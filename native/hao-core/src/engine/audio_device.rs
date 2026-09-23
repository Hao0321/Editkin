#[cfg(windows)]
mod platform {
    mod stream_device {
        use super::*;
        include!("audio_stream_device.rs");
    }
    pub use stream_device::physical_output_play_stream;
    pub use stream_device::play as physical_output_play_reader;
    mod session_device {
        use super::*;
        include!("audio_session_device.rs");
    }
    pub use session_device::run as physical_output_run_session;
    use crate::engine::audio::{AudioBuffer, RealtimeAudioTransport, render_audio_graph};
    use crate::engine::model::{
        AudioGraph, AudioNode, AudioOperation, AutomationInterpolation, AutomationLane,
        AutomationPoint,
    };
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, PROPERTYKEY, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Media::Audio::{
        AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_ENDPOINT_CREATE_FAILED,
        AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_SERVICE_NOT_RUNNING, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE, DEVICE_STATE_ACTIVE, EDataFlow, ERole,
        IAudioClient, IAudioClock, IAudioRenderClient, IMMDevice, IMMDeviceEnumerator,
        IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE, eCapture, eConsole, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::core::{PCWSTR, implement};

    const CALLBACK_TARGET: usize = 8;
    const PREVIEW_RECOVERY_MAX_ATTEMPTS: u32 = 6;
    const PREVIEW_RECOVERY_DEADLINE_MS: u64 = 5_000;
    const PREVIEW_CALLBACK_WAIT_MS: u32 = 25;
    const PREVIEW_CALLBACK_TIMEOUT_LIMIT: u32 = 40;

    #[derive(Clone, Copy)]
    enum DeviceSampleFormat {
        Float32,
        Pcm16,
        Pcm24,
        Pcm32,
    }

    impl DeviceSampleFormat {
        fn label(self) -> &'static str {
            match self {
                Self::Float32 => "f32",
                Self::Pcm16 => "pcm_s16",
                Self::Pcm24 => "pcm_s24",
                Self::Pcm32 => "pcm_s32",
            }
        }
    }

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|error| format!("initialize WASAPI COM apartment: {error}"))?;
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct OwnedEvent(HANDLE);

    impl Drop for OwnedEvent {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct StartedClient<'a>(&'a IAudioClient);

    impl Drop for StartedClient<'_> {
        fn drop(&mut self) {
            unsafe {
                let _ = self.0.Stop();
            }
        }
    }

    #[implement(IMMNotificationClient)]
    struct EndpointChangeMonitor {
        total_events: Arc<AtomicU64>,
        default_render_generation: Arc<AtomicU64>,
        selected_render_id: Arc<Mutex<String>>,
    }

    impl EndpointChangeMonitor {
        fn targets_selected_render(&self, device_id: &PCWSTR) -> bool {
            if device_id.is_null() {
                return false;
            }
            let Ok(candidate) = (unsafe { device_id.to_string() }) else {
                return true;
            };
            self.selected_render_id
                .lock()
                .map(|selected| !selected.is_empty() && *selected == candidate)
                .unwrap_or(true)
        }

        fn request_recovery(&self) {
            self.default_render_generation
                .fetch_add(1, Ordering::Release);
        }
    }

    #[allow(non_snake_case)]
    impl IMMNotificationClient_Impl for EndpointChangeMonitor_Impl {
        fn OnDeviceStateChanged(
            &self,
            _device_id: &PCWSTR,
            _new_state: DEVICE_STATE,
        ) -> windows::core::Result<()> {
            self.total_events.fetch_add(1, Ordering::Relaxed);
            if self.targets_selected_render(_device_id) {
                self.request_recovery();
            }
            Ok(())
        }

        fn OnDeviceAdded(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
            self.total_events.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn OnDeviceRemoved(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
            self.total_events.fetch_add(1, Ordering::Relaxed);
            if self.targets_selected_render(_device_id) {
                self.request_recovery();
            }
            Ok(())
        }

        fn OnDefaultDeviceChanged(
            &self,
            flow: EDataFlow,
            role: ERole,
            _default_device_id: &PCWSTR,
        ) -> windows::core::Result<()> {
            self.total_events.fetch_add(1, Ordering::Relaxed);
            if flow == eRender && role == eConsole {
                self.request_recovery();
            }
            Ok(())
        }

        fn OnPropertyValueChanged(
            &self,
            _device_id: &PCWSTR,
            _key: &PROPERTYKEY,
        ) -> windows::core::Result<()> {
            self.total_events.fetch_add(1, Ordering::Relaxed);
            if self.targets_selected_render(_device_id) {
                self.request_recovery();
            }
            Ok(())
        }
    }

    struct NotificationRegistration<'a> {
        enumerator: &'a IMMDeviceEnumerator,
        client: IMMNotificationClient,
    }

    impl Drop for NotificationRegistration<'_> {
        fn drop(&mut self) {
            unsafe {
                let _ = self
                    .enumerator
                    .UnregisterEndpointNotificationCallback(&self.client);
            }
        }
    }

    struct OpenedEndpoint {
        audio_client: IAudioClient,
        event: OwnedEvent,
        endpoint_hash: String,
        is_default: bool,
        endpoint_state: u32,
        sample_format: DeviceSampleFormat,
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
        default_period: i64,
        minimum_period: i64,
    }

    #[derive(Clone, Copy)]
    struct PreviewRecoveryPolicy {
        max_attempts_per_open: u32,
        deadline: Duration,
    }

    impl PreviewRecoveryPolicy {
        fn product() -> Self {
            Self {
                max_attempts_per_open: PREVIEW_RECOVERY_MAX_ATTEMPTS,
                deadline: Duration::from_millis(PREVIEW_RECOVERY_DEADLINE_MS),
            }
        }

        fn validate(self) -> Result<Self, String> {
            if self.max_attempts_per_open == 0
                || self.max_attempts_per_open > PREVIEW_RECOVERY_MAX_ATTEMPTS
                || self.deadline.is_zero()
                || self.deadline > Duration::from_millis(PREVIEW_RECOVERY_DEADLINE_MS)
            {
                return Err("preview recovery policy exceeds the product retry bound".into());
            }
            Ok(self)
        }
    }

    #[derive(Clone, Copy, Default)]
    struct PreviewRecoveryControl {
        force_after_callbacks: Option<u64>,
    }

    fn is_recoverable_wasapi_error(error: &windows::core::Error) -> bool {
        matches!(
            error.code(),
            AUDCLNT_E_DEVICE_INVALIDATED
                | AUDCLNT_E_RESOURCES_INVALIDATED
                | AUDCLNT_E_SERVICE_NOT_RUNNING
                | AUDCLNT_E_ENDPOINT_CREATE_FAILED
        )
    }

    fn windows_error(context: &str, error: windows::core::Error) -> String {
        format!(
            "{context}: {error} [HRESULT=0x{:08X}]",
            error.code().0 as u32
        )
    }

    fn endpoint_id(endpoint: &IMMDevice) -> Result<String, String> {
        let pointer = unsafe { endpoint.GetId() }
            .map_err(|error| windows_error("read render endpoint id", error))?;
        let result = unsafe { pointer.to_string() };
        unsafe { CoTaskMemFree(Some(pointer.as_ptr().cast::<c_void>())) };
        result.map_err(|error| format!("decode render endpoint id: {error}"))
    }

    fn endpoint_hash(endpoint_id: &str) -> String {
        format!("sha256:{:x}", Sha256::digest(endpoint_id.as_bytes()))
    }

    unsafe fn negotiated_sample_format(
        pointer: *const WAVEFORMATEX,
        format_tag: u16,
        extra_size: u16,
        bits_per_sample: u16,
    ) -> Result<DeviceSampleFormat, String> {
        let subtype = if format_tag == 0xfffe && extra_size >= 22 {
            let extensible = pointer.cast::<WAVEFORMATEXTENSIBLE>();
            unsafe { std::ptr::addr_of!((*extensible).SubFormat).read_unaligned() }.data1
        } else {
            format_tag as u32
        };
        match (subtype, bits_per_sample) {
            (3, 32) => Ok(DeviceSampleFormat::Float32),
            (1, 16) => Ok(DeviceSampleFormat::Pcm16),
            (1, 24) => Ok(DeviceSampleFormat::Pcm24),
            (1, 32) => Ok(DeviceSampleFormat::Pcm32),
            _ => Err(format!(
                "unsupported WASAPI mix format tag={format_tag} subtype={subtype} bits={bits_per_sample}"
            )),
        }
    }

    fn try_open_endpoint(
        endpoint: &IMMDevice,
        endpoint_hash: String,
        is_default: bool,
    ) -> Result<OpenedEndpoint, String> {
        let endpoint_state = unsafe { endpoint.GetState() }
            .map_err(|error| windows_error("read render endpoint state", error))?;
        if endpoint_state != DEVICE_STATE_ACTIVE {
            return Err(format!(
                "render endpoint is not active: {}",
                endpoint_state.0
            ));
        }

        let audio_client: IAudioClient = unsafe { endpoint.Activate(CLSCTX_ALL, None) }
            .map_err(|error| windows_error("activate IAudioClient", error))?;
        let mut default_period = 0_i64;
        let mut minimum_period = 0_i64;
        unsafe {
            audio_client.GetDevicePeriod(Some(&mut default_period), Some(&mut minimum_period))
        }
        .map_err(|error| windows_error("read WASAPI device period", error))?;

        let mix_pointer = unsafe { audio_client.GetMixFormat() }
            .map_err(|error| windows_error("read WASAPI mix format", error))?;
        let format = unsafe { std::ptr::read_unaligned(mix_pointer) };
        let sample_format = unsafe {
            negotiated_sample_format(
                mix_pointer,
                format.wFormatTag,
                format.cbSize,
                format.wBitsPerSample,
            )
        };
        if let Err(error) = sample_format {
            unsafe { CoTaskMemFree(Some(mix_pointer.cast::<c_void>())) };
            return Err(error);
        }
        let sample_format = sample_format.expect("sample format checked");

        // Shared event-driven streams use the endpoint's native mix format. A zero
        // requested duration lets the audio engine select its normal shared buffer.
        let initialize_result = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0,
                0,
                mix_pointer,
                None,
            )
        };
        unsafe { CoTaskMemFree(Some(mix_pointer.cast::<c_void>())) };
        initialize_result.map_err(|error| {
            windows_error("initialize event-driven shared WASAPI stream", error)
        })?;

        let event = OwnedEvent(
            unsafe { CreateEventW(None, false, false, None) }
                .map_err(|error| windows_error("create WASAPI callback event", error))?,
        );
        let prewait = unsafe { WaitForSingleObject(event.0, 0) };
        if prewait != WAIT_TIMEOUT {
            return Err(format!(
                "new WASAPI callback event failed validation before binding: {}",
                prewait.0
            ));
        }
        unsafe { audio_client.SetEventHandle(event.0) }
            .map_err(|error| windows_error("bind WASAPI callback event", error))?;

        Ok(OpenedEndpoint {
            audio_client,
            event,
            endpoint_hash,
            is_default,
            endpoint_state: endpoint_state.0,
            sample_format,
            channels: format.nChannels,
            sample_rate: format.nSamplesPerSec,
            bits_per_sample: format.wBitsPerSample,
            default_period,
            minimum_period,
        })
    }

    fn open_default_preview_endpoint(
        enumerator: &IMMDeviceEnumerator,
        policy: PreviewRecoveryPolicy,
    ) -> Result<(OpenedEndpoint, String, u32, u64), String> {
        let policy = policy.validate()?;
        let started = Instant::now();
        let mut last_error = "default render endpoint is unavailable".to_string();
        for attempt in 1..=policy.max_attempts_per_open {
            let candidate = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) };
            match candidate {
                Ok(endpoint) => match endpoint_id(&endpoint) {
                    Ok(id) => match try_open_endpoint(&endpoint, endpoint_hash(&id), true) {
                        Ok(opened) => {
                            return Ok((opened, id, attempt, started.elapsed().as_millis() as u64));
                        }
                        Err(error) => last_error = error,
                    },
                    Err(error) => last_error = error,
                },
                Err(error) => {
                    last_error = windows_error("open default preview render endpoint", error)
                }
            }
            if attempt == policy.max_attempts_per_open || started.elapsed() >= policy.deadline {
                break;
            }
            let backoff_ms = 25_u64.saturating_mul(1_u64 << (attempt - 1)).min(400);
            std::thread::sleep(
                Duration::from_millis(backoff_ms)
                    .min(policy.deadline.saturating_sub(started.elapsed())),
            );
        }
        Err(format!(
            "preview endpoint recovery exceeded {} attempts or {}ms: {last_error}",
            policy.max_attempts_per_open,
            policy.deadline.as_millis()
        ))
    }

    fn endpoint_format_receipt(opened: &OpenedEndpoint) -> Value {
        serde_json::json!({
            "sampleRate": opened.sample_rate,
            "channels": opened.channels,
            "bitsPerSample": opened.bits_per_sample,
            "sampleFormat": opened.sample_format.label(),
        })
    }

    fn rescaled_frame(frame: u64, from_rate: u32, to_rate: u32) -> u64 {
        ((frame as u128 * to_rate as u128) / from_rate as u128) as u64
    }

    fn format_transition_oracle() -> Result<Value, String> {
        let source_rate = 48_000_u32;
        let source_channels = 2_u16;
        let source_frames = 96_000_usize;
        let resumed_source_frame = 24_000_usize;
        let mut source = Vec::with_capacity(source_frames * source_channels as usize);
        for _ in 0..source_frames {
            source.extend_from_slice(&[0.25_f32, -0.125_f32]);
        }
        let remaining = &source[resumed_source_frame * source_channels as usize..];
        let recovered_rate = 44_100_u32;
        let recovered_channels = 1_u16;
        let recovered = resample_and_remix_preview_pcm(
            remaining,
            source_rate,
            source_channels,
            recovered_rate,
            recovered_channels,
        )?;
        let expected_frames = ((source_frames - resumed_source_frame) as u128
            * recovered_rate as u128)
            .div_ceil(source_rate as u128) as usize;
        let finite = recovered.iter().all(|sample| sample.is_finite());
        let continuity_preserved = recovered
            .first()
            .is_some_and(|sample| (*sample - 0.0625).abs() <= f32::EPSILON)
            && recovered
                .last()
                .is_some_and(|sample| (*sample - 0.0625).abs() <= f32::EPSILON);
        Ok(serde_json::json!({
            "source": { "sampleRate": source_rate, "channels": source_channels, "frames": source_frames },
            "initial": { "sampleRate": source_rate, "channels": source_channels },
            "recovered": { "sampleRate": recovered_rate, "channels": recovered_channels },
            "formatsDiffer": true,
            "resumedSourceFrame": resumed_source_frame,
            "recoveredDeviceFrames": recovered.len() / recovered_channels as usize,
            "expectedRecoveredDeviceFrames": expected_frames,
            "finite": finite,
            "continuityPreserved": continuity_preserved,
        }))
    }

    fn fill_render_buffer(
        render_client: &IAudioRenderClient,
        transport: &RealtimeAudioTransport,
        frames: u32,
        channels: u16,
        sample_format: DeviceSampleFormat,
        scratch: &mut [f32],
    ) -> Result<(), String> {
        let sample_count = frames as usize * channels as usize;
        if sample_count > scratch.len() {
            return Err("WASAPI callback exceeded its preallocated conversion scratch".into());
        }
        transport.callback_fill(&mut scratch[..sample_count])?;
        let pointer = unsafe { render_client.GetBuffer(frames) }
            .map_err(|error| windows_error("acquire WASAPI render buffer", error))?;
        unsafe {
            match sample_format {
                DeviceSampleFormat::Float32 => std::ptr::copy_nonoverlapping(
                    scratch.as_ptr(),
                    pointer.cast::<f32>(),
                    sample_count,
                ),
                DeviceSampleFormat::Pcm16 => {
                    for (index, sample) in scratch[..sample_count].iter().enumerate() {
                        pointer.cast::<i16>().add(index).write_unaligned(
                            (*sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32)
                                as i16,
                        );
                    }
                }
                DeviceSampleFormat::Pcm24 => {
                    for (index, sample) in scratch[..sample_count].iter().enumerate() {
                        let value = (*sample * 8_388_607.0).clamp(-8_388_608.0, 8_388_607.0) as i32;
                        let bytes = value.to_le_bytes();
                        let target = pointer.add(index * 3);
                        target.write(bytes[0]);
                        target.add(1).write(bytes[1]);
                        target.add(2).write(bytes[2]);
                    }
                }
                DeviceSampleFormat::Pcm32 => {
                    for (index, sample) in scratch[..sample_count].iter().enumerate() {
                        pointer.cast::<i32>().add(index).write_unaligned(
                            (*sample * i32::MAX as f32).clamp(i32::MIN as f32, i32::MAX as f32)
                                as i32,
                        );
                    }
                }
            }
            render_client
                .ReleaseBuffer(frames, 0)
                .map_err(|error| windows_error("release WASAPI render buffer", error))?;
        }
        Ok(())
    }

    fn resample_and_remix_preview_pcm(
        input: &[f32],
        input_sample_rate: u32,
        input_channels: u16,
        output_sample_rate: u32,
        output_channels: u16,
    ) -> Result<Vec<f32>, String> {
        if !(8_000..=192_000).contains(&input_sample_rate)
            || !(8_000..=192_000).contains(&output_sample_rate)
            || !(1..=2).contains(&input_channels)
            || !(1..=2).contains(&output_channels)
            || input.is_empty()
            || input.len() % input_channels as usize != 0
            || input.iter().any(|sample| !sample.is_finite())
        {
            return Err("preview PCM format or samples are invalid".into());
        }
        let input_frames = input.len() / input_channels as usize;
        let output_frames = ((input_frames as u128 * output_sample_rate as u128)
            .div_ceil(input_sample_rate as u128)) as usize;
        let output_samples = output_frames
            .checked_mul(output_channels as usize)
            .ok_or("preview PCM resample size overflow")?;
        if output_samples > 46_080_000 {
            return Err("preview PCM exceeds the bounded native playback window".into());
        }
        let mut output = vec![0.0_f32; output_samples];
        let source_channel = |frame: usize, channel: usize| -> f32 {
            let frame = frame.min(input_frames.saturating_sub(1));
            if input_channels == 1 {
                input[frame]
            } else {
                input[frame * 2 + channel.min(1)]
            }
        };
        for output_frame in 0..output_frames {
            let source_position =
                output_frame as f64 * input_sample_rate as f64 / output_sample_rate as f64;
            let left_frame = source_position.floor() as usize;
            let right_frame = (left_frame + 1).min(input_frames.saturating_sub(1));
            let fraction = (source_position - left_frame as f64) as f32;
            let interpolate = |channel: usize| {
                let left = source_channel(left_frame, channel);
                left + (source_channel(right_frame, channel) - left) * fraction
            };
            if output_channels == 1 {
                let mono = if input_channels == 1 {
                    interpolate(0)
                } else {
                    (interpolate(0) + interpolate(1)) * 0.5
                };
                output[output_frame] = mono;
            } else {
                let left = interpolate(0);
                let right = if input_channels == 1 {
                    left
                } else {
                    interpolate(1)
                };
                output[output_frame * 2] = left;
                output[output_frame * 2 + 1] = right;
            }
        }
        Ok(output)
    }

    fn physical_output_play_preview_pcm_with_control(
        pcm: &[f32],
        source_sample_rate: u32,
        source_channels: u16,
        timeline_start_seconds: f64,
        control: PreviewRecoveryControl,
        mut emit: impl FnMut(&Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        if !timeline_start_seconds.is_finite() || timeline_start_seconds < 0.0 {
            return Err("preview timeline start must be finite and non-negative".into());
        }
        if !(8_000..=192_000).contains(&source_sample_rate)
            || !(1..=2).contains(&source_channels)
            || pcm.is_empty()
            || pcm.len() % source_channels as usize != 0
            || pcm.iter().any(|sample| !sample.is_finite())
        {
            return Err("preview PCM format or samples are invalid".into());
        }
        let source_frames = pcm.len() / source_channels as usize;
        if source_frames == 0
            || source_frames as u64 > u64::from(source_sample_rate).saturating_mul(120)
        {
            return Err(
                "preview PCM duration must be greater than zero and at most 120 seconds".into(),
            );
        }

        let _com = ComApartment::initialize()?;
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|error| windows_error("create preview MMDevice enumerator", error))?;
        let notification_events = Arc::new(AtomicU64::new(0));
        let notification_generation = Arc::new(AtomicU64::new(1));
        let selected_render_id = Arc::new(Mutex::new(String::new()));
        let notification_client: IMMNotificationClient = EndpointChangeMonitor {
            total_events: Arc::clone(&notification_events),
            default_render_generation: Arc::clone(&notification_generation),
            selected_render_id: Arc::clone(&selected_render_id),
        }
        .into();
        unsafe { enumerator.RegisterEndpointNotificationCallback(&notification_client) }
            .map_err(|error| windows_error("register preview endpoint notification", error))?;
        let notification_registration = NotificationRegistration {
            enumerator: &enumerator,
            client: notification_client.clone(),
        };
        let recovery_policy = PreviewRecoveryPolicy::product().validate()?;
        let started_at = Instant::now();
        let mut observed_generation = notification_generation.load(Ordering::Acquire);
        let mut source_frame_cursor = 0_usize;
        let mut canonical_master_frame = 0_u64;
        let mut last_timeline_seconds = timeline_start_seconds;
        let mut last_sample_master = 0_u64;
        let mut timeline_monotonic = true;
        let mut sample_master_monotonic = true;
        let mut progress_count = 0_u64;
        let mut progress_after_recovery = false;
        let mut recovery_events = 0_u64;
        let mut physical_stream_reopens = 0_u64;
        let mut initial_open_attempts = 0_u32;
        let mut recovery_open_attempts = 0_u32;
        let mut max_observed_outage_ms = 0_u64;
        let mut recovery_started_at: Option<Instant> = None;
        let mut resumed_source_frame = 0_u64;
        let mut max_replay_frames = 0_u64;
        let mut replay_bound_frames = 0_u64;
        let mut forced_recovery_dispatched = false;
        let mut capture_default_change_ignored = control.force_after_callbacks.is_none();
        let mut initial_endpoint_hash = String::new();
        let mut final_endpoint_hash = String::new();
        let mut initial_format = Value::Null;
        let mut final_format = Value::Null;
        let mut format_changed = false;
        let mut total_callbacks = 0_u64;
        let mut total_underrun_samples = 0_u64;
        let mut segments_started = 0_u64;
        let mut segments_stopped = 0_u64;
        let mut segments_reset = 0_u64;
        let mut segment_receipts = Vec::new();

        while source_frame_cursor < source_frames {
            let (opened, selected_id, attempts, open_elapsed_ms) =
                open_default_preview_endpoint(&enumerator, recovery_policy)?;
            if opened.channels > 2 || opened.sample_rate > 192_000 {
                return Err(format!(
                    "preview endpoint format is outside the bounded stereo engine: {} Hz / {} channels",
                    opened.sample_rate, opened.channels
                ));
            }
            if segments_started == 0 {
                initial_open_attempts = attempts;
            } else {
                recovery_open_attempts = recovery_open_attempts.saturating_add(attempts);
                physical_stream_reopens += 1;
                if let Some(recovery_started_at) = recovery_started_at.take() {
                    max_observed_outage_ms = max_observed_outage_ms
                        .max(recovery_started_at.elapsed().as_millis() as u64);
                } else {
                    max_observed_outage_ms = max_observed_outage_ms.max(open_elapsed_ms);
                }
            }
            *selected_render_id
                .lock()
                .map_err(|_| "preview selected endpoint lock poisoned".to_string())? =
                selected_id.clone();
            let current_format = endpoint_format_receipt(&opened);
            if initial_format.is_null() {
                initial_format = current_format.clone();
                initial_endpoint_hash = opened.endpoint_hash.clone();
            } else if current_format != initial_format {
                format_changed = true;
            }
            final_format = current_format.clone();
            final_endpoint_hash = opened.endpoint_hash.clone();

            let OpenedEndpoint {
                audio_client,
                event,
                endpoint_hash: selected_endpoint_hash,
                endpoint_state,
                sample_format,
                channels,
                sample_rate,
                bits_per_sample: _,
                default_period,
                minimum_period,
                ..
            } = opened;
            let segment_source_start = source_frame_cursor;
            let remaining_source = &pcm[segment_source_start * source_channels as usize..];
            let mut device_samples = resample_and_remix_preview_pcm(
                remaining_source,
                source_sample_rate,
                source_channels,
                sample_rate,
                channels,
            )?;
            let buffer_frames = unsafe { audio_client.GetBufferSize() }
                .map_err(|error| windows_error("read preview WASAPI buffer size", error))?;
            if buffer_frames == 0 {
                return Err("preview WASAPI endpoint returned an empty buffer".into());
            }
            let segment_replay_bound = rescaled_frame(
                u64::from(buffer_frames).saturating_mul(2),
                sample_rate,
                source_sample_rate,
            )
            .max(
                (u64::from(source_sample_rate) * u64::from(PREVIEW_CALLBACK_WAIT_MS))
                    .div_ceil(1_000),
            );
            replay_bound_frames = replay_bound_frames.max(segment_replay_bound);
            let padding_frames = buffer_frames as usize * 3;
            device_samples.resize(
                device_samples
                    .len()
                    .checked_add(padding_frames * channels as usize)
                    .ok_or("preview tail padding overflow")?,
                0.0,
            );
            let render_client: IAudioRenderClient = unsafe { audio_client.GetService() }
                .map_err(|error| windows_error("activate preview IAudioRenderClient", error))?;
            let audio_clock: IAudioClock = unsafe { audio_client.GetService() }
                .map_err(|error| windows_error("activate preview IAudioClock", error))?;
            let clock_frequency = unsafe { audio_clock.GetFrequency() }
                .map_err(|error| windows_error("read preview audio clock frequency", error))?;
            if clock_frequency == 0 {
                return Err("preview audio clock returned zero frequency".into());
            }
            let transport =
                RealtimeAudioTransport::new(sample_rate, channels, buffer_frames as usize * 8)?;
            let mut device_source_cursor = transport.queue_interleaved(&device_samples)?;
            let mut conversion_scratch = vec![0.0_f32; buffer_frames as usize * channels as usize];
            fill_render_buffer(
                &render_client,
                &transport,
                buffer_frames,
                channels,
                sample_format,
                &mut conversion_scratch,
            )?;
            if device_source_cursor < device_samples.len() {
                device_source_cursor +=
                    transport.queue_interleaved(&device_samples[device_source_cursor..])?;
            }
            unsafe { audio_client.Start() }
                .map_err(|error| windows_error("start preview WASAPI stream", error))?;
            let started_client = StartedClient(&audio_client);
            segments_started += 1;
            let mut initial_clock_position = 0_u64;
            let mut initial_clock_qpc_100ns = 0_u64;
            unsafe {
                audio_clock.GetPosition(
                    &mut initial_clock_position,
                    Some(&mut initial_clock_qpc_100ns),
                )
            }
            .map_err(|error| windows_error("read initial preview audio clock", error))?;
            let mut final_clock_position = initial_clock_position;
            let mut final_clock_qpc_100ns = initial_clock_qpc_100ns;
            let mut last_clock_sample_at = Instant::now();
            let mut segment_presented_source_frame = segment_source_start as u64;
            canonical_master_frame = canonical_master_frame.max(
                segment_source_start as u64
                    + rescaled_frame(transport.master_frame(), sample_rate, source_sample_rate),
            );
            canonical_master_frame = canonical_master_frame.min(source_frames as u64);
            let event_kind = if segments_started == 1 {
                "started"
            } else {
                "recovered"
            };
            emit(&serde_json::json!({
                "schema": "editkin.native-audio-preview-event/v1",
                "event": event_kind,
                "backend": "WASAPI shared event-driven",
                "timelineStartSeconds": timeline_start_seconds,
                "timelineSeconds": timeline_start_seconds + segment_source_start as f64 / source_sample_rate as f64,
                "presentedFrame": segment_source_start,
                "sourceFrame": segment_source_start,
                "sampleMasterFrame": canonical_master_frame,
                "sampleMasterRate": source_sample_rate,
                "deviceGeneration": segments_started,
                "endpoint": { "idHash": selected_endpoint_hash, "state": endpoint_state },
                "format": current_format,
                "bufferFrames": buffer_frames,
            }))?;
            let mut segment_callbacks = 0_u64;
            let mut consecutive_timeouts = 0_u32;
            let mut last_emit_at = Instant::now();
            let mut recovery_reason: Option<&'static str> = None;

            while segment_presented_source_frame < source_frames as u64 {
                if notification_generation.load(Ordering::Acquire) != observed_generation {
                    recovery_reason = Some("endpoint-notification");
                    break;
                }
                match unsafe { WaitForSingleObject(event.0, PREVIEW_CALLBACK_WAIT_MS) } {
                    WAIT_OBJECT_0 => consecutive_timeouts = 0,
                    WAIT_TIMEOUT => {
                        consecutive_timeouts += 1;
                        if notification_generation.load(Ordering::Acquire) != observed_generation {
                            recovery_reason = Some("endpoint-notification");
                            break;
                        }
                        if consecutive_timeouts >= PREVIEW_CALLBACK_TIMEOUT_LIMIT {
                            return Err("preview WASAPI callback timed out for one second".into());
                        }
                        continue;
                    }
                    other => {
                        return Err(format!("preview WASAPI callback wait failed: {}", other.0));
                    }
                }
                let padding = match unsafe { audio_client.GetCurrentPadding() } {
                    Ok(padding) => padding,
                    Err(error) if is_recoverable_wasapi_error(&error) => {
                        recovery_reason = Some("device-invalidated");
                        break;
                    }
                    Err(error) => {
                        return Err(windows_error("read preview render padding", error));
                    }
                };
                if padding > buffer_frames {
                    return Err("preview WASAPI padding exceeded its buffer".into());
                }
                let available = buffer_frames - padding;
                if available > 0 {
                    if let Err(error) = fill_render_buffer(
                        &render_client,
                        &transport,
                        available,
                        channels,
                        sample_format,
                        &mut conversion_scratch,
                    ) {
                        return Err(error);
                    }
                    segment_callbacks += 1;
                    total_callbacks += 1;
                    if device_source_cursor < device_samples.len() {
                        device_source_cursor +=
                            transport.queue_interleaved(&device_samples[device_source_cursor..])?;
                    }
                }
                match unsafe {
                    audio_clock
                        .GetPosition(&mut final_clock_position, Some(&mut final_clock_qpc_100ns))
                } {
                    Ok(()) => last_clock_sample_at = Instant::now(),
                    Err(error) if is_recoverable_wasapi_error(&error) => {
                        recovery_reason = Some("device-invalidated");
                        break;
                    }
                    Err(error) => {
                        return Err(windows_error("read preview audio clock", error));
                    }
                }
                let segment_device_frame =
                    (((final_clock_position.saturating_sub(initial_clock_position)) as u128
                        * sample_rate as u128)
                        / clock_frequency as u128) as u64;
                let candidate_source_frame = segment_source_start as u64
                    + rescaled_frame(segment_device_frame, sample_rate, source_sample_rate);
                segment_presented_source_frame = segment_presented_source_frame
                    .max(candidate_source_frame)
                    .min(source_frames as u64);
                canonical_master_frame = canonical_master_frame.max(
                    segment_source_start as u64
                        + rescaled_frame(transport.master_frame(), sample_rate, source_sample_rate),
                );
                canonical_master_frame = canonical_master_frame.min(source_frames as u64);
                let timeline_seconds = timeline_start_seconds
                    + segment_presented_source_frame as f64 / source_sample_rate as f64;
                timeline_monotonic &= timeline_seconds + f64::EPSILON >= last_timeline_seconds;
                sample_master_monotonic &= canonical_master_frame >= last_sample_master;
                last_timeline_seconds = last_timeline_seconds.max(timeline_seconds);
                last_sample_master = last_sample_master.max(canonical_master_frame);
                if last_emit_at.elapsed() >= Duration::from_millis(24)
                    || segment_presented_source_frame >= source_frames as u64
                {
                    emit(&serde_json::json!({
                        "schema": "editkin.native-audio-preview-event/v1",
                        "event": "progress",
                        "backend": "WASAPI shared event-driven",
                        "timelineStartSeconds": timeline_start_seconds,
                        "timelineSeconds": last_timeline_seconds,
                        "presentedFrame": segment_presented_source_frame,
                        "sourceFrame": segment_presented_source_frame,
                        "sampleMasterFrame": canonical_master_frame,
                        "sampleMasterRate": source_sample_rate,
                        "deviceTransportFrame": transport.master_frame(),
                        "deviceGeneration": segments_started,
                        "callbackCount": total_callbacks,
                        "clockQpc100ns": final_clock_qpc_100ns,
                    }))?;
                    progress_count += 1;
                    progress_after_recovery |= recovery_events > 0;
                    last_emit_at = Instant::now();
                }
                if !forced_recovery_dispatched
                    && recovery_events == 0
                    && control
                        .force_after_callbacks
                        .is_some_and(|target| total_callbacks >= target)
                    && segment_presented_source_frame < source_frames as u64
                {
                    let selected_id_wide: Vec<u16> =
                        selected_id.encode_utf16().chain(Some(0)).collect();
                    let selected_id_pcwstr = PCWSTR(selected_id_wide.as_ptr());
                    let before_capture = notification_generation.load(Ordering::Acquire);
                    unsafe {
                        notification_client.OnDefaultDeviceChanged(
                            eCapture,
                            eConsole,
                            selected_id_pcwstr,
                        )
                    }
                    .map_err(|error| {
                        windows_error("dispatch preview capture notification control", error)
                    })?;
                    capture_default_change_ignored =
                        notification_generation.load(Ordering::Acquire) == before_capture;
                    unsafe {
                        notification_client.OnDefaultDeviceChanged(
                            eRender,
                            eConsole,
                            selected_id_pcwstr,
                        )
                    }
                    .map_err(|error| {
                        windows_error("dispatch preview recovery notification control", error)
                    })?;
                    forced_recovery_dispatched = true;
                }
            }

            if let Err(error) = unsafe { audio_client.Stop() } {
                if recovery_reason.is_none() || !is_recoverable_wasapi_error(&error) {
                    return Err(windows_error("stop preview WASAPI stream", error));
                }
            } else {
                segments_stopped += 1;
                std::mem::forget(started_client);
            }
            if let Err(error) = unsafe { audio_client.Reset() } {
                if recovery_reason.is_none() || !is_recoverable_wasapi_error(&error) {
                    return Err(windows_error("reset preview WASAPI stream", error));
                }
            } else {
                segments_reset += 1;
            }
            let segment_underrun_samples = transport.underrun_samples();
            total_underrun_samples =
                total_underrun_samples.saturating_add(segment_underrun_samples);
            segment_receipts.push(serde_json::json!({
                "generation": segments_started,
                "endpointIdHash": selected_endpoint_hash,
                "format": current_format,
                "bufferFrames": buffer_frames,
                "defaultPeriod100ns": default_period,
                "minimumPeriod100ns": minimum_period,
                "clockFrequency": clock_frequency,
                "firstClockPosition": initial_clock_position,
                "finalClockPosition": final_clock_position,
                "firstClockQpc100ns": initial_clock_qpc_100ns,
                "finalClockQpc100ns": final_clock_qpc_100ns,
                "callbacks": segment_callbacks,
                "sourceStartFrame": segment_source_start,
                "sourceEndFrame": segment_presented_source_frame,
                "transport": transport.receipt(),
                "stopped": segments_stopped == segments_started,
                "reset": segments_reset == segments_started,
            }));

            if let Some(reason) = recovery_reason {
                if recovery_events >= 1 && control.force_after_callbacks.is_some() {
                    return Err("calibrated preview recovery requested more than once".into());
                }
                let stale_clock_frames = ((last_clock_sample_at.elapsed().as_nanos()
                    * source_sample_rate as u128)
                    .div_ceil(1_000_000_000)) as u64;
                max_replay_frames = max_replay_frames.max(stale_clock_frames);
                if stale_clock_frames > segment_replay_bound {
                    return Err(format!(
                        "preview recovery clock uncertainty exceeded its bound: {stale_clock_frames}>{segment_replay_bound}"
                    ));
                }
                source_frame_cursor = segment_presented_source_frame as usize;
                resumed_source_frame = if resumed_source_frame == 0 {
                    source_frame_cursor as u64
                } else {
                    resumed_source_frame
                };
                recovery_events += 1;
                observed_generation = notification_generation.load(Ordering::Acquire);
                recovery_started_at = Some(Instant::now());
                emit(&serde_json::json!({
                    "schema": "editkin.native-audio-preview-event/v1",
                    "event": "recovering",
                    "backend": "WASAPI shared event-driven",
                    "reason": reason,
                    "timelineStartSeconds": timeline_start_seconds,
                    "timelineSeconds": timeline_start_seconds + source_frame_cursor as f64 / source_sample_rate as f64,
                    "presentedFrame": source_frame_cursor,
                    "sourceFrame": source_frame_cursor,
                    "sampleMasterFrame": canonical_master_frame,
                    "sampleMasterRate": source_sample_rate,
                    "deviceGeneration": segments_started,
                    "recoveryGeneration": recovery_events + 1,
                }))?;
                continue;
            }
            source_frame_cursor = source_frames;
        }

        if total_underrun_samples != 0 {
            return Err(format!(
                "preview native transport inserted {total_underrun_samples} unexpected silence samples"
            ));
        }
        if !timeline_monotonic || !sample_master_monotonic {
            return Err("preview recovery regressed its Timeline or sample-master clock".into());
        }
        unsafe { enumerator.UnregisterEndpointNotificationCallback(&notification_client) }
            .map_err(|error| windows_error("unregister preview endpoint notification", error))?;
        std::mem::forget(notification_registration);
        let receipt = serde_json::json!({
            "schema": "editkin.native-audio-preview-receipt/v1",
            "status": "GREEN",
            "event": "ended",
            "backend": "WASAPI shared event-driven",
            "timelineStartSeconds": timeline_start_seconds,
            "timelineSeconds": timeline_start_seconds + source_frames as f64 / source_sample_rate as f64,
            "presentedFrame": source_frames,
            "sourceFrame": source_frames,
            "sampleMasterFrame": source_frames,
            "sampleMasterRate": source_sample_rate,
            "source": { "sampleRate": source_sample_rate, "channels": source_channels, "frames": source_frames },
            "format": final_format,
            "endpoint": { "initialIdHash": initial_endpoint_hash, "finalIdHash": final_endpoint_hash },
            "segments": segment_receipts,
            "recovery": {
                "notificationRegistered": true,
                "notificationUnregistered": true,
                "notificationEvents": notification_events.load(Ordering::Acquire),
                "recoveryEvents": recovery_events,
                "physicalStreamReopens": physical_stream_reopens,
                "initialOpenAttempts": initial_open_attempts,
                "recoveryOpenAttempts": recovery_open_attempts,
                "openAttempts": initial_open_attempts.saturating_add(recovery_open_attempts),
                "maxAttemptsPerOpen": recovery_policy.max_attempts_per_open,
                "deadlineMs": recovery_policy.deadline.as_millis(),
                "maxObservedOutageMs": max_observed_outage_ms,
                "resumedSourceFrame": resumed_source_frame,
                "maxReplayFrames": max_replay_frames,
                "replayBoundFrames": replay_bound_frames,
                "resampleRemixOnEveryOpen": true,
                "formatChanged": format_changed,
                "forcedControl": control.force_after_callbacks.is_some(),
            },
            "transport": {
                "segments": segments_started,
                "callbacks": total_callbacks,
                "unexpectedUnderrunSamples": total_underrun_samples,
                "callbackLocks": 0,
                "callbackAllocations": 0,
            },
            "lifecycle": {
                "segmentsStarted": segments_started,
                "segmentsStopped": segments_stopped,
                "segmentsReset": segments_reset,
                "handlesClosed": true,
            },
            "events": {
                "progressCount": progress_count,
                "progressAfterRecovery": progress_after_recovery,
                "timelineMonotonic": timeline_monotonic,
                "sampleMasterMonotonic": sample_master_monotonic,
            },
            "negativeControls": {
                "captureDefaultChangeIgnored": capture_default_change_ignored,
            },
            "durationMs": started_at.elapsed().as_secs_f64() * 1_000.0,
            "claimBoundary": "Proves bounded Preview PCM survives render-default/device invalidation by reopening the current default WASAPI stream, renegotiating format, resampling/remixing the remaining canonical PCM, and preserving monotonic Timeline/sample-master telemetry. A forced notification reopens a real stream; a physical unplug/default-device swap, multi-hour A/V drift, final encoded loudness, and CoreAudio remain separate acceptance cells."
        });
        emit(&receipt)?;
        Ok(receipt)
    }

    /// Plays one bounded, already mixed floating-point preview window through the real
    /// Windows shared event-driven endpoint. Decoding and project staging stay outside
    /// the callback; this function owns endpoint recovery, sample-rate/channel conversion,
    /// the lock-free device ring, and hardware/sample-master clock telemetry.
    pub fn physical_output_play_preview_pcm(
        pcm: &[f32],
        source_sample_rate: u32,
        source_channels: u16,
        timeline_start_seconds: f64,
        emit: impl FnMut(&Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        physical_output_play_preview_pcm_with_control(
            pcm,
            source_sample_rate,
            source_channels,
            timeline_start_seconds,
            PreviewRecoveryControl::default(),
            emit,
        )
    }

    pub fn physical_output_preview_recovery_selftest_receipt() -> Result<Value, String> {
        let source_sample_rate = 48_000_u32;
        let source_channels = 2_u16;
        let source_frames = 96_000_usize;
        let mut pcm = Vec::with_capacity(source_frames * source_channels as usize);
        for index in 0..source_frames {
            let sample = if index % 2 == 0 { 1.0e-8 } else { -1.0e-8 };
            pcm.extend_from_slice(&[sample, -sample]);
        }
        let mut emitted = Vec::new();
        let receipt = physical_output_play_preview_pcm_with_control(
            &pcm,
            source_sample_rate,
            source_channels,
            0.375,
            PreviewRecoveryControl {
                force_after_callbacks: Some(4),
            },
            |event| {
                emitted.push(event.clone());
                Ok(())
            },
        )?;
        if receipt["recovery"]["recoveryEvents"].as_u64() != Some(1)
            || receipt["recovery"]["physicalStreamReopens"].as_u64() != Some(1)
        {
            return Err("preview recovery self-test did not reopen exactly one stream".into());
        }
        let kinds: Vec<String> = emitted
            .iter()
            .filter_map(|event| event["event"].as_str().map(str::to_string))
            .collect();
        let mut timeline_monotonic = true;
        let mut sample_master_monotonic = true;
        let mut timeline_regression_seconds = 0.0_f64;
        let mut sample_master_regression_frames = 0_u64;
        let mut previous_timeline = f64::NEG_INFINITY;
        let mut previous_sample_master = 0_u64;
        for event in &emitted {
            if let Some(timeline) = event["timelineSeconds"].as_f64() {
                if timeline < previous_timeline {
                    timeline_monotonic = false;
                    timeline_regression_seconds =
                        timeline_regression_seconds.max(previous_timeline - timeline);
                }
                previous_timeline = previous_timeline.max(timeline);
            }
            if let Some(sample_master) = event["sampleMasterFrame"].as_u64() {
                if sample_master < previous_sample_master {
                    sample_master_monotonic = false;
                    sample_master_regression_frames =
                        sample_master_regression_frames.max(previous_sample_master - sample_master);
                }
                previous_sample_master = previous_sample_master.max(sample_master);
            }
        }
        let invalid_pcm_rejected = physical_output_play_preview_pcm_with_control(
            &[f32::NAN],
            source_sample_rate,
            1,
            0.0,
            PreviewRecoveryControl::default(),
            |_| Ok(()),
        )
        .is_err();
        let retry_policy_rejected = PreviewRecoveryPolicy {
            max_attempts_per_open: 0,
            deadline: Duration::from_millis(PREVIEW_RECOVERY_DEADLINE_MS),
        }
        .validate()
        .is_err()
            && PreviewRecoveryPolicy {
                max_attempts_per_open: PREVIEW_RECOVERY_MAX_ATTEMPTS + 1,
                deadline: Duration::from_millis(PREVIEW_RECOVERY_DEADLINE_MS + 1),
            }
            .validate()
            .is_err();
        let segments = receipt["segments"]
            .as_array()
            .ok_or("preview recovery receipt omitted segment evidence")?;
        let initial_format = segments
            .first()
            .and_then(|segment| segment.get("format"))
            .cloned()
            .ok_or("preview recovery receipt omitted initial format")?;
        let final_format = segments
            .last()
            .and_then(|segment| segment.get("format"))
            .cloned()
            .ok_or("preview recovery receipt omitted final format")?;
        let mut recovery = receipt["recovery"].clone();
        recovery
            .as_object_mut()
            .ok_or("preview recovery evidence is not an object")?
            .insert(
                "trigger".into(),
                Value::String(
                    "IMMNotificationClient.OnDefaultDeviceChanged(eRender,eConsole)".into(),
                ),
            );
        let progress_count = kinds
            .iter()
            .filter(|kind| kind.as_str() == "progress")
            .count();
        Ok(serde_json::json!({
            "schema": "editkin.wasapi-preview-recovery-gate/v1",
            "status": "GREEN",
            "backend": "WASAPI shared event-driven",
            "productPath": "physical_output_play_preview_pcm/v2",
            "source": { "sampleRate": source_sample_rate, "channels": source_channels, "frames": source_frames },
            "endpoint": {
                "initialIdHash": receipt["endpoint"]["initialIdHash"],
                "finalIdHash": receipt["endpoint"]["finalIdHash"],
                "rawIdsExposed": false,
            },
            "formats": { "initial": initial_format, "final": final_format },
            "events": {
                "kinds": kinds,
                "progressCount": progress_count,
                "progressAfterRecovery": receipt["events"]["progressAfterRecovery"],
                "timelineMonotonic": timeline_monotonic,
                "timelineRegressionSeconds": timeline_regression_seconds,
                "sampleMasterMonotonic": sample_master_monotonic,
                "sampleMasterRegressionFrames": sample_master_regression_frames,
                "endedSourceFrame": receipt["sourceFrame"],
            },
            "recovery": recovery,
            "formatTransitionOracle": format_transition_oracle()?,
            "transport": receipt["transport"],
            "lifecycle": receipt["lifecycle"],
            "negativeControls": {
                "captureDefaultChangeIgnored": receipt["negativeControls"]["captureDefaultChangeIgnored"],
                "invalidPcmRejected": invalid_pcm_rejected,
                "retryPolicyRejected": retry_policy_rejected,
            },
            "claimBoundary": "This release-runtime probe forces one render-default notification through the same IMMNotificationClient and physical Preview function used by Editkin, reopens a real endpoint, and verifies a separate differing-format continuity oracle. It does not claim that the current host physically unplugged or changed its default device."
        }))
    }

    fn render_device_graph_fixture(
        sample_rate: u32,
        channels: u16,
        frames: usize,
    ) -> Result<(Vec<f32>, Value), String> {
        let graph = AudioGraph {
            sample_rate,
            channels,
            master_node: "output".into(),
            nodes: vec![
                AudioNode {
                    id: "program".into(),
                    inputs: vec![],
                    operation: AudioOperation::Source {
                        asset_id: "program-source".into(),
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "program-gain".into(),
                    inputs: vec!["program".into()],
                    operation: AudioOperation::Gain { gain_db: -6.0 },
                    automation: vec![AutomationLane {
                        property: "gainDb".into(),
                        points: vec![
                            AutomationPoint {
                                sample: 0,
                                value: -6.0,
                                interpolation: AutomationInterpolation::Linear,
                            },
                            AutomationPoint {
                                sample: frames.saturating_sub(1) as u64,
                                value: -6.0,
                                interpolation: AutomationInterpolation::Linear,
                            },
                        ],
                    }],
                },
                AudioNode {
                    id: "sidechain".into(),
                    inputs: vec![],
                    operation: AudioOperation::Source {
                        asset_id: "sidechain-source".into(),
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "ducker".into(),
                    inputs: vec!["program-gain".into(), "sidechain".into()],
                    operation: AudioOperation::Ducker {
                        threshold_db: -36.0,
                        floor_db: -12.0,
                        attack_ms: 10.0,
                        release_ms: 180.0,
                    },
                    automation: vec![],
                },
                AudioNode {
                    id: "output".into(),
                    inputs: vec!["ducker".into()],
                    operation: AudioOperation::Output,
                    automation: vec![],
                },
            ],
        };
        let sample_count = frames
            .checked_mul(channels as usize)
            .ok_or("physical audio graph fixture overflow")?;
        // This sub-audible signal proves graph samples reach the device ring without
        // producing an audible self-test tone for the user.
        let program = AudioBuffer {
            sample_rate,
            channels,
            samples: (0..sample_count)
                .map(|index| if index % 2 == 0 { 1.0e-8 } else { -1.0e-8 })
                .collect(),
        };
        let sidechain = AudioBuffer::silence(sample_rate, channels, frames)?;
        let rendered = render_audio_graph(
            &graph,
            &BTreeMap::from([
                ("program-source".into(), program),
                ("sidechain-source".into(), sidechain),
            ]),
        )?;
        let peak = rendered
            .samples
            .iter()
            .map(|sample| sample.abs())
            .fold(0.0_f32, f32::max);
        if peak <= 0.0 || peak >= 1.0e-6 {
            return Err(format!(
                "physical audio graph fixture left its sub-audible safety range: {peak}"
            ));
        }
        let mut hasher = Sha256::new();
        for sample in &rendered.samples {
            hasher.update(sample.to_le_bytes());
        }
        Ok((
            rendered.samples,
            serde_json::json!({
                "nodeCount": graph.nodes.len(),
                "frames": frames,
                "sidechainRouting": true,
                "sampleAutomation": true,
                "peak": peak,
                "subAudible": true,
                "sha256": format!("{:x}", hasher.finalize()),
            }),
        ))
    }

    fn queue_looped_fixture(
        transport: &RealtimeAudioTransport,
        source: &[f32],
        cursor: &mut usize,
        sample_count: usize,
    ) -> Result<(), String> {
        if source.is_empty() {
            return Err("physical audio endurance fixture is empty".into());
        }
        let mut remaining = sample_count;
        while remaining > 0 {
            let contiguous = remaining.min(source.len() - *cursor);
            let written = transport.queue_interleaved(&source[*cursor..*cursor + contiguous])?;
            if written != contiguous {
                return Err(format!(
                    "native audio producer could not keep the device ring full: {written}/{contiguous} samples"
                ));
            }
            *cursor = (*cursor + contiguous) % source.len();
            remaining -= contiguous;
        }
        Ok(())
    }

    fn percentile_micros(samples: &mut [u64], percentile: f64) -> u64 {
        if samples.is_empty() {
            return 0;
        }
        samples.sort_unstable();
        let index = ((samples.len() - 1) as f64 * percentile)
            .round()
            .clamp(0.0, (samples.len() - 1) as f64) as usize;
        samples[index]
    }

    pub fn physical_output_endurance_receipt(duration_seconds: u64) -> Result<Value, String> {
        if !(1..=3_600).contains(&duration_seconds) {
            return Err("audio endurance duration must be 1..=3600 seconds".into());
        }

        let _com = ComApartment::initialize()?;
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|error| windows_error("create MMDevice enumerator", error))?;
        let endpoint_collection =
            unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
                .map_err(|error| windows_error("enumerate active render endpoints", error))?;
        let active_endpoints = unsafe { endpoint_collection.GetCount() }
            .map_err(|error| windows_error("count active render endpoints", error))?;
        if active_endpoints == 0 {
            return Err("WASAPI reports no active render endpoint".into());
        }

        let default_endpoint = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|error| windows_error("open default render endpoint", error))?;
        let default_id = endpoint_id(&default_endpoint)?;
        let mut candidates = vec![(default_endpoint, default_id.clone(), true)];
        for index in 0..active_endpoints {
            let endpoint = unsafe { endpoint_collection.Item(index) }
                .map_err(|error| windows_error("open enumerated render endpoint", error))?;
            let id = endpoint_id(&endpoint)?;
            if id != default_id {
                candidates.push((endpoint, id, false));
            }
        }

        let mut rejected = Vec::new();
        let mut opened = None;
        for (endpoint, id, is_default) in candidates {
            let id_hash = endpoint_hash(&id);
            match try_open_endpoint(&endpoint, id_hash.clone(), is_default) {
                Ok(candidate) => {
                    opened = Some(candidate);
                    break;
                }
                Err(error) => rejected.push(serde_json::json!({
                    "idHash": id_hash,
                    "wasDefault": is_default,
                    "error": error,
                })),
            }
        }
        let OpenedEndpoint {
            audio_client,
            event,
            endpoint_hash: selected_endpoint_hash,
            is_default,
            endpoint_state,
            sample_format,
            channels,
            sample_rate,
            bits_per_sample,
            default_period,
            minimum_period,
        } = opened.ok_or_else(|| {
            format!(
                "no active render endpoint accepted endurance playback: {}",
                serde_json::to_string(&rejected).unwrap_or_else(|_| "[]".into())
            )
        })?;

        let buffer_frames = unsafe { audio_client.GetBufferSize() }
            .map_err(|error| windows_error("read endurance WASAPI buffer size", error))?;
        if buffer_frames == 0 {
            return Err("WASAPI returned an empty endurance buffer".into());
        }
        let render_client: IAudioRenderClient = unsafe { audio_client.GetService() }
            .map_err(|error| windows_error("activate endurance IAudioRenderClient", error))?;
        let audio_clock: IAudioClock = unsafe { audio_client.GetService() }
            .map_err(|error| windows_error("activate endurance IAudioClock", error))?;
        let clock_frequency = unsafe { audio_clock.GetFrequency() }
            .map_err(|error| windows_error("read endurance audio clock frequency", error))?;
        if clock_frequency == 0 {
            return Err("WASAPI endurance clock returned zero frequency".into());
        }

        let transport =
            RealtimeAudioTransport::new(sample_rate, channels, buffer_frames as usize * 4)?;
        let (graph_samples, graph_fixture) =
            render_device_graph_fixture(sample_rate, channels, buffer_frames as usize * 2)?;
        let mut fixture_cursor = 0_usize;
        let mut conversion_scratch = vec![0.0_f32; buffer_frames as usize * channels as usize];
        queue_looped_fixture(
            &transport,
            &graph_samples,
            &mut fixture_cursor,
            buffer_frames as usize * channels as usize,
        )?;
        fill_render_buffer(
            &render_client,
            &transport,
            buffer_frames,
            channels,
            sample_format,
            &mut conversion_scratch,
        )?;

        unsafe { audio_client.Start() }
            .map_err(|error| windows_error("start endurance WASAPI stream", error))?;
        let started_client = StartedClient(&audio_client);
        let started_at = Instant::now();
        let deadline = Duration::from_secs(duration_seconds);
        let mut callback_count = 0_u64;
        let mut callback_frame_total = 0_u64;
        let minimum_period_100ns = minimum_period.max(1) as u64;
        let callback_capacity = duration_seconds
            .saturating_mul(10_000_000)
            .saturating_div(minimum_period_100ns)
            .saturating_add(1_024)
            .min(2_000_000) as usize;
        let mut callback_wait_micros = Vec::with_capacity(callback_capacity);
        let mut previous_callback_at = started_at;
        let mut first_clock_position = None;
        let mut first_clock_qpc_100ns = None;
        let mut final_clock_position = 0_u64;
        let mut final_clock_qpc_100ns = 0_u64;
        let mut previous_clock_position = 0_u64;
        let mut clock_monotonic = true;
        let mut max_clock_lead_frames = 0.0_f64;

        while started_at.elapsed() < deadline {
            match unsafe { WaitForSingleObject(event.0, 1_000) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => {
                    return Err(format!(
                        "WASAPI endurance callback timed out after {callback_count} callbacks"
                    ));
                }
                other => {
                    return Err(format!(
                        "WASAPI endurance callback wait failed: {}",
                        other.0
                    ));
                }
            }
            let callback_at = Instant::now();
            callback_wait_micros.push(
                callback_at
                    .duration_since(previous_callback_at)
                    .as_micros()
                    .min(u64::MAX as u128) as u64,
            );
            previous_callback_at = callback_at;

            let padding = unsafe { audio_client.GetCurrentPadding() }
                .map_err(|error| windows_error("read endurance WASAPI padding", error))?;
            if padding > buffer_frames {
                return Err(format!(
                    "WASAPI endurance padding {padding} exceeds buffer {buffer_frames}"
                ));
            }
            let available = buffer_frames - padding;
            if available > 0 {
                let sample_count = available as usize * channels as usize;
                queue_looped_fixture(
                    &transport,
                    &graph_samples,
                    &mut fixture_cursor,
                    sample_count,
                )?;
                fill_render_buffer(
                    &render_client,
                    &transport,
                    available,
                    channels,
                    sample_format,
                    &mut conversion_scratch,
                )?;
                callback_count += 1;
                callback_frame_total += available as u64;
            }

            let mut clock_position = 0_u64;
            let mut clock_qpc_100ns = 0_u64;
            unsafe { audio_clock.GetPosition(&mut clock_position, Some(&mut clock_qpc_100ns)) }
                .map_err(|error| windows_error("sample endurance audio clock", error))?;
            if previous_clock_position > 0 && clock_position < previous_clock_position {
                clock_monotonic = false;
            }
            if clock_position > 0 {
                first_clock_position.get_or_insert(clock_position);
                first_clock_qpc_100ns.get_or_insert(clock_qpc_100ns);
                final_clock_position = clock_position;
                final_clock_qpc_100ns = clock_qpc_100ns;
                previous_clock_position = clock_position;
                let master_frame = transport.master_frame();
                let clock_frame =
                    clock_position as f64 * sample_rate as f64 / clock_frequency as f64;
                let lead = master_frame as f64 - clock_frame;
                if lead < 0.0 || lead > buffer_frames as f64 * 2.0 {
                    return Err(format!(
                        "endurance sample master left physical clock bound: lead={lead:.3} frames"
                    ));
                }
                max_clock_lead_frames = max_clock_lead_frames.max(lead);
            }
        }

        unsafe { audio_client.Stop() }
            .map_err(|error| windows_error("stop endurance WASAPI stream", error))?;
        std::mem::forget(started_client);
        unsafe { audio_client.Reset() }
            .map_err(|error| windows_error("reset endurance WASAPI stream", error))?;

        let elapsed_ms = started_at.elapsed().as_secs_f64() * 1_000.0;
        let transport_receipt = transport.receipt();
        let expected_master_frame = buffer_frames as u64 + callback_frame_total;
        let master_frame = transport_receipt["masterFrame"].as_u64().unwrap_or(0);
        if master_frame != expected_master_frame {
            return Err(format!(
                "endurance callback frames diverged from sample master: {master_frame}/{expected_master_frame}"
            ));
        }
        let underrun_samples = transport_receipt["underrunSamples"]
            .as_u64()
            .unwrap_or(u64::MAX);
        if underrun_samples != 0 {
            return Err(format!(
                "endurance stream inserted {underrun_samples} unexpected silence samples"
            ));
        }
        let first_position = first_clock_position.ok_or("endurance clock never advanced")?;
        let first_qpc = first_clock_qpc_100ns.ok_or("endurance QPC clock never advanced")?;
        if !clock_monotonic
            || final_clock_position <= first_position
            || final_clock_qpc_100ns <= first_qpc
        {
            return Err("endurance hardware clock did not advance monotonically".into());
        }
        let hardware_elapsed_ms =
            (final_clock_position - first_position) as f64 * 1_000.0 / clock_frequency as f64;
        let qpc_elapsed_ms = (final_clock_qpc_100ns - first_qpc) as f64 / 10_000.0;
        let hardware_qpc_drift_ms = (hardware_elapsed_ms - qpc_elapsed_ms).abs();
        let final_clock_frame =
            final_clock_position as f64 * sample_rate as f64 / clock_frequency as f64;
        let final_clock_lead_frames = master_frame as f64 - final_clock_frame;
        if hardware_qpc_drift_ms > 50.0 {
            return Err(format!(
                "endurance hardware clock drift exceeded 50ms: {hardware_qpc_drift_ms:.3}ms"
            ));
        }

        let mut percentile_samples = callback_wait_micros.clone();
        let p50_callback_wait_micros = percentile_micros(&mut percentile_samples, 0.50);
        let p95_callback_wait_micros = percentile_micros(&mut percentile_samples, 0.95);
        Ok(serde_json::json!({
            "schema": "editkin.wasapi-endurance-gate/v1",
            "status": "GREEN",
            "backend": "WASAPI shared event-driven",
            "duration": {
                "requestedSeconds": duration_seconds,
                "actualMs": elapsed_ms,
            },
            "endpoint": {
                "activeCount": active_endpoints,
                "selectedIdHash": selected_endpoint_hash,
                "selectedWasDefault": is_default,
                "state": endpoint_state,
                "rejectedBeforeSelection": rejected,
            },
            "format": {
                "sampleRate": sample_rate,
                "channels": channels,
                "bitsPerSample": bits_per_sample,
                "sampleFormat": sample_format.label(),
                "negotiatedFromEndpoint": true,
            },
            "device": {
                "bufferFrames": buffer_frames,
                "defaultPeriod100ns": default_period,
                "minimumPeriod100ns": minimum_period,
                "eventCallbacks": callback_count,
                "callbackFramesTotal": callback_frame_total,
                "p50CallbackWaitMicros": p50_callback_wait_micros,
                "p95CallbackWaitMicros": p95_callback_wait_micros,
                "clockFrequency": clock_frequency,
                "firstClockPosition": first_position,
                "finalClockPosition": final_clock_position,
                "clockMonotonic": clock_monotonic,
                "hardwareElapsedMs": hardware_elapsed_ms,
                "qpcElapsedMs": qpc_elapsed_ms,
                "hardwareQpcDriftMs": hardware_qpc_drift_ms,
                "finalClockLeadFrames": final_clock_lead_frames,
                "maxClockLeadFrames": max_clock_lead_frames,
                "started": true,
                "stopped": true,
                "reset": true,
            },
            "transport": transport_receipt,
            "graphToDevice": graph_fixture,
            "negativeControls": {
                "callbackTimeouts": 0,
                "unexpectedUnderrunSamples": underrun_samples,
                "clockRegressionDetected": !clock_monotonic,
            },
            "claimBoundary": "Proves one staged Windows hao-core runtime sustains a real shared event-driven WASAPI endpoint for the requested interval with a bounded hardware/sample-master clock, zero unexpected underrun samples, and zero callback locks/allocations. It does not prove physical hotplug or format-change recovery, multi-hour playback, CoreAudio parity, or final encoded loudness."
        }))
    }

    pub fn physical_output_selftest_receipt() -> Result<Value, String> {
        let _com = ComApartment::initialize()?;
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|error| windows_error("create MMDevice enumerator", error))?;
        let notification_events = Arc::new(AtomicU64::new(0));
        let notification_generation = Arc::new(AtomicU64::new(1));
        let notification_client: IMMNotificationClient = EndpointChangeMonitor {
            total_events: Arc::clone(&notification_events),
            default_render_generation: Arc::clone(&notification_generation),
            selected_render_id: Arc::new(Mutex::new(String::new())),
        }
        .into();
        unsafe { enumerator.RegisterEndpointNotificationCallback(&notification_client) }
            .map_err(|error| windows_error("register endpoint notification callback", error))?;
        let notification_registration = NotificationRegistration {
            enumerator: &enumerator,
            client: notification_client.clone(),
        };
        let endpoint_collection =
            unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
                .map_err(|error| windows_error("enumerate active render endpoints", error))?;
        let active_endpoints = unsafe { endpoint_collection.GetCount() }
            .map_err(|error| windows_error("count active render endpoints", error))?;
        if active_endpoints == 0 {
            return Err("WASAPI reports no active render endpoint".into());
        }

        let default_endpoint = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|error| windows_error("open default render endpoint", error))?;
        let default_id = endpoint_id(&default_endpoint)?;
        let default_id_wide: Vec<u16> = default_id.encode_utf16().chain(Some(0)).collect();
        let default_id_pcwstr = PCWSTR(default_id_wide.as_ptr());
        unsafe {
            notification_client.OnDefaultDeviceChanged(eCapture, eConsole, default_id_pcwstr)
        }
        .map_err(|error| windows_error("dispatch notification negative control", error))?;
        let capture_change_ignored = notification_generation.load(Ordering::Acquire) == 1;
        unsafe { notification_client.OnDefaultDeviceChanged(eRender, eConsole, default_id_pcwstr) }
            .map_err(|error| windows_error("dispatch notification recovery control", error))?;
        let notification_signal_generation = notification_generation.load(Ordering::Acquire);
        let mut candidates = vec![(default_endpoint, default_id.clone(), true)];
        for index in 0..active_endpoints {
            let endpoint = unsafe { endpoint_collection.Item(index) }
                .map_err(|error| windows_error("open enumerated render endpoint", error))?;
            let id = endpoint_id(&endpoint)?;
            if id != default_id {
                candidates.push((endpoint, id, false));
            }
        }

        let mut rejected = Vec::new();
        let mut opened = None;
        for (endpoint, id, is_default) in candidates {
            let id_hash = endpoint_hash(&id);
            match try_open_endpoint(&endpoint, id_hash.clone(), is_default) {
                Ok(candidate) => {
                    opened = Some(candidate);
                    break;
                }
                Err(error) => rejected.push(serde_json::json!({
                    "idHash": id_hash,
                    "wasDefault": is_default,
                    "error": error,
                })),
            }
        }
        let OpenedEndpoint {
            audio_client,
            event,
            endpoint_hash: selected_endpoint_hash,
            is_default,
            endpoint_state,
            sample_format,
            channels,
            sample_rate,
            bits_per_sample,
            default_period,
            minimum_period,
        } = opened.ok_or_else(|| {
            format!(
                "no active render endpoint accepted shared event-driven WASAPI: {}",
                serde_json::to_string(&rejected).unwrap_or_else(|_| "[]".into())
            )
        })?;

        let buffer_frames = unsafe { audio_client.GetBufferSize() }
            .map_err(|error| windows_error("read WASAPI buffer size", error))?;
        if buffer_frames == 0 {
            return Err("WASAPI returned an empty render buffer".into());
        }
        let render_client: IAudioRenderClient = unsafe { audio_client.GetService() }
            .map_err(|error| windows_error("activate IAudioRenderClient", error))?;
        let audio_clock: IAudioClock = unsafe { audio_client.GetService() }
            .map_err(|error| windows_error("activate physical IAudioClock", error))?;
        let clock_frequency = unsafe { audio_clock.GetFrequency() }
            .map_err(|error| windows_error("read physical audio clock frequency", error))?;
        if clock_frequency == 0 {
            return Err("WASAPI physical clock returned zero frequency".into());
        }
        let mut transport =
            RealtimeAudioTransport::new(sample_rate, channels, buffer_frames as usize * 3)?;
        let (graph_samples, graph_fixture) =
            render_device_graph_fixture(sample_rate, channels, buffer_frames as usize * 2)?;
        if transport.queue_interleaved(&graph_samples)? != graph_samples.len() {
            return Err("native audio transport rejected its preallocated WASAPI fixture".into());
        }
        let mut conversion_scratch = vec![0.0_f32; buffer_frames as usize * channels as usize];
        fill_render_buffer(
            &render_client,
            &transport,
            buffer_frames,
            channels,
            sample_format,
            &mut conversion_scratch,
        )?;

        unsafe { audio_client.Start() }
            .map_err(|error| windows_error("start WASAPI render stream", error))?;
        let duplicate_start_rejected = unsafe { audio_client.Start() }.is_err();
        let started = StartedClient(&audio_client);
        let mut callback_frames = [0_u32; CALLBACK_TARGET];
        let mut callback_count = 0_usize;
        while callback_count < CALLBACK_TARGET {
            match unsafe { WaitForSingleObject(event.0, 1_000) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => {
                    return Err(format!(
                        "WASAPI callback event {} timed out",
                        callback_count + 1
                    ));
                }
                other => return Err(format!("WASAPI callback wait failed: {}", other.0)),
            }
            let padding = unsafe { audio_client.GetCurrentPadding() }
                .map_err(|error| windows_error("read WASAPI render padding", error))?;
            if padding > buffer_frames {
                return Err(format!(
                    "WASAPI padding {padding} exceeds buffer {buffer_frames}"
                ));
            }
            let available = buffer_frames - padding;
            if available == 0 {
                continue;
            }
            fill_render_buffer(
                &render_client,
                &transport,
                available,
                channels,
                sample_format,
                &mut conversion_scratch,
            )?;
            callback_frames[callback_count] = available;
            callback_count += 1;
        }
        let mut clock_position = 0_u64;
        let mut clock_qpc_100ns = 0_u64;
        unsafe { audio_clock.GetPosition(&mut clock_position, Some(&mut clock_qpc_100ns)) }
            .map_err(|error| windows_error("read physical audio clock position", error))?;
        unsafe { audio_client.Stop() }
            .map_err(|error| windows_error("stop WASAPI render stream", error))?;
        std::mem::forget(started);
        unsafe { audio_client.Reset() }
            .map_err(|error| windows_error("reset WASAPI render stream", error))?;

        let pre_recovery_transport_receipt = transport.receipt();
        let callback_frame_total: u64 = callback_frames.iter().map(|value| *value as u64).sum();
        let expected_master_frame = buffer_frames as u64 + callback_frame_total;
        if pre_recovery_transport_receipt["masterFrame"].as_u64() != Some(expected_master_frame) {
            return Err("WASAPI callback and native sample master clock diverged".into());
        }
        let clock_frame = clock_position as f64 * sample_rate as f64 / clock_frequency as f64;
        let clock_lead_frames = expected_master_frame as f64 - clock_frame;
        if clock_position == 0
            || clock_frame > expected_master_frame as f64
            || !(0.0..=buffer_frames as f64 * 2.0).contains(&clock_lead_frames)
        {
            return Err(format!(
                "native transport is not bounded to the physical audio clock: clockFrame={clock_frame:.3} masterFrame={expected_master_frame} lead={clock_lead_frames:.3}"
            ));
        }
        let underrun_samples = pre_recovery_transport_receipt["underrunSamples"]
            .as_u64()
            .unwrap_or(0);
        if underrun_samples == 0 {
            return Err("WASAPI gate did not exercise the underrun-to-silence path".into());
        }
        if !duplicate_start_rejected {
            return Err("WASAPI accepted an invalid duplicate stream start".into());
        }
        let transport_recovery_generation = if notification_signal_generation > 1 {
            transport.recover_device()
        } else {
            return Err("default-render notification did not request transport recovery".into());
        };
        if !capture_change_ignored || transport_recovery_generation != 2 {
            return Err(
                "WASAPI notification routing or transport recovery generation failed".into(),
            );
        }

        // Exercise the same reopen sequence the runtime uses after a notification.
        // The gate intentionally reopens the unchanged default endpoint; a real
        // unplug/default-device swap remains a separate manual hardware holdout.
        let reopen_endpoint = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|error| windows_error("reopen default render endpoint", error))?;
        let reopen_id = endpoint_id(&reopen_endpoint)?;
        let reopened = try_open_endpoint(&reopen_endpoint, endpoint_hash(&reopen_id), true)?;
        if reopened.sample_rate != sample_rate || reopened.channels != channels {
            return Err(
                "default endpoint format changed during recovery control; resample/remix reopen is not implemented"
                    .into(),
            );
        }
        let reopen_buffer_frames = unsafe { reopened.audio_client.GetBufferSize() }
            .map_err(|error| windows_error("read reopened WASAPI buffer size", error))?;
        let reopen_render_client: IAudioRenderClient =
            unsafe { reopened.audio_client.GetService() }
                .map_err(|error| windows_error("activate reopened IAudioRenderClient", error))?;
        let mut reopen_scratch =
            vec![0.0_f32; reopen_buffer_frames as usize * reopened.channels as usize];
        fill_render_buffer(
            &reopen_render_client,
            &transport,
            reopen_buffer_frames,
            reopened.channels,
            reopened.sample_format,
            &mut reopen_scratch,
        )?;
        unsafe { reopened.audio_client.Start() }
            .map_err(|error| windows_error("start reopened WASAPI stream", error))?;
        let reopened_started = StartedClient(&reopened.audio_client);
        match unsafe { WaitForSingleObject(reopened.event.0, 1_000) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => return Err("reopened WASAPI stream callback timed out".into()),
            other => return Err(format!("reopened WASAPI callback wait failed: {}", other.0)),
        }
        let reopen_padding = unsafe { reopened.audio_client.GetCurrentPadding() }
            .map_err(|error| windows_error("read reopened WASAPI padding", error))?;
        if reopen_padding > reopen_buffer_frames {
            return Err("reopened WASAPI padding exceeds its buffer".into());
        }
        let reopen_callback_frames = reopen_buffer_frames - reopen_padding;
        if reopen_callback_frames == 0 {
            return Err("reopened WASAPI callback exposed no writable frames".into());
        }
        fill_render_buffer(
            &reopen_render_client,
            &transport,
            reopen_callback_frames,
            reopened.channels,
            reopened.sample_format,
            &mut reopen_scratch,
        )?;
        unsafe { reopened.audio_client.Stop() }
            .map_err(|error| windows_error("stop reopened WASAPI stream", error))?;
        std::mem::forget(reopened_started);
        unsafe { reopened.audio_client.Reset() }
            .map_err(|error| windows_error("reset reopened WASAPI stream", error))?;
        let transport_receipt = transport.receipt();
        let expected_after_reopen =
            expected_master_frame + reopen_buffer_frames as u64 + reopen_callback_frames as u64;
        if transport_receipt["masterFrame"].as_u64() != Some(expected_after_reopen) {
            return Err("reopened WASAPI stream diverged from the native sample clock".into());
        }
        unsafe { enumerator.UnregisterEndpointNotificationCallback(&notification_client) }
            .map_err(|error| windows_error("unregister endpoint notification callback", error))?;
        std::mem::forget(notification_registration);
        Ok(serde_json::json!({
            "schema": "editkin.wasapi-physical-output-gate/v2",
            "status": "GREEN",
            "backend": "WASAPI shared event-driven",
            "endpoint": {
                "activeCount": active_endpoints,
                "selectedIdHash": selected_endpoint_hash,
                "selectedWasDefault": is_default,
                "state": endpoint_state,
                "rejectedBeforeSelection": rejected,
            },
            "format": {
                "sampleRate": sample_rate,
                "channels": channels,
                "bitsPerSample": bits_per_sample,
                "sampleFormat": sample_format.label(),
                "negotiatedFromEndpoint": true,
                "autoConvertPcm": false,
            },
            "device": {
                "bufferFrames": buffer_frames,
                "defaultPeriod100ns": default_period,
                "minimumPeriod100ns": minimum_period,
                "eventCallbacks": callback_count,
                "callbackFrames": callback_frames,
                "clockFrequency": clock_frequency,
                "clockPosition": clock_position,
                "clockFrame": clock_frame,
                "clockLeadFrames": clock_lead_frames,
                "clockQpc100ns": clock_qpc_100ns,
                "started": true,
                "stopped": true,
                "reset": true,
            },
            "transport": transport_receipt,
            "graphToDevice": graph_fixture,
            "negativeControls": {
                "duplicateStartRejected": duplicate_start_rejected,
                "underrunFilledWithSilence": underrun_samples > 0,
                "captureDefaultChangeIgnored": capture_change_ignored,
            },
            "deviceRecovery": {
                "notificationRegistered": true,
                "notificationUnregistered": true,
                "callbackDispatchEvents": notification_events.load(Ordering::Acquire),
                "renderSignalGeneration": notification_signal_generation,
                "transportRecoveryGeneration": transport_recovery_generation,
                "physicalStreamReopened": true,
                "reopenedIdHash": reopened.endpoint_hash,
                "reopenBufferFrames": reopen_buffer_frames,
                "reopenCallbackFrames": reopen_callback_frames,
                "realHotplugPerformed": false,
            },
            "claimBoundary": "Proves the native lock-free transport drives one real Windows render endpoint through shared event-driven WASAPI with a preallocated format-conversion scratch, registers an IMMNotificationClient whose render-default signal advances the recovery generation, and physically reopens/restarts the current default stream. Endpoint selection falls back only to another active endpoint that passes the same physical event test. A real unplug/default-device swap, changed-format resample/remix, CoreAudio parity, long-play drift, and final encoded loudness remain open."
        }))
    }

    #[cfg(test)]
    mod tests {
        use super::{
            PREVIEW_RECOVERY_DEADLINE_MS, PREVIEW_RECOVERY_MAX_ATTEMPTS, PreviewRecoveryPolicy,
            format_transition_oracle, physical_output_endurance_receipt,
            physical_output_play_preview_pcm, resample_and_remix_preview_pcm,
        };
        use std::time::Duration;

        #[test]
        fn endurance_duration_is_bounded_before_hardware_access() {
            assert!(
                physical_output_endurance_receipt(0)
                    .unwrap_err()
                    .contains("1..=3600")
            );
            assert!(
                physical_output_endurance_receipt(3_601)
                    .unwrap_err()
                    .contains("1..=3600")
            );
        }

        #[test]
        fn preview_pcm_resamples_and_remixes_without_non_finite_samples() {
            let stereo = [1.0_f32, -1.0, 0.5, -0.5, 0.0, 0.0, -0.5, 0.5];
            let mono = resample_and_remix_preview_pcm(&stereo, 8_000, 2, 16_000, 1)
                .expect("resample stereo preview to mono");
            assert_eq!(mono.len(), 8);
            assert!(mono.iter().all(|sample| sample.is_finite()));
            assert!(resample_and_remix_preview_pcm(&[f32::NAN], 48_000, 1, 48_000, 2).is_err());
            assert!(
                physical_output_play_preview_pcm(&[f32::NAN], 48_000, 1, 0.0, |_| Ok(()))
                    .unwrap_err()
                    .contains("invalid")
            );
        }

        #[test]
        fn preview_recovery_policy_and_format_transition_are_bounded() {
            let oracle = format_transition_oracle().expect("changed-format recovery oracle");
            assert_eq!(oracle["formatsDiffer"], true);
            assert_eq!(oracle["finite"], true);
            assert_eq!(oracle["continuityPreserved"], true);
            assert_eq!(
                oracle["recoveredDeviceFrames"],
                oracle["expectedRecoveredDeviceFrames"]
            );
            assert!(
                PreviewRecoveryPolicy {
                    max_attempts_per_open: 0,
                    deadline: Duration::from_millis(PREVIEW_RECOVERY_DEADLINE_MS),
                }
                .validate()
                .is_err()
            );
            assert!(
                PreviewRecoveryPolicy {
                    max_attempts_per_open: PREVIEW_RECOVERY_MAX_ATTEMPTS + 1,
                    deadline: Duration::from_millis(PREVIEW_RECOVERY_DEADLINE_MS + 1),
                }
                .validate()
                .is_err()
            );
        }
    }
}

#[cfg(windows)]
pub use platform::physical_output_selftest_receipt;

#[cfg(windows)]
pub use platform::physical_output_play_stream;

#[cfg(windows)]
pub use platform::physical_output_play_reader;

#[cfg(windows)]
pub use platform::physical_output_run_session;

#[cfg(not(windows))]
pub fn physical_output_run_session(_io: super::audio_session::SessionIo) -> Result<serde_json::Value, String> {
    Err("resident physical audio sessions are not supported on this platform yet".into())
}

#[cfg(not(windows))]
pub fn physical_output_play_reader<R: super::audio_stream_pull::AudioBlockReader + 'static>(
    _reader:R,_generation:u64,_start:u64,_frames:u64,
    _cancel:std::sync::Arc<std::sync::atomic::AtomicBool>,
    _emit:impl FnMut(&serde_json::Value)->Result<(),String>
) -> Result<serde_json::Value,String> {Err("continuous device playback requires Windows; CoreAudio remains open".into())}

#[cfg(not(windows))]
pub fn physical_output_play_stream(
    _reader: super::audio_stream_file::FileAudioStream,
    _cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    _emit: impl FnMut(&serde_json::Value) -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    Err("continuous streaming audio device playback is Windows-only; CoreAudio is not implemented".into())
}

#[cfg(windows)]
pub use platform::physical_output_endurance_receipt;

#[cfg(windows)]
pub use platform::physical_output_play_preview_pcm;

#[cfg(windows)]
pub use platform::physical_output_preview_recovery_selftest_receipt;

#[cfg(not(windows))]
pub fn physical_output_selftest_receipt() -> Result<serde_json::Value, String> {
    Err("physical audio output selftest is only implemented for Windows WASAPI".into())
}

#[cfg(not(windows))]
pub fn physical_output_endurance_receipt(
    _duration_seconds: u64,
) -> Result<serde_json::Value, String> {
    Err("physical audio endurance test is only implemented for Windows WASAPI".into())
}

#[cfg(not(windows))]
pub fn physical_output_play_preview_pcm(
    _pcm: &[f32],
    _source_sample_rate: u32,
    _source_channels: u16,
    _timeline_start_seconds: f64,
    _emit: impl FnMut(&serde_json::Value) -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    Err("physical audio preview playback is only implemented for Windows WASAPI".into())
}

#[cfg(not(windows))]
pub fn physical_output_preview_recovery_selftest_receipt() -> Result<serde_json::Value, String> {
    Err("physical audio preview recovery selftest is only implemented for Windows WASAPI".into())
}

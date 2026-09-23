// Included inside audio_device::platform::stream_device to share the canonical
// WASAPI endpoint/format/RAII implementation with the existing v1 player.
use crate::engine::{
    audio_stream_file::FileAudioStream,
    audio_stream_pull::{AudioBlockReader, DevicePcmPull},
    audio_stream_transport::{PRODUCER_CANCELLED, PRODUCER_FAILED, StreamProducer},
};
use std::sync::atomic::AtomicBool;

pub fn physical_output_play_stream(
    reader: FileAudioStream,
    cancel: Arc<AtomicBool>,
    emit: impl FnMut(&Value) -> Result<(), String>,
) -> Result<Value, String> {
    let (generation, start, frames) = (reader.generation, reader.start_frame, reader.frame_count);
    play(reader, generation, start, frames, cancel, emit)
}

pub fn play<R: AudioBlockReader + 'static>(
    reader: R,
    generation: u64,
    start: u64,
    frames: u64,
    cancel: Arc<AtomicBool>,
    mut emit: impl FnMut(&Value) -> Result<(), String>,
) -> Result<Value, String> {
    if generation == 0
        || frames == 0
        || start.checked_add(frames).is_none_or(|n| n > 48_000 * 86400)
    {
        return Err("stream playback timeline contract invalid".into());
    }
    if cancel.load(Ordering::Acquire) {
        return Err("stream playback cancelled before device open".into());
    }
    let begun = Instant::now();
    let _com = ComApartment::initialize()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| windows_error("create stream device enumerator", e))?;
    let changes = Arc::new(AtomicU64::new(1));
    let events = Arc::new(AtomicU64::new(0));
    let selected_id = Arc::new(Mutex::new(String::new()));
    let notification: IMMNotificationClient = EndpointChangeMonitor {
        total_events: events.clone(),
        default_render_generation: changes.clone(),
        selected_render_id: selected_id.clone(),
    }
    .into();
    unsafe { enumerator.RegisterEndpointNotificationCallback(&notification) }
        .map_err(|e| windows_error("register streaming endpoint observer", e))?;
    let _registration = NotificationRegistration {
        enumerator: &enumerator,
        client: notification,
    };
    let (opened, id, open_attempts, _) =
        open_default_preview_endpoint(&enumerator, PreviewRecoveryPolicy::product())?;
    *selected_id
        .lock()
        .map_err(|_| "stream endpoint observer poisoned")? = id;
    let observed = changes.load(Ordering::Acquire);
    let format = endpoint_format_receipt(&opened);
    let OpenedEndpoint {
        audio_client,
        event,
        endpoint_hash,
        sample_format,
        channels,
        sample_rate,
        ..
    } = opened;
    let buffer_frames = unsafe { audio_client.GetBufferSize() }
        .map_err(|e| windows_error("read stream buffer size", e))?;
    if !(8_000..=192_000).contains(&sample_rate)
        || !(1..=2).contains(&channels)
        || buffer_frames == 0
        || buffer_frames > 19200
        || buffer_frames.saturating_mul(4) > sample_rate
    {
        return Err("stream endpoint exceeds bounded mono/stereo format or buffer size".into());
    }
    let render: IAudioRenderClient = unsafe { audio_client.GetService() }
        .map_err(|e| windows_error("activate stream render client", e))?;
    let clock: IAudioClock = unsafe { audio_client.GetService() }
        .map_err(|e| windows_error("activate stream clock", e))?;
    let frequency = unsafe { clock.GetFrequency() }
        .map_err(|e| windows_error("read stream clock frequency", e))?;
    if frequency == 0 {
        return Err("stream clock frequency is zero".into());
    }
    let pull = DevicePcmPull::new(reader, generation, start, frames, sample_rate, channels)?;
    let mut producer = StreamProducer::start(
        pull,
        sample_rate,
        channels,
        buffer_frames as usize * 3,
        cancel.clone(),
    )?;
    let mut scratch = vec![0.0; buffer_frames as usize * channels as usize];
    let startup = Instant::now();
    let prefill = (sample_rate as u64 / 4)
        .max(u64::from(buffer_frames) * 2)
        .min(producer.content_frames + u64::from(buffer_frames) * 3);
    while producer.available_frames() < prefill {
        if cancel.load(Ordering::Acquire) {
            return Err("stream playback cancelled during prefill".into());
        }
        if producer.state() == PRODUCER_FAILED {
            return Err(producer.finish().unwrap_err());
        }
        if startup.elapsed() > Duration::from_secs(5) {
            return Err("stream producer prefill exceeded five seconds".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let prefill_ms = startup.elapsed().as_millis() as u64;
    fill_render_buffer(
        &render,
        &producer.transport,
        buffer_frames,
        channels,
        sample_format,
        &mut scratch,
    )?;
    unsafe { audio_client.Start() }
        .map_err(|e| windows_error("start continuous stream device", e))?;
    let started = StartedClient(&audio_client);
    let playback_begun = Instant::now();
    let mut callbacks = 0_u64;
    let mut presented = 0_u64;
    let mut position = 0_u64;
    let mut qpc = 0_u64;
    let mut last_qpc = 0_u64;
    let mut progress = 0_u64;
    let mut last_emit = Instant::now();
    let mut last_progress = Instant::now();
    let mut timeouts = 0;
    let timeline_start = start as f64 / 48000.0;
    let base = |kind: &str, presented: u64, submitted: u64, qpc: u64, callbacks: u64| {
        serde_json::json!({
        "schema":"editkin.native-audio-preview-event/v1","event":kind,"streamGeneration":generation,
        "backend":"WASAPI shared event-driven streaming","timelineStartSeconds":timeline_start,
        "timelineSeconds":timeline_start+presented as f64/48000.0,"presentedFrame":presented,
        "sourceFrame":presented,"sampleMasterFrame":submitted,"sampleMasterRate":48000,
        "deviceGeneration":1,"clockQpc100ns":qpc,"callbackCount":callbacks})
    };
    let mut start_event = base(
        "started",
        0,
        (((producer.transport.master_frame() as u128 * 48000) / sample_rate as u128) as u64)
            .min(frames),
        0,
        0,
    );
    start_event["format"] = format.clone();
    start_event["bufferFrames"] = buffer_frames.into();
    start_event["endpoint"] = serde_json::json!({"idHash":endpoint_hash});
    emit(&start_event)?;
    let run = (|| -> Result<(), String> {
        while presented < frames {
            if cancel.load(Ordering::Acquire) {
                return Err("stream playback cancelled".into());
            }
            if producer.state() == PRODUCER_FAILED {
                return Err(producer.finish().unwrap_err());
            }
            if producer.state() == PRODUCER_CANCELLED {
                return Err("stream producer cancelled".into());
            }
            if changes.load(Ordering::Acquire) != observed {
                return Err("stream endpoint changed; continuous recovery is not admitted on this route yet".into());
            }
            if playback_begun.elapsed() > Duration::from_secs_f64(frames as f64 / 48000.0 + 5.0)
                || last_progress.elapsed() > Duration::from_secs(2)
            {
                return Err("stream hardware clock stalled or exceeded duration deadline".into());
            }
            match unsafe { WaitForSingleObject(event.0, PREVIEW_CALLBACK_WAIT_MS) } {
                WAIT_OBJECT_0 => timeouts = 0,
                WAIT_TIMEOUT => {
                    timeouts += 1;
                    if timeouts >= 40 {
                        return Err("stream device callback timeout".into());
                    }
                    continue;
                }
                other => return Err(format!("stream callback wait failed: {}", other.0)),
            }
            let padding = unsafe { audio_client.GetCurrentPadding() }
                .map_err(|e| windows_error("read streaming device padding", e))?;
            if padding > buffer_frames {
                return Err("stream device padding exceeded buffer".into());
            }
            let available = buffer_frames - padding;
            if available > 0 {
                // Refuse to advance the project over invented silence. The
                // producer runs independently and all submitted frames are real
                // content or explicitly bounded post-content drain padding.
                if producer.available_frames() < u64::from(available) {
                    return Err("stream producer starved before device callback".into());
                }
                fill_render_buffer(
                    &render,
                    &producer.transport,
                    available,
                    channels,
                    sample_format,
                    &mut scratch,
                )?;
                callbacks += 1;
            }
            unsafe { clock.GetPosition(&mut position, Some(&mut qpc)) }
                .map_err(|e| windows_error("read continuous stream clock", e))?;
            if qpc < last_qpc {
                return Err("stream hardware QPC regressed".into());
            }
            last_qpc = qpc;
            // A freshly initialized IAudioClock starts at zero; using an
            // arbitrary first observation as the origin would discard samples.
            let hardware = ((position as u128 * 48000) / frequency as u128) as u64;
            let submitted = (((producer.transport.master_frame() as u128 * 48000)
                / sample_rate as u128) as u64)
                .min(frames);
            let candidate = hardware.min(submitted).min(frames);
            if candidate < presented {
                return Err("stream presented frame regressed".into());
            }
            if candidate > presented {
                last_progress = Instant::now();
            }
            presented = candidate;
            if last_emit.elapsed() >= Duration::from_millis(24) || presented == frames {
                emit(&base("progress", presented, submitted, qpc, callbacks))?;
                progress += 1;
                last_emit = Instant::now();
            }
        }
        Ok(())
    })();
    // RAII still stops the device if Stop itself fails or emit aborts.
    unsafe { audio_client.Stop() }.map_err(|e| windows_error("stop streaming device", e))?;
    std::mem::forget(started);
    unsafe { audio_client.Reset() }.map_err(|e| windows_error("reset streaming device", e))?;
    if let Err(error) = run {
        cancel.store(true, Ordering::Release);
        let _ = producer.finish();
        let mut failure = base(
            if error.contains("cancelled") {
                "cancelled"
            } else {
                "failed"
            },
            presented,
            (((producer.transport.master_frame() as u128 * 48000) / sample_rate as u128) as u64)
                .min(frames),
            qpc,
            callbacks,
        );
        failure["reason"] = error.clone().into();
        let _ = emit(&failure);
        return Err(error);
    }
    let worker_receipt = producer.finish()?;
    if producer.transport.underrun_samples() != 0 {
        return Err("stream device inserted unexpected silence".into());
    }
    let mut receipt = base("ended", frames, frames, qpc, callbacks);
    receipt["receipt"] = serde_json::json!({"schema":"editkin.stream-device-playback/v1","status":"GREEN",
        "deviceOpens":1,"deviceStarts":1,"deviceStops":1,"deviceResets":1,"openAttempts":open_attempts,
        "sourceFrames":frames,"presentedFrames":presented,"deviceContentFrames":producer.content_frames,
        "deviceSampleRate":sample_rate,"format":format,"bufferFrames":buffer_frames,
        "prefillMs":prefill_ms,"elapsedMs":begun.elapsed().as_millis(),"playbackMs":playback_begun.elapsed().as_millis(),
        "progressEvents":progress,"callbacks":callbacks,"clockFrequency":frequency,"lastClockPosition":position,
        "lastClockQpc100ns":qpc,"producer":worker_receipt,"transport":producer.transport.receipt(),
        "boundary":"Continuous stateful PCM-file/DSP playback through one physical WASAPI endpoint. No full mixed PCM allocation. Linear format adaptation only. Endpoint changes fail closed; automatic recovery, codecs, installed UI, physical loopback/lip-sync, macOS and whole-product closure remain open."});
    emit(&receipt)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{audio::AudioBuffer, audio_stream::StreamBlock};
    struct Silent {
        at: u64,
        fail: bool,
    }
    impl AudioBlockReader for Silent {
        fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
            if self.fail && self.at >= 48000 * 2 {
                return Err("injected live producer failure".into());
            }
            if self.at >= 48000 * 4 {
                return Ok(None);
            }
            let at = self.at;
            let n = (48000 * 4 - at).min(2048);
            self.at += n;
            Ok(Some(StreamBlock {
                generation: 1,
                start_frame: at,
                buffer: AudioBuffer {
                    sample_rate: 48000,
                    channels: 2,
                    samples: vec![0.0; n as usize * 2],
                },
            }))
        }
        fn receipt(&self) -> Value {
            serde_json::json!({"syntheticSilence":true})
        }
    }
    #[test]
    #[ignore = "requires the real default Windows render endpoint"]
    fn real_device_cancel_and_producer_failure_are_not_completed() {
        for fail in [false, true] {
            let cancel = Arc::new(AtomicBool::new(false));
            let mut events = Vec::new();
            let token = cancel.clone();
            let result = play(Silent { at: 0, fail }, 1, 0, 48000 * 4, cancel, |event| {
                events.push(event.clone());
                if !fail
                    && event["event"] == "progress"
                    && event["presentedFrame"].as_u64().unwrap_or(0) > 12000
                {
                    token.store(true, Ordering::Release);
                }
                Ok(())
            });
            assert!(result.is_err());
            assert!(events.iter().any(|e| e["event"] == "started"));
            assert!(
                events
                    .iter()
                    .any(|e| e["event"] == "progress"
                        && e["presentedFrame"].as_u64().unwrap_or(0) > 0)
            );
            assert!(!events.iter().any(|e| e["event"] == "ended"));
            assert!(
                events
                    .iter()
                    .any(|e| e["event"] == if fail { "failed" } else { "cancelled" })
            );
            println!(
                "NATIVE_STREAM_DEVICE_NEGATIVE {}",
                serde_json::json!({"failure":fail,"error":result.unwrap_err(),"events":events})
            );
        }
    }
    #[test]
    #[ignore = "requires the real default Windows render endpoint"]
    fn real_device_short_content_has_bounded_start_and_exact_end() {
        struct Short {
            done: bool,
            frames: usize,
        }
        impl AudioBlockReader for Short {
            fn next_block(&mut self) -> Result<Option<StreamBlock>, String> {
                if self.done {
                    return Ok(None);
                }
                self.done = true;
                Ok(Some(StreamBlock {
                    generation: 7,
                    start_frame: 96000,
                    buffer: AudioBuffer {
                        sample_rate: 48000,
                        channels: 2,
                        samples: vec![0.0; self.frames * 2],
                    },
                }))
            }
            fn receipt(&self) -> Value {
                serde_json::json!({"shortSyntheticSilence":true})
            }
        }
        for frames in [1, 100, 480, 4096] {
            let mut events = Vec::new();
            let result = play(
                Short {
                    done: false,
                    frames,
                },
                7,
                96000,
                frames as u64,
                Arc::new(AtomicBool::new(false)),
                |e| {
                    events.push(e.clone());
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(result["event"], "ended");
            assert_eq!(result["presentedFrame"], frames);
            assert_eq!(result["receipt"]["transport"]["underrunSamples"], 0);
            for e in &events {
                let p = e["presentedFrame"].as_u64().unwrap();
                let s = e["sampleMasterFrame"].as_u64().unwrap();
                assert!(p <= s && s <= frames as u64);
                assert_eq!(
                    e["timelineSeconds"].as_f64().unwrap(),
                    2.0 + p as f64 / 48000.0
                );
            }
            println!("NATIVE_STREAM_DEVICE_SHORT {}", result);
        }
    }
}

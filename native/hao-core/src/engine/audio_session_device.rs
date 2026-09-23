// Included inside audio_device::platform::session_device. Endpoint setup,
// format negotiation, notification and buffer-writing implementations stay owned
// by the canonical platform module; one session reuses the initialized client.
use crate::engine::{
    audio_session::{CommandOrder, EventOutput, PreparedPlayback, SessionCommand, SessionIo},
    audio_stream_pull::DevicePcmPull,
    audio_stream_transport::{PRODUCER_CANCELLED, PRODUCER_FAILED, StreamProducer},
};
use std::sync::mpsc::{RecvTimeoutError, TryRecvError};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Preparing,
    Paused,
    Playing,
    Ended,
}
impl Phase {
    fn label(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Paused => "paused",
            Self::Playing => "playing",
            Self::Ended => "ended",
        }
    }
}
#[derive(Default)]
struct Counts {
    starts: u64,
    stops: u64,
    resets: u64,
    producers: u64,
    joined: u64,
    rejected: u64,
}
impl Counts {
    fn receipt(&self) -> Value {
        serde_json::json!({"deviceOpens":1,"deviceStarts":self.starts,"deviceStops":self.stops,
            "deviceResets":self.resets,"producerStarts":self.producers,"producerJoins":self.joined,
            "commandsRejected":self.rejected})
    }
}
struct Active {
    generation: u64,
    start: u64,
    frames: u64,
    request: u64,
    producer: Option<StreamProducer>,
    phase: Phase,
    autoplay: bool,
    presented: u64,
    submitted: u64,
    qpc: u64,
    callbacks: u64,
    created: Instant,
    last_progress: Instant,
    last_emit: Instant,
}
impl Active {
    fn sample_clock(
        &mut self,
        clock: &IAudioClock,
        frequency: u64,
        rate: u32,
    ) -> Result<(), String> {
        let mut position = 0;
        let mut qpc = 0;
        unsafe { clock.GetPosition(&mut position, Some(&mut qpc)) }
            .map_err(|e| windows_error("sample resident clock", e))?;
        let submitted = self.producer.as_ref().map_or(self.submitted, |p| {
            ((p.transport.master_frame() as u128 * 48000 / rate as u128) as u64).min(self.frames)
        });
        let presented = ((position as u128 * 48000 / frequency as u128) as u64)
            .min(submitted)
            .min(self.frames);
        if presented < self.presented || submitted < self.submitted || qpc < self.qpc {
            return Err("resident hardware clock/submission regressed".into());
        }
        if presented > self.presented {
            self.last_progress = Instant::now();
        }
        self.presented = presented;
        self.submitted = submitted;
        self.qpc = qpc;
        Ok(())
    }
}
fn event(
    kind: &str,
    request: u64,
    active: Option<&Active>,
    counts: &Counts,
    dropped: u64,
) -> Value {
    serde_json::json!({"schema":"editkin.native-audio-session-event/v1","event":kind,"requestId":request,
        "streamGeneration":active.map_or(0,|a|a.generation),
        "state":active.map_or("idle",|a|a.phase.label()),
        "timelineStartFrame":active.map_or(0,|a|a.start),
        "timelineFrame":active.map_or(0,|a|a.start+a.presented),
        "presentedFrame":active.map_or(0,|a|a.presented),
        "sampleMasterFrame":active.map_or(0,|a|a.submitted),
        "sampleMasterRate":48000,"clockQpc100ns":active.map_or(0,|a|a.qpc),
        "callbackCount":active.map_or(0,|a|a.callbacks),"deviceGeneration":1,
        "counts":counts.receipt(),"droppedProgressEvents":dropped})
}
fn retire(
    active: &mut Option<Active>,
    client: &IAudioClient,
    counts: &mut Counts,
) -> Result<(), String> {
    let Some(mut a) = active.take() else {
        return Ok(());
    };
    // Always try producer closure even when the hardware stop/reset fails.
    let hardware = (|| -> Result<(), String> {
        if a.phase == Phase::Playing {
            unsafe { client.Stop() }
                .map_err(|e| windows_error("stop retired resident stream", e))?;
            counts.stops += 1;
        }
        if a.phase != Phase::Ended {
            unsafe { client.Reset() }
                .map_err(|e| windows_error("reset retired resident stream", e))?;
            counts.resets += 1;
        }
        Ok(())
    })();
    let worker = if let Some(mut producer) = a.producer.take() {
        let result = producer.cancel_and_finish();
        counts.joined += 1;
        result.map(|_| ())
    } else {
        Ok(())
    };
    match (hardware, worker) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(a), Err(b)) => Err(format!("{a}; producer: {b}")),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}
pub fn run(io: SessionIo) -> Result<Value, String> {
    let _com = ComApartment::initialize()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| windows_error("create resident device enumerator", e))?;
    let changes = Arc::new(AtomicU64::new(1));
    let notifications = Arc::new(AtomicU64::new(0));
    let selected = Arc::new(Mutex::new(String::new()));
    let notification: IMMNotificationClient = EndpointChangeMonitor {
        total_events: notifications,
        default_render_generation: changes.clone(),
        selected_render_id: selected.clone(),
    }
    .into();
    unsafe { enumerator.RegisterEndpointNotificationCallback(&notification) }
        .map_err(|e| windows_error("register resident endpoint observer", e))?;
    let _registration = NotificationRegistration {
        enumerator: &enumerator,
        client: notification,
    };
    let (opened, id, attempts, _) =
        open_default_preview_endpoint(&enumerator, PreviewRecoveryPolicy::product())?;
    *selected
        .lock()
        .map_err(|_| "resident endpoint observer poisoned")? = id;
    let observed = changes.load(Ordering::Acquire);
    let client = &opened.audio_client;
    // Also stops the client on a command, observer, event-queue or driver error.
    let _stop = StartedClient(client);
    let rate = opened.sample_rate;
    let channels = opened.channels;
    let buffers =
        unsafe { client.GetBufferSize() }.map_err(|e| windows_error("resident buffer size", e))?;
    if !(8000..=192000).contains(&rate)
        || !(1..=2).contains(&channels)
        || buffers == 0
        || buffers > 19200
        || buffers.saturating_mul(4) > rate
    {
        return Err("resident endpoint exceeds bounded format/buffer contract".into());
    }
    let render: IAudioRenderClient =
        unsafe { client.GetService() }.map_err(|e| windows_error("resident render client", e))?;
    let clock: IAudioClock =
        unsafe { client.GetService() }.map_err(|e| windows_error("resident clock", e))?;
    let frequency = unsafe { clock.GetFrequency() }
        .map_err(|e| windows_error("resident clock frequency", e))?;
    if frequency == 0 {
        return Err("resident clock frequency is zero".into());
    }
    let mut scratch = vec![0.0; buffers as usize * channels as usize];
    let mut counts = Counts::default();
    let mut order = CommandOrder::default();
    let mut output = EventOutput::default();
    let mut active: Option<Active> = None;
    let mut max_generation = 0;
    let result = (|| -> Result<Value, String> {
        let mut ready = event("ready", 0, None, &counts, output.dropped_progress);
        ready["format"] = endpoint_format_receipt(&opened);
        ready["endpoint"] =
            serde_json::json!({"idHash":opened.endpoint_hash,"openAttempts":attempts});
        output.send(&io, ready)?;
        loop {
            if changes.load(Ordering::Acquire) != observed {
                return Err("resident endpoint changed; seamless recovery not admitted yet".into());
            }
            // One command per iteration prevents a flooded controller from
            // starving a live audio callback. Both queues have fixed capacities.
            let command = if active
                .as_ref()
                .is_some_and(|a| matches!(a.phase, Phase::Playing | Phase::Preparing))
            {
                match io.commands.try_recv() {
                    Ok(c) => Some(c),
                    Err(TryRecvError::Empty) => None,
                    Err(TryRecvError::Disconnected) => {
                        return Err("resident command controller disconnected".into());
                    }
                }
            } else {
                match io.commands.recv_timeout(Duration::from_millis(25)) {
                    Ok(c) => Some(c),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err("resident command controller disconnected".into());
                    }
                }
            };
            if let Some(command) = command {
                let request = command.request();
                let rejection = if !order.accept(request) {
                    Some("stale or duplicate request")
                } else {
                    match &command {
                        SessionCommand::Replace { playback, .. }
                            if playback.generation <= max_generation =>
                        {
                            Some("stale stream generation")
                        }
                        SessionCommand::Pause { generation, .. }
                        | SessionCommand::Resume { generation, .. }
                            if active.as_ref().is_none_or(|a| {
                                a.generation != *generation || a.phase == Phase::Ended
                            }) =>
                        {
                            Some("inactive stream generation")
                        }
                        _ => None,
                    }
                };
                if let Some(reason) = rejection {
                    counts.rejected += 1;
                    let mut e = event(
                        "rejected",
                        request,
                        active.as_ref(),
                        &counts,
                        output.dropped_progress,
                    );
                    e["reason"] = reason.into();
                    output.send(&io, e)?;
                } else {
                    match command {
                        SessionCommand::Replace {
                            request,
                            playback,
                            autoplay,
                        } => {
                            retire(&mut active, client, &mut counts)?;
                            let PreparedPlayback {
                                reader,
                                generation,
                                start,
                                frames,
                                cancel,
                            } = playback;
                            let pull = DevicePcmPull::new(
                                reader, generation, start, frames, rate, channels,
                            )?;
                            let producer = StreamProducer::start(
                                pull,
                                rate,
                                channels,
                                buffers as usize * 3,
                                cancel,
                            )?;
                            counts.producers += 1;
                            max_generation = generation;
                            active = Some(Active {
                                generation,
                                start,
                                frames,
                                request,
                                producer: Some(producer),
                                phase: Phase::Preparing,
                                autoplay,
                                presented: 0,
                                submitted: 0,
                                qpc: 0,
                                callbacks: 0,
                                created: Instant::now(),
                                last_progress: Instant::now(),
                                last_emit: Instant::now(),
                            });
                            output.send(
                                &io,
                                event(
                                    "loading",
                                    request,
                                    active.as_ref(),
                                    &counts,
                                    output.dropped_progress,
                                ),
                            )?;
                        }
                        SessionCommand::Pause { request, .. } => {
                            let a = active.as_mut().unwrap();
                            if a.phase == Phase::Playing {
                                unsafe { client.Stop() }
                                    .map_err(|e| windows_error("pause resident audio", e))?;
                                counts.stops += 1;
                                a.sample_clock(&clock, frequency, rate)?;
                                a.phase = Phase::Paused;
                            }
                            a.autoplay = false;
                            output.send(
                                &io,
                                event(
                                    if a.phase == Phase::Preparing {
                                        "pause-pending"
                                    } else {
                                        "paused"
                                    },
                                    request,
                                    Some(a),
                                    &counts,
                                    output.dropped_progress,
                                ),
                            )?;
                        }
                        SessionCommand::Resume { request, .. } => {
                            let a = active.as_mut().unwrap();
                            if a.phase == Phase::Paused {
                                unsafe { client.Start() }
                                    .map_err(|e| windows_error("resume resident audio", e))?;
                                counts.starts += 1;
                                a.phase = Phase::Playing;
                                a.last_progress = Instant::now();
                            }
                            a.autoplay = true;
                            output.send(
                                &io,
                                event(
                                    if a.phase == Phase::Preparing {
                                        "resume-pending"
                                    } else {
                                        "resumed"
                                    },
                                    request,
                                    Some(a),
                                    &counts,
                                    output.dropped_progress,
                                ),
                            )?;
                        }
                        SessionCommand::Snapshot { request } => {
                            if let Some(a) = active.as_mut() {
                                if a.phase == Phase::Paused || a.phase == Phase::Playing {
                                    a.sample_clock(&clock, frequency, rate)?;
                                }
                            }
                            output.send(
                                &io,
                                event(
                                    "snapshot",
                                    request,
                                    active.as_ref(),
                                    &counts,
                                    output.dropped_progress,
                                ),
                            )?;
                        }
                        SessionCommand::Close { request } => {
                            retire(&mut active, client, &mut counts)?;
                            let mut closed =
                                event("closed", request, None, &counts, output.dropped_progress);
                            closed["status"] = "SOURCE_ONLY".into();
                            output.send(&io, closed.clone())?;
                            return Ok(closed);
                        }
                    }
                }
            }
            let Some(a) = active.as_mut() else { continue };
            if a.phase == Phase::Ended {
                continue;
            }
            let producer = a.producer.as_mut().ok_or("resident producer missing")?;
            if producer.state() == PRODUCER_FAILED || producer.state() == PRODUCER_CANCELLED {
                return Err("resident producer failed or cancelled unexpectedly".into());
            }
            if a.phase == Phase::Preparing {
                let prefill = (rate as u64 / 4)
                    .max(buffers as u64 * 2)
                    .min(producer.content_frames + buffers as u64 * 3);
                if producer.available_frames() < prefill {
                    if a.created.elapsed() > Duration::from_secs(5) {
                        return Err("resident producer prefill exceeded five seconds".into());
                    }
                    std::thread::sleep(Duration::from_millis(1));
                    continue;
                }
                fill_render_buffer(
                    &render,
                    &producer.transport,
                    buffers,
                    channels,
                    opened.sample_format,
                    &mut scratch,
                )?;
                a.submitted = ((producer.transport.master_frame() as u128 * 48000 / rate as u128)
                    as u64)
                    .min(a.frames);
                if a.autoplay {
                    unsafe { client.Start() }
                        .map_err(|e| windows_error("start resident audio", e))?;
                    counts.starts += 1;
                    a.phase = Phase::Playing;
                } else {
                    a.phase = Phase::Paused;
                }
                a.last_progress = Instant::now();
                let mut e = event(
                    if a.autoplay { "started" } else { "prepared" },
                    a.request,
                    Some(a),
                    &counts,
                    output.dropped_progress,
                );
                e["prefillMs"] = (a.created.elapsed().as_millis() as u64).into();
                output.send(&io, e)?;
                continue;
            }
            if a.phase == Phase::Paused {
                continue;
            }
            if a.last_progress.elapsed() > Duration::from_secs(2) {
                return Err("resident hardware clock stalled".into());
            }
            match unsafe { WaitForSingleObject(opened.event.0, PREVIEW_CALLBACK_WAIT_MS) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => continue,
                other => return Err(format!("resident device wait failed: {}", other.0)),
            }
            let padding = unsafe { client.GetCurrentPadding() }
                .map_err(|e| windows_error("resident padding", e))?;
            if padding > buffers {
                return Err("resident padding exceeds buffer".into());
            }
            let available = buffers - padding;
            if available > 0 {
                if producer.available_frames() < available as u64 {
                    return Err("resident producer starved before callback".into());
                }
                fill_render_buffer(
                    &render,
                    &producer.transport,
                    available,
                    channels,
                    opened.sample_format,
                    &mut scratch,
                )?;
                a.callbacks += 1;
            }
            a.sample_clock(&clock, frequency, rate)?;
            if a.presented == a.frames {
                unsafe { client.Stop() }
                    .map_err(|e| windows_error("stop ended resident stream", e))?;
                counts.stops += 1;
                // Reset both the driver's pending data and clock before a
                // replacement generation; an old ring is never shared or reused.
                unsafe { client.Reset() }
                    .map_err(|e| windows_error("reset ended resident stream", e))?;
                counts.resets += 1;
                a.phase = Phase::Ended;
                let mut producer = a.producer.take().unwrap();
                let receipt = producer.finish()?;
                counts.joined += 1;
                if producer.transport.underrun_samples() != 0 {
                    return Err("resident unexpected silence insertion".into());
                }
                let mut e = event(
                    "ended",
                    a.request,
                    Some(a),
                    &counts,
                    output.dropped_progress,
                );
                e["producer"] = receipt;
                e["transport"] = producer.transport.receipt();
                output.send(&io, e)?;
            } else if a.last_emit.elapsed() >= Duration::from_millis(24) {
                output.send(
                    &io,
                    event(
                        "progress",
                        a.request,
                        Some(a),
                        &counts,
                        output.dropped_progress,
                    ),
                )?;
                a.last_emit = Instant::now();
            }
        }
    })();
    let cleanup = retire(&mut active, client, &mut counts);
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(primary), cleanup) => {
            let reason = match cleanup {
                Ok(()) => primary,
                Err(e) => format!("{primary}; cleanup: {e}"),
            };
            let mut e = event("failed", 0, None, &counts, output.dropped_progress);
            e["reason"] = reason.clone().into();
            let _ = output.send(&io, e);
            Err(reason)
        }
        (Ok(_), Err(error)) => Err(error),
    }
}

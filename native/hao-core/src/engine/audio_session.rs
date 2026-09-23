//! Bounded in-process controller boundary for a resident native audio endpoint.
//! Readers are prepared on a worker before submission. This is not a renderer
//! file-path/codec authority and does not claim DSP-seek or UI integration.
use super::audio_stream_pull::AudioBlockReader;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender, TrySendError},
};
use std::time::Duration;

pub const COMMAND_CAPACITY: usize = 8;
pub const EVENT_CAPACITY: usize = 64;

#[cfg(all(test, windows))]
#[path = "audio_session_tests.rs"]
mod hardware_tests;

pub struct PreparedPlayback {
    pub(crate) generation: u64,
    pub(crate) start: u64,
    pub(crate) frames: u64,
    pub(crate) reader: Box<dyn AudioBlockReader>,
    pub(crate) cancel: Arc<AtomicBool>,
}
impl PreparedPlayback {
    /// The reader MUST use this cancellation token for its blocking IO. Reader
    /// shutdown is bounded; no untrusted/plugin reader is admitted by this API.
    pub fn new<R: AudioBlockReader + 'static>(
        reader: R,
        generation: u64,
        start: u64,
        frames: u64,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        if generation == 0
            || frames == 0
            || start
                .checked_add(frames)
                .is_none_or(|n| n > 48_000 * 86_400)
            || cancel.load(Ordering::Acquire)
        {
            return Err("resident playback range/generation/cancellation invalid".into());
        }
        Ok(Self {
            generation,
            start,
            frames,
            reader: Box::new(reader),
            cancel,
        })
    }
}
pub enum SessionCommand {
    Replace {
        request: u64,
        playback: PreparedPlayback,
        autoplay: bool,
    },
    Pause {
        request: u64,
        generation: u64,
    },
    Resume {
        request: u64,
        generation: u64,
    },
    Snapshot {
        request: u64,
    },
    Close {
        request: u64,
    },
}
impl SessionCommand {
    pub(crate) fn request(&self) -> u64 {
        match self {
            Self::Replace { request, .. }
            | Self::Pause { request, .. }
            | Self::Resume { request, .. }
            | Self::Snapshot { request }
            | Self::Close { request } => *request,
        }
    }
}
pub struct SessionClient {
    commands: SyncSender<SessionCommand>,
    events: Receiver<Value>,
}
pub struct SessionIo {
    pub(crate) commands: Receiver<SessionCommand>,
    pub(crate) events: SyncSender<Value>,
}
pub fn channel() -> (SessionClient, SessionIo) {
    let (commands, receiver) = mpsc::sync_channel(COMMAND_CAPACITY);
    let (sender, events) = mpsc::sync_channel(EVENT_CAPACITY);
    (
        SessionClient { commands, events },
        SessionIo {
            commands: receiver,
            events: sender,
        },
    )
}
impl SessionClient {
    pub(crate) fn try_receive(&self) -> Result<Option<Value>, String> {
        match self.events.try_recv() {
            Ok(value) => Ok(Some(value)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err("resident event channel closed".into()),
        }
    }
    /// Never block the UI caller when the command queue is full.
    pub fn submit(&self, command: SessionCommand) -> Result<(), String> {
        self.commands.try_send(command).map_err(|e| match e {
            TrySendError::Full(_) => "resident command queue is full".into(),
            TrySendError::Disconnected(_) => "resident session is closed".into(),
        })
    }
    pub fn receive(&self, timeout: Duration) -> Result<Value, String> {
        self.events.recv_timeout(timeout).map_err(|e| e.to_string())
    }
}
#[derive(Default)]
pub(crate) struct CommandOrder {
    last: u64,
}
impl CommandOrder {
    pub fn accept(&mut self, request: u64) -> bool {
        if request == 0 || request <= self.last {
            return false;
        }
        self.last = request;
        true
    }
}
#[derive(Default)]
pub(crate) struct EventOutput {
    pub dropped_progress: u64,
}
impl EventOutput {
    pub fn send(&mut self, io: &SessionIo, event: Value) -> Result<(), String> {
        let progress = event["event"] == "progress";
        match io.events.try_send(event) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) if progress => {
                self.dropped_progress += 1;
                Ok(())
            }
            Err(TrySendError::Full(_)) => Err("resident critical-event queue is full".into()),
            Err(TrySendError::Disconnected(_)) => {
                Err("resident event controller disconnected".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_order_rejects_zero_duplicate_and_stale_without_rewinding() {
        let mut order = CommandOrder::default();
        assert!(!order.accept(0));
        assert!(order.accept(2));
        assert!(!order.accept(2));
        assert!(!order.accept(1));
        assert!(order.accept(3));
    }
    #[test]
    fn command_queue_backpressure_and_disconnection_are_explicit() {
        let (client, io) = channel();
        for request in 1..=COMMAND_CAPACITY as u64 {
            client.submit(SessionCommand::Snapshot { request }).unwrap();
        }
        assert!(
            client
                .submit(SessionCommand::Close { request: 9 })
                .unwrap_err()
                .contains("full")
        );
        assert_eq!(io.commands.try_recv().unwrap().request(), 1);
        client
            .submit(SessionCommand::Close { request: 10 })
            .unwrap();
        drop(io);
        assert!(
            client
                .submit(SessionCommand::Close { request: 11 })
                .unwrap_err()
                .contains("closed")
        );
    }
    #[test]
    fn slow_event_consumer_drops_only_progress_never_blocks_or_silences_critical_failure() {
        let (_client, io) = channel();
        let mut output = EventOutput::default();
        for _ in 0..EVENT_CAPACITY {
            output
                .send(&io, serde_json::json!({"event":"progress"}))
                .unwrap();
        }
        output
            .send(&io, serde_json::json!({"event":"progress"}))
            .unwrap();
        assert_eq!(output.dropped_progress, 1);
        assert!(
            output
                .send(&io, serde_json::json!({"event":"paused"}))
                .unwrap_err()
                .contains("critical")
        );
    }
}

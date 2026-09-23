//! Bounded native-audio telemetry. The device clock is the authority; consumers
//! read the latest event, never an accumulating per-frame message queue.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read},
    sync::Mutex,
    time::{Duration, Instant},
};

pub const MAX_EVENT_BYTES: usize = 1_048_576;

#[path = "audio_device_clock.rs"]
mod device_clock;

pub fn read_event(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    let count = Read::by_ref(reader)
        .take((MAX_EVENT_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_EVENT_BYTES {
        return Err("原生音訊事件超過 1 MiB 限制".into());
    }
    if bytes.last() != Some(&b'\n') {
        return Err("原生音訊事件在完整回應前中斷".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("原生音訊事件 JSON 無效：{error}"))
}

pub struct EventMailbox {
    state: Mutex<MailboxState>,
}
struct MailboxState {
    latest: Option<(Result<Value, String>, Instant)>,
    clock: Option<device_clock::DeviceClock>,
}
#[derive(Clone, Copy, Debug)]
pub struct ClockSample {
    pub seconds: f64,
    pub ended: bool,
    pub age: Duration,
}
impl Default for EventMailbox {
    fn default() -> Self {
        Self {
            state: Mutex::new(MailboxState {
                latest: None,
                clock: None,
            }),
        }
    }
}
impl EventMailbox {
    pub fn with_timeline_window(start: f64, duration: f64) -> Result<Self, String> {
        Ok(Self {
            state: Mutex::new(MailboxState {
                latest: None,
                clock: Some(device_clock::DeviceClock::new(start, duration)?),
            }),
        })
    }
    pub fn publish(&self, event: Value) -> Result<(), String> {
        let next = event
            .get("timelineSeconds")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or("原生音訊時鐘不合法")?;
        let mut state = self.state.lock().map_err(|_| "原生音訊時鐘狀態失效")?;
        if let Some((previous, _)) = state.latest.as_ref() {
            let previous = previous.as_ref().map_err(Clone::clone)?;
            if previous.get("event").and_then(Value::as_str) == Some("ended") {
                return Err("原生音訊結束後收到多餘事件".into());
            }
            if previous["timelineSeconds"]
                .as_f64()
                .is_some_and(|value| next + 1e-9 < value)
            {
                return Err("原生音訊時鐘倒退".into());
            }
        }
        if let Some(mut clock) = state.clock.clone() {
            let qpc = if event["event"] == "progress" {
                Some(device_clock::qpc_now()?)
            } else {
                None
            };
            clock.admit(&event, qpc)?;
            state.clock = Some(clock);
        }
        state.latest = Some((Ok(event), Instant::now()));
        Ok(())
    }
    pub fn fail(&self, reason: String) {
        let mut slot = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // The reader handles normal EOF separately. Invalid trailing output
        // must remain a failure even if an ended event was admitted first.
        if !slot
            .latest
            .as_ref()
            .is_some_and(|(result, _)| result.is_err())
        {
            slot.latest = Some((Err(reason), Instant::now()));
        }
    }
    pub fn snapshot(&self) -> Result<Option<Value>, String> {
        self.state
            .lock()
            .map_err(|_| "原生音訊時鐘狀態失效".to_string())?
            .latest
            .as_ref()
            .map(|(result, _)| result.clone())
            .transpose()
    }
    /// Native frame scheduling only needs the device clock, not a clone of the
    /// full mix/PCM provenance on every frame. Production uses hardware capture
    /// age and QPC correlation, not time spent waiting in the event pipe.
    pub fn clock_sample(&self) -> Result<ClockSample, String> {
        let mut state = self.state.lock().map_err(|_| "原生音訊時鐘狀態失效")?;
        let (event, received) = state.latest.as_ref().ok_or("原生音訊尚未提供時鐘")?;
        let event = event.as_ref().map_err(Clone::clone)?;
        let raw = event["timelineSeconds"]
            .as_f64()
            .ok_or("原生音訊時鐘不合法")?;
        let ended = event["event"] == "ended";
        let arrival_age = received.elapsed();
        let (seconds, age) = if let Some(clock) = state.clock.as_mut() {
            let (seconds, hardware_age) = clock.sample(raw, Some(device_clock::qpc_now()?))?;
            (seconds, hardware_age.unwrap_or(arrival_age))
        } else {
            (raw, arrival_age)
        };
        Ok(ClockSample {
            seconds,
            ended,
            age,
        })
    }
}

/// Keep full mix provenance native-side; high-frequency UI events need only
/// clock/recovery fields and a generation, not repeated PCM/source receipts.
pub fn status_event(generation: u64, event: &Value) -> Value {
    let mut playback = serde_json::Map::new();
    for key in [
        "schema",
        "event",
        "backend",
        "timelineStartSeconds",
        "timelineSeconds",
        "presentedFrame",
        "sampleMasterFrame",
        "sampleMasterRate",
        "sourceFrame",
        "deviceGeneration",
        "recoveryGeneration",
        "reason",
        "callbackCount",
        "clockQpc100ns",
    ] {
        if let Some(value) = event.get(key) {
            playback.insert(key.into(), value.clone());
        }
    }
    json!({"generation":generation,"active":event["event"] != "ended","playback":playback})
}

#[cfg(test)]
#[path = "audio_preview_events_device_tests.rs"]
pub(crate) mod device_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn rejects_oversized_truncated_and_invalid_utf8_events() {
        assert!(read_event(&mut Cursor::new(vec![b'x'; MAX_EVENT_BYTES + 1])).is_err());
        assert!(read_event(&mut Cursor::new(b"{}".to_vec())).is_err());
        assert!(read_event(&mut Cursor::new(vec![0xff, b'\n'])).is_err());
        assert!(read_event(&mut Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_none());
        assert_eq!(
            read_event(&mut Cursor::new(b"{\"ok\":true}\n"))
                .unwrap()
                .unwrap()["ok"],
            true
        );
    }
    #[test]
    fn slow_consumer_gets_latest_event_without_an_accumulating_queue() {
        let mailbox = EventMailbox::default();
        for frame in 0..10_000 {
            mailbox
                .publish(json!({"event":"progress","timelineSeconds":frame as f64 / 1000.0}))
                .unwrap();
        }
        assert_eq!(
            mailbox.snapshot().unwrap().unwrap()["timelineSeconds"],
            9.999
        );
        mailbox
            .publish(json!({"event":"ended","timelineSeconds":10.0}))
            .unwrap();
        assert_eq!(mailbox.snapshot().unwrap().unwrap()["event"], "ended");
        assert!(mailbox
            .publish(json!({"event":"progress","timelineSeconds":11.0}))
            .is_err());
    }
    #[test]
    fn invalid_trailing_output_is_not_hidden_by_a_terminal_clock() {
        let mailbox = EventMailbox::default();
        mailbox
            .publish(json!({"event":"ended","timelineSeconds":10.0}))
            .unwrap();
        mailbox.fail("invalid trailing output".into());
        assert_eq!(mailbox.snapshot().unwrap_err(), "invalid trailing output");
    }
    #[test]
    fn clock_regression_and_primary_failure_are_not_silenced() {
        let mailbox = EventMailbox::default();
        mailbox
            .publish(json!({"event":"started","timelineSeconds":2.0}))
            .unwrap();
        assert!(mailbox
            .publish(json!({"event":"progress","timelineSeconds":1.0}))
            .is_err());
        mailbox.fail("identity mismatch".into());
        mailbox.fail("EOF".into());
        assert_eq!(mailbox.snapshot().unwrap_err(), "identity mismatch");
    }
    #[test]
    fn ui_clock_projection_excludes_large_private_receipts() {
        let event = status_event(
            7,
            &json!({"event":"ended","timelineSeconds":30,"nativeMix":{"sourcePath":"private"},"segments":[1,2]}),
        );
        assert_eq!(event["generation"], 7);
        assert_eq!(event["active"], false);
        assert!(event["playback"].get("nativeMix").is_none());
        assert!(event["playback"].get("segments").is_none());
    }
}

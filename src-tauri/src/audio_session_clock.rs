//! Versioned resident sample/QPC clock. Independent of the legacy 30 s window.
//! A handle belongs to exactly one stream; replacement/closure invalidates it.
use serde_json::Value;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
#[path = "audio_device_clock.rs"]
mod hardware;
pub const SCHEMA: &str = "editkin.resident-audio-clock/v1";
const RATE: u64 = 48_000;
const MAX_END: u64 = 4_147_200_000;
const TICKS: f64 = 10_000_000.;

#[derive(Clone)]
struct State {
    seen: bool,
    raw: u64,
    supplied: u64,
    qpc: Option<u64>,
    anchor_raw: u64,
    last_qpc: u64,
    last: Option<f64>,
    pause_ceiling: Option<f64>,
    playing: bool,
    ended: bool,
    retired: bool,
    waiting: Instant,
}
pub struct ResidentClock {
    pub generation: u64,
    pub start: u64,
    pub end: u64,
    state: Mutex<State>,
}
impl ResidentClock {
    pub fn new(generation: u64, start: u64, count: u64) -> Result<Self, String> {
        let end = start
            .checked_add(count)
            .filter(|end| *end <= MAX_END)
            .ok_or("Resident clock range exceeds 24 hours")?;
        if generation == 0 || generation > 9_007_199_254_740_991 || count == 0 {
            return Err("Resident clock binding invalid".into());
        }
        Ok(Self {
            generation,
            start,
            end,
            state: Mutex::new(State {
                seen: false,
                raw: 0,
                supplied: 0,
                qpc: None,
                anchor_raw: 0,
                last_qpc: 0,
                last: None,
                pause_ceiling: None,
                playing: false,
                ended: false,
                retired: false,
                waiting: Instant::now(),
            }),
        })
    }
    pub fn retire(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).retired = true;
    }
    pub fn is_retired(&self) -> bool {
        self.state.lock().map(|s| s.retired).unwrap_or(true)
    }
    /// The owner validates the native envelope and request correlation first.
    /// Invalid values are transactional: never replace the last good anchor.
    pub fn admit(&self, event: &Value) -> Result<(), String> {
        let mut slot = self.state.lock().map_err(|_| "Resident clock poisoned")?;
        if slot.retired {
            return Err("Resident clock was retired".into());
        }
        let mut s = slot.clone();
        let number = |key: &str| {
            event[key]
                .as_u64()
                .ok_or_else(|| format!("Resident clock missing {key}"))
        };
        let kind = event["event"]
            .as_str()
            .ok_or("Resident clock event missing")?;
        // Loading has no hardware anchor; preparation may fill the queue while
        // paused. No time advances until a fresh progress capture arrives.
        if !matches!(
            kind,
            "loading"
                | "prepared"
                | "started"
                | "progress"
                | "paused"
                | "resumed"
                | "snapshot"
                | "ended"
        ) {
            return Err("Resident clock event unsupported".into());
        }
        let state = event["state"]
            .as_str()
            .ok_or("Resident clock state missing")?;
        if event["schema"] != "editkin.native-audio-session-event/v1"
            || number("streamGeneration")? != self.generation
            || number("sampleMasterRate")? != RATE
            || number("timelineStartFrame")? != self.start
            || number("deviceGeneration")? != 1
        {
            return Err("Resident clock stream/device identity mismatch".into());
        }
        let raw = number("presentedFrame")?;
        let supplied = number("sampleMasterFrame")?;
        let qpc = number("clockQpc100ns")?;
        if raw > supplied
            || supplied > self.end - self.start
            || number("timelineFrame")? != self.start + raw
            || raw < s.raw
            || supplied < s.supplied
        {
            return Err("Resident clock sample range regressed or escaped plan".into());
        }
        if s.ended {
            if kind == "snapshot" && state == "ended" && raw == self.end - self.start {
                return Ok(());
            }
            return Err("Resident clock received work after end".into());
        }
        let playing = state == "playing";
        if !matches!(state, "preparing" | "playing" | "paused" | "ended")
            || kind == "progress" && !playing
            || kind == "paused" && state != "paused"
            || kind == "ended" && (state != "ended" || raw != self.end - self.start)
        {
            return Err("Resident clock phase/sample mismatch".into());
        }
        if qpc < s.last_qpc {
            return Err("Resident hardware QPC regressed".into());
        }
        if kind == "progress" || kind == "snapshot" && playing {
            if qpc == 0
                || kind == "progress" && qpc == s.last_qpc
                || qpc == s.last_qpc && (s.qpc != Some(qpc) || raw != s.anchor_raw)
            {
                return Err("Resident hardware QPC replayed/regressed".into());
            }
            // Position and capture time form one indivisible anchor. A playing
            // snapshot takes a fresh device capture just like progress does.
            s.qpc = Some(qpc);
            s.anchor_raw = raw;
        } else if !playing || !s.playing {
            s.qpc = None;
            s.waiting = Instant::now();
        }
        if state == "paused" && s.playing {
            let stopped = (self.start + raw) as f64 / RATE as f64;
            s.pause_ceiling = s.last.filter(|last| *last > stopped);
            if s.pause_ceiling
                .is_some_and(|last| last - stopped > hardware::MAX_SAMPLE_AGE.as_secs_f64())
            {
                return Err("Resident pause discontinuity exceeds hardware age bound".into());
            }
        }
        s.last_qpc = qpc;
        s.raw = raw;
        s.supplied = supplied;
        s.playing = playing;
        s.ended = kind == "ended";
        s.seen = true;
        *slot = s;
        Ok(())
    }
    pub fn sample(&self) -> Result<(f64, bool, Duration), String> {
        // Read QPC after acquiring the anchor lock: otherwise a fresh capture
        // admitted between these operations can appear to be in the future.
        let mut s = self.state.lock().map_err(|_| "Resident clock poisoned")?;
        self.sample_state(&mut s, hardware::qpc_now()?)
    }
    pub fn sample_at(&self, now: u64) -> Result<(f64, bool, Duration), String> {
        let mut s = self.state.lock().map_err(|_| "Resident clock poisoned")?;
        self.sample_state(&mut s, now)
    }
    fn sample_state(&self, s: &mut State, now: u64) -> Result<(f64, bool, Duration), String> {
        if s.retired || !s.seen {
            return Err("Resident clock retired or not prepared".into());
        }
        let raw = (self.start + s.raw) as f64 / RATE as f64;
        let (projected, age) = if s.playing && !s.ended && s.qpc.is_some() {
            let qpc = s.qpc.unwrap();
            let ticks = now
                .checked_sub(qpc)
                .ok_or("Resident hardware QPC is in the future")?;
            if ticks > 2_500_000 {
                return Err("Resident hardware clock expired after 250 ms".into());
            }
            let elapsed = ticks as f64 / TICKS;
            (
                ((self.start + s.anchor_raw) as f64 / RATE as f64 + elapsed)
                    .min((self.start + s.supplied) as f64 / RATE as f64)
                    .min(self.end as f64 / RATE as f64),
                Duration::from_nanos(ticks * 100),
            )
        } else {
            // Resume acknowledgement precedes the first device capture. Hold
            // the actual sample position; Instant is a watchdog, NOT a clock
            // for advancing video while waiting for QPC.
            if s.playing && s.waiting.elapsed() > hardware::MAX_SAMPLE_AGE {
                return Err("Resident resume hardware capture timed out".into());
            }
            (raw, Duration::ZERO)
        };
        // Pause can arrive after the last interpolation. Hold exactly that
        // already-published ceiling until the resumed device catches it; never
        // advance a paused clock, enlarge the ceiling, or relax normal drift.
        if s.playing
            && s.pause_ceiling.is_some_and(|ceiling| projected < ceiling)
            && s.waiting.elapsed() > hardware::MAX_SAMPLE_AGE
        {
            return Err("Resident pause catch-up exceeded 250 ms".into());
        }
        if s.playing
            && s.last.is_some_and(|last| last - projected > 0.002)
            && !s
                .pause_ceiling
                .is_some_and(|ceiling| s.last.unwrap() <= ceiling)
        {
            return Err(format!("Resident correlated clock regressed beyond 2 ms: last={:?}, projected={projected}, raw={raw}, qpc={:?}", s.last, s.qpc));
        }
        if s.playing
            && s.qpc.is_some()
            && s.pause_ceiling.is_some_and(|ceiling| projected >= ceiling)
        {
            s.pause_ceiling = None;
        }
        let seconds = projected
            .max(s.last.unwrap_or(projected))
            .min(self.end as f64 / RATE as f64);
        s.last = Some(seconds);
        Ok((seconds, s.ended, age))
    }
}

#[cfg(test)]
#[path = "audio_session_clock_tests.rs"]
mod tests;

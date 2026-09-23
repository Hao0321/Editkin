//! Native resident-video transport. The GPU FIFO owns execution; this registry
//! owns clock/generation/telemetry state, never a second rendering thread.
use crate::audio_preview_events::ClockSample;
use crate::audio_preview_events::EventMailbox;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub type EventSink = Arc<dyn Fn(Value) -> bool + Send + Sync>;
const UI_INTERVAL: Duration = Duration::from_millis(100);
const AUDIO_MAX_AGE: Duration = Duration::from_millis(250);

pub trait AudioClockSource: Send + Sync {
    fn clock_sample(&self) -> Result<ClockSample, String>;
}
impl AudioClockSource for EventMailbox {
    fn clock_sample(&self) -> Result<ClockSample, String> {
        EventMailbox::clock_sample(self)
    }
}
struct SampleClock<F>(F);
impl<F: Fn() -> Result<ClockSample, String> + Send + Sync> AudioClockSource for SampleClock<F> {
    fn clock_sample(&self) -> Result<ClockSample, String> {
        (self.0)()
    }
}
pub fn sample_clock(
    read: impl Fn() -> Result<ClockSample, String> + Send + Sync + 'static,
) -> Arc<dyn AudioClockSource> {
    Arc::new(SampleClock(read))
}

#[derive(Clone)]
pub struct GraphBinding {
    pub session: String,
    pub numerator: u64,
    pub denominator: u64,
    pub device_generation: u64,
    required_nodes: Vec<String>,
}
impl GraphBinding {
    pub fn from_load(session: &str, graph: &Value, receipt: &Value) -> Result<Self, String> {
        let numerator = graph["timebase"]["numerator"]
            .as_u64()
            .ok_or("Native transport timebase numerator missing")?;
        let denominator = graph["timebase"]["denominator"]
            .as_u64()
            .ok_or("Native transport timebase denominator missing")?;
        if numerator == 0
            || denominator == 0
            || denominator > 1_000_000
            || numerator > 1_000_000
            || !(1.0..=240.0).contains(&(denominator as f64 / numerator as f64))
        {
            return Err("Native transport requires a 1..=240 fps rational timebase".into());
        }
        let required_nodes = graph["nodes"]
            .as_array()
            .ok_or("Native transport graph nodes missing")?
            .iter()
            .map(|node| {
                node["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Native transport node ID missing".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if required_nodes.is_empty()
            || required_nodes.len() > 4096
            || session.is_empty()
            || session.len() > 128
        {
            return Err("Native transport graph identity exceeds bounds".into());
        }
        let binding = Self {
            session: session.to_owned(),
            numerator,
            denominator,
            required_nodes,
            device_generation: receipt["generation"]
                .as_u64()
                .ok_or("Native transport device generation missing")?,
        };
        if receipt["sessionId"] != session || !binding.coverage_valid(receipt) {
            return Err("Native transport load did not execute the complete graph".into());
        }
        Ok(binding)
    }
    fn frame_seconds(&self) -> f64 {
        self.numerator as f64 / self.denominator as f64
    }
    fn coverage_valid(&self, receipt: &Value) -> bool {
        let coverage = &receipt["engineGraph"];
        coverage["directExecution"] == true
            && coverage["blockedNodeIds"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && coverage["ignoredNodeIds"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && coverage["executedNodeIds"].as_array().is_some_and(|nodes| {
                self.required_nodes
                    .iter()
                    .all(|id| nodes.iter().any(|node| node == id))
            })
    }
    fn validate_frame(&self, frame: u64, receipt: &Value) -> Result<(), String> {
        let active = receipt["active"]
            .as_bool()
            .ok_or("Native transport frame activity missing")?;
        if receipt["sessionId"] != self.session
            || receipt["timelineFrame"].as_u64() != Some(frame)
            || receipt["generation"].as_u64() != Some(self.device_generation)
            || !self.coverage_valid(receipt)
        {
            return Err("Native transport frame/session/generation/coverage mismatch".into());
        }
        if active {
            let output = &receipt["frame"];
            if output["nativeSurfacePresented"] != true
                || output["decodePathCpuPixelCopies"] != 0
                || output["stagingCpuPixelReadbacks"] != 0
                || output["nativeSurfaceCpuPixelReadbacks"] != 0
            {
                return Err("Native transport lost native surface presentation".into());
            }
        } else if receipt["nativeSurfaceCleared"] != true {
            return Err("Native transport inactive frame was not cleared".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct Registry {
    next: u64,
    binding: Option<GraphBinding>,
    current: Option<Arc<Playback>>,
}
#[derive(Default)]
pub struct PlaybackRegistry {
    inner: Mutex<Registry>,
}
impl PlaybackRegistry {
    pub fn bind(&self, binding: GraphBinding) -> Result<(), String> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| "Native transport registry poisoned")?;
        let old = registry.current.clone();
        registry.binding = Some(binding);
        drop(registry);
        if let Some(old) = old {
            old.stop("stopped", None);
        }
        Ok(())
    }
    pub fn start(
        &self,
        owner: &str,
        session: &str,
        start_frame: u64,
        end_frame: u64,
        audio: Option<Arc<dyn AudioClockSource>>,
        sink: Option<EventSink>,
    ) -> Result<PlaybackLease, String> {
        let mut registry = self
            .inner
            .lock()
            .map_err(|_| "Native transport registry poisoned")?;
        let binding = registry
            .binding
            .as_ref()
            .filter(|binding| binding.session == session)
            .ok_or("Native transport requires the exact loaded Engine Graph video session")?
            .clone();
        if owner.is_empty()
            || owner.len() > 128
            || start_frame >= end_frame
            || end_frame as f64 * binding.frame_seconds() > 86_400.0
        {
            return Err("Native transport range is invalid or exceeds 24 hours".into());
        }
        let generation = registry
            .next
            .checked_add(1)
            .ok_or("Native transport generation exhausted")?;
        let old = registry.current.clone();
        let playback = Arc::new(Playback {
            owner: owner.to_owned(),
            generation,
            binding,
            start_frame,
            end_frame,
            origin: Instant::now(),
            audio,
            sink,
            cancelled: AtomicBool::new(false),
            state: Mutex::new(Progress::new(start_frame)),
        });
        registry.next = generation;
        registry.current = Some(playback.clone());
        drop(registry);
        if let Some(old) = old {
            old.stop("superseded", None);
        }
        Ok(PlaybackLease(playback))
    }
    fn matching(&self, owner: &str, generation: u64) -> Result<Arc<Playback>, String> {
        self.inner
            .lock()
            .map_err(|_| "Native transport registry poisoned")?
            .current
            .as_ref()
            .filter(|p| p.owner == owner && p.generation == generation)
            .cloned()
            .ok_or("Native transport owner/generation expired".into())
    }
    pub fn stop(&self, owner: &str, generation: Option<u64>) -> bool {
        let registry = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let Some(playback) = registry
            .current
            .as_ref()
            .filter(|p| p.owner == owner && generation.is_none_or(|g| p.generation == g))
            .cloned()
        else {
            return false;
        };
        drop(registry);
        playback.stop("stopped", None);
        true
    }
    pub fn acknowledge(&self, owner: &str, generation: u64, sequence: u64) -> Result<bool, String> {
        let playback = self.matching(owner, generation)?;
        {
            let mut state = playback
                .state
                .lock()
                .map_err(|_| "Native transport state poisoned")?;
            if state.pending != Some(sequence) {
                return Ok(false);
            }
            state.pending = None;
        }
        playback.notify();
        Ok(true)
    }
    pub fn snapshot(
        &self,
        owner: &str,
        generation: u64,
        diagnostic: bool,
    ) -> Result<Value, String> {
        let playback = self.matching(owner, generation)?;
        let state = playback
            .state
            .lock()
            .map_err(|_| "Native transport state poisoned")?;
        let mut receipt = playback.receipt(&state);
        if diagnostic {
            receipt["frameReceipt"] = state.frame_receipt.clone().unwrap_or(Value::Null);
        }
        Ok(receipt)
    }
}

struct Progress {
    status: &'static str,
    frame: u64,
    presented: u64,
    dropped: u64,
    reason: Option<String>,
    revision: u64,
    sent_revision: u64,
    sequence: u64,
    pending: Option<u64>,
    last_sent: Option<Instant>,
    sink_failed: bool,
    frame_receipt: Option<Value>,
}
impl Progress {
    fn new(frame: u64) -> Self {
        Self {
            status: "playing",
            frame,
            presented: 0,
            dropped: 0,
            reason: None,
            revision: 1,
            sent_revision: 0,
            sequence: 0,
            pending: None,
            last_sent: None,
            sink_failed: false,
            frame_receipt: None,
        }
    }
}
pub struct Playback {
    owner: String,
    generation: u64,
    binding: GraphBinding,
    start_frame: u64,
    end_frame: u64,
    origin: Instant,
    audio: Option<Arc<dyn AudioClockSource>>,
    sink: Option<EventSink>,
    cancelled: AtomicBool,
    state: Mutex<Progress>,
}
pub struct PlaybackLease(Arc<Playback>);
impl PlaybackLease {
    pub fn start_receipt(&self) -> Value {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.0.receipt(&state)
    }
    pub fn tick(
        &self,
        present: impl FnOnce(u64, f64) -> Result<Value, String>,
    ) -> Option<Duration> {
        let playback = &self.0;
        if playback.cancelled.load(Ordering::Acquire) {
            return None;
        }
        let result = (|| {
            let (seconds, ended) = playback.clock()?;
            let desired = (seconds / playback.binding.frame_seconds()).floor() as u64;
            if ended || desired >= playback.end_frame {
                playback.stop("ended", None);
                return Ok(None);
            }
            let previous = {
                let state = playback
                    .state
                    .lock()
                    .map_err(|_| "Native transport state poisoned")?;
                if desired < state.frame {
                    return Err("Native transport clock regressed".into());
                }
                if state.presented > 0 && desired == state.frame {
                    return Ok(Some(Duration::from_millis(8)));
                }
                state.frame
            };
            let receipt = present(desired, (playback.binding.frame_seconds() * 0.5).min(0.25))?;
            playback.binding.validate_frame(desired, &receipt)?;
            if playback.cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            {
                let mut state = playback
                    .state
                    .lock()
                    .map_err(|_| "Native transport state poisoned")?;
                let skip = desired
                    .saturating_sub(previous)
                    .saturating_sub(u64::from(state.presented > 0));
                state.dropped = state.dropped.saturating_add(skip);
                state.frame = desired;
                state.presented += 1;
                state.revision += 1;
                state.frame_receipt = Some(receipt);
            }
            playback.notify();
            let (now, ended) = playback.clock()?;
            if ended {
                playback.stop("ended", None);
                return Ok(None);
            }
            let remaining =
                ((desired + 1) as f64 * playback.binding.frame_seconds() - now).max(0.001);
            Ok(Some(Duration::from_secs_f64(if playback.audio.is_some() {
                remaining.min(0.008)
            } else {
                remaining
            })))
        })();
        match result {
            Ok(delay) => delay,
            Err(reason) => {
                playback.stop("failed", Some(reason));
                None
            }
        }
    }
}
impl Drop for PlaybackLease {
    fn drop(&mut self) {
        if !self.0.cancelled.load(Ordering::Acquire) {
            self.0
                .stop("stopped", Some("Native playback worker retired".into()));
        }
    }
}
impl Playback {
    fn clock(&self) -> Result<(f64, bool), String> {
        if let Some(audio) = self.audio.as_ref() {
            let sample = audio.clock_sample()?;
            if !sample.ended && sample.age > AUDIO_MAX_AGE {
                return Err("Native audio clock expired; video stopped".into());
            }
            if !sample.seconds.is_finite() || sample.seconds < 0.0 {
                return Err("Native audio clock invalid".into());
            }
            // The production mailbox projects the device-position/QPC pair,
            // bounded by supplied samples, stage end and hardware sample age.
            // It does not extrapolate from delayed pipe/JavaScript arrival.
            Ok((sample.seconds, sample.ended))
        } else {
            Ok((
                self.start_frame as f64 * self.binding.frame_seconds()
                    + self.origin.elapsed().as_secs_f64(),
                false,
            ))
        }
    }
    fn receipt(&self, state: &Progress) -> Value {
        json!({"schema":"editkin.native-preview-playback/v1","owner":self.owner,"generation":self.generation,
            "sessionId":self.binding.session,"state":state.status,"timelineFrame":state.frame,
            "timelineSeconds":state.frame as f64*self.binding.frame_seconds(),"presentedFrames":state.presented,
            "droppedFrames":state.dropped,"sequence":state.sequence,"reason":state.reason,
            "clock":if self.audio.is_some(){"native-audio"}else{"native-monotonic"}})
    }
    fn stop(&self, status: &'static str, reason: Option<String>) {
        if self.cancelled.swap(true, Ordering::AcqRel) {
            return;
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.status = status;
            state.reason = reason.map(|reason| reason.chars().take(512).collect());
            state.revision += 1;
        }
        self.notify();
    }
    fn notify(&self) {
        let Some(sink) = self.sink.as_ref() else {
            return;
        };
        let event = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.pending.is_some()
                || state.sink_failed
                || state.revision == state.sent_revision
                || (state.status == "playing"
                    && state
                        .last_sent
                        .is_some_and(|sent| sent.elapsed() < UI_INTERVAL))
            {
                return;
            }
            state.sequence += 1;
            state.pending = Some(state.sequence);
            state.sent_revision = state.revision;
            state.last_sent = Some(Instant::now());
            self.receipt(&state)
        };
        if !sink(event) {
            self.cancelled.store(true, Ordering::Release);
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.sink_failed = true;
            state.status = "failed";
            state.reason = Some("Native playback event consumer unavailable".into());
            state.revision += 1;
        }
    }
}

#[cfg(test)]
#[path = "native_preview_playback_tests.rs"]
mod tests;

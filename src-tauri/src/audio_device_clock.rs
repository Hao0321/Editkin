//! Device-position/QPC correlation, not an arrival-time wall clock. WASAPI
//! GetPosition returns QPC in 100 ns units across processes on the same host.
use serde_json::Value;
use std::time::Duration;

pub const MAX_SAMPLE_AGE: Duration = Duration::from_millis(250);
const QPC_PER_SECOND: u64 = 10_000_000;
const CORRECTION_SECONDS: f64 = 0.002;

fn counter_100ns(counter: i64, frequency: i64) -> Result<u64, String> {
    if counter < 0 || frequency <= 0 {
        return Err("Native QPC counter/frequency invalid".into());
    }
    u64::try_from(counter as u128 * QPC_PER_SECOND as u128 / frequency as u128)
        .map_err(|_| "Native QPC conversion overflow".into())
}

#[cfg(windows)]
pub fn qpc_now() -> Result<u64, String> {
    use std::sync::OnceLock;
    // Exact Windows ABI; avoids introducing a new third-party runtime or a
    // dynamically loaded symbol on the real-time scheduling path.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn QueryPerformanceCounter(value: *mut i64) -> i32;
        fn QueryPerformanceFrequency(value: *mut i64) -> i32;
    }
    static FREQUENCY: OnceLock<Result<i64, String>> = OnceLock::new();
    let frequency = FREQUENCY.get_or_init(|| {
        let mut value = 0;
        if unsafe { QueryPerformanceFrequency(&mut value) } == 0 || value <= 0 {
            Err("Native QPC frequency unavailable".into())
        } else {
            Ok(value)
        }
    });
    let mut counter = 0;
    if unsafe { QueryPerformanceCounter(&mut counter) } == 0 {
        return Err("Native QPC counter unavailable".into());
    }
    counter_100ns(counter, *frequency.as_ref().map_err(Clone::clone)?)
}

#[cfg(not(windows))]
pub fn qpc_now() -> Result<u64, String> {
    Err("WASAPI QPC correlation is only available on Windows".into())
}

fn age(now: u64, captured: u64) -> Result<Duration, String> {
    let ticks = now
        .checked_sub(captured)
        .ok_or("Native audio QPC is in the future")?;
    let age = Duration::from_nanos(
        ticks
            .checked_mul(100)
            .ok_or("Native audio QPC age overflow")?,
    );
    if captured == 0 || age > MAX_SAMPLE_AGE {
        return Err("Native audio hardware clock expired".into());
    }
    Ok(age)
}

#[derive(Clone, Copy)]
struct Anchor {
    qpc: u64,
    seconds: f64,
    submitted_end: f64,
    generation: u64,
}

#[derive(Clone)]
pub struct DeviceClock {
    start: f64,
    end: f64,
    anchor: Option<Anchor>,
    generation: Option<u64>,
    last: Option<f64>,
    recovering: bool,
    recovery_catchup: bool,
}
impl DeviceClock {
    pub fn new(start: f64, duration: f64) -> Result<Self, String> {
        if !start.is_finite()
            || !duration.is_finite()
            || start < 0.0
            || duration <= 0.0
            || duration > 30.05
            || !(start + duration).is_finite()
        {
            return Err("Native audio clock window invalid".into());
        }
        Ok(Self {
            start,
            end: start + duration,
            anchor: None,
            generation: None,
            last: None,
            recovering: false,
            recovery_catchup: false,
        })
    }

    /// Called only after the event stream and native mix identity are validated.
    /// The caller clones this small state before admission so rejected events
    /// cannot partially replace the last good anchor.
    pub fn admit(&mut self, event: &Value, now: Option<u64>) -> Result<(), String> {
        let seconds = event["timelineSeconds"]
            .as_f64()
            .ok_or("Native audio timeline missing")?;
        if !seconds.is_finite()
            || seconds < self.start - 1e-6
            || seconds > self.end + 1e-6
            || !event["timelineStartSeconds"]
                .as_f64()
                .is_some_and(|v| (v - self.start).abs() <= 1e-6)
        {
            return Err("Native audio clock outside its staged window".into());
        }
        let kind = event["event"]
            .as_str()
            .ok_or("Native audio clock event missing")?;
        if kind == "ended" {
            if (seconds - self.end).abs() > 1e-6 {
                return Err("Native audio ended before staged end".into());
            }
            self.anchor = None;
            return Ok(());
        }
        let generation = event["deviceGeneration"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or("Native audio device generation missing")?;
        if let Some(previous) = self.generation {
            if kind == "started" {
                return Err("Native audio repeated started event".into());
            }
            let valid = if kind == "recovered" {
                self.recovering && previous.checked_add(1) == Some(generation)
            } else {
                previous == generation
            };
            if !valid {
                return Err("Native audio device generation changed without recovery".into());
            }
        } else if kind != "started" || generation != 1 {
            return Err("Native audio requires initial started generation".into());
        }
        self.generation = Some(generation);
        match kind {
            "started" | "recovered" => {
                self.anchor = None;
                self.recovering = false;
            }
            "recovering" => {
                self.anchor = None;
                self.recovering = true;
                self.recovery_catchup = true;
            }
            "progress" => {
                if self.recovering {
                    return Err("Native audio progress before recovery".into());
                }
                let qpc = event["clockQpc100ns"]
                    .as_u64()
                    .ok_or("Native audio QPC missing")?;
                age(now.ok_or("Native QPC unavailable")?, qpc)?;
                let rate = event["sampleMasterRate"]
                    .as_u64()
                    .filter(|rate| *rate == 48_000)
                    .ok_or("Native audio canonical sample rate changed")?;
                let frame = event["sourceFrame"]
                    .as_u64()
                    .ok_or("Native audio source frame missing")?;
                let supplied = event["sampleMasterFrame"]
                    .as_u64()
                    .filter(|value| *value >= frame)
                    .ok_or("Native audio supplied frame precedes device")?;
                if event["presentedFrame"].as_u64() != Some(frame)
                    || (seconds - (self.start + frame as f64 / rate as f64)).abs() > 1e-6
                    || self.start + supplied as f64 / rate as f64 > self.end + 1e-6
                {
                    return Err("Native audio sample/timeline identity mismatch".into());
                }
                if let Some(anchor) = self.anchor {
                    if qpc <= anchor.qpc || anchor.generation != generation {
                        return Err("Native audio QPC regressed or was replayed".into());
                    }
                }
                self.anchor = Some(Anchor {
                    qpc,
                    seconds,
                    submitted_end: self.start + supplied as f64 / rate as f64,
                    generation,
                });
            }
            _ => return Err("Native audio clock event unsupported".into()),
        }
        Ok(())
    }

    pub fn sample(
        &mut self,
        raw: f64,
        now: Option<u64>,
    ) -> Result<(f64, Option<Duration>), String> {
        let (projected, hardware_age) = if let Some(anchor) = self.anchor {
            let elapsed = age(now.ok_or("Native QPC unavailable")?, anchor.qpc)?;
            (
                (anchor.seconds + elapsed.as_secs_f64())
                    .min(anchor.submitted_end)
                    .min(self.end),
                Some(elapsed),
            )
        } else {
            (raw.min(self.end), None)
        };
        // Hardware quantization may put a newer capture a fraction of a sample
        // behind the previous estimate. Freeze briefly, never rewind video;
        // meaningful discontinuities fail instead of being hidden indefinitely.
        let correction = if self.recovery_catchup {
            MAX_SAMPLE_AGE.as_secs_f64()
        } else {
            CORRECTION_SECONDS
        };
        if self.last.is_some_and(|last| last - projected > correction) {
            return Err(format!(
                "Native audio correlated clock regressed beyond {} ms",
                correction * 1000.0
            ));
        }
        if self.anchor.is_some() && self.last.is_none_or(|last| projected >= last) {
            self.recovery_catchup = false;
        }
        let seconds = projected.max(self.last.unwrap_or(projected));
        self.last = Some(seconds);
        Ok((seconds, hardware_age))
    }
}

#[cfg(test)]
#[path = "audio_device_clock_tests.rs"]
mod tests;

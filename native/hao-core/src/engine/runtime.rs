use super::model::RationalTimebase;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceState {
    Ready,
    Lost,
    Recovering,
    CpuFallback,
}

#[derive(Clone, Debug)]
pub struct EngineClock {
    timebase: RationalTimebase,
    sample_rate: u32,
}

impl EngineClock {
    pub fn new(timebase: RationalTimebase, sample_rate: u32) -> Result<Self, String> {
        if timebase.numerator == 0 || timebase.denominator == 0 || sample_rate == 0 {
            return Err("invalid clock configuration".into());
        }
        Ok(Self {
            timebase,
            sample_rate,
        })
    }

    pub fn frame_to_nanoseconds(&self, frame: u64) -> u128 {
        frame as u128 * self.timebase.numerator as u128 * 1_000_000_000_u128
            / self.timebase.denominator as u128
    }

    pub fn frame_to_sample(&self, frame: u64) -> u64 {
        (frame as u128 * self.timebase.numerator as u128 * self.sample_rate as u128
            / self.timebase.denominator as u128) as u64
    }

    pub fn sample_to_frame(&self, sample: u64) -> u64 {
        (sample as u128 * self.timebase.denominator as u128
            / (self.sample_rate as u128 * self.timebase.numerator as u128)) as u64
    }
}

#[derive(Clone, Debug)]
pub struct FrameRing<T> {
    queue: VecDeque<T>,
    capacity: usize,
    rejected: u64,
}

impl<T> FrameRing<T> {
    pub fn triple() -> Self {
        Self {
            queue: VecDeque::with_capacity(3),
            capacity: 3,
            rejected: 0,
        }
    }
    pub fn push(&mut self, value: T) -> Result<(), T> {
        if self.queue.len() == self.capacity {
            self.rejected += 1;
            return Err(value);
        }
        self.queue.push_back(value);
        Ok(())
    }
    pub fn pop(&mut self) -> Option<T> {
        self.queue.pop_front()
    }
    pub fn len(&self) -> usize {
        self.queue.len()
    }
    pub fn rejected(&self) -> u64 {
        self.rejected
    }
}

#[derive(Clone, Debug)]
struct CacheEntry<T> {
    value: T,
    bytes: u64,
    touched: u64,
}

#[derive(Clone, Debug)]
pub struct ResourceCache<T> {
    budget_bytes: u64,
    used_bytes: u64,
    tick: u64,
    entries: BTreeMap<String, CacheEntry<T>>,
}

impl<T> ResourceCache<T> {
    pub fn new(budget_bytes: u64) -> Result<Self, String> {
        if budget_bytes == 0 {
            return Err("cache budget must be positive".into());
        }
        Ok(Self {
            budget_bytes,
            used_bytes: 0,
            tick: 0,
            entries: BTreeMap::new(),
        })
    }

    pub fn insert(&mut self, key: String, value: T, bytes: u64) -> Result<Vec<String>, String> {
        if key.trim().is_empty() || bytes == 0 || bytes > self.budget_bytes {
            return Err("resource cannot fit cache budget".into());
        }
        self.tick += 1;
        if let Some(previous) = self.entries.remove(&key) {
            self.used_bytes -= previous.bytes;
        }
        self.entries.insert(
            key.clone(),
            CacheEntry {
                value,
                bytes,
                touched: self.tick,
            },
        );
        self.used_bytes += bytes;
        let mut evicted = Vec::new();
        while self.used_bytes > self.budget_bytes {
            let victim = self
                .entries
                .iter()
                .filter(|(candidate, _)| candidate.as_str() != key)
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(candidate, _)| candidate.clone())
                .ok_or("cache cannot evict enough space")?;
            let removed = self.entries.remove(&victim).expect("known cache entry");
            self.used_bytes -= removed.bytes;
            evicted.push(victim);
        }
        Ok(evicted)
    }

    pub fn get(&mut self, key: &str) -> Option<&T> {
        self.tick += 1;
        let entry = self.entries.get_mut(key)?;
        entry.touched = self.tick;
        Some(&entry.value)
    }

    pub fn used_bytes(&self) -> u64 {
        self.used_bytes
    }
}

#[derive(Clone, Debug)]
pub struct DeviceRecovery {
    state: DeviceState,
    generation: u64,
    failures: u32,
}

impl DeviceRecovery {
    pub fn new() -> Self {
        Self {
            state: DeviceState::Ready,
            generation: 1,
            failures: 0,
        }
    }
    pub fn mark_lost(&mut self) {
        self.state = DeviceState::Lost;
    }
    pub fn begin_recovery(&mut self) -> Result<(), String> {
        if self.state != DeviceState::Lost {
            return Err("device recovery requires lost state".into());
        }
        self.state = DeviceState::Recovering;
        Ok(())
    }
    pub fn finish_recovery(&mut self, success: bool) {
        if success {
            self.generation += 1;
            self.failures = 0;
            self.state = DeviceState::Ready;
        } else {
            self.failures += 1;
            self.state = DeviceState::CpuFallback;
        }
    }
    pub fn state(&self) -> DeviceState {
        self.state
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

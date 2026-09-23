//! Bounded, stateful PCM DAG for a decode/mix worker (not the device callback).
//! The terminal limiter is explicitly look-ahead sample-peak limiting, NOT the
//! legacy renderer's whole-window normalization and NOT a true-peak claim.
use super::{
    audio::{self, AudioBuffer, DspState},
    model::{AudioGraph, AudioNode, AudioOperation},
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const EXECUTOR: &str = "hao-core-streaming-dag/v1";
pub const LIMITER_POLICY: &str = "lookahead-sample-peak/v1";
pub const MAX_BLOCK_FRAMES: usize = 4096;

#[derive(Clone, Copy, Debug)]
pub struct StreamSettings {
    pub block_frames: usize,
    pub lookahead_frames: usize,
    pub limiter_release_ms: f32,
}
impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            block_frames: 2048,
            lookahead_frames: 240,
            limiter_release_ms: 80.0,
        }
    }
}

struct LookaheadLimiter {
    delay: Vec<f32>,
    peaks: VecDeque<(u64, f32)>,
    lookahead: usize,
    fed: u64,
    ceiling: f32,
    gain: f32,
    release: f32,
}
impl LookaheadLimiter {
    fn new(settings: StreamSettings, ceiling_db: f32) -> Result<Self, String> {
        if !(-24.0..=0.0).contains(&ceiling_db) {
            return Err("stream limiter ceiling invalid".into());
        }
        Ok(Self {
            delay: vec![0.0; (settings.lookahead_frames + 1) * 2],
            peaks: VecDeque::with_capacity(settings.lookahead_frames + 1),
            lookahead: settings.lookahead_frames,
            fed: 0,
            ceiling: audio::db_to_gain(ceiling_db)?,
            gain: 1.0,
            release: (-1.0 / (settings.limiter_release_ms * 0.001 * 48_000.0)).exp(),
        })
    }
    fn reset(&mut self) {
        self.delay.fill(0.0);
        self.peaks.clear();
        self.fed = 0;
        self.gain = 1.0;
    }
    fn push(&mut self, frame: [f32; 2], output: &mut Vec<f32>) {
        let n = self.fed;
        let first = n.saturating_sub(self.lookahead as u64);
        while self.peaks.front().is_some_and(|(index, _)| *index < first) {
            self.peaks.pop_front();
        }
        let peak = frame[0].abs().max(frame[1].abs());
        while self.peaks.back().is_some_and(|(_, value)| *value <= peak) {
            self.peaks.pop_back();
        }
        self.peaks.push_back((n, peak));
        let at = (n % (self.lookahead + 1) as u64) as usize * 2;
        self.delay[at..at + 2].copy_from_slice(&frame);
        if n >= self.lookahead as u64 {
            let maximum = self.peaks.front().map(|(_, value)| *value).unwrap_or(0.0);
            let target = if maximum > self.ceiling {
                self.ceiling / maximum
            } else {
                1.0
            };
            self.gain = if target < self.gain {
                target
            } else {
                (self.release * self.gain + (1.0 - self.release)).min(target)
            };
            let from = (first % (self.lookahead + 1) as u64) as usize * 2;
            output.extend([
                self.delay[from] * self.gain,
                self.delay[from + 1] * self.gain,
            ]);
        }
        self.fed += 1;
    }
}

struct Node {
    spec: AudioNode,
    inputs: Vec<usize>,
    buffer: AudioBuffer,
    state: DspState,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Running,
    Finished,
    Cancelled,
    Failed,
}

#[derive(Debug)]
pub struct StreamBlock {
    pub generation: u64,
    pub start_frame: u64,
    pub buffer: AudioBuffer,
}

pub struct StreamingAudioGraph {
    nodes: Vec<Node>,
    sources: BTreeSet<String>,
    limiter: Option<LookaheadLimiter>,
    settings: StreamSettings,
    generation: u64,
    origin: u64,
    next_input: u64,
    emitted: u64,
    phase: Phase,
}

fn validate_node(node: &AudioNode) -> Result<(), String> {
    let property = match node.operation {
        AudioOperation::Gain { .. } => Some("gainDb"),
        AudioOperation::Pan { .. } => Some("pan"),
        _ => None,
    };
    if node.automation.len() > 1 {
        return Err("duplicate/unsupported stream automation".into());
    }
    for lane in &node.automation {
        if Some(lane.property.as_str()) != property
            || lane.points.is_empty()
            || lane.points.len() > 4096
            || lane.points.windows(2).any(|p| p[0].sample >= p[1].sample)
        {
            return Err("invalid stream automation lane".into());
        }
        for point in &lane.points {
            if property == Some("gainDb") {
                audio::db_to_gain(point.value)?;
            } else {
                audio::stereo_pan_gains(point.value)?;
            }
        }
    }
    let expected = match node.operation {
        AudioOperation::Source { .. } => Some(0),
        AudioOperation::Ducker { .. } => Some(2),
        AudioOperation::Bus | AudioOperation::Output => None,
        _ => Some(1),
    };
    if expected.is_some_and(|count| node.inputs.len() != count)
        || (expected.is_none() && node.inputs.is_empty())
    {
        return Err("stream node input cardinality invalid".into());
    }
    let mut empty = AudioBuffer::silence(48_000, 2, 0)?;
    let mut state = DspState::default();
    match node.operation {
        AudioOperation::Gain { gain_db } => {
            audio::db_to_gain(gain_db)?;
        }
        AudioOperation::Pan { pan } => {
            audio::stereo_pan_gains(pan)?;
        }
        AudioOperation::Eq {
            low_db,
            mid_db,
            high_db,
        } => audio::apply_eq(&mut empty, low_db, mid_db, high_db, &mut state)?,
        AudioOperation::Compressor {
            threshold_db,
            ratio,
        } => audio::apply_compressor(&mut empty, threshold_db, ratio, &mut state)?,
        AudioOperation::Ducker {
            threshold_db,
            floor_db,
            attack_ms,
            release_ms,
        } => audio::apply_ducker(
            &mut empty,
            &AudioBuffer::silence(48_000, 2, 0)?,
            threshold_db,
            floor_db,
            attack_ms,
            release_ms,
            &mut state,
        )?,
        _ => {}
    }
    Ok(())
}

impl StreamingAudioGraph {
    pub fn new(
        graph: &AudioGraph,
        settings: StreamSettings,
        generation: u64,
        start_frame: u64,
    ) -> Result<Self, String> {
        if graph.sample_rate != 48_000
            || graph.channels != 2
            || graph.nodes.is_empty()
            || graph.nodes.len() > 64
            || generation == 0
            || settings.block_frames == 0
            || settings.block_frames > MAX_BLOCK_FRAMES
            || settings.lookahead_frames == 0
            || settings.lookahead_frames > 960
            || !(1.0..=5000.0).contains(&settings.limiter_release_ms)
            || start_frame > 48_000 * 86_400
        {
            return Err("stream settings exceed declared bounds".into());
        }
        let order = audio::audio_order(graph)?;
        if order.len() != graph.nodes.len() {
            return Err("stream graph has unreachable nodes".into());
        }
        let mut nodes = Vec::new();
        let mut ids = BTreeMap::new();
        let mut sources = BTreeSet::new();
        let mut limiter = None;
        for (index, spec) in order.iter().enumerate() {
            if spec.id.is_empty() || spec.id.len() > 128 {
                return Err("stream node id invalid".into());
            }
            validate_node(spec)?;
            if let AudioOperation::Source { asset_id } = &spec.operation {
                if asset_id.is_empty() || asset_id.len() > 128 {
                    return Err("stream source id invalid".into());
                }
                sources.insert(asset_id.clone());
            }
            if let AudioOperation::Limiter { ceiling_db } = spec.operation {
                let terminal = index == order.len() - 1
                    || (index + 2 == order.len()
                        && matches!(order[index + 1].operation, AudioOperation::Output)
                        && order[index + 1].inputs == [spec.id.clone()]);
                if limiter.is_some() || !terminal {
                    return Err("stream v1 requires a single terminal limiter; latency compensation for interior limiters is unsupported".into());
                }
                limiter = Some(LookaheadLimiter::new(settings, ceiling_db)?);
            }
            let inputs = spec
                .inputs
                .iter()
                .map(|id| {
                    ids.get(id)
                        .copied()
                        .ok_or("stream input not ordered".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            nodes.push(Node {
                spec: (*spec).clone(),
                inputs,
                buffer: AudioBuffer::silence(48_000, 2, settings.block_frames)?,
                state: DspState::default(),
            });
            ids.insert(spec.id.clone(), index);
        }
        if sources.is_empty() || sources.len() > 8 {
            return Err("stream source count invalid".into());
        }
        Ok(Self {
            nodes,
            sources,
            limiter,
            settings,
            generation,
            origin: start_frame,
            next_input: start_frame,
            emitted: 0,
            phase: Phase::Running,
        })
    }
    pub fn source_ids(&self) -> &BTreeSet<String> {
        &self.sources
    }
    pub fn buffered_sample_bytes(&self) -> usize {
        (self
            .nodes
            .iter()
            .map(|node| node.buffer.samples.capacity())
            .sum::<usize>()
            + self.limiter.as_ref().map_or(0, |v| v.delay.capacity()))
            * size_of::<f32>()
    }
    pub fn receipt(&self) -> serde_json::Value {
        serde_json::json!({"executor":EXECUTOR,"generation":self.generation,"phase":format!("{:?}",self.phase),"originFrame":self.origin,"nextInputFrame":self.next_input,"emittedFrames":self.emitted,"nodeCount":self.nodes.len(),"sourceCount":self.sources.len(),"blockFrames":self.settings.block_frames,"bufferedSampleBytes":self.buffered_sample_bytes(),"limiterPolicy":self.limiter.as_ref().map(|_|LIMITER_POLICY),"latencyFrames":self.limiter.as_ref().map_or(0,|v|v.lookahead),"seekPolicy":"cold-state-reset; preroll belongs to session owner","callbackSafe":false})
    }
    pub fn restart(&mut self, generation: u64, start_frame: u64) -> Result<(), String> {
        if generation <= self.generation || start_frame > 48_000 * 86_400 {
            return Err("stream restart generation/range invalid".into());
        }
        for node in &mut self.nodes {
            node.state = DspState::default();
            node.buffer.samples.clear();
        }
        if let Some(limiter) = self.limiter.as_mut() {
            limiter.reset();
        }
        self.generation = generation;
        self.origin = start_frame;
        self.next_input = start_frame;
        self.emitted = 0;
        self.phase = Phase::Running;
        Ok(())
    }
    pub fn cancel(&mut self, generation: u64) -> bool {
        if generation != self.generation || self.phase != Phase::Running {
            return false;
        }
        self.phase = Phase::Cancelled;
        if let Some(limiter) = self.limiter.as_mut() {
            limiter.reset();
        }
        true
    }
    fn require_running(&self, generation: u64) -> Result<(), String> {
        if generation != self.generation || self.phase != Phase::Running {
            return Err("stream generation expired or terminal".into());
        }
        Ok(())
    }
    pub fn process(
        &mut self,
        generation: u64,
        start_frame: u64,
        sources: &BTreeMap<String, AudioBuffer>,
    ) -> Result<StreamBlock, String> {
        self.require_running(generation)?;
        if start_frame != self.next_input
            || sources.len() != self.sources.len()
            || sources.keys().any(|key| !self.sources.contains(key))
        {
            return Err("stream requires exact contiguous input/source identity".into());
        }
        for buffer in sources.values() {
            if buffer.samples.len() > self.settings.block_frames * 2 {
                return Err("stream source buffer exceeds block limit".into());
            }
            buffer.validate(48_000, 2)?;
        }
        let frames = sources
            .values()
            .next()
            .ok_or("stream sources missing")?
            .frames();
        if frames == 0
            || frames > self.settings.block_frames
            || start_frame
                .checked_add(frames as u64)
                .is_none_or(|end| end > 48_000 * 86_400)
        {
            return Err("stream block/range exceeds bounds".into());
        }
        for buffer in sources.values() {
            if buffer.frames() != frames {
                return Err("stream source block lengths differ".into());
            }
        }
        let result = self.process_validated(start_frame, frames, sources);
        if result.is_err() {
            self.phase = Phase::Failed;
        } else {
            self.next_input += frames as u64;
        }
        result
    }
    fn process_validated(
        &mut self,
        start_frame: u64,
        frames: usize,
        sources: &BTreeMap<String, AudioBuffer>,
    ) -> Result<StreamBlock, String> {
        for index in 0..self.nodes.len() {
            let (previous, remaining) = self.nodes.split_at_mut(index);
            let node = &mut remaining[0];
            node.buffer.samples.resize(frames * 2, 0.0);
            node.buffer.samples.fill(0.0);
            match &node.spec.operation {
                AudioOperation::Source { asset_id } => node
                    .buffer
                    .samples
                    .copy_from_slice(&sources[asset_id].samples),
                AudioOperation::Ducker { .. } => node
                    .buffer
                    .samples
                    .copy_from_slice(&previous[node.inputs[0]].buffer.samples),
                _ => {
                    for input in &node.inputs {
                        for (out, sample) in node
                            .buffer
                            .samples
                            .iter_mut()
                            .zip(&previous[*input].buffer.samples)
                        {
                            *out += *sample;
                        }
                    }
                }
            }
            match node.spec.operation {
                AudioOperation::Gain { gain_db } => {
                    audio::apply_gain(&node.spec, &mut node.buffer, gain_db, start_frame)?
                }
                AudioOperation::Pan { pan } => {
                    audio::apply_pan(&node.spec, &mut node.buffer, pan, start_frame)?
                }
                AudioOperation::Eq {
                    low_db,
                    mid_db,
                    high_db,
                } => audio::apply_eq(&mut node.buffer, low_db, mid_db, high_db, &mut node.state)?,
                AudioOperation::Compressor {
                    threshold_db,
                    ratio,
                } => {
                    audio::apply_compressor(&mut node.buffer, threshold_db, ratio, &mut node.state)?
                }
                AudioOperation::Ducker {
                    threshold_db,
                    floor_db,
                    attack_ms,
                    release_ms,
                } => audio::apply_ducker(
                    &mut node.buffer,
                    &previous[node.inputs[1]].buffer,
                    threshold_db,
                    floor_db,
                    attack_ms,
                    release_ms,
                    &mut node.state,
                )?,
                _ => {}
            }
            if node.buffer.samples.iter().any(|v| !v.is_finite()) {
                return Err("stream DSP produced non-finite PCM; generation retired".into());
            }
        }
        let input = &self.nodes.last().unwrap().buffer.samples;
        let mut output = Vec::with_capacity(input.len());
        if let Some(limiter) = self.limiter.as_mut() {
            for frame in input.chunks_exact(2) {
                limiter.push([frame[0], frame[1]], &mut output);
            }
        } else {
            output.extend_from_slice(input);
        }
        Ok(self.block(output))
    }
    fn block(&mut self, samples: Vec<f32>) -> StreamBlock {
        let start_frame = self.origin + self.emitted;
        self.emitted += (samples.len() / 2) as u64;
        StreamBlock {
            generation: self.generation,
            start_frame,
            buffer: AudioBuffer {
                sample_rate: 48_000,
                channels: 2,
                samples,
            },
        }
    }
    pub fn finish(&mut self, generation: u64) -> Result<StreamBlock, String> {
        self.require_running(generation)?;
        let remaining = (self.next_input - self.origin - self.emitted) as usize;
        let mut tail = Vec::with_capacity(remaining * 2);
        if let Some(limiter) = self.limiter.as_mut() {
            for _ in 0..limiter.lookahead {
                limiter.push([0.0, 0.0], &mut tail);
            }
        }
        if tail.len() != remaining * 2 {
            self.phase = Phase::Failed;
            return Err("stream tail length invariant failed".into());
        }
        self.phase = Phase::Finished;
        Ok(self.block(tail))
    }
}

#[cfg(test)]
#[path = "audio_stream_tests.rs"]
mod tests;

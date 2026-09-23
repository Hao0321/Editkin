use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

use super::model::{
    AudioGraph, AudioNode, AudioOperation, AutomationInterpolation, AutomationLane,
};

pub fn automation_value(lane: &AutomationLane, sample: u64) -> Result<f32, String> {
    if lane.points.is_empty() {
        return Err("automation lane has no points".into());
    }
    if sample <= lane.points[0].sample {
        return Ok(lane.points[0].value);
    }
    if sample >= lane.points.last().expect("non-empty").sample {
        return Ok(lane.points.last().expect("non-empty").value);
    }
    let right = lane.points.partition_point(|point| point.sample <= sample);
    let left = &lane.points[right - 1];
    let next = &lane.points[right];
    let span = (next.sample - left.sample) as f32;
    let ratio = (sample - left.sample) as f32 / span;
    Ok(match left.interpolation {
        AutomationInterpolation::Hold => left.value,
        AutomationInterpolation::Linear => left.value + (next.value - left.value) * ratio,
        AutomationInterpolation::Smooth => {
            let eased = ratio * ratio * (3.0 - 2.0 * ratio);
            left.value + (next.value - left.value) * eased
        }
    })
}

pub fn db_to_gain(db: f32) -> Result<f32, String> {
    if !db.is_finite() || !(-144.0..=48.0).contains(&db) {
        return Err("gain is outside supported range".into());
    }
    Ok(10.0_f32.powf(db / 20.0))
}

pub fn stereo_pan_gains(pan: f32) -> Result<(f32, f32), String> {
    if !pan.is_finite() || !(-1.0..=1.0).contains(&pan) {
        return Err("pan must be -1..=1".into());
    }
    let angle = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
    Ok((angle.cos(), angle.sin()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioBuffer {
    pub sample_rate: u32,
    pub channels: u16,
    /// Interleaved, normalized floating-point PCM.
    pub samples: Vec<f32>,
}

impl AudioBuffer {
    pub fn silence(sample_rate: u32, channels: u16, frames: usize) -> Result<Self, String> {
        if sample_rate == 0 || channels == 0 || channels > 8 {
            return Err("invalid audio format".into());
        }
        Ok(Self {
            sample_rate,
            channels,
            samples: vec![0.0; frames.saturating_mul(channels as usize)],
        })
    }

    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels as usize
    }

    pub(super) fn validate(&self, sample_rate: u32, channels: u16) -> Result<(), String> {
        if self.sample_rate != sample_rate
            || self.channels != channels
            || self.samples.len() % channels as usize != 0
            || self.samples.iter().any(|sample| !sample.is_finite())
        {
            return Err("audio source format or samples are invalid".into());
        }
        Ok(())
    }
}

fn lane<'a>(node: &'a AudioNode, property: &str) -> Option<&'a AutomationLane> {
    node.automation
        .iter()
        .find(|lane| lane.property == property)
}

fn automated(node: &AudioNode, property: &str, sample: u64, fallback: f32) -> Result<f32, String> {
    match lane(node, property) {
        Some(lane) => automation_value(lane, sample),
        None => Ok(fallback),
    }
}

fn mix_inputs(
    inputs: &[AudioBuffer],
    sample_rate: u32,
    channels: u16,
    frames: usize,
) -> Result<AudioBuffer, String> {
    let mut output = AudioBuffer::silence(sample_rate, channels, frames)?;
    for input in inputs {
        input.validate(sample_rate, channels)?;
        for (target, source) in output.samples.iter_mut().zip(input.samples.iter()) {
            *target += *source;
        }
    }
    Ok(output)
}

#[derive(Default)]
pub(super) struct DspState {
    low: [f32; 8],
    high: [f32; 8],
    envelope: f32,
}

pub(super) fn apply_gain(
    node: &AudioNode,
    buffer: &mut AudioBuffer,
    fallback_db: f32,
    origin: u64,
) -> Result<(), String> {
    let channels = buffer.channels as usize;
    for frame in 0..buffer.frames() {
        let gain = db_to_gain(automated(
            node,
            "gainDb",
            origin + frame as u64,
            fallback_db,
        )?)?;
        for channel in 0..channels {
            buffer.samples[frame * channels + channel] *= gain;
        }
    }
    Ok(())
}

pub(super) fn apply_pan(
    node: &AudioNode,
    buffer: &mut AudioBuffer,
    fallback: f32,
    origin: u64,
) -> Result<(), String> {
    if buffer.channels != 2 {
        return Err("pan requires a stereo graph".into());
    }
    for frame in 0..buffer.frames() {
        let (left, right) =
            stereo_pan_gains(automated(node, "pan", origin + frame as u64, fallback)?)?;
        buffer.samples[frame * 2] *= left;
        buffer.samples[frame * 2 + 1] *= right;
    }
    Ok(())
}

/// Stable three-band tone control. Low/high are complementary one-pole bands and
/// mid is the residual, so 0 dB is sample-identical and automation remains deterministic.
pub(super) fn apply_eq(
    buffer: &mut AudioBuffer,
    low_db: f32,
    mid_db: f32,
    high_db: f32,
    state: &mut DspState,
) -> Result<(), String> {
    let gains = [
        db_to_gain(low_db)?,
        db_to_gain(mid_db)?,
        db_to_gain(high_db)?,
    ];
    let channels = buffer.channels as usize;
    let low_alpha = 1.0 - (-2.0 * std::f32::consts::PI * 220.0 / buffer.sample_rate as f32).exp();
    let high_alpha =
        1.0 - (-2.0 * std::f32::consts::PI * 4_500.0 / buffer.sample_rate as f32).exp();
    let low_state = &mut state.low;
    let high_lp_state = &mut state.high;
    for frame in 0..buffer.frames() {
        for channel in 0..channels {
            let index = frame * channels + channel;
            let input = buffer.samples[index];
            low_state[channel] += low_alpha * (input - low_state[channel]);
            high_lp_state[channel] += high_alpha * (input - high_lp_state[channel]);
            let low = low_state[channel];
            let high = input - high_lp_state[channel];
            let mid = input - low - high;
            buffer.samples[index] = low * gains[0] + mid * gains[1] + high * gains[2];
        }
    }
    Ok(())
}

pub(super) fn apply_compressor(
    buffer: &mut AudioBuffer,
    threshold_db: f32,
    ratio: f32,
    state: &mut DspState,
) -> Result<(), String> {
    if !threshold_db.is_finite()
        || !(-96.0..=0.0).contains(&threshold_db)
        || !ratio.is_finite()
        || !(1.0..=100.0).contains(&ratio)
    {
        return Err("invalid compressor parameters".into());
    }
    let channels = buffer.channels as usize;
    let attack = (-1.0 / (0.005 * buffer.sample_rate as f32)).exp();
    let release = (-1.0 / (0.080 * buffer.sample_rate as f32)).exp();
    let envelope = &mut state.envelope;
    for frame in 0..buffer.frames() {
        let peak = (0..channels)
            .map(|channel| buffer.samples[frame * channels + channel].abs())
            .fold(0.0_f32, f32::max);
        let coefficient = if peak > *envelope { attack } else { release };
        *envelope = coefficient * *envelope + (1.0 - coefficient) * peak;
        let level_db = 20.0 * envelope.max(1.0e-9).log10();
        let reduction_db = if level_db > threshold_db {
            threshold_db + (level_db - threshold_db) / ratio - level_db
        } else {
            0.0
        };
        let gain = 10.0_f32.powf(reduction_db / 20.0);
        for channel in 0..channels {
            buffer.samples[frame * channels + channel] *= gain;
        }
    }
    Ok(())
}

pub(super) fn apply_ducker(
    program: &mut AudioBuffer,
    sidechain: &AudioBuffer,
    threshold_db: f32,
    floor_db: f32,
    attack_ms: f32,
    release_ms: f32,
    state: &mut DspState,
) -> Result<(), String> {
    sidechain.validate(program.sample_rate, program.channels)?;
    if !(-96.0..=0.0).contains(&threshold_db)
        || !(-60.0..=0.0).contains(&floor_db)
        || !(0.1..=500.0).contains(&attack_ms)
        || !(1.0..=5_000.0).contains(&release_ms)
    {
        return Err("invalid ducker parameters".into());
    }
    let channels = program.channels as usize;
    let attack = (-1.0 / (attack_ms * 0.001 * program.sample_rate as f32)).exp();
    let release = (-1.0 / (release_ms * 0.001 * program.sample_rate as f32)).exp();
    let envelope = &mut state.envelope;
    for frame in 0..program.frames() {
        let peak = (0..channels)
            .map(|channel| sidechain.samples[frame * channels + channel].abs())
            .fold(0.0_f32, f32::max);
        let coefficient = if peak > *envelope { attack } else { release };
        *envelope = coefficient * *envelope + (1.0 - coefficient) * peak;
        let level_db = 20.0 * envelope.max(1.0e-9).log10();
        let activation = ((level_db - threshold_db) / 18.0).clamp(0.0, 1.0);
        let gain = 10.0_f32.powf((floor_db * activation) / 20.0);
        for channel in 0..channels {
            program.samples[frame * channels + channel] *= gain;
        }
    }
    Ok(())
}

fn apply_limiter(buffer: &mut AudioBuffer, ceiling_db: f32) -> Result<(), String> {
    if !ceiling_db.is_finite() || !(-24.0..=0.0).contains(&ceiling_db) {
        return Err("limiter ceiling must be -24..=0 dBFS".into());
    }
    let ceiling = db_to_gain(ceiling_db)?;
    let peak = buffer
        .samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0_f32, f32::max);
    if peak > ceiling {
        let gain = ceiling / peak;
        for sample in &mut buffer.samples {
            *sample *= gain;
        }
    }
    Ok(())
}

/// Lock-free single-producer/single-consumer PCM ring. Slots use atomic f32 bits so
/// the device callback never locks or allocates. One slot remains empty to separate
/// full and empty states.
pub struct SpscAudioRing {
    slots: Box<[AtomicU32]>,
    read_index: AtomicUsize,
    write_index: AtomicUsize,
}

impl SpscAudioRing {
    pub fn new(capacity_samples: usize) -> Result<Self, String> {
        if capacity_samples < 2 || capacity_samples > 16_777_216 {
            return Err("audio ring capacity must be 2..=16777216 samples".into());
        }
        Ok(Self {
            slots: (0..capacity_samples).map(|_| AtomicU32::new(0)).collect(),
            read_index: AtomicUsize::new(0),
            write_index: AtomicUsize::new(0),
        })
    }

    pub fn usable_capacity(&self) -> usize {
        self.slots.len() - 1
    }

    pub fn push_slice(&self, input: &[f32]) -> usize {
        let mut written = 0;
        for sample in input {
            let write = self.write_index.load(Ordering::Relaxed);
            let next = (write + 1) % self.slots.len();
            if next == self.read_index.load(Ordering::Acquire) {
                break;
            }
            self.slots[write].store(sample.to_bits(), Ordering::Relaxed);
            self.write_index.store(next, Ordering::Release);
            written += 1;
        }
        written
    }

    pub fn pop_slice(&self, output: &mut [f32]) -> usize {
        let mut read_count = 0;
        for target in output {
            let read = self.read_index.load(Ordering::Relaxed);
            if read == self.write_index.load(Ordering::Acquire) {
                break;
            }
            *target = f32::from_bits(self.slots[read].load(Ordering::Relaxed));
            self.read_index
                .store((read + 1) % self.slots.len(), Ordering::Release);
            read_count += 1;
        }
        read_count
    }

    pub fn clear(&mut self) {
        self.read_index.store(0, Ordering::Relaxed);
        self.write_index.store(0, Ordering::Relaxed);
    }
}

pub struct RealtimeAudioTransport {
    ring: SpscAudioRing,
    sample_rate: u32,
    channels: u16,
    master_frame: AtomicU64,
    underrun_samples: AtomicU64,
    device_generation: AtomicU64,
}

impl RealtimeAudioTransport {
    pub fn new(sample_rate: u32, channels: u16, capacity_frames: usize) -> Result<Self, String> {
        if !(8_000..=384_000).contains(&sample_rate) || channels == 0 || channels > 8 {
            return Err("invalid realtime audio format".into());
        }
        let samples = capacity_frames
            .checked_mul(channels as usize)
            .and_then(|value| value.checked_add(1))
            .ok_or("audio ring capacity overflow")?;
        Ok(Self {
            ring: SpscAudioRing::new(samples)?,
            sample_rate,
            channels,
            master_frame: AtomicU64::new(0),
            underrun_samples: AtomicU64::new(0),
            device_generation: AtomicU64::new(1),
        })
    }

    pub fn queue_interleaved(&self, samples: &[f32]) -> Result<usize, String> {
        if samples.len() % self.channels as usize != 0
            || samples.iter().any(|sample| !sample.is_finite())
        {
            return Err("queued audio is not finite interleaved PCM".into());
        }
        Ok(self.ring.push_slice(samples))
    }

    /// Models the device callback contract: fixed output is always filled, missing
    /// samples become silence, and the audio master clock still advances.
    pub fn callback_fill(&self, output: &mut [f32]) -> Result<(), String> {
        if output.len() % self.channels as usize != 0 {
            return Err("callback buffer is not frame aligned".into());
        }
        let read = self.ring.pop_slice(output);
        output[read..].fill(0.0);
        self.underrun_samples
            .fetch_add((output.len() - read) as u64, Ordering::Relaxed);
        self.master_frame.fetch_add(
            (output.len() / self.channels as usize) as u64,
            Ordering::Release,
        );
        Ok(())
    }

    pub fn seek(&mut self, frame: u64) {
        self.ring.clear();
        self.master_frame.store(frame, Ordering::Release);
    }

    pub fn recover_device(&mut self) -> u64 {
        self.ring.clear();
        self.device_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn master_frame(&self) -> u64 {
        self.master_frame.load(Ordering::Acquire)
    }

    pub fn underrun_samples(&self) -> u64 {
        self.underrun_samples.load(Ordering::Relaxed)
    }

    pub fn receipt(&self) -> serde_json::Value {
        serde_json::json!({
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "ringCapacitySamples": self.ring.usable_capacity(),
            "masterFrame": self.master_frame(),
            "underrunSamples": self.underrun_samples(),
            "deviceGeneration": self.device_generation.load(Ordering::Acquire),
            "callbackLocks": 0,
            "callbackAllocations": 0
        })
    }
}

pub fn realtime_transport_selftest_receipt() -> Result<serde_json::Value, String> {
    let mut transport = RealtimeAudioTransport::new(48_000, 2, 256)?;
    let source: Vec<f32> = (0..512).map(|index| index as f32 / 512.0).collect();
    if transport.queue_interleaved(&source)? != source.len() {
        return Err("realtime ring rejected valid source samples".into());
    }
    let mut first = vec![0.0_f32; 256];
    let mut second = vec![0.0_f32; 256];
    transport.callback_fill(&mut first)?;
    transport.callback_fill(&mut second)?;
    if first
        .iter()
        .chain(second.iter())
        .zip(source.iter())
        .any(|(actual, expected)| actual.to_bits() != expected.to_bits())
    {
        return Err("realtime callback changed queued PCM".into());
    }
    let mut underrun = vec![1.0_f32; 256];
    transport.callback_fill(&mut underrun)?;
    if underrun.iter().any(|sample| *sample != 0.0) {
        return Err("underrun did not emit silence".into());
    }
    let invalid_samples_rejected = transport.queue_interleaved(&[f32::NAN, 0.0]).is_err();
    let mut invalid_callback = [0.0_f32; 3];
    let invalid_callback_rejected = transport.callback_fill(&mut invalid_callback).is_err();
    transport.seek(96_000);
    let generation = transport.recover_device();
    Ok(serde_json::json!({
        "schema": "editkin.realtime-audio-transport-selftest/v1",
        "status": "GREEN",
        "contract": "SPSC callback transport and sidechain-capable native graph are verified without callback locks/allocations; this does not claim a physical audio device backend.",
        "queuedSamples": source.len(),
        "callbacks": 3,
        "seekFrame": 96_000,
        "recoveryGeneration": generation,
        "negativeControls": { "invalidSamplesRejected": invalid_samples_rejected, "misalignedCallbackRejected": invalid_callback_rejected },
        "transport": transport.receipt()
    }))
}

pub(super) fn audio_order(graph: &AudioGraph) -> Result<Vec<&AudioNode>, String> {
    let nodes: HashMap<&str, &AudioNode> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    if nodes.len() != graph.nodes.len() || !nodes.contains_key(graph.master_node.as_str()) {
        return Err("audio graph has duplicate ids or missing master".into());
    }
    fn visit<'a>(
        id: &'a str,
        nodes: &HashMap<&'a str, &'a AudioNode>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
        order: &mut Vec<&'a AudioNode>,
    ) -> Result<(), String> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(format!("audio graph cycle at {id}"));
        }
        let node = nodes
            .get(id)
            .ok_or_else(|| format!("unknown audio node {id}"))?;
        for input in &node.inputs {
            visit(input, nodes, visiting, visited, order)?;
        }
        visiting.remove(id);
        visited.insert(id);
        order.push(node);
        Ok(())
    }
    let mut order = Vec::new();
    visit(
        graph.master_node.as_str(),
        &nodes,
        &mut HashSet::new(),
        &mut HashSet::new(),
        &mut order,
    )?;
    Ok(order)
}

/// Executes a complete audio DAG into one interleaved floating-point master buffer.
/// The caller owns the device/ring; this function is deterministic and safe to run
/// off the real-time callback when rebuilding a dirty graph segment.
pub fn render_audio_graph(
    graph: &AudioGraph,
    sources: &BTreeMap<String, AudioBuffer>,
) -> Result<AudioBuffer, String> {
    if !(8_000..=384_000).contains(&graph.sample_rate) || graph.channels == 0 || graph.channels > 8
    {
        return Err("unsupported audio graph format".into());
    }
    let order = audio_order(graph)?;
    let frames = sources.values().map(AudioBuffer::frames).max().unwrap_or(0);
    if frames == 0 {
        return Err("audio graph has no source frames".into());
    }
    for source in sources.values() {
        source.validate(graph.sample_rate, graph.channels)?;
    }
    let mut rendered: HashMap<&str, AudioBuffer> = HashMap::new();
    for node in order {
        let mut input_buffers = Vec::with_capacity(node.inputs.len());
        for input in &node.inputs {
            input_buffers.push(
                rendered
                    .get(input.as_str())
                    .ok_or_else(|| format!("audio input {input} was not rendered"))?
                    .clone(),
            );
        }
        let mut output = match node.operation {
            AudioOperation::Source { ref asset_id } => sources
                .get(asset_id)
                .ok_or_else(|| format!("missing audio source {asset_id}"))?
                .clone(),
            AudioOperation::Ducker { .. } => input_buffers
                .first()
                .ok_or("ducker requires program and sidechain inputs")?
                .clone(),
            _ => mix_inputs(&input_buffers, graph.sample_rate, graph.channels, frames)?,
        };
        match node.operation {
            AudioOperation::Source { .. } | AudioOperation::Bus | AudioOperation::Output => {}
            AudioOperation::Gain { gain_db } => apply_gain(node, &mut output, gain_db, 0)?,
            AudioOperation::Pan { pan } => apply_pan(node, &mut output, pan, 0)?,
            AudioOperation::Eq {
                low_db,
                mid_db,
                high_db,
            } => apply_eq(
                &mut output,
                low_db,
                mid_db,
                high_db,
                &mut DspState::default(),
            )?,
            AudioOperation::Compressor {
                threshold_db,
                ratio,
            } => apply_compressor(&mut output, threshold_db, ratio, &mut DspState::default())?,
            AudioOperation::Ducker {
                threshold_db,
                floor_db,
                attack_ms,
                release_ms,
            } => {
                if input_buffers.len() != 2 {
                    return Err("ducker requires exactly two inputs: program, sidechain".into());
                }
                apply_ducker(
                    &mut output,
                    &input_buffers[1],
                    threshold_db,
                    floor_db,
                    attack_ms,
                    release_ms,
                    &mut DspState::default(),
                )?;
            }
            AudioOperation::Limiter { ceiling_db } => {
                apply_limiter(&mut output, ceiling_db)?;
            }
        }
        rendered.insert(node.id.as_str(), output);
    }
    rendered
        .remove(graph.master_node.as_str())
        .ok_or_else(|| "audio master was not rendered".into())
}

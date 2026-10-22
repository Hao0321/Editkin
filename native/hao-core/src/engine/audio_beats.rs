//! W2-4: streaming spectral flux, autocorrelation tempo, DP beat tracking and novelty.
//! No model or whole PCM staging. Four-beat downbeats are a confidence-bearing hypothesis.
#[path = "audio_beats_rhythm_v2.rs"]
mod rhythm_v2;
pub use rhythm_v2::{refine_rhythm_v2, RhythmV2};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SAMPLE_RATE: u32 = 16_000;
pub const FFT_SIZE: usize = 1024;
pub const HOP: usize = 160;
pub const CHUNK_FRAMES: usize = 6000;
pub const OVERLAP_FRAMES: usize = 400;
pub const MAX_SAMPLES: u64 = SAMPLE_RATE as u64 * 86_400;
const BANDS: usize = 16;
const MAX_ONSETS: usize = 1_000_000;
const MAX_BEATS: usize = 400_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Onset { pub time_seconds: f64, pub strength: f64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Beat { pub time_seconds: f64, pub confidence: f64, pub downbeat: bool, pub downbeat_confidence: f64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TempoWindow { pub start_seconds: f64, pub end_seconds: f64, pub bpm: f64, pub confidence: f64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Section { pub time_seconds: f64, pub novelty: f64, pub energy_before: f64, pub energy_after: f64 }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Analysis {
    pub schema: String, pub executor: String, pub sample_rate: u32, pub decoded_samples: u64,
    pub duration_seconds: f64, pub source_start_seconds: f64, pub fft_size: usize, pub hop_samples: usize,
    pub peak_feature_frames: usize, pub maximum_feature_frames: usize,
    pub tempo_bpm: Option<f64>, pub tempo_confidence: f64, pub meter_hypothesis: String,
    pub onsets: Vec<Onset>, pub beats: Vec<Beat>, pub tempo_windows: Vec<TempoWindow>, pub sections: Vec<Section>,
    pub quality_state: String,
}
#[derive(Clone)]
struct Feature { index: u64, time: f64, flux: f64, energy: f64, bands: [f64; BANDS] }
#[derive(Clone, Copy, Default)]
struct Complex { re: f64, im: f64 }

pub struct BeatAnalyzer {
    ring: [f32; FFT_SIZE], position: usize, samples: u64, offset: f64, prior: Option<f64>,
    hann: [f64; FFT_SIZE], fft: [Complex; FFT_SIZE], twiddle: [Complex; FFT_SIZE / 2],
    previous: [f64; FFT_SIZE / 2 + 1], features: Vec<Feature>, frame_index: u64,
    emitted_until: u64, peak_features: usize, onsets: Vec<Onset>, beats: Vec<Beat>,
    tempos: Vec<TempoWindow>, sections: Vec<Section>,
}
impl BeatAnalyzer {
    pub fn new(prior: Option<f64>, source_start_seconds: f64) -> Result<Self, String> {
        if prior.is_some_and(|bpm| !bpm.is_finite() || !(30.0..=300.0).contains(&bpm))
            || !source_start_seconds.is_finite() || !(0.0..=604_800.0).contains(&source_start_seconds) {
            return Err("MUSIC_BEATS_REQUEST_INVALID".into());
        }
        let hann = std::array::from_fn(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (FFT_SIZE - 1) as f64).cos());
        let twiddle = std::array::from_fn(|n| { let a = -2.0 * std::f64::consts::PI * n as f64 / FFT_SIZE as f64; Complex { re: a.cos(), im: a.sin() } });
        Ok(Self { ring: [0.0; FFT_SIZE], position: 0, samples: 0, offset: source_start_seconds, prior,
            hann, fft: [Complex::default(); FFT_SIZE], twiddle, previous: [0.0; FFT_SIZE / 2 + 1],
            features: Vec::with_capacity(CHUNK_FRAMES + OVERLAP_FRAMES), frame_index: 0, emitted_until: 0,
            peak_features: 0, onsets: Vec::new(), beats: Vec::new(), tempos: Vec::new(), sections: Vec::new() })
    }
    pub fn push(&mut self, samples: &[f32]) -> Result<(), String> {
        if self.samples.checked_add(samples.len() as u64).is_none_or(|n| n > MAX_SAMPLES)
            || samples.iter().any(|x| !x.is_finite()) { return Err("MUSIC_BEATS_PCM_INVALID".into()); }
        for &value in samples {
            self.ring[self.position] = value; self.position = (self.position + 1) % FFT_SIZE; self.samples += 1;
            if self.samples >= FFT_SIZE as u64 && (self.samples - FFT_SIZE as u64) % HOP as u64 == 0 {
                self.analyze_frame();
                if self.features.len() == CHUNK_FRAMES + OVERLAP_FRAMES {
                    let end = self.features[CHUNK_FRAMES].index;
                    self.process_features(end)?;
                    // Two seconds of already-emitted history and four seconds of lookahead cross chunks.
                    self.features.drain(..CHUNK_FRAMES - OVERLAP_FRAMES / 2);
                }
            }
        }
        Ok(())
    }
    fn analyze_frame(&mut self) {
        let mut energy = 0.0;
        for n in 0..FFT_SIZE {
            let value = f64::from(self.ring[(self.position + n) % FFT_SIZE]); energy += value * value;
            self.fft[n] = Complex { re: value * self.hann[n], im: 0.0 };
        }
        let mut reverse = 0;
        for i in 1..FFT_SIZE {
            let mut bit = FFT_SIZE >> 1;
            while reverse & bit != 0 { reverse ^= bit; bit >>= 1; }
            reverse ^= bit; if i < reverse { self.fft.swap(i, reverse); }
        }
        let mut length = 2;
        while length <= FFT_SIZE {
            for start in (0..FFT_SIZE).step_by(length) {
                for j in 0..length / 2 {
                    let w = self.twiddle[j * FFT_SIZE / length]; let b = self.fft[start + j + length / 2]; let a = self.fft[start + j];
                    let c = Complex { re: w.re * b.re - w.im * b.im, im: w.re * b.im + w.im * b.re };
                    self.fft[start + j] = Complex { re: a.re + c.re, im: a.im + c.im };
                    self.fft[start + j + length / 2] = Complex { re: a.re - c.re, im: a.im - c.im };
                }
            }
            length *= 2;
        }
        let mut flux = 0.0; let mut bands = [0.0; BANDS];
        for bin in 1..=FFT_SIZE / 2 {
            let c = self.fft[bin]; let magnitude = (c.re * c.re + c.im * c.im).sqrt() / FFT_SIZE as f64;
            let log = (64.0 * magnitude).ln_1p(); flux += (log - self.previous[bin]).max(0.0); self.previous[bin] = log;
            let frequency = bin as f64 * SAMPLE_RATE as f64 / FFT_SIZE as f64;
            let band = ((frequency / 40.0).log2() * 2.0).floor().max(0.0).min((BANDS - 1) as f64) as usize;
            bands[band] += magnitude * magnitude;
        }
        for band in &mut bands { *band = (32.0 * band.sqrt()).ln_1p(); }
        let center_sample = self.samples - FFT_SIZE as u64 / 2;
        self.features.push(Feature { index: self.frame_index, time: self.offset + center_sample as f64 / SAMPLE_RATE as f64,
            flux: flux / (FFT_SIZE / 2) as f64, energy: energy / FFT_SIZE as f64, bands });
        self.frame_index += 1; self.peak_features = self.peak_features.max(self.features.len());
    }
    fn process_features(&mut self, end: u64) -> Result<(), String> {
        if self.features.is_empty() { return Ok(()); }
        let envelope = onset_envelope(&self.features);
        for n in 1..envelope.len().saturating_sub(1) {
            let f = &self.features[n];
            if f.index < self.emitted_until || f.index >= end { continue; }
            if envelope[n] >= 0.1 && envelope[n] >= envelope[n - 1] && envelope[n] > envelope[n + 1]
                && self.onsets.last().is_none_or(|last| f.time - last.time_seconds >= 0.05) {
                self.onsets.push(Onset { time_seconds: f.time, strength: envelope[n] });
            }
        }
        if let Some((period, confidence)) = estimate_tempo(&envelope, self.prior) {
            let path = track_beats(&envelope, period);
            let mut phases = [(0.0, 0); 4];
            for (ordinal, &n) in path.iter().enumerate() {
                if envelope[n] < 0.1 { continue; }
                phases[ordinal % 4].0 += self.features[n].energy.sqrt(); phases[ordinal % 4].1 += 1;
            }
            let averages = phases.map(|(sum, count)| if count > 0 { sum / count as f64 } else { 0.0 });
            let phase = (0..4).max_by(|&a, &b| averages[a].total_cmp(&averages[b])).unwrap();
            let rest = (averages.iter().sum::<f64>() - averages[phase]) / 3.0;
            let accent_confidence = ((averages[phase] - rest) / averages[phase].max(1e-12)).clamp(0.0, 1.0);
            for (ordinal, n) in path.into_iter().enumerate() {
                let f = &self.features[n];
                if f.index < self.emitted_until || f.index >= end || envelope[n] < 0.1 { continue; }
                if self.beats.last().is_some_and(|last| f.time - last.time_seconds < 0.15) { continue; }
                self.beats.push(Beat { time_seconds: f.time, confidence: (envelope[n] * confidence).clamp(0.0, 1.0),
                    downbeat: accent_confidence >= 0.2 && ordinal % 4 == phase,
                    downbeat_confidence: if ordinal % 4 == phase { accent_confidence * confidence } else { 0.0 } });
            }
            let start = self.features.iter().find(|f| f.index >= self.emitted_until).map_or(self.features[0].time, |f| f.time);
            let stop = self.features.iter().find(|f| f.index >= end).map_or(self.offset + self.samples as f64 / SAMPLE_RATE as f64, |f| f.time);
            if stop > start { self.tempos.push(TempoWindow { start_seconds: start, end_seconds: stop, bpm: 6000.0 / period, confidence }); }
        }
        let changes = novelty_sections(&self.features);
        for change in changes {
            let frame = ((change.time_seconds - self.offset - 0.032).max(0.0) * 100.0).round() as u64;
            if frame >= self.emitted_until && frame < end
                && self.sections.last().is_none_or(|last| change.time_seconds - last.time_seconds >= 3.0) { self.sections.push(change); }
        }
        self.emitted_until = end;
        if self.onsets.len() > MAX_ONSETS || self.beats.len() > MAX_BEATS || self.tempos.len() > 2000 || self.sections.len() > 30_000 {
            return Err("MUSIC_BEATS_EVENT_BUDGET_EXCEEDED".into());
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<Analysis, String> {
        self.process_features(self.frame_index)?;
        let mut ordered = self.tempos.clone(); ordered.sort_by(|a, b| a.bpm.total_cmp(&b.bpm));
        let weight = ordered.iter().map(|w| (w.end_seconds - w.start_seconds) * w.confidence).sum::<f64>();
        let mut accumulated = 0.0; let mut tempo = None;
        for window in &ordered { accumulated += (window.end_seconds - window.start_seconds) * window.confidence;
            if accumulated >= weight / 2.0 { tempo = Some(window.bpm); break; } }
        let confidence = if self.tempos.is_empty() { 0.0 } else { self.tempos.iter().map(|w| w.confidence).sum::<f64>() / self.tempos.len() as f64 };
        Ok(Analysis { schema: "editkin.music-beats-analysis/v1".into(), executor: "hao-core-spectral-flux-autocorrelation-dp/v1".into(),
            sample_rate: SAMPLE_RATE, decoded_samples: self.samples, duration_seconds: self.samples as f64 / SAMPLE_RATE as f64,
            source_start_seconds: self.offset, fft_size: FFT_SIZE, hop_samples: HOP, peak_feature_frames: self.peak_features,
            maximum_feature_frames: CHUNK_FRAMES + OVERLAP_FRAMES, tempo_bpm: tempo, tempo_confidence: confidence,
            meter_hypothesis: "four-beat-accent-hypothesis; not a learned meter classifier".into(), onsets: self.onsets,
            beats: self.beats, tempo_windows: self.tempos, sections: self.sections, quality_state: "analysis_candidate_real_music_quality_unmeasured".into() })
    }
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() { return 0.0; } values.sort_by(f64::total_cmp); values[values.len() / 2]
}
fn onset_envelope(features: &[Feature]) -> Vec<f64> {
    let mut out = vec![0.0; features.len()];
    for n in 0..features.len() {
        let start = n.saturating_sub(50); let end = (n + 51).min(features.len());
        let mut local: Vec<f64> = features[start..end].iter().map(|f| f.flux).collect(); let baseline = median(&mut local);
        for value in &mut local { *value = (*value - baseline).abs(); } let deviation = median(&mut local);
        if features[n].energy > 1e-9 { out[n] = (features[n].flux - baseline - 2.5 * deviation).max(0.0); }
    }
    let maximum = out.iter().copied().fold(0.0, f64::max);
    if maximum < 1e-7 { out.fill(0.0); } else { for value in &mut out { *value /= maximum; } }
    out
}
fn estimate_tempo(envelope: &[f64], prior: Option<f64>) -> Option<(f64, f64)> {
    if envelope.len() < 150 || envelope.iter().filter(|&&x| x >= 0.1).count() < 3 { return None; }
    // Compress only salient onset amplitudes for tempo; otherwise strong bar accents win at quarter tempo.
    // Original energies remain intact for downbeat inference. Sparse gating keeps random low flux from gaining periodic authority.
    let compressed: Vec<f64> = envelope.iter().map(|&v| if v >= 0.1 { v.powf(0.25) } else { 0.0 }).collect();
    let envelope = &compressed;
    let mut peaks = Vec::new();
    for n in 1..envelope.len().saturating_sub(1) {
        if envelope[n] >= 0.1 && envelope[n] >= envelope[n - 1] && envelope[n] > envelope[n + 1]
            && peaks.last().is_none_or(|&previous| n - previous >= 5) { peaks.push(n); }
    }
    let mut best = (0.0_f64, 0_usize, 0.0_f64);
    let mut correlations = vec![0.0; 201];
    for lag in 20..=200.min(envelope.len() / 2) {
        let (mut cross, mut a, mut b) = (0.0, 0.0, 0.0);
        for n in lag..envelope.len() { cross += envelope[n] * envelope[n - lag]; a += envelope[n] * envelope[n]; b += envelope[n - lag] * envelope[n - lag]; }
        let correlation = cross / (a * b).sqrt().max(1e-20); let bpm = 6000.0 / lag as f64;
        correlations[lag] = correlation;
        let anchor = prior.unwrap_or(120.0);
        // Adjacent salient onset spacing resolves accent-induced multiples of the pulse period.
        let supported = peaks.windows(2).filter(|p| ((p[1] - p[0]) as f64 - lag as f64).abs() <= (lag as f64 * 0.15).max(3.0)).count();
        let spacing_support = if peaks.len() > 1 { supported as f64 / (peaks.len() - 1) as f64 } else { 0.0 };
        let score = correlation * (-0.08 * (bpm / anchor).log2().powi(2)).exp() * (0.6 + 0.4 * spacing_support);
        if score > best.0 { best = (score, lag, correlation); }
    }
    if best.2 < 0.3 { return None; }
    let mut period = best.1 as f64;
    if best.1 > 20 && best.1 < 200.min(envelope.len() / 2) {
        let left = correlations[best.1 - 1]; let center = correlations[best.1]; let right = correlations[best.1 + 1];
        let denominator = left - 2.0 * center + right;
        if denominator < -1e-12 { period += (0.5 * (left - right) / denominator).clamp(-0.5, 0.5); }
    }
    Some((period, best.2.clamp(0.0, 1.0)))
}
fn track_beats(envelope: &[f64], period: f64) -> Vec<usize> {
    let mut scores = vec![0.0; envelope.len()]; let mut previous = vec![None; envelope.len()];
    let first = (period * 0.5).floor().max(1.0) as usize; let last = (period * 2.0).ceil() as usize;
    for n in 0..envelope.len() {
        let mut best = 0.0; let mut parent = None;
        for lag in first..=last.min(n) { let p = n - lag; let candidate = scores[p] - 100.0 * (lag as f64 / period).ln().powi(2);
            if candidate > best { best = candidate; parent = Some(p); } }
        scores[n] = envelope[n] + best; previous[n] = parent;
    }
    let start = envelope.len().saturating_sub((period * 1.5).ceil() as usize);
    let Some(mut at) = (start..envelope.len()).max_by(|&a, &b| scores[a].total_cmp(&scores[b])) else { return Vec::new(); };
    let mut path = Vec::new();
    loop { path.push(at); if let Some(p) = previous[at] { at = p; } else { break; } }
    path.reverse(); path
}
fn novelty_sections(features: &[Feature]) -> Vec<Section> {
    let mut seconds = BTreeMap::<u64, ([f64; BANDS], f64, usize)>::new();
    for f in features { let row = seconds.entry(f.time.floor() as u64).or_insert(([0.0; BANDS], 0.0, 0));
        for band in 0..BANDS { row.0[band] += f.bands[band]; } row.1 += f.energy; row.2 += 1; }
    let bins: Vec<_> = seconds.into_iter().map(|(time, (mut bands, energy, count))| {
        for band in &mut bands { *band /= count as f64; } (time as f64, bands, energy / count as f64)
    }).collect();
    let mut candidates = Vec::new();
    for n in 2..bins.len().saturating_sub(2) {
        let before = (bins[n - 2].2 + bins[n - 1].2) / 2.0; let after = (bins[n].2 + bins[n + 1].2) / 2.0;
        let contrast = (0..BANDS).map(|b| { let a = (bins[n - 2].1[b] + bins[n - 1].1[b]) / 2.0;
            let c = (bins[n].1[b] + bins[n + 1].1[b]) / 2.0; (a - c).powi(2) }).sum::<f64>().sqrt();
        candidates.push(Section { time_seconds: bins[n].0, novelty: contrast, energy_before: before, energy_after: after });
    }
    let mut values: Vec<_> = candidates.iter().map(|s| s.novelty).collect(); let baseline = median(&mut values);
    for value in &mut values { *value = (*value - baseline).abs(); } let threshold = (baseline + 3.0 * median(&mut values) + 0.01).max(0.015);
    let mut result = Vec::new();
    for n in 1..candidates.len().saturating_sub(1) { let s = &candidates[n];
        if s.novelty > threshold && s.novelty >= candidates[n - 1].novelty && s.novelty > candidates[n + 1].novelty { result.push(s.clone()); } }
    result
}

#[cfg(test)]
#[path = "audio_beats_tests.rs"]
mod tests;

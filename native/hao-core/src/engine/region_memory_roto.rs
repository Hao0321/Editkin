use super::optical_alpha::{OpticalAlphaReceipt, OpticalAlphaSettings, refine_optical_alpha};
use super::roto::{MatteFrame, MatteRefine, refine_matte};
use serde::Serialize;

pub const REGION_MEMORY_ROTO_ENGINE: &str = "editkin-self-authored-region-memory-roto/v1";

#[derive(Clone, Copy, Debug)]
pub struct RegionMemorySeedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct RegionMemorySettings {
    pub anchor_weight: f32,
    pub anchor_pull: f32,
    pub update_rate: f32,
    pub update_confidence: f32,
    pub occlusion_area_ratio: f32,
    pub scene_cut_mean_delta: f32,
    pub support_expansion: f32,
    pub support_floor: f32,
    pub max_center_step: f32,
    pub temporal_stability: f32,
    pub feather: f32,
    pub edge_shift: f32,
    pub contrast: f32,
}

impl Default for RegionMemorySettings {
    fn default() -> Self {
        Self {
            anchor_weight: 0.08,
            anchor_pull: 0.025,
            update_rate: 0.28,
            update_confidence: 0.72,
            occlusion_area_ratio: 0.12,
            scene_cut_mean_delta: 0.32,
            support_expansion: 1.65,
            support_floor: 0.035,
            max_center_step: 0.12,
            temporal_stability: 0.16,
            feather: 0.01,
            edge_shift: 0.0,
            contrast: 1.7,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionMemoryFreezeReason {
    None,
    FullOcclusion,
    SceneCut,
    SceneCutReseed,
    LowConfidence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionMemoryFrameReceipt {
    pub frame: usize,
    pub freeze_reason: RegionMemoryFreezeReason,
    pub memory_updated: bool,
    pub scene_delta: f32,
    pub subject_area_ratio: f32,
    pub update_confidence: f32,
    pub support_center: [f32; 2],
    pub support_half_extent: [f32; 2],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionMemorySequenceReceipt {
    pub schema: &'static str,
    pub engine: &'static str,
    pub frame_count: usize,
    pub memory_updates: usize,
    pub full_occlusion_freezes: usize,
    pub scene_cut_freezes: usize,
    pub scene_cut_reseeds: usize,
    pub low_confidence_freezes: usize,
    pub model_bounds_valid: bool,
    pub frames: Vec<RegionMemoryFrameReceipt>,
}

#[derive(Clone, Debug)]
pub struct RegionMemorySequenceResult {
    pub mattes: Vec<MatteFrame>,
    pub refinements: Vec<OpticalAlphaReceipt>,
    pub receipt: RegionMemorySequenceReceipt,
}

#[derive(Clone, Debug)]
pub struct RegionMemoryStateSnapshot {
    pub engine: String,
    pub width: usize,
    pub height: usize,
    pub last_frame: usize,
    pub foreground_mean: [f32; 3],
    pub foreground_variance: [f32; 3],
    pub background_mean: [f32; 3],
    pub background_variance: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
struct ColorModel {
    mean: [f32; 3],
    variance: [f32; 3],
}

impl ColorModel {
    fn from_samples(samples: &[[u8; 3]]) -> Result<Self, String> {
        if samples.len() < 8 {
            return Err("region memory seed has too few pixels".into());
        }
        let mut mean = [0.0_f32; 3];
        for sample in samples {
            for channel in 0..3 {
                mean[channel] += sample[channel] as f32;
            }
        }
        for value in &mut mean {
            *value /= samples.len() as f32;
        }
        let mut variance = [0.0_f32; 3];
        for sample in samples {
            for channel in 0..3 {
                variance[channel] += (sample[channel] as f32 - mean[channel]).powi(2);
            }
        }
        for value in &mut variance {
            *value = (*value / samples.len() as f32).clamp(64.0, 16_384.0);
        }
        let model = Self { mean, variance };
        model.validate()?;
        Ok(model)
    }

    fn validate(self) -> Result<(), String> {
        if self
            .mean
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=255.0).contains(value))
            || self
                .variance
                .iter()
                .any(|value| !value.is_finite() || !(64.0..=16_384.0).contains(value))
        {
            return Err("region memory color model left bounded range".into());
        }
        Ok(())
    }

    fn regularized(self, anchor: Self, weight: f32) -> Self {
        let mut output = self;
        for channel in 0..3 {
            output.mean[channel] =
                self.mean[channel] * (1.0 - weight) + anchor.mean[channel] * weight;
            output.variance[channel] = (self.variance[channel] * (1.0 - weight)
                + anchor.variance[channel] * weight)
                .clamp(64.0, 16_384.0);
        }
        output
    }

    fn update(&mut self, observed: Self, anchor: Self, rate: f32, anchor_pull: f32) {
        for channel in 0..3 {
            self.mean[channel] = self.mean[channel] * (1.0 - rate) + observed.mean[channel] * rate;
            self.variance[channel] = (self.variance[channel] * (1.0 - rate)
                + observed.variance[channel] * rate)
                .clamp(64.0, 16_384.0);
            self.mean[channel] =
                self.mean[channel] * (1.0 - anchor_pull) + anchor.mean[channel] * anchor_pull;
            self.variance[channel] = (self.variance[channel] * (1.0 - anchor_pull)
                + anchor.variance[channel] * anchor_pull)
                .clamp(64.0, 16_384.0);
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct SpatialSupport {
    center: [f32; 2],
    half_extent: [f32; 2],
    seed_half_extent: [f32; 2],
    velocity: [f32; 2],
    area_ema: f32,
}

#[derive(Clone)]
struct RegionMemoryState {
    width: usize,
    height: usize,
    anchor_foreground: ColorModel,
    anchor_background: ColorModel,
    foreground: ColorModel,
    background: ColorModel,
    support: SpatialSupport,
    previous_rgb: Vec<u8>,
    previous_matte: MatteFrame,
    last_frame: usize,
    correction_bias: Vec<f32>,
}

fn smoothstep(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn validate_settings(settings: RegionMemorySettings) -> Result<(), String> {
    let finite = [
        settings.anchor_weight,
        settings.anchor_pull,
        settings.update_rate,
        settings.update_confidence,
        settings.occlusion_area_ratio,
        settings.scene_cut_mean_delta,
        settings.support_expansion,
        settings.support_floor,
        settings.max_center_step,
        settings.temporal_stability,
        settings.feather,
        settings.edge_shift,
        settings.contrast,
    ]
    .iter()
    .all(|value| value.is_finite());
    if !finite
        || !(0.0..=0.5).contains(&settings.anchor_weight)
        || !(0.0..=0.25).contains(&settings.anchor_pull)
        || !(0.01..=0.75).contains(&settings.update_rate)
        || !(0.5..=0.98).contains(&settings.update_confidence)
        || !(0.02..=0.4).contains(&settings.occlusion_area_ratio)
        || !(0.1..=0.8).contains(&settings.scene_cut_mean_delta)
        || !(1.0..=3.0).contains(&settings.support_expansion)
        || !(0.0..=0.25).contains(&settings.support_floor)
        || !(0.01..=0.5).contains(&settings.max_center_step)
        || !(0.0..=0.9).contains(&settings.temporal_stability)
        || !(0.0..=0.25).contains(&settings.feather)
        || !(-0.25..=0.25).contains(&settings.edge_shift)
        || !(0.0..=4.0).contains(&settings.contrast)
    {
        return Err("invalid region memory settings".into());
    }
    Ok(())
}

fn validate_dimensions(
    bytes: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
) -> Result<usize, String> {
    let frame_bytes = width
        .checked_mul(height)
        .and_then(|value| value.checked_mul(3))
        .ok_or("region memory frame size overflow")?;
    if width < 16
        || height < 16
        || frame_count == 0
        || bytes.len()
            != frame_bytes
                .checked_mul(frame_count)
                .ok_or("region memory sequence size overflow")?
    {
        return Err("invalid region memory RGB sequence".into());
    }
    Ok(frame_bytes)
}

fn validate_seed(rect: RegionMemorySeedRect) -> Result<(), String> {
    if ![rect.x, rect.y, rect.width, rect.height]
        .iter()
        .all(|value| value.is_finite())
        || rect.x < 0.0
        || rect.y < 0.0
        || rect.width < 0.02
        || rect.height < 0.02
        || rect.x + rect.width > 1.0
        || rect.y + rect.height > 1.0
    {
        return Err("invalid region memory seed rectangle".into());
    }
    Ok(())
}

fn seed_models(
    frame: &[u8],
    width: usize,
    height: usize,
    rect: RegionMemorySeedRect,
) -> Result<(ColorModel, ColorModel, SpatialSupport), String> {
    validate_seed(rect)?;
    let left = (rect.x * width as f64).round() as usize;
    let top = (rect.y * height as f64).round() as usize;
    let right = ((rect.x + rect.width) * width as f64)
        .round()
        .min(width as f64) as usize;
    let bottom = ((rect.y + rect.height) * height as f64)
        .round()
        .min(height as f64) as usize;
    let inset_x = ((right - left) / 5).max(1);
    let inset_y = ((bottom - top) / 5).max(1);
    let border = (width.min(height) / 12).max(1);
    let mut foreground = Vec::new();
    let mut background = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let offset = (y * width + x) * 3;
            let pixel = [frame[offset], frame[offset + 1], frame[offset + 2]];
            if x >= left + inset_x
                && x < right.saturating_sub(inset_x)
                && y >= top + inset_y
                && y < bottom.saturating_sub(inset_y)
            {
                foreground.push(pixel);
            } else if x < border
                || y < border
                || x >= width - border
                || y >= height - border
                || x + border < left
                || x > right + border
                || y + border < top
                || y > bottom + border
            {
                background.push(pixel);
            }
        }
    }
    let foreground = ColorModel::from_samples(&foreground)?;
    let background = ColorModel::from_samples(&background)?;
    let half_extent = [
        (rect.width as f32 * 0.5).max(2.0 / width as f32),
        (rect.height as f32 * 0.5).max(2.0 / height as f32),
    ];
    let support = SpatialSupport {
        center: [
            (rect.x + rect.width * 0.5) as f32,
            (rect.y + rect.height * 0.5) as f32,
        ],
        half_extent,
        seed_half_extent: half_extent,
        velocity: [0.0, 0.0],
        area_ema: ((right - left) * (bottom - top)) as f32 * 0.45,
    };
    Ok((foreground, background, support))
}

fn distance(pixel: [u8; 3], model: ColorModel) -> f32 {
    (0..3)
        .map(|channel| {
            (pixel[channel] as f32 - model.mean[channel]).powi(2) / model.variance[channel]
        })
        .sum()
}

fn support_weight(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    support: SpatialSupport,
    settings: RegionMemorySettings,
) -> f32 {
    let normalized_x = (x as f32 + 0.5) / width as f32;
    let normalized_y = (y as f32 + 0.5) / height as f32;
    let predicted = [
        (support.center[0] + support.velocity[0]).clamp(0.0, 1.0),
        (support.center[1] + support.velocity[1]).clamp(0.0, 1.0),
    ];
    let radius_x = (support.half_extent[0] * settings.support_expansion).max(2.0 / width as f32);
    let radius_y = (support.half_extent[1] * settings.support_expansion).max(2.0 / height as f32);
    let elliptical = (((normalized_x - predicted[0]) / radius_x).powi(2)
        + ((normalized_y - predicted[1]) / radius_y).powi(2))
    .sqrt();
    if elliptical <= 0.72 {
        1.0
    } else if elliptical >= 1.15 {
        settings.support_floor
    } else {
        settings.support_floor
            + (1.0 - settings.support_floor) * (1.0 - smoothstep((elliptical - 0.72) / 0.43))
    }
}

fn scene_delta(previous: &[u8], current: &[u8]) -> f32 {
    previous
        .iter()
        .zip(current)
        .map(|(left, right)| (*left as f32 - *right as f32).abs() / 255.0)
        .sum::<f32>()
        / previous.len().max(1) as f32
}

fn measured_support(
    alpha: &[u8],
    width: usize,
    height: usize,
) -> Option<([f32; 2], [f32; 2], usize)> {
    let mut count = 0_usize;
    let mut sum_x = 0.0_f32;
    let mut sum_y = 0.0_f32;
    let mut left = width;
    let mut right = 0_usize;
    let mut top = height;
    let mut bottom = 0_usize;
    for y in 0..height {
        for x in 0..width {
            if alpha[y * width + x] < 160 {
                continue;
            }
            count += 1;
            sum_x += (x as f32 + 0.5) / width as f32;
            sum_y += (y as f32 + 0.5) / height as f32;
            left = left.min(x);
            right = right.max(x);
            top = top.min(y);
            bottom = bottom.max(y);
        }
    }
    if count == 0 {
        return None;
    }
    Some((
        [sum_x / count as f32, sum_y / count as f32],
        [
            ((right - left + 1) as f32 / width as f32 * 0.65).max(1.0 / width as f32),
            ((bottom - top + 1) as f32 / height as f32 * 0.65).max(1.0 / height as f32),
        ],
        count,
    ))
}

fn update_support(
    support: &mut SpatialSupport,
    center: [f32; 2],
    half_extent: [f32; 2],
    area: usize,
    settings: RegionMemorySettings,
) {
    let mut delta = [center[0] - support.center[0], center[1] - support.center[1]];
    let magnitude = delta[0].hypot(delta[1]);
    if magnitude > settings.max_center_step {
        let scale = settings.max_center_step / magnitude;
        delta[0] *= scale;
        delta[1] *= scale;
    }
    support.velocity[0] = support.velocity[0] * 0.4 + delta[0] * 0.6;
    support.velocity[1] = support.velocity[1] * 0.4 + delta[1] * 0.6;
    support.center[0] = (support.center[0] + delta[0] * 0.82).clamp(0.0, 1.0);
    support.center[1] = (support.center[1] + delta[1] * 0.82).clamp(0.0, 1.0);
    for axis in 0..2 {
        let minimum = support.seed_half_extent[axis] * 0.45;
        let maximum = support.seed_half_extent[axis] * 1.45;
        let measured = half_extent[axis].clamp(minimum, maximum);
        support.half_extent[axis] = support.half_extent[axis] * 0.68 + measured * 0.32;
    }
    support.area_ema = support.area_ema * 0.82 + area as f32 * 0.18;
}

fn update_models(
    state: &mut RegionMemoryState,
    rgb: &[u8],
    alpha: &[u8],
    settings: RegionMemorySettings,
) -> Result<f32, String> {
    let mut foreground = Vec::new();
    let mut background = Vec::new();
    let mut confidence_total = 0.0_f32;
    for y in 0..state.height {
        for x in 0..state.width {
            let index = y * state.width + x;
            let encoded = alpha[index];
            let support = support_weight(x, y, state.width, state.height, state.support, settings);
            let offset = index * 3;
            let pixel = [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
            if encoded >= 220 && support >= 0.72 {
                foreground.push(pixel);
                confidence_total += encoded as f32 / 255.0;
            } else if encoded <= 20 && support <= 0.35 {
                background.push(pixel);
            }
        }
    }
    let confidence = confidence_total / foreground.len().max(1) as f32;
    if foreground.len() < 8 || background.len() < 8 || confidence < settings.update_confidence {
        return Ok(confidence);
    }
    let foreground = ColorModel::from_samples(&foreground)?;
    let background = ColorModel::from_samples(&background)?;
    state.foreground.update(
        foreground,
        state.anchor_foreground,
        settings.update_rate,
        settings.anchor_pull,
    );
    state.background.update(
        background,
        state.anchor_background,
        settings.update_rate * 0.6,
        settings.anchor_pull,
    );
    state.foreground.validate()?;
    state.background.validate()?;
    Ok(confidence)
}

fn segment_one(
    state: &mut RegionMemoryState,
    frame_index: usize,
    rgb: &[u8],
    settings: RegionMemorySettings,
    is_seed: bool,
) -> Result<(MatteFrame, OpticalAlphaReceipt, RegionMemoryFrameReceipt), String> {
    if rgb.len() != state.width * state.height * 3 {
        return Err("region memory frame dimensions differ".into());
    }
    let foreground = state
        .foreground
        .regularized(state.anchor_foreground, settings.anchor_weight);
    let background = state
        .background
        .regularized(state.anchor_background, settings.anchor_weight);
    foreground.validate()?;
    background.validate()?;
    let current_scene_delta = if is_seed {
        0.0
    } else {
        scene_delta(&state.previous_rgb, rgb)
    };
    let scene_cut = !is_seed && current_scene_delta >= settings.scene_cut_mean_delta;
    let mut alpha = Vec::with_capacity(state.width * state.height);
    let mut certainty = 0.0_f32;
    for y in 0..state.height {
        for x in 0..state.width {
            let index = y * state.width + x;
            let offset = index * 3;
            let pixel = [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
            let foreground_distance = distance(pixel, foreground);
            let background_distance = distance(pixel, background);
            let color_probability = (background_distance
                / (foreground_distance + background_distance + 0.0001))
                .clamp(0.000_001, 0.999_999);
            let identity = support_weight(x, y, state.width, state.height, state.support, settings);
            let supported = color_probability * identity;
            let mut probability = smoothstep((supported - 0.55) / 0.50);
            if !is_seed && !scene_cut {
                let prior = state.previous_matte.alpha[index] as f32 / 255.0;
                if (prior - probability).abs() <= 0.16 {
                    probability = probability * (1.0 - settings.temporal_stability)
                        + prior * settings.temporal_stability;
                }
                probability = (probability + state.correction_bias[index] * 0.78).clamp(0.0, 1.0);
            }
            certainty += (probability - 0.5).abs() * 2.0;
            alpha.push((probability * 255.0).round() as u8);
        }
    }
    for bias in &mut state.correction_bias {
        *bias *= 0.65;
        if bias.abs() < 0.01 {
            *bias = 0.0;
        }
    }
    let detected = measured_support(&alpha, state.width, state.height);
    let detected_area = detected.map_or(0, |(_, _, area)| area);
    let area_ratio = detected_area as f32 / state.support.area_ema.max(1.0);
    let full_occlusion = !is_seed && area_ratio < settings.occlusion_area_ratio;
    if scene_cut || full_occlusion {
        alpha.fill(0);
    }
    let confidence = certainty / (state.width * state.height) as f32;
    let raw = MatteFrame {
        frame: frame_index as u64,
        width: state.width as u32,
        height: state.height as u32,
        alpha,
        confidence,
    };
    let shortest = state.width.min(state.height) as f32;
    let coarse = refine_matte(
        &raw,
        None,
        MatteRefine {
            radius: 0,
            contrast: settings.contrast,
            edge_shift: (settings.edge_shift * shortest).round().clamp(-64.0, 64.0) as i32,
            temporal_stability: 0.0,
        },
    )?;
    let previous_for_refinement = if scene_cut || full_occlusion || is_seed {
        None
    } else {
        Some(&state.previous_matte)
    };
    let refined = refine_optical_alpha(
        rgb,
        &coarse,
        previous_for_refinement,
        OpticalAlphaSettings {
            radius: (settings.feather * shortest).round().clamp(2.0, 32.0) as u32,
            temporal_stability: settings.temporal_stability * 0.25,
            ..OpticalAlphaSettings::default()
        },
    )?;

    let matte = refined.matte;
    let mut freeze_reason = if scene_cut {
        RegionMemoryFreezeReason::SceneCut
    } else if full_occlusion {
        RegionMemoryFreezeReason::FullOcclusion
    } else {
        RegionMemoryFreezeReason::None
    };
    let mut update_confidence = 0.0_f32;
    let mut memory_updated = false;
    if freeze_reason == RegionMemoryFreezeReason::None {
        update_confidence = update_models(state, rgb, &matte.alpha, settings)?;
        if update_confidence >= settings.update_confidence {
            memory_updated = true;
            if let Some((center, half_extent, area)) =
                measured_support(&matte.alpha, state.width, state.height)
            {
                update_support(&mut state.support, center, half_extent, area, settings);
            }
        } else if !is_seed {
            freeze_reason = RegionMemoryFreezeReason::LowConfidence;
        }
    } else {
        state.support.velocity[0] *= 0.82;
        state.support.velocity[1] *= 0.82;
    }
    matte.validate()?;
    state.previous_rgb.clear();
    state.previous_rgb.extend_from_slice(rgb);
    state.previous_matte = matte.clone();
    state.last_frame = frame_index;
    let receipt = RegionMemoryFrameReceipt {
        frame: frame_index,
        freeze_reason,
        memory_updated,
        scene_delta: current_scene_delta,
        subject_area_ratio: area_ratio,
        update_confidence,
        support_center: state.support.center,
        support_half_extent: state.support.half_extent,
    };
    Ok((matte, refined.receipt, receipt))
}

fn initial_state(
    frame: &[u8],
    width: usize,
    height: usize,
    initial_frame: usize,
    rect: RegionMemorySeedRect,
) -> Result<RegionMemoryState, String> {
    let (foreground, background, support) = seed_models(frame, width, height, rect)?;
    Ok(RegionMemoryState {
        width,
        height,
        anchor_foreground: foreground,
        anchor_background: background,
        foreground,
        background,
        support,
        previous_rgb: frame.to_vec(),
        previous_matte: MatteFrame {
            frame: initial_frame as u64,
            width: width as u32,
            height: height as u32,
            alpha: vec![0; width * height],
            confidence: 0.0,
        },
        last_frame: initial_frame,
        correction_bias: vec![0.0; width * height],
    })
}

fn postprocess_and_capture<F>(
    state: &mut RegionMemoryState,
    matte: &mut MatteFrame,
    postprocess: &mut F,
) -> Result<(), String>
where
    F: FnMut(&mut MatteFrame),
{
    let before = matte.alpha.clone();
    postprocess(matte);
    matte.validate()?;
    for (index, (before, after)) in before.iter().zip(&matte.alpha).enumerate() {
        let delta = *after as f32 / 255.0 - *before as f32 / 255.0;
        if delta.abs() >= 0.05 {
            state.correction_bias[index] = delta;
        }
    }
    state.previous_matte = matte.clone();
    Ok(())
}

fn segment_with_scene_reseed<F>(
    state: &mut RegionMemoryState,
    frame_index: usize,
    frame: &[u8],
    seed_rect: RegionMemorySeedRect,
    settings: RegionMemorySettings,
    postprocess: &mut F,
) -> Result<(MatteFrame, OpticalAlphaReceipt, RegionMemoryFrameReceipt), String>
where
    F: FnMut(&mut MatteFrame),
{
    let (mut matte, mut refinement, mut receipt) =
        segment_one(state, frame_index, frame, settings, false)?;
    if receipt.freeze_reason == RegionMemoryFreezeReason::SceneCut {
        let observed_scene_delta = receipt.scene_delta;
        *state = initial_state(frame, state.width, state.height, frame_index, seed_rect)?;
        (matte, refinement, receipt) = segment_one(state, frame_index, frame, settings, true)?;
        receipt.freeze_reason = RegionMemoryFreezeReason::SceneCutReseed;
        receipt.scene_delta = observed_scene_delta;
    }
    postprocess_and_capture(state, &mut matte, postprocess)?;
    Ok((matte, refinement, receipt))
}

pub fn validate_region_memory_snapshot(snapshot: &RegionMemoryStateSnapshot) -> Result<(), String> {
    if snapshot.engine != REGION_MEMORY_ROTO_ENGINE
        || snapshot.width < 16
        || snapshot.height < 16
        || snapshot.last_frame > u32::MAX as usize
    {
        return Err("invalid region memory state identity".into());
    }
    ColorModel {
        mean: snapshot.foreground_mean,
        variance: snapshot.foreground_variance,
    }
    .validate()?;
    ColorModel {
        mean: snapshot.background_mean,
        variance: snapshot.background_variance,
    }
    .validate()?;
    Ok(())
}

pub fn segment_region_memory_sequence(
    bytes: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    initial_rect: RegionMemorySeedRect,
    settings: RegionMemorySettings,
) -> Result<RegionMemorySequenceResult, String> {
    segment_region_memory_sequence_with_postprocess(
        bytes,
        width,
        height,
        frame_count,
        initial_frame,
        initial_rect,
        settings,
        |_| {},
    )
}

pub fn segment_region_memory_sequence_with_postprocess<F>(
    bytes: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    initial_rect: RegionMemorySeedRect,
    settings: RegionMemorySettings,
    mut postprocess: F,
) -> Result<RegionMemorySequenceResult, String>
where
    F: FnMut(&mut MatteFrame),
{
    validate_settings(settings)?;
    let frame_bytes = validate_dimensions(bytes, width, height, frame_count)?;
    if initial_frame >= frame_count {
        return Err("invalid region memory initial frame".into());
    }
    let initial = &bytes[initial_frame * frame_bytes..(initial_frame + 1) * frame_bytes];
    let mut seed_state = initial_state(initial, width, height, initial_frame, initial_rect)?;
    let (mut seed, seed_refinement, seed_receipt) =
        segment_one(&mut seed_state, initial_frame, initial, settings, true)?;
    postprocess_and_capture(&mut seed_state, &mut seed, &mut postprocess)?;

    let mut mattes = vec![None; frame_count];
    let mut refinements = vec![None; frame_count];
    let mut receipts = vec![None; frame_count];
    mattes[initial_frame] = Some(seed.clone());
    refinements[initial_frame] = Some(seed_refinement);
    receipts[initial_frame] = Some(seed_receipt);

    let mut forward = seed_state.clone();
    for frame_index in initial_frame + 1..frame_count {
        let start = frame_index * frame_bytes;
        let frame = &bytes[start..start + frame_bytes];
        let (matte, refinement, receipt) = segment_with_scene_reseed(
            &mut forward,
            frame_index,
            frame,
            initial_rect,
            settings,
            &mut postprocess,
        )?;
        mattes[frame_index] = Some(matte);
        refinements[frame_index] = Some(refinement);
        receipts[frame_index] = Some(receipt);
    }
    let mut backward = seed_state;
    for frame_index in (0..initial_frame).rev() {
        let start = frame_index * frame_bytes;
        let frame = &bytes[start..start + frame_bytes];
        let (matte, refinement, receipt) = segment_with_scene_reseed(
            &mut backward,
            frame_index,
            frame,
            initial_rect,
            settings,
            &mut postprocess,
        )?;
        mattes[frame_index] = Some(matte);
        refinements[frame_index] = Some(refinement);
        receipts[frame_index] = Some(receipt);
    }
    let frames = receipts
        .into_iter()
        .map(|receipt| receipt.expect("all region memory receipts present"))
        .collect::<Vec<_>>();
    let model_bounds_valid = forward.foreground.validate().is_ok()
        && forward.background.validate().is_ok()
        && backward.foreground.validate().is_ok()
        && backward.background.validate().is_ok();
    if !model_bounds_valid {
        return Err("region memory color model invalid after sequence".into());
    }
    Ok(RegionMemorySequenceResult {
        mattes: mattes
            .into_iter()
            .map(|matte| matte.expect("all region memory mattes present"))
            .collect(),
        refinements: refinements
            .into_iter()
            .map(|receipt| receipt.expect("all optical receipts present"))
            .collect(),
        receipt: RegionMemorySequenceReceipt {
            schema: "editkin.region-memory-roto-receipt/v1",
            engine: REGION_MEMORY_ROTO_ENGINE,
            frame_count,
            memory_updates: frames.iter().filter(|frame| frame.memory_updated).count(),
            full_occlusion_freezes: frames
                .iter()
                .filter(|frame| frame.freeze_reason == RegionMemoryFreezeReason::FullOcclusion)
                .count(),
            scene_cut_freezes: frames
                .iter()
                .filter(|frame| frame.freeze_reason == RegionMemoryFreezeReason::SceneCut)
                .count(),
            scene_cut_reseeds: frames
                .iter()
                .filter(|frame| frame.freeze_reason == RegionMemoryFreezeReason::SceneCutReseed)
                .count(),
            low_confidence_freezes: frames
                .iter()
                .filter(|frame| frame.freeze_reason == RegionMemoryFreezeReason::LowConfidence)
                .count(),
            model_bounds_valid,
            frames,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rectangle_sequence(width: usize, height: usize, colors: &[[u8; 3]]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(width * height * colors.len() * 3);
        for (frame, color) in colors.iter().enumerate() {
            let mut rgb = vec![24_u8; width * height * 3];
            for y in 10..22 {
                for x in 10 + frame..24 + frame {
                    let offset = (y * width + x) * 3;
                    rgb[offset..offset + 3].copy_from_slice(color);
                }
            }
            bytes.extend(rgb);
        }
        bytes
    }

    fn subject_frame(
        width: usize,
        height: usize,
        left: usize,
        visible: bool,
        background: [u8; 3],
    ) -> Vec<u8> {
        let mut rgb = vec![0_u8; width * height * 3];
        for pixel in rgb.chunks_exact_mut(3) {
            pixel.copy_from_slice(&background);
        }
        if visible {
            for y in 10..22 {
                for x in left..left + 14 {
                    let offset = (y * width + x) * 3;
                    rgb[offset..offset + 3].copy_from_slice(&[220, 55, 44]);
                }
            }
        }
        rgb
    }

    #[test]
    fn adapts_to_gradual_color_drift_deterministically() {
        let width = 48;
        let height = 32;
        let colors = [
            [220, 55, 44],
            [205, 66, 49],
            [188, 78, 54],
            [170, 90, 59],
            [152, 102, 64],
        ];
        let bytes = rectangle_sequence(width, height, &colors);
        let request = || {
            segment_region_memory_sequence(
                &bytes,
                width,
                height,
                colors.len(),
                0,
                RegionMemorySeedRect {
                    x: 8.0 / width as f64,
                    y: 8.0 / height as f64,
                    width: 18.0 / width as f64,
                    height: 16.0 / height as f64,
                },
                RegionMemorySettings::default(),
            )
            .unwrap()
        };
        let first = request();
        let second = request();
        assert_eq!(
            first.mattes.last().unwrap().alpha,
            second.mattes.last().unwrap().alpha
        );
        assert!(first.receipt.memory_updates >= 3);
        assert!(
            first
                .mattes
                .last()
                .unwrap()
                .alpha
                .iter()
                .filter(|value| **value >= 128)
                .count()
                >= 120
        );
    }

    #[test]
    fn identity_support_rejects_a_distant_same_color_distractor() {
        let width = 64;
        let height = 40;
        let mut bytes = rectangle_sequence(width, height, &[[220, 55, 44]; 4]);
        let frame_bytes = width * height * 3;
        for frame in 1..4 {
            for y in 10..22 {
                for x in 48..60 {
                    let offset = frame * frame_bytes + (y * width + x) * 3;
                    bytes[offset..offset + 3].copy_from_slice(&[220, 55, 44]);
                }
            }
        }
        let result = segment_region_memory_sequence(
            &bytes,
            width,
            height,
            4,
            0,
            RegionMemorySeedRect {
                x: 8.0 / width as f64,
                y: 8.0 / height as f64,
                width: 20.0 / width as f64,
                height: 16.0 / height as f64,
            },
            RegionMemorySettings::default(),
        )
        .unwrap();
        let last = &result.mattes[3].alpha;
        let distractor_positive = (10..22)
            .flat_map(|y| (48..60).map(move |x| y * width + x))
            .filter(|index| last[*index] >= 128)
            .count();
        assert_eq!(distractor_positive, 0);
    }

    #[test]
    fn full_occlusion_freezes_updates_and_reappearance_recovers_identity() {
        let width = 48;
        let height = 32;
        let visibility = [true, true, false, false, true, true];
        let mut bytes = Vec::new();
        for (frame, visible) in visibility.into_iter().enumerate() {
            bytes.extend(subject_frame(
                width,
                height,
                10 + frame.min(1),
                visible,
                [24; 3],
            ));
        }
        let result = segment_region_memory_sequence(
            &bytes,
            width,
            height,
            visibility.len(),
            0,
            RegionMemorySeedRect {
                x: 8.0 / width as f64,
                y: 8.0 / height as f64,
                width: 18.0 / width as f64,
                height: 16.0 / height as f64,
            },
            RegionMemorySettings::default(),
        )
        .unwrap();
        assert_eq!(result.receipt.full_occlusion_freezes, 2);
        assert!(
            result.receipt.frames[2..4]
                .iter()
                .all(|frame| !frame.memory_updated)
        );
        assert!(
            result.mattes[2..4]
                .iter()
                .all(|matte| matte.alpha.iter().all(|value| *value == 0))
        );
        assert!(
            result.mattes[4..].iter().all(|matte| matte
                .alpha
                .iter()
                .filter(|value| **value >= 128)
                .count()
                >= 140)
        );
    }

    #[test]
    fn scene_cut_reseeds_a_new_segment_without_zeroing_the_tail() {
        let width = 48;
        let height = 32;
        let mut bytes = Vec::new();
        bytes.extend(subject_frame(width, height, 10, true, [24; 3]));
        bytes.extend(subject_frame(width, height, 11, true, [24; 3]));
        for _ in 0..3 {
            let mut frame = subject_frame(width, height, 11, false, [210, 145, 36]);
            for y in 10..22 {
                for x in 10..24 {
                    let offset = (y * width + x) * 3;
                    frame[offset..offset + 3].copy_from_slice(&[38, 205, 126]);
                }
            }
            bytes.extend(frame);
        }
        let result = segment_region_memory_sequence(
            &bytes,
            width,
            height,
            5,
            0,
            RegionMemorySeedRect {
                x: 8.0 / width as f64,
                y: 8.0 / height as f64,
                width: 18.0 / width as f64,
                height: 16.0 / height as f64,
            },
            RegionMemorySettings::default(),
        )
        .unwrap();
        assert_eq!(result.receipt.scene_cut_freezes, 0);
        assert_eq!(result.receipt.scene_cut_reseeds, 1);
        assert_eq!(
            result.receipt.frames[2].freeze_reason,
            RegionMemoryFreezeReason::SceneCutReseed
        );
        assert!(
            result.mattes[2..].iter().all(|matte| matte
                .alpha
                .iter()
                .filter(|value| **value >= 128)
                .count()
                >= 120)
        );
    }

    #[test]
    fn invalid_dimensions_settings_and_state_identity_fail_closed() {
        let settings = RegionMemorySettings::default();
        assert!(
            segment_region_memory_sequence(
                &[0; 12],
                16,
                16,
                1,
                0,
                RegionMemorySeedRect {
                    x: 0.2,
                    y: 0.2,
                    width: 0.4,
                    height: 0.4
                },
                settings
            )
            .is_err()
        );
        assert!(
            segment_region_memory_sequence(
                &vec![0; 16 * 16 * 3],
                16,
                16,
                1,
                0,
                RegionMemorySeedRect {
                    x: 0.2,
                    y: 0.2,
                    width: 0.4,
                    height: 0.4
                },
                RegionMemorySettings {
                    update_rate: f32::NAN,
                    ..settings
                }
            )
            .is_err()
        );
        let snapshot = RegionMemoryStateSnapshot {
            engine: "external-memory-engine".into(),
            width: 32,
            height: 24,
            last_frame: 0,
            foreground_mean: [100.0; 3],
            foreground_variance: [64.0; 3],
            background_mean: [20.0; 3],
            background_variance: [64.0; 3],
        };
        assert!(validate_region_memory_snapshot(&snapshot).is_err());
    }
}

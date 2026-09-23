#[cfg(feature = "auto-roto-research-onnx")]
use super::auto_roto_onnx::{OnnxRotoModelReceipt, OnnxRotoPackRequest, OnnxRotoSession};
use super::optical_alpha::{
    OPTICAL_ALPHA_ENGINE, OpticalAlphaReceipt, OpticalAlphaSettings, refine_optical_alpha,
};
use super::region_memory_roto::{
    RegionMemorySeedRect, RegionMemorySequenceReceipt, RegionMemorySettings,
    segment_region_memory_sequence_with_postprocess,
};
use super::roto::{MatteFrame, MatteRefine, boundary_chatter, refine_matte};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

#[cfg(feature = "auto-roto-research-onnx")]
type OptionalResearchSession = OnnxRotoSession;
#[cfg(not(feature = "auto-roto-research-onnx"))]
type OptionalResearchSession = ();

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct RotoRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct RotoPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RotoCorrectionMode {
    Foreground,
    Background,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotoCorrectionStroke {
    pub id: String,
    pub frame: usize,
    pub mode: RotoCorrectionMode,
    pub radius: f32,
    pub points: Vec<RotoPoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoRotoRequest {
    pub raw_path: PathBuf,
    pub output_dir: PathBuf,
    pub width: usize,
    pub height: usize,
    pub frame_count: usize,
    pub analysis_fps: f64,
    pub initial_frame: usize,
    pub initial_rect: RotoRect,
    #[serde(default = "default_temporal_stability")]
    pub temporal_stability: f32,
    #[serde(default = "default_feather")]
    pub feather: f32,
    #[serde(default)]
    pub edge_shift: f32,
    #[serde(default = "default_contrast")]
    pub contrast: f32,
    #[serde(default)]
    pub corrections: Vec<RotoCorrectionStroke>,
    #[cfg(feature = "auto-roto-research-onnx")]
    #[serde(default)]
    pub onnx_pack: Option<OnnxRotoPackRequest>,
    #[serde(default)]
    pub region_memory_policy: RegionMemoryRoutePolicy,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegionMemoryRoutePolicy {
    #[default]
    FixedBaseline,
    GuardedExperimental,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionMemoryRoutingReceipt {
    pub schema: &'static str,
    pub requested: RegionMemoryRoutePolicy,
    pub executed: &'static str,
    pub candidate_attempted: bool,
    pub deterministic_fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

fn default_temporal_stability() -> f32 {
    0.22
}
fn default_feather() -> f32 {
    0.01
}
fn default_contrast() -> f32 {
    1.7
}

const MAX_AUTO_ROTO_DIMENSION: usize = 8_192;
const MAX_AUTO_ROTO_PIXELS_PER_FRAME: usize = 16_777_216;
const MAX_AUTO_ROTO_FRAME_COUNT: usize = 36_000;
const MAX_AUTO_ROTO_ALPHA_BYTES: usize = 2 * 1024 * 1024 * 1024;

fn validated_auto_roto_layout(
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    raw_bytes: u64,
) -> Result<(usize, usize), String> {
    let pixels = width
        .checked_mul(height)
        .ok_or("auto roto pixel count overflow")?;
    let frame_bytes = pixels
        .checked_mul(3)
        .ok_or("auto roto frame size overflow")?;
    let alpha_bytes = pixels
        .checked_mul(frame_count)
        .ok_or("auto roto sequence size overflow")?;
    let expected_raw_bytes = frame_bytes
        .checked_mul(frame_count)
        .ok_or("auto roto raw sequence size overflow")?;
    if width < 16
        || height < 16
        || width > MAX_AUTO_ROTO_DIMENSION
        || height > MAX_AUTO_ROTO_DIMENSION
        || pixels > MAX_AUTO_ROTO_PIXELS_PER_FRAME
        || frame_count == 0
        || frame_count > MAX_AUTO_ROTO_FRAME_COUNT
        || initial_frame >= frame_count
        || alpha_bytes > MAX_AUTO_ROTO_ALPHA_BYTES
        || raw_bytes != expected_raw_bytes as u64
    {
        return Err("invalid or unsafe auto roto RGB sequence layout".into());
    }
    Ok((frame_bytes, alpha_bytes))
}

fn write_alpha_png(
    path: &PathBuf,
    width: usize,
    height: usize,
    alpha: &[u8],
) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .map_err(|error| error.to_string())?
        .write_image_data(alpha)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRotoFrameReceipt {
    pub frame: usize,
    pub time: f64,
    pub alpha_path: PathBuf,
    pub confidence: f32,
    pub foreground_ratio: f64,
    pub boundary_chatter: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRotoAlphaRefinementReceipt {
    pub schema: &'static str,
    pub engine: &'static str,
    pub applied_frames: usize,
    pub radius: u32,
    pub background_threshold: f32,
    pub foreground_threshold: f32,
    pub coarse_weight: f32,
    pub temporal_stability: f32,
    pub temporal_gate: f32,
    pub changed_pixels: usize,
    pub fractional_pixels: usize,
    pub solved_pixels: usize,
    pub mean_solve_confidence: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRotoReceipt {
    pub schema: &'static str,
    pub engine: String,
    pub width: usize,
    pub height: usize,
    pub analysis_fps: f64,
    pub initial_frame: usize,
    pub sequence_path: PathBuf,
    pub frames: Vec<AutoRotoFrameReceipt>,
    pub mean_boundary_chatter: f64,
    pub correction_strokes_applied: usize,
    pub corrected_frames: Vec<usize>,
    pub alpha_refinement: AutoRotoAlphaRefinementReceipt,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region_memory: Option<RegionMemorySequenceReceipt>,
    pub region_memory_routing: RegionMemoryRoutingReceipt,
    #[cfg(feature = "auto-roto-research-onnx")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onnx_model: Option<OnnxRotoModelReceipt>,
    pub frozen: bool,
}

#[derive(Clone, Copy)]
struct ColorModel {
    mean: [f32; 3],
    variance: [f32; 3],
}

fn model(samples: &[[u8; 3]]) -> Result<ColorModel, String> {
    if samples.len() < 8 {
        return Err("auto roto seed has too few pixels".into());
    }
    let mut mean = [0.0_f32; 3];
    for sample in samples {
        for channel in 0..3 {
            mean[channel] += sample[channel] as f32;
        }
    }
    for channel in 0..3 {
        mean[channel] /= samples.len() as f32;
    }
    let mut variance = [0.0_f32; 3];
    for sample in samples {
        for channel in 0..3 {
            variance[channel] += (sample[channel] as f32 - mean[channel]).powi(2);
        }
    }
    for channel in 0..3 {
        variance[channel] = (variance[channel] / samples.len() as f32).max(64.0);
    }
    Ok(ColorModel { mean, variance })
}

fn distance(pixel: [u8; 3], model: ColorModel) -> f32 {
    (0..3)
        .map(|channel| {
            (pixel[channel] as f32 - model.mean[channel]).powi(2) / model.variance[channel]
        })
        .sum()
}

fn seed_models(
    frame: &[u8],
    width: usize,
    height: usize,
    rect: RotoRect,
) -> Result<(ColorModel, ColorModel), String> {
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
        return Err("invalid auto roto seed rectangle".into());
    }
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
    let mut foreground = Vec::new();
    let mut background = Vec::new();
    let border = (width.min(height) / 12).max(1);
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
    Ok((model(&foreground)?, model(&background)?))
}

fn segment_frame(
    frame_index: usize,
    frame: &[u8],
    width: usize,
    height: usize,
    foreground: ColorModel,
    background: ColorModel,
    previous: Option<&MatteFrame>,
    model: Option<&mut OptionalResearchSession>,
    stability: f32,
    feather: f32,
    edge_shift: f32,
    contrast: f32,
) -> Result<(MatteFrame, OpticalAlphaReceipt), String> {
    let mut color_probabilities = Vec::with_capacity(width * height);
    let mut logits = Vec::with_capacity(width * height);
    for index in 0..width * height {
        let offset = index * 3;
        let pixel = [frame[offset], frame[offset + 1], frame[offset + 2]];
        let foreground_distance = distance(pixel, foreground);
        let background_distance = distance(pixel, background);
        let probability = (background_distance
            / (foreground_distance + background_distance + 0.0001))
            .clamp(0.000_001, 0.999_999);
        color_probabilities.push(probability);
        logits.push((probability / (1.0 - probability)).ln());
    }
    #[cfg(feature = "auto-roto-research-onnx")]
    let probabilities = match model {
        Some(model) => model.calibrate_probabilities(&logits)?,
        None => color_probabilities,
    };
    #[cfg(not(feature = "auto-roto-research-onnx"))]
    let probabilities = {
        let _ = (model, logits);
        color_probabilities
    };
    if probabilities.len() != width * height {
        return Err("Auto Roto probability count mismatch".into());
    }
    let mut alpha = Vec::with_capacity(width * height);
    let mut certainty = 0.0_f32;
    for (index, color_probability) in probabilities.into_iter().enumerate() {
        let temporal =
            previous.map_or(color_probability, |matte| matte.alpha[index] as f32 / 255.0);
        let probability = color_probability * (1.0 - stability) + temporal * stability;
        certainty += (probability - 0.5).abs() * 2.0;
        alpha.push((probability * 255.0).round() as u8);
    }
    let raw = MatteFrame {
        frame: frame_index as u64,
        width: width as u32,
        height: height as u32,
        alpha,
        confidence: certainty / (width * height) as f32,
    };
    let shortest = width.min(height) as f32;
    let coarse = refine_matte(
        &raw,
        None,
        MatteRefine {
            radius: 0,
            contrast,
            edge_shift: (edge_shift * shortest).round().clamp(-64.0, 64.0) as i32,
            temporal_stability: 0.0,
        },
    )?;
    let refined = refine_optical_alpha(
        frame,
        &coarse,
        previous,
        OpticalAlphaSettings {
            radius: (feather * shortest).round().clamp(2.0, 32.0) as u32,
            temporal_stability: stability * 0.25,
            ..OpticalAlphaSettings::default()
        },
    )?;
    Ok((refined.matte, refined.receipt))
}

fn validate_corrections(
    corrections: &[RotoCorrectionStroke],
    frame_count: usize,
) -> Result<(), String> {
    for stroke in corrections {
        if stroke.id.trim().is_empty()
            || stroke.id.len() > 128
            || stroke.frame >= frame_count
            || !stroke.radius.is_finite()
            || !(0.001..=0.25).contains(&stroke.radius)
            || stroke.points.is_empty()
            || stroke.points.len() > 4096
            || stroke.points.iter().any(|point| {
                !point.x.is_finite()
                    || !point.y.is_finite()
                    || !(0.0..=1.0).contains(&point.x)
                    || !(0.0..=1.0).contains(&point.y)
            })
        {
            return Err(format!(
                "invalid Auto Roto correction stroke: {}",
                stroke.id
            ));
        }
    }
    Ok(())
}

fn validate_auto_roto_settings(
    temporal_stability: f32,
    feather: f32,
    edge_shift: f32,
    contrast: f32,
    corrections: &[RotoCorrectionStroke],
    frame_count: usize,
) -> Result<(), String> {
    if !temporal_stability.is_finite()
        || !(0.0..=0.9).contains(&temporal_stability)
        || !feather.is_finite()
        || !(0.0..=0.25).contains(&feather)
        || !edge_shift.is_finite()
        || !(-0.25..=0.25).contains(&edge_shift)
        || !contrast.is_finite()
        || !(0.0..=4.0).contains(&contrast)
    {
        return Err("invalid auto roto refinement settings".into());
    }
    validate_corrections(corrections, frame_count)
}

fn paint_correction_disc(
    matte: &mut MatteFrame,
    point: RotoPoint,
    radius: f32,
    mode: RotoCorrectionMode,
) {
    let width = matte.width as usize;
    let height = matte.height as usize;
    let shortest = width.min(height) as f32;
    let radius_pixels = (radius * shortest).max(0.75);
    let center_x = point.x as f32 * (width.saturating_sub(1)) as f32;
    let center_y = point.y as f32 * (height.saturating_sub(1)) as f32;
    let left = (center_x - radius_pixels).floor().max(0.0) as usize;
    let right = (center_x + radius_pixels)
        .ceil()
        .min(width.saturating_sub(1) as f32) as usize;
    let top = (center_y - radius_pixels).floor().max(0.0) as usize;
    let bottom = (center_y + radius_pixels)
        .ceil()
        .min(height.saturating_sub(1) as f32) as usize;
    let target = if mode == RotoCorrectionMode::Foreground {
        255.0
    } else {
        0.0
    };
    for y in top..=bottom {
        for x in left..=right {
            let distance = ((x as f32 - center_x).powi(2) + (y as f32 - center_y).powi(2)).sqrt();
            if distance > radius_pixels {
                continue;
            }
            let normalized = (1.0 - distance / radius_pixels).clamp(0.0, 1.0);
            let weight = normalized * normalized * (3.0 - 2.0 * normalized);
            let index = y * width + x;
            matte.alpha[index] =
                (matte.alpha[index] as f32 * (1.0 - weight) + target * weight).round() as u8;
        }
    }
}

fn apply_frame_corrections(matte: &mut MatteFrame, corrections: &[RotoCorrectionStroke]) {
    let frame = matte.frame as usize;
    for stroke in corrections.iter().filter(|stroke| stroke.frame == frame) {
        let shortest = matte.width.min(matte.height) as f64;
        for segment in stroke.points.windows(2) {
            let dx = (segment[1].x - segment[0].x) * matte.width as f64;
            let dy = (segment[1].y - segment[0].y) * matte.height as f64;
            let steps = ((dx.hypot(dy) / (stroke.radius as f64 * shortest * 0.45).max(0.5)).ceil()
                as usize)
                .max(1);
            for step in 0..=steps {
                let ratio = step as f64 / steps as f64;
                paint_correction_disc(
                    matte,
                    RotoPoint {
                        x: segment[0].x + (segment[1].x - segment[0].x) * ratio,
                        y: segment[0].y + (segment[1].y - segment[0].y) * ratio,
                    },
                    stroke.radius,
                    stroke.mode,
                );
            }
        }
        if stroke.points.len() == 1 {
            paint_correction_disc(matte, stroke.points[0], stroke.radius, stroke.mode);
        }
    }
}

pub fn segment_rgb_sequence(
    bytes: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    initial_rect: RotoRect,
    temporal_stability: f32,
    feather: f32,
    edge_shift: f32,
    contrast: f32,
    corrections: &[RotoCorrectionStroke],
) -> Result<Vec<MatteFrame>, String> {
    Ok(segment_rgb_sequence_with_model(
        bytes,
        width,
        height,
        frame_count,
        initial_frame,
        initial_rect,
        temporal_stability,
        feather,
        edge_shift,
        contrast,
        corrections,
        None,
        false,
    )?
    .mattes)
}

/// Frozen comparison path retained for the bounded region-memory evaluator. Product callers use
/// `segment_rgb_sequence`, whose native route is guarded by that evaluator.
pub fn segment_rgb_sequence_fixed_initial_frame_baseline(
    bytes: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    initial_rect: RotoRect,
    temporal_stability: f32,
    feather: f32,
    edge_shift: f32,
    contrast: f32,
    corrections: &[RotoCorrectionStroke],
) -> Result<Vec<MatteFrame>, String> {
    Ok(segment_rgb_sequence_with_model(
        bytes,
        width,
        height,
        frame_count,
        initial_frame,
        initial_rect,
        temporal_stability,
        feather,
        edge_shift,
        contrast,
        corrections,
        None,
        false,
    )?
    .mattes)
}

struct SegmentedSequence {
    mattes: Vec<MatteFrame>,
    refinements: Vec<OpticalAlphaReceipt>,
    region_memory: Option<RegionMemorySequenceReceipt>,
}

fn segment_rgb_sequence_with_model(
    bytes: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    initial_rect: RotoRect,
    temporal_stability: f32,
    feather: f32,
    edge_shift: f32,
    contrast: f32,
    corrections: &[RotoCorrectionStroke],
    mut model: Option<&mut OptionalResearchSession>,
    allow_region_memory: bool,
) -> Result<SegmentedSequence, String> {
    let (frame_bytes, _) = validated_auto_roto_layout(
        width,
        height,
        frame_count,
        initial_frame,
        bytes.len() as u64,
    )?;
    validate_auto_roto_settings(
        temporal_stability,
        feather,
        edge_shift,
        contrast,
        corrections,
        frame_count,
    )?;
    if allow_region_memory && model.is_none() {
        let result = segment_region_memory_sequence_with_postprocess(
            bytes,
            width,
            height,
            frame_count,
            initial_frame,
            RegionMemorySeedRect {
                x: initial_rect.x,
                y: initial_rect.y,
                width: initial_rect.width,
                height: initial_rect.height,
            },
            RegionMemorySettings {
                temporal_stability,
                feather,
                edge_shift,
                contrast,
                ..RegionMemorySettings::default()
            },
            |matte| apply_frame_corrections(matte, corrections),
        )?;
        return Ok(SegmentedSequence {
            mattes: result.mattes,
            refinements: result.refinements,
            region_memory: Some(result.receipt),
        });
    }
    let initial = &bytes[initial_frame * frame_bytes..(initial_frame + 1) * frame_bytes];
    let (foreground, background) = seed_models(initial, width, height, initial_rect)?;
    let (mut seed, seed_refinement) = segment_frame(
        initial_frame,
        initial,
        width,
        height,
        foreground,
        background,
        None,
        model.as_deref_mut(),
        0.0,
        feather,
        edge_shift,
        contrast,
    )?;
    apply_frame_corrections(&mut seed, corrections);
    let mut output = vec![None; frame_count];
    let mut refinements = vec![None; frame_count];
    output[initial_frame] = Some(seed.clone());
    refinements[initial_frame] = Some(seed_refinement);
    let mut previous = seed.clone();
    for frame in initial_frame + 1..frame_count {
        let start = frame * frame_bytes;
        let (mut matte, refinement) = segment_frame(
            frame,
            &bytes[start..start + frame_bytes],
            width,
            height,
            foreground,
            background,
            Some(&previous),
            model.as_deref_mut(),
            temporal_stability,
            feather,
            edge_shift,
            contrast,
        )?;
        apply_frame_corrections(&mut matte, corrections);
        output[frame] = Some(matte.clone());
        refinements[frame] = Some(refinement);
        previous = matte;
    }
    previous = seed;
    for frame in (0..initial_frame).rev() {
        let start = frame * frame_bytes;
        let (mut matte, refinement) = segment_frame(
            frame,
            &bytes[start..start + frame_bytes],
            width,
            height,
            foreground,
            background,
            Some(&previous),
            model.as_deref_mut(),
            temporal_stability,
            feather,
            edge_shift,
            contrast,
        )?;
        apply_frame_corrections(&mut matte, corrections);
        output[frame] = Some(matte.clone());
        refinements[frame] = Some(refinement);
        previous = matte;
    }
    Ok(SegmentedSequence {
        mattes: output
            .into_iter()
            .map(|matte| matte.expect("all frames segmented"))
            .collect(),
        refinements: refinements
            .into_iter()
            .map(|receipt| receipt.expect("all frames refined"))
            .collect(),
        region_memory: None,
    })
}

fn guarded_candidate_or_fallback<T, C, B>(
    candidate: C,
    baseline: B,
) -> Result<(T, bool, Option<String>), String>
where
    C: FnOnce() -> Result<T, String>,
    B: FnOnce() -> Result<T, String>,
{
    match candidate() {
        Ok(value) => Ok((value, false, None)),
        Err(candidate_error) => baseline()
            .map(|value| {
                (
                    value,
                    true,
                    Some(format!("candidate-error:{candidate_error}")),
                )
            })
            .map_err(|baseline_error| {
                format!(
                    "region memory candidate and fixed baseline failed: candidate={candidate_error}; baseline={baseline_error}"
                )
            }),
    }
}

fn aggregate_alpha_refinements(
    refinement_frames: &[OpticalAlphaReceipt],
) -> Result<AutoRotoAlphaRefinementReceipt, String> {
    let first = refinement_frames
        .first()
        .ok_or("missing optical alpha receipt")?;
    let solved_pixels = refinement_frames
        .iter()
        .map(|item| item.solved_pixels)
        .sum::<usize>();
    Ok(AutoRotoAlphaRefinementReceipt {
        schema: "editkin.optical-alpha-refinement-aggregate/v1",
        engine: OPTICAL_ALPHA_ENGINE,
        applied_frames: refinement_frames.len(),
        radius: first.radius,
        background_threshold: first.background_threshold,
        foreground_threshold: first.foreground_threshold,
        coarse_weight: first.coarse_weight,
        temporal_stability: first.temporal_stability,
        temporal_gate: first.temporal_gate,
        changed_pixels: refinement_frames
            .iter()
            .map(|item| item.changed_pixels)
            .sum(),
        fractional_pixels: refinement_frames
            .iter()
            .map(|item| item.fractional_pixels)
            .sum(),
        solved_pixels,
        mean_solve_confidence: if solved_pixels == 0 {
            0.0
        } else {
            refinement_frames
                .iter()
                .map(|item| item.mean_solve_confidence * item.solved_pixels as f32)
                .sum::<f32>()
                / solved_pixels as f32
        },
    })
}

fn corrected_frame_indices(corrections: &[RotoCorrectionStroke]) -> Vec<usize> {
    let mut frames = corrections
        .iter()
        .map(|stroke| stroke.frame)
        .collect::<Vec<_>>();
    frames.sort_unstable();
    frames.dedup();
    frames
}

fn read_rgb_frame(
    input: &mut fs::File,
    frame: usize,
    frame_bytes: usize,
    buffer: &mut [u8],
) -> Result<(), String> {
    let offset = frame
        .checked_mul(frame_bytes)
        .ok_or("auto roto frame offset overflow")? as u64;
    input
        .seek(SeekFrom::Start(offset))
        .and_then(|_| input.read_exact(buffer))
        .map_err(|error| format!("read auto roto frame {frame}: {error}"))
}

fn write_streamed_matte(
    request: &AutoRotoRequest,
    sequence: &mut fs::File,
    matte: &MatteFrame,
    frame_receipts: &mut [Option<AutoRotoFrameReceipt>],
    refinements: &mut [Option<OpticalAlphaReceipt>],
    refinement: OpticalAlphaReceipt,
) -> Result<(), String> {
    let frame = matte.frame as usize;
    let alpha_offset = frame
        .checked_mul(matte.alpha.len())
        .ok_or("auto roto alpha offset overflow")? as u64;
    sequence
        .seek(SeekFrom::Start(alpha_offset))
        .and_then(|_| sequence.write_all(&matte.alpha))
        .map_err(|error| format!("write auto roto alpha frame {frame}: {error}"))?;
    let alpha_path = request.output_dir.join(format!("frame-{frame:06}.png"));
    write_alpha_png(&alpha_path, request.width, request.height, &matte.alpha)?;
    frame_receipts[frame] = Some(AutoRotoFrameReceipt {
        frame,
        time: frame as f64 / request.analysis_fps,
        alpha_path,
        confidence: matte.confidence,
        foreground_ratio: matte.alpha.iter().filter(|value| **value >= 128).count() as f64
            / matte.alpha.len() as f64,
        boundary_chatter: 0.0,
    });
    refinements[frame] = Some(refinement);
    Ok(())
}

fn run_fixed_baseline_streaming(request: AutoRotoRequest) -> Result<AutoRotoReceipt, String> {
    let metadata = fs::metadata(&request.raw_path)
        .map_err(|error| format!("inspect auto roto frames: {error}"))?;
    if !metadata.is_file() {
        return Err("auto roto RGB input is not a file".into());
    }
    let (frame_bytes, alpha_bytes) = validated_auto_roto_layout(
        request.width,
        request.height,
        request.frame_count,
        request.initial_frame,
        metadata.len(),
    )?;
    validate_auto_roto_settings(
        request.temporal_stability,
        request.feather,
        request.edge_shift,
        request.contrast,
        &request.corrections,
        request.frame_count,
    )?;
    fs::create_dir_all(&request.output_dir).map_err(|error| error.to_string())?;
    let sequence_path = request.output_dir.join("matte-sequence.alpha8");
    let mut sequence = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(&sequence_path)
        .map_err(|error| format!("create auto roto alpha sequence: {error}"))?;
    sequence
        .set_len(alpha_bytes as u64)
        .map_err(|error| format!("allocate auto roto alpha sequence: {error}"))?;
    let mut input = fs::File::open(&request.raw_path)
        .map_err(|error| format!("open auto roto frames: {error}"))?;
    let mut rgb = vec![0_u8; frame_bytes];
    read_rgb_frame(&mut input, request.initial_frame, frame_bytes, &mut rgb)?;
    let (foreground, background) =
        seed_models(&rgb, request.width, request.height, request.initial_rect)?;
    let (mut seed, seed_refinement) = segment_frame(
        request.initial_frame,
        &rgb,
        request.width,
        request.height,
        foreground,
        background,
        None,
        None,
        0.0,
        request.feather,
        request.edge_shift,
        request.contrast,
    )?;
    apply_frame_corrections(&mut seed, &request.corrections);
    let mut frame_receipts = (0..request.frame_count).map(|_| None).collect::<Vec<_>>();
    let mut refinements = (0..request.frame_count).map(|_| None).collect::<Vec<_>>();
    write_streamed_matte(
        &request,
        &mut sequence,
        &seed,
        &mut frame_receipts,
        &mut refinements,
        seed_refinement,
    )?;

    let backward_seed = seed.clone();
    let mut previous = seed;
    let mut chatter_total = 0.0;
    for frame in request.initial_frame + 1..request.frame_count {
        read_rgb_frame(&mut input, frame, frame_bytes, &mut rgb)?;
        let (mut matte, refinement) = segment_frame(
            frame,
            &rgb,
            request.width,
            request.height,
            foreground,
            background,
            Some(&previous),
            None,
            request.temporal_stability,
            request.feather,
            request.edge_shift,
            request.contrast,
        )?;
        apply_frame_corrections(&mut matte, &request.corrections);
        let chatter = boundary_chatter(&previous, &matte)?;
        chatter_total += chatter;
        write_streamed_matte(
            &request,
            &mut sequence,
            &matte,
            &mut frame_receipts,
            &mut refinements,
            refinement,
        )?;
        frame_receipts[frame]
            .as_mut()
            .expect("streamed frame receipt")
            .boundary_chatter = chatter;
        previous = matte;
    }
    previous = backward_seed;
    for frame in (0..request.initial_frame).rev() {
        read_rgb_frame(&mut input, frame, frame_bytes, &mut rgb)?;
        let (mut matte, refinement) = segment_frame(
            frame,
            &rgb,
            request.width,
            request.height,
            foreground,
            background,
            Some(&previous),
            None,
            request.temporal_stability,
            request.feather,
            request.edge_shift,
            request.contrast,
        )?;
        apply_frame_corrections(&mut matte, &request.corrections);
        let chatter = boundary_chatter(&matte, &previous)?;
        chatter_total += chatter;
        frame_receipts[frame + 1]
            .as_mut()
            .expect("later streamed frame receipt")
            .boundary_chatter = chatter;
        write_streamed_matte(
            &request,
            &mut sequence,
            &matte,
            &mut frame_receipts,
            &mut refinements,
            refinement,
        )?;
        previous = matte;
    }
    sequence
        .sync_all()
        .map_err(|error| format!("sync auto roto alpha sequence: {error}"))?;
    let frame_receipts = frame_receipts
        .into_iter()
        .map(|receipt| receipt.expect("all streamed frame receipts exist"))
        .collect::<Vec<_>>();
    let refinements = refinements
        .into_iter()
        .map(|receipt| receipt.expect("all streamed refinements exist"))
        .collect::<Vec<_>>();
    let receipt = AutoRotoReceipt {
        schema: "editkin.auto-roto-matte/v1",
        engine: "editkin-native-color-temporal-roto/v1".into(),
        width: request.width,
        height: request.height,
        analysis_fps: request.analysis_fps,
        initial_frame: request.initial_frame,
        sequence_path,
        frames: frame_receipts,
        mean_boundary_chatter: chatter_total / request.frame_count.max(1) as f64,
        correction_strokes_applied: request.corrections.len(),
        corrected_frames: corrected_frame_indices(&request.corrections),
        alpha_refinement: aggregate_alpha_refinements(&refinements)?,
        region_memory: None,
        region_memory_routing: RegionMemoryRoutingReceipt {
            schema: "editkin.region-memory-routing/v1",
            requested: RegionMemoryRoutePolicy::FixedBaseline,
            executed: "fixed_baseline",
            candidate_attempted: false,
            deterministic_fallback: false,
            fallback_reason: None,
        },
        #[cfg(feature = "auto-roto-research-onnx")]
        onnx_model: None,
        frozen: true,
    };
    let manifest_path = request.output_dir.join("matte-manifest.json");
    fs::write(
        manifest_path,
        serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(receipt)
}

pub fn run_auto_roto(request: AutoRotoRequest) -> Result<AutoRotoReceipt, String> {
    if !request.analysis_fps.is_finite()
        || request.analysis_fps <= 0.0
        || request.analysis_fps > 120.0
    {
        return Err("invalid auto roto analysis fps".into());
    }
    #[cfg(feature = "auto-roto-research-onnx")]
    let has_research_pack = request.onnx_pack.is_some();
    #[cfg(not(feature = "auto-roto-research-onnx"))]
    let has_research_pack = false;
    if !has_research_pack && request.region_memory_policy == RegionMemoryRoutePolicy::FixedBaseline
    {
        return run_fixed_baseline_streaming(request);
    }
    let bytes =
        fs::read(&request.raw_path).map_err(|error| format!("read auto roto frames: {error}"))?;
    #[cfg(feature = "auto-roto-research-onnx")]
    let mut research_session = request
        .onnx_pack
        .as_ref()
        .map(OnnxRotoSession::load)
        .transpose()?;
    #[cfg(not(feature = "auto-roto-research-onnx"))]
    let mut research_session: Option<OptionalResearchSession> = None;
    let segment = |model: Option<&mut OptionalResearchSession>, allow_region_memory: bool| {
        segment_rgb_sequence_with_model(
            &bytes,
            request.width,
            request.height,
            request.frame_count,
            request.initial_frame,
            request.initial_rect,
            request.temporal_stability,
            request.feather,
            request.edge_shift,
            request.contrast,
            &request.corrections,
            model,
            allow_region_memory,
        )
    };
    let (segmented, region_memory_routing) = if research_session.is_some() {
        (
            segment(research_session.as_mut(), false)?,
            RegionMemoryRoutingReceipt {
                schema: "editkin.region-memory-routing/v1",
                requested: request.region_memory_policy,
                #[cfg(feature = "auto-roto-research-onnx")]
                executed: "onnx_bypass",
                #[cfg(not(feature = "auto-roto-research-onnx"))]
                executed: "unreachable_research_bypass",
                candidate_attempted: false,
                deterministic_fallback: false,
                fallback_reason: None,
            },
        )
    } else if request.region_memory_policy == RegionMemoryRoutePolicy::GuardedExperimental {
        let (result, fell_back, fallback_reason) =
            guarded_candidate_or_fallback(|| segment(None, true), || segment(None, false))?;
        (
            result,
            RegionMemoryRoutingReceipt {
                schema: "editkin.region-memory-routing/v1",
                requested: request.region_memory_policy,
                executed: if fell_back {
                    "fixed_baseline"
                } else {
                    "guarded_experimental"
                },
                candidate_attempted: true,
                deterministic_fallback: fell_back,
                fallback_reason,
            },
        )
    } else {
        (
            segment(None, false)?,
            RegionMemoryRoutingReceipt {
                schema: "editkin.region-memory-routing/v1",
                requested: request.region_memory_policy,
                executed: "fixed_baseline",
                candidate_attempted: false,
                deterministic_fallback: false,
                fallback_reason: None,
            },
        )
    };
    let mattes = segmented.mattes;
    let refinement_frames = segmented.refinements;
    let region_memory = segmented.region_memory;
    fs::create_dir_all(&request.output_dir).map_err(|error| error.to_string())?;
    let sequence_path = request.output_dir.join("matte-sequence.alpha8");
    let sequence_bytes = mattes
        .iter()
        .flat_map(|matte| matte.alpha.iter().copied())
        .collect::<Vec<_>>();
    fs::write(&sequence_path, &sequence_bytes).map_err(|error| error.to_string())?;
    let mut receipts = Vec::with_capacity(mattes.len());
    let mut chatter_total = 0.0;
    for (index, matte) in mattes.iter().enumerate() {
        let alpha_path = request.output_dir.join(format!("frame-{index:06}.png"));
        write_alpha_png(&alpha_path, request.width, request.height, &matte.alpha)?;
        let chatter = if index == 0 {
            0.0
        } else {
            boundary_chatter(&mattes[index - 1], matte)?
        };
        chatter_total += chatter;
        receipts.push(AutoRotoFrameReceipt {
            frame: index,
            time: index as f64 / request.analysis_fps,
            alpha_path,
            confidence: matte.confidence,
            foreground_ratio: matte.alpha.iter().filter(|value| **value >= 128).count() as f64
                / matte.alpha.len() as f64,
            boundary_chatter: chatter,
        });
    }
    let receipt = AutoRotoReceipt {
        schema: "editkin.auto-roto-matte/v1",
        engine: if research_session.is_some() {
            #[cfg(feature = "auto-roto-research-onnx")]
            {
                "editkin-native-onnx-assisted-roto/v1"
            }
            #[cfg(not(feature = "auto-roto-research-onnx"))]
            {
                unreachable!("research session cannot exist in a product build")
            }
        } else {
            "editkin-native-color-temporal-roto/v1"
        }
        .into(),
        width: request.width,
        height: request.height,
        analysis_fps: request.analysis_fps,
        initial_frame: request.initial_frame,
        sequence_path,
        mean_boundary_chatter: chatter_total / mattes.len().max(1) as f64,
        correction_strokes_applied: request.corrections.len(),
        corrected_frames: corrected_frame_indices(&request.corrections),
        alpha_refinement: aggregate_alpha_refinements(&refinement_frames)?,
        region_memory,
        region_memory_routing,
        #[cfg(feature = "auto-roto-research-onnx")]
        onnx_model: research_session.as_ref().map(OnnxRotoSession::receipt),
        frames: receipts,
        frozen: true,
    };
    let manifest_path = request.output_dir.join("matte-manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&receipt).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(not(feature = "auto-roto-research-onnx"))]
    #[test]
    fn product_request_rejects_research_model_fields_instead_of_silently_ignoring_them() {
        let error = serde_json::from_value::<AutoRotoRequest>(json!({
            "rawPath": "frames.rgb24",
            "outputDir": "matte-output",
            "width": 32,
            "height": 24,
            "frameCount": 1,
            "analysisFps": 12.0,
            "initialFrame": 0,
            "initialRect": { "x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6 },
            "onnxPack": null
        }))
        .expect_err("product request must reject research-only fields");
        assert!(error.to_string().contains("unknown field `onnxPack`"));
    }

    #[test]
    fn segments_a_moving_colored_subject_into_pixel_mattes() {
        let width = 32;
        let height = 24;
        let frames = 6;
        let mut bytes = vec![20_u8; width * height * frames * 3];
        for frame in 0..frames {
            for y in 8..16 {
                for x in 6 + frame..14 + frame {
                    let offset = (frame * width * height + y * width + x) * 3;
                    bytes[offset] = 220;
                    bytes[offset + 1] = 60;
                    bytes[offset + 2] = 50;
                }
            }
        }
        let mattes = segment_rgb_sequence(
            &bytes,
            width,
            height,
            frames,
            0,
            RotoRect {
                x: 5.0 / width as f64,
                y: 7.0 / height as f64,
                width: 10.0 / width as f64,
                height: 10.0 / height as f64,
            },
            0.15,
            0.01,
            0.0,
            1.7,
            &[],
        )
        .unwrap();
        assert_eq!(mattes.len(), frames);
        for matte in mattes {
            assert!(matte.alpha.iter().filter(|value| **value >= 128).count() >= 40);
        }
    }

    #[test]
    fn public_color_route_defaults_to_the_frozen_baseline() {
        let width = 32;
        let height = 24;
        let frames = 3;
        let mut bytes = vec![20_u8; width * height * frames * 3];
        for frame in 0..frames {
            for y in 7..17 {
                for x in 7 + frame..19 + frame {
                    let offset = (frame * width * height + y * width + x) * 3;
                    bytes[offset..offset + 3].copy_from_slice(&[220, 60, 50]);
                }
            }
        }
        let rect = RotoRect {
            x: 6.0 / width as f64,
            y: 6.0 / height as f64,
            width: 15.0 / width as f64,
            height: 13.0 / height as f64,
        };
        let product = segment_rgb_sequence(
            &bytes,
            width,
            height,
            frames,
            0,
            rect,
            0.2,
            0.01,
            0.0,
            1.7,
            &[],
        )
        .unwrap();
        let baseline = segment_rgb_sequence_fixed_initial_frame_baseline(
            &bytes,
            width,
            height,
            frames,
            0,
            rect,
            0.2,
            0.01,
            0.0,
            1.7,
            &[],
        )
        .unwrap();
        assert!(
            product
                .iter()
                .zip(baseline)
                .all(|(left, right)| left.alpha == right.alpha)
        );
    }

    #[test]
    fn fixed_product_route_streams_frames_and_matches_the_frozen_in_memory_baseline() {
        let width = 32;
        let height = 24;
        let frames = 5;
        let initial_frame = 2;
        let mut bytes = vec![20_u8; width * height * frames * 3];
        for frame in 0..frames {
            for y in 7..17 {
                for x in 6 + frame..18 + frame {
                    let offset = (frame * width * height + y * width + x) * 3;
                    bytes[offset..offset + 3].copy_from_slice(&[220, 60, 50]);
                }
            }
        }
        let rect = RotoRect {
            x: 7.0 / width as f64,
            y: 6.0 / height as f64,
            width: 15.0 / width as f64,
            height: 13.0 / height as f64,
        };
        let baseline = segment_rgb_sequence_fixed_initial_frame_baseline(
            &bytes,
            width,
            height,
            frames,
            initial_frame,
            rect,
            0.2,
            0.02,
            0.0,
            1.7,
            &[],
        )
        .unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "editkin-streamed-auto-roto-{}-{nonce}",
            std::process::id()
        ));
        let raw_path = root.join("frames.rgb24");
        let output_dir = root.join("output");
        fs::create_dir_all(&root).unwrap();
        fs::write(&raw_path, &bytes).unwrap();
        let receipt = run_auto_roto(AutoRotoRequest {
            raw_path,
            output_dir: output_dir.clone(),
            width,
            height,
            frame_count: frames,
            analysis_fps: 12.0,
            initial_frame,
            initial_rect: rect,
            temporal_stability: 0.2,
            feather: 0.02,
            edge_shift: 0.0,
            contrast: 1.7,
            corrections: vec![],
            #[cfg(feature = "auto-roto-research-onnx")]
            onnx_pack: None,
            region_memory_policy: RegionMemoryRoutePolicy::FixedBaseline,
        })
        .unwrap();
        let sequence = fs::read(&receipt.sequence_path).unwrap();
        let expected = baseline
            .iter()
            .flat_map(|matte| matte.alpha.iter().copied())
            .collect::<Vec<_>>();
        assert_eq!(sequence, expected);
        assert_eq!(receipt.frames.len(), frames);
        assert_eq!(receipt.frames[0].boundary_chatter, 0.0);
        assert!(
            receipt
                .frames
                .iter()
                .all(|frame| frame.alpha_path.is_file())
        );
        assert_eq!(receipt.region_memory_routing.executed, "fixed_baseline");
        assert!(receipt.region_memory.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_layout_budget_rejects_unbounded_frame_and_alpha_counts_without_allocating() {
        assert!(validated_auto_roto_layout(480, 270, MAX_AUTO_ROTO_FRAME_COUNT + 1, 0, 0).is_err());
        let frames_over_alpha_budget = MAX_AUTO_ROTO_ALPHA_BYTES / (480 * 270) + 1;
        let raw_bytes = (480_u64 * 270 * 3) * frames_over_alpha_budget as u64;
        assert!(
            validated_auto_roto_layout(480, 270, frames_over_alpha_budget, 0, raw_bytes).is_err()
        );
        assert!(validated_auto_roto_layout(16_384, 16, 1, 0, 16_384 * 16 * 3).is_err());
    }

    #[test]
    fn guarded_candidate_failure_deterministically_falls_back() {
        let first = guarded_candidate_or_fallback::<u32, _, _>(
            || Err("candidate-fixture-failure".into()),
            || Ok(7),
        )
        .unwrap();
        let second = guarded_candidate_or_fallback::<u32, _, _>(
            || Err("candidate-fixture-failure".into()),
            || Ok(7),
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first,
            (
                7,
                true,
                Some("candidate-error:candidate-fixture-failure".into())
            )
        );
    }

    #[test]
    fn native_receipt_binds_self_authored_optical_alpha_refinement() {
        let width = 32;
        let height = 24;
        let frames = 3;
        let mut bytes = vec![20_u8; width * height * frames * 3];
        for frame in 0..frames {
            for y in 7..17 {
                for x in 7 + frame..19 + frame {
                    let offset = (frame * width * height + y * width + x) * 3;
                    bytes[offset] = 220;
                    bytes[offset + 1] = 60;
                    bytes[offset + 2] = 50;
                }
            }
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "editkin-optical-alpha-receipt-{}-{nonce}",
            std::process::id()
        ));
        let raw_path = root.join("frames.rgb24");
        let output_dir = root.join("output");
        fs::create_dir_all(&root).unwrap();
        fs::write(&raw_path, bytes).unwrap();
        let receipt = run_auto_roto(AutoRotoRequest {
            raw_path,
            output_dir: output_dir.clone(),
            width,
            height,
            frame_count: frames,
            analysis_fps: 12.0,
            initial_frame: 0,
            initial_rect: RotoRect {
                x: 6.0 / width as f64,
                y: 6.0 / height as f64,
                width: 15.0 / width as f64,
                height: 13.0 / height as f64,
            },
            temporal_stability: 0.2,
            feather: 0.02,
            edge_shift: 0.0,
            contrast: 1.7,
            corrections: vec![],
            #[cfg(feature = "auto-roto-research-onnx")]
            onnx_pack: None,
            region_memory_policy: RegionMemoryRoutePolicy::GuardedExperimental,
        })
        .unwrap();
        assert_eq!(receipt.alpha_refinement.engine, OPTICAL_ALPHA_ENGINE);
        assert_eq!(
            receipt.region_memory_routing.executed,
            "guarded_experimental"
        );
        assert!(receipt.region_memory_routing.candidate_attempted);
        assert!(!receipt.region_memory_routing.deterministic_fallback);
        assert_eq!(
            receipt.region_memory.as_ref().map(|item| item.engine),
            Some(crate::engine::region_memory_roto::REGION_MEMORY_ROTO_ENGINE)
        );
        assert_eq!(receipt.alpha_refinement.applied_frames, frames);
        assert!(
            receipt.alpha_refinement.fractional_pixels >= receipt.alpha_refinement.solved_pixels
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(output_dir.join("matte-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(
            manifest["alphaRefinement"]["engine"],
            serde_json::Value::String(OPTICAL_ALPHA_ENGINE.into())
        );
        assert_eq!(
            manifest["regionMemory"]["engine"],
            serde_json::Value::String(
                crate::engine::region_memory_roto::REGION_MEMORY_ROTO_ENGINE.into(),
            )
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn applies_foreground_and_background_brushes_before_temporal_propagation() {
        let width = 32;
        let height = 24;
        let frames = 4;
        let mut bytes = vec![20_u8; width * height * frames * 3];
        for frame in 0..frames {
            for y in 7..17 {
                for x in 8..20 {
                    let offset = (frame * width * height + y * width + x) * 3;
                    bytes[offset] = 220;
                    bytes[offset + 1] = 60;
                    bytes[offset + 2] = 50;
                }
            }
        }
        let baseline = segment_rgb_sequence(
            &bytes,
            width,
            height,
            frames,
            0,
            RotoRect {
                x: 7.0 / width as f64,
                y: 6.0 / height as f64,
                width: 14.0 / width as f64,
                height: 12.0 / height as f64,
            },
            0.45,
            0.0,
            0.0,
            1.7,
            &[],
        )
        .unwrap();
        let corrected = segment_rgb_sequence(
            &bytes,
            width,
            height,
            frames,
            0,
            RotoRect {
                x: 7.0 / width as f64,
                y: 6.0 / height as f64,
                width: 14.0 / width as f64,
                height: 12.0 / height as f64,
            },
            0.45,
            0.0,
            0.0,
            1.7,
            &[
                RotoCorrectionStroke {
                    id: "remove-center".into(),
                    frame: 0,
                    mode: RotoCorrectionMode::Background,
                    radius: 0.12,
                    points: vec![RotoPoint { x: 0.44, y: 0.5 }],
                },
                RotoCorrectionStroke {
                    id: "keep-corner".into(),
                    frame: 1,
                    mode: RotoCorrectionMode::Foreground,
                    radius: 0.08,
                    points: vec![RotoPoint { x: 0.05, y: 0.05 }],
                },
            ],
        )
        .unwrap();
        let center = 12 * width + 14;
        let corner = width + 2;
        assert!(baseline[0].alpha[center] > 200);
        assert!(corrected[0].alpha[center] < 40);
        assert!(corrected[1].alpha[center] < baseline[1].alpha[center]);
        assert!(corrected[1].alpha[corner] > baseline[1].alpha[corner]);
    }
}

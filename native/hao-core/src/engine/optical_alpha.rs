use super::roto::MatteFrame;
use serde::Serialize;

pub const OPTICAL_ALPHA_ENGINE: &str = "editkin-self-authored-optical-alpha-refiner/v1";
pub const ADAPTIVE_OPTICAL_ALPHA_ENGINE: &str =
    "editkin-self-authored-adaptive-optical-alpha-refiner/v2";
pub const TEXTURE_AWARE_OPTICAL_ALPHA_ENGINE: &str =
    "editkin-self-authored-texture-aware-optical-alpha-refiner/v3";

#[derive(Clone, Copy, Debug)]
pub struct OpticalAlphaSettings {
    pub radius: u32,
    pub background_threshold: f32,
    pub foreground_threshold: f32,
    pub coarse_weight: f32,
    pub temporal_stability: f32,
    pub temporal_gate: f32,
}

impl Default for OpticalAlphaSettings {
    fn default() -> Self {
        Self {
            radius: 8,
            background_threshold: 0.08,
            foreground_threshold: 0.92,
            coarse_weight: 0.2,
            temporal_stability: 0.15,
            temporal_gate: 0.18,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpticalAlphaReceipt {
    pub schema: &'static str,
    pub engine: &'static str,
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

#[derive(Clone, Debug)]
pub struct OpticalAlphaResult {
    pub matte: MatteFrame,
    pub receipt: OpticalAlphaReceipt,
}

#[derive(Clone)]
struct IntegralPlane {
    stride: usize,
    values: Vec<f64>,
}

impl IntegralPlane {
    fn from_samples(width: usize, height: usize, samples: impl Fn(usize) -> f64) -> Self {
        let stride = width + 1;
        let mut values = vec![0.0_f64; stride * (height + 1)];
        for y in 0..height {
            let mut row = 0.0_f64;
            for x in 0..width {
                row += samples(y * width + x);
                values[(y + 1) * stride + x + 1] = values[y * stride + x + 1] + row;
            }
        }
        Self { stride, values }
    }

    fn sum(&self, left: usize, top: usize, right: usize, bottom: usize) -> f64 {
        self.values[(bottom + 1) * self.stride + right + 1]
            - self.values[top * self.stride + right + 1]
            - self.values[(bottom + 1) * self.stride + left]
            + self.values[top * self.stride + left]
    }
}

fn smoothstep(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn validate_settings(settings: OpticalAlphaSettings) -> Result<(), String> {
    if settings.radius == 0
        || settings.radius > 64
        || !settings.background_threshold.is_finite()
        || !settings.foreground_threshold.is_finite()
        || settings.background_threshold < 0.0
        || settings.foreground_threshold > 1.0
        || settings.background_threshold + 0.05 >= settings.foreground_threshold
        || !settings.coarse_weight.is_finite()
        || !(0.0..=1.0).contains(&settings.coarse_weight)
        || !settings.temporal_stability.is_finite()
        || !(0.0..=1.0).contains(&settings.temporal_stability)
        || !settings.temporal_gate.is_finite()
        || !(0.0..=1.0).contains(&settings.temporal_gate)
    {
        return Err("invalid optical alpha settings".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalSolveStrategy {
    FrozenFixedWindow,
    AdaptiveColorLine,
    GuardedTextureAware,
}

#[derive(Clone, Copy, Debug)]
struct LocalAlphaSolve {
    score: f32,
    alpha: f32,
    confidence: f32,
    residual: f32,
    radius: usize,
}

/// Refines only the uncertain trimap band. Definite foreground/background pixels stay byte-exact.
/// The implementation uses the compositing equation C = aF + (1-a)B with local foreground and
/// background color estimates. It is a deterministic Editkin reference path, not a learned model.
pub fn refine_optical_alpha(
    rgb: &[u8],
    coarse: &MatteFrame,
    previous: Option<&MatteFrame>,
    settings: OpticalAlphaSettings,
) -> Result<OpticalAlphaResult, String> {
    refine_optical_alpha_with_strategy(
        rgb,
        coarse,
        previous,
        settings,
        LocalSolveStrategy::FrozenFixedWindow,
    )
}

/// Experimental self-authored successor to [`refine_optical_alpha`].  It evaluates a bounded
/// three-level local color-line pyramid and selects the most local reconstruction that still has
/// trustworthy foreground/background support.  The frozen v1 path remains available as the
/// comparison and product fallback until a blind holdout promotes this candidate.
pub fn refine_adaptive_optical_alpha(
    rgb: &[u8],
    coarse: &MatteFrame,
    previous: Option<&MatteFrame>,
    settings: OpticalAlphaSettings,
) -> Result<OpticalAlphaResult, String> {
    refine_optical_alpha_with_strategy(
        rgb,
        coarse,
        previous,
        settings,
        LocalSolveStrategy::AdaptiveColorLine,
    )
}

/// Prospectively frozen v3 diagnostic candidate. It retains the v1 full-window solve as an exact
/// fallback and admits a more local color line only when reconstruction residual and support both
/// improve by a bounded margin. This is not the product route until its separate evidence gates
/// pass.
pub fn refine_texture_aware_optical_alpha(
    rgb: &[u8],
    coarse: &MatteFrame,
    previous: Option<&MatteFrame>,
    settings: OpticalAlphaSettings,
) -> Result<OpticalAlphaResult, String> {
    refine_optical_alpha_with_strategy(
        rgb,
        coarse,
        previous,
        settings,
        LocalSolveStrategy::GuardedTextureAware,
    )
}

fn refine_optical_alpha_with_strategy(
    rgb: &[u8],
    coarse: &MatteFrame,
    previous: Option<&MatteFrame>,
    settings: OpticalAlphaSettings,
    strategy: LocalSolveStrategy,
) -> Result<OpticalAlphaResult, String> {
    coarse.validate()?;
    validate_settings(settings)?;
    let width = coarse.width as usize;
    let height = coarse.height as usize;
    let pixels = width
        .checked_mul(height)
        .ok_or("optical alpha size overflow")?;
    if rgb.len()
        != pixels
            .checked_mul(3)
            .ok_or("optical alpha RGB size overflow")?
    {
        return Err("optical alpha RGB dimensions differ".into());
    }
    if let Some(previous) = previous {
        previous.validate()?;
        if previous.width != coarse.width || previous.height != coarse.height {
            return Err("optical alpha temporal dimensions differ".into());
        }
    }

    let background_threshold = settings.background_threshold;
    let foreground_threshold = settings.foreground_threshold;
    let foreground_weight = |index: usize| {
        let alpha = coarse.alpha[index] as f32 / 255.0;
        if alpha < foreground_threshold {
            0.0
        } else {
            smoothstep((alpha - foreground_threshold) / (1.0 - foreground_threshold).max(1e-6))
                as f64
        }
    };
    let background_weight = |index: usize| {
        let alpha = coarse.alpha[index] as f32 / 255.0;
        if alpha > background_threshold {
            0.0
        } else {
            smoothstep((background_threshold - alpha) / background_threshold.max(1e-6)) as f64
        }
    };
    let foreground_weights = IntegralPlane::from_samples(width, height, foreground_weight);
    let background_weights = IntegralPlane::from_samples(width, height, background_weight);
    let foreground_channels: Vec<_> = (0..3)
        .map(|channel| {
            IntegralPlane::from_samples(width, height, |index| {
                foreground_weight(index) * rgb[index * 3 + channel] as f64
            })
        })
        .collect();
    let background_channels: Vec<_> = (0..3)
        .map(|channel| {
            IntegralPlane::from_samples(width, height, |index| {
                background_weight(index) * rgb[index * 3 + channel] as f64
            })
        })
        .collect();

    let radius = settings.radius as usize;
    let mut alpha = coarse.alpha.clone();
    let mut changed_pixels = 0_usize;
    let mut fractional_pixels = 0_usize;
    let mut solved_pixels = 0_usize;
    let mut confidence_total = 0.0_f32;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let coarse_alpha = coarse.alpha[index] as f32 / 255.0;
            if coarse_alpha <= background_threshold || coarse_alpha >= foreground_threshold {
                continue;
            }
            fractional_pixels += 1;
            let observed = [
                rgb[index * 3] as f32,
                rgb[index * 3 + 1] as f32,
                rgb[index * 3 + 2] as f32,
            ];
            let radii = match strategy {
                LocalSolveStrategy::FrozenFixedWindow => [radius, radius, radius],
                LocalSolveStrategy::AdaptiveColorLine | LocalSolveStrategy::GuardedTextureAware => {
                    [
                        (radius / 4).max(2).min(radius),
                        (radius / 2).max(2).min(radius),
                        radius,
                    ]
                }
            };
            let mut best: Option<LocalAlphaSolve> = None;
            let mut fixed: Option<LocalAlphaSolve> = None;
            let mut previous_radius = usize::MAX;
            for local_radius in radii {
                if local_radius == previous_radius {
                    continue;
                }
                previous_radius = local_radius;
                let left = x.saturating_sub(local_radius);
                let right = (x + local_radius).min(width - 1);
                let top = y.saturating_sub(local_radius);
                let bottom = (y + local_radius).min(height - 1);
                let foreground_sum = foreground_weights.sum(left, top, right, bottom);
                let background_sum = background_weights.sum(left, top, right, bottom);
                if foreground_sum < 0.5 || background_sum < 0.5 {
                    continue;
                }
                let mut foreground = [0.0_f32; 3];
                let mut background = [0.0_f32; 3];
                for channel in 0..3 {
                    foreground[channel] = (foreground_channels[channel]
                        .sum(left, top, right, bottom)
                        / foreground_sum) as f32;
                    background[channel] = (background_channels[channel]
                        .sum(left, top, right, bottom)
                        / background_sum) as f32;
                }
                let direction = [
                    foreground[0] - background[0],
                    foreground[1] - background[1],
                    foreground[2] - background[2],
                ];
                let denominator = direction.iter().map(|value| value * value).sum::<f32>();
                if denominator < 16.0 {
                    continue;
                }
                let solved = ((observed[0] - background[0]) * direction[0]
                    + (observed[1] - background[1]) * direction[1]
                    + (observed[2] - background[2]) * direction[2])
                    / denominator;
                let clamped = solved.clamp(0.0, 1.0);
                let window_samples = ((right - left + 1) * (bottom - top + 1)) as f32;
                let support_confidence = ((foreground_sum.min(background_sum) as f32)
                    / (window_samples * 0.04).max(1.0))
                .clamp(0.0, 1.0);
                let separation_confidence = (denominator.sqrt() / 96.0).clamp(0.0, 1.0);
                let base_confidence = support_confidence * separation_confidence;
                let residual = ((0..3)
                    .map(|channel| {
                        let reconstructed = background[channel] + clamped * direction[channel];
                        (observed[channel] - reconstructed).powi(2)
                    })
                    .sum::<f32>()
                    / 3.0)
                    .sqrt();
                let mut confidence = base_confidence;
                let score = if strategy != LocalSolveStrategy::FrozenFixedWindow {
                    let reconstruction_confidence = (1.0 - residual / 48.0).clamp(0.0, 1.0);
                    confidence *= reconstruction_confidence;
                    let locality = 1.0 - local_radius as f32 / radius.max(1) as f32;
                    confidence + locality * 0.01
                } else {
                    confidence
                };
                let candidate = LocalAlphaSolve {
                    score,
                    alpha: clamped,
                    confidence,
                    residual,
                    radius: local_radius,
                };
                if local_radius == radius {
                    fixed = Some(LocalAlphaSolve {
                        score: base_confidence,
                        confidence: base_confidence,
                        ..candidate
                    });
                }
                if best.is_none_or(|best| score > best.score) {
                    best = Some(candidate);
                }
            }
            let selected = if strategy == LocalSolveStrategy::GuardedTextureAware {
                match (best, fixed) {
                    (Some(local), Some(frozen))
                        if local.radius < frozen.radius
                            && local.residual <= frozen.residual
                            && local.confidence >= frozen.confidence * 0.82 =>
                    {
                        local
                    }
                    (_, Some(frozen)) => frozen,
                    (Some(local), None) => local,
                    (None, None) => continue,
                }
            } else if let Some(best) = best {
                best
            } else {
                continue;
            };
            let solved = selected.alpha;
            let confidence = selected.confidence;
            let optical_weight = (1.0 - settings.coarse_weight) * confidence;
            let mut refined =
                (coarse_alpha * (1.0 - optical_weight) + solved * optical_weight).clamp(0.0, 1.0);
            if let Some(previous) = previous {
                let prior = previous.alpha[index] as f32 / 255.0;
                if (prior - refined).abs() <= settings.temporal_gate {
                    refined = refined * (1.0 - settings.temporal_stability)
                        + prior * settings.temporal_stability;
                }
            }
            let encoded = (refined * 255.0).round() as u8;
            if encoded != coarse.alpha[index] {
                changed_pixels += 1;
            }
            alpha[index] = encoded;
            solved_pixels += 1;
            confidence_total += confidence;
        }
    }
    let matte = MatteFrame {
        frame: coarse.frame,
        width: coarse.width,
        height: coarse.height,
        alpha,
        confidence: coarse.confidence,
    };
    matte.validate()?;
    Ok(OpticalAlphaResult {
        matte,
        receipt: OpticalAlphaReceipt {
            schema: match strategy {
                LocalSolveStrategy::FrozenFixedWindow => {
                    "editkin.optical-alpha-refinement-receipt/v1"
                }
                LocalSolveStrategy::AdaptiveColorLine => {
                    "editkin.optical-alpha-refinement-receipt/v2"
                }
                LocalSolveStrategy::GuardedTextureAware => {
                    "editkin.optical-alpha-refinement-receipt/v3"
                }
            },
            engine: match strategy {
                LocalSolveStrategy::FrozenFixedWindow => OPTICAL_ALPHA_ENGINE,
                LocalSolveStrategy::AdaptiveColorLine => ADAPTIVE_OPTICAL_ALPHA_ENGINE,
                LocalSolveStrategy::GuardedTextureAware => TEXTURE_AWARE_OPTICAL_ALPHA_ENGINE,
            },
            radius: settings.radius,
            background_threshold: settings.background_threshold,
            foreground_threshold: settings.foreground_threshold,
            coarse_weight: settings.coarse_weight,
            temporal_stability: settings.temporal_stability,
            temporal_gate: settings.temporal_gate,
            changed_pixels,
            fractional_pixels,
            solved_pixels,
            mean_solve_confidence: if solved_pixels == 0 {
                0.0
            } else {
                confidence_total / solved_pixels as f32
            },
        },
    })
}

/// Recovers straight foreground RGB from a known background and fractional alpha. Pixels below
/// `minimum_alpha` are cleared because their foreground color is numerically undefined.
pub fn recover_straight_foreground(
    composite_rgb: &[u8],
    alpha: &[u8],
    background_rgb: [u8; 3],
    minimum_alpha: f32,
) -> Result<Vec<u8>, String> {
    if composite_rgb.len()
        != alpha
            .len()
            .checked_mul(3)
            .ok_or("foreground size overflow")?
        || !minimum_alpha.is_finite()
        || !(0.0..=1.0).contains(&minimum_alpha)
    {
        return Err("invalid foreground recovery input".into());
    }
    let mut foreground = vec![0_u8; composite_rgb.len()];
    for (index, encoded_alpha) in alpha.iter().enumerate() {
        let normalized_alpha = *encoded_alpha as f32 / 255.0;
        if normalized_alpha <= minimum_alpha {
            continue;
        }
        for channel in 0..3 {
            let composite = composite_rgb[index * 3 + channel] as f32;
            let background = background_rgb[channel] as f32;
            foreground[index * 3 + channel] = ((composite - (1.0 - normalized_alpha) * background)
                / normalized_alpha)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }
    Ok(foreground)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::roto::{MatteRefine, refine_matte};

    fn alpha_mad(left: &[u8], right: &[u8]) -> f64 {
        left.iter()
            .zip(right)
            .map(|(left, right)| (*left as f64 - *right as f64).abs() / 255.0)
            .sum::<f64>()
            / left.len() as f64
    }

    #[test]
    fn local_color_unmixing_beats_box_blur_on_fractional_composite_edge() {
        let width = 64_usize;
        let height = 24_usize;
        let foreground = [224_u8, 54, 36];
        let background = [22_u8, 116, 222];
        let mut truth = vec![0_u8; width * height];
        let mut coarse = vec![0_u8; width * height];
        let mut rgb = vec![0_u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                let alpha = if x < 22 {
                    0.0
                } else if x >= 34 {
                    1.0
                } else {
                    (x - 21) as f32 / 13.0
                };
                truth[index] = (alpha * 255.0).round() as u8;
                let biased = if alpha <= 0.0 || alpha >= 1.0 {
                    alpha
                } else {
                    (alpha * 0.66 + 0.17).clamp(0.0, 1.0)
                };
                coarse[index] = (biased * 255.0).round() as u8;
                for channel in 0..3 {
                    rgb[index * 3 + channel] = (alpha * foreground[channel] as f32
                        + (1.0 - alpha) * background[channel] as f32)
                        .round() as u8;
                }
            }
        }
        let frame = MatteFrame {
            frame: 0,
            width: width as u32,
            height: height as u32,
            alpha: coarse,
            confidence: 0.8,
        };
        let baseline = refine_matte(
            &frame,
            None,
            MatteRefine {
                radius: 2,
                contrast: 1.0,
                edge_shift: 0,
                temporal_stability: 0.0,
            },
        )
        .unwrap();
        let candidate = refine_optical_alpha(
            &rgb,
            &frame,
            None,
            OpticalAlphaSettings {
                radius: 16,
                coarse_weight: 0.05,
                temporal_stability: 0.0,
                ..OpticalAlphaSettings::default()
            },
        )
        .unwrap();
        let baseline_mad = alpha_mad(&baseline.alpha, &truth);
        let candidate_mad = alpha_mad(&candidate.matte.alpha, &truth);
        assert!(
            candidate_mad < baseline_mad * 0.8,
            "candidate {candidate_mad:.6} did not beat baseline {baseline_mad:.6}"
        );
        assert!(candidate.receipt.solved_pixels > 0);
        assert_eq!(&candidate.matte.alpha[..22], &truth[..22]);
    }

    #[test]
    fn adaptive_candidate_has_distinct_identity_and_is_deterministic() {
        let width = 40_usize;
        let height = 16_usize;
        let mut rgb = vec![0_u8; width * height * 3];
        let mut coarse = vec![0_u8; width * height];
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                let alpha = ((x as f32 - 12.0) / 14.0).clamp(0.0, 1.0);
                let biased = if alpha <= 0.0 || alpha >= 1.0 {
                    alpha
                } else {
                    (alpha * 0.62 + 0.19).clamp(0.0, 1.0)
                };
                coarse[index] = (biased * 255.0).round() as u8;
                let foreground = [220.0 - y as f32, 48.0 + y as f32, 32.0];
                let background = [22.0 + x as f32, 132.0 - x as f32, 210.0];
                for channel in 0..3 {
                    rgb[index * 3 + channel] = (alpha * foreground[channel]
                        + (1.0 - alpha) * background[channel])
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
        }
        let frame = MatteFrame {
            frame: 0,
            width: width as u32,
            height: height as u32,
            alpha: coarse,
            confidence: 0.8,
        };
        let settings = OpticalAlphaSettings {
            radius: 16,
            temporal_stability: 0.0,
            ..OpticalAlphaSettings::default()
        };
        let frozen = refine_optical_alpha(&rgb, &frame, None, settings).unwrap();
        let adaptive = refine_adaptive_optical_alpha(&rgb, &frame, None, settings).unwrap();
        let repeated = refine_adaptive_optical_alpha(&rgb, &frame, None, settings).unwrap();
        let texture_aware =
            refine_texture_aware_optical_alpha(&rgb, &frame, None, settings).unwrap();
        let texture_repeated =
            refine_texture_aware_optical_alpha(&rgb, &frame, None, settings).unwrap();
        assert_eq!(frozen.receipt.engine, OPTICAL_ALPHA_ENGINE);
        assert_eq!(
            frozen.receipt.schema,
            "editkin.optical-alpha-refinement-receipt/v1"
        );
        assert_eq!(adaptive.receipt.engine, ADAPTIVE_OPTICAL_ALPHA_ENGINE);
        assert_eq!(
            adaptive.receipt.schema,
            "editkin.optical-alpha-refinement-receipt/v2"
        );
        assert_eq!(adaptive.matte.alpha, repeated.matte.alpha);
        assert!(adaptive.receipt.solved_pixels > 0);
        assert_eq!(
            texture_aware.receipt.engine,
            TEXTURE_AWARE_OPTICAL_ALPHA_ENGINE
        );
        assert_eq!(
            texture_aware.receipt.schema,
            "editkin.optical-alpha-refinement-receipt/v3"
        );
        assert_eq!(texture_aware.matte.alpha, texture_repeated.matte.alpha);
        assert_eq!(
            texture_aware.receipt.solved_pixels,
            texture_aware.receipt.fractional_pixels
        );
    }

    #[test]
    fn temporal_gate_does_not_ghost_across_a_discontinuous_boundary() {
        let width = 8_u32;
        let height = 2_u32;
        let coarse = MatteFrame {
            frame: 1,
            width,
            height,
            alpha: vec![128; width as usize * height as usize],
            confidence: 1.0,
        };
        let previous = MatteFrame {
            frame: 0,
            width,
            height,
            alpha: vec![255; width as usize * height as usize],
            confidence: 1.0,
        };
        let mut rgb = vec![0_u8; coarse.alpha.len() * 3];
        for pixel in rgb.chunks_exact_mut(3) {
            pixel.copy_from_slice(&[128, 128, 128]);
        }
        let result = refine_optical_alpha(
            &rgb,
            &coarse,
            Some(&previous),
            OpticalAlphaSettings {
                radius: 2,
                temporal_stability: 1.0,
                temporal_gate: 0.1,
                ..OpticalAlphaSettings::default()
            },
        )
        .unwrap();
        assert!(result.matte.alpha.iter().all(|value| *value == 128));
    }

    #[test]
    fn straight_foreground_recovery_removes_known_background_contamination() {
        let foreground = [210_u8, 64, 32];
        let background = [16_u8, 180, 42];
        let alpha = [64_u8, 128, 192, 255];
        let mut composite = Vec::new();
        for encoded_alpha in alpha {
            let normalized = encoded_alpha as f32 / 255.0;
            for channel in 0..3 {
                composite.push(
                    (normalized * foreground[channel] as f32
                        + (1.0 - normalized) * background[channel] as f32)
                        .round() as u8,
                );
            }
        }
        let recovered = recover_straight_foreground(&composite, &alpha, background, 0.01).unwrap();
        for pixel in recovered.chunks_exact(3) {
            for channel in 0..3 {
                assert!((pixel[channel] as i16 - foreground[channel] as i16).abs() <= 2);
            }
        }
    }

    #[test]
    fn invalid_dimensions_and_settings_fail_closed() {
        let frame = MatteFrame {
            frame: 0,
            width: 2,
            height: 2,
            alpha: vec![0; 4],
            confidence: 1.0,
        };
        assert!(
            refine_optical_alpha(&[0; 3], &frame, None, OpticalAlphaSettings::default()).is_err()
        );
        assert!(
            refine_optical_alpha(
                &[0; 12],
                &frame,
                None,
                OpticalAlphaSettings {
                    radius: 0,
                    ..OpticalAlphaSettings::default()
                },
            )
            .is_err()
        );
        assert!(recover_straight_foreground(&[0; 3], &[255, 0], [0; 3], 0.01).is_err());
    }
}

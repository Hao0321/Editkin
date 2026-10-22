use hao_core::engine::optical_alpha::{
    OPTICAL_ALPHA_ENGINE, OpticalAlphaSettings, recover_straight_foreground, refine_optical_alpha,
};
use hao_core::engine::roto::{MatteFrame, MatteRefine, refine_matte};
use serde::Serialize;
use std::time::Instant;

const WIDTH: usize = 72;
const HEIGHT: usize = 32;
const FOREGROUND: [u8; 3] = [224, 54, 36];
const BACKGROUND: [u8; 3] = [22, 116, 222];

#[derive(Clone)]
struct Fixture {
    rgb: Vec<u8>,
    truth: Vec<u8>,
    coarse: MatteFrame,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema: &'static str,
    engine: &'static str,
    fixture_count: usize,
    baseline_alpha_mad: f64,
    candidate_alpha_mad: f64,
    baseline_edge_mad: f64,
    candidate_edge_mad: f64,
    baseline_foreground_rgb_mae: f64,
    candidate_foreground_rgb_mae: f64,
    baseline_composite_rgb_mae: f64,
    candidate_composite_rgb_mae: f64,
    baseline_temporal_dtssd: f64,
    candidate_temporal_dtssd: f64,
    known_core_max_error: f64,
    candidate_p95_ms: f64,
    solved_pixels: usize,
    fractional_pixels: usize,
}

fn fixture(edge: usize, frame: u64) -> Fixture {
    let mut rgb = vec![0_u8; WIDTH * HEIGHT * 3];
    let mut truth = vec![0_u8; WIDTH * HEIGHT];
    let mut coarse = vec![0_u8; WIDTH * HEIGHT];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let index = y * WIDTH + x;
            let edge_offset = if y % 7 == 0 {
                2
            } else if y % 5 == 0 {
                1
            } else {
                0
            };
            let left = edge + edge_offset;
            let alpha = if x < left {
                0.0
            } else if x >= left + 14 {
                1.0
            } else {
                (x - left + 1) as f32 / 15.0
            };
            truth[index] = (alpha * 255.0).round() as u8;
            let biased = if alpha <= 0.0 || alpha >= 1.0 {
                alpha
            } else {
                (alpha * 0.62 + 0.19).clamp(0.0, 1.0)
            };
            coarse[index] = (biased * 255.0).round() as u8;
            for channel in 0..3 {
                rgb[index * 3 + channel] = (alpha * FOREGROUND[channel] as f32
                    + (1.0 - alpha) * BACKGROUND[channel] as f32)
                    .round() as u8;
            }
        }
    }
    Fixture {
        rgb,
        truth,
        coarse: MatteFrame {
            frame,
            width: WIDTH as u32,
            height: HEIGHT as u32,
            alpha: coarse,
            confidence: 0.8,
        },
    }
}

fn alpha_mad(predicted: &[u8], truth: &[u8], edge_only: bool) -> f64 {
    let mut total = 0.0_f64;
    let mut samples = 0_usize;
    for (predicted, truth) in predicted.iter().zip(truth) {
        if edge_only && (*truth == 0 || *truth == 255) {
            continue;
        }
        total += (*predicted as f64 - *truth as f64).abs() / 255.0;
        samples += 1;
    }
    total / samples.max(1) as f64
}

fn rgb_mae(predicted: &[u8], truth: [u8; 3], alpha: &[u8]) -> f64 {
    let mut total = 0.0_f64;
    let mut samples = 0_usize;
    for (index, encoded_alpha) in alpha.iter().enumerate() {
        if *encoded_alpha < 32 {
            continue;
        }
        for channel in 0..3 {
            total += (predicted[index * 3 + channel] as f64 - truth[channel] as f64).abs() / 255.0;
            samples += 1;
        }
    }
    total / samples.max(1) as f64
}

fn composite_mae(foreground: &[u8], alpha: &[u8], observed: &[u8]) -> f64 {
    let mut total = 0.0_f64;
    for (index, encoded_alpha) in alpha.iter().enumerate() {
        let normalized = *encoded_alpha as f64 / 255.0;
        for channel in 0..3 {
            let recomposite = normalized * foreground[index * 3 + channel] as f64
                + (1.0 - normalized) * BACKGROUND[channel] as f64;
            total += (recomposite - observed[index * 3 + channel] as f64).abs() / 255.0;
        }
    }
    total / observed.len() as f64
}

fn temporal_dtssd(left: &[u8], right: &[u8], truth_left: &[u8], truth_right: &[u8]) -> f64 {
    left.iter()
        .zip(right)
        .zip(truth_left.iter().zip(truth_right))
        .map(|((left, right), (truth_left, truth_right))| {
            let predicted_delta = *right as f64 / 255.0 - *left as f64 / 255.0;
            let truth_delta = *truth_right as f64 / 255.0 - *truth_left as f64 / 255.0;
            (predicted_delta - truth_delta).powi(2)
        })
        .sum::<f64>()
        / left.len() as f64
}

fn baseline(fixture: &Fixture, previous: Option<&MatteFrame>) -> MatteFrame {
    refine_matte(
        &fixture.coarse,
        previous,
        MatteRefine {
            radius: 2,
            contrast: 1.0,
            edge_shift: 0,
            temporal_stability: 0.15,
        },
    )
    .expect("baseline refinement")
}

fn main() {
    let fixtures = [fixture(22, 0), fixture(24, 1), fixture(23, 2)];
    let settings = OpticalAlphaSettings {
        radius: 18,
        coarse_weight: 0.05,
        temporal_stability: 0.12,
        temporal_gate: 0.08,
        ..OpticalAlphaSettings::default()
    };
    let mut baselines = Vec::new();
    let mut candidates = Vec::new();
    let mut timings = Vec::new();
    let mut previous_baseline: Option<MatteFrame> = None;
    let mut previous_candidate: Option<MatteFrame> = None;
    let mut solved_pixels = 0_usize;
    let mut fractional_pixels = 0_usize;
    for fixture in &fixtures {
        let baseline = baseline(fixture, previous_baseline.as_ref());
        let started = Instant::now();
        let candidate = refine_optical_alpha(
            &fixture.rgb,
            &fixture.coarse,
            previous_candidate.as_ref(),
            settings,
        )
        .expect("candidate refinement");
        timings.push(started.elapsed().as_secs_f64() * 1000.0);
        solved_pixels += candidate.receipt.solved_pixels;
        fractional_pixels += candidate.receipt.fractional_pixels;
        previous_baseline = Some(baseline.clone());
        previous_candidate = Some(candidate.matte.clone());
        baselines.push(baseline);
        candidates.push(candidate.matte);
    }

    let baseline_alpha_mad = fixtures
        .iter()
        .zip(&baselines)
        .map(|(fixture, matte)| alpha_mad(&matte.alpha, &fixture.truth, false))
        .sum::<f64>()
        / fixtures.len() as f64;
    let candidate_alpha_mad = fixtures
        .iter()
        .zip(&candidates)
        .map(|(fixture, matte)| alpha_mad(&matte.alpha, &fixture.truth, false))
        .sum::<f64>()
        / fixtures.len() as f64;
    let baseline_edge_mad = fixtures
        .iter()
        .zip(&baselines)
        .map(|(fixture, matte)| alpha_mad(&matte.alpha, &fixture.truth, true))
        .sum::<f64>()
        / fixtures.len() as f64;
    let candidate_edge_mad = fixtures
        .iter()
        .zip(&candidates)
        .map(|(fixture, matte)| alpha_mad(&matte.alpha, &fixture.truth, true))
        .sum::<f64>()
        / fixtures.len() as f64;

    let mut baseline_foreground_rgb_mae = 0.0_f64;
    let mut candidate_foreground_rgb_mae = 0.0_f64;
    let mut baseline_composite_rgb_mae = 0.0_f64;
    let mut candidate_composite_rgb_mae = 0.0_f64;
    for ((fixture, baseline), candidate) in fixtures.iter().zip(&baselines).zip(&candidates) {
        let baseline_foreground =
            recover_straight_foreground(&fixture.rgb, &baseline.alpha, BACKGROUND, 0.02)
                .expect("baseline foreground");
        let candidate_foreground =
            recover_straight_foreground(&fixture.rgb, &candidate.alpha, BACKGROUND, 0.02)
                .expect("candidate foreground");
        baseline_foreground_rgb_mae += rgb_mae(&baseline_foreground, FOREGROUND, &fixture.truth);
        candidate_foreground_rgb_mae += rgb_mae(&candidate_foreground, FOREGROUND, &fixture.truth);
        baseline_composite_rgb_mae +=
            composite_mae(&baseline_foreground, &baseline.alpha, &fixture.rgb);
        candidate_composite_rgb_mae +=
            composite_mae(&candidate_foreground, &candidate.alpha, &fixture.rgb);
    }
    baseline_foreground_rgb_mae /= fixtures.len() as f64;
    candidate_foreground_rgb_mae /= fixtures.len() as f64;
    baseline_composite_rgb_mae /= fixtures.len() as f64;
    candidate_composite_rgb_mae /= fixtures.len() as f64;

    let baseline_temporal_dtssd = (0..fixtures.len() - 1)
        .map(|index| {
            temporal_dtssd(
                &baselines[index].alpha,
                &baselines[index + 1].alpha,
                &fixtures[index].truth,
                &fixtures[index + 1].truth,
            )
        })
        .sum::<f64>()
        / (fixtures.len() - 1) as f64;
    let candidate_temporal_dtssd = (0..fixtures.len() - 1)
        .map(|index| {
            temporal_dtssd(
                &candidates[index].alpha,
                &candidates[index + 1].alpha,
                &fixtures[index].truth,
                &fixtures[index + 1].truth,
            )
        })
        .sum::<f64>()
        / (fixtures.len() - 1) as f64;

    let mut known_core_max_error = 0.0_f64;
    for (fixture, candidate) in fixtures.iter().zip(&candidates) {
        for (truth, predicted) in fixture.truth.iter().zip(&candidate.alpha) {
            if *truth == 0 || *truth == 255 {
                known_core_max_error =
                    known_core_max_error.max((*truth as f64 - *predicted as f64).abs() / 255.0);
            }
        }
    }
    timings.sort_by(f64::total_cmp);
    let p95_index = ((timings.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(timings.len() - 1);
    let report = BenchmarkReport {
        schema: "editkin.optical-alpha-benchmark/v1",
        engine: OPTICAL_ALPHA_ENGINE,
        fixture_count: fixtures.len(),
        baseline_alpha_mad,
        candidate_alpha_mad,
        baseline_edge_mad,
        candidate_edge_mad,
        baseline_foreground_rgb_mae,
        candidate_foreground_rgb_mae,
        baseline_composite_rgb_mae,
        candidate_composite_rgb_mae,
        baseline_temporal_dtssd,
        candidate_temporal_dtssd,
        known_core_max_error,
        candidate_p95_ms: timings[p95_index],
        solved_pixels,
        fractional_pixels,
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("serialize report")
    );
}

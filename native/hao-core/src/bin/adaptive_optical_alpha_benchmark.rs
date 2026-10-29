use hao_core::engine::optical_alpha::{
    ADAPTIVE_OPTICAL_ALPHA_ENGINE, OpticalAlphaSettings, TEXTURE_AWARE_OPTICAL_ALPHA_ENGINE,
    refine_adaptive_optical_alpha, refine_optical_alpha, refine_texture_aware_optical_alpha,
};
use hao_core::engine::roto::MatteFrame;
use serde::Serialize;
use std::time::Instant;

const WIDTH: usize = 112;
const HEIGHT: usize = 56;

#[derive(Clone)]
struct Fixture {
    name: &'static str,
    rgb: Vec<u8>,
    truth: Vec<u8>,
    coarse: MatteFrame,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioMetric {
    name: &'static str,
    frozen_alpha_mad: f64,
    adaptive_alpha_mad: f64,
    frozen_edge_mad: f64,
    adaptive_edge_mad: f64,
    texture_aware_alpha_mad: f64,
    texture_aware_edge_mad: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema: &'static str,
    engine: &'static str,
    texture_aware_engine: &'static str,
    baseline_engine: &'static str,
    fixture_count: usize,
    frozen_alpha_mad: f64,
    adaptive_alpha_mad: f64,
    frozen_edge_mad: f64,
    adaptive_edge_mad: f64,
    adaptive_win_count: usize,
    texture_aware_alpha_mad: f64,
    texture_aware_edge_mad: f64,
    texture_aware_win_count: usize,
    known_core_max_error: f64,
    adaptive_solved_pixels: usize,
    adaptive_fractional_pixels: usize,
    frozen_p95_ms: f64,
    adaptive_p95_ms: f64,
    texture_aware_p95_ms: f64,
    deterministic: bool,
    texture_aware_deterministic: bool,
    texture_aware_solved_pixels: usize,
    texture_aware_fractional_pixels: usize,
    scenarios: Vec<ScenarioMetric>,
}

fn clamp_byte(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

fn smoothstep(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn colors(kind: usize, x: usize, y: usize) -> ([f32; 3], [f32; 3]) {
    let xf = x as f32 / (WIDTH - 1) as f32;
    let yf = y as f32 / (HEIGHT - 1) as f32;
    match kind {
        0 => (
            [224.0 - 74.0 * xf, 44.0 + 72.0 * yf, 38.0 + 34.0 * xf],
            [18.0 + 96.0 * xf, 152.0 - 82.0 * xf, 214.0 - 88.0 * yf],
        ),
        1 => {
            let tile = if (x / 7 + y / 6) % 2 == 0 {
                -28.0
            } else {
                28.0
            };
            (
                [206.0 - 38.0 * yf, 70.0 + 42.0 * xf, 42.0 + 18.0 * yf],
                [62.0 + tile, 132.0 - tile * 0.55, 188.0 + tile * 0.45],
            )
        }
        2 => {
            let stripe = ((x * 13 + y * 7) % 19) as f32 - 9.0;
            (
                [198.0 + stripe, 58.0 + 52.0 * yf, 76.0 - stripe * 0.4],
                [42.0 + 46.0 * xf - stripe, 124.0 + stripe, 174.0 - 58.0 * yf],
            )
        }
        3 => (
            [176.0 + 40.0 * yf, 88.0 - 34.0 * xf, 54.0 + 48.0 * xf],
            [72.0 + 52.0 * xf, 112.0 + 22.0 * yf, 146.0 - 36.0 * xf],
        ),
        _ => (
            [218.0 - 58.0 * xf, 52.0 + 56.0 * yf, 46.0 + 26.0 * xf],
            [30.0 + 76.0 * xf, 146.0 - 58.0 * yf, 204.0 - 62.0 * xf],
        ),
    }
}

fn alpha_for(kind: usize, x: usize, y: usize) -> f32 {
    let wave = ((y as f32 * 0.37).sin() * 4.0).round();
    let edge = 34.0 + wave + kind as f32 * 2.0;
    let ramp = match kind {
        2 => 24.0,
        3 => 12.0,
        _ => 18.0,
    };
    let mut alpha = smoothstep((x as f32 - edge) / ramp);
    if kind == 1 && x > 45 && x < 82 {
        let strand = ((x as i32 * 5 + y as i32 * 9) % 23).abs();
        if strand <= 1 {
            alpha = alpha.max(if strand == 0 { 0.72 } else { 0.38 });
        }
    }
    if kind == 3 {
        let center = 63.0 + (y as f32 * 0.24).sin() * 5.0;
        let distance = (x as f32 - center).abs();
        if distance < 18.0 {
            alpha = alpha.max((1.0 - distance / 18.0) * 0.74);
        }
    }
    alpha.clamp(0.0, 1.0)
}

fn fixture(kind: usize, frame: u64) -> Fixture {
    let names = [
        "spatial_gradient",
        "checker_hair",
        "textured_motion_blur",
        "semi_transparent_veil",
        "curved_color_drift",
    ];
    let mut rgb = vec![0_u8; WIDTH * HEIGHT * 3];
    let mut truth = vec![0_u8; WIDTH * HEIGHT];
    let mut coarse = vec![0_u8; WIDTH * HEIGHT];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let index = y * WIDTH + x;
            let alpha = alpha_for(kind, x, y);
            truth[index] = clamp_byte(alpha * 255.0);
            let biased = if alpha <= 0.0 || alpha >= 1.0 {
                alpha
            } else {
                (alpha * (0.58 + kind as f32 * 0.025) + 0.19).clamp(0.0, 1.0)
            };
            coarse[index] = clamp_byte(biased * 255.0);
            let (foreground, background) = colors(kind, x, y);
            for channel in 0..3 {
                rgb[index * 3 + channel] =
                    clamp_byte(alpha * foreground[channel] + (1.0 - alpha) * background[channel]);
            }
        }
    }
    Fixture {
        name: names[kind],
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

fn mad(predicted: &[u8], truth: &[u8], edge_only: bool) -> f64 {
    let mut total = 0.0;
    let mut count = 0_usize;
    for (predicted, truth) in predicted.iter().zip(truth) {
        if edge_only && (*truth == 0 || *truth == 255) {
            continue;
        }
        total += (*predicted as f64 - *truth as f64).abs() / 255.0;
        count += 1;
    }
    total / count.max(1) as f64
}

fn p95(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let index = ((values.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1);
    values[index]
}

fn main() {
    let fixtures = (0..5)
        .map(|index| fixture(index, index as u64))
        .collect::<Vec<_>>();
    let settings = OpticalAlphaSettings {
        radius: 24,
        coarse_weight: 0.08,
        temporal_stability: 0.0,
        temporal_gate: 0.08,
        ..OpticalAlphaSettings::default()
    };
    let mut frozen_time = Vec::new();
    let mut adaptive_time = Vec::new();
    let mut texture_aware_time = Vec::new();
    let mut metrics = Vec::new();
    let mut adaptive_solved_pixels = 0;
    let mut adaptive_fractional_pixels = 0;
    let mut texture_aware_solved_pixels = 0;
    let mut texture_aware_fractional_pixels = 0;
    let mut known_core_max_error = 0.0_f64;
    let mut deterministic = true;
    let mut texture_aware_deterministic = true;
    for fixture in &fixtures {
        let started = Instant::now();
        let frozen = refine_optical_alpha(&fixture.rgb, &fixture.coarse, None, settings)
            .expect("frozen optical alpha");
        frozen_time.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = Instant::now();
        let adaptive = refine_adaptive_optical_alpha(&fixture.rgb, &fixture.coarse, None, settings)
            .expect("adaptive optical alpha");
        adaptive_time.push(started.elapsed().as_secs_f64() * 1000.0);
        let repeat = refine_adaptive_optical_alpha(&fixture.rgb, &fixture.coarse, None, settings)
            .expect("adaptive deterministic repeat");
        deterministic &= repeat.matte.alpha == adaptive.matte.alpha;
        let started = Instant::now();
        let texture_aware =
            refine_texture_aware_optical_alpha(&fixture.rgb, &fixture.coarse, None, settings)
                .expect("texture-aware optical alpha");
        texture_aware_time.push(started.elapsed().as_secs_f64() * 1000.0);
        let texture_repeat =
            refine_texture_aware_optical_alpha(&fixture.rgb, &fixture.coarse, None, settings)
                .expect("texture-aware deterministic repeat");
        texture_aware_deterministic &= texture_repeat.matte.alpha == texture_aware.matte.alpha;
        adaptive_solved_pixels += adaptive.receipt.solved_pixels;
        adaptive_fractional_pixels += adaptive.receipt.fractional_pixels;
        texture_aware_solved_pixels += texture_aware.receipt.solved_pixels;
        texture_aware_fractional_pixels += texture_aware.receipt.fractional_pixels;
        for (truth, predicted) in fixture.truth.iter().zip(&texture_aware.matte.alpha) {
            if *truth == 0 || *truth == 255 {
                known_core_max_error =
                    known_core_max_error.max((*truth as f64 - *predicted as f64).abs() / 255.0);
            }
        }
        metrics.push(ScenarioMetric {
            name: fixture.name,
            frozen_alpha_mad: mad(&frozen.matte.alpha, &fixture.truth, false),
            adaptive_alpha_mad: mad(&adaptive.matte.alpha, &fixture.truth, false),
            frozen_edge_mad: mad(&frozen.matte.alpha, &fixture.truth, true),
            adaptive_edge_mad: mad(&adaptive.matte.alpha, &fixture.truth, true),
            texture_aware_alpha_mad: mad(&texture_aware.matte.alpha, &fixture.truth, false),
            texture_aware_edge_mad: mad(&texture_aware.matte.alpha, &fixture.truth, true),
        });
    }
    let mean = |values: Vec<f64>| values.iter().sum::<f64>() / values.len() as f64;
    let report = Report {
        schema: "editkin.adaptive-optical-alpha-hardcase-benchmark/v1",
        engine: ADAPTIVE_OPTICAL_ALPHA_ENGINE,
        texture_aware_engine: TEXTURE_AWARE_OPTICAL_ALPHA_ENGINE,
        baseline_engine: "editkin-self-authored-optical-alpha-refiner/v1",
        fixture_count: fixtures.len(),
        frozen_alpha_mad: mean(
            metrics
                .iter()
                .map(|metric| metric.frozen_alpha_mad)
                .collect(),
        ),
        adaptive_alpha_mad: mean(
            metrics
                .iter()
                .map(|metric| metric.adaptive_alpha_mad)
                .collect(),
        ),
        frozen_edge_mad: mean(
            metrics
                .iter()
                .map(|metric| metric.frozen_edge_mad)
                .collect(),
        ),
        adaptive_edge_mad: mean(
            metrics
                .iter()
                .map(|metric| metric.adaptive_edge_mad)
                .collect(),
        ),
        adaptive_win_count: metrics
            .iter()
            .filter(|metric| metric.adaptive_edge_mad < metric.frozen_edge_mad)
            .count(),
        texture_aware_alpha_mad: mean(
            metrics
                .iter()
                .map(|metric| metric.texture_aware_alpha_mad)
                .collect(),
        ),
        texture_aware_edge_mad: mean(
            metrics
                .iter()
                .map(|metric| metric.texture_aware_edge_mad)
                .collect(),
        ),
        texture_aware_win_count: metrics
            .iter()
            .filter(|metric| {
                metric.texture_aware_alpha_mad <= metric.frozen_alpha_mad
                    && metric.texture_aware_edge_mad <= metric.frozen_edge_mad
            })
            .count(),
        known_core_max_error,
        adaptive_solved_pixels,
        adaptive_fractional_pixels,
        frozen_p95_ms: p95(&mut frozen_time),
        adaptive_p95_ms: p95(&mut adaptive_time),
        texture_aware_p95_ms: p95(&mut texture_aware_time),
        deterministic,
        texture_aware_deterministic,
        texture_aware_solved_pixels,
        texture_aware_fractional_pixels,
        scenarios: metrics,
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("serialize report")
    );
}

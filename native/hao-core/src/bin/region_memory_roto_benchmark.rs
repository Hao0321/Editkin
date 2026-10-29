use hao_core::engine::auto_roto::{RotoRect, segment_rgb_sequence_fixed_initial_frame_baseline};
use hao_core::engine::region_memory_roto::{
    REGION_MEMORY_ROTO_ENGINE, RegionMemorySeedRect, RegionMemorySettings,
    RegionMemoryStateSnapshot, segment_region_memory_sequence, validate_region_memory_snapshot,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const WIDTH: usize = 96;
const HEIGHT: usize = 64;
#[derive(Clone)]
struct Fixture {
    name: &'static str,
    bytes: Vec<u8>,
    truth: Vec<Vec<u8>>,
    distractor_masks: Vec<Vec<u8>>,
    occlusion_frames: Vec<usize>,
    reappearance_frames: Vec<usize>,
    lighting_drift_frames: Vec<usize>,
    scene_cut_frames: Vec<usize>,
    seed: RegionMemorySeedRect,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioScore {
    name: &'static str,
    baseline_j: f64,
    candidate_j: f64,
    baseline_boundary_f: f64,
    candidate_boundary_f: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema: &'static str,
    engine: &'static str,
    dataset_id: String,
    fixture_count: usize,
    frame_count: usize,
    mean_j_baseline: f64,
    mean_j_candidate: f64,
    mean_boundary_f_baseline: f64,
    mean_boundary_f_candidate: f64,
    lighting_drift_j_baseline: f64,
    lighting_drift_j_candidate: f64,
    distractor_false_positive_rate_baseline: f64,
    distractor_false_positive_rate_candidate: f64,
    occlusion_leakage_candidate: f64,
    reappearance_j_candidate: f64,
    temporal_dtssd_baseline: f64,
    temporal_dtssd_candidate: f64,
    candidate_p95_ms_per_frame: f64,
    candidate_runtime_samples_ms_per_frame: Vec<f64>,
    performance_warmup_runs: usize,
    memory_updates: usize,
    full_occlusion_freezes: usize,
    scene_cut_freezes: usize,
    scene_cut_reseeds: usize,
    model_bounds_valid: bool,
    invalid_state_identity_rejected: bool,
    deterministic: bool,
    regression_count: usize,
    scenarios: Vec<ScenarioScore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenDatasetManifest {
    schema: String,
    dataset_id: String,
    width: usize,
    height: usize,
    frame_count: usize,
    scenarios: Vec<FrozenScenario>,
    files: Vec<FrozenFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrozenScenario {
    name: String,
    frame_offset: usize,
    frame_count: usize,
    seed: RegionMemorySeedRectSerde,
    occlusion_frames: Vec<usize>,
    reappearance_frames: Vec<usize>,
    lighting_drift_frames: Vec<usize>,
    scene_cut_frames: Vec<usize>,
}

#[derive(Deserialize)]
struct RegionMemorySeedRectSerde {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
struct FrozenFile {
    role: String,
    path: String,
}

fn dataset_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(".rd")
        .join("experiments")
        .join("self-authored-region-memory-roto-dataset")
}

fn load_fixtures() -> (String, Vec<Fixture>) {
    let root = dataset_root();
    let manifest: FrozenDatasetManifest = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).expect("read frozen region-memory dataset manifest"),
    )
    .expect("parse frozen region-memory dataset manifest");
    assert_eq!(manifest.schema, "editkin.region-memory-roto-dataset/v1");
    assert_eq!((manifest.width, manifest.height), (WIDTH, HEIGHT));
    let file = |role: &str| {
        manifest
            .files
            .iter()
            .find(|item| item.role == role)
            .map(|item| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join(&item.path)
            })
            .unwrap_or_else(|| panic!("missing frozen dataset role {role}"))
    };
    let rgb = fs::read(file("inputs")).expect("read frozen RGB inputs");
    let truth = fs::read(file("annotations")).expect("read frozen alpha annotations");
    let distractors = fs::read(file("distractors")).expect("read frozen distractor annotations");
    assert_eq!(rgb.len(), manifest.frame_count * WIDTH * HEIGHT * 3);
    assert_eq!(truth.len(), manifest.frame_count * WIDTH * HEIGHT);
    assert_eq!(distractors.len(), manifest.frame_count * WIDTH * HEIGHT);
    let fixtures = manifest
        .scenarios
        .into_iter()
        .map(|scenario| {
            let start_rgb = scenario.frame_offset * WIDTH * HEIGHT * 3;
            let end_rgb = (scenario.frame_offset + scenario.frame_count) * WIDTH * HEIGHT * 3;
            let start_alpha = scenario.frame_offset * WIDTH * HEIGHT;
            let end_alpha = (scenario.frame_offset + scenario.frame_count) * WIDTH * HEIGHT;
            let truth = truth[start_alpha..end_alpha]
                .chunks_exact(WIDTH * HEIGHT)
                .map(<[u8]>::to_vec)
                .collect();
            let distractor_masks = distractors[start_alpha..end_alpha]
                .chunks_exact(WIDTH * HEIGHT)
                .map(<[u8]>::to_vec)
                .collect();
            Fixture {
                name: Box::leak(scenario.name.into_boxed_str()),
                bytes: rgb[start_rgb..end_rgb].to_vec(),
                truth,
                distractor_masks,
                occlusion_frames: scenario.occlusion_frames,
                reappearance_frames: scenario.reappearance_frames,
                lighting_drift_frames: scenario.lighting_drift_frames,
                scene_cut_frames: scenario.scene_cut_frames,
                seed: RegionMemorySeedRect {
                    x: scenario.seed.x,
                    y: scenario.seed.y,
                    width: scenario.seed.width,
                    height: scenario.seed.height,
                },
            }
        })
        .collect();
    (manifest.dataset_id, fixtures)
}

fn jaccard(predicted: &[u8], truth: &[u8]) -> f64 {
    let mut intersection = 0_usize;
    let mut union = 0_usize;
    for (predicted, truth) in predicted.iter().zip(truth) {
        let predicted = *predicted >= 128;
        let truth = *truth >= 128;
        intersection += usize::from(predicted && truth);
        union += usize::from(predicted || truth);
    }
    if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    }
}

fn boundary(alpha: &[u8]) -> Vec<bool> {
    let mut output = vec![false; alpha.len()];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let value = alpha[y * WIDTH + x] >= 128;
            let neighbors = [
                (x > 0).then(|| (x - 1, y)),
                (x + 1 < WIDTH).then(|| (x + 1, y)),
                (y > 0).then(|| (x, y - 1)),
                (y + 1 < HEIGHT).then(|| (x, y + 1)),
            ];
            output[y * WIDTH + x] = neighbors
                .into_iter()
                .flatten()
                .any(|(sample_x, sample_y)| (alpha[sample_y * WIDTH + sample_x] >= 128) != value);
        }
    }
    output
}

fn boundary_match(source: &[bool], target: &[bool]) -> usize {
    let mut matched = 0_usize;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            if !source[y * WIDTH + x] {
                continue;
            }
            let left = x.saturating_sub(1);
            let right = (x + 1).min(WIDTH - 1);
            let top = y.saturating_sub(1);
            let bottom = (y + 1).min(HEIGHT - 1);
            if (top..=bottom)
                .any(|sample_y| (left..=right).any(|sample_x| target[sample_y * WIDTH + sample_x]))
            {
                matched += 1;
            }
        }
    }
    matched
}

fn boundary_f(predicted: &[u8], truth: &[u8]) -> f64 {
    let predicted = boundary(predicted);
    let truth = boundary(truth);
    let predicted_count = predicted.iter().filter(|value| **value).count();
    let truth_count = truth.iter().filter(|value| **value).count();
    if predicted_count == 0 && truth_count == 0 {
        return 1.0;
    }
    if predicted_count == 0 || truth_count == 0 {
        return 0.0;
    }
    let precision = boundary_match(&predicted, &truth) as f64 / predicted_count as f64;
    let recall = boundary_match(&truth, &predicted) as f64 / truth_count as f64;
    if precision + recall == 0.0 {
        0.0
    } else {
        2.0 * precision * recall / (precision + recall)
    }
}

fn temporal_dtssd(predicted: &[Vec<u8>], truth: &[Vec<u8>]) -> f64 {
    (0..predicted.len().saturating_sub(1))
        .map(|frame| {
            predicted[frame]
                .iter()
                .zip(&predicted[frame + 1])
                .zip(truth[frame].iter().zip(&truth[frame + 1]))
                .map(|((left, right), (truth_left, truth_right))| {
                    let predicted_delta = *right as f64 / 255.0 - *left as f64 / 255.0;
                    let truth_delta = *truth_right as f64 / 255.0 - *truth_left as f64 / 255.0;
                    (predicted_delta - truth_delta).powi(2)
                })
                .sum::<f64>()
                / predicted[frame].len() as f64
        })
        .sum::<f64>()
        / predicted.len().saturating_sub(1).max(1) as f64
}

fn main() {
    let (dataset_id, fixtures) = load_fixtures();
    let settings = RegionMemorySettings::default();
    let mut all_baseline_j = Vec::new();
    let mut all_candidate_j = Vec::new();
    let mut all_baseline_boundary = Vec::new();
    let mut all_candidate_boundary = Vec::new();
    let mut lighting_baseline = Vec::new();
    let mut lighting_candidate = Vec::new();
    let mut distractor_baseline_positive = 0_usize;
    let mut distractor_candidate_positive = 0_usize;
    let mut distractor_pixels = 0_usize;
    let mut occlusion_candidate_positive = 0_usize;
    let mut occlusion_reference_area = 0_usize;
    let mut reappearance_candidate = Vec::new();
    let mut memory_updates = 0_usize;
    let mut full_occlusion_freezes = 0_usize;
    let mut scene_cut_freezes = 0_usize;
    let mut scene_cut_reseeds = 0_usize;
    let mut model_bounds_valid = true;
    let mut scenarios = Vec::new();
    let mut temporal_baseline = 0.0_f64;
    let mut temporal_candidate = 0.0_f64;
    let mut deterministic = true;
    let mut regression_count = 0_usize;
    let mut total_frames = 0_usize;

    for fixture in &fixtures {
        let baseline = segment_rgb_sequence_fixed_initial_frame_baseline(
            &fixture.bytes,
            WIDTH,
            HEIGHT,
            fixture.truth.len(),
            0,
            RotoRect {
                x: fixture.seed.x,
                y: fixture.seed.y,
                width: fixture.seed.width,
                height: fixture.seed.height,
            },
            settings.temporal_stability,
            settings.feather,
            settings.edge_shift,
            settings.contrast,
            &[],
        )
        .expect("fixed initial-frame baseline");
        let candidate = segment_region_memory_sequence(
            &fixture.bytes,
            WIDTH,
            HEIGHT,
            fixture.truth.len(),
            0,
            fixture.seed,
            settings,
        )
        .expect("region-memory candidate");
        let repeated = segment_region_memory_sequence(
            &fixture.bytes,
            WIDTH,
            HEIGHT,
            fixture.truth.len(),
            0,
            fixture.seed,
            settings,
        )
        .expect("region-memory deterministic repeat");
        deterministic &= candidate
            .mattes
            .iter()
            .zip(&repeated.mattes)
            .all(|(left, right)| left.alpha == right.alpha);
        total_frames += fixture.truth.len();
        memory_updates += candidate.receipt.memory_updates;
        full_occlusion_freezes += candidate.receipt.full_occlusion_freezes;
        scene_cut_freezes += candidate.receipt.scene_cut_freezes;
        scene_cut_reseeds += candidate.receipt.scene_cut_reseeds;
        model_bounds_valid &= candidate.receipt.model_bounds_valid;

        let baseline_j = baseline
            .iter()
            .zip(&fixture.truth)
            .map(|(matte, truth)| jaccard(&matte.alpha, truth))
            .collect::<Vec<_>>();
        let candidate_j = candidate
            .mattes
            .iter()
            .zip(&fixture.truth)
            .map(|(matte, truth)| jaccard(&matte.alpha, truth))
            .collect::<Vec<_>>();
        let baseline_boundary = baseline
            .iter()
            .zip(&fixture.truth)
            .map(|(matte, truth)| boundary_f(&matte.alpha, truth))
            .collect::<Vec<_>>();
        let candidate_boundary = candidate
            .mattes
            .iter()
            .zip(&fixture.truth)
            .map(|(matte, truth)| boundary_f(&matte.alpha, truth))
            .collect::<Vec<_>>();
        let scenario = ScenarioScore {
            name: fixture.name,
            baseline_j: baseline_j.iter().sum::<f64>() / baseline_j.len() as f64,
            candidate_j: candidate_j.iter().sum::<f64>() / candidate_j.len() as f64,
            baseline_boundary_f: baseline_boundary.iter().sum::<f64>()
                / baseline_boundary.len() as f64,
            candidate_boundary_f: candidate_boundary.iter().sum::<f64>()
                / candidate_boundary.len() as f64,
        };
        if scenario.candidate_j + 1e-9 < scenario.baseline_j
            || scenario.candidate_boundary_f + 1e-9 < scenario.baseline_boundary_f
        {
            regression_count += 1;
        }
        scenarios.push(scenario);
        all_baseline_j.extend(&baseline_j);
        all_candidate_j.extend(&candidate_j);
        all_baseline_boundary.extend(&baseline_boundary);
        all_candidate_boundary.extend(&candidate_boundary);
        for frame in &fixture.lighting_drift_frames {
            lighting_baseline.push(baseline_j[*frame]);
            lighting_candidate.push(candidate_j[*frame]);
        }
        for frame in 0..fixture.truth.len() {
            for index in 0..WIDTH * HEIGHT {
                if fixture.distractor_masks[frame][index] >= 128 {
                    distractor_pixels += 1;
                    distractor_baseline_positive +=
                        usize::from(baseline[frame].alpha[index] >= 128);
                    distractor_candidate_positive +=
                        usize::from(candidate.mattes[frame].alpha[index] >= 128);
                }
            }
        }
        let reference_area = fixture
            .truth
            .iter()
            .map(|truth| truth.iter().filter(|value| **value >= 128).count())
            .max()
            .unwrap_or(1);
        for frame in &fixture.occlusion_frames {
            occlusion_reference_area += reference_area;
            occlusion_candidate_positive += candidate.mattes[*frame]
                .alpha
                .iter()
                .filter(|value| **value >= 128)
                .count();
        }
        for frame in &fixture.reappearance_frames {
            reappearance_candidate.push(candidate_j[*frame]);
        }
        if fixture.name == "temporal_stability" {
            let baseline_alpha = baseline
                .iter()
                .map(|matte| matte.alpha.clone())
                .collect::<Vec<_>>();
            let candidate_alpha = candidate
                .mattes
                .iter()
                .map(|matte| matte.alpha.clone())
                .collect::<Vec<_>>();
            temporal_baseline = temporal_dtssd(&baseline_alpha, &fixture.truth);
            temporal_candidate = temporal_dtssd(&candidate_alpha, &fixture.truth);
        }
        for frame in &fixture.scene_cut_frames {
            if candidate.receipt.frames[*frame].freeze_reason
                != hao_core::engine::region_memory_roto::RegionMemoryFreezeReason::SceneCutReseed
            {
                regression_count += 1;
            }
            if candidate.mattes[*frame]
                .alpha
                .iter()
                .all(|value| *value == 0)
            {
                regression_count += 1;
            }
        }
    }

    let performance_fixture = &fixtures[0];
    let performance_warmup_runs = 3;
    for _ in 0..performance_warmup_runs {
        segment_region_memory_sequence(
            &performance_fixture.bytes,
            WIDTH,
            HEIGHT,
            performance_fixture.truth.len(),
            0,
            performance_fixture.seed,
            settings,
        )
        .expect("performance warmup candidate");
    }
    let mut timings = Vec::new();
    for _ in 0..9 {
        let started = Instant::now();
        segment_region_memory_sequence(
            &performance_fixture.bytes,
            WIDTH,
            HEIGHT,
            performance_fixture.truth.len(),
            0,
            performance_fixture.seed,
            settings,
        )
        .expect("performance candidate");
        timings.push(
            started.elapsed().as_secs_f64() * 1000.0 / performance_fixture.truth.len() as f64,
        );
    }
    timings.sort_by(f64::total_cmp);
    let p95_index = ((timings.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(timings.len() - 1);
    let invalid_state_identity_rejected =
        validate_region_memory_snapshot(&RegionMemoryStateSnapshot {
            engine: "foreign-memory-state/v1".into(),
            width: WIDTH,
            height: HEIGHT,
            last_frame: 0,
            foreground_mean: [128.0; 3],
            foreground_variance: [64.0; 3],
            background_mean: [32.0; 3],
            background_variance: [64.0; 3],
        })
        .is_err();
    let report = BenchmarkReport {
        schema: "editkin.region-memory-roto-benchmark/v1",
        engine: REGION_MEMORY_ROTO_ENGINE,
        dataset_id,
        fixture_count: fixtures.len(),
        frame_count: total_frames,
        mean_j_baseline: all_baseline_j.iter().sum::<f64>() / all_baseline_j.len() as f64,
        mean_j_candidate: all_candidate_j.iter().sum::<f64>() / all_candidate_j.len() as f64,
        mean_boundary_f_baseline: all_baseline_boundary.iter().sum::<f64>()
            / all_baseline_boundary.len() as f64,
        mean_boundary_f_candidate: all_candidate_boundary.iter().sum::<f64>()
            / all_candidate_boundary.len() as f64,
        lighting_drift_j_baseline: lighting_baseline.iter().sum::<f64>()
            / lighting_baseline.len().max(1) as f64,
        lighting_drift_j_candidate: lighting_candidate.iter().sum::<f64>()
            / lighting_candidate.len().max(1) as f64,
        distractor_false_positive_rate_baseline: distractor_baseline_positive as f64
            / distractor_pixels.max(1) as f64,
        distractor_false_positive_rate_candidate: distractor_candidate_positive as f64
            / distractor_pixels.max(1) as f64,
        occlusion_leakage_candidate: occlusion_candidate_positive as f64
            / occlusion_reference_area.max(1) as f64,
        reappearance_j_candidate: reappearance_candidate.iter().sum::<f64>()
            / reappearance_candidate.len().max(1) as f64,
        temporal_dtssd_baseline: temporal_baseline,
        temporal_dtssd_candidate: temporal_candidate,
        candidate_p95_ms_per_frame: timings[p95_index],
        candidate_runtime_samples_ms_per_frame: timings,
        performance_warmup_runs,
        memory_updates,
        full_occlusion_freezes,
        scene_cut_freezes,
        scene_cut_reseeds,
        model_bounds_valid,
        invalid_state_identity_rejected,
        deterministic,
        regression_count,
        scenarios,
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("serialize benchmark")
    );
}

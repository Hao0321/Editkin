use super::*;

fn clicks(seconds: f64, bpm: f64, phase: f64, accent: bool, timbre_change: Option<f64>) -> Vec<f32> {
    let mut samples = vec![0.0; (seconds * SAMPLE_RATE as f64).round() as usize];
    let period = 60.0 / bpm;
    let mut beat = 0;
    while phase + beat as f64 * period < seconds {
        let at = ((phase + beat as f64 * period) * SAMPLE_RATE as f64).round() as usize;
        let amplitude = if accent && beat % 4 == 0 { 0.9 } else { 0.3 };
        let frequency = if timbre_change.is_some_and(|t| at as f64 / SAMPLE_RATE as f64 >= t) { 1600.0 } else { 180.0 };
        for n in 0..480.min(samples.len() - at) {
            samples[at + n] += (amplitude * (1.0 - n as f64 / 480.0)
                * (2.0 * std::f64::consts::PI * frequency * n as f64 / SAMPLE_RATE as f64).sin()) as f32;
        }
        beat += 1;
    }
    samples
}
fn analyze(samples: &[f32], prior: Option<f64>, block: usize, offset: f64) -> Analysis {
    let mut analyzer = BeatAnalyzer::new(prior, offset).unwrap();
    for part in samples.chunks(block) { analyzer.push(part).unwrap(); }
    analyzer.finish().unwrap()
}
// One-to-one matching catches missing and extra beats; unlike nearest-neighbor matching it cannot double-credit.
fn f_measure(measured: &[f64], reference: &[f64], tolerance: f64) -> f64 {
    let mut i = 0; let mut j = 0; let mut matched = 0;
    while i < measured.len() && j < reference.len() {
        if (measured[i] - reference[j]).abs() <= tolerance { matched += 1; i += 1; j += 1; }
        else if measured[i] < reference[j] { i += 1; } else { j += 1; }
    }
    if measured.is_empty() && reference.is_empty() { 1.0 } else { 2.0 * matched as f64 / (measured.len() + reference.len()) as f64 }
}
fn expected(seconds: f64, bpm: f64, phase: f64, every: usize) -> Vec<f64> {
    let mut times = Vec::new(); let mut beat = 0;
    while phase + beat as f64 * 60.0 / bpm < seconds { if beat % every == 0 { times.push(phase + beat as f64 * 60.0 / bpm); } beat += 1; }
    times
}

#[test]
fn evaluator_accepts_exact_grid_and_refuses_missing_extra_and_shifted_beats() {
    let truth = expected(24.0, 120.0, 0.13, 1);
    assert_eq!(f_measure(&truth, &truth, 0.07), 1.0);
    assert!(f_measure(&truth.iter().skip(12).copied().collect::<Vec<_>>(), &truth, 0.07) < 0.95);
    let mut extra = truth.clone(); extra.extend(truth.iter().map(|t| t + 0.2)); extra.sort_by(f64::total_cmp);
    assert!(f_measure(&extra, &truth, 0.07) < 0.95);
    assert_eq!(f_measure(&truth.iter().map(|t| t + 0.15).collect::<Vec<_>>(), &truth, 0.07), 0.0);
}
#[test]
fn fft_spectral_flux_and_dp_track_known_tempos_with_and_without_a_prior() {
    for bpm in [60.0, 90.0, 120.0, 180.0] {
        let samples = clicks(24.0, bpm, 0.13, true, None);
        for prior in [None, Some(bpm)] {
            let result = analyze(&samples, prior, 997, 0.0);
            let actual_bpm = result.tempo_bpm.expect("click rhythm must yield a tempo");
            assert!((actual_bpm - bpm).abs() <= 1.0, "bpm={bpm} prior={prior:?} actual={actual_bpm}");
            let times: Vec<_> = result.beats.iter().map(|b| b.time_seconds).collect();
            let measure = f_measure(&times, &expected(24.0, bpm, 0.13, 1), 0.07);
            assert!(measure >= 0.95, "bpm={bpm} prior={prior:?} f={measure} actual={times:?}");
            let down: Vec<_> = result.beats.iter().filter(|b| b.downbeat).map(|b| b.time_seconds).collect();
            assert!(f_measure(&down, &expected(24.0, bpm, 0.13, 4), 0.07) >= 0.85, "downbeats bpm={bpm} actual={down:?}");
        }
    }
}
#[test]
fn analysis_is_invariant_to_pcm_pipe_chunk_sizes() {
    let samples = clicks(16.0, 120.0, 0.13, true, None);
    let a = analyze(&samples, Some(120.0), 1, 0.0); let b = analyze(&samples, Some(120.0), 8192, 0.0);
    assert_eq!(serde_json::to_value(a).unwrap(), serde_json::to_value(b).unwrap());
}
#[test]
fn long_feature_chunk_boundaries_keep_a_single_global_beat_path() {
    let result = analyze(&clicks(132.0, 120.0, 0.13, true, None), Some(120.0), 8192, 0.0);
    assert!(result.peak_feature_frames <= CHUNK_FRAMES + OVERLAP_FRAMES);
    assert!(result.tempo_windows.len() >= 3);
    let times: Vec<_> = result.beats.iter().map(|b| b.time_seconds).collect();
    assert!(f_measure(&times, &expected(132.0, 120.0, 0.13, 1), 0.07) >= 0.95);
    assert!(times.windows(2).all(|w| (w[1] - w[0] - 0.5).abs() < 0.07), "cross-chunk beat gap or duplicate");
    let down: Vec<_> = result.beats.iter().filter(|b| b.downbeat).map(|b| b.time_seconds).collect();
    assert!(f_measure(&down, &expected(132.0, 120.0, 0.13, 4), 0.07) >= 0.85);
}
#[test]
fn silence_and_constant_tone_do_not_inherit_a_fake_catalog_tempo() {
    for samples in [vec![0.0; SAMPLE_RATE as usize * 12], (0..SAMPLE_RATE as usize * 12)
        .map(|n| (0.2 * (2.0 * std::f64::consts::PI * 1000.0 * n as f64 / SAMPLE_RATE as f64).sin()) as f32).collect()] {
        let result = analyze(&samples, Some(120.0), 321, 0.0);
        assert!(result.tempo_bpm.is_none()); assert!(result.beats.is_empty());
    }
}
#[test]
fn aperiodic_noise_does_not_earn_a_confident_music_grid() {
    let mut seed = 0x1234_5678_u32;
    let samples: Vec<_> = (0..SAMPLE_RATE as usize * 16).map(|_| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); ((seed as f64 / u32::MAX as f64 - 0.5) * 0.2) as f32
    }).collect();
    let result = analyze(&samples, Some(120.0), 4096, 0.0);
    assert!(result.tempo_bpm.is_none(), "noise tempo={:?} confidence={}", result.tempo_bpm, result.tempo_confidence);
    assert!(result.beats.is_empty());
}
#[test]
fn spectral_band_novelty_locates_a_known_timbre_change() {
    let result = analyze(&clicks(28.0, 120.0, 0.13, true, Some(14.0)), Some(120.0), 3072, 0.0);
    assert!(result.sections.iter().any(|s| (s.time_seconds - 14.0).abs() <= 1.0), "sections={:?}", result.sections);
}
#[test]
fn wide_sample_bytes_and_long_source_offsets_are_not_32_bit_clocks() {
    assert!(MAX_SAMPLES * 4 > u32::MAX as u64);
    let samples = clicks(12.0, 120.0, 0.13, true, None); let offset = 43_200.0;
    let zero = analyze(&samples, Some(120.0), 256, 0.0); let long = analyze(&samples, Some(120.0), 256, offset);
    assert_eq!(zero.decoded_samples, long.decoded_samples); assert_eq!(zero.beats.len(), long.beats.len());
    for (a, b) in zero.beats.iter().zip(&long.beats) { assert!((a.time_seconds + offset - b.time_seconds).abs() < 1e-8); }
    assert!(long.beats.iter().all(|b| b.time_seconds > offset));
}
#[test]
fn malformed_requests_and_nonfinite_pcm_fail_before_any_result() {
    assert!(BeatAnalyzer::new(Some(f64::NAN), 0.0).is_err());
    assert!(BeatAnalyzer::new(Some(10.0), 0.0).is_err());
    assert!(BeatAnalyzer::new(None, -1.0).is_err());
    let mut analyzer = BeatAnalyzer::new(None, 0.0).unwrap();
    assert!(analyzer.push(&[0.0, f32::NAN]).is_err()); assert_eq!(analyzer.samples, 0);
    assert!(analyzer.push(&[f32::INFINITY]).is_err());
}

//! Optional interpretation of the immutable v1 analysis. No FFT/DP/event mutation.
use super::Analysis;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TempoChoiceV2 {
    pub raw_bpm: Option<f64>, pub bpm: Option<f64>, pub prior_bpm: Option<f64>,
    pub octave_multiplier: f64, pub state: String, pub confidence: f64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PulseRecipeV2 { pub mode: String, pub phase: usize }
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BarHypothesisV2 {
    pub mode: String, pub beats_per_bar: usize, pub anchor_source_seconds: Option<f64>,
    pub anchor_native_index: Option<usize>, pub period_seconds: Option<f64>,
    pub confidence: f64, pub inferred: bool, pub reason: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RhythmV2 {
    pub schema: String, pub policy: String, pub tempo: TempoChoiceV2, pub pulse_recipe: PulseRecipeV2,
    pub bars: BarHypothesisV2, pub native_beat_count: usize, pub native_downbeat_count: usize,
    pub regular_interval_fraction: f64, pub human_quality_certified: bool,
}
fn choose_tempo(raw: Option<f64>, confidence: f64, prior: Option<f64>) -> TempoChoiceV2 {
    let mut choice = TempoChoiceV2 { raw_bpm: raw, bpm: raw, prior_bpm: prior, octave_multiplier: 1.0,
        state: if raw.is_none() { "no-tempo" } else if prior.is_none() { "no-prior" } else { "unchanged" }.into(), confidence };
    if let (Some(bpm), Some(anchor)) = (raw, prior) {
        if (bpm / anchor - 1.0).abs() > 0.1 {
            let candidate = [0.5_f64, 2.0].into_iter().filter(|m| (30.0..=300.0).contains(&(bpm * m)))
                .min_by(|a, b| (bpm * a / anchor - 1.0).abs().total_cmp(&(bpm * b / anchor - 1.0).abs()));
            if let Some(multiplier) = candidate.filter(|m| (bpm * m / anchor - 1.0).abs() <= 0.1) {
                choice.bpm = Some(bpm * multiplier); choice.octave_multiplier = multiplier;
                choice.state = "prior-octave-corrected".into(); choice.confidence = confidence.min(0.5);
            } else { choice.state = "prior-incompatible".into(); }
        }
    }
    choice
}
/** Constant-size metadata; event grids are recipes over the existing observed beats.
 * A prior can be wrong, so octave interpretation is flagged and never raises confidence. */
pub fn refine_rhythm_v2(analysis: &Analysis, prior: Option<f64>) -> Result<RhythmV2, String> {
    if prior.is_some_and(|v| !v.is_finite() || !(30.0..=300.0).contains(&v))
        || analysis.tempo_bpm.is_some_and(|v| !v.is_finite() || !(30.0..=300.0).contains(&v))
        || !analysis.tempo_confidence.is_finite() || !(0.0..=1.0).contains(&analysis.tempo_confidence)
        || !analysis.source_start_seconds.is_finite() || !(0.0..=604800.0).contains(&analysis.source_start_seconds)
        || !analysis.duration_seconds.is_finite() || analysis.duration_seconds <= 0.0 || analysis.duration_seconds > 86400.0
        || analysis.tempo_bpm.is_none() && (!analysis.beats.is_empty() || analysis.tempo_confidence != 0.0)
        || analysis.beats.len() > 400_000 { return Err("MUSIC_RHYTHM_INPUT_INVALID".into()); }
    let start = analysis.source_start_seconds; let end = start + analysis.duration_seconds;
    let mut previous = None;
    for beat in &analysis.beats {
        if !beat.time_seconds.is_finite() || beat.time_seconds < start || beat.time_seconds >= end
            || !beat.confidence.is_finite() || !(0.0..=1.0).contains(&beat.confidence)
            || !beat.downbeat_confidence.is_finite() || !(0.0..=1.0).contains(&beat.downbeat_confidence)
            || previous.is_some_and(|p| beat.time_seconds <= p) { return Err("MUSIC_RHYTHM_EVENT_CLOCK_INVALID".into()); }
        previous = Some(beat.time_seconds);
    }
    let tempo = choose_tempo(analysis.tempo_bpm, analysis.tempo_confidence, prior);
    let accent = analysis.beats.iter().enumerate().find(|(_, b)| b.downbeat);
    let downbeats = analysis.beats.iter().filter(|b| b.downbeat).count();
    let native_period = analysis.tempo_bpm.map(|bpm| 60.0 / bpm);
    let regular = native_period.map_or(0.0, |period| {
        let supported = analysis.beats.windows(2).filter(|pair| {
            let ratio = (pair[1].time_seconds - pair[0].time_seconds) / period;
            let multiple = ratio.round(); (1.0..=4.0).contains(&multiple) && (ratio - multiple).abs() <= 0.15
        }).count();
        if analysis.beats.len() < 2 { 0.0 } else { supported as f64 / (analysis.beats.len() - 1) as f64 }
    });
    let pulse = if tempo.bpm.is_none() { "unavailable" } else if tempo.octave_multiplier == 0.5 { "decimate-by-two" }
        else if tempo.octave_multiplier == 2.0 { "insert-midpoints" } else { "native-observed" };
    let mut bars = BarHypothesisV2 { mode: "unavailable".into(), beats_per_bar: 4, anchor_source_seconds: None,
        anchor_native_index: None, period_seconds: tempo.bpm.map(|bpm| 240.0 / bpm), confidence: 0.0,
        inferred: false, reason: "insufficient-or-irregular-evidence".into() };
    if tempo.bpm.is_some() && downbeats >= 2 && tempo.octave_multiplier == 1.0 {
        bars.mode = "native-downbeats".into(); bars.reason = "native-accent-hypothesis".into();
        bars.confidence = analysis.beats.iter().filter(|b| b.downbeat).map(|b| b.downbeat_confidence).sum::<f64>() / downbeats as f64;
    } else if tempo.bpm.is_some() && analysis.beats.len() >= 8 && regular >= 0.8 && analysis.tempo_confidence >= 0.3 {
        bars.mode = "inferred-four-beat-grid".into(); bars.inferred = true;
        bars.reason = if tempo.octave_multiplier == 1.0 { "weak-accent-first-beat-anchor" } else { "octave-adjusted-meter-hypothesis" }.into();
        bars.confidence = (tempo.confidence * regular * 0.2).min(0.2);
    }
    if bars.mode != "unavailable" {
        if let Some((index, beat)) = accent.or_else(|| analysis.beats.first().map(|b| (0, b))) {
            bars.anchor_native_index = Some(index); bars.anchor_source_seconds = Some(beat.time_seconds);
        }
    }
    let phase = if tempo.octave_multiplier == 0.5 { accent.map_or(0, |(index, _)| index % 2) } else { 0 };
    Ok(RhythmV2 { schema: "editkin.music-rhythm-refinement/v2".into(), policy: "prior-octave-four-beat-candidate/v2".into(),
        tempo, pulse_recipe: PulseRecipeV2 { mode: pulse.into(), phase }, bars, native_beat_count: analysis.beats.len(),
        native_downbeat_count: downbeats, regular_interval_fraction: regular, human_quality_certified: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::audio_beats::Beat;
    fn analysis(bpm: f64, count: usize, accent: bool, offset: f64) -> Analysis {
        let duration = count as f64 * 60.0 / bpm + 1.0;
        Analysis { schema: "editkin.music-beats-analysis/v1".into(), executor: "hao-core-spectral-flux-autocorrelation-dp/v1".into(),
            sample_rate: 16000, decoded_samples: (duration * 16000.0).round() as u64, duration_seconds: duration, source_start_seconds: offset,
            fft_size: 1024, hop_samples: 160, peak_feature_frames: 0, maximum_feature_frames: 6400,
            tempo_bpm: Some(bpm), tempo_confidence: 0.8, meter_hypothesis: "four-beat-accent-hypothesis; not a learned meter classifier".into(),
            onsets: vec![], beats: (0..count).map(|i| Beat { time_seconds: offset + 0.13 + i as f64 * 60.0 / bpm,
                confidence: 0.8, downbeat: accent && i % 4 == 0, downbeat_confidence: if accent && i % 4 == 0 { 0.7 } else { 0.0 } }).collect(),
            tempo_windows: vec![], sections: vec![], quality_state: "analysis_candidate_real_music_quality_unmeasured".into() }
    }
    #[test]
    fn known_ninety_one_twenty_one_eighty_octaves_follow_prior_and_flag() {
        for target in [90.0, 120.0, 180.0] {
            for multiplier in [0.5, 2.0] {
                let raw = target / multiplier; if !(30.0..=300.0).contains(&raw) { continue; }
                let result = refine_rhythm_v2(&analysis(raw, 16, true, 0.0), Some(target)).unwrap();
                assert_eq!(result.tempo.bpm, Some(target)); assert_eq!(result.tempo.octave_multiplier, multiplier);
                assert_eq!(result.tempo.state, "prior-octave-corrected"); assert!(result.tempo.confidence <= 0.5);
                assert!(result.bars.inferred); assert!(result.bars.confidence <= 0.2);
            }
        }
    }
    #[test]
    fn absent_incompatible_and_close_priors_do_not_rewrite_native_tempo() {
        for prior in [None, Some(120.0), Some(121.0), Some(75.0)] {
            let r = refine_rhythm_v2(&analysis(120.0, 16, true, 0.0), prior).unwrap();
            assert_eq!(r.tempo.bpm, Some(120.0)); assert_eq!(r.tempo.octave_multiplier, 1.0);
        }
        assert_eq!(refine_rhythm_v2(&analysis(120.0, 16, true, 0.0), Some(75.0)).unwrap().tempo.state, "prior-incompatible");
    }
    #[test]
    fn weak_accents_get_an_explicit_low_confidence_hypothesis() {
        let r = refine_rhythm_v2(&analysis(120.0, 16, false, 0.0), Some(120.0)).unwrap();
        assert_eq!(r.bars.mode, "inferred-four-beat-grid"); assert!(r.bars.inferred); assert!(r.bars.confidence <= 0.2);
        assert_eq!(r.bars.anchor_source_seconds, Some(0.13)); assert!(!r.human_quality_certified);
    }
    #[test]
    fn native_accents_remain_observed_and_legacy_json_is_unchanged() {
        let a = analysis(120.0, 16, true, 0.0); let before = serde_json::to_string(&a).unwrap();
        let r = refine_rhythm_v2(&a, Some(120.0)).unwrap(); assert_eq!(r.bars.mode, "native-downbeats"); assert!(!r.bars.inferred);
        assert_eq!(serde_json::to_string(&a).unwrap(), before);
    }
    #[test]
    fn insufficient_irregular_and_no_tempo_do_not_get_a_fake_bar_grid() {
        let mut a = analysis(120.0, 4, false, 0.0); assert_eq!(refine_rhythm_v2(&a, None).unwrap().bars.mode, "unavailable");
        a = analysis(120.0, 16, false, 0.0); a.duration_seconds = 12.0; for (i, b) in a.beats.iter_mut().enumerate() { b.time_seconds += i as f64 * 0.21; }
        assert_eq!(refine_rhythm_v2(&a, None).unwrap().bars.mode, "unavailable");
        a.beats.clear(); a.tempo_bpm = None; a.tempo_confidence = 0.0; let r = refine_rhythm_v2(&a, Some(120.0)).unwrap();
        assert!(r.tempo.bpm.is_none()); assert_eq!(r.pulse_recipe.mode, "unavailable"); assert_eq!(r.bars.mode, "unavailable");
    }
    #[test]
    fn constant_metadata_has_no_song_sized_vector_and_handles_late_offsets() {
        let small = serde_json::to_vec(&refine_rhythm_v2(&analysis(240.0, 16, false, 43200.0), None).unwrap()).unwrap();
        let large = serde_json::to_vec(&refine_rhythm_v2(&analysis(240.0, 40000, false, 43200.0), None).unwrap()).unwrap();
        assert!(small.len() < 2048 && large.len() < 2048); assert!(large.len().abs_diff(small.len()) < 32);
    }
    #[test]
    fn malformed_inputs_refuse_without_changing_analysis() {
        let mut a = analysis(120.0, 16, true, 0.0); assert!(refine_rhythm_v2(&a, Some(f64::NAN)).is_err());
        a.beats[1].time_seconds = a.beats[0].time_seconds; assert!(refine_rhythm_v2(&a, None).is_err());
    }
}

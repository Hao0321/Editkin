//! Paired reads require real decoder PTS, before staging or presenting a frame.
//! Legacy sessions keep their original clock recovery and EOF behavior.
use anyhow::{bail, Context, Result};

fn clock_ticks(seconds: f64) -> Result<i64> {
    let ticks = seconds * 10_000_000.0;
    if !ticks.is_finite() || ticks <= i64::MIN as f64 || ticks >= i64::MAX as f64 {
        bail!("TIMELINE_TRANSITION_DECODE_CLOCK_INVALID");
    }
    Ok(ticks.round() as i64)
}

pub(super) fn assert_frame(
    enabled: bool,
    target_seconds: f64,
    tolerance_seconds: f64,
    original_and_presented_pts: Option<(i64, i64)>,
    source_origin_100ns: i64,
) -> Result<()> {
    if !enabled { return Ok(()); }
    if !target_seconds.is_finite() || target_seconds < 0.0
        || !tolerance_seconds.is_finite() || tolerance_seconds <= 0.0 || tolerance_seconds > 0.25 {
        bail!("TIMELINE_TRANSITION_DECODE_CLOCK_INVALID");
    }
    let target = i128::from(clock_ticks(target_seconds)?);
    // Match the existing clock receipt's one-tick rounding allowance.
    let tolerance = i128::from(clock_ticks(tolerance_seconds)?) + 1;
    let (original, presented) = original_and_presented_pts
        .context("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING")?;
    let actual = i128::from(original) - i128::from(source_origin_100ns);
    if actual < 0 || (actual - target).abs() > tolerance
        || (i128::from(presented) - actual).abs() > 1 {
        bail!("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
    }
    Ok(())
}

pub(super) fn assert_cached_frame(
    enabled: bool, target_seconds: f64, tolerance_seconds: f64,
    receipt: &serde_json::Value, source_origin_100ns: i64,
) -> Result<()> {
    if !enabled { return Ok(()); }
    if receipt["endOfStream"].as_bool() != Some(false) {
        bail!("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
    }
    let original = clock_ticks(receipt["sourceTimestampSeconds"].as_f64()
        .context("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING")?)?;
    let presented = clock_ticks(receipt["timestampSeconds"].as_f64()
        .context("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING")?)?;
    assert_frame(true, target_seconds, tolerance_seconds, Some((original, presented)), source_origin_100ns)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_clock_and_eof_receipts_are_not_intervened_in() {
        assert_frame(false, f64::NAN, 0.0, None, i64::MIN).unwrap();
        assert_cached_frame(false, 0.0, 0.0, &serde_json::Value::Null, 0).unwrap();
    }
    #[test]
    fn actual_pre_and_post_roll_accept_nonzero_source_origins() {
        for origin in [0, 2_000_000, -2_000_000] {
            for pts in [2_000_000, 7_000_000] {
                assert_frame(true, pts as f64 / 10_000_000.0, 0.01,
                    Some((origin + pts, pts)), origin).unwrap();
            }
        }
    }
    #[test]
    fn eof_and_future_or_stale_samples_cannot_replace_missing_handles() {
        for sample in [None, Some((6_000_000, 6_000_000)), Some((8_000_000, 8_000_000)),
            Some((6_000_000, 7_000_000)), Some((7_000_000, 8_000_000))] {
            assert!(assert_frame(true, 0.7, 0.01, sample, 0).unwrap_err()
                .to_string().contains("ACTUAL_HANDLE_MISSING"));
        }
    }
    #[test]
    fn one_tick_receipt_rounding_is_kept_without_enlarging_tolerance() {
        assert_frame(true, 0.7, 0.01, Some((7_100_001, 7_100_001)), 0).unwrap();
        assert!(assert_frame(true, 0.7, 0.01, Some((7_100_002, 7_100_002)), 0).is_err());
    }
    #[test]
    fn cache_admission_uses_original_pts_instead_of_a_restamped_flag() {
        let receipt = serde_json::json!({"sourceTimestampSeconds":0.2,"timestampSeconds":0.7,
            "clockWithinTolerance":true,"endOfStream":false});
        assert!(assert_cached_frame(true, 0.7, 0.01, &receipt, 0).is_err());
        let valid = serde_json::json!({"sourceTimestampSeconds":0.2,"timestampSeconds":0.2,
            "clockWithinTolerance":true,"endOfStream":false});
        assert_cached_frame(true, 0.2, 0.01, &valid, 0).unwrap();
        assert!(assert_cached_frame(true, 0.7, 0.01, &valid, 0).is_err());
    }
    #[test]
    fn long_clocks_use_wide_arithmetic_and_invalid_inputs_are_rejected() {
        let pts = 24_i64 * 3600 * 10_000_000;
        assert_frame(true, 86400.0, 0.01, Some((pts, pts)), 0).unwrap();
        for (target, tolerance) in [(f64::NAN,0.01),(f64::INFINITY,0.01),(-1.0,0.01),
            (0.0,0.0),(0.0,0.251),(0.0,f64::NAN),(1e30,0.01)] {
            assert!(assert_frame(true,target,tolerance,Some((0,0)),0).is_err());
        }
        assert!(assert_frame(true,0.0,0.01,Some((i64::MIN,0)),i64::MAX).is_err());
    }
}

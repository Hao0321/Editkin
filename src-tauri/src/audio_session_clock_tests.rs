use super::*;
use serde_json::json;
fn event(kind: &str, state: &str, start: u64, raw: u64, supplied: u64, qpc: u64) -> Value {
    json!({"schema":"editkin.native-audio-session-event/v1","event":kind,"state":state,"streamGeneration":9,"deviceGeneration":1,
        "sampleMasterRate":48000,"timelineStartFrame":start,"timelineFrame":start+raw,"presentedFrame":raw,"sampleMasterFrame":supplied,"clockQpc100ns":qpc})
}
#[test]
fn long_clock_projects_hardware_not_arrival_and_never_exceeds_submitted() {
    let start = 48_000 * 3_600;
    let c = ResidentClock::new(9, start, 48_000 * 3_600).unwrap();
    c.admit(&event("prepared", "paused", start, 0, 960, 0))
        .unwrap();
    assert_eq!(c.sample_at(9_999_999).unwrap().0, 3600.);
    c.admit(&event("progress", "playing", start, 480, 1440, 10_000_000))
        .unwrap();
    assert!((c.sample_at(10_100_000).unwrap().0 - 3600.02).abs() < 1e-8);
    assert!((c.sample_at(10_500_000).unwrap().0 - 3600.03).abs() < 1e-8);
    assert!(c.sample_at(12_500_001).is_err());
}
#[test]
fn pause_freezes_and_resume_requires_a_fresh_hardware_capture() {
    let c = ResidentClock::new(9, 0, 480_000).unwrap();
    c.admit(&event("progress", "playing", 0, 480, 1440, 10_000_000))
        .unwrap();
    c.sample_at(10_050_000).unwrap();
    c.admit(&event("paused", "paused", 0, 960, 1920, 10_100_000))
        .unwrap();
    assert_eq!(c.sample_at(100_000_000).unwrap().0, 0.02);
    c.admit(&event("resumed", "playing", 0, 960, 1920, 10_100_000))
        .unwrap();
    assert_eq!(c.sample_at(100_000_000).unwrap().0, 0.02);
    c.state.lock().unwrap().waiting = Instant::now() - Duration::from_millis(251);
    assert!(c.sample_at(100_000_000).is_err());
    c.admit(&event("progress", "playing", 0, 1440, 2400, 100_000_000))
        .unwrap();
    assert_eq!(c.sample_at(100_000_000).unwrap().0, 0.03);
}
#[test]
fn pause_interpolation_lead_is_held_only_until_fresh_device_catchup() {
    let c = ResidentClock::new(9, 0, 480_000).unwrap();
    c.admit(&event("progress", "playing", 0, 28_800, 30_720, 10_000_000))
        .unwrap();
    assert_eq!(c.sample_at(10_200_000).unwrap().0, 0.62);
    // The pause reaches the device before the host receives its acknowledgement.
    // A previously sampled interpolation can therefore lead the stopped sample.
    c.admit(&event("paused", "paused", 0, 28_800, 30_720, 10_010_000))
        .unwrap();
    assert_eq!(c.sample_at(100_000_000).unwrap().0, 0.62);
    c.admit(&event("resumed", "playing", 0, 28_800, 30_720, 10_010_000))
        .unwrap();
    assert_eq!(c.sample_at(100_000_000).unwrap().0, 0.62);
    c.admit(&event(
        "progress",
        "playing",
        0,
        29_280,
        31_200,
        100_000_000,
    ))
    .unwrap();
    assert_eq!(c.sample_at(100_000_000).unwrap().0, 0.62);
    c.admit(&event(
        "progress",
        "playing",
        0,
        30_240,
        32_160,
        100_200_000,
    ))
    .unwrap();
    assert_eq!(c.sample_at(100_200_000).unwrap().0, 0.63);
    // After catch-up, the ordinary 2 ms discontinuity guard is still enforced.
    c.sample_at(100_400_000).unwrap();
    c.admit(&event(
        "progress",
        "playing",
        0,
        30_240,
        32_160,
        100_400_001,
    ))
    .unwrap();
    assert!(c.sample_at(100_400_001).is_err());
}
#[test]
fn playing_snapshot_replaces_the_sample_and_qpc_as_one_anchor() {
    let c = ResidentClock::new(9, 0, 480_000).unwrap();
    c.admit(&event("progress", "playing", 0, 480, 2_880, 10_000_000))
        .unwrap();
    assert_eq!(c.sample_at(10_100_000).unwrap().0, 0.02);
    c.admit(&event("snapshot", "playing", 0, 1_440, 3_360, 10_200_000))
        .unwrap();
    assert!((c.sample_at(10_300_000).unwrap().0 - 0.04).abs() < 1e-9);
    // A duplicate read-only snapshot is harmless, but never rebases the clock.
    c.admit(&event("snapshot", "playing", 0, 1_440, 3_360, 10_200_000))
        .unwrap();
    assert!((c.sample_at(10_300_000).unwrap().0 - 0.04).abs() < 1e-9);
    assert!(c
        .admit(&event("snapshot", "playing", 0, 1_441, 3_360, 10_200_000))
        .is_err());
    assert!(c
        .admit(&event("snapshot", "playing", 0, 1_440, 3_360, 10_199_999))
        .is_err());
}
#[test]
fn pause_catchup_cannot_mask_a_stalled_or_unrelated_clock() {
    let c = ResidentClock::new(9, 0, 480_000).unwrap();
    c.admit(&event("progress", "playing", 0, 28_800, 30_720, 10_000_000))
        .unwrap();
    c.sample_at(10_200_000).unwrap();
    c.admit(&event("paused", "paused", 0, 28_800, 30_720, 10_010_000))
        .unwrap();
    c.admit(&event("resumed", "playing", 0, 28_800, 30_720, 10_010_000))
        .unwrap();
    c.admit(&event(
        "progress",
        "playing",
        0,
        28_800,
        30_720,
        100_000_000,
    ))
    .unwrap();
    c.state.lock().unwrap().waiting = Instant::now() - Duration::from_millis(251);
    assert!(c.sample_at(100_000_000).is_err());
    // Repeated playing acknowledgements must not reset the catch-up watchdog.
    c.admit(&event("resumed", "playing", 0, 28_800, 30_720, 100_000_000))
        .unwrap();
    assert!(c.sample_at(100_000_000).is_err());
    let ordinary = ResidentClock::new(9, 0, 480_000).unwrap();
    ordinary
        .admit(&event("progress", "playing", 0, 480, 2_400, 10_000_000))
        .unwrap();
    ordinary.sample_at(10_300_000).unwrap();
    ordinary
        .admit(&event("progress", "playing", 0, 480, 2_400, 10_300_001))
        .unwrap();
    assert!(ordinary.sample_at(10_300_001).is_err());
}
#[test]
fn stale_identity_bad_ranges_replays_and_retired_handles_fail_closed() {
    let c = ResidentClock::new(9, 1_536_000, 48000).unwrap();
    let good = event("progress", "playing", 1_536_000, 0, 480, 10_000_000);
    c.admit(&good).unwrap();
    for (key, bad) in [
        ("streamGeneration", json!(8)),
        ("sampleMasterRate", json!(44100)),
        ("timelineFrame", json!(0)),
        ("sampleMasterFrame", json!(48001)),
        ("deviceGeneration", json!(2)),
    ] {
        let mut v = good.clone();
        v[key] = bad;
        v["clockQpc100ns"] = 10_000_001.into();
        assert!(c.admit(&v).is_err());
    }
    assert!(c.admit(&good).is_err());
    assert!(c.sample_at(9_999_999).is_err());
    assert_eq!(c.sample_at(10_000_000).unwrap().0, 32.);
    c.retire();
    assert!(c.sample_at(10_000_000).is_err());
    assert!(c.admit(&good).is_err());
}
#[test]
fn end_is_exact_and_legacy_range_is_unchanged() {
    assert!(ResidentClock::new(1, MAX_END, 1).is_err());
    assert!(ResidentClock::new(0, 0, 1).is_err());
    assert!(hardware::DeviceClock::new(0., 31.).is_err());
    let c = ResidentClock::new(9, 0, 48000).unwrap();
    assert!(c
        .admit(&event("ended", "ended", 0, 47999, 48000, 0))
        .is_err());
    c.admit(&event("ended", "ended", 0, 48000, 48000, 0))
        .unwrap();
    assert_eq!(c.sample_at(1).unwrap(), (1., true, Duration::ZERO));
    assert!(c
        .admit(&event("progress", "playing", 0, 48000, 48000, 1))
        .is_err());
}

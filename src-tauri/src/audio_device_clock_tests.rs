use super::*;
use serde_json::json;

fn started(generation: u64, frame: u64, kind: &str) -> Value {
    json!({"event":kind,"timelineStartSeconds":10.0,"timelineSeconds":10.0+frame as f64/48_000.0,"deviceGeneration":generation})
}
fn progress(qpc: u64, frame: u64, supplied: u64, generation: u64) -> Value {
    let mut event = started(generation, frame, "progress");
    event["clockQpc100ns"] = json!(qpc);
    event["presentedFrame"] = json!(frame);
    event["sourceFrame"] = json!(frame);
    event["sampleMasterFrame"] = json!(supplied);
    event["sampleMasterRate"] = json!(48_000);
    event
}
fn clock() -> DeviceClock {
    let mut clock = DeviceClock::new(10.0, 30.0).unwrap();
    clock.admit(&started(1, 0, "started"), None).unwrap();
    clock
}

#[test]
fn qpc_conversion_preserves_units_fraction_and_overflow_bound() {
    assert_eq!(counter_100ns(123_456_789, 10_000_000).unwrap(), 123_456_789);
    assert_eq!(counter_100ns(1_234_567, 3_579_545).unwrap(), 3_448_949);
    assert_eq!(
        counter_100ns(i64::MAX, 10_000_000).unwrap(),
        i64::MAX as u64
    );
    assert!(counter_100ns(i64::MAX, 1).is_err());
    assert!(counter_100ns(-1, 10_000_000).is_err());
    assert!(counter_100ns(0, 0).is_err());
}

#[test]
fn delayed_delivery_uses_hardware_capture_and_advances_between_sparse_events() {
    let mut clock = clock();
    // Capture at 1.000s, pipe delivery at 1.012s, rendering at 1.020s.
    clock
        .admit(&progress(10_000_000, 48_000, 52_800, 1), Some(10_120_000))
        .unwrap();
    let (seconds, age) = clock.sample(11.0, Some(10_200_000)).unwrap();
    assert!((seconds - 11.020).abs() < 1e-6);
    assert_eq!(age, Some(Duration::from_millis(20)));
    // An arrival-time extrapolator gives 11.008; a raw mailbox gives 11.000.
    assert!((seconds - 11.008).abs() > 0.01);
    let mut indices = Vec::new();
    for elapsed in [0, 4, 8, 12, 16, 20] {
        let mut sample_clock = clock.clone();
        sample_clock.last = None;
        indices.push(
            ((sample_clock
                .sample(11.0, Some(10_000_000 + elapsed * 10_000))
                .unwrap()
                .0
                - 10.0)
                * 120.0)
                .floor() as u64,
        );
    }
    assert!(indices.last().unwrap() > &indices[0]);
}

#[test]
fn staged_end_and_supplied_samples_are_hard_projection_ceilings() {
    let mut clock = clock();
    clock
        .admit(
            &progress(10_000_000, 1_439_040, 1_440_000, 1),
            Some(10_000_000),
        )
        .unwrap();
    assert_eq!(clock.sample(39.98, Some(10_500_000)).unwrap().0, 40.0);
    let mut bounded = super::tests::clock();
    bounded
        .admit(&progress(10_000_000, 48_000, 48_480, 1), Some(10_000_000))
        .unwrap();
    assert!((bounded.sample(11.0, Some(10_900_000)).unwrap().0 - 11.01).abs() < 1e-6);
}

#[test]
fn stale_future_wrong_unit_and_missing_correlation_are_rejected() {
    for event in [
        progress(1, 48_000, 52_800, 1),
        progress(11_000_000, 48_000, 52_800, 1),
        progress(0, 48_000, 52_800, 1),
        progress(1_000_000_000, 48_000, 52_800, 1),
    ] {
        assert!(clock().admit(&event, Some(10_000_000)).is_err());
    }
    let mut event = progress(10_000_000, 48_000, 52_800, 1);
    event.as_object_mut().unwrap().remove("clockQpc100ns");
    assert!(clock().admit(&event, Some(10_000_000)).is_err());
    let mut clock = clock();
    clock
        .admit(&progress(10_000_000, 48_000, 52_800, 1), Some(10_000_000))
        .unwrap();
    assert!(clock.sample(11.0, Some(12_500_001)).is_err());
}

#[test]
fn device_generation_and_canonical_samples_cannot_be_relabelled() {
    for field in [
        "sampleMasterRate",
        "sourceFrame",
        "presentedFrame",
        "deviceGeneration",
        "timelineStartSeconds",
        "timelineSeconds",
        "sampleMasterFrame",
    ] {
        let mut event = progress(10_000_000, 48_000, 52_800, 1);
        event[field] = json!(9_999_999);
        assert!(clock().admit(&event, Some(10_000_000)).is_err(), "{field}");
    }
    let mut clock = clock();
    clock
        .admit(&progress(10_000_000, 48_000, 52_800, 1), Some(10_000_000))
        .unwrap();
    assert!(clock
        .admit(&progress(10_000_000, 48_000, 52_800, 1), Some(10_000_000))
        .is_err());
    assert!(clock.admit(&started(1, 48_000, "started"), None).is_err());
}

#[test]
fn recovery_freezes_then_rebinds_device_without_old_qpc_extrapolation() {
    let mut clock = clock();
    clock
        .admit(&progress(10_000_000, 48_000, 52_800, 1), Some(10_000_000))
        .unwrap();
    assert_eq!(clock.sample(11.0, Some(10_200_000)).unwrap().0, 11.02);
    clock
        .admit(&started(1, 48_000, "recovering"), None)
        .unwrap();
    assert_eq!(clock.sample(11.0, Some(11_000_000)).unwrap().0, 11.02);
    assert!(clock
        .admit(&progress(11_000_000, 48_000, 52_800, 1), Some(11_000_000))
        .is_err());
    clock.admit(&started(2, 48_000, "recovered"), None).unwrap();
    assert_eq!(clock.sample(11.0, Some(11_000_000)).unwrap().0, 11.02);
    clock
        .admit(&progress(12_000_000, 49_440, 53_280, 2), Some(12_000_000))
        .unwrap();
    assert_eq!(clock.sample(11.03, Some(12_000_000)).unwrap().0, 11.03);
    let ended = json!({"event":"ended","timelineSeconds":40.0,"timelineStartSeconds":10.0});
    clock.admit(&ended, None).unwrap();
    assert_eq!(clock.sample(40.0, Some(999_999_999)).unwrap().0, 40.0);
}

#[test]
fn tiny_quantization_correction_freezes_but_real_discontinuity_fails() {
    let mut clock = clock();
    clock
        .admit(&progress(10_000_000, 48_000, 52_800, 1), Some(10_000_000))
        .unwrap();
    let before = clock.sample(11.0, Some(10_240_000)).unwrap().0;
    clock
        .admit(&progress(10_250_000, 49_128, 53_280, 1), Some(10_250_000))
        .unwrap();
    assert_eq!(clock.sample(11.0235, Some(10_250_000)).unwrap().0, before);
    clock
        .admit(&progress(10_260_000, 49_128, 53_280, 1), Some(10_260_000))
        .unwrap();
    clock.sample(11.0235, Some(10_500_000)).unwrap();
    clock
        .admit(&progress(10_600_000, 49_128, 53_280, 1), Some(10_600_000))
        .unwrap();
    assert!(clock.sample(11.0235, Some(10_600_000)).is_err());
}

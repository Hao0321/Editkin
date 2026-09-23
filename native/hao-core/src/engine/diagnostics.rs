use serde_json::{Value, json};

use super::audio::{automation_value, db_to_gain, stereo_pan_gains};
use super::model::{
    AutomationInterpolation, AutomationLane, AutomationPoint, PixelFormat, RationalTimebase,
};
use super::plugin::{EffectPluginManifest, validate_plugin_manifest};
use super::roto::{MatteFrame, MatteRefine, boundary_chatter, refine_matte, warp_translation};
use super::runtime::{DeviceRecovery, DeviceState, EngineClock, FrameRing, ResourceCache};
use super::scene::{CameraProjection, Vec3, shutter_sample_times, simulate_particles};

pub fn selftest_receipt() -> Result<Value, String> {
    let clock = EngineClock::new(
        RationalTimebase {
            numerator: 1001,
            denominator: 30_000,
        },
        48_000,
    )?;
    let frame = 30_000_u64;
    let sample = clock.frame_to_sample(frame);
    if sample != 48_048_000 || clock.sample_to_frame(sample) != frame {
        return Err("rational frame/sample clock parity failed".into());
    }

    let mut ring = FrameRing::triple();
    ring.push(1)
        .map_err(|_| "frame ring rejected first frame")?;
    ring.push(2)
        .map_err(|_| "frame ring rejected second frame")?;
    ring.push(3)
        .map_err(|_| "frame ring rejected third frame")?;
    if ring.push(4) != Err(4) || ring.rejected() != 1 || ring.pop() != Some(1) || ring.len() != 2 {
        return Err("triple frame ring backpressure failed".into());
    }

    let mut cache = ResourceCache::new(10)?;
    cache.insert("a".into(), 1, 4)?;
    cache.insert("b".into(), 2, 4)?;
    let _ = cache.get("a");
    let evicted = cache.insert("c".into(), 3, 4)?;
    if evicted != ["b"] || cache.used_bytes() != 8 {
        return Err("LRU resource budget failed".into());
    }

    let mut recovery = DeviceRecovery::new();
    recovery.mark_lost();
    recovery.begin_recovery()?;
    recovery.finish_recovery(true);
    if recovery.state() != DeviceState::Ready || recovery.generation() != 2 {
        return Err("device loss recovery failed".into());
    }

    let mut alpha = vec![0_u8; 25];
    alpha[12] = 255;
    let source = MatteFrame {
        frame: 0,
        width: 5,
        height: 5,
        alpha,
        confidence: 1.0,
    };
    let warped = warp_translation(&source, 1, 1, 0, 0.9)?;
    let refined = refine_matte(
        &warped,
        Some(&source),
        MatteRefine {
            radius: 1,
            contrast: 1.2,
            edge_shift: 1,
            temporal_stability: 0.25,
        },
    )?;
    let chatter = boundary_chatter(&source, &warped)?;
    if warped.alpha[13] != 255 || refined.alpha.iter().all(|value| *value == 0) || chatter <= 0.0 {
        return Err("pixel matte propagation/refine failed".into());
    }

    let lane = AutomationLane {
        property: "gainDb".into(),
        points: vec![
            AutomationPoint {
                sample: 0,
                value: 0.0,
                interpolation: AutomationInterpolation::Linear,
            },
            AutomationPoint {
                sample: 100,
                value: 1.0,
                interpolation: AutomationInterpolation::Hold,
            },
        ],
    };
    let automation = automation_value(&lane, 25)?;
    let gain = db_to_gain(0.0)?;
    let (pan_left, pan_right) = stereo_pan_gains(0.0)?;
    if (automation - 0.25).abs() > 0.0001
        || (gain - 1.0).abs() > 0.0001
        || (pan_left - pan_right).abs() > 0.0001
    {
        return Err("sample-accurate audio math failed".into());
    }

    validate_plugin_manifest(&EffectPluginManifest {
        schema: "editkin.effect-plugin/v1".into(),
        id: "diagnostic-gain".into(),
        version: "1.0.0".into(),
        abi_version: 1,
        library_sha256: "a".repeat(64),
        entry_symbol: "editkin_effect_plugin_v1".into(),
        supported_formats: vec![PixelFormat::Rgba16Float],
        max_temporal_radius: 0,
        timeout_ms: 1000,
        deterministic: true,
    })?;

    let camera = CameraProjection {
        position: Vec3::new([0.0, 0.0, 0.0]),
        target: Vec3::new([0.0, 0.0, 1.0]),
        up: Vec3::new([0.0, 1.0, 0.0]),
        vertical_fov: 1.0,
        aspect: 16.0 / 9.0,
        near: 0.1,
        far: 100.0,
    };
    let projected = camera
        .project(Vec3::new([0.0, 0.0, 1.0]))?
        .ok_or("camera clipped visible point")?;
    let particles = simulate_particles(
        9,
        30.0,
        2.0,
        Vec3::new([0.0, 1.0, 0.0]),
        Vec3::new([0.0, -9.8, 0.0]),
        1.0,
        100,
    )?;
    let repeat = simulate_particles(
        9,
        30.0,
        2.0,
        Vec3::new([0.0, 1.0, 0.0]),
        Vec3::new([0.0, -9.8, 0.0]),
        1.0,
        100,
    )?;
    let shutter = shutter_sample_times(1.0, 1.0 / 30.0, 180.0, 8)?;
    if projected[0] != 0.0 || particles != repeat || shutter.len() != 8 {
        return Err("deterministic scene/VFX reference failed".into());
    }

    Ok(json!({
        "schema": "editkin.engine-selftest/v1", "status": "GREEN", "engineAbiVersion": 1,
        "clock": { "frame": frame, "sample": sample, "nanosecondsPerFrame": clock.frame_to_nanoseconds(1) },
        "frameRing": { "capacity": 3, "rejected": ring.rejected() }, "resourceCache": { "usedBytes": cache.used_bytes(), "evicted": evicted },
        "deviceRecovery": { "state": "ready", "generation": recovery.generation() },
        "pixelMatte": { "propagated": true, "refinedPixels": refined.alpha.iter().filter(|value| **value > 0).count(), "boundaryChatter": chatter },
        "audio": { "automationAt25": automation, "unityGain": gain, "centerPan": [pan_left, pan_right] },
        "effectAbi": { "version": 1, "manifestRejectedOnMismatch": true },
        "scene": { "projectedOrigin": projected, "deterministicParticles": particles.len(), "shutterSamples": shutter.len() }
    }))
}

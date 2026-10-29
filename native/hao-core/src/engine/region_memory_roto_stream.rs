//! Same region-memory arithmetic as the frozen slice API, with fallible frame IO.
//! Only seed/directional states and one RGB buffer live here; sinks own their storage.
use super::*;

#[derive(Debug, PartialEq, Eq)]
pub enum RegionMemoryStreamError {
    Algorithm(String),
    Read(String),
    Emit(String),
}

impl std::fmt::Display for RegionMemoryStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Algorithm(s) | Self::Read(s) | Self::Emit(s) => f.write_str(s),
        }
    }
}

/// Visits seed, forward, then backward, exactly like the slice implementation.
/// `read` must fill its whole RGB buffer. Read/emit errors are terminal IO failures,
/// distinct from candidate-algorithm failures eligible for deterministic fallback.
pub fn segment_region_memory_streaming<R, E, P>(
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame: usize,
    initial_rect: RegionMemorySeedRect,
    settings: RegionMemorySettings,
    mut read: R,
    mut emit: E,
    mut postprocess: P,
) -> Result<RegionMemorySequenceReceipt, RegionMemoryStreamError>
where
    R: FnMut(usize, &mut [u8]) -> Result<(), String>,
    E: FnMut(&MatteFrame, OpticalAlphaReceipt) -> Result<(), String>,
    P: FnMut(&mut MatteFrame),
{
    use RegionMemoryStreamError::{Algorithm, Emit, Read};
    validate_settings(settings).map_err(Algorithm)?;
    let frame_bytes = width.checked_mul(height).and_then(|n| n.checked_mul(3))
        .ok_or_else(|| Algorithm("region memory frame size overflow".into()))?;
    // Keep native product bounds; checked before allocating even one frame or receipt array.
    if width < 16 || height < 16 || width > 8192 || height > 8192
        || width * height > 16_777_216 || frame_count == 0 || frame_count > 36_000
        || initial_frame >= frame_count
        || width.checked_mul(height).and_then(|n| n.checked_mul(frame_count))
            .filter(|n| *n <= 2 * 1024 * 1024 * 1024).is_none()
    {
        return Err(Algorithm("invalid or unsafe region memory streaming layout".into()));
    }
    validate_seed(initial_rect).map_err(Algorithm)?;
    let mut rgb = vec![0; frame_bytes];
    read(initial_frame, &mut rgb).map_err(Read)?;
    let mut seed_state = initial_state(&rgb, width, height, initial_frame, initial_rect).map_err(Algorithm)?;
    let (mut seed, refinement, receipt) =
        segment_one(&mut seed_state, initial_frame, &rgb, settings, true).map_err(Algorithm)?;
    postprocess_and_capture(&mut seed_state, &mut seed, &mut postprocess).map_err(Algorithm)?;
    let mut receipts = vec![None; frame_count];
    emit(&seed, refinement).map_err(Emit)?;
    receipts[initial_frame] = Some(receipt);
    drop(seed);

    let mut forward = seed_state.clone();
    for frame in initial_frame + 1..frame_count {
        read(frame, &mut rgb).map_err(Read)?;
        let (matte, refinement, receipt) = segment_with_scene_reseed(
            &mut forward, frame, &rgb, initial_rect, settings, &mut postprocess,
        ).map_err(Algorithm)?;
        emit(&matte, refinement).map_err(Emit)?;
        receipts[frame] = Some(receipt);
    }
    let mut backward = seed_state;
    for frame in (0..initial_frame).rev() {
        read(frame, &mut rgb).map_err(Read)?;
        let (matte, refinement, receipt) = segment_with_scene_reseed(
            &mut backward, frame, &rgb, initial_rect, settings, &mut postprocess,
        ).map_err(Algorithm)?;
        emit(&matte, refinement).map_err(Emit)?;
        receipts[frame] = Some(receipt);
    }
    let frames = receipts.into_iter().map(|r| r.ok_or_else(|| Algorithm("missing streamed region receipt".into())))
        .collect::<Result<Vec<_>, _>>()?;
    let model_bounds_valid = forward.foreground.validate().is_ok()
        && forward.background.validate().is_ok()
        && backward.foreground.validate().is_ok()
        && backward.background.validate().is_ok();
    if !model_bounds_valid {
        return Err(Algorithm("region memory color model invalid after sequence".into()));
    }
    Ok(RegionMemorySequenceReceipt {
        schema: "editkin.region-memory-roto-receipt/v1",
        engine: REGION_MEMORY_ROTO_ENGINE,
        frame_count,
        memory_updates: frames.iter().filter(|r| r.memory_updated).count(),
        full_occlusion_freezes: frames.iter().filter(|r| r.freeze_reason == RegionMemoryFreezeReason::FullOcclusion).count(),
        scene_cut_freezes: frames.iter().filter(|r| r.freeze_reason == RegionMemoryFreezeReason::SceneCut).count(),
        scene_cut_reseeds: frames.iter().filter(|r| r.freeze_reason == RegionMemoryFreezeReason::SceneCutReseed).count(),
        low_confidence_freezes: frames.iter().filter(|r| r.freeze_reason == RegionMemoryFreezeReason::LowConfidence).count(),
        model_bounds_valid,
        frames,
    })
}

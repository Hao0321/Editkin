//! Bounded-memory coarse route used only by explicit v2. The old v1 dispatcher is frozen.
use super::*;
use crate::engine::auto_roto_v2_io::{assert_local_path, guard_space, write_new, V2_MAX_RAW_BYTES};
use crate::engine::region_memory_roto::streaming::{segment_region_memory_streaming, RegionMemoryStreamError};

/// Same model, order, corrections and output bytes as guarded v1, without whole-sequence arrays.
/// The enclosing v2 request retains its existing raw/output caps. No model, proxy or quality change.
pub fn run_guarded_coarse_streaming(request: AutoRotoRequest) -> Result<AutoRotoReceipt, String> {
    if request.region_memory_policy != RegionMemoryRoutePolicy::GuardedExperimental
        || request.edge_refine.is_some() || !request.analysis_fps.is_finite()
        || !(0.01..=60.0).contains(&request.analysis_fps)
    {
        return Err("streamed coarse route requires explicit guarded v2 without a nested edge request".into());
    }
    #[cfg(feature = "auto-roto-research-onnx")]
    if request.onnx_pack.is_some() { return Err("streamed coarse route does not accept research models".into()); }
    assert_local_path(&request.raw_path)?;
    let meta = fs::metadata(&request.raw_path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > V2_MAX_RAW_BYTES { return Err("streamed coarse RGB input budget".into()); }
    let (frame_bytes, alpha_bytes) = validated_auto_roto_layout(
        request.width, request.height, request.frame_count, request.initial_frame, meta.len(),
    )?;
    validate_auto_roto_settings(request.temporal_stability, request.feather, request.edge_shift,
        request.contrast, &request.corrections, request.frame_count)?;
    let parent = request.output_dir.parent().ok_or("coarse output parent missing")?;
    let pending = (alpha_bytes as u64).checked_mul(2).and_then(|n| n.checked_add(request.frame_count as u64 * 4096 + 1024 * 1024))
        .ok_or("coarse output estimate overflow")?;
    guard_space(parent, pending)?;
    fs::create_dir(&request.output_dir).map_err(|e| format!("exclusive streamed coarse output: {e}"))?;
    let sequence_path = request.output_dir.join("matte-sequence.alpha8");
    let mut sequence = fs::OpenOptions::new().create_new(true).read(true).write(true)
        .open(&sequence_path).map_err(|e| e.to_string())?;
    sequence.set_len(alpha_bytes as u64).map_err(|e| e.to_string())?;
    let mut input = fs::File::open(&request.raw_path).map_err(|e| e.to_string())?;
    let mut frame_receipts = (0..request.frame_count).map(|_| None).collect::<Vec<_>>();
    let mut refinements = (0..request.frame_count).map(|_| None).collect::<Vec<_>>();
    let mut completed = 0;
    let region = segment_region_memory_streaming(
        request.width, request.height, request.frame_count, request.initial_frame,
        RegionMemorySeedRect {x:request.initial_rect.x,y:request.initial_rect.y,width:request.initial_rect.width,height:request.initial_rect.height},
        RegionMemorySettings {temporal_stability:request.temporal_stability,feather:request.feather,
            edge_shift:request.edge_shift,contrast:request.contrast,..Default::default()},
        |frame, rgb| read_rgb_frame(&mut input, frame, frame_bytes, rgb),
        |matte, refinement| {
            guard_space(&request.output_dir, matte.alpha.len() as u64 + 4096)?;
            write_streamed_matte(&request, &mut sequence, matte, &mut frame_receipts, &mut refinements, refinement)?;
            completed += 1;
            eprintln!("ROTO_V2_COARSE_PROGRESS {completed}/{}", request.frame_count);
            Ok(())
        },
        |matte| apply_frame_corrections(matte, &request.corrections),
    );
    let region_memory = match region {
        Ok(receipt) => receipt,
        Err(RegionMemoryStreamError::Read(e)) | Err(RegionMemoryStreamError::Emit(e)) => return Err(e),
        Err(RegionMemoryStreamError::Algorithm(candidate_error)) => {
            // All files belong to this exclusive workspace. Complete fixed fallback overwrites
            // every frame; no partial candidate manifest has been committed.
            drop(sequence);drop(input);
            let mut receipt = run_fixed_baseline_streaming(request)?;
            receipt.region_memory_routing = RegionMemoryRoutingReceipt {
                schema:"editkin.region-memory-routing/v1",requested:RegionMemoryRoutePolicy::GuardedExperimental,
                executed:"fixed_baseline",candidate_attempted:true,deterministic_fallback:true,
                fallback_reason:Some(format!("candidate-error:{candidate_error}")),
            };
            fs::write(receipt.sequence_path.parent().unwrap().join("matte-manifest.json"),
                serde_json::to_vec_pretty(&receipt).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            return Ok(receipt);
        }
    };
    sequence.sync_all().map_err(|e| e.to_string())?;
    let mut frames = frame_receipts.into_iter().map(|r|r.ok_or("missing streamed coarse frame"))
        .collect::<Result<Vec<_>, _>>()?;
    // Chatter is defined in chronological order, even when the seed is in the middle.
    // A second sequential alpha read uses two frame buffers, never the whole sequence.
    sequence.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let pixels = request.width * request.height;
    let mut previous = MatteFrame {frame:0,width:request.width as u32,height:request.height as u32,
        alpha:vec![0;pixels],confidence:frames[0].confidence};
    sequence.read_exact(&mut previous.alpha).map_err(|e|e.to_string())?;
    let mut current = previous.clone();let mut chatter_total = 0.0;
    for frame in 1..request.frame_count {
        current.frame = frame as u64;current.confidence = frames[frame].confidence;
        sequence.read_exact(&mut current.alpha).map_err(|e|e.to_string())?;
        let chatter = boundary_chatter(&previous, &current)?;
        frames[frame].boundary_chatter=chatter;chatter_total+=chatter;
        std::mem::swap(&mut previous, &mut current);
    }
    let refinements=refinements.into_iter().map(|r|r.ok_or("missing streamed coarse refinement"))
        .collect::<Result<Vec<_>, _>>()?;
    let receipt=AutoRotoReceipt {
        schema:"editkin.auto-roto-matte/v1",engine:"editkin-native-color-temporal-roto/v1".into(),
        width:request.width,height:request.height,analysis_fps:request.analysis_fps,initial_frame:request.initial_frame,
        sequence_path,frames,mean_boundary_chatter:chatter_total/request.frame_count.max(1) as f64,
        correction_strokes_applied:request.corrections.len(),corrected_frames:corrected_frame_indices(&request.corrections),
        alpha_refinement:aggregate_alpha_refinements(&refinements)?,region_memory:Some(region_memory),
        region_memory_routing:RegionMemoryRoutingReceipt {schema:"editkin.region-memory-routing/v1",
            requested:RegionMemoryRoutePolicy::GuardedExperimental,executed:"guarded_experimental",
            candidate_attempted:true,deterministic_fallback:false,fallback_reason:None},
        #[cfg(feature="auto-roto-research-onnx")]
        onnx_model:None,
        frozen:true,
    };
    write_new(&request.output_dir.join("matte-manifest.json"), &serde_json::to_vec_pretty(&receipt).map_err(|e|e.to_string())?)?;
    Ok(receipt)
}

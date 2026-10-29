//! Explicit no-model v2 sequence; existing v1 stays the default and live-mask route.
//! Coarse and edge frames stream from a bounded 256MiB RGB file; disk spool cap is unchanged.
use super::auto_roto::{
    AutoRotoRequest, RegionMemoryRoutePolicy, apply_frame_corrections, run_auto_roto,
};
use super::auto_roto_v2_io::{
    V2_MAX_RAW_BYTES, assert_local_path, guard_space, new_file, sha256_file, write_new,
};
use super::auto_roto_v2_types::AUTO_ROTO_V2_ENGINE;
pub use super::auto_roto_v2_types::{AutoRotoCliReceipt, AutoRotoFrameV2, AutoRotoReceiptV2};
use super::roto::MatteFrame;
use super::roto_edge_color_v2::recover_local_foreground;
use super::roto_edge_png_v2::encode_roto_edge_alpha_png_v2;
use super::roto_edge_v2::{
    ROTO_EDGE_V2_MAX_PIXELS, RotoEdgePreviousV2, RotoEdgeSettingsV2, refine_roto_edge_v2,
    roto_edge_bands_v2,
};
use std::fs::{self, File};
use std::io::{Read, Write};

pub fn run_auto_roto_cli(mut request: AutoRotoRequest) -> Result<AutoRotoCliReceipt, String> {
    if let Some(settings) = request.edge_refine.take() {
        Ok(AutoRotoCliReceipt::V2(run_v2(request, settings)?))
    } else {
        Ok(AutoRotoCliReceipt::V1(run_auto_roto(request)?))
    }
}

fn run_v2(
    mut request: AutoRotoRequest,
    settings: RotoEdgeSettingsV2,
) -> Result<AutoRotoReceiptV2, String> {
    settings.validate()?;
    let pixels = request
        .width
        .checked_mul(request.height)
        .ok_or("v2 pixel overflow")?;
    let total = pixels
        .checked_mul(request.frame_count)
        .ok_or("v2 frame overflow")?;
    let raw_bytes = total.checked_mul(3).ok_or("v2 raw overflow")? as u64;
    if request.width < 16
        || request.height < 16
        || pixels > ROTO_EDGE_V2_MAX_PIXELS
        || request.frame_count == 0
        || request.frame_count > 1440
        || raw_bytes > V2_MAX_RAW_BYTES
        || request.initial_frame >= request.frame_count
        || !request.analysis_fps.is_finite()
        || !(0.01..=60.0).contains(&request.analysis_fps)
        || request.region_memory_policy != RegionMemoryRoutePolicy::GuardedExperimental
    {
        return Err("roto v2 requires guarded_experimental and a bounded RGB/frame layout".into());
    }
    assert_local_path(&request.raw_path)?;
    if fs::metadata(&request.raw_path)
        .map_err(|e| e.to_string())?
        .len()
        != raw_bytes
    {
        return Err("v2 raw byte count differs".into());
    }
    let source_sha = sha256_file(&request.raw_path)?;
    let root = request.output_dir.clone();
    let parent = root.parent().ok_or("v2 output parent missing")?;
    assert_local_path(parent)?;
    // The existing coarse route writes alpha8 + PNG8. Final RGB + alpha + PNG fit this bound.
    let alpha_width = if settings.alpha16 { 2_u64 } else { 1 };
    let estimate =
        total as u64 * (3 + 2 * alpha_width + 2) + request.frame_count as u64 * 4096 + 1024 * 1024;
    guard_space(parent, estimate)?;
    fs::create_dir(&root).map_err(|e| format!("exclusive roto v2 output: {e}"))?;
    let width = request.width;
    let height = request.height;
    let count = request.frame_count;
    let fps = request.analysis_fps;
    let initial_frame = request.initial_frame;
    let corrections = request.corrections.clone();
    let raw_path = request.raw_path.clone();
    request.output_dir = root.join("coarse");
    let coarse_receipt = super::auto_roto::streaming::run_guarded_coarse_streaming(request)?;
    if fs::metadata(&coarse_receipt.sequence_path)
        .map_err(|e| e.to_string())?
        .len()
        != total as u64
    {
        return Err("coarse alpha count differs".into());
    }
    let alpha_name = if settings.alpha16 {
        "matte-sequence.alpha16le"
    } else {
        "matte-sequence.alpha8"
    };
    let mut input = File::open(&raw_path).map_err(|e| e.to_string())?;
    let mut coarse_file = File::open(&coarse_receipt.sequence_path).map_err(|e| e.to_string())?;
    let mut rgb_out = new_file(&root.join("foreground.rgb24"))?;
    let mut alpha_out = new_file(&root.join(alpha_name))?;
    let mut rgb = vec![0; pixels * 3];
    let mut coarse_alpha = vec![0; pixels];
    let mut previous: Option<(MatteFrame, Vec<f32>)> = None;
    let mut frames = Vec::with_capacity(count);
    for frame in 0..count {
        guard_space(&root, pixels as u64 * (3 + 2 * alpha_width) + 4096)?;
        input.read_exact(&mut rgb).map_err(|e| e.to_string())?;
        coarse_file
            .read_exact(&mut coarse_alpha)
            .map_err(|e| e.to_string())?;
        let coarse = MatteFrame {
            frame: frame as u64,
            width: width as u32,
            height: height as u32,
            alpha: coarse_alpha.clone(),
            confidence: coarse_receipt.frames[frame].confidence,
        };
        let prior = previous.as_ref().map(|(coarse, alpha)| RotoEdgePreviousV2 {
            coarse,
            refined_alpha: alpha,
        });
        let mut result = refine_roto_edge_v2(&rgb, &coarse, prior, settings)?;
        // Coarse already includes the user's soft brush. Preserve it exactly where the brush
        // has a measurable effect; do not run it twice or let the edge solve erase it.
        let mut coverage = MatteFrame {
            alpha: vec![128; pixels],
            ..coarse.clone()
        };
        apply_frame_corrections(&mut coverage, &corrections);
        let mut restored = 0;
        for i in 0..pixels {
            if coverage.alpha[i] != 128 {
                result.matte.alpha[i] = coarse.alpha[i];
                result.alpha_f32[i] = coarse.alpha[i] as f32 / 255.0;
                if let Some(high) = result.alpha16.as_mut() {
                    high[i] = coarse.alpha[i] as u16 * 257;
                }
                restored += 1;
            }
        }
        if restored > 0 && settings.despill {
            let (band, _) =
                roto_edge_bands_v2(&coarse, previous.as_ref().map(|(c, _)| c), settings)?;
            result.straight_rgb = recover_local_foreground(
                &rgb,
                &coarse,
                &band,
                &result.alpha_f32,
                settings.local_radius as usize,
            )
            .0;
        }
        rgb_out
            .write_all(&result.straight_rgb)
            .map_err(|e| e.to_string())?;
        if let Some(high) = &result.alpha16 {
            let bytes: Vec<u8> = high.iter().flat_map(|v| v.to_le_bytes()).collect();
            alpha_out.write_all(&bytes).map_err(|e| e.to_string())?;
        } else {
            alpha_out
                .write_all(&result.matte.alpha)
                .map_err(|e| e.to_string())?;
        }
        let png = format!("frame-{frame:06}.png");
        write_new(&root.join(&png), &encode_roto_edge_alpha_png_v2(&result)?)?;
        frames.push(AutoRotoFrameV2 {
            frame,
            time: frame as f64 / fps,
            alpha_path: png,
            confidence: result.matte.confidence,
            manual_pixels_restored: restored,
            edge_refinement: result.receipt,
        });
        previous = Some((coarse, result.alpha_f32));
        eprintln!("ROTO_V2_PROGRESS {}/{}", frame + 1, count);
    }
    rgb_out
        .sync_all()
        .and_then(|_| alpha_out.sync_all())
        .map_err(|e| e.to_string())?;
    if sha256_file(&raw_path)? != source_sha {
        return Err("v2 raw source changed during analysis".into());
    }
    let receipt = AutoRotoReceiptV2 {
        schema: "editkin.auto-roto-matte/v2",
        engine: AUTO_ROTO_V2_ENGINE,
        quality_state: "diagnostic",
        sample_time_kind: "analysis-grid-not-decoder-pts",
        width,
        height,
        frame_count: count,
        analysis_fps: fps,
        initial_frame,
        source_raw_sha256: source_sha,
        alpha_format: if settings.alpha16 { "gray16le" } else { "gray" },
        alpha_path: alpha_name,
        straight_rgb_path: "foreground.rgb24",
        alpha_bytes: total as u64 * alpha_width,
        straight_rgb_bytes: raw_bytes,
        coarse_engine: coarse_receipt.engine,
        coarse_routing: coarse_receipt.region_memory_routing,
        correction_strokes_applied: coarse_receipt.correction_strokes_applied,
        corrected_frames: coarse_receipt.corrected_frames,
        edge_settings: settings,
        frames,
    };
    write_new(
        &root.join("matte-v2-manifest.json"),
        &serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
    )?;
    Ok(receipt)
}

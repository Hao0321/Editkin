//! Actual no-window DX12 attachment reuse controls, not film/art/GUI acceptance.
use super::*;
use hao_core::engine::composite::LinearRgba;
use crate::engine_graph::{EngineDisplayTransform, EngineVideoDepthOfFieldPlan};

#[test]
#[ignore = "actual Windows DX12 controlled 90-frame readback; run explicitly"]
fn offscreen_resource_reuse_90_frames_equal_fresh_attachments() -> Result<()> {
    let output = std::env::var("EDITKIN_REUSE_TEST_OUTPUT")?;
    let output = Path::new(&output);
    fs::create_dir_all(output)?;
    let engine = GpuCompositor::new_dx12_video()?;
    let (w, h) = (960, 540);
    let surface = NativePreviewSurface::offscreen(&engine, w, h, NativePreviewColorSpace::SdrAuto)?;
    assert!(surface.is_offscreen());
    assert!(surface.window.is_none() && surface.surface.is_none());
    let source = engine.device.create_texture_with_data(&engine.queue, &wgpu::TextureDescriptor {
        label: Some("owned reuse corner fixture"), size: wgpu::Extent3d { width: 2, height: 2, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, wgpu::util::TextureDataOrder::LayerMajor,
        &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    let paint_frame = |transparent: bool| FloatFrame {
        width: w, height: h,
        pixels: (0..w*h).map(|i| {
            let (x, y) = (i % w, i / w);
            let a = if transparent || x < w/5 || x > w*4/5 || y < h/8 || y > h/4 { 0.0 } else { 0.65 };
            LinearRgba { r: a * x as f32 / w as f32, g: a * 0.2, b: a, a }
        }).collect(),
    };
    let paint = ResidentOverlayTexture::upload_display_linear_premultiplied(&engine, &paint_frame(false))?;
    let transparent = ResidentOverlayTexture::upload_display_linear_premultiplied(&engine, &paint_frame(true))?;
    let spec: hao_core::engine::floating_video_frame::FloatingVideoFrameSpec = serde_json::from_value(serde_json::json!({
        "schema":"editkin.native-floating-video-frame/v1",
        "frame":{"schema":"editkin.floating-video-frame/v2","style":"matte","aspect":"source",
          "mediaFit":"contain","size":0.58,"yawDegrees":-9,"pitchDegrees":2,
          "motion":{"entranceFrames":6,"exitFrames":6,"travelY":0.012}},
        "source":{"width":2,"height":2,"displayAspectRatio":1.0},
        "timeline":{"timelineStartFrame":0,"sourceStartFrame":0,"durationFrames":90},
        "canvasWidth":w,"canvasHeight":h,"timebase":{"numerator":1,"denominator":30}
    }))?;
    let lens = EngineVideoDepthOfFieldPlan {
        contract: "editkin.depth-of-field/v1", node_id: "controlled-reuse-lens".into(),
        focus_distance: 3.0, aperture: 2.8, max_blur_radius: 3.0, near: 0.1, far: 100.0,
        execution_mode: scene_depth_of_field::EXECUTION_MODE, depth_source: "depth32_float",
        executor: "wgpu-depth-aware-gather/v1", pass_count: 1, animation_contract: "none",
        keyframe_count: 0, sampled_timeline_frame: 0, keyframes: Vec::new(),
    };
    let transform = EngineDisplayTransform::Aces2Rec709Sdr;
    let mut observations = Vec::new();
    let mut first_a = None;
    for frame in 0..90_i64 {
        // Includes A→B→A, paint 0/1/2, transparent suffix, adjustments and depth/DoF.
        let mode = frame % 9;
        let mut visual = crate::engine_graph::EngineVideoVisualPlan::default();
        if (1..=5).contains(&mode) { visual.floating_frame = Some(spec.clone()); visual.finalize_floating(frame)?; }
        let mut style = crate::video_visual_style(&visual).with_source_dimensions(2, 2);
        style.source_color_contract = 1.0;
        if mode >= 7 {
            style.projective_enabled = 1.0;
            style.projective_h0 = 1.0; style.projective_h4 = 1.0;
            style.scene_depth_enabled = 1; style.source_alpha_mode = 1;
            style.scene_depth_c = 0.3;
        }
        let mut layers = vec![VideoSurfaceLayer { source: &source, temporal_sources: None,
            source_width: 2, source_height: 2, style, matte: None, display_referred: false }];
        if (2..=5).contains(&mode) { layers.push(paint.surface_layer()); }
        if (3..=5).contains(&mode) { layers.push(if mode == 5 { transparent.surface_layer() } else { paint.surface_layer() }); }
        let adjustments = if mode == 4 { vec![VideoVisualStyle { exposure: 0.5, ..Default::default() }] } else { Vec::new() };
        let split = if adjustments.is_empty() { None } else { Some(1) };
        let dof = if mode == 8 { Some(&lens) } else { None };
        let reference = output.join(format!("fresh-{frame:03}.png"));
        let reused = output.join(format!("resident-{frame:03}.png"));
        let mut receipts = Vec::new();
        // Alternating order prevents always measuring one path after the other.
        for reuse in if frame % 2 == 0 { [false, true] } else { [true, false] } {
            let start = std::time::Instant::now();
            let path = if reuse { &reused } else { &reference };
            let receipt = if reuse {
                surface.verify_scene_linear_aces2_layers(&engine, transform, &layers, &adjustments, split, dof, w, h, path)?
            } else {
                surface.verify_scene_linear_aces2_layers_with_resources(&engine, transform, &layers, &adjustments, split, dof, w, h, path, false)?
            };
            assert_eq!(receipt["verificationFullFrameTextureCreations"], if reuse { 0 } else { 6 });
            assert_eq!(receipt["verificationAdditionalResidentBytes"], 0);
            assert_eq!(receipt["offscreen"], true);
            assert_eq!(receipt["nativeSurfacePresented"], false);
            receipts.push(serde_json::json!({"reuse":reuse,"elapsedMs":start.elapsed().as_secs_f64()*1000.0,"receipt":receipt}));
        }
        let fresh = image::open(&reference)?.to_rgba8().into_raw();
        let pixels = image::open(&reused)?.to_rgba8().into_raw();
        assert_eq!(fresh.len(), (w*h*4) as usize);
        assert_eq!(pixels, fresh, "full-frame pixel mismatch at {frame}/{mode}");
        // The comparator must catch a one-channel defect, not merely read receipts.
        let mut corrupted = pixels.clone(); corrupted[0] ^= 1;
        assert_ne!(fresh, corrupted);
        if mode == 0 {
            if let Some(a) = &first_a { assert_eq!(&pixels, a, "A→B→A retained prior framebuffer state"); }
            else { first_a = Some(pixels); }
        }
        observations.push(serde_json::json!({"frame":frame,"mode":mode,"completeRgbaEqual":true,"receipts":receipts}));
    }
    let protected_output = output.join("resident-089.png");
    let before = fs::read(&protected_output)?;
    let plain = VideoSurfaceLayer { source: &source, temporal_sources: None, source_width: 2, source_height: 2,
        style: VideoVisualStyle::default().with_source_dimensions(2,2), matte: None, display_referred: false };
    assert!(surface.verify_scene_linear_aces2_layers(&engine, transform, &[plain], &[], None, None, w-1, h, &protected_output).unwrap_err().to_string().contains("dimensions must match"));
    assert!(surface.verify_scene_linear_aces2_layers(&engine, transform, &[], &[], None, None, w, h, &protected_output).unwrap_err().to_string().contains("at least one layer"));
    let wrong = NativePreviewSurface::offscreen(&engine, w, h, NativePreviewColorSpace::SdrRec709V2)?;
    assert!(wrong.verify_scene_linear_aces2_layers(&engine, transform, &[], &[], None, None, w, h, &protected_output).unwrap_err().to_string().contains("requires"));
    assert_eq!(fs::read(&protected_output)?, before, "rejection overwrote the previous output");
    assert_eq!(surface.present_count, 0);
    fs::write(output.join("PIXEL_RESULT.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "status":"PASS", "adapter":engine.adapter_name,"backend":engine.backend,
        "width":w,"height":h,"frames":90,"nativeWindowCreated":false,
        "fullRgbaMismatchCount":0,"freshTextureCreations":540,"reusedTextureCreations":0,
        "newResidentBytes":0,"completeResourceBudgetMeasured":false,"productionFilmPerformanceMeasured":false,
        "controls":["same pixels accepts","one channel differs rejects","A-B-A clears","wrong dimensions rejects","wrong format rejects","empty layers rejects","previous output preserved"],
        "observations":observations
    }))?)?;
    Ok(())
}

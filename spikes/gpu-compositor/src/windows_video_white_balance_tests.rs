//! Hardware tests of the production DX12 pipelines. No application window is shown,
//! no project is opened, and no installed/canonical executable is replaced.
use super::*;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const W: u32 = 16;
const H: u32 = 16;

fn inverse_709(x: f64) -> f64 { if x < 0.081 { x / 4.5 } else { ((x + 0.099) / 1.099).powf(1.0 / 0.45) } }
fn forward_709(x: f64) -> f64 { if x < 0.018 { x * 4.5 } else { 1.099 * x.powf(0.45) - 0.099 } }
fn srgb_output(x: f64) -> u8 { let x = x.clamp(0.0, 1.0); ((if x <= 0.0031308 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }) * 255.0).round() as u8 }
fn analytic(rgb: [u8; 4], stops: [f32; 3]) -> [f64; 3] {
    std::array::from_fn(|i| forward_709(inverse_709(rgb[i] as f64 / 255.0) * 2_f64.powf(stops[i] as f64)))
}
fn rgba_texture(compositor: &GpuCompositor, pixel: [u8; 4]) -> wgpu::Texture {
    let texture = compositor.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("owned native WB RGBA fixture"), size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
    });
    compositor.queue.write_texture(texture.as_image_copy(), &pixel.repeat((W * H) as usize), wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(W * 4), rows_per_image: Some(H) }, texture.size());
    texture
}
fn layer(source: &wgpu::Texture, style: VideoVisualStyle) -> VideoSurfaceLayer<'_> {
    VideoSurfaceLayer { source, temporal_sources: None, source_width: W, source_height: H, style, matte: None }
}
fn pixel(path: &Path) -> [u8; 4] { image::open(path).unwrap().to_rgba8().get_pixel(W / 2, H / 2).0 }
fn close(actual: [u8; 4], expected: [u8; 4], tolerance: u8, label: &str) {
    assert!(actual.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= tolerance), "{label}: actual {actual:?}, expected {expected:?}, tolerance {tolerance}");
}
fn ffmpeg_rgb(input: [u8; 4], stops: [f32; 3]) -> [u8; 4] {
    let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/ffmpeg/win32-x64/ffmpeg.exe");
    let expr = |channel: &str, stop: f32| {
        let x = format!("{channel}(X,Y)");
        let linear = format!("if(lt({x},0.081),{x}/4.5,pow(({x}+0.099)/1.099,1/0.45))*pow(2,{stop})");
        format!("st(0,{linear});if(lt(ld(0),0.018),4.5*ld(0),1.099*pow(ld(0),0.45)-0.099)")
    };
    let filter = format!("format=gbrpf32le,geq=r='{}':g='{}':b='{}',format=rgba", expr("r", stops[0]), expr("g", stops[1]), expr("b", stops[2]));
    let mut child = Command::new(ffmpeg).args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "16x16", "-i", "pipe:0", "-vf", &filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(&input.repeat((W * H) as usize)).unwrap();
    let output = child.wait_with_output().unwrap(); assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(output.stdout.len(), (W * H * 4) as usize);
    output.stdout[0..4].try_into().unwrap()
}

fn read_scene_center(compositor: &GpuCompositor, surface: &NativePreviewSurface, source: &wgpu::Texture, style: VideoVisualStyle) -> [f64; 4] {
    let target = compositor.device.create_texture(&wgpu::TextureDescriptor { label: Some("owned linear WB readback"), size: source.size(), mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let style_buffer = compositor.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("owned linear WB style"), contents: bytemuck::bytes_of(&style), usage: wgpu::BufferUsages::UNIFORM });
    let staging = compositor.device.create_buffer(&wgpu::BufferDescriptor { label: Some("owned linear WB staging"), size: 256 * H as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = compositor.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    surface.encode_scene_linear_layer(compositor, source, None, &style_buffer, None, &style_buffer, &surface.scene_linear_black_texture, &target.create_view(&Default::default()), W, H, &mut encoder);
    encoder.copy_texture_to_buffer(target.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: Some(H) } }, target.size());
    compositor.queue.submit([encoder.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    staging.slice(..).map_async(wgpu::MapMode::Read, move |result| { tx.send(result).unwrap(); });
    compositor.device.poll(wgpu::PollType::wait_indefinitely()).unwrap(); rx.recv().unwrap().unwrap();
    let mapped = staging.slice(..).get_mapped_range().unwrap();
    let offset = H as usize / 2 * 256 + W as usize / 2 * 8;
    let output = std::array::from_fn(|i| {
        let bits = u16::from_le_bytes(mapped[offset+i*2..offset+i*2+2].try_into().unwrap());
        let sign = if bits & 0x8000 == 0 { 1.0 } else { -1.0 }; let exponent = (bits >> 10) & 31; let mantissa = bits & 1023;
        assert_ne!(exponent, 31, "native scene output must be finite");
        sign * if exponent == 0 { mantissa as f64 * 2_f64.powi(-24) } else { (1.0 + mantissa as f64 / 1024.0) * 2_f64.powi(exponent as i32 - 15) }
    });
    drop(mapped); staging.unmap(); output
}

fn owned_mf_fixture(compositor: &GpuCompositor, surface: &NativePreviewSurface, output: &Path, style: VideoVisualStyle) -> serde_json::Value {
    let path = output.join("strong-137-128-119.mp4");
    let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/ffmpeg/win32-x64/ffmpeg.exe");
    // Lossless x264 advertises High 4:4:4 Predictive even with 4:2:0 input; MF does not
    // decode that profile here. Use a real supported High-profile SDR fixture, then pin
    // actual decoded bytes rather than pretending codec output equals authored RGB.
    let mut child = Command::new(ffmpeg).args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "64x64", "-framerate", "30", "-i", "pipe:0", "-frames:v", "30", "-vf", "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p", "-c:v", "libx264", "-crf", "1", "-profile:v", "high", "-bf", "0", "-g", "1", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"])
        .arg(&path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(&[137_u8,128,119,255].repeat(64*64*30)).unwrap();
    let encode = child.wait_with_output().unwrap(); assert!(encode.status.success(), "{}", String::from_utf8_lossy(&encode.stderr));
    let mut decoder = VideoInteropSession::open(compositor, &path).unwrap();
    let staged = decoder.stage_at(compositor, 0.0, 0.018).unwrap().unwrap();
    let slot = staged["frameRingSlot"].as_u64().unwrap() as usize;
    let frame = decoder.staged_surface_layer(slot, VideoVisualStyle::default().with_source_dimensions(64,64)).unwrap();
    let (_, rgba) = consume_bgra_with_wgpu(compositor, frame.source, 64,64).unwrap();
    let point = (8*64+8)*4;
    let pinned: [u8;4] = rgba[point..point+4].try_into().unwrap();
    super::super::save_rgba(&output.join("mf-pinned-before.png"), rgba.clone(), 64,64).unwrap();
    let zero_path = output.join("mf-v2-zero.png");
    surface.verify_texture(compositor, frame.source, 64,64,VideoVisualStyle::default().with_source_dimensions(64,64),None,&zero_path).unwrap();
    let zero_actual = pixel(&zero_path);
    close(zero_actual,pinned,1,"v2 zero preserves pinned MF source without an added transfer");
    let zero_pixels = image::open(&zero_path).unwrap().to_rgba8().into_raw();
    assert_eq!(zero_pixels,rgba,"v2 zero full-frame source byte fidelity");
    let independently_decoded = Command::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/ffmpeg/win32-x64/ffmpeg.exe"))
        .args(["-v","error","-i"]).arg(&path).args(["-frames:v","1","-vf","scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgba","-f","rawvideo","-pix_fmt","rgba","pipe:1"]).output().unwrap();
    assert!(independently_decoded.status.success(),"{}",String::from_utf8_lossy(&independently_decoded.stderr));
    assert_eq!(independently_decoded.stdout.len(),64*64*4);
    let decoded: [u8;4] = independently_decoded.stdout[point..point+4].try_into().unwrap();
    let errors = zero_pixels.iter().zip(&independently_decoded.stdout).enumerate().filter_map(|(i,(a,b))| (i%4!=3).then_some(a.abs_diff(*b))).collect::<Vec<_>>();
    let zero_mean = errors.iter().map(|value|*value as f64).sum::<f64>()/errors.len() as f64;
    let zero_max = *errors.iter().max().unwrap();
    close(zero_actual,decoded,6,"v2 zero versus independent FFmpeg source decode");
    assert!(zero_mean<=2.0,"v2 zero RGB mean error {zero_mean}; actual {zero_actual:?}, decoded {decoded:?}");
    assert!(zero_max<=6,"v2 zero full-frame maximum source error {zero_max}");
    let actual_path = output.join("mf-v2-wb.png");
    surface.verify_texture(compositor, frame.source, 64,64, style.with_source_dimensions(64,64), None, &actual_path).unwrap();
    let expected = ffmpeg_rgb(pinned, [style.white_balance_red,style.white_balance_green,style.white_balance_blue]);
    let actual = pixel(&actual_path);
    close(actual, expected, 2, "actual MF decoded frame / independent FFmpeg");
    let mean = actual[..3].iter().zip(expected).map(|(a,b)| a.abs_diff(b) as f64).sum::<f64>() / 3.0;
    assert!(mean <= 2.0);
    let next = decoder.stage_at(compositor, 1.0/30.0, 0.018).unwrap().unwrap();
    assert_eq!(staged["timestampSeconds"], 0.0);
    assert!((next["timestampSeconds"].as_f64().unwrap()-1.0/30.0).abs()<0.0000001);
    assert_eq!(staged["clockWithinTolerance"],true); assert_eq!(next["clockWithinTolerance"],true);
    let cleanup = decoder.flush_staged_fences(compositor).unwrap();
    serde_json::json!({"input":path,"authoredRgba":[137,128,119,255],"samplePixel":[8,8],"pinnedMfDecodedRgba":pinned,"zeroNativeRgba":zero_actual,"independentDecodedRgba":decoded,"zeroFullFrameMeanAbsoluteRgbError":zero_mean,"zeroFullFrameMaxAbsoluteRgbError":zero_max,"nativeRgba":actual,"ffmpegRgba":expected,"meanAbsoluteRgbError":mean,"firstFrame":staged,"nextFrame":next,"cleanup":cleanup})
}

#[test]
#[ignore = "requires actual Windows DX12 GPU and local FFmpeg; run explicitly with --ignored"]
fn native_white_balance_production_gpu_pixels() {
    let output = std::env::temp_dir().join(format!("editkin-owned-native-wb-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir(&output).unwrap();
    println!("NATIVE_WB_EVIDENCE={}", output.display());
    let compositor = GpuCompositor::new_dx12_video().unwrap();
    let mut legacy = NativePreviewSurface::bind(&compositor, 0, -32000, -32000, W, H, NativePreviewColorSpace::SdrAuto).unwrap();
    let surface = NativePreviewSurface::bind(&compositor, 0, -32000, -32000, W, H, NativePreviewColorSpace::SdrRec709V2).unwrap();
    assert!(!surface.visible); assert_eq!(surface.present_count, 0);
    assert_eq!(surface.configuration.format, wgpu::TextureFormat::Bgra8Unorm);
    let base = VideoVisualStyle::default().with_source_dimensions(W, H);
    let input = [96, 128, 160, 255]; let stops = [1.0, -0.5, -1.0];
    let source = rgba_texture(&compositor, input);
    let oracle = analytic(input, stops);
    let independent = ffmpeg_rgb(input, stops);
    close(independent, [ (oracle[0] * 255.0).round() as u8, (oracle[1] * 255.0).round() as u8, (oracle[2] * 255.0).round() as u8, 255], 1, "independent FFmpeg / analytic");
    let corrected = rgba_texture(&compositor, independent);
    let wb = VideoVisualStyle { white_balance_red: stops[0], white_balance_green: stops[1], white_balance_blue: stops[2], ..base };
    let zero_path = output.join("single-zero.png");
    legacy.verify_texture(&compositor, &source, W, H, base, None, &zero_path).unwrap();
    close(pixel(&zero_path), [srgb_output(input[0] as f64 / 255.0), srgb_output(input[1] as f64 / 255.0), srgb_output(input[2] as f64 / 255.0), 255], 1, "legacy zero route");
    let current_zero_path=output.join("single-v2-zero.png");
    surface.verify_texture(&compositor,&source,W,H,base,None,&current_zero_path).unwrap();
    close(pixel(&current_zero_path),input,1,"explicit v2 zero no added OETF");
    let legacy_mean=pixel(&zero_path)[..3].iter().zip(input).map(|(a,b)|a.abs_diff(b) as f64).sum::<f64>()/3.0;
    assert!(legacy_mean>6.0,"retained legacy v1 must fail new source-fidelity threshold");
    let wb_path = output.join("single-wb.png");
    let receipt = surface.verify_texture(&compositor, &source, W, H, wb, None, &wb_path).unwrap();
    close(pixel(&wb_path), [(oracle[0]*255.0).round() as u8, (oracle[1]*255.0).round() as u8, (oracle[2]*255.0).round() as u8, 255], 1, "production single / independent analytic");
    assert_eq!(receipt["visualGraph"]["whiteBalanceRed"], 1.0);
    let oracle_path = output.join("single-ffmpeg-oracle.png");
    surface.verify_texture(&compositor, &corrected, W, H, base, None, &oracle_path).unwrap();
    close(pixel(&wb_path), pixel(&oracle_path), 2, "production single / independent FFmpeg");
    // Calibrate: multiplying encoded bytes is observably the wrong operation.
    let wrong = std::array::from_fn::<u8, 4, _>(|i| if i == 3 { 255 } else { (input[i] as f64 * 2_f64.powf(stops[i] as f64)).round().clamp(0.0,255.0) as u8 });
    assert!(pixel(&wb_path).iter().zip(wrong).any(|(a,b)| a.abs_diff(b) > 10));
    let background = rgba_texture(&compositor, [40, 72, 24, 255]);
    let semi = VideoVisualStyle { opacity: 0.6, ..wb };
    let semizero = VideoVisualStyle { opacity: 0.6, ..base };
    let fused = output.join("fused-wb.png"); let fused_oracle = output.join("fused-ffmpeg-oracle.png");
    let transparent = VideoVisualStyle { opacity: 0.0, ..base };
    let fused_receipt = surface.verify_layers_with_adjustments(&compositor, &[layer(&background, base), layer(&background, transparent), layer(&background, transparent), layer(&source, semi)], &[], None, W, H, &fused).unwrap();
    surface.verify_layers_with_adjustments(&compositor, &[layer(&background, base), layer(&background, transparent), layer(&background, transparent), layer(&corrected, semizero)], &[], None, W, H, &fused_oracle).unwrap();
    assert_eq!(fused_receipt["compositeExecutionMode"], "fused-four-layer/v1"); close(pixel(&fused), pixel(&fused_oracle), 2, "production fused / FFmpeg");
    let mut masked = layer(&background, VideoVisualStyle { matte_mode: 3, ..base });
    masked.matte = Some(VideoSurfaceMatte { source: &source, style: wb });
    let matte = output.join("luma-matte-wb.png"); let matte_oracle = output.join("luma-matte-ffmpeg-oracle.png");
    let matte_receipt = surface.verify_layers_with_adjustments(&compositor, &[masked], &[], None, W, H, &matte).unwrap();
    masked.matte = Some(VideoSurfaceMatte { source: &corrected, style: base });
    surface.verify_layers_with_adjustments(&compositor, &[masked], &[], None, W, H, &matte_oracle).unwrap();
    assert_eq!(matte_receipt["mattePassCount"], 1); close(pixel(&matte), pixel(&matte_oracle), 2, "production luma matte / FFmpeg");
    let adjustment = output.join("adjustment-wb.png");
    surface.verify_layers_with_adjustments(&compositor, &[layer(&source, base)], &[wb], None, W, H, &adjustment).unwrap();
    close(pixel(&adjustment), pixel(&wb_path), 2, "production trailing adjustment / single");
    // Two extreme bounded stops remain finite and match the independent optical equations.
    for stop in [-4.0, 4.0] {
        let style = VideoVisualStyle { white_balance_red: stop, white_balance_green: stop, white_balance_blue: stop, ..base };
        let path = output.join(format!("extreme-{stop}.png"));
        surface.verify_texture(&compositor, &source, W, H, style, None, &path).unwrap();
        let expected = analytic(input, [stop; 3]); close(pixel(&path), [(expected[0]*255.0).round().clamp(0.0,255.0) as u8, (expected[1]*255.0).round().clamp(0.0,255.0) as u8, (expected[2]*255.0).round().clamp(0.0,255.0) as u8, 255], 1, "extreme bounded gains");
    }
    let scene_path = output.join("aces-input709-wb.png");
    let scene_style = VideoVisualStyle { source_color_contract: 2.0, ..wb };
    let scene_receipt = legacy.verify_scene_linear_aces2_layers(&compositor, crate::engine_graph::EngineDisplayTransform::Aces2Rec709Sdr, &[layer(&source, scene_style)], &[], None, None, W, H, &scene_path).unwrap();
    assert_eq!(scene_receipt["inputTransform"], "editkin-rec709-to-linear-rec709-primary/v2");
    assert_eq!(scene_receipt["visualLayers"][0]["inputTransfer"], 2.0);
    let scene_linear = read_scene_center(&compositor, &legacy, &source, scene_style);
    for i in 0..3 { let expected = inverse_709(input[i] as f64/255.0) * 2_f64.powf(stops[i] as f64); assert!((scene_linear[i]-expected).abs() < 0.0007, "linear channel{i}: {scene_linear:?}, expected{expected}"); }
    assert_eq!(scene_linear[3], 1.0);
    let premult = rgba_texture(&compositor, [48,64,80,128]);
    let premult_linear = read_scene_center(&compositor, &legacy, &premult, VideoVisualStyle { source_alpha_mode:2, ..scene_style });
    for i in 0..3 { let expected = inverse_709([48.0,64.0,80.0][i]/128.0) * 2_f64.powf(stops[i] as f64) *128.0/255.0; assert!((premult_linear[i]-expected).abs()<0.0007, "straight-alpha linear channel{i}: {premult_linear:?}"); }
    let overlay_pixel = [170_u8,90,35,255];
    let overlay = ResidentOverlayTexture::upload(&compositor, W,H,&overlay_pixel.repeat((W*H) as usize)).unwrap();
    let overlay_path = output.join("v2-coloured-overlay.png");
    surface.verify_layers_with_adjustments(&compositor, &[overlay.surface_layer()], &[], None,W,H,&overlay_path).unwrap();
    close(pixel(&overlay_path), overlay_pixel,1,"sRGB uploaded overlay preserves authored bytes in v2");
    let neutral = VideoVisualStyle { white_balance_red: 0.8982097402389128_f64.log2() as f32, white_balance_green: 1.0196604077256723_f64.log2() as f32, white_balance_blue: 1.1664547062421933_f64.log2() as f32, ..base };
    let strong_source = rgba_texture(&compositor,[137,128,119,255]);
    let strong_path = output.join("strong-exact-v2-neutral.png");
    surface.verify_texture(&compositor,&strong_source,W,H,neutral,None,&strong_path).unwrap();
    close(pixel(&strong_path),[129,129,129,255],1,"strong declared neutral reference");
    let mf = owned_mf_fixture(&compositor,&surface,&output,neutral);
    // Exercise the same profile transition called by present/verify, without showing it.
    legacy.select_rec709_output_contract(&compositor,true).unwrap();
    let switched = output.join("profile-switch-v2.png");
    legacy.verify_texture(&compositor,&source,W,H,wb,None,&switched).unwrap();
    close(pixel(&switched),pixel(&wb_path),0,"v2 profile selection");
    legacy.select_rec709_output_contract(&compositor,false).unwrap();
    let restored = output.join("profile-switch-v1-restored.png");
    legacy.verify_texture(&compositor,&source,W,H,base,None,&restored).unwrap();
    assert_eq!(std::fs::read(restored).unwrap(),std::fs::read(&zero_path).unwrap(),"explicit v1 compatibility bytes after profile switch");
    assert!(!legacy.visible); assert_eq!(legacy.present_count,0);
    assert!(!surface.visible); assert_eq!(surface.present_count, 0);
    let report = serde_json::json!({"status":"PASS","adapter":format!("{:?}", compositor.adapter.get_info()),"surface":surface.description(),"inputRgba":input,"legacyV1ZeroRgba":pixel(&zero_path),"legacyV1MeanSourceError":legacy_mean,"v2ZeroRgba":pixel(&current_zero_path),"stops":stops,"independentFfmpegRgba":independent,"analyticEncoded709":oracle,"singleRgba":pixel(&wb_path),"fusedRgba":pixel(&fused),"matteRgba":pixel(&matte),"adjustmentRgba":pixel(&adjustment),"acesReceipt":scene_receipt,"sceneLinearReadback":scene_linear,"premultipliedReadback":premult_linear,"mediaFoundation":mf,"boundaries":["owned hidden source-test window only; no presentation", "not packaged application acceptance", "HDR/EXR/native high-range creative pipeline not admitted", "legacy v1 SDR surface remains brighter; not a quality pass"]});
    let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(output.join("report.json")).unwrap();
    file.write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes()).unwrap();
    println!("{}", serde_json::to_string(&report).unwrap());
}

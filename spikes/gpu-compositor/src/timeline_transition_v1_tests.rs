use super::*;
use crate::GpuCompositor;
use anyhow::Context;

fn native_pair_device() -> Result<GpuCompositor> {
    #[cfg(windows)] { GpuCompositor::new_dx12_video() }
    #[cfg(not(windows))] { GpuCompositor::new() }
}

fn input(engine: &GpuCompositor, width: u32, height: u32, pixels: &[[f32; 4]]) -> wgpu::Texture {
    engine.device.create_texture_with_data(&engine.queue, &wgpu::TextureDescriptor {
        label: Some("owned paired F32 source"), size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, wgpu::util::TextureDataOrder::LayerMajor, bytemuck::cast_slice(pixels))
}
fn output(engine: &GpuCompositor, width: u32, height: u32) -> wgpu::Texture {
    engine.device.create_texture(&wgpu::TextureDescriptor { label: Some("owned pair F32 target"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] })
}
fn decode_half(bits: u16) -> f32 {
    let sign = if bits & 0x8000 == 0 { 1.0 } else { -1.0 }; let exponent = (bits >> 10) & 31; let fraction = bits & 1023;
    if exponent == 0 { sign * f32::from(fraction) * 2.0_f32.powi(-24) }
    else if exponent == 31 { if fraction == 0 { sign * f32::INFINITY } else { f32::NAN } }
    else { sign * (1.0 + f32::from(fraction)/1024.0) * 2.0_f32.powi(i32::from(exponent)-15) }
}
fn read(engine: &GpuCompositor, texture: &wgpu::Texture) -> Result<Vec<[f32; 4]>> {
    let width = texture.width(); let height = texture.height();
    let pixel_bytes = if texture.format() == wgpu::TextureFormat::Rgba16Float { 8 } else { 16 };
    let row = (width * pixel_bytes).div_ceil(256) * 256;
    let staging = engine.device.create_buffer(&wgpu::BufferDescriptor { label: Some("owned pair readback"),
        size: u64::from(row) * u64::from(height), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = engine.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(height) } }, texture.size());
    engine.queue.submit([encoder.finish()]);
    let slice = staging.slice(..); let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| { let _ = sender.send(result); });
    engine.device.poll(wgpu::PollType::wait_indefinitely()).context("poll pair readback")?;
    receiver.recv().context("pair map callback")??;
    let mapped = slice.get_mapped_range().context("pair mapped range")?; let mut pixels = Vec::new();
    for line in mapped.chunks_exact(row as usize).take(height as usize) {
        for pixel in line[..width as usize * pixel_bytes as usize].chunks_exact(pixel_bytes as usize) {
            pixels.push(std::array::from_fn(|c| if pixel_bytes == 8 { decode_half(u16::from_le_bytes(pixel[c*2..c*2+2].try_into().unwrap())) }
                else { f32::from_le_bytes(pixel[c * 4..c * 4 + 4].try_into().unwrap()) }));
        }
    }
    drop(mapped); staging.unmap(); Ok(pixels)
}
// Independent double-precision coverage reference using the actual uniform u.
fn reference(a: [f32; 4], b: [f32; 4], u: f32, kernel: TransitionKernelV1) -> [f64; 4] {
    let u = f64::from(u); if u == 0.0 { return if a[3] == 0.0 { [0.0; 4] } else { a.map(f64::from) }; }
    if u == 1.0 { return if b[3] == 0.0 { [0.0; 4] } else { b.map(f64::from) }; }
    let (wa, wb, black) = match kernel { TransitionKernelV1::Dissolve => (1.0-u, u, 0.0),
        TransitionKernelV1::Dip if u < 0.5 => (1.0-2.0*u, 0.0, 2.0*u), TransitionKernelV1::Dip => (0.0, 2.0*u-1.0, 2.0-2.0*u) };
    let wa = wa * f64::from(a[3]); let wb = wb * f64::from(b[3]); let alpha = wa + wb + black;
    if alpha == 0.0 { return [0.0; 4]; }
    [0, 1, 2, 3].map(|c| if c == 3 { alpha } else { (wa*f64::from(a[c])+wb*f64::from(b[c]))/alpha })
}
fn assert_pixels(actual: &[[f32; 4]], a: &[[f32; 4]], b: &[[f32; 4]], u: f32, kernel: TransitionKernelV1) {
    assert_pixels_precision(actual, a, b, u, kernel, 5e-7);
}
fn assert_pixels_precision(actual: &[[f32; 4]], a: &[[f32; 4]], b: &[[f32; 4]], u: f32, kernel: TransitionKernelV1, rgb_precision: f64) {
    assert_eq!(actual.len(), a.len());
    for (index, value) in actual.iter().enumerate() {
        let want = reference(a[index], b[index], u, kernel);
        for c in 0..4 {
            assert!(value[c].is_finite(), "nonfinite pixel {index}/{c}");
            let error = (f64::from(value[c])-want[c]).abs();
            let bound = if c == 3 { 1e-7 } else { rgb_precision * want[c].abs().max(1.0) };
            assert!(error <= bound, "{kernel:?} u={u} pixel={index}/{c} actual={} expected={} error={error} bound={bound}", value[c], want[c]);
            if u == 0.0 || u == 1.0 { assert_eq!(f64::from(value[c]), want[c], "exact endpoint {index}/{c}"); }
        }
    }
}
#[test]
fn real_gpu_all49_alpha_pairs_hdr_negative_zero_and_stable_dip() -> Result<()> {
    let engine = native_pair_device()?; let pass = TimelineTransitionPassV1::new(&engine.device, wgpu::TextureFormat::Rgba32Float)?;
    println!("PAIR_F32_ADAPTER={:?}", engine.adapter.get_info());
    let levels = [0.0, 1.0/65535.0, 128.0/65535.0, 16384.0/65535.0, 32768.0/65535.0, 49151.0/65535.0, 1.0];
    let a: Vec<_> = (0..49).map(|i| [4.0, -0.01, 0.3, levels[i/7]]).collect();
    let b: Vec<_> = (0..49).map(|i| [0.2, 12.0, 0.7, levels[i%7]]).collect();
    let from = input(&engine, 7, 7, &a); let to = input(&engine, 7, 7, &b); let target = output(&engine, 7, 7);
    for kernel in [TransitionKernelV1::Dissolve, TransitionKernelV1::Dip] {
        for progress in [0.0, 0.00001, 0.25, 0.5, 0.75, 0.99999, 1.0] {
            let mut encoder = engine.device.create_command_encoder(&Default::default());
            pass.encode(&engine.device, &mut encoder, &from, &to, &target, progress, kernel)?;
            engine.queue.submit([encoder.finish()]); assert_pixels(&read(&engine, &target)?, &a, &b, progress as f32, kernel);
        }
    }
    let a = [[1.0, 3.0, 5.0, 1e-16]]; let b = [[8.0, 4.0, 2.0, 0.0]];
    let from = input(&engine, 1, 1, &a); let to = input(&engine, 1, 1, &b); let target = output(&engine, 1, 1);
    let mut encoder = engine.device.create_command_encoder(&Default::default());
    pass.encode(&engine.device, &mut encoder, &from, &to, &target, 1e-16, TransitionKernelV1::Dip)?;
    engine.queue.submit([encoder.finish()]); assert_pixels(&read(&engine, &target)?, &a, &b, 1e-16_f32, TransitionKernelV1::Dip);
    Ok(())
}
#[test]
fn queued_passes_keep_independent_uniform_progress() -> Result<()> {
    let engine = native_pair_device()?; let pass = TimelineTransitionPassV1::new(&engine.device, wgpu::TextureFormat::Rgba32Float)?;
    let a = [[2.0, 0.3, 0.2, 0.25]]; let b = [[0.2, 4.0, 0.8, 0.75]];
    let from = input(&engine, 1, 1, &a); let to = input(&engine, 1, 1, &b);
    let targets: Vec<_> = (0..3).map(|_| output(&engine, 1, 1)).collect();
    let mut encoder = engine.device.create_command_encoder(&Default::default());
    for (target, progress) in targets.iter().zip([0.0, 0.5, 1.0]) { pass.encode(&engine.device, &mut encoder, &from, &to, target, progress, TransitionKernelV1::Dip)?; }
    engine.queue.submit([encoder.finish()]);
    for (target, progress) in targets.iter().zip([0.0, 0.5, 1.0]) { assert_pixels(&read(&engine, target)?, &a, &b, progress, TransitionKernelV1::Dip); }
    Ok(())
}
#[test]
fn actual_texture_contract_and_progress_refusals() -> Result<()> {
    let engine = native_pair_device()?; let pass = TimelineTransitionPassV1::new(&engine.device, wgpu::TextureFormat::Rgba32Float)?;
    assert!(TimelineTransitionPassV1::new(&engine.device, wgpu::TextureFormat::Rgba8Unorm).is_err());
    let a = input(&engine, 1, 1, &[[1.0, 0.0, 0.0, 1.0]]); let b = input(&engine, 1, 1, &[[0.0, 0.0, 1.0, 1.0]]);
    let target = output(&engine, 1, 1); let wrong = output(&engine, 2, 1);
    let mut encoder = engine.device.create_command_encoder(&Default::default());
    assert!(pass.encode(&engine.device, &mut encoder, &a, &b, &wrong, 0.5, TransitionKernelV1::Dissolve).is_err());
    assert!(pass.encode(&engine.device, &mut encoder, &a, &b, &target, f64::NAN, TransitionKernelV1::Dissolve).is_err());
    assert!(pass.encode(&engine.device, &mut encoder, &a, &b, &target, f64::INFINITY, TransitionKernelV1::Dissolve).is_err());
    let alias = target.clone();
    assert!(pass.encode(&engine.device, &mut encoder, &alias, &b, &target, 0.5, TransitionKernelV1::Dissolve).unwrap_err().to_string().contains("TEXTURE_ALIAS_INVALID"));
    Ok(())
}
#[test]
fn real_native_f16_scene_texture_targets_keep_hdr_and_exact_endpoints() -> Result<()> {
    let engine = native_pair_device()?; let pass = TimelineTransitionPassV1::new(&engine.device, wgpu::TextureFormat::Rgba16Float)?;
    println!("PAIR_F16_ADAPTER={:?}", engine.adapter.get_info());
    let f32_pass = TimelineTransitionPassV1::new(&engine.device, wgpu::TextureFormat::Rgba32Float)?;
    let f32_target = output(&engine, 4, 4);
    let levels = [0_u16, 0x3400, 0x3800, 0x3c00];
    let a: Vec<_> = (0..16).map(|i| [0x4400, 0xb800, 0x3400, levels[i/4]]).collect();
    let b: Vec<_> = (0..16).map(|i| [0x3800, 0x4a00, 0x3a00, levels[i%4]]).collect();
    let desc = wgpu::TextureDescriptor { label: Some("owned native F16 paired scene"), size: wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] };
    let from = engine.device.create_texture_with_data(&engine.queue, &desc, wgpu::util::TextureDataOrder::LayerMajor, bytemuck::cast_slice(&a));
    let to = engine.device.create_texture_with_data(&engine.queue, &desc, wgpu::util::TextureDataOrder::LayerMajor, bytemuck::cast_slice(&b));
    let target = engine.device.create_texture(&wgpu::TextureDescriptor { usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, ..desc });
    let a: Vec<_> = a.into_iter().map(|pixel| pixel.map(decode_half)).collect();
    let b: Vec<_> = b.into_iter().map(|pixel| pixel.map(decode_half)).collect();
    for kernel in [TransitionKernelV1::Dissolve, TransitionKernelV1::Dip] {
        for progress in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let mut encoder = engine.device.create_command_encoder(&Default::default());
            f32_pass.encode(&engine.device, &mut encoder, &from, &to, &f32_target, progress, kernel)?;
            pass.encode(&engine.device, &mut encoder, &from, &to, &target, progress, kernel)?;
            engine.queue.submit([encoder.finish()]);
            let f32_pixels = read(&engine, &f32_target)?;
            assert_pixels(&f32_pixels, &a, &b, progress as f32, kernel);
            let f16_pixels = read(&engine, &target)?;
            if progress == 0.5 { println!("PAIR_F16_VERSUS_F32 {kernel:?} pixel7 f32={:?} f16={:?}", f32_pixels[7], f16_pixels[7]); }
            assert_pixels_precision(&f16_pixels, &a, &b, progress as f32, kernel, 1.0/2048.0);
        }
    }
    Ok(())
}

//! Bounded headless controls for the actual resident shader. No HWND or input.
//! Fixture uploads/readback are test-only, not a product preview/performance claim.
use super::*;

fn half_value(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = ((bits >> 10) & 31) as i32;
    let fraction = (bits & 1023) as f32 / 1024.0;
    sign * if exponent == 0 { fraction * 2.0_f32.powi(-14) }
        else { (1.0 + fraction) * 2.0_f32.powi(exponent - 15) }
}

#[test]
fn floating_assembly_actual_headless_shader_contains_and_separates_material() -> Result<()> {
    let engine = GpuCompositor::new()?;
    let device = &engine.device;
    let (width, height) = (128_u32, 192_u32);
    let spec: hao_core::engine::floating_video_frame::FloatingVideoFrameSpec = serde_json::from_value(serde_json::json!({
        "schema":"editkin.native-floating-video-frame/v1",
        "frame":{"schema":"editkin.floating-video-frame/v2","style":"matte","aspect":"portrait",
            "mediaFit":"contain","size":0.65,"yawDegrees":0,"pitchDegrees":0,
            "motion":{"entranceFrames":0,"exitFrames":0,"travelY":0}},
        "source":{"width":160,"height":90,"displayAspectRatio":16.0/9.0},
        "timeline":{"timelineStartFrame":0,"sourceStartFrame":0,"durationFrames":30},
        "canvasWidth":width,"canvasHeight":height,"timebase":{"numerator":1,"denominator":30}
    }))?;
    let mut plan = crate::engine_graph::EngineVideoVisualPlan::default();
    plan.floating_frame = Some(spec.clone()); plan.finalize_floating(15)?;
    let base = crate::video_visual_style(&plan).with_source_dimensions(width, height);
    assert_eq!(std::mem::offset_of!(VideoVisualStyle, floating_panel) % 16, 0);
    assert_eq!(std::mem::size_of::<VideoVisualStyle>() % 16, 0);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("actual resident floating material test shader"),
        source: wgpu::ShaderSource::Wgsl([include_str!("linear_white_balance.wgsl"), include_str!("scene_linear_video.wgsl")].concat().into())
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("headless actual material control"), layout: None,
        vertex: wgpu::VertexState { module:&shader, entry_point:Some("vertex_main"), buffers:&[], compilation_options:Default::default() },
        fragment:Some(wgpu::FragmentState { module:&shader, entry_point:Some("fragment_main"),
            targets:&[Some(wgpu::ColorTargetState { format:wgpu::TextureFormat::Rgba16Float, blend:None, write_mask:wgpu::ColorWrites::ALL })], compilation_options:Default::default() }),
        primitive:Default::default(), depth_stencil:None, multisample:Default::default(), multiview_mask:None, cache:None
    });
    let extent = |w,h| wgpu::Extent3d { width:w,height:h,depth_or_array_layers:1 };
    let mut source_bytes = Vec::with_capacity(160*90*4);
    for y in 0..90 { for x in 0..160 { source_bytes.extend_from_slice(match (x<80,y<45) {
        (true,true)=>&[255,0,0,255], (false,true)=>&[0,255,0,255],
        (true,false)=>&[0,0,255,255], (false,false)=>&[255,255,0,255] }); } }
    let texture = |label, w,h,bytes:&[u8]| device.create_texture_with_data(&engine.queue,&wgpu::TextureDescriptor {
        label:Some(label),size:extent(w,h),mip_level_count:1,sample_count:1,dimension:wgpu::TextureDimension::D2,
        format:wgpu::TextureFormat::Rgba8Unorm,usage:wgpu::TextureUsages::TEXTURE_BINDING,view_formats:&[]
    },wgpu::util::TextureDataOrder::LayerMajor,bytes);
    let source = texture("original DAR corner source",160,90,&source_bytes);
    let empty = texture("transparent material control",1,1,&[0,0,0,0]);
    let source_view = source.create_view(&Default::default()); let empty_view = empty.create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter:wgpu::FilterMode::Linear,min_filter:wgpu::FilterMode::Linear,..Default::default() });
    let render = |mut style:VideoVisualStyle, radial:bool| -> Result<Vec<[f32;4]>> {
        style.source_color_contract=1.0; style.floating_mask[3]=if radial {2.0} else {1.0};
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label:Some("actual floating uniform"),contents:bytemuck::bytes_of(&style),usage:wgpu::BufferUsages::UNIFORM });
        let mut entries = vec![wgpu::BindGroupEntry {binding:0,resource:wgpu::BindingResource::TextureView(&source_view)},
            wgpu::BindGroupEntry {binding:1,resource:wgpu::BindingResource::Sampler(&sampler)},
            wgpu::BindGroupEntry {binding:2,resource:uniform.as_entire_binding()},
            wgpu::BindGroupEntry {binding:3,resource:wgpu::BindingResource::TextureView(&empty_view)},
            wgpu::BindGroupEntry {binding:4,resource:wgpu::BindingResource::TextureView(&empty_view)},
            wgpu::BindGroupEntry {binding:5,resource:uniform.as_entire_binding()}];
        for binding in 6..=12 { entries.push(wgpu::BindGroupEntry {binding,resource:wgpu::BindingResource::TextureView(&source_view)}); }
        let group=device.create_bind_group(&wgpu::BindGroupDescriptor {label:Some("floating material test bindings"),layout:&pipeline.get_bind_group_layout(0),entries:&entries});
        let target=device.create_texture(&wgpu::TextureDescriptor {label:Some("floating material test pixels"),size:extent(width,height),mip_level_count:1,sample_count:1,dimension:wgpu::TextureDimension::D2,
            format:wgpu::TextureFormat::Rgba16Float,usage:wgpu::TextureUsages::RENDER_ATTACHMENT|wgpu::TextureUsages::COPY_SRC,view_formats:&[] });
        let view=target.create_view(&Default::default()); let row=width*8;
        let readback=device.create_buffer(&wgpu::BufferDescriptor {label:Some("test only float readback"),size:(row*height)as u64,usage:wgpu::BufferUsages::COPY_DST|wgpu::BufferUsages::MAP_READ,mapped_at_creation:false});
        let mut encoder=device.create_command_encoder(&Default::default());
        { let mut pass=encoder.begin_render_pass(&wgpu::RenderPassDescriptor {label:Some("actual resident material pass"),color_attachments:&[Some(wgpu::RenderPassColorAttachment {
            view:&view,resolve_target:None,depth_slice:None,ops:wgpu::Operations {load:wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),store:wgpu::StoreOp::Store}})],
            depth_stencil_attachment:None,timestamp_writes:None,occlusion_query_set:None,multiview_mask:None });
            pass.set_pipeline(&pipeline);pass.set_bind_group(0,&group,&[]);pass.draw(0..3,0..1); }
        encoder.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo {texture:&target,mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},
            wgpu::TexelCopyBufferInfo {buffer:&readback,layout:wgpu::TexelCopyBufferLayout {offset:0,bytes_per_row:Some(row),rows_per_image:Some(height)}},extent(width,height));
        engine.queue.submit([encoder.finish()]); let slice=readback.slice(..); let (tx,rx)=std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read,move |result| {let _=tx.send(result);});
        device.poll(wgpu::PollType::wait_indefinitely())?; rx.recv()??;
        let mapped=slice.get_mapped_range()?; let pixels=mapped.chunks_exact(8).map(|p| std::array::from_fn(|i| half_value(u16::from_le_bytes([p[i*2],p[i*2+1]])))).collect();
        drop(mapped);readback.unmap(); Ok(pixels)
    };
    let pixels=render(base,false)?; let radial=render(base,true)?;
    let sample=spec.sample(15).map_err(anyhow::Error::msg)?;
    let pixel=|data:&Vec<[f32;4]>,x:f32,y:f32| data[(y.floor()as u32*width+x.floor()as u32)as usize];
    let [x,y,w,h]=sample.content_rect;
    for (u,v,expected) in [(0.2,0.2,[1.0,0.0,0.0]),(0.8,0.2,[0.0,1.0,0.0]),(0.2,0.8,[0.0,0.0,1.0]),(0.8,0.8,[1.0,1.0,0.0])] {
        let actual=pixel(&pixels,x+u*w,y+v*h);
        for channel in 0..3 { assert!((actual[channel]-expected[channel]).abs()<0.003,"source corner lost {:?} != {:?}",actual,expected); }
        assert!((actual[3]-1.0).abs()<0.003);
    }
    assert_eq!(pixels[0][3],0.0,"later floating layer must not repaint the backdrop");
    assert_eq!(radial[0][3],1.0);assert!(radial[0][0]>0.001,"first floating backdrop must execute");
    let [px,py,pw,ph]=sample.outer_rect;
    let partial=pixel(&pixels,px+0.5,py+ph*0.5)[3];
    assert!(partial>0.0&&partial<0.9,"feather must expose an actual partial-alpha edge: {partial}");
    assert!(pixel(&pixels,px+pw*0.5,py+ph+4.0)[3]>0.0,"external shadow absent");
    if let Ok(output)=std::env::var("EDITKIN_FLOATING_TEST_OUTPUT") {
        let path=Path::new(&output); fs::create_dir_all(path)?;
        let rgba=radial.iter().flat_map(|p| p.iter().map(|v| (v.clamp(0.0,1.0).sqrt()*255.0).round()as u8)).collect();
        crate::save_rgba(&path.join("headless-material-linear-diagnostic.png"),rgba,width,height)?;
        fs::write(path.join("HEADLESS_SHADER_RESULT.json"),serde_json::to_vec_pretty(&serde_json::json!({
            "status":"PASS","scope":"actual production WGSL material with controlled uploaded source; not video decode or GUI",
            "adapter":engine.adapter_name,"backend":engine.backend,"sample":sample,"partialEdgeAlpha":partial,
            "nativeWindowCreated":false,"previewOutputParityMeasured":false,"productArtApproved":false
        }))?)?;
    }
    Ok(())
}

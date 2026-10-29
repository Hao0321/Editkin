use super::*;
use hao_core::engine::timeline_pair_v1::{TimelinePairEndpointV1, TimelinePairSpecV1};
use hao_core::engine::model::NodeFrameRange;

fn pair(kernel: TimelinePairKernelV1, from: usize, to: usize) -> PreparedTimelinePairV1 {
    let endpoint = |name: &str, start| TimelinePairEndpointV1 {
        branch_node_id: format!("transform:{name}"), source_node_id: format!("source:{name}"), asset_id: name.into(), media_kind: "video".into(),
        nominal: NodeFrameRange { timeline_start_frame: start, source_start_frame: 12, duration_frames: 12 }, source_start_seconds: 0.4, asset_duration_seconds: 2.0,
    };
    PreparedTimelinePairV1 { node_id: "cut".into(), from_layer_index: from, to_layer_index: to, composite_layer_index: to,
        spec: TimelinePairSpecV1 { id: "cut".into(), track_id: "main".into(), kernel, start_frame: 8, cut_frame: 12, end_frame: 16, from: endpoint("a",0), to: endpoint("b",12) } }
}
fn half(bits: u16) -> f32 {
    let sign=if bits&0x8000==0 { 1.0 } else { -1.0 }; let exponent=(bits>>10)&31; let fraction=bits&1023;
    sign*if exponent==0 { f32::from(fraction)*2.0_f32.powi(-24) } else { (1.0+f32::from(fraction)/1024.0)*2.0_f32.powi(i32::from(exponent)-15) }
}
fn read(engine: &GpuCompositor, texture: &wgpu::Texture) -> Result<Vec<[f32;4]>> {
    let row=(texture.width()*8).div_ceil(256)*256;
    let buffer=engine.device.create_buffer(&wgpu::BufferDescriptor { label:Some("pair scene test readback"), size:u64::from(row)*u64::from(texture.height()), usage:wgpu::BufferUsages::COPY_DST|wgpu::BufferUsages::MAP_READ, mapped_at_creation:false });
    let mut encoder=engine.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(wgpu::TexelCopyTextureInfo { texture,mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer:&buffer,layout:wgpu::TexelCopyBufferLayout { offset:0,bytes_per_row:Some(row),rows_per_image:Some(texture.height()) } },texture.size());
    engine.queue.submit([encoder.finish()]);let slice=buffer.slice(..);let(sender,receiver)=std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read,move|result|{let _=sender.send(result);});engine.device.poll(wgpu::PollType::wait_indefinitely())?;receiver.recv()??;
    let mapped=slice.get_mapped_range()?;
    let pixels=mapped.chunks_exact(row as usize).flat_map(|line| line[..texture.width() as usize*8].chunks_exact(8)
        .map(|pixel|std::array::from_fn(|c|half(u16::from_le_bytes(pixel[c*2..c*2+2].try_into().unwrap()))))).collect();
    drop(mapped);buffer.unmap();Ok(pixels)
}
fn source(engine:&GpuCompositor,pixel:[u8;4])->wgpu::Texture {
    engine.device.create_texture_with_data(&engine.queue,&wgpu::TextureDescriptor { label:Some("pair source scene fixture"),size:wgpu::Extent3d{width:8,height:8,depth_or_array_layers:1},mip_level_count:1,sample_count:1,dimension:wgpu::TextureDimension::D2,format:wgpu::TextureFormat::Rgba8Unorm,usage:wgpu::TextureUsages::TEXTURE_BINDING,view_formats:&[] },wgpu::util::TextureDataOrder::LayerMajor,&pixel.repeat(64))
}
fn layer(texture:&wgpu::Texture, opacity:f32)->VideoSurfaceLayer<'_> {
    let style=VideoVisualStyle{ opacity,..Default::default() }.with_source_dimensions(8,8);
    VideoSurfaceLayer{source:texture,temporal_sources:None,source_width:8,source_height:8,style,matte:None,display_referred:false}
}
fn uniforms(engine:&GpuCompositor,layers:&[VideoSurfaceLayer<'_>])->Vec<wgpu::Buffer>{
    layers.iter().map(|layer|engine.device.create_buffer_init(&wgpu::util::BufferInitDescriptor{label:Some("pair styled test uniform"),contents:bytemuck::bytes_of(&layer.style),usage:wgpu::BufferUsages::UNIFORM})).collect()
}
fn reference(a:[f32;4],b:[f32;4],u:f64,kernel:TimelinePairKernelV1)->[f64;4]{
    let(wa,wb,black)=match kernel{TimelinePairKernelV1::Dissolve=>(1.0-u,u,0.0),TimelinePairKernelV1::Dip=>((1.0-2.0*u).max(0.0),(2.0*u-1.0).max(0.0),2.0*u.min(1.0-u))};
    let wa=wa*f64::from(a[3]);let wb=wb*f64::from(b[3]);let alpha=wa+wb+black;
    if alpha==0.0{return[0.0;4];}std::array::from_fn(|c|if c==3{alpha}else{(wa*f64::from(a[c])+wb*f64::from(b[c]))/alpha})
}

#[test]
fn active_context_refuses_missing_duplicate_and_cross_grade_handles() {
    let pairs=[pair(TimelinePairKernelV1::Dissolve,0,1)];
    let context=|indices|TimelinePairSceneContextV1{pairs:&pairs,layer_indices:indices,timeline_frame:12};
    assert!(active_pairs(context(&[0]),2,2).unwrap_err().to_string().contains("HANDLE_MISSING"));
    assert!(active_pairs(context(&[0,0,1]),3,3).unwrap_err().to_string().contains("DUPLICATE"));
    assert!(active_pairs(context(&[0,1]),1,2).unwrap_err().to_string().contains("BOUNDARY_CROSSING"));
    let valid=active_pairs(context(&[1,0]),2,2).unwrap();assert_eq!((valid[&0].from,valid[&0].to),(1,0));
    assert!(active_pairs(TimelinePairSceneContextV1{timeline_frame:16,..context(&[])},2,2).unwrap().is_empty());
}

#[test]
fn incoming_pair_keeps_foreground_above_it_when_clip_array_is_unsorted() -> Result<()> {
    let engine=GpuCompositor::new_dx12_video()?;
    let surface=NativePreviewSurface::offscreen(&engine,8,8,NativePreviewColorSpace::SdrAuto)?;
    let a=source(&engine,[192,192,192,255]);let b=source(&engine,[64,64,64,255]);
    let foreground=source(&engine,[192,192,192,255]);let seed=source(&engine,[128,128,128,255]);
    let mut overlay=layer(&foreground,1.0);overlay.style.blend_mode=crate::BlendMode::Overlay.code();
    let layers=[layer(&b,1.0),overlay,layer(&a,1.0)];let buffers=uniforms(&engine,&layers);
    let resources=TimelinePairSceneResourcesV1::new(&engine,8,8)?;
    let declared=[pair(TimelinePairKernelV1::Dissolve,2,0)];
    let pairs=active_pairs(TimelinePairSceneContextV1{pairs:&declared,layer_indices:&[0,1,2],timeline_frame:12},3,3)?;
    let mut encoder=engine.device.create_command_encoder(&Default::default());
    let result=encode_segment(&surface,&engine,&resources,&layers,&buffers,&buffers,&pairs,0..3,&surface.scene_linear_black_texture,&mut encoder)?;
    engine.queue.submit([encoder.finish()]);let actual=read(&engine,result)?;
    // Independent old styled stack: the midpoint has equal opaque source coverage,
    // and the foreground still composes AFTER that midpoint at the incoming slot.
    let reference_layers=[layer(&seed,1.0),overlay];let buffers=uniforms(&engine,&reference_layers);
    let reference_resources=TimelinePairSceneResourcesV1::new(&engine,8,8)?;
    let mut encoder=engine.device.create_command_encoder(&Default::default());
    let output=encode_segment(&surface,&engine,&reference_resources,&reference_layers,&buffers,&buffers,&BTreeMap::new(),0..2,&surface.scene_linear_black_texture,&mut encoder)?;
    engine.queue.submit([encoder.finish()]);let expected=read(&engine,output)?;
    assert_eq!(actual,expected,"unsorted source handles must not move a foreground below the incoming cut");
    assert!(actual[0][0]>0.7,"foreground overlay must be present above the midpoint");
    Ok(())
}

#[test]
fn actual_dx12_styled_scenes_share_backdrop_and_queued_uniforms_for_both_kernels() -> Result<()> {
    let engine=GpuCompositor::new_dx12_video()?;
    let surface=NativePreviewSurface::offscreen(&engine,8,8,NativePreviewColorSpace::SdrAuto)?;
    let textures=[source(&engine,[64,128,192,128]),source(&engine,[192,64,128,192]),source(&engine,[32,192,64,64])];
    let layers=[layer(&textures[0],1.0),layer(&textures[1],0.5),layer(&textures[2],0.75)];
    let uniforms=uniforms(&engine,&layers);let matte_uniforms=uniforms.iter().collect::<Vec<_>>();
    let resources=TimelinePairSceneResourcesV1::new(&engine,8,8)?;
    // Non-paired prefix uses the real existing styled layer shader.
    let mut encoder=engine.device.create_command_encoder(&Default::default());
    let backdrop=encode_segment(&surface,&engine,&resources,&layers,&uniforms,&uniforms,&BTreeMap::new(),0..1,&surface.scene_linear_black_texture,&mut encoder)?;
    for (side,index) in [1,2].into_iter().enumerate(){let view=resources.scenes[side].create_view(&Default::default());surface.encode_scene_linear_layer(&engine,layers[index].source,None,&uniforms[index],None,matte_uniforms[index],backdrop,&view,8,8,&mut encoder);}
    engine.queue.submit([encoder.finish()]);let a=read(&engine,&resources.scenes[0])?;let b=read(&engine,&resources.scenes[1])?;
    assert!(a[0][3]>0.0&&b[0][3]>0.0);assert!(a[0][0]!=b[0][0]);
    for kernel in [TimelinePairKernelV1::Dissolve,TimelinePairKernelV1::Dip]{
        let pair=[pair(kernel,1,2)];let snapshots=(0..8).map(|_|create_composite_intermediate(&engine.device,8,8,wgpu::TextureFormat::Rgba16Float)).collect::<Vec<_>>();
        let mut encoder=engine.device.create_command_encoder(&Default::default());
        for (step,frame) in (8..16).enumerate(){
            let pairs=active_pairs(TimelinePairSceneContextV1{pairs:&pair,layer_indices:&[0,1,2],timeline_frame:frame},3,3)?;
            let result=encode_segment(&surface,&engine,&resources,&layers,&uniforms,&uniforms,&pairs,0..3,&surface.scene_linear_black_texture,&mut encoder)?;
            encoder.copy_texture_to_texture(wgpu::TexelCopyTextureInfo{texture:result,mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},
                wgpu::TexelCopyTextureInfo{texture:&snapshots[step][0],mip_level:0,origin:wgpu::Origin3d::ZERO,aspect:wgpu::TextureAspect::All},result.size());
        }
        engine.queue.submit([encoder.finish()]);
        for(step,snapshot)in snapshots.iter().enumerate(){for(index,pixel)in read(&engine,&snapshot[0])?.iter().enumerate(){let want=reference(a[index],b[index],step as f64/8.0,kernel);for c in 0..4{assert!((f64::from(pixel[c])-want[c]).abs()<=1.0/2048.0,"{kernel:?} step{step} pixel{index}/{c}: {} vs {}",pixel[c],want[c]);}if step==0{assert_eq!(*pixel,a[index]);}}}
    }
    Ok(())
}

#[test]
fn offscreen_aces_display_uses_pair_consumer_and_outside_window_matches_legacy_bytes() -> Result<()> {
    let engine=GpuCompositor::new_dx12_video()?;let surface=NativePreviewSurface::offscreen(&engine,8,8,NativePreviewColorSpace::SdrAuto)?;
    let a=source(&engine,[192,32,64,255]);let b=source(&engine,[32,64,192,255]);let layers=[layer(&a,1.0),layer(&b,1.0)];
    let pairs=[pair(TimelinePairKernelV1::Dissolve,0,1)];let indices=[0,1];
    let root=std::env::temp_dir().join(format!("editkin-pair-scenes-{}",std::process::id()));std::fs::create_dir_all(&root)?;
    let legacy=surface.verify_scene_linear_aces2_layers(&engine,EngineDisplayTransform::Aces2Rec709Sdr,&layers,&[],None,None,8,8,&root.join("legacy.png"))?;
    let context=|frame|TimelinePairSceneContextV1{pairs:&pairs,layer_indices:&indices,timeline_frame:frame};
    let outside=surface.verify_scene_linear_aces2_layers_with_pairs(&engine,EngineDisplayTransform::Aces2Rec709Sdr,&layers,&[],None,None,8,8,&root.join("outside.png"),context(16))?;
    assert_eq!(std::fs::read(root.join("legacy.png"))?,std::fs::read(root.join("outside.png"))?);
    assert_eq!(legacy["outputHash"],outside["outputHash"]);
    let inside=surface.verify_scene_linear_aces2_layers_with_pairs(&engine,EngineDisplayTransform::Aces2Rec709Sdr,&layers,&[],None,None,8,8,&root.join("dissolve.png"),context(12))?;
    assert_eq!(inside["timelineTransitionActiveCount"],1);assert_ne!(std::fs::read(root.join("outside.png"))?,std::fs::read(root.join("dissolve.png"))?);
    println!("{}",serde_json::json!({"actualNativeSourceArtifacts":root,"artStatus":"ART_PENDING_CLAUDE","outsideWindowPngByteIdentical":true,"executor":inside["timelineTransitionExecutor"]}));
    Ok(())
}

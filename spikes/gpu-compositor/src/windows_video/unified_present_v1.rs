//! Ordered Rec.709 surface execution. Draw, grade, blend and matte shader math is unchanged.
//! One existing adjustment texture is the immutable transparent seed; two existing composite textures ping-pong.
use super::*;
use crate::engine_graph::UnifiedVideoProgramV1;

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ExecutionStepV1<'a> {
    Draw {
        layer: usize,
        node_id: &'a str,
        source_node_id: &'a str,
    },
    Adjustment {
        adjustment: usize,
        node_id: &'a str,
    },
}

fn validate(
    layers: &[VideoSurfaceLayer<'_>],
    adjustments: &[VideoVisualStyle],
    steps: &[ExecutionStepV1<'_>],
) -> Result<()> {
    if layers.len() > 14 || adjustments.len() > 4 || steps.len() > 18 {
        bail!("UNIFIED_NATIVE_ACTIVE_CAPACITY");
    }
    let mut draws = std::collections::BTreeSet::new();
    let mut adjusted = std::collections::BTreeSet::new();
    for step in steps {
        match step {
            ExecutionStepV1::Draw {
                layer,
                node_id,
                source_node_id,
            } => {
                if *layer >= layers.len()
                    || !draws.insert(*layer)
                    || node_id.is_empty()
                    || source_node_id.is_empty()
                {
                    bail!("UNIFIED_NATIVE_ACTIVE_DRAW_INVALID");
                }
            }
            ExecutionStepV1::Adjustment {
                adjustment,
                node_id,
            } => {
                if *adjustment >= adjustments.len()
                    || !adjusted.insert(*adjustment)
                    || node_id.is_empty()
                {
                    bail!("UNIFIED_NATIVE_ACTIVE_ADJUSTMENT_INVALID");
                }
            }
        }
    }
    if draws.len() != layers.len() || adjusted.len() != adjustments.len() {
        bail!("UNIFIED_NATIVE_ACTIVE_PROGRAM_INCOMPLETE");
    }
    reject_scene_linear_overlays_in_legacy(layers)
}

fn execution_receipt(
    program: &UnifiedVideoProgramV1,
    frame: u64,
    steps: &[ExecutionStepV1<'_>],
) -> serde_json::Value {
    serde_json::json!({"schema":"editkin.unified-native-execution/v1","graphId":program.graph_id,"outputNode":program.output_node,
        "timelineFrame":frame,"steps":steps,"workingSeed":"transparent","deliveryBackground":"opaque_black",
        "workingPingPongTextures":2,"seedTextures":1,"retainedFrameHistory":0})
}

impl NativePreviewSurface {
    #[allow(clippy::too_many_arguments)]
    fn encode_unified_with_resources(
        &self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        steps: &[ExecutionStepV1<'_>],
        buffers: &[wgpu::Buffer],
        matte_buffers: &[wgpu::Buffer],
        adjustment_buffers: &[wgpu::Buffer],
        intermediate: &[wgpu::Texture; 2],
        seed: &wgpu::Texture,
        present_buffer: &wgpu::Buffer,
        destination: &wgpu::TextureView,
        width: u32,
        height: u32,
        encoder: &mut wgpu::CommandEncoder,
    ) {
        let seed_view = seed.create_view(&wgpu::TextureViewDescriptor::default());
        let views = [
            intermediate[0].create_view(&wgpu::TextureViewDescriptor::default()),
            intermediate[1].create_view(&wgpu::TextureViewDescriptor::default()),
        ];
        {
            let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Editkin unified transparent working seed"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &seed_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
        }
        for (position, step) in steps.iter().enumerate() {
            let backdrop = if position == 0 {
                &seed_view
            } else {
                &views[(position - 1) % 2]
            };
            let output = &views[position % 2];
            match step {
                ExecutionStepV1::Draw { layer: index, .. } => {
                    let layer = &layers[*index];
                    self.encode_visual_layer(
                        compositor,
                        layer.source,
                        layer
                            .temporal_sources
                            .as_ref()
                            .map(|sources| sources.as_slice()),
                        layer.source_width,
                        layer.source_height,
                        &buffers[*index],
                        layer.matte,
                        &matte_buffers[*index],
                        backdrop,
                        output,
                        width,
                        height,
                        true,
                        None,
                        encoder,
                    );
                }
                ExecutionStepV1::Adjustment { adjustment, .. } => {
                    let source = if position == 0 {
                        seed
                    } else {
                        &intermediate[(position - 1) % 2]
                    };
                    self.encode_visual_layer(
                        compositor,
                        source,
                        None,
                        width,
                        height,
                        &adjustment_buffers[*adjustment],
                        None,
                        &adjustment_buffers[*adjustment],
                        &seed_view,
                        output,
                        width,
                        height,
                        true,
                        None,
                        encoder,
                    );
                }
            }
        }
        // Presentation flattens the finished transparent stack against black exactly once.
        let source = if steps.is_empty() {
            seed
        } else {
            &intermediate[(steps.len() - 1) % 2]
        };
        let black = self
            .black_texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        self.encode_visual_layer(
            compositor,
            source,
            None,
            width,
            height,
            present_buffer,
            None,
            present_buffer,
            &black,
            destination,
            width,
            height,
            true,
            None,
            encoder,
        );
    }

    pub(crate) fn present_unified_layers(
        &mut self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        steps: &[ExecutionStepV1<'_>],
        program: &UnifiedVideoProgramV1,
        timeline_frame: u64,
    ) -> Result<serde_json::Value> {
        self.ensure_legacy_video_surface()?;
        validate(layers, adjustments, steps)?;
        self.ensure_composite_style_buffers(compositor, layers.len());
        self.ensure_composite_matte_style_buffers(compositor, layers.len());
        self.ensure_adjustment_style_buffers(compositor, adjustments.len());
        for (layer, buffer) in layers.iter().zip(&self.composite_style_buffers) {
            compositor
                .queue
                .write_buffer(buffer, 0, bytemuck::bytes_of(&layer.style));
        }
        for (layer, buffer) in layers.iter().zip(&self.composite_matte_style_buffers) {
            compositor.queue.write_buffer(
                buffer,
                0,
                bytemuck::bytes_of(&layer.matte.map(|matte| matte.style).unwrap_or_default()),
            );
        }
        for (style, buffer) in adjustments.iter().zip(&self.adjustment_style_buffers) {
            compositor.queue.write_buffer(
                buffer,
                0,
                bytemuck::bytes_of(&style.with_source_dimensions(self.width, self.height)),
            );
        }
        let present_style =
            VideoVisualStyle::default().with_source_dimensions(self.width, self.height);
        compositor.queue.write_buffer(
            &self.composite_present_buffer,
            0,
            bytemuck::bytes_of(&present_style),
        );
        pump_preview_window_messages();
        let frame = match self.presentation_surface()?.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame)
            | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.presentation_surface()?
                    .configure(&compositor.device, &self.configuration);
                match self.presentation_surface()?.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(frame)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                    status => bail!("reacquire unified native preview surface failed:{status:?}"),
                }
            }
            status => bail!("acquire unified native preview surface failed:{status:?}"),
        };
        let destination = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin unified ordered present"),
                });
        self.encode_unified_with_resources(
            compositor,
            layers,
            steps,
            &self.composite_style_buffers,
            &self.composite_matte_style_buffers,
            &self.adjustment_style_buffers,
            &self.composite_intermediate,
            &self.adjustment_intermediate[0],
            &self.composite_present_buffer,
            &destination,
            self.width,
            self.height,
            &mut encoder,
        );
        compositor.queue.submit([encoder.finish()]);
        compositor.queue.present(frame);
        self.presented();
        let mut description = self.description();
        let object = description
            .as_object_mut()
            .context("unified native surface description must be an object")?;
        object.insert(
            "compositeExecutionMode".into(),
            serde_json::json!("unified-draw-adjust-ping-pong/v1"),
        );
        object.insert(
            "compositeLayerCount".into(),
            serde_json::json!(layers.len()),
        );
        object.insert(
            "compositeFullFramePassCount".into(),
            serde_json::json!(steps.len() + 2),
        );
        object.insert("compositeMaximumLayersPerPass".into(), serde_json::json!(1));
        object.insert("compositeDirtyRectLayerCount".into(), serde_json::json!(0));
        object.insert("compositeTextureCopyCount".into(), serde_json::json!(0));
        let matte_count = layers.iter().filter(|layer| layer.matte.is_some()).count();
        object.insert(
            "matteExecutionMode".into(),
            serde_json::json!(if matte_count == 0 {
                "none"
            } else {
                "sampled-track-matte/v1"
            }),
        );
        object.insert("mattePassCount".into(), serde_json::json!(matte_count));
        object.insert(
            "adjustmentExecutionMode".into(),
            serde_json::json!(if adjustments.is_empty() {
                "none"
            } else {
                "scoped-in-layer-order/v1"
            }),
        );
        object.insert(
            "adjustmentPassCount".into(),
            serde_json::json!(adjustments.len()),
        );
        object.insert(
            "unifiedCompositeExecutionV1".into(),
            execution_receipt(program, timeline_frame, steps),
        );
        Ok(description)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn verify_unified_layers(
        &self,
        compositor: &GpuCompositor,
        layers: &[VideoSurfaceLayer<'_>],
        adjustments: &[VideoVisualStyle],
        steps: &[ExecutionStepV1<'_>],
        program: &UnifiedVideoProgramV1,
        timeline_frame: u64,
        width: u32,
        height: u32,
        output_path: &Path,
    ) -> Result<serde_json::Value> {
        self.ensure_legacy_video_surface()?;
        if self.is_offscreen() && (width != self.width || height != self.height) {
            bail!("UNIFIED_NATIVE_OFFSCREEN_DIMENSIONS_MISMATCH");
        }
        validate(layers, adjustments, steps)?;
        let target = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin isolated unified verification target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.configuration.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let intermediate = create_composite_intermediate(
            &compositor.device,
            width,
            height,
            self.configuration.format,
        );
        let seed = compositor.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editkin isolated unified transparent seed"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.configuration.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let make_buffer = |label, style: &VideoVisualStyle| {
            compositor
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: bytemuck::bytes_of(style),
                    usage: wgpu::BufferUsages::UNIFORM,
                })
        };
        let buffers = layers
            .iter()
            .map(|layer| make_buffer("Editkin unified verification draw uniform", &layer.style))
            .collect::<Vec<_>>();
        let matte_buffers = layers
            .iter()
            .map(|layer| {
                make_buffer(
                    "Editkin unified verification matte uniform",
                    &layer.matte.map(|matte| matte.style).unwrap_or_default(),
                )
            })
            .collect::<Vec<_>>();
        let adjustment_buffers = adjustments
            .iter()
            .map(|style| {
                make_buffer(
                    "Editkin unified verification adjustment uniform",
                    &style.with_source_dimensions(width, height),
                )
            })
            .collect::<Vec<_>>();
        let present_style = VideoVisualStyle::default().with_source_dimensions(width, height);
        let present_buffer =
            make_buffer("Editkin isolated unified present uniform", &present_style);
        let mut encoder =
            compositor
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Editkin unified ordered verification"),
                });
        self.encode_unified_with_resources(
            compositor,
            layers,
            steps,
            &buffers,
            &matte_buffers,
            &adjustment_buffers,
            &intermediate,
            &seed,
            &present_buffer,
            &target.create_view(&wgpu::TextureViewDescriptor::default()),
            width,
            height,
            &mut encoder,
        );
        compositor.queue.submit([encoder.finish()]);
        let (output_hash, rgba) = consume_bgra_with_wgpu(compositor, &target, width, height)?;
        super::super::save_rgba(output_path, rgba, width, height)?;
        Ok(
            serde_json::json!({"verificationReadback":true,"productPathCpuPixelCopies":0,"outputWritten":true,"outputHash":output_hash,
            "verificationResourceMode":"isolated-attachments/v1","verificationFullFrameTextureCreations":4,
            "verificationAdditionalResidentBytes":0,"outputReadbackCopies":1,"offscreen":self.is_offscreen(),
            "nativeSurfacePresented":false,"renderTarget":self.description(),
            "visualLayers":layers.iter().map(|layer|layer.style).collect::<Vec<_>>(),"compositeExecutionMode":"unified-draw-adjust-ping-pong/v1",
            "compositeLayerCount":layers.len(),"compositeFullFramePassCount":steps.len()+2,"compositeMaximumLayersPerPass":1,
            "matteExecutionMode":if layers.iter().any(|layer|layer.matte.is_some()){"sampled-track-matte/v1"}else{"none"},
            "mattePassCount":layers.iter().filter(|layer|layer.matte.is_some()).count(),
            "adjustmentExecutionMode":if adjustments.is_empty(){"none"}else{"scoped-in-layer-order/v1"},"adjustmentPassCount":adjustments.len(),
            "adjustments":adjustments,"sdrOutputContract":self.output_pixel_contract(),"unifiedCompositeExecutionV1":execution_receipt(program,timeline_frame,steps)}),
        )
    }
}

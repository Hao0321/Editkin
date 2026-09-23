use anyhow::{Result, bail};

use super::{GpuCompositor, VideoSurfaceLayer, VideoVisualStyle};

pub(super) const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
pub(super) const EXECUTION_MODE: &str = "scene-linear-depth32f-opaque-planes/v1";

pub(super) fn create_texture(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    label: &'static str,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

pub(super) fn create_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
) -> wgpu::RenderPipeline {
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Editkin resident 2.5D depth-plane layout"),
        bind_group_layouts: &[Some(layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Editkin resident 2.5D Depth32Float compositor"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vertex_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fragment_depth_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    })
}

pub(super) fn requested(layers: &[VideoSurfaceLayer<'_>]) -> bool {
    layers
        .iter()
        .any(|layer| layer.style.scene_depth_enabled != 0)
}

pub(super) fn validate_contract(
    layers: &[VideoSurfaceLayer<'_>],
    adjustments: &[VideoVisualStyle],
    adjustment_base_layer_count: Option<usize>,
) -> Result<bool> {
    if !requested(layers) {
        return Ok(false);
    }
    let exact = (1..=8).contains(&layers.len())
        && adjustments.is_empty()
        && adjustment_base_layer_count.is_none()
        && layers.iter().all(|layer| {
            let style = layer.style;
            layer.temporal_sources.is_none()
                && layer.matte.is_none()
                && layer.source_width > 0
                && layer.source_height > 0
                && style.projective_enabled > 0.5
                && style.scene_depth_enabled == 1
                && [
                    style.scene_depth_a,
                    style.scene_depth_b,
                    style.scene_depth_c,
                ]
                .iter()
                .all(|value| value.is_finite())
                && [style.shade_r, style.shade_g, style.shade_b]
                    .iter()
                    .all(|value| value.is_finite() && *value >= 0.0)
                && (style.opacity - 1.0).abs() <= 0.000_001
                && (style.composite_opacity - 1.0).abs() <= 0.000_001
                && style.source_alpha_mode == 1
                && style.blend_mode == 0
                && style.matte_mode == 0
                && style.effect_kind == 0
                && style.shader_op_count == 0
                && style.motion_sample_count == 0
        });
    if !exact {
        bail!(
            "resident 2.5D depth planes require 1..=8 opaque static projective layers with no blend, matte, temporal, effect, or adjustment fallback"
        );
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn encode(
    compositor: &GpuCompositor,
    pipeline: &wgpu::RenderPipeline,
    bind_group_layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    black_texture: &wgpu::Texture,
    layers: &[VideoSurfaceLayer<'_>],
    style_buffers: &[wgpu::Buffer],
    destination: &wgpu::TextureView,
    depth_texture: &wgpu::Texture,
    width: u32,
    height: u32,
    encoder: &mut wgpu::CommandEncoder,
) {
    debug_assert_eq!(layers.len(), style_buffers.len());
    let black_view = black_texture.create_view(&wgpu::TextureViewDescriptor::default());
    let bind_groups = layers
        .iter()
        .zip(style_buffers)
        .map(|(layer, style_buffer)| {
            let source_view = layer
                .source
                .create_view(&wgpu::TextureViewDescriptor::default());
            compositor
                .device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Editkin resident 2.5D depth-plane bindings"),
                    layout: bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: style_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::TextureView(&black_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: wgpu::BindingResource::TextureView(&black_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 5,
                            resource: style_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 6,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 7,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 8,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 9,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 10,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 11,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 12,
                            resource: wgpu::BindingResource::TextureView(&source_view),
                        },
                    ],
                })
        })
        .collect::<Vec<_>>();
    let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Editkin resident 2.5D single-pass per-pixel depth composite"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: destination,
            resolve_target: None,
            depth_slice: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &depth_view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(1.0),
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_viewport(0.0, 0.0, width as f32, height as f32, 0.0, 1.0);
    for bind_group in &bind_groups {
        pass.set_bind_group(0, bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

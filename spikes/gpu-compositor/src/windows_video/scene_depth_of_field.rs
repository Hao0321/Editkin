use wgpu::util::DeviceExt;

use crate::engine_graph::EngineVideoDepthOfFieldPlan;

use super::GpuCompositor;

pub(super) const EXECUTION_MODE: &str = "scene-linear-depth32f-gather-dof/v1";

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LensUniform {
    focus_distance: f32,
    aperture: f32,
    max_blur_radius: f32,
    near: f32,
    far: f32,
    width: f32,
    height: f32,
    padding: f32,
}

pub(super) fn create_pipeline(
    device: &wgpu::Device,
) -> (wgpu::BindGroupLayout, wgpu::RenderPipeline) {
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Editkin resident depth-of-field bindings"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Depth,
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Editkin resident depth-aware lens shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../scene_depth_of_field.wgsl").into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Editkin resident depth-of-field pipeline layout"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Editkin resident Depth32Float depth-of-field"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vertex_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fragment_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    (layout, pipeline)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn encode(
    compositor: &GpuCompositor,
    layout: &wgpu::BindGroupLayout,
    pipeline: &wgpu::RenderPipeline,
    sampler: &wgpu::Sampler,
    source: &wgpu::Texture,
    depth: &wgpu::Texture,
    destination: &wgpu::TextureView,
    plan: &EngineVideoDepthOfFieldPlan,
    width: u32,
    height: u32,
    encoder: &mut wgpu::CommandEncoder,
) {
    let uniform = LensUniform {
        focus_distance: plan.focus_distance,
        aperture: plan.aperture,
        max_blur_radius: plan.max_blur_radius,
        near: plan.near,
        far: plan.far,
        width: width as f32,
        height: height as f32,
        padding: 0.0,
    };
    let uniform_buffer = compositor
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Editkin resident depth-of-field lens uniform"),
            contents: bytemuck::bytes_of(&uniform),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let source_view = source.create_view(&wgpu::TextureViewDescriptor::default());
    let depth_view = depth.create_view(&wgpu::TextureViewDescriptor::default());
    let bind_group = compositor
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Editkin resident depth-of-field sampled depth bindings"),
            layout,
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
                    resource: wgpu::BindingResource::TextureView(&depth_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: uniform_buffer.as_entire_binding(),
                },
            ],
        });
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Editkin resident scene-linear depth-aware lens pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: destination,
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
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, &bind_group, &[]);
    pass.set_viewport(0.0, 0.0, width as f32, height as f32, 0.0, 1.0);
    pass.draw(0..3, 0..1);
}

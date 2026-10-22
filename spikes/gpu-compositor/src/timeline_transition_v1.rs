//! New, opt-in paired scene pass. Both textures contain styled straight,
//! scene-linear RGBA. Colour ingress and display output remain separate passes.
use anyhow::{Result, bail};
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

pub(crate) const SHADER_SOURCE_V1: &str = include_str!("timeline_transition_v1.wgsl");

#[derive(Clone, Copy, Debug)]
pub(crate) enum TransitionKernelV1 { Dissolve, Dip }
impl TransitionKernelV1 { fn code(self) -> u32 { match self { Self::Dissolve => 0, Self::Dip => 1 } } }

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TransitionParamsV1 { progress: f32, kernel: u32, pad0: u32, pad1: u32 }

pub(crate) struct TimelineTransitionPassV1 {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    output_format: wgpu::TextureFormat,
}

impl TimelineTransitionPassV1 {
    pub(crate) fn new(device: &wgpu::Device, output_format: wgpu::TextureFormat) -> Result<Self> {
        if !matches!(output_format, wgpu::TextureFormat::Rgba16Float | wgpu::TextureFormat::Rgba32Float) {
            bail!("TIMELINE_TRANSITION_WORKING_FORMAT_INVALID");
        }
        let texture = |binding| wgpu::BindGroupLayoutEntry {
            binding, visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Editkin pair v1 straight linear textures"),
            entries: &[texture(0), texture(1), wgpu::BindGroupLayoutEntry {
                binding: 2, visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false,
                    min_binding_size: std::num::NonZeroU64::new(16) }, count: None,
            }],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin shared timeline transition v1"), source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE_V1.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Editkin pair v1 pipeline layout"), bind_group_layouts: &[Some(&layout)], immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Editkin pair v1 linear coverage"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vertex_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some(if output_format == wgpu::TextureFormat::Rgba16Float { "fragment_main_f16" } else { "fragment_main" }),
                targets: &[Some(wgpu::ColorTargetState { format: output_format, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None,
        });
        Ok(Self { layout, pipeline, output_format })
    }

    /// Each encoded pass owns its16-byte uniform. Several transitions may be
    /// queued in one command buffer without all passes observing the last u.
    pub(crate) fn encode(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder,
        from: &wgpu::Texture, to: &wgpu::Texture, output: &wgpu::Texture,
        progress: f64, kernel: TransitionKernelV1) -> Result<()> {
        if !progress.is_finite() { bail!("TIMELINE_TRANSITION_PROGRESS_INVALID"); }
        if from == output || to == output { bail!("TIMELINE_TRANSITION_TEXTURE_ALIAS_INVALID"); }
        if output.format() != self.output_format || from.size() != to.size() || from.size() != output.size()
            || from.size().depth_or_array_layers != 1 || from.width() == 0 || from.height() == 0
            || [from, to, output].iter().any(|t| t.dimension() != wgpu::TextureDimension::D2 || t.sample_count() != 1)
            || [from, to].iter().any(|t| !matches!(t.format(), wgpu::TextureFormat::Rgba16Float | wgpu::TextureFormat::Rgba32Float)
                || !t.usage().contains(wgpu::TextureUsages::TEXTURE_BINDING))
            || !output.usage().contains(wgpu::TextureUsages::RENDER_ATTACHMENT) {
            bail!("TIMELINE_TRANSITION_TEXTURE_CONTRACT_INVALID");
        }
        let params = TransitionParamsV1 { progress: progress.clamp(0.0, 1.0) as f32, kernel: kernel.code(), pad0: 0, pad1: 0 };
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Editkin pair v1 immutable pass parameters"), contents: bytemuck::bytes_of(&params), usage: wgpu::BufferUsages::UNIFORM,
        });
        let from_view = from.create_view(&Default::default());
        let to_view = to.create_view(&Default::default());
        let output_view = output.create_view(&Default::default());
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("Editkin pair v1 input scenes"), layout: &self.layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&from_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&to_view) },
                wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() }],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Editkin pair v1 shared shader execution"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &output_view, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        pass.set_pipeline(&self.pipeline); pass.set_bind_group(0, &bindings, &[]); pass.draw(0..3, 0..1);
        Ok(())
    }
}

#[cfg(test)]
#[path = "timeline_transition_v1_tests.rs"]
mod tests;

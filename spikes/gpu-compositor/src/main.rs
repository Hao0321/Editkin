#![recursion_limit = "256"]

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail};
use bytemuck::{Pod, Zeroable};
use flate2::read::ZlibDecoder;
use image::{ImageBuffer, ImageFormat, Rgba, Rgba32FImage, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wgpu::util::DeviceExt;

mod caption;
mod engine_graph;
#[cfg(windows)]
mod software_video;
#[cfg(windows)]
mod windows_video;

const GRAPH_SCHEMA: &str = "hao.gpu-render-graph/v1";
const ACES2_REC709_SDR_LUT_BYTES: &[u8] =
    include_bytes!("../../../public/color/aces2/luts/output-acescct-to-rec709_sdr.cube");
const ACES2_REC709_SDR_LUT_SHA256: &str =
    "0808837eb979b6f59e79db411f6bd861469456a89bf399ffe652a99bf0c454b3";
const ACES2_REC709_SDR_LUT_SIZE: usize = 65;
const ACES2_HDR_LUT_SIZE: usize = 129;
const ACES2_REC2100_HLG_1000_LUT_BYTES: &[u8] = include_bytes!(
    "../../../public/color/aces2/luts/output-acescct-to-rec2100_hlg_1000.rgb-f32le.zlib"
);
const ACES2_REC2100_HLG_1000_LUT_SHA256: &str =
    "ab4a459ae1a284ceb34546ffe1bed664af6bdf6f43f4b7bc4ca562a4492a0eda";
const ACES2_REC2100_HLG_1000_PAYLOAD_SHA256: &str =
    "012d60627a4aa5e9880122c94cd540fa7d70bbda7918ef866a0a64cf4c9cadab";
const ACES2_REC2100_HLG_1000_COMPRESSED_SHA256: &str =
    "a43b47b4e5bc8a1f134ded9bc397018017fa40cf24dc27994ea7ccd4a2667119";
const ACES2_REC2100_PQ_1000_LUT_BYTES: &[u8] = include_bytes!(
    "../../../public/color/aces2/luts/output-acescct-to-rec2100_pq_1000.rgb-f32le.zlib"
);
const ACES2_REC2100_PQ_1000_LUT_SHA256: &str =
    "0cad3aecbc3c5e12aec4f0c489bea6eb5a3a4c0e322aa28010468b856b6b121f";
const ACES2_REC2100_PQ_1000_PAYLOAD_SHA256: &str =
    "2c400e0cb185ba44ceecf19aae2ddbd5d90a976f39f43d324ff8bc118ef9f7e1";
const ACES2_REC2100_PQ_1000_COMPRESSED_SHA256: &str =
    "0b69202405c491f9562d676f681009f8718c6d94ef8a2b87ae94e6910012496a";

#[derive(Clone)]
struct OcioLut3d {
    size: usize,
    values: Vec<[f32; 4]>,
}

fn embedded_aces2_rec709_sdr_lut() -> Result<OcioLut3d> {
    if output_hash(ACES2_REC709_SDR_LUT_BYTES) != ACES2_REC709_SDR_LUT_SHA256 {
        bail!("embedded ACES 2 Rec.709 SDR LUT SHA-256 mismatch");
    }
    let text = std::str::from_utf8(ACES2_REC709_SDR_LUT_BYTES)
        .context("embedded ACES 2 Rec.709 SDR LUT is not UTF-8")?;
    let mut size = None;
    let mut values = Vec::with_capacity(
        ACES2_REC709_SDR_LUT_SIZE * ACES2_REC709_SDR_LUT_SIZE * ACES2_REC709_SDR_LUT_SIZE,
    );
    for (line_index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("TITLE") {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.first() == Some(&"LUT_3D_SIZE") {
            if fields.len() != 2 || size.replace(fields[1].parse::<usize>()?).is_some() {
                bail!("invalid embedded ACES LUT size declaration");
            }
            continue;
        }
        if matches!(fields.first(), Some(&"DOMAIN_MIN") | Some(&"DOMAIN_MAX")) {
            bail!("embedded ACES LUT must use the exact normalized domain");
        }
        if fields.len() != 3 {
            bail!("invalid embedded ACES LUT row {}", line_index + 1);
        }
        let rgb = [
            fields[0].parse::<f32>()?,
            fields[1].parse::<f32>()?,
            fields[2].parse::<f32>()?,
        ];
        if rgb.iter().any(|value| !value.is_finite()) {
            bail!("embedded ACES LUT contains a non-finite value");
        }
        values.push([rgb[0], rgb[1], rgb[2], 0.0]);
    }
    if size != Some(ACES2_REC709_SDR_LUT_SIZE)
        || values.len()
            != ACES2_REC709_SDR_LUT_SIZE * ACES2_REC709_SDR_LUT_SIZE * ACES2_REC709_SDR_LUT_SIZE
    {
        bail!("embedded ACES LUT dimensions or payload length are invalid");
    }
    Ok(OcioLut3d {
        size: ACES2_REC709_SDR_LUT_SIZE,
        values,
    })
}

fn embedded_compressed_hdr_lut(
    compressed: &[u8],
    compressed_sha256: &str,
    payload_sha256: &str,
    label: &str,
) -> Result<OcioLut3d> {
    if output_hash(compressed) != compressed_sha256 {
        bail!("embedded {label} compressed LUT SHA-256 mismatch");
    }
    let expected_bytes = ACES2_HDR_LUT_SIZE
        .checked_pow(3)
        .and_then(|value| value.checked_mul(3))
        .and_then(|value| value.checked_mul(std::mem::size_of::<f32>()))
        .context("HDR LUT payload length overflow")?;
    let mut raw = Vec::with_capacity(expected_bytes);
    ZlibDecoder::new(compressed)
        .take(expected_bytes as u64 + 1)
        .read_to_end(&mut raw)
        .with_context(|| format!("decompress embedded {label} LUT"))?;
    if raw.len() != expected_bytes || output_hash(&raw) != payload_sha256 {
        bail!("embedded {label} LUT payload identity or length mismatch");
    }
    let mut values = Vec::with_capacity(ACES2_HDR_LUT_SIZE.pow(3));
    for rgb in raw.chunks_exact(12) {
        let decoded = [
            f32::from_le_bytes(rgb[0..4].try_into()?),
            f32::from_le_bytes(rgb[4..8].try_into()?),
            f32::from_le_bytes(rgb[8..12].try_into()?),
        ];
        if decoded.iter().any(|value| !value.is_finite()) {
            bail!("embedded {label} LUT contains a non-finite value");
        }
        values.push([decoded[0], decoded[1], decoded[2], 0.0]);
    }
    Ok(OcioLut3d {
        size: ACES2_HDR_LUT_SIZE,
        values,
    })
}

fn embedded_aces2_rec2100_hlg_1000_lut() -> Result<OcioLut3d> {
    embedded_compressed_hdr_lut(
        ACES2_REC2100_HLG_1000_LUT_BYTES,
        ACES2_REC2100_HLG_1000_COMPRESSED_SHA256,
        ACES2_REC2100_HLG_1000_PAYLOAD_SHA256,
        "ACES 2 Rec.2100 HLG 1000-nit",
    )
}

fn embedded_aces2_rec2100_pq_1000_lut() -> Result<OcioLut3d> {
    embedded_compressed_hdr_lut(
        ACES2_REC2100_PQ_1000_LUT_BYTES,
        ACES2_REC2100_PQ_1000_COMPRESSED_SHA256,
        ACES2_REC2100_PQ_1000_PAYLOAD_SHA256,
        "ACES 2 Rec.2100 PQ 1000-nit",
    )
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderGraph {
    schema: String,
    width: u32,
    height: u32,
    layers: Vec<Layer>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Layer {
    id: String,
    source: LayerSource,
    #[serde(default)]
    alpha_mode: SourceAlphaMode,
    #[serde(default)]
    blend_mode: BlendMode,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default)]
    transform: Transform,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(skip)]
    effect: BuiltinEffect,
    /// Geometry depth is populated only by the common 2.5D engine-graph lowering pass.
    /// Legacy render graphs remain 2D and deserialize this as `None`.
    #[serde(skip)]
    scene_depth: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SourceAlphaMode {
    #[default]
    Auto,
    Opaque,
    Straight,
    Premultiplied,
}

impl SourceAlphaMode {
    const fn code(self) -> u32 {
        match self {
            Self::Auto | Self::Straight => 0,
            Self::Opaque => 1,
            Self::Premultiplied => 2,
        }
    }

    const fn resolved_for(self, source: &LayerSource) -> Self {
        match self {
            Self::Auto => match source {
                LayerSource::Image { .. } | LayerSource::FloatImage { .. } => Self::Straight,
                _ => Self::Straight,
            },
            explicit => explicit,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct BuiltinEffect {
    kind: u32,
    contrast: f32,
    brightness: f32,
}

impl BuiltinEffect {
    const fn monochrome(kind: u32, contrast: f32, brightness: f32) -> Self {
        Self {
            kind,
            contrast,
            brightness,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum LayerSource {
    Solid {
        color: [u8; 4],
    },
    Gradient {
        start: [u8; 4],
        end: [u8; 4],
        #[serde(default)]
        horizontal: bool,
    },
    Radial {
        inner: [u8; 4],
        outer: [u8; 4],
        center: [f32; 2],
        radius: f32,
    },
    Rect {
        color: [u8; 4],
        rect: [f32; 4],
        #[serde(default)]
        radius: f32,
    },
    Image {
        path: PathBuf,
    },
    FloatImage {
        path: PathBuf,
    },
    ParticleEmitter {
        seed: u32,
        rate_per_second: f32,
        lifetime_seconds: f32,
        time_seconds: f32,
        max_particles: u32,
        emitter_position: [f32; 2],
        initial_velocity: [f32; 2],
        gravity: [f32; 2],
        radius_pixels: f32,
        color: [f32; 4],
    },
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BlendMode {
    #[default]
    Normal,
    Add,
    Screen,
    Multiply,
    Overlay,
    SoftLight,
    HardLight,
    Difference,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
}

impl BlendMode {
    fn code(self) -> u32 {
        match self {
            Self::Normal => 0,
            Self::Add => 1,
            Self::Screen => 2,
            Self::Multiply => 3,
            Self::Overlay => 4,
            Self::SoftLight => 5,
            Self::HardLight => 6,
            Self::Difference => 7,
            Self::Darken => 8,
            Self::Lighten => 9,
            Self::ColorDodge => 10,
            Self::ColorBurn => 11,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
struct Transform {
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default = "one")]
    scale: f32,
    #[serde(default)]
    rotation: f32,
    /// Destination-pixel to source-pixel homography for a projected 2.5D plane. The source
    /// and destination coordinate systems are centered on the composition.
    #[serde(skip)]
    projective: [f32; 8],
    #[serde(skip)]
    projective_enabled: bool,
    /// Native Lambert/ambient scene-light multiplier. Scene-linear working pixels are not
    /// clamped here; the selected display/output transform owns gamut and range handling.
    #[serde(skip, default = "unit_shade")]
    shade: [f32; 3],
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            projective: [0.0; 8],
            projective_enabled: false,
            shade: [1.0; 3],
        }
    }
}

const fn one() -> f32 {
    1.0
}
const fn unit_shade() -> [f32; 3] {
    [1.0; 3]
}
const fn yes() -> bool {
    true
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct GpuConfig {
    width: u32,
    height: u32,
    layer_count: u32,
    pixel_count: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuLayerParam {
    opacity: f32,
    translate_x: f32,
    translate_y: f32,
    scale: f32,
    rotation: f32,
    blend_mode: u32,
    enabled: u32,
    #[serde(default)]
    alpha_mode: u32,
    #[serde(default)]
    effect_kind: u32,
    #[serde(default)]
    effect_contrast: f32,
    #[serde(default)]
    effect_brightness: f32,
    #[serde(default)]
    _effect_pad: u32,
    #[serde(default)]
    projective_h0: f32,
    #[serde(default)]
    projective_h1: f32,
    #[serde(default)]
    projective_h2: f32,
    #[serde(default)]
    projective_h3: f32,
    #[serde(default)]
    projective_h4: f32,
    #[serde(default)]
    projective_h5: f32,
    #[serde(default)]
    projective_h6: f32,
    #[serde(default)]
    projective_h7: f32,
    #[serde(default)]
    projective_enabled: u32,
    #[serde(default)]
    _projective_pad_x: u32,
    #[serde(default)]
    _projective_pad_y: u32,
    #[serde(default)]
    _projective_pad_z: u32,
    #[serde(default = "one")]
    shade_r: f32,
    #[serde(default = "one")]
    shade_g: f32,
    #[serde(default = "one")]
    shade_b: f32,
    #[serde(default)]
    _shade_pad: f32,
    #[serde(default)]
    source_kind: u32,
    #[serde(default)]
    particle_seed: u32,
    #[serde(default)]
    particle_max: u32,
    #[serde(default)]
    _particle_pad: u32,
    #[serde(default)]
    particle_rate: f32,
    #[serde(default)]
    particle_lifetime: f32,
    #[serde(default)]
    particle_time: f32,
    #[serde(default)]
    particle_radius: f32,
    #[serde(default)]
    particle_emitter_x: f32,
    #[serde(default)]
    particle_emitter_y: f32,
    #[serde(default)]
    particle_velocity_x: f32,
    #[serde(default)]
    particle_velocity_y: f32,
    #[serde(default)]
    particle_gravity_x: f32,
    #[serde(default)]
    particle_gravity_y: f32,
    #[serde(default)]
    particle_color_r: f32,
    #[serde(default)]
    particle_color_g: f32,
    #[serde(default)]
    particle_color_b: f32,
    #[serde(default)]
    particle_color_a: f32,
}

struct PreparedGraph {
    width: u32,
    height: u32,
    layers: Vec<Layer>,
    packed_layers: Vec<u32>,
    params: Vec<GpuLayerParam>,
    float_input: bool,
    float_working: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuReceipt {
    engine: &'static str,
    adapter_name: String,
    backend: String,
    device_type: String,
    width: u32,
    height: u32,
    layer_count: usize,
    render_milliseconds: f64,
    output_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    schema: &'static str,
    adapter_name: String,
    backend: String,
    frames: usize,
    width: u32,
    height: u32,
    layers: usize,
    gpu_average_ms: f64,
    gpu_p95_ms: f64,
    gpu_fps_equivalent: f64,
    cpu_average_ms: f64,
    cpu_fps_equivalent: f64,
    parity_max_channel_error: u8,
    note: &'static str,
}

#[derive(Clone)]
struct GpuCompositor {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    float_input_pipeline: wgpu::ComputePipeline,
    packed_pipeline: wgpu::ComputePipeline,
    pack_bind_group_layout: wgpu::BindGroupLayout,
    pack_pipeline: wgpu::ComputePipeline,
    linear_pack_pipeline: wgpu::ComputePipeline,
    display_pack_bind_group_layout: wgpu::BindGroupLayout,
    aces2_rec709_sdr_pipeline: wgpu::ComputePipeline,
    aces2_rec709_sdr_lut_buffer: wgpu::Buffer,
    aces2_rec2100_hdr_pipeline: wgpu::ComputePipeline,
    aces2_rec2100_hlg_1000_lut_buffer: Option<wgpu::Buffer>,
    aces2_rec2100_pq_1000_lut_buffer: Option<wgpu::Buffer>,
    adapter_name: String,
    backend: String,
    device_type: String,
}

struct ResidentGraph {
    width: u32,
    height: u32,
    layer_count: usize,
    output_size: u64,
    hdr_output_size: u64,
    params_buffer: wgpu::Buffer,
    output_buffer: wgpu::Buffer,
    packed_output_buffer: Option<wgpu::Buffer>,
    staging: wgpu::Buffer,
    float_staging: Option<wgpu::Buffer>,
    bind_group: wgpu::BindGroup,
    pack_bind_group: Option<wgpu::BindGroup>,
    display_pack_bind_group: Option<wgpu::BindGroup>,
    display_pack_hlg_bind_group: Option<wgpu::BindGroup>,
    display_pack_pq_bind_group: Option<wgpu::BindGroup>,
    float_working: bool,
    float_input: bool,
}

impl GpuCompositor {
    fn new() -> Result<Self> {
        Self::new_with_backend(wgpu::Backends::all(), wgpu::Features::empty(), None, false)
    }

    fn new_for_display(display_transform: engine_graph::EngineDisplayTransform) -> Result<Self> {
        Self::new_with_backend(
            wgpu::Backends::all(),
            wgpu::Features::empty(),
            Some(display_transform),
            false,
        )
    }

    #[cfg(windows)]
    fn new_dx12_video() -> Result<Self> {
        Self::new_with_backend(wgpu::Backends::DX12, wgpu::Features::empty(), None, true)
    }

    fn new_with_backend(
        backends: wgpu::Backends,
        required_features: wgpu::Features,
        hdr_display: Option<engine_graph::EngineDisplayTransform>,
        resident_video_pq: bool,
    ) -> Result<Self> {
        let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        instance_descriptor.backends = backends;
        let instance = wgpu::Instance::new(instance_descriptor);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
            ..Default::default()
        }))
        .context("no compatible GPU adapter")?;
        let info = adapter.get_info();
        if !adapter.features().contains(required_features) {
            bail!(
                "adapter {} does not expose required features {:?}",
                info.name,
                required_features
            );
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Editkin GPU compositor"),
            required_features,
            ..Default::default()
        }))
        .context("request GPU device")?;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin layer compositor"),
            source: wgpu::ShaderSource::Wgsl(include_str!("compositor.wgsl").into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Editkin compositor bindings"),
            entries: &[
                storage_entry(0, true),
                storage_entry(1, true),
                storage_entry(2, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Editkin compositor pipeline layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Editkin compositor pipeline"),
            layout: Some(&layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let float_input_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin float-input layer compositor"),
            source: wgpu::ShaderSource::Wgsl(include_str!("compositor_float_input.wgsl").into()),
        });
        let float_input_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Editkin float-input compositor pipeline"),
                layout: Some(&layout),
                module: &float_input_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let packed_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin packed layer compositor"),
            source: wgpu::ShaderSource::Wgsl(include_str!("compositor_packed.wgsl").into()),
        });
        let packed_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Editkin packed compositor pipeline"),
            layout: Some(&layout),
            module: &packed_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let pack_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin float output packer"),
            source: wgpu::ShaderSource::Wgsl(include_str!("pack_output.wgsl").into()),
        });
        let pack_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Editkin float output pack bindings"),
                entries: &[
                    storage_entry(0, true),
                    storage_entry(1, false),
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
        let pack_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Editkin float output pack pipeline layout"),
            bind_group_layouts: &[Some(&pack_bind_group_layout)],
            immediate_size: 0,
        });
        let pack_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Editkin float output pack pipeline"),
            layout: Some(&pack_layout),
            module: &pack_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let linear_pack_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin scene-linear preview packer"),
            source: wgpu::ShaderSource::Wgsl(include_str!("pack_linear_output.wgsl").into()),
        });
        let linear_pack_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Editkin scene-linear preview pack pipeline"),
                layout: Some(&pack_layout),
                module: &linear_pack_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let display_pack_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Editkin ACES 2 display pack bindings"),
                entries: &[
                    storage_entry(0, true),
                    storage_entry(1, false),
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    storage_entry(3, true),
                ],
            });
        let display_pack_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Editkin ACES 2 display pack pipeline layout"),
            bind_group_layouts: &[Some(&display_pack_bind_group_layout)],
            immediate_size: 0,
        });
        let aces2_rec709_sdr_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin OCIO ACES 2 Rec.709 SDR output transform"),
            source: wgpu::ShaderSource::Wgsl(include_str!("pack_aces2_rec709_sdr.wgsl").into()),
        });
        let aces2_rec709_sdr_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Editkin OCIO ACES 2 Rec.709 SDR output transform pipeline"),
                layout: Some(&display_pack_layout),
                module: &aces2_rec709_sdr_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let aces2_rec709_sdr_lut = embedded_aces2_rec709_sdr_lut()?;
        let aces2_rec709_sdr_lut_buffer =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Editkin OCIO ACES 2 Rec.709 SDR LUT"),
                contents: bytemuck::cast_slice(&aces2_rec709_sdr_lut.values),
                usage: wgpu::BufferUsages::STORAGE,
            });
        let aces2_rec2100_hdr_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Editkin OCIO ACES 2 Rec.2100 HDR output transform"),
            source: wgpu::ShaderSource::Wgsl(include_str!("pack_aces2_rec2100_hdr.wgsl").into()),
        });
        let aces2_rec2100_hdr_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Editkin OCIO ACES 2 Rec.2100 HDR output transform pipeline"),
                layout: Some(&display_pack_layout),
                module: &aces2_rec2100_hdr_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
        let aces2_rec2100_hlg_1000_lut_buffer =
            if hdr_display == Some(engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000) {
                let lut = embedded_aces2_rec2100_hlg_1000_lut()?;
                Some(
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin OCIO ACES 2 Rec.2100 HLG 1000-nit LUT"),
                        contents: bytemuck::cast_slice(&lut.values),
                        usage: wgpu::BufferUsages::STORAGE,
                    }),
                )
            } else {
                None
            };
        let aces2_rec2100_pq_1000_lut_buffer =
            if hdr_display == Some(engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000)
                || resident_video_pq
            {
                let lut = embedded_aces2_rec2100_pq_1000_lut()?;
                Some(
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Editkin OCIO ACES 2 Rec.2100 PQ 1000-nit LUT"),
                        contents: bytemuck::cast_slice(&lut.values),
                        usage: wgpu::BufferUsages::STORAGE,
                    }),
                )
            } else {
                None
            };
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            bind_group_layout,
            pipeline,
            float_input_pipeline,
            packed_pipeline,
            pack_bind_group_layout,
            pack_pipeline,
            linear_pack_pipeline,
            display_pack_bind_group_layout,
            aces2_rec709_sdr_pipeline,
            aces2_rec709_sdr_lut_buffer,
            aces2_rec2100_hdr_pipeline,
            aces2_rec2100_hlg_1000_lut_buffer,
            aces2_rec2100_pq_1000_lut_buffer,
            adapter_name: info.name,
            backend: format!("{:?}", info.backend),
            device_type: format!("{:?}", info.device_type),
        })
    }

    fn upload(&self, prepared: &PreparedGraph) -> Result<ResidentGraph> {
        let pixel_count = prepared.width as u64 * prepared.height as u64;
        let output_size = pixel_count * 4;
        let hdr_output_size = pixel_count * 8;
        let compositor_output_size = if prepared.float_working {
            pixel_count * 16
        } else {
            output_size
        };
        let config = GpuConfig {
            width: prepared.width,
            height: prepared.height,
            layer_count: prepared.layers.len() as u32,
            pixel_count: pixel_count as u32,
        };
        let layer_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Editkin packed layer pixels"),
                contents: bytemuck::cast_slice(&prepared.packed_layers),
                usage: wgpu::BufferUsages::STORAGE,
            });
        let params_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Editkin layer parameters"),
                contents: bytemuck::cast_slice(&prepared.params),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            });
        let output_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(if prepared.float_working {
                "Editkin GPU float output"
            } else {
                "Editkin GPU packed output"
            }),
            size: compositor_output_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let packed_output_buffer = prepared.float_working.then(|| {
            self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Editkin GPU packed float output"),
                size: hdr_output_size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        });
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Editkin GPU readback"),
            size: if prepared.float_working {
                hdr_output_size
            } else {
                output_size
            },
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let float_staging = prepared.float_working.then(|| {
            self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Editkin GPU float readback"),
                size: compositor_output_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        });
        let config_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Editkin compositor config"),
                contents: bytemuck::bytes_of(&config),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Editkin compositor bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: layer_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: output_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: config_buffer.as_entire_binding(),
                },
            ],
        });
        let pack_bind_group = packed_output_buffer.as_ref().map(|packed| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Editkin float output pack bind group"),
                layout: &self.pack_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: output_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: packed.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: config_buffer.as_entire_binding(),
                    },
                ],
            })
        });
        let display_pack_bind_group = packed_output_buffer.as_ref().map(|packed| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Editkin ACES 2 display pack bind group"),
                layout: &self.display_pack_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: output_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: packed.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: config_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: self.aces2_rec709_sdr_lut_buffer.as_entire_binding(),
                    },
                ],
            })
        });
        let display_pack_hlg_bind_group = packed_output_buffer.as_ref().and_then(|packed| {
            self.aces2_rec2100_hlg_1000_lut_buffer.as_ref().map(|lut| {
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Editkin ACES 2 Rec.2100 HLG display pack bind group"),
                    layout: &self.display_pack_bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: output_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: packed.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: config_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: lut.as_entire_binding(),
                        },
                    ],
                })
            })
        });
        let display_pack_pq_bind_group = packed_output_buffer.as_ref().and_then(|packed| {
            self.aces2_rec2100_pq_1000_lut_buffer.as_ref().map(|lut| {
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Editkin ACES 2 Rec.2100 PQ display pack bind group"),
                    layout: &self.display_pack_bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: output_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: packed.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: config_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: lut.as_entire_binding(),
                        },
                    ],
                })
            })
        });
        Ok(ResidentGraph {
            width: prepared.width,
            height: prepared.height,
            layer_count: prepared.layers.len(),
            output_size,
            hdr_output_size,
            params_buffer,
            output_buffer,
            packed_output_buffer,
            staging,
            float_staging,
            bind_group,
            pack_bind_group,
            display_pack_bind_group,
            display_pack_hlg_bind_group,
            display_pack_pq_bind_group,
            float_working: prepared.float_working,
            float_input: prepared.float_input,
        })
    }

    fn update_params(&self, resident: &ResidentGraph, params: &[GpuLayerParam]) -> Result<()> {
        if params.len() != resident.layer_count {
            bail!("property buffer layer count differs from resident graph");
        }
        self.queue
            .write_buffer(&resident.params_buffer, 0, bytemuck::cast_slice(params));
        Ok(())
    }

    fn render_resident(&self, resident: &ResidentGraph) -> Result<(Vec<u8>, f64)> {
        self.render_resident_with_display(
            resident,
            engine_graph::EngineDisplayTransform::SceneLinearPreview,
        )
    }

    fn render_resident_with_display(
        &self,
        resident: &ResidentGraph,
        display_transform: engine_graph::EngineDisplayTransform,
    ) -> Result<(Vec<u8>, f64)> {
        if display_transform.is_aces2() && (!resident.float_input || !resident.float_working) {
            bail!("ACES 2 display transform requires a float scene-linear resident graph");
        }
        let started = Instant::now();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Editkin compositor encoder"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Editkin layer pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(if resident.float_input {
                &self.float_input_pipeline
            } else if resident.float_working {
                &self.pipeline
            } else {
                &self.packed_pipeline
            });
            pass.set_bind_group(0, &resident.bind_group, &[]);
            pass.dispatch_workgroups(resident.width.div_ceil(16), resident.height.div_ceil(16), 1);
        }
        if let Some(pack_bind_group) = &resident.pack_bind_group {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some(match display_transform {
                    engine_graph::EngineDisplayTransform::SceneLinearPreview => {
                        "Editkin float output pack pass"
                    }
                    engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => {
                        "Editkin OCIO ACES 2 display output pack pass"
                    }
                    engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => {
                        "Editkin OCIO ACES 2 Rec.2100 HLG output pack pass"
                    }
                    engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
                        "Editkin OCIO ACES 2 Rec.2100 PQ output pack pass"
                    }
                }),
                timestamp_writes: None,
            });
            match display_transform {
                engine_graph::EngineDisplayTransform::SceneLinearPreview => {
                    pass.set_pipeline(if resident.float_input {
                        &self.linear_pack_pipeline
                    } else {
                        &self.pack_pipeline
                    });
                    pass.set_bind_group(0, pack_bind_group, &[]);
                }
                engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => {
                    pass.set_pipeline(&self.aces2_rec709_sdr_pipeline);
                    pass.set_bind_group(
                        0,
                        resident
                            .display_pack_bind_group
                            .as_ref()
                            .context("missing ACES 2 display pack bind group")?,
                        &[],
                    );
                }
                engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => {
                    pass.set_pipeline(&self.aces2_rec2100_hdr_pipeline);
                    pass.set_bind_group(
                        0,
                        resident
                            .display_pack_hlg_bind_group
                            .as_ref()
                            .context("missing ACES 2 Rec.2100 HLG display pack bind group")?,
                        &[],
                    );
                }
                engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
                    pass.set_pipeline(&self.aces2_rec2100_hdr_pipeline);
                    pass.set_bind_group(
                        0,
                        resident
                            .display_pack_pq_bind_group
                            .as_ref()
                            .context("missing ACES 2 Rec.2100 PQ display pack bind group")?,
                        &[],
                    );
                }
            }
            pass.dispatch_workgroups((resident.width * resident.height).div_ceil(256), 1, 1);
        }
        let readback_source = resident
            .packed_output_buffer
            .as_ref()
            .unwrap_or(&resident.output_buffer);
        let readback_size = if matches!(
            display_transform,
            engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000
                | engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000
        ) {
            resident.hdr_output_size
        } else {
            resident.output_size
        };
        encoder.copy_buffer_to_buffer(readback_source, 0, &resident.staging, 0, readback_size);
        self.queue.submit([encoder.finish()]);
        let slice = resident.staging.slice(..readback_size);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .context("poll GPU")?;
        receiver.recv().context("receive GPU map callback")??;
        let view = slice.get_mapped_range().context("read mapped GPU output")?;
        let bytes = view.to_vec();
        drop(view);
        resident.staging.unmap();
        Ok((bytes, started.elapsed().as_secs_f64() * 1000.0))
    }

    fn render(&self, prepared: &PreparedGraph) -> Result<(Vec<u8>, f64)> {
        let resident = self.upload(prepared)?;
        self.render_resident(&resident)
    }

    fn render_display(
        &self,
        prepared: &PreparedGraph,
        display_transform: engine_graph::EngineDisplayTransform,
    ) -> Result<(Vec<u8>, f64)> {
        let resident = self.upload(prepared)?;
        self.render_resident_with_display(&resident, display_transform)
    }

    fn render_float(&self, prepared: &PreparedGraph) -> Result<(Vec<f32>, f64)> {
        if !prepared.float_working || !prepared.float_input {
            bail!(
                "float artifact rendering requires a float working graph and float source boundary"
            );
        }
        let resident = self.upload(prepared)?;
        let staging = resident
            .float_staging
            .as_ref()
            .context("missing float staging buffer")?;
        let started = Instant::now();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Editkin float artifact encoder"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Editkin float artifact layer pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.float_input_pipeline);
            pass.set_bind_group(0, &resident.bind_group, &[]);
            pass.dispatch_workgroups(resident.width.div_ceil(16), resident.height.div_ceil(16), 1);
        }
        encoder.copy_buffer_to_buffer(
            &resident.output_buffer,
            0,
            staging,
            0,
            resident.width as u64 * resident.height as u64 * 16,
        );
        self.queue.submit([encoder.finish()]);
        let slice = staging.slice(..);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .context("poll GPU float artifact")?;
        receiver
            .recv()
            .context("receive GPU float map callback")??;
        let view = slice
            .get_mapped_range()
            .context("read mapped GPU float output")?;
        let values = view
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        drop(view);
        staging.unmap();
        Ok((values, started.elapsed().as_secs_f64() * 1000.0))
    }
}

fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn validate_graph(graph: &RenderGraph) -> Result<()> {
    if graph.schema != GRAPH_SCHEMA {
        bail!("unsupported graph schema: {}", graph.schema);
    }
    if graph.width == 0 || graph.height == 0 || graph.width > 8192 || graph.height > 8192 {
        bail!("invalid render size: {}x{}", graph.width, graph.height);
    }
    if graph.layers.is_empty() || graph.layers.len() > 64 {
        bail!("layer count must be 1..=64");
    }
    for layer in &graph.layers {
        if layer.id.trim().is_empty()
            || !layer.opacity.is_finite()
            || !(0.0..=1.0).contains(&layer.opacity)
        {
            bail!("invalid layer: {}", layer.id);
        }
        if !layer.transform.scale.is_finite()
            || layer.transform.scale <= 0.0
            || !layer.transform.x.is_finite()
            || !layer.transform.y.is_finite()
            || !layer.transform.rotation.is_finite()
        {
            bail!("invalid transform: {}", layer.id);
        }
    }
    Ok(())
}

fn load_graph(path: &Path) -> Result<RenderGraph> {
    let graph: RenderGraph = serde_json::from_slice(
        &fs::read(path).with_context(|| format!("read {}", path.display()))?,
    )
    .with_context(|| format!("parse {}", path.display()))?;
    validate_graph(&graph)?;
    Ok(graph)
}

fn prepare_graph(graph: RenderGraph, graph_dir: &Path) -> Result<PreparedGraph> {
    let pixel_count = graph.width as usize * graph.height as usize;
    let float_input = graph
        .layers
        .iter()
        .any(|layer| matches!(&layer.source, LayerSource::FloatImage { .. }));
    let values_per_pixel = if float_input { 4 } else { 1 };
    let mut packed_layers = Vec::with_capacity(pixel_count * graph.layers.len() * values_per_pixel);
    let mut params = Vec::with_capacity(graph.layers.len());
    for layer in &graph.layers {
        if float_input {
            let pixels =
                materialize_float_source(&layer.source, graph.width, graph.height, graph_dir)
                    .with_context(|| format!("materialize float layer {}", layer.id))?;
            packed_layers.extend(pixels.into_iter().flat_map(|pixel| pixel.map(f32::to_bits)));
        } else {
            let image = materialize_source(&layer.source, graph.width, graph.height, graph_dir)
                .with_context(|| format!("materialize layer {}", layer.id))?;
            packed_layers.extend(image.pixels().map(|pixel| u32::from_le_bytes(pixel.0)));
        }
        params.push(GpuLayerParam {
            opacity: layer.opacity,
            translate_x: layer.transform.x,
            translate_y: layer.transform.y,
            scale: layer.transform.scale,
            rotation: layer.transform.rotation,
            blend_mode: layer.blend_mode.code(),
            enabled: u32::from(layer.enabled),
            alpha_mode: layer.alpha_mode.resolved_for(&layer.source).code(),
            effect_kind: layer.effect.kind,
            effect_contrast: layer.effect.contrast,
            effect_brightness: layer.effect.brightness,
            _effect_pad: 0,
            projective_h0: layer.transform.projective[0],
            projective_h1: layer.transform.projective[1],
            projective_h2: layer.transform.projective[2],
            projective_h3: layer.transform.projective[3],
            projective_h4: layer.transform.projective[4],
            projective_h5: layer.transform.projective[5],
            projective_h6: layer.transform.projective[6],
            projective_h7: layer.transform.projective[7],
            projective_enabled: u32::from(layer.transform.projective_enabled),
            _projective_pad_x: 0,
            _projective_pad_y: 0,
            _projective_pad_z: 0,
            shade_r: layer.transform.shade[0],
            shade_g: layer.transform.shade[1],
            shade_b: layer.transform.shade[2],
            _shade_pad: 0.0,
            source_kind: u32::from(matches!(&layer.source, LayerSource::ParticleEmitter { .. })),
            particle_seed: match &layer.source {
                LayerSource::ParticleEmitter { seed, .. } => *seed,
                _ => 0,
            },
            particle_max: match &layer.source {
                LayerSource::ParticleEmitter { max_particles, .. } => *max_particles,
                _ => 0,
            },
            _particle_pad: 0,
            particle_rate: match &layer.source {
                LayerSource::ParticleEmitter {
                    rate_per_second, ..
                } => *rate_per_second,
                _ => 0.0,
            },
            particle_lifetime: match &layer.source {
                LayerSource::ParticleEmitter {
                    lifetime_seconds, ..
                } => *lifetime_seconds,
                _ => 0.0,
            },
            particle_time: match &layer.source {
                LayerSource::ParticleEmitter { time_seconds, .. } => *time_seconds,
                _ => 0.0,
            },
            particle_radius: match &layer.source {
                LayerSource::ParticleEmitter { radius_pixels, .. } => *radius_pixels,
                _ => 0.0,
            },
            particle_emitter_x: match &layer.source {
                LayerSource::ParticleEmitter {
                    emitter_position, ..
                } => emitter_position[0],
                _ => 0.0,
            },
            particle_emitter_y: match &layer.source {
                LayerSource::ParticleEmitter {
                    emitter_position, ..
                } => emitter_position[1],
                _ => 0.0,
            },
            particle_velocity_x: match &layer.source {
                LayerSource::ParticleEmitter {
                    initial_velocity, ..
                } => initial_velocity[0],
                _ => 0.0,
            },
            particle_velocity_y: match &layer.source {
                LayerSource::ParticleEmitter {
                    initial_velocity, ..
                } => initial_velocity[1],
                _ => 0.0,
            },
            particle_gravity_x: match &layer.source {
                LayerSource::ParticleEmitter { gravity, .. } => gravity[0],
                _ => 0.0,
            },
            particle_gravity_y: match &layer.source {
                LayerSource::ParticleEmitter { gravity, .. } => gravity[1],
                _ => 0.0,
            },
            particle_color_r: match &layer.source {
                LayerSource::ParticleEmitter { color, .. } => color[0],
                _ => 0.0,
            },
            particle_color_g: match &layer.source {
                LayerSource::ParticleEmitter { color, .. } => color[1],
                _ => 0.0,
            },
            particle_color_b: match &layer.source {
                LayerSource::ParticleEmitter { color, .. } => color[2],
                _ => 0.0,
            },
            particle_color_a: match &layer.source {
                LayerSource::ParticleEmitter { color, .. } => color[3],
                _ => 0.0,
            },
        });
    }
    Ok(PreparedGraph {
        width: graph.width,
        height: graph.height,
        layers: graph.layers,
        packed_layers,
        params,
        float_input,
        float_working: false,
    })
}

fn materialize_source(
    source: &LayerSource,
    width: u32,
    height: u32,
    graph_dir: &Path,
) -> Result<RgbaImage> {
    let mut output = RgbaImage::new(width, height);
    match source {
        LayerSource::Solid { color } => {
            for pixel in output.pixels_mut() {
                *pixel = Rgba(*color);
            }
        }
        LayerSource::Gradient {
            start,
            end,
            horizontal,
        } => {
            for y in 0..height {
                for x in 0..width {
                    let ratio = if *horizontal {
                        x as f32 / (width - 1).max(1) as f32
                    } else {
                        y as f32 / (height - 1).max(1) as f32
                    };
                    output.put_pixel(x, y, Rgba(interpolate(*start, *end, ratio)));
                }
            }
        }
        LayerSource::Radial {
            inner,
            outer,
            center,
            radius,
        } => {
            let cx = center[0] * width as f32;
            let cy = center[1] * height as f32;
            let radius_pixels = radius.max(0.0001) * width.min(height) as f32;
            for y in 0..height {
                for x in 0..width {
                    let distance = (((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt()
                        / radius_pixels)
                        .clamp(0.0, 1.0);
                    output.put_pixel(
                        x,
                        y,
                        Rgba(interpolate(*inner, *outer, smoothstep(distance))),
                    );
                }
            }
        }
        LayerSource::Rect {
            color,
            rect,
            radius,
        } => {
            let left = rect[0] * width as f32;
            let top = rect[1] * height as f32;
            let right = rect[2] * width as f32;
            let bottom = rect[3] * height as f32;
            let r = radius.max(0.0) * width.min(height) as f32;
            for y in 0..height {
                for x in 0..width {
                    if rounded_rect_contains(
                        x as f32 + 0.5,
                        y as f32 + 0.5,
                        left,
                        top,
                        right,
                        bottom,
                        r,
                    ) {
                        output.put_pixel(x, y, Rgba(*color));
                    }
                }
            }
        }
        LayerSource::Image { path } => {
            let absolute = if path.is_absolute() {
                path.clone()
            } else {
                graph_dir.join(path)
            };
            let source = image::open(&absolute)
                .with_context(|| format!("open {}", absolute.display()))?
                .into_rgba8();
            output = image::imageops::resize(
                &source,
                width,
                height,
                image::imageops::FilterType::Lanczos3,
            );
        }
        LayerSource::FloatImage { .. } => bail!("float image requires a float working input"),
        LayerSource::ParticleEmitter { .. } => {}
    }
    Ok(output)
}

const FLOAT_RGBA_MAGIC: &[u8; 8] = b"EKF32V1\0";

fn materialize_float_source(
    source: &LayerSource,
    width: u32,
    height: u32,
    graph_dir: &Path,
) -> Result<Vec<[f32; 4]>> {
    if let LayerSource::FloatImage { path } = source {
        let absolute = if path.is_absolute() {
            path.clone()
        } else {
            graph_dir.join(path)
        };
        return load_float_rgba(&absolute, width, height);
    }
    Ok(materialize_source(source, width, height, graph_dir)?
        .pixels()
        .map(|pixel| pixel.0.map(|channel| channel as f32 / 255.0))
        .collect())
}

fn load_float_rgba(
    path: &Path,
    expected_width: u32,
    expected_height: u32,
) -> Result<Vec<[f32; 4]>> {
    if extension_is(path, "exr") {
        return load_exr_rgba(path, expected_width, expected_height);
    }
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.len() < 16 || &bytes[..8] != FLOAT_RGBA_MAGIC {
        bail!("invalid Editkin float RGBA header: {}", path.display());
    }
    let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    if width != expected_width || height != expected_height {
        bail!(
            "float RGBA dimensions {width}x{height} do not match graph {expected_width}x{expected_height}"
        );
    }
    let pixel_count = width as usize * height as usize;
    if bytes.len() != 16 + pixel_count * 16 {
        bail!(
            "invalid Editkin float RGBA payload length: {}",
            path.display()
        );
    }
    let mut pixels = Vec::with_capacity(pixel_count);
    for pixel in bytes[16..].chunks_exact(16) {
        let value = std::array::from_fn(|channel| {
            f32::from_le_bytes(pixel[channel * 4..channel * 4 + 4].try_into().unwrap())
        });
        if value[..3].iter().any(|channel| !channel.is_finite())
            || !value[3].is_finite()
            || !(0.0..=1.0).contains(&value[3])
        {
            bail!("non-finite RGB or out-of-range alpha in {}", path.display());
        }
        pixels.push(value);
    }
    Ok(pixels)
}

fn load_exr_rgba(path: &Path, expected_width: u32, expected_height: u32) -> Result<Vec<[f32; 4]>> {
    let image = image::open(path)
        .with_context(|| format!("decode OpenEXR {}", path.display()))?
        .into_rgba32f();
    let (width, height) = image.dimensions();
    if width != expected_width || height != expected_height {
        bail!(
            "OpenEXR dimensions {width}x{height} do not match graph {expected_width}x{expected_height}"
        );
    }
    let pixels = image.pixels().map(|pixel| pixel.0).collect::<Vec<_>>();
    validate_float_pixels(&pixels, path)?;
    Ok(pixels)
}

fn validate_float_pixels(pixels: &[[f32; 4]], path: &Path) -> Result<()> {
    if pixels.iter().any(|value| {
        value[..3].iter().any(|channel| !channel.is_finite())
            || !value[3].is_finite()
            || !(0.0..=1.0).contains(&value[3])
    }) {
        bail!("non-finite RGB or out-of-range alpha in {}", path.display());
    }
    Ok(())
}

fn extension_is(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

fn interpolate(start: [u8; 4], end: [u8; 4], ratio: f32) -> [u8; 4] {
    let mut out = [0u8; 4];
    for index in 0..4 {
        out[index] = (start[index] as f32 * (1.0 - ratio) + end[index] as f32 * ratio)
            .round()
            .clamp(0.0, 255.0) as u8;
    }
    out
}

fn smoothstep(value: f32) -> f32 {
    let x = value.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

fn rounded_rect_contains(
    x: f32,
    y: f32,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    radius: f32,
) -> bool {
    if x < left || x >= right || y < top || y >= bottom {
        return false;
    }
    if radius <= 0.0 {
        return true;
    }
    let cx = x.clamp(left + radius, right - radius);
    let cy = y.clamp(top + radius, bottom - radius);
    (x - cx).powi(2) + (y - cy).powi(2) <= radius.powi(2)
}

fn composite_cpu(prepared: &PreparedGraph) -> Vec<u8> {
    let pixel_count = prepared.width as usize * prepared.height as usize;
    let mut output = vec![0u8; pixel_count * 4];
    for y in 0..prepared.height {
        for x in 0..prepared.width {
            let mut color = [0.0f32; 4];
            for (layer_index, layer) in prepared.layers.iter().enumerate() {
                if !layer.enabled {
                    continue;
                }
                let Some(source_index) =
                    transformed_index(x, y, prepared.width, prepared.height, layer.transform)
                else {
                    continue;
                };
                let source = source_pixel(prepared, layer_index, source_index, layer);
                color = if prepared.float_input {
                    composite_scene_linear(color, source, layer.opacity, layer.blend_mode)
                } else {
                    composite(color, source, layer.opacity, layer.blend_mode)
                };
            }
            let index = (y as usize * prepared.width as usize + x as usize) * 4;
            for channel in 0..3 {
                let display = if prepared.float_input {
                    rec709_oetf(color[channel])
                } else {
                    color[channel]
                };
                output[index + channel] = (display.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
            output[index + 3] = (color[3].clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    output
}

fn rec709_oetf(linear: f32) -> f32 {
    if linear < 0.018 {
        4.5 * linear
    } else {
        1.099 * linear.powf(0.45) - 0.099
    }
}

fn scene_linear_preview_bytes(values: &[f32]) -> Result<Vec<u8>> {
    if values.len() % 4 != 0 || values.iter().any(|value| !value.is_finite()) {
        bail!("scene-linear preview requires finite RGBA32F pixels");
    }
    let mut output = Vec::with_capacity(values.len());
    for pixel in values.chunks_exact(4) {
        for channel in &pixel[..3] {
            output.push((rec709_oetf(*channel).clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        output.push((pixel[3].clamp(0.0, 1.0) * 255.0).round() as u8);
    }
    Ok(output)
}

fn linear_rec709_to_acescct(rgb: [f32; 3]) -> [f32; 3] {
    let aces_ap1 = [
        0.61309740240118826_f32 * rgb[0]
            + 0.33952314618410551_f32 * rgb[1]
            + 0.047379451414707258_f32 * rgb[2],
        0.070193722469581596_f32 * rgb[0]
            + 0.91635387905734134_f32 * rgb[1]
            + 0.013452398473073862_f32 * rgb[2],
        0.020615592882227002_f32 * rgb[0]
            + 0.10956977293813569_f32 * rgb[1]
            + 0.86981463417963978_f32 * rgb[2],
    ];
    aces_ap1.map(|value| {
        if value > 0.0078125 {
            0.0823456049 * value.max(f32::MIN_POSITIVE).ln() + 0.5547945205479452
        } else {
            value * 10.5402374 + 0.0729055703
        }
    })
}

fn sample_ocio_lut_tetrahedral(lut: &OcioLut3d, rgb: [f32; 3]) -> [f32; 3] {
    let maximum = (lut.size - 1) as f32;
    let scaled = rgb.map(|value| value.clamp(0.0, 1.0) * maximum);
    let low = scaled.map(|value| (value.floor() as usize).min(lut.size - 2));
    let fraction: [f32; 3] = std::array::from_fn(|index| scaled[index] - low[index] as f32);
    let at = |dr: usize, dg: usize, db: usize| {
        let index = low[0] + dr + (low[1] + dg) * lut.size + (low[2] + db) * lut.size * lut.size;
        let value = lut.values[index];
        [value[0], value[1], value[2]]
    };
    let c000 = at(0, 0, 0);
    let c100 = at(1, 0, 0);
    let c010 = at(0, 1, 0);
    let c001 = at(0, 0, 1);
    let c110 = at(1, 1, 0);
    let c101 = at(1, 0, 1);
    let c011 = at(0, 1, 1);
    let c111 = at(1, 1, 1);
    std::array::from_fn(|channel| {
        if fraction[0] >= fraction[1] {
            if fraction[1] >= fraction[2] {
                c000[channel]
                    + fraction[0] * (c100[channel] - c000[channel])
                    + fraction[1] * (c110[channel] - c100[channel])
                    + fraction[2] * (c111[channel] - c110[channel])
            } else if fraction[0] >= fraction[2] {
                c000[channel]
                    + fraction[0] * (c100[channel] - c000[channel])
                    + fraction[2] * (c101[channel] - c100[channel])
                    + fraction[1] * (c111[channel] - c101[channel])
            } else {
                c000[channel]
                    + fraction[2] * (c001[channel] - c000[channel])
                    + fraction[0] * (c101[channel] - c001[channel])
                    + fraction[1] * (c111[channel] - c101[channel])
            }
        } else if fraction[2] >= fraction[1] {
            c000[channel]
                + fraction[2] * (c001[channel] - c000[channel])
                + fraction[1] * (c011[channel] - c001[channel])
                + fraction[0] * (c111[channel] - c011[channel])
        } else if fraction[2] >= fraction[0] {
            c000[channel]
                + fraction[1] * (c010[channel] - c000[channel])
                + fraction[2] * (c011[channel] - c010[channel])
                + fraction[0] * (c111[channel] - c011[channel])
        } else {
            c000[channel]
                + fraction[1] * (c010[channel] - c000[channel])
                + fraction[0] * (c110[channel] - c010[channel])
                + fraction[2] * (c111[channel] - c110[channel])
        }
    })
}

fn aces2_rec709_sdr_bytes(values: &[f32]) -> Result<Vec<u8>> {
    if values.len() % 4 != 0 || values.iter().any(|value| !value.is_finite()) {
        bail!("ACES 2 display transform requires finite RGBA32F pixels");
    }
    let lut = embedded_aces2_rec709_sdr_lut()?;
    let mut output = Vec::with_capacity(values.len());
    for pixel in values.chunks_exact(4) {
        let display = sample_ocio_lut_tetrahedral(
            &lut,
            linear_rec709_to_acescct([pixel[0], pixel[1], pixel[2]]),
        );
        output.extend(display.map(|channel| (channel.clamp(0.0, 1.0) * 255.0).round() as u8));
        output.push((pixel[3].clamp(0.0, 1.0) * 255.0).round() as u8);
    }
    Ok(output)
}

fn aces2_rec2100_hdr_bytes(
    values: &[f32],
    display_transform: engine_graph::EngineDisplayTransform,
) -> Result<Vec<u8>> {
    if values.len() % 4 != 0 || values.iter().any(|value| !value.is_finite()) {
        bail!("ACES 2 HDR display transform requires finite RGBA32F pixels");
    }
    let lut = match display_transform {
        engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => {
            embedded_aces2_rec2100_hlg_1000_lut()?
        }
        engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
            embedded_aces2_rec2100_pq_1000_lut()?
        }
        _ => bail!("HDR pixel packing requires an HLG or PQ display transform"),
    };
    let mut output = Vec::with_capacity(values.len() * 2);
    for pixel in values.chunks_exact(4) {
        let display = sample_ocio_lut_tetrahedral(
            &lut,
            linear_rec709_to_acescct([pixel[0], pixel[1], pixel[2]]),
        );
        for channel in display {
            output.extend_from_slice(
                &((channel.clamp(0.0, 1.0) * 65535.0).round() as u16).to_le_bytes(),
            );
        }
        output.extend_from_slice(
            &((pixel[3].clamp(0.0, 1.0) * 65535.0).round() as u16).to_le_bytes(),
        );
    }
    Ok(output)
}

fn display_lut_sha256(
    display_transform: engine_graph::EngineDisplayTransform,
) -> Option<&'static str> {
    match display_transform {
        engine_graph::EngineDisplayTransform::SceneLinearPreview => None,
        engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => Some(ACES2_REC709_SDR_LUT_SHA256),
        engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => {
            Some(ACES2_REC2100_HLG_1000_LUT_SHA256)
        }
        engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
            Some(ACES2_REC2100_PQ_1000_LUT_SHA256)
        }
    }
}

fn display_lut_payload_sha256(
    display_transform: engine_graph::EngineDisplayTransform,
) -> Option<&'static str> {
    match display_transform {
        engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000 => {
            Some(ACES2_REC2100_HLG_1000_PAYLOAD_SHA256)
        }
        engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
            Some(ACES2_REC2100_PQ_1000_PAYLOAD_SHA256)
        }
        _ => None,
    }
}

fn display_is_hdr(display_transform: engine_graph::EngineDisplayTransform) -> bool {
    matches!(
        display_transform,
        engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000
            | engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000
    )
}

fn composite_cpu_float(prepared: &PreparedGraph) -> Vec<f32> {
    let pixel_count = prepared.width as usize * prepared.height as usize;
    let mut output = vec![0.0f32; pixel_count * 4];
    for y in 0..prepared.height {
        for x in 0..prepared.width {
            let mut color = [0.0f32; 4];
            for (layer_index, layer) in prepared.layers.iter().enumerate() {
                if !layer.enabled {
                    continue;
                }
                let Some(source_index) =
                    transformed_index(x, y, prepared.width, prepared.height, layer.transform)
                else {
                    continue;
                };
                let source = source_pixel(prepared, layer_index, source_index, layer);
                color = composite_scene_linear(color, source, layer.opacity, layer.blend_mode);
            }
            let index = (y as usize * prepared.width as usize + x as usize) * 4;
            output[index..index + 4].copy_from_slice(&color);
        }
    }
    output
}

fn source_pixel(
    prepared: &PreparedGraph,
    layer_index: usize,
    source_index: usize,
    layer: &Layer,
) -> [f32; 4] {
    if matches!(&layer.source, LayerSource::ParticleEmitter { .. }) {
        return particle_source_pixel(
            &prepared.params[layer_index],
            prepared.width,
            prepared.height,
            source_index,
        );
    }
    let pixel_count = prepared.width as usize * prepared.height as usize;
    let mut output = if prepared.float_input {
        let offset = (layer_index * pixel_count + source_index) * 4;
        let value =
            std::array::from_fn(|channel| f32::from_bits(prepared.packed_layers[offset + channel]));
        apply_builtin_effect(
            normalize_source_alpha_float(value, layer.alpha_mode.resolved_for(&layer.source)),
            layer.effect,
        )
    } else {
        let packed = prepared.packed_layers[layer_index * pixel_count + source_index];
        apply_builtin_effect(
            normalize_source_alpha(
                packed.to_le_bytes(),
                layer.alpha_mode.resolved_for(&layer.source),
            ),
            layer.effect,
        )
    };
    for (channel, shade) in layer.transform.shade.into_iter().enumerate() {
        output[channel] *= shade;
    }
    output
}

fn particle_hash(seed: u32, index: u32, stream: u32) -> u32 {
    let mut value = seed ^ index.wrapping_mul(0x9e37_79b9) ^ stream.wrapping_mul(0x85eb_ca6b);
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^ (value >> 16)
}

fn particle_random(seed: u32, index: u32, stream: u32) -> f32 {
    (particle_hash(seed, index, stream) & 0xffff) as f32 / 65_535.0
}

fn particle_source_pixel(
    params: &GpuLayerParam,
    width: u32,
    height: u32,
    source_index: usize,
) -> [f32; 4] {
    if params.source_kind != 1
        || params.particle_rate <= 0.0
        || params.particle_lifetime <= 0.0
        || params.particle_max == 0
    {
        return [0.0; 4];
    }
    let x = (source_index % width as usize) as f32;
    let y = (source_index / width as usize) as f32;
    let spawned = (params.particle_time * params.particle_rate).floor() as i32;
    let emitter_x = params.particle_emitter_x * width.saturating_sub(1) as f32;
    let emitter_y = params.particle_emitter_y * height.saturating_sub(1) as f32;
    let mut alpha = 0.0f32;
    for slot in 0..params.particle_max.min(64) {
        let birth = spawned - slot as i32;
        if birth < 0 {
            continue;
        }
        let age = params.particle_time - birth as f32 / params.particle_rate;
        if !(0.0..=params.particle_lifetime).contains(&age) {
            continue;
        }
        let birth = birth as u32;
        let velocity_x = params.particle_velocity_x
            + (particle_random(params.particle_seed, birth, 0) - 0.5) * 42.0;
        let velocity_y = params.particle_velocity_y
            + (particle_random(params.particle_seed, birth, 1) - 0.5) * 18.0;
        let particle_x = emitter_x + velocity_x * age + 0.5 * params.particle_gravity_x * age * age;
        let particle_y = emitter_y + velocity_y * age + 0.5 * params.particle_gravity_y * age * age;
        let dx = x - particle_x;
        let dy = y - particle_y;
        let distance = (dx * dx + dy * dy).sqrt();
        let radius =
            params.particle_radius * (0.7 + particle_random(params.particle_seed, birth, 2) * 0.6);
        let core = ((radius - distance) / (radius * 0.35 + 0.5)).clamp(0.0, 1.0);
        let glow = ((radius * 2.4 - distance) / (radius * 1.8 + 0.5)).clamp(0.0, 1.0) * 0.18;
        let fade = (1.0 - age / params.particle_lifetime).clamp(0.0, 1.0);
        let particle_alpha = ((core + glow) * params.particle_color_a * fade).clamp(0.0, 1.0);
        alpha = particle_alpha + alpha * (1.0 - particle_alpha);
    }
    if alpha <= 0.0 {
        [0.0; 4]
    } else {
        [
            params.particle_color_r,
            params.particle_color_g,
            params.particle_color_b,
            alpha,
        ]
    }
}

fn normalize_source_alpha(bytes: [u8; 4], mode: SourceAlphaMode) -> [f32; 4] {
    let alpha = bytes[3] as f32 / 255.0;
    let mut output = [
        bytes[0] as f32 / 255.0,
        bytes[1] as f32 / 255.0,
        bytes[2] as f32 / 255.0,
        alpha,
    ];
    match mode {
        SourceAlphaMode::Opaque => output[3] = 1.0,
        SourceAlphaMode::Premultiplied if alpha > 0.000001 => {
            for channel in &mut output[..3] {
                *channel = (*channel / alpha).clamp(0.0, 1.0);
            }
        }
        SourceAlphaMode::Premultiplied => output = [0.0; 4],
        SourceAlphaMode::Auto | SourceAlphaMode::Straight => {}
    }
    output
}

fn normalize_source_alpha_float(mut output: [f32; 4], mode: SourceAlphaMode) -> [f32; 4] {
    let alpha = output[3];
    match mode {
        SourceAlphaMode::Opaque => output[3] = 1.0,
        SourceAlphaMode::Premultiplied if alpha > 0.000001 => {
            for channel in &mut output[..3] {
                *channel /= alpha;
            }
        }
        SourceAlphaMode::Premultiplied => output = [0.0; 4],
        SourceAlphaMode::Auto | SourceAlphaMode::Straight => {}
    }
    output
}

fn apply_builtin_effect(mut output: [f32; 4], effect: BuiltinEffect) -> [f32; 4] {
    if matches!(effect.kind, 1 | 2) {
        let (contrast_percent, brightness_code) = if effect.kind == 2 {
            (142i32, 5i32)
        } else {
            (118i32, 0i32)
        };
        let rgb_code: [u32; 3] =
            std::array::from_fn(|index| (output[index].clamp(0.0, 1.0) * 255.0).round() as u32);
        let luma_code =
            ((rgb_code[0] * 54 + rgb_code[1] * 183 + rgb_code[2] * 19 + 128) >> 8) as i32;
        let value = (((luma_code - 128) * contrast_percent) / 100 + 128 + brightness_code)
            .clamp(0, 255) as f32
            / 255.0;
        output[0] = value;
        output[1] = value;
        output[2] = value;
    }
    output
}

fn transformed_index(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    transform: Transform,
) -> Option<usize> {
    let center_x = (width - 1) as f32 * 0.5;
    let center_y = (height - 1) as f32 * 0.5;
    let (local_x, local_y) = if transform.projective_enabled {
        let destination_x = x as f32 - center_x;
        let destination_y = y as f32 - center_y;
        let h = transform.projective;
        let denominator = h[6] * destination_x + h[7] * destination_y + 1.0;
        if denominator.abs() <= 0.000001 {
            return None;
        }
        (
            (h[0] * destination_x + h[1] * destination_y + h[2]) / denominator + center_x,
            (h[3] * destination_x + h[4] * destination_y + h[5]) / denominator + center_y,
        )
    } else {
        let translated_x = x as f32 - center_x - transform.x;
        let translated_y = y as f32 - center_y - transform.y;
        let sine = (-transform.rotation).sin();
        let cosine = (-transform.rotation).cos();
        (
            (translated_x * cosine - translated_y * sine) / transform.scale + center_x,
            (translated_x * sine + translated_y * cosine) / transform.scale + center_y,
        )
    };
    if local_x < 0.0 || local_y < 0.0 || local_x >= width as f32 || local_y >= height as f32 {
        return None;
    }
    Some(local_y as usize * width as usize + local_x as usize)
}

fn composite(backdrop: [f32; 4], mut source: [f32; 4], opacity: f32, mode: BlendMode) -> [f32; 4] {
    source[3] *= opacity.clamp(0.0, 1.0);
    let output_alpha = source[3] + backdrop[3] * (1.0 - source[3]);
    if output_alpha <= 0.000001 {
        return [0.0; 4];
    }
    let mut output = [0.0; 4];
    for channel in 0..3 {
        let mixed = match mode {
            BlendMode::Normal => source[channel],
            BlendMode::Add => (backdrop[channel] + source[channel]).min(1.0),
            BlendMode::Screen => 1.0 - (1.0 - backdrop[channel]) * (1.0 - source[channel]),
            BlendMode::Multiply => backdrop[channel] * source[channel],
            BlendMode::Overlay => {
                if backdrop[channel] <= 0.5 {
                    2.0 * backdrop[channel] * source[channel]
                } else {
                    1.0 - 2.0 * (1.0 - backdrop[channel]) * (1.0 - source[channel])
                }
            }
            BlendMode::SoftLight => {
                (1.0 - 2.0 * source[channel]) * backdrop[channel] * backdrop[channel]
                    + 2.0 * source[channel] * backdrop[channel]
            }
            BlendMode::HardLight => {
                if source[channel] <= 0.5 {
                    2.0 * backdrop[channel] * source[channel]
                } else {
                    1.0 - 2.0 * (1.0 - backdrop[channel]) * (1.0 - source[channel])
                }
            }
            BlendMode::Difference => (backdrop[channel] - source[channel]).abs(),
            BlendMode::Darken => backdrop[channel].min(source[channel]),
            BlendMode::Lighten => backdrop[channel].max(source[channel]),
            BlendMode::ColorDodge => {
                if source[channel] >= 1.0 {
                    1.0
                } else {
                    (backdrop[channel] / (1.0 - source[channel])).min(1.0)
                }
            }
            BlendMode::ColorBurn => {
                if source[channel] <= 0.0 {
                    0.0
                } else {
                    1.0 - ((1.0 - backdrop[channel]) / source[channel]).min(1.0)
                }
            }
        };
        let premultiplied = backdrop[channel] * backdrop[3] * (1.0 - source[3])
            + source[channel] * source[3] * (1.0 - backdrop[3])
            + mixed * backdrop[3] * source[3];
        output[channel] = premultiplied / output_alpha;
    }
    output[3] = output_alpha;
    output
}

fn composite_scene_linear(
    backdrop: [f32; 4],
    mut source: [f32; 4],
    opacity: f32,
    mode: BlendMode,
) -> [f32; 4] {
    source[3] *= opacity.clamp(0.0, 1.0);
    let output_alpha = source[3] + backdrop[3] * (1.0 - source[3]);
    if output_alpha <= 0.000001 {
        return [0.0; 4];
    }
    let mut output = [0.0; 4];
    for channel in 0..3 {
        let mixed = match mode {
            BlendMode::Normal => source[channel],
            BlendMode::Add => backdrop[channel] + source[channel],
            BlendMode::Screen => 1.0 - (1.0 - backdrop[channel]) * (1.0 - source[channel]),
            BlendMode::Multiply => backdrop[channel] * source[channel],
            BlendMode::Overlay => {
                if backdrop[channel] <= 0.5 {
                    2.0 * backdrop[channel] * source[channel]
                } else {
                    1.0 - 2.0 * (1.0 - backdrop[channel]) * (1.0 - source[channel])
                }
            }
            BlendMode::SoftLight => {
                (1.0 - 2.0 * source[channel]) * backdrop[channel] * backdrop[channel]
                    + 2.0 * source[channel] * backdrop[channel]
            }
            BlendMode::HardLight => {
                if source[channel] <= 0.5 {
                    2.0 * backdrop[channel] * source[channel]
                } else {
                    1.0 - 2.0 * (1.0 - backdrop[channel]) * (1.0 - source[channel])
                }
            }
            BlendMode::Difference => (backdrop[channel] - source[channel]).abs(),
            BlendMode::Darken => backdrop[channel].min(source[channel]),
            BlendMode::Lighten => backdrop[channel].max(source[channel]),
            BlendMode::ColorDodge => {
                if source[channel] >= 1.0 {
                    1.0
                } else {
                    backdrop[channel] / (1.0 - source[channel]).max(0.000001)
                }
            }
            BlendMode::ColorBurn => {
                if source[channel] <= 0.0 {
                    0.0
                } else {
                    1.0 - (1.0 - backdrop[channel]) / source[channel].max(0.000001)
                }
            }
        };
        let premultiplied = backdrop[channel] * backdrop[3] * (1.0 - source[3])
            + source[channel] * source[3] * (1.0 - backdrop[3])
            + mixed * backdrop[3] * source[3];
        output[channel] = premultiplied / output_alpha;
    }
    output[3] = output_alpha;
    output
}

fn save_rgba(path: &Path, bytes: Vec<u8>, width: u32, height: u32) -> Result<()> {
    let image: RgbaImage = ImageBuffer::from_raw(width, height, bytes)
        .ok_or_else(|| anyhow!("invalid RGBA output length"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    image
        .save(path)
        .with_context(|| format!("save {}", path.display()))?;
    Ok(())
}

fn save_rgba16(path: &Path, bytes: &[u8], width: u32, height: u32) -> Result<()> {
    if bytes.len() != width as usize * height as usize * 8 {
        bail!("invalid RGBA16 output length");
    }
    let values = bytes
        .chunks_exact(2)
        .map(|value| u16::from_le_bytes([value[0], value[1]]))
        .collect::<Vec<_>>();
    let image: ImageBuffer<Rgba<u16>, Vec<u16>> = ImageBuffer::from_raw(width, height, values)
        .ok_or_else(|| anyhow!("invalid RGBA16 image dimensions"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    image
        .save(path)
        .with_context(|| format!("save 16-bit {}", path.display()))?;
    Ok(())
}

fn save_float_rgba(path: &Path, values: &[f32], width: u32, height: u32) -> Result<Vec<u8>> {
    if values.len() != width as usize * height as usize * 4
        || values.iter().any(|value| !value.is_finite())
    {
        bail!("invalid finite float RGBA output length");
    }
    if values
        .chunks_exact(4)
        .any(|pixel| !(0.0..=1.0).contains(&pixel[3]))
    {
        bail!("float RGBA output alpha must remain within 0..=1");
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if extension_is(path, "exr") {
        let image: Rgba32FImage = ImageBuffer::from_raw(width, height, values.to_vec())
            .ok_or_else(|| anyhow!("invalid RGBA32F output length"))?;
        image
            .save_with_format(path, ImageFormat::OpenExr)
            .with_context(|| format!("save OpenEXR {}", path.display()))?;
        return fs::read(path).with_context(|| format!("read saved OpenEXR {}", path.display()));
    }
    let mut bytes = Vec::with_capacity(16 + values.len() * 4);
    bytes.extend_from_slice(FLOAT_RGBA_MAGIC);
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    fs::write(path, &bytes).with_context(|| format!("save {}", path.display()))?;
    Ok(bytes)
}

fn requests_float_artifact(path: &Path) -> bool {
    extension_is(path, "ekf32") || extension_is(path, "exr")
}

fn float_artifact_container(path: &Path) -> &'static str {
    if extension_is(path, "exr") {
        "openexr"
    } else {
        "editkin-float-rgba/v1"
    }
}

fn output_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parity_error(left: &[u8], right: &[u8]) -> u8 {
    left.iter()
        .zip(right)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0)
}

fn percentile(values: &mut [f64], ratio: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    values[((values.len().saturating_sub(1)) as f64 * ratio).round() as usize]
}

fn render_command(graph_path: &Path, output: &Path, engine_name: &str) -> Result<()> {
    let graph = load_graph(graph_path)?;
    let prepared = prepare_graph(graph, graph_path.parent().unwrap_or_else(|| Path::new(".")))?;
    if engine_name == "cpu" {
        let started = Instant::now();
        let bytes = composite_cpu(&prepared);
        save_rgba(output, bytes.clone(), prepared.width, prepared.height)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "engine": "editkin-cpu-compositor/v1",
                "milliseconds": started.elapsed().as_secs_f64() * 1000.0,
                "output": output,
                "outputHash": output_hash(&bytes)
            }))?
        );
        return Ok(());
    }
    let compositor = GpuCompositor::new()?;
    let (bytes, render_milliseconds) = compositor.render(&prepared)?;
    save_rgba(output, bytes.clone(), prepared.width, prepared.height)?;
    let receipt = GpuReceipt {
        engine: "editkin-wgpu-compositor/v1",
        adapter_name: compositor.adapter_name,
        backend: compositor.backend,
        device_type: compositor.device_type,
        width: prepared.width,
        height: prepared.height,
        layer_count: prepared.layers.len(),
        render_milliseconds,
        output_sha256: output_hash(&bytes),
    };
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}

fn engine_render_command(
    graph_path: &Path,
    bindings_path: &Path,
    timeline_frame: u64,
    output: &Path,
    engine_name: &str,
) -> Result<()> {
    if !matches!(engine_name, "gpu" | "cpu") {
        bail!("engine-render backend must be gpu or cpu");
    }
    let graph: hao_core::engine::EngineGraph = serde_json::from_slice(
        &fs::read(graph_path).with_context(|| format!("read {}", graph_path.display()))?,
    )
    .with_context(|| format!("parse {}", graph_path.display()))?;
    let bindings: BTreeMap<String, PathBuf> = serde_json::from_slice(
        &fs::read(bindings_path).with_context(|| format!("read {}", bindings_path.display()))?,
    )
    .with_context(|| format!("parse {}", bindings_path.display()))?;
    let engine_graph::PreparedEngineGraph {
        prepared,
        coverage,
        timeline: _,
        display_transform,
        scene_25d,
        vfx_simulation,
    } = engine_graph::prepare(
        graph,
        &bindings,
        bindings_path.parent().unwrap_or_else(|| Path::new(".")),
        timeline_frame,
    )?;
    if requests_float_artifact(output) {
        if display_transform != engine_graph::EngineDisplayTransform::SceneLinearPreview {
            bail!("float output cannot contain a display-referred output transform");
        }
        if coverage.requested_working_format != "rgba32_float" || !prepared.float_input {
            bail!(
                "float output requires rgba32_float working format and a scene-linear float source binding"
            );
        }
        let started = Instant::now();
        let (values, render_milliseconds, adapter, backend, device_type) = if engine_name == "cpu" {
            (
                composite_cpu_float(&prepared),
                started.elapsed().as_secs_f64() * 1000.0,
                "cpu-reference".to_owned(),
                "cpu".to_owned(),
                "cpu".to_owned(),
            )
        } else {
            let compositor = GpuCompositor::new()?;
            let (values, milliseconds) = compositor.render_float(&prepared)?;
            (
                values,
                milliseconds,
                compositor.adapter_name,
                compositor.backend,
                compositor.device_type,
            )
        };
        let artifact = save_float_rgba(output, &values, prepared.width, prepared.height)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "engine": "editkin-common-graph-wgpu-executor/v1",
                "graphSchema": coverage.graph_schema,
                "graphId": coverage.graph_id,
                "directExecution": coverage.direct_execution,
                "requestedWorkingFormat": coverage.requested_working_format,
                "executionFormat": coverage.execution_format,
                "artifactFormat": "rgba32_float",
                "artifactContainer": float_artifact_container(output),
                "timelineFrame": timeline_frame,
                "adapterName": adapter,
                "backend": backend,
                "deviceType": device_type,
                "width": prepared.width,
                "height": prepared.height,
                "layerCount": prepared.layers.len(),
                "sourceAlphaModes": prepared.layers.iter().map(|layer| layer.alpha_mode.resolved_for(&layer.source)).collect::<Vec<_>>(),
                "renderMilliseconds": render_milliseconds,
                "outputSha256": output_hash(&artifact),
                "executedNodeIds": coverage.executed_node_ids,
                "blockedNodeIds": coverage.blocked_node_ids,
                "ignoredNodeIds": coverage.ignored_node_ids,
                "scene25d": scene_25d,
                "vfxSimulation": vfx_simulation,
            }))?
        );
        return Ok(());
    }
    let started = Instant::now();
    let (bytes, render_milliseconds, adapter, backend, device_type) = if engine_name == "cpu" {
        let bytes = match display_transform {
            engine_graph::EngineDisplayTransform::SceneLinearPreview => composite_cpu(&prepared),
            engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => {
                aces2_rec709_sdr_bytes(&composite_cpu_float(&prepared))?
            }
            engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000
            | engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
                aces2_rec2100_hdr_bytes(&composite_cpu_float(&prepared), display_transform)?
            }
        };
        (
            bytes,
            started.elapsed().as_secs_f64() * 1000.0,
            "cpu-reference".to_owned(),
            "cpu".to_owned(),
            "cpu".to_owned(),
        )
    } else {
        let compositor = GpuCompositor::new_for_display(display_transform)?;
        let (bytes, milliseconds) = compositor.render_display(&prepared, display_transform)?;
        (
            bytes,
            milliseconds,
            compositor.adapter_name,
            compositor.backend,
            compositor.device_type,
        )
    };
    if display_is_hdr(display_transform) {
        save_rgba16(output, &bytes, prepared.width, prepared.height)?;
    } else {
        save_rgba(output, bytes.clone(), prepared.width, prepared.height)?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "engine": "editkin-common-graph-wgpu-executor/v1",
            "graphSchema": coverage.graph_schema,
            "graphId": coverage.graph_id,
            "directExecution": coverage.direct_execution,
            "requestedWorkingFormat": coverage.requested_working_format,
            "executionFormat": coverage.execution_format,
            "artifactFormat": if display_is_hdr(display_transform) { "rgba16_unorm" } else { "rgba8" },
            "artifactContainer": "png",
            "displayTransform": display_transform,
            "colorProcessor": display_transform.processor(),
            "ocioVersion": if display_transform.is_aces2() { Some("2.5.2") } else { None },
            "acesVersion": if display_transform.is_aces2() { Some("2.0") } else { None },
            "configSha256": if display_transform.is_aces2() { Some("eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a") } else { None },
            "lutSha256": display_lut_sha256(display_transform),
            "lutPayloadSha256": display_lut_payload_sha256(display_transform),
            "timelineFrame": timeline_frame,
            "adapterName": adapter,
            "backend": backend,
            "deviceType": device_type,
            "width": prepared.width,
            "height": prepared.height,
            "layerCount": prepared.layers.len(),
            "sourceAlphaModes": prepared.layers.iter().map(|layer| layer.alpha_mode.resolved_for(&layer.source)).collect::<Vec<_>>(),
            "renderMilliseconds": render_milliseconds,
            "outputSha256": output_hash(&bytes),
            "executedNodeIds": coverage.executed_node_ids,
            "blockedNodeIds": coverage.blocked_node_ids,
            "ignoredNodeIds": coverage.ignored_node_ids,
            "scene25d": scene_25d,
            "vfxSimulation": vfx_simulation,
        }))?
    );
    Ok(())
}

fn engine_render_sequence_command(
    graph_path: &Path,
    bindings_path: &Path,
    start_frame: u64,
    frame_count: u64,
    output_directory: &Path,
    engine_name: &str,
) -> Result<()> {
    if !matches!(engine_name, "gpu" | "cpu") {
        bail!("engine-render-sequence backend must be gpu or cpu");
    }
    if frame_count == 0 || frame_count > 1_000_000 {
        bail!("engine-render-sequence frame count must be 1..=1000000");
    }
    start_frame
        .checked_add(frame_count)
        .context("engine-render-sequence frame range overflow")?;
    if output_directory.exists() {
        bail!(
            "engine-render-sequence output directory already exists: {}",
            output_directory.display()
        );
    }
    let graph: hao_core::engine::EngineGraph = serde_json::from_slice(
        &fs::read(graph_path).with_context(|| format!("read {}", graph_path.display()))?,
    )
    .with_context(|| format!("parse {}", graph_path.display()))?;
    let bindings: BTreeMap<String, PathBuf> = serde_json::from_slice(
        &fs::read(bindings_path).with_context(|| format!("read {}", bindings_path.display()))?,
    )
    .with_context(|| format!("parse {}", bindings_path.display()))?;
    let parent = output_directory.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let directory_name = output_directory
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("openexr-sequence");
    let temporary_directory = parent.join(format!(
        ".{directory_name}.editkin-partial-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    if temporary_directory.exists() {
        bail!("engine-render-sequence temporary output collision");
    }
    fs::create_dir(&temporary_directory)
        .with_context(|| format!("create {}", temporary_directory.display()))?;

    let result = (|| -> Result<serde_json::Value> {
        let compositor = if engine_name == "gpu" {
            Some(GpuCompositor::new()?)
        } else {
            None
        };
        let mut render_times = Vec::with_capacity(frame_count.min(100_000) as usize);
        let mut sequence_hasher = Sha256::new();
        let mut first_frame_sha256 = None;
        let mut last_frame_sha256 = String::new();
        let mut total_bytes = 0_u64;
        let mut width = 0_u32;
        let mut height = 0_u32;
        let mut layer_count = 0_usize;
        let mut graph_id = String::new();
        let mut executed_node_ids = Vec::new();
        for offset in 0..frame_count {
            let timeline_frame = start_frame + offset;
            let engine_graph::PreparedEngineGraph {
                prepared,
                coverage,
                timeline: _,
                display_transform,
                scene_25d: _,
                vfx_simulation: _,
            } = engine_graph::prepare(
                graph.clone(),
                &bindings,
                bindings_path.parent().unwrap_or_else(|| Path::new(".")),
                timeline_frame,
            )?;
            if coverage.requested_working_format != "rgba32_float" || !prepared.float_input {
                bail!(
                    "OpenEXR sequence requires rgba32_float working format and a scene-linear float source binding"
                );
            }
            if display_transform != engine_graph::EngineDisplayTransform::SceneLinearPreview {
                bail!("OpenEXR sequence cannot contain a display-referred output transform");
            }
            let started = Instant::now();
            let (values, render_milliseconds) = if let Some(compositor) = compositor.as_ref() {
                compositor.render_float(&prepared)?
            } else {
                let values = composite_cpu_float(&prepared);
                (values, started.elapsed().as_secs_f64() * 1_000.0)
            };
            let frame_path = temporary_directory.join(format!("frame-{timeline_frame:08}.exr"));
            let artifact = save_float_rgba(&frame_path, &values, prepared.width, prepared.height)?;
            let artifact_sha256 = output_hash(&artifact);
            if first_frame_sha256.is_none() {
                save_rgba(
                    &temporary_directory.join("preview.png"),
                    scene_linear_preview_bytes(&values)?,
                    prepared.width,
                    prepared.height,
                )?;
                first_frame_sha256 = Some(artifact_sha256.clone());
                width = prepared.width;
                height = prepared.height;
                layer_count = prepared.layers.len();
                graph_id = coverage.graph_id.clone();
                executed_node_ids = coverage.executed_node_ids.clone();
            } else if prepared.width != width
                || prepared.height != height
                || prepared.layers.len() != layer_count
                || coverage.graph_id != graph_id
                || coverage.executed_node_ids != executed_node_ids
            {
                bail!("OpenEXR sequence graph coverage changed between frames");
            }
            sequence_hasher.update(&artifact);
            total_bytes = total_bytes
                .checked_add(artifact.len() as u64)
                .context("OpenEXR sequence byte count overflow")?;
            last_frame_sha256 = artifact_sha256;
            render_times.push(render_milliseconds);
        }
        let total_render_milliseconds = render_times.iter().sum::<f64>();
        let mut p95_times = render_times.clone();
        let adapter_name = compositor
            .as_ref()
            .map(|value| value.adapter_name.clone())
            .unwrap_or_else(|| "cpu-reference".into());
        let backend = compositor
            .as_ref()
            .map(|value| value.backend.clone())
            .unwrap_or_else(|| "cpu".into());
        let device_type = compositor
            .as_ref()
            .map(|value| value.device_type.clone())
            .unwrap_or_else(|| "cpu".into());
        let receipt = serde_json::json!({
            "schema": "editkin.openexr-sequence/v1",
            "status": "GREEN",
            "engine": "editkin-common-graph-wgpu-sequence-executor/v1",
            "graphSchema": "editkin.engine-graph/v1",
            "graphId": graph_id,
            "directExecution": true,
            "workingColorSpace": "linear_rec709",
            "artifactFormat": "rgba32_float",
            "artifactContainer": "openexr",
            "alphaMode": "straight",
            "audioIncluded": false,
            "timebase": {
                "numerator": graph.timebase.numerator,
                "denominator": graph.timebase.denominator
            },
            "startFrame": start_frame,
            "frameCount": frame_count,
            "lastFrame": start_frame + frame_count - 1,
            "filePattern": "frame-%08d.exr",
            "previewFile": "preview.png",
            "width": width,
            "height": height,
            "layerCount": layer_count,
            "adapterName": adapter_name,
            "backend": backend,
            "deviceType": device_type,
            "deviceCreationCount": if compositor.is_some() { 1 } else { 0 },
            "renderMilliseconds": {
                "total": total_render_milliseconds,
                "average": total_render_milliseconds / frame_count as f64,
                "p95": percentile(&mut p95_times, 0.95)
            },
            "totalBytes": total_bytes,
            "sequenceSha256": format!("{:x}", sequence_hasher.finalize()),
            "firstFrameSha256": first_frame_sha256.context("OpenEXR sequence rendered no frames")?,
            "lastFrameSha256": last_frame_sha256,
            "executedNodeIds": executed_node_ids,
            "blockedNodeIds": [],
            "ignoredNodeIds": []
        });
        fs::write(
            temporary_directory.join("editkin-openexr-sequence.json"),
            serde_json::to_vec_pretty(&receipt)?,
        )?;
        Ok(receipt)
    })();

    match result {
        Ok(receipt) => {
            fs::rename(&temporary_directory, output_directory).with_context(|| {
                format!(
                    "commit OpenEXR sequence {} -> {}",
                    temporary_directory.display(),
                    output_directory.display()
                )
            })?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "outputDirectory": output_directory,
                    "manifestPath": output_directory.join("editkin-openexr-sequence.json"),
                    "receipt": receipt
                }))?
            );
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&temporary_directory);
            Err(error)
        }
    }
}

fn engine_render_display_sequence_command(
    graph_path: &Path,
    bindings_path: &Path,
    start_frame: u64,
    frame_count: u64,
    output_directory: &Path,
    engine_name: &str,
) -> Result<()> {
    if !matches!(engine_name, "gpu" | "cpu") {
        bail!("engine-render-display-sequence backend must be gpu or cpu");
    }
    if frame_count == 0 || frame_count > 1_000_000 {
        bail!("engine-render-display-sequence frame count must be 1..=1000000");
    }
    start_frame
        .checked_add(frame_count)
        .context("engine-render-display-sequence frame range overflow")?;
    if output_directory.exists() {
        bail!(
            "engine-render-display-sequence output directory already exists: {}",
            output_directory.display()
        );
    }
    let graph: hao_core::engine::EngineGraph = serde_json::from_slice(
        &fs::read(graph_path).with_context(|| format!("read {}", graph_path.display()))?,
    )
    .with_context(|| format!("parse {}", graph_path.display()))?;
    let bindings: BTreeMap<String, PathBuf> = serde_json::from_slice(
        &fs::read(bindings_path).with_context(|| format!("read {}", bindings_path.display()))?,
    )
    .with_context(|| format!("parse {}", bindings_path.display()))?;
    let parent = output_directory.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let directory_name = output_directory
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("aces2-display-sequence");
    let temporary_directory = parent.join(format!(
        ".{directory_name}.editkin-partial-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    if temporary_directory.exists() {
        bail!("engine-render-display-sequence temporary output collision");
    }
    fs::create_dir(&temporary_directory)
        .with_context(|| format!("create {}", temporary_directory.display()))?;

    let result = (|| -> Result<serde_json::Value> {
        let initial = engine_graph::prepare(
            graph.clone(),
            &bindings,
            bindings_path.parent().unwrap_or_else(|| Path::new(".")),
            start_frame,
        )?;
        let sequence_transform = initial.display_transform;
        if !sequence_transform.is_aces2()
            || initial.coverage.requested_working_format != "rgba32_float"
            || !initial.prepared.float_input
        {
            bail!("display sequence requires a measured rgba32_float ACES 2 transform");
        }
        let compositor = if engine_name == "gpu" {
            Some(GpuCompositor::new_for_display(sequence_transform)?)
        } else {
            None
        };
        let mut render_times = Vec::with_capacity(frame_count.min(100_000) as usize);
        let mut sequence_hasher = Sha256::new();
        let mut first_frame_sha256 = None;
        let mut last_frame_sha256 = String::new();
        let mut total_bytes = 0_u64;
        let mut width = 0_u32;
        let mut height = 0_u32;
        let mut layer_count = 0_usize;
        let mut graph_id = String::new();
        let mut executed_node_ids = Vec::new();
        for offset in 0..frame_count {
            let timeline_frame = start_frame + offset;
            let engine_graph::PreparedEngineGraph {
                prepared,
                coverage,
                timeline: _,
                display_transform,
                scene_25d: _,
                vfx_simulation: _,
            } = engine_graph::prepare(
                graph.clone(),
                &bindings,
                bindings_path.parent().unwrap_or_else(|| Path::new(".")),
                timeline_frame,
            )?;
            if coverage.requested_working_format != "rgba32_float"
                || !prepared.float_input
                || display_transform != sequence_transform
            {
                bail!("display sequence transform or float graph changed between frames");
            }
            let started = Instant::now();
            let (bytes, render_milliseconds) = if let Some(compositor) = compositor.as_ref() {
                compositor.render_display(&prepared, display_transform)?
            } else {
                let values = composite_cpu_float(&prepared);
                let bytes = match display_transform {
                    engine_graph::EngineDisplayTransform::Aces2Rec709Sdr => {
                        aces2_rec709_sdr_bytes(&values)?
                    }
                    engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000
                    | engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000 => {
                        aces2_rec2100_hdr_bytes(&values, display_transform)?
                    }
                    engine_graph::EngineDisplayTransform::SceneLinearPreview => {
                        bail!("display sequence lost its ACES 2 transform")
                    }
                };
                (bytes, started.elapsed().as_secs_f64() * 1_000.0)
            };
            let frame_path = temporary_directory.join(format!("frame-{timeline_frame:08}.png"));
            if display_is_hdr(display_transform) {
                save_rgba16(&frame_path, &bytes, prepared.width, prepared.height)?;
            } else {
                save_rgba(&frame_path, bytes, prepared.width, prepared.height)?;
            }
            let artifact = fs::read(&frame_path)
                .with_context(|| format!("read display frame {}", frame_path.display()))?;
            let artifact_sha256 = output_hash(&artifact);
            if first_frame_sha256.is_none() {
                first_frame_sha256 = Some(artifact_sha256.clone());
                width = prepared.width;
                height = prepared.height;
                layer_count = prepared.layers.len();
                graph_id = coverage.graph_id.clone();
                executed_node_ids = coverage.executed_node_ids.clone();
            } else if prepared.width != width
                || prepared.height != height
                || prepared.layers.len() != layer_count
                || coverage.graph_id != graph_id
                || coverage.executed_node_ids != executed_node_ids
            {
                bail!("display sequence graph coverage changed between frames");
            }
            sequence_hasher.update(&artifact);
            total_bytes = total_bytes
                .checked_add(artifact.len() as u64)
                .context("display sequence byte count overflow")?;
            last_frame_sha256 = artifact_sha256;
            render_times.push(render_milliseconds);
        }
        let total_render_milliseconds = render_times.iter().sum::<f64>();
        let mut p95_times = render_times.clone();
        let receipt = serde_json::json!({
            "schema": "editkin.ocio-display-sequence/v1",
            "status": "GREEN",
            "engine": "editkin-common-graph-wgpu-display-sequence-executor/v1",
            "graphSchema": "editkin.engine-graph/v1",
            "graphId": graph_id,
            "directExecution": true,
            "sourceWorkingColorSpace": "linear_rec709",
            "workingColorSpace": "ACEScct",
            "displayColorSpace": sequence_transform.output_space(),
            "displayTransform": sequence_transform,
            "colorProcessor": sequence_transform.processor(),
            "ocioVersion": "2.5.2",
            "acesVersion": "2.0",
            "configSha256": "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
            "lutSha256": display_lut_sha256(sequence_transform),
            "lutPayloadSha256": display_lut_payload_sha256(sequence_transform),
            "artifactFormat": if display_is_hdr(sequence_transform) { "rgba16_unorm" } else { "rgba8" },
            "artifactContainer": "png-sequence",
            "alphaMode": "straight",
            "audioIncluded": false,
            "timebase": { "numerator": graph.timebase.numerator, "denominator": graph.timebase.denominator },
            "startFrame": start_frame,
            "frameCount": frame_count,
            "lastFrame": start_frame + frame_count - 1,
            "filePattern": "frame-%08d.png",
            "width": width,
            "height": height,
            "layerCount": layer_count,
            "adapterName": compositor.as_ref().map(|value| value.adapter_name.clone()).unwrap_or_else(|| "cpu-reference".into()),
            "backend": compositor.as_ref().map(|value| value.backend.clone()).unwrap_or_else(|| "cpu".into()),
            "deviceType": compositor.as_ref().map(|value| value.device_type.clone()).unwrap_or_else(|| "cpu".into()),
            "deviceCreationCount": if compositor.is_some() { 1 } else { 0 },
            "renderMilliseconds": {
                "total": total_render_milliseconds,
                "average": total_render_milliseconds / frame_count as f64,
                "p95": percentile(&mut p95_times, 0.95)
            },
            "totalBytes": total_bytes,
            "sequenceSha256": format!("{:x}", sequence_hasher.finalize()),
            "firstFrameSha256": first_frame_sha256.context("display sequence rendered no frames")?,
            "lastFrameSha256": last_frame_sha256,
            "executedNodeIds": executed_node_ids,
            "blockedNodeIds": [],
            "ignoredNodeIds": []
        });
        fs::write(
            temporary_directory.join("editkin-ocio-display-sequence.json"),
            serde_json::to_vec_pretty(&receipt)?,
        )?;
        Ok(receipt)
    })();

    match result {
        Ok(receipt) => {
            fs::rename(&temporary_directory, output_directory).with_context(|| {
                format!(
                    "commit display sequence {} -> {}",
                    temporary_directory.display(),
                    output_directory.display()
                )
            })?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "outputDirectory": output_directory,
                    "manifestPath": output_directory.join("editkin-ocio-display-sequence.json"),
                    "receipt": receipt
                }))?
            );
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&temporary_directory);
            Err(error)
        }
    }
}

fn benchmark_command(graph_path: &Path, frames: usize, report_path: Option<&Path>) -> Result<()> {
    if frames == 0 || frames > 10_000 {
        bail!("frames must be 1..=10000");
    }
    let graph = load_graph(graph_path)?;
    let prepared = prepare_graph(graph, graph_path.parent().unwrap_or_else(|| Path::new(".")))?;
    let compositor = GpuCompositor::new()?;
    let (gpu_reference, _) = compositor.render(&prepared)?;
    let cpu_reference = composite_cpu(&prepared);
    let parity = parity_error(&gpu_reference, &cpu_reference);
    if parity > 2 {
        bail!("GPU/CPU parity failed: max channel error {parity}");
    }
    let mut gpu_times = Vec::with_capacity(frames);
    for _ in 0..frames {
        let (_, elapsed) = compositor.render(&prepared)?;
        gpu_times.push(elapsed);
    }
    let cpu_started = Instant::now();
    for _ in 0..frames {
        std::hint::black_box(composite_cpu(&prepared));
    }
    let cpu_average = cpu_started.elapsed().as_secs_f64() * 1000.0 / frames as f64;
    let gpu_average = gpu_times.iter().sum::<f64>() / frames as f64;
    let mut p95_values = gpu_times.clone();
    let report = BenchmarkReport {
        schema: "hao.gpu-compositor-benchmark/v1",
        adapter_name: compositor.adapter_name,
        backend: compositor.backend,
        frames,
        width: prepared.width,
        height: prepared.height,
        layers: prepared.layers.len(),
        gpu_average_ms: gpu_average,
        gpu_p95_ms: percentile(&mut p95_values, 0.95),
        gpu_fps_equivalent: 1000.0 / gpu_average.max(0.0001),
        cpu_average_ms: cpu_average,
        cpu_fps_equivalent: 1000.0 / cpu_average.max(0.0001),
        parity_max_channel_error: parity,
        note: "Prototype includes upload and readback per frame; production preview keeps textures resident and does not block for CPU readback.",
    };
    let json = serde_json::to_string_pretty(&report)? + "\n";
    if let Some(path) = report_path {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &json)?;
    }
    print!("{json}");
    Ok(())
}

fn selftest(graph_path: &Path, output_dir: &Path) -> Result<()> {
    let graph = load_graph(graph_path)?;
    let prepared = prepare_graph(graph, graph_path.parent().unwrap_or_else(|| Path::new(".")))?;
    let cpu = composite_cpu(&prepared);
    save_rgba(
        &output_dir.join("cpu-reference.png"),
        cpu.clone(),
        prepared.width,
        prepared.height,
    )?;
    let compositor = GpuCompositor::new()?;
    let (gpu, elapsed) = compositor.render(&prepared)?;
    let parity = parity_error(&cpu, &gpu);
    save_rgba(
        &output_dir.join("gpu-reference.png"),
        gpu,
        prepared.width,
        prepared.height,
    )?;
    if parity > 2 {
        bail!("GPU/CPU parity max channel error {parity}");
    }
    let receipt = serde_json::json!({
        "status": "GREEN",
        "engine": "editkin-wgpu-compositor/v1",
        "adapter": compositor.adapter_name,
        "backend": compositor.backend,
        "deviceType": compositor.device_type,
        "size": [prepared.width, prepared.height],
        "layers": prepared.layers.len(),
        "gpuMilliseconds": elapsed,
        "parityMaxChannelError": parity,
        "blendModes": ["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"],
    });
    fs::create_dir_all(output_dir)?;
    fs::write(
        output_dir.join("selftest-receipt.json"),
        serde_json::to_string_pretty(&receipt)? + "\n",
    )?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}

fn probe_command() -> Result<()> {
    let compositor = GpuCompositor::new()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "status": "GREEN",
            "engine": "editkin-wgpu-compositor/v1",
            "adapter": compositor.adapter_name,
            "backend": compositor.backend,
            "deviceType": compositor.device_type,
            "blendModes": ["normal", "add", "screen", "multiply", "overlay", "soft_light", "hard_light", "difference", "darken", "lighten", "color_dodge", "color_burn"]
        }))?
    );
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerRequest {
    id: String,
    command: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_ids: Option<Vec<String>>,
    #[serde(default)]
    graph_path: Option<PathBuf>,
    #[serde(default)]
    bindings_path: Option<PathBuf>,
    #[serde(default)]
    effect_bindings_path: Option<PathBuf>,
    #[serde(default)]
    output_path: Option<PathBuf>,
    #[serde(default)]
    input_path: Option<PathBuf>,
    #[serde(default)]
    time_seconds: Option<f64>,
    #[serde(default)]
    tolerance_seconds: Option<f64>,
    #[serde(default)]
    params: Option<Vec<GpuLayerParam>>,
    #[serde(default)]
    parent_hwnd: Option<String>,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    surface_color_space: Option<String>,
    #[serde(default)]
    timeline_frame: Option<u64>,
}

struct ResidentSession {
    graph: ResidentGraph,
    params: Vec<GpuLayerParam>,
    engine_timeline: Option<engine_graph::EngineTimelinePlan>,
    engine_coverage: Option<serde_json::Value>,
    engine_scene_25d: Option<serde_json::Value>,
    engine_vfx_simulation: Option<serde_json::Value>,
    display_transform: engine_graph::EngineDisplayTransform,
}

#[cfg(windows)]
struct ResidentEngineVideoSession {
    layers: Vec<ResidentEngineVideoLayer>,
    controllers: Vec<engine_graph::EngineVideoControllerPlan>,
    adjustments: Vec<engine_graph::EngineVideoAdjustmentPlan>,
    adjustment_before_typography: bool,
    particles: Vec<ResidentEngineParticle>,
    captions: Vec<ResidentEngineCaption>,
    motion_graphics: Vec<ResidentEngineMotionGraphic>,
    width: u32,
    height: u32,
    coverage: serde_json::Value,
    resource_plan: serde_json::Value,
    decode_schedule: serde_json::Value,
    display_transform: engine_graph::EngineDisplayTransform,
    scene_graph: Option<hao_core::engine::EngineGraph>,
    scene_25d_structure: Option<engine_graph::EngineScene25dCoverage>,
    depth_of_field: Option<engine_graph::EngineVideoDepthOfFieldPlan>,
    vfx_simulation: Option<serde_json::Value>,
}

#[cfg(windows)]
fn resident_video_requires_rec709_v2(session: &ResidentEngineVideoSession) -> bool {
    !session.display_transform.is_aces2() && (
        session.layers.iter().any(|layer| layer.visual_plan.primary_processor_version == 2)
        || session.adjustments.iter().any(|adjustment| adjustment.visual.primary_processor_version == 2)
    )
}

#[cfg(windows)]
fn resident_engine_scene_at(
    session: &ResidentEngineVideoSession,
    timeline_frame: u64,
) -> Result<Option<engine_graph::EngineScene25dPlan>> {
    let (Some(graph), Some(structure)) = (
        session.scene_graph.as_ref(),
        session.scene_25d_structure.as_ref(),
    ) else {
        return Ok(None);
    };
    let mut scene = engine_graph::prepare_scene_25d_frame(graph, timeline_frame)?;
    if let Some(frame) = scene.as_mut() {
        frame.coverage.depth_mode = structure.depth_mode;
        frame.coverage.depth_format = structure.depth_format;
        frame.coverage.depth_tested_plane_count = structure.depth_tested_plane_count;
        frame.coverage.depth_pass_count = structure.depth_pass_count;
        frame.coverage.geometry_executor = structure.geometry_executor;
        frame.coverage.pixel_executor = structure.pixel_executor;
    }
    Ok(scene)
}

#[cfg(windows)]
struct ResidentEngineParticle {
    plan: engine_graph::EngineVideoParticlePlan,
    texture: windows_video::ResidentParticleTexture,
}

#[cfg(windows)]
impl ResidentEngineParticle {
    fn update(&mut self, engine: &GpuCompositor, timeline_frame: u64) -> Option<serde_json::Value> {
        let local_frame = self.plan.local_frame(timeline_frame)?;
        let mut receipt = self.texture.update(
            engine,
            windows_video::ResidentParticleSettings {
                seed: self.plan.seed,
                rate_per_second: self.plan.rate_per_second,
                lifetime_seconds: self.plan.lifetime_seconds,
                max_particles: self.plan.max_particles,
                emitter_position: self.plan.emitter_position,
                initial_velocity: self.plan.initial_velocity,
                gravity: self.plan.gravity,
                radius_pixels: self.plan.radius_pixels,
                color: self.plan.color,
            },
            self.plan.time_seconds(timeline_frame),
            local_frame,
        );
        if let Some(object) = receipt.as_object_mut() {
            object.insert("nodeId".into(), serde_json::json!(self.plan.node_id));
            object.insert("timelineFrame".into(), serde_json::json!(timeline_frame));
            object.insert("localFrame".into(), serde_json::json!(local_frame));
            object.insert("timeline".into(), serde_json::json!(self.plan.timeline));
            object.insert("seed".into(), serde_json::json!(self.plan.seed));
            object.insert(
                "particleCeiling".into(),
                serde_json::json!(self.plan.max_particles),
            );
        }
        Some(receipt)
    }
}

#[cfg(windows)]
struct ResidentEngineCaption {
    plan: engine_graph::EngineVideoCaptionPlan,
    texture: windows_video::ResidentOverlayTexture,
    receipt: serde_json::Value,
}

#[cfg(windows)]
struct ResidentEngineMotionGraphic {
    plan: engine_graph::EngineVideoMotionGraphicPlan,
    texture: windows_video::ResidentOverlayTexture,
    receipt: serde_json::Value,
}

#[cfg(windows)]
impl ResidentEngineMotionGraphic {
    fn active_receipt(&self, timeline_frame: u64) -> Option<serde_json::Value> {
        let sample = self.plan.sample(timeline_frame)?;
        let mut receipt = self.receipt.clone();
        let object = receipt.as_object_mut()?;
        object.insert("sampledOpacity".into(), serde_json::json!(sample.opacity));
        object.insert(
            "sampledTranslateX".into(),
            serde_json::json!(sample.translate_x),
        );
        object.insert(
            "sampledTranslateY".into(),
            serde_json::json!(sample.translate_y),
        );
        object.insert("sampledScale".into(), serde_json::json!(sample.scale));
        object.insert(
            "sampledRotationRadians".into(),
            serde_json::json!(sample.rotation_radians),
        );
        if let Some(status) = sample.tracking_status {
            object.insert("sampledTrackingStatus".into(), serde_json::json!(status));
        }
        if let Some(confidence) = sample.tracking_confidence {
            object.insert(
                "sampledTrackingConfidence".into(),
                serde_json::json!(confidence),
            );
        }
        if let Some(x) = sample.tracking_x {
            object.insert("sampledTrackingX".into(), serde_json::json!(x));
        }
        if let Some(y) = sample.tracking_y {
            object.insert("sampledTrackingY".into(), serde_json::json!(y));
        }
        if let Some(rotation) = sample.tracking_rotation_radians {
            object.insert(
                "sampledTrackingRotationRadians".into(),
                serde_json::json!(rotation),
            );
        }
        if let Some(scale) = sample.tracking_scale {
            object.insert("sampledTrackingScale".into(), serde_json::json!(scale));
        }
        if let Some(destination_quad) = sample.destination_quad {
            object.insert(
                "sampledDestinationQuad".into(),
                serde_json::json!(destination_quad),
            );
        }
        Some(receipt)
    }
}

#[cfg(windows)]
struct ResidentEngineVideoLayer {
    source_node_id: String,
    asset_id: String,
    video: ResidentEngineVideoDecoder,
    project_coordinate_width: u32,
    project_coordinate_height: u32,
    timeline: engine_graph::EngineVideoTimelinePlan,
    visual_plan: engine_graph::EngineVideoVisualPlan,
    alpha_mode: hao_core::engine::model::AlphaMode,
    transform_node_id: Option<String>,
    parent_transform_node_id: Option<String>,
    parent_layer_index: Option<usize>,
    parent_controller_index: Option<usize>,
    parent_depth: u32,
    blend_mode: BlendMode,
    composite_opacity: f32,
    matte_layer_index: Option<usize>,
    matte_mode: Option<hao_core::engine::model::MatteMode>,
    precomposition_node_ids: Vec<String>,
    nested_graph_ids: Vec<String>,
    decode_cadence_divisor: u32,
    decode_cadence_phase: u32,
    cached_stage: Option<ResidentEngineCachedStage>,
}

#[cfg(windows)]
const fn engine_alpha_mode_code(mode: hao_core::engine::model::AlphaMode) -> u32 {
    match mode {
        hao_core::engine::model::AlphaMode::Auto | hao_core::engine::model::AlphaMode::Straight => {
            0
        }
        hao_core::engine::model::AlphaMode::Opaque => 1,
        hao_core::engine::model::AlphaMode::Premultiplied => 2,
    }
}

#[cfg(windows)]
enum ResidentEngineVideoDecoder {
    Direct(windows_video::VideoInteropSession),
    Parallel(Rc<windows_video::VideoInteropWorker>),
}

#[cfg(windows)]
impl ResidentEngineVideoDecoder {
    fn open_direct(engine: &GpuCompositor, input: &Path, ring_size: usize) -> Result<Self> {
        Ok(Self::Direct(
            windows_video::VideoInteropSession::open_with_ring_size(engine, input, ring_size)?,
        ))
    }

    fn description(&self) -> serde_json::Value {
        match self {
            Self::Direct(video) => video.description(),
            Self::Parallel(video) => video.description(),
        }
    }

    fn dimensions(&self) -> (u32, u32) {
        match self {
            Self::Direct(video) => video.dimensions(),
            Self::Parallel(video) => video.dimensions(),
        }
    }

    fn frame_rate(&self) -> (u32, u32) {
        match self {
            Self::Direct(video) => video.frame_rate(),
            Self::Parallel(video) => video.frame_rate(),
        }
    }

    fn is_direct(&self) -> bool {
        matches!(self, Self::Direct(_))
    }

    fn direct_mut(&mut self) -> Result<&mut windows_video::VideoInteropSession> {
        match self {
            Self::Direct(video) => Ok(video),
            Self::Parallel(_) => bail!("multi-layer decoder cannot enter the single-layer path"),
        }
    }

    fn worker(&self) -> Result<&windows_video::VideoInteropWorker> {
        match self {
            Self::Parallel(video) => Ok(video.as_ref()),
            Self::Direct(_) => {
                bail!("single-layer decoder cannot enter the parallel multi-layer path")
            }
        }
    }

    fn staged_surface_layer(
        &self,
        slot_index: usize,
        style: windows_video::VideoVisualStyle,
    ) -> Result<windows_video::VideoSurfaceLayer<'_>> {
        match self {
            Self::Direct(video) => video.staged_surface_layer(slot_index, style),
            Self::Parallel(video) => video.staged_surface_layer(slot_index, style),
        }
    }

    fn staged_temporal_surface_layer(
        &self,
        slot_indices: &[usize],
        style: windows_video::VideoVisualStyle,
    ) -> Result<windows_video::VideoSurfaceLayer<'_>> {
        match self {
            Self::Direct(video) => video.staged_temporal_surface_layer(slot_indices, style),
            Self::Parallel(_) => {
                bail!("decoded temporal source window requires a direct resident decoder")
            }
        }
    }

    fn flush_staged_fences(&mut self, engine: &GpuCompositor) -> Result<serde_json::Value> {
        match self {
            Self::Direct(video) => video.flush_staged_fences(engine),
            Self::Parallel(video) => video.flush_staged_fences(),
        }
    }
}

#[cfg(windows)]
struct ResidentEngineCachedStage {
    timeline_frame: u64,
    slot_index: usize,
    receipt: serde_json::Value,
}

#[cfg(windows)]
impl ResidentEngineVideoLayer {
    fn sampled_visual_at_continuous(
        &self,
        timeline_frame: f64,
    ) -> engine_graph::EngineVideoVisualPlan {
        let local_frame = self
            .timeline
            .local_frame_continuous(timeline_frame)
            .unwrap_or(0.0);
        self.visual_plan.sample_continuous(local_frame)
    }
}

#[cfg(windows)]
fn compose_video_parent_transform(
    parent: &engine_graph::EngineVideoVisualPlan,
    child: &mut engine_graph::EngineVideoVisualPlan,
) {
    let cosine = parent.rotation.cos();
    let sine = parent.rotation.sin();
    let child_x = child.translate_x;
    let child_y = child.translate_y;
    child.translate_x = parent.translate_x + (child_x * cosine - child_y * sine) * parent.scale;
    child.translate_y = parent.translate_y + (child_x * sine + child_y * cosine) * parent.scale;
    child.scale *= parent.scale;
    child.rotation += parent.rotation;
    child.opacity *= parent.opacity;
}

#[cfg(windows)]
fn prepared_engine_video_visual_plan_at(
    layers: &[engine_graph::PreparedEngineVideoLayer],
    controllers: &[engine_graph::EngineVideoControllerPlan],
    layer_index: usize,
    timeline_frame: u64,
    scene: Option<&engine_graph::EngineScene25dPlan>,
) -> Result<engine_graph::EngineVideoVisualPlan> {
    let layer = layers
        .get(layer_index)
        .context("common-video prepared parent layer index is outside the resident table")?;
    let local_frame = layer.timeline.local_frame(timeline_frame).unwrap_or(0);
    let mut visual = layer.visual.sample(local_frame);
    if let Some(parent_index) = layer.parent_layer_index {
        let parent = prepared_engine_video_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    } else if let Some(parent_index) = layer.parent_controller_index {
        let parent = prepared_engine_video_controller_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    }
    if let (Some(scene), Some(transform_id)) = (scene, layer.transform_node_id.as_deref()) {
        let projection = scene
            .projections
            .get(transform_id)
            .with_context(|| format!("sampled 2.5D projection disappeared for {transform_id}"))?;
        visual.apply_scene_projection(projection, scene.width, scene.height)?;
    }
    Ok(visual)
}

#[cfg(windows)]
fn prepared_engine_video_controller_visual_plan_at(
    layers: &[engine_graph::PreparedEngineVideoLayer],
    controllers: &[engine_graph::EngineVideoControllerPlan],
    controller_index: usize,
    timeline_frame: u64,
    scene: Option<&engine_graph::EngineScene25dPlan>,
) -> Result<engine_graph::EngineVideoVisualPlan> {
    let controller = controllers
        .get(controller_index)
        .context("common-video prepared controller index is outside the controller table")?;
    let local_frame = controller.timeline.local_frame(timeline_frame).unwrap_or(0);
    let mut visual = controller.visual.sample(local_frame);
    if let Some(parent_index) = controller.parent_layer_index {
        let parent = prepared_engine_video_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    } else if let Some(parent_index) = controller.parent_controller_index {
        let parent = prepared_engine_video_controller_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    }
    Ok(visual)
}

#[cfg(windows)]
fn resident_engine_video_visual_at(
    layers: &[ResidentEngineVideoLayer],
    controllers: &[engine_graph::EngineVideoControllerPlan],
    layer_index: usize,
    timeline_frame: u64,
    scene: Option<&engine_graph::EngineScene25dPlan>,
) -> Result<windows_video::VideoVisualStyle> {
    let layer = layers
        .get(layer_index)
        .context("common-video parent layer index is outside the resident table")?;
    let mut sampled = resident_engine_video_layer_visual_plan_at(
        layers,
        controllers,
        layer_index,
        timeline_frame as f64,
        scene,
    )?;
    if let Some(motion_blur) = sampled.motion_blur.as_mut() {
        let sample_frames = motion_blur.sample_timeline_frames(&layer.timeline, timeline_frame);
        let mut sample_transforms = Vec::with_capacity(sample_frames.len());
        for sample_frame in &sample_frames {
            let sample = resident_engine_video_layer_visual_plan_at(
                layers,
                controllers,
                layer_index,
                *sample_frame,
                scene,
            )?;
            sample_transforms.push([
                sample.translate_x,
                sample.translate_y,
                sample.scale,
                sample.rotation,
            ]);
        }
        motion_blur.sample_frames = sample_frames.iter().map(|frame| *frame as f32).collect();
        motion_blur.sample_transforms = sample_transforms;
    }
    Ok(video_visual_style(&sampled)
        .with_source_dimensions(
            layer.project_coordinate_width,
            layer.project_coordinate_height,
        )
        .with_composite(
            layer.blend_mode.code(),
            layer.composite_opacity,
            engine_alpha_mode_code(layer.alpha_mode),
        ))
}

#[cfg(windows)]
fn resident_engine_video_layer_visual_plan_at(
    layers: &[ResidentEngineVideoLayer],
    controllers: &[engine_graph::EngineVideoControllerPlan],
    layer_index: usize,
    timeline_frame: f64,
    scene: Option<&engine_graph::EngineScene25dPlan>,
) -> Result<engine_graph::EngineVideoVisualPlan> {
    let layer = layers
        .get(layer_index)
        .context("common-video resident parent layer disappeared")?;
    let mut visual = layer.sampled_visual_at_continuous(timeline_frame);
    if let Some(parent_index) = layer.parent_layer_index {
        let parent = resident_engine_video_layer_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    } else if let Some(parent_index) = layer.parent_controller_index {
        let parent = resident_engine_video_controller_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    }
    if let (Some(scene), Some(transform_id)) = (scene, layer.transform_node_id.as_deref()) {
        let projection = scene.projections.get(transform_id).with_context(|| {
            format!("sampled resident 2.5D projection disappeared for {transform_id}")
        })?;
        visual.apply_scene_projection(projection, scene.width, scene.height)?;
    }
    Ok(visual)
}

#[cfg(windows)]
fn resident_engine_video_controller_visual_plan_at(
    layers: &[ResidentEngineVideoLayer],
    controllers: &[engine_graph::EngineVideoControllerPlan],
    controller_index: usize,
    timeline_frame: f64,
    scene: Option<&engine_graph::EngineScene25dPlan>,
) -> Result<engine_graph::EngineVideoVisualPlan> {
    let controller = controllers
        .get(controller_index)
        .context("common-video resident controller disappeared")?;
    let local_frame = controller
        .timeline
        .local_frame_continuous(timeline_frame)
        .unwrap_or(0.0);
    let mut visual = controller.visual.sample_continuous(local_frame);
    if let Some(parent_index) = controller.parent_layer_index {
        let parent = resident_engine_video_layer_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    } else if let Some(parent_index) = controller.parent_controller_index {
        let parent = resident_engine_video_controller_visual_plan_at(
            layers,
            controllers,
            parent_index,
            timeline_frame,
            scene,
        )?;
        compose_video_parent_transform(&parent, &mut visual);
    }
    Ok(visual)
}

#[cfg(windows)]
fn resident_engine_video_controller_receipts(
    layers: &[ResidentEngineVideoLayer],
    controllers: &[engine_graph::EngineVideoControllerPlan],
    timeline_frame: u64,
) -> Result<Vec<serde_json::Value>> {
    (0..controllers.len())
        .map(|index| {
            let controller = &controllers[index];
            let visual = resident_engine_video_controller_visual_plan_at(
                layers,
                controllers,
                index,
                timeline_frame as f64,
                None,
            )?;
            Ok(serde_json::json!({
                "sourceNodeId": controller.source_node_id,
                "transformNodeId": controller.transform_node_id,
                "timeline": controller.timeline,
                "sampledFrame": controller.timeline.frame(timeline_frame),
                "visualGraph": video_visual_style(&visual),
                "parentTransformNodeId": controller.parent_transform_node_id,
                "parentLayerIndex": controller.parent_layer_index,
                "parentControllerIndex": controller.parent_controller_index,
                "parentDepth": controller.parent_depth
            }))
        })
        .collect()
}

#[cfg(windows)]
fn video_visual_style(
    plan: &engine_graph::EngineVideoVisualPlan,
) -> windows_video::VideoVisualStyle {
    let mut shader_operations = [[0.0_f32; 4]; 16];
    let operations = plan
        .shader_effects
        .iter()
        .flat_map(|effect| effect.operations.iter());
    for (target, operation) in shader_operations.iter_mut().zip(operations) {
        *target = [
            operation.opcode as f32,
            operation.args[0],
            operation.args[1],
            operation.args[2],
        ];
    }
    let mut motion_samples = [[0.0_f32; 4]; 8];
    let mut motion_sample_frames = [[0.0_f32; 4]; 2];
    let (motion_sample_count, motion_shutter_angle) =
        plan.motion_blur.as_ref().map_or((0, 0.0), |motion_blur| {
            for (target, sample) in motion_samples
                .iter_mut()
                .zip(&motion_blur.sample_transforms)
            {
                *target = *sample;
            }
            for (index, frame) in motion_blur.sample_frames.iter().take(8).enumerate() {
                motion_sample_frames[index / 4][index % 4] = *frame;
            }
            (
                motion_blur.sample_transforms.len().min(8) as u32,
                motion_blur.shutter_angle,
            )
        });
    windows_video::VideoVisualStyle {
        translate_x: plan.translate_x,
        translate_y: plan.translate_y,
        scale: plan.scale,
        rotation: plan.rotation,
        opacity: plan.opacity,
        source_width: 1.0,
        source_height: 1.0,
        effect_kind: plan.effect_kind,
        brightness: plan.grade.brightness,
        contrast: plan.grade.contrast,
        saturation: plan.grade.saturation,
        hue: plan.grade.hue,
        exposure: plan.grade.exposure,
        temperature: plan.grade.temperature,
        tint: plan.grade.tint,
        pivot: plan.grade.pivot,
        shadows: plan.grade.shadows,
        highlights: plan.grade.highlights,
        blacks: plan.grade.blacks,
        whites: plan.grade.whites,
        white_balance_red: plan.grade.white_balance_red,
        white_balance_green: plan.grade.white_balance_green,
        white_balance_blue: plan.grade.white_balance_blue,
        white_balance_pad: 0.0,
        transform_pivot_x: 0.0,
        transform_pivot_y: 0.0,
        transform_pad_x: 0.0,
        transform_pad_y: 0.0,
        projective_h0: plan.projective[0],
        projective_h1: plan.projective[1],
        projective_h2: plan.projective[2],
        projective_h3: plan.projective[3],
        projective_h4: plan.projective[4],
        projective_h5: plan.projective[5],
        projective_h6: plan.projective[6],
        projective_h7: plan.projective[7],
        projective_enabled: if plan.projective_enabled { 1.0 } else { 0.0 },
        shade_r: plan.shade[0],
        shade_g: plan.shade[1],
        shade_b: plan.shade[2],
        blend_mode: 0,
        composite_opacity: 1.0,
        source_alpha_mode: 0,
        source_color_contract: plan.input_transfer as f32,
        matte_mode: 0,
        scene_depth_a: plan.scene_depth_plane.map_or(0.0, |plane| plane[0]),
        scene_depth_b: plan.scene_depth_plane.map_or(0.0, |plane| plane[1]),
        scene_depth_c: plan.scene_depth_plane.map_or(1.0, |plane| plane[2]),
        shader_op_count: plan
            .shader_effects
            .iter()
            .map(|effect| effect.operations.len() as u32)
            .sum(),
        scene_depth_enabled: u32::from(plan.scene_depth_plane.is_some()),
        shader_pad_y: 0,
        shader_pad_z: 0,
        shader_ops: shader_operations,
        motion_sample_count,
        motion_contract_code: if motion_sample_count == 0 {
            0
        } else {
            plan.motion_blur
                .as_ref()
                .map_or(0, |motion_blur| match motion_blur.source_sampling {
                    hao_core::engine::model::MotionBlurSourceSampling::CurrentFrame => 1,
                    hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal => 2,
                })
        },
        motion_shutter_angle,
        motion_pad_z: 0.0,
        motion_samples,
        motion_sample_frames,
    }
}

#[cfg(windows)]
fn matte_mode_code(mode: hao_core::engine::model::MatteMode) -> u32 {
    use hao_core::engine::model::MatteMode;
    match mode {
        MatteMode::Alpha => 1,
        MatteMode::AlphaInverted => 2,
        MatteMode::Luma => 3,
        MatteMode::LumaInverted => 4,
    }
}

#[cfg(windows)]
fn engine_video_surface_layers<'a>(
    layers: &'a [ResidentEngineVideoLayer],
    active_indices: &[usize],
    slot_indices: &[usize],
    visual_layers: &[windows_video::VideoVisualStyle],
    temporal_layer: Option<(usize, &[usize])>,
) -> Result<Vec<windows_video::VideoSurfaceLayer<'a>>> {
    if active_indices.len() != slot_indices.len() || active_indices.len() != visual_layers.len() {
        bail!("common-video active layer, slot and style counts differ");
    }
    let mut surfaces = active_indices
        .iter()
        .enumerate()
        .map(|(position, index)| {
            if temporal_layer.is_some_and(|(temporal_index, _)| temporal_index == *index) {
                let (_, temporal_slots) = temporal_layer
                    .context("decoded temporal surface layer lost its resident slots")?;
                layers[*index]
                    .video
                    .staged_temporal_surface_layer(temporal_slots, visual_layers[position])
            } else {
                layers[*index]
                    .video
                    .staged_surface_layer(slot_indices[position], visual_layers[position])
            }
        })
        .collect::<Result<Vec<_>>>()?;
    for (position, index) in active_indices.iter().copied().enumerate() {
        let Some(matte_index) = layers[index].matte_layer_index else {
            continue;
        };
        let matte_position = active_indices
            .iter()
            .position(|candidate| *candidate == matte_index)
            .context("active common-video track matte has no active resident source")?;
        let mode = layers[index]
            .matte_mode
            .context("common-video track matte lost its typed mode")?;
        let matte_surface = surfaces[matte_position];
        surfaces[position].style.matte_mode = matte_mode_code(mode);
        surfaces[position].matte = Some(windows_video::VideoSurfaceMatte {
            source: matte_surface.source,
            style: matte_surface.style,
        });
    }
    Ok(surfaces)
}

#[cfg(windows)]
fn compact_engine_video_frame_receipt(frame: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "frameRingSlot": frame["frameRingSlot"],
        "gpuSubmissionSequence": frame["gpuSubmissionSequence"],
        "timestampSeconds": frame["timestampSeconds"],
        "decodePathCpuPixelCopies": frame["decodePathCpuPixelCopies"],
        "stagingCpuPixelReadbacks": frame["stagingCpuPixelReadbacks"],
        "nativeSurfacePresented": frame["nativeSurfacePresented"],
        "nativeSurfaceCpuPixelReadbacks": frame["nativeSurfaceCpuPixelReadbacks"],
        "clockTargetSeconds": frame["clockTargetSeconds"],
        "clockDriftMilliseconds": frame["clockDriftMilliseconds"],
        "clockWithinTolerance": frame["clockWithinTolerance"],
        "decoderSourceCacheHit": frame["decoderSourceCacheHit"],
        "gpuCopySubmissionMode": frame["gpuCopySubmissionMode"],
        "gpuCopySubmissionLayerCount": frame["gpuCopySubmissionLayerCount"],
        "decodeDispatchMode": frame["decodeDispatchMode"],
        "decodeDispatchWidth": frame["decodeDispatchWidth"],
        "decodePrepareMilliseconds": frame["decodePrepareMilliseconds"],
        "adaptiveFrameReused": frame["adaptiveFrameReused"],
        "adaptiveFrameAgeFrames": frame["adaptiveFrameAgeFrames"],
        "decodeCadenceDivisor": frame["decodeCadenceDivisor"],
        "decodeCadencePhase": frame["decodeCadencePhase"],
        "presentationTargetSeconds": frame["presentationTargetSeconds"],
    })
}

fn server_response(id: &str, ok: bool, result: serde_json::Value) -> serde_json::Value {
    if ok {
        serde_json::json!({ "id": id, "ok": true, "result": result })
    } else {
        serde_json::json!({ "id": id, "ok": false, "error": result })
    }
}

fn serve_command() -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::BufWriter::new(std::io::stdout());
    let mut compositor = GpuCompositor::new()?;
    let mut sessions = BTreeMap::<String, ResidentSession>::new();
    #[cfg(windows)]
    let mut video_compositor: Option<GpuCompositor> = None;
    #[cfg(windows)]
    let mut video_sessions = BTreeMap::<String, windows_video::VideoInteropSession>::new();
    #[cfg(windows)]
    let mut engine_video_sessions = BTreeMap::<String, ResidentEngineVideoSession>::new();
    #[cfg(windows)]
    let mut native_preview_surface: Option<windows_video::NativePreviewSurface> = None;
    let mut generation = 1_u64;
    let mut fail_next_gpu_request = false;
    writeln!(
        stdout,
        "{}",
        serde_json::json!({
            "event": "ready", "engine": "editkin-wgpu-resident-engine/v1", "generation": generation,
            "adapter": compositor.adapter_name, "backend": compositor.backend, "deviceType": compositor.device_type,
            "videoInteropProtocol": if cfg!(windows) { "media-foundation-d3d11-d3d12-wgpu/v1" } else { "unavailable" }
        })
    )?;
    stdout.flush()?;
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: ServerRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                writeln!(
                    stdout,
                    "{}",
                    server_response(
                        "invalid",
                        false,
                        serde_json::json!(format!("invalid request: {error}"))
                    )
                )?;
                stdout.flush()?;
                continue;
            }
        };
        let outcome: Result<serde_json::Value> = (|| {
            if fail_next_gpu_request
                && matches!(
                    request.command.as_str(),
                    "load"
                        | "engine_load"
                        | "engine_video_load"
                        | "engine_video_present_frame"
                        | "engine_video_stage_frame"
                        | "engine_video_verify_frame"
                        | "engine_update_frame"
                        | "update_params"
                        | "render"
                        | "video_open"
                        | "video_decode_next"
                        | "video_decode_at"
                        | "video_stage_at"
                        | "video_stage_batch_at"
                        | "video_present_at"
                        | "surface_bind"
                        | "surface_probe"
                        | "video_seek"
                )
            {
                fail_next_gpu_request = false;
                bail!("GPU_DEVICE_LOST: injected fault before {}", request.command);
            }
            match request.command.as_str() {
                "inject_device_loss" => {
                    fail_next_gpu_request = true;
                    Ok(serde_json::json!({
                        "armed": true, "generation": generation,
                        "nextAffectedRequestWillFail": true
                    }))
                }
                "status" => {
                    #[cfg(windows)]
                    let video_session_count = video_sessions.len();
                    #[cfg(not(windows))]
                    let video_session_count = 0usize;
                    #[cfg(windows)]
                    let engine_video_session_count = engine_video_sessions.len();
                    #[cfg(not(windows))]
                    let engine_video_session_count = 0usize;
                    #[cfg(windows)]
                    let video_backend = video_compositor
                        .as_ref()
                        .map(|engine| engine.backend.as_str());
                    #[cfg(not(windows))]
                    let video_backend: Option<&str> = None;
                    #[cfg(windows)]
                    let native_surface = native_preview_surface
                        .as_ref()
                        .map(windows_video::NativePreviewSurface::description);
                    #[cfg(not(windows))]
                    let native_surface: Option<serde_json::Value> = None;
                    Ok(serde_json::json!({
                        "engine": "editkin-wgpu-resident-engine/v1", "generation": generation,
                        "residentSessions": sessions.len(), "residentVideoSessions": video_session_count,
                        "residentEngineVideoSessions": engine_video_session_count,
                        "adapter": compositor.adapter_name, "backend": compositor.backend,
                        "deviceType": compositor.device_type, "videoBackend": video_backend,
                        "nativePreviewSurface": native_surface
                    }))
                }
                "load" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("load requires sessionId")?;
                    if session_id.trim().is_empty() {
                        bail!("sessionId cannot be empty");
                    }
                    let graph_path = request
                        .graph_path
                        .as_deref()
                        .context("load requires graphPath")?;
                    let graph = load_graph(graph_path)?;
                    let prepared = prepare_graph(
                        graph,
                        graph_path.parent().unwrap_or_else(|| Path::new(".")),
                    )?;
                    let layer_count = prepared.layers.len();
                    let params = prepared.params.clone();
                    let resident = compositor.upload(&prepared)?;
                    sessions.insert(
                        session_id.to_owned(),
                        ResidentSession {
                            graph: resident,
                            params,
                            engine_timeline: None,
                            engine_coverage: None,
                            engine_scene_25d: None,
                            engine_vfx_simulation: None,
                            display_transform:
                                engine_graph::EngineDisplayTransform::SceneLinearPreview,
                        },
                    );
                    Ok(
                        serde_json::json!({ "sessionId": session_id, "resident": true, "layers": layer_count, "generation": generation }),
                    )
                }
                "engine_load" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_load requires sessionId")?;
                    if session_id.trim().is_empty() {
                        bail!("sessionId cannot be empty");
                    }
                    let graph_path = request
                        .graph_path
                        .as_deref()
                        .context("engine_load requires graphPath")?;
                    let bindings_path = request
                        .bindings_path
                        .as_deref()
                        .context("engine_load requires bindingsPath")?;
                    let timeline_frame = request
                        .timeline_frame
                        .context("engine_load requires timelineFrame")?;
                    let graph: hao_core::engine::EngineGraph = serde_json::from_slice(
                        &fs::read(graph_path)
                            .with_context(|| format!("read {}", graph_path.display()))?,
                    )
                    .with_context(|| format!("parse {}", graph_path.display()))?;
                    let bindings: BTreeMap<String, PathBuf> = serde_json::from_slice(
                        &fs::read(bindings_path)
                            .with_context(|| format!("read {}", bindings_path.display()))?,
                    )
                    .with_context(|| format!("parse {}", bindings_path.display()))?;
                    let engine_graph::PreparedEngineGraph {
                        prepared,
                        coverage,
                        timeline,
                        display_transform,
                        scene_25d,
                        vfx_simulation,
                    } = engine_graph::prepare(
                        graph,
                        &bindings,
                        bindings_path.parent().unwrap_or_else(|| Path::new(".")),
                        timeline_frame,
                    )?;
                    let layer_count = prepared.layers.len();
                    let params = prepared.params.clone();
                    let resident = compositor.upload(&prepared)?;
                    let coverage = serde_json::to_value(coverage)?;
                    let scene_25d = scene_25d.map(serde_json::to_value).transpose()?;
                    let vfx_simulation = vfx_simulation.map(serde_json::to_value).transpose()?;
                    sessions.insert(
                        session_id.to_owned(),
                        ResidentSession {
                            graph: resident,
                            params,
                            engine_timeline: Some(timeline),
                            engine_coverage: Some(coverage.clone()),
                            engine_scene_25d: scene_25d.clone(),
                            engine_vfx_simulation: vfx_simulation.clone(),
                            display_transform,
                        },
                    );
                    Ok(serde_json::json!({
                        "sessionId": session_id, "resident": true, "layers": layer_count,
                        "generation": generation, "timelineFrame": timeline_frame,
                        "engineGraph": coverage, "scene25d": scene_25d,
                        "vfxSimulation": vfx_simulation
                    }))
                }
                "update_params" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("update_params requires sessionId")?;
                    let session = sessions
                        .get_mut(session_id)
                        .context("unknown resident session")?;
                    if session.engine_timeline.is_some() {
                        bail!(
                            "common engine graph properties must be updated through typed graph commands"
                        );
                    }
                    let params = request.params.context("update_params requires params")?;
                    compositor.update_params(&session.graph, &params)?;
                    session.params = params;
                    Ok(
                        serde_json::json!({ "sessionId": session_id, "updated": true, "layers": session.params.len() }),
                    )
                }
                "engine_update_frame" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_update_frame requires sessionId")?;
                    let timeline_frame = request
                        .timeline_frame
                        .context("engine_update_frame requires timelineFrame")?;
                    let session = sessions
                        .get_mut(session_id)
                        .context("unknown resident session")?;
                    let timeline = session
                        .engine_timeline
                        .as_ref()
                        .context("resident session was not loaded from a common engine graph")?;
                    timeline.apply(&mut session.params, timeline_frame)?;
                    compositor.update_params(&session.graph, &session.params)?;
                    Ok(serde_json::json!({
                        "sessionId": session_id, "timelineFrame": timeline_frame,
                        "updated": true, "layers": session.params.len()
                    }))
                }
                "render" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("render requires sessionId")?;
                    let session = sessions
                        .get(session_id)
                        .context("unknown resident session")?;
                    let (bytes, milliseconds) = compositor
                        .render_resident_with_display(&session.graph, session.display_transform)?;
                    if let Some(path) = request.output_path.as_deref() {
                        save_rgba(
                            path,
                            bytes.clone(),
                            session.graph.width,
                            session.graph.height,
                        )?;
                    }
                    Ok(serde_json::json!({
                        "sessionId": session_id, "generation": generation, "renderMilliseconds": milliseconds,
                        "width": session.graph.width, "height": session.graph.height, "layers": session.graph.layer_count,
                        "outputHash": output_hash(&bytes), "readbackBytes": bytes.len(),
                        "executionFormat": "rgba32_float", "artifactFormat": "rgba8",
                        "displayTransform": session.display_transform,
                        "colorProcessor": session.display_transform.processor(),
                        "engineGraph": session.engine_coverage,
                        "scene25d": session.engine_scene_25d,
                        "vfxSimulation": session.engine_vfx_simulation
                    }))
                }
                "release" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("release requires sessionId")?;
                    Ok(
                        serde_json::json!({ "sessionId": session_id, "released": sessions.remove(session_id).is_some() }),
                    )
                }
                #[cfg(windows)]
                "engine_video_load" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_video_load requires sessionId")?;
                    if session_id.trim().is_empty() {
                        bail!("sessionId cannot be empty");
                    }
                    if sessions.contains_key(session_id)
                        || video_sessions.contains_key(session_id)
                        || engine_video_sessions.contains_key(session_id)
                    {
                        bail!("resident session already exists: {session_id}");
                    }
                    let graph_path = request
                        .graph_path
                        .as_deref()
                        .context("engine_video_load requires graphPath")?;
                    let bindings_path = request
                        .bindings_path
                        .as_deref()
                        .context("engine_video_load requires bindingsPath")?;
                    let timeline_frame = request
                        .timeline_frame
                        .context("engine_video_load requires timelineFrame")?;
                    let graph: hao_core::engine::EngineGraph = serde_json::from_slice(
                        &fs::read(graph_path)
                            .with_context(|| format!("read {}", graph_path.display()))?,
                    )
                    .with_context(|| format!("parse {}", graph_path.display()))?;
                    let bindings: BTreeMap<String, PathBuf> = serde_json::from_slice(
                        &fs::read(bindings_path)
                            .with_context(|| format!("read {}", bindings_path.display()))?,
                    )
                    .with_context(|| format!("parse {}", bindings_path.display()))?;
                    let effect_bindings: engine_graph::GpuEffectBindings = if let Some(path) =
                        request.effect_bindings_path.as_deref()
                    {
                        serde_json::from_slice(
                            &fs::read(path).with_context(|| format!("read {}", path.display()))?,
                        )
                        .with_context(|| format!("parse {}", path.display()))?
                    } else {
                        engine_graph::GpuEffectBindings::default()
                    };
                    let scene_graph_candidate = graph.clone();
                    let prepared = engine_graph::prepare_video_with_effects(
                        graph,
                        &bindings,
                        bindings_path.parent().unwrap_or_else(|| Path::new(".")),
                        &effect_bindings,
                    )?;
                    debug_assert_eq!(
                        prepared.decode_schedule.full_rate_layer_count
                            + prepared.decode_schedule.adaptive_layer_count,
                        prepared.layers.len(),
                        "prepared decode schedule must cover every resident video layer"
                    );
                    if video_compositor.is_none() {
                        video_compositor = Some(GpuCompositor::new_dx12_video()?);
                    }
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let coverage = serde_json::to_value(prepared.coverage)?;
                    let resource_plan = serde_json::to_value(&prepared.resource_plan)?;
                    let vfx_simulation = prepared
                        .vfx_simulation
                        .as_ref()
                        .map(serde_json::to_value)
                        .transpose()?;
                    let scene_25d_structure = prepared.scene_25d.clone();
                    let scene_frame = if let Some(structure) = scene_25d_structure.as_ref() {
                        let mut scene = engine_graph::prepare_scene_25d_frame(
                            &scene_graph_candidate,
                            timeline_frame,
                        )?;
                        if let Some(frame) = scene.as_mut() {
                            frame.coverage.depth_mode = structure.depth_mode;
                            frame.coverage.depth_format = structure.depth_format;
                            frame.coverage.depth_tested_plane_count =
                                structure.depth_tested_plane_count;
                            frame.coverage.depth_pass_count = structure.depth_pass_count;
                            frame.coverage.geometry_executor = structure.geometry_executor;
                            frame.coverage.pixel_executor = structure.pixel_executor;
                        }
                        scene
                    } else {
                        None
                    };
                    let scene_25d = scene_frame
                        .as_ref()
                        .map(|scene| serde_json::to_value(&scene.coverage))
                        .transpose()?;
                    let scene_graph = scene_frame.as_ref().map(|_| scene_graph_candidate);
                    let depth_of_field = prepared.depth_of_field.clone();
                    let depth_of_field_receipt = depth_of_field
                        .as_ref()
                        .map(|plan| serde_json::to_value(plan.sample(timeline_frame)))
                        .transpose()?;
                    let gpu_effect_programs = prepared
                        .layers
                        .iter()
                        .flat_map(|layer| layer.visual.shader_effects.iter())
                        .chain(
                            prepared
                                .adjustments
                                .iter()
                                .flat_map(|adjustment| adjustment.visual.shader_effects.iter()),
                        )
                        .map(|effect| {
                            serde_json::json!({
                                "nodeId": effect.node_id,
                                "pluginIdentity": effect.plugin_identity,
                                "programSha256": effect.program_sha256,
                                "shaderOpCount": effect.operations.len()
                            })
                        })
                        .collect::<Vec<_>>();
                    let prepared_layer_count = prepared.layers.len();
                    let parallel_decode = prepared_layer_count > 1;
                    let is_decoded_temporal_layer =
                        |layer: &engine_graph::PreparedEngineVideoLayer| {
                            layer.visual.motion_blur.as_ref().is_some_and(|motion_blur| {
                                matches!(
                                    motion_blur.source_sampling,
                                    hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal
                                )
                            })
                        };
                    let decoder_group_key = |layer: &engine_graph::PreparedEngineVideoLayer| {
                        // The worker owns a physical media source, while each logical layer sends
                        // its exact target clock with every prepare request. Nearby clocks profit
                        // from one source cache; distant clocks force repeated seeks and need an
                        // independent reader. Twelve project frames is the calibrated 30 fps
                        // sharing window. Cadence divisor stays separate so full-rate and adaptive
                        // rings retain independent scheduling contracts.
                        let clock_bucket =
                            layer.timeline.decoder_clock_offset_frames().div_euclid(12);
                        (
                            layer.input_path.clone(),
                            format!(
                                "cadence:{}:clock-bucket:{clock_bucket}",
                                layer.decode_cadence_divisor
                            ),
                        )
                    };
                    let decoder_group_counts = prepared
                        .layers
                        .iter()
                        .filter(|layer| !is_decoded_temporal_layer(layer))
                        .fold(
                            BTreeMap::<(PathBuf, String), usize>::new(),
                            |mut counts, layer| {
                                *counts.entry(decoder_group_key(layer)).or_default() += 1;
                                counts
                            },
                        );
                    let mut shared_decoders =
                        BTreeMap::<(PathBuf, String), Rc<windows_video::VideoInteropWorker>>::new();
                    let mut layers = Vec::with_capacity(prepared.layers.len());
                    let mut layer_receipts = Vec::with_capacity(prepared.layers.len());
                    let initial_visual_plans = (0..prepared.layers.len())
                        .map(|index| {
                            prepared_engine_video_visual_plan_at(
                                &prepared.layers,
                                &prepared.controllers,
                                index,
                                timeline_frame,
                                scene_frame.as_ref(),
                            )
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let controller_receipts = (0..prepared.controllers.len())
                        .map(|index| {
                            let controller = &prepared.controllers[index];
                            let visual = prepared_engine_video_controller_visual_plan_at(
                                &prepared.layers,
                                &prepared.controllers,
                                index,
                                timeline_frame,
                                scene_frame.as_ref(),
                            )?;
                            Ok(serde_json::json!({
                                "sourceNodeId": controller.source_node_id,
                                "transformNodeId": controller.transform_node_id,
                                "timeline": controller.timeline,
                                "visualGraph": video_visual_style(&visual),
                                "parentTransformNodeId": controller.parent_transform_node_id,
                                "parentLayerIndex": controller.parent_layer_index,
                                "parentControllerIndex": controller.parent_controller_index,
                                "parentDepth": controller.parent_depth
                            }))
                        })
                        .collect::<Result<Vec<_>>>()?;
                    for (layer_index, layer) in prepared.layers.into_iter().enumerate() {
                        let group_key = decoder_group_key(&layer);
                        let decoder_group_size =
                            decoder_group_counts.get(&group_key).copied().unwrap_or(1);
                        let decoded_temporal = is_decoded_temporal_layer(&layer);
                        let video = if decoded_temporal {
                            let ring_size = layer
                                .visual
                                .motion_blur
                                .as_ref()
                                .context("decoded temporal layer lost its motion plan")?
                                .sample_count
                                .max(3) as usize;
                            ResidentEngineVideoDecoder::open_direct(
                                engine,
                                &layer.input_path,
                                ring_size,
                            )?
                        } else if parallel_decode {
                            let worker = if let Some(worker) = shared_decoders.get(&group_key) {
                                worker.clone()
                            } else {
                                let worker = Rc::new(windows_video::VideoInteropWorker::open(
                                    engine,
                                    &layer.input_path,
                                    decoder_group_size.saturating_mul(3),
                                )?);
                                shared_decoders.insert(group_key, worker.clone());
                                worker
                            };
                            ResidentEngineVideoDecoder::Parallel(worker)
                        } else {
                            let ring_size = 3;
                            ResidentEngineVideoDecoder::open_direct(
                                engine,
                                &layer.input_path,
                                ring_size,
                            )?
                        };
                        let (decoded_width, decoded_height) = video.dimensions();
                        let (decoded_rate_numerator, decoded_rate_denominator) = video.frame_rate();
                        let aspect_denominator =
                            f64::from(prepared.width) * f64::from(decoded_height);
                        let aspect_error = ((f64::from(decoded_width)
                            * f64::from(prepared.height))
                            - aspect_denominator)
                            .abs()
                            / aspect_denominator.max(1.0);
                        if decoded_width < 2
                            || decoded_height < 2
                            || decoded_width > 16_384
                            || decoded_height > 16_384
                            || aspect_error > 0.002
                        {
                            bail!(
                                "common video decoded source must preserve the graph aspect ratio within 0.2%: graph={}x{}, source={}x{} ({})",
                                prepared.width,
                                prepared.height,
                                decoded_width,
                                decoded_height,
                                layer.source_node_id
                            );
                        }
                        let project_rate = layer.timeline.project_frame_rate();
                        let decoded_rate = f64::from(decoded_rate_numerator)
                            / f64::from(decoded_rate_denominator.max(1));
                        let maximum_scale = layer.visual.keyframes.iter().fold(
                            layer.visual.scale.abs(),
                            |maximum, keyframe| {
                                maximum
                                    .max(keyframe.scale_x.abs())
                                    .max(keyframe.scale_y.abs())
                            },
                        );
                        let performance_proxy_cadence = parallel_decode
                            && prepared_layer_count >= 6
                            && layer_index > 0
                            && maximum_scale <= 0.25
                            && decoded_rate_numerator > 0
                            && decoded_rate_denominator > 0
                            && (decoded_rate * 2.0 - project_rate).abs() <= 0.05;
                        let decode_cadence_divisor = if performance_proxy_cadence {
                            2
                        } else {
                            layer.decode_cadence_divisor
                        };
                        let decode_cadence_phase = if decode_cadence_divisor > 1 {
                            layer_index as u32 % decode_cadence_divisor
                        } else {
                            0
                        };
                        let decoder = video.description();
                        let visual = video_visual_style(&initial_visual_plans[layer_index])
                            .with_source_dimensions(prepared.width, prepared.height)
                            .with_composite(
                                layer.blend_mode.code(),
                                layer.composite_opacity,
                                engine_alpha_mode_code(layer.alpha_mode),
                            );
                        let initial_frame = layer.timeline.frame(timeline_frame);
                        layer_receipts.push(serde_json::json!({
                            "layerIndex": layer_index,
                            "sourceNodeId": layer.source_node_id.clone(),
                            "assetId": layer.asset_id.clone(),
                            "decoder": decoder,
                            "projectCoordinateWidth": prepared.width,
                            "projectCoordinateHeight": prepared.height,
                            "proxyScale": f64::from(decoded_width) / f64::from(prepared.width),
                            "visualGraph": visual,
                            "motionBlur": layer.visual.motion_blur,
                            "transformNodeId": layer.transform_node_id.clone(),
                            "parentTransformNodeId": layer.parent_transform_node_id.clone(),
                            "parentLayerIndex": layer.parent_layer_index,
                            "parentControllerIndex": layer.parent_controller_index,
                            "parentDepth": layer.parent_depth,
                            "blendMode": layer.blend_mode,
                            "compositeOpacity": layer.composite_opacity,
                            "sourceAlphaMode": layer.alpha_mode,
                            "matteLayerIndex": layer.matte_layer_index,
                            "matteMode": layer.matte_mode,
                            "precompositionNodeIds": layer.precomposition_node_ids,
                            "nestedGraphIds": layer.nested_graph_ids,
                            "decodeCadenceDivisor": decode_cadence_divisor,
                            "decodeCadencePhase": decode_cadence_phase,
                            "performanceProxyCadence": performance_proxy_cadence,
                            "sharedDecoderLayerCount": decoder_group_size,
                            "initialFrame": initial_frame
                        }));
                        layers.push(ResidentEngineVideoLayer {
                            source_node_id: layer.source_node_id,
                            asset_id: layer.asset_id,
                            video,
                            project_coordinate_width: prepared.width,
                            project_coordinate_height: prepared.height,
                            timeline: layer.timeline,
                            visual_plan: layer.visual,
                            alpha_mode: layer.alpha_mode,
                            transform_node_id: layer.transform_node_id,
                            parent_transform_node_id: layer.parent_transform_node_id,
                            parent_layer_index: layer.parent_layer_index,
                            parent_controller_index: layer.parent_controller_index,
                            parent_depth: layer.parent_depth,
                            blend_mode: layer.blend_mode,
                            composite_opacity: layer.composite_opacity,
                            matte_layer_index: layer.matte_layer_index,
                            matte_mode: layer.matte_mode,
                            precomposition_node_ids: layer.precomposition_node_ids,
                            nested_graph_ids: layer.nested_graph_ids,
                            decode_cadence_divisor,
                            decode_cadence_phase,
                            cached_stage: None,
                        });
                    }
                    let adaptive_layer_count = layers
                        .iter()
                        .filter(|layer| layer.decode_cadence_divisor > 1)
                        .count();
                    let decode_schedule = serde_json::json!({
                        "schema": "editkin.resident-video-decode-schedule/v1",
                        "fullRateLayerCount": layers.len() - adaptive_layer_count,
                        "adaptiveLayerCount": adaptive_layer_count,
                        "maximumDecodeCadenceDivisor": layers.iter().map(|layer| layer.decode_cadence_divisor).max().unwrap_or(1),
                        "maximumReuseAgeFrames": layers.iter().map(|layer| layer.decode_cadence_divisor.saturating_sub(1)).max().unwrap_or(0),
                    });
                    let font_root = if prepared.captions.is_empty()
                        && prepared.motion_graphics.is_empty()
                    {
                        None
                    } else {
                        Some(
                            std::env::var_os("EDITKIN_FONT_ROOT")
                                .map(PathBuf::from)
                                .context("common video text overlays require EDITKIN_FONT_ROOT")?,
                        )
                    };
                    let adjustment_before_typography = prepared.adjustment_before_typography;
                    let adjustments = prepared.adjustments;
                    let adjustment_receipts = adjustments
                        .iter()
                        .map(|plan| {
                            serde_json::json!({
                                "nodeIds": plan.node_ids,
                                "timeline": plan.timeline,
                                "visualGraph": video_visual_style(&plan.visual)
                                    .with_source_dimensions(prepared.width, prepared.height)
                            })
                        })
                        .collect::<Vec<_>>();
                    let mut particles = Vec::with_capacity(prepared.particles.len());
                    for plan in prepared.particles {
                        let texture = windows_video::ResidentParticleTexture::new(
                            engine,
                            prepared.width,
                            prepared.height,
                        )?;
                        particles.push(ResidentEngineParticle { plan, texture });
                    }
                    let mut captions = Vec::with_capacity(prepared.captions.len());
                    let mut caption_receipts = Vec::with_capacity(prepared.captions.len());
                    for plan in prepared.captions {
                        let raster = caption::rasterize_caption(
                            &plan,
                            font_root
                                .as_deref()
                                .context("caption font root disappeared")?,
                            prepared.width,
                            prepared.height,
                        )?;
                        let texture = windows_video::ResidentOverlayTexture::upload(
                            engine,
                            raster.width,
                            raster.height,
                            &raster.pixels,
                        )?;
                        let receipt = serde_json::json!({
                            "nodeId": plan.node_id,
                            "cueId": plan.cue_id,
                            "timeline": plan.timeline,
                            "fontFamily": raster.font_family,
                            "fontSha256": raster.font_sha256,
                            "fontFaceId": raster.font_face_id,
                            "fontFaceFamily": raster.font_face_family,
                            "fontFile": raster.font_file,
                            "requestedFontWeight": raster.requested_font_weight,
                            "resolvedFontWeight": raster.resolved_font_weight,
                            "fontWeightSubstituted": raster.font_weight_substituted,
                            "fontWeightSubstitutionReason": raster.font_weight_substituted.then_some("nearest-available-physical-face"),
                            "atlasSha256": raster.atlas_sha256,
                            "glyphCount": raster.glyph_count,
                            "missingGlyphCount": raster.missing_glyph_count,
                            "textureUploadCount": 1,
                            "textColor": plan.text_color,
                            "singleTextColor": true
                        });
                        caption_receipts.push(receipt.clone());
                        captions.push(ResidentEngineCaption {
                            plan,
                            texture,
                            receipt,
                        });
                    }
                    let mut motion_graphics = Vec::with_capacity(prepared.motion_graphics.len());
                    let mut motion_graphic_receipts =
                        Vec::with_capacity(prepared.motion_graphics.len());
                    for plan in prepared.motion_graphics {
                        let raster = caption::rasterize_motion_graphic(
                            &plan,
                            font_root
                                .as_deref()
                                .context("motion graphic font root disappeared")?,
                            prepared.width,
                            prepared.height,
                        )?;
                        let texture = windows_video::ResidentOverlayTexture::upload(
                            engine,
                            raster.width,
                            raster.height,
                            &raster.pixels,
                        )?;
                        let receipt = serde_json::json!({
                            "nodeId": plan.node_id,
                            "graphicId": plan.graphic_id,
                            "graphicKind": plan.graphic_kind,
                            "timeline": plan.timeline,
                            "x": plan.x,
                            "y": plan.y,
                            "width": plan.width,
                            "fontSize": plan.font_size,
                            "fontFamily": raster.font_family,
                            "fontWeight": plan.font_weight,
                            "fontFaceId": raster.font_face_id,
                            "fontFaceFamily": raster.font_face_family,
                            "fontFile": raster.font_file,
                            "requestedFontWeight": raster.requested_font_weight,
                            "resolvedFontWeight": raster.resolved_font_weight,
                            "fontWeightSubstituted": raster.font_weight_substituted,
                            "fontWeightSubstitutionReason": raster.font_weight_substituted.then_some("nearest-available-physical-face"),
                            "letterSpacing": plan.letter_spacing,
                            "outlineWidth": plan.outline_width,
                            "shadowDepth": plan.shadow_depth,
                            "cornerRadius": plan.corner_radius,
                            "fontSha256": raster.font_sha256,
                            "atlasSha256": raster.atlas_sha256,
                            "glyphCount": raster.glyph_count,
                            "missingGlyphCount": raster.missing_glyph_count,
                            "textureUploadCount": 1,
                            "textColor": plan.text_color,
                            "backgroundColor": plan.background_color,
                            "accentColor": plan.accent_color,
                            "visualStyle": plan.visual_style,
                            "animation": plan.animation,
                            "trackingMode": plan.tracking_mode,
                            "fadeInFrames": plan.fade_in_frames,
                            "fadeOutFrames": plan.fade_out_frames,
                            "trackId": plan.track_id,
                            "trackingSampleCount": plan.tracking_samples.len()
                        });
                        motion_graphic_receipts.push(receipt.clone());
                        motion_graphics.push(ResidentEngineMotionGraphic {
                            plan,
                            texture,
                            receipt,
                        });
                    }
                    let first = layer_receipts
                        .first()
                        .context("common video graph produced no resident layers")?;
                    let decoder = first["decoder"].clone();
                    let visual = first["visualGraph"].clone();
                    let initial_frame = first["initialFrame"].clone();
                    let layer_count = layers.len();
                    let matte_count = layers
                        .iter()
                        .filter(|layer| layer.matte_layer_index.is_some())
                        .count();
                    let precomposition_count = layers
                        .iter()
                        .map(|layer| layer.precomposition_node_ids.len())
                        .sum::<usize>();
                    let parent_count = layers
                        .iter()
                        .filter(|layer| {
                            layer.parent_layer_index.is_some()
                                || layer.parent_controller_index.is_some()
                        })
                        .count()
                        + prepared
                            .controllers
                            .iter()
                            .filter(|controller| {
                                controller.parent_layer_index.is_some()
                                    || controller.parent_controller_index.is_some()
                            })
                            .count();
                    let controller_count = prepared.controllers.len();
                    let typed_blend_composite = layers.iter().skip(1).any(|layer| {
                        !matches!(layer.blend_mode, BlendMode::Normal)
                            || (layer.composite_opacity - 1.0).abs() > 0.000001
                    });
                    let caption_count = captions.len();
                    let motion_graphic_count = motion_graphics.len();
                    let adjustment_count = adjustments.len();
                    let particle_count = particles.len();
                    let active_motion_graphics = motion_graphics
                        .iter()
                        .filter_map(|graphic| graphic.active_receipt(timeline_frame))
                        .collect::<Vec<_>>();
                    engine_video_sessions.insert(
                        session_id.to_owned(),
                        ResidentEngineVideoSession {
                            layers,
                            controllers: prepared.controllers,
                            adjustments,
                            adjustment_before_typography,
                            particles,
                            captions,
                            motion_graphics,
                            width: prepared.width,
                            height: prepared.height,
                            coverage: coverage.clone(),
                            resource_plan: resource_plan.clone(),
                            decode_schedule: decode_schedule.clone(),
                            display_transform: prepared.display_transform,
                            scene_graph,
                            scene_25d_structure,
                            depth_of_field,
                            vfx_simulation: vfx_simulation.clone(),
                        },
                    );
                    Ok(serde_json::json!({
                        "sessionId": session_id,
                        "generation": generation,
                        "resident": true,
                        "executor": "media-foundation-d3d11-d3d12-wgpu/v1",
                        "decoder": decoder,
                        "engineGraph": coverage,
                        "resourcePlan": resource_plan,
                        "decodeSchedule": decode_schedule,
                        "displayTransform": prepared.display_transform,
                        "scene25d": scene_25d,
                        "depthOfField": depth_of_field_receipt,
                        "vfxSimulation": vfx_simulation,
                        "gpuEffects": {
                            "runtime": "editkin.gpu-effect-graph/v1",
                            "resolved": true,
                            "count": gpu_effect_programs.len(),
                            "programs": gpu_effect_programs
                        },
                        "visualGraph": visual,
                        "initialFrame": initial_frame,
                        "layerCount": layer_count,
                        "matteCount": matte_count,
                        "precompositionCount": precomposition_count,
                        "parentCount": parent_count,
                        "controllerCount": controller_count,
                        "controllers": controller_receipts,
                        "adjustmentCount": adjustment_count,
                        "adjustmentPlacement": if adjustment_before_typography { "before-typography/v1" } else { "trailing/v1" },
                        "adjustments": adjustment_receipts,
                        "particleCount": particle_count,
                        "particleTexturesResident": particle_count,
                        "captionCount": caption_count,
                        "captionTextureUploads": caption_count,
                        "captions": caption_receipts,
                        "activeCaptions": caption_receipts.iter().filter(|caption| {
                            let start = caption["timeline"]["timelineStartFrame"].as_u64().unwrap_or(u64::MAX);
                            let duration = caption["timeline"]["durationFrames"].as_u64().unwrap_or(0);
                            timeline_frame >= start && timeline_frame < start.saturating_add(duration)
                        }).cloned().collect::<Vec<_>>(),
                        "motionGraphicCount": motion_graphic_count,
                        "motionGraphicTextureUploads": motion_graphic_count,
                        "motionGraphics": motion_graphic_receipts,
                        "activeMotionGraphics": active_motion_graphics,
                        "compositeMode": if adjustment_count > 0 && adjustment_before_typography { "video-pre-typography-adjustment/v1" } else if adjustment_count > 0 { "video-trailing-adjustment/v1" } else if matte_count > 0 { "typed-track-matte/v1" } else if precomposition_count > 0 { "resolved-precomposition/v1" } else if controller_count > 0 { "typed-controller-parent/v1" } else if parent_count > 0 { "typed-parent-transform/v1" } else if motion_graphic_count > 0 { "video-motion-graphic-source-over/v1" } else if caption_count > 0 { "video-caption-source-over/v1" } else if particle_count > 0 { "video-particle-source-over/v1" } else if typed_blend_composite { "typed-blend-source-over/v1" } else if layer_count > 1 { "normal-source-over/v1" } else { "single/v1" },
                        "layers": layer_receipts,
                        "visualLayers": layer_receipts.iter().map(|layer| layer["visualGraph"].clone()).collect::<Vec<_>>()
                    }))
                }
                #[cfg(not(windows))]
                "engine_video_load" => {
                    bail!("common native-video graphs are currently available on Windows only")
                }
                #[cfg(windows)]
                "engine_video_stage_frame" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_video_stage_frame requires sessionId")?;
                    let timeline_frame = request
                        .timeline_frame
                        .context("engine_video_stage_frame requires timelineFrame")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("engine_video_stage_frame requires toleranceSeconds")?;
                    let session = engine_video_sessions
                        .get_mut(session_id)
                        .context("unknown resident common-video session")?;
                    let scene_frame = resident_engine_scene_at(session, timeline_frame)?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let frame_plans = session
                        .layers
                        .iter()
                        .map(|layer| layer.timeline.frame(timeline_frame))
                        .collect::<Vec<_>>();
                    let mut staged = (0..session.layers.len()).map(|_| None).collect::<Vec<_>>();
                    if session.layers.len() > 1 {
                        let active_indices = frame_plans
                            .iter()
                            .enumerate()
                            .filter_map(|(index, plan)| plan.source_time_seconds.map(|_| index))
                            .collect::<Vec<_>>();
                        let source_times = active_indices
                            .iter()
                            .map(|index| frame_plans[*index].source_time_seconds.unwrap())
                            .collect::<Vec<_>>();
                        let source_tolerances = vec![tolerance_seconds; active_indices.len()];
                        let workers = active_indices
                            .iter()
                            .map(|index| session.layers[*index].video.worker())
                            .collect::<Result<Vec<_>>>()?;
                        let active_staged = windows_video::stage_video_workers_at(
                            engine,
                            &workers,
                            &source_times,
                            &source_tolerances,
                        )?;
                        for (index, frame) in active_indices.into_iter().zip(active_staged) {
                            staged[index] = frame;
                        }
                    } else if let Some(source_time_seconds) = frame_plans[0].source_time_seconds {
                        staged[0] = session.layers[0].video.direct_mut()?.stage_at(
                            engine,
                            source_time_seconds,
                            tolerance_seconds,
                        )?;
                    }
                    let mut layer_receipts = Vec::with_capacity(session.layers.len());
                    for (index, layer) in session.layers.iter().enumerate() {
                        let frame_plan = &frame_plans[index];
                        let visual = resident_engine_video_visual_at(
                            &session.layers,
                            &session.controllers,
                            index,
                            timeline_frame,
                            scene_frame.as_ref(),
                        )?;
                        let frame = staged[index].take();
                        layer_receipts.push(serde_json::json!({
                            "layerIndex": index,
                            "sourceNodeId": layer.source_node_id,
                            "assetId": layer.asset_id,
                            "active": frame_plan.active,
                            "sourceFrame": frame_plan.source_frame,
                            "sourceTimeSeconds": frame_plan.source_time_seconds,
                            "endOfStream": frame_plan.active && frame.is_none(),
                            "frame": frame,
                            "visualGraph": visual,
                            "transformNodeId": layer.transform_node_id,
                            "parentTransformNodeId": layer.parent_transform_node_id,
                            "parentLayerIndex": layer.parent_layer_index,
                            "parentControllerIndex": layer.parent_controller_index,
                            "parentDepth": layer.parent_depth,
                            "matteLayerIndex": layer.matte_layer_index,
                            "matteMode": layer.matte_mode
                            ,"precompositionNodeIds": layer.precomposition_node_ids
                            ,"nestedGraphIds": layer.nested_graph_ids
                        }));
                    }
                    let active = layer_receipts.iter().any(|layer| layer["active"] == true);
                    let controller_receipts = resident_engine_video_controller_receipts(
                        &session.layers,
                        &session.controllers,
                        timeline_frame,
                    )?;
                    let end_of_stream = layer_receipts
                        .iter()
                        .any(|layer| layer["endOfStream"] == true);
                    let first = &layer_receipts[0];
                    Ok(serde_json::json!({
                        "sessionId": session_id,
                        "generation": generation,
                        "active": active,
                        "timelineFrame": timeline_frame,
                        "sourceFrame": first["sourceFrame"],
                        "sourceTimeSeconds": first["sourceTimeSeconds"],
                        "nativeSurfaceCleared": false,
                        "endOfStream": end_of_stream,
                        "frame": first["frame"],
                        "layers": layer_receipts,
                        "controllers": controller_receipts,
                        "engineGraph": session.coverage,
                        "resourcePlan": session.resource_plan,
                        "decodeSchedule": session.decode_schedule,
                        "scene25d": scene_frame.as_ref().map(|scene| &scene.coverage)
                    }))
                }
                #[cfg(not(windows))]
                "engine_video_stage_frame" => {
                    bail!("common native-video graphs are currently available on Windows only")
                }
                #[cfg(windows)]
                "engine_video_present_frame" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_video_present_frame requires sessionId")?;
                    let timeline_frame = request
                        .timeline_frame
                        .context("engine_video_present_frame requires timelineFrame")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("engine_video_present_frame requires toleranceSeconds")?;
                    let session = engine_video_sessions
                        .get_mut(session_id)
                        .context("unknown resident common-video session")?;
                    let scene_frame = resident_engine_scene_at(session, timeline_frame)?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let surface = native_preview_surface
                        .as_mut()
                        .context("native preview surface is not bound")?;
                    surface.select_rec709_output_contract(engine, resident_video_requires_rec709_v2(session))?;
                    let frame_plans = session
                        .layers
                        .iter()
                        .map(|layer| layer.timeline.frame(timeline_frame))
                        .collect::<Vec<_>>();
                    let active_indices = frame_plans
                        .iter()
                        .enumerate()
                        .filter_map(|(index, plan)| plan.active.then_some(index))
                        .collect::<Vec<_>>();
                    let active_caption_indices = session
                        .captions
                        .iter()
                        .enumerate()
                        .filter_map(|(index, caption)| {
                            caption.plan.active(timeline_frame).then_some(index)
                        })
                        .collect::<Vec<_>>();
                    let active_motion_graphic_indices = session
                        .motion_graphics
                        .iter()
                        .enumerate()
                        .filter_map(|(index, graphic)| {
                            graphic.plan.sampled_opacity(timeline_frame).map(|_| index)
                        })
                        .collect::<Vec<_>>();
                    let active_adjustment_indices = session
                        .adjustments
                        .iter()
                        .enumerate()
                        .filter_map(|(index, adjustment)| {
                            adjustment.active(timeline_frame).then_some(index)
                        })
                        .collect::<Vec<_>>();
                    let active_particle_indices = session
                        .particles
                        .iter()
                        .enumerate()
                        .filter_map(|(index, particle)| {
                            particle.plan.active(timeline_frame).then_some(index)
                        })
                        .collect::<Vec<_>>();
                    if active_indices.is_empty() {
                        let surface_description = if session.display_transform.is_aces2() {
                            surface.clear_scene_linear_aces2_black(
                                engine,
                                session.display_transform,
                            )?
                        } else {
                            surface.clear_black(engine)?
                        };
                        let controller_receipts = resident_engine_video_controller_receipts(
                            &session.layers,
                            &session.controllers,
                            timeline_frame,
                        )?;
                        return Ok(serde_json::json!({
                            "sessionId": session_id,
                            "generation": generation,
                            "active": false,
                            "timelineFrame": timeline_frame,
                            "sourceFrame": null,
                            "sourceTimeSeconds": null,
                            "nativeSurfaceCleared": true,
                            "surface": if session.display_transform.is_aces2() { surface_description["surface"].clone() } else { surface_description.clone() },
                            "sceneLinearExecution": surface_description.get("sceneLinearExecution").cloned(),
                            "workingColorSpace": surface_description.get("workingColorSpace").cloned(),
                            "workingFormat": surface_description.get("workingFormat").cloned(),
                            "displayTransform": surface_description.get("displayTransform").cloned(),
                            "outputSpace": surface_description.get("outputSpace").cloned(),
                            "lutSha256": surface_description.get("lutSha256").cloned(),
                            "lutPayloadSha256": surface_description.get("lutPayloadSha256").cloned(),
                            "inputTransform": surface_description.get("inputTransform").cloned(),
                            "ocioVersion": surface_description.get("ocioVersion").cloned(),
                            "acesVersion": surface_description.get("acesVersion").cloned(),
                            "configSha256": surface_description.get("configSha256").cloned(),
                            "compositeExecutionMode": surface_description.get("compositeExecutionMode").cloned(),
                            "compositeLayerCount": surface_description.get("compositeLayerCount").cloned(),
                            "compositeFullFramePassCount": surface_description.get("compositeFullFramePassCount").cloned(),
                            "compositeMaximumLayersPerPass": surface_description.get("compositeMaximumLayersPerPass").cloned(),
                            "depthExecutionMode": surface_description.get("depthExecutionMode").cloned(),
                            "depthFormat": surface_description.get("depthFormat").cloned(),
                            "depthTestedLayerCount": surface_description.get("depthTestedLayerCount").cloned(),
                            "depthPassCount": surface_description.get("depthPassCount").cloned(),
                            "matteExecutionMode": surface_description.get("matteExecutionMode").cloned(),
                            "mattePassCount": surface_description.get("mattePassCount").cloned(),
                            "adjustmentExecutionMode": surface_description.get("adjustmentExecutionMode").cloned(),
                            "adjustmentBaseLayerCount": surface_description.get("adjustmentBaseLayerCount").cloned(),
                            "layers": frame_plans,
                            "controllers": controller_receipts,
                            "activeCaptions": [],
                            "captionTextureUploads": session.captions.len(),
                            "activeMotionGraphics": [],
                            "motionGraphicTextureUploads": session.motion_graphics.len(),
                            "activeParticles": null,
                            "activeParticleEmitters": [],
                            "activeAdjustments": [],
                            "adjustmentPassCount": 0,
                            "engineGraph": session.coverage,
                            "resourcePlan": session.resource_plan,
                            "decodeSchedule": session.decode_schedule,
                            "vfxSimulation": session.vfx_simulation
                        }));
                    }
                    if !session.display_transform.is_aces2()
                        && active_indices.len() == 1
                        && session.layers[active_indices[0]].video.is_direct()
                        && session.layers[active_indices[0]]
                            .matte_layer_index
                            .is_none()
                        && active_caption_indices.is_empty()
                        && active_motion_graphic_indices.is_empty()
                        && active_particle_indices.is_empty()
                        && active_adjustment_indices.is_empty()
                    {
                        let index = active_indices[0];
                        let frame_plan = &frame_plans[index];
                        let source_time_seconds = frame_plan
                            .source_time_seconds
                            .context("active common-video frame has no source time")?;
                        let visual = resident_engine_video_visual_at(
                            &session.layers,
                            &session.controllers,
                            index,
                            timeline_frame,
                            scene_frame.as_ref(),
                        )?;
                        let controller_receipts = resident_engine_video_controller_receipts(
                            &session.layers,
                            &session.controllers,
                            timeline_frame,
                        )?;
                        let temporal_source_times = session.layers[index]
                            .visual_plan
                            .motion_blur
                            .as_ref()
                            .filter(|motion_blur| {
                                matches!(
                                    motion_blur.source_sampling,
                                    hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal
                                )
                            })
                            .map(|motion_blur| {
                                motion_blur.sample_source_times_seconds(
                                    &session.layers[index].timeline,
                                    timeline_frame,
                                )
                            });
                        let layer = &mut session.layers[index];
                        let presented = if let Some(targets) = temporal_source_times.as_deref() {
                            layer.video.direct_mut()?.present_temporal_at_styled(
                                engine,
                                targets,
                                tolerance_seconds,
                                surface,
                                visual,
                            )?
                        } else {
                            layer.video.direct_mut()?.present_at_styled(
                                engine,
                                source_time_seconds,
                                tolerance_seconds,
                                surface,
                                visual,
                            )?
                        };
                        return match presented {
                            Some(mut frame) => {
                                let frame_object = frame.as_object_mut().context(
                                    "single-layer common-video receipt must be an object",
                                )?;
                                frame_object
                                    .insert("adaptiveFrameReused".into(), serde_json::json!(false));
                                frame_object
                                    .insert("adaptiveFrameAgeFrames".into(), serde_json::json!(0));
                                frame_object.insert(
                                    "decodeCadenceDivisor".into(),
                                    serde_json::json!(layer.decode_cadence_divisor),
                                );
                                frame_object.insert(
                                    "decodeCadencePhase".into(),
                                    serde_json::json!(layer.decode_cadence_phase),
                                );
                                frame_object.insert(
                                    "presentationTargetSeconds".into(),
                                    serde_json::json!(source_time_seconds),
                                );
                                Ok(serde_json::json!({
                                "sessionId": session_id,
                                "generation": generation,
                                "active": true,
                                "timelineFrame": timeline_frame,
                                "sourceFrame": frame_plan.source_frame,
                                "sourceTimeSeconds": source_time_seconds,
                                "temporalSampling": frame["temporalSampling"],
                                "nativeSurfaceCleared": false,
                                "endOfStream": false,
                                "frame": frame,
                                "layerFrames": [frame],
                                "layers": [{
                                    "layerIndex": index,
                                    "sourceNodeId": layer.source_node_id,
                                    "assetId": layer.asset_id,
                                    "active": true,
                                    "sourceFrame": frame_plan.source_frame,
                                    "sourceTimeSeconds": source_time_seconds,
                                    "frame": frame,
                                    "visualGraph": visual,
                                    "motionBlur": layer.visual_plan.motion_blur,
                                    "transformNodeId": layer.transform_node_id,
                                    "parentTransformNodeId": layer.parent_transform_node_id,
                                    "parentLayerIndex": layer.parent_layer_index,
                                    "parentControllerIndex": layer.parent_controller_index,
                                    "parentDepth": layer.parent_depth,
                                    "matteLayerIndex": layer.matte_layer_index,
                                    "matteMode": layer.matte_mode,
                                    "precompositionNodeIds": layer.precomposition_node_ids,
                                    "nestedGraphIds": layer.nested_graph_ids
                                }],
                                "controllers": controller_receipts,
                                "activeCaptions": [],
                                "captionTextureUploads": session.captions.len(),
                                "activeMotionGraphics": [],
                                "motionGraphicTextureUploads": session.motion_graphics.len(),
                                "activeParticles": null,
                                "activeParticleEmitters": [],
                                "activeParticleEmitters": [],
                                "activeAdjustments": [],
                                "adjustmentPassCount": 0,
                                "surface": surface.description(),
                                "controllers": controller_receipts,
                                "engineGraph": session.coverage,
                                "resourcePlan": session.resource_plan,
                                "decodeSchedule": session.decode_schedule,
                                "vfxSimulation": session.vfx_simulation,
                                "visualGraphApplied": true,
                                "visualGraph": visual,
                                "visualLayersApplied": true,
                                "visualLayers": [visual]
                                }))
                            }
                            None => Ok(serde_json::json!({
                                "sessionId": session_id,
                                "generation": generation,
                                "active": true,
                                "timelineFrame": timeline_frame,
                                "sourceFrame": frame_plan.source_frame,
                                "sourceTimeSeconds": source_time_seconds,
                                "nativeSurfaceCleared": false,
                                "endOfStream": true,
                                "surface": surface.description(),
                                "activeCaptions": [],
                                "captionTextureUploads": session.captions.len(),
                                "activeMotionGraphics": [],
                                "motionGraphicTextureUploads": session.motion_graphics.len(),
                                "activeParticles": null,
                                "activeParticleEmitters": [],
                                "activeAdjustments": [],
                                "adjustmentPassCount": 0,
                                "engineGraph": session.coverage,
                                "resourcePlan": session.resource_plan,
                                "decodeSchedule": session.decode_schedule,
                                "vfxSimulation": session.vfx_simulation,
                                "visualGraphApplied": true,
                                "visualGraph": visual,
                                "visualLayersApplied": true,
                                "visualLayers": [visual]
                            })),
                        };
                    }
                    let temporal_index = active_indices.iter().copied().find(|index| {
                        session.layers[*index]
                            .visual_plan
                            .motion_blur
                            .as_ref()
                            .is_some_and(|motion_blur| {
                                matches!(
                                    motion_blur.source_sampling,
                                    hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal
                                )
                            })
                    });
                    let mut temporal_stage: Option<(usize, serde_json::Value, Vec<usize>)> = None;
                    if let Some(index) = temporal_index {
                        let targets = session.layers[index]
                            .visual_plan
                            .motion_blur
                            .as_ref()
                            .context("decoded temporal composite layer lost its motion plan")?
                            .sample_source_times_seconds(
                                &session.layers[index].timeline,
                                timeline_frame,
                            );
                        let Some((mut receipt, slots)) = session.layers[index]
                            .video
                            .direct_mut()?
                            .stage_temporal_at(engine, &targets, tolerance_seconds)?
                        else {
                            return Ok(serde_json::json!({
                                "sessionId": session_id,
                                "generation": generation,
                                "active": true,
                                "timelineFrame": timeline_frame,
                                "nativeSurfaceCleared": false,
                                "endOfStream": true,
                                "surface": surface.description(),
                                "engineGraph": session.coverage,
                                "resourcePlan": session.resource_plan,
                                "decodeSchedule": session.decode_schedule,
                                "visualLayersApplied": false
                            }));
                        };
                        let object = receipt
                            .as_object_mut()
                            .context("decoded temporal composite receipt must be an object")?;
                        object.insert("adaptiveFrameReused".into(), serde_json::json!(false));
                        object.insert("adaptiveFrameAgeFrames".into(), serde_json::json!(0));
                        object.insert("decodeCadenceDivisor".into(), serde_json::json!(1));
                        object.insert("decodeCadencePhase".into(), serde_json::json!(0));
                        object.insert(
                            "presentationTargetSeconds".into(),
                            serde_json::json!(frame_plans[index].source_time_seconds),
                        );
                        temporal_stage = Some((index, receipt, slots));
                    }
                    let adaptive_stage_started = Instant::now();
                    for index in active_indices.iter().copied() {
                        if temporal_index == Some(index) {
                            continue;
                        }
                        let Some(target_seconds) = frame_plans[index].source_time_seconds else {
                            continue;
                        };
                        let layer = &mut session.layers[index];
                        let Some(cached) = layer.cached_stage.as_mut() else {
                            continue;
                        };
                        if cached.timeline_frame == timeline_frame {
                            continue;
                        }
                        let Some(timestamp_seconds) = cached.receipt["timestampSeconds"].as_f64()
                        else {
                            continue;
                        };
                        let timestamp_100ns = (timestamp_seconds * 10_000_000.0).round() as i64;
                        let target_100ns = (target_seconds * 10_000_000.0).round() as i64;
                        let tolerance_100ns = (tolerance_seconds * 10_000_000.0).round() as i64;
                        let drift_100ns = timestamp_100ns - target_100ns;
                        if drift_100ns.abs() > tolerance_100ns + 1 {
                            continue;
                        }
                        let drift_milliseconds = drift_100ns as f64 / 10_000.0;
                        let object = cached
                            .receipt
                            .as_object_mut()
                            .context("resident source-cache receipt must be an object")?;
                        object.insert(
                            "clockTargetSeconds".into(),
                            serde_json::json!(target_seconds),
                        );
                        object.insert(
                            "clockToleranceSeconds".into(),
                            serde_json::json!(tolerance_seconds),
                        );
                        object.insert(
                            "clockDriftMilliseconds".into(),
                            serde_json::json!(drift_milliseconds),
                        );
                        object.insert("clockWithinTolerance".into(), serde_json::json!(true));
                        object.insert("decoderSourceCacheHit".into(), serde_json::json!(true));
                        object.insert(
                            "gpuCopySubmissionMode".into(),
                            serde_json::json!("source-cache-hit/v1"),
                        );
                        object.insert("gpuCopySubmissionLayerCount".into(), serde_json::json!(0));
                        object.insert("decodePrepareMilliseconds".into(), serde_json::json!(0.0));
                        cached.timeline_frame = timeline_frame;
                    }
                    let decode_indices = active_indices
                        .iter()
                        .copied()
                        .filter(|index| {
                            if temporal_index == Some(*index) {
                                return false;
                            }
                            let layer = &session.layers[*index];
                            let Some(cached) = &layer.cached_stage else {
                                return true;
                            };
                            if timeline_frame == cached.timeline_frame {
                                return false;
                            }
                            if timeline_frame < cached.timeline_frame
                                || timeline_frame.saturating_sub(cached.timeline_frame)
                                    > u64::from(layer.decode_cadence_divisor)
                            {
                                return true;
                            }
                            timeline_frame % u64::from(layer.decode_cadence_divisor)
                                == u64::from(layer.decode_cadence_phase)
                        })
                        .collect::<Vec<_>>();
                    if !decode_indices.is_empty() {
                        let source_times = decode_indices
                            .iter()
                            .map(|index| {
                                frame_plans[*index].source_time_seconds.context(
                                    "active common-video adaptive frame has no source time",
                                )
                            })
                            .collect::<Result<Vec<_>>>()?;
                        let source_tolerances = vec![tolerance_seconds; decode_indices.len()];
                        let staged = if session.layers.len() > 1 {
                            let workers = session
                                .layers
                                .iter()
                                .enumerate()
                                .filter_map(|(index, layer)| {
                                    decode_indices
                                        .contains(&index)
                                        .then_some(layer.video.worker())
                                })
                                .collect::<Result<Vec<_>>>()?;
                            windows_video::stage_video_workers_at(
                                engine,
                                &workers,
                                &source_times,
                                &source_tolerances,
                            )?
                        } else {
                            vec![
                                session.layers[decode_indices[0]]
                                    .video
                                    .direct_mut()?
                                    .stage_at(engine, source_times[0], tolerance_seconds)?,
                            ]
                        };
                        if staged.iter().any(Option::is_none) {
                            return Ok(serde_json::json!({
                                "sessionId": session_id,
                                "generation": generation,
                                "active": true,
                                "timelineFrame": timeline_frame,
                                "nativeSurfaceCleared": false,
                                "endOfStream": true,
                                "surface": surface.description(),
                                "engineGraph": session.coverage,
                                "resourcePlan": session.resource_plan,
                                "decodeSchedule": session.decode_schedule,
                                "visualLayersApplied": false
                            }));
                        }
                        for (index, frame) in decode_indices.iter().zip(staged) {
                            let receipt = frame
                                .context("successful common-video adaptive stage has no receipt")?;
                            let slot_index = receipt["frameRingSlot"]
                                .as_u64()
                                .context("adaptive common-video frame has no ring slot")?
                                as usize;
                            session.layers[*index].cached_stage = Some(ResidentEngineCachedStage {
                                timeline_frame,
                                slot_index,
                                receipt,
                            });
                        }
                    }
                    let adaptive_decode_stage_milliseconds =
                        adaptive_stage_started.elapsed().as_secs_f64() * 1_000.0;
                    let mut frames = Vec::with_capacity(active_indices.len());
                    let mut slot_indices = Vec::with_capacity(active_indices.len());
                    for index in &active_indices {
                        if let Some((temporal_index, receipt, slots)) = temporal_stage.as_ref() {
                            if temporal_index == index {
                                slot_indices.push(slots[slots.len() / 2]);
                                frames.push(receipt.clone());
                                continue;
                            }
                        }
                        let layer = &session.layers[*index];
                        let cached = layer
                            .cached_stage
                            .as_ref()
                            .context("active common-video layer has no staged cache")?;
                        let age = timeline_frame.saturating_sub(cached.timeline_frame);
                        if age > u64::from(layer.decode_cadence_divisor.saturating_sub(1)) {
                            bail!("adaptive common-video frame exceeded its declared reuse age");
                        }
                        let mut receipt = cached.receipt.clone();
                        let object = receipt
                            .as_object_mut()
                            .context("adaptive common-video receipt must be an object")?;
                        object.insert("adaptiveFrameReused".into(), serde_json::json!(age > 0));
                        object.insert("adaptiveFrameAgeFrames".into(), serde_json::json!(age));
                        object.insert(
                            "decodeCadenceDivisor".into(),
                            serde_json::json!(layer.decode_cadence_divisor),
                        );
                        object.insert(
                            "decodeCadencePhase".into(),
                            serde_json::json!(layer.decode_cadence_phase),
                        );
                        object.insert(
                            "presentationTargetSeconds".into(),
                            serde_json::json!(frame_plans[*index].source_time_seconds),
                        );
                        slot_indices.push(cached.slot_index);
                        frames.push(receipt);
                    }
                    let mut visual_layers = active_indices
                        .iter()
                        .map(|index| {
                            resident_engine_video_visual_at(
                                &session.layers,
                                &session.controllers,
                                *index,
                                timeline_frame,
                                scene_frame.as_ref(),
                            )
                        })
                        .collect::<Result<Vec<_>>>()?;
                    if session.display_transform.is_aces2() {
                        for style in &mut visual_layers {
                            if style.source_color_contract < 0.5 { style.source_color_contract = 1.0; }
                        }
                    }
                    let active_particle_receipts = session
                        .particles
                        .iter_mut()
                        .filter_map(|particle| particle.update(engine, timeline_frame))
                        .collect::<Vec<_>>();
                    let mut surface_layers = engine_video_surface_layers(
                        &session.layers,
                        &active_indices,
                        &slot_indices,
                        &visual_layers,
                        temporal_stage
                            .as_ref()
                            .map(|(index, _, slots)| (*index, slots.as_slice())),
                    )?;
                    for index in &active_particle_indices {
                        surface_layers.push(session.particles[*index].texture.surface_layer());
                    }
                    for index in &active_caption_indices {
                        surface_layers.push(session.captions[*index].texture.surface_layer());
                    }
                    for index in &active_motion_graphic_indices {
                        let motion_graphic = &session.motion_graphics[*index];
                        let sample = motion_graphic
                            .plan
                            .sample(timeline_frame)
                            .context("active motion graphic lost its sampled style")?;
                        if let Some(homography) =
                            motion_graphic.plan.projective_transform(&sample)?
                        {
                            surface_layers.push(
                                motion_graphic
                                    .texture
                                    .surface_layer_with_projective(sample.opacity, homography),
                            );
                        } else {
                            let (pivot_x, pivot_y) = motion_graphic.plan.pivot_pixels();
                            surface_layers.push(motion_graphic.texture.surface_layer_with_motion(
                                sample.opacity,
                                sample.translate_x,
                                sample.translate_y,
                                sample.scale,
                                sample.rotation_radians,
                                pivot_x,
                                pivot_y,
                            ));
                        }
                    }
                    let adjustment_styles = active_adjustment_indices
                        .iter()
                        .map(|index| {
                            video_visual_style(&session.adjustments[*index].visual)
                                .with_source_dimensions(session.width, session.height)
                        })
                        .collect::<Vec<_>>();
                    let composite_present_started = Instant::now();
                    let adjustment_base_layer_count = (session.adjustment_before_typography
                        && !adjustment_styles.is_empty())
                    .then_some(active_indices.len() + active_particle_indices.len());
                    let sampled_depth_of_field = session
                        .depth_of_field
                        .as_ref()
                        .map(|plan| plan.sample(timeline_frame));
                    let surface_description = if session.display_transform.is_aces2() {
                        surface.present_scene_linear_aces2_layers(
                            engine,
                            session.display_transform,
                            &surface_layers,
                            &adjustment_styles,
                            adjustment_base_layer_count,
                            sampled_depth_of_field.as_ref(),
                        )?
                    } else {
                        surface.present_layers_with_adjustments(
                            engine,
                            &surface_layers,
                            &adjustment_styles,
                            adjustment_base_layer_count,
                        )?
                    };
                    let composite_present_milliseconds =
                        composite_present_started.elapsed().as_secs_f64() * 1_000.0;
                    let present_count = if session.display_transform.is_aces2() {
                        surface_description["surface"]["presentCount"].clone()
                    } else {
                        surface_description["presentCount"].clone()
                    };
                    for frame in &mut frames {
                        let object = frame
                            .as_object_mut()
                            .context("common-video composite frame receipt must be an object")?;
                        object.insert("nativeSurfacePresented".into(), serde_json::json!(true));
                        object.insert("nativeSurfacePresentCount".into(), present_count.clone());
                    }
                    let layer_receipts = active_indices
                        .iter()
                        .enumerate()
                        .map(|(position, index)| {
                            let layer = &session.layers[*index];
                            let plan = &frame_plans[*index];
                            serde_json::json!({
                                "layerIndex": index,
                                "sourceNodeId": layer.source_node_id,
                                "assetId": layer.asset_id,
                                "active": true,
                                "sourceFrame": plan.source_frame,
                                "sourceTimeSeconds": plan.source_time_seconds,
                                "frame": compact_engine_video_frame_receipt(&frames[position]),
                                "visualGraph": visual_layers[position],
                                "motionBlur": layer.visual_plan.motion_blur,
                                "transformNodeId": layer.transform_node_id,
                                "parentTransformNodeId": layer.parent_transform_node_id,
                                "parentLayerIndex": layer.parent_layer_index,
                                "parentControllerIndex": layer.parent_controller_index,
                                "parentDepth": layer.parent_depth,
                                "matteLayerIndex": layer.matte_layer_index,
                                "matteMode": layer.matte_mode
                                ,"precompositionNodeIds": layer.precomposition_node_ids
                                ,"nestedGraphIds": layer.nested_graph_ids
                            })
                        })
                        .collect::<Vec<_>>();
                    let active_captions = active_caption_indices
                        .iter()
                        .map(|index| session.captions[*index].receipt.clone())
                        .collect::<Vec<_>>();
                    let active_motion_graphics = active_motion_graphic_indices
                        .iter()
                        .filter_map(|index| {
                            session.motion_graphics[*index].active_receipt(timeline_frame)
                        })
                        .collect::<Vec<_>>();
                    let active_adjustments = active_adjustment_indices
                        .iter()
                        .enumerate()
                        .map(|(position, index)| {
                            serde_json::json!({
                                "nodeIds": session.adjustments[*index].node_ids,
                                "timeline": session.adjustments[*index].timeline,
                                "visualGraph": adjustment_styles[position]
                            })
                        })
                        .collect::<Vec<_>>();
                    let controller_receipts = resident_engine_video_controller_receipts(
                        &session.layers,
                        &session.controllers,
                        timeline_frame,
                    )?;
                    let temporal_sampling = temporal_stage
                        .as_ref()
                        .map(|(_, receipt, _)| receipt["temporalSampling"].clone());
                    Ok(serde_json::json!({
                            "sessionId": session_id,
                            "generation": generation,
                            "active": true,
                            "timelineFrame": timeline_frame,
                            "sourceFrame": frame_plans[active_indices[0]].source_frame,
                            "sourceTimeSeconds": frame_plans[active_indices[0]].source_time_seconds,
                            "nativeSurfaceCleared": false,
                            "endOfStream": false,
                            "frame": frames[0],
                            "layerFrames": frames,
                            "temporalSampling": temporal_sampling,
                            "layers": layer_receipts,
                            "controllers": controller_receipts,
                            "activeCaptions": active_captions,
                            "captionTextureUploads": session.captions.len(),
                            "activeMotionGraphics": active_motion_graphics,
                            "motionGraphicTextureUploads": session.motion_graphics.len(),
                            "activeParticles": active_particle_receipts.first().cloned(),
                            "activeParticleEmitters": active_particle_receipts,
                            "activeAdjustments": active_adjustments,
                            "adjustmentPassCount": adjustment_styles.len(),
                            "surface": if session.display_transform.is_aces2() { surface_description["surface"].clone() } else { surface_description.clone() },
                            "sceneLinearExecution": surface_description.get("sceneLinearExecution").cloned(),
                            "workingColorSpace": surface_description.get("workingColorSpace").cloned(),
                            "workingFormat": surface_description.get("workingFormat").cloned(),
                            "displayTransform": surface_description.get("displayTransform").cloned(),
                            "outputSpace": surface_description.get("outputSpace").cloned(),
                            "lutSha256": surface_description.get("lutSha256").cloned(),
                            "lutPayloadSha256": surface_description.get("lutPayloadSha256").cloned(),
                            "inputTransform": surface_description.get("inputTransform").cloned(),
                            "ocioVersion": surface_description.get("ocioVersion").cloned(),
                            "acesVersion": surface_description.get("acesVersion").cloned(),
                            "configSha256": surface_description.get("configSha256").cloned(),
                            "compositeExecutionMode": surface_description.get("compositeExecutionMode").cloned(),
                            "compositeLayerCount": surface_description.get("compositeLayerCount").cloned(),
                            "compositeFullFramePassCount": surface_description.get("compositeFullFramePassCount").cloned(),
                            "compositeMaximumLayersPerPass": surface_description.get("compositeMaximumLayersPerPass").cloned(),
                            "depthExecutionMode": surface_description.get("depthExecutionMode").cloned(),
                            "depthFormat": surface_description.get("depthFormat").cloned(),
                            "depthTestedLayerCount": surface_description.get("depthTestedLayerCount").cloned(),
                            "depthPassCount": surface_description.get("depthPassCount").cloned(),
                            "depthOfFieldExecutionMode": surface_description.get("depthOfFieldExecutionMode").cloned(),
                            "depthOfFieldDepthSource": surface_description.get("depthOfFieldDepthSource").cloned(),
                            "depthOfFieldPassCount": surface_description.get("depthOfFieldPassCount").cloned(),
                            "depthOfField": surface_description.get("depthOfField").cloned(),
                            "effectExecutionMode": surface_description.get("effectExecutionMode").cloned(),
                            "shaderOperationCount": surface_description.get("shaderOperationCount").cloned(),
                            "builtInEffectCount": surface_description.get("builtInEffectCount").cloned(),
                            "temporalExecutionMode": surface_description.get("temporalExecutionMode").cloned(),
                            "temporalLayerCount": surface_description.get("temporalLayerCount").cloned(),
                            "temporalSampleTextureCount": surface_description.get("temporalSampleTextureCount").cloned(),
                            "matteExecutionMode": surface_description.get("matteExecutionMode").cloned(),
                            "mattePassCount": surface_description.get("mattePassCount").cloned(),
                            "adjustmentExecutionMode": surface_description.get("adjustmentExecutionMode").cloned(),
                            "adjustmentBaseLayerCount": surface_description.get("adjustmentBaseLayerCount").cloned(),
                            "engineGraph": session.coverage,
                            "resourcePlan": session.resource_plan,
                            "decodeSchedule": session.decode_schedule,
                            "scene25d": scene_frame.as_ref().map(|scene| &scene.coverage),
                            "vfxSimulation": session.vfx_simulation,
                            "adaptiveDecodeStageMilliseconds": adaptive_decode_stage_milliseconds,
                            "compositePresentMilliseconds": composite_present_milliseconds,
                            "productPathCpuPixelCopies": 0,
                            "visualGraphApplied": true,
                            "visualGraph": visual_layers[0],
                            "visualLayersApplied": true,
                            "visualLayers": visual_layers
                    }))
                }
                #[cfg(not(windows))]
                "engine_video_present_frame" => {
                    bail!("common native-video graphs are currently available on Windows only")
                }
                #[cfg(windows)]
                "engine_video_verify_frame" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_video_verify_frame requires sessionId")?;
                    let timeline_frame = request
                        .timeline_frame
                        .context("engine_video_verify_frame requires timelineFrame")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("engine_video_verify_frame requires toleranceSeconds")?;
                    let output_path = request
                        .output_path
                        .as_deref()
                        .context("engine_video_verify_frame requires outputPath")?;
                    let session = engine_video_sessions
                        .get_mut(session_id)
                        .context("unknown resident common-video session")?;
                    let scene_frame = resident_engine_scene_at(session, timeline_frame)?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let surface = native_preview_surface
                        .as_mut()
                        .context("native preview surface is not bound")?;
                    surface.select_rec709_output_contract(engine, resident_video_requires_rec709_v2(session))?;
                    let frame_plans = session
                        .layers
                        .iter()
                        .map(|layer| layer.timeline.frame(timeline_frame))
                        .collect::<Vec<_>>();
                    let active_indices = frame_plans
                        .iter()
                        .enumerate()
                        .filter_map(|(index, plan)| plan.active.then_some(index))
                        .collect::<Vec<_>>();
                    let active_caption_indices = session
                        .captions
                        .iter()
                        .enumerate()
                        .filter_map(|(index, caption)| {
                            caption.plan.active(timeline_frame).then_some(index)
                        })
                        .collect::<Vec<_>>();
                    let active_motion_graphic_indices = session
                        .motion_graphics
                        .iter()
                        .enumerate()
                        .filter_map(|(index, graphic)| {
                            graphic.plan.sampled_opacity(timeline_frame).map(|_| index)
                        })
                        .collect::<Vec<_>>();
                    let active_adjustment_indices = session
                        .adjustments
                        .iter()
                        .enumerate()
                        .filter_map(|(index, adjustment)| {
                            adjustment.active(timeline_frame).then_some(index)
                        })
                        .collect::<Vec<_>>();
                    let active_particle_indices = session
                        .particles
                        .iter()
                        .enumerate()
                        .filter_map(|(index, particle)| {
                            particle.plan.active(timeline_frame).then_some(index)
                        })
                        .collect::<Vec<_>>();
                    if active_indices.is_empty() {
                        bail!("common-video verification requires at least one active layer");
                    }
                    if !session.display_transform.is_aces2()
                        && active_indices.len() == 1
                        && session.layers[active_indices[0]].video.is_direct()
                        && session.layers[active_indices[0]]
                            .matte_layer_index
                            .is_none()
                        && active_caption_indices.is_empty()
                        && active_motion_graphic_indices.is_empty()
                        && active_particle_indices.is_empty()
                        && active_adjustment_indices.is_empty()
                    {
                        let index = active_indices[0];
                        let frame_plan = &frame_plans[index];
                        let source_time_seconds = frame_plan
                            .source_time_seconds
                            .context("active common-video verification frame has no source time")?;
                        let visual = resident_engine_video_visual_at(
                            &session.layers,
                            &session.controllers,
                            index,
                            timeline_frame,
                            scene_frame.as_ref(),
                        )?;
                        let temporal_source_times = session.layers[index]
                            .visual_plan
                            .motion_blur
                            .as_ref()
                            .filter(|motion_blur| {
                                matches!(
                                    motion_blur.source_sampling,
                                    hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal
                                )
                            })
                            .map(|motion_blur| {
                                motion_blur.sample_source_times_seconds(
                                    &session.layers[index].timeline,
                                    timeline_frame,
                                )
                            });
                        let layer = &mut session.layers[index];
                        let verified = if let Some(targets) = temporal_source_times.as_deref() {
                            layer.video.direct_mut()?.verify_temporal_at(
                                engine,
                                targets,
                                tolerance_seconds,
                                surface,
                                visual,
                                output_path,
                            )?
                        } else {
                            layer.video.direct_mut()?.verify_at(
                                engine,
                                source_time_seconds,
                                tolerance_seconds,
                                surface,
                                visual,
                                output_path,
                            )?
                        };
                        return match verified {
                            Some(frame) => {
                                let verification_readback = frame["verificationReadback"].clone();
                                let product_path_cpu_pixel_copies =
                                    frame["productPathCpuPixelCopies"].clone();
                                let output_written = frame["outputWritten"].clone();
                                let output_hash = frame["outputHash"].clone();
                                Ok(serde_json::json!({
                                    "sessionId": session_id,
                                    "generation": generation,
                                    "active": true,
                                    "timelineFrame": timeline_frame,
                                    "sourceFrame": frame_plan.source_frame,
                                    "sourceTimeSeconds": source_time_seconds,
                                    "temporalSampling": frame["temporalSampling"],
                                    "endOfStream": false,
                                    "frame": frame,
                                    "layerFrames": [frame],
                                    "layers": [{
                                        "layerIndex": index,
                                        "sourceNodeId": layer.source_node_id,
                                        "assetId": layer.asset_id,
                                        "active": true,
                                        "sourceFrame": frame_plan.source_frame,
                                        "sourceTimeSeconds": source_time_seconds,
                                        "frame": compact_engine_video_frame_receipt(&frame),
                                        "visualGraph": visual,
                                        "motionBlur": layer.visual_plan.motion_blur,
                                        "transformNodeId": layer.transform_node_id,
                                        "parentTransformNodeId": layer.parent_transform_node_id,
                                        "parentLayerIndex": layer.parent_layer_index,
                                        "parentControllerIndex": layer.parent_controller_index,
                                        "parentDepth": layer.parent_depth,
                                        "matteLayerIndex": layer.matte_layer_index,
                                        "matteMode": layer.matte_mode,
                                        "precompositionNodeIds": layer.precomposition_node_ids,
                                        "nestedGraphIds": layer.nested_graph_ids
                                    }],
                                    "verificationReadback": verification_readback,
                                    "productPathCpuPixelCopies": product_path_cpu_pixel_copies,
                                    "outputWritten": output_written,
                                    "outputHash": output_hash,
                                    "visualGraph": visual,
                                    "motionBlur": layer.visual_plan.motion_blur,
                                    "visualLayers": [visual],
                                    "activeCaptions": [],
                                    "captionTextureUploads": session.captions.len(),
                                    "activeMotionGraphics": [],
                                    "motionGraphicTextureUploads": session.motion_graphics.len(),
                                    "activeParticles": null,
                                    "activeParticleEmitters": [],
                                    "activeAdjustments": [],
                                    "adjustmentPassCount": 0,
                                    "engineGraph": session.coverage,
                                    "resourcePlan": session.resource_plan,
                                    "decodeSchedule": session.decode_schedule
                                    ,"scene25d": scene_frame.as_ref().map(|scene| &scene.coverage)
                                    ,"vfxSimulation": session.vfx_simulation
                                }))
                            }
                            None => Ok(serde_json::json!({
                                "sessionId": session_id,
                                "generation": generation,
                                "active": true,
                                "timelineFrame": timeline_frame,
                                "sourceFrame": frame_plan.source_frame,
                                "sourceTimeSeconds": source_time_seconds,
                                "endOfStream": true,
                                    "visualGraph": visual,
                                    "activeCaptions": [],
                                    "captionTextureUploads": session.captions.len(),
                                    "activeMotionGraphics": [],
                                    "motionGraphicTextureUploads": session.motion_graphics.len(),
                                    "activeParticles": null,
                                    "activeParticleEmitters": [],
                                    "activeAdjustments": [],
                                    "adjustmentPassCount": 0,
                                    "engineGraph": session.coverage,
                                    "resourcePlan": session.resource_plan,
                                    "decodeSchedule": session.decode_schedule
                                    ,"scene25d": scene_frame.as_ref().map(|scene| &scene.coverage)
                                    ,"vfxSimulation": session.vfx_simulation
                            })),
                        };
                    }
                    let temporal_index = active_indices.iter().copied().find(|index| {
                        session.layers[*index]
                            .visual_plan
                            .motion_blur
                            .as_ref()
                            .is_some_and(|motion_blur| {
                                matches!(
                                motion_blur.source_sampling,
                                hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal
                            )
                            })
                    });
                    let mut temporal_stage: Option<(usize, Vec<usize>)> = None;
                    let mut staged_by_index = BTreeMap::<usize, (serde_json::Value, usize)>::new();
                    if let Some(index) = temporal_index {
                        let targets = session.layers[index]
                            .visual_plan
                            .motion_blur
                            .as_ref()
                            .context("decoded temporal verification layer lost its motion plan")?
                            .sample_source_times_seconds(
                                &session.layers[index].timeline,
                                timeline_frame,
                            );
                        let Some((receipt, slots)) = session.layers[index]
                            .video
                            .direct_mut()?
                            .stage_temporal_at(engine, &targets, tolerance_seconds)?
                        else {
                            return Ok(serde_json::json!({
                                "sessionId": session_id,
                                "generation": generation,
                                "active": true,
                                "timelineFrame": timeline_frame,
                                "endOfStream": true,
                                "engineGraph": session.coverage,
                                "resourcePlan": session.resource_plan,
                                "decodeSchedule": session.decode_schedule
                            }));
                        };
                        let primary_slot = slots[slots.len() / 2];
                        staged_by_index.insert(index, (receipt, primary_slot));
                        temporal_stage = Some((index, slots));
                    }
                    let standard_indices = active_indices
                        .iter()
                        .copied()
                        .filter(|index| temporal_index != Some(*index))
                        .collect::<Vec<_>>();
                    let source_times = standard_indices
                        .iter()
                        .map(|index| {
                            frame_plans[*index].source_time_seconds.context(
                                "active common-video composite verification has no source time",
                            )
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let source_tolerances = vec![tolerance_seconds; standard_indices.len()];
                    let staged = if standard_indices.is_empty() {
                        Vec::new()
                    } else if session.layers.len() > 1 {
                        let workers = standard_indices
                            .iter()
                            .map(|index| session.layers[*index].video.worker())
                            .collect::<Result<Vec<_>>>()?;
                        windows_video::stage_video_workers_at(
                            engine,
                            &workers,
                            &source_times,
                            &source_tolerances,
                        )?
                    } else {
                        vec![
                            session.layers[standard_indices[0]]
                                .video
                                .direct_mut()?
                                .stage_at(engine, source_times[0], tolerance_seconds)?,
                        ]
                    };
                    if staged.iter().any(Option::is_none) {
                        return Ok(serde_json::json!({
                            "sessionId": session_id,
                            "generation": generation,
                            "active": true,
                            "timelineFrame": timeline_frame,
                            "endOfStream": true,
                            "engineGraph": session.coverage,
                                "resourcePlan": session.resource_plan,
                                "decodeSchedule": session.decode_schedule
                        }));
                    }
                    for (index, frame) in standard_indices.iter().copied().zip(staged) {
                        let frame = frame
                            .context("successful composite verification stage has no receipt")?;
                        let slot = frame["frameRingSlot"]
                            .as_u64()
                            .context("staged composite verification frame has no ring slot")?
                            as usize;
                        staged_by_index.insert(index, (frame, slot));
                    }
                    let frames = active_indices
                        .iter()
                        .map(|index| {
                            staged_by_index
                                .get(index)
                                .map(|(frame, _)| frame.clone())
                                .context("composite verification layer was not staged")
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let slot_indices = active_indices
                        .iter()
                        .map(|index| {
                            staged_by_index
                                .get(index)
                                .map(|(_, slot)| *slot)
                                .context("composite verification layer has no resident slot")
                        })
                        .collect::<Result<Vec<_>>>()?;
                    let mut visual_layers = active_indices
                        .iter()
                        .map(|index| {
                            resident_engine_video_visual_at(
                                &session.layers,
                                &session.controllers,
                                *index,
                                timeline_frame,
                                scene_frame.as_ref(),
                            )
                        })
                        .collect::<Result<Vec<_>>>()?;
                    if session.display_transform.is_aces2() {
                        for style in &mut visual_layers {
                            if style.source_color_contract < 0.5 { style.source_color_contract = 1.0; }
                        }
                    }
                    let verification_indices = active_indices.clone();
                    let active_particle_receipts = session
                        .particles
                        .iter_mut()
                        .filter_map(|particle| particle.update(engine, timeline_frame))
                        .collect::<Vec<_>>();
                    let mut surface_layers = engine_video_surface_layers(
                        &session.layers,
                        &verification_indices,
                        &slot_indices,
                        &visual_layers,
                        temporal_stage
                            .as_ref()
                            .map(|(index, slots)| (*index, slots.as_slice())),
                    )?;
                    for index in &active_particle_indices {
                        surface_layers.push(session.particles[*index].texture.surface_layer());
                    }
                    for index in &active_caption_indices {
                        surface_layers.push(session.captions[*index].texture.surface_layer());
                    }
                    for index in &active_motion_graphic_indices {
                        let motion_graphic = &session.motion_graphics[*index];
                        let sample = motion_graphic
                            .plan
                            .sample(timeline_frame)
                            .context("active motion graphic lost its sampled style")?;
                        if let Some(homography) =
                            motion_graphic.plan.projective_transform(&sample)?
                        {
                            surface_layers.push(
                                motion_graphic
                                    .texture
                                    .surface_layer_with_projective(sample.opacity, homography),
                            );
                        } else {
                            let (pivot_x, pivot_y) = motion_graphic.plan.pivot_pixels();
                            surface_layers.push(motion_graphic.texture.surface_layer_with_motion(
                                sample.opacity,
                                sample.translate_x,
                                sample.translate_y,
                                sample.scale,
                                sample.rotation_radians,
                                pivot_x,
                                pivot_y,
                            ));
                        }
                    }
                    let adjustment_styles = active_adjustment_indices
                        .iter()
                        .map(|index| {
                            video_visual_style(&session.adjustments[*index].visual)
                                .with_source_dimensions(session.width, session.height)
                        })
                        .collect::<Vec<_>>();
                    let adjustment_base_layer_count = (session.adjustment_before_typography
                        && !adjustment_styles.is_empty())
                    .then_some(verification_indices.len() + active_particle_indices.len());
                    let sampled_depth_of_field = session
                        .depth_of_field
                        .as_ref()
                        .map(|plan| plan.sample(timeline_frame));
                    let verification = if session.display_transform.is_aces2() {
                        surface.verify_scene_linear_aces2_layers(
                            engine,
                            session.display_transform,
                            &surface_layers,
                            &adjustment_styles,
                            adjustment_base_layer_count,
                            sampled_depth_of_field.as_ref(),
                            session.width,
                            session.height,
                            output_path,
                        )?
                    } else {
                        surface.verify_layers_with_adjustments(
                            engine,
                            &surface_layers,
                            &adjustment_styles,
                            adjustment_base_layer_count,
                            session.width,
                            session.height,
                            output_path,
                        )?
                    };
                    let layer_receipts = active_indices
                        .iter()
                        .enumerate()
                        .map(|(position, index)| {
                            let layer = &session.layers[*index];
                            let plan = &frame_plans[*index];
                            serde_json::json!({
                                "layerIndex": index,
                                "sourceNodeId": layer.source_node_id,
                                "assetId": layer.asset_id,
                                "active": true,
                                "sourceFrame": plan.source_frame,
                                "sourceTimeSeconds": plan.source_time_seconds,
                                "frame": frames[position],
                                "visualGraph": visual_layers[position],
                                "motionBlur": layer.visual_plan.motion_blur,
                                "transformNodeId": layer.transform_node_id,
                                "parentTransformNodeId": layer.parent_transform_node_id,
                                "parentLayerIndex": layer.parent_layer_index,
                                "parentControllerIndex": layer.parent_controller_index,
                                "parentDepth": layer.parent_depth,
                                "matteLayerIndex": layer.matte_layer_index,
                                "matteMode": layer.matte_mode
                                ,"precompositionNodeIds": layer.precomposition_node_ids
                                ,"nestedGraphIds": layer.nested_graph_ids
                            })
                        })
                        .collect::<Vec<_>>();
                    let active_captions = active_caption_indices
                        .iter()
                        .map(|index| session.captions[*index].receipt.clone())
                        .collect::<Vec<_>>();
                    let active_motion_graphics = active_motion_graphic_indices
                        .iter()
                        .filter_map(|index| {
                            session.motion_graphics[*index].active_receipt(timeline_frame)
                        })
                        .collect::<Vec<_>>();
                    let active_adjustments = active_adjustment_indices
                        .iter()
                        .enumerate()
                        .map(|(position, index)| {
                            serde_json::json!({
                                "nodeIds": session.adjustments[*index].node_ids,
                                "timeline": session.adjustments[*index].timeline,
                                "visualGraph": adjustment_styles[position]
                            })
                        })
                        .collect::<Vec<_>>();
                    let controller_receipts = resident_engine_video_controller_receipts(
                        &session.layers,
                        &session.controllers,
                        timeline_frame,
                    )?;
                    let temporal_sampling = temporal_index.and_then(|index| {
                        staged_by_index
                            .get(&index)
                            .map(|(frame, _)| frame["temporalSampling"].clone())
                    });
                    Ok(serde_json::json!({
                        "sessionId": session_id,
                        "generation": generation,
                        "active": true,
                        "timelineFrame": timeline_frame,
                        "sourceFrame": frame_plans[active_indices[0]].source_frame,
                        "sourceTimeSeconds": frame_plans[active_indices[0]].source_time_seconds,
                        "endOfStream": false,
                        "frame": frames[0],
                        "layerFrames": frames,
                        "temporalSampling": temporal_sampling,
                        "layers": layer_receipts,
                        "controllers": controller_receipts,
                        "activeCaptions": active_captions,
                        "captionTextureUploads": session.captions.len(),
                        "activeMotionGraphics": active_motion_graphics,
                        "motionGraphicTextureUploads": session.motion_graphics.len(),
                        "activeParticles": active_particle_receipts.first().cloned(),
                        "activeParticleEmitters": active_particle_receipts,
                        "activeAdjustments": active_adjustments,
                        "adjustmentPassCount": adjustment_styles.len(),
                        "verificationReadback": verification["verificationReadback"],
                        "productPathCpuPixelCopies": verification["productPathCpuPixelCopies"],
                        "outputWritten": verification["outputWritten"],
                        "outputHash": verification["outputHash"],
                        "compositeExecutionMode": verification["compositeExecutionMode"],
                        "compositeLayerCount": verification["compositeLayerCount"],
                        "compositeFullFramePassCount": verification["compositeFullFramePassCount"],
                        "compositeMaximumLayersPerPass": verification["compositeMaximumLayersPerPass"],
                        "depthExecutionMode": verification["depthExecutionMode"],
                        "depthFormat": verification["depthFormat"],
                        "depthTestedLayerCount": verification["depthTestedLayerCount"],
                        "depthPassCount": verification["depthPassCount"],
                        "depthOfFieldExecutionMode": verification["depthOfFieldExecutionMode"],
                        "depthOfFieldDepthSource": verification["depthOfFieldDepthSource"],
                        "depthOfFieldPassCount": verification["depthOfFieldPassCount"],
                        "depthOfField": verification["depthOfField"],
                        "effectExecutionMode": verification["effectExecutionMode"],
                        "shaderOperationCount": verification["shaderOperationCount"],
                        "builtInEffectCount": verification["builtInEffectCount"],
                        "temporalExecutionMode": verification["temporalExecutionMode"],
                        "temporalLayerCount": verification["temporalLayerCount"],
                        "temporalSampleTextureCount": verification["temporalSampleTextureCount"],
                        "matteExecutionMode": verification["matteExecutionMode"],
                        "mattePassCount": verification["mattePassCount"],
                        "adjustmentExecutionMode": verification["adjustmentExecutionMode"],
                        "adjustmentBaseLayerCount": verification["adjustmentBaseLayerCount"],
                        "sceneLinearExecution": verification["sceneLinearExecution"],
                        "workingColorSpace": verification["workingColorSpace"],
                        "workingFormat": verification["workingFormat"],
                        "displayTransform": verification["displayTransform"],
                        "outputSpace": verification["outputSpace"],
                        "lutSha256": verification["lutSha256"],
                        "lutPayloadSha256": verification["lutPayloadSha256"],
                        "inputTransform": verification["inputTransform"],
                        "ocioVersion": verification["ocioVersion"],
                        "acesVersion": verification["acesVersion"],
                        "configSha256": verification["configSha256"],
                        "visualGraph": visual_layers[0],
                        "visualLayers": verification["visualLayers"],
                        "engineGraph": session.coverage,
                        "resourcePlan": session.resource_plan,
                        "decodeSchedule": session.decode_schedule,
                        "scene25d": scene_frame.as_ref().map(|scene| &scene.coverage),
                        "vfxSimulation": session.vfx_simulation
                    }))
                }
                #[cfg(not(windows))]
                "engine_video_verify_frame" => {
                    bail!("common native-video graphs are currently available on Windows only")
                }
                #[cfg(windows)]
                "engine_video_release" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("engine_video_release requires sessionId")?;
                    match engine_video_sessions.remove(session_id) {
                        Some(mut session) => {
                            let engine = video_compositor
                                .as_ref()
                                .context("DX12 video compositor unavailable")?;
                            let mut retired_submission_sequences = Vec::new();
                            let mut pending_fence_count = 0_u64;
                            for layer in &mut session.layers {
                                let fences = layer.video.flush_staged_fences(engine)?;
                                pending_fence_count += fences["pendingFenceCount"]
                                    .as_u64()
                                    .context("common-video fence receipt has no pending count")?;
                                if let Some(sequences) =
                                    fences["retiredSubmissionSequences"].as_array()
                                {
                                    retired_submission_sequences.extend(sequences.iter().cloned());
                                }
                            }
                            let fences = serde_json::json!({
                                "retiredFenceCount": retired_submission_sequences.len(),
                                "retiredSubmissionSequences": retired_submission_sequences,
                                "pendingFenceCount": pending_fence_count
                            });
                            Ok(serde_json::json!({
                                "sessionId": session_id,
                                "released": true,
                                "fences": fences
                            }))
                        }
                        None => Ok(serde_json::json!({
                            "sessionId": session_id,
                            "released": false,
                            "fences": { "retiredFenceCount": 0, "retiredSubmissionSequences": [], "pendingFenceCount": 0 }
                        })),
                    }
                }
                #[cfg(not(windows))]
                "engine_video_release" => {
                    bail!("common native-video graphs are currently available on Windows only")
                }
                #[cfg(windows)]
                "video_open" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_open requires sessionId")?;
                    if session_id.trim().is_empty() {
                        bail!("sessionId cannot be empty");
                    }
                    if video_sessions.contains_key(session_id) {
                        bail!("resident video session already exists: {session_id}");
                    }
                    let input_path = request
                        .input_path
                        .as_deref()
                        .context("video_open requires inputPath")?;
                    if video_compositor.is_none() {
                        video_compositor = Some(GpuCompositor::new_dx12_video()?);
                    }
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let session = windows_video::VideoInteropSession::open(engine, input_path)?;
                    let decoder = session.description();
                    video_sessions.insert(session_id.to_owned(), session);
                    Ok(serde_json::json!({
                        "sessionId": session_id, "generation": generation,
                        "backend": engine.backend, "decoder": decoder
                    }))
                }
                #[cfg(not(windows))]
                "video_open" => {
                    bail!("resident hardware video decoding is currently available on Windows only")
                }
                #[cfg(windows)]
                "video_decode_next" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_decode_next requires sessionId")?;
                    let session = video_sessions
                        .get_mut(session_id)
                        .context("unknown resident video session")?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    match session.decode_next(engine, request.output_path.as_deref())? {
                        Some(frame) => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": false, "frame": frame
                        })),
                        None => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": true
                        })),
                    }
                }
                #[cfg(not(windows))]
                "video_decode_next" => {
                    bail!("resident hardware video decoding is currently available on Windows only")
                }
                #[cfg(windows)]
                "video_decode_at" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_decode_at requires sessionId")?;
                    let target_seconds = request
                        .time_seconds
                        .context("video_decode_at requires timeSeconds")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("video_decode_at requires toleranceSeconds")?;
                    let session = video_sessions
                        .get_mut(session_id)
                        .context("unknown resident video session")?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    match session.decode_at(
                        engine,
                        target_seconds,
                        tolerance_seconds,
                        request.output_path.as_deref(),
                    )? {
                        Some(frame) => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": false, "frame": frame
                        })),
                        None => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": true
                        })),
                    }
                }
                #[cfg(not(windows))]
                "video_decode_at" => {
                    bail!("resident hardware video decoding is currently available on Windows only")
                }
                #[cfg(windows)]
                "video_stage_at" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_stage_at requires sessionId")?;
                    let target_seconds = request
                        .time_seconds
                        .context("video_stage_at requires timeSeconds")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("video_stage_at requires toleranceSeconds")?;
                    let session = video_sessions
                        .get_mut(session_id)
                        .context("unknown resident video session")?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    match session.stage_at(engine, target_seconds, tolerance_seconds)? {
                        Some(frame) => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": false, "frame": frame
                        })),
                        None => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": true
                        })),
                    }
                }
                #[cfg(not(windows))]
                "video_stage_at" => {
                    bail!("resident hardware video staging is currently available on Windows only")
                }
                #[cfg(windows)]
                "video_stage_batch_at" => {
                    let session_ids = request
                        .session_ids
                        .as_deref()
                        .context("video_stage_batch_at requires sessionIds")?;
                    if session_ids.is_empty() || session_ids.len() > 192 {
                        bail!("video_stage_batch_at sessionIds must contain 1..=192 sessions");
                    }
                    let unique_ids = session_ids
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>();
                    if unique_ids.len() != session_ids.len() {
                        bail!("video_stage_batch_at sessionIds must be unique");
                    }
                    for session_id in session_ids {
                        if !video_sessions.contains_key(session_id) {
                            bail!("unknown resident video session: {session_id}");
                        }
                    }
                    let target_seconds = request
                        .time_seconds
                        .context("video_stage_batch_at requires timeSeconds")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("video_stage_batch_at requires toleranceSeconds")?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let mut removed_sessions = Vec::with_capacity(session_ids.len());
                    for session_id in session_ids {
                        let session = video_sessions
                            .remove(session_id)
                            .context("resident video session disappeared during batch")?;
                        removed_sessions.push((session_id.clone(), session));
                    }
                    let staged_result = {
                        let mut session_refs = removed_sessions
                            .iter_mut()
                            .map(|(_, session)| session)
                            .collect::<Vec<_>>();
                        windows_video::stage_video_sessions_at(
                            engine,
                            &mut session_refs,
                            target_seconds,
                            tolerance_seconds,
                        )
                    };
                    for (session_id, session) in removed_sessions {
                        video_sessions.insert(session_id, session);
                    }
                    let staged = staged_result?;
                    let mut frames = Vec::with_capacity(session_ids.len());
                    for (session_id, frame) in session_ids.iter().zip(staged) {
                        frames.push(serde_json::json!({
                            "sessionId": session_id,
                            "endOfStream": frame.is_none(),
                            "frame": frame,
                        }));
                    }
                    Ok(serde_json::json!({
                        "generation": generation,
                        "batchExecution": "single-ipc-resident-video-stage/v1",
                        "sessionCount": session_ids.len(),
                        "frames": frames,
                    }))
                }
                #[cfg(not(windows))]
                "video_stage_batch_at" => {
                    bail!("resident hardware video staging is currently available on Windows only")
                }
                #[cfg(windows)]
                "surface_bind" => {
                    let parent_hwnd = request
                        .parent_hwnd
                        .as_deref()
                        .unwrap_or("0")
                        .parse::<usize>()
                        .context("surface_bind parentHwnd must be an unsigned decimal handle")?;
                    let x = request.x.context("surface_bind requires x")?;
                    let y = request.y.context("surface_bind requires y")?;
                    let width = request.width.context("surface_bind requires width")?;
                    let height = request.height.context("surface_bind requires height")?;
                    let color_space = windows_video::NativePreviewColorSpace::parse(
                        request.surface_color_space.as_deref(),
                    )?;
                    if video_compositor.is_none() {
                        video_compositor = Some(GpuCompositor::new_dx12_video()?);
                    }
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    if let Some(surface) = native_preview_surface.as_mut() {
                        surface.reposition(engine, parent_hwnd, x, y, width, height, color_space)
                    } else {
                        let surface = windows_video::NativePreviewSurface::bind(
                            engine,
                            parent_hwnd,
                            x,
                            y,
                            width,
                            height,
                            color_space,
                        )?;
                        let description = surface.description();
                        native_preview_surface = Some(surface);
                        Ok(description)
                    }
                }
                #[cfg(not(windows))]
                "surface_bind" => {
                    bail!("native preview surfaces are currently available on Windows only")
                }
                #[cfg(windows)]
                "surface_probe" => native_preview_surface
                    .as_mut()
                    .context("native preview surface is not bound")?
                    .clear_black(
                        video_compositor
                            .as_ref()
                            .context("DX12 video compositor unavailable")?,
                    ),
                #[cfg(not(windows))]
                "surface_probe" => {
                    bail!("native preview surfaces are currently available on Windows only")
                }
                #[cfg(windows)]
                "surface_hide" => Ok(native_preview_surface
                    .as_mut()
                    .context("native preview surface is not bound")?
                    .hide()),
                #[cfg(not(windows))]
                "surface_hide" => {
                    bail!("native preview surfaces are currently available on Windows only")
                }
                #[cfg(windows)]
                "surface_release" => Ok(serde_json::json!({
                    "released": native_preview_surface.take().is_some()
                })),
                #[cfg(not(windows))]
                "surface_release" => {
                    bail!("native preview surfaces are currently available on Windows only")
                }
                #[cfg(windows)]
                "video_present_at" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_present_at requires sessionId")?;
                    let target_seconds = request
                        .time_seconds
                        .context("video_present_at requires timeSeconds")?;
                    let tolerance_seconds = request
                        .tolerance_seconds
                        .context("video_present_at requires toleranceSeconds")?;
                    let session = video_sessions
                        .get_mut(session_id)
                        .context("unknown resident video session")?;
                    let engine = video_compositor
                        .as_ref()
                        .context("DX12 video compositor unavailable")?;
                    let surface = native_preview_surface
                        .as_mut()
                        .context("native preview surface is not bound")?;
                    match session.present_at(engine, target_seconds, tolerance_seconds, surface)? {
                        Some(frame) => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": false, "frame": frame,
                            "surface": surface.description()
                        })),
                        None => Ok(serde_json::json!({
                            "sessionId": session_id, "generation": generation,
                            "endOfStream": true, "surface": surface.description()
                        })),
                    }
                }
                #[cfg(not(windows))]
                "video_present_at" => {
                    bail!("native preview surfaces are currently available on Windows only")
                }
                #[cfg(windows)]
                "video_seek" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_seek requires sessionId")?;
                    let time_seconds = request
                        .time_seconds
                        .context("video_seek requires timeSeconds")?;
                    let session = video_sessions
                        .get_mut(session_id)
                        .context("unknown resident video session")?;
                    let seek = session.seek(time_seconds)?;
                    Ok(serde_json::json!({
                        "sessionId": session_id, "generation": generation, "seek": seek
                    }))
                }
                #[cfg(not(windows))]
                "video_seek" => {
                    bail!("resident hardware video decoding is currently available on Windows only")
                }
                #[cfg(windows)]
                "video_release" => {
                    let session_id = request
                        .session_id
                        .as_deref()
                        .context("video_release requires sessionId")?;
                    match video_sessions.remove(session_id) {
                        Some(mut session) => {
                            let engine = video_compositor
                                .as_ref()
                                .context("DX12 video compositor unavailable")?;
                            let fences = session.flush_staged_fences(engine)?;
                            Ok(serde_json::json!({
                                "sessionId": session_id,
                                "released": true,
                                "fences": fences
                            }))
                        }
                        None => Ok(serde_json::json!({
                            "sessionId": session_id,
                            "released": false,
                            "fences": { "retiredFenceCount": 0, "retiredSubmissionSequences": [], "pendingFenceCount": 0 }
                        })),
                    }
                }
                #[cfg(not(windows))]
                "video_release" => {
                    bail!("resident hardware video decoding is currently available on Windows only")
                }
                "recover_device" => {
                    sessions.clear();
                    #[cfg(windows)]
                    {
                        if let Some(engine) = video_compositor.as_ref() {
                            for session in video_sessions.values_mut() {
                                session.flush_staged_fences(engine)?;
                            }
                            for session in engine_video_sessions.values_mut() {
                                for layer in &mut session.layers {
                                    layer.video.flush_staged_fences(engine)?;
                                }
                            }
                        }
                        video_sessions.clear();
                        engine_video_sessions.clear();
                        native_preview_surface = None;
                        video_compositor = None;
                    }
                    compositor = GpuCompositor::new()?;
                    generation += 1;
                    Ok(serde_json::json!({
                        "recovered": true, "generation": generation,
                        "residentSessions": 0, "residentVideoSessions": 0,
                        "residentEngineVideoSessions": 0
                    }))
                }
                "shutdown" => Ok(serde_json::json!({ "shutdown": true })),
                command => bail!("unknown resident engine command: {command}"),
            }
        })();
        match outcome {
            Ok(value) => writeln!(stdout, "{}", server_response(&request.id, true, value))?,
            Err(error) => writeln!(
                stdout,
                "{}",
                server_response(&request.id, false, serde_json::json!(error.to_string()))
            )?,
        }
        stdout.flush()?;
        if request.command == "shutdown" {
            break;
        }
    }
    Ok(())
}

fn usage() -> &'static str {
    "Usage:\n  editkin-gpu-compositor probe\n  editkin-gpu-compositor serve\n  editkin-gpu-compositor selftest <graph.json> <output-dir>\n  editkin-gpu-compositor render <graph.json> <output.png> [gpu|cpu]\n  editkin-gpu-compositor engine-render <engine-graph.json> <asset-bindings.json> <timeline-frame> <output.png> [gpu|cpu]\n  editkin-gpu-compositor engine-render-sequence <engine-graph.json> <asset-bindings.json> <start-frame> <frame-count> <output-directory> [gpu|cpu]\n  editkin-gpu-compositor engine-render-display-sequence <engine-graph.json> <asset-bindings.json> <start-frame> <frame-count> <output-directory> [gpu|cpu]\n  editkin-gpu-compositor benchmark <graph.json> <frames> [report.json]\n  editkin-gpu-compositor decode-interop <input.mp4> <frames> <report.json>\n  editkin-gpu-compositor software-runtime-probe <runtime-root> <report.json>\n  editkin-gpu-compositor software-decode <runtime-root> <input> <target-seconds> <tolerance-seconds> <report.json>\n  editkin-gpu-compositor software-decode-benchmark <runtime-root> <input> <iterations> <report.json>"
}

#[cfg(windows)]
fn write_software_receipt<T: Serialize>(receipt: &T, report_path: &Path) -> Result<()> {
    let json = serde_json::to_string_pretty(receipt)? + "\n";
    if let Some(parent) = report_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create receipt directory {}", parent.display()))?;
    }
    fs::write(report_path, &json)
        .with_context(|| format!("write receipt {}", report_path.display()))?;
    print!("{json}");
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("probe") if args.len() == 2 => probe_command(),
        Some("serve") if args.len() == 2 => serve_command(),
        Some("selftest") if args.len() == 4 => selftest(Path::new(&args[2]), Path::new(&args[3])),
        Some("render") if (4..=5).contains(&args.len()) => render_command(
            Path::new(&args[2]),
            Path::new(&args[3]),
            args.get(4).map(String::as_str).unwrap_or("gpu"),
        ),
        Some("engine-render") if (6..=7).contains(&args.len()) => {
            let timeline_frame: u64 = args[4].parse().context("parse timeline frame")?;
            engine_render_command(
                Path::new(&args[2]),
                Path::new(&args[3]),
                timeline_frame,
                Path::new(&args[5]),
                args.get(6).map(String::as_str).unwrap_or("gpu"),
            )
        }
        Some("engine-render-sequence") if (7..=8).contains(&args.len()) => {
            let start_frame: u64 = args[4].parse().context("parse sequence start frame")?;
            let frame_count: u64 = args[5].parse().context("parse sequence frame count")?;
            engine_render_sequence_command(
                Path::new(&args[2]),
                Path::new(&args[3]),
                start_frame,
                frame_count,
                Path::new(&args[6]),
                args.get(7).map(String::as_str).unwrap_or("gpu"),
            )
        }
        Some("engine-render-display-sequence") if (7..=8).contains(&args.len()) => {
            let start_frame: u64 = args[4].parse().context("parse sequence start frame")?;
            let frame_count: u64 = args[5].parse().context("parse sequence frame count")?;
            engine_render_display_sequence_command(
                Path::new(&args[2]),
                Path::new(&args[3]),
                start_frame,
                frame_count,
                Path::new(&args[6]),
                args.get(7).map(String::as_str).unwrap_or("gpu"),
            )
        }
        Some("benchmark") if (4..=5).contains(&args.len()) => {
            let frames: usize = args[3].parse().context("parse frames")?;
            benchmark_command(Path::new(&args[2]), frames, args.get(4).map(Path::new))
        }
        #[cfg(windows)]
        Some("decode-interop") if args.len() == 5 => {
            let frames: usize = args[3].parse().context("parse frames")?;
            if frames == 0 || frames > 120 {
                bail!("decode-interop frames must be 1..=120");
            }
            let compositor = GpuCompositor::new_dx12_video()?;
            windows_video::run(
                &compositor,
                Path::new(&args[2]),
                frames,
                Path::new(&args[4]),
            )
        }
        #[cfg(windows)]
        Some("software-runtime-probe") if args.len() == 4 => {
            let receipt = software_video::runtime_probe_receipt(Path::new(&args[2]), 5_000)?;
            write_software_receipt(&receipt, Path::new(&args[3]))
        }
        #[cfg(windows)]
        Some("software-decode") if args.len() == 7 => {
            let target_seconds = args[4].parse::<f64>().context("parse target seconds")?;
            let tolerance_seconds = args[5]
                .parse::<f64>()
                .context("parse tolerance seconds")?;
            let receipt = software_video::decode_to_receipt(
                Path::new(&args[2]),
                Path::new(&args[3]),
                target_seconds,
                tolerance_seconds,
                5_000,
            )?;
            write_software_receipt(&receipt, Path::new(&args[6]))
        }
        #[cfg(windows)]
        Some("software-decode-benchmark") if args.len() == 6 => {
            let iterations = args[4]
                .parse::<usize>()
                .context("parse software decode benchmark iterations")?;
            let receipt = software_video::benchmark_to_receipt(
                Path::new(&args[2]),
                Path::new(&args[3]),
                iterations,
            )?;
            write_software_receipt(&receipt, Path::new(&args[5]))
        }
        _ => bail!(usage()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_alpha_is_porter_duff_source_over() {
        let result = composite(
            [0.0, 0.0, 1.0, 1.0],
            [1.0, 0.0, 0.0, 0.5],
            1.0,
            BlendMode::Normal,
        );
        assert!((result[0] - 0.5).abs() < 0.001);
        assert!((result[2] - 0.5).abs() < 0.001);
        assert!((result[3] - 1.0).abs() < 0.001);
    }

    #[test]
    fn all_blend_modes_are_bounded() {
        for mode in [
            BlendMode::Normal,
            BlendMode::Add,
            BlendMode::Screen,
            BlendMode::Multiply,
            BlendMode::Overlay,
            BlendMode::SoftLight,
            BlendMode::HardLight,
            BlendMode::Difference,
            BlendMode::Darken,
            BlendMode::Lighten,
            BlendMode::ColorDodge,
            BlendMode::ColorBurn,
        ] {
            let result = composite([0.2, 0.4, 0.6, 1.0], [0.8, 0.5, 0.1, 0.9], 0.75, mode);
            assert!(result.iter().all(|value| (0.0..=1.0).contains(value)));
        }
    }

    #[test]
    fn inverse_transform_centers_identity() {
        assert_eq!(
            transformed_index(10, 12, 64, 64, Transform::default()),
            Some(12 * 64 + 10)
        );
    }

    #[test]
    fn monochrome_effect_preserves_alpha_and_applies_grade() {
        let result = apply_builtin_effect(
            normalize_source_alpha([255, 0, 0, 102], SourceAlphaMode::Straight),
            BuiltinEffect::monochrome(1, 1.18, 0.0),
        );
        assert!((result[0] - result[1]).abs() < 0.000001);
        assert!((result[1] - result[2]).abs() < 0.000001);
        assert!((result[3] - 0.4).abs() < 0.00001);
        assert!((result[0] - 41.0 / 255.0).abs() < 0.00001);
    }

    #[test]
    fn premultiplied_source_is_normalized_before_compositing() {
        let normalized = normalize_source_alpha([64, 32, 16, 128], SourceAlphaMode::Premultiplied);
        assert!((normalized[0] - 0.5).abs() < 0.005);
        assert!((normalized[1] - 0.25).abs() < 0.005);
        assert!((normalized[2] - 0.125).abs() < 0.005);
        assert!((normalized[3] - 128.0 / 255.0).abs() < 0.00001);
        assert_eq!(
            normalize_source_alpha([255, 120, 80, 0], SourceAlphaMode::Premultiplied),
            [0.0; 4]
        );
        assert_eq!(
            normalize_source_alpha([10, 20, 30, 0], SourceAlphaMode::Opaque)[3],
            1.0
        );
    }

    #[test]
    fn embedded_hdr_luts_are_hash_bound_and_pack_rgba16() {
        for (transform, lut) in [
            (
                engine_graph::EngineDisplayTransform::Aces2Rec2100Hlg1000,
                embedded_aces2_rec2100_hlg_1000_lut().unwrap(),
            ),
            (
                engine_graph::EngineDisplayTransform::Aces2Rec2100Pq1000,
                embedded_aces2_rec2100_pq_1000_lut().unwrap(),
            ),
        ] {
            assert_eq!(lut.size, ACES2_HDR_LUT_SIZE);
            assert_eq!(lut.values.len(), ACES2_HDR_LUT_SIZE.pow(3));
            let bytes = aces2_rec2100_hdr_bytes(&[0.18, 0.18, 0.18, 0.5], transform).unwrap();
            assert_eq!(bytes.len(), 8);
            let alpha = u16::from_le_bytes([bytes[6], bytes[7]]);
            assert_eq!(alpha, 32768);
            assert!(bytes[..6].chunks_exact(2).all(|channel| {
                let code = u16::from_le_bytes([channel[0], channel[1]]);
                code > 0 && code < u16::MAX
            }));
        }
    }
}

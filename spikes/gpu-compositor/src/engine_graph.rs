use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use hao_core::engine::compile_graph;
use hao_core::engine::composite::LinearRgba;
use hao_core::engine::model::{
    AlphaMode, BlendMode as EngineBlendMode, CameraKeyframe, DepthOfFieldKeyframe, EngineGraph,
    EngineNode, KeyframeEasing, LightKeyframe, LightKind, MatteMode, MotionBlurSourceSampling,
    MotionGraphicQuadPoint, MotionGraphicTrackingSample, MotionGraphicTrackingStatus,
    NodeFrameRange, NodeOperation, PixelFormat, PrimaryGrade, RationalTimebase,
    Transform2dKeyframe,
};
use hao_core::engine::scene::{
    CameraProjection, DirectionalLight, SceneLayer, ScenePlaneProjection, Vec3,
    project_2_5d_scene_planes,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    BlendMode, BuiltinEffect, Layer, LayerSource, PreparedGraph, RenderGraph, SourceAlphaMode,
    Transform, prepare_graph,
};

const COMMON_GRAPH_SCHEMA: &str = "editkin.engine-graph/v1";
const RESIDENT_VIDEO_RESOURCE_SCHEMA: &str = "editkin.resident-video-resource-plan/v1";
const RESIDENT_FRAME_RING_SLOTS: u64 = 3;
const RESIDENT_TEXTURES_PER_SLOT: u64 = 3;
const BGRA_BYTES_PER_PIXEL: u64 = 4;
const COMPOSITOR_PEAK_TEXTURES: u64 = 3;
const ADJUSTMENT_PING_PONG_TEXTURES: u64 = 2;
pub(crate) const RESIDENT_PARTICLE_SNAPSHOT_CAPACITY_PER_EMITTER: usize = 2;
const GPU_EFFECT_BINDINGS_SCHEMA: &str = "editkin.gpu-effect-bindings/v1";
const GPU_EFFECT_GRAPH_SCHEMA: &str = "editkin.gpu-effect-graph/v1";
const MAX_GPU_EFFECT_GRAPHS_PER_VISUAL: usize = 4;
const MAX_GPU_EFFECT_OPERATIONS_PER_VISUAL: usize = 16;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuEffectOperation {
    pub opcode: u32,
    pub args: [f32; 3],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuEffectBinding {
    pub schema: String,
    pub node_id: String,
    pub plugin_identity: String,
    pub parameters: BTreeMap<String, f64>,
    pub program_sha256: String,
    pub operations: Vec<GpuEffectOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuEffectBindings {
    pub schema: String,
    pub bindings: BTreeMap<String, GpuEffectBinding>,
}

impl Default for GpuEffectBindings {
    fn default() -> Self {
        Self {
            schema: GPU_EFFECT_BINDINGS_SCHEMA.to_owned(),
            bindings: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoShaderEffectPlan {
    pub node_id: String,
    pub plugin_identity: String,
    pub program_sha256: String,
    pub operations: Vec<GpuEffectOperation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineExecutionCoverage {
    pub graph_schema: &'static str,
    pub graph_id: String,
    pub direct_execution: bool,
    pub requested_working_format: String,
    pub execution_format: &'static str,
    pub artifact_format: &'static str,
    pub executed_node_ids: Vec<String>,
    pub blocked_node_ids: Vec<String>,
    pub ignored_node_ids: Vec<String>,
}

pub struct PreparedEngineGraph {
    pub prepared: PreparedGraph,
    pub coverage: EngineExecutionCoverage,
    pub timeline: EngineTimelinePlan,
    pub display_transform: EngineDisplayTransform,
    pub scene_25d: Option<EngineScene25dCoverage>,
    pub vfx_simulation: Option<EngineVfxSimulationCoverage>,
}

/// Receipt for the first deliberately bounded native simulation executor. This contract is a
/// deterministic screen-space particle layer, not a claim of mesh particles, fluid simulation,
/// collision, depth interaction, motion vectors, or a general simulation cache.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVfxSimulationCoverage {
    pub simulation_contract: &'static str,
    pub emitter_count: usize,
    pub particle_ceiling: u32,
    pub dimension: &'static str,
    pub seed_mode: &'static str,
    pub time_source: &'static str,
    pub executor: &'static str,
}

/// Receipt for the deliberately bounded native 2.5D executor. It is not a mesh renderer:
/// every visual is a whole textured plane projected by one camera. The receipt distinguishes
/// the compatibility average-order image route from the resident video's per-pixel depth route.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineScene25dCoverage {
    pub scene_contract: &'static str,
    pub plane_count: usize,
    pub video_plane_count: usize,
    pub parented_plane_count: usize,
    pub camera_node_id: String,
    pub ambient_light_count: usize,
    pub directional_light_count: usize,
    pub depth_mode: &'static str,
    pub depth_format: &'static str,
    pub depth_tested_plane_count: usize,
    pub depth_pass_count: usize,
    pub geometry_executor: &'static str,
    pub pixel_executor: &'static str,
    pub camera_animation_contract: &'static str,
    pub camera_keyframe_count: usize,
    pub sampled_timeline_frame: u64,
    pub camera_position: [f32; 3],
    pub camera_target: [f32; 3],
    pub camera_vertical_fov_radians: f32,
    pub light_animation_contract: &'static str,
    pub ambient_light_keyframe_count: usize,
    pub directional_light_keyframe_count: usize,
    pub sampled_light_timeline_frame: u64,
    pub ambient_light_color: [f32; 3],
    pub ambient_light_intensity: f32,
    pub directional_light_color: [f32; 3],
    pub directional_light_intensity: f32,
    pub directional_light_direction: [f32; 3],
}

pub struct EngineScene25dPlan {
    pub width: u32,
    pub height: u32,
    pub projections: BTreeMap<String, ScenePlaneProjection>,
    resource_node_ids: BTreeSet<String>,
    pub coverage: EngineScene25dCoverage,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineDisplayTransform {
    #[default]
    SceneLinearPreview,
    Aces2Rec709Sdr,
    Aces2Rec2100Hlg1000,
    Aces2Rec2100Pq1000,
}

impl EngineDisplayTransform {
    pub const fn processor(self) -> &'static str {
        match self {
            Self::SceneLinearPreview => "editkin-linear-preview-rec709-oetf/v1",
            Self::Aces2Rec709Sdr => "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1",
            Self::Aces2Rec2100Hlg1000 => "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1",
            Self::Aces2Rec2100Pq1000 => "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1",
        }
    }

    pub fn from_processor(processor: &str) -> Option<Self> {
        match processor {
            "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1" => Some(Self::Aces2Rec709Sdr),
            "editkin-ocio-aces2-linear-rec709-to-rec2100-hlg-1000/v1" => {
                Some(Self::Aces2Rec2100Hlg1000)
            }
            "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1" => {
                Some(Self::Aces2Rec2100Pq1000)
            }
            _ => None,
        }
    }

    pub const fn output_space(self) -> &'static str {
        match self {
            Self::SceneLinearPreview => "rec709_preview",
            Self::Aces2Rec709Sdr => "rec709_sdr",
            Self::Aces2Rec2100Hlg1000 => "rec2100_hlg_1000",
            Self::Aces2Rec2100Pq1000 => "rec2100_pq_1000",
        }
    }

    pub const fn is_aces2(self) -> bool {
        !matches!(self, Self::SceneLinearPreview)
    }
}

/// A deliberately closed common-graph subset whose source remains on the Windows decode GPU.
/// The platform executor is selected only after the shared graph compiler has validated every
/// node; no node may be silently bypassed by the specialized video path.
pub struct PreparedEngineVideoGraph {
    pub width: u32,
    pub height: u32,
    pub coverage: EngineExecutionCoverage,
    pub resource_plan: ResidentVideoResourcePlan,
    pub decode_schedule: ResidentVideoDecodeSchedule,
    /// Display transform executed exactly once after the resident scene-linear composite.
    /// `SceneLinearPreview` is the legacy display-referred path; ACES variants require the
    /// explicit encoded-video input transform admitted by `prepare_video_branch`.
    pub display_transform: EngineDisplayTransform,
    /// Present only when resident decoded video textures are projected by the native 2.5D
    /// camera/light graph before entering the shared compositor.
    pub scene_25d: Option<EngineScene25dCoverage>,
    /// Global camera-lens post process. The native video executor admits it only when a real
    /// Depth32Float 2.5D scene owns the first input and the scene camera owns the second.
    pub depth_of_field: Option<EngineVideoDepthOfFieldPlan>,
    pub layers: Vec<PreparedEngineVideoLayer>,
    /// Non-rendering transform-only layers. Controllers are sampled by the same rational
    /// timeline as video layers but own no decoder, texture or pixel buffer.
    pub controllers: Vec<EngineVideoControllerPlan>,
    pub adjustments: Vec<EngineVideoAdjustmentPlan>,
    /// True only for the bounded graph order video -> adjustment -> caption/motion graphic.
    /// The surface executor uses this to keep typography outside the grade pass.
    pub adjustment_before_typography: bool,
    pub particles: Vec<EngineVideoParticlePlan>,
    pub captions: Vec<EngineVideoCaptionPlan>,
    pub motion_graphics: Vec<EngineVideoMotionGraphicPlan>,
    pub vfx_simulation: Option<EngineVfxSimulationCoverage>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoDepthOfFieldPlan {
    pub contract: &'static str,
    pub node_id: String,
    pub focus_distance: f32,
    pub aperture: f32,
    pub max_blur_radius: f32,
    pub near: f32,
    pub far: f32,
    pub execution_mode: &'static str,
    pub depth_source: &'static str,
    pub executor: &'static str,
    pub pass_count: u32,
    pub animation_contract: &'static str,
    pub keyframe_count: usize,
    pub sampled_timeline_frame: u64,
    #[serde(skip)]
    pub keyframes: Vec<DepthOfFieldKeyframe>,
}

impl EngineVideoDepthOfFieldPlan {
    pub fn sample(&self, timeline_frame: u64) -> Self {
        let first_after_or_at = self
            .keyframes
            .iter()
            .position(|keyframe| keyframe.frame >= timeline_frame);
        let values = match first_after_or_at {
            None if !self.keyframes.is_empty() => {
                lens_keyframe_values(*self.keyframes.last().expect("non-empty"))
            }
            None => (self.focus_distance, self.aperture, self.max_blur_radius),
            Some(0) => {
                let next = self.keyframes[0];
                interpolate_lens(
                    (self.focus_distance, self.aperture, self.max_blur_radius),
                    lens_keyframe_values(next),
                    timeline_frame as f32 / next.frame as f32,
                )
            }
            Some(index) => {
                let previous = self.keyframes[index - 1];
                let next = self.keyframes[index];
                if timeline_frame == next.frame {
                    lens_keyframe_values(next)
                } else if matches!(previous.easing, KeyframeEasing::Hold) {
                    lens_keyframe_values(previous)
                } else {
                    let ratio = (timeline_frame - previous.frame) as f32
                        / (next.frame - previous.frame) as f32;
                    interpolate_lens(
                        lens_keyframe_values(previous),
                        lens_keyframe_values(next),
                        easing_progress(ratio, previous.easing),
                    )
                }
            }
        };
        Self {
            focus_distance: values.0,
            aperture: values.1,
            max_blur_radius: values.2,
            sampled_timeline_frame: timeline_frame,
            ..self.clone()
        }
    }
}

fn lens_keyframe_values(keyframe: DepthOfFieldKeyframe) -> (f32, f32, f32) {
    (
        keyframe.focus_distance,
        keyframe.aperture,
        keyframe.max_blur_radius,
    )
}

fn interpolate_lens(
    previous: (f32, f32, f32),
    next: (f32, f32, f32),
    ratio: f32,
) -> (f32, f32, f32) {
    let amount = ratio.clamp(0.0, 1.0);
    let mix = |left: f32, right: f32| left + (right - left) * amount;
    (
        mix(previous.0, next.0),
        mix(previous.1, next.1),
        mix(previous.2, next.2),
    )
}

/// Closed resource accounting for the resident decoded-video path. The plan counts only
/// product-owned GPU allocations whose lifetime is controlled here: three BGRA resources per
/// frame-ring slot (shared, wgpu staging and D3D11 processor target), the ping/pong plus isolated
/// verification target peak, and each resident RGBA overlay texture. Decoder/driver-private
/// surfaces remain outside `cacheBudgetMb` and are reported separately by the platform runtime.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentVideoResourcePlan {
    pub schema: &'static str,
    pub width: u32,
    pub height: u32,
    pub pixel_count: u64,
    pub video_layer_count: usize,
    pub overlay_count: usize,
    pub particle_count: usize,
    pub particle_snapshot_capacity_per_emitter: usize,
    pub adjustment_count: usize,
    pub matte_count: usize,
    pub bytes_per_video_layer: u64,
    pub working_bytes_per_pixel: u64,
    pub temporal_sample_count: u32,
    pub temporal_resident_ring_slots: u64,
    pub temporal_resident_bytes: u64,
    pub compositor_working_bytes: u64,
    pub overlay_bytes: u64,
    pub particle_snapshot_bytes: u64,
    pub adjustment_working_bytes: u64,
    pub scene_depth_attachment_count: u32,
    pub scene_depth_bytes: u64,
    pub depth_of_field_pass_count: u32,
    pub depth_of_field_additional_working_bytes: u64,
    pub maximum_full_frame_passes_per_present: usize,
    pub required_bytes: u64,
    pub budget_bytes: u64,
    pub max_video_layers: u64,
    pub remaining_bytes: u64,
}

fn resident_video_resource_plan(
    width: u32,
    height: u32,
    cache_budget_mb: u64,
    video_layer_count: usize,
    overlay_count: usize,
    particle_count: usize,
    adjustment_count: usize,
    matte_count: usize,
    temporal_sample_count: u32,
    working_bytes_per_pixel: u64,
    scene_depth_attachment_count: u32,
    depth_of_field_pass_count: u32,
) -> Result<ResidentVideoResourcePlan> {
    if scene_depth_attachment_count > 1
        || depth_of_field_pass_count > 1
        || (depth_of_field_pass_count == 1 && scene_depth_attachment_count != 1)
    {
        bail!("common video scene depth/lens resource request exceeds the bounded contract");
    }
    let pixel_count = u64::from(width)
        .checked_mul(u64::from(height))
        .context("common video resource pixel count overflow")?;
    let bytes_per_video_layer = pixel_count
        .checked_mul(RESIDENT_FRAME_RING_SLOTS)
        .and_then(|bytes| bytes.checked_mul(RESIDENT_TEXTURES_PER_SLOT))
        .and_then(|bytes| bytes.checked_mul(BGRA_BYTES_PER_PIXEL))
        .context("common video per-layer resource size overflow")?;
    let temporal_resident_ring_slots =
        u64::from(temporal_sample_count).saturating_sub(RESIDENT_FRAME_RING_SLOTS);
    let temporal_resident_bytes = pixel_count
        .checked_mul(temporal_resident_ring_slots)
        .and_then(|bytes| bytes.checked_mul(RESIDENT_TEXTURES_PER_SLOT))
        .and_then(|bytes| bytes.checked_mul(BGRA_BYTES_PER_PIXEL))
        .context("common video temporal resident resource size overflow")?;
    let compositor_working_bytes = pixel_count
        .checked_mul(COMPOSITOR_PEAK_TEXTURES)
        .and_then(|bytes| bytes.checked_mul(working_bytes_per_pixel))
        .context("common video compositor resource size overflow")?;
    let overlay_bytes = pixel_count
        .checked_mul(BGRA_BYTES_PER_PIXEL)
        .and_then(|bytes| bytes.checked_mul(overlay_count as u64))
        .context("common video overlay resource size overflow")?;
    let particle_snapshot_bytes = pixel_count
        .checked_mul(BGRA_BYTES_PER_PIXEL)
        .and_then(|bytes| bytes.checked_mul(particle_count as u64))
        .and_then(|bytes| bytes.checked_mul(RESIDENT_PARTICLE_SNAPSHOT_CAPACITY_PER_EMITTER as u64))
        .context("common video particle snapshot resource size overflow")?;
    let adjustment_working_bytes = if adjustment_count == 0 {
        0
    } else {
        pixel_count
            .checked_mul(ADJUSTMENT_PING_PONG_TEXTURES)
            .and_then(|bytes| bytes.checked_mul(working_bytes_per_pixel))
            .context("common video adjustment working resource size overflow")?
    };
    let scene_depth_bytes = pixel_count
        .checked_mul(u64::from(scene_depth_attachment_count))
        .and_then(|bytes| bytes.checked_mul(BGRA_BYTES_PER_PIXEL))
        .context("common video scene depth resource size overflow")?;
    let depth_of_field_additional_working_bytes = 0;
    let maximum_full_frame_passes_per_present = if scene_depth_attachment_count == 1 {
        2 + depth_of_field_pass_count as usize
    } else {
        video_layer_count + overlay_count + adjustment_count + 1
    };
    let required_bytes = bytes_per_video_layer
        .checked_mul(video_layer_count as u64)
        .and_then(|bytes| bytes.checked_add(temporal_resident_bytes))
        .and_then(|bytes| bytes.checked_add(compositor_working_bytes))
        .and_then(|bytes| bytes.checked_add(overlay_bytes))
        .and_then(|bytes| bytes.checked_add(particle_snapshot_bytes))
        .and_then(|bytes| bytes.checked_add(adjustment_working_bytes))
        .and_then(|bytes| bytes.checked_add(scene_depth_bytes))
        .context("common video total resource size overflow")?;
    let budget_bytes = cache_budget_mb
        .checked_mul(1024 * 1024)
        .context("common video cache budget byte size overflow")?;
    let fixed_bytes = compositor_working_bytes
        .checked_add(temporal_resident_bytes)
        .and_then(|bytes| bytes.checked_add(overlay_bytes))
        .and_then(|bytes| bytes.checked_add(particle_snapshot_bytes))
        .and_then(|bytes| bytes.checked_add(adjustment_working_bytes))
        .and_then(|bytes| bytes.checked_add(scene_depth_bytes))
        .context("common video fixed resource size overflow")?;
    let max_video_layers = budget_bytes
        .saturating_sub(fixed_bytes)
        .checked_div(bytes_per_video_layer)
        .unwrap_or(0);
    if video_layer_count == 0 {
        bail!("common video graph requires at least one resident video layer");
    }
    if required_bytes > budget_bytes {
        bail!(
            "common video resource budget is insufficient: layers={}, requiredBytes={}, budgetBytes={}, maxVideoLayers={}",
            video_layer_count,
            required_bytes,
            budget_bytes,
            max_video_layers
        );
    }
    Ok(ResidentVideoResourcePlan {
        schema: RESIDENT_VIDEO_RESOURCE_SCHEMA,
        width,
        height,
        pixel_count,
        video_layer_count,
        overlay_count,
        particle_count,
        particle_snapshot_capacity_per_emitter: RESIDENT_PARTICLE_SNAPSHOT_CAPACITY_PER_EMITTER,
        adjustment_count,
        matte_count,
        bytes_per_video_layer,
        working_bytes_per_pixel,
        temporal_sample_count,
        temporal_resident_ring_slots,
        temporal_resident_bytes,
        compositor_working_bytes,
        overlay_bytes,
        particle_snapshot_bytes,
        adjustment_working_bytes,
        scene_depth_attachment_count,
        scene_depth_bytes,
        depth_of_field_pass_count,
        depth_of_field_additional_working_bytes,
        maximum_full_frame_passes_per_present,
        required_bytes,
        budget_bytes,
        max_video_layers,
        remaining_bytes: budget_bytes - required_bytes,
    })
}

pub struct PreparedEngineVideoLayer {
    pub source_node_id: String,
    pub asset_id: String,
    pub input_path: PathBuf,
    pub timeline: EngineVideoTimelinePlan,
    pub visual: EngineVideoVisualPlan,
    /// Resolved source boundary contract. Resident working textures are straight-alpha.
    pub alpha_mode: AlphaMode,
    /// The transform node owned by this visible video branch. A direct source has no transform
    /// and therefore cannot be used as a parent until the graph gives it an explicit identity.
    pub transform_node_id: Option<String>,
    /// Typed graph reference captured from `Transform2d.parent` before it is resolved to the
    /// resident layer table.
    pub parent_transform_node_id: Option<String>,
    /// Index of the visible resident layer whose sampled transform is composed before this
    /// layer's local transform. Parenting never creates another decoder or texture.
    pub parent_layer_index: Option<usize>,
    /// Index into the transform-only controller table when the parent does not render pixels.
    pub parent_controller_index: Option<usize>,
    /// Closed maximum parent-chain depth, where a direct child has depth one.
    pub parent_depth: u32,
    pub blend_mode: BlendMode,
    pub composite_opacity: f32,
    /// Index of an already resident decoded layer sampled as this layer's track matte.
    /// The matte remains a normal visible layer because that is the editor's current typed
    /// graph contract; this field adds the target-layer alpha operation without duplicating
    /// a decoder or allocating a CPU-side matte.
    pub matte_layer_index: Option<usize>,
    pub matte_mode: Option<MatteMode>,
    pub precomposition_node_ids: Vec<String>,
    pub nested_graph_ids: Vec<String>,
    pub decode_cadence_divisor: u32,
    pub decode_cadence_phase: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoControllerPlan {
    pub source_node_id: String,
    pub transform_node_id: String,
    pub timeline: EngineVideoTimelinePlan,
    pub visual: EngineVideoVisualPlan,
    pub parent_transform_node_id: Option<String>,
    pub parent_layer_index: Option<usize>,
    pub parent_controller_index: Option<usize>,
    pub parent_depth: u32,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum EngineVideoParentTarget {
    Layer(usize),
    Controller(usize),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoAdjustmentPlan {
    pub node_ids: Vec<String>,
    pub timeline: NodeFrameRange,
    pub visual: EngineVideoVisualPlan,
}

impl EngineVideoAdjustmentPlan {
    pub fn active(&self, timeline_frame: u64) -> bool {
        frame_active(Some(&self.timeline), timeline_frame)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentVideoDecodeSchedule {
    pub schema: &'static str,
    pub full_rate_layer_count: usize,
    pub adaptive_layer_count: usize,
    pub maximum_decode_cadence_divisor: u32,
    pub maximum_reuse_age_frames: u32,
}

struct CollectedVideoBranch {
    tail: String,
    blend_mode: BlendMode,
    opacity: f32,
    matte_tail: Option<String>,
    matte_mode: Option<MatteMode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoCaptionPlan {
    pub node_id: String,
    pub cue_id: String,
    pub text: String,
    pub timeline: NodeFrameRange,
    pub font_family: String,
    pub font_size: f32,
    pub text_color: String,
    pub outline_color: String,
    pub outline_width: f32,
    pub background_color: String,
    pub alignment: u8,
    pub margin_vertical: f32,
    pub bold: bool,
    pub shadow: f32,
    pub letter_spacing: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoParticlePlan {
    pub node_id: String,
    pub timeline: Option<NodeFrameRange>,
    pub seed: u32,
    pub rate_per_second: f32,
    pub lifetime_seconds: f32,
    pub initial_velocity: [f32; 2],
    pub gravity: [f32; 2],
    pub max_particles: u32,
    pub emitter_position: [f32; 2],
    pub radius_pixels: f32,
    pub color: [f32; 4],
    pub timebase_numerator: u32,
    pub timebase_denominator: u32,
}

impl EngineVideoParticlePlan {
    pub fn active(&self, timeline_frame: u64) -> bool {
        frame_active(self.timeline.as_ref(), timeline_frame)
    }

    pub fn local_frame(&self, timeline_frame: u64) -> Option<u64> {
        self.active(timeline_frame).then(|| {
            timeline_frame.saturating_sub(
                self.timeline
                    .as_ref()
                    .map_or(0, |range| range.timeline_start_frame),
            )
        })
    }

    pub fn time_seconds(&self, timeline_frame: u64) -> f32 {
        self.local_frame(timeline_frame).unwrap_or(0) as f32 * self.timebase_numerator as f32
            / self.timebase_denominator as f32
    }
}

impl EngineVideoCaptionPlan {
    pub fn active(&self, timeline_frame: u64) -> bool {
        frame_active(Some(&self.timeline), timeline_frame)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoMotionGraphicPlan {
    pub node_id: String,
    pub graphic_id: String,
    pub graphic_kind: String,
    pub text: String,
    pub timeline: NodeFrameRange,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub font_size: f32,
    pub font_family: String,
    pub font_weight: u16,
    pub letter_spacing: f32,
    pub outline_width: f32,
    pub shadow_depth: f32,
    pub corner_radius: f32,
    pub text_color: String,
    pub background_color: String,
    pub accent_color: String,
    pub visual_style: String,
    pub animation: String,
    pub tracking_mode: String,
    pub fade_in_frames: u64,
    pub fade_out_frames: u64,
    pub track_id: Option<String>,
    pub tracking_samples: Vec<MotionGraphicTrackingSample>,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoMotionGraphicSample {
    pub opacity: f32,
    pub translate_x: f32,
    pub translate_y: f32,
    pub scale: f32,
    pub rotation_radians: f32,
    pub tracking_x: Option<f32>,
    pub tracking_y: Option<f32>,
    pub tracking_confidence: Option<f32>,
    pub tracking_status: Option<MotionGraphicTrackingStatus>,
    pub tracking_rotation_radians: Option<f32>,
    pub tracking_scale: Option<f32>,
    pub destination_quad: Option<[MotionGraphicQuadPoint; 4]>,
}

impl EngineVideoMotionGraphicPlan {
    fn tracking_sample(&self, timeline_frame: u64) -> Option<MotionGraphicTrackingSample> {
        if self.track_id.is_none() {
            return Some(MotionGraphicTrackingSample {
                timeline_frame,
                x: self.x,
                y: self.y,
                confidence: 1.0,
                status: MotionGraphicTrackingStatus::Manual,
                rotation_radians: 0.0,
                scale: 1.0,
                destination_quad: None,
            });
        }
        let samples = &self.tracking_samples;
        let next_index = samples.partition_point(|sample| sample.timeline_frame < timeline_frame);
        if next_index < samples.len() && samples[next_index].timeline_frame == timeline_frame {
            let sample = samples[next_index];
            return (sample.status != MotionGraphicTrackingStatus::Lost).then_some(sample);
        }
        if next_index == 0 {
            let sample = *samples.first()?;
            return (sample.status != MotionGraphicTrackingStatus::Lost).then_some(sample);
        }
        let previous = samples[next_index - 1];
        if previous.status == MotionGraphicTrackingStatus::Lost {
            return None;
        }
        let Some(next) = samples.get(next_index).copied() else {
            return Some(previous);
        };
        if next.status == MotionGraphicTrackingStatus::Lost {
            return Some(MotionGraphicTrackingSample {
                timeline_frame,
                status: MotionGraphicTrackingStatus::Held,
                ..previous
            });
        }
        let span = next
            .timeline_frame
            .saturating_sub(previous.timeline_frame)
            .max(1) as f32;
        let ratio = timeline_frame.saturating_sub(previous.timeline_frame) as f32 / span;
        let status = if previous.status == MotionGraphicTrackingStatus::Held
            || next.status == MotionGraphicTrackingStatus::Held
        {
            MotionGraphicTrackingStatus::Held
        } else if previous.status == MotionGraphicTrackingStatus::Manual
            && next.status == MotionGraphicTrackingStatus::Manual
        {
            MotionGraphicTrackingStatus::Manual
        } else {
            MotionGraphicTrackingStatus::Tracked
        };
        Some(MotionGraphicTrackingSample {
            timeline_frame,
            x: previous.x + (next.x - previous.x) * ratio,
            y: previous.y + (next.y - previous.y) * ratio,
            confidence: previous.confidence + (next.confidence - previous.confidence) * ratio,
            status,
            rotation_radians: previous.rotation_radians
                + (next.rotation_radians - previous.rotation_radians) * ratio,
            scale: previous.scale + (next.scale - previous.scale) * ratio,
            destination_quad: match (previous.destination_quad, next.destination_quad) {
                (Some(previous_quad), Some(next_quad)) => {
                    Some(std::array::from_fn(|index| MotionGraphicQuadPoint {
                        x: previous_quad[index].x
                            + (next_quad[index].x - previous_quad[index].x) * ratio,
                        y: previous_quad[index].y
                            + (next_quad[index].y - previous_quad[index].y) * ratio,
                    }))
                }
                (quad, _) => quad,
            },
        })
    }

    pub fn sample(&self, timeline_frame: u64) -> Option<EngineVideoMotionGraphicSample> {
        if !frame_active(Some(&self.timeline), timeline_frame) {
            return None;
        }
        let tracking = self.tracking_sample(timeline_frame)?;
        let local = timeline_frame.saturating_sub(self.timeline.timeline_start_frame);
        let remaining = self.timeline.duration_frames.saturating_sub(local);
        let fade_in = if self.fade_in_frames == 0 {
            1.0
        } else {
            local as f32 / self.fade_in_frames as f32
        };
        let fade_out = if self.fade_out_frames == 0 {
            1.0
        } else {
            remaining as f32 / self.fade_out_frames as f32
        };
        let opacity = fade_in.min(fade_out).clamp(0.0, 1.0);
        let entry = fade_in.clamp(0.0, 1.0);
        let exit = fade_out.clamp(0.0, 1.0);
        let exit_scale = if exit >= 1.0 { 1.0 } else { 0.94 + 0.06 * exit };
        let (translate_y, scale) = match self.animation.as_str() {
            "slide_up" => {
                let eased_entry = 1.0 - (1.0 - entry).powi(3);
                ((1.0 - eased_entry) * 48.0 - (1.0 - exit) * 24.0, 1.0)
            }
            "pop" => {
                let eased_entry = 1.0 - (1.0 - entry).powi(3);
                (0.0, (0.7 + 0.3 * eased_entry) * exit_scale)
            }
            "spring_soft" => {
                let spring_scale = if entry >= 1.0 {
                    1.0
                } else if entry <= 0.6 {
                    let phase = entry / 0.6;
                    0.82 + 0.24 * (1.0 - (1.0 - phase).powi(3))
                } else {
                    let phase = (entry - 0.6) / 0.4;
                    1.06 - 0.06 * (1.0 - (1.0 - phase).powi(3))
                };
                (0.0, spring_scale * exit_scale)
            }
            _ => (0.0, 1.0),
        };
        Some(EngineVideoMotionGraphicSample {
            opacity,
            translate_x: (tracking.x - self.x) * self.canvas_width as f32,
            translate_y: (tracking.y - self.y) * self.canvas_height as f32 + translate_y,
            scale: scale * tracking.scale,
            rotation_radians: tracking.rotation_radians,
            tracking_x: self.track_id.as_ref().map(|_| tracking.x),
            tracking_y: self.track_id.as_ref().map(|_| tracking.y),
            tracking_confidence: self.track_id.as_ref().map(|_| tracking.confidence),
            tracking_status: self.track_id.as_ref().map(|_| tracking.status),
            tracking_rotation_radians: self.track_id.as_ref().map(|_| tracking.rotation_radians),
            tracking_scale: self.track_id.as_ref().map(|_| tracking.scale),
            destination_quad: tracking.destination_quad,
        })
    }

    pub fn pivot_pixels(&self) -> (f32, f32) {
        let box_height = (self.font_size * 1.25).ceil() + (self.font_size * 0.36).ceil() * 2.0;
        (
            (self.x + self.width * 0.5) * self.canvas_width as f32 - self.canvas_width as f32 * 0.5,
            self.y * self.canvas_height as f32 + box_height * 0.5 - self.canvas_height as f32 * 0.5,
        )
    }

    pub fn sampled_opacity(&self, timeline_frame: u64) -> Option<f32> {
        self.sample(timeline_frame).map(|sample| sample.opacity)
    }

    pub fn projective_transform(
        &self,
        sample: &EngineVideoMotionGraphicSample,
    ) -> Result<Option<[f32; 8]>> {
        let Some(destination_quad) = sample.destination_quad else {
            return Ok(None);
        };
        let canvas_width = self.canvas_width as f64;
        let canvas_height = self.canvas_height as f64;
        let box_height = (self.font_size * 1.25).ceil() + (self.font_size * 0.36).ceil() * 2.0;
        let source_left = self.x as f64 * canvas_width - canvas_width * 0.5;
        let source_top = self.y as f64 * canvas_height - canvas_height * 0.5;
        let source_right = source_left + self.width as f64 * canvas_width;
        let source_bottom = source_top + box_height as f64;
        let source = [
            (source_left, source_top),
            (source_right, source_top),
            (source_right, source_bottom),
            (source_left, source_bottom),
        ];
        let destination = destination_quad.map(|point| {
            (
                point.x as f64 * canvas_width - canvas_width * 0.5,
                point.y as f64 * canvas_height - canvas_height * 0.5,
            )
        });
        solve_destination_to_source_homography(destination, source)
            .map(Some)
            .context("surface motion graphic has a singular projective transform")
    }
}

fn solve_destination_to_source_homography(
    destination: [(f64, f64); 4],
    source: [(f64, f64); 4],
) -> Result<[f32; 8]> {
    let mut system = [[0.0_f64; 9]; 8];
    for index in 0..4 {
        let (x, y) = destination[index];
        let (u, v) = source[index];
        system[index * 2] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        system[index * 2 + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for column in 0..8 {
        let pivot_row = (column..8)
            .max_by(|left, right| {
                system[*left][column]
                    .abs()
                    .total_cmp(&system[*right][column].abs())
            })
            .unwrap_or(column);
        if system[pivot_row][column].abs() < 1.0e-9 {
            bail!("projective transform is singular");
        }
        if pivot_row != column {
            system.swap(pivot_row, column);
        }
        let pivot = system[column][column];
        for value in column..=8 {
            system[column][value] /= pivot;
        }
        for row in 0..8 {
            if row == column {
                continue;
            }
            let factor = system[row][column];
            for value in column..=8 {
                system[row][value] -= factor * system[column][value];
            }
        }
    }
    let result = std::array::from_fn(|index| system[index][8] as f32);
    if result.iter().any(|value| !value.is_finite()) {
        bail!("projective transform is non-finite");
    }
    Ok(result)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoVisualPlan {
    /// 0 = existing linear working buffer, 1 = legacy sRGB input, 2 = explicit Rec709 v2 input.
    pub input_transfer: u32,
    /// Keep the requested processor version even when its physical gains are all zero.
    pub primary_processor_version: u32,
    pub translate_x: f32,
    pub translate_y: f32,
    pub scale: f32,
    pub rotation: f32,
    pub opacity: f32,
    /// Destination-pixel to source-pixel homography produced by the native 2.5D camera oracle.
    pub projective: [f32; 8],
    pub projective_enabled: bool,
    /// Linear-light modulation from the bounded ambient + directional light contract.
    pub shade: [f32; 3],
    #[serde(skip)]
    pub scene_depth: Option<f32>,
    /// D3D/WGPU depth evaluated from normalized top-left screen coordinates.
    #[serde(skip)]
    pub scene_depth_plane: Option<[f32; 3]>,
    pub effect_kind: u32,
    /// Authored source-to-output order. Each identity remains separate for receipts while the
    /// bounded operations are flattened into one resident shader uniform at presentation time.
    pub shader_effects: Vec<EngineVideoShaderEffectPlan>,
    #[serde(flatten)]
    pub grade: PrimaryGrade,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion_blur: Option<EngineVideoMotionBlurPlan>,
    #[serde(skip)]
    pub keyframes: Vec<Transform2dKeyframe>,
}

/// Bounded shutter accumulation. Compatibility graphs may reuse the current decoded frame;
/// decoded-temporal graphs retain 2..=8 source-time textures and sample one per shutter transform.
/// This is not optical-flow, deformation, motion-vector, camera, or object segmentation blur.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoMotionBlurPlan {
    pub contract: &'static str,
    pub node_id: String,
    pub shutter_angle: f32,
    pub sample_count: u32,
    pub source_sampling: MotionBlurSourceSampling,
    pub sample_frames: Vec<f32>,
    pub sample_transforms: Vec<[f32; 4]>,
}

impl Default for EngineVideoVisualPlan {
    fn default() -> Self {
        Self {
            input_transfer: 0,
            primary_processor_version: 1,
            translate_x: 0.0,
            translate_y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            projective: [0.0; 8],
            projective_enabled: false,
            shade: [1.0; 3],
            scene_depth: None,
            scene_depth_plane: None,
            effect_kind: 0,
            shader_effects: Vec::new(),
            grade: PrimaryGrade::default(),
            motion_blur: None,
            keyframes: Vec::new(),
        }
    }
}

impl EngineVideoVisualPlan {
    pub fn apply_scene_projection(
        &mut self,
        projection: &ScenePlaneProjection,
        width: u32,
        height: u32,
    ) -> Result<()> {
        let center_x = (width - 1) as f32 * 0.5;
        let center_y = (height - 1) as f32 * 0.5;
        let destination = projection.screen_corners.map(|point| {
            (
                f64::from(point[0] - center_x),
                f64::from(point[1] - center_y),
            )
        });
        let source = [
            (-f64::from(center_x), f64::from(center_y)),
            (f64::from(center_x), f64::from(center_y)),
            (f64::from(center_x), -f64::from(center_y)),
            (-f64::from(center_x), -f64::from(center_y)),
        ];
        self.projective = solve_destination_to_source_homography(destination, source)
            .context("project sampled resident-video 2.5D plane")?;
        self.projective_enabled = true;
        self.shade = projection.shade;
        self.scene_depth = Some(projection.average_depth);
        self.scene_depth_plane = Some(projection.depth_plane);
        Ok(())
    }

    pub fn sample(&self, local_frame: u64) -> Self {
        self.sample_continuous(local_frame as f64)
    }

    pub fn sample_continuous(&self, local_frame: f64) -> Self {
        if self.keyframes.is_empty() {
            return self.clone();
        }
        let local_frame = local_frame.max(0.0);
        let first_after_or_at = self
            .keyframes
            .iter()
            .position(|keyframe| keyframe.frame as f64 >= local_frame);
        let (x, y, scale, rotation, opacity) = match first_after_or_at {
            None => transform_keyframe_values(*self.keyframes.last().expect("non-empty")),
            Some(0) => {
                let next = self.keyframes[0];
                if local_frame == next.frame as f64 {
                    let (x, y, scale, rotation, opacity) = transform_keyframe_values(next);
                    return Self {
                        translate_x: x,
                        translate_y: y,
                        scale,
                        rotation,
                        opacity,
                        ..self.clone()
                    };
                }
                let progress = (local_frame / next.frame as f64) as f32;
                interpolate_transform(
                    (
                        self.translate_x,
                        self.translate_y,
                        self.scale,
                        self.rotation,
                        self.opacity,
                    ),
                    transform_keyframe_values(next),
                    progress,
                )
            }
            Some(index) => {
                let previous = self.keyframes[index - 1];
                let next = self.keyframes[index];
                if local_frame == next.frame as f64 {
                    transform_keyframe_values(next)
                } else if matches!(previous.easing, KeyframeEasing::Hold) {
                    transform_keyframe_values(previous)
                } else {
                    let ratio = ((local_frame - previous.frame as f64)
                        / (next.frame - previous.frame) as f64)
                        as f32;
                    interpolate_transform(
                        transform_keyframe_values(previous),
                        transform_keyframe_values(next),
                        easing_progress(ratio, previous.easing),
                    )
                }
            }
        };
        Self {
            translate_x: x,
            input_transfer: self.input_transfer,
            primary_processor_version: self.primary_processor_version,
            translate_y: y,
            scale,
            rotation,
            opacity,
            projective: self.projective,
            projective_enabled: self.projective_enabled,
            shade: self.shade,
            scene_depth: self.scene_depth,
            scene_depth_plane: self.scene_depth_plane,
            effect_kind: self.effect_kind,
            shader_effects: self.shader_effects.clone(),
            grade: self.grade,
            motion_blur: self.motion_blur.clone(),
            keyframes: Vec::new(),
        }
    }
}

impl EngineVideoMotionBlurPlan {
    pub fn sample_timeline_frames(
        &self,
        timeline: &EngineVideoTimelinePlan,
        timeline_frame: u64,
    ) -> Vec<f64> {
        let interval_frames = f64::from(self.shutter_angle) / 360.0;
        let minimum = timeline.range.timeline_start_frame as f64;
        let maximum = timeline
            .range
            .timeline_start_frame
            .saturating_add(timeline.range.duration_frames.saturating_sub(1))
            as f64;
        (0..self.sample_count)
            .map(|index| {
                let centered = (f64::from(index) + 0.5) / f64::from(self.sample_count) - 0.5;
                (timeline_frame as f64 + interval_frames * centered).clamp(minimum, maximum)
            })
            .collect()
    }

    pub fn sample_source_times_seconds(
        &self,
        timeline: &EngineVideoTimelinePlan,
        timeline_frame: u64,
    ) -> Vec<f64> {
        self.sample_timeline_frames(timeline, timeline_frame)
            .into_iter()
            .map(|frame| timeline.source_time_seconds_continuous(frame))
            .collect()
    }
}

fn transform_keyframe_values(keyframe: Transform2dKeyframe) -> (f32, f32, f32, f32, f32) {
    (
        keyframe.x,
        keyframe.y,
        keyframe.scale_x,
        keyframe.rotation_radians,
        keyframe.opacity,
    )
}

fn interpolate_transform(
    previous: (f32, f32, f32, f32, f32),
    next: (f32, f32, f32, f32, f32),
    ratio: f32,
) -> (f32, f32, f32, f32, f32) {
    let mix = |left: f32, right: f32| left + (right - left) * ratio;
    (
        mix(previous.0, next.0),
        mix(previous.1, next.1),
        mix(previous.2, next.2),
        mix(previous.3, next.3),
        mix(previous.4, next.4),
    )
}

fn easing_progress(ratio: f32, easing: KeyframeEasing) -> f32 {
    let value = ratio.clamp(0.0, 1.0);
    match easing {
        KeyframeEasing::Linear => value,
        KeyframeEasing::Hold => 0.0,
        KeyframeEasing::EaseIn => value * value,
        KeyframeEasing::EaseOut => 1.0 - (1.0 - value) * (1.0 - value),
        KeyframeEasing::EaseInOut => {
            if value < 0.5 {
                2.0 * value * value
            } else {
                1.0 - (-2.0 * value + 2.0).powi(2) / 2.0
            }
        }
        KeyframeEasing::SpringSoft => {
            (1.0 - (-6.0 * value).exp() * (8.0 * value).cos()).clamp(0.0, 1.08)
        }
    }
}

fn validate_common_video_grade(grade: PrimaryGrade) -> Result<()> {
    if grade.values().iter().any(|value| !value.is_finite()) {
        bail!("common video grade bounds require finite values");
    }
    if grade.hue.abs() > 0.000001 {
        bail!("common video grade hue is not supported by the Rec.709 primary shader");
    }
    if !(-1.0..=1.0).contains(&grade.brightness)
        || !(0.1..=3.0).contains(&grade.contrast)
        || !(0.0..=3.0).contains(&grade.saturation)
        || !(-3.0..=3.0).contains(&grade.exposure)
        || !(-1.0..=1.0).contains(&grade.temperature)
        || !(-1.0..=1.0).contains(&grade.tint)
        || !(0.1..=0.9).contains(&grade.pivot)
        || !(-1.0..=1.0).contains(&grade.shadows)
        || !(-1.0..=1.0).contains(&grade.highlights)
        || !(-1.0..=1.0).contains(&grade.blacks)
        || !(-1.0..=1.0).contains(&grade.whites)
    {
        bail!("common video grade bounds are invalid");
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoTimelinePlan {
    range: NodeFrameRange,
    timebase_numerator: u32,
    timebase_denominator: u32,
}

impl EngineVideoTimelinePlan {
    pub fn project_frame_rate(&self) -> f64 {
        f64::from(self.timebase_denominator) / f64::from(self.timebase_numerator.max(1))
    }

    pub fn decoder_clock_offset_frames(&self) -> i128 {
        i128::from(self.range.source_start_frame) - i128::from(self.range.timeline_start_frame)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineVideoFramePlan {
    pub active: bool,
    pub timeline_frame: u64,
    pub source_frame: Option<u64>,
    pub source_time_seconds: Option<f64>,
}

pub struct EngineTimelinePlan {
    base_enabled: Vec<u32>,
    ranges: Vec<Option<NodeFrameRange>>,
    particle_time_scales: Vec<Option<f32>>,
}

fn format_name(format: PixelFormat) -> &'static str {
    match format {
        PixelFormat::Rgba8 => "rgba8",
        PixelFormat::Rgba16Float => "rgba16_float",
        PixelFormat::Rgba32Float => "rgba32_float",
        PixelFormat::Alpha8 => "alpha8",
        PixelFormat::Alpha16 => "alpha16",
    }
}

fn gpu_blend(mode: EngineBlendMode) -> BlendMode {
    match mode {
        EngineBlendMode::Normal => BlendMode::Normal,
        EngineBlendMode::Add => BlendMode::Add,
        EngineBlendMode::Screen => BlendMode::Screen,
        EngineBlendMode::Multiply => BlendMode::Multiply,
        EngineBlendMode::Overlay => BlendMode::Overlay,
        EngineBlendMode::SoftLight => BlendMode::SoftLight,
        EngineBlendMode::HardLight => BlendMode::HardLight,
        EngineBlendMode::Difference => BlendMode::Difference,
        EngineBlendMode::Darken => BlendMode::Darken,
        EngineBlendMode::Lighten => BlendMode::Lighten,
        EngineBlendMode::ColorDodge => BlendMode::ColorDodge,
        EngineBlendMode::ColorBurn => BlendMode::ColorBurn,
    }
}

fn frame_active(range: Option<&NodeFrameRange>, timeline_frame: u64) -> bool {
    range.is_none_or(|range| {
        timeline_frame >= range.timeline_start_frame
            && timeline_frame
                < range
                    .timeline_start_frame
                    .saturating_add(range.duration_frames)
    })
}

fn resolve_binding(path: &Path, binding_dir: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        binding_dir.join(path)
    }
}

struct Planner<'a> {
    nodes: BTreeMap<&'a str, &'a EngineNode>,
    bindings: &'a BTreeMap<String, PathBuf>,
    binding_dir: &'a Path,
    graph_timebase: &'a RationalTimebase,
    timeline_frame: u64,
    canvas_width: u32,
    canvas_height: u32,
    visited: BTreeSet<String>,
    source_ranges: BTreeMap<String, Option<NodeFrameRange>>,
    display_transform: EngineDisplayTransform,
    scene_planes: BTreeMap<String, ScenePlaneProjection>,
}

fn camera_keyframe_values(keyframe: CameraKeyframe) -> ([f32; 3], [f32; 3], f32) {
    (
        keyframe.position,
        keyframe.target,
        keyframe.vertical_fov_radians,
    )
}

fn interpolate_camera(
    previous: ([f32; 3], [f32; 3], f32),
    next: ([f32; 3], [f32; 3], f32),
    ratio: f32,
) -> ([f32; 3], [f32; 3], f32) {
    let amount = ratio.clamp(0.0, 1.0);
    let mix = |left: f32, right: f32| left + (right - left) * amount;
    (
        std::array::from_fn(|index| mix(previous.0[index], next.0[index])),
        std::array::from_fn(|index| mix(previous.1[index], next.1[index])),
        mix(previous.2, next.2),
    )
}

fn sample_camera(
    base: ([f32; 3], [f32; 3], f32),
    keyframes: &[CameraKeyframe],
    timeline_frame: u64,
) -> ([f32; 3], [f32; 3], f32) {
    let first_after_or_at = keyframes
        .iter()
        .position(|keyframe| keyframe.frame >= timeline_frame);
    match first_after_or_at {
        None if !keyframes.is_empty() => {
            camera_keyframe_values(*keyframes.last().expect("non-empty"))
        }
        None => base,
        Some(0) => {
            let next = keyframes[0];
            interpolate_camera(
                base,
                camera_keyframe_values(next),
                timeline_frame as f32 / next.frame as f32,
            )
        }
        Some(index) => {
            let previous = keyframes[index - 1];
            let next = keyframes[index];
            if timeline_frame == next.frame {
                camera_keyframe_values(next)
            } else if matches!(previous.easing, KeyframeEasing::Hold) {
                camera_keyframe_values(previous)
            } else {
                let ratio =
                    (timeline_frame - previous.frame) as f32 / (next.frame - previous.frame) as f32;
                interpolate_camera(
                    camera_keyframe_values(previous),
                    camera_keyframe_values(next),
                    easing_progress(ratio, previous.easing),
                )
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LightSample {
    color: [f32; 3],
    intensity: f32,
    direction: [f32; 3],
}

fn light_keyframe_values(keyframe: LightKeyframe) -> LightSample {
    LightSample {
        color: keyframe.color,
        intensity: keyframe.intensity,
        direction: keyframe.direction,
    }
}

fn interpolate_light(previous: LightSample, next: LightSample, ratio: f32) -> LightSample {
    let amount = ratio.clamp(0.0, 1.0);
    let mix = |left: f32, right: f32| left + (right - left) * amount;
    LightSample {
        color: std::array::from_fn(|index| mix(previous.color[index], next.color[index])),
        intensity: mix(previous.intensity, next.intensity),
        direction: std::array::from_fn(|index| {
            mix(previous.direction[index], next.direction[index])
        }),
    }
}

fn sample_light(
    base: LightSample,
    keyframes: &[LightKeyframe],
    timeline_frame: u64,
) -> LightSample {
    let first_after_or_at = keyframes
        .iter()
        .position(|keyframe| keyframe.frame >= timeline_frame);
    match first_after_or_at {
        None if !keyframes.is_empty() => {
            light_keyframe_values(*keyframes.last().expect("non-empty"))
        }
        None => base,
        Some(0) => {
            let next = keyframes[0];
            if timeline_frame == next.frame {
                light_keyframe_values(next)
            } else {
                interpolate_light(
                    base,
                    light_keyframe_values(next),
                    timeline_frame as f32 / next.frame as f32,
                )
            }
        }
        Some(index) => {
            let previous = keyframes[index - 1];
            let next = keyframes[index];
            if timeline_frame == next.frame {
                light_keyframe_values(next)
            } else if matches!(previous.easing, KeyframeEasing::Hold) {
                light_keyframe_values(previous)
            } else {
                let ratio =
                    (timeline_frame - previous.frame) as f32 / (next.frame - previous.frame) as f32;
                interpolate_light(
                    light_keyframe_values(previous),
                    light_keyframe_values(next),
                    easing_progress(ratio, previous.easing),
                )
            }
        }
    }
}

pub fn prepare_scene_25d_frame(
    graph: &EngineGraph,
    timeline_frame: u64,
) -> Result<Option<EngineScene25dPlan>> {
    let transforms = graph
        .nodes
        .iter()
        .filter(|node| matches!(node.operation, NodeOperation::Transform3d { .. }))
        .collect::<Vec<_>>();
    let cameras = graph
        .nodes
        .iter()
        .filter(|node| matches!(node.operation, NodeOperation::Camera { .. }))
        .collect::<Vec<_>>();
    let lights = graph
        .nodes
        .iter()
        .filter(|node| matches!(node.operation, NodeOperation::Light { .. }))
        .collect::<Vec<_>>();
    if transforms.is_empty() {
        if !cameras.is_empty() || !lights.is_empty() {
            bail!("camera/light nodes require at least one transform3d plane");
        }
        return Ok(None);
    }
    if !(1..=8).contains(&transforms.len()) {
        bail!("bounded 2.5D scene requires 1..=8 textured planes");
    }
    if cameras.len() != 1 {
        bail!("bounded 2.5D scene requires exactly one camera");
    }
    if transforms.iter().any(|node| !node.enabled)
        || cameras.iter().any(|node| !node.enabled)
        || lights.iter().any(|node| !node.enabled)
    {
        bail!("bounded 2.5D scene resources cannot be disabled");
    }
    let camera_node = cameras[0];
    let NodeOperation::Camera {
        position,
        target,
        up,
        vertical_fov_radians,
        near,
        far,
        keyframes,
    } = &camera_node.operation
    else {
        unreachable!()
    };
    let (sampled_position, sampled_target, sampled_fov) = sample_camera(
        (*position, *target, *vertical_fov_radians),
        keyframes,
        timeline_frame,
    );
    let camera = CameraProjection {
        position: Vec3::new(sampled_position),
        target: Vec3::new(sampled_target),
        up: Vec3::new(*up),
        vertical_fov: sampled_fov,
        aspect: graph.width as f32 / graph.height as f32,
        near: *near,
        far: *far,
    };
    let mut ambient = None;
    let mut ambient_sample = None;
    let mut ambient_keyframe_count = 0;
    let mut directional = Vec::new();
    let mut directional_sample = None;
    let mut directional_keyframe_count = 0;
    for node in &lights {
        let NodeOperation::Light {
            light_kind,
            color,
            intensity,
            direction,
            keyframes,
            ..
        } = &node.operation
        else {
            unreachable!()
        };
        if color.iter().any(|value| !value.is_finite() || *value < 0.0) {
            bail!("bounded 2.5D scene light {} has invalid color", node.id);
        }
        let sampled = sample_light(
            LightSample {
                color: *color,
                intensity: *intensity,
                direction: *direction,
            },
            keyframes,
            timeline_frame,
        );
        if sampled
            .color
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
            || !sampled.intensity.is_finite()
            || sampled.intensity < 0.0
            || sampled.direction.iter().any(|value| !value.is_finite())
        {
            bail!(
                "bounded 2.5D scene light {} produced an invalid timeline sample",
                node.id
            );
        }
        match light_kind {
            LightKind::Ambient => {
                if ambient.is_some() {
                    bail!("bounded 2.5D scene supports exactly one ambient light");
                }
                if sampled
                    .color
                    .iter()
                    .any(|value| (*value - 1.0).abs() > 0.000001)
                {
                    bail!("bounded 2.5D ambient light must be neutral white");
                }
                ambient = Some(sampled.intensity);
                ambient_sample = Some(sampled);
                ambient_keyframe_count = keyframes.len();
            }
            LightKind::Directional => {
                if !directional.is_empty() {
                    bail!("bounded 2.5D scene supports exactly one directional light");
                }
                directional.push(DirectionalLight {
                    direction: Vec3::new(sampled.direction),
                    color: sampled.color,
                    intensity: sampled.intensity,
                });
                directional_sample = Some(sampled);
                directional_keyframe_count = keyframes.len();
            }
            LightKind::Point | LightKind::Spot => {
                bail!("bounded 2.5D scene supports ambient/directional light, not point or spot");
            }
        }
    }
    let ambient = ambient.context("bounded 2.5D scene requires exactly one ambient light")?;
    if directional.len() != 1 {
        bail!("bounded 2.5D scene requires exactly one directional light");
    }
    let ambient_sample =
        ambient_sample.context("bounded 2.5D scene requires an ambient light sample")?;
    let directional_sample =
        directional_sample.context("bounded 2.5D scene requires a directional light sample")?;
    let transform_ids = transforms
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    let video_plane_count = transforms
        .iter()
        .filter(|transform| {
            transform.inputs.first().and_then(|input| graph.nodes.iter().find(|node| node.id == *input))
                .is_some_and(|source| matches!(&source.operation, NodeOperation::Source { media_kind, .. } if media_kind == "video"))
        })
        .count();
    let aspect = graph.width as f32 / graph.height as f32;
    let mut parented_plane_count = 0;
    let scene_layers = transforms
        .iter()
        .map(|node| {
            if node.inputs.len() != 1 {
                bail!(
                    "2.5D transform {} requires exactly one image input",
                    node.id
                );
            }
            let NodeOperation::Transform3d {
                position,
                rotation_radians,
                scale,
                parent,
            } = &node.operation
            else {
                unreachable!()
            };
            if let Some(parent) = parent {
                if !transform_ids.contains(parent.as_str()) {
                    bail!(
                        "2.5D transform {} parent must reference transform3d",
                        node.id
                    );
                }
                parented_plane_count += 1;
            }
            Ok(SceneLayer {
                id: node.id.clone(),
                parent: parent.clone(),
                position: Vec3::new(*position),
                rotation: Vec3::new(*rotation_radians),
                scale: Vec3::new(*scale),
                size: [aspect * 2.0, 2.0],
                color: LinearRgba {
                    r: 1.0,
                    g: 1.0,
                    b: 1.0,
                    a: 1.0,
                },
                blend_mode: EngineBlendMode::Normal,
                opacity: 1.0,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    for layer in &scene_layers {
        let mut depth = 0;
        let mut parent = layer.parent.as_deref();
        while let Some(parent_id) = parent {
            depth += 1;
            if depth > 4 {
                bail!("bounded 2.5D parent depth exceeds 4 at {}", layer.id);
            }
            parent = scene_layers
                .iter()
                .find(|candidate| candidate.id == parent_id)
                .and_then(|candidate| candidate.parent.as_deref());
        }
    }
    let projections = project_2_5d_scene_planes(
        graph.width,
        graph.height,
        camera,
        &scene_layers,
        ambient,
        &directional,
    )
    .map_err(anyhow::Error::msg)?
    .into_iter()
    .map(|projection| (projection.id.clone(), projection))
    .collect();
    let resource_node_ids = cameras
        .iter()
        .chain(lights.iter())
        .map(|node| node.id.clone())
        .collect();
    Ok(Some(EngineScene25dPlan {
        width: graph.width,
        height: graph.height,
        projections,
        resource_node_ids,
        coverage: EngineScene25dCoverage {
            scene_contract: "single_camera_textured_planes/v1",
            plane_count: transforms.len(),
            video_plane_count,
            parented_plane_count,
            camera_node_id: camera_node.id.clone(),
            ambient_light_count: 1,
            directional_light_count: 1,
            depth_mode: "non_intersecting_plane_average_depth_back_to_front",
            depth_format: "none",
            depth_tested_plane_count: 0,
            depth_pass_count: 0,
            geometry_executor: "hao-core-native-camera-matrix/v1",
            pixel_executor: "wgpu-projective-plane-compositor/v1",
            camera_animation_contract: if keyframes.is_empty() {
                "static/v1"
            } else {
                "timeline-keyframes/v1"
            },
            camera_keyframe_count: keyframes.len(),
            sampled_timeline_frame: if keyframes.is_empty() {
                0
            } else {
                timeline_frame
            },
            camera_position: sampled_position,
            camera_target: sampled_target,
            camera_vertical_fov_radians: sampled_fov,
            light_animation_contract: if ambient_keyframe_count + directional_keyframe_count == 0 {
                "static/v1"
            } else {
                "timeline-keyframes/v1"
            },
            ambient_light_keyframe_count: ambient_keyframe_count,
            directional_light_keyframe_count: directional_keyframe_count,
            sampled_light_timeline_frame: if ambient_keyframe_count + directional_keyframe_count
                == 0
            {
                0
            } else {
                timeline_frame
            },
            ambient_light_color: ambient_sample.color,
            ambient_light_intensity: ambient_sample.intensity,
            directional_light_color: directional_sample.color,
            directional_light_intensity: directional_sample.intensity,
            directional_light_direction: directional_sample.direction,
        },
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenExrSequenceManifest {
    schema: String,
    status: String,
    working_color_space: String,
    artifact_format: String,
    artifact_container: String,
    timebase: RationalTimebase,
    start_frame: u64,
    frame_count: u64,
    last_frame: u64,
    file_pattern: String,
    width: u32,
    height: u32,
}

fn resolve_openexr_sequence_frame(
    manifest_path: &Path,
    range: Option<&NodeFrameRange>,
    timeline_frame: u64,
    graph_timebase: &RationalTimebase,
) -> Result<PathBuf> {
    let manifest: OpenExrSequenceManifest = serde_json::from_slice(
        &std::fs::read(manifest_path)
            .with_context(|| format!("read OpenEXR sequence {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parse OpenEXR sequence {}", manifest_path.display()))?;
    if manifest.schema != "editkin.openexr-sequence/v1"
        || manifest.status != "GREEN"
        || manifest.working_color_space != "linear_rec709"
        || manifest.artifact_format != "rgba32_float"
        || manifest.artifact_container != "openexr"
        || manifest.file_pattern != "frame-%08d.exr"
        || manifest.frame_count == 0
        || manifest.frame_count > 1_000_000
        || manifest.width == 0
        || manifest.height == 0
        || manifest.start_frame.checked_add(manifest.frame_count - 1) != Some(manifest.last_frame)
    {
        bail!(
            "invalid Editkin OpenEXR sequence manifest: {}",
            manifest_path.display()
        );
    }
    if &manifest.timebase != graph_timebase {
        bail!(
            "OpenEXR sequence timebase {}/{} does not match graph {}/{}",
            manifest.timebase.numerator,
            manifest.timebase.denominator,
            graph_timebase.numerator,
            graph_timebase.denominator
        );
    }
    let source_index = if let Some(range) = range {
        if range
            .source_start_frame
            .checked_add(range.duration_frames)
            .is_none_or(|end| end > manifest.frame_count)
        {
            bail!("OpenEXR sequence source range exceeds its manifest frame count");
        }
        let active = timeline_frame >= range.timeline_start_frame
            && timeline_frame
                < range
                    .timeline_start_frame
                    .saturating_add(range.duration_frames);
        range.source_start_frame
            + if active {
                timeline_frame - range.timeline_start_frame
            } else {
                0
            }
    } else {
        0
    };
    if source_index >= manifest.frame_count {
        bail!("OpenEXR sequence source frame is outside its manifest range");
    }
    let file_frame = manifest
        .start_frame
        .checked_add(source_index)
        .context("OpenEXR sequence file frame overflow")?;
    let frame_path = manifest_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("frame-{file_frame:08}.exr"));
    if !frame_path.is_file() {
        bail!(
            "OpenEXR sequence frame is missing: {}",
            frame_path.display()
        );
    }
    Ok(frame_path)
}

impl<'a> Planner<'a> {
    fn node(&self, id: &str) -> Result<&'a EngineNode> {
        self.nodes
            .get(id)
            .copied()
            .with_context(|| format!("missing engine node: {id}"))
    }

    fn one_input<'b>(&self, node: &'b EngineNode) -> Result<&'b str> {
        if node.inputs.len() != 1 {
            bail!("engine node {} requires exactly one input", node.id);
        }
        Ok(&node.inputs[0])
    }

    fn leaf(&mut self, id: &str) -> Result<Layer> {
        let node = self.node(id)?;
        self.visited.insert(node.id.clone());
        match &node.operation {
            NodeOperation::Source {
                asset_id,
                media_kind,
                input_color_space,
                alpha_mode,
                timeline,
            } => {
                if !node.inputs.is_empty() {
                    bail!("source node {} cannot have inputs", node.id);
                }
                if input_color_space
                    .as_deref()
                    .is_some_and(|space| !matches!(space, "rec709" | "linear_rec709"))
                {
                    bail!("unsupported source color space on {}", node.id);
                }
                let source = if asset_id == "editkin.generator.transparent"
                    && media_kind == "generator"
                {
                    LayerSource::Solid {
                        color: [0, 0, 0, 0],
                    }
                } else {
                    if media_kind != "image" {
                        bail!("unsupported engine source kind: {media_kind}");
                    }
                    let binding = self
                        .bindings
                        .get(asset_id)
                        .with_context(|| format!("missing asset binding: {asset_id}"))?;
                    let resolved = resolve_binding(binding, self.binding_dir);
                    let extension = resolved
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .unwrap_or_default();
                    if extension.eq_ignore_ascii_case("exr")
                        && input_color_space.as_deref() != Some("linear_rec709")
                    {
                        bail!(
                            "OpenEXR source {} requires linear_rec709 interpretation",
                            node.id
                        );
                    }
                    if input_color_space.as_deref() == Some("linear_rec709") {
                        if !extension.eq_ignore_ascii_case("ekf32")
                            && !extension.eq_ignore_ascii_case("exr")
                            && !extension.eq_ignore_ascii_case("json")
                        {
                            bail!(
                                "scene-linear source {} requires an .exr, .ekf32, or Editkin OpenEXR sequence binding",
                                node.id
                            );
                        }
                        let path = if extension.eq_ignore_ascii_case("json") {
                            resolve_openexr_sequence_frame(
                                &resolved,
                                timeline.as_ref(),
                                self.timeline_frame,
                                self.graph_timebase,
                            )?
                        } else {
                            resolved
                        };
                        LayerSource::FloatImage { path }
                    } else {
                        LayerSource::Image { path: resolved }
                    }
                };
                self.source_ranges.insert(node.id.clone(), timeline.clone());
                Ok(Layer {
                    id: node.id.clone(),
                    source,
                    alpha_mode: generic_source_alpha_mode(*alpha_mode, media_kind),
                    blend_mode: BlendMode::Normal,
                    opacity: 1.0,
                    transform: Transform::default(),
                    enabled: node.enabled,
                    effect: BuiltinEffect::default(),
                    scene_depth: None,
                })
            }
            NodeOperation::ParticleEmitter {
                timeline,
                seed,
                rate_per_second,
                lifetime_seconds,
                initial_velocity,
                gravity,
                max_particles,
                emitter_position,
                radius_pixels,
                color,
            } => {
                if !node.inputs.is_empty() {
                    bail!("particle emitter {} cannot have inputs", node.id);
                }
                if !node.enabled {
                    bail!("disabled particle emitter is not supported: {}", node.id);
                }
                let seed = u32::try_from(*seed)
                    .with_context(|| format!("particle seed exceeds u32 on {}", node.id))?;
                let local_frame = self.timeline_frame.saturating_sub(
                    timeline
                        .as_ref()
                        .map_or(0, |range| range.timeline_start_frame),
                );
                let time_seconds = local_frame as f32 * self.graph_timebase.numerator as f32
                    / self.graph_timebase.denominator as f32;
                self.source_ranges.insert(node.id.clone(), timeline.clone());
                Ok(Layer {
                    id: node.id.clone(),
                    source: LayerSource::ParticleEmitter {
                        seed,
                        rate_per_second: *rate_per_second,
                        lifetime_seconds: *lifetime_seconds,
                        time_seconds,
                        max_particles: *max_particles,
                        emitter_position: *emitter_position,
                        initial_velocity: [initial_velocity[0], initial_velocity[1]],
                        gravity: [gravity[0], gravity[1]],
                        radius_pixels: *radius_pixels,
                        color: *color,
                    },
                    alpha_mode: SourceAlphaMode::Straight,
                    blend_mode: BlendMode::Normal,
                    opacity: 1.0,
                    transform: Transform::default(),
                    enabled: true,
                    effect: BuiltinEffect::default(),
                    scene_depth: None,
                })
            }
            NodeOperation::Transform2d {
                x,
                y,
                scale_x,
                scale_y,
                rotation_radians,
                opacity,
                keyframes,
                parent,
            } => {
                if !self.scene_planes.is_empty() {
                    bail!("bounded 2.5D scene cannot mix transform2d and transform3d planes");
                }
                if !keyframes.is_empty() {
                    bail!(
                        "animated engine transforms are not supported on {}",
                        node.id
                    );
                }
                if parent.is_some() {
                    bail!("unsupported engine transform parent on {}", node.id);
                }
                if (*scale_x - *scale_y).abs() > 0.000001 {
                    bail!("non-uniform engine scale is not supported on {}", node.id);
                }
                let input = self.one_input(node)?.to_owned();
                let mut layer = self.leaf(&input)?;
                if layer.transform != Transform::default() {
                    bail!("stacked engine transforms are not supported on {}", node.id);
                }
                layer.transform = Transform {
                    x: *x,
                    y: *y,
                    scale: *scale_x,
                    rotation: *rotation_radians,
                    ..Transform::default()
                };
                layer.opacity *= *opacity;
                layer.enabled &= node.enabled;
                Ok(layer)
            }
            NodeOperation::Transform3d { .. } => {
                let input = self.one_input(node)?.to_owned();
                let mut layer = self.leaf(&input)?;
                if layer.transform != Transform::default() {
                    bail!("stacked 2.5D transforms are not supported on {}", node.id);
                }
                let projection = self
                    .scene_planes
                    .get(node.id.as_str())
                    .with_context(|| format!("missing native 2.5D projection for {}", node.id))?;
                let center_x = (self.canvas_width - 1) as f32 * 0.5;
                let center_y = (self.canvas_height - 1) as f32 * 0.5;
                let destination = projection.screen_corners.map(|point| {
                    (
                        f64::from(point[0] - center_x),
                        f64::from(point[1] - center_y),
                    )
                });
                // World +Y points upward while raster +Y points downward. Pair each projected
                // world corner with the corresponding source-image corner so the plane remains
                // upright under camera projection.
                let source = [
                    (-f64::from(center_x), f64::from(center_y)),
                    (f64::from(center_x), f64::from(center_y)),
                    (f64::from(center_x), -f64::from(center_y)),
                    (-f64::from(center_x), -f64::from(center_y)),
                ];
                layer.transform.projective =
                    solve_destination_to_source_homography(destination, source)
                        .with_context(|| format!("project 2.5D plane {}", node.id))?;
                layer.transform.projective_enabled = true;
                layer.transform.shade = projection.shade;
                layer.scene_depth = Some(projection.average_depth);
                layer.enabled &= node.enabled;
                Ok(layer)
            }
            NodeOperation::Color {
                processor,
                input_space,
                working_space,
                output_space,
                grade,
            } => {
                let rec709 = processor == "editkin-rec709-primary/v1"
                    && input_space == "rec709"
                    && working_space == "rec709"
                    && output_space == "rec709_sdr";
                let scene_linear = processor == "editkin-linear-primary/v1"
                    && input_space == "linear_rec709"
                    && working_space == "linear_rec709"
                    && output_space == "linear_rec709";
                if !rec709 && !scene_linear {
                    bail!("unsupported color processor on {}: {}", node.id, processor);
                }
                if !grade.is_identity() {
                    bail!("unsupported color grade on {}", node.id);
                }
                let input = self.one_input(node)?.to_owned();
                let mut layer = self.leaf(&input)?;
                layer.enabled &= node.enabled;
                Ok(layer)
            }
            NodeOperation::Effect {
                plugin_id,
                abi_version,
                temporal_radius,
                parameters,
            } => {
                if !node.enabled {
                    bail!("disabled GPU effect nodes are not supported: {}", node.id);
                }
                if *abi_version != 1 || *temporal_radius != 0 || !parameters.is_empty() {
                    bail!("unsupported GPU effect contract: {plugin_id}");
                }
                let effect = match plugin_id.as_str() {
                    "editkin.builtin.mono_halftone" => BuiltinEffect::monochrome(1, 1.18, 0.0),
                    "editkin.builtin.xerox_pulse" => BuiltinEffect::monochrome(2, 1.42, 0.02),
                    _ => bail!("unsupported GPU effect plugin: {plugin_id}"),
                };
                let input = self.one_input(node)?.to_owned();
                let mut layer = self.leaf(&input)?;
                if layer.effect != BuiltinEffect::default() {
                    bail!("stacked GPU effects are not supported on {}", node.id);
                }
                layer.effect = effect;
                Ok(layer)
            }
            operation => bail!("unsupported engine node kind: {}", operation.kind_name()),
        }
    }

    fn expression(&mut self, id: &str) -> Result<Vec<Layer>> {
        let node = self.node(id)?;
        self.visited.insert(node.id.clone());
        match &node.operation {
            NodeOperation::Output { format } => {
                if !matches!(format, PixelFormat::Rgba16Float | PixelFormat::Rgba32Float) {
                    bail!("unsupported engine output format: {}", format_name(*format));
                }
                if !node.enabled {
                    bail!("engine output node cannot be disabled");
                }
                let input = self.one_input(node)?.to_owned();
                self.expression(&input)
            }
            NodeOperation::Composite {
                blend_mode,
                opacity,
                matte_input,
                matte_mode,
            } => {
                if !node.enabled {
                    bail!("disabled composite nodes are not supported: {}", node.id);
                }
                if matte_input.is_some() || matte_mode.is_some() {
                    bail!("unsupported engine node kind: track_matte");
                }
                if !self.scene_planes.is_empty()
                    && (!matches!(blend_mode, EngineBlendMode::Normal)
                        || (*opacity - 1.0).abs() > 0.000001)
                {
                    bail!("bounded 2.5D planes require normal depth compositing at opacity 1");
                }
                if node.inputs.len() != 2 {
                    bail!("composite node {} requires exactly two inputs", node.id);
                }
                let lower = node.inputs[0].clone();
                let upper = node.inputs[1].clone();
                let mut layers = self.expression(&lower)?;
                let mut upper_layer = self.leaf(&upper).with_context(|| {
                    format!(
                        "upper composite branch {} must resolve to one image layer",
                        upper
                    )
                })?;
                upper_layer.blend_mode = gpu_blend(*blend_mode);
                upper_layer.opacity *= *opacity;
                layers.push(upper_layer);
                Ok(layers)
            }
            NodeOperation::Color {
                processor,
                input_space,
                working_space,
                output_space,
                grade,
            } if EngineDisplayTransform::from_processor(processor).is_some() => {
                if !node.enabled {
                    bail!("engine display transform cannot be disabled");
                }
                let requested = EngineDisplayTransform::from_processor(processor)
                    .context("recognized ACES processor disappeared")?;
                if input_space != "linear_rec709"
                    || working_space != "ACEScct"
                    || output_space != requested.output_space()
                    || !grade.is_identity()
                {
                    bail!("invalid ACES 2 display transform on {}", node.id);
                }
                if self.display_transform != EngineDisplayTransform::SceneLinearPreview {
                    bail!("engine graph supports exactly one display transform");
                }
                self.display_transform = requested;
                let input = self.one_input(node)?.to_owned();
                self.expression(&input)
            }
            NodeOperation::Source { .. }
            | NodeOperation::ParticleEmitter { .. }
            | NodeOperation::Transform2d { .. }
            | NodeOperation::Transform3d { .. }
            | NodeOperation::Color { .. }
            | NodeOperation::Effect { .. } => Ok(vec![self.leaf(id)?]),
            operation => bail!("unsupported engine node kind: {}", operation.kind_name()),
        }
    }
}

trait OperationKindName {
    fn kind_name(&self) -> &'static str;
}

impl OperationKindName for NodeOperation {
    fn kind_name(&self) -> &'static str {
        match self {
            Self::Source { .. } => "source",
            Self::Transform2d { .. } => "transform2d",
            Self::Transform3d { .. } => "transform3d",
            Self::Camera { .. } => "camera",
            Self::Light { .. } => "light",
            Self::Mask { .. } => "mask",
            Self::AutoRoto { .. } => "auto_roto",
            Self::Color { .. } => "color",
            Self::Effect { .. } => "effect",
            Self::Composite { .. } => "composite",
            Self::Adjustment { .. } => "adjustment",
            Self::Precomposition { .. } => "precomposition",
            Self::Caption { .. } => "caption",
            Self::MotionGraphic { .. } => "motion_graphic",
            Self::ParticleEmitter { .. } => "particle_emitter",
            Self::DepthOfField { .. } => "depth_of_field",
            Self::MotionBlur { .. } => "motion_blur",
            Self::Output { .. } => "output",
        }
    }
}

fn prepare_vfx_simulation(graph: &EngineGraph) -> Result<Option<EngineVfxSimulationCoverage>> {
    let emitters = graph
        .nodes
        .iter()
        .filter(|node| matches!(&node.operation, NodeOperation::ParticleEmitter { .. }))
        .collect::<Vec<_>>();
    if emitters.is_empty() {
        return Ok(None);
    }
    if emitters.len() > 4 {
        bail!("bounded particle simulation supports at most 4 emitters");
    }
    if graph.nodes.iter().any(|node| {
        matches!(
            &node.operation,
            NodeOperation::Transform3d { .. }
                | NodeOperation::Camera { .. }
                | NodeOperation::Light { .. }
        )
    }) {
        bail!("screen-space particle simulation cannot mix 2.5D scene nodes");
    }
    let mut particle_ceiling = 0_u32;
    for emitter in &emitters {
        if !emitter.enabled {
            bail!("disabled particle emitter is not supported: {}", emitter.id);
        }
        let NodeOperation::ParticleEmitter {
            seed,
            rate_per_second,
            lifetime_seconds,
            initial_velocity,
            gravity,
            max_particles,
            radius_pixels,
            ..
        } = &emitter.operation
        else {
            unreachable!()
        };
        if *seed > u32::MAX as u64 {
            bail!("particle seed exceeds u32 on {}", emitter.id);
        }
        if *rate_per_second <= 0.0 || *rate_per_second > 240.0 {
            bail!(
                "bounded particle rate must be within 0..=240 on {}",
                emitter.id
            );
        }
        if *lifetime_seconds > 10.0 {
            bail!(
                "bounded particle lifetime ceiling is 10 seconds on {}",
                emitter.id
            );
        }
        if *max_particles > 64 {
            bail!("bounded particle ceiling is 64 on {}", emitter.id);
        }
        particle_ceiling = particle_ceiling
            .checked_add(*max_particles)
            .context("particle budget overflow")?;
        if initial_velocity[2].abs() > 0.000001 || gravity[2].abs() > 0.000001 {
            bail!(
                "screen-space 2D particles do not accept Z motion on {}",
                emitter.id
            );
        }
        if *radius_pixels > 64.0 {
            bail!(
                "bounded particle radius ceiling is 64 pixels on {}",
                emitter.id
            );
        }
    }
    if particle_ceiling > 192 {
        bail!("bounded particle aggregate ceiling is 192");
    }
    Ok(Some(EngineVfxSimulationCoverage {
        simulation_contract: "screen_space_analytic_particles/v1",
        emitter_count: emitters.len(),
        particle_ceiling,
        dimension: "screen_space_2d",
        seed_mode: "fixed_u32_hash_per_birth",
        time_source: "rational_node_local_frame",
        executor: "wgpu-bounded-particle-compute/v1",
    }))
}

pub fn prepare(
    graph: EngineGraph,
    bindings: &BTreeMap<String, PathBuf>,
    binding_dir: &Path,
    timeline_frame: u64,
) -> Result<PreparedEngineGraph> {
    let compiled = compile_graph(graph.clone()).map_err(anyhow::Error::msg)?;
    let scene_25d = prepare_scene_25d_frame(&graph, timeline_frame)?;
    let vfx_simulation = prepare_vfx_simulation(&graph)?;
    if !matches!(
        graph.working_format,
        PixelFormat::Rgba16Float | PixelFormat::Rgba32Float
    ) {
        bail!("common GPU executor requires rgba16_float or rgba32_float working format");
    }
    if graph.audio.is_some() {
        bail!("audio graph is not accepted by the image-only GPU executor");
    }
    validate_scene_linear_contract(&graph)?;
    let nodes = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut planner = Planner {
        nodes,
        bindings,
        binding_dir,
        graph_timebase: &graph.timebase,
        timeline_frame,
        canvas_width: graph.width,
        canvas_height: graph.height,
        visited: scene_25d
            .as_ref()
            .map(|scene| scene.resource_node_ids.clone())
            .unwrap_or_default(),
        source_ranges: BTreeMap::new(),
        display_transform: EngineDisplayTransform::SceneLinearPreview,
        scene_planes: scene_25d
            .as_ref()
            .map(|scene| scene.projections.clone())
            .unwrap_or_default(),
    };
    let mut layers = planner.expression(&graph.output_node)?;
    if scene_25d.is_some() {
        if layers.iter().any(|layer| layer.scene_depth.is_none()) {
            bail!("bounded 2.5D scene cannot mix projected and flat image planes");
        }
        layers.sort_by(|left, right| {
            right
                .scene_depth
                .unwrap_or_default()
                .total_cmp(&left.scene_depth.unwrap_or_default())
        });
    }
    if layers
        .iter()
        .any(|layer| matches!(&layer.source, LayerSource::FloatImage { .. }))
        && graph.working_format != PixelFormat::Rgba32Float
    {
        bail!("scene-linear float sources require rgba32_float working format");
    }
    if planner.display_transform.is_aces2()
        && (!layers
            .iter()
            .any(|layer| matches!(&layer.source, LayerSource::FloatImage { .. }))
            || graph.working_format != PixelFormat::Rgba32Float)
    {
        bail!("ACES 2 display transform requires rgba32_float scene-linear sources");
    }
    let required: BTreeSet<_> = graph.nodes.iter().map(|node| node.id.clone()).collect();
    if planner.visited != required {
        let unreachable = required
            .difference(&planner.visited)
            .cloned()
            .collect::<Vec<_>>();
        bail!(
            "unreachable engine nodes are not allowed: {}",
            unreachable.join(", ")
        );
    }
    let base_enabled = layers
        .iter()
        .map(|layer| u32::from(layer.enabled))
        .collect();
    let ranges = layers
        .iter()
        .map(|layer| planner.source_ranges.get(&layer.id).cloned().flatten())
        .collect();
    let particle_time_scales = layers
        .iter()
        .map(|layer| {
            matches!(&layer.source, LayerSource::ParticleEmitter { .. })
                .then_some(graph.timebase.numerator as f32 / graph.timebase.denominator as f32)
        })
        .collect();
    let internal = RenderGraph {
        schema: super::GRAPH_SCHEMA.to_owned(),
        width: graph.width,
        height: graph.height,
        layers,
    };
    super::validate_graph(&internal)?;
    let mut prepared = prepare_graph(internal, binding_dir)?;
    prepared.float_working = true;
    let timeline = EngineTimelinePlan {
        base_enabled,
        ranges,
        particle_time_scales,
    };
    timeline.apply(&mut prepared.params, timeline_frame)?;
    Ok(PreparedEngineGraph {
        prepared,
        coverage: EngineExecutionCoverage {
            graph_schema: COMMON_GRAPH_SCHEMA,
            graph_id: graph.graph_id,
            direct_execution: true,
            requested_working_format: format_name(graph.working_format).to_owned(),
            execution_format: "rgba32_float",
            artifact_format: "rgba8",
            executed_node_ids: compiled
                .passes
                .into_iter()
                .map(|pass| pass.node_id)
                .collect(),
            blocked_node_ids: vec![],
            ignored_node_ids: vec![],
        },
        timeline,
        display_transform: planner.display_transform,
        scene_25d: scene_25d.map(|scene| scene.coverage),
        vfx_simulation,
    })
}

fn validate_scene_linear_contract(graph: &EngineGraph) -> Result<()> {
    let has_scene_linear = graph.nodes.iter().any(|node| {
        matches!(
            &node.operation,
            NodeOperation::Source { asset_id, media_kind, input_color_space, .. }
                if media_kind == "image" && !asset_id.starts_with("editkin.generator.")
                    && input_color_space.as_deref() == Some("linear_rec709")
        )
    });
    if !has_scene_linear {
        return Ok(());
    }
    for node in &graph.nodes {
        match &node.operation {
            NodeOperation::Source {
                asset_id,
                media_kind,
                input_color_space,
                ..
            } if media_kind == "image"
                && !asset_id.starts_with("editkin.generator.")
                && input_color_space.as_deref() != Some("linear_rec709") =>
            {
                bail!(
                    "scene-linear graph cannot mix an unconverted SDR source: {}",
                    node.id
                );
            }
            NodeOperation::Caption { .. }
            | NodeOperation::MotionGraphic { .. }
            | NodeOperation::Effect { .. } => {
                bail!(
                    "scene-linear graph node {} requires a calibrated linear-light implementation",
                    node.id
                );
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn prepare_video(
    graph: EngineGraph,
    bindings: &BTreeMap<String, PathBuf>,
    binding_dir: &Path,
) -> Result<PreparedEngineVideoGraph> {
    prepare_video_with_effects(graph, bindings, binding_dir, &GpuEffectBindings::default())
}

pub fn prepare_video_with_effects(
    graph: EngineGraph,
    bindings: &BTreeMap<String, PathBuf>,
    binding_dir: &Path,
    effect_bindings: &GpuEffectBindings,
) -> Result<PreparedEngineVideoGraph> {
    if effect_bindings.schema != GPU_EFFECT_BINDINGS_SCHEMA {
        bail!(
            "unsupported GPU effect bindings schema: {}",
            effect_bindings.schema
        );
    }
    let compiled = compile_graph(graph.clone()).map_err(anyhow::Error::msg)?;
    if !matches!(
        graph.working_format,
        PixelFormat::Rgba16Float | PixelFormat::Rgba32Float
    ) {
        bail!("common video GPU executor requires rgba16_float or rgba32_float working format");
    }
    if graph.audio.is_some() {
        bail!("audio graph is not accepted by the common video GPU executor");
    }
    let mut scene_25d = prepare_scene_25d_frame(&graph, 0)?;
    let mut vfx_simulation = prepare_vfx_simulation(&graph)?;
    if let Some(coverage) = &mut vfx_simulation {
        coverage.executor = "wgpu-resident-video-particle-overlay/v1";
    }
    let nodes: BTreeMap<_, _> = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut visited = scene_25d
        .as_ref()
        .map(|scene| scene.resource_node_ids.clone())
        .unwrap_or_default();
    let mut consumed_effect_bindings = BTreeSet::new();
    let output = nodes
        .get(graph.output_node.as_str())
        .copied()
        .with_context(|| format!("missing engine output node: {}", graph.output_node))?;
    if !visited.insert(output.id.clone()) {
        bail!("common video graph contains a cycle at {}", output.id);
    }
    if !output.enabled {
        bail!("common video graph node cannot be disabled: {}", output.id);
    }
    let NodeOperation::Output { format } = &output.operation else {
        bail!("common video outputNode must reference an output operation");
    };
    if !matches!(format, PixelFormat::Rgba16Float | PixelFormat::Rgba32Float) {
        bail!(
            "unsupported common video output format: {}",
            format_name(*format)
        );
    }
    if output.inputs.len() != 1 {
        bail!(
            "common video output {} requires exactly one input",
            output.id
        );
    }
    let mut composite_root = output.inputs[0].clone();
    let mut display_transform = EngineDisplayTransform::SceneLinearPreview;
    if let Some(display_node) = nodes.get(composite_root.as_str()).copied() {
        if let NodeOperation::Color {
            processor,
            input_space,
            working_space,
            output_space,
            grade,
        } = &display_node.operation
        {
            if let Some(requested) = EngineDisplayTransform::from_processor(processor) {
                if !matches!(
                    requested,
                    EngineDisplayTransform::Aces2Rec709Sdr
                        | EngineDisplayTransform::Aces2Rec2100Pq1000
                ) {
                    bail!(
                        "resident scene-linear video preview supports ACES2 Rec.709 SDR or Rec.2100 PQ 1000-nit; HLG remains a formal-output transform"
                    );
                }
                if input_space != "linear_rec709"
                    || working_space != "ACEScct"
                    || output_space != requested.output_space()
                    || !grade.is_identity()
                    || display_node.inputs.len() != 1
                {
                    bail!(
                        "resident scene-linear video display transform must be one identity linear_rec709 -> ACEScct -> declared output-space node"
                    );
                }
                if !visited.insert(display_node.id.clone()) {
                    bail!("common video graph contains a cycle at {}", display_node.id);
                }
                display_transform = requested;
                composite_root = display_node.inputs[0].clone();
            }
        }
    }
    let mut depth_of_field = None;
    if let Some(lens_node) = nodes.get(composite_root.as_str()).copied() {
        if let NodeOperation::DepthOfField {
            focus_distance,
            aperture,
            max_blur_radius,
            keyframes,
        } = &lens_node.operation
        {
            let scene = scene_25d
                .as_ref()
                .context("resident camera depth of field requires one native 2.5D scene")?;
            if !lens_node.enabled || lens_node.inputs.len() != 2 {
                bail!("resident camera depth of field requires two enabled typed inputs");
            }
            let camera_id = lens_node.inputs[1].as_str();
            if camera_id != scene.coverage.camera_node_id {
                bail!("resident camera depth of field must reference the active 2.5D camera");
            }
            let camera_node = nodes
                .get(camera_id)
                .copied()
                .context("resident camera depth of field camera input is missing")?;
            let NodeOperation::Camera { near, far, .. } = &camera_node.operation else {
                bail!("resident camera depth of field second input is not a camera");
            };
            if !focus_distance.is_finite()
                || !aperture.is_finite()
                || !max_blur_radius.is_finite()
                || *focus_distance <= *near
                || *focus_distance >= *far
                || *aperture <= 0.0
                || *aperture > 16.0
                || *max_blur_radius < 1.0
                || *max_blur_radius > 32.0
            {
                bail!("resident camera depth of field parameters exceed the bounded lens contract");
            }
            if keyframes
                .iter()
                .any(|keyframe| keyframe.focus_distance <= *near || keyframe.focus_distance >= *far)
            {
                bail!("resident camera depth of field keyframes exceed the camera clipping range");
            }
            if !visited.insert(lens_node.id.clone()) {
                bail!("common video graph contains a cycle at {}", lens_node.id);
            }
            if !matches!(
                display_transform,
                EngineDisplayTransform::Aces2Rec709Sdr
                    | EngineDisplayTransform::Aces2Rec2100Pq1000
            ) {
                bail!(
                    "resident camera depth of field requires an admitted ACES2 SDR/PQ scene-linear preview route"
                );
            }
            depth_of_field = Some(EngineVideoDepthOfFieldPlan {
                contract: "camera_depth_of_field/v1",
                node_id: lens_node.id.clone(),
                focus_distance: *focus_distance,
                aperture: *aperture,
                max_blur_radius: *max_blur_radius,
                near: *near,
                far: *far,
                execution_mode: "scene-linear-depth32f-gather-dof/v1",
                depth_source: "depth32_float",
                executor: "wgpu-depth-aware-gather/v1",
                pass_count: 1,
                animation_contract: if keyframes.is_empty() {
                    "static/v1"
                } else {
                    "timeline-keyframes/v1"
                },
                keyframe_count: keyframes.len(),
                sampled_timeline_frame: 0,
                keyframes: keyframes.clone(),
            });
            composite_root = lens_node.inputs[0].clone();
        }
    }
    let mut post_adjustment_typography = Vec::new();
    let mut adjustment_before_typography = false;
    if let Some((inner_root, typography, composite_ids)) =
        peel_post_adjustment_typography(&nodes, &composite_root)?
    {
        for id in composite_ids {
            if !visited.insert(id.clone()) {
                bail!("common video graph contains a shared or cyclic composite at {id}");
            }
        }
        composite_root = inner_root;
        post_adjustment_typography = typography;
        adjustment_before_typography = true;
    }
    let mut adjustments = Vec::new();
    while adjustment_chain_reaches_adjustment(&nodes, &composite_root) {
        let (next, adjustment) = prepare_video_adjustment(
            &nodes,
            &composite_root,
            &mut visited,
            effect_bindings,
            &mut consumed_effect_bindings,
            display_transform,
        )?;
        adjustments.push(adjustment);
        composite_root = next;
        if adjustments.len() > 4 {
            bail!("common video graph supports at most 4 trailing adjustment layers");
        }
    }
    adjustments.reverse();
    let mut branch_tails = Vec::new();
    collect_video_branch_tails(&nodes, &composite_root, &mut visited, &mut branch_tails)?;
    branch_tails.extend(post_adjustment_typography);
    let mut layers = Vec::with_capacity(branch_tails.len());
    let mut layer_indices_by_tail = BTreeMap::<String, usize>::new();
    let mut pending_mattes = Vec::<(usize, String, MatteMode)>::new();
    let mut captions = Vec::new();
    let mut motion_graphics = Vec::new();
    let mut particles = Vec::new();
    let mut overlay_phase = 0_u8;
    for collected in branch_tails {
        let branch_tail = collected.tail;
        let branch = nodes
            .get(branch_tail.as_str())
            .copied()
            .with_context(|| format!("missing engine node: {branch_tail}"))?;
        if matches!(branch.operation, NodeOperation::ParticleEmitter { .. }) {
            if !matches!(collected.blend_mode, BlendMode::Normal)
                || (collected.opacity - 1.0).abs() > 0.000001
            {
                bail!("common video particle composite requires normal blend mode and opacity 1");
            }
            if overlay_phase > 1 {
                bail!("common video particles must precede captions and motion graphic overlays");
            }
            overlay_phase = 1;
            particles.push(prepare_video_particle(
                branch,
                &mut visited,
                graph.timebase.numerator,
                graph.timebase.denominator,
            )?);
            if particles.len() > 4 {
                bail!("common video graph supports at most 4 bounded particle overlays");
            }
        } else if matches!(branch.operation, NodeOperation::Caption { .. }) {
            if !matches!(collected.blend_mode, BlendMode::Normal)
                || (collected.opacity - 1.0).abs() > 0.000001
            {
                bail!("common video caption composite requires normal blend mode and opacity 1");
            }
            if overlay_phase > 2 {
                bail!("common video captions must precede motion graphic overlays");
            }
            overlay_phase = 2;
            captions.push(prepare_video_caption(branch, &mut visited)?);
            if captions.len() > 8 {
                bail!("common video graph supports at most 8 caption overlays");
            }
        } else if matches!(branch.operation, NodeOperation::MotionGraphic { .. }) {
            if !matches!(collected.blend_mode, BlendMode::Normal)
                || (collected.opacity - 1.0).abs() > 0.000001
            {
                bail!(
                    "common video motion graphic composite requires normal blend mode and opacity 1"
                );
            }
            overlay_phase = 3;
            motion_graphics.push(prepare_video_motion_graphic(
                branch,
                &mut visited,
                graph.timebase.numerator,
                graph.timebase.denominator,
                graph.width,
                graph.height,
            )?);
            if motion_graphics.len() > 4 {
                bail!("common video graph supports at most 4 motion graphic overlays");
            }
        } else {
            match overlay_phase {
                1 => bail!("common video particle overlays must follow video layers"),
                2 => bail!("common video caption overlays must follow video layers"),
                3 => bail!("common video motion graphic overlays must follow video layers"),
                _ => {}
            }
            let mut layer = prepare_video_branch(
                &nodes,
                &branch_tail,
                bindings,
                binding_dir,
                &mut visited,
                graph.timebase.numerator,
                graph.timebase.denominator,
                effect_bindings,
                &mut consumed_effect_bindings,
                display_transform,
                scene_25d.as_ref().map(|scene| &scene.projections),
                graph.width,
                graph.height,
            )?;
            layer.blend_mode = collected.blend_mode;
            layer.composite_opacity = collected.opacity;
            let layer_index = layers.len();
            layer_indices_by_tail.insert(branch_tail.clone(), layer_index);
            if let (Some(matte_tail), Some(matte_mode)) =
                (collected.matte_tail, collected.matte_mode)
            {
                pending_mattes.push((layer_index, matte_tail, matte_mode));
            }
            layers.push(layer);
        }
    }
    if layers.is_empty() {
        bail!("common video graph requires at least one resident video layer");
    }
    if let Some(scene) = scene_25d.as_mut() {
        if !pending_mattes.is_empty()
            || !adjustments.is_empty()
            || !particles.is_empty()
            || !captions.is_empty()
            || !motion_graphics.is_empty()
        {
            bail!(
                "resident 2.5D video planes cannot mix mattes, adjustments, particles, captions, or motion graphics"
            );
        }
        if layers.iter().any(|layer| {
            !layer.visual.projective_enabled
                || layer.visual.scene_depth.is_none()
                || layer.visual.scene_depth_plane.is_none()
                || !layer.visual.grade.is_identity()
                || layer.visual.effect_kind != 0
                || !layer.visual.shader_effects.is_empty()
                || layer.visual.motion_blur.is_some()
                || !layer.visual.keyframes.is_empty()
                || !matches!(layer.blend_mode, BlendMode::Normal)
                || (layer.composite_opacity - 1.0).abs() > 0.000001
        }) {
            bail!(
                "resident 2.5D video planes require static, identity-grade, normal source branches"
            );
        }
        layers.sort_by(|left, right| {
            right
                .visual
                .scene_depth
                .unwrap_or_default()
                .total_cmp(&left.visual.scene_depth.unwrap_or_default())
        });
        scene.coverage.depth_mode = "per_pixel_opaque_plane_depth32float";
        scene.coverage.depth_format = "depth32_float";
        scene.coverage.depth_tested_plane_count = layers.len();
        scene.coverage.depth_pass_count = 1;
        scene.coverage.geometry_executor = "hao-core-native-camera-matrix-depth-plane/v1";
        scene.coverage.pixel_executor = "wgpu-projective-plane-depth-compositor/v1";
    } else if depth_of_field.is_some() {
        bail!("resident camera depth of field cannot execute without native 2.5D depth");
    }
    let mut controllers = prepare_video_controllers(&graph, &nodes, &mut visited)?;
    if scene_25d.is_some() && !controllers.is_empty() {
        bail!("resident 2.5D video planes cannot mix transform-only controllers");
    }
    for (target_index, matte_tail, matte_mode) in pending_mattes {
        let matte_index = *layer_indices_by_tail.get(&matte_tail).with_context(|| {
            format!(
                "common video track matte must reference one visible video branch tail: {matte_tail}"
            )
        })?;
        if target_index == matte_index {
            bail!("common video track matte cannot reference its target layer");
        }
        if !frame_range_contains(
            &layers[matte_index].timeline.range,
            &layers[target_index].timeline.range,
        ) {
            bail!("common video track matte timeline must fully cover its target layer timeline");
        }
        layers[target_index].matte_layer_index = Some(matte_index);
        layers[target_index].matte_mode = Some(matte_mode);
    }
    let mut transform_targets = layers
        .iter()
        .enumerate()
        .filter_map(|(index, layer)| {
            layer
                .transform_node_id
                .as_ref()
                .map(|node_id| (node_id.clone(), EngineVideoParentTarget::Layer(index)))
        })
        .collect::<BTreeMap<_, _>>();
    for (index, controller) in controllers.iter().enumerate() {
        if transform_targets
            .insert(
                controller.transform_node_id.clone(),
                EngineVideoParentTarget::Controller(index),
            )
            .is_some()
        {
            bail!("common video transform identities must be unique");
        }
    }
    let layer_parent_targets = layers
        .iter()
        .map(|layer| {
            let Some(parent_node_id) = layer.parent_transform_node_id.as_ref() else {
                return Ok(None);
            };
            let parent = *transform_targets.get(parent_node_id).with_context(|| {
                format!(
                    "common video transform parent must reference one visible resident video transform or null controller: {parent_node_id}"
                )
            })?;
            let parent_range = match parent {
                EngineVideoParentTarget::Layer(index) => &layers[index].timeline.range,
                EngineVideoParentTarget::Controller(index) => &controllers[index].timeline.range,
            };
            if !frame_range_contains(parent_range, &layer.timeline.range) {
                bail!(
                    "common video transform parent timeline must fully cover its child layer timeline"
                );
            }
            Ok(Some(parent))
        })
        .collect::<Result<Vec<_>>>()?;
    let controller_parent_targets = controllers
        .iter()
        .map(|controller| {
            let Some(parent_node_id) = controller.parent_transform_node_id.as_ref() else {
                return Ok(None);
            };
            let parent = *transform_targets.get(parent_node_id).with_context(|| {
                format!(
                    "common video transform controller parent is missing: {parent_node_id}"
                )
            })?;
            let parent_range = match parent {
                EngineVideoParentTarget::Layer(index) => &layers[index].timeline.range,
                EngineVideoParentTarget::Controller(index) => &controllers[index].timeline.range,
            };
            if !frame_range_contains(parent_range, &controller.timeline.range) {
                bail!("common video transform parent timeline must fully cover its child layer timeline");
            }
            Ok(Some(parent))
        })
        .collect::<Result<Vec<_>>>()?;
    let parent_of = |target: EngineVideoParentTarget| match target {
        EngineVideoParentTarget::Layer(index) => layer_parent_targets[index],
        EngineVideoParentTarget::Controller(index) => controller_parent_targets[index],
    };
    let all_targets = (0..layers.len())
        .map(EngineVideoParentTarget::Layer)
        .chain((0..controllers.len()).map(EngineVideoParentTarget::Controller))
        .collect::<Vec<_>>();
    let mut parent_depths = BTreeMap::new();
    for child in all_targets {
        let mut depth = 0_u32;
        let mut current = child;
        let mut chain = BTreeSet::new();
        chain.insert(child);
        while let Some(parent) = parent_of(current) {
            if !chain.insert(parent) {
                bail!("common video transform parent graph contains a cycle");
            }
            depth += 1;
            if depth > 4 {
                bail!("common video transform parent graph supports at most depth 4");
            }
            current = parent;
        }
        parent_depths.insert(child, depth);
    }
    for (index, layer) in layers.iter_mut().enumerate() {
        layer.parent_layer_index = match layer_parent_targets[index] {
            Some(EngineVideoParentTarget::Layer(parent)) => Some(parent),
            _ => None,
        };
        layer.parent_controller_index = match layer_parent_targets[index] {
            Some(EngineVideoParentTarget::Controller(parent)) => Some(parent),
            _ => None,
        };
        layer.parent_depth = parent_depths[&EngineVideoParentTarget::Layer(index)];
    }
    for (index, controller) in controllers.iter_mut().enumerate() {
        controller.parent_layer_index = match controller_parent_targets[index] {
            Some(EngineVideoParentTarget::Layer(parent)) => Some(parent),
            _ => None,
        };
        controller.parent_controller_index = match controller_parent_targets[index] {
            Some(EngineVideoParentTarget::Controller(parent)) => Some(parent),
            _ => None,
        };
        controller.parent_depth = parent_depths[&EngineVideoParentTarget::Controller(index)];
    }
    let matte_count = layers
        .iter()
        .filter(|layer| layer.matte_layer_index.is_some())
        .count();
    if captions.iter().any(|caption| {
        !layers
            .iter()
            .any(|layer| frame_range_contains(&layer.timeline.range, &caption.timeline))
    }) {
        bail!("common video caption timeline must be fully covered by one resident video layer");
    }
    if motion_graphics.iter().any(|graphic| {
        !layers
            .iter()
            .any(|layer| frame_range_contains(&layer.timeline.range, &graphic.timeline))
    }) {
        bail!(
            "common video motion graphic timeline must be fully covered by one resident video layer"
        );
    }
    if adjustments.iter().any(|adjustment| {
        !layers
            .iter()
            .any(|layer| frame_range_contains(&layer.timeline.range, &adjustment.timeline))
    }) {
        bail!("common video adjustment timeline must be fully covered by one resident video layer");
    }
    if particles
        .iter()
        .filter_map(|particle| particle.timeline.as_ref())
        .any(|timeline| {
            !layers
                .iter()
                .any(|layer| frame_range_contains(&layer.timeline.range, timeline))
        })
    {
        bail!("common video particle timeline must be fully covered by one resident video layer");
    }
    let decoded_temporal_layers = layers
        .iter()
        .enumerate()
        .filter_map(|(index, layer)| {
            layer
                .visual
                .motion_blur
                .as_ref()
                .filter(|motion_blur| {
                    matches!(
                        motion_blur.source_sampling,
                        MotionBlurSourceSampling::DecodedTemporal
                    )
                })
                .map(|motion_blur| (index, motion_blur.sample_count))
        })
        .collect::<Vec<_>>();
    if decoded_temporal_layers.len() > 1 {
        bail!("common video graph supports exactly one decoded temporal motion-blur layer");
    }
    let decoded_temporal_sample_count = decoded_temporal_layers
        .first()
        .map_or(0, |(_, sample_count)| *sample_count);
    let static_particle_video_overlay = layers.len() == 2
        && layers[0].timeline.range.timeline_start_frame
            < layers[1]
                .timeline
                .range
                .timeline_start_frame
                .saturating_add(layers[1].timeline.range.duration_frames)
        && layers[1].timeline.range.timeline_start_frame
            < layers[0]
                .timeline
                .range
                .timeline_start_frame
                .saturating_add(layers[0].timeline.range.duration_frames)
        && layers[1].visual.keyframes.is_empty()
        && layers[1].visual.motion_blur.is_none()
        && layers[1].visual.effect_kind == 0
        && layers[1].visual.shader_effects.is_empty()
        && layers[1].visual.grade.is_identity()
        && matches!(layers[1].blend_mode, BlendMode::Normal)
        && (layers[1].composite_opacity - 1.0).abs() <= 0.000001
        && layers[1].matte_layer_index.is_none();
    let animated_particle_video_overlay = layers.len() == 2
        && layers[0].timeline.range.timeline_start_frame
            < layers[1]
                .timeline
                .range
                .timeline_start_frame
                .saturating_add(layers[1].timeline.range.duration_frames)
        && layers[1].timeline.range.timeline_start_frame
            < layers[0]
                .timeline
                .range
                .timeline_start_frame
                .saturating_add(layers[0].timeline.range.duration_frames)
        && !layers[1].visual.keyframes.is_empty()
        && layers[1].visual.keyframes.len() <= 2
        && layers[1].visual.motion_blur.is_none()
        && layers[1].visual.effect_kind == 0
        && layers[1].visual.shader_effects.is_empty()
        && layers[1].visual.grade.is_identity()
        && matches!(layers[1].blend_mode, BlendMode::Normal)
        && (layers[1].composite_opacity - 1.0).abs() <= 0.000001
        && layers[1].matte_layer_index.is_none();
    let temporal_matte_source_topology =
        decoded_temporal_layers
            .first()
            .is_some_and(|(temporal_layer_index, _)| {
                matte_count == 1
                    && layers.len() == 2
                    && *temporal_layer_index == 0
                    && layers[1].matte_layer_index == Some(0)
            });
    let resource_governed_temporal_matte =
        decoded_temporal_layers
            .first()
            .is_some_and(|(temporal_layer_index, _)| {
                matte_count == 1
                    && layers.len() == 2
                    && *temporal_layer_index == 1
                    && layers[1].matte_layer_index == Some(0)
            });
    let resource_governed_particle_look = (1..=4).contains(&particles.len())
        && particles.iter().all(|particle| particle.timeline.is_some())
        && (layers.len() == 1
            || static_particle_video_overlay
            || animated_particle_video_overlay
            || resource_governed_temporal_matte)
        && adjustments.len() <= 2
        && (matte_count == 0 || resource_governed_temporal_matte);
    if let Some((temporal_layer_index, _)) = decoded_temporal_layers.first() {
        if layers.len() > 3 {
            bail!("decoded temporal motion blur supports at most two independent video overlays");
        }
        if matte_count > 0 {
            if !temporal_matte_source_topology && !resource_governed_temporal_matte {
                bail!(
                    "decoded temporal track matte requires exactly one fully covered static matte source with a temporal target, or the legacy non-ACES temporal matte-source topology"
                );
            }
            if !adjustments.is_empty()
                || !captions.is_empty()
                || !motion_graphics.is_empty()
                || (!particles.is_empty() && !resource_governed_particle_look)
            {
                bail!(
                    "decoded temporal matte topology cannot mix adjustment, caption, motion-graphic, or unbounded particle overlays"
                );
            }
        } else if layers.len() >= 2 && *temporal_layer_index != 0 {
            bail!("decoded temporal motion blur must be the first resident video layer");
        } else if adjustments.len() > 2
            || (!adjustment_before_typography
                && adjustments.len() > 1
                && !resource_governed_particle_look)
            || (!particles.is_empty() && !resource_governed_particle_look)
        {
            bail!(
                "decoded temporal motion blur currently converges with up to two video overlays, bounded typography, at most one legacy trailing adjustment, up to two legacy pre-typography adjustments over one video, one to four resource-governed temporal particle emitters with an optional safe overlay and up to two adjustments, or one exclusive track matte"
            );
        }
    }
    let pre_typography_particles_valid = particles.is_empty() || resource_governed_particle_look;
    if adjustment_before_typography
        && (decoded_temporal_layers.len() != 1
            || !(1..=3).contains(&layers.len())
            || !(1..=2).contains(&adjustments.len())
            || (adjustments.len() == 2
                && layers.len() != 1
                && !(resource_governed_particle_look && layers.len() == 2))
            || !pre_typography_particles_valid
            || matte_count != 0
            || captions.len() + motion_graphics.len() == 0)
    {
        bail!(
            "pre-typography adjustment currently requires one decoded-temporal base, at most two independent video overlays, one adjustment, exactly two legacy adjustments over the single-video base, or one resource-governed static or animated video overlay plus one to four particle emitters and up to two adjustments; third adjustments and matte mixtures remain unsupported"
        );
    }
    let required: BTreeSet<_> = graph.nodes.iter().map(|node| node.id.clone()).collect();
    if visited != required {
        let unreachable = required.difference(&visited).cloned().collect::<Vec<_>>();
        bail!(
            "unreachable common video nodes are not allowed: {}",
            unreachable.join(", ")
        );
    }
    if consumed_effect_bindings.len() != effect_bindings.bindings.len() {
        let orphan = effect_bindings
            .bindings
            .keys()
            .filter(|node_id| !consumed_effect_bindings.contains(*node_id))
            .cloned()
            .collect::<Vec<_>>();
        bail!("orphan GPU effect binding: {}", orphan.join(", "));
    }
    let adaptive_density = layers.len() >= 8;
    let adaptive_cadence_divisor = 2_u32;
    let mut adaptive_layer_count = 0_usize;
    for (index, layer) in layers.iter_mut().enumerate() {
        let maximum_scale =
            layer
                .visual
                .keyframes
                .iter()
                .fold(layer.visual.scale.abs(), |maximum, keyframe| {
                    maximum
                        .max(keyframe.scale_x.abs())
                        .max(keyframe.scale_y.abs())
                });
        if adaptive_density && index > 0 && maximum_scale <= 0.25 {
            layer.decode_cadence_divisor = adaptive_cadence_divisor;
            layer.decode_cadence_phase = index as u32 % adaptive_cadence_divisor;
            adaptive_layer_count += 1;
        }
    }
    let decode_schedule = ResidentVideoDecodeSchedule {
        schema: "editkin.resident-video-decode-schedule/v1",
        full_rate_layer_count: layers.len() - adaptive_layer_count,
        adaptive_layer_count,
        maximum_decode_cadence_divisor: if adaptive_layer_count > 0 {
            adaptive_cadence_divisor
        } else {
            1
        },
        maximum_reuse_age_frames: if adaptive_layer_count > 0 {
            adaptive_cadence_divisor - 1
        } else {
            0
        },
    };
    let resource_plan = resident_video_resource_plan(
        graph.width,
        graph.height,
        graph.cache_budget_mb,
        layers.len(),
        particles.len() + captions.len() + motion_graphics.len(),
        particles.len(),
        adjustments.len(),
        matte_count,
        decoded_temporal_sample_count,
        if display_transform.is_aces2() {
            8
        } else {
            BGRA_BYTES_PER_PIXEL
        },
        u32::from(scene_25d.is_some()),
        u32::from(depth_of_field.is_some()),
    )?;
    if display_transform.is_aces2() {
        let decoded_temporal_layers = layers
            .iter()
            .enumerate()
            .filter_map(|(index, layer)| {
                layer
                    .visual
                    .motion_blur
                    .as_ref()
                    .is_some_and(|motion_blur| {
                        matches!(
                            motion_blur.source_sampling,
                            MotionBlurSourceSampling::DecodedTemporal
                        )
                    })
                    .then_some(index)
            })
            .collect::<BTreeSet<_>>();
        if layers.iter().any(|layer| {
            layer
                .matte_layer_index
                .is_some_and(|matte_index| decoded_temporal_layers.contains(&matte_index))
        }) {
            bail!(
                "resident scene-linear ACES2 video keeps decoded-temporal track-matte sources fail-closed"
            );
        }
    }
    Ok(PreparedEngineVideoGraph {
        width: graph.width,
        height: graph.height,
        coverage: EngineExecutionCoverage {
            graph_schema: COMMON_GRAPH_SCHEMA,
            graph_id: graph.graph_id,
            direct_execution: true,
            requested_working_format: format_name(graph.working_format).to_owned(),
            execution_format: "rgba32_float",
            artifact_format: "native_swap_chain",
            executed_node_ids: compiled
                .passes
                .into_iter()
                .map(|pass| pass.node_id)
                .collect(),
            blocked_node_ids: vec![],
            ignored_node_ids: vec![],
        },
        resource_plan,
        decode_schedule,
        display_transform,
        scene_25d: scene_25d.map(|scene| scene.coverage),
        depth_of_field,
        layers,
        controllers,
        adjustments,
        adjustment_before_typography,
        particles,
        captions,
        motion_graphics,
        vfx_simulation,
    })
}

fn prepare_video_particle(
    node: &EngineNode,
    visited: &mut BTreeSet<String>,
    timebase_numerator: u32,
    timebase_denominator: u32,
) -> Result<EngineVideoParticlePlan> {
    if !visited.insert(node.id.clone()) {
        bail!(
            "common video graph contains a shared particle emitter at {}",
            node.id
        );
    }
    if !node.enabled || !node.inputs.is_empty() {
        bail!(
            "common video particle emitter must be an enabled source overlay: {}",
            node.id
        );
    }
    let NodeOperation::ParticleEmitter {
        timeline,
        seed,
        rate_per_second,
        lifetime_seconds,
        initial_velocity,
        gravity,
        max_particles,
        emitter_position,
        radius_pixels,
        color,
    } = &node.operation
    else {
        bail!("common video branch is not a particle emitter: {}", node.id);
    };
    Ok(EngineVideoParticlePlan {
        node_id: node.id.clone(),
        timeline: timeline.clone(),
        seed: u32::try_from(*seed).context("particle seed exceeds u32")?,
        rate_per_second: *rate_per_second,
        lifetime_seconds: *lifetime_seconds,
        initial_velocity: [initial_velocity[0], initial_velocity[1]],
        gravity: [gravity[0], gravity[1]],
        max_particles: *max_particles,
        emitter_position: *emitter_position,
        radius_pixels: *radius_pixels,
        color: *color,
        timebase_numerator,
        timebase_denominator,
    })
}

fn frame_range_contains(outer: &NodeFrameRange, inner: &NodeFrameRange) -> bool {
    outer.timeline_start_frame <= inner.timeline_start_frame
        && inner
            .timeline_start_frame
            .saturating_add(inner.duration_frames)
            <= outer
                .timeline_start_frame
                .saturating_add(outer.duration_frames)
}

fn prepare_video_caption(
    node: &EngineNode,
    visited: &mut BTreeSet<String>,
) -> Result<EngineVideoCaptionPlan> {
    if !visited.insert(node.id.clone()) {
        bail!(
            "common video graph contains a shared caption at {}",
            node.id
        );
    }
    if !node.enabled || !node.inputs.is_empty() {
        bail!(
            "common video caption {} must be an enabled source overlay",
            node.id
        );
    }
    let NodeOperation::Caption {
        cue_id,
        text,
        timeline,
        font_family,
        font_size,
        text_color,
        outline_color,
        outline_width,
        background_color,
        alignment,
        margin_vertical,
        bold,
        italic,
        shadow,
        letter_spacing,
        translation,
    } = &node.operation
    else {
        bail!("common video branch is not a caption: {}", node.id);
    };
    if text.chars().count() > 256 {
        bail!("common video caption text supports at most 256 characters");
    }
    if !(8.0..=192.0).contains(font_size)
        || !(0.0..=12.0).contains(outline_width)
        || !(0.0..=4096.0).contains(margin_vertical)
    {
        bail!("common video caption geometry is outside the bounded contract");
    }
    if *italic {
        bail!("common video caption italic variants are not supported yet");
    }
    if !(0.0..=10.0).contains(shadow) || !(-5.0..=20.0).contains(letter_spacing) {
        bail!("common video caption shadow or letter spacing is outside the bounded contract");
    }
    if translation
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        bail!("common video caption translation requires a separate measured layout contract");
    }
    Ok(EngineVideoCaptionPlan {
        node_id: node.id.clone(),
        cue_id: cue_id.clone(),
        text: text.clone(),
        timeline: timeline.clone(),
        font_family: font_family.clone(),
        font_size: *font_size,
        text_color: text_color.clone(),
        outline_color: outline_color.clone(),
        outline_width: *outline_width,
        background_color: background_color.clone(),
        alignment: *alignment,
        margin_vertical: *margin_vertical,
        bold: *bold,
        shadow: *shadow,
        letter_spacing: *letter_spacing,
    })
}

fn prepare_video_motion_graphic(
    node: &EngineNode,
    visited: &mut BTreeSet<String>,
    timebase_numerator: u32,
    timebase_denominator: u32,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<EngineVideoMotionGraphicPlan> {
    if !visited.insert(node.id.clone()) {
        bail!(
            "common video graph contains a shared motion graphic at {}",
            node.id
        );
    }
    if !node.enabled || !node.inputs.is_empty() {
        bail!(
            "common video motion graphic {} must be an enabled source overlay",
            node.id
        );
    }
    let NodeOperation::MotionGraphic {
        graphic_id,
        graphic_kind,
        text,
        timeline,
        x,
        y,
        width,
        font_size,
        font_family,
        font_weight,
        letter_spacing,
        outline_width,
        shadow_depth,
        corner_radius,
        text_color,
        background_color,
        accent_color,
        visual_style,
        animation,
        tracking_mode,
        offset_x,
        offset_y,
        tracking,
    } = &node.operation
    else {
        bail!("common video branch is not a motion graphic: {}", node.id);
    };
    if text.chars().count() > 128 {
        bail!("common video motion graphic text supports at most 128 characters");
    }
    if !matches!(
        animation.as_str(),
        "fade" | "slide_up" | "pop" | "spring_soft"
    ) {
        bail!("common video motion graphic supports fade, slide_up, pop, or spring_soft only");
    }
    if !matches!(
        visual_style.as_str(),
        "solid_panel"
            | "holo_scan_cyan"
            | "holo_grid_lime"
            | "target_lock_red"
            | "spectral_wire_violet"
            | "depth_glass_blue"
            | "telemetry_beam_amber"
            | "neon_extrude_white"
            | "quantum_label_magenta"
    ) {
        bail!("common video motion graphic has an unsupported visual style");
    }
    if tracking.is_none() && (*offset_x != 0.0 || *offset_y != 0.0) {
        bail!("common video motion graphic offsets require tracking samples");
    }
    if !matches!(tracking_mode.as_str(), "anchor" | "surface") {
        bail!("common video motion graphic has an unsupported tracking mode");
    }
    if tracking_mode == "surface" && (tracking.is_none() || animation != "fade") {
        bail!("common video surface motion graphic requires tracked fade animation");
    }
    if !(0.0..=1.0).contains(x)
        || !(0.0..=1.0).contains(y)
        || !(0.05..=1.0).contains(width)
        || !(8.0..=192.0).contains(font_size)
        || !(100..=900).contains(font_weight)
        || !(-5.0..=20.0).contains(letter_spacing)
        || !(0.0..=12.0).contains(outline_width)
        || !(0.0..=10.0).contains(shadow_depth)
        || !(0.0..=96.0).contains(corner_radius)
    {
        bail!("common video motion graphic geometry is outside the bounded contract");
    }
    let box_height = (font_size * 1.25).ceil() + (font_size * 0.36).ceil() * 2.0;
    if tracking_mode == "anchor"
        && let Some(tracking) = tracking
    {
        if tracking.samples.iter().any(|sample| {
            let width_pixels = width * canvas_width as f32;
            let cosine = sample.rotation_radians.cos().abs();
            let sine = sample.rotation_radians.sin().abs();
            let bounds_width = sample.scale * (cosine * width_pixels + sine * box_height);
            let bounds_height = sample.scale * (sine * width_pixels + cosine * box_height);
            let center_x = sample.x * canvas_width as f32 + width_pixels * 0.5;
            let center_y = sample.y * canvas_height as f32 + box_height * 0.5;
            let margin_x = canvas_width as f32 * 0.02;
            let margin_y = canvas_height as f32 * 0.02;
            center_x - bounds_width * 0.5 < margin_x - f32::EPSILON
                || center_x + bounds_width * 0.5 > canvas_width as f32 - margin_x + f32::EPSILON
                || center_y - bounds_height * 0.5 < margin_y - f32::EPSILON
                || center_y + bounds_height * 0.5 > canvas_height as f32 - margin_y + f32::EPSILON
        }) {
            bail!("common video motion graphic tracking samples exceed the transformed safe area");
        }
    }
    let frames_for_ms = |milliseconds: u64| {
        let divisor = 1_000_u64.saturating_mul(timebase_numerator as u64);
        milliseconds
            .saturating_mul(timebase_denominator as u64)
            .saturating_add(divisor / 2)
            / divisor.max(1)
    };
    Ok(EngineVideoMotionGraphicPlan {
        node_id: node.id.clone(),
        graphic_id: graphic_id.clone(),
        graphic_kind: graphic_kind.clone(),
        text: text.clone(),
        timeline: timeline.clone(),
        x: *x,
        y: *y,
        width: *width,
        font_size: *font_size,
        font_family: font_family.clone(),
        font_weight: *font_weight,
        letter_spacing: *letter_spacing,
        outline_width: *outline_width,
        shadow_depth: *shadow_depth,
        corner_radius: *corner_radius,
        text_color: text_color.clone(),
        background_color: background_color.clone(),
        accent_color: accent_color.clone(),
        visual_style: visual_style.clone(),
        animation: animation.clone(),
        tracking_mode: tracking_mode.clone(),
        fade_in_frames: frames_for_ms(180).min(timeline.duration_frames / 2),
        fade_out_frames: frames_for_ms(140).min(timeline.duration_frames / 2),
        track_id: tracking.as_ref().map(|tracking| tracking.track_id.clone()),
        tracking_samples: tracking
            .as_ref()
            .map(|tracking| tracking.samples.clone())
            .unwrap_or_default(),
        canvas_width,
        canvas_height,
    })
}

fn adjustment_chain_reaches_adjustment(nodes: &BTreeMap<&str, &EngineNode>, start: &str) -> bool {
    let mut current = start;
    for _ in 0..4 {
        let Some(node) = nodes.get(current).copied() else {
            return false;
        };
        match &node.operation {
            NodeOperation::Adjustment { .. } => return true,
            NodeOperation::Color { .. } | NodeOperation::Effect { .. }
                if node.inputs.len() == 1 =>
            {
                current = &node.inputs[0];
            }
            _ => return false,
        }
    }
    false
}

fn gpu_effect_program_sha256(binding: &GpuEffectBinding) -> String {
    let mut digest = Sha256::new();
    fn write_string(digest: &mut Sha256, value: &str) {
        digest.update((value.len() as u32).to_le_bytes());
        digest.update(value.as_bytes());
    }
    write_string(&mut digest, GPU_EFFECT_GRAPH_SCHEMA);
    write_string(&mut digest, &binding.plugin_identity);
    digest.update((binding.parameters.len() as u32).to_le_bytes());
    for (key, value) in &binding.parameters {
        write_string(&mut digest, key);
        digest.update(value.to_le_bytes());
    }
    digest.update((binding.operations.len() as u32).to_le_bytes());
    for operation in &binding.operations {
        digest.update(operation.opcode.to_le_bytes());
        for argument in operation.args {
            digest.update(argument.to_le_bytes());
        }
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_gpu_effect_operation(operation: &GpuEffectOperation) -> Result<()> {
    if operation.args.iter().any(|value| !value.is_finite()) {
        bail!("GPU effect operation contains non-finite arguments");
    }
    let bounds: &[(f32, f32)] = match operation.opcode {
        1 => &[(0.0, 8.0)],
        2 | 3 => &[(0.0, 1.0)],
        4 => &[(0.0, 4.0)],
        5 => &[(0.0, 4.0), (0.0, 1.0)],
        6 => &[(0.0, 2.0), (0.0, 2.0), (0.0, 2.0)],
        7 => &[(2.0, 64.0)],
        8 => &[(0.0, 1.0), (0.0, 1.5), (0.001, 1.0)],
        9 => &[(-std::f32::consts::PI, std::f32::consts::PI)],
        10 => &[(-0.5, 0.5), (0.1, 4.0), (0.0, 4.0)],
        11 => &[(0.0, 1.0), (0.0, 1.0), (0.0, 1.0)],
        12 => &[(-1.0, 1.0), (-1.0, 1.0)],
        _ => bail!("unsupported GPU effect opcode: {}", operation.opcode),
    };
    for (index, &(minimum, maximum)) in bounds.iter().enumerate() {
        if !(minimum..=maximum).contains(&operation.args[index]) {
            bail!("GPU effect operation argument is out of bounds");
        }
    }
    if operation.args[bounds.len()..]
        .iter()
        .any(|value| value.abs() > f32::EPSILON)
    {
        bail!("GPU effect operation has non-zero unused arguments");
    }
    Ok(())
}

fn lower_video_effect(
    node: &EngineNode,
    plugin_id: &str,
    abi_version: u32,
    temporal_radius: u32,
    parameters: &BTreeMap<String, f64>,
    visual: &mut EngineVideoVisualPlan,
    effect_bindings: &GpuEffectBindings,
    consumed_effect_bindings: &mut BTreeSet<String>,
) -> Result<()> {
    if abi_version != 1 || temporal_radius != 0 {
        bail!("unsupported common video effect contract: {plugin_id}");
    }
    visual.effect_kind = match plugin_id {
        "editkin.builtin.mono_halftone" if parameters.is_empty() => {
            if visual.effect_kind != 0 || !visual.shader_effects.is_empty() {
                bail!(
                    "built-in effects cannot be stacked or mixed with third-party GPU effects on one visual"
                );
            }
            1
        }
        "editkin.builtin.xerox_pulse" if parameters.is_empty() => {
            if visual.effect_kind != 0 || !visual.shader_effects.is_empty() {
                bail!(
                    "built-in effects cannot be stacked or mixed with third-party GPU effects on one visual"
                );
            }
            2
        }
        value if value.starts_with("editkin.builtin.") => {
            bail!("unsupported common video effect: {plugin_id}")
        }
        _ => {
            if visual.effect_kind != 0 {
                bail!(
                    "built-in effects cannot be stacked or mixed with third-party GPU effects on one visual"
                );
            }
            let binding = effect_bindings
                .bindings
                .get(&node.id)
                .with_context(|| format!("missing GPU effect binding: {}", node.id))?;
            if binding.schema != GPU_EFFECT_GRAPH_SCHEMA || binding.node_id != node.id {
                bail!("GPU effect binding node identity mismatch: {}", node.id);
            }
            if binding.plugin_identity != plugin_id {
                bail!("GPU effect binding identity mismatch: {}", node.id);
            }
            if &binding.parameters != parameters {
                bail!("GPU effect binding parameters mismatch: {}", node.id);
            }
            if binding.operations.is_empty() || binding.operations.len() > 4 {
                bail!("GPU effect graph supports at most 4 operations");
            }
            if visual.shader_effects.len() >= MAX_GPU_EFFECT_GRAPHS_PER_VISUAL {
                bail!("GPU effect stack supports at most 4 graphs per visual");
            }
            if visual
                .shader_effects
                .iter()
                .map(|effect| effect.operations.len())
                .sum::<usize>()
                + binding.operations.len()
                > MAX_GPU_EFFECT_OPERATIONS_PER_VISUAL
            {
                bail!("GPU effect stack supports at most 16 operations per visual");
            }
            for operation in &binding.operations {
                validate_gpu_effect_operation(operation)?;
            }
            if binding.program_sha256.len() != 64
                || !binding
                    .program_sha256
                    .bytes()
                    .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
                || gpu_effect_program_sha256(binding) != binding.program_sha256
            {
                bail!("GPU effect program hash mismatch: {}", node.id);
            }
            if !consumed_effect_bindings.insert(node.id.clone()) {
                bail!(
                    "GPU effect binding was consumed more than once: {}",
                    node.id
                );
            }
            // Graph lowering walks from output back to source. Insert at the front so the
            // executable operation order remains the user's source-to-output stack order.
            visual.shader_effects.insert(
                0,
                EngineVideoShaderEffectPlan {
                    node_id: node.id.clone(),
                    plugin_identity: binding.plugin_identity.clone(),
                    program_sha256: binding.program_sha256.clone(),
                    operations: binding.operations.clone(),
                },
            );
            0
        }
    };
    Ok(())
}

fn prepare_video_adjustment(
    nodes: &BTreeMap<&str, &EngineNode>,
    start: &str,
    visited: &mut BTreeSet<String>,
    effect_bindings: &GpuEffectBindings,
    consumed_effect_bindings: &mut BTreeSet<String>,
    display_transform: EngineDisplayTransform,
) -> Result<(String, EngineVideoAdjustmentPlan)> {
    let mut current = start;
    let mut node_ids = Vec::new();
    let mut visual = EngineVideoVisualPlan::default();
    let mut color_seen = false;
    loop {
        let node = nodes
            .get(current)
            .copied()
            .with_context(|| format!("missing common video adjustment node: {current}"))?;
        if !visited.insert(node.id.clone()) {
            bail!(
                "common video adjustment graph contains a shared or cyclic node at {}",
                node.id
            );
        }
        if !node.enabled {
            bail!(
                "common video adjustment node cannot be disabled: {}",
                node.id
            );
        }
        node_ids.push(node.id.clone());
        match &node.operation {
            NodeOperation::Color {
                processor,
                input_space,
                working_space,
                output_space,
                grade,
            } => {
                let valid_color = if display_transform.is_aces2() {
                    (processor == "editkin-linear-primary/v1" || processor == "editkin-linear-primary/v2")
                        && input_space == "linear_rec709"
                        && working_space == "linear_rec709"
                        && output_space == "linear_rec709"
                } else {
                    (processor == "editkin-rec709-primary/v1" || processor == "editkin-rec709-primary/v2")
                        && input_space == "rec709"
                        && working_space == "rec709"
                        && output_space == "rec709_sdr"
                };
                if color_seen || !valid_color {
                    bail!(
                        "unsupported common video adjustment color processor on {}",
                        node.id
                    );
                }
                hao_core::engine::white_balance::validate_contract(processor, *grade).map_err(anyhow::Error::msg)?;
                validate_common_video_grade(*grade)?;
                visual.grade = *grade;
                visual.primary_processor_version = if hao_core::engine::white_balance::is_v2(processor) { 2 } else { 1 };
                color_seen = true;
                if node.inputs.len() != 1 {
                    bail!(
                        "common video adjustment color {} requires exactly one input",
                        node.id
                    );
                }
                current = &node.inputs[0];
            }
            NodeOperation::Effect {
                plugin_id,
                abi_version,
                temporal_radius,
                parameters,
            } => {
                lower_video_effect(
                    node,
                    plugin_id,
                    *abi_version,
                    *temporal_radius,
                    parameters,
                    &mut visual,
                    effect_bindings,
                    consumed_effect_bindings,
                )?;
                if node.inputs.len() != 1 {
                    bail!(
                        "common video adjustment effect {} requires exactly one input",
                        node.id
                    );
                }
                current = &node.inputs[0];
            }
            NodeOperation::Adjustment {
                affected_inputs,
                timeline,
            } => {
                if node.inputs.len() != 1 || affected_inputs != &node.inputs {
                    bail!("common video adjustment must target exactly its one direct input");
                }
                let timeline = timeline
                    .clone()
                    .context("common video adjustment requires an explicit timeline")?;
                return Ok((
                    node.inputs[0].clone(),
                    EngineVideoAdjustmentPlan {
                        node_ids,
                        timeline,
                        visual,
                    },
                ));
            }
            operation => bail!(
                "unsupported common video adjustment node kind: {}",
                operation.kind_name()
            ),
        }
    }
}

fn collect_video_branch_tails(
    nodes: &BTreeMap<&str, &EngineNode>,
    current: &str,
    visited: &mut BTreeSet<String>,
    branch_tails: &mut Vec<CollectedVideoBranch>,
) -> Result<()> {
    let node = nodes
        .get(current)
        .copied()
        .with_context(|| format!("missing engine node: {current}"))?;
    let NodeOperation::Composite {
        blend_mode,
        opacity,
        matte_input,
        matte_mode,
    } = &node.operation
    else {
        branch_tails.push(CollectedVideoBranch {
            tail: node.id.clone(),
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            matte_tail: None,
            matte_mode: None,
        });
        if branch_tails.len() > 14 {
            bail!(
                "common video graph supports at most 14 video/particle/caption/motion-graphic branches"
            );
        }
        return Ok(());
    };
    if !visited.insert(node.id.clone()) {
        bail!(
            "common video graph contains a shared or cyclic composite at {}",
            node.id
        );
    }
    if !node.enabled {
        bail!("common video graph node cannot be disabled: {}", node.id);
    }
    if !opacity.is_finite() || !(0.0..=1.0).contains(opacity) {
        bail!("common video composite opacity must be finite and within 0..=1");
    }
    if node.inputs.len() != 2 {
        bail!("common video composite requires exactly two inputs");
    }
    if nodes
        .get(node.inputs[1].as_str())
        .is_some_and(|input| matches!(input.operation, NodeOperation::Composite { .. }))
    {
        bail!("right-nested common video composite is not supported; use canonical layer order");
    }
    collect_video_branch_tails(nodes, &node.inputs[0], visited, branch_tails)?;
    let previous_len = branch_tails.len();
    collect_video_branch_tails(nodes, &node.inputs[1], visited, branch_tails)?;
    if branch_tails.len() != previous_len + 1 {
        bail!("common video composite upper input must resolve to exactly one layer");
    }
    let upper = branch_tails
        .last_mut()
        .context("common video composite lost its upper layer")?;
    upper.blend_mode = gpu_blend(*blend_mode);
    upper.opacity = *opacity;
    upper.matte_tail = matte_input.clone();
    upper.matte_mode = *matte_mode;
    Ok(())
}

/// Peels only canonical outer caption/motion-graphic composites when their lower branch reaches
/// an adjustment. The returned order is inner-to-outer, matching the ordinary branch collector.
/// Nothing is marked visited until the caller commits to this exact bounded topology.
fn peel_post_adjustment_typography(
    nodes: &BTreeMap<&str, &EngineNode>,
    start: &str,
) -> Result<Option<(String, Vec<CollectedVideoBranch>, Vec<String>)>> {
    let mut current = start.to_owned();
    let mut typography = Vec::new();
    let mut composite_ids = Vec::new();
    loop {
        let Some(node) = nodes.get(current.as_str()).copied() else {
            bail!("missing engine node: {current}");
        };
        let NodeOperation::Composite {
            blend_mode,
            opacity,
            matte_input,
            matte_mode,
        } = &node.operation
        else {
            break;
        };
        if !node.enabled || node.inputs.len() != 2 {
            break;
        }
        let Some(upper) = nodes.get(node.inputs[1].as_str()).copied() else {
            bail!("missing engine node: {}", node.inputs[1]);
        };
        if !matches!(
            upper.operation,
            NodeOperation::Caption { .. } | NodeOperation::MotionGraphic { .. }
        ) {
            break;
        }
        if !matches!(blend_mode, EngineBlendMode::Normal)
            || (*opacity - 1.0).abs() > 0.000001
            || matte_input.is_some()
            || matte_mode.is_some()
        {
            bail!(
                "post-adjustment typography composite requires normal blend, opacity 1, and no matte"
            );
        }
        typography.push(CollectedVideoBranch {
            tail: upper.id.clone(),
            blend_mode: gpu_blend(*blend_mode),
            opacity: *opacity,
            matte_tail: None,
            matte_mode: None,
        });
        composite_ids.push(node.id.clone());
        current = node.inputs[0].clone();
    }
    if typography.is_empty() || !adjustment_chain_reaches_adjustment(nodes, &current) {
        return Ok(None);
    }
    typography.reverse();
    Ok(Some((current, typography, composite_ids)))
}

fn prepare_video_controllers(
    graph: &EngineGraph,
    nodes: &BTreeMap<&str, &EngineNode>,
    visited: &mut BTreeSet<String>,
) -> Result<Vec<EngineVideoControllerPlan>> {
    let mut controllers = Vec::new();
    for source in &graph.nodes {
        let NodeOperation::Source {
            asset_id,
            media_kind,
            input_color_space,
            alpha_mode: _,
            timeline,
        } = &source.operation
        else {
            continue;
        };
        if media_kind != "generator" {
            continue;
        }
        if asset_id != "editkin.generator.null" {
            bail!(
                "common video transform controller requires assetId editkin.generator.null on {}",
                source.id
            );
        }
        if !source.inputs.is_empty() || input_color_space.as_deref() != Some("rec709") {
            bail!(
                "common video transform controller source is invalid on {}",
                source.id
            );
        }
        let range = timeline.clone().context(format!(
            "common video transform controller source {} requires a timeline",
            source.id
        ))?;
        let consumers = graph
            .nodes
            .iter()
            .filter(|candidate| candidate.inputs.len() == 1 && candidate.inputs[0] == source.id)
            .collect::<Vec<_>>();
        if consumers.len() != 1 {
            bail!(
                "common video transform controller source {} must feed exactly one transform",
                source.id
            );
        }
        let transform = consumers[0];
        let NodeOperation::Transform2d {
            x,
            y,
            scale_x,
            scale_y,
            rotation_radians,
            opacity,
            keyframes,
            parent,
        } = &transform.operation
        else {
            bail!(
                "common video transform controller source {} must feed transform2d",
                source.id
            );
        };
        if !source.enabled
            || !transform.enabled
            || !x.is_finite()
            || !y.is_finite()
            || !scale_x.is_finite()
            || !scale_y.is_finite()
            || !rotation_radians.is_finite()
            || !opacity.is_finite()
            || (*scale_x - *scale_y).abs() > 0.000001
            || *scale_x <= 0.0001
            || !(0.0..=1.0).contains(opacity)
        {
            bail!(
                "common video transform controller has invalid visual values on {}",
                transform.id
            );
        }
        for keyframe in keyframes {
            if (keyframe.scale_x - keyframe.scale_y).abs() > 0.000001 {
                bail!(
                    "common video transform controller keyframes require uniform scale on {}",
                    transform.id
                );
            }
        }
        if keyframes
            .first()
            .is_some_and(|keyframe| keyframe.frame == 0)
            || keyframes
                .last()
                .is_some_and(|keyframe| keyframe.frame > range.duration_frames)
        {
            bail!(
                "common video transform controller keyframes exceed the bounded timeline on {}",
                transform.id
            );
        }
        if !visited.insert(source.id.clone()) || !visited.insert(transform.id.clone()) {
            bail!(
                "common video transform controller overlaps a rendered branch at {}",
                transform.id
            );
        }
        controllers.push(EngineVideoControllerPlan {
            source_node_id: source.id.clone(),
            transform_node_id: transform.id.clone(),
            timeline: EngineVideoTimelinePlan {
                range,
                timebase_numerator: graph.timebase.numerator,
                timebase_denominator: graph.timebase.denominator,
            },
            visual: EngineVideoVisualPlan {
                input_transfer: 0,
                primary_processor_version: 1,
                translate_x: *x,
                translate_y: *y,
                scale: *scale_x,
                rotation: *rotation_radians,
                opacity: *opacity,
                projective: [0.0; 8],
                projective_enabled: false,
                shade: [1.0; 3],
                scene_depth: None,
                scene_depth_plane: None,
                effect_kind: 0,
                shader_effects: Vec::new(),
                grade: PrimaryGrade::default(),
                motion_blur: None,
                keyframes: keyframes.clone(),
            },
            parent_transform_node_id: parent.clone(),
            parent_layer_index: None,
            parent_controller_index: None,
            parent_depth: 0,
        });
        if controllers.len() > 8 {
            bail!("common video graph supports at most 8 transform controllers");
        }
    }
    // The controller source lookup above is intentionally exact; a reference to a normal source
    // or an arbitrary generator must never be interpreted as a transform-only parent.
    for controller in &controllers {
        if !nodes.contains_key(controller.transform_node_id.as_str()) {
            bail!("common video transform controller disappeared during lowering");
        }
    }
    Ok(controllers)
}

#[allow(clippy::too_many_arguments)]
fn prepare_video_branch(
    nodes: &BTreeMap<&str, &EngineNode>,
    start: &str,
    bindings: &BTreeMap<String, PathBuf>,
    binding_dir: &Path,
    visited: &mut BTreeSet<String>,
    timebase_numerator: u32,
    timebase_denominator: u32,
    effect_bindings: &GpuEffectBindings,
    consumed_effect_bindings: &mut BTreeSet<String>,
    display_transform: EngineDisplayTransform,
    scene_planes: Option<&BTreeMap<String, ScenePlaneProjection>>,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<PreparedEngineVideoLayer> {
    let mut current = start;
    let mut visual = EngineVideoVisualPlan::default();
    let mut transform_seen = false;
    let mut motion_blur_seen = false;
    let mut outer_visual_before_motion_blur = false;
    let mut color_seen = false;
    let mut physical_color_seen = false;
    let mut transform_node_id = None;
    let mut parent_transform_node_id = None;
    let mut precompositions = Vec::<(String, String, NodeFrameRange)>::new();
    loop {
        let node = nodes
            .get(current)
            .copied()
            .with_context(|| format!("missing engine node: {current}"))?;
        if !visited.insert(node.id.clone()) {
            bail!(
                "common video graph contains a shared or cyclic branch at {}",
                node.id
            );
        }
        if !node.enabled {
            bail!("common video graph node cannot be disabled: {}", node.id);
        }
        match &node.operation {
            NodeOperation::Color {
                processor,
                input_space,
                working_space,
                output_space,
                grade,
            } => {
                let physical = hao_core::engine::white_balance::is_v2(processor);
                if color_seen && (physical || physical_color_seen) {
                    bail!("stacked v2 source color processors require ordered execution; refusing to discard a white-balance stage on {}", node.id);
                }
                color_seen = true;
                physical_color_seen |= physical;
                if !motion_blur_seen {
                    outer_visual_before_motion_blur = true;
                }
                let valid_color = if display_transform.is_aces2() {
                    (processor == "editkin-srgb-to-linear-rec709-primary/v1" || processor == "editkin-rec709-to-linear-rec709-primary/v2")
                        && input_space == "rec709"
                        && working_space == "linear_rec709"
                        && output_space == "linear_rec709"
                } else {
                    (processor == "editkin-rec709-primary/v1" || processor == "editkin-rec709-primary/v2")
                        && input_space == "rec709"
                        && working_space == "rec709"
                        && output_space == "rec709_sdr"
                };
                if !valid_color {
                    bail!(
                        "common video executor requires the display-contract primary processor on {}",
                        node.id
                    );
                }
                hao_core::engine::white_balance::validate_contract(processor, *grade).map_err(anyhow::Error::msg)?;
                validate_common_video_grade(*grade)?;
                visual.grade = *grade;
                visual.input_transfer = if processor == "editkin-rec709-to-linear-rec709-primary/v2" { 2 } else { 1 };
                visual.primary_processor_version = if hao_core::engine::white_balance::is_v2(processor) { 2 } else { 1 };
                if node.inputs.len() != 1 {
                    bail!("common video color {} requires exactly one input", node.id);
                }
                current = &node.inputs[0];
            }
            NodeOperation::Transform2d {
                x,
                y,
                scale_x,
                scale_y,
                rotation_radians,
                opacity,
                keyframes,
                parent,
            } => {
                if !motion_blur_seen {
                    outer_visual_before_motion_blur = true;
                }
                if transform_seen {
                    bail!(
                        "stacked common video transforms are not supported on {}",
                        node.id
                    );
                }
                if !x.is_finite()
                    || !y.is_finite()
                    || !scale_x.is_finite()
                    || !scale_y.is_finite()
                    || !rotation_radians.is_finite()
                    || !opacity.is_finite()
                    || (*scale_x - *scale_y).abs() > 0.000001
                    || *scale_x <= 0.0001
                    || !(0.0..=1.0).contains(opacity)
                {
                    bail!(
                        "common video transform requires finite uniform positive scale and opacity within 0..=1 on {}",
                        node.id
                    );
                }
                if node.inputs.len() != 1 {
                    bail!(
                        "common video transform {} requires exactly one input",
                        node.id
                    );
                }
                visual.translate_x = *x;
                visual.translate_y = *y;
                visual.scale = *scale_x;
                visual.rotation = *rotation_radians;
                visual.opacity = *opacity;
                for keyframe in keyframes {
                    if (keyframe.scale_x - keyframe.scale_y).abs() > 0.000001 {
                        bail!(
                            "common video transform keyframes require uniform scale on {}",
                            node.id
                        );
                    }
                }
                if keyframes
                    .first()
                    .is_some_and(|keyframe| keyframe.frame == 0)
                {
                    bail!(
                        "common video transform keyframes must start after frame 0 on {}",
                        node.id
                    );
                }
                visual.keyframes = keyframes.clone();
                transform_node_id = Some(node.id.clone());
                parent_transform_node_id = parent.clone();
                transform_seen = true;
                current = &node.inputs[0];
            }
            NodeOperation::Transform3d { .. } => {
                if !motion_blur_seen {
                    outer_visual_before_motion_blur = true;
                }
                if transform_seen {
                    bail!(
                        "stacked common video transforms are not supported on {}",
                        node.id
                    );
                }
                if node.inputs.len() != 1 {
                    bail!(
                        "common video 2.5D transform {} requires exactly one input",
                        node.id
                    );
                }
                let projection = scene_planes
                    .and_then(|projections| projections.get(node.id.as_str()))
                    .with_context(|| {
                        format!("missing resident video 2.5D projection for {}", node.id)
                    })?;
                visual
                    .apply_scene_projection(projection, canvas_width, canvas_height)
                    .with_context(|| format!("project resident video 2.5D plane {}", node.id))?;
                transform_node_id = Some(node.id.clone());
                // Parenting is already resolved by the native camera oracle into the final
                // projective transform. Do not apply the separate 2D parent compositor again.
                parent_transform_node_id = None;
                transform_seen = true;
                current = &node.inputs[0];
            }
            NodeOperation::Effect {
                plugin_id,
                abi_version,
                temporal_radius,
                parameters,
            } => {
                if !motion_blur_seen {
                    outer_visual_before_motion_blur = true;
                }
                lower_video_effect(
                    node,
                    plugin_id,
                    *abi_version,
                    *temporal_radius,
                    parameters,
                    &mut visual,
                    effect_bindings,
                    consumed_effect_bindings,
                )?;
                if node.inputs.len() != 1 {
                    bail!("common video effect {} requires exactly one input", node.id);
                }
                current = &node.inputs[0];
            }
            NodeOperation::MotionBlur {
                shutter_angle,
                samples,
                source_sampling,
            } => {
                if motion_blur_seen {
                    bail!("common video branch supports exactly one motion blur node");
                }
                if outer_visual_before_motion_blur {
                    bail!(
                        "common video transform motion blur must be the final visual node on {}",
                        node.id
                    );
                }
                if !shutter_angle.is_finite() || *shutter_angle <= 0.0 || *shutter_angle > 360.0 {
                    bail!(
                        "common video transform motion blur shutter angle must be within 0..=360 on {}",
                        node.id
                    );
                }
                if !(2..=8).contains(samples) {
                    bail!(
                        "common video transform motion blur supports 2..=8 shutter samples on {}",
                        node.id
                    );
                }
                if node.inputs.len() != 1 {
                    bail!(
                        "common video transform motion blur {} requires exactly one input",
                        node.id
                    );
                }
                visual.motion_blur = Some(EngineVideoMotionBlurPlan {
                    contract: match source_sampling {
                        MotionBlurSourceSampling::CurrentFrame => {
                            "transform-shutter-accumulation/v1"
                        }
                        MotionBlurSourceSampling::DecodedTemporal => {
                            "decoded-temporal-shutter-accumulation/v1"
                        }
                    },
                    node_id: node.id.clone(),
                    shutter_angle: *shutter_angle,
                    sample_count: *samples,
                    source_sampling: *source_sampling,
                    sample_frames: Vec::new(),
                    sample_transforms: Vec::new(),
                });
                motion_blur_seen = true;
                current = &node.inputs[0];
            }
            NodeOperation::Precomposition {
                nested_graph_id,
                timeline,
            } => {
                if !motion_blur_seen {
                    outer_visual_before_motion_blur = true;
                }
                if node.inputs.len() != 1
                    || !nested_graph_id.starts_with("composition:")
                    || nested_graph_id.trim() == "composition:"
                    || precompositions.len() >= 4
                {
                    bail!(
                        "common video resolved precomposition has an invalid bounded contract on {}",
                        node.id
                    );
                }
                precompositions.push((node.id.clone(), nested_graph_id.clone(), timeline.clone()));
                current = &node.inputs[0];
            }
            NodeOperation::Source {
                asset_id,
                media_kind,
                input_color_space,
                alpha_mode,
                timeline,
            } => {
                if !node.inputs.is_empty() {
                    bail!("common video source {} cannot have inputs", node.id);
                }
                if media_kind != "video" {
                    bail!("common video source must have mediaKind video");
                }
                if input_color_space.as_deref() != Some("rec709") {
                    bail!(
                        "common video source {} requires explicit rec709 input",
                        node.id
                    );
                }
                let range = timeline.clone().with_context(|| {
                    format!("common video source {} requires a timeline", node.id)
                })?;
                if precompositions.iter().any(|(_, _, timeline)| {
                    timeline.timeline_start_frame != range.timeline_start_frame
                        || timeline.duration_frames != range.duration_frames
                }) {
                    bail!(
                        "common video resolved precomposition timeline must match its leaf source coverage"
                    );
                }
                if visual
                    .keyframes
                    .last()
                    .is_some_and(|keyframe| keyframe.frame > range.duration_frames)
                {
                    bail!("common video transform keyframe exceeds source timeline duration");
                }
                if let Some(motion_blur) = visual.motion_blur.as_ref() {
                    if matches!(
                        motion_blur.source_sampling,
                        MotionBlurSourceSampling::CurrentFrame
                    ) && (!transform_seen || visual.keyframes.is_empty())
                    {
                        bail!("common video transform motion blur requires an animated transform");
                    }
                    if visual
                        .keyframes
                        .iter()
                        .any(|keyframe| (keyframe.opacity - visual.opacity).abs() > 0.000001)
                    {
                        bail!(
                            "common video transform motion blur requires constant opacity across shutter samples"
                        );
                    }
                }
                let binding = bindings
                    .get(asset_id)
                    .with_context(|| format!("missing asset binding: {asset_id}"))?;
                return Ok(PreparedEngineVideoLayer {
                    source_node_id: node.id.clone(),
                    asset_id: asset_id.clone(),
                    input_path: resolve_binding(binding, binding_dir),
                    alpha_mode: resolve_engine_alpha_mode(*alpha_mode, media_kind),
                    timeline: EngineVideoTimelinePlan {
                        range,
                        timebase_numerator,
                        timebase_denominator,
                    },
                    visual,
                    transform_node_id,
                    parent_transform_node_id,
                    parent_layer_index: None,
                    parent_controller_index: None,
                    parent_depth: 0,
                    blend_mode: BlendMode::Normal,
                    composite_opacity: 1.0,
                    matte_layer_index: None,
                    matte_mode: None,
                    precomposition_node_ids: precompositions
                        .iter()
                        .map(|item| item.0.clone())
                        .collect(),
                    nested_graph_ids: precompositions.iter().map(|item| item.1.clone()).collect(),
                    decode_cadence_divisor: 1,
                    decode_cadence_phase: 0,
                });
            }
            NodeOperation::Composite { .. } => {
                bail!("nested common video composite is not supported")
            }
            operation => bail!(
                "unsupported common video node kind: {}",
                operation.kind_name()
            ),
        }
    }
}

fn generic_source_alpha_mode(mode: AlphaMode, media_kind: &str) -> SourceAlphaMode {
    match mode {
        AlphaMode::Auto if media_kind == "video" => SourceAlphaMode::Opaque,
        AlphaMode::Auto => SourceAlphaMode::Straight,
        AlphaMode::Opaque => SourceAlphaMode::Opaque,
        AlphaMode::Straight => SourceAlphaMode::Straight,
        AlphaMode::Premultiplied => SourceAlphaMode::Premultiplied,
    }
}

fn resolve_engine_alpha_mode(mode: AlphaMode, media_kind: &str) -> AlphaMode {
    match mode {
        AlphaMode::Auto if media_kind == "video" => AlphaMode::Opaque,
        AlphaMode::Auto => AlphaMode::Straight,
        explicit => explicit,
    }
}

impl EngineTimelinePlan {
    pub fn apply(&self, params: &mut [super::GpuLayerParam], timeline_frame: u64) -> Result<()> {
        if params.len() != self.base_enabled.len()
            || params.len() != self.ranges.len()
            || params.len() != self.particle_time_scales.len()
        {
            bail!("engine timeline/property buffer layer count differs");
        }
        for (index, param) in params.iter_mut().enumerate() {
            param.enabled = self.base_enabled[index]
                * u32::from(frame_active(self.ranges[index].as_ref(), timeline_frame));
            if let Some(seconds_per_frame) = self.particle_time_scales[index] {
                let local_frame = timeline_frame.saturating_sub(
                    self.ranges[index]
                        .as_ref()
                        .map_or(0, |range| range.timeline_start_frame),
                );
                param.particle_time = local_frame as f32 * seconds_per_frame;
            }
        }
        Ok(())
    }
}

impl EngineVideoTimelinePlan {
    pub fn local_frame(&self, timeline_frame: u64) -> Option<u64> {
        frame_active(Some(&self.range), timeline_frame)
            .then(|| timeline_frame.saturating_sub(self.range.timeline_start_frame))
    }

    pub fn local_frame_continuous(&self, timeline_frame: f64) -> Option<f64> {
        let start = self.range.timeline_start_frame as f64;
        let end = self
            .range
            .timeline_start_frame
            .saturating_add(self.range.duration_frames) as f64;
        (timeline_frame >= start && timeline_frame < end).then_some(timeline_frame - start)
    }

    pub fn frame(&self, timeline_frame: u64) -> EngineVideoFramePlan {
        if !frame_active(Some(&self.range), timeline_frame) {
            return EngineVideoFramePlan {
                active: false,
                timeline_frame,
                source_frame: None,
                source_time_seconds: None,
            };
        }
        let relative = timeline_frame.saturating_sub(self.range.timeline_start_frame);
        let source_frame = self.range.source_start_frame.saturating_add(relative);
        EngineVideoFramePlan {
            active: true,
            timeline_frame,
            source_frame: Some(source_frame),
            source_time_seconds: Some(
                source_frame as f64 * self.timebase_numerator as f64
                    / self.timebase_denominator as f64,
            ),
        }
    }

    pub fn source_time_seconds_continuous(&self, timeline_frame: f64) -> f64 {
        let local_frame = (timeline_frame - self.range.timeline_start_frame as f64)
            .clamp(0.0, self.range.duration_frames.saturating_sub(1) as f64);
        let source_frame = self.range.source_start_frame as f64 + local_frame;
        source_frame * self.timebase_numerator as f64 / self.timebase_denominator as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_balance_graph_versions_and_source_transfer_fail_closed() {
        let base = trailing_adjustment_graph();
        let bindings = BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]);
        let mut wire = serde_json::to_value(&base).unwrap();
        for index in [2, 4] {
            wire["nodes"][index]["processor"] = serde_json::json!("editkin-rec709-primary/v2");
            wire["nodes"][index]["grade"] = serde_json::to_value(hao_core::engine::model::PrimaryGrade::default()).unwrap();
            wire["nodes"][index]["grade"]["whiteBalanceRed"] = serde_json::json!(0.75);
        }
        let prepared = prepare_video(serde_json::from_value(wire.clone()).unwrap(), &bindings, Path::new(".")).unwrap();
        assert_eq!(prepared.layers[0].visual.grade.white_balance_red, 0.75);
        assert_eq!(prepared.layers[0].visual.input_transfer, 1);
        assert_eq!(prepared.adjustments[0].visual.grade.white_balance_red, 0.75);
        assert_eq!(prepared.adjustments[0].visual.input_transfer, 0);
        let mut zero_v2 = wire.clone();
        for index in [2,4] { zero_v2["nodes"][index]["grade"]["whiteBalanceRed"] = serde_json::json!(0.0); }
        let zero_prepared = prepare_video(serde_json::from_value(zero_v2).unwrap(), &bindings, Path::new(".")).unwrap();
        assert_eq!(zero_prepared.layers[0].visual.primary_processor_version, 2);
        assert_eq!(zero_prepared.adjustments[0].visual.primary_processor_version, 2);
        assert!(zero_prepared.layers[0].visual.grade.is_identity());
        assert_eq!(zero_prepared.layers[0].visual.sample_continuous(15.0).primary_processor_version, 2);
        for index in [2, 4] {
            let mut old = wire.clone(); old["nodes"][index]["processor"] = serde_json::json!("editkin-rec709-primary/v1");
            assert!(prepare_video(serde_json::from_value(old).unwrap(), &bindings, Path::new(".")).is_err());
            let mut missing = wire.clone(); missing["nodes"][index]["grade"].as_object_mut().unwrap().remove("whiteBalanceBlue");
            assert!(prepare_video(serde_json::from_value(missing).unwrap(), &bindings, Path::new(".")).is_err());
        }
        for unsupported in ["rec2100_hlg", "rec2100_pq", "sony_slog3", "linear_rec709"] {
            let mut bad = wire.clone(); bad["nodes"][0]["inputColorSpace"] = serde_json::json!(unsupported);
            assert!(prepare_video(serde_json::from_value(bad).unwrap(), &bindings, Path::new(".")).is_err());
        }
        let mut stacked = wire.clone();
        let mut outer = stacked["nodes"][2].clone(); outer["id"] = serde_json::json!("outer-color"); outer["inputs"] = serde_json::json!(["base-color"]);
        stacked["nodes"][3]["inputs"] = serde_json::json!(["outer-color"]); stacked["nodes"][3]["affectedInputs"] = serde_json::json!(["outer-color"]);
        stacked["nodes"].as_array_mut().unwrap().push(outer);
        let error = prepare_video(serde_json::from_value(stacked).unwrap(), &bindings, Path::new(".")).err().expect("never silently overwrite a v2 source color stage");
        assert!(error.to_string().contains("stacked v2"));
        // Same source and linear adjustment, with only the existing ACES display node added.
        wire["nodes"][2]["processor"] = serde_json::json!("editkin-rec709-to-linear-rec709-primary/v2");
        for index in [2, 4] { wire["nodes"][index]["workingSpace"] = serde_json::json!("linear_rec709"); wire["nodes"][index]["outputSpace"] = serde_json::json!("linear_rec709"); }
        wire["nodes"][4]["inputSpace"] = serde_json::json!("linear_rec709");
        wire["nodes"][4]["processor"] = serde_json::json!("editkin-linear-primary/v2");
        wire["nodes"][6]["inputs"] = serde_json::json!(["display"]);
        wire["nodes"].as_array_mut().unwrap().insert(6, serde_json::json!({"id":"display","inputs":["adjustment-effect"],"kind":"color","enabled":true,"processor":"editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1","inputSpace":"linear_rec709","workingSpace":"ACEScct","outputSpace":"rec709_sdr"}));
        let prepared = prepare_video(serde_json::from_value(wire).unwrap(), &bindings, Path::new(".")).unwrap();
        assert_eq!(prepared.layers[0].visual.input_transfer, 2);
        assert_eq!(prepared.adjustments[0].visual.input_transfer, 0);
        assert_eq!(prepared.layers[0].visual.sample_continuous(15.0).input_transfer, 2);
    }

    fn bound_gpu_effect(
        node_id: &str,
        plugin_identity: &str,
        opcode: u32,
        argument: f32,
    ) -> GpuEffectBinding {
        let mut binding = GpuEffectBinding {
            schema: GPU_EFFECT_GRAPH_SCHEMA.into(),
            node_id: node_id.into(),
            plugin_identity: plugin_identity.into(),
            parameters: BTreeMap::new(),
            program_sha256: String::new(),
            operations: vec![GpuEffectOperation {
                opcode,
                args: [argument, 0.0, 0.0],
            }],
        };
        binding.program_sha256 = gpu_effect_program_sha256(&binding);
        binding
    }

    #[test]
    fn third_party_gpu_effect_stack_preserves_source_to_output_order() {
        let first_identity = "creator.stack/invert@1.0.0#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let second_identity = "creator.stack/gain@1.0.0#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "gpu-stack-order",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 30 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "color", "inputs": ["transform"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr" },
                { "id": "effect-a", "inputs": ["color"], "enabled": true, "kind": "effect", "pluginId": first_identity, "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "effect-b", "inputs": ["effect-a"], "enabled": true, "kind": "effect", "pluginId": second_identity, "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "output", "inputs": ["effect-b"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("GPU stack fixture must deserialize");
        let effect_bindings = GpuEffectBindings {
            schema: GPU_EFFECT_BINDINGS_SCHEMA.into(),
            bindings: BTreeMap::from([
                (
                    "effect-a".into(),
                    bound_gpu_effect("effect-a", first_identity, 2, 0.65),
                ),
                (
                    "effect-b".into(),
                    bound_gpu_effect("effect-b", second_identity, 1, 0.55),
                ),
            ]),
        };
        let prepared = prepare_video_with_effects(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
            &effect_bindings,
        )
        .expect("two bounded GPU graphs must lower");
        let effects = &prepared.layers[0].visual.shader_effects;
        assert_eq!(
            effects
                .iter()
                .map(|effect| effect.node_id.as_str())
                .collect::<Vec<_>>(),
            vec!["effect-a", "effect-b"]
        );
        assert_eq!(
            effects
                .iter()
                .flat_map(|effect| effect.operations.iter().map(|operation| operation.opcode))
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
    }

    fn trailing_adjustment_graph() -> EngineGraph {
        serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1",
            "graphId": "trailing-adjustment-contract",
            "width": 960,
            "height": 540,
            "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float",
            "cacheBudgetMb": 64,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "base-color", "inputs": ["transform"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr" },
                { "id": "adjustment", "inputs": ["base-color"], "enabled": true, "kind": "adjustment", "affectedInputs": ["base-color"], "timeline": { "timelineStartFrame": 15, "sourceStartFrame": 0, "durationFrames": 30 } },
                { "id": "adjustment-color", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": 0.04, "contrast": 1.15, "saturation": 0.8, "hue": 0, "exposure": 0.35, "temperature": 0.2, "tint": -0.1, "pivot": 0.45, "shadows": 0.15, "highlights": -0.1, "blacks": 0.08, "whites": -0.04 } },
                { "id": "adjustment-effect", "inputs": ["adjustment-color"], "enabled": true, "kind": "effect", "pluginId": "editkin.builtin.mono_halftone", "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "output", "inputs": ["adjustment-effect"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ],
            "outputNode": "output"
        }))
        .expect("trailing adjustment fixture must deserialize")
    }

    #[test]
    fn operation_kind_names_cover_the_common_contract() {
        let operation = NodeOperation::Output {
            format: PixelFormat::Rgba16Float,
        };
        assert_eq!(operation.kind_name(), "output");
    }

    #[test]
    fn video_timeline_maps_project_frames_to_source_clock() {
        let plan = EngineVideoTimelinePlan {
            range: NodeFrameRange {
                timeline_start_frame: 30,
                source_start_frame: 15,
                duration_frames: 60,
            },
            timebase_numerator: 1,
            timebase_denominator: 30,
        };
        let active = plan.frame(60);
        assert!(active.active);
        assert_eq!(active.source_frame, Some(45));
        assert_eq!(active.source_time_seconds, Some(1.5));
        assert!(!plan.frame(29).active);
        assert!(!plan.frame(90).active);
    }

    #[test]
    fn video_composite_preserves_typed_blend_and_opacity() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1",
            "graphId": "blend-contract",
            "width": 960,
            "height": 540,
            "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float",
            "cacheBudgetMb": 64,
            "nodes": [
                { "id": "base", "inputs": [], "enabled": true, "kind": "source", "assetId": "base", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "upper", "inputs": [], "enabled": true, "kind": "source", "assetId": "upper", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 15, "durationFrames": 60 } },
                { "id": "composite", "inputs": ["base", "upper"], "enabled": true, "kind": "composite", "blendMode": "screen", "opacity": 0.65 },
                { "id": "output", "inputs": ["composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ],
            "outputNode": "output"
        }))
        .expect("blend graph fixture must deserialize");
        let bindings = BTreeMap::from([
            ("base".into(), PathBuf::from("base.mp4")),
            ("upper".into(), PathBuf::from("upper.mp4")),
        ]);
        let prepared = prepare_video(graph, &bindings, Path::new("."))
            .expect("typed blend graph must lower to the common video executor");
        assert_eq!(prepared.layers.len(), 2);
        assert!(matches!(prepared.layers[0].blend_mode, BlendMode::Normal));
        assert!(matches!(prepared.layers[1].blend_mode, BlendMode::Screen));
        assert!((prepared.layers[0].composite_opacity - 1.0).abs() < f32::EPSILON);
        assert!((prepared.layers[1].composite_opacity - 0.65).abs() < 0.000001);
    }

    #[test]
    fn video_track_matte_lowers_typed_mode_and_resident_source_index() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "track-matte-contract",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 96,
            "nodes": [
                { "id": "matte", "inputs": [], "enabled": true, "kind": "source", "assetId": "matte", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "target", "inputs": [], "enabled": true, "kind": "source", "assetId": "target", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 15, "sourceStartFrame": 30, "durationFrames": 45 } },
                { "id": "composite", "inputs": ["matte", "target"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1, "matteInput": "matte", "matteMode": "luma_inverted" },
                { "id": "output", "inputs": ["composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ],
            "outputNode": "output"
        })).expect("track matte fixture must deserialize");
        let bindings = BTreeMap::from([
            ("matte".into(), PathBuf::from("matte.mp4")),
            ("target".into(), PathBuf::from("target.mp4")),
        ]);
        let prepared = prepare_video(graph, &bindings, Path::new("."))
            .expect("bounded track matte must lower to the common video executor");
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.resource_plan.video_layer_count, 2);
        assert_eq!(prepared.resource_plan.matte_count, 1);
        assert_eq!(prepared.layers[1].matte_layer_index, Some(0));
        assert_eq!(prepared.layers[1].matte_mode, Some(MatteMode::LumaInverted));
    }

    #[test]
    fn video_track_matte_rejects_uncovered_target_timeline() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "track-matte-uncovered",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 96,
            "nodes": [
                { "id": "matte", "inputs": [], "enabled": true, "kind": "source", "assetId": "matte", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 10, "sourceStartFrame": 0, "durationFrames": 20 } },
                { "id": "target", "inputs": [], "enabled": true, "kind": "source", "assetId": "target", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "composite", "inputs": ["matte", "target"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1, "matteInput": "matte", "matteMode": "alpha" },
                { "id": "output", "inputs": ["composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("uncovered matte fixture must deserialize");
        let bindings = BTreeMap::from([
            ("matte".into(), PathBuf::from("matte.mp4")),
            ("target".into(), PathBuf::from("target.mp4")),
        ]);
        let error = prepare_video(graph, &bindings, Path::new("."))
            .err()
            .expect("uncovered matte must fail closed");
        assert!(error.to_string().contains("must fully cover"));
    }

    fn video_parenting_graph() -> EngineGraph {
        serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "parent-transform-contract",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 96,
            "nodes": [
                { "id": "parent-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "parent", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "parent-transform", "inputs": ["parent-source"], "enabled": true, "kind": "transform2d", "x": 80, "y": -35, "scaleX": 0.8, "scaleY": 0.8, "rotationRadians": 0.2, "opacity": 0.9, "keyframes": [{ "frame": 45, "x": 120, "y": 20, "scaleX": 0.7, "scaleY": 0.7, "rotationRadians": 0.35, "opacity": 0.75, "easing": "ease_in_out" }] },
                { "id": "child-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "child", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 15, "sourceStartFrame": 12, "durationFrames": 45 } },
                { "id": "child-transform", "inputs": ["child-source"], "enabled": true, "kind": "transform2d", "x": -70, "y": 55, "scaleX": 0.45, "scaleY": 0.45, "rotationRadians": -0.1, "opacity": 0.8, "parent": "parent-transform", "keyframes": [{ "frame": 30, "x": 40, "y": -25, "scaleX": 0.6, "scaleY": 0.6, "rotationRadians": 0.05, "opacity": 0.65, "easing": "linear" }] },
                { "id": "composite", "inputs": ["parent-transform", "child-transform"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("parent-transform fixture must deserialize")
    }

    #[test]
    fn video_parenting_lowers_typed_visible_transform_relationship() {
        let bindings = BTreeMap::from([
            ("parent".into(), PathBuf::from("parent.mp4")),
            ("child".into(), PathBuf::from("child.mp4")),
        ]);
        let prepared = prepare_video(video_parenting_graph(), &bindings, Path::new("."))
            .expect("bounded parent transform must lower to resident video layers");
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.resource_plan.video_layer_count, 2);
        assert_eq!(
            prepared.layers[0].transform_node_id.as_deref(),
            Some("parent-transform")
        );
        assert_eq!(prepared.layers[0].parent_layer_index, None);
        assert_eq!(prepared.layers[0].parent_depth, 0);
        assert_eq!(
            prepared.layers[1].transform_node_id.as_deref(),
            Some("child-transform")
        );
        assert_eq!(
            prepared.layers[1].parent_transform_node_id.as_deref(),
            Some("parent-transform")
        );
        assert_eq!(prepared.layers[1].parent_layer_index, Some(0));
        assert_eq!(prepared.layers[1].parent_depth, 1);
        assert_eq!(prepared.decode_schedule.full_rate_layer_count, 2);
    }

    #[test]
    fn video_parenting_fails_closed_for_missing_self_cycle_and_uncovered_parent() {
        let bindings = BTreeMap::from([
            ("parent".into(), PathBuf::from("parent.mp4")),
            ("child".into(), PathBuf::from("child.mp4")),
        ]);
        let set_parent = |graph: &mut EngineGraph, node_id: &str, parent_id: &str| {
            let node = graph
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .unwrap();
            let NodeOperation::Transform2d { parent, .. } = &mut node.operation else {
                panic!("fixture node must remain a transform");
            };
            *parent = Some(parent_id.into());
        };

        let mut missing = video_parenting_graph();
        set_parent(&mut missing, "child-transform", "missing-transform");
        assert!(prepare_video(missing, &bindings, Path::new(".")).is_err());

        let mut self_parent = video_parenting_graph();
        set_parent(&mut self_parent, "child-transform", "child-transform");
        assert!(prepare_video(self_parent, &bindings, Path::new(".")).is_err());

        let mut cycle = video_parenting_graph();
        set_parent(&mut cycle, "parent-transform", "child-transform");
        assert!(prepare_video(cycle, &bindings, Path::new(".")).is_err());

        let mut uncovered = video_parenting_graph();
        let parent_source = uncovered
            .nodes
            .iter_mut()
            .find(|node| node.id == "parent-source")
            .unwrap();
        let NodeOperation::Source { timeline, .. } = &mut parent_source.operation else {
            panic!("fixture parent source must remain a source");
        };
        *timeline = Some(NodeFrameRange {
            timeline_start_frame: 20,
            source_start_frame: 0,
            duration_frames: 20,
        });
        let parent_transform = uncovered
            .nodes
            .iter_mut()
            .find(|node| node.id == "parent-transform")
            .unwrap();
        if let NodeOperation::Transform2d { keyframes, .. } = &mut parent_transform.operation {
            keyframes.clear();
        }
        let error = prepare_video(uncovered, &bindings, Path::new("."))
            .err()
            .expect("uncovered parent timeline must fail closed");
        assert!(error.to_string().contains("fully cover"));
    }

    fn video_controller_graph() -> EngineGraph {
        serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "null-controller-contract",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "controller-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "editkin.generator.null", "mediaKind": "generator", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "controller-transform", "inputs": ["controller-source"], "enabled": true, "kind": "transform2d", "x": 80, "y": -35, "scaleX": 0.8, "scaleY": 0.8, "rotationRadians": 0.2, "opacity": 0.9, "keyframes": [{ "frame": 45, "x": 120, "y": 20, "scaleX": 0.7, "scaleY": 0.7, "rotationRadians": 0.35, "opacity": 0.75, "easing": "linear" }] },
                { "id": "child-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "child", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "child-transform", "inputs": ["child-source"], "enabled": true, "kind": "transform2d", "x": -70, "y": 55, "scaleX": 0.45, "scaleY": 0.45, "rotationRadians": -0.1, "opacity": 0.8, "parent": "controller-transform" },
                { "id": "child-color", "inputs": ["child-transform"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr" },
                { "id": "output", "inputs": ["child-color"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("null-controller fixture must deserialize")
    }

    #[test]
    fn video_controller_lowers_without_decoder_or_texture_ownership() {
        let bindings = BTreeMap::from([("child".into(), PathBuf::from("child.mp4"))]);
        let prepared = prepare_video(video_controller_graph(), &bindings, Path::new("."))
            .expect("bounded null controller must lower to a transform-only plan");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.controllers.len(), 1);
        assert_eq!(prepared.resource_plan.video_layer_count, 1);
        assert_eq!(prepared.layers[0].parent_layer_index, None);
        assert_eq!(prepared.layers[0].parent_controller_index, Some(0));
        assert_eq!(prepared.layers[0].parent_depth, 1);
        assert_eq!(
            prepared.controllers[0].transform_node_id,
            "controller-transform"
        );
        assert_eq!(prepared.controllers[0].parent_depth, 0);
    }

    #[test]
    fn video_controller_fails_closed_for_wrong_generator_cycle_and_coverage() {
        let bindings = BTreeMap::from([("child".into(), PathBuf::from("child.mp4"))]);
        let mut wrong = video_controller_graph();
        let NodeOperation::Source { asset_id, .. } = &mut wrong.nodes[0].operation else {
            panic!("controller source kind changed")
        };
        *asset_id = "editkin.generator.unknown".into();
        assert!(prepare_video(wrong, &bindings, Path::new(".")).is_err());

        let mut cycle = video_controller_graph();
        let NodeOperation::Transform2d { parent, .. } = &mut cycle.nodes[1].operation else {
            panic!("controller transform kind changed")
        };
        *parent = Some("child-transform".into());
        assert!(prepare_video(cycle, &bindings, Path::new(".")).is_err());

        let mut uncovered = video_controller_graph();
        let NodeOperation::Source { timeline, .. } = &mut uncovered.nodes[0].operation else {
            panic!("controller source kind changed")
        };
        timeline.as_mut().unwrap().duration_frames = 20;
        assert!(prepare_video(uncovered, &bindings, Path::new(".")).is_err());
    }

    #[test]
    fn video_resolved_precomposition_executes_leaf_timing_without_an_intermediate() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "resolved-precomp",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 }, "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "leaf", "inputs": [], "enabled": true, "kind": "source", "assetId": "leaf-video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 30, "sourceStartFrame": 23, "durationFrames": 45 } },
                { "id": "precomp", "inputs": ["leaf"], "enabled": true, "kind": "precomposition", "nestedGraphId": "composition:hero", "timeline": { "timelineStartFrame": 30, "sourceStartFrame": 8, "durationFrames": 45 } },
                { "id": "transform", "inputs": ["precomp"], "enabled": true, "kind": "transform2d", "x": 100, "y": 50, "scaleX": 0.4, "scaleY": 0.4, "rotationRadians": 0.25, "opacity": 0.72 },
                { "id": "color", "inputs": ["transform"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr" },
                { "id": "output", "inputs": ["color"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("resolved precomp fixture must deserialize");
        let bindings = BTreeMap::from([("leaf-video".into(), PathBuf::from("leaf.mp4"))]);
        let prepared = prepare_video(graph, &bindings, Path::new("."))
            .expect("resolved precomp must lower directly to its leaf decoder");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.layers[0].asset_id, "leaf-video");
        assert_eq!(prepared.layers[0].timeline.range.source_start_frame, 23);
        assert_eq!(prepared.layers[0].precomposition_node_ids, ["precomp"]);
        assert_eq!(prepared.layers[0].nested_graph_ids, ["composition:hero"]);
    }

    #[test]
    fn video_resolved_precomposition_rejects_unresolved_or_misaligned_contracts() {
        let bindings = BTreeMap::from([("leaf-video".into(), PathBuf::from("leaf.mp4"))]);
        let fixture = || -> EngineGraph {
            serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "bad-precomp", "width": 960, "height": 540,
            "timebase": { "numerator": 1, "denominator": 30 }, "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "leaf", "inputs": [], "enabled": true, "kind": "source", "assetId": "leaf-video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 30, "sourceStartFrame": 23, "durationFrames": 45 } },
                { "id": "precomp", "inputs": ["leaf"], "enabled": true, "kind": "precomposition", "nestedGraphId": "composition:hero", "timeline": { "timelineStartFrame": 31, "sourceStartFrame": 0, "durationFrames": 45 } },
                { "id": "output", "inputs": ["precomp"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).unwrap()
        };
        let error = prepare_video(fixture(), &bindings, Path::new("."))
            .err()
            .unwrap();
        assert!(error.to_string().contains("timeline must match"));
        let mut unresolved = fixture();
        let node = unresolved
            .nodes
            .iter_mut()
            .find(|node| node.id == "precomp")
            .unwrap();
        node.inputs.clear();
        let error = prepare_video(unresolved, &bindings, Path::new("."))
            .err()
            .unwrap();
        assert!(error.to_string().contains("invalid bounded contract"));
    }

    #[test]
    fn video_trailing_adjustment_lowers_exact_timeline_and_visual_chain() {
        let graph = trailing_adjustment_graph();
        let bindings = BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]);
        let prepared = prepare_video(graph, &bindings, Path::new("."))
            .expect("bounded trailing adjustment must lower to the common video executor");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.adjustments.len(), 1);
        assert_eq!(prepared.resource_plan.adjustment_count, 1);
        let adjustment = &prepared.adjustments[0];
        assert_eq!(
            adjustment.node_ids,
            ["adjustment-effect", "adjustment-color", "adjustment"]
        );
        assert_eq!(adjustment.timeline.timeline_start_frame, 15);
        assert_eq!(adjustment.timeline.duration_frames, 30);
        assert_eq!(adjustment.visual.effect_kind, 1);
        assert!((adjustment.visual.grade.exposure - 0.35).abs() < 0.000001);
        assert!(!adjustment.active(14));
        assert!(adjustment.active(15));
        assert!(adjustment.active(44));
        assert!(!adjustment.active(45));
    }

    #[test]
    fn video_adjustment_rejects_missing_timeline_and_wrong_target() {
        let bindings = BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]);
        let mut missing_timeline = trailing_adjustment_graph();
        let adjustment = missing_timeline
            .nodes
            .iter_mut()
            .find(|node| node.id == "adjustment")
            .expect("fixture adjustment");
        if let NodeOperation::Adjustment { timeline, .. } = &mut adjustment.operation {
            *timeline = None;
        }
        let error = prepare_video(missing_timeline, &bindings, Path::new("."))
            .err()
            .expect("timeline-less adjustment must fail closed");
        assert!(error.to_string().contains("requires an explicit timeline"));

        let mut wrong_target = trailing_adjustment_graph();
        let adjustment = wrong_target
            .nodes
            .iter_mut()
            .find(|node| node.id == "adjustment")
            .expect("fixture adjustment");
        if let NodeOperation::Adjustment {
            affected_inputs, ..
        } = &mut adjustment.operation
        {
            *affected_inputs = vec!["source".into()];
        }
        let error = prepare_video(wrong_target, &bindings, Path::new("."))
            .err()
            .expect("adjustment with an invented target must fail closed");
        assert!(
            error
                .to_string()
                .contains("target exactly its one direct input")
        );

        let mut uncovered = trailing_adjustment_graph();
        let adjustment = uncovered
            .nodes
            .iter_mut()
            .find(|node| node.id == "adjustment")
            .expect("fixture adjustment");
        if let NodeOperation::Adjustment { timeline, .. } = &mut adjustment.operation {
            *timeline = Some(NodeFrameRange {
                timeline_start_frame: 85,
                source_start_frame: 0,
                duration_frames: 20,
            });
        }
        let error = prepare_video(uncovered, &bindings, Path::new("."))
            .err()
            .expect("uncovered adjustment timeline must fail closed");
        assert!(error.to_string().contains("must be fully covered"));
    }

    #[test]
    fn resident_video_resources_scale_from_budget_instead_of_a_layer_constant() {
        let plan = resident_video_resource_plan(960, 540, 384, 12, 0, 0, 0, 0, 0, 4, 0, 0)
            .expect("384 MiB must admit twelve 540p resident video layers");
        assert_eq!(plan.pixel_count, 518_400);
        assert_eq!(plan.bytes_per_video_layer, 18_662_400);
        assert_eq!(plan.compositor_working_bytes, 6_220_800);
        assert_eq!(plan.required_bytes, 230_169_600);
        assert_eq!(plan.budget_bytes, 402_653_184);
        assert_eq!(plan.max_video_layers, 21);
        assert_eq!(plan.video_layer_count, 12);
    }

    #[test]
    fn resident_video_resources_reject_the_mib_below_the_required_floor() {
        let error = resident_video_resource_plan(960, 540, 219, 12, 0, 0, 0, 0, 0, 4, 0, 0)
            .expect_err("219 MiB must not admit the twelve-layer plan");
        assert!(
            error
                .to_string()
                .contains("resource budget is insufficient")
        );
    }

    #[test]
    fn resident_video_resources_account_for_every_overlay_texture() {
        let plan = resident_video_resource_plan(960, 540, 384, 12, 2, 0, 0, 0, 0, 4, 0, 0)
            .expect("overlay-inclusive plan must fit its declared budget");
        assert_eq!(plan.overlay_bytes, 4_147_200);
        assert_eq!(plan.required_bytes, 234_316_800);
        assert_eq!(plan.max_video_layers, 21);
    }

    #[test]
    fn resident_video_resources_account_for_adjustment_ping_pong() {
        let plan = resident_video_resource_plan(960, 540, 384, 2, 0, 0, 1, 0, 0, 4, 0, 0)
            .expect("one trailing adjustment must fit its declared working textures");
        assert_eq!(plan.adjustment_count, 1);
        assert_eq!(plan.adjustment_working_bytes, 4_147_200);
        assert_eq!(plan.required_bytes, 47_692_800);
    }

    #[test]
    fn resident_video_resources_account_for_depth_and_reused_lens_intermediate() {
        let plan = resident_video_resource_plan(960, 540, 64, 2, 0, 0, 0, 0, 0, 8, 1, 1)
            .expect("two scene-linear planes, one depth attachment and one lens pass must fit");
        assert_eq!(plan.scene_depth_attachment_count, 1);
        assert_eq!(plan.scene_depth_bytes, 2_073_600);
        assert_eq!(plan.depth_of_field_pass_count, 1);
        assert_eq!(plan.depth_of_field_additional_working_bytes, 0);
        assert_eq!(plan.maximum_full_frame_passes_per_present, 3);
        assert_eq!(plan.required_bytes, 51_840_000);
        assert!(resident_video_resource_plan(960, 540, 64, 2, 0, 0, 0, 0, 0, 8, 0, 1).is_err());
    }

    #[test]
    fn camera_lens_keyframes_sample_project_time_with_segment_easing() {
        let plan = EngineVideoDepthOfFieldPlan {
            contract: "camera_depth_of_field/v1",
            node_id: "lens".into(),
            focus_distance: 3.0,
            aperture: 2.0,
            max_blur_radius: 8.0,
            near: 0.1,
            far: 20.0,
            execution_mode: "scene-linear-depth32f-gather-dof/v1",
            depth_source: "depth32_float",
            executor: "wgpu-depth-aware-gather/v1",
            pass_count: 1,
            animation_contract: "timeline-keyframes/v1",
            keyframe_count: 2,
            sampled_timeline_frame: 0,
            keyframes: vec![
                DepthOfFieldKeyframe {
                    frame: 10,
                    focus_distance: 5.0,
                    aperture: 4.0,
                    max_blur_radius: 12.0,
                    easing: KeyframeEasing::EaseInOut,
                },
                DepthOfFieldKeyframe {
                    frame: 20,
                    focus_distance: 9.0,
                    aperture: 8.0,
                    max_blur_radius: 20.0,
                    easing: KeyframeEasing::Hold,
                },
            ],
        };
        let first = plan.sample(5);
        assert!((first.focus_distance - 4.0).abs() < 0.0001);
        assert!((first.aperture - 3.0).abs() < 0.0001);
        let second = plan.sample(15);
        assert!((second.focus_distance - 7.0).abs() < 0.0001);
        assert!((second.max_blur_radius - 16.0).abs() < 0.0001);
        assert_eq!(second.sampled_timeline_frame, 15);
        assert_eq!(second.keyframe_count, 2);
        let final_sample = plan.sample(25);
        assert!((final_sample.focus_distance - 9.0).abs() < 0.0001);
    }

    #[test]
    fn camera_projection_keyframes_sample_project_time_before_projection() {
        let keyframes = vec![
            CameraKeyframe {
                frame: 10,
                position: [1.0, 0.0, 5.0],
                target: [0.5, 0.0, 0.0],
                vertical_fov_radians: 1.2,
                easing: KeyframeEasing::EaseInOut,
            },
            CameraKeyframe {
                frame: 20,
                position: [3.0, 0.0, 6.0],
                target: [1.0, 0.0, 0.0],
                vertical_fov_radians: 1.4,
                easing: KeyframeEasing::Hold,
            },
        ];
        let first = sample_camera(([0.0, 0.0, 4.0], [0.0, 0.0, 0.0], 1.0), &keyframes, 5);
        assert_eq!(first.0, [0.5, 0.0, 4.5]);
        assert_eq!(first.1, [0.25, 0.0, 0.0]);
        assert!((first.2 - 1.1).abs() < 0.0001);
        let second = sample_camera(([0.0, 0.0, 4.0], [0.0, 0.0, 0.0], 1.0), &keyframes, 15);
        assert_eq!(second.0, [2.0, 0.0, 5.5]);
        assert_eq!(second.1, [0.75, 0.0, 0.0]);
        let terminal = sample_camera(([0.0, 0.0, 4.0], [0.0, 0.0, 0.0], 1.0), &keyframes, 30);
        assert_eq!(terminal.0, [3.0, 0.0, 6.0]);
        let exact = sample_camera(([0.0, 0.0, 4.0], [0.0, 0.0, 0.0], 1.0), &keyframes, 20);
        assert_eq!(exact.0, [3.0, 0.0, 6.0]);
    }

    #[test]
    fn light_keyframes_sample_project_time_before_native_shading() {
        let base = LightSample {
            color: [1.0, 0.8, 0.6],
            intensity: 0.2,
            direction: [0.0, 0.0, 1.0],
        };
        let keyframes = vec![
            LightKeyframe {
                frame: 10,
                color: [0.2, 0.4, 1.0],
                intensity: 1.2,
                direction: [1.0, 0.0, 1.0],
                easing: KeyframeEasing::Hold,
            },
            LightKeyframe {
                frame: 20,
                color: [1.0, 0.2, 0.1],
                intensity: 1.8,
                direction: [-1.0, 0.0, 1.0],
                easing: KeyframeEasing::Linear,
            },
        ];
        let first = sample_light(base, &keyframes, 5);
        assert_eq!(first.color, [0.6, 0.6, 0.8]);
        assert!((first.intensity - 0.7).abs() < 0.0001);
        let held = sample_light(base, &keyframes, 15);
        assert_eq!(held, light_keyframe_values(keyframes[0]));
        let exact = sample_light(base, &keyframes, 20);
        assert_eq!(exact, light_keyframe_values(keyframes[1]));
    }

    #[test]
    fn resident_video_resources_account_for_particle_seek_snapshots() {
        let plan = resident_video_resource_plan(320, 180, 64, 1, 1, 1, 0, 0, 0, 4, 0, 0)
            .expect("one particle overlay and two snapshots must fit the declared budget");
        assert_eq!(plan.particle_count, 1);
        assert_eq!(plan.particle_snapshot_capacity_per_emitter, 2);
        assert_eq!(plan.particle_snapshot_bytes, 460_800);
        assert_eq!(plan.required_bytes, 3_456_000);
        assert!(resident_video_resource_plan(320, 180, 3, 1, 1, 1, 0, 0, 0, 4, 0, 0).is_err());
    }

    #[test]
    fn resident_video_resources_account_for_decoded_temporal_window() {
        let plan = resident_video_resource_plan(960, 540, 160, 1, 0, 0, 0, 0, 8, 4, 0, 0)
            .expect("eight-sample decoded temporal ring must fit the declared budget");
        assert_eq!(plan.temporal_sample_count, 8);
        assert_eq!(plan.temporal_resident_ring_slots, 5);
        assert_eq!(plan.temporal_resident_bytes, 31_104_000);
        assert_eq!(plan.required_bytes, 55_987_200);
        assert!(resident_video_resource_plan(1920, 1080, 64, 1, 0, 0, 0, 0, 8, 4, 0, 0).is_err());
    }

    #[test]
    fn video_transform_keyframes_sample_the_segment_source_easing() {
        let visual = EngineVideoVisualPlan {
            translate_x: -180.0,
            translate_y: -60.0,
            scale: 0.55,
            rotation: -0.12,
            opacity: 0.35,
            keyframes: vec![
                Transform2dKeyframe {
                    frame: 30,
                    x: 0.0,
                    y: 80.0,
                    scale_x: 0.85,
                    scale_y: 0.85,
                    rotation_radians: 0.12,
                    opacity: 0.75,
                    easing: KeyframeEasing::EaseInOut,
                },
                Transform2dKeyframe {
                    frame: 60,
                    x: 180.0,
                    y: -40.0,
                    scale_x: 0.45,
                    scale_y: 0.45,
                    rotation_radians: -0.08,
                    opacity: 0.5,
                    easing: KeyframeEasing::Hold,
                },
            ],
            ..EngineVideoVisualPlan::default()
        };
        let first_half = visual.sample(15);
        assert!((first_half.translate_x + 90.0).abs() < 0.0001);
        assert!((first_half.scale - 0.7).abs() < 0.0001);
        let second_half = visual.sample(45);
        assert!((second_half.translate_x - 90.0).abs() < 0.0001);
        assert!((second_half.translate_y - 20.0).abs() < 0.0001);
        assert!((second_half.opacity - 0.625).abs() < 0.0001);
        assert!((visual.sample(60).translate_x - 180.0).abs() < 0.0001);
        assert!((visual.sample(75).translate_x - 180.0).abs() < 0.0001);
    }

    #[test]
    fn video_transform_uses_authored_zero_and_exact_hold_boundaries() {
        let first = Transform2dKeyframe {
            frame: 0,
            x: -24.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation_radians: 0.0,
            opacity: 1.0,
            easing: KeyframeEasing::Hold,
        };
        let visual = EngineVideoVisualPlan {
            translate_x: 99.0,
            keyframes: vec![
                first,
                Transform2dKeyframe { frame: 2, x: 24.0, ..first },
                Transform2dKeyframe { frame: 4, x: 0.0, ..first },
            ],
            ..EngineVideoVisualPlan::default()
        };
        for (frame, expected) in [(-1.0, -24.0), (0.0, -24.0), (1.999, -24.0),
            (2.0, 24.0), (3.999, 24.0), (4.0, 0.0), (5.0, 0.0)] {
            assert_eq!(visual.sample_continuous(frame).translate_x, expected);
        }
    }

    #[test]
    fn video_transform_motion_blur_lowers_bounded_subframe_samples() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "transform-motion-blur",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": -210, "y": 0, "scaleX": 0.62, "scaleY": 0.62, "rotationRadians": -0.08, "opacity": 1, "keyframes": [{ "frame": 30, "x": 210, "y": 0, "scaleX": 0.62, "scaleY": 0.62, "rotationRadians": 0.08, "opacity": 1, "easing": "linear" }] },
                { "id": "motion-blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8 },
                { "id": "output", "inputs": ["motion-blur"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("motion-blur fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect("bounded transform motion blur must lower");
        let motion = prepared.layers[0]
            .visual
            .motion_blur
            .as_ref()
            .expect("motion blur plan must remain typed");
        assert_eq!(motion.contract, "transform-shutter-accumulation/v1");
        assert_eq!(motion.sample_count, 8);
        let frames = motion.sample_timeline_frames(&prepared.layers[0].timeline, 15);
        assert_eq!(frames.len(), 8);
        assert!((frames[0] - 14.5625).abs() < 0.000001);
        assert!((frames[7] - 15.4375).abs() < 0.000001);
        let first = prepared.layers[0].visual.sample_continuous(frames[0]);
        let last = prepared.layers[0].visual.sample_continuous(frames[7]);
        assert!(first.translate_x < last.translate_x);
        assert!((first.opacity - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn video_decoded_temporal_motion_blur_lowers_static_transform_and_source_times() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-motion-blur",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 30, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "motion-blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "output", "inputs": ["motion-blur"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("decoded temporal fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect("decoded temporal motion blur must admit a static transform");
        let motion = prepared.layers[0]
            .visual
            .motion_blur
            .as_ref()
            .expect("typed motion plan");
        assert_eq!(motion.contract, "decoded-temporal-shutter-accumulation/v1");
        assert!(matches!(
            motion.source_sampling,
            MotionBlurSourceSampling::DecodedTemporal
        ));
        let targets = motion.sample_source_times_seconds(&prepared.layers[0].timeline, 15);
        assert_eq!(targets.len(), 8);
        assert!((targets[0] - 1.4854166666666666).abs() < 0.000001);
        assert!((targets[7] - 1.5145833333333334).abs() < 0.000001);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
    }

    #[test]
    fn video_decoded_temporal_motion_blur_converges_with_one_overlay() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-overlay",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 192,
            "nodes": [
                { "id": "base-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "base", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "base-transform", "inputs": ["base-source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "base-blur", "inputs": ["base-transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "overlay-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "overlay", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "overlay-transform", "inputs": ["overlay-source"], "enabled": true, "kind": "transform2d", "x": 250, "y": 120, "scaleX": 0.3, "scaleY": 0.3, "rotationRadians": 0, "opacity": 1 },
                { "id": "composite", "inputs": ["base-blur", "overlay-transform"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("temporal overlay fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([
                ("base".into(), PathBuf::from("base.mp4")),
                ("overlay".into(), PathBuf::from("overlay.mp4")),
            ]),
            Path::new("."),
        )
        .expect("one overlay must converge with the first decoded-temporal layer");
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.resource_plan.temporal_resident_ring_slots, 5);
        assert!(matches!(
            prepared.layers[0]
                .visual
                .motion_blur
                .as_ref()
                .map(|plan| plan.source_sampling),
            Some(MotionBlurSourceSampling::DecodedTemporal)
        ));
        assert!(prepared.layers[1].visual.motion_blur.is_none());
    }

    #[test]
    fn video_decoded_temporal_motion_blur_converges_with_bounded_typography() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-typography",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 160,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "caption", "inputs": [], "enabled": true, "kind": "caption", "cueId": "single-colour", "text": "字幕保持單色", "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 }, "fontFamily": "Noto Sans TC", "fontSize": 44, "textColor": "#FFFFFFFF", "outlineColor": "#000000FF", "outlineWidth": 3, "backgroundColor": "#00000000", "alignment": 2, "marginVertical": 44, "bold": true, "italic": false, "shadow": 1, "letterSpacing": 0 },
                { "id": "caption-composite", "inputs": ["blur", "caption"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "graphic", "inputs": [], "enabled": true, "kind": "motion_graphic", "graphicId": "title-card", "graphicKind": "card", "text": "關鍵重點", "timeline": { "timelineStartFrame": 12, "sourceStartFrame": 0, "durationFrames": 36 }, "x": 0.08, "y": 0.09, "width": 0.48, "fontSize": 54, "fontFamily": "Noto Sans TC", "fontWeight": 800, "letterSpacing": 0, "outlineWidth": 3, "shadowDepth": 3, "cornerRadius": 18, "textColor": "#FFFFFFFF", "backgroundColor": "#10151FEE", "accentColor": "#A8FF3EFF", "animation": "slide_up", "trackingMode": "anchor", "offsetX": 0, "offsetY": 0 },
                { "id": "graphic-composite", "inputs": ["caption-composite", "graphic"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["graphic-composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("temporal typography fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect("bounded caption and motion graphic must converge with decoded temporal video");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.captions.len(), 1);
        assert_eq!(prepared.motion_graphics.len(), 1);
        assert_eq!(prepared.resource_plan.overlay_bytes, 4_147_200);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.captions[0].text_color, "#FFFFFFFF");
    }

    #[test]
    fn two_video_decoded_temporal_adjustments_execute_before_single_colour_typography() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-look",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 192,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "adjustment", "inputs": ["blur"], "enabled": true, "kind": "adjustment", "affectedInputs": ["blur"], "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 } },
                { "id": "adjustment-color", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": 0.02, "contrast": 1.08, "saturation": 0.92, "hue": 0, "exposure": 0.25, "temperature": 0.04, "tint": -0.02, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "adjustment-finish", "inputs": ["adjustment-color"], "enabled": true, "kind": "adjustment", "affectedInputs": ["adjustment-color"], "timeline": { "timelineStartFrame": 12, "sourceStartFrame": 0, "durationFrames": 24 } },
                { "id": "adjustment-finish-color", "inputs": ["adjustment-finish"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": -0.01, "contrast": 1.04, "saturation": 1.12, "hue": 0, "exposure": -0.12, "temperature": -0.08, "tint": 0.06, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "caption", "inputs": [], "enabled": true, "kind": "caption", "cueId": "single-colour", "text": "字幕保持單色", "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 }, "fontFamily": "Noto Sans TC", "fontSize": 44, "textColor": "#FFFFFFFF", "outlineColor": "#000000FF", "outlineWidth": 3, "backgroundColor": "#00000000", "alignment": 2, "marginVertical": 44, "bold": true, "italic": false, "shadow": 1, "letterSpacing": 0 },
                { "id": "caption-composite", "inputs": ["adjustment-finish-color", "caption"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "graphic", "inputs": [], "enabled": true, "kind": "motion_graphic", "graphicId": "title-card", "graphicKind": "card", "text": "關鍵重點", "timeline": { "timelineStartFrame": 12, "sourceStartFrame": 0, "durationFrames": 36 }, "x": 0.08, "y": 0.09, "width": 0.48, "fontSize": 54, "fontFamily": "Noto Sans TC", "fontWeight": 800, "letterSpacing": 0, "outlineWidth": 3, "shadowDepth": 3, "cornerRadius": 18, "textColor": "#FFFFFFFF", "backgroundColor": "#10151FEE", "accentColor": "#A8FF3EFF", "animation": "slide_up", "trackingMode": "anchor", "offsetX": 0, "offsetY": 0 },
                { "id": "graphic-composite", "inputs": ["caption-composite", "graphic"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["graphic-composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("temporal look fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect("two pre-typography adjustments must converge with decoded temporal video");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.adjustments.len(), 2);
        assert_eq!(prepared.captions.len(), 1);
        assert_eq!(prepared.motion_graphics.len(), 1);
        assert!(prepared.adjustment_before_typography);
        assert_eq!(prepared.resource_plan.adjustment_count, 2);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.captions[0].text_color, "#FFFFFFFF");
    }

    #[test]
    fn one_temporal_particle_layer_accepts_two_grades_before_single_colour_typography() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-particle-look",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 192,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "particles", "inputs": [], "enabled": true, "kind": "particle_emitter", "timeline": { "timelineStartFrame": 12, "sourceStartFrame": 0, "durationFrames": 24 }, "seed": 32021, "ratePerSecond": 48, "lifetimeSeconds": 1.25, "initialVelocity": [18, -76, 0], "gravity": [0, 82, 0], "maxParticles": 48, "emitterPosition": [0.5, 0.72], "radiusPixels": 3.25, "color": [0.66, 1, 0.24, 0.92] },
                { "id": "particle-composite", "inputs": ["blur", "particles"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "adjustment", "inputs": ["particle-composite"], "enabled": true, "kind": "adjustment", "affectedInputs": ["particle-composite"], "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 } },
                { "id": "adjustment-color", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": 0.02, "contrast": 1.08, "saturation": 0.92, "hue": 0, "exposure": 0.25, "temperature": 0.04, "tint": -0.02, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "finish", "inputs": ["adjustment-color"], "enabled": true, "kind": "adjustment", "affectedInputs": ["adjustment-color"], "timeline": { "timelineStartFrame": 16, "sourceStartFrame": 0, "durationFrames": 16 } },
                { "id": "finish-color", "inputs": ["finish"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": -0.01, "contrast": 0.96, "saturation": 1.12, "hue": 0, "exposure": -0.08, "temperature": -0.02, "tint": 0.01, "pivot": 0.5, "shadows": 0.04, "highlights": -0.03, "blacks": 0, "whites": 0 } },
                { "id": "caption", "inputs": [], "enabled": true, "kind": "caption", "cueId": "single-colour", "text": "字幕保持單色", "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 }, "fontFamily": "Noto Sans TC", "fontSize": 44, "textColor": "#FFFFFFFF", "outlineColor": "#000000FF", "outlineWidth": 3, "backgroundColor": "#00000000", "alignment": 2, "marginVertical": 44, "bold": true, "italic": false, "shadow": 1, "letterSpacing": 0 },
                { "id": "caption-composite", "inputs": ["finish-color", "caption"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["caption-composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("temporal particle look fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect("one bounded particle layer must join two ordered pre-typography adjustments");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.particles.len(), 1);
        assert_eq!(prepared.adjustments.len(), 2);
        assert_eq!(prepared.captions.len(), 1);
        assert!(prepared.adjustment_before_typography);
        assert_eq!(prepared.resource_plan.particle_count, 1);
        assert_eq!(prepared.resource_plan.adjustment_count, 2);
        assert_eq!(prepared.captions[0].text_color, "#FFFFFFFF");
    }

    #[test]
    fn particle_overlay_adjustment_width_accepts_partial_and_coextensive_video_overlays() {
        let graph_value = serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-particle-overlay-look",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 192,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "overlay-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "overlay", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 6, "sourceStartFrame": 6, "durationFrames": 72 } },
                { "id": "overlay-transform", "inputs": ["overlay-source"], "enabled": true, "kind": "transform2d", "x": 240, "y": 120, "scaleX": 0.32, "scaleY": 0.32, "rotationRadians": 0, "opacity": 1 },
                { "id": "video-composite", "inputs": ["blur", "overlay-transform"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "particles", "inputs": [], "enabled": true, "kind": "particle_emitter", "timeline": { "timelineStartFrame": 12, "sourceStartFrame": 0, "durationFrames": 24 }, "seed": 32021, "ratePerSecond": 48, "lifetimeSeconds": 1.25, "initialVelocity": [18, -76, 0], "gravity": [0, 82, 0], "maxParticles": 48, "emitterPosition": [0.5, 0.72], "radiusPixels": 3.25, "color": [0.66, 1, 0.24, 0.92] },
                { "id": "particle-composite", "inputs": ["video-composite", "particles"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "adjustment", "inputs": ["particle-composite"], "enabled": true, "kind": "adjustment", "affectedInputs": ["particle-composite"], "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 } },
                { "id": "adjustment-color", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": 0.02, "contrast": 1.08, "saturation": 0.92, "hue": 0, "exposure": 0.25, "temperature": 0.04, "tint": -0.02, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "caption", "inputs": [], "enabled": true, "kind": "caption", "cueId": "single-colour", "text": "字幕保持單色", "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 }, "fontFamily": "Noto Sans TC", "fontSize": 44, "textColor": "#FFFFFFFF", "outlineColor": "#000000FF", "outlineWidth": 3, "backgroundColor": "#00000000", "alignment": 2, "marginVertical": 44, "bold": true, "italic": false, "shadow": 1, "letterSpacing": 0 },
                { "id": "caption-composite", "inputs": ["adjustment-color", "caption"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["caption-composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        });
        let graph: EngineGraph = serde_json::from_value(graph_value.clone())
            .expect("temporal particle-overlay fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([
                ("video".into(), PathBuf::from("video.mp4")),
                ("overlay".into(), PathBuf::from("overlay.mp4")),
            ]),
            Path::new("."),
        )
        .expect("one overlapping static video overlay and one particle emitter must join the pre-typography grade");
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.particles.len(), 1);
        assert_eq!(prepared.adjustments.len(), 1);
        assert_eq!(prepared.captions.len(), 1);
        assert!(prepared.adjustment_before_typography);
        assert_eq!(prepared.resource_plan.video_layer_count, 2);
        assert_eq!(prepared.resource_plan.particle_count, 1);
        assert_eq!(prepared.resource_plan.adjustment_count, 1);
        assert_eq!(prepared.captions[0].text_color, "#FFFFFFFF");

        let with_second_adjustment = |mut value: serde_json::Value, coextensive: bool| {
            let nodes = value["nodes"]
                .as_array_mut()
                .expect("fixture nodes must remain an array");
            if coextensive {
                let overlay_source = nodes
                    .iter_mut()
                    .find(|node| node["id"] == "overlay-source")
                    .expect("overlay source must exist");
                overlay_source["timeline"]["timelineStartFrame"] = serde_json::json!(0);
                overlay_source["timeline"]["durationFrames"] = serde_json::json!(60);
            }
            let caption_index = nodes
                .iter()
                .position(|node| node["id"] == "caption")
                .expect("caption must exist");
            nodes.insert(caption_index, serde_json::json!({
                "id": "finish", "inputs": ["adjustment-color"], "enabled": true, "kind": "adjustment", "affectedInputs": ["adjustment-color"],
                "timeline": { "timelineStartFrame": 16, "sourceStartFrame": 0, "durationFrames": 16 }
            }));
            nodes.insert(caption_index + 1, serde_json::json!({
                "id": "finish-color", "inputs": ["finish"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1",
                "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr",
                "grade": { "brightness": -0.01, "contrast": 0.96, "saturation": 1.12, "hue": 0, "exposure": -0.08, "temperature": -0.02, "tint": 0.01, "pivot": 0.5, "shadows": 0.04, "highlights": -0.03, "blacks": 0, "whites": 0 }
            }));
            nodes
                .iter_mut()
                .find(|node| node["id"] == "caption-composite")
                .expect("caption composite must exist")["inputs"][0] =
                serde_json::json!("finish-color");
            serde_json::from_value::<EngineGraph>(value)
                .expect("two-adjustment particle-overlay fixture must deserialize")
        };
        let bindings = BTreeMap::from([
            ("video".into(), PathBuf::from("video.mp4")),
            ("overlay".into(), PathBuf::from("overlay.mp4")),
        ]);
        let mut animated_value = graph_value.clone();
        let animated_nodes = animated_value["nodes"]
            .as_array_mut()
            .expect("animated fixture nodes must remain an array");
        let animated_source = animated_nodes
            .iter_mut()
            .find(|node| node["id"] == "overlay-source")
            .expect("animated overlay source must exist");
        animated_source["timeline"]["timelineStartFrame"] = serde_json::json!(0);
        animated_source["timeline"]["durationFrames"] = serde_json::json!(60);
        let animated_transform = animated_nodes
            .iter_mut()
            .find(|node| node["id"] == "overlay-transform")
            .expect("animated overlay transform must exist");
        animated_transform["keyframes"] = serde_json::json!([{
            "frame": 18, "x": -220, "y": 105, "scaleX": 0.4, "scaleY": 0.4,
            "rotationRadians": -0.14, "opacity": 0.82, "easing": "ease_in_out"
        }]);
        let animated = prepare_video(
            serde_json::from_value(animated_value.clone())
                .expect("animated particle-overlay fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("one exact single-keyframe overlay may join one particle and one adjustment");
        assert_eq!(animated.layers[1].visual.keyframes.len(), 1);
        assert_eq!(animated.adjustments.len(), 1);

        let mut two_keyframe_value = animated_value.clone();
        two_keyframe_value["nodes"]
            .as_array_mut()
            .expect("two-keyframe fixture nodes must remain an array")
            .iter_mut()
            .find(|node| node["id"] == "overlay-transform")
            .expect("two-keyframe overlay transform must exist")["keyframes"]
            .as_array_mut()
            .expect("overlay keyframes must remain an array")
            .push(serde_json::json!({
                "frame": 36, "x": 180, "y": 80, "scaleX": 0.3, "scaleY": 0.3,
                "rotationRadians": 0.1, "opacity": 1, "easing": "linear"
            }));
        let two_keyframe = prepare_video(
            serde_json::from_value(two_keyframe_value.clone())
                .expect("two-keyframe particle-overlay fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("one exact two-keyframe overlay may join one particle and one adjustment");
        assert_eq!(two_keyframe.layers[1].visual.keyframes.len(), 2);

        let mut three_keyframe_value = two_keyframe_value.clone();
        three_keyframe_value["nodes"]
            .as_array_mut()
            .expect("three-keyframe fixture nodes must remain an array")
            .iter_mut()
            .find(|node| node["id"] == "overlay-transform")
            .expect("three-keyframe overlay transform must exist")["keyframes"]
            .as_array_mut()
            .expect("overlay keyframes must remain an array")
            .push(serde_json::json!({
                "frame": 48, "x": 40, "y": 60, "scaleX": 0.36, "scaleY": 0.36,
                "rotationRadians": -0.04, "opacity": 0.9, "easing": "ease_out"
            }));
        assert!(
            prepare_video(
                serde_json::from_value(three_keyframe_value)
                    .expect("three-keyframe particle-overlay fixture must deserialize"),
                &bindings,
                Path::new("."),
            )
            .is_err()
        );
        let two_keyframe_two_adjustment = prepare_video(
            with_second_adjustment(two_keyframe_value.clone(), true),
            &bindings,
            Path::new("."),
        )
        .expect("one exact two-keyframe overlay may join one particle and two ordered adjustments");
        assert_eq!(
            two_keyframe_two_adjustment.layers[1].visual.keyframes.len(),
            2
        );
        assert_eq!(two_keyframe_two_adjustment.adjustments.len(), 2);
        assert_eq!(
            two_keyframe_two_adjustment.resource_plan.adjustment_count,
            2
        );

        let mut dual_particle_value =
            serde_json::to_value(with_second_adjustment(two_keyframe_value, true))
                .expect("dual-particle fixture must serialize");
        let mut partial_animated_dual_value = dual_particle_value.clone();
        let partial_animated_nodes = partial_animated_dual_value["nodes"]
            .as_array_mut()
            .expect("partial animated dual nodes must remain an array");
        let partial_animated_source = partial_animated_nodes
            .iter_mut()
            .find(|node| node["id"] == "overlay-source")
            .expect("partial animated overlay source must exist");
        partial_animated_source["timeline"]["timelineStartFrame"] = serde_json::json!(8);
        partial_animated_source["timeline"]["durationFrames"] = serde_json::json!(40);
        let partial_animated_adjustment_index = partial_animated_nodes
            .iter()
            .position(|node| node["id"] == "adjustment")
            .expect("partial animated first adjustment must exist");
        partial_animated_nodes.insert(partial_animated_adjustment_index, serde_json::json!({
            "id": "particles-two", "inputs": [], "enabled": true, "kind": "particle_emitter",
            "timeline": { "timelineStartFrame": 18, "sourceStartFrame": 0, "durationFrames": 18 },
            "seed": 90210, "ratePerSecond": 36, "lifetimeSeconds": 0.9,
            "initialVelocity": [-22, -58, 0], "gravity": [0, 70, 0], "maxParticles": 32,
            "emitterPosition": [0.35, 0.62], "radiusPixels": 2.5, "color": [0.1, 0.65, 1, 0.85]
        }));
        partial_animated_nodes.insert(
            partial_animated_adjustment_index + 1,
            serde_json::json!({
                "id": "particle-composite-two", "inputs": ["particle-composite", "particles-two"],
                "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1
            }),
        );
        let partial_animated_first_adjustment = partial_animated_nodes
            .iter_mut()
            .find(|node| node["id"] == "adjustment")
            .expect("partial animated first adjustment must remain reachable");
        partial_animated_first_adjustment["inputs"] = serde_json::json!(["particle-composite-two"]);
        partial_animated_first_adjustment["affectedInputs"] =
            serde_json::json!(["particle-composite-two"]);
        let partial_animated_dual = prepare_video(
            serde_json::from_value(partial_animated_dual_value)
                .expect("partial animated dual fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("a partial animated overlay may join two particles and two adjustments");
        assert_eq!(partial_animated_dual.layers[1].visual.keyframes.len(), 2);
        assert_eq!(partial_animated_dual.particles.len(), 2);
        assert_eq!(partial_animated_dual.adjustments.len(), 2);

        let dual_nodes = dual_particle_value["nodes"]
            .as_array_mut()
            .expect("dual-particle fixture nodes must remain an array");
        let adjustment_index = dual_nodes
            .iter()
            .position(|node| node["id"] == "adjustment")
            .expect("first adjustment must exist");
        dual_nodes.insert(adjustment_index, serde_json::json!({
            "id": "particles-two", "inputs": [], "enabled": true, "kind": "particle_emitter",
            "timeline": { "timelineStartFrame": 18, "sourceStartFrame": 0, "durationFrames": 18 },
            "seed": 90210, "ratePerSecond": 36, "lifetimeSeconds": 0.9,
            "initialVelocity": [-22, -58, 0], "gravity": [0, 70, 0], "maxParticles": 32,
            "emitterPosition": [0.35, 0.62], "radiusPixels": 2.5, "color": [0.1, 0.65, 1, 0.85]
        }));
        dual_nodes.insert(
            adjustment_index + 1,
            serde_json::json!({
                "id": "particle-composite-two", "inputs": ["particle-composite", "particles-two"],
                "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1
            }),
        );
        let first_adjustment = dual_nodes
            .iter_mut()
            .find(|node| node["id"] == "adjustment")
            .expect("first adjustment must remain reachable");
        first_adjustment["inputs"] = serde_json::json!(["particle-composite-two"]);
        first_adjustment["affectedInputs"] = serde_json::json!(["particle-composite-two"]);
        let dual_particle = prepare_video(
            serde_json::from_value(dual_particle_value.clone())
                .expect("dual-particle fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("the exact animated overlay may join two particles and two ordered adjustments");
        assert_eq!(dual_particle.particles.len(), 2);
        assert_eq!(dual_particle.adjustments.len(), 2);
        assert_eq!(dual_particle.resource_plan.particle_count, 2);

        let mut static_dual_value = graph_value.clone();
        let static_dual_nodes = static_dual_value["nodes"]
            .as_array_mut()
            .expect("static dual-particle fixture nodes must remain an array");
        let static_overlay_source = static_dual_nodes
            .iter_mut()
            .find(|node| node["id"] == "overlay-source")
            .expect("static overlay source must exist");
        static_overlay_source["timeline"]["timelineStartFrame"] = serde_json::json!(0);
        static_overlay_source["timeline"]["durationFrames"] = serde_json::json!(60);
        let static_adjustment_index = static_dual_nodes
            .iter()
            .position(|node| node["id"] == "adjustment")
            .expect("static first adjustment must exist");
        static_dual_nodes.insert(static_adjustment_index, serde_json::json!({
            "id": "particles-two", "inputs": [], "enabled": true, "kind": "particle_emitter",
            "timeline": { "timelineStartFrame": 18, "sourceStartFrame": 0, "durationFrames": 18 },
            "seed": 90210, "ratePerSecond": 36, "lifetimeSeconds": 0.9,
            "initialVelocity": [-22, -58, 0], "gravity": [0, 70, 0], "maxParticles": 32,
            "emitterPosition": [0.35, 0.62], "radiusPixels": 2.5, "color": [0.1, 0.65, 1, 0.85]
        }));
        static_dual_nodes.insert(
            static_adjustment_index + 1,
            serde_json::json!({
                "id": "particle-composite-two", "inputs": ["particle-composite", "particles-two"],
                "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1
            }),
        );
        let static_first_adjustment = static_dual_nodes
            .iter_mut()
            .find(|node| node["id"] == "adjustment")
            .expect("static first adjustment must remain reachable");
        static_first_adjustment["inputs"] = serde_json::json!(["particle-composite-two"]);
        static_first_adjustment["affectedInputs"] = serde_json::json!(["particle-composite-two"]);
        let static_dual_particle = prepare_video(
            serde_json::from_value(static_dual_value.clone())
                .expect("static dual-particle fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("the exact static overlay may join two particles and one ordered adjustment");
        assert_eq!(static_dual_particle.layers.len(), 2);
        assert_eq!(static_dual_particle.layers[1].visual.keyframes.len(), 0);
        assert_eq!(static_dual_particle.particles.len(), 2);
        assert_eq!(static_dual_particle.adjustments.len(), 1);
        assert_eq!(static_dual_particle.resource_plan.particle_count, 2);

        let mut partial_static_dual_value = static_dual_value.clone();
        let partial_static_overlay_source = partial_static_dual_value["nodes"]
            .as_array_mut()
            .expect("partial static dual nodes must remain an array")
            .iter_mut()
            .find(|node| node["id"] == "overlay-source")
            .expect("partial static overlay source must exist");
        partial_static_overlay_source["timeline"]["timelineStartFrame"] = serde_json::json!(8);
        partial_static_overlay_source["timeline"]["durationFrames"] = serde_json::json!(40);
        let partial_static_dual = prepare_video(
            serde_json::from_value(partial_static_dual_value)
                .expect("partial static dual-particle fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("a partial static overlay may join two particles and one adjustment");
        assert_eq!(partial_static_dual.particles.len(), 2);
        assert_eq!(partial_static_dual.adjustments.len(), 1);

        let add_particle_stage = |mut value: serde_json::Value, ordinal: u32| {
            let nodes = value["nodes"]
                .as_array_mut()
                .expect("resource-governed particle fixture nodes must remain an array");
            let adjustment_index = nodes
                .iter()
                .position(|node| node["id"] == "adjustment")
                .expect("resource-governed fixture adjustment must exist");
            let prior = if ordinal == 3 {
                "particle-composite-two".to_string()
            } else {
                format!("particle-composite-{}", ordinal - 1)
            };
            let particle_id = format!("particles-{ordinal}");
            let composite_id = format!("particle-composite-{ordinal}");
            nodes.insert(adjustment_index, serde_json::json!({
                "id": particle_id, "inputs": [], "enabled": true, "kind": "particle_emitter",
                "timeline": { "timelineStartFrame": 18 + ordinal, "sourceStartFrame": 0, "durationFrames": 16 },
                "seed": 90210 + ordinal, "ratePerSecond": 30, "lifetimeSeconds": 0.8,
                "initialVelocity": [12, -52, 0], "gravity": [0, 68, 0], "maxParticles": 24,
                "emitterPosition": [0.45, 0.58], "radiusPixels": 2.25, "color": [0.7, 0.3, 1, 0.85]
            }));
            nodes.insert(
                adjustment_index + 1,
                serde_json::json!({
                    "id": composite_id, "inputs": [prior, particle_id],
                    "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1
                }),
            );
            let adjustment = nodes
                .iter_mut()
                .find(|node| node["id"] == "adjustment")
                .expect("resource-governed fixture adjustment must remain reachable");
            adjustment["inputs"] = serde_json::json!([composite_id]);
            adjustment["affectedInputs"] = serde_json::json!([composite_id]);
            value
        };
        let four_particle_value =
            add_particle_stage(add_particle_stage(static_dual_value.clone(), 3), 4);
        let four_particle = prepare_video(
            serde_json::from_value(four_particle_value.clone())
                .expect("four-particle resource-governed fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("one safe overlay may join four temporal particle emitters under one resource-governed topology");
        assert_eq!(four_particle.particles.len(), 4);
        assert_eq!(four_particle.resource_plan.particle_count, 4);

        let five_particle_value = add_particle_stage(four_particle_value, 5);
        assert!(
            prepare_video(
                serde_json::from_value(five_particle_value)
                    .expect("five-particle overflow fixture must deserialize"),
                &bindings,
                Path::new("."),
            )
            .is_err()
        );

        let static_dual_two_adjustments = prepare_video(
            with_second_adjustment(static_dual_value, true),
            &bindings,
            Path::new("."),
        )
        .expect("an exact static overlay may join two particles and two adjustments");
        assert_eq!(static_dual_two_adjustments.particles.len(), 2);
        assert_eq!(static_dual_two_adjustments.adjustments.len(), 2);

        let dual_nodes = dual_particle_value["nodes"]
            .as_array_mut()
            .expect("dual-particle negative nodes must remain an array");
        dual_nodes
            .iter_mut()
            .find(|node| node["id"] == "overlay-transform")
            .expect("animated overlay transform must exist")["keyframes"] = serde_json::json!([]);
        let static_dual_two_adjustments = prepare_video(
            serde_json::from_value(dual_particle_value)
                .expect("static dual-particle fixture must deserialize"),
            &bindings,
            Path::new("."),
        )
        .expect("a static overlay may retain two particles and two adjustments");
        assert_eq!(static_dual_two_adjustments.particles.len(), 2);
        assert_eq!(static_dual_two_adjustments.adjustments.len(), 2);

        let partial = prepare_video(
            with_second_adjustment(graph_value.clone(), false),
            &bindings,
            Path::new("."),
        )
        .expect("partial static video overlay may join one particle and two ordered adjustments");
        assert_eq!(partial.layers.len(), 2);
        assert_eq!(partial.particles.len(), 1);
        assert_eq!(partial.adjustments.len(), 2);
        assert_eq!(partial.resource_plan.adjustment_count, 2);
        assert_eq!(partial.captions[0].text_color, "#FFFFFFFF");

        let coextensive = prepare_video(
            with_second_adjustment(graph_value, true),
            &bindings,
            Path::new("."),
        )
        .expect(
            "coextensive static video overlay may join one particle and two ordered adjustments",
        );
        assert_eq!(coextensive.layers.len(), 2);
        assert_eq!(coextensive.particles.len(), 1);
        assert_eq!(coextensive.adjustments.len(), 2);
        assert_eq!(coextensive.resource_plan.adjustment_count, 2);
        assert_eq!(coextensive.captions[0].text_color, "#FFFFFFFF");
    }

    #[test]
    fn two_video_overlays_are_graded_before_single_colour_temporal_typography() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-multi-overlay-look",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 224,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "overlay-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "overlay", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 6, "durationFrames": 60 } },
                { "id": "overlay-transform", "inputs": ["overlay-source"], "enabled": true, "kind": "transform2d", "x": 240, "y": 120, "scaleX": 0.32, "scaleY": 0.32, "rotationRadians": 0, "opacity": 1 },
                { "id": "video-composite", "inputs": ["blur", "overlay-transform"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "overlay-two-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "overlay-two", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 3, "durationFrames": 60 } },
                { "id": "overlay-two-transform", "inputs": ["overlay-two-source"], "enabled": true, "kind": "transform2d", "x": -240, "y": 120, "scaleX": 0.28, "scaleY": 0.28, "rotationRadians": 0, "opacity": 0.9 },
                { "id": "video-composite-two", "inputs": ["video-composite", "overlay-two-transform"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "adjustment", "inputs": ["video-composite-two"], "enabled": true, "kind": "adjustment", "affectedInputs": ["video-composite-two"], "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 } },
                { "id": "adjustment-color", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": 0.02, "contrast": 1.08, "saturation": 0.92, "hue": 0, "exposure": 0.25, "temperature": 0.04, "tint": -0.02, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "caption", "inputs": [], "enabled": true, "kind": "caption", "cueId": "single-colour", "text": "字幕保持單色", "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 }, "fontFamily": "Noto Sans TC", "fontSize": 44, "textColor": "#FFFFFFFF", "outlineColor": "#000000FF", "outlineWidth": 3, "backgroundColor": "#00000000", "alignment": 2, "marginVertical": 44, "bold": true, "italic": false, "shadow": 1, "letterSpacing": 0 },
                { "id": "caption-composite", "inputs": ["adjustment-color", "caption"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "output", "inputs": ["caption-composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("temporal overlay look fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([
                ("video".into(), PathBuf::from("video.mp4")),
                ("overlay".into(), PathBuf::from("overlay.mp4")),
                ("overlay-two".into(), PathBuf::from("overlay-two.mp4")),
            ]),
            Path::new("."),
        )
        .expect("two overlays must be graded before bounded typography");
        assert_eq!(prepared.layers.len(), 3);
        assert_eq!(prepared.adjustments.len(), 1);
        assert_eq!(prepared.captions.len(), 1);
        assert!(prepared.adjustment_before_typography);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.captions[0].text_color, "#FFFFFFFF");
    }

    #[test]
    fn video_decoded_temporal_motion_blur_converges_with_one_trailing_adjustment() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-adjustment",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 160,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "blur", "inputs": ["transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "adjustment", "inputs": ["blur"], "enabled": true, "kind": "adjustment", "affectedInputs": ["blur"], "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 0, "durationFrames": 40 } },
                { "id": "adjustment-color", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr", "grade": { "brightness": 0.02, "contrast": 1.08, "saturation": 0.92, "hue": 0, "exposure": 0.25, "temperature": 0.04, "tint": -0.02, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "adjustment-effect", "inputs": ["adjustment-color"], "enabled": true, "kind": "effect", "pluginId": "editkin.builtin.mono_halftone", "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "output", "inputs": ["adjustment-effect"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("temporal adjustment fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect("one trailing adjustment must converge with decoded temporal video");
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.adjustments.len(), 1);
        assert_eq!(prepared.resource_plan.adjustment_count, 1);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.adjustments[0].timeline.timeline_start_frame, 8);
        assert_eq!(prepared.adjustments[0].timeline.duration_frames, 40);
    }

    #[test]
    fn video_decoded_temporal_motion_blur_converges_as_one_track_matte_source() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "decoded-temporal-track-matte",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 192,
            "nodes": [
                { "id": "matte-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "matte", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "matte-transform", "inputs": ["matte-source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "matte-blur", "inputs": ["matte-transform"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "target-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "target", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 8, "sourceStartFrame": 18, "durationFrames": 40 } },
                { "id": "target-transform", "inputs": ["target-source"], "enabled": true, "kind": "transform2d", "x": 80, "y": -20, "scaleX": 0.7, "scaleY": 0.7, "rotationRadians": 0, "opacity": 1 },
                { "id": "composite", "inputs": ["matte-blur", "target-transform"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1, "matteInput": "matte-blur", "matteMode": "luma" },
                { "id": "output", "inputs": ["composite"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("temporal matte fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([
                ("matte".into(), PathBuf::from("matte.mp4")),
                ("target".into(), PathBuf::from("target.mp4")),
            ]),
            Path::new("."),
        )
        .expect("one exclusive decoded-temporal track matte must converge");
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.resource_plan.matte_count, 1);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert!(matches!(
            prepared.layers[0]
                .visual
                .motion_blur
                .as_ref()
                .map(|motion| motion.source_sampling),
            Some(MotionBlurSourceSampling::DecodedTemporal)
        ));
        assert_eq!(prepared.layers[1].matte_layer_index, Some(0));
        assert_eq!(prepared.layers[1].matte_mode, Some(MatteMode::Luma));
    }

    #[test]
    fn video_transform_motion_blur_rejects_outer_visual_effects() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "transform-motion-blur-order",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 64,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1, "keyframes": [{ "frame": 30, "x": 100, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1, "easing": "linear" }] },
                { "id": "color", "inputs": ["transform"], "enabled": true, "kind": "color", "processor": "editkin-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "rec709", "outputSpace": "rec709_sdr" },
                { "id": "motion-blur", "inputs": ["color"], "enabled": true, "kind": "motion_blur", "shutterAngle": 180, "samples": 8 },
                { "id": "outer-effect", "inputs": ["motion-blur"], "enabled": true, "kind": "effect", "pluginId": "editkin.builtin.mono_halftone", "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "output", "inputs": ["outer-effect"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        })).expect("fixture must parse");
        let error = match prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("fixture.mp4"))]),
            Path::new("."),
        ) {
            Ok(_) => panic!("outer effect must not be silently reordered around motion blur"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("final visual node"));
    }

    #[test]
    fn caption_range_requires_contiguous_video_coverage() {
        let video = NodeFrameRange {
            timeline_start_frame: 30,
            source_start_frame: 0,
            duration_frames: 60,
        };
        let covered = NodeFrameRange {
            timeline_start_frame: 45,
            source_start_frame: 0,
            duration_frames: 30,
        };
        let crosses_end = NodeFrameRange {
            timeline_start_frame: 75,
            source_start_frame: 0,
            duration_frames: 30,
        };
        assert!(frame_range_contains(&video, &covered));
        assert!(!frame_range_contains(&video, &crosses_end));
    }

    #[test]
    fn motion_graphic_fade_samples_entry_hold_exit_and_inactive_frames() {
        let plan = EngineVideoMotionGraphicPlan {
            node_id: "motion".into(),
            graphic_id: "tag".into(),
            graphic_kind: "tag".into(),
            text: "1700+".into(),
            timeline: NodeFrameRange {
                timeline_start_frame: 15,
                source_start_frame: 0,
                duration_frames: 45,
            },
            x: 0.1,
            y: 0.1,
            width: 0.4,
            font_size: 54.0,
            font_family: "Noto Sans TC".into(),
            font_weight: 700,
            letter_spacing: 0.0,
            outline_width: 2.0,
            shadow_depth: 2.0,
            corner_radius: 18.0,
            text_color: "#FFFFFFFF".into(),
            background_color: "#10151FEE".into(),
            accent_color: "#A8FF3EFF".into(),
            visual_style: "solid_panel".into(),
            animation: "fade".into(),
            tracking_mode: "anchor".into(),
            fade_in_frames: 5,
            fade_out_frames: 4,
            track_id: None,
            tracking_samples: vec![],
            canvas_width: 960,
            canvas_height: 540,
        };
        assert_eq!(plan.sampled_opacity(14), None);
        assert_eq!(plan.sampled_opacity(15), Some(0.0));
        assert!((plan.sampled_opacity(18).unwrap() - 0.6).abs() < 0.0001);
        assert_eq!(plan.sampled_opacity(30), Some(1.0));
        assert!((plan.sampled_opacity(58).unwrap() - 0.5).abs() < 0.0001);
        assert_eq!(plan.sampled_opacity(60), None);

        let mut slide = plan.clone();
        slide.animation = "slide_up".into();
        let start = slide.sample(15).unwrap();
        let entry = slide.sample(16).unwrap();
        let active = slide.sample(30).unwrap();
        let exit = slide.sample(58).unwrap();
        assert_eq!(start.translate_y, 48.0);
        assert!((entry.translate_y - 24.576).abs() < 0.001);
        assert_eq!(active.translate_y, 0.0);
        assert_eq!(exit.translate_y, -12.0);
        assert_eq!(entry.scale, 1.0);
        assert_eq!(active.opacity, 1.0);

        let mut pop = plan.clone();
        pop.animation = "pop".into();
        assert!((pop.sample(16).unwrap().scale - 0.8464).abs() < 0.001);
        assert_eq!(pop.sample(30).unwrap().scale, 1.0);
        assert!((pop.sample(58).unwrap().scale - 0.97).abs() < 0.001);

        let mut spring = plan;
        spring.animation = "spring_soft".into();
        assert!((spring.sample(17).unwrap().scale - 1.051111).abs() < 0.001);
        assert_eq!(spring.sample(30).unwrap().scale, 1.0);
        assert!((spring.sample(58).unwrap().scale - 0.97).abs() < 0.001);

        let mut tracked = spring;
        tracked.animation = "fade".into();
        tracked.track_id = Some("subject".into());
        tracked.tracking_samples = vec![
            MotionGraphicTrackingSample {
                timeline_frame: 15,
                x: 0.2,
                y: 0.3,
                confidence: 0.9,
                status: MotionGraphicTrackingStatus::Tracked,
                rotation_radians: 0.0,
                scale: 1.0,
                destination_quad: None,
            },
            MotionGraphicTrackingSample {
                timeline_frame: 30,
                x: 0.3,
                y: 0.35,
                confidence: 0.8,
                status: MotionGraphicTrackingStatus::Tracked,
                rotation_radians: 0.2,
                scale: 1.2,
                destination_quad: None,
            },
            MotionGraphicTrackingSample {
                timeline_frame: 45,
                x: 0.3,
                y: 0.35,
                confidence: 0.0,
                status: MotionGraphicTrackingStatus::Lost,
                rotation_radians: 0.2,
                scale: 1.2,
                destination_quad: None,
            },
            MotionGraphicTrackingSample {
                timeline_frame: 50,
                x: 0.4,
                y: 0.4,
                confidence: 0.75,
                status: MotionGraphicTrackingStatus::Tracked,
                rotation_radians: 0.3,
                scale: 1.3,
                destination_quad: None,
            },
        ];
        let attached = tracked.sample(30).unwrap();
        assert!((attached.translate_x - 192.0).abs() < 0.001);
        assert!((attached.translate_y - 135.0).abs() < 0.001);
        assert!((attached.rotation_radians - 0.2).abs() < 0.001);
        assert!((attached.scale - 1.2).abs() < 0.001);
        assert_eq!(attached.tracking_scale, Some(1.2));
        assert_eq!(
            attached.tracking_status,
            Some(MotionGraphicTrackingStatus::Tracked)
        );
        assert!(tracked.sample(45).is_none());
        assert!(tracked.sample(48).is_none());
        assert!(tracked.sample(50).is_some());
    }

    #[test]
    fn projective_homography_maps_every_destination_corner_back_to_source() {
        let destination = [
            (-210.0, -110.0),
            (180.0, -145.0),
            (230.0, 125.0),
            (-245.0, 155.0),
        ];
        let source = [
            (-160.0, -80.0),
            (160.0, -80.0),
            (160.0, 80.0),
            (-160.0, 80.0),
        ];
        let homography = solve_destination_to_source_homography(destination, source)
            .expect("solve projective transform");
        for (destination, expected) in destination.into_iter().zip(source) {
            let denominator =
                homography[6] as f64 * destination.0 + homography[7] as f64 * destination.1 + 1.0;
            let observed = (
                (homography[0] as f64 * destination.0
                    + homography[1] as f64 * destination.1
                    + homography[2] as f64)
                    / denominator,
                (homography[3] as f64 * destination.0
                    + homography[4] as f64 * destination.1
                    + homography[5] as f64)
                    / denominator,
            );
            assert!((observed.0 - expected.0).abs() < 0.001);
            assert!((observed.1 - expected.1).abs() < 0.001);
        }
        assert!(solve_destination_to_source_homography([(0.0, 0.0); 4], source).is_err());
    }

    #[test]
    fn resident_scene_linear_video_requires_explicit_input_and_single_display_transforms() {
        let value = serde_json::json!({
            "schema": "editkin.engine-graph/v1",
            "graphId": "scene-linear-video-contract",
            "width": 960,
            "height": 540,
            "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba32_float",
            "cacheBudgetMb": 64,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "linear", "inputs": ["transform"], "enabled": true, "kind": "color", "processor": "editkin-srgb-to-linear-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "linear_rec709", "outputSpace": "linear_rec709" },
                { "id": "adjustment", "inputs": ["linear"], "enabled": true, "kind": "adjustment", "affectedInputs": ["linear"], "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 90 } },
                { "id": "grade", "inputs": ["adjustment"], "enabled": true, "kind": "color", "processor": "editkin-linear-primary/v1", "inputSpace": "linear_rec709", "workingSpace": "linear_rec709", "outputSpace": "linear_rec709", "grade": { "brightness": 0, "contrast": 1, "saturation": 1, "hue": 0, "exposure": 0.25, "temperature": 0, "tint": 0, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 } },
                { "id": "display", "inputs": ["grade"], "enabled": true, "kind": "color", "processor": "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1", "inputSpace": "linear_rec709", "workingSpace": "ACEScct", "outputSpace": "rec709_sdr" },
                { "id": "output", "inputs": ["display"], "enabled": true, "kind": "output", "format": "rgba32_float" }
            ],
            "outputNode": "output"
        });
        let graph: EngineGraph = serde_json::from_value(value.clone()).unwrap();
        let bindings = BTreeMap::from([("video".into(), PathBuf::from("plate.mp4"))]);
        let prepared = prepare_video(graph, &bindings, Path::new("."))
            .expect("explicit decoded input transform and one ACES display transform must lower");
        assert_eq!(
            prepared.display_transform,
            EngineDisplayTransform::Aces2Rec709Sdr
        );
        assert_eq!(prepared.layers.len(), 1);
        assert_eq!(prepared.adjustments.len(), 1);
        assert_eq!(prepared.resource_plan.working_bytes_per_pixel, 8);

        let mut pq = value.clone();
        pq["nodes"][5]["processor"] = serde_json::json!(
            "editkin-ocio-aces2-linear-rec709-to-rec2100-pq-1000/v1"
        );
        pq["nodes"][5]["outputSpace"] = serde_json::json!("rec2100_pq_1000");
        let prepared_pq = prepare_video(
            serde_json::from_value(pq).unwrap(),
            &bindings,
            Path::new("."),
        )
        .expect("the explicit ACES2 Rec.2100 PQ display transform must lower");
        assert_eq!(
            prepared_pq.display_transform,
            EngineDisplayTransform::Aces2Rec2100Pq1000
        );

        let mut bypass = value.clone();
        bypass["nodes"][2]["processor"] = serde_json::json!("editkin-linear-primary/v1");
        assert!(
            prepare_video(
                serde_json::from_value(bypass).unwrap(),
                &bindings,
                Path::new(".")
            )
            .is_err()
        );

        let mut graded_display = value;
        graded_display["nodes"][5]["grade"] = serde_json::json!({ "brightness": 0, "contrast": 1, "saturation": 1, "hue": 0, "exposure": 0.1, "temperature": 0, "tint": 0, "pivot": 0.5, "shadows": 0, "highlights": 0, "blacks": 0, "whites": 0 });
        assert!(
            prepare_video(
                serde_json::from_value(graded_display).unwrap(),
                &bindings,
                Path::new(".")
            )
            .is_err()
        );
    }

    #[test]
    fn resident_scene_linear_video_lowers_decoded_temporal_sampling_and_particles() {
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "scene-linear-temporal-particle-contract",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 192,
            "nodes": [
                { "id": "source", "inputs": [], "enabled": true, "kind": "source", "assetId": "video", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "transform", "inputs": ["source"], "enabled": true, "kind": "transform2d", "x": -180, "y": 0, "scaleX": 0.65, "scaleY": 0.65, "rotationRadians": -0.1, "opacity": 1, "keyframes": [{ "frame": 14, "x": 180, "y": 0, "scaleX": 0.65, "scaleY": 0.65, "rotationRadians": 0.1, "opacity": 1, "easing": "linear" }] },
                { "id": "linear", "inputs": ["transform"], "enabled": true, "kind": "color", "processor": "editkin-srgb-to-linear-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "linear_rec709", "outputSpace": "linear_rec709" },
                { "id": "blur", "inputs": ["linear"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "particles", "inputs": [], "enabled": true, "kind": "particle_emitter", "timeline": { "timelineStartFrame": 4, "sourceStartFrame": 0, "durationFrames": 6 }, "seed": 32021, "ratePerSecond": 72, "lifetimeSeconds": 1.25, "initialVelocity": [18, -76, 0], "gravity": [0, 82, 0], "maxParticles": 48, "emitterPosition": [0.5, 0.72], "radiusPixels": 3.25, "color": [0.66, 1, 0.24, 0.92] },
                { "id": "composite", "inputs": ["blur", "particles"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "display", "inputs": ["composite"], "enabled": true, "kind": "color", "processor": "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1", "inputSpace": "linear_rec709", "workingSpace": "ACEScct", "outputSpace": "rec709_sdr" },
                { "id": "output", "inputs": ["display"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        }))
        .expect("scene-linear temporal particle fixture must deserialize");
        let prepared = prepare_video(
            graph,
            &BTreeMap::from([("video".into(), PathBuf::from("video.mp4"))]),
            Path::new("."),
        )
        .expect(
            "scene-linear decoded temporal sampling and one bounded particle emitter must lower",
        );
        assert_eq!(
            prepared.display_transform,
            EngineDisplayTransform::Aces2Rec709Sdr
        );
        assert_eq!(prepared.resource_plan.working_bytes_per_pixel, 8);
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.resource_plan.particle_count, 1);
        assert_eq!(prepared.particles.len(), 1);
    }

    #[test]
    fn resident_scene_linear_video_converges_effects_static_matte_temporal_target_and_particles_but_rejects_temporal_effects()
     {
        let plugin_identity = "creator.scene-linear/look@1.0.0#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let value = serde_json::json!({
            "schema": "editkin.engine-graph/v1", "graphId": "scene-linear-effect-matte-contract",
            "width": 960, "height": 540, "timebase": { "numerator": 1, "denominator": 30 },
            "workingFormat": "rgba16_float", "cacheBudgetMb": 96,
            "nodes": [
                { "id": "matte-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "matte", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 0, "durationFrames": 60 } },
                { "id": "matte-transform", "inputs": ["matte-source"], "enabled": true, "kind": "transform2d", "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotationRadians": 0, "opacity": 1 },
                { "id": "matte-linear", "inputs": ["matte-transform"], "enabled": true, "kind": "color", "processor": "editkin-srgb-to-linear-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "linear_rec709", "outputSpace": "linear_rec709" },
                { "id": "matte-effect", "inputs": ["matte-linear"], "enabled": true, "kind": "effect", "pluginId": "editkin.builtin.mono_halftone", "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "target-source", "inputs": [], "enabled": true, "kind": "source", "assetId": "target", "mediaKind": "video", "inputColorSpace": "rec709", "timeline": { "timelineStartFrame": 0, "sourceStartFrame": 30, "durationFrames": 60 } },
                { "id": "target-transform", "inputs": ["target-source"], "enabled": true, "kind": "transform2d", "x": -180, "y": 0, "scaleX": 0.65, "scaleY": 0.65, "rotationRadians": -0.1, "opacity": 1, "keyframes": [{ "frame": 14, "x": 180, "y": 0, "scaleX": 0.65, "scaleY": 0.65, "rotationRadians": 0.1, "opacity": 1, "easing": "linear" }] },
                { "id": "target-linear", "inputs": ["target-transform"], "enabled": true, "kind": "color", "processor": "editkin-srgb-to-linear-rec709-primary/v1", "inputSpace": "rec709", "workingSpace": "linear_rec709", "outputSpace": "linear_rec709" },
                { "id": "target-effect", "inputs": ["target-linear"], "enabled": true, "kind": "effect", "pluginId": plugin_identity, "abiVersion": 1, "temporalRadius": 0, "parameters": {} },
                { "id": "target-blur", "inputs": ["target-effect"], "enabled": true, "kind": "motion_blur", "shutterAngle": 360, "samples": 8, "sourceSampling": "decoded_temporal" },
                { "id": "composite", "inputs": ["matte-effect", "target-blur"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1, "matteInput": "matte-effect", "matteMode": "luma" },
                { "id": "particles", "inputs": [], "enabled": true, "kind": "particle_emitter", "timeline": { "timelineStartFrame": 4, "sourceStartFrame": 0, "durationFrames": 6 }, "seed": 32021, "ratePerSecond": 72, "lifetimeSeconds": 1.25, "initialVelocity": [18, -76, 0], "gravity": [0, 82, 0], "maxParticles": 48, "emitterPosition": [0.5, 0.72], "radiusPixels": 3.25, "color": [0.66, 1, 0.24, 0.92] },
                { "id": "particle-composite", "inputs": ["composite", "particles"], "enabled": true, "kind": "composite", "blendMode": "normal", "opacity": 1 },
                { "id": "display", "inputs": ["particle-composite"], "enabled": true, "kind": "color", "processor": "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1", "inputSpace": "linear_rec709", "workingSpace": "ACEScct", "outputSpace": "rec709_sdr" },
                { "id": "output", "inputs": ["display"], "enabled": true, "kind": "output", "format": "rgba16_float" }
            ], "outputNode": "output"
        });
        let bindings = BTreeMap::from([
            ("matte".into(), PathBuf::from("matte.mp4")),
            ("target".into(), PathBuf::from("target.mp4")),
        ]);
        let effect_bindings = GpuEffectBindings {
            schema: GPU_EFFECT_BINDINGS_SCHEMA.into(),
            bindings: BTreeMap::from([(
                "target-effect".into(),
                bound_gpu_effect("target-effect", plugin_identity, 1, 0.82),
            )]),
        };
        let prepared = prepare_video_with_effects(
            serde_json::from_value(value.clone()).unwrap(),
            &bindings,
            Path::new("."),
            &effect_bindings,
        )
        .expect("scene-linear bounded effects and one track matte must lower");
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.layers[0].visual.effect_kind, 1);
        assert_eq!(prepared.layers[1].visual.shader_effects.len(), 1);
        assert_eq!(prepared.layers[1].matte_layer_index, Some(0));
        assert_eq!(prepared.layers[1].matte_mode, Some(MatteMode::Luma));
        assert_eq!(prepared.resource_plan.temporal_sample_count, 8);
        assert_eq!(prepared.resource_plan.particle_count, 1);
        assert_eq!(prepared.particles.len(), 1);

        let mut temporal = value;
        temporal["nodes"][7]["temporalRadius"] = serde_json::json!(1);
        assert!(
            prepare_video_with_effects(
                serde_json::from_value(temporal).unwrap(),
                &bindings,
                Path::new("."),
                &effect_bindings,
            )
            .is_err()
        );
    }
}

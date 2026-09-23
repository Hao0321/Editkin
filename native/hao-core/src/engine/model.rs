use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ENGINE_GRAPH_SCHEMA: &str = "editkin.engine-graph/v1";
pub const ENGINE_ABI_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PixelFormat {
    Rgba8,
    Rgba16Float,
    Rgba32Float,
    Alpha8,
    Alpha16,
}

/// Declares how RGB relates to alpha at the source boundary. `Auto` is retained for
/// backwards-compatible project files and is resolved by the executor from `mediaKind`
/// (`video` => opaque, image/generator => straight). Working buffers remain straight-alpha.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlphaMode {
    #[default]
    Auto,
    Opaque,
    Straight,
    Premultiplied,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatteMode {
    Alpha,
    AlphaInverted,
    Luma,
    LumaInverted,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LightKind {
    Ambient,
    Directional,
    Point,
    Spot,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationInterpolation {
    Hold,
    Linear,
    Smooth,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EngineStage {
    Decode,
    Analysis,
    Geometry,
    Matte,
    Color,
    Effect,
    Composite,
    Simulation,
    Audio,
    Output,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RationalTimebase {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineGraph {
    pub schema: String,
    pub graph_id: String,
    pub width: u32,
    pub height: u32,
    pub timebase: RationalTimebase,
    pub working_format: PixelFormat,
    #[serde(default = "default_cache_budget")]
    pub cache_budget_mb: u64,
    pub nodes: Vec<EngineNode>,
    pub output_node: String,
    #[serde(default)]
    pub audio: Option<AudioGraph>,
}

fn default_cache_budget() -> u64 {
    1024
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineNode {
    pub id: String,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(flatten)]
    pub operation: NodeOperation,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeFrameRange {
    pub timeline_start_frame: u64,
    pub source_start_frame: u64,
    pub duration_frames: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", from = "PrimaryGradeWire")]
pub struct PrimaryGrade {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub hue: f32,
    pub exposure: f32,
    pub temperature: f32,
    pub tint: f32,
    pub pivot: f32,
    pub shadows: f32,
    pub highlights: f32,
    pub blacks: f32,
    pub whites: f32,
    pub white_balance_red: f32,
    pub white_balance_green: f32,
    pub white_balance_blue: f32,
    /// Presence is retained for the v2 graph contract; absent old fields mean identity only.
    #[serde(skip)]
    pub white_balance_fields_present: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrimaryGradeWire {
    brightness: f32, contrast: f32, saturation: f32, hue: f32,
    exposure: f32, temperature: f32, tint: f32, pivot: f32,
    shadows: f32, highlights: f32, blacks: f32, whites: f32,
    white_balance_red: Option<f32>,
    white_balance_green: Option<f32>,
    white_balance_blue: Option<f32>,
}

impl From<PrimaryGradeWire> for PrimaryGrade {
    fn from(value: PrimaryGradeWire) -> Self {
        Self {
            brightness: value.brightness, contrast: value.contrast, saturation: value.saturation,
            hue: value.hue, exposure: value.exposure, temperature: value.temperature,
            tint: value.tint, pivot: value.pivot, shadows: value.shadows,
            highlights: value.highlights, blacks: value.blacks, whites: value.whites,
            white_balance_red: value.white_balance_red.unwrap_or(0.0),
            white_balance_green: value.white_balance_green.unwrap_or(0.0),
            white_balance_blue: value.white_balance_blue.unwrap_or(0.0),
            white_balance_fields_present: u8::from(value.white_balance_red.is_some())
                | (u8::from(value.white_balance_green.is_some()) << 1)
                | (u8::from(value.white_balance_blue.is_some()) << 2),
        }
    }
}

impl PartialEq for PrimaryGrade {
    fn eq(&self, other: &Self) -> bool { self.values() == other.values() }
}

impl Default for PrimaryGrade {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            hue: 0.0,
            exposure: 0.0,
            temperature: 0.0,
            tint: 0.0,
            pivot: 0.5,
            shadows: 0.0,
            highlights: 0.0,
            blacks: 0.0,
            whites: 0.0,
            white_balance_red: 0.0,
            white_balance_green: 0.0,
            white_balance_blue: 0.0,
            white_balance_fields_present: 0,
        }
    }
}

impl PrimaryGrade {
    pub fn values(self) -> [f32; 15] {
        [
            self.brightness,
            self.contrast,
            self.saturation,
            self.hue,
            self.exposure,
            self.temperature,
            self.tint,
            self.pivot,
            self.shadows,
            self.highlights,
            self.blacks,
            self.whites,
            self.white_balance_red,
            self.white_balance_green,
            self.white_balance_blue,
        ]
    }

    pub fn is_identity(self) -> bool {
        self == Self::default()
    }
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyframeEasing {
    Linear,
    Hold,
    EaseIn,
    EaseOut,
    EaseInOut,
    SpringSoft,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform2dKeyframe {
    pub frame: u64,
    pub x: f32,
    pub y: f32,
    pub scale_x: f32,
    pub scale_y: f32,
    pub rotation_radians: f32,
    pub opacity: f32,
    pub easing: KeyframeEasing,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DepthOfFieldKeyframe {
    pub frame: u64,
    pub focus_distance: f32,
    pub aperture: f32,
    pub max_blur_radius: f32,
    pub easing: KeyframeEasing,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraKeyframe {
    pub frame: u64,
    pub position: [f32; 3],
    pub target: [f32; 3],
    pub vertical_fov_radians: f32,
    pub easing: KeyframeEasing,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LightKeyframe {
    pub frame: u64,
    pub color: [f32; 3],
    pub intensity: f32,
    pub direction: [f32; 3],
    pub easing: KeyframeEasing,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MotionGraphicTrackingStatus {
    Tracked,
    Held,
    Lost,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotionGraphicQuadPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotionGraphicTrackingSample {
    pub timeline_frame: u64,
    pub x: f32,
    pub y: f32,
    pub confidence: f32,
    pub status: MotionGraphicTrackingStatus,
    pub rotation_radians: f32,
    pub scale: f32,
    #[serde(default)]
    pub destination_quad: Option<[MotionGraphicQuadPoint; 4]>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotionGraphicTracking {
    pub track_id: String,
    pub samples: Vec<MotionGraphicTrackingSample>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MotionBlurSourceSampling {
    /// Compatibility mode: every shutter transform samples the currently decoded texture.
    #[default]
    CurrentFrame,
    /// Decode and retain the bounded shutter window before one GPU accumulation pass.
    DecodedTemporal,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NodeOperation {
    Source {
        asset_id: String,
        media_kind: String,
        #[serde(default)]
        input_color_space: Option<String>,
        #[serde(default)]
        alpha_mode: AlphaMode,
        #[serde(default)]
        timeline: Option<NodeFrameRange>,
    },
    Transform2d {
        x: f32,
        y: f32,
        scale_x: f32,
        scale_y: f32,
        rotation_radians: f32,
        opacity: f32,
        #[serde(default)]
        keyframes: Vec<Transform2dKeyframe>,
        #[serde(default)]
        parent: Option<String>,
    },
    Transform3d {
        position: [f32; 3],
        rotation_radians: [f32; 3],
        scale: [f32; 3],
        #[serde(default)]
        parent: Option<String>,
    },
    Camera {
        position: [f32; 3],
        target: [f32; 3],
        up: [f32; 3],
        vertical_fov_radians: f32,
        near: f32,
        far: f32,
        #[serde(default)]
        keyframes: Vec<CameraKeyframe>,
    },
    Light {
        light_kind: LightKind,
        color: [f32; 3],
        intensity: f32,
        position: [f32; 3],
        direction: [f32; 3],
        #[serde(default)]
        keyframes: Vec<LightKeyframe>,
    },
    Mask {
        matte_id: String,
        matte_mode: MatteMode,
        feather: f32,
        expansion: f32,
    },
    AutoRoto {
        sequence_id: String,
        model_id: String,
        model_sha256: String,
        cache_manifest: String,
        frozen: bool,
    },
    Color {
        processor: String,
        input_space: String,
        working_space: String,
        output_space: String,
        #[serde(default)]
        grade: PrimaryGrade,
    },
    Effect {
        plugin_id: String,
        abi_version: u32,
        #[serde(default)]
        temporal_radius: u32,
        #[serde(default)]
        parameters: BTreeMap<String, f64>,
    },
    Composite {
        blend_mode: BlendMode,
        opacity: f32,
        #[serde(default)]
        matte_input: Option<String>,
        #[serde(default)]
        matte_mode: Option<MatteMode>,
    },
    Adjustment {
        #[serde(default)]
        affected_inputs: Vec<String>,
        #[serde(default)]
        timeline: Option<NodeFrameRange>,
    },
    Precomposition {
        nested_graph_id: String,
        timeline: NodeFrameRange,
    },
    Caption {
        cue_id: String,
        text: String,
        timeline: NodeFrameRange,
        font_family: String,
        font_size: f32,
        text_color: String,
        outline_color: String,
        outline_width: f32,
        background_color: String,
        alignment: u8,
        margin_vertical: f32,
        bold: bool,
        italic: bool,
        #[serde(default)]
        shadow: f32,
        #[serde(default)]
        letter_spacing: f32,
        #[serde(default)]
        translation: Option<String>,
    },
    MotionGraphic {
        graphic_id: String,
        graphic_kind: String,
        text: String,
        timeline: NodeFrameRange,
        x: f32,
        y: f32,
        width: f32,
        font_size: f32,
        font_family: String,
        font_weight: u16,
        letter_spacing: f32,
        outline_width: f32,
        shadow_depth: f32,
        corner_radius: f32,
        text_color: String,
        background_color: String,
        accent_color: String,
        #[serde(default = "default_motion_graphic_visual_style")]
        visual_style: String,
        animation: String,
        #[serde(default = "default_motion_graphic_tracking_mode")]
        tracking_mode: String,
        offset_x: f32,
        offset_y: f32,
        #[serde(default)]
        tracking: Option<MotionGraphicTracking>,
    },
    ParticleEmitter {
        #[serde(default)]
        timeline: Option<NodeFrameRange>,
        seed: u64,
        rate_per_second: f32,
        lifetime_seconds: f32,
        initial_velocity: [f32; 3],
        gravity: [f32; 3],
        max_particles: u32,
        #[serde(default = "default_particle_emitter_position")]
        emitter_position: [f32; 2],
        #[serde(default = "default_particle_radius_pixels")]
        radius_pixels: f32,
        #[serde(default = "default_particle_color")]
        color: [f32; 4],
    },
    DepthOfField {
        focus_distance: f32,
        aperture: f32,
        max_blur_radius: f32,
        #[serde(default)]
        keyframes: Vec<DepthOfFieldKeyframe>,
    },
    MotionBlur {
        shutter_angle: f32,
        samples: u32,
        #[serde(default)]
        source_sampling: MotionBlurSourceSampling,
    },
    Output {
        format: PixelFormat,
    },
}

fn default_motion_graphic_tracking_mode() -> String {
    "anchor".into()
}

fn default_motion_graphic_visual_style() -> String {
    "solid_panel".into()
}

fn default_particle_emitter_position() -> [f32; 2] {
    [0.5, 0.72]
}

fn default_particle_radius_pixels() -> f32 {
    3.0
}

fn default_particle_color() -> [f32; 4] {
    [1.0, 0.42, 0.06, 0.92]
}

impl NodeOperation {
    pub fn stage(&self) -> EngineStage {
        match self {
            Self::Source { .. } => EngineStage::Decode,
            Self::AutoRoto { .. } => EngineStage::Analysis,
            Self::Transform2d { .. }
            | Self::Transform3d { .. }
            | Self::Camera { .. }
            | Self::Light { .. } => EngineStage::Geometry,
            Self::Mask { .. } => EngineStage::Matte,
            Self::Color { .. } => EngineStage::Color,
            Self::Effect { .. } | Self::DepthOfField { .. } | Self::MotionBlur { .. } => {
                EngineStage::Effect
            }
            Self::Composite { .. }
            | Self::Adjustment { .. }
            | Self::Precomposition { .. }
            | Self::Caption { .. }
            | Self::MotionGraphic { .. } => EngineStage::Composite,
            Self::ParticleEmitter { .. } => EngineStage::Simulation,
            Self::Output { .. } => EngineStage::Output,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioGraph {
    pub sample_rate: u32,
    pub channels: u16,
    pub master_node: String,
    pub nodes: Vec<AudioNode>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioNode {
    pub id: String,
    #[serde(default)]
    pub inputs: Vec<String>,
    pub operation: AudioOperation,
    #[serde(default)]
    pub automation: Vec<AutomationLane>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioOperation {
    Source {
        asset_id: String,
    },
    Gain {
        gain_db: f32,
    },
    Pan {
        pan: f32,
    },
    Eq {
        low_db: f32,
        mid_db: f32,
        high_db: f32,
    },
    Compressor {
        threshold_db: f32,
        ratio: f32,
    },
    Ducker {
        threshold_db: f32,
        floor_db: f32,
        attack_ms: f32,
        release_ms: f32,
    },
    Limiter {
        ceiling_db: f32,
    },
    Bus,
    Output,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationLane {
    pub property: String,
    pub points: Vec<AutomationPoint>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPoint {
    pub sample: u64,
    pub value: f32,
    pub interpolation: AutomationInterpolation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledPass {
    pub node_id: String,
    pub stage: EngineStage,
    pub inputs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledGraph {
    pub schema: &'static str,
    pub engine_abi_version: u32,
    pub graph_id: String,
    pub timebase: RationalTimebase,
    pub working_format: PixelFormat,
    pub output_node: String,
    pub passes: Vec<CompiledPass>,
    pub audio_node_count: usize,
    pub cache_budget_mb: u64,
    pub feature_families: Vec<&'static str>,
}

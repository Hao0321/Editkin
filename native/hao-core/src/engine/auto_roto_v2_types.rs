use super::auto_roto::{AutoRotoReceipt, RegionMemoryRoutingReceipt};
use super::roto_edge_v2::{RotoEdgeReceiptV2, RotoEdgeSettingsV2};
use serde::Serialize;

pub const AUTO_ROTO_V2_ENGINE: &str = "editkin-native-roto-edge/v2";

/// Untagged serialization preserves every v1 field, value and its struct field order.
#[derive(Serialize)]
#[serde(untagged)]
pub enum AutoRotoCliReceipt {
    V1(AutoRotoReceipt),
    V2(AutoRotoReceiptV2),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRotoFrameV2 {
    pub frame: usize,
    pub time: f64,
    pub alpha_path: String,
    pub confidence: f32,
    pub manual_pixels_restored: usize,
    pub edge_refinement: RotoEdgeReceiptV2,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRotoReceiptV2 {
    pub schema: &'static str,
    pub engine: &'static str,
    pub quality_state: &'static str,
    pub sample_time_kind: &'static str,
    pub width: usize,
    pub height: usize,
    pub frame_count: usize,
    pub analysis_fps: f64,
    pub initial_frame: usize,
    pub source_raw_sha256: String,
    pub alpha_format: &'static str,
    pub alpha_path: &'static str,
    pub straight_rgb_path: &'static str,
    pub alpha_bytes: u64,
    pub straight_rgb_bytes: u64,
    pub coarse_engine: String,
    pub coarse_routing: RegionMemoryRoutingReceipt,
    pub correction_strokes_applied: usize,
    pub corrected_frames: Vec<usize>,
    pub edge_settings: RotoEdgeSettingsV2,
    pub frames: Vec<AutoRotoFrameV2>,
}

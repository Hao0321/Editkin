//! Exact authored frame poses over one bounded native paint scene.
//! `sourceSignature` is an opaque equality binding, not font or renderer authority.
use super::composite::{FloatFrame, LinearRgba};
use super::model::NodeFrameRange;
use super::motion_paint::{
    LayerPose, MAX_COMMANDS, MAX_LAYERS, MAX_PIXELS, MAX_SEGMENTS, PaintScene, PaintScratch,
    PreparedPaintScene,
};
use serde::{Deserialize, Deserializer, Serialize};

pub const NATIVE_MOTION_PAINT_TRACK_SCHEMA: &str = "editkin.native-motion-paint-track/v1";
pub const NATIVE_MOTION_PAINT_DISPLAY_TRACK_SCHEMA: &str = "editkin.native-motion-paint-track/v2";
pub const MAX_TRACK_POSES: usize = 18_000;
pub const MAX_SOURCE_SIGNATURE_BYTES: usize = 65_536;
pub type RenderScratch = PaintScratch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeMotionPaintColorIntent {
    #[serde(rename = "display_rec709_sdr")]
    DisplayRec709Sdr,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMotionPaintTrack {
    pub schema: String,
    /// Only v2 carries an explicit intent. Missing v1 intent retains its original
    /// scene-linear behavior and serialized shape; it is never upgraded implicitly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_intent: Option<NativeMotionPaintColorIntent>,
    pub scene: PaintScene,
    pub timeline: NodeFrameRange,
    /// Local integer frame index, then the scene's stable layer order.
    pub frames: Vec<Vec<LayerPose>>,
    pub source_signature: String,
}

impl<'de> Deserialize<'de> for NativeMotionPaintTrack {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct StrictTrack {
            schema: String,
            #[serde(default, deserialize_with = "deserialize_color_intent")]
            color_intent: Option<NativeMotionPaintColorIntent>,
            scene: PaintScene,
            #[serde(deserialize_with = "deserialize_timeline")]
            timeline: NodeFrameRange,
            frames: Vec<Vec<LayerPose>>,
            source_signature: String,
        }
        let wire = StrictTrack::deserialize(deserializer)?;
        match (wire.schema.as_str(), wire.color_intent) {
            (NATIVE_MOTION_PAINT_TRACK_SCHEMA, None)
            | (NATIVE_MOTION_PAINT_DISPLAY_TRACK_SCHEMA,
                Some(NativeMotionPaintColorIntent::DisplayRec709Sdr)) => {}
            _ => return Err(serde::de::Error::custom("native paint schema and required color intent differ")),
        }
        Ok(Self {
            schema: wire.schema,
            color_intent: wire.color_intent,
            scene: wire.scene,
            timeline: wire.timeline,
            frames: wire.frames,
            source_signature: wire.source_signature,
        })
    }
}

fn deserialize_color_intent<'de, D>(deserializer: D) -> Result<Option<NativeMotionPaintColorIntent>, D::Error>
where
    D: Deserializer<'de>,
{
    // The field's default handles absence. An explicitly authored null is invalid.
    NativeMotionPaintColorIntent::deserialize(deserializer).map(Some)
}

fn deserialize_timeline<'de, D>(deserializer: D) -> Result<NodeFrameRange, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct StrictTimeline {
        timeline_start_frame: u64,
        source_start_frame: u64,
        duration_frames: u64,
    }
    let range = StrictTimeline::deserialize(deserializer)?;
    Ok(NodeFrameRange {
        timeline_start_frame: range.timeline_start_frame,
        source_start_frame: range.source_start_frame,
        duration_frames: range.duration_frames,
    })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NativeMotionPaintBudget {
    pub layers: usize,
    pub commands: usize,
    pub poses: usize,
}

impl NativeMotionPaintBudget {
    /// Shared graph admission happens before preparing any native geometry.
    pub fn include(&mut self, other: Self) -> Result<(), String> {
        let layers = self
            .layers
            .checked_add(other.layers)
            .ok_or("native paint layer count overflow")?;
        let commands = self
            .commands
            .checked_add(other.commands)
            .ok_or("native paint command count overflow")?;
        let poses = self
            .poses
            .checked_add(other.poses)
            .ok_or("native paint pose count overflow")?;
        if layers > MAX_LAYERS || commands > MAX_COMMANDS || poses > MAX_TRACK_POSES {
            return Err("shared native paint layer, command or pose budget exceeded".into());
        }
        *self = Self {
            layers,
            commands,
            poses,
        };
        Ok(())
    }
}

impl NativeMotionPaintTrack {
    pub fn is_display_referred(&self) -> bool {
        self.color_intent == Some(NativeMotionPaintColorIntent::DisplayRec709Sdr)
    }

    pub fn color_intent(&self) -> &'static str {
        if self.is_display_referred() { "display_rec709_sdr" } else { "scene_linear_rec709" }
    }

    pub fn composition_boundary(&self) -> &'static str {
        if self.is_display_referred() { "after_aces2_before_output_encoding" } else { "before_aces2" }
    }

    /// No FloatFrame, GPU texture or tessellation is allocated by this admission.
    pub fn validate_structure(
        &self,
        width: u32,
        height: u32,
    ) -> Result<NativeMotionPaintBudget, String> {
        match (self.schema.as_str(), self.color_intent) {
            (NATIVE_MOTION_PAINT_TRACK_SCHEMA, None)
            | (NATIVE_MOTION_PAINT_DISPLAY_TRACK_SCHEMA,
                Some(NativeMotionPaintColorIntent::DisplayRec709Sdr)) => {}
            _ => return Err("native paint schema and required color intent differ".into()),
        }
        if self.source_signature.trim().is_empty()
            || self.source_signature.len() > MAX_SOURCE_SIGNATURE_BYTES
        {
            return Err("native paint source signature must be nonblank and bounded".into());
        }
        if width == 0
            || height == 0
            || width > 8192
            || height > 8192
            || u64::from(width) * u64::from(height) > MAX_PIXELS
            || self.scene.width != width
            || self.scene.height != height
        {
            return Err("native paint scene dimensions differ from graph or exceed budget".into());
        }
        if self.scene.background != [0.0; 4] {
            return Err("native motion paint scene must have a transparent zero background".into());
        }
        if !self.scene.max_scale.is_finite() || !(1.0..=32.0).contains(&self.scene.max_scale) {
            return Err("native paint maximum scale invalid".into());
        }
        let duration = usize::try_from(self.timeline.duration_frames)
            .map_err(|_| "native paint duration exceeds addressable frames")?;
        if duration == 0
            || self.timeline.source_start_frame != 0
            || self
                .timeline
                .timeline_start_frame
                .checked_add(self.timeline.duration_frames)
                .is_none()
            || self.frames.len() != duration
        {
            return Err(
                "native paint timeline requires exact duration frames and source start zero".into(),
            );
        }
        let layers = self.scene.layers.len();
        let poses = layers
            .checked_mul(duration)
            .ok_or("native paint pose count overflow")?;
        if layers == 0 || layers > MAX_LAYERS || poses > MAX_TRACK_POSES {
            return Err("native paint layer or pose budget exceeded".into());
        }
        let mut commands = 0_usize;
        for layer in &self.scene.layers {
            if layer.clips.len() > 8 {
                return Err("native paint clip count exceeds budget".into());
            }
            for path in std::iter::once(&layer.path).chain(layer.clips.iter()) {
                commands = commands
                    .checked_add(path.commands.len())
                    .ok_or("native paint command count overflow")?;
                if commands > MAX_COMMANDS {
                    return Err("native paint command budget exceeded".into());
                }
            }
        }
        for poses in &self.frames {
            if poses.len() != layers {
                return Err(
                    "native paint frame pose count differs from stable scene layers".into(),
                );
            }
            if poses.iter().any(|pose| {
                !pose.x.is_finite()
                    || !pose.y.is_finite()
                    || pose.x.abs() > 1_000_000.0
                    || pose.y.abs() > 1_000_000.0
                    || !pose.scale.is_finite()
                    || !(0.01..=self.scene.max_scale).contains(&pose.scale)
                    || !pose.opacity.is_finite()
                    || !(0.0..=1.0).contains(&pose.opacity)
            }) {
                return Err(
                    "native paint frame pose contains invalid coordinates, scale or opacity".into(),
                );
            }
        }
        Ok(NativeMotionPaintBudget {
            layers,
            commands,
            poses,
        })
    }
}

#[derive(Clone, Debug)]
pub struct PreparedNativeMotionPaintTrack {
    scene: PreparedPaintScene,
    timeline: NodeFrameRange,
    frames: Vec<Vec<LayerPose>>,
    source_signature: String,
    color_intent: Option<NativeMotionPaintColorIntent>,
    budget: NativeMotionPaintBudget,
}

impl PreparedNativeMotionPaintTrack {
    pub fn prepare(
        track: &NativeMotionPaintTrack,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let budget = track.validate_structure(width, height)?;
        let scene = PreparedPaintScene::prepare(&track.scene)?;
        // Reuse the native library's transformed scan-work admission for every frame,
        // including transparent or currently offscreen poses, before output allocation.
        for (local_frame, poses) in track.frames.iter().enumerate() {
            scene
                .admit_poses(poses)
                .map_err(|error| format!("native paint frame {local_frame}: {error}"))?;
        }
        if scene.edge_count() > MAX_SEGMENTS {
            return Err("native paint flattened edge budget exceeded".into());
        }
        Ok(Self {
            scene,
            timeline: track.timeline.clone(),
            frames: track.frames.clone(),
            source_signature: track.source_signature.clone(),
            color_intent: track.color_intent,
            budget,
        })
    }

    pub fn width(&self) -> u32 {
        self.scene.width
    }
    pub fn height(&self) -> u32 {
        self.scene.height
    }
    pub fn timeline(&self) -> &NodeFrameRange {
        &self.timeline
    }
    pub fn source_signature(&self) -> &str {
        &self.source_signature
    }

    pub fn is_display_referred(&self) -> bool {
        self.color_intent == Some(NativeMotionPaintColorIntent::DisplayRec709Sdr)
    }

    pub fn color_intent(&self) -> &'static str {
        if self.is_display_referred() { "display_rec709_sdr" } else { "scene_linear_rec709" }
    }

    pub fn composition_boundary(&self) -> &'static str {
        if self.is_display_referred() { "after_aces2_before_output_encoding" } else { "before_aces2" }
    }
    pub fn budget(&self) -> NativeMotionPaintBudget {
        self.budget
    }
    pub fn edge_count(&self) -> usize {
        self.scene.edge_count()
    }
    pub fn layer_count(&self) -> usize {
        self.scene.layer_count()
    }
    pub fn layer_ids(&self) -> impl Iterator<Item = &str> {
        self.scene.layer_ids()
    }

    /// Half-open absolute timeline interval; exact integer samples, no interpolation.
    pub fn sample(&self, frame: u64) -> Option<&[LayerPose]> {
        let local = frame.checked_sub(self.timeline.timeline_start_frame)?;
        if local >= self.timeline.duration_frames {
            return None;
        }
        self.frames
            .get(usize::try_from(local).ok()?)
            .map(Vec::as_slice)
    }

    /// Compare complete authored pose content only inside this immutable prepared
    /// track. Its stable layer order, paths (including every revealed glyph's
    /// commands), paint and effects cannot change after preparation. Every pose
    /// component participates by its exact f32 bits; no epsilon or pixel-visibility
    /// shortcut may turn a changed/transparent layer into a hit. Inactive samples
    /// are deliberately never equivalent, even to another inactive sample.
    pub fn has_exact_pose_content(&self, left_frame: u64, right_frame: u64) -> bool {
        let (Some(left), Some(right)) = (self.sample(left_frame), self.sample(right_frame)) else {
            return false;
        };
        left.len() == right.len() && left.iter().zip(right).all(|(left, right)| {
            left.x.to_bits() == right.x.to_bits()
                && left.y.to_bits() == right.y.to_bits()
                && left.scale.to_bits() == right.scale.to_bits()
                && left.opacity.to_bits() == right.opacity.to_bits()
        })
    }

    /// Render native premultiplied linear Rec.709 pixels. The admitted color intent
    /// determines their composition boundary; it does not alter geometry or raster.
    /// Inactive samples
    /// clear the reusable frame so a seek cannot expose pixels from an earlier sample.
    pub fn render_at(
        &self,
        frame: u64,
        target: &mut FloatFrame,
        scratch: &mut RenderScratch,
    ) -> Result<(), String> {
        if target.width != self.width()
            || target.height != self.height()
            || target.pixels.len() != self.width() as usize * self.height() as usize
        {
            return Err("native paint target frame differs from prepared scene".into());
        }
        if let Some(poses) = self.sample(frame) {
            self.scene.render_into(target, poses, scratch)
        } else {
            target.pixels.fill(LinearRgba::default());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::model::{
        ENGINE_GRAPH_SCHEMA, EngineGraph, EngineNode, EngineStage, NodeOperation, PixelFormat,
        RationalTimebase,
    };
    use crate::engine::motion_paint::{
        FillRule, GradientStop, Paint, PaintLayer, PathCommand, Point, VectorPath,
    };
    use crate::engine::validate::compile_graph;

    fn rectangle(x0: f32, y0: f32, x1: f32, y1: f32) -> VectorPath {
        VectorPath {
            fill_rule: FillRule::NonZero,
            commands: vec![
                PathCommand::M { x: x0, y: y0 },
                PathCommand::L { x: x1, y: y0 },
                PathCommand::L { x: x1, y: y1 },
                PathCommand::L { x: x0, y: y1 },
                PathCommand::Z,
            ],
        }
    }

    fn track() -> NativeMotionPaintTrack {
        NativeMotionPaintTrack {
            schema: NATIVE_MOTION_PAINT_TRACK_SCHEMA.into(),
            color_intent: None,
            scene: PaintScene {
                width: 4,
                height: 4,
                background: [0.0; 4],
                max_scale: 2.0,
                layers: vec![PaintLayer {
                    id: "physical-glyph".into(),
                    path: rectangle(0.0, 0.0, 2.0, 2.0),
                    paint: Paint::Solid {
                        color: [1.0, 0.0, 0.0, 0.5],
                    },
                    clips: vec![],
                    stroke: None,
                    shadow: None,
                }],
            },
            timeline: NodeFrameRange {
                timeline_start_frame: 10,
                source_start_frame: 0,
                duration_frames: 2,
            },
            frames: vec![
                vec![LayerPose {
                    opacity: 0.5,
                    ..LayerPose::default()
                }],
                vec![LayerPose {
                    x: 1.0,
                    y: 1.0,
                    ..LayerPose::default()
                }],
            ],
            source_signature: "authored-equality-binding".into(),
        }
    }

    #[test]
    fn pose_content_requires_every_layer_and_every_exact_f32_component() {
        let mut authored = track();
        authored.scene.layers.push({
            let mut second = authored.scene.layers[0].clone();
            second.id = "second-revealed-glyph".into();
            second
        });
        authored.frames = vec![vec![LayerPose { opacity: 0.5, ..LayerPose::default() }; 2]; 2];
        let identical = PreparedNativeMotionPaintTrack::prepare(&authored, 4, 4).unwrap();
        assert!(identical.has_exact_pose_content(10, 11));
        assert!(identical.has_exact_pose_content(11, 10));
        for layer in 0..2 {
            for component in 0..4 {
                let mut changed = authored.clone();
                let pose = &mut changed.frames[1][layer];
                let value = match component {
                    0 => &mut pose.x, 1 => &mut pose.y,
                    2 => &mut pose.scale, _ => &mut pose.opacity,
                };
                *value = f32::from_bits(value.to_bits() + 1);
                let prepared = PreparedNativeMotionPaintTrack::prepare(&changed, 4, 4).unwrap();
                assert!(!prepared.has_exact_pose_content(10, 11), "layer{layer} component{component}");
                assert!(!prepared.has_exact_pose_content(11, 10));
            }
        }
        let mut signed_zero = authored.clone();
        signed_zero.frames[1][1].x = -0.0;
        let prepared = PreparedNativeMotionPaintTrack::prepare(&signed_zero, 4, 4).unwrap();
        assert!(!prepared.has_exact_pose_content(10, 11), "f32 signed zero is exact pose content");
        let mut hidden = authored.clone();
        for poses in &mut hidden.frames { poses[1].opacity = 0.0; }
        hidden.frames[1][1].x = 1.0;
        let prepared = PreparedNativeMotionPaintTrack::prepare(&hidden, 4, 4).unwrap();
        assert!(!prepared.has_exact_pose_content(10, 11), "hidden layers are not ignored");
    }

    #[test]
    fn pose_content_is_active_only_and_detached_from_mutable_source() {
        let mut authored = track();
        authored.frames[1] = authored.frames[0].clone();
        let prepared = PreparedNativeMotionPaintTrack::prepare(&authored, 4, 4).unwrap();
        assert!(prepared.has_exact_pose_content(10, 11));
        for (left, right) in [(9, 10), (10, 12), (9, 9), (12, 12)] {
            assert!(!prepared.has_exact_pose_content(left, right));
        }
        let mut original = FloatFrame::transparent(4, 4).unwrap();
        prepared.render_at(10, &mut original, &mut RenderScratch::default()).unwrap();
        authored.frames[0][0].x = 3.0;
        authored.scene.layers[0].path.commands.clear();
        authored.source_signature = "different-owner".into();
        assert!(prepared.has_exact_pose_content(10, 11));
        assert_eq!(prepared.source_signature(), "authored-equality-binding");
        let mut reread = FloatFrame::transparent(4, 4).unwrap();
        prepared.render_at(10, &mut reread, &mut RenderScratch::default()).unwrap();
        assert_eq!(original, reread, "immutable preparation retains its own path/style/pose bytes");
    }

    fn graph(track: NativeMotionPaintTrack) -> EngineGraph {
        EngineGraph {
            schema: ENGINE_GRAPH_SCHEMA.into(),
            graph_id: "native-paint".into(),
            width: 4,
            height: 4,
            timebase: RationalTimebase {
                numerator: 1,
                denominator: 30,
            },
            working_format: PixelFormat::Rgba16Float,
            cache_budget_mb: 64,
            nodes: vec![
                EngineNode {
                    id: "paint".into(),
                    inputs: vec![],
                    enabled: true,
                    operation: NodeOperation::NativeMotionPaint {
                        graphic_id: "graphic".into(),
                        track,
                    },
                },
                EngineNode {
                    id: "output".into(),
                    inputs: vec!["paint".into()],
                    enabled: true,
                    operation: NodeOperation::Output {
                        format: PixelFormat::Rgba16Float,
                    },
                },
            ],
            output_node: "output".into(),
            audio: None,
        }
    }

    #[test]
    fn strict_wire_contract_keeps_track_camel_case_and_rejects_nested_unknowns() {
        let value = serde_json::to_value(track()).unwrap();
        assert!(value.get("colorIntent").is_none(), "v1 keeps its original wire shape");
        assert!(value.get("sourceSignature").is_some());
        assert!(value["timeline"].get("timelineStartFrame").is_some());
        assert!(serde_json::from_value::<NativeMotionPaintTrack>(value.clone()).is_ok());
        for path in ["outer", "timeline", "scene", "pose"] {
            let mut invalid = value.clone();
            let object = match path {
                "outer" => invalid.as_object_mut().unwrap(),
                "timeline" => invalid["timeline"].as_object_mut().unwrap(),
                "scene" => invalid["scene"].as_object_mut().unwrap(),
                _ => invalid["frames"][0][0].as_object_mut().unwrap(),
            };
            object.insert("unrecognized".into(), serde_json::json!(true));
            assert!(
                serde_json::from_value::<NativeMotionPaintTrack>(invalid).is_err(),
                "{path}"
            );
        }
        let node = serde_json::to_value(&graph(track()).nodes[0]).unwrap();
        assert_eq!(node["kind"], "native_motion_paint");
        assert_eq!(node["graphicId"], "graphic");
        assert!(serde_json::from_value::<EngineNode>(node).is_ok());
    }

    #[test]
    fn versioned_display_intent_is_required_and_never_reinterprets_legacy_tracks() {
        let legacy = serde_json::to_value(track()).unwrap();
        let mut display = legacy.clone();
        display["schema"] = serde_json::json!(NATIVE_MOTION_PAINT_DISPLAY_TRACK_SCHEMA);
        display["colorIntent"] = serde_json::json!("display_rec709_sdr");
        let authored: NativeMotionPaintTrack = serde_json::from_value(display.clone()).unwrap();
        let prepared = PreparedNativeMotionPaintTrack::prepare(&authored, 4, 4).unwrap();
        assert_eq!(prepared.color_intent(), "display_rec709_sdr");
        assert_eq!(prepared.composition_boundary(), "after_aces2_before_output_encoding");
        let legacy_prepared = PreparedNativeMotionPaintTrack::prepare(&track(), 4, 4).unwrap();
        assert_eq!(legacy_prepared.color_intent(), "scene_linear_rec709");
        assert_eq!(legacy_prepared.composition_boundary(), "before_aces2");
        let mut legacy_with_intent = legacy.clone();
        legacy_with_intent["colorIntent"] = serde_json::json!("display_rec709_sdr");
        assert!(serde_json::from_value::<NativeMotionPaintTrack>(legacy_with_intent).is_err());
        let mut missing = display.clone();
        missing.as_object_mut().unwrap().remove("colorIntent");
        assert!(serde_json::from_value::<NativeMotionPaintTrack>(missing).is_err());
        for invalid in [serde_json::Value::Null, serde_json::json!("scene_linear_rec709"),
            serde_json::json!("display_rec2100_pq"), serde_json::json!(false)] {
            let mut changed = display.clone();
            changed["colorIntent"] = invalid;
            assert!(serde_json::from_value::<NativeMotionPaintTrack>(changed).is_err());
        }
        let mut from_display = FloatFrame::transparent(4, 4).unwrap();
        let mut from_legacy = FloatFrame::transparent(4, 4).unwrap();
        prepared.render_at(10, &mut from_display, &mut RenderScratch::default()).unwrap();
        legacy_prepared.render_at(10, &mut from_legacy, &mut RenderScratch::default()).unwrap();
        assert_eq!(from_display, from_legacy, "intent changes the boundary, never authored paint pixels");
    }

    #[test]
    fn admission_rejects_timeline_dimension_signature_and_topology_mismatches() {
        let mut invalids = Vec::new();
        let mut invalid = track();
        invalid.schema.push('x');
        invalids.push(invalid);
        let mut invalid = track();
        invalid.timeline.duration_frames = 0;
        invalids.push(invalid);
        let mut invalid = track();
        invalid.timeline.timeline_start_frame = u64::MAX;
        invalids.push(invalid);
        let mut invalid = track();
        invalid.timeline.source_start_frame = 1;
        invalids.push(invalid);
        let mut invalid = track();
        invalid.frames.pop();
        invalids.push(invalid);
        let mut invalid = track();
        invalid.frames[1].clear();
        invalids.push(invalid);
        let mut invalid = track();
        invalid.scene.layers.clear();
        invalids.push(invalid);
        let mut invalid = track();
        invalid.scene.width = 0;
        invalids.push(invalid);
        let mut invalid = track();
        invalid.scene.background[3] = 0.1;
        invalids.push(invalid);
        let mut invalid = track();
        invalid.source_signature = " \n\t".into();
        invalids.push(invalid);
        let mut invalid = track();
        invalid.source_signature = "字".repeat(MAX_SOURCE_SIGNATURE_BYTES / 3 + 1);
        invalids.push(invalid);
        for invalid in invalids {
            assert!(PreparedNativeMotionPaintTrack::prepare(&invalid, 4, 4).is_err());
        }
        assert!(PreparedNativeMotionPaintTrack::prepare(&track(), 8, 4).is_err());
        let mut huge = track();
        huge.scene.width = 8192;
        huge.scene.height = 8192;
        assert!(PreparedNativeMotionPaintTrack::prepare(&huge, 8192, 8192).is_err());
    }

    #[test]
    fn admission_checks_every_pose_and_the_exact_total_pose_bound() {
        let invalid_poses = [
            LayerPose {
                x: f32::NAN,
                ..LayerPose::default()
            },
            LayerPose {
                y: f32::INFINITY,
                ..LayerPose::default()
            },
            LayerPose {
                x: 1_000_001.0,
                ..LayerPose::default()
            },
            LayerPose {
                scale: 0.0,
                ..LayerPose::default()
            },
            LayerPose {
                scale: 2.01,
                ..LayerPose::default()
            },
            LayerPose {
                opacity: -0.01,
                ..LayerPose::default()
            },
            LayerPose {
                opacity: 1.01,
                ..LayerPose::default()
            },
        ];
        for pose in invalid_poses {
            let mut invalid = track();
            invalid.frames[1][0] = pose;
            assert!(PreparedNativeMotionPaintTrack::prepare(&invalid, 4, 4).is_err());
        }
        let mut bounded = track();
        bounded.timeline.duration_frames = MAX_TRACK_POSES as u64;
        bounded.frames = vec![vec![LayerPose::default()]; MAX_TRACK_POSES];
        assert_eq!(
            PreparedNativeMotionPaintTrack::prepare(&bounded, 4, 4)
                .unwrap()
                .budget()
                .poses,
            MAX_TRACK_POSES
        );
        bounded.timeline.duration_frames += 1;
        bounded.frames.push(vec![LayerPose::default()]);
        assert!(PreparedNativeMotionPaintTrack::prepare(&bounded, 4, 4).is_err());
    }

    #[test]
    fn native_preparation_rejects_bad_geometry_and_each_transformed_scan_budget() {
        let mut invalid = track();
        invalid.scene.layers[0].path.commands.pop();
        assert!(PreparedNativeMotionPaintTrack::prepare(&invalid, 4, 4).is_err());
        let mut scan = track();
        scan.scene.width = 1024;
        scan.scene.height = 1024;
        scan.scene.layers[0].path = rectangle(0.0, 0.0, 1000.0, 64.0);
        // Default preparation sees 64 rows; a later exact 32x scale covers the
        // 1,024-row target and exceeds the native frame scan-work budget.
        let commands = &mut scan.scene.layers[0].path.commands;
        commands.pop();
        for _ in 0..31_000 {
            commands.push(PathCommand::L { x: 1000.0, y: 64.0 });
            commands.push(PathCommand::L { x: 0.0, y: 0.0 });
        }
        commands.push(PathCommand::Z);
        scan.scene.max_scale = 32.0;
        scan.frames[1][0].scale = 32.0;
        assert!(
            PreparedNativeMotionPaintTrack::prepare(&scan, 1024, 1024)
                .unwrap_err()
                .contains("scanline edge work")
        );
    }

    #[test]
    fn integer_samples_seek_and_inactive_clear_preserve_exact_native_pixels() {
        let prepared = PreparedNativeMotionPaintTrack::prepare(&track(), 4, 4).unwrap();
        assert!(prepared.sample(9).is_none());
        assert_eq!(prepared.sample(10).unwrap()[0].opacity, 0.5);
        assert_eq!(prepared.sample(11).unwrap()[0].x, 1.0);
        assert!(prepared.sample(12).is_none());
        assert!(prepared.sample(u64::MAX).is_none());
        let mut target = FloatFrame::transparent(4, 4).unwrap();
        let mut scratch = RenderScratch::default();
        prepared.render_at(10, &mut target, &mut scratch).unwrap();
        assert_eq!(
            target.pixels[0],
            LinearRgba {
                r: 0.25,
                g: 0.0,
                b: 0.0,
                a: 0.25
            }
        );
        let first = target.clone();
        prepared.render_at(11, &mut target, &mut scratch).unwrap();
        assert_eq!(target.pixels[0], LinearRgba::default());
        assert_eq!(
            target.pixels[5],
            LinearRgba {
                r: 0.5,
                g: 0.0,
                b: 0.0,
                a: 0.5
            }
        );
        prepared.render_at(10, &mut target, &mut scratch).unwrap();
        assert_eq!(target, first);
        prepared.render_at(12, &mut target, &mut scratch).unwrap();
        assert!(
            target
                .pixels
                .iter()
                .all(|pixel| *pixel == LinearRgba::default())
        );
        let mut wrong = FloatFrame::transparent(2, 2).unwrap();
        let before = wrong.clone();
        assert!(prepared.render_at(10, &mut wrong, &mut scratch).is_err());
        assert_eq!(wrong, before);
    }

    #[test]
    fn gradient_clip_and_pose_opacity_use_native_premultiplied_linear_ink() {
        let mut authored = track();
        let layer = &mut authored.scene.layers[0];
        layer.path = rectangle(0.0, 0.0, 4.0, 4.0);
        layer.clips.push(rectangle(1.0, 0.0, 3.0, 4.0));
        layer.paint = Paint::Linear {
            start: Point { x: 0.0, y: 0.0 },
            end: Point { x: 4.0, y: 0.0 },
            stops: vec![
                GradientStop {
                    at: 0.0,
                    color: [0.0, 0.0, 1.0, 0.0],
                },
                GradientStop {
                    at: 1.0,
                    color: [0.5, 0.0, 0.0, 1.0],
                },
            ],
        };
        let prepared = PreparedNativeMotionPaintTrack::prepare(&authored, 4, 4).unwrap();
        let mut target = FloatFrame::transparent(4, 4).unwrap();
        prepared
            .render_at(10, &mut target, &mut RenderScratch::default())
            .unwrap();
        let pixel = target.pixels[5];
        let expected_alpha = 0.375 * 0.5;
        let expected_red = super::super::composite::srgb_to_linear(0.5).unwrap() * expected_alpha;
        assert!((pixel.r - expected_red).abs() < 1.0e-7);
        assert_eq!(pixel.a, expected_alpha);
        assert_eq!(pixel.b, 0.0);
        assert_eq!(target.pixels[4], LinearRgba::default());
        assert_eq!(target.pixels[7], LinearRgba::default());
    }

    #[test]
    fn graph_requires_enabled_connected_zero_input_paint_and_composite_stage() {
        let compiled = compile_graph(graph(track())).unwrap();
        assert_eq!(compiled.passes[0].stage, EngineStage::Composite);
        assert!(compiled.feature_families.contains(&"native_motion_paint"));
        assert!(compiled.feature_families.contains(&"motion_graphics"));
        let mut invalid = graph(track());
        invalid.working_format = PixelFormat::Rgba8;
        assert!(
            compile_graph(invalid)
                .unwrap_err()
                .contains("requires Rgba16Float")
        );
        let mut invalid = graph(track());
        let mut duplicate = invalid.nodes[0].clone();
        duplicate.id = "paint2".into();
        invalid.nodes.insert(1, duplicate);
        invalid.nodes[2].inputs.push("paint2".into());
        assert!(
            compile_graph(invalid)
                .unwrap_err()
                .contains("duplicate native paint graphic IDs")
        );
        let legacy = EngineNode {
            id: "legacy".into(),
            inputs: vec![],
            enabled: true,
            operation: NodeOperation::MotionGraphic {
                graphic_id: "graphic".into(),
                graphic_kind: "title".into(),
                text: "Caption".into(),
                timeline: track().timeline,
                x: 0.1,
                y: 0.1,
                width: 0.5,
                font_size: 24.0,
                font_family: "Bebas Neue".into(),
                font_weight: 700,
                letter_spacing: 0.0,
                outline_width: 0.0,
                shadow_depth: 0.0,
                corner_radius: 0.0,
                text_color: "#ffffff".into(),
                background_color: "#00000000".into(),
                accent_color: "#ffffff".into(),
                visual_style: "solid_panel".into(),
                animation: "fade".into(),
                tracking_mode: "anchor".into(),
                offset_x: 0.0,
                offset_y: 0.0,
                tracking: None,
            },
        };
        let mut legacy_only = graph(track());
        legacy_only.nodes[0] = legacy.clone();
        legacy_only.nodes[1].inputs = vec!["legacy".into()];
        assert!(compile_graph(legacy_only).is_ok());
        for legacy_first in [false, true] {
            let mut invalid = graph(track());
            invalid
                .nodes
                .insert(usize::from(!legacy_first), legacy.clone());
            invalid.nodes[2].inputs.push("legacy".into());
            assert!(
                compile_graph(invalid)
                    .unwrap_err()
                    .contains("cannot mix v1 and native paint")
            );
        }
        let mut invalid = graph(track());
        invalid.nodes[0].enabled = false;
        assert!(compile_graph(invalid).is_err());
        let mut invalid = graph(track());
        invalid.nodes[0].inputs.push("output".into());
        assert!(compile_graph(invalid).is_err());
        let mut invalid = graph(track());
        invalid.nodes[1].inputs.clear();
        assert!(
            compile_graph(invalid)
                .unwrap_err()
                .contains("does not contribute")
        );
        let mut invalid = graph(track());
        invalid.nodes[1].enabled = false;
        assert!(
            compile_graph(invalid)
                .unwrap_err()
                .contains("does not contribute")
        );
    }

    #[test]
    fn graph_shared_budgets_cannot_be_bypassed_by_splitting_paint_nodes() {
        for category in ["layers", "commands", "poses"] {
            let mut first = track();
            match category {
                "layers" => {
                    let layer = first.scene.layers[0].clone();
                    first.scene.layers = (0..33)
                        .map(|index| {
                            let mut l = layer.clone();
                            l.id = format!("layer{index}");
                            l
                        })
                        .collect();
                    first.frames = vec![vec![LayerPose::default(); 33]; 2];
                }
                "commands" => {
                    let commands = &mut first.scene.layers[0].path.commands;
                    commands.pop();
                    commands.extend((0..32_765).map(|_| PathCommand::L { x: 0.0, y: 0.0 }));
                    commands.push(PathCommand::Z);
                }
                _ => {
                    first.timeline.duration_frames = 9_001;
                    first.frames = vec![vec![LayerPose::default()]; 9_001];
                }
            }
            assert!(first.validate_structure(4, 4).is_ok());
            let mut invalid = graph(first.clone());
            invalid.nodes.insert(
                1,
                EngineNode {
                    id: "paint2".into(),
                    inputs: vec![],
                    enabled: true,
                    operation: NodeOperation::NativeMotionPaint {
                        graphic_id: "graphic2".into(),
                        track: first,
                    },
                },
            );
            invalid.nodes[2].inputs.push("paint2".into());
            assert!(
                compile_graph(invalid)
                    .unwrap_err()
                    .contains("shared native paint"),
                "{category}"
            );
        }
    }
}

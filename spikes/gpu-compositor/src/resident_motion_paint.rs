//! Resident consumer for exact, authored native paint poses. Preview and
//! verification call this same cache; neither route derives its own motion.
use anyhow::{Context, Result};
use hao_core::engine::composite::FloatFrame;
use hao_core::engine::motion_paint_track::{PreparedNativeMotionPaintTrack, RenderScratch};
use serde_json::{Value, json};
use std::time::Instant;
use crate::{GpuCompositor, engine_graph::EngineVideoNativeMotionPaintPlan, windows_video};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativePaintReuse { None, SameFrame, ExactPoseContent }

impl NativePaintReuse {
    fn reused(self) -> bool { self != Self::None }
    fn reason(self) -> &'static str {
        match self { Self::None => "none", Self::SameFrame => "same_frame",
            Self::ExactPoseContent => "exact_pose_content" }
    }
}

/// Cache ownership cannot be detached from the prepared track. The last successful
/// raster/upload (or exact reuse) is the only eligible texture content; no shared
/// source-signature lookup or approximate visible-pixel comparison exists.
struct ResidentPaintTrackState {
    prepared: PreparedNativeMotionPaintTrack,
    cached_frame: Option<u64>,
    raster_count: u64,
    texture_upload_count: u64,
}

impl ResidentPaintTrackState {
    fn after_initial_upload(prepared: PreparedNativeMotionPaintTrack, frame: u64) -> Self {
        let cached_frame = prepared.sample(frame).map(|_| frame);
        Self { prepared, cached_frame, raster_count: 1, texture_upload_count: 1 }
    }

    fn decide(&mut self, frame: u64) -> Option<NativePaintReuse> {
        if self.prepared.sample(frame).is_none() {
            // The resident texture stays allocated but is never composited outside
            // the active range. Re-entry must re-rasterize, even after an equal pose.
            self.cached_frame = None;
            return None;
        }
        Some(match self.cached_frame {
            Some(cached) if cached == frame => NativePaintReuse::SameFrame,
            Some(cached) if self.prepared.has_exact_pose_content(cached, frame) =>
                NativePaintReuse::ExactPoseContent,
            _ => NativePaintReuse::None,
        })
    }

    /// A failed render/upload cannot advance the frame or work counters. Exact
    /// reuse advances the integer frame so a repeat is still a same-frame hit.
    fn commit(&mut self, frame: u64, reuse: NativePaintReuse) {
        debug_assert!(self.prepared.sample(frame).is_some());
        if !reuse.reused() {
            self.raster_count += 1;
            self.texture_upload_count += 1;
        }
        self.cached_frame = Some(frame);
    }
}

pub(super) struct ResidentNativeMotionPaint {
    plan: EngineVideoNativeMotionPaintPlan,
    track: ResidentPaintTrackState,
    frame: FloatFrame,
    scratch: RenderScratch,
    pub texture: windows_video::ResidentOverlayTexture,
    last_raster_ms: f64,
    last_upload_ms: f64,
}

impl ResidentNativeMotionPaint {
    pub fn prepare(engine: &GpuCompositor, plan: EngineVideoNativeMotionPaintPlan,
        width: u32, height: u32, timeline_frame: u64) -> Result<Self> {
        // Full geometry and every pose are admitted before allocating pixels.
        let prepared = PreparedNativeMotionPaintTrack::prepare(&plan.track, width, height)
            .map_err(anyhow::Error::msg)?;
        let mut frame = FloatFrame::transparent(width, height).map_err(anyhow::Error::msg)?;
        let mut scratch = RenderScratch::default();
        let raster_started = Instant::now();
        prepared.render_at(timeline_frame, &mut frame, &mut scratch).map_err(anyhow::Error::msg)?;
        let last_raster_ms = raster_started.elapsed().as_secs_f64() * 1000.0;
        let upload_started = Instant::now();
        let texture = if prepared.is_display_referred() {
            windows_video::ResidentOverlayTexture::upload_display_linear_premultiplied(engine, &frame)?
        } else {
            windows_video::ResidentOverlayTexture::upload_scene_linear_premultiplied(
                engine, &frame, windows_video::SceneLinearOverlayBasis::LinearRec709)?
        };
        let last_upload_ms = upload_started.elapsed().as_secs_f64() * 1000.0;
        let track = ResidentPaintTrackState::after_initial_upload(prepared, timeline_frame);
        Ok(Self { plan, track, frame, scratch, texture, last_raster_ms, last_upload_ms })
    }

    pub fn active(&self, timeline_frame: u64) -> bool { self.track.prepared.sample(timeline_frame).is_some() }
    pub fn texture_upload_count(&self) -> u64 { self.track.texture_upload_count }

    pub fn is_display_referred(&self) -> bool { self.track.prepared.is_display_referred() }

    /// Admission binding is available even while the authored track is inactive.
    /// Source signature keeps its existing opaque equality domain.
    pub fn color_binding(&self) -> Value {
        let prepared = &self.track.prepared;
        json!({
            "nodeId": self.plan.node_id, "graphicId": self.plan.graphic_id,
            "sourceSignatureSha256": crate::output_hash(prepared.source_signature().as_bytes()),
            "colorIntent": prepared.color_intent(),
            "compositionBoundary": prepared.composition_boundary(),
            "overlayOrder": self.plan.overlay_order,
        })
    }

    /// A repeat or another frame with exact authored pose content reuses the
    /// resident texture. All changed poses and inactive re-entry do real work.
    pub fn update(&mut self, engine: &GpuCompositor, timeline_frame: u64) -> Result<Option<Value>> {
        let Some(reuse) = self.track.decide(timeline_frame) else { return Ok(None); };
        if !reuse.reused() {
            let raster_started = Instant::now();
            self.track.prepared.render_at(timeline_frame, &mut self.frame, &mut self.scratch)
                .map_err(anyhow::Error::msg)?;
            self.last_raster_ms = raster_started.elapsed().as_secs_f64() * 1000.0;
            let upload_started = Instant::now();
            if self.track.prepared.is_display_referred() {
                self.texture.update_display_linear_premultiplied(engine, &self.frame)?;
            } else {
                self.texture.update_scene_linear_premultiplied(engine, &self.frame,
                    windows_video::SceneLinearOverlayBasis::LinearRec709)?;
            }
            self.last_upload_ms = upload_started.elapsed().as_secs_f64() * 1000.0;
        }
        self.track.commit(timeline_frame, reuse);
        Ok(Some(self.receipt_with_reuse(timeline_frame, reuse)?))
    }

    /// Existing load call-site reports the initial raster/upload, never a hit.
    pub fn receipt(&self, timeline_frame: u64, cache_hit: bool) -> Result<Value> {
        anyhow::ensure!(!cache_hit, "initial native paint receipt cannot assert cache reuse");
        self.receipt_with_reuse(timeline_frame, NativePaintReuse::None)
    }

    fn receipt_with_reuse(&self, timeline_frame: u64, reuse: NativePaintReuse) -> Result<Value> {
        let prepared = &self.track.prepared;
        let poses = prepared.sample(timeline_frame).context("paint receipt outside active range")?;
        let work = u64::from(!reuse.reused());
        Ok(json!({
            "nodeId": self.plan.node_id, "graphicId": self.plan.graphic_id,
            "timeline": prepared.timeline(), "timelineFrame": timeline_frame,
            "localFrame": timeline_frame - prepared.timeline().timeline_start_frame,
            "executor": "editkin.resident-native-motion-paint/v1",
            "sourceSignatureSha256": crate::output_hash(prepared.source_signature().as_bytes()),
            "colorIntent": prepared.color_intent(),
            "compositionBoundary": prepared.composition_boundary(),
            "overlayOrder": self.plan.overlay_order,
            "layerCount": prepared.layer_count(), "poses": poses,
            "workingColorSpace": "linear_rec709", "workingFormat": "rgba16float",
            "alphaMode": "premultiplied", "cacheHit": reuse == NativePaintReuse::SameFrame,
            "poseContentCacheHit": reuse == NativePaintReuse::ExactPoseContent,
            "reuseReason": reuse.reason(),
            "rasterCount": self.track.raster_count, "textureUploadCount": self.track.texture_upload_count,
            "frameRasterCount": work, "frameTextureUploadCount": work,
            "frameCpuUploadBytes": work * u64::from(self.frame.width) * u64::from(self.frame.height) * 8,
            "rasterMilliseconds": if reuse.reused() { 0.0 } else { self.last_raster_ms },
            "uploadMilliseconds": if reuse.reused() { 0.0 } else { self.last_upload_ms }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hao_core::engine::model::NodeFrameRange;
    use hao_core::engine::motion_paint::{FillRule, LayerPose, Paint, PaintLayer, PaintScene, PathCommand, VectorPath};
    use hao_core::engine::motion_paint_track::{NativeMotionPaintColorIntent, NativeMotionPaintTrack,
        NATIVE_MOTION_PAINT_DISPLAY_TRACK_SCHEMA, NATIVE_MOTION_PAINT_TRACK_SCHEMA};

    fn authored_track() -> NativeMotionPaintTrack {
        let pose = LayerPose::default();
        NativeMotionPaintTrack {
            schema: NATIVE_MOTION_PAINT_TRACK_SCHEMA.into(),
            color_intent: None,
            scene: PaintScene { width: 4, height: 4, background: [0.0; 4], max_scale: 2.0,
                layers: vec![PaintLayer { id: "original-glyph".into(),
                    path: VectorPath { fill_rule: FillRule::NonZero, commands: vec![
                        PathCommand::M { x: 0.0, y: 0.0 }, PathCommand::L { x: 2.0, y: 0.0 },
                        PathCommand::L { x: 2.0, y: 2.0 }, PathCommand::L { x: 0.0, y: 2.0 }, PathCommand::Z,
                    ] }, paint: Paint::Solid { color: [1.0, 0.0, 0.0, 0.5] },
                    clips: vec![], stroke: None, shadow: None }], },
            timeline: NodeFrameRange { timeline_start_frame: 10, source_start_frame: 0, duration_frames: 6 },
            frames: vec![vec![pose], vec![pose], vec![LayerPose { x: 1.0, ..pose }],
                vec![pose], vec![LayerPose { opacity: 0.0, ..pose }], vec![pose]],
            source_signature: "immutable-authored-track-owner-a".into(),
        }
    }

    fn assert_pixels_exact(actual: &FloatFrame, reference: &FloatFrame) {
        assert_eq!((actual.width, actual.height, actual.pixels.len()),
            (reference.width, reference.height, reference.pixels.len()));
        for (index, (actual, reference)) in actual.pixels.iter().zip(&reference.pixels).enumerate() {
            assert_eq!([actual.r.to_bits(), actual.g.to_bits(), actual.b.to_bits(), actual.a.to_bits()],
                [reference.r.to_bits(), reference.g.to_bits(), reference.b.to_bits(), reference.a.to_bits()],
                "pixel {index}");
        }
    }

    #[test]
    fn display_intent_remains_owned_by_its_prepared_cache_without_changing_pose_reuse() {
        let scene = authored_track();
        let mut display = scene.clone();
        display.schema = NATIVE_MOTION_PAINT_DISPLAY_TRACK_SCHEMA.into();
        display.color_intent = Some(NativeMotionPaintColorIntent::DisplayRec709Sdr);
        let scene_prepared = PreparedNativeMotionPaintTrack::prepare(&scene, 4, 4).unwrap();
        let display_prepared = PreparedNativeMotionPaintTrack::prepare(&display, 4, 4).unwrap();
        let mut scene_pixels = FloatFrame::transparent(4, 4).unwrap();
        let mut display_pixels = FloatFrame::transparent(4, 4).unwrap();
        scene_prepared.render_at(10, &mut scene_pixels, &mut RenderScratch::default()).unwrap();
        display_prepared.render_at(10, &mut display_pixels, &mut RenderScratch::default()).unwrap();
        assert_pixels_exact(&display_pixels, &scene_pixels);
        let mut scene_state = ResidentPaintTrackState::after_initial_upload(scene_prepared, 10);
        let mut display_state = ResidentPaintTrackState::after_initial_upload(display_prepared, 10);
        display.schema = NATIVE_MOTION_PAINT_TRACK_SCHEMA.into();
        display.color_intent = None;
        assert!(!scene_state.prepared.is_display_referred());
        assert!(display_state.prepared.is_display_referred(), "prepared intent cannot follow mutable caller state");
        assert_eq!(display_state.prepared.composition_boundary(), "after_aces2_before_output_encoding");
        for state in [&mut scene_state, &mut display_state] {
            assert_eq!(state.decide(11), Some(NativePaintReuse::ExactPoseContent));
            state.commit(11, NativePaintReuse::ExactPoseContent);
            assert_eq!(state.decide(11), Some(NativePaintReuse::SameFrame));
            assert_eq!((state.raster_count, state.texture_upload_count), (1, 1));
            assert_eq!(state.decide(9), None);
            assert_eq!(state.decide(11), Some(NativePaintReuse::None), "inactive re-entry remains fresh work");
        }
    }

    #[test]
    fn pose_content_static_hold_seek_and_exit_match_uncached_native_pixels() {
        let authored = authored_track();
        let reference = PreparedNativeMotionPaintTrack::prepare(&authored, 4, 4).unwrap();
        let prepared = PreparedNativeMotionPaintTrack::prepare(&authored, 4, 4).unwrap();
        let mut output = FloatFrame::transparent(4, 4).unwrap();
        let mut scratch = RenderScratch::default();
        prepared.render_at(10, &mut output, &mut scratch).unwrap();
        let mut state = ResidentPaintTrackState::after_initial_upload(prepared, 10);
        let mut real_rasters = 1;
        for (frame, expected_reuse, expected_work_count) in [
            (11, NativePaintReuse::ExactPoseContent, 1),
            (11, NativePaintReuse::SameFrame, 1),
            (10, NativePaintReuse::ExactPoseContent, 1),
            (12, NativePaintReuse::None, 2),
            (11, NativePaintReuse::None, 3),
            (13, NativePaintReuse::ExactPoseContent, 3),
            (14, NativePaintReuse::None, 4),
            (15, NativePaintReuse::None, 5),
        ] {
            let reuse = state.decide(frame).unwrap();
            assert_eq!(reuse, expected_reuse, "frame {frame}");
            if !reuse.reused() {
                state.prepared.render_at(frame, &mut output, &mut scratch).unwrap();
                real_rasters += 1;
            }
            let mut uncached = FloatFrame::transparent(4, 4).unwrap();
            reference.render_at(frame, &mut uncached, &mut RenderScratch::default()).unwrap();
            assert_pixels_exact(&output, &uncached);
            state.commit(frame, reuse);
            assert_eq!(real_rasters, expected_work_count);
            assert_eq!(state.raster_count, expected_work_count);
            assert_eq!(state.texture_upload_count, expected_work_count,
                "state's successful upload accounting follows actual raster decisions; GPU upload itself is not mocked here");
        }
        assert_eq!(state.decide(16), None);
        assert_eq!(state.cached_frame, None);
        assert_eq!(state.decide(15), Some(NativePaintReuse::None), "inactive re-entry forces fresh work");
        state.prepared.render_at(15, &mut output, &mut scratch).unwrap();
        let mut uncached = FloatFrame::transparent(4, 4).unwrap();
        reference.render_at(15, &mut uncached, &mut RenderScratch::default()).unwrap();
        assert_pixels_exact(&output, &uncached);
        state.commit(15, NativePaintReuse::None);
        assert_eq!((state.raster_count, state.texture_upload_count), (6, 6));
        assert_eq!(state.decide(15), Some(NativePaintReuse::SameFrame));
    }

    #[test]
    fn pose_content_owner_initial_inactive_and_uncommitted_update_do_not_reuse() {
        let first = PreparedNativeMotionPaintTrack::prepare(&authored_track(), 4, 4).unwrap();
        let mut state = ResidentPaintTrackState::after_initial_upload(first, 10);
        assert_eq!(state.decide(12), Some(NativePaintReuse::None));
        // An unsuccessful upload has no commit. The old texture still owns frame10;
        // the pending different frame cannot turn into a hit or advance counters.
        assert_eq!(state.decide(12), Some(NativePaintReuse::None));
        assert_eq!(state.decide(10), Some(NativePaintReuse::SameFrame));
        assert_eq!((state.raster_count, state.texture_upload_count), (1, 1));
        let mut changed = authored_track();
        changed.source_signature = "immutable-authored-track-owner-b".into();
        changed.scene.layers[0].paint = Paint::Solid { color: [0.0, 0.0, 1.0, 0.5] };
        let second = PreparedNativeMotionPaintTrack::prepare(&changed, 4, 4).unwrap();
        let mut own_pixels = FloatFrame::transparent(4, 4).unwrap();
        second.render_at(10, &mut own_pixels, &mut RenderScratch::default()).unwrap();
        let mut first_pixels = FloatFrame::transparent(4, 4).unwrap();
        state.prepared.render_at(10, &mut first_pixels, &mut RenderScratch::default()).unwrap();
        assert_ne!(own_pixels, first_pixels);
        let second_owner = ResidentPaintTrackState::after_initial_upload(second, 10);
        assert_eq!((second_owner.raster_count, second_owner.texture_upload_count), (1, 1),
            "new owner always performed its own initial raster/upload");
        assert_eq!(second_owner.prepared.source_signature(), "immutable-authored-track-owner-b");
        let initially_inactive = PreparedNativeMotionPaintTrack::prepare(&authored_track(), 4, 4).unwrap();
        let mut inactive_pixels = FloatFrame::transparent(4, 4).unwrap();
        initially_inactive.render_at(9, &mut inactive_pixels, &mut RenderScratch::default()).unwrap();
        assert!(inactive_pixels.pixels.iter().all(|pixel| pixel.a.to_bits() == 0));
        let mut inactive = ResidentPaintTrackState::after_initial_upload(initially_inactive, 9);
        assert_eq!(inactive.cached_frame, None);
        assert_eq!(inactive.decide(10), Some(NativePaintReuse::None));
        inactive.commit(10, NativePaintReuse::None);
        assert_eq!((inactive.raster_count, inactive.texture_upload_count), (2, 2));
        assert_eq!(inactive.decide(9), None);
        assert_eq!(inactive.decide(11), Some(NativePaintReuse::None));
        assert_eq!((NativePaintReuse::SameFrame.reason(), NativePaintReuse::ExactPoseContent.reason(),
            NativePaintReuse::None.reason()), ("same_frame", "exact_pose_content", "none"));
    }
}

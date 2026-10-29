//! Handle reads change decoder clocks only. Authored geometry remains nominal.
use crate::engine_graph::{EngineVideoFramePlan, EngineVideoMotionBlurPlan, EngineVideoTimelinePlan};
use hao_core::engine::timeline_pair_v1::TimelineSourceReadV1;

pub(super) fn decode_frame(timeline: &EngineVideoTimelinePlan, read: Option<&TimelineSourceReadV1>, frame: u64) -> EngineVideoFramePlan {
    if let Some(read) = read {
        let source_frame = read.source_frame(frame);
        EngineVideoFramePlan { active: source_frame.is_some(), timeline_frame: frame, source_frame,
            source_time_seconds: read.source_seconds(frame as f64).expect("validated paired source clock") }
    } else { timeline.frame(frame) }
}

pub(super) fn authored_local_continuous(timeline: &EngineVideoTimelinePlan, read: Option<&TimelineSourceReadV1>, frame: f64) -> f64 {
    read.map_or_else(|| timeline.local_frame_continuous(frame).unwrap_or(0.0),
        |read| read.authored_local_continuous(frame).expect("finite resident authored frame"))
}

pub(super) fn floating_local_continuous(timeline: &EngineVideoTimelinePlan, read: Option<&TimelineSourceReadV1>, frame: f64) -> f64 {
    let local = authored_local_continuous(timeline, read, frame);
    read.map_or(local, |read| local.min((read.endpoint.nominal.duration_frames - 1) as f64))
}

pub(super) fn temporal_source_times(timeline: &EngineVideoTimelinePlan, read: Option<&TimelineSourceReadV1>, motion: &EngineVideoMotionBlurPlan, frame: u64) -> Vec<f64> {
    let Some(read) = read else { return motion.sample_source_times_seconds(timeline, frame); };
    let interval = f64::from(motion.shutter_angle) / 360.0;
    (0..motion.sample_count).map(|index| {
        let centered = (f64::from(index) + 0.5) / f64::from(motion.sample_count) - 0.5;
        let target = (frame as f64 + interval * centered)
            .clamp(read.read_start_frame as f64, (read.read_end_frame - 1) as f64);
        read.source_seconds(target).expect("finite handle shutter frame").expect("shutter remains in the validated read window")
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hao_core::engine::model::{NodeFrameRange, RationalTimebase};
    use hao_core::engine::timeline_pair_v1::TimelinePairEndpointV1;
    fn timeline_fixture() -> EngineVideoTimelinePlan {
        let graph = serde_json::from_value(serde_json::json!({
            "schema":"editkin.engine-graph/v1","graphId":"resident-clock-fixture","width":64,"height":64,
            "timebase":{"numerator":1,"denominator":30},"workingFormat":"rgba16_float","cacheBudgetMb":128,
            "nodes":[
                {"id":"source:b","kind":"source","assetId":"b","mediaKind":"video","inputColorSpace":"rec709","timeline":{"timelineStartFrame":12,"sourceStartFrame":24,"durationFrames":12}},
                {"id":"transform:b","kind":"transform2d","inputs":["source:b"],"x":0,"y":0,"scaleX":1,"scaleY":1,"rotationRadians":0,"opacity":1},
                {"id":"out","kind":"output","inputs":["transform:b"],"format":"rgba16_float"}
            ],"outputNode":"out"
        })).unwrap();
        let bindings = std::collections::BTreeMap::from([("b".into(), std::path::PathBuf::from("b.mp4"))]);
        crate::engine_graph::prepare_video(graph, &bindings, std::path::Path::new(".")).unwrap().layers[0].timeline.clone()
    }
    #[test]
    fn actual_resident_helpers_keep_source_handles_and_authored_clocks_independent() {
        let endpoint = TimelinePairEndpointV1 { branch_node_id: "transform:b".into(), source_node_id: "source:b".into(), asset_id: "b".into(), media_kind: "video".into(),
            nominal: NodeFrameRange { timeline_start_frame: 12, source_start_frame: 24, duration_frames: 12 }, source_start_seconds: 0.800001, asset_duration_seconds: 2.0 };
        let timeline = timeline_fixture();
        let read = TimelineSourceReadV1::new(&endpoint, 8, 28, &RationalTimebase { numerator: 1, denominator: 30 }).unwrap();
        assert!(!decode_frame(&timeline, None, 8).active);
        assert_eq!(decode_frame(&timeline, Some(&read), 8).source_frame, Some(20));
        assert!((decode_frame(&timeline, Some(&read), 8).source_time_seconds.unwrap() - (0.800001-4.0/30.0)).abs()<1e-12);
        assert_eq!(authored_local_continuous(&timeline, Some(&read), 8.5), 0.0);
        assert_eq!(authored_local_continuous(&timeline, Some(&read), 27.0), 12.0);
        assert_eq!(floating_local_continuous(&timeline, Some(&read), 27.0), 11.0);
        assert_eq!(authored_local_continuous(&timeline, None, 27.0), 0.0);
    }
    #[test]
    fn no_pair_shutter_retains_old_values_and_pair_shutter_uses_real_handles() {
        let endpoint = TimelinePairEndpointV1 { branch_node_id: "transform:b".into(), source_node_id: "source:b".into(), asset_id: "b".into(), media_kind: "video".into(),
            nominal: NodeFrameRange { timeline_start_frame: 12, source_start_frame: 24, duration_frames: 12 }, source_start_seconds: 0.8, asset_duration_seconds: 2.0 };
        let timeline = timeline_fixture();
        let read = TimelineSourceReadV1::new(&endpoint, 8, 28, &RationalTimebase { numerator: 1, denominator: 30 }).unwrap();
        let motion = EngineVideoMotionBlurPlan { contract: "editkin.motion-blur/v1", node_id: "motion:b".into(),
            shutter_angle: 180.0, sample_count: 2,
            source_sampling: hao_core::engine::model::MotionBlurSourceSampling::DecodedTemporal,
            sample_frames: Vec::new(), sample_transforms: Vec::new() };
        assert_eq!(temporal_source_times(&timeline, None, &motion, 12), motion.sample_source_times_seconds(&timeline, 12));
        let values = temporal_source_times(&timeline, Some(&read), &motion, 10);
        assert!((values[0]-(0.8-2.125/30.0)).abs()<1e-12);
        assert!((values[1]-(0.8-1.875/30.0)).abs()<1e-12);
        assert_eq!(temporal_source_times(&timeline, Some(&read), &motion, 8)[0], 0.8-4.0/30.0);
        assert_eq!(temporal_source_times(&timeline, Some(&read), &motion, 27)[1], 0.8+15.0/30.0);
    }
}

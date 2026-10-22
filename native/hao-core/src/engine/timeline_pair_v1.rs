//! Versioned pair declarations keep decoded handles separate from authored animation clocks.
use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};
use super::model::{EngineNode, NodeFrameRange, NodeOperation, RationalTimebase};

const MAX_SAFE_FRAME: u64 = 9_007_199_254_740_991;
const EPSILON: f64 = 1e-6;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelinePairKernelV1 { Dissolve, Dip }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelinePairEndpointV1 {
    pub branch_node_id: String,
    pub source_node_id: String,
    pub asset_id: String,
    pub media_kind: String,
    pub nominal: NodeFrameRange,
    pub source_start_seconds: f64,
    pub asset_duration_seconds: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelinePairSpecV1 {
    pub id: String,
    pub track_id: String,
    pub kernel: TimelinePairKernelV1,
    pub start_frame: u64,
    pub cut_frame: u64,
    pub end_frame: u64,
    pub from: TimelinePairEndpointV1,
    pub to: TimelinePairEndpointV1,
}

fn end(range: &NodeFrameRange) -> Result<u64, String> {
    let value = range.timeline_start_frame.checked_add(range.duration_frames)
        .ok_or("TIMELINE_TRANSITION_FRAME_OVERFLOW")?;
    if range.duration_frames == 0 || value > MAX_SAFE_FRAME || range.source_start_frame > MAX_SAFE_FRAME {
        return Err("TIMELINE_TRANSITION_FRAME_GRID_INVALID".into());
    }
    Ok(value)
}
fn step(timebase: &RationalTimebase) -> Result<f64, String> {
    if timebase.numerator == 0 || timebase.denominator == 0 || timebase.denominator > 1_000_000 {
        return Err("TIMELINE_TRANSITION_TIMEBASE_INVALID".into());
    }
    let value = timebase.numerator as f64 / timebase.denominator as f64;
    if 1.0 / value > 240.0 { return Err("TIMELINE_TRANSITION_TIMEBASE_INVALID".into()); }
    Ok(value)
}
impl TimelinePairEndpointV1 {
    fn validate(&self, timebase: &RationalTimebase, first: u64, last: u64) -> Result<(), String> {
        end(&self.nominal)?;
        let tick = step(timebase)?;
        if self.branch_node_id.trim().is_empty() || self.source_node_id.trim().is_empty()
            || self.asset_id.trim().is_empty() || !matches!(self.media_kind.as_str(), "video" | "image")
            || !self.source_start_seconds.is_finite() || self.source_start_seconds < 0.0
            || !self.asset_duration_seconds.is_finite() || self.asset_duration_seconds < 0.0
            || (self.source_start_seconds / tick).round() != self.nominal.source_start_frame as f64 {
            return Err("TIMELINE_TRANSITION_SOURCE_INVALID".into());
        }
        if self.media_kind == "video" {
            let first_source = self.source_start_seconds + (first as f64 - self.nominal.timeline_start_frame as f64) * tick;
            let last_source = self.source_start_seconds + (last as f64 - self.nominal.timeline_start_frame as f64) * tick;
            let first_hint = self.nominal.source_start_frame as i128 + first as i128 - self.nominal.timeline_start_frame as i128;
            let last_hint = self.nominal.source_start_frame as i128 + last as i128 - self.nominal.timeline_start_frame as i128;
            if self.asset_duration_seconds <= 0.0 || first_source < -EPSILON
                || last_source > self.asset_duration_seconds + EPSILON
                || first_hint < 0 || last_hint > MAX_SAFE_FRAME as i128 {
                return Err("TIMELINE_TRANSITION_SOURCE_HANDLE_MISSING".into());
            }
        }
        Ok(())
    }
}
impl TimelinePairSpecV1 {
    pub fn validate(&self, timebase: &RationalTimebase) -> Result<(), String> {
        if self.id.trim().is_empty() || self.track_id.trim().is_empty()
            || self.from.source_node_id == self.to.source_node_id
            || self.from.branch_node_id == self.to.branch_node_id
            || self.start_frame >= self.end_frame || self.end_frame - self.start_frame < 2 || self.end_frame > MAX_SAFE_FRAME
            || self.start_frame > self.cut_frame || self.cut_frame > self.end_frame
            || end(&self.from.nominal)? != self.cut_frame || self.to.nominal.timeline_start_frame != self.cut_frame
            || self.start_frame < self.from.nominal.timeline_start_frame || self.end_frame > end(&self.to.nominal)? {
            return Err("TIMELINE_TRANSITION_WINDOW_INVALID".into());
        }
        self.from.validate(timebase, self.start_frame, self.end_frame)?;
        self.to.validate(timebase, self.start_frame, self.end_frame)?;
        Ok(())
    }
    pub fn progress(&self, frame: f64) -> Result<Option<f64>, String> {
        if !frame.is_finite() { return Err("TIMELINE_TRANSITION_FRAME_GRID_INVALID".into()); }
        if frame < self.start_frame as f64 || frame >= self.end_frame as f64 { return Ok(None); }
        Ok(Some((frame - self.start_frame as f64) / (self.end_frame - self.start_frame) as f64))
    }
    pub fn validate_nodes(&self, nodes: &[EngineNode], inputs: &[String], timebase: &RationalTimebase) -> Result<(), String> {
        self.validate(timebase)?;
        let table = nodes.iter().map(|n| (n.id.as_str(), n)).collect::<BTreeMap<_, _>>();
        if !(1..=2).contains(&inputs.len()) { return Err("TIMELINE_TRANSITION_COMPOSITE_INPUTS_INVALID".into()); }
        // The incoming composite keeps its authored stack slot. An outgoing
        // handle may be emitted later in an unsorted track, and is a typed
        // implicit dependency rather than a request to reorder that track.
        if inputs[inputs.len() - 1] != self.to.branch_node_id { return Err("TIMELINE_TRANSITION_COMPOSITE_ORDER_INVALID".into()); }
        for side in [&self.from, &self.to] {
            let mut id = side.branch_node_id.as_str(); let mut visited = BTreeSet::new();
            loop {
                if !visited.insert(id) { return Err("TIMELINE_TRANSITION_BRANCH_CYCLE".into()); }
                let node = table.get(id).ok_or("TIMELINE_TRANSITION_SOURCE_INVALID")?;
                if !node.enabled { return Err("TIMELINE_TRANSITION_VISIBLE_SOURCE_REQUIRED".into()); }
                if id == side.source_node_id {
                    if let NodeOperation::Source { asset_id, media_kind, timeline: Some(range), .. } = &node.operation {
                        if asset_id == &side.asset_id && media_kind == &side.media_kind && range == &side.nominal { break; }
                    }
                    return Err("TIMELINE_TRANSITION_STALE_SOURCE_PLAN".into());
                }
                if node.inputs.len() != 1 { return Err("TIMELINE_TRANSITION_BRANCH_INVALID".into()); }
                id = &node.inputs[0];
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct TimelineSourceReadV1 {
    pub endpoint: TimelinePairEndpointV1,
    pub read_start_frame: u64,
    pub read_end_frame: u64,
    pub timebase: RationalTimebase,
}
impl TimelineSourceReadV1 {
    pub fn new(endpoint: &TimelinePairEndpointV1, first: u64, last: u64, timebase: &RationalTimebase) -> Result<Self, String> {
        if first >= last || last > MAX_SAFE_FRAME { return Err("TIMELINE_TRANSITION_FRAME_GRID_INVALID".into()); }
        let first = first.min(endpoint.nominal.timeline_start_frame);
        let last = last.max(end(&endpoint.nominal)?);
        endpoint.validate(timebase, first, last)?;
        Ok(Self { endpoint: endpoint.clone(), read_start_frame: first, read_end_frame: last, timebase: timebase.clone() })
    }
    pub fn extend(&mut self, endpoint: &TimelinePairEndpointV1, first: u64, last: u64) -> Result<(), String> {
        if self.endpoint.source_node_id != endpoint.source_node_id || self.endpoint.asset_id != endpoint.asset_id
            || self.endpoint.media_kind != endpoint.media_kind || self.endpoint.nominal != endpoint.nominal
            || self.endpoint.source_start_seconds != endpoint.source_start_seconds
            || self.endpoint.asset_duration_seconds != endpoint.asset_duration_seconds {
            return Err("TIMELINE_TRANSITION_STALE_SOURCE_PLAN".into());
        }
        let combined = Self::new(endpoint, first.min(self.read_start_frame), last.max(self.read_end_frame), &self.timebase)?;
        *self = combined; Ok(())
    }
    pub fn source_frame(&self, frame: u64) -> Option<u64> {
        if frame < self.read_start_frame || frame >= self.read_end_frame { return None; }
        if self.endpoint.media_kind == "image" { return Some(self.endpoint.nominal.source_start_frame); }
        u64::try_from(self.endpoint.nominal.source_start_frame as i128 + frame as i128 - self.endpoint.nominal.timeline_start_frame as i128).ok()
    }
    pub fn source_seconds(&self, frame: f64) -> Result<Option<f64>, String> {
        if !frame.is_finite() { return Err("TIMELINE_TRANSITION_FRAME_GRID_INVALID".into()); }
        if frame < self.read_start_frame as f64 || frame >= self.read_end_frame as f64 { return Ok(None); }
        let value = if self.endpoint.media_kind == "image" { self.endpoint.source_start_seconds }
            else { self.endpoint.source_start_seconds + (frame - self.endpoint.nominal.timeline_start_frame as f64) * step(&self.timebase)? };
        Ok(Some(value.max(0.0)))
    }
    pub fn authored_local_frame(&self, frame: u64) -> u64 {
        frame.saturating_sub(self.endpoint.nominal.timeline_start_frame).min(self.endpoint.nominal.duration_frames)
    }
    pub fn authored_local_continuous(&self, frame: f64) -> Result<f64, String> {
        if !frame.is_finite() { return Err("TIMELINE_TRANSITION_FRAME_GRID_INVALID".into()); }
        Ok((frame - self.endpoint.nominal.timeline_start_frame as f64).clamp(0.0, self.endpoint.nominal.duration_frames as f64))
    }
    pub fn floating_local_frame(&self, frame: u64) -> u64 {
        self.authored_local_frame(frame).min(self.endpoint.nominal.duration_frames - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair() -> TimelinePairSpecV1 {
        let side = |name: &str, start, source| TimelinePairEndpointV1 { branch_node_id: format!("colour:{name}"), source_node_id: format!("source:{name}"), asset_id: name.into(), media_kind: "video".into(), nominal: NodeFrameRange { timeline_start_frame: start, source_start_frame: source, duration_frames: 12 }, source_start_seconds: source as f64 / 30.0, asset_duration_seconds: 2.0 };
        TimelinePairSpecV1 { id: "cut".into(), track_id: "main".into(), kernel: TimelinePairKernelV1::Dissolve, start_frame: 8, cut_frame: 12, end_frame: 16, from: side("a", 0, 12), to: side("b", 12, 24) }
    }
    #[test] fn real_handle_clocks_do_not_shift_authored_geometry_or_floating_phase() {
        let p=pair();let t=RationalTimebase{numerator:1,denominator:30};p.validate(&t).unwrap();
        let a=TimelineSourceReadV1::new(&p.from,8,16,&t).unwrap();let b=TimelineSourceReadV1::new(&p.to,8,16,&t).unwrap();
        for (frame, source, local_a, local_b) in [(8,20,8,0),(12,24,12,0),(15,27,12,3)] {
            assert_eq!(a.source_frame(frame),Some(source));assert_eq!(b.source_frame(frame),Some(source));
            assert_eq!(a.authored_local_frame(frame),local_a);assert_eq!(b.authored_local_frame(frame),local_b);
        }
        assert_eq!(a.floating_local_frame(15),11);assert_eq!(a.source_frame(16),None);assert_eq!(b.source_frame(7),None);
        assert_eq!(p.progress(8.0).unwrap(),Some(0.0));assert_eq!(p.progress(12.0).unwrap(),Some(0.5));assert_eq!(p.progress(16.0).unwrap(),None);
    }
    #[test] fn exact_physical_source_offset_and_ntsc_shutter_positions_are_preserved() {
        let mut p=pair();let t=RationalTimebase{numerator:1001,denominator:30000};
        p.from.source_start_seconds=0.4004+0.000001;p.to.source_start_seconds=0.8008+0.000001;
        let b=TimelineSourceReadV1::new(&p.to,8,16,&t).unwrap();
        assert!((b.source_seconds(8.0).unwrap().unwrap()-0.6673343333333334).abs()<1e-12);
        assert!((b.source_seconds(12.5).unwrap().unwrap()-0.8174843333333334).abs()<1e-12);
        assert_eq!(b.authored_local_continuous(8.5).unwrap(),0.0);assert_eq!(b.authored_local_continuous(13.5).unwrap(),1.5);
    }
    #[test] fn missing_handles_and_unsafe_frame_ranges_are_refused_without_freeze_fallback() {
        let t=RationalTimebase{numerator:1,denominator:30};let mut p=pair();p.from.asset_duration_seconds=0.85;
        assert!(p.validate(&t).unwrap_err().contains("HANDLE_MISSING"));
        p=pair();p.to.source_start_seconds=0.0;p.to.nominal.source_start_frame=0;assert!(p.validate(&t).is_err());
        p=pair();p.from.nominal.timeline_start_frame=u64::MAX;assert!(p.validate(&t).is_err());
        p=pair();p.end_frame=p.start_frame;assert!(p.validate(&t).is_err());
        p=pair();p.start_frame=p.cut_frame;p.end_frame=p.cut_frame+1;assert!(p.validate(&t).is_err());
        p=pair();p.to.source_start_seconds=f64::NAN;assert!(p.validate(&t).is_err());
        assert!(pair().validate(&RationalTimebase{numerator:0,denominator:30}).is_err());
        assert!(pair().progress(f64::INFINITY).is_err());
    }
    #[test] fn a_middle_clip_merges_both_read_windows_and_refuses_changed_identity() {
        let p=pair();let t=RationalTimebase{numerator:1,denominator:30};let mut b=TimelineSourceReadV1::new(&p.to,8,16,&t).unwrap();
        b.extend(&p.to,20,28).unwrap();assert_eq!((b.read_start_frame,b.read_end_frame),(8,28));
        assert_eq!(b.source_frame(27),Some(39));assert_eq!(b.authored_local_frame(27),12);assert_eq!(b.floating_local_frame(27),11);
        let mut changed=p.to.clone();changed.asset_id="replacement".into();assert!(b.extend(&changed,20,28).is_err());
    }
    #[test] fn still_images_keep_a_constant_source_and_strict_versioned_fields() {
        let mut p=pair();p.to.media_kind="image".into();p.to.asset_duration_seconds=0.0;
        let b=TimelineSourceReadV1::new(&p.to,8,16,&RationalTimebase{numerator:1,denominator:30}).unwrap();
        assert_eq!(b.source_frame(8),Some(24));assert_eq!(b.source_frame(15),Some(24));assert_eq!(b.source_seconds(8.0).unwrap(),Some(0.8));
        let mut wire=serde_json::to_value(p).unwrap();wire["kernel"]=serde_json::json!("invented");assert!(serde_json::from_value::<TimelinePairSpecV1>(wire).is_err());
    }
    #[test] fn incoming_first_slot_waits_for_its_future_source_and_rejects_an_implicit_cycle() {
        let mut p=pair();p.from.branch_node_id="transform:a".into();p.to.branch_node_id="transform:b".into();
        let mut graph: super::super::model::EngineGraph=serde_json::from_value(serde_json::json!({
            "schema":"editkin.engine-graph/v1","graphId":"incoming-first-dependency","width":64,"height":64,
            "timebase":{"numerator":1,"denominator":30},"workingFormat":"rgba16_float","cacheBudgetMb":128,
            "nodes":[
                {"id":"source:b","kind":"source","assetId":"b","mediaKind":"video","inputColorSpace":"rec709","timeline":p.to.nominal},
                {"id":"transform:b","kind":"transform2d","inputs":["source:b"],"x":0,"y":0,"scaleX":1,"scaleY":1,"rotationRadians":0,"opacity":1},
                {"id":"first-slot","kind":"timeline_transition_v1","inputs":["transform:b"],"blendMode":"normal","opacity":1,"plans":[p]},
                {"id":"source:a","kind":"source","assetId":"a","mediaKind":"video","inputColorSpace":"rec709","timeline":p.from.nominal},
                {"id":"transform:a","kind":"transform2d","inputs":["source:a"],"x":0,"y":0,"scaleX":1,"scaleY":1,"rotationRadians":0,"opacity":1},
                {"id":"stack","kind":"composite","inputs":["first-slot","transform:a"],"blendMode":"normal","opacity":1},
                {"id":"out","kind":"output","inputs":["stack"],"format":"rgba16_float"}
            ],"outputNode":"out"
        })).unwrap();
        let compiled=crate::engine::compile_graph(graph.clone()).unwrap();
        let index=|id|compiled.passes.iter().position(|pass|pass.node_id==id).unwrap();
        assert!(index("transform:a")<index("first-slot"));assert!(index("transform:b")<index("first-slot"));
        assert!(compiled.feature_families.contains(&"timeline_pair_v1"));
        graph.nodes.iter_mut().find(|node|node.id=="source:a").unwrap().inputs.push("first-slot".into());
        assert!(crate::engine::compile_graph(graph).unwrap_err().contains("cycle"));
    }
}

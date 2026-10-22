//! Private lowering retains the existing styled-layer compiler and attaches
//! every typed pair declaration to real resident source indices.
use super::*;
use hao_core::engine::timeline_pair_v1::{TimelinePairSpecV1, TimelineSourceReadV1};

#[derive(Clone, Debug)]
pub struct PreparedTimelinePairV1 {
    pub spec: TimelinePairSpecV1,
    pub node_id: String,
    pub from_layer_index: usize,
    pub to_layer_index: usize,
    pub composite_layer_index: usize,
}

pub(super) fn prepare(graph: EngineGraph, bindings: &BTreeMap<String, PathBuf>,
    binding_dir: &Path, effects: &GpuEffectBindings) -> Result<PreparedEngineVideoGraph> {
    compile_graph(graph.clone()).map_err(anyhow::Error::msg)?;
    let mut declared = Vec::new();
    let mut projection = graph.clone();
    let mut first_slot_aliases = BTreeMap::new();
    for node in &mut projection.nodes {
        if let NodeOperation::TimelineTransitionV1 { blend_mode, opacity, matte_input, matte_mode, plans } = &node.operation {
            declared.extend(plans.iter().cloned().map(|plan| (node.id.clone(), plan)));
            if node.inputs.len() == 1 {
                first_slot_aliases.insert(node.id.clone(), node.inputs[0].clone());
            } else {
                node.operation = NodeOperation::Composite { blend_mode: *blend_mode, opacity: *opacity,
                    matte_input: matte_input.clone(), matte_mode: *matte_mode };
            }
        }
    }
    projection.nodes.retain(|node| !first_slot_aliases.contains_key(&node.id));
    for node in &mut projection.nodes {
        for input in &mut node.inputs {
            if let Some(original) = first_slot_aliases.get(input) { *input = original.clone(); }
        }
    }
    let mut prepared = super::prepare_video_with_effects(projection, bindings, binding_dir, effects)?;
    let indices = prepared.layers.iter().enumerate().map(|(index, layer)| (layer.source_node_id.clone(), index)).collect::<BTreeMap<_, _>>();
    for (node_id, spec) in declared {
        let from_index = *indices.get(&spec.from.source_node_id).context("TIMELINE_TRANSITION_NATIVE_FROM_SOURCE_MISSING")?;
        let to_index = *indices.get(&spec.to.source_node_id).context("TIMELINE_TRANSITION_NATIVE_TO_SOURCE_MISSING")?;
        for (index, endpoint) in [(from_index, &spec.from), (to_index, &spec.to)] {
            let layer = &mut prepared.layers[index];
            if layer.asset_id != endpoint.asset_id || layer.timeline.range != endpoint.nominal {
                bail!("TIMELINE_TRANSITION_STALE_SOURCE_PLAN");
            }
            if let Some(read) = &mut layer.transition_read {
                read.extend(endpoint, spec.start_frame, spec.end_frame).map_err(anyhow::Error::msg)?;
            } else {
                layer.transition_read = Some(TimelineSourceReadV1::new(endpoint, spec.start_frame, spec.end_frame, &graph.timebase).map_err(anyhow::Error::msg)?);
            }
            // Every requested handle must be sampled. The legacy small-overlay
            // cadence optimisation may not substitute a cached nominal frame.
            layer.decode_cadence_divisor = 1;
            layer.decode_cadence_phase = 0;
        }
        prepared.timeline_pairs.push(PreparedTimelinePairV1 { spec, node_id,
            from_layer_index: from_index, to_layer_index: to_index,
            composite_layer_index: to_index });
    }
    let extra = u64::from(prepared.width).checked_mul(u64::from(prepared.height))
        .and_then(|pixels| pixels.checked_mul(32)).context("TIMELINE_TRANSITION_TEXTURE_BUDGET_OVERFLOW")?;
    let required = prepared.resource_plan.required_bytes.checked_add(extra).context("TIMELINE_TRANSITION_TEXTURE_BUDGET_OVERFLOW")?;
    if required > prepared.resource_plan.budget_bytes { bail!("TIMELINE_TRANSITION_TEXTURE_BUDGET_EXCEEDED"); }
    prepared.resource_plan.required_bytes = required;
    prepared.resource_plan.remaining_bytes = prepared.resource_plan.budget_bytes - required;
    // Remains explicit until the resident scene pass consumes these declarations.
    prepared.coverage.direct_execution = false;
    prepared.coverage.blocked_node_ids = prepared.timeline_pairs.iter().map(|pair| pair.node_id.clone()).collect();
    Ok(prepared)
}

impl PreparedEngineVideoLayer {
    pub fn decode_frame(&self, frame: u64) -> EngineVideoFramePlan {
        if let Some(read) = &self.transition_read {
            let source_frame = read.source_frame(frame);
            EngineVideoFramePlan { active: source_frame.is_some(), timeline_frame: frame, source_frame,
                source_time_seconds: read.source_seconds(frame as f64).expect("validated paired source clock") }
        } else { self.timeline.frame(frame) }
    }
    pub fn authored_local_frame(&self, frame: u64) -> u64 {
        self.transition_read.as_ref().map_or_else(|| self.timeline.local_frame(frame).unwrap_or(0), |read| read.authored_local_frame(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_common_graph_lowering_preserves_original_ranges_and_reads_both_handles() {
        let endpoint = |id: &str, start: u64, source: u64| serde_json::json!({
            "branchNodeId":format!("transform:{id}"),"sourceNodeId":format!("source:{id}"),
            "assetId":id,"mediaKind":"video","nominal":{"timelineStartFrame":start,"sourceStartFrame":source,"durationFrames":12},
            "sourceStartSeconds":source as f64/30.0,"assetDurationSeconds":2.0
        });
        let graph: EngineGraph = serde_json::from_value(serde_json::json!({
            "schema":"editkin.engine-graph/v1","graphId":"real-pair-plan","width":64,"height":64,
            "timebase":{"numerator":1,"denominator":30},"workingFormat":"rgba16_float","cacheBudgetMb":128,
            "nodes":[
                {"id":"source:a","kind":"source","assetId":"a","mediaKind":"video","inputColorSpace":"rec709","timeline":{"timelineStartFrame":0,"sourceStartFrame":12,"durationFrames":12}},
                {"id":"transform:a","kind":"transform2d","inputs":["source:a"],"x":0,"y":0,"scaleX":1,"scaleY":1,"rotationRadians":0,"opacity":1},
                {"id":"source:b","kind":"source","assetId":"b","mediaKind":"video","inputColorSpace":"rec709","timeline":{"timelineStartFrame":12,"sourceStartFrame":24,"durationFrames":12}},
                {"id":"transform:b","kind":"transform2d","inputs":["source:b"],"x":0,"y":0,"scaleX":1,"scaleY":1,"rotationRadians":0,"opacity":1},
                {"id":"cut","kind":"timeline_transition_v1","inputs":["transform:a","transform:b"],"blendMode":"normal","opacity":1,
                 "plans":[{"id":"cut","trackId":"main","kernel":"dissolve","startFrame":8,"cutFrame":12,"endFrame":16,"from":endpoint("a",0,12),"to":endpoint("b",12,24)}]},
                {"id":"out","kind":"output","inputs":["cut"],"format":"rgba16_float"}
            ],"outputNode":"out"
        })).unwrap();
        let bindings=BTreeMap::from([("a".into(),PathBuf::from("a.mp4")),("b".into(),PathBuf::from("b.mp4"))]);
        let mut reversed=graph.clone();
        reversed.nodes.iter_mut().find(|node|node.id=="cut").unwrap().inputs=vec!["transform:b".into()];
        reversed.nodes.iter_mut().find(|node|node.id=="out").unwrap().inputs=vec!["reversed-stack".into()];
        reversed.nodes.push(serde_json::from_value(serde_json::json!({"id":"reversed-stack","kind":"composite","inputs":["cut","transform:a"],"blendMode":"normal","opacity":1})).unwrap());
        let prepared=super::super::prepare_video(graph,&bindings,Path::new(".")).unwrap();
        assert_eq!(prepared.timeline_pairs.len(),1);
        assert_eq!(prepared.layers[1].timeline.range.timeline_start_frame,12);
        assert!(!prepared.layers[1].timeline.frame(8).active);
        assert_eq!(prepared.layers[1].decode_frame(8).source_frame,Some(20));
        assert_eq!(prepared.layers[0].decode_frame(15).source_frame,Some(27));
        assert_eq!(prepared.layers[0].authored_local_frame(15),12);
        assert_eq!(prepared.layers[1].authored_local_frame(8),0);
        assert!(!prepared.coverage.direct_execution);
        assert_eq!(prepared.coverage.blocked_node_ids,vec!["cut"]);
        let reversed=super::super::prepare_video(reversed,&bindings,Path::new(".")).unwrap();
        assert_eq!(reversed.layers.iter().map(|layer|layer.source_node_id.as_str()).collect::<Vec<_>>(),vec!["source:b","source:a"]);
        assert_eq!((reversed.timeline_pairs[0].from_layer_index,reversed.timeline_pairs[0].to_layer_index,reversed.timeline_pairs[0].composite_layer_index),(1,0,0));
        assert_eq!(reversed.layers[0].decode_frame(8).source_frame,Some(20));
        assert_eq!(reversed.layers[0].timeline.range.timeline_start_frame,12);
    }
}

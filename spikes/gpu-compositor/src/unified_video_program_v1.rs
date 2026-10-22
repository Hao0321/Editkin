//! Explicit mixed-layer execution. The internal legacy projection prepares unchanged leaf resources;
//! only this original-DAG program may determine the visible picture and adjustment scope.
use super::*;

pub const SCHEMA: &str = "editkin.unified-native-composite/v1";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DrawKind {
    Video,
    Caption,
    MotionGraphic,
}
impl DrawKind {
    fn slot(self) -> usize {
        match self {
            Self::Video => 0,
            Self::Caption => 1,
            Self::MotionGraphic => 2,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draw {
    pub kind: DrawKind,
    pub index: usize,
    pub tail_id: String,
    pub source_node_id: String,
    pub blend_mode: EngineBlendMode,
    pub opacity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matte_tail_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matte_mode: Option<MatteMode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjustment {
    pub kind: &'static str,
    pub index: usize,
    pub node_id: String,
    pub tail_id: String,
    pub node_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum Step {
    Draw(Draw),
    Adjustment(Adjustment),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub schema: &'static str,
    pub graph_id: String,
    pub output_node: String,
    pub steps: Vec<Step>,
}

pub fn is_explicit(graph: &EngineGraph) -> bool {
    let Some((_, suffix)) = graph.graph_id.rsplit_once(":layer-order-v1:") else {
        return false;
    };
    suffix.is_empty()
        || suffix.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
        })
}

struct Topology {
    program: Program,
    leaf_graph: EngineGraph,
    consumed_stack: BTreeSet<String>,
}
struct Builder<'a> {
    nodes: BTreeMap<&'a str, &'a EngineNode>,
    consumed: BTreeSet<String>,
    tails: BTreeSet<String>,
    steps: Vec<Step>,
    counts: [usize; 4],
}

impl<'a> Builder<'a> {
    fn node(&self, id: &str) -> Result<&'a EngineNode> {
        self.nodes
            .get(id)
            .copied()
            .with_context(|| format!("UNIFIED_NATIVE_INPUT_MISSING:{id}"))
    }
    fn own(&mut self, node: &EngineNode) -> Result<()> {
        if !node.enabled || !self.consumed.insert(node.id.clone()) {
            bail!("UNIFIED_NATIVE_SHARED_OR_CYCLIC_STACK");
        }
        Ok(())
    }
    fn adjustment(&self, id: &str) -> Result<Option<(&'a EngineNode, Vec<String>)>> {
        let mut current = self.node(id)?;
        let mut seen = BTreeSet::new();
        let mut ids = Vec::new();
        while matches!(current.operation.kind_name(), "color" | "effect") {
            if !seen.insert(current.id.clone()) || current.inputs.len() != 1 {
                bail!("UNIFIED_NATIVE_ADJUSTMENT_CHAIN_INVALID");
            }
            ids.push(current.id.clone());
            current = self.node(&current.inputs[0])?;
        }
        if current.operation.kind_name() == "adjustment" {
            ids.push(current.id.clone());
            Ok(Some((current, ids)))
        } else {
            Ok(None)
        }
    }
    fn video_source(&self, id: &str) -> Result<&'a EngineNode> {
        let mut current = self.node(id)?;
        let mut seen = BTreeSet::new();
        while current.operation.kind_name() != "source" {
            if !seen.insert(current.id.clone())
                || !current.enabled
                || current.inputs.len() != 1
                || !matches!(
                    current.operation.kind_name(),
                    "transform2d" | "color" | "effect" | "motion_blur" | "precomposition"
                )
            {
                bail!("UNIFIED_NATIVE_VIDEO_BRANCH_INVALID");
            }
            current = self.node(&current.inputs[0])?;
        }
        if !current.enabled
            || !current.inputs.is_empty()
            || !matches!(&current.operation, NodeOperation::Source { media_kind, .. } if media_kind == "video")
        {
            bail!("UNIFIED_NATIVE_VIDEO_BRANCH_INVALID");
        }
        Ok(current)
    }
    fn visit(&mut self, id: &str, upper: bool, depth: usize) -> Result<()> {
        if depth > 64 {
            bail!("UNIFIED_NATIVE_STACK_CAPACITY");
        }
        let node = self.node(id)?;
        if let NodeOperation::Composite {
            blend_mode,
            opacity,
            matte_input,
            matte_mode,
        } = &node.operation
        {
            self.own(node)?;
            if upper
                || node.inputs.len() != 2
                || self.node(&node.inputs[1])?.operation.kind_name() == "composite"
            {
                bail!("UNIFIED_NATIVE_RIGHT_NESTED_GROUP_REQUIRED");
            }
            if !opacity.is_finite() || !(0.0..=1.0).contains(opacity) {
                bail!("UNIFIED_NATIVE_COMPOSITE_STYLE_INVALID");
            }
            match (matte_input, matte_mode) {
                (Some(tail), Some(_))
                    if !tail.is_empty() && self.nodes.contains_key(tail.as_str()) => {}
                (None, None) => {}
                _ => bail!("UNIFIED_NATIVE_MATTE_INVALID"),
            }
            self.visit(&node.inputs[0], false, depth + 1)?;
            let previous = self.steps.len();
            self.visit(&node.inputs[1], true, depth + 1)?;
            if self.steps.len() != previous + 1 {
                bail!("UNIFIED_NATIVE_UPPER_BRANCH_INVALID");
            }
            let Some(Step::Draw(draw)) = self.steps.last_mut() else {
                bail!("UNIFIED_NATIVE_UPPER_BRANCH_INVALID");
            };
            draw.blend_mode = *blend_mode;
            draw.opacity = *opacity;
            draw.matte_tail_id = matte_input.clone();
            draw.matte_mode = *matte_mode;
            return Ok(());
        }
        if let Some((adjustment, ids)) = self.adjustment(id)? {
            let NodeOperation::Adjustment {
                affected_inputs, ..
            } = &adjustment.operation
            else {
                unreachable!()
            };
            if upper || adjustment.inputs.len() != 1 || affected_inputs != &adjustment.inputs {
                bail!("UNIFIED_NATIVE_ADJUSTMENT_SCOPE_INVALID");
            }
            for owned in &ids {
                self.own(self.node(owned)?)?;
            }
            self.visit(&adjustment.inputs[0], false, depth + 1)?;
            let index = self.counts[3];
            self.counts[3] += 1;
            if self.counts[3] > 4 {
                bail!("UNIFIED_NATIVE_ADJUSTMENT_CAPACITY");
            }
            self.steps.push(Step::Adjustment(Adjustment {
                kind: "adjustment",
                index,
                node_id: adjustment.id.clone(),
                tail_id: id.to_owned(),
                node_ids: ids,
            }));
            return Ok(());
        }
        if matches!(&node.operation, NodeOperation::Source { asset_id, .. } if asset_id == "editkin.generator.transparent")
        {
            if upper
                || !self.steps.is_empty()
                || !node.inputs.is_empty()
                || !node.enabled
                || !matches!(&node.operation, NodeOperation::Source { media_kind, input_color_space, alpha_mode, .. }
                    if media_kind == "generator" && input_color_space.as_deref() == Some("rec709") && matches!(alpha_mode, AlphaMode::Straight))
            {
                bail!("UNIFIED_NATIVE_TRANSPARENT_SEED_INVALID");
            }
            return self.own(node);
        }
        if !node.enabled || !self.tails.insert(id.to_owned()) {
            bail!("UNIFIED_NATIVE_DRAW_IDENTITY_INVALID");
        }
        let kind = match node.operation.kind_name() {
            "caption" => DrawKind::Caption,
            "motion_graphic" => DrawKind::MotionGraphic,
            _ => DrawKind::Video,
        };
        let source = if kind == DrawKind::Video {
            self.video_source(id)?
        } else {
            if !node.inputs.is_empty() {
                bail!("UNIFIED_NATIVE_OVERLAY_INPUT_INVALID");
            }
            node
        };
        let index = self.counts[kind.slot()];
        self.counts[kind.slot()] += 1;
        if self.counts[0] + self.counts[1] + self.counts[2] > 14
            || self.counts[1] > 8
            || self.counts[2] > 4
        {
            bail!("UNIFIED_NATIVE_DRAW_CAPACITY");
        }
        self.steps.push(Step::Draw(Draw {
            kind,
            index,
            tail_id: id.to_owned(),
            source_node_id: source.id.clone(),
            blend_mode: EngineBlendMode::Normal,
            opacity: 1.0,
            matte_tail_id: None,
            matte_mode: None,
        }));
        Ok(())
    }
}

fn topology(graph: &EngineGraph) -> Result<Topology> {
    if graph.audio.is_some() {
        bail!("UNIFIED_NATIVE_AUDIO_SEPARATE_REQUIRED");
    }
    if graph.nodes.is_empty() || graph.nodes.len() > 16_384 {
        bail!("UNIFIED_NATIVE_NODE_CAPACITY");
    }
    let nodes = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    if nodes.len() != graph.nodes.len()
        || graph.nodes.iter().any(|node| {
            node.inputs
                .iter()
                .any(|id| !nodes.contains_key(id.as_str()))
        })
    {
        bail!("UNIFIED_NATIVE_NODE_IDENTITIES_INVALID");
    }
    let output = nodes
        .get(graph.output_node.as_str())
        .copied()
        .context("UNIFIED_NATIVE_OUTPUT_INVALID")?;
    if output.operation.kind_name() != "output" || !output.enabled || output.inputs.len() != 1 {
        bail!("UNIFIED_NATIVE_OUTPUT_INVALID");
    }
    if graph.nodes.iter().any(|node| {
        matches!(
            node.operation.kind_name(),
            "camera"
                | "light"
                | "transform3d"
                | "depth_of_field"
                | "particle_emitter"
                | "timeline_transition_v1"
                | "native_motion_paint"
                | "floating_video_frame_2d"
        ) || matches!(
            &node.operation,
            NodeOperation::MotionBlur {
                source_sampling: MotionBlurSourceSampling::DecodedTemporal,
                ..
            }
        )
    }) {
        bail!("UNIFIED_NATIVE_GROUP_REQUIRED");
    }
    let mut builder = Builder {
        nodes,
        consumed: BTreeSet::new(),
        tails: BTreeSet::new(),
        steps: Vec::new(),
        counts: [0; 4],
    };
    builder.visit(&output.inputs[0], false, 0)?;
    if builder.counts[0] == 0 {
        let mut owned = builder.consumed.clone();
        owned.extend(builder.tails.iter().cloned());
        if graph.nodes.iter().any(|node| node.id != output.id && !owned.contains(&node.id)) {
            bail!("UNIFIED_NATIVE_COVERAGE_INCOMPLETE");
        }
    }
    let videos = builder
        .steps
        .iter()
        .filter_map(|step| match step {
            Step::Draw(draw) if draw.kind == DrawKind::Video => Some(draw),
            _ => None,
        })
        .map(|draw| (draw.tail_id.as_str(), draw))
        .collect::<BTreeMap<_, _>>();
    for step in &builder.steps {
        let Step::Draw(draw) = step else {
            continue;
        };
        if draw.kind != DrawKind::Video
            && (!matches!(draw.blend_mode, EngineBlendMode::Normal)
                || draw.opacity != 1.0
                || draw.matte_tail_id.is_some())
        {
            bail!("UNIFIED_NATIVE_OVERLAY_STYLE_INVALID");
        }
        if let Some(matte) = &draw.matte_tail_id {
            if !videos.contains_key(matte.as_str()) || matte == &draw.tail_id {
                bail!("UNIFIED_NATIVE_MATTE_INVALID");
            }
        }
    }
    for video in videos.values() {
        let mut current = *video;
        let mut seen = BTreeSet::new();
        while let Some(matte) = &current.matte_tail_id {
            if !seen.insert(current.tail_id.as_str()) {
                bail!("UNIFIED_NATIVE_MATTE_CYCLE");
            }
            current = videos[matte.as_str()];
        }
    }
    let mut projection = graph.clone();
    projection.graph_id = "editkin.internal-unified-leaf-preparation/v1".to_owned();
    let adjustment_ids = builder
        .steps
        .iter()
        .flat_map(|step| match step {
            Step::Adjustment(adjustment) => adjustment.node_ids.clone(),
            _ => Vec::new(),
        })
        .collect::<BTreeSet<_>>();
    projection.nodes.retain(|node| {
        node.id != output.id
            && (!builder.consumed.contains(&node.id) || adjustment_ids.contains(&node.id))
    });
    let mut used = graph
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let mut generated = 0;
    let mut tail: Option<String> = None;
    for kind in [DrawKind::Video, DrawKind::Caption, DrawKind::MotionGraphic] {
        for draw in builder.steps.iter().filter_map(|step| match step {
            Step::Draw(draw) if draw.kind == kind => Some(draw),
            _ => None,
        }) {
            let Some(base) = tail.clone() else {
                tail = Some(draw.tail_id.clone());
                continue;
            };
            let id = loop {
                let id = format!("unified-leaf-preparation:composite:{generated}");
                generated += 1;
                if used.insert(id.clone()) {
                    break id;
                }
            };
            projection.nodes.push(EngineNode {
                id: id.clone(),
                inputs: vec![base, draw.tail_id.clone()],
                enabled: true,
                operation: NodeOperation::Composite {
                    blend_mode: draw.blend_mode,
                    opacity: draw.opacity,
                    matte_input: draw.matte_tail_id.clone(),
                    matte_mode: draw.matte_mode,
                },
            });
            tail = Some(id);
        }
    }
    if tail.is_none() {
        let seed = graph.nodes.iter().find(|node| builder.consumed.contains(&node.id)
            && matches!(&node.operation, NodeOperation::Source { asset_id, .. } if asset_id == "editkin.generator.transparent"))
            .context("UNIFIED_NATIVE_TRANSPARENT_SEED_REQUIRED")?;
        tail = Some(seed.id.clone());
        projection.nodes.push(seed.clone());
    }
    for step in &builder.steps {
        let Step::Adjustment(adjustment) = step else {
            continue;
        };
        let node = projection
            .nodes
            .iter_mut()
            .find(|node| node.id == adjustment.node_id)
            .context("UNIFIED_NATIVE_ADJUSTMENT_MISSING")?;
        node.inputs = vec![tail.clone().context("UNIFIED_NATIVE_TRANSPARENT_SEED_REQUIRED")?];
        if let NodeOperation::Adjustment {
            affected_inputs, ..
        } = &mut node.operation
        {
            *affected_inputs = node.inputs.clone();
        }
        tail = Some(adjustment.tail_id.clone());
    }
    let mut projected_output = output.clone();
    projected_output.inputs = vec![tail.context("UNIFIED_NATIVE_TRANSPARENT_SEED_REQUIRED")?];
    projection.nodes.push(projected_output);
    Ok(Topology {
        program: Program {
            schema: SCHEMA,
            graph_id: graph.graph_id.clone(),
            output_node: graph.output_node.clone(),
            steps: builder.steps,
        },
        leaf_graph: projection,
        consumed_stack: builder.consumed,
    })
}

pub fn prepare(
    graph: EngineGraph,
    bindings: &BTreeMap<String, PathBuf>,
    binding_dir: &Path,
    effects: &GpuEffectBindings,
) -> Result<PreparedEngineVideoGraph> {
    let compiled = compile_graph(graph.clone()).map_err(anyhow::Error::msg)?;
    let Topology {
        program,
        leaf_graph,
        consumed_stack,
    } = topology(&graph)?;
    let media_free = !program.steps.iter().any(|step| matches!(step, Step::Draw(draw) if draw.kind == DrawKind::Video));
    let mut prepared = super::prepare_unified_video_leaves(leaf_graph, bindings, binding_dir, effects, media_free)?;
    if prepared.display_transform.is_aces2()
        || prepared.scene_25d.is_some()
        || prepared.depth_of_field.is_some()
        || !prepared.particles.is_empty()
        || !prepared.native_motion_paints.is_empty()
        || !prepared.timeline_pairs.is_empty()
    {
        bail!("UNIFIED_NATIVE_GROUP_REQUIRED");
    }
    let videos = program
        .steps
        .iter()
        .filter_map(|step| match step {
            Step::Draw(draw) if draw.kind == DrawKind::Video => Some(draw),
            _ => None,
        })
        .collect::<Vec<_>>();
    if videos.len() != prepared.layers.len() {
        bail!("UNIFIED_NATIVE_LEAF_IDENTITY_MISMATCH");
    }
    let by_tail = videos
        .iter()
        .map(|draw| (draw.tail_id.as_str(), draw.index))
        .collect::<BTreeMap<_, _>>();
    for draw in &videos {
        let layer = prepared
            .layers
            .get_mut(draw.index)
            .context("UNIFIED_NATIVE_LEAF_IDENTITY_MISMATCH")?;
        if layer.source_node_id != draw.source_node_id {
            bail!("UNIFIED_NATIVE_LEAF_IDENTITY_MISMATCH");
        }
        layer.blend_mode = gpu_blend(draw.blend_mode);
        layer.composite_opacity = draw.opacity;
        layer.matte_layer_index = draw.matte_tail_id.as_ref().map(|id| by_tail[id.as_str()]);
        layer.matte_mode = draw.matte_mode;
    }
    for layer in &prepared.layers {
        if let Some(index) = layer.matte_layer_index {
            if !frame_range_contains(
                &prepared.layers[index].timeline.range,
                &layer.timeline.range,
            ) {
                bail!("UNIFIED_NATIVE_MATTE_TIMELINE_INVALID");
            }
        }
    }
    let mut resource = if media_free {
        resident_media_free_resource_plan(graph.width, graph.height, graph.cache_budget_mb,
            prepared.captions.len() + prepared.motion_graphics.len(), prepared.adjustments.len())?
    } else {
        resident_video_resource_plan(
        graph.width,
        graph.height,
        graph.cache_budget_mb,
        prepared.layers.len(),
        prepared.captions.len() + prepared.motion_graphics.len(),
        0,
        prepared.adjustments.len(),
        prepared
            .layers
            .iter()
            .filter(|layer| layer.matte_layer_index.is_some())
            .count(),
        0,
        BGRA_BYTES_PER_PIXEL,
        0,
        0,
    )?
    };
    // Reuse an existing adjustment ping-pong texture as a cleared, immutable transparent seed for each frame.
    // Account its working storage and clear pass explicitly; no per-layer full-frame history is retained.
    let seed_bytes = resource
        .pixel_count
        .checked_mul(BGRA_BYTES_PER_PIXEL)
        .context("UNIFIED_NATIVE_SEED_RESOURCE_OVERFLOW")?;
    resource.compositor_working_bytes = resource
        .compositor_working_bytes
        .checked_add(seed_bytes)
        .context("UNIFIED_NATIVE_SEED_RESOURCE_OVERFLOW")?;
    resource.required_bytes = resource
        .required_bytes
        .checked_add(seed_bytes)
        .context("UNIFIED_NATIVE_SEED_RESOURCE_OVERFLOW")?;
    if resource.required_bytes > resource.budget_bytes {
        bail!("UNIFIED_NATIVE_SEED_RESOURCE_BUDGET");
    }
    let video_bytes = resource
        .bytes_per_video_layer
        .checked_mul(prepared.layers.len() as u64)
        .context("UNIFIED_NATIVE_SEED_RESOURCE_OVERFLOW")?;
    let fixed_bytes = resource
        .required_bytes
        .checked_sub(video_bytes)
        .context("UNIFIED_NATIVE_SEED_RESOURCE_OVERFLOW")?;
    resource.max_video_layers = resource
        .budget_bytes
        .saturating_sub(fixed_bytes)
        .checked_div(resource.bytes_per_video_layer)
        .unwrap_or(0);
    resource.remaining_bytes = resource.budget_bytes - resource.required_bytes;
    resource.maximum_full_frame_passes_per_present = resource
        .maximum_full_frame_passes_per_present
        .checked_add(1)
        .context("UNIFIED_NATIVE_SEED_RESOURCE_OVERFLOW")?;
    resource.unified_seed_bytes = Some(seed_bytes);
    let original_ids = graph
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    let mut covered = prepared
        .coverage
        .executed_node_ids
        .iter()
        .filter(|id| original_ids.contains(*id))
        .cloned()
        .collect::<BTreeSet<_>>();
    covered.extend(consumed_stack);
    covered.insert(graph.output_node.clone());
    if covered != original_ids {
        bail!("UNIFIED_NATIVE_COVERAGE_INCOMPLETE");
    }
    prepared.coverage.graph_id = graph.graph_id;
    prepared.coverage.executed_node_ids = compiled
        .passes
        .into_iter()
        .map(|pass| pass.node_id)
        .collect();
    prepared.resource_plan = resource;
    prepared.adjustment_before_typography = false;
    prepared.unified_program = Some(program);
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> EngineGraph {
        serde_json::from_str(include_str!("../test-fixtures/unified-mixed-graph-v1.json")).unwrap()
    }

    fn media_free_graph() -> EngineGraph {
        serde_json::from_str(include_str!("../test-fixtures/unified-media-free-graph-v1.json")).unwrap()
    }

    fn clear_graph() -> EngineGraph {
        let mut graph = media_free_graph();
        let seed = graph.nodes.iter().find(|node| matches!(&node.operation,
            NodeOperation::Source { asset_id, .. } if asset_id == "editkin.generator.transparent")).unwrap().id.clone();
        graph.nodes.retain(|node| node.id == seed || node.id == graph.output_node);
        graph.nodes.iter_mut().find(|node| node.id == graph.output_node).unwrap().inputs = vec![seed];
        graph.graph_id = "source-media-free-clear:layer-order-v1:".to_owned();
        graph
    }

    #[test]
    fn zero_source_canonical_graph_matches_the_actual_typescript_program() {
        let graph = media_free_graph();
        let prepared = topology(&graph).unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(include_str!("../test-fixtures/unified-media-free-program-v1.json")).unwrap();
        for step in expected["steps"].as_array_mut().unwrap() {
            if let Some(value) = step.get_mut("opacity") { *value = serde_json::json!(value.as_f64().unwrap()); }
        }
        assert_eq!(serde_json::to_value(&prepared.program).unwrap(), expected);
        assert!(prepared.program.steps.iter().all(|step| !matches!(step, Step::Draw(draw) if draw.kind == DrawKind::Video)));
    }

    #[test]
    fn actual_zero_source_preparation_owns_overlays_budget_and_complete_coverage_without_a_decoder() {
        let graph = media_free_graph();
        let prepared = super::super::prepare_video(graph.clone(), &BTreeMap::new(), Path::new(".")).unwrap();
        assert!(prepared.layers.is_empty()); assert_eq!(prepared.captions.len(), 1); assert_eq!(prepared.motion_graphics.len(), 1);
        assert_eq!(prepared.resource_plan.video_layer_count, 0); assert_eq!(prepared.resource_plan.overlay_count, 2);
        assert_eq!(prepared.resource_plan.required_bytes, prepared.resource_plan.pixel_count * 24);
        assert_eq!(prepared.resource_plan.unified_seed_bytes, Some(prepared.resource_plan.pixel_count * 4));
        assert_eq!(prepared.decode_schedule.full_rate_layer_count, 0); assert_eq!(prepared.decode_schedule.adaptive_layer_count, 0);
        assert_eq!(prepared.coverage.executed_node_ids.iter().cloned().collect::<BTreeSet<_>>(), graph.nodes.iter().map(|node| node.id.clone()).collect());
    }

    #[test]
    fn clear_only_keeps_a_real_transparent_generator_and_legacy_video_still_declines_it() {
        let graph = clear_graph();
        let topology = topology(&graph).unwrap();
        assert!(topology.program.steps.is_empty());
        let prepared = super::super::prepare_video(graph, &BTreeMap::new(), Path::new(".")).unwrap();
        assert!(prepared.layers.is_empty()); assert!(prepared.captions.is_empty()); assert!(prepared.motion_graphics.is_empty());
        assert_eq!(prepared.resource_plan.required_bytes, prepared.resource_plan.pixel_count * 16);
        assert!(super::super::prepare_legacy_video_with_effects(topology.leaf_graph, &BTreeMap::new(), Path::new("."), &GpuEffectBindings::default()).is_err());
    }

    #[test]
    fn zero_source_profile_rejects_phantom_bindings_bad_seed_and_legacy_zero_layer_budget() {
        let graph = media_free_graph();
        let bindings = BTreeMap::from([("phantom".to_owned(), PathBuf::from("SHOULD_NOT_BE_OPENED.mp4"))]);
        assert!(super::super::prepare_video(graph, &bindings, Path::new(".")).is_err());
        let mut graph = clear_graph();
        if let NodeOperation::Source { input_color_space, .. } = &mut graph.nodes.iter_mut().find(|node| matches!(node.operation, NodeOperation::Source { .. })).unwrap().operation {
            *input_color_space = Some("unowned-space".to_owned());
        }
        assert!(topology(&graph).is_err());
        assert!(resident_video_resource_plan(64, 64, 64, 0, 2, 0, 0, 0, 0, 4, 0, 0).is_err());
        assert!(resident_media_free_resource_plan(0, 64, 64, 2, 0).is_err());
    }

    #[test]
    fn original_shared_dag_produces_the_complete_typescript_program() {
        let graph = graph();
        let before = serde_json::to_value(&graph).unwrap();
        let prepared = topology(&graph).unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(include_str!(
            "../test-fixtures/unified-mixed-program-v1.json"
        ))
        .unwrap();
        // TS serializes integral f32 opacity as 1; serde_json retains its floating representation.
        for step in expected["steps"].as_array_mut().unwrap() {
            if let Some(value) = step.get_mut("opacity") {
                *value = serde_json::json!(value.as_f64().unwrap());
            }
        }
        assert_eq!(serde_json::to_value(&prepared.program).unwrap(), expected);
        assert_eq!(serde_json::to_value(&graph).unwrap(), before);
        assert!(!is_explicit(&prepared.leaf_graph));
        assert_eq!(prepared.program.steps.len(), 6);
    }

    #[test]
    fn actual_leaf_preparation_keeps_original_coverage_and_accounts_for_the_seed() {
        let graph = graph();
        let original_ids = graph
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<BTreeSet<_>>();
        let prepared = prepare(
            graph,
            &BTreeMap::from([("asset-demo".into(), PathBuf::from("not-decoded.mp4"))]),
            Path::new("."),
            &GpuEffectBindings::default(),
        )
        .unwrap();
        assert_eq!(prepared.layers.len(), 2);
        assert_eq!(prepared.captions.len(), 1);
        assert_eq!(prepared.motion_graphics.len(), 1);
        assert_eq!(prepared.adjustments.len(), 2);
        assert_eq!(
            prepared
                .coverage
                .executed_node_ids
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>(),
            original_ids
        );
        assert_eq!(prepared.resource_plan.unified_seed_bytes, Some(64 * 64 * 4));
        assert_eq!(
            prepared.resource_plan.maximum_full_frame_passes_per_present,
            8
        );
        assert!(!prepared.adjustment_before_typography);
        assert_eq!(prepared.unified_program.unwrap().steps.len(), 6);
    }

    #[test]
    fn missing_input_duplicate_node_and_recursive_adjustment_are_rejected() {
        let mut missing = graph();
        missing
            .nodes
            .iter_mut()
            .find(|node| node.id == missing.output_node)
            .unwrap()
            .inputs = vec!["missing".into()];
        assert!(topology(&missing).is_err());
        let mut duplicate = graph();
        duplicate.nodes.push(duplicate.nodes[0].clone());
        assert!(topology(&duplicate).is_err());
        let mut recursive = graph();
        let node = recursive
            .nodes
            .iter_mut()
            .find(|node| node.operation.kind_name() == "adjustment")
            .unwrap();
        node.inputs = vec![node.id.clone()];
        if let NodeOperation::Adjustment {
            affected_inputs, ..
        } = &mut node.operation
        {
            *affected_inputs = node.inputs.clone();
        }
        assert!(topology(&recursive).is_err());
    }

    #[test]
    fn legacy_identity_with_an_embedded_marker_does_not_enable_the_route() {
        let mut graph = graph();
        assert!(is_explicit(&graph));
        graph.graph_id = "project:layer-order-v1:legacy:r7".into();
        assert!(!is_explicit(&graph));
    }
}

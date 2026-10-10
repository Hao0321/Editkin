use super::model::*;
use super::motion_paint::MAX_SEGMENTS;
use super::motion_paint_track::{NativeMotionPaintBudget, PreparedNativeMotionPaintTrack};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

fn finite(values: &[f32]) -> bool {
    values.iter().all(|value| value.is_finite())
}

fn valid_frame_range(range: &NodeFrameRange) -> bool {
    range.duration_frames > 0
        && range
            .timeline_start_frame
            .checked_add(range.duration_frames)
            .is_some()
        && range
            .source_start_frame
            .checked_add(range.duration_frames)
            .is_some()
}

fn valid_color(value: &str) -> bool {
    matches!(value.len(), 7 | 9)
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn valid_motion_graphic_quad(quad: &[MotionGraphicQuadPoint; 4]) -> bool {
    const SAFE_MARGIN: f32 = 0.02;
    const MIN_EDGE: f32 = 0.01;
    const MIN_AREA: f32 = 0.0001;

    if quad.iter().any(|point| {
        !point.x.is_finite()
            || !point.y.is_finite()
            || !(SAFE_MARGIN..=1.0 - SAFE_MARGIN).contains(&point.x)
            || !(SAFE_MARGIN..=1.0 - SAFE_MARGIN).contains(&point.y)
    }) {
        return false;
    }

    let mut cross_sign = 0.0_f32;
    for index in 0..4 {
        let current = quad[index];
        let next = quad[(index + 1) % 4];
        let after = quad[(index + 2) % 4];
        let edge_x = next.x - current.x;
        let edge_y = next.y - current.y;
        if edge_x.hypot(edge_y) < MIN_EDGE {
            return false;
        }
        let cross = edge_x * (after.y - next.y) - edge_y * (after.x - next.x);
        if cross.abs() <= f32::EPSILON {
            return false;
        }
        if cross_sign == 0.0 {
            cross_sign = cross.signum();
        } else if cross.signum() != cross_sign {
            return false;
        }
    }

    let twice_area = (0..4)
        .map(|index| {
            let current = quad[index];
            let next = quad[(index + 1) % 4];
            current.x * next.y - next.x * current.y
        })
        .sum::<f32>()
        .abs();
    twice_area * 0.5 >= MIN_AREA
}

fn validate_operation(node: &EngineNode) -> Result<(), String> {
    match &node.operation {
        NodeOperation::Source {
            asset_id,
            media_kind,
            timeline,
            ..
        } => {
            if asset_id.trim().is_empty()
                || !matches!(media_kind.as_str(), "video" | "image" | "generator")
                || timeline
                    .as_ref()
                    .is_some_and(|range| !valid_frame_range(range))
            {
                return Err(format!("node {} has invalid source", node.id));
            }
        }
        NodeOperation::Transform2d {
            x,
            y,
            scale_x,
            scale_y,
            rotation_radians,
            opacity,
            keyframes,
            ..
        } => {
            if !finite(&[*x, *y, *scale_x, *scale_y, *rotation_radians, *opacity])
                || *scale_x == 0.0
                || *scale_y == 0.0
                || !(0.0..=1.0).contains(opacity)
            {
                return Err(format!("node {} has invalid 2d transform", node.id));
            }
            if keyframes.len() > 64 {
                return Err(format!(
                    "node {} transform keyframes must contain at most 64 points",
                    node.id
                ));
            }
            let mut previous_frame = None;
            for keyframe in keyframes {
                if previous_frame.is_some_and(|previous| keyframe.frame <= previous) {
                    return Err(format!(
                        "node {} transform keyframes must be strictly increasing",
                        node.id
                    ));
                }
                if !finite(&[
                    keyframe.x,
                    keyframe.y,
                    keyframe.scale_x,
                    keyframe.scale_y,
                    keyframe.rotation_radians,
                    keyframe.opacity,
                ]) || keyframe.scale_x <= 0.0001
                    || keyframe.scale_y <= 0.0001
                    || !(0.0..=1.0).contains(&keyframe.opacity)
                {
                    return Err(format!(
                        "node {} has invalid 2d transform keyframe",
                        node.id
                    ));
                }
                previous_frame = Some(keyframe.frame);
            }
        }
        NodeOperation::FloatingVideoFrame2d { spec } => {
            if !node.enabled || node.inputs.len() != 1 {
                return Err(format!("node {} floating video requires one enabled source branch", node.id));
            }
            spec.validate()?;
        }
        NodeOperation::Transform3d {
            position,
            rotation_radians,
            scale,
            ..
        } => {
            if !finite(position)
                || !finite(rotation_radians)
                || !finite(scale)
                || scale.contains(&0.0)
            {
                return Err(format!("node {} has invalid 3d transform", node.id));
            }
        }
        NodeOperation::Camera {
            position,
            target,
            up,
            vertical_fov_radians,
            near,
            far,
            keyframes,
        } => {
            if !finite(position)
                || !finite(target)
                || !finite(up)
                || !finite(&[*vertical_fov_radians, *near, *far])
                || *vertical_fov_radians <= 0.0
                || *vertical_fov_radians >= std::f32::consts::PI
                || *near <= 0.0
                || *far <= *near
            {
                return Err(format!("node {} has invalid camera", node.id));
            }
            if keyframes.len() > 16 {
                return Err(format!(
                    "node {} camera keyframes must contain at most 16 points",
                    node.id
                ));
            }
            let mut previous_frame = None;
            for keyframe in keyframes {
                let direction_squared = keyframe
                    .position
                    .iter()
                    .zip(keyframe.target)
                    .map(|(position, target)| (target - position).powi(2))
                    .sum::<f32>();
                if keyframe.frame == 0
                    || previous_frame.is_some_and(|previous| keyframe.frame <= previous)
                    || !finite(&keyframe.position)
                    || !finite(&keyframe.target)
                    || !keyframe.vertical_fov_radians.is_finite()
                    || keyframe.vertical_fov_radians <= 0.0
                    || keyframe.vertical_fov_radians >= std::f32::consts::PI
                    || direction_squared <= 1.0e-12
                {
                    return Err(format!(
                        "node {} has invalid or unordered camera keyframe",
                        node.id
                    ));
                }
                previous_frame = Some(keyframe.frame);
            }
        }
        NodeOperation::Light {
            light_kind,
            color,
            intensity,
            position,
            direction,
            keyframes,
        } => {
            if !finite(color)
                || !finite(position)
                || !finite(direction)
                || !intensity.is_finite()
                || *intensity < 0.0
                || color.iter().any(|value| *value < 0.0)
            {
                return Err(format!("node {} has invalid light", node.id));
            }
            if keyframes.len() > 16 {
                return Err(format!(
                    "node {} light keyframes must contain at most 16 points",
                    node.id
                ));
            }
            let mut previous_frame = None;
            for keyframe in keyframes {
                let direction_squared = keyframe
                    .direction
                    .iter()
                    .map(|value| value.powi(2))
                    .sum::<f32>();
                if keyframe.frame == 0
                    || previous_frame.is_some_and(|previous| keyframe.frame <= previous)
                    || !finite(&keyframe.color)
                    || keyframe.color.iter().any(|value| *value < 0.0)
                    || !finite(&keyframe.direction)
                    || !keyframe.intensity.is_finite()
                    || keyframe.intensity < 0.0
                    || direction_squared <= 1.0e-12
                    || matches!(light_kind, crate::engine::model::LightKind::Ambient)
                        && (keyframe
                            .color
                            .iter()
                            .any(|value| (*value - 1.0).abs() > 1.0e-6)
                            || keyframe.direction != [0.0, 0.0, -1.0])
                {
                    return Err(format!(
                        "node {} has invalid or unordered light keyframe",
                        node.id
                    ));
                }
                previous_frame = Some(keyframe.frame);
            }
        }
        NodeOperation::Mask {
            matte_id,
            feather,
            expansion,
            ..
        } => {
            if matte_id.trim().is_empty() || !finite(&[*feather, *expansion]) || *feather < 0.0 {
                return Err(format!("node {} has invalid matte", node.id));
            }
        }
        NodeOperation::AutoRoto {
            sequence_id,
            model_id,
            model_sha256,
            cache_manifest,
            frozen,
        } => {
            if sequence_id.trim().is_empty()
                || model_id.trim().is_empty()
                || model_sha256.len() != 64
                || cache_manifest.trim().is_empty()
                || !*frozen
            {
                return Err(format!(
                    "node {} requires a frozen, hash-bound pixel matte sequence",
                    node.id
                ));
            }
        }
        NodeOperation::Color {
            processor,
            input_space,
            working_space,
            output_space,
            grade,
        } => {
            super::white_balance::validate_contract(processor, *grade)
                .map_err(|error| format!("node {}: {error}", node.id))?;
            if processor.trim().is_empty()
                || input_space.trim().is_empty()
                || working_space.trim().is_empty()
                || output_space.trim().is_empty()
                || !finite(&grade.values())
                || grade.contrast < 0.0
                || grade.saturation < 0.0
                || !(0.0..=1.0).contains(&grade.pivot)
            {
                return Err(format!("node {} has incomplete color transform", node.id));
            }
        }
        NodeOperation::Effect {
            plugin_id,
            abi_version,
            temporal_radius,
            parameters,
        } => {
            if plugin_id.trim().is_empty()
                || *abi_version != ENGINE_ABI_VERSION
                || *temporal_radius > 240
                || parameters.values().any(|value| !value.is_finite())
            {
                return Err(format!("node {} has incompatible effect ABI", node.id));
            }
        }
        NodeOperation::Composite {
            opacity,
            matte_input,
            matte_mode,
            ..
        } => {
            if !opacity.is_finite()
                || !(0.0..=1.0).contains(opacity)
                || matte_input.as_ref().is_some_and(|id| id.trim().is_empty())
                || matte_input.is_some() != matte_mode.is_some()
            {
                return Err(format!("node {} has invalid composite", node.id));
            }
        }
        NodeOperation::Adjustment {
            affected_inputs,
            timeline,
        } => {
            if affected_inputs.is_empty()
                || timeline
                    .as_ref()
                    .is_some_and(|range| !valid_frame_range(range))
            {
                return Err(format!("node {} adjustment has no targets", node.id));
            }
        }
        NodeOperation::Precomposition {
            nested_graph_id,
            timeline,
        } => {
            if nested_graph_id.trim().is_empty() || !valid_frame_range(timeline) {
                return Err(format!("node {} has invalid precomposition", node.id));
            }
        }
        NodeOperation::Caption {
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
            shadow,
            letter_spacing,
            ..
        } => {
            if cue_id.trim().is_empty()
                || text.trim().is_empty()
                || !valid_frame_range(timeline)
                || font_family.trim().is_empty()
                || !finite(&[
                    *font_size,
                    *outline_width,
                    *margin_vertical,
                    *shadow,
                    *letter_spacing,
                ])
                || *font_size <= 0.0
                || *outline_width < 0.0
                || *shadow < 0.0
                || !valid_color(text_color)
                || !valid_color(outline_color)
                || !valid_color(background_color)
                || !(1..=9).contains(alignment)
            {
                return Err(format!("node {} has invalid caption", node.id));
            }
        }
        NodeOperation::NativeMotionPaint { graphic_id, .. } => {
            if graphic_id.trim().is_empty() || graphic_id.len() > 128
                || !node.enabled || !node.inputs.is_empty()
            {
                return Err(format!("node {} has invalid native motion paint identity, enablement or inputs", node.id));
            }
        }
        NodeOperation::MotionGraphic {
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
        } => {
            if graphic_id.trim().is_empty()
                || !matches!(graphic_kind.as_str(), "title" | "card" | "tag" | "counter")
                || text.trim().is_empty()
                || text.chars().count() > 128
                || !valid_frame_range(timeline)
                || font_family.trim().is_empty()
                || !finite(&[
                    *x,
                    *y,
                    *width,
                    *font_size,
                    *letter_spacing,
                    *outline_width,
                    *shadow_depth,
                    *corner_radius,
                    *offset_x,
                    *offset_y,
                ])
                || !(0.0..=1.0).contains(x)
                || !(0.0..=1.0).contains(y)
                || !(0.05..=1.0).contains(width)
                || !(8.0..=192.0).contains(font_size)
                || !(100..=900).contains(font_weight)
                || !(-5.0..=20.0).contains(letter_spacing)
                || !(0.0..=12.0).contains(outline_width)
                || !(0.0..=10.0).contains(shadow_depth)
                || !(0.0..=96.0).contains(corner_radius)
                || !valid_color(text_color)
                || !valid_color(background_color)
                || !valid_color(accent_color)
                || !matches!(
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
                )
                || !matches!(
                    animation.as_str(),
                    "fade" | "slide_up" | "pop" | "spring_soft"
                )
                || !matches!(tracking_mode.as_str(), "anchor" | "surface")
                || (tracking_mode == "surface" && (tracking.is_none() || animation != "fade"))
                || offset_x.abs() > 1.0
                || offset_y.abs() > 1.0
                || (tracking.is_none() && (*offset_x != 0.0 || *offset_y != 0.0))
            {
                return Err(format!("node {} has invalid motion graphic", node.id));
            }
            if let Some(tracking) = tracking {
                if tracking.track_id.trim().is_empty()
                    || tracking.samples.is_empty()
                    || tracking.samples.len() > 18_000
                {
                    return Err(format!(
                        "node {} has invalid motion graphic tracking",
                        node.id
                    ));
                }
                let timeline_end = timeline.timeline_start_frame + timeline.duration_frames;
                let mut previous_frame = None;
                for sample in &tracking.samples {
                    if previous_frame.is_some_and(|previous| sample.timeline_frame <= previous)
                        || sample.timeline_frame < timeline.timeline_start_frame
                        || sample.timeline_frame >= timeline_end
                        || !finite(&[
                            sample.x,
                            sample.y,
                            sample.confidence,
                            sample.rotation_radians,
                            sample.scale,
                        ])
                        || !(0.0..=1.0).contains(&sample.x)
                        || !(0.0..=1.0).contains(&sample.y)
                        || (tracking_mode == "anchor" && sample.x + *width > 1.0 + f32::EPSILON)
                        || !(0.0..=1.0).contains(&sample.confidence)
                        || sample.rotation_radians.abs() > std::f32::consts::TAU
                        || !(0.25..=4.0).contains(&sample.scale)
                        || match tracking_mode.as_str() {
                            "anchor" => sample.destination_quad.is_some(),
                            "surface" => match sample.status {
                                MotionGraphicTrackingStatus::Lost => {
                                    sample.destination_quad.is_some()
                                }
                                _ => sample
                                    .destination_quad
                                    .as_ref()
                                    .is_none_or(|quad| !valid_motion_graphic_quad(quad)),
                            },
                            _ => true,
                        }
                    {
                        return Err(format!(
                            "node {} has invalid motion graphic tracking sample",
                            node.id
                        ));
                    }
                    previous_frame = Some(sample.timeline_frame);
                }
            }
        }
        NodeOperation::ParticleEmitter {
            timeline,
            rate_per_second,
            lifetime_seconds,
            initial_velocity,
            gravity,
            max_particles,
            emitter_position,
            radius_pixels,
            color,
            ..
        } => {
            if !finite(&[*rate_per_second, *lifetime_seconds])
                || timeline
                    .as_ref()
                    .is_none_or(|range| !valid_frame_range(range))
                || !finite(initial_velocity)
                || !finite(gravity)
                || !finite(emitter_position)
                || !finite(&[*radius_pixels])
                || !finite(color)
                || *rate_per_second < 0.0
                || *lifetime_seconds <= 0.0
                || *max_particles == 0
                || *max_particles > 2_000_000
                || emitter_position
                    .iter()
                    .any(|value| !(0.0..=1.0).contains(value))
                || *radius_pixels <= 0.0
                || color.iter().any(|value| !(0.0..=1.0).contains(value))
            {
                return Err(format!("node {} has invalid particle emitter", node.id));
            }
        }
        NodeOperation::DepthOfField {
            focus_distance,
            aperture,
            max_blur_radius,
            keyframes,
        } => {
            if !finite(&[*focus_distance, *aperture, *max_blur_radius])
                || *focus_distance <= 0.0
                || *aperture <= 0.0
                || *aperture > 16.0
                || *max_blur_radius < 1.0
                || *max_blur_radius > 32.0
            {
                return Err(format!("node {} has invalid depth of field", node.id));
            }
            if keyframes.len() > 16 {
                return Err(format!(
                    "node {} depth of field keyframes exceed 16",
                    node.id
                ));
            }
            let mut previous_frame = 0;
            for keyframe in keyframes {
                if keyframe.frame <= previous_frame
                    || !finite(&[
                        keyframe.focus_distance,
                        keyframe.aperture,
                        keyframe.max_blur_radius,
                    ])
                    || keyframe.focus_distance <= 0.0
                    || keyframe.aperture <= 0.0
                    || keyframe.aperture > 16.0
                    || keyframe.max_blur_radius < 1.0
                    || keyframe.max_blur_radius > 32.0
                {
                    return Err(format!(
                        "node {} has invalid depth of field keyframe",
                        node.id
                    ));
                }
                previous_frame = keyframe.frame;
            }
        }
        NodeOperation::MotionBlur {
            shutter_angle,
            samples,
            source_sampling: _,
        } => {
            if !shutter_angle.is_finite()
                || !(0.0..=720.0).contains(shutter_angle)
                || !(1..=64).contains(samples)
            {
                return Err(format!("node {} has invalid motion blur", node.id));
            }
        }
        NodeOperation::Output { .. } => {}
    }
    Ok(())
}

fn topological_order(nodes: &[EngineNode]) -> Result<Vec<String>, String> {
    let mut indegree = BTreeMap::<String, usize>::new();
    let mut outgoing = BTreeMap::<String, Vec<String>>::new();
    for node in nodes {
        indegree.insert(node.id.clone(), 0);
    }
    for node in nodes {
        for input in &node.inputs {
            if !indegree.contains_key(input) {
                return Err(format!(
                    "node {} references missing input {}",
                    node.id, input
                ));
            }
            *indegree.get_mut(&node.id).expect("known node") += 1;
            outgoing
                .entry(input.clone())
                .or_default()
                .push(node.id.clone());
        }
        let implicit_input = match &node.operation {
            NodeOperation::Transform2d {
                parent: Some(parent),
                ..
            }
            | NodeOperation::Transform3d {
                parent: Some(parent),
                ..
            } => Some((parent, "parent")),
            NodeOperation::Composite {
                matte_input: Some(matte),
                ..
            } => Some((matte, "matte")),
            _ => None,
        };
        if let Some((reference, kind)) = implicit_input {
            if !indegree.contains_key(reference) {
                return Err(format!(
                    "node {} references missing {} {}",
                    node.id, kind, reference
                ));
            }
            if !node.inputs.contains(reference) {
                *indegree.get_mut(&node.id).expect("known node") += 1;
                outgoing
                    .entry(reference.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
    }
    let mut ready = VecDeque::from(
        indegree
            .iter()
            .filter_map(|(id, degree)| (*degree == 0).then_some(id.clone()))
            .collect::<Vec<_>>(),
    );
    let mut order = Vec::with_capacity(nodes.len());
    while let Some(id) = ready.pop_front() {
        order.push(id.clone());
        if let Some(children) = outgoing.get(&id) {
            for child in children {
                let degree = indegree.get_mut(child).expect("known child");
                *degree -= 1;
                if *degree == 0 {
                    ready.push_back(child.clone());
                }
            }
        }
    }
    if order.len() != nodes.len() {
        return Err("render graph contains a dependency cycle".into());
    }
    Ok(order)
}

pub fn validate_audio(graph: &AudioGraph) -> Result<(), String> {
    if !(8_000..=384_000).contains(&graph.sample_rate) || !(1..=32).contains(&graph.channels) {
        return Err("invalid audio format".into());
    }
    let ids = graph
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    if ids.len() != graph.nodes.len() || !ids.contains(graph.master_node.as_str()) {
        return Err("invalid or duplicate audio node id".into());
    }
    for node in &graph.nodes {
        if node.id.trim().is_empty()
            || node
                .inputs
                .iter()
                .any(|input| !ids.contains(input.as_str()))
        {
            return Err(format!("audio node {} has invalid input", node.id));
        }
        for lane in &node.automation {
            if lane.property.trim().is_empty()
                || lane.points.is_empty()
                || lane
                    .points
                    .windows(2)
                    .any(|pair| pair[0].sample >= pair[1].sample)
                || lane.points.iter().any(|point| !point.value.is_finite())
            {
                return Err(format!("audio node {} has invalid automation", node.id));
            }
        }
    }
    Ok(())
}

pub fn compile_graph(graph: EngineGraph) -> Result<CompiledGraph, String> {
    if graph.schema != ENGINE_GRAPH_SCHEMA {
        return Err(format!("unsupported engine graph schema: {}", graph.schema));
    }
    if graph.graph_id.trim().is_empty()
        || !(1..=16_384).contains(&graph.width)
        || !(1..=16_384).contains(&graph.height)
    {
        return Err("invalid graph identity or dimensions".into());
    }
    if graph.timebase.numerator == 0
        || graph.timebase.denominator == 0
        || graph.timebase.denominator > 1_000_000
    {
        return Err("invalid rational timebase".into());
    }
    if !(64..=262_144).contains(&graph.cache_budget_mb) {
        return Err("cache budget must be 64..=262144 MiB".into());
    }
    if graph.nodes.is_empty() || graph.nodes.len() > 16_384 {
        return Err("render graph must contain 1..=16384 nodes".into());
    }
    let ids = graph
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    if ids.len() != graph.nodes.len() || ids.iter().any(|id| id.trim().is_empty()) {
        return Err("render graph contains an empty or duplicate node id".into());
    }
    if !ids.contains(graph.output_node.as_str()) {
        return Err("output node is missing".into());
    }
    let mut native_paint_budget = NativeMotionPaintBudget::default();
    let mut native_paint_graphic_ids = BTreeSet::new();
    let legacy_motion_graphic_ids = graph.nodes.iter().filter_map(|node| {
        match &node.operation {
            NodeOperation::MotionGraphic { graphic_id, .. } => Some(graphic_id.as_str()),
            _ => None,
        }
    }).collect::<BTreeSet<_>>();
    for node in &graph.nodes {
        validate_operation(node)?;
        if let NodeOperation::NativeMotionPaint { graphic_id, track } = &node.operation {
            if graph.working_format != PixelFormat::Rgba16Float {
                return Err("native motion paint requires Rgba16Float graph working format".into());
            }
            if legacy_motion_graphic_ids.contains(graphic_id.as_str()) {
                return Err("render graph cannot mix v1 and native paint for the same graphic ID".into());
            }
            if !native_paint_graphic_ids.insert(graphic_id.as_str()) {
                return Err("render graph contains duplicate native paint graphic IDs".into());
            }
            native_paint_budget.include(track.validate_structure(graph.width, graph.height)?)?;
        }
    }
    let order = topological_order(&graph.nodes)?;
    let by_id = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let floating_nodes = graph.nodes.iter().filter(|node| matches!(node.operation, NodeOperation::FloatingVideoFrame2d { .. })).collect::<Vec<_>>();
    if floating_nodes.len() > super::floating_video_frame::MAX_FLOATING_NODES {
        return Err("shared floating video node count exceeds bounded resource contract".into());
    }
    if !floating_nodes.is_empty() {
        // A finalized floating parent includes its media entrance/exit opacity.
        // That opacity must not leak into a child's authored affine transform.
        for candidate in &graph.nodes {
            if let NodeOperation::Transform2d { parent: Some(parent), .. } = &candidate.operation {
                let mut pending = vec![parent.as_str()];
                let mut visited = BTreeSet::new();
                while let Some(id) = pending.pop() {
                    if !visited.insert(id) { continue; }
                    let ancestor = by_id.get(id).ok_or("floating affine parent references missing graph node")?;
                    if matches!(ancestor.operation, NodeOperation::FloatingVideoFrame2d { .. }) {
                        return Err("floating video media cannot be used as an affine parent until media-phase inheritance is separated".into());
                    }
                    pending.extend(ancestor.inputs.iter().map(String::as_str));
                    if let NodeOperation::Transform2d { parent: Some(next), .. } = &ancestor.operation {
                        pending.push(next.as_str());
                    }
                }
            }
        }
        if graph.nodes.iter().any(|node| matches!(node.operation,
            NodeOperation::Transform3d { .. } | NodeOperation::Camera { .. } | NodeOperation::Light { .. }
            | NodeOperation::Mask { .. } | NodeOperation::AutoRoto { .. } | NodeOperation::MotionBlur { .. }
            | NodeOperation::DepthOfField { .. } | NodeOperation::Precomposition { .. } | NodeOperation::Effect { .. }
            | NodeOperation::ParticleEmitter { .. } | NodeOperation::Adjustment { .. }))
            || graph.nodes.iter().any(|node| matches!(&node.operation, NodeOperation::Composite { matte_input: Some(_), .. })) {
            return Err("shared floating video does not admit depth, matte, effect, temporal or nested execution".into());
        }
        for node in floating_nodes {
            let NodeOperation::FloatingVideoFrame2d { spec } = &node.operation else { unreachable!() };
            if spec.canvas_width != graph.width || spec.canvas_height != graph.height || spec.timebase != graph.timebase {
                return Err("floating video descriptor canvas or rational clock differs from actual graph".into());
            }
            let mut current = node.inputs[0].as_str(); let mut branch = BTreeSet::new(); let mut color_count = 0;
            loop {
                if !branch.insert(current) { return Err("floating video source branch is cyclic".into()); }
                let input = by_id.get(current).ok_or("floating video references missing actual source branch")?;
                if !input.enabled { return Err("floating video source branch cannot be disabled".into()); }
                match &input.operation {
                    NodeOperation::Color { processor, input_space, working_space, output_space, .. } => {
                        color_count += 1;
                        if color_count != 1 || input.inputs.len() != 1 || input_space != "rec709"
                            || working_space != "linear_rec709" || output_space != "linear_rec709"
                            || processor != "editkin-rec709-to-linear-rec709-primary/v2" {
                            return Err("floating video must assemble after exactly one Rec709 source colour boundary".into());
                        }
                        current = input.inputs[0].as_str();
                    }
                    NodeOperation::Source { media_kind, input_color_space, timeline, .. } => {
                        if color_count != 1 || media_kind != "video" || !input.inputs.is_empty()
                            || input_color_space.as_deref() != Some("rec709") || timeline.as_ref() != Some(&spec.timeline) {
                            return Err("floating video descriptor does not match its actual typed video/source timeline".into());
                        }
                        break;
                    }
                    _ => return Err("floating video source ordering must be source then colour then assembly then affine".into()),
                }
            }
            let mut reachable = BTreeSet::new(); let mut pending = vec![graph.output_node.as_str()];
            while let Some(id) = pending.pop() {
                if !reachable.insert(id) { continue; }
                let input = by_id.get(id).ok_or("floating output references missing graph node")?;
                if input.enabled { pending.extend(input.inputs.iter().map(String::as_str)); }
            }
            if !reachable.contains(node.id.as_str()) {
                return Err("floating video node does not contribute to the actual enabled output".into());
            }
        }
    }
    if !matches!(
        by_id[graph.output_node.as_str()].operation,
        NodeOperation::Output { .. }
    ) {
        return Err("output_node must reference an output operation".into());
    }
    if !native_paint_graphic_ids.is_empty() {
        // Native paint may only be advertised when it contributes to an enabled
        // output dependency path, including explicit matte and parent references.
        let mut reachable = BTreeSet::new();
        let mut pending = vec![graph.output_node.as_str()];
        while let Some(id) = pending.pop() {
            let node = by_id[id];
            if !node.enabled || !reachable.insert(id) { continue; }
            pending.extend(node.inputs.iter().map(String::as_str));
            match &node.operation {
                NodeOperation::Transform2d { parent: Some(parent), .. }
                | NodeOperation::Transform3d { parent: Some(parent), .. } => pending.push(parent.as_str()),
                NodeOperation::Composite { matte_input: Some(matte), .. } => pending.push(matte.as_str()),
                _ => {}
            }
        }
        let mut edges = 0_usize;
        for node in &graph.nodes {
            if let NodeOperation::NativeMotionPaint { track, .. } = &node.operation {
                if !reachable.contains(node.id.as_str()) {
                    return Err(format!("native paint node {} does not contribute to the enabled graph output", node.id));
                }
                let prepared = PreparedNativeMotionPaintTrack::prepare(track, graph.width, graph.height)?;
                edges = edges.checked_add(prepared.edge_count()).ok_or("native paint flattened edge count overflow")?;
                if edges > MAX_SEGMENTS { return Err("shared native paint flattened edge budget exceeded".into()); }
            }
        }
    }
    if let Some(audio) = &graph.audio {
        validate_audio(audio)?;
    }
    let mut features = BTreeSet::new();
    for node in &graph.nodes {
        let feature = match node.operation {
            NodeOperation::Transform3d { .. }
            | NodeOperation::Camera { .. }
            | NodeOperation::Light { .. } => "scene_3d",
            NodeOperation::AutoRoto { .. } => "auto_roto",
            NodeOperation::ParticleEmitter { .. } => "particles",
            NodeOperation::DepthOfField { .. } => "depth_of_field",
            NodeOperation::MotionBlur { .. } => "motion_blur",
            NodeOperation::Effect { .. } => "effect_abi",
            NodeOperation::Color { .. } => "color_management",
            NodeOperation::Mask { .. } => "pixel_matte",
            NodeOperation::Caption { .. } => "caption_rendering",
            NodeOperation::MotionGraphic { .. } => "motion_graphics",
            NodeOperation::NativeMotionPaint { .. } => {
                features.insert("motion_graphics");
                "native_motion_paint"
            },
            NodeOperation::FloatingVideoFrame2d { .. } => "floating_video_frame_2d",
            NodeOperation::Precomposition { .. } => "precomposition",
            NodeOperation::Adjustment { .. } => "adjustment_layers",
            _ => "core_compositing",
        };
        features.insert(feature);
    }
    if graph.audio.is_some() {
        features.insert("audio_graph");
    }
    let passes = order
        .into_iter()
        .filter_map(|id| {
            let node = by_id[id.as_str()];
            node.enabled.then(|| CompiledPass {
                node_id: id,
                stage: node.operation.stage(),
                inputs: node.inputs.clone(),
            })
        })
        .collect();
    Ok(CompiledGraph {
        schema: ENGINE_GRAPH_SCHEMA,
        engine_abi_version: ENGINE_ABI_VERSION,
        graph_id: graph.graph_id,
        timebase: graph.timebase,
        working_format: graph.working_format,
        output_node: graph.output_node,
        passes,
        audio_node_count: graph.audio.as_ref().map_or(0, |audio| audio.nodes.len()),
        cache_budget_mb: graph.cache_budget_mb,
        feature_families: features.into_iter().collect(),
    })
}

pub fn dirty_descendants(graph: &EngineGraph, changed: &[String]) -> Result<Vec<String>, String> {
    let ids = graph
        .nodes
        .iter()
        .map(|node| node.id.as_str())
        .collect::<BTreeSet<_>>();
    if changed.iter().any(|id| !ids.contains(id.as_str())) {
        return Err("dirty set contains an unknown node".into());
    }
    let mut dirty = changed.iter().cloned().collect::<BTreeSet<_>>();
    loop {
        let before = dirty.len();
        for node in &graph.nodes {
            if node.inputs.iter().any(|input| dirty.contains(input)) {
                dirty.insert(node.id.clone());
            }
        }
        if dirty.len() == before {
            break;
        }
    }
    Ok(topological_order(&graph.nodes)?
        .into_iter()
        .filter(|id| dirty.contains(id))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{MotionGraphicQuadPoint, valid_motion_graphic_quad};

    #[test]
    fn surface_quad_contract_rejects_bounds_order_and_degeneracy() {
        let valid = [
            MotionGraphicQuadPoint { x: 0.2, y: 0.2 },
            MotionGraphicQuadPoint { x: 0.7, y: 0.24 },
            MotionGraphicQuadPoint { x: 0.74, y: 0.62 },
            MotionGraphicQuadPoint { x: 0.18, y: 0.66 },
        ];
        assert!(valid_motion_graphic_quad(&valid));
        let mut out_of_bounds = valid;
        out_of_bounds[0].x = 0.01;
        assert!(!valid_motion_graphic_quad(&out_of_bounds));
        let mut crossed = valid;
        crossed.swap(1, 2);
        assert!(!valid_motion_graphic_quad(&crossed));
        assert!(!valid_motion_graphic_quad(&[valid[0]; 4]));
    }
}

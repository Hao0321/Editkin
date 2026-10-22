//! Opt-in paired scenes reuse the existing styled layer pass and colour boundary.
use super::*;
use crate::engine_graph::{EngineDisplayTransform, PreparedTimelinePairV1};
use crate::timeline_transition_v1::{TimelineTransitionPassV1, TransitionKernelV1};
use hao_core::engine::timeline_pair_v1::TimelinePairKernelV1;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy)]
pub(crate) struct TimelinePairSceneContextV1<'a> {
    pub pairs: &'a [PreparedTimelinePairV1],
    /// Resident video indices precede all particle, caption and paint surfaces.
    pub layer_indices: &'a [usize],
    pub timeline_frame: u64,
}

pub(super) struct TimelinePairSceneResourcesV1 {
    scenes: [wgpu::Texture; 2],
    ping: [wgpu::Texture; 2],
    pass: TimelineTransitionPassV1,
    width: u32,
    height: u32,
}
impl TimelinePairSceneResourcesV1 {
    fn new(compositor: &GpuCompositor, width: u32, height: u32) -> Result<Self> {
        Ok(Self {
            scenes: create_composite_intermediate(&compositor.device, width, height, wgpu::TextureFormat::Rgba16Float),
            ping: create_composite_intermediate(&compositor.device, width, height, wgpu::TextureFormat::Rgba16Float),
            pass: TimelineTransitionPassV1::new(&compositor.device, wgpu::TextureFormat::Rgba16Float)?, width, height,
        })
    }
}
#[derive(Clone, Copy, Debug)]
struct ActivePairV1 { from: usize, to: usize, progress: f64, kernel: TransitionKernelV1 }

fn active_pairs(context: TimelinePairSceneContextV1<'_>, base: usize, scene_count: usize) -> Result<BTreeMap<usize, ActivePairV1>> {
    let mut pairs = BTreeMap::new(); let mut participants = BTreeSet::new();
    if context.layer_indices.iter().collect::<BTreeSet<_>>().len() != context.layer_indices.len() {
        bail!("TIMELINE_TRANSITION_NATIVE_SOURCE_INDEX_DUPLICATE");
    }
    for pair in context.pairs {
        let Some(progress) = pair.spec.progress(context.timeline_frame as f64).map_err(anyhow::Error::msg)? else { continue; };
        let position = |index| context.layer_indices.iter().position(|candidate| *candidate == index)
            .context("TIMELINE_TRANSITION_NATIVE_ACTIVE_HANDLE_MISSING");
        let from = position(pair.from_layer_index)?; let to = position(pair.to_layer_index)?;
        if from >= scene_count || to >= scene_count || (from < base) != (to < base) {
            bail!("TIMELINE_TRANSITION_NATIVE_COLOUR_BOUNDARY_CROSSING");
        }
        if !participants.insert(from) || !participants.insert(to) {
            bail!("TIMELINE_TRANSITION_NATIVE_ACTIVE_WINDOW_CONFLICT");
        }
        let kernel = match pair.spec.kernel { TimelinePairKernelV1::Dissolve => TransitionKernelV1::Dissolve, TimelinePairKernelV1::Dip => TransitionKernelV1::Dip };
        if pair.composite_layer_index != pair.to_layer_index { bail!("TIMELINE_TRANSITION_STALE_NATIVE_SLOT"); }
        if pairs.insert(to, ActivePairV1 { from, to, progress, kernel }).is_some() {
            bail!("TIMELINE_TRANSITION_NATIVE_ACTIVE_WINDOW_CONFLICT");
        }
    }
    Ok(pairs)
}

#[allow(clippy::too_many_arguments)]
fn encode_segment<'a>(surface: &'a NativePreviewSurface, compositor: &GpuCompositor,
    resources: &'a TimelinePairSceneResourcesV1, layers: &[VideoSurfaceLayer<'_>],
    uniforms: &[wgpu::Buffer], matte_uniforms: &[wgpu::Buffer], pairs: &BTreeMap<usize, ActivePairV1>,
    range: std::ops::Range<usize>, mut backdrop: &'a wgpu::Texture, encoder: &mut wgpu::CommandEncoder) -> Result<&'a wgpu::Texture> {
    let participants = pairs.values().flat_map(|pair| [pair.from, pair.to]).collect::<BTreeSet<_>>();
    for index in range {
        let slot = usize::from(backdrop == &resources.ping[0]);
        let output = &resources.ping[slot];
        if let Some(pair) = pairs.get(&index) {
            // Each endpoint is a complete styled scene over the SAME backdrop.
            // Neither endpoint may become the other endpoint's backdrop.
            for (side, source_index) in [pair.from, pair.to].into_iter().enumerate() {
                let layer = layers[source_index];
                let view = resources.scenes[side].create_view(&Default::default());
                surface.encode_scene_linear_layer(compositor, layer.source, layer.temporal_sources,
                    &uniforms[source_index], layer.matte, &matte_uniforms[source_index], backdrop,
                    &view, resources.width, resources.height, encoder);
            }
            resources.pass.encode(&compositor.device, encoder, &resources.scenes[0], &resources.scenes[1], output, pair.progress, pair.kernel)?;
        } else if participants.contains(&index) { continue; }
        else {
            let layer = layers[index]; let view = output.create_view(&Default::default());
            surface.encode_scene_linear_layer(compositor, layer.source, layer.temporal_sources,
                &uniforms[index], layer.matte, &matte_uniforms[index], backdrop,
                &view, resources.width, resources.height, encoder);
        }
        backdrop = output;
    }
    Ok(backdrop)
}

impl NativePreviewSurface {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn present_scene_linear_aces2_layers(&mut self, compositor: &GpuCompositor,
        display: EngineDisplayTransform, layers: &[VideoSurfaceLayer<'_>], adjustments: &[VideoVisualStyle],
        base: Option<usize>, depth: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>) -> Result<serde_json::Value> {
        self.present_scene_linear_aces2_layers_with_pairs(compositor, display, layers, adjustments, base, depth, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn verify_scene_linear_aces2_layers_with_resources(&self, compositor: &GpuCompositor,
        display: EngineDisplayTransform, layers: &[VideoSurfaceLayer<'_>], adjustments: &[VideoVisualStyle],
        base: Option<usize>, depth: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>, width: u32, height: u32,
        path: &Path, reuse_resident: bool) -> Result<serde_json::Value> {
        self.verify_scene_linear_aces2_layers_with_resources_and_pairs(compositor, display, layers,
            adjustments, base, depth, width, height, path, reuse_resident, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn verify_scene_linear_aces2_layers_with_pairs(&self, compositor: &GpuCompositor,
        display: EngineDisplayTransform, layers: &[VideoSurfaceLayer<'_>], adjustments: &[VideoVisualStyle],
        base: Option<usize>, depth: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>, width: u32, height: u32,
        path: &Path, pairs: TimelinePairSceneContextV1<'_>) -> Result<serde_json::Value> {
        let mut result = self.verify_scene_linear_aces2_layers_with_resources_and_pairs(compositor, display, layers,
            adjustments, base, depth, width, height, path, self.is_offscreen(), Some(pairs))?;
        result["timelineTransitionExecutor"] = serde_json::json!("editkin.timeline-pair-scene/v1");
        result["timelineTransitionActiveCount"] = serde_json::json!(pairs.pairs.iter().filter(|pair| pair.spec.progress(pairs.timeline_frame as f64).ok().flatten().is_some()).count());
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn encode_scene_linear_aces2_graph(&self, compositor: &GpuCompositor, display: EngineDisplayTransform,
        layers: &[VideoSurfaceLayer<'_>], adjustments: &[VideoVisualStyle], base: Option<usize>,
        depth: Option<&crate::engine_graph::EngineVideoDepthOfFieldPlan>, composite: &[wgpu::Texture; 2],
        adjusted: &[wgpu::Texture; 2], depth_texture: &wgpu::Texture, destination: &wgpu::TextureView,
        width: u32, height: u32, encoder: &mut wgpu::CommandEncoder, context: Option<TimelinePairSceneContextV1<'_>>) -> Result<(bool, bool)> {
        let Some(context) = context else {
            return self.encode_scene_linear_aces2_graph_legacy(compositor, display, layers, adjustments, base, depth,
                composite, adjusted, depth_texture, destination, width, height, encoder);
        };
        let scene_count = display_paint_suffix_start(layers, display, depth, width, height)?;
        let base = base.unwrap_or(scene_count);
        if base == 0 || base > scene_count { bail!("TIMELINE_TRANSITION_NATIVE_ADJUSTMENT_SPLIT_INVALID"); }
        let pairs = active_pairs(context, base, scene_count)?;
        if pairs.is_empty() {
            return self.encode_scene_linear_aces2_graph_legacy(compositor, display, layers, adjustments, Some(base), depth,
                composite, adjusted, depth_texture, destination, width, height, encoder);
        }
        if depth.is_some() || layers.iter().any(|layer| layer.style.scene_depth_enabled != 0) {
            bail!("TIMELINE_TRANSITION_NATIVE_DEPTH_PAIR_NOT_CONNECTED");
        }
        if layers.iter().any(|layer| layer.temporal_sources.is_some() != (layer.style.motion_contract_code == 2)
            || (layer.temporal_sources.is_some() && !(2..=8).contains(&layer.style.motion_sample_count))) {
            bail!("TIMELINE_TRANSITION_NATIVE_SHUTTER_BINDINGS_INVALID");
        }
        let uniform = |style: &VideoVisualStyle| compositor.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Editkin pair immutable styled scene uniform"), contents: bytemuck::bytes_of(style), usage: wgpu::BufferUsages::UNIFORM,
        });
        let uniforms = layers.iter().map(|layer| uniform(&layer.style)).collect::<Vec<_>>();
        let matte_uniforms = layers.iter().map(|layer| uniform(&layer.matte.map_or_else(VideoVisualStyle::default, |matte| matte.style))).collect::<Vec<_>>();
        let mut storage = self.timeline_pair_resources.borrow_mut();
        if storage.as_ref().is_none_or(|resources| resources.width != width || resources.height != height) {
            *storage = Some(TimelinePairSceneResourcesV1::new(compositor, width, height)?);
        }
        let resources = storage.as_ref().expect("pair resources created");
        let mut linear = encode_segment(self, compositor, resources, layers, &uniforms, &matte_uniforms, &pairs,
            0..base, &self.scene_linear_black_texture, encoder)?;
        for (index, style) in adjustments.iter().enumerate() {
            let style = style.with_source_dimensions(width, height); let buffer = uniform(&style);
            let output = &adjusted[index % 2]; let view = output.create_view(&Default::default());
            self.encode_scene_linear_layer(compositor, linear, None, &buffer, None, &buffer,
                &self.scene_linear_black_texture, &view, width, height, encoder);
            linear = output;
        }
        linear = encode_segment(self, compositor, resources, layers, &uniforms, &matte_uniforms, &pairs,
            base..scene_count, linear, encoder)?;
        if scene_count == layers.len() {
            self.encode_scene_linear_aces2_display(compositor, display, linear, destination, width, height, encoder)?;
        } else {
            let initial = usize::from(linear == &adjusted[0]);
            let view = adjusted[initial].create_view(&Default::default());
            self.encode_aces2_display_pipeline(compositor, &self.scene_to_display_linear_pipeline,
                &compositor.aces2_rec709_sdr_lut_buffer, linear, &view, width, height, encoder);
            for (index, layer_index) in (scene_count..layers.len()).enumerate() {
                let input = &adjusted[(initial + index) % 2];
                let view = adjusted[(initial + index + 1) % 2].create_view(&Default::default());
                self.encode_scene_linear_layer(compositor, layers[layer_index].source, None, &uniforms[layer_index],
                    None, &matte_uniforms[layer_index], input, &view, width, height, encoder);
            }
            let final_display = &adjusted[(initial + layers.len() - scene_count) % 2];
            self.encode_aces2_display_pipeline(compositor, &self.display_linear_output_pipeline,
                &compositor.aces2_rec709_sdr_lut_buffer, final_display, destination, width, height, encoder);
        }
        Ok((false, false))
    }
}

#[cfg(test)]
#[path = "timeline_pair_scene_tests_v1.rs"]
mod tests;

import type { EditProject } from "../domain/types";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, canPresentGpuVideoOnNativeSurface,
  type GpuEnginePreviewGraph } from "../render/gpuCompositor";

/** Compile/admit the full resident timeline once per immutable project revision.
 * These two builders use time only for timelineFrame, not graph membership. */
export function prepareResidentGpuGraphs(project: EditProject) {
  return {
    image: buildGpuEnginePreviewGraph(project, 0),
    video: buildGpuEngineVideoPreviewGraph(project, 0),
    nativeSurfaceSafe: canPresentGpuVideoOnNativeSurface(project),
  };
}

/** Keep resource/graph identity stable; sampling only chooses the native frame. */
export function sampleResidentGpuGraph<T extends GpuEnginePreviewGraph>(graph: T | undefined, playhead: number): T | undefined {
  if (!graph) return undefined;
  return { ...graph, timelineFrame: Math.max(0, Math.round(playhead * graph.graph.timebase.denominator / graph.graph.timebase.numerator)) };
}

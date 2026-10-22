import type { EditProject } from "../domain/types";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dCameraAt, mesh3dSceneSchema } from "../motion/mesh3dScene";
import { prepareCameraPrevisFrameV1, type CameraPrevisBindingV1 } from "./cameraPrevisFrameV1";
import { createCameraPrevisGpuProgramV1 } from "./cameraPrevisGpuProgramV1";

function prepare(project: EditProject, bindings: readonly CameraPrevisBindingV1[], cache: Mesh3dGeometryCache) {
  const adapter = prepareCameraPrevisFrameV1(project, bindings, cache), scene = mesh3dSceneSchema.parse(project.scene3d);
  if (scene.overlaysV1 || scene.background.grid || project.captions.length || project.motionGraphics.length
    || scene.segments.some(s => s.objects.some(o => o.material.clipId || o.material.grid || o.geometry.kind === "text"))) throw Error("PREVIS_GPU_UNSUPPORTED_LAYER_REQUIRES_CPU");
  return { adapter, scene };
}
/** Opt-in technical preview. Unsupported features refuse, never disappear. */
export function createCameraPrevisGpuViewportV1(canvas: HTMLCanvasElement, project: EditProject, bindings: readonly CameraPrevisBindingV1[],
  width = project.width, height = project.height, cache = new Mesh3dGeometryCache()) {
  let state = prepare(project, bindings, cache), disposed = false;
  const gpu = createCameraPrevisGpuProgramV1(canvas, width, height, cache);
  function live() { if (disposed) throw Error("PREVIS_GPU_DISPOSED_OR_CONTEXT_LOST"); }
  return { identity: gpu.identity, stats: gpu.stats, readPixels: gpu.readPixels, waitForCompletion: gpu.waitForCompletion,
    setInputs(next: EditProject, nextBindings: readonly CameraPrevisBindingV1[]) { live(); const prepared = prepare(next, nextBindings, cache); state = prepared; },
    cameraAt(frame: number) { live(); const camera = state.adapter.cameraAt(frame); return camera && structuredClone(camera); },
    renderFrame(frame: number) {
      live(); const camera = state.adapter.cameraAt(frame), seconds = frame / state.adapter.fps;
      const segment = state.scene.segments.find(s => seconds >= s.timelineStart && seconds < s.timelineStart + s.duration)!;
      return gpu.draw(state.scene, segment, seconds - segment.timelineStart, camera ?? mesh3dCameraAt(segment, seconds - segment.timelineStart));
    },
    dispose() { if (!disposed) { disposed = true; gpu.dispose(); } } };
}

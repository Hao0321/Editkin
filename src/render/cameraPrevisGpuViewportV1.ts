import type { EditProject } from "../domain/types";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dCameraAt, mesh3dSceneSchema } from "../motion/mesh3dScene";
import { prepareCameraPrevisFrameV1, type CameraPrevisBindingV1 } from "./cameraPrevisFrameV1";
import { assertCameraPrevisGpuDrawableV1, createCameraPrevisGpuProgramV1 } from "./cameraPrevisGpuProgramV1";

function prepare(project: EditProject, bindings: readonly CameraPrevisBindingV1[], cache: Mesh3dGeometryCache) {
  const scene = mesh3dSceneSchema.parse(project.scene3d);
  // Extended scenes (fill/hemisphere light, radial background, post), extended materials (emissive, stripes, gradient,
  // edge light, specular, reflection, wireframe), glyph kinds and the polish fields are CPU features: refuse, never draw
  // them flat (cameraPrevisGpuRefusalV1). Checked before the adapter builds any geometry, so glyph kinds are refused even
  // when their faces are not loaded.
  if (project.captions.length || project.motionGraphics.length) throw Error("PREVIS_GPU_UNSUPPORTED_LAYER_REQUIRES_CPU: captions or Motion graphics");
  assertCameraPrevisGpuDrawableV1(scene, bindings.flatMap(binding => binding.camera ? [binding.camera] : []));
  const adapter = prepareCameraPrevisFrameV1(project, bindings, cache);
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

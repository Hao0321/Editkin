import type { EditProject } from "../domain/types";
import { validateMesh3dProject } from "../domain/mesh3dValidation";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { mesh3dPoseAt, mesh3dSceneSchema, type Mesh3dCamera } from "../motion/mesh3dScene";
import { prepareCameraPrevisBoundsV1 } from "../motion/cameraPrevisBoundsV1";
import { renderMesh3dProjectFrameV1 } from "../motion/mesh3dProjectFrameV1";
import type { Mesh3dTexture } from "../motion/mesh3dRasterizer";
import { prepareSafeCameraPrevisV1 } from "../application/cameraPrevisSafetyV1";
import { cameraPrevisMotionSchemaV1, previsSubV1, type CameraPrevisMotionV1 } from "../application/cameraPrevisMotionV1";

export interface CameraPrevisBindingV1 { segmentId: string; motion: CameraPrevisMotionV1; camera?: Mesh3dCamera;
  floorY: number; radius: number; floorIds?: readonly string[]; nonblockingIds?: readonly string[]; followGroupIds?: readonly string[]; }
/** Additive opt-in adapter. Preview and encoder callers consume exactly this frame clock. */
export function prepareCameraPrevisFrameV1(project: EditProject, inputs: readonly CameraPrevisBindingV1[], cache = new Mesh3dGeometryCache()) {
  validateMesh3dProject(project);
  if (!project.scene3d?.enabled || !inputs.length || inputs.length > 16 || !Number.isFinite(project.fps) || project.fps <= 0) throw Error("PREVIS_PROJECT_INVALID");
  const scene = mesh3dSceneSchema.parse(project.scene3d), fps = project.fps;
  if (new Set(inputs.map(i => i.segmentId)).size !== inputs.length) throw Error("PREVIS_BINDING_DUPLICATE");
  const plans = new Map(inputs.map(input => {
    const segment = scene.segments.find(s => s.id === input.segmentId);
    if (!segment) throw Error("PREVIS_SEGMENT_MISSING");
    const motion = cameraPrevisMotionSchemaV1.parse(input.motion);
    const subject = motion.kind === "follow" ? segment.objects.find(o => o.id === motion.objectId) : undefined;
    const bounds = prepareCameraPrevisBoundsV1(segment, cache, { ...input, followObjectId: motion.kind === "follow" ? motion.objectId : undefined });
    const path = prepareSafeCameraPrevisV1(input.camera ?? segment.camera, motion, segment.duration, { ...input, ...bounds });
    return [segment.id, { path, subject, triangles: bounds.triangles }] as const;
  }));
  function sceneAt(timelineFrame: number) {
    if (!Number.isSafeInteger(timelineFrame) || timelineFrame < 0) throw Error("PREVIS_FRAME_INVALID");
    const seconds = timelineFrame / fps, segment = scene.segments.find(s => seconds >= s.timelineStart && seconds < s.timelineStart + s.duration);
    if (!segment) throw Error("PREVIS_FRAME_OUTSIDE");
    const plan = plans.get(segment.id);
    if (!plan) return { scene, camera: undefined };
    const local = seconds - segment.timelineStart, delta = plan.subject ? previsSubV1(mesh3dPoseAt(plan.subject, local).position, plan.subject.pose.position) : undefined;
    const camera = plan.path.sample(local, delta);
    return { camera, scene: { ...scene, segments: scene.segments.map(s => s === segment ? { ...s, camera, cameraKeyframes: [] } : s) } };
  }
  return { fps, metadata: [...plans].map(([segmentId, p]) => ({ segmentId, ...p.path.descriptor, amplitudeScale: p.path.amplitudeScale, warnings: p.path.warnings, triangles: p.triangles })),
    cameraAt: (frame: number) => structuredClone(sceneAt(frame).camera),
    renderFrame: (frame: number, width: number, height: number, textures = new Map<string, Mesh3dTexture>()) =>
      renderMesh3dProjectFrameV1(sceneAt(frame).scene, { timelineFrame: frame, fps }, width, height, cache, textures) };
}

import { z } from "zod";
import { mesh3dSegmentSchema, type Mesh3dCamera } from "../motion/mesh3dScene";
import { frameCameraPrevisSubjectV1 } from "./cameraPrevisFramingV1";
import { validatePrevisCameraV1, type PrevisBoundsV1 } from "./cameraPrevisMotionV1";

const millimeters = z.number().finite().min(1);
const lensInput = z.strictObject({
  focalLengthMm: millimeters.max(1000),
  sensorWidthMm: millimeters.max(100),
  sensorHeightMm: millimeters.max(100),
});
export type CameraPrevisLensV1 = z.infer<typeof lensInput>;

/** Rectilinear pinhole lens, centered crop inside the explicitly oriented sensor. */
export function resolveCameraPrevisLensV1(input: unknown, aspect: number) {
  const lens = lensInput.parse(input);
  if (!Number.isFinite(aspect) || aspect < .25 || aspect > 4) throw Error("PREVIS_LENS_ASPECT_INVALID");
  const widthMm = Math.min(lens.sensorWidthMm, lens.sensorHeightMm * aspect);
  const heightMm = Math.min(lens.sensorHeightMm, lens.sensorWidthMm / aspect);
  const toDegrees = (gateMm: number) => 2 * Math.atan2(gateMm, 2 * lens.focalLengthMm) * 180 / Math.PI;
  const verticalFovDegrees = toDegrees(heightMm);
  return {
    lens, aspect, activeGate: { widthMm, heightMm },
    horizontalFovDegrees: toDegrees(widthMm), verticalFovDegrees,
    compatibleWithMeshSceneV1: mesh3dSegmentSchema.shape.camera.shape.verticalFovDegrees.safeParse(verticalFovDegrees).success,
  };
}

/** Reuse the canonical camera range. Never clamp the FOV or relabel a focal length. */
export function applyCameraPrevisLensV1(cameraInput: Mesh3dCamera, lens: CameraPrevisLensV1, aspect: number): Mesh3dCamera {
  const camera = validatePrevisCameraV1(cameraInput), optical = resolveCameraPrevisLensV1(lens, aspect);
  if (!optical.compatibleWithMeshSceneV1) throw Error("PREVIS_LENS_FOV_UNSUPPORTED");
  return validatePrevisCameraV1({ ...camera, verticalFovDegrees: optical.verticalFovDegrees });
}

/** Fit all subject corners with the same physical lens, using the existing framing planner. */
export function frameCameraPrevisLensV1(bounds: PrevisBoundsV1, camera: Mesh3dCamera, lens: CameraPrevisLensV1, aspect: number,
  composition?: Parameters<typeof frameCameraPrevisSubjectV1>[3]): Mesh3dCamera {
  return frameCameraPrevisSubjectV1(bounds, applyCameraPrevisLensV1(camera, lens, aspect), aspect, composition);
}

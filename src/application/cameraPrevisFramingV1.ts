import { previsAddV1, previsCameraBasisV1, previsScaleV1, previsSubV1, validatePrevisCameraV1,
  type PrevisBoundsV1, type PrevisVectorV1 } from "./cameraPrevisMotionV1";
import type { Mesh3dCamera } from "../motion/mesh3dScene";

export function previsCornersV1(bounds: PrevisBoundsV1): PrevisVectorV1[] {
  if (bounds.min.length !== 3 || bounds.max.length !== 3 || bounds.min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(bounds.max[i]) || v > bounds.max[i])) throw Error("PREVIS_BOUNDS_INVALID");
  return Array.from({ length: 8 }, (_, i) => [0, 1, 2].map(j => (i & (1 << j)) ? bounds.max[j] : bounds.min[j]) as PrevisVectorV1);
}
/** Fits the initial subject using all 8 corners, actual aspect and perspective. */
export function frameCameraPrevisSubjectV1(bounds: PrevisBoundsV1, cameraInput: Mesh3dCamera, aspect: number,
  composition: { x: number; y: number; safe: number } = { x: 0, y: -.05, safe: .85 }): Mesh3dCamera {
  const camera = validatePrevisCameraV1(cameraInput), corners = previsCornersV1(bounds);
  if (!Number.isFinite(aspect) || aspect < .25 || aspect > 4 || ![composition.x, composition.y, composition.safe].every(Number.isFinite)
    || composition.safe < .4 || composition.safe > .95 || Math.max(Math.abs(composition.x), Math.abs(composition.y)) > composition.safe - .1) throw Error("PREVIS_FRAMING_INVALID");
  const { forward, right, up } = previsCameraBasisV1(camera), center = previsScaleV1(previsAddV1(bounds.min, bounds.max), .5);
  const tanV = Math.tan(camera.verticalFovDegrees * Math.PI / 360), tanH = tanV * aspect;
  const dot = (a: PrevisVectorV1, b: PrevisVectorV1) => a.reduce((s, v, i) => s + v * b[i], 0);
  let distance = .1;
  for (const corner of corners) {
    const p = previsSubV1(corner, center), z = dot(p, forward);
    distance = Math.max(distance, camera.near * 1.01 - z);
    for (const [axis, tan, bias] of [[right, tanH, composition.x], [up, tanV, composition.y]] as const) {
      const x = dot(p, axis) / tan;
      distance = Math.max(distance, (x - composition.safe * z) / (composition.safe - bias), (-x - composition.safe * z) / (composition.safe + bias));
    }
  }
  distance *= 1.001;
  if (corners.some(p => distance + dot(previsSubV1(p, center), forward) >= camera.far)) throw Error("PREVIS_FRAMING_FAR_CLIP");
  const offset = previsAddV1(previsScaleV1(right, -composition.x * distance * tanH), previsScaleV1(up, -composition.y * distance * tanV));
  const target = previsAddV1(center, offset);
  return validatePrevisCameraV1({ ...camera, position: previsSubV1(target, previsScaleV1(forward, distance)), target });
}

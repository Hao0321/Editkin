/**
 * Rotation helpers matching the mesh3d engine's poses (three.js Euler order "XYZ": R = Rx · Ry · Rz, degrees), so a
 * component can build an object in a group's frame (a card on a tilted screen, a rule on a turning band) and hand the
 * engine one world pose. Browser-safe.
 */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
export type Vec3 = readonly [number, number, number];

const rad = (degrees: number) => (degrees * Math.PI) / 180;

export function rotX(degrees: number): Mat3 { const c = Math.cos(rad(degrees)), s = Math.sin(rad(degrees)); return [1, 0, 0, 0, c, -s, 0, s, c]; }
export function rotY(degrees: number): Mat3 { const c = Math.cos(rad(degrees)), s = Math.sin(rad(degrees)); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
export function rotZ(degrees: number): Mat3 { const c = Math.cos(rad(degrees)), s = Math.sin(rad(degrees)); return [c, -s, 0, s, c, 0, 0, 0, 1]; }

export function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out as unknown as Mat3;
}

export function apply(m: Mat3, v: Vec3): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** The engine pose rotation (XYZ Euler degrees) as a matrix. */
export function eulerMatrix(degrees: Vec3): Mat3 {
  return mul(mul(rotX(degrees[0]), rotY(degrees[1])), rotZ(degrees[2]));
}

/** XYZ Euler degrees of a rotation matrix (three.js setFromRotationMatrix, order XYZ). */
export function matrixEuler(m: Mat3): [number, number, number] {
  const m13 = Math.max(-1, Math.min(1, m[2]));
  const y = Math.asin(m13);
  let x: number, z: number;
  if (Math.abs(m13) < 0.9999999) { x = Math.atan2(-m[5], m[8]); z = Math.atan2(-m[1], m[0]); } else { x = Math.atan2(m[7], m[4]); z = 0; }
  const deg = (value: number) => Math.round(((value * 180) / Math.PI) * 1e6) / 1e6;
  return [deg(x), deg(y), deg(z)];
}

/** A frame (rotation + origin) that children are placed in. */
export interface GroupV1 { readonly rotation: Mat3; readonly origin: Vec3 }

export function group(rotationDegrees: Vec3, origin: Vec3): GroupV1 {
  return { rotation: eulerMatrix(rotationDegrees), origin };
}

/** World position and XYZ Euler of a child at `local` with local rotation `localDegrees`. */
export function placeIn(groupFrame: GroupV1, local: Vec3, localDegrees: Vec3 = [0, 0, 0]): { position: [number, number, number]; rotationDegrees: [number, number, number] } {
  const p = apply(groupFrame.rotation, local);
  return { position: [p[0] + groupFrame.origin[0], p[1] + groupFrame.origin[1], p[2] + groupFrame.origin[2]],
    rotationDegrees: matrixEuler(mul(groupFrame.rotation, eulerMatrix(localDegrees))) };
}

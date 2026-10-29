import { mixHex } from "../../svg/color";
import { g, path, polygonPathD, type Point2 } from "../../svg/document";
import { backInOut, cubicInOut, energyProfile, loopPhase, sineInOut, smoothstep } from "../../svg/easing";
import { layoutLine, type GlyphBox } from "../../svg/glyphs";
import { depthSort, project, rotateX, rotateY, signedArea, vec3, type Camera3D, type Vec3 } from "../../svg/project3d";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, displayTracking, readableColor, textFace, titleSafeBox } from "../shared";
import { mapPathD } from "./T18_textCorridor";

/**
 * T23 Text Cube (キューブ), DEPTH: a cube with one word (or kanji) per face rolls about its
 * horizontal X axis in 90° steps: each step is a TURN s ease-in-out roll followed by a hold,
 * 0.6 s per step, so four faces cycle in the 2.4 s loop (catalog loopSeconds) and the next
 * face rolls up from below. A fixed yaw shows the cube's right side face, and a gentle
 * perspective camera (svg/project3d) gives the slight depth the reference has. The rolling
 * faces are accent squares with ink glyphs (ART_DIRECTION §0: ink on the accent card),
 * shaded by a fixed light from the upper left toward the deep shade as they turn away; the
 * side faces are dark (the deep shade toward ink). Glyph outlines are mapped onto their face
 * point by point through the same projection, so they foreshorten with it. Faces are
 * back-face culled and painter-sorted.
 *
 * Lines map to faces in order and cycle when there are fewer than four. The cube is sized
 * so its widest silhouette during a roll stays inside the 5% title-safe box; the held front
 * face is the reading face, its glyph about 70% of the face. Energy shapes the roll (sine at
 * calm, cubic, back-overshoot at punchy and hype) and its length, never the step period.
 */

const ID = "T23";
const REVISION = 1;
export const T23_LOOP_SECONDS = 2.4;
export const T23_STEP_SECONDS = 0.6;
/** Roll duration at standard energy (s); the rest of each step is the hold. */
const TURN = 0.25;
/** Fixed yaw (degrees, negative turns the front face left and shows the right side), camera distance (× cube side). */
const YAW = -24, CAMERA_DISTANCE = 3.4;
/** Share of the safe box the rolling silhouette may fill, and the glyph ink size on a face (× the side). */
const FIT = 0.96, GLYPH_FILL = 0.7;
/** Light direction (toward the light, normalised below) and the shading range. */
const LIGHT = { x: -0.45, y: -0.55, z: 0.7 };
/** A face's glyph fades into the face between these facing cosines (grazing → square on). */
const GLYPH_FADE: readonly [number, number] = [0.12, 0.42];

interface FaceSpec {
  /** Face corners and the face's own glyph frame (origin at the face centre, right and down axes), cube-local. */
  readonly corners: readonly Vec3[];
  readonly origin: Vec3;
  readonly right: Vec3;
  readonly down: Vec3;
  readonly normal: Vec3;
  /** Ring face index 0..3 (carries a word), or −1 for a side face. */
  readonly ring: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);

/** The six faces of a unit cube (side 1): ring face k is the front face rolled back by k × 90° about X. */
function cubeFaces(): FaceSpec[] {
  const h = 0.5;
  const front: FaceSpec = {
    corners: [vec3(-h, -h, h), vec3(h, -h, h), vec3(h, h, h), vec3(-h, h, h)],
    origin: vec3(0, 0, h), right: vec3(1, 0, 0), down: vec3(0, 1, 0), normal: vec3(0, 0, 1), ring: 0,
  };
  const roll = (face: FaceSpec, degrees: number, ring: number): FaceSpec => ({
    corners: face.corners.map(corner => rotateX(corner, degrees)), origin: rotateX(face.origin, degrees),
    right: rotateX(face.right, degrees), down: rotateX(face.down, degrees), normal: rotateX(face.normal, degrees), ring,
  });
  const faces = [0, 1, 2, 3].map(k => roll(front, -90 * k, k));
  const side = (sign: 1 | -1): FaceSpec => ({
    corners: sign > 0 ? [vec3(h, -h, h), vec3(h, -h, -h), vec3(h, h, -h), vec3(h, h, h)] : [vec3(-h, -h, -h), vec3(-h, -h, h), vec3(-h, h, h), vec3(-h, h, -h)],
    origin: vec3(sign * h, 0, 0), right: vec3(0, 0, -sign), down: vec3(0, 1, 0), normal: vec3(sign, 0, 0), ring: -1,
  });
  return [...faces, side(1), side(-1)];
}
const FACES = cubeFaces();

export interface CubeLayout {
  readonly camera: Camera3D;
  /** World units per cube side are 1; `focal` is fitted so the rolling silhouette fits the safe box. */
  readonly words: ReadonlyArray<{ readonly pathD: string; readonly box: GlyphBox; readonly scale: number }>;
  readonly turnSeconds: number;
  readonly ease: (p: number) => number;
  readonly colors: { readonly lit: string; readonly shade: string; readonly side: string; readonly glyph: string };
}

/** Cube-local point → camera space at roll angle (degrees). */
function placed(point: Vec3, roll: number): Vec3 {
  const p = rotateY(rotateX(point, roll), YAW);
  return vec3(p.x, p.y, p.z - CAMERA_DISTANCE);
}

export function cubeLayout(params: TextMotionParams, size: MotionFrameSize): CubeLayout {
  const safe = titleSafeBox(size);
  // Fit: the widest projected silhouette over a whole roll (by symmetry one step covers all) inside the safe box.
  // The yaw makes the silhouette asymmetric: centre the union of every roll's silhouette in the frame.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let roll = 0; roll <= 90; roll += 3) {
    for (const face of FACES) for (const corner of face.corners) {
      const p = project(placed(corner, roll), { focal: 1, cx: 0, cy: 0 });
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const focal = FIT * Math.min(safe.width / (maxX - minX), safe.height / (maxY - minY));
  const face = textFace(params.font, 900);
  const words = params.lines.map(text => {
    const line = layoutLine(text.trim(), { ...face, size: 100, tracking: displayTracking([text]) });
    const box = line.inkBox ?? { x0: 0, y0: -88, x1: 100, y1: 0 };
    // Ink fitted to GLYPH_FILL of the face (the longer side), in face units (side = 1).
    const scale = GLYPH_FILL / Math.max(box.x1 - box.x0, box.y1 - box.y0);
    return { pathD: line.pathD, box, scale };
  });
  const energy = energyProfile(params.energy);
  const palette = params.palette;
  return {
    camera: { focal, cx: size.width / 2 - ((minX + maxX) / 2) * focal, cy: size.height / 2 - ((minY + maxY) / 2) * focal, near: 0.1 },
    words, turnSeconds: Math.min(0.4, TURN * energy.time),
    ease: energy.tier === 0 ? sineInOut : energy.tier === 1 ? cubicInOut : (p: number) => backInOut(p, 1.2),
    colors: { lit: palette.accent, shade: palette.accent2, side: mixHex(palette.accent2, palette.ink, 0.35),
      glyph: readableColor(palette.accent, [palette.ink, palette.paper]) },
  };
}

/** Roll angle (degrees) at time t: four 90° steps per loop. */
export function cubeRoll(layout: CubeLayout, t: number): number {
  const u = loopPhase(t, T23_LOOP_SECONDS) * T23_LOOP_SECONDS;
  const step = Math.floor(u / T23_STEP_SECONDS + 1e-9), local = u - step * T23_STEP_SECONDS;
  // The hold boundary (0.6 − 0.25 s) is not exact in binary: a nanosecond tolerance keeps the full hold at rest.
  const hold = T23_STEP_SECONDS - layout.turnSeconds;
  const p = local <= hold + 1e-9 ? 0 : layout.ease((local - hold) / layout.turnSeconds);
  return 90 * (step + p);
}

export const T23_textCube = defineTextMotion(ID, (params, t, size) => {
  const layout = cubeLayout(params, size);
  const doc = createTextDocument(size, params);
  const roll = cubeRoll(layout, t);
  const light = (() => { const l = Math.hypot(LIGHT.x, LIGHT.y, LIGHT.z); return vec3(LIGHT.x / l, LIGHT.y / l, LIGHT.z / l); })();
  const drawn: Array<{ depth: number; markup: string }> = [];
  for (const face of FACES) {
    const corners = face.corners.map(corner => placed(corner, roll));
    const projected = corners.map(corner => project(corner, layout.camera));
    const points = projected.map(p => [p.x, p.y] as Point2);
    // Back-face cull: screen winding of a face seen from outside is clockwise (y-down) for these corner orders.
    if (signedArea(points) <= 0) continue;
    const normal = rotateY(rotateX(face.normal, roll), YAW);
    const lambert = Math.max(0, normal.x * light.x + normal.y * light.y + normal.z * light.z);
    const fill = face.ring < 0 ? layout.colors.side : mixHex(layout.colors.shade, layout.colors.lit, Math.min(1, 0.25 + 0.95 * lambert));
    let markup = path(polygonPathD(points, 1), { fill, "stroke-linejoin": "round" });
    // How squarely the face looks at the camera (cosine to the view ray through its centre): a glyph on a face near
    // grazing would squash into a dark sliver along the edge, so it fades into its face there.
    const centre = placed(face.origin, roll), distance = Math.hypot(centre.x, centre.y, centre.z);
    const facing = -(normal.x * centre.x + normal.y * centre.y + normal.z * centre.z) / distance;
    const ink = smoothstep(GLYPH_FADE[0], GLYPH_FADE[1], facing);
    if (face.ring >= 0 && ink > 0.01) {
      const word = layout.words[face.ring % layout.words.length];
      const cx = (word.box.x0 + word.box.x1) / 2, cy = (word.box.y0 + word.box.y1) / 2;
      const d = mapPathD(word.pathD, (x, y) => {
        const local = add(add(face.origin, mul(face.right, (x - cx) * word.scale)), mul(face.down, (y - cy) * word.scale));
        const p = project(placed(local, roll), layout.camera);
        return [p.x, p.y];
      });
      markup += path(d, { fill: ink >= 0.99 ? layout.colors.glyph : mixHex(fill, layout.colors.glyph, ink) });
    }
    drawn.push({ depth: corners.reduce((sum, corner) => sum - corner.z, 0) / corners.length, markup });
  }
  return doc.render(g(undefined, depthSort(drawn, item => item.depth).map(item => item.markup)));
}, { revision: REVISION });

import { mesh3dBounceKeyframesV1, mesh3dOrbitKeyframesV1 } from "../../motion/mesh3dAnimation";
import type { Mesh3dCamera, Mesh3dObject, Mesh3dScene } from "../../motion/mesh3dScene";
import { fmt, g, path, rect } from "../../motionLibrary/svg/document";
import { backOut, clamp01, curve, expoInOut, expoOut, lerp, smootherstep } from "../../motionLibrary/svg/easing";
import { assertMotionText, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import type { StyleCompositeFrameV1, StyleCompositeHooksV1, StyleCompositeLayersV1, StyleCompositePassV1 } from "./compositeComponent";
import {
  bloom, createRaster, darken, gaussianBlur, grain, hexRgb, mixRgb, over, rgbHex, rgbaFromPlanes, vignette, type RasterV1, type Rgb,
} from "./raster";
import { group, placeIn } from "./euler";
import { fitLine, inkWidth, labelFace, placeLine, placedGlyphs, poseAbout, svgFrame } from "./templateType";

/**
 * mesh3dKineticLyric (S7 kinetic_lyric_3d, from R7; Claude's style frames S7_A / S7_B / S7_reskin): a one-hue kinetic
 * lyric clip built on Editkin's mesh3d engine. Every word lands on the beat and the camera never stops.
 *
 * Act A (the whole clip when no lock-up text is given):
 *   a giant extruded hero word (text_extrude; depth 14% of the size for CJK, 30% for Latin) that flies in and lands on the
 *   first beat · a thin orbit ring (torus) · a paper ribbon carrying a phrase (band_text, part mesh3dLyricBand) turning
 *   under the word · a fisheye ring tunnel rushing toward the camera (gridded tube, engine fisheye) · a small tracked
 *   label with a hand-lettered line. The camera orbits the word (mesh3dOrbitKeyframesV1 path) and punches on each beat.
 * Act B (after a whip pan, when `display` is given): a blush grid floor with soft key-light shadows, primitives (spheres, a
 *   striped torus, cones, a cylinder, cubes) dropping onto it with mesh3dBounceKeyframesV1 on the beats, and a title
 *   lock-up — kicker, condensed display word, marker script word — inside a thin circle frame with corner brackets.
 *
 * Text slots become extruded and banded meshes and SVG glyph outlines (bundled faces only); colour roles become material,
 * light and emissive colours. The script role has no licence-clear Latin script face, so the hand role (LXGW WenKai TC)
 * is thickened into a slanted marker stroke, as in the style frames.
 */

export const KINETIC_LYRIC_REVISION = 1;
export const LYRIC_BAND_REVISION = 1;

export interface KineticLyricParams {
  readonly component: "mesh3dKineticLyric";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly palette: { readonly paper: string; readonly ink: string; readonly bg: string; readonly accent: string };
  readonly text: { readonly word: string; readonly band?: string; readonly label?: string; readonly labelSub?: string; readonly display?: string; readonly script?: string; readonly kicker?: string };
  /** Seconds per beat (the camera punches and words land on beats). */
  readonly beat: number;
  /** Act B starts after the whip (null: act A for the whole clip). */
  readonly whip: { readonly at: number; readonly duration: number } | null;
  /** Hero word: world size (em), extrusion depth, bevel. */
  readonly hero: { readonly size: number; readonly depth: number; readonly bevel: number; readonly bevelSegments: number; readonly latin: boolean };
}

type V3 = [number, number, number];
const pose = (position: V3, rotationDegrees: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const hex = (c: Rgb) => rgbHex(c);
const CJK = /[⺀-鿿豈-﫿　-〿＀-￯]/u;

// ---------------------------------------------------------------------------
// Camera maths (three.js lookAt, right-handed, y up) for placing 2D light on 3D objects
// ---------------------------------------------------------------------------

function project(camera: Mesh3dCamera, width: number, height: number, point: V3): { x: number; y: number; distance: number } {
  const [cx, cy, cz] = camera.position, [tx, ty, tz] = camera.target;
  let fx = tx - cx, fy = ty - cy, fz = tz - cz; const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = fy * 0 - fz * 1, ry = fz * 0 - fx * 0, rz = fx * 1 - fy * 0; const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const roll = ((camera.roll ?? 0) * Math.PI) / 180;
  if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const nrx = rx * c + ux * s, nry = ry * c + uy * s, nrz = rz * c + uz * s; ux = -rx * s + ux * c; uy = -ry * s + uy * c; uz = -rz * s + uz * c; rx = nrx; ry = nry; rz = nrz; }
  const dx = point[0] - cx, dy = point[1] - cy, dz = point[2] - cz;
  const xc = dx * rx + dy * ry + dz * rz, yc = dx * ux + dy * uy + dz * uz, zc = dx * fx + dy * fy + dz * fz;
  const focal = height / 2 / Math.tan((camera.verticalFovDegrees * Math.PI) / 360);
  return { x: width / 2 + (focal * xc) / zc, y: height / 2 - (focal * yc) / zc, distance: zc };
}

/** Engine NDC depth of an eye distance (perspective, the camera's near/far). */
function ndcDepth(camera: Mesh3dCamera, distance: number): number {
  const { near, far } = camera;
  return (far + near) / (far - near) - (2 * far * near) / ((far - near) * distance);
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export function kineticLyricParams(input: {
  width: number; height: number; duration: number; palette: KineticLyricParams["palette"]; text: KineticLyricParams["text"];
}): KineticLyricParams {
  const { width, height, duration, text } = input;
  const latin = !CJK.test(text.word);
  // The hero word fills ~84% of the frame width (portrait) or ~62% of its height (landscape) at its resting turn.
  const portrait = height >= width;
  const face: MotionFontSelector = { font: "display", weight: 900 };
  const inkW = inkWidth(text.word, face, 100, latin ? -0.02 : 0) / 100, line = placeLine(text.word, face, 100, latin ? -0.02 : 0, 0, 0);
  const inkH = (line.box.y1 - line.box.y0) / 100;
  const view = portrait ? { h: 2 * 8.6 * Math.tan((40 * Math.PI) / 360), w: 0 } : { h: 2 * 7.4 * Math.tan((34 * Math.PI) / 360), w: 0 };
  const visibleW = view.h * (width / height);
  const size = Math.min((visibleW * (portrait ? 0.86 : 0.56)) / Math.max(inkW * 0.93, 1e-3), (view.h * (portrait ? 0.48 : 0.62)) / Math.max(inkH, 1e-3), latin ? 2.6 : 3.2);
  const lockup = Boolean(text.display);
  const beat = 0.5;
  // Act B needs ≥ 1.6 s to land and hold: the whip sits at ~55% of the clip, on a beat.
  const whipAt = lockup && duration >= 3 ? Math.max(1.5, Math.round((duration * 0.55) / beat) * beat - 0.12) : null;
  const glyphs = [...text.word].length;
  return {
    component: "mesh3dKineticLyric", revision: KINETIC_LYRIC_REVISION, width, height, duration, palette: input.palette, text, beat,
    whip: whipAt === null ? null : { at: Math.round(whipAt * 1000) / 1000, duration: 0.3 },
    hero: { size: Math.round(size * 1e4) / 1e4, depth: Math.round(size * (latin ? 0.3 : 0.14) * 1e4) / 1e4, bevel: Math.round(size * 0.012 * 1e4) / 1e4,
      bevelSegments: glyphs <= 2 ? 3 : 2, latin },
  };
}

// ---------------------------------------------------------------------------
// Act A
// ---------------------------------------------------------------------------

function actADuration(p: KineticLyricParams): number { return p.whip ? p.whip.at + p.whip.duration : p.duration; }

/** Beat punch: 0 → 1 → 0 within ~0.32 s after each beat (fast attack, smooth settle). */
function beatPunch(t: number, beat: number, from: number): number {
  if (t < from) return 0;
  const local = (t - from) % beat;
  return local < 0.06 ? expoOut(local / 0.06) : 1 - smootherstep(0.06, 0.34, local);
}

/** Linear interpolation of an engine pose track (pose + keyframes) at `time`: the path the engine itself would follow. */
function trackPosition(track: { pose: { position: number[] }; keyframes: ReadonlyArray<{ time: number; pose: { position: number[] } }> }, time: number): V3 {
  let previous = track.pose.position, previousTime = 0;
  for (const key of track.keyframes) {
    if (time < key.time) {
      const u = clamp01((time - previousTime) / Math.max(1e-9, key.time - previousTime));
      return [lerp(previous[0], key.pose.position[0], u), lerp(previous[1], key.pose.position[1], u), lerp(previous[2], key.pose.position[2], u)];
    }
    previous = key.pose.position; previousTime = key.time;
  }
  return [previous[0], previous[1], previous[2]];
}

function cameraA(p: KineticLyricParams, t: number): Mesh3dCamera {
  const portrait = p.height >= p.width, dist = portrait ? 8.6 : 7.4, fov = portrait ? 40 : 34;
  const target: V3 = [0.05, 0.12, 0];
  const end = Math.max(0.5, actADuration(p));
  // A slow orbit around the word: the engine's orbit helper lays the arc out as keyframes (16 samples, sub-millimetre
  // chord error); the camera travels it on an eased clock, pulls in from a wider start and punches on every beat.
  const orbit = mesh3dOrbitKeyframesV1({ center: target, radius: dist, axis: "y", startDegrees: 11, endDegrees: -8, startTime: 0, endTime: end, keyframes: 16 });
  const along = trackPosition(orbit, end * (0.4 * clamp01(t / end) + 0.6 * curve("quintOut", clamp01(t / end))));
  const intro = expoOut(clamp01(t / 0.9)), punch = beatPunch(t, p.beat, 0.45);
  const k = (1.3 - 0.3 * intro) * (1 - 0.04 * punch);
  const beatIndex = Math.floor(Math.max(0, t - 0.45) / p.beat);
  const roll = (beatIndex % 2 ? 1 : -1) * 1.6 * punch - 5 * (1 - intro);
  return { position: [target[0] + (along[0] - target[0]) * k, 0.55 + 0.35 * (1 - intro), target[2] + (along[2] - target[2]) * k], target, verticalFovDegrees: fov, near: 0.1, far: 120, roll };
}

function tunnelScene(p: KineticLyricParams, t: number, camera: Mesh3dCamera): Mesh3dScene {
  const bg = hexRgb(p.palette.bg), accent = hexRgb(p.palette.accent);
  // Rings rush toward the camera: the tube slides one cell (60 / 14 units) per loop.
  const cell = 60 / 14, travel = (t * 6.5) % cell;
  return {
    schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: hex(bg), gridColor: hex(bg), spacing: 72, grid: false },
    light: { direction: [0, 0, 1], ambient: 1, intensity: 0 },
    segments: [{ id: "tunnel", name: "tunnel", timelineStart: 0, duration: Math.max(1, p.duration + 1), camera, cameraKeyframes: [], objects: [
      { id: "tube", name: "ring tunnel", geometry: { kind: "cylinder", radiusTop: 6.5, radiusBottom: 6.5, height: 20, segments: 96, openEnded: true },
        pose: pose([0.35, 0.3, -20 + travel], [90, 0, 0], [1, 3, 1]), keyframes: [],
        material: { color: hex(bg), unlit: true, doubleSided: true, grid: true,
          gridStyle: { cells: [16, 14], lineWidthPx: 2.2, color: hex(mixRgb(bg, accent, 0.9)), fade: { start: 8, end: 62 } } } },
    ] }],
    post: { fisheye: { strength: 0.3 } },
  };
}

function heroScene(p: KineticLyricParams, t: number, camera: Mesh3dCamera): Mesh3dScene {
  const paper = hexRgb(p.palette.paper), ink = hexRgb(p.palette.ink), accent = hexRgb(p.palette.accent);
  const portrait = p.height >= p.width, gx = portrait ? 0 : -0.15;
  const hero = p.hero;
  // Fly-in: from far behind and turned away, landing on the first beat (0.45 s) with a small overshoot, then a slow drift.
  const land = clamp01(t / 0.45), e = backOut(land, 1.15);
  const z = lerp(-9, 0, expoOut(land)), yaw = lerp(-72, -24, e) + 6 * Math.sin(t * 0.9) * smootherstep(0.45, 1.2, t);
  const pitch = lerp(22, 9, e), roll = lerp(-14, -5, e);
  const breath = 1 + 0.025 * beatPunch(t, p.beat, 0.95);
  const objects: Mesh3dObject[] = [{
    id: "hero", name: "hero word",
    geometry: { kind: "text_extrude", text: p.text.word, font: "display", weight: 900, size: hero.size, depth: hero.depth, bevelSize: hero.bevel,
      bevelThickness: Math.min(hero.bevel * 1.4, hero.depth * 0.45), bevelSegments: hero.bevelSegments, bevelProfile: "round", tracking: hero.latin ? -0.02 : 0 },
    pose: pose([gx, 0.25, z], [pitch, yaw, roll], [breath, breath, breath]), keyframes: [],
    // Saturated accent face (gradient along the extrusion: the walls darken toward the ink), glossy key, paper rim.
    material: { color: p.palette.accent, unlit: false, gradient: { colors: [hex(mixRgb(ink, accent, 0.42)), hex(mixRgb(accent, paper, 0.08))], axis: "z" },
      specular: { strength: 1.25, shininess: 90 }, roughness: 0.24, edgeLight: { color: hex(mixRgb(paper, accent, 0.25)), strength: 0.3, power: 3.4 },
      reflection: { strength: 0.2, sky: hex(mixRgb(paper, accent, 0.35)), horizon: "#FFFFFF", ground: hex(mixRgb(ink, accent, 0.4)) } },
  }];
  // Orbit ring: grows in after the landing, then keeps turning.
  const ringIn = expoOut(clamp01((t - 0.2) / 0.55));
  if (ringIn > 0.01) objects.push({ id: "ring", name: "orbit ring", geometry: { kind: "torus", radius: 4.6, tube: 0.012, segments: 64, tubeSegments: 6 },
    pose: pose([gx, 0.15, 0], [74, 6 + t * 9, -16 + 2 * Math.sin(t * 1.3)], [0.5 * ringIn, 0.5 * ringIn, 0.5 * ringIn]), keyframes: [],
    material: { color: hex(mixRgb(paper, [1, 1, 1], 0.5)), unlit: true, emissive: { color: p.palette.paper, strength: 0.6 } } });
  // The band (part mesh3dLyricBand): a paper ribbon carrying the phrase between two ink rules, rising in and turning.
  if (p.text.band) {
    const bandIn = expoOut(clamp01((t - 0.3) / 0.6));
    const frame = group([8, 32 + t * 26, -6], [gx, lerp(-2.6, -0.93, bandIn), 0]);
    const at = (local: V3, rotation: V3 = [0, 0, 0]) => { const placed = placeIn(frame, local, rotation); return pose(placed.position, placed.rotationDegrees); };
    objects.push(
      { id: "ribbon", name: "band ribbon", geometry: { kind: "cylinder", radiusTop: 1.85, radiusBottom: 1.85, height: 0.42, segments: 96, openEnded: true },
        pose: at([0, 0, 0]), keyframes: [], material: { color: hex(mixRgb(paper, ink, 0.04)), unlit: false, doubleSided: true, specular: { strength: 0.18, shininess: 24 } } },
      { id: "bandText", name: "band text", geometry: { kind: "band_text", text: bandPhrase(p.text.band), font: "serif", weight: 900, form: "cylinder", facing: "outside",
        radius: 1.856, height: 0.3, segments: 128, repeat: bandRepeat(bandPhrase(p.text.band)), tracking: 0.04 },
        pose: at([0, -0.005, 0]), keyframes: [], material: { color: p.palette.ink, unlit: false } },
      ...[0.192, -0.192].map((dy, index) => ({ id: index ? "ruleBottom" : "ruleTop", name: "band rule",
        geometry: { kind: "torus" as const, radius: 1.857, tube: 0.011, segments: 64, tubeSegments: 4 }, pose: at([0, dy, 0], [90, 0, 0]), keyframes: [],
        material: { color: p.palette.ink, unlit: true } })),
    );
  }
  return {
    schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: p.palette.bg, gridColor: p.palette.bg, spacing: 72, grid: false },
    light: { direction: [-0.5, 0.55, 0.85], ambient: 0.22, intensity: 0.8, size: 12, distance: 9,
      fill: { direction: [0.95, 0.15, -0.35], intensity: 0.4, color: p.palette.accent },
      hemisphere: { sky: p.palette.paper, ground: p.palette.ink, intensity: 0.16 } },
    segments: [{ id: "hero", name: "hero", timelineStart: 0, duration: Math.max(1, p.duration + 1), camera, cameraKeyframes: [], objects }],
    post: { ao: { strength: 0.45, radius: 0.22 } },
  };
}

/**
 * The phrase as it repeats around the ribbon. The engine centres each repeat in its share of the ring (and trims the
 * text), so the seam is a gap; a phrase that does not end in a separator gets " ·" so the repeats read as a list.
 */
function bandPhrase(text: string): string {
  const phrase = text.trim();
  return /[·•|/\-–—・]$/u.test(phrase) ? phrase : `${phrase} ·`;
}

function bandRepeat(text: string): number {
  // One repeat per ~9 glyph widths around the ring, at least 2, at most 6.
  return Math.max(2, Math.min(6, Math.round(30 / Math.max(4, [...text].length + 2))));
}

// ---------------------------------------------------------------------------
// Act B
// ---------------------------------------------------------------------------

interface Primitive {
  id: string; geometry: Mesh3dObject["geometry"]; tone: "accent" | "ink" | "stripe";
  /** Screen anchor (output px at the reference camera): a floor contact point, or an airborne centre at `distance`. */
  screen: [number, number]; distance?: number;
  /** World size from screen px at that depth: radius (or edge) in px. */
  px: number; air?: boolean; spin?: V3; rest?: V3; delay: number;
}

/** The R7 set, placed by screen position like the style frame (S7_B), for portrait and landscape. */
function primitives(p: KineticLyricParams): Primitive[] {
  const portrait = p.height >= p.width, s = Math.min(p.width, p.height) / 1080;
  const P = (x: number, y: number): [number, number] => [x * s, y * s];
  if (portrait) return [
    { id: "sphA", geometry: { kind: "sphere", radius: 1, segments: 64 }, tone: "accent", screen: P(262, 1408), px: 150 * s, delay: 0 },
    { id: "cone", geometry: { kind: "cone", radius: 1, height: 2.5, segments: 64 }, tone: "ink", screen: P(452, 1238), px: 52 * s, delay: 0.1, spin: [0, 140, 0] },
    { id: "cyl", geometry: { kind: "cylinder", radiusTop: 1, radiusBottom: 1, height: 2.7, segments: 64, openEnded: false }, tone: "accent", screen: P(700, 1402), px: 56 * s, delay: 0.18 },
    { id: "cubeB", geometry: { kind: "rounded_box", width: 2, height: 2, depth: 2, radius: 0.07, segments: 2 }, tone: "ink", screen: P(905, 1300), px: 59 * s, delay: 0.26, rest: [0, 32, 0], spin: [0, 90, 0] },
    { id: "sphD", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "ink", screen: P(800, 1462), px: 36 * s, delay: 0.34 },
    { id: "tor", geometry: { kind: "torus", radius: 1, tube: 0.32, segments: 64, tubeSegments: 20 }, tone: "stripe", screen: P(884, 238), distance: 8.6, px: 88 * s, air: true, rest: [62, 14, 28], spin: [34, 18, 12], delay: 0.04 },
    { id: "cubeA", geometry: { kind: "rounded_box", width: 2, height: 2, depth: 2, radius: 0.07, segments: 2 }, tone: "accent", screen: P(168, 262), distance: 9, px: 56 * s, air: true, rest: [28, 38, 14], spin: [60, 70, 24], delay: 0.1 },
    { id: "sphB", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "ink", screen: P(640, 232), distance: 9, px: 34 * s, air: true, delay: 0.16 },
    { id: "sphC", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "accent", screen: P(104, 846), distance: 8, px: 38 * s, air: true, delay: 0.22 },
    { id: "sphE", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "accent", screen: P(990, 1012), distance: 7.6, px: 26 * s, air: true, delay: 0.28 },
  ];
  const L = (x: number, y: number): [number, number] => [x * (p.width / 1920), y * (p.height / 1080)];
  return [
    { id: "sphA", geometry: { kind: "sphere", radius: 1, segments: 64 }, tone: "accent", screen: L(360, 960), px: 130 * s, delay: 0 },
    { id: "cone", geometry: { kind: "cone", radius: 1, height: 2.5, segments: 64 }, tone: "ink", screen: L(610, 870), px: 46 * s, delay: 0.1, spin: [0, 140, 0] },
    { id: "cyl", geometry: { kind: "cylinder", radiusTop: 1, radiusBottom: 1, height: 2.7, segments: 64, openEnded: false }, tone: "accent", screen: L(1330, 975), px: 50 * s, delay: 0.18 },
    { id: "cubeB", geometry: { kind: "rounded_box", width: 2, height: 2, depth: 2, radius: 0.07, segments: 2 }, tone: "ink", screen: L(1560, 880), px: 54 * s, delay: 0.26, rest: [0, 32, 0], spin: [0, 90, 0] },
    { id: "sphD", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "ink", screen: L(1450, 1010), px: 32 * s, delay: 0.34 },
    { id: "tor", geometry: { kind: "torus", radius: 1, tube: 0.32, segments: 64, tubeSegments: 20 }, tone: "stripe", screen: L(1640, 170), distance: 8.2, px: 80 * s, air: true, rest: [62, 14, 28], spin: [34, 18, 12], delay: 0.04 },
    { id: "cubeA", geometry: { kind: "rounded_box", width: 2, height: 2, depth: 2, radius: 0.07, segments: 2 }, tone: "accent", screen: L(290, 200), distance: 8.6, px: 52 * s, air: true, rest: [28, 38, 14], spin: [60, 70, 24], delay: 0.1 },
    { id: "sphB", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "ink", screen: L(1180, 120), distance: 8.6, px: 30 * s, air: true, delay: 0.16 },
    { id: "sphC", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "accent", screen: L(200, 560), distance: 7.8, px: 34 * s, air: true, delay: 0.22 },
    { id: "sphE", geometry: { kind: "sphere", radius: 1, segments: 40 }, tone: "accent", screen: L(1760, 560), distance: 7.4, px: 24 * s, air: true, delay: 0.28 },
  ];
}

/** Reference camera of act B (where the set is laid out); the live camera settles onto it and drifts. */
function referenceCameraB(p: KineticLyricParams): Mesh3dCamera {
  const portrait = p.height >= p.width;
  return { position: [0, 2.3, portrait ? 9.8 : 8.6], target: [0, 1.0, 0], verticalFovDegrees: portrait ? 38 : 33, near: 0.1, far: 80 };
}

function cameraB(p: KineticLyricParams, local: number): Mesh3dCamera {
  const ref = referenceCameraB(p);
  const settle = expoOut(clamp01(local / 0.8)), drift = smootherstep(0, Math.max(1, p.duration), local);
  const dist = ref.position[2] * (1.07 - 0.07 * settle - 0.025 * drift);
  const angle = ((-5 + 8 * drift) * Math.PI) / 180;
  return { ...ref, position: [Math.sin(angle) * dist, ref.position[1] + 0.25 * (1 - settle), Math.cos(angle) * dist], roll: (1 - settle) * 3 };
}

/** World point under a screen pixel: on the floor (y = 0), or at an eye distance. */
function unproject(camera: Mesh3dCamera, width: number, height: number, sx: number, sy: number, distance?: number): { point: V3; distance: number; focal: number } {
  const [cx, cy, cz] = camera.position, [tx, ty, tz] = camera.target;
  let fx = tx - cx, fy = ty - cy, fz = tz - cz; const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const focal = height / 2 / Math.tan((camera.verticalFovDegrees * Math.PI) / 360);
  const dx = (sx - width / 2) / focal, dy = -(sy - height / 2) / focal;
  const ray: V3 = [fx + dx * rx + dy * ux, fy + dy * uy, fz + dx * rz + dy * uz];
  if (distance === undefined) {
    const k = -cy / ray[1];
    const point: V3 = [cx + ray[0] * k, 0, cz + ray[2] * k];
    return { point, distance: (point[0] - cx) * fx + (point[1] - cy) * fy + (point[2] - cz) * fz, focal };
  }
  return { point: [cx + ray[0] * distance, cy + ray[1] * distance, cz + ray[2] * distance], distance, focal };
}

/** Act B scene; `piecesOnly` drops the floor (the matte pass that tells the pieces in front of the lock-up from the floor). */
function sceneB(p: KineticLyricParams, local: number, camera: Mesh3dCamera, piecesOnly = false): Mesh3dScene {
  const paper = hexRgb(p.palette.paper), ink = hexRgb(p.palette.ink), accent = hexRgb(p.palette.accent);
  const objects: Mesh3dObject[] = piecesOnly ? [] : [{
    id: "floor", name: "grid floor", geometry: { kind: "box", width: 20, height: 0.02, depth: 20 }, pose: pose([0, -0.01, -10], [0, 0, 0], [4, 1, 4]), keyframes: [],
    // Unlit shadow catcher in the background colour: the floor melts into the backdrop, the grid fades with distance.
    material: { color: hex(mixRgb(paper, [1, 1, 1], 0.12)), unlit: true, grid: true,
      gridStyle: { cells: [96, 96], lineWidthPx: 1.4, color: hex(mixRgb(paper, ink, 0.42)), fade: { start: 7, end: 26 } }, receiveShadow: true },
  }];
  const ref = referenceCameraB(p);
  const colour = (tone: Primitive["tone"]) => tone === "accent" ? p.palette.accent : p.palette.ink;
  for (const prim of primitives(p)) {
    const startTime = 0.12 + prim.delay;
    const at = unproject(ref, p.width, p.height, prim.screen[0], prim.screen[1], prim.distance);
    const size = (prim.px * at.distance) / at.focal;
    const scale: V3 = [size, size, size];
    const half = prim.geometry.kind === "cone" ? 1.25 * size : prim.geometry.kind === "cylinder" ? 1.35 * size : prim.geometry.kind === "torus" ? 0.32 * size : size;
    const material: Mesh3dObject["material"] = prim.tone === "stripe"
      ? { color: p.palette.paper, unlit: false, stripes: { colors: [p.palette.accent, hex(mixRgb(paper, [1, 1, 1], 0.55))], count: 12, angleDegrees: 0 }, specular: { strength: 0.45, shininess: 40 }, roughness: 0.38 }
      : { color: colour(prim.tone), unlit: false, specular: { strength: prim.tone === "ink" ? 0.6 : 0.8, shininess: 60 }, roughness: 0.28,
        edgeLight: { color: hex(mixRgb(paper, accent, 0.3)), strength: 0.14, power: 2.5 } };
    if (prim.air) {
      // Airborne pieces pop in with an overshoot, bob and tumble slowly.
      const pop = backOut(clamp01((local - startTime) / 0.42), 1.7);
      if (pop <= 0.001) continue;
      const rest = prim.rest ?? [0, 0, 0], spin = prim.spin ?? [0, 0, 0];
      objects.push({ id: prim.id, name: prim.id, geometry: prim.geometry, keyframes: [], material,
        pose: pose([at.point[0], at.point[1] + 0.1 * Math.sin(local * 2.2 + prim.delay * 9), at.point[2]],
          [rest[0] + spin[0] * local, rest[1] + spin[1] * local, rest[2] + spin[2] * local], [scale[0] * pop, scale[1] * pop, scale[2] * pop]) });
      continue;
    }
    if (local < startTime - 0.001) continue;
    // Floor pieces drop in and bounce (engine bounce keyframes): fall, impact with squash, two rebounds, rest.
    const track = mesh3dBounceKeyframesV1({ start: pose([at.point[0], 3.2 + half, at.point[2]], prim.rest ?? [0, 0, 0], scale), floorY: 0, contactOffset: half,
      startTime, restitution: 0.4, bounces: 2, squash: 0.2, gravity: 30, spinDegrees: prim.spin, until: Math.max(2, p.duration) });
    objects.push({ id: prim.id, name: prim.id, geometry: prim.geometry, pose: track.pose, keyframes: track.keyframes, material });
  }
  return {
    schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: hex(mixRgb(paper, [1, 1, 1], 0.12)), gridColor: hex(paper), spacing: 72, grid: false,
      radial: { color: hex(mixRgb(paper, [1, 1, 1], 0.7)), center: [0.5, 0.08], radius: 0.42, strength: 0.75 } },
    light: { direction: [-0.45, 0.85, 0.5], ambient: 0.36, intensity: 0.56, size: 9,
      fill: { direction: [0.8, 0.2, 0.6], intensity: 0.16, color: "#FFFFFF" },
      hemisphere: { sky: "#FFFFFF", ground: hex(paper), intensity: 0.12 },
      shadow: { strength: 0.5, softness: 6, mapSize: 2048 } },
    segments: [{ id: "lockup", name: "lockup", timelineStart: 0, duration: Math.max(2, p.duration + 1), camera, cameraKeyframes: [], objects }],
    post: { ao: { strength: 0.4, radius: 0.3 } },
  };
}

// ---------------------------------------------------------------------------
// 2D type (SVG overlays)
// ---------------------------------------------------------------------------

function labelsSvg(p: KineticLyricParams, t: number): string {
  const { width: W, height: H } = p, s = Math.min(W, H) / 1080, portrait = H >= W;
  const paper = p.palette.paper, accent = p.palette.accent;
  const parts: string[] = [];
  const x = (portrait ? 96 : 120) * s, y = (portrait ? 228 : 96) * s;
  const fade = 1 - curve("snapIn", clamp01((t - (p.whip ? p.whip.at : 1e9)) / 0.12));
  if (p.text.label && fade > 0.001) {
    const face = labelFace(p.text.label);
    const size = fitLine(p.text.label, face, (face.font === "latin" ? 54 : 40) * s, face.font === "latin" ? 0.32 : 0.18, 560 * s);
    const line = placeLine(p.text.label, face, size, face.font === "latin" ? 0.32 : 0.18, x, y, "start", "top");
    const glyphs = placedGlyphs(line);
    glyphs.forEach((glyph, index) => {
      const e = expoOut(clamp01((t - 0.5 - index * 0.035) / 0.4));
      if (e <= 0.001) return;
      parts.push(path(glyph.d, { fill: paper, "fill-opacity": Number(fmt(0.92 * e * fade, 3)), transform: poseAbout(glyph.cx, glyph.cy, { dx: (1 - e) * 26 * s }) }));
    });
    const rule = expoOut(clamp01((t - 0.75) / 0.5));
    if (rule > 0.001) parts.push(rect(line.box.x1 + 22 * s, line.box.y0 + (line.box.y1 - line.box.y0) * 0.45, 128 * s * rule, 3 * s, { fill: paper, "fill-opacity": Number(fmt(0.7 * fade, 3)) }));
    if (p.text.labelSub) {
      const sub = placeLine(p.text.labelSub, { font: "hand", weight: 700 }, fitLine(p.text.labelSub, { font: "hand", weight: 700 }, 64 * s, 0.02, 560 * s), 0.02, x, line.box.y1 + 30 * s, "start", "top");
      // Hand-written reveal: a left-to-right wipe of the line.
      const reveal = curve("quintOut", clamp01((t - 0.75) / 0.6));
      if (reveal > 0.001) {
        const clipW = (sub.box.x1 - sub.box.x0 + 8 * s) * reveal;
        parts.push(`<clipPath id="kl-sub"><rect x="${fmt(sub.box.x0 - 4 * s, 2)}" y="${fmt(sub.box.y0 - 20 * s, 2)}" width="${fmt(clipW, 2)}" height="${fmt(sub.box.y1 - sub.box.y0 + 40 * s, 2)}"/></clipPath>`);
        parts.push(g({ "clip-path": "url(#kl-sub)" }, path(sub.d, { fill: accent, "fill-opacity": Number(fmt(fade, 3)) })));
      }
    }
  }
  return svgFrame(W, H, parts.join(""));
}

interface LockupLayout { cx: number; cy: number; r: number; s: number }
function lockupLayout(p: KineticLyricParams): LockupLayout {
  const { width: W, height: H } = p, s = Math.min(W, H) / 1080, portrait = H >= W;
  return portrait ? { cx: W / 2, cy: 760 * s, r: 372 * s, s } : { cx: W / 2, cy: H * 0.45, r: 300 * s, s };
}

function lockupSvg(p: KineticLyricParams, local: number): string {
  const { width: W, height: H } = p;
  if (local < 0 || !p.text.display) return svgFrame(W, H, "");
  const L = lockupLayout(p), s = L.s, ink = p.palette.ink, paper = p.palette.paper, accent = p.palette.accent;
  const parts: string[] = [];
  // Circle frame draws on (stroke reveal) and corner brackets slide in from the corners.
  const ring = curve("quintOut", clamp01(local / 0.7));
  if (ring > 0.001) {
    const C = 2 * Math.PI * L.r;
    parts.push(`<circle cx="${fmt(L.cx, 2)}" cy="${fmt(L.cy, 2)}" r="${fmt(L.r, 2)}" fill="none" stroke="${ink}" stroke-width="${fmt(2.2 * s, 2)}" stroke-dasharray="${fmt(C * ring, 2)} ${fmt(C, 2)}" transform="rotate(-90 ${fmt(L.cx, 2)} ${fmt(L.cy, 2)})" stroke-opacity="0.85"/>`);
  }
  const br = expoOut(clamp01((local - 0.05) / 0.5));
  if (br > 0.001) {
    const span = L.r + 30 * s, arm = 64 * s, travel = (1 - br) * 90 * s;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x0 = L.cx + sx * (span + travel), y0 = L.cy + sy * (span + travel);
      parts.push(`<path d="M${fmt(x0 - sx * arm, 2)} ${fmt(y0, 2)}L${fmt(x0, 2)} ${fmt(y0, 2)}L${fmt(x0, 2)} ${fmt(y0 - sy * arm, 2)}" fill="none" stroke="${ink}" stroke-width="${fmt(5 * s, 2)}" stroke-linecap="square" stroke-opacity="${fmt(br, 3)}"/>`);
    }
  }
  // Display word slams in (scale 1.12 → 1 with overshoot), kicker tracks out above it.
  const dFace: MotionFontSelector = faceDrawsDisplay(p.text.display) ? { font: "latin", weight: 400 } : { font: "display", weight: 900 };
  const dTrack = dFace.font === "latin" ? 0.03 : -0.02;
  const dSize = fitLine(p.text.display, dFace, (dFace.font === "latin" ? 300 : 190) * s, dTrack, (W >= H ? 0.4 : 0.7) * W);
  // As in the frame: the display sits above the circle's centre, the script hangs below it, set right.
  const display = placeLine(p.text.display, dFace, dSize, dTrack, L.cx, L.cy - 0.19 * L.r, "center", "middle");
  const slam = clamp01((local - 0.12) / 0.42);
  if (slam > 0.001) {
    const e = backOut(slam, 1.4), scale = lerp(1.14, 1, e);
    parts.push(path(display.d, { fill: ink, "fill-opacity": Number(fmt(clamp01(slam * 3), 3)), transform: poseAbout(L.cx, (display.box.y0 + display.box.y1) / 2, { scale }) }));
  }
  if (p.text.kicker) {
    const kFace = labelFace(p.text.kicker), kTrack = kFace.font === "latin" ? 0.42 : 0.24;
    const kSize = fitLine(p.text.kicker, kFace, (kFace.font === "latin" ? 44 : 34) * s, kTrack, 0.5 * L.r * 2);
    const k = expoOut(clamp01((local - 0.3) / 0.5));
    if (k > 0.001) {
      const kicker = placeLine(p.text.kicker, kFace, kSize, kTrack * (0.6 + 0.4 * k), L.cx, display.box.y0 - 46 * s, "center", "baseline");
      parts.push(path(kicker.d, { fill: ink, "fill-opacity": Number(fmt(k, 3)) }));
      const ry = (kicker.box.y0 + kicker.box.y1) / 2, len = 66 * s * k;
      parts.push(rect(kicker.box.x0 - 24 * s - len, ry - 1.5 * s, len, 3 * s, { fill: ink }), rect(kicker.box.x1 + 24 * s, ry - 1.5 * s, len, 3 * s, { fill: ink }));
    }
  }
  if (p.text.script) {
    // Marker script: the hand face thickened by a same-colour stroke, slanted and turned, with a paper knock-out and an ink offset edge.
    const face: MotionFontSelector = { font: "hand", weight: 700 };
    const size = fitLine(p.text.script, face, 210 * s, 0.02, (W >= H ? 0.42 : 0.62) * W);
    const sx = L.cx + 115 * s, sy = display.box.y1 + size * 0.6;
    const line = placeLine(p.text.script, face, size, 0.02, sx, sy, "center", "middle");
    const reveal = curve("quintOut", clamp01((local - 0.45) / 0.55));
    if (reveal > 0.001) {
      const transform = `rotate(-6 ${fmt(sx, 2)} ${fmt(sy, 2)}) translate(${fmt(sx, 2)} ${fmt(sy, 2)}) skewX(-11) translate(${fmt(-sx, 2)} ${fmt(-sy, 2)})`;
      const clipW = (line.box.x1 - line.box.x0 + 60 * s) * reveal;
      const clip = `<clipPath id="kl-script"><rect x="${fmt(line.box.x0 - 30 * s, 2)}" y="${fmt(line.box.y0 - 80 * s, 2)}" width="${fmt(clipW, 2)}" height="${fmt(line.box.y1 - line.box.y0 + 160 * s, 2)}"/></clipPath>`;
      const stroke = (color: string, width: number, extra: Record<string, string | number> = {}) => path(line.d, { fill: color, stroke: color, "stroke-width": Number(fmt(width, 2)), "stroke-linejoin": "round", ...extra });
      parts.push(clip, g({ "clip-path": "url(#kl-script)" }, g({ transform },
        stroke(paper, 22 * s),
        g({ transform: `translate(${fmt(5 * s, 2)} ${fmt(4 * s, 2)})` }, stroke(ink, 6 * s, { "fill-opacity": 0.85, "stroke-opacity": 0.85 })),
        stroke(accent, 6 * s))));
    }
  }
  return svgFrame(W, H, parts.join(""));
}

function faceDrawsDisplay(text: string): boolean {
  return labelFace(text).font === "latin";
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Where we are: act A, act B, or the whip between them (u: 0 → 1 across the whip). */
function phase(p: KineticLyricParams, t: number): { a: boolean; b: boolean; u: number; bLocal: number } {
  if (!p.whip) return { a: true, b: false, u: 0, bLocal: -1 };
  const { at, duration } = p.whip;
  if (t < at) return { a: true, b: false, u: 0, bLocal: -1 };
  if (t >= at + duration) return { a: false, b: true, u: 1, bLocal: t - at - duration * 0.5 };
  return { a: true, b: true, u: (t - at) / duration, bLocal: t - at - duration * 0.5 };
}

function frame(params: Record<string, unknown>, t: number): StyleCompositeFrameV1 {
  const p = params as unknown as KineticLyricParams;
  const ph = phase(p, t), passes: StyleCompositePassV1[] = [];
  if (ph.a) {
    const tA = Math.min(t, p.whip ? p.whip.at + p.whip.duration : t);
    const camera = cameraA(p, tA);
    passes.push({ id: "tunnel", scene: tunnelScene(p, tA, camera), time: 0, matte: "opaque", ss: 1 });
    passes.push({ id: "hero", scene: heroScene(p, tA, camera), time: 0, matte: "depth", ss: 2 });
  }
  if (ph.b) {
    const local = Math.max(0, ph.bLocal);
    const camera = cameraB(p, local);
    // Pieces nearer than the lock-up plane (the circle's distance) come back over the type: a pieces-only pass (no floor)
    // gives their coverage, the full pass their colour, light and shadows.
    const plane = Math.hypot(camera.position[0], camera.position[1] - 1.0, camera.position[2]) - 0.2;
    passes.push({ id: "floor", scene: sceneB(p, local, camera), time: local, matte: "opaque", ss: 2 });
    // Before the first piece drops in there is nothing to split (an empty scene is not a valid engine scene).
    const pieces = sceneB(p, local, camera, true);
    if (pieces.segments[0].objects.length > 0) passes.push({ id: "pieces", scene: pieces, time: local, matte: "depth", ss: 2, splits: { front: ndcDepth(camera, plane) } });
  }
  return { passes, overlays: { labels: labelsSvg(p, t), lockup: ph.b ? lockupSvg(p, Math.max(0, ph.bLocal)) : svgFrame(p.width, p.height, "") } };
}

function heroCentre(p: KineticLyricParams, t: number): { x: number; y: number } {
  const portrait = p.height >= p.width, camera = cameraA(p, t);
  return project(camera, p.width, p.height, [portrait ? 0 : -0.15, 0.25, 0]);
}

function compositeA(p: KineticLyricParams, t: number, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const tunnel = layers.passes.tunnel, hero = layers.passes.hero;
  const W = p.width, H = p.height, n = W * H, bg = hexRgb(p.palette.bg), accent = hexRgb(p.palette.accent);
  const d = out.data;
  // Tunnel lines (opaque pass) with a soft glow of their own, a hot core behind the word and a deep vignette.
  const lines = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) for (let c = 0; c < 3; c += 1) lines[i * 3 + c] = Math.max(0, tunnel.color[i * 3 + c] - bg[c]);
  const soft = gaussianBlur(lines, W, H, 3, 6 * (W / 1080));
  const centre = heroCentre(p, t), portrait = H >= W;
  const rx = W * (portrait ? 0.62 : 0.36), ry = H * (portrait ? 0.3 : 0.5);
  const coreColour = mixRgb(bg, accent, 0.38), intro = expoOut(clamp01(t / 0.6));
  for (let y = 0; y < H; y += 1) {
    const vy = (y + 0.5 - centre.y) / ry;
    for (let x = 0; x < W; x += 1) {
      const vx = (x + 0.5 - centre.x) / rx, core = Math.exp(-(vx * vx + vy * vy)) * intro, i = y * W + x, o = i * 3;
      for (let c = 0; c < 3; c += 1) d[o + c] = bg[c] * (0.55 + 0.45 * core) + coreColour[c] * core * 0.42 + lines[o + c] * 0.62 + soft[o + c] * 0.6;
    }
  }
  // A dark halo separates the word from the tunnel, then the word, ring and band.
  const halo = gaussianBlur(hero.alpha, W, H, 1, 40 * (W / 1080));
  darken(out, halo, 0.36);
  over(out, rgbaFromPlanes(W, H, hero.color, hero.alpha));
  bloom(out, 0.9, [[4 * (W / 1080), 0.22], [16 * (W / 1080), 0.2], [60 * (W / 1080), 0.16]]);
  vignette(out, 0.3, 0.8, 0.7, 0.55);
}

function compositeB(p: KineticLyricParams, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const floor = layers.passes.floor, W = p.width, H = p.height, n = W * H, d = out.data;
  for (let i = 0; i < n * 3; i += 1) d[i] = floor.color[i];
  // Horizon haze: the floor's far edge melts into the backdrop glow.
  const horizon = project(cameraB(p, 1e3), W, H, [0, 0, -60]).y, paper = hexRgb(p.palette.paper), haze = mixRgb(paper, [1, 1, 1], 0.55), band = 0.07 * H;
  for (let y = 0; y < H; y += 1) {
    const k = Math.exp(-(((y - horizon) / band) ** 2)) * 0.55;
    if (k < 0.002) continue;
    for (let x = 0; x < W; x += 1) { const o = (y * W + x) * 3; d[o] += (haze[0] - d[o]) * k; d[o + 1] += (haze[1] - d[o + 1]) * k; d[o + 2] += (haze[2] - d[o + 2]) * k; }
  }
  over(out, layers.overlays.lockup);
  // Pieces in front of the lock-up plane come back over the type.
  const front = layers.passes.pieces?.splits.front;
  if (front) {
    const color = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) { const a = front[i]; color[i * 3] = floor.color[i * 3] * a; color[i * 3 + 1] = floor.color[i * 3 + 1] * a; color[i * 3 + 2] = floor.color[i * 3 + 2] * a; }
    over(out, rgbaFromPlanes(W, H, color, front));
  }
  bloom(out, 0.95, [[4 * (W / 1080), 0.1], [16 * (W / 1080), 0.07]]);
  vignette(out, 0.1, 0.85, 0.75, 0.8);
}

function composite(params: Record<string, unknown>, t: number, index: number, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const p = params as unknown as KineticLyricParams;
  const ph = phase(p, t), W = p.width, H = p.height;
  if (ph.a && !ph.b) compositeA(p, t, layers, out);
  else if (ph.b && !ph.a) compositeB(p, layers, out);
  else {
    // Whip pan: A leaves left and B enters from the right, both smeared along the pan (shutter half a frame).
    const a = createRaster(W, H, 3), b = createRaster(W, H, 3);
    compositeA(p, t, layers, a);
    compositeB(p, layers, b);
    const u = expoInOut(ph.u), du = Math.abs(expoInOut(clamp01(ph.u + 0.02)) - expoInOut(clamp01(ph.u - 0.02))) / 0.04;
    const shift = Math.round(u * W), smear = Math.max(1, Math.round((du / (p.whip!.duration * 30)) * W * 0.5));
    const d = out.data;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const sx = x + shift, o = (y * W + x) * 3;
      const src = sx < W ? a.data : b.data, xx = sx < W ? sx : sx - W, so = (y * W + xx) * 3;
      d[o] = src[so]; d[o + 1] = src[so + 1]; d[o + 2] = src[so + 2];
    }
    // Horizontal motion blur (box, radius ∝ pan speed), then a flash at the cut.
    const blurred = new Float32Array(W * H * 3), r = Math.min(Math.floor(W / 3), smear);
    for (let y = 0; y < H; y += 1) {
      const row = y * W * 3;
      for (let c = 0; c < 3; c += 1) {
        let acc = 0;
        const at = (x: number) => d[row + Math.max(0, Math.min(W - 1, x)) * 3 + c];
        for (let i = -r; i <= r; i += 1) acc += at(i);
        for (let x = 0; x < W; x += 1) { blurred[row + x * 3 + c] = acc / (2 * r + 1); acc += at(x + r + 1) - at(x - r); }
      }
    }
    const flash = Math.exp(-(((ph.u - 0.5) / 0.18) ** 2)) * 0.22, paper = hexRgb(p.palette.paper);
    for (let i = 0; i < W * H * 3; i += 1) d[i] = blurred[i] + paper[i % 3] * flash;
  }
  if (ph.a) over(out, layers.overlays.labels);
  grain(out, 0.011, 23, index);
}

function preflight(params: Record<string, unknown>): void {
  const p = params as unknown as KineticLyricParams, text = p.text;
  assertMotionText(text.word, { font: "display", weight: 900 });
  if (text.band) assertMotionText(bandPhrase(text.band), { font: "serif", weight: 900 });
  if (text.label) assertMotionText(text.label, labelFace(text.label));
  if (text.labelSub) assertMotionText(text.labelSub, { font: "hand", weight: 700 });
  if (text.display) assertMotionText(text.display, faceDrawsDisplay(text.display) ? { font: "latin", weight: 400 } : { font: "display", weight: 900 });
  if (text.script) assertMotionText(text.script, { font: "hand", weight: 700 });
  if (text.kicker) assertMotionText(text.kicker, labelFace(text.kicker));
}

export const kineticLyricCompositeV1: StyleCompositeHooksV1 = {
  frame: (params, t) => frame(params, t),
  composite,
  preflight,
};

export type { KineticLyricParams as KineticLyricParamsV1 };
/** Pure pieces for tests and previews. */
export const kineticLyricInternalsV1 = { phase, primitives, bandPhrase, bandRepeat, cameraA, heroScene, lockupSvg, labelsSvg };

import type { Mesh3dCamera, Mesh3dObject, Mesh3dScene } from "../../motion/mesh3dScene";
import { circle, fmt, g, path, rect, roundRect } from "../../motionLibrary/svg/document";
import { backOut, clamp01, expoOut, lerp, smootherstep } from "../../motionLibrary/svg/easing";
import { assertMotionText, type MotionFontSelector } from "../../motionLibrary/svg/glyphs";
import type { StyleCompositeFrameV1, StyleCompositeHooksV1, StyleCompositeLayersV1, StyleCompositePassV1, StyleSvgArtV1 } from "./compositeComponent";
import { apply, eulerMatrix, mul, placeIn, type Vec3 } from "./euler";
import {
  addRadial, addStreak, bloom, darken, depthOfField, gaussianBlur, glow, grain, hexRgb, luminance, mixRgb, ndcToDistance, over, rgbHex, rgbaFromPlanes, saturateRgb, scaleRgb, vignette,
  type RasterV1, type Rgb,
} from "./raster";
import { imagePlacement, svgImageElement, type SlotImageParams } from "./svgImage";
import { fitLine, labelFace, placeLine, placedGlyphs, poseAbout, svgFrame } from "./templateType";

/**
 * mesh3dDeviceScreen (S4 motion_promo_3d, from R4; Claude's style frames S4_A / S4_A_16x9 / S4_reskin) with its part
 * mesh3dExtrudedTitle: a 3D device on Editkin's mesh3d engine whose screen shows a picture slot, three UI cards (picture
 * slots) popping out of the screen with an overshoot, a chrome extruded title and a tracked kicker, on an ultramarine glow
 * field with light columns and a glossy floor reflection.
 *
 * Engine passes per frame: the device and cards (exact matte from renders over black and white, so the engine's depth of
 * field and ambient occlusion keep their soft edges), a mirrored-camera pass for the floor reflection, and the title in
 * its own studio light (each glyph its own extruded mesh, chrome-gradient textured, landing in a stagger). Light that the
 * engine does not draw (the glow field, light columns, light pool, tinted bloom, grain) is composited in TypeScript.
 *
 * Slots: text title (extruded) and kicker (2D); colours bg, accent (glow field, key light, rim), accent2 (screen light,
 * chrome tint), highlight (the kicker dot); pictures screen, cardHero, cardMenu, cardPill (placeholders: drawn UI panels).
 */

export const DEVICE_SCREEN_REVISION = 1;
export const EXTRUDED_TITLE_REVISION = 1;

type V3 = [number, number, number];
const pose = (position: V3, rotationDegrees: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const hex = (c: Rgb) => rgbHex(c);
const TITLE_FACE: MotionFontSelector = { font: "display", weight: 900 };

export const DEVICE_SCREEN_IMAGE_SLOTS = ["screen", "cardHero", "cardMenu", "cardPill"] as const;
type ImageSlot = typeof DEVICE_SCREEN_IMAGE_SLOTS[number];

/** Texture size per picture slot (the derivative is sized to cover it). */
const TEXTURE: Record<ImageSlot, { w: number; h: number; radius: number }> = {
  screen: { w: 1600, h: 1000, radius: 0 },
  cardHero: { w: 640, h: 880, radius: 30 },
  cardMenu: { w: 640, h: 512, radius: 26 },
  cardPill: { w: 1040, h: 196, radius: 34 },
};

export interface DeviceScreenParams {
  readonly component: "mesh3dDeviceScreen";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly palette: { readonly bg: string; readonly accent: string; readonly accent2: string; readonly highlight: string; readonly glow: string; readonly metal: string };
  readonly text: { readonly title: string; readonly kicker?: string };
  /** Picture per image slot (absent: the drawn UI panel). */
  readonly images: Partial<Record<ImageSlot, SlotImageParams>>;
  /** Title layout in output px: ink box centre, em size, per-glyph centres (x, y offsets from the centre, px). */
  readonly title: { readonly cx: number; readonly cy: number; readonly size: number; readonly glyphs: ReadonlyArray<{ readonly char: string; readonly dx: number; readonly dy: number; readonly top: number; readonly bottom: number }>; readonly inkTop: number; readonly inkBottom: number };
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export function deviceScreenPalette(roles: { bg: string; accent: string; accent2: string; highlight: string }): DeviceScreenParams["palette"] {
  const bg = hexRgb(roles.bg), accent = hexRgb(roles.accent);
  // The light field: bg toward the accent, saturated. A light accent (violet, pink) is held to the blue frame's brightness
  // (luminance 0.14) so the field never washes the device out.
  const field = saturateRgb(mixRgb(bg, accent, 0.45), 0.25), level = luminance(field);
  return { ...roles, glow: hex(level > 0.14 ? scaleRgb(field, 0.14 / level) : field), metal: hex(mixRgb(mixRgb(bg, [0.71, 0.74, 0.8], 0.1), accent, 0.04)) };
}

export function deviceScreenParams(input: { width: number; height: number; duration: number; roles: { bg: string; accent: string; accent2: string; highlight: string };
  text: DeviceScreenParams["text"]; images: DeviceScreenParams["images"] }): DeviceScreenParams {
  const { width: W, height: H } = input, portrait = H >= W, s = Math.min(W, H) / 1080;
  // Title: heavy display, slightly tracked, fitted to the frame (portrait: centred under the kicker; landscape: left column).
  const tracking = 0.02, maxWidth = portrait ? W * 0.84 : W * 0.4;
  const size = fitLine(input.text.title, TITLE_FACE, (portrait ? 132 : 124) * s, tracking, maxWidth);
  const line = placeLine(input.text.title, TITLE_FACE, size, tracking, 0, 0, "center", "middle");
  const cx = portrait ? W / 2 : 116 * s + (line.box.x1 - line.box.x0) / 2, cy = portrait ? 424 * s : 512 * s;
  const glyphs = placedGlyphs(line).map(glyph => {
    const bbox = line.layout.glyphs[glyph.index].bbox!;
    return { char: line.layout.glyphs[glyph.index].char, dx: glyph.cx, dy: glyph.cy, top: bbox.y0 + line.dy, bottom: bbox.y1 + line.dy };
  });
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    component: "mesh3dDeviceScreen", revision: DEVICE_SCREEN_REVISION, width: W, height: H, duration: input.duration,
    palette: deviceScreenPalette(input.roles), text: input.text, images: input.images,
    title: { cx: round(cx), cy: round(cy), size: round(size), inkTop: round(line.box.y0), inkBottom: round(line.box.y1),
      glyphs: glyphs.map(glyph => ({ char: glyph.char, dx: round(glyph.dx), dy: round(glyph.dy), top: round(glyph.top), bottom: round(glyph.bottom) })) },
  };
}

// ---------------------------------------------------------------------------
// Art: textures (straight RGBA)
// ---------------------------------------------------------------------------

function screenPlaceholder(p: DeviceScreenParams, w: number, h: number): string {
  const accent = p.palette.accent, accent2 = p.palette.accent2, line = "#2A3142", panel = "#161B26", ink = "#0E121A";
  const parts: string[] = [rect(0, 0, w, h, { fill: ink })];
  // Top bar, left media panel, preview, inspector and a timeline with coloured clips.
  parts.push(rect(0, 0, w, 54, { fill: panel }), circle(30, 27, 9, { fill: accent }));
  for (let i = 0; i < 4; i += 1) parts.push(roundRect(70 + i * 120, 19, 92, 16, 8, { fill: i === 0 ? accent : line }));
  parts.push(rect(0, 54, 330, h - 54 - 300, { fill: panel }));
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 2; c += 1) {
    const x = 22 + c * 150, y = 84 + r * 128;
    parts.push(roundRect(x, y, 136, 80, 10, { fill: c === r % 2 ? mixHex(accent, ink, 0.45) : mixHex(accent2, ink, 0.55) }), roundRect(x, y + 90, 96, 10, 5, { fill: line }));
  }
  parts.push(rect(1240, 54, w - 1240, h - 54 - 300, { fill: panel }));
  for (let r = 0; r < 6; r += 1) {
    const y = 96 + r * 66;
    parts.push(roundRect(1270, y, 120, 10, 5, { fill: line }), roundRect(1270, y + 26, 290, 6, 3, { fill: line }), circle(1270 + 60 + r * 34, y + 29, 10, { fill: r % 2 ? accent2 : accent }));
  }
  // Preview with a framed "video" (a soft gradient and a centred title bar).
  parts.push(rect(330, 54, 910, h - 54 - 300, { fill: "#0A0D14" }));
  parts.push(`<defs><linearGradient id="sp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mixHex(accent, "#FFFFFF", 0.15)}"/><stop offset="1" stop-color="${mixHex(accent2, ink, 0.4)}"/></linearGradient></defs>`);
  parts.push(roundRect(420, 110, 730, 410, 14, { fill: "url(#sp)" }), roundRect(470, 380, 360, 34, 8, { fill: "#FFFFFF", "fill-opacity": 0.9 }), roundRect(470, 428, 220, 18, 6, { fill: "#FFFFFF", "fill-opacity": 0.55 }));
  // Timeline.
  parts.push(rect(0, h - 300, w, 300, { fill: panel }), rect(0, h - 300, w, 2, { fill: line }));
  const tracks = [[60, 520, accent], [600, 300, accent2], [920, 380, accent], [120, 760, mixHex(accent2, "#FFFFFF", 0.3)], [960, 420, mixHex(accent, "#FFFFFF", 0.25)]] as const;
  tracks.forEach(([x, len, color], i) => parts.push(roundRect(x, h - 270 + (i < 3 ? 0 : 70) + (i >= 3 ? 0 : 0) + (i === 3 || i === 4 ? 0 : 0) + Math.floor(i / 3) * 0, len, 52, 10, { fill: color, "fill-opacity": 0.92 })));
  for (let i = 0; i < 3; i += 1) parts.push(roundRect(60 + i * 410, h - 120, 380, 40, 10, { fill: line }));
  parts.push(rect(840, h - 300, 4, 300, { fill: "#FFFFFF" }), circle(842, h - 300, 10, { fill: "#FFFFFF" }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

function cardPlaceholder(p: DeviceScreenParams, slot: Exclude<ImageSlot, "screen">, w: number, h: number): string {
  const accent = p.palette.accent, bar = "#D5DAE6", dark = "#2A3040";
  const parts: string[] = [];
  if (slot === "cardHero") {
    parts.push(roundRect(40, 40, 46, 46, 12, { fill: accent }), roundRect(104, 46, 260, 14, 7, { fill: dark }), roundRect(104, 70, 180, 10, 5, { fill: bar }));
    parts.push(roundRect(40, 120, w - 80, 300, 18, { fill: "#20242E" }), roundRect(80, 330, 300, 34, 8, { fill: "#FFFFFF" }));
    for (let i = 0; i < 4; i += 1) parts.push(roundRect(40, 460 + i * 92, w - 80, 70, 14, { fill: "#EEF1F7" }), roundRect(64, 486 + i * 92, 200 + (i % 2) * 90, 16, 8, { fill: i === 0 ? accent : bar }));
  } else if (slot === "cardMenu") {
    for (let i = 0; i < 4; i += 1) {
      const y = 44 + i * 112;
      parts.push(circle(76, y + 34, 18, { fill: i === 2 ? accent : bar }), roundRect(120, y + 24, 230 - i * 20, 20, 10, { fill: i === 3 ? "#B8BFCC" : dark }), roundRect(w - 150, y + 26, 100, 16, 8, { fill: bar }));
      if (i < 3) parts.push(rect(40, y + 88, w - 80, 2, { fill: "#E3E7EF" }));
    }
  } else {
    parts.push(circle(h / 2, h / 2, h * 0.3, { fill: accent }), roundRect(h, h * 0.3, 260, h * 0.16, h * 0.08, { fill: dark }), roundRect(h, h * 0.56, 420, h * 0.12, h * 0.06, { fill: bar }));
    for (let i = 0; i < 3; i += 1) parts.push(roundRect(w - 300 + i * 90, h * 0.38, 60, h * 0.24, h * 0.12, { fill: "#E3E7EF" }));
  }
  return parts.join("");
}

function mixHex(a: string, b: string, t: number): string { return hex(mixRgb(hexRgb(a), hexRgb(b), t)); }

function slotTexture(p: DeviceScreenParams, slot: ImageSlot, images: Readonly<Record<string, string>>): StyleSvgArtV1 {
  const { w, h, radius } = TEXTURE[slot];
  const picture = p.images[slot], href = images[slot];
  const clip = radius ? `<clipPath id="c"><rect x="0" y="0" width="${w}" height="${h}" rx="${radius}"/></clipPath>` : "";
  let body: string;
  if (picture && href) {
    const placed = imagePlacement(picture, { w, h });
    body = g(radius ? { "clip-path": "url(#c)" } : undefined, rect(0, 0, w, h, { fill: slot === "screen" ? "#0A0D14" : "#F4F6FB" }), svgImageElement(href, placed.x, placed.y, placed.w, placed.h));
  } else if (slot === "screen") {
    return { svg: screenPlaceholder(p, w, h), width: w, height: h };
  } else {
    body = g({ "clip-path": "url(#c)" }, rect(0, 0, w, h, { fill: "#F6F8FC" }), cardPlaceholder(p, slot, w, h));
  }
  // A crisp light edge on the cards (rim of the glass/paper), a faint glare on the screen.
  const edge = radius ? `<rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="${radius - 1.5}" fill="none" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="3"/>` : "";
  const veil = `<rect width="${w}" height="${h}" fill="#000000" fill-opacity="${slot === "screen" ? 0.12 : 0.05}"${radius ? ' clip-path="url(#c)"' : ""}/>`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${clip}</defs>${body}${veil}${edge}</svg>`, width: w, height: h };
}

function keyboardTexture(p: DeviceScreenParams): StyleSvgArtV1 {
  const w = 1600, h = 600, metal = hexRgb(p.palette.metal), key = hex(mixRgb(metal, [0, 0, 0], 0.45)), top = hex(mixRgb(metal, [0, 0, 0], 0.32));
  const parts: string[] = [rect(0, 0, w, h, { fill: p.palette.metal })];
  const rows = [14, 14, 14, 13, 12, 9], kh = h / 6.4;
  rows.forEach((n, r) => {
    const y0 = 18 + r * (kh + 6), kw = (w - 36 - (n - 1) * 8) / n;
    for (let i = 0; i < n; i += 1) {
      const x0 = 18 + i * (kw + 8);
      parts.push(roundRect(x0, y0, kw, kh, 10, { fill: key }), roundRect(x0 + 3, y0 + 2, kw - 6, kh * 0.55, 8, { fill: top }));
    }
  });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`, width: w, height: h };
}

/** Chrome for one title glyph: the line's vertical chrome gradient sliced to this glyph's ink box (uv frame = its own ink). */
function chromeSlice(p: DeviceScreenParams, top: number, bottom: number): StyleSvgArtV1 {
  const T = p.title, accent = hexRgb(p.palette.accent), accent2 = hexRgb(p.palette.accent2);
  const span = Math.max(1, T.inkBottom - T.inkTop), a = (top - T.inkTop) / span, b = (bottom - T.inkTop) / span;
  const stops: Array<[number, Rgb]> = [
    [0, [1, 1, 1]], [0.4, mixRgb([0.8, 0.86, 1], accent2, 0.25)], [0.52, mixRgb(accent, [0, 0, 0], 0.55)],
    [0.545, mixRgb(accent, [0.2, 0.3, 0.9], 0.3)], [0.8, mixRgb(accent2, [1, 1, 1], 0.45)], [1, [0.92, 0.95, 1]],
  ];
  // Re-map the stops into this glyph's [a, b] slice of the line.
  const local = stops.map(([o, c]) => [(o - a) / Math.max(1e-6, b - a), c] as const);
  const stopMarkup = local.map(([o, c]) => `<stop offset="${fmt(o, 3)}" stop-color="${hex(c)}"/>`).join("");
  const h = 512;
  return { width: 8, height: h, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="${h}" viewBox="0 0 8 ${h}"><defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="${h}" gradientUnits="userSpaceOnUse" spreadMethod="pad">${stopMarkup}</linearGradient></defs><rect width="8" height="${h}" fill="url(#c)"/></svg>` };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

interface CardSpec { slot: Exclude<ImageSlot, "screen">; at: V3; width: number; rotation: V3; delay: number; phase: number }
const CARDS: readonly CardSpec[] = [
  { slot: "cardMenu", at: [-1.02, 1.8, 0.95], width: 0.7, rotation: [4, -14, -5], delay: 0.13, phase: 0.3 },
  { slot: "cardHero", at: [1.02, 1.02, 1.5], width: 0.84, rotation: [10, -24, 4], delay: 0, phase: 1.4 },
  { slot: "cardPill", at: [-0.3, 0.3, 2.05], width: 1.08, rotation: [16, -18, -2], delay: 0.26, phase: 2.2 },
];
const CARD_IN = 0.55, LID_TILT = -13;

function deviceCamera(p: DeviceScreenParams, t: number): Mesh3dCamera {
  const portrait = p.height >= p.width;
  const base = portrait ? { position: [0.6, 3.6, 17.5] as V3, target: [0.25, 1.02, 0.7] as V3, fov: 25 } : { position: [0, 2.6, 10.5] as V3, target: [-1.55, 0.95, 0.6] as V3, fov: 28 };
  const intro = expoOut(clamp01(t / 1.1)), drift = smootherstep(0, Math.max(1.5, p.duration), t);
  const k = 1.16 - 0.16 * intro - 0.035 * drift, swing = (1 - intro) * 0.12 + drift * 0.03;
  const dx = base.position[0] - base.target[0], dz = base.position[2] - base.target[2];
  const c = Math.cos(swing), s = Math.sin(swing);
  return { position: [base.target[0] + (dx * c - dz * s) * k, base.target[1] + (base.position[1] - base.target[1]) * (k + (1 - intro) * 0.25), base.target[2] + (dx * s + dz * c) * k],
    target: base.target, verticalFovDegrees: base.fov, near: 0.1, far: 80 };
}

function deviceGroup(p: DeviceScreenParams, t: number): { rotation: V3; origin: V3 } {
  const portrait = p.height >= p.width, intro = expoOut(clamp01(t / 1.1));
  return { rotation: [2, (portrait ? 24 : 28) + 14 * (1 - intro), -3], origin: [portrait ? -0.12 : 0, -0.35 * (1 - intro), 0] };
}

function deviceObjects(p: DeviceScreenParams, t: number, withCards: boolean): Mesh3dObject[] {
  const accent = hexRgb(p.palette.accent), accent2 = hexRgb(p.palette.accent2), metal = hexRgb(p.palette.metal);
  const G = deviceGroup(p, t);
  // The group rotation is Rz·Ry·Rx as in the style frame: compose it explicitly.
  const groupMatrix = mul(mul(eulerMatrix([0, 0, G.rotation[2]]), eulerMatrix([0, G.rotation[1], 0])), eulerMatrix([G.rotation[0], 0, 0]));
  const world = { rotation: groupMatrix, origin: G.origin as Vec3 };
  const at = (local: V3, rotation: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => { const placed = placeIn(world, local, rotation); return pose(placed.position, placed.rotationDegrees, scale); };
  const lid = (local: V3): V3 => {
    const r = (LID_TILT * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [local[0], 0.07 + local[1] * c - local[2] * s, local[1] * s + local[2] * c];
  };
  const aluminium: Mesh3dObject["material"] = { color: p.palette.metal, unlit: false, specular: { strength: 0.7, shininess: 120 }, roughness: 0.34,
    edgeLight: { color: hex(mixRgb(accent, accent2, 0.5)), strength: 0.42, power: 3 }, reflection: { strength: 0.1, sky: hex(mixRgb(accent2, [1, 1, 1], 0.5)), horizon: "#FFFFFF", ground: p.palette.bg } };
  const objects: Mesh3dObject[] = [
    { id: "deck", name: "deck", geometry: { kind: "rounded_box", width: 3, height: 0.07, depth: 2.05, radius: 0.03, segments: 3 }, pose: at([0, 0.035, 1.025]), keyframes: [], material: aluminium },
    { id: "keys", name: "keyboard", geometry: { kind: "box", width: 2.55, height: 0.95, depth: 0.004, uvMode: "front" }, pose: at([0, 0.072, 0.66], [-90, 0, 0]), keyframes: [],
      material: { color: p.palette.metal, unlit: false, clipId: "keys", texture: { filter: "mipmap", alpha: false }, specular: { strength: 0.2, shininess: 40 } } },
    { id: "pad", name: "trackpad", geometry: { kind: "box", width: 1.15, height: 0.003, depth: 0.6 }, pose: at([0, 0.072, 1.52]), keyframes: [],
      material: { color: hex(mixRgb(metal, [1, 1, 1], 0.07)), unlit: false, specular: { strength: 0.5, shininess: 80 }, roughness: 0.4 } },
    { id: "lid", name: "lid", geometry: { kind: "rounded_box", width: 3, height: 1.95, depth: 0.045, radius: 0.02, segments: 3 }, pose: at(lid([0, 0.975, -0.0225]), [LID_TILT, 0, 0]), keyframes: [], material: aluminium },
    { id: "screen", name: "screen", geometry: { kind: "box", width: 2.8, height: 1.75, depth: 0.002, uvMode: "front" }, pose: at(lid([0, 1.03, 0.0015]), [LID_TILT, 0, 0]), keyframes: [],
      material: { color: "#0A0D14", unlit: true, clipId: "screen", texture: { filter: "mipmap", alpha: false }, receiveShadow: false, castShadow: false,
        reflection: { strength: 0.04, sky: "#FFFFFF", horizon: "#FFFFFF", ground: "#000000" } } },
  ];
  if (withCards) {
    for (const card of CARDS) {
      const { w, h } = TEXTURE[card.slot], height = (card.width * h) / w;
      const e = clamp01((t - CARD_IN - card.delay) / 0.62);
      if (e <= 0) continue;
      const pop = backOut(e, 1.5), fly = expoOut(e), bob = 0.018 * Math.sin((t * 2 * Math.PI) / 2.6 + card.phase) * smootherstep(0, 0.6, e);
      // From the screen plane (on the screen, small) out to the card's place, turning into its own angle.
      const from: V3 = [card.at[0] * 0.55, card.at[1] * 0.92 + 0.05, 0.012], to: V3 = card.at;
      const local: V3 = [lerp(from[0], to[0], fly), lerp(from[1], to[1], fly) + bob, lerp(from[2], to[2], fly)];
      const turn: V3 = [card.rotation[0] * fly, card.rotation[1] * fly, card.rotation[2] * fly];
      const scale = lerp(0.35, 1, pop);
      objects.push({ id: card.slot, name: card.slot, geometry: { kind: "box", width: card.width, height, depth: 0.006, uvMode: "front" },
        pose: at(lid(local), [LID_TILT + turn[0], turn[1], turn[2]], [scale, scale, scale]), keyframes: [],
        material: { color: "#F4F6FB", unlit: true, clipId: card.slot, texture: { filter: "mipmap", alpha: true }, doubleSided: true, castShadow: true } });
    }
  }
  return objects;
}

function deviceLight(p: DeviceScreenParams): Mesh3dScene["light"] {
  const accent = hexRgb(p.palette.accent), accent2 = hexRgb(p.palette.accent2);
  return { direction: [-0.55, 0.75, 0.6], ambient: 0.22, intensity: 0.62, size: 10,
    fill: { direction: [0.9, 0.1, 0.4], intensity: 0.4, color: hex(mixRgb(accent, accent2, 0.4)) },
    hemisphere: { sky: hex(mixRgb(accent2, [1, 1, 1], 0.5)), ground: p.palette.bg, intensity: 0.12 },
    shadow: { strength: 0.32, softness: 3, mapSize: 2048 } };
}

function deviceScene(p: DeviceScreenParams, t: number, camera: Mesh3dCamera, withCards: boolean, post: boolean): Mesh3dScene {
  const objects = deviceObjects(p, t, withCards);
  return {
    schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: p.palette.bg, gridColor: p.palette.bg, spacing: 72, grid: false },
    light: deviceLight(p),
    segments: [{ id: "device", name: "device", timelineStart: 0, duration: Math.max(1, p.duration + 1), camera, cameraKeyframes: [], objects }],
    ...(post ? { post: { ao: { strength: 0.55, radius: 0.25 } } } : {}),
  };
}

/** The title pass camera: a long lens straight on, so a world unit is `ppu` output pixels at the title plane. */
function titleCamera(p: DeviceScreenParams): { camera: Mesh3dCamera; ppu: number } {
  const fov = 15, distance = 30, visible = 2 * distance * Math.tan((fov * Math.PI) / 360);
  return { camera: { position: [0, 0, distance], target: [0, 0, 0], verticalFovDegrees: fov, near: 1, far: 60 }, ppu: p.height / visible };
}

function titleScene(p: DeviceScreenParams, t: number): Mesh3dScene {
  const { camera, ppu } = titleCamera(p), T = p.title, accent = hexRgb(p.palette.accent), accent2 = hexRgb(p.palette.accent2);
  const W = p.width, H = p.height, size = T.size / ppu, depth = size * 0.13;
  const sweep = clamp01((t - 1.25) / 0.9), sx = lerp(-0.9, 0.9, smootherstep(0, 1, sweep));
  const objects: Mesh3dObject[] = T.glyphs.flatMap((glyph, index) => {
    const e = clamp01((t - 0.85 - index * 0.055) / 0.5);
    if (e <= 0) return [];
    const pop = backOut(e, 1.35), rise = expoOut(e);
    const x = (T.cx + glyph.dx - W / 2) / ppu, y = -(T.cy + glyph.dy - H / 2) / ppu;
    return [{ id: `g${index}`, name: glyph.char,
      geometry: { kind: "text_extrude" as const, text: glyph.char, font: "display" as const, weight: 900, size, depth, bevelSize: size * 0.022, bevelThickness: depth * 0.32, bevelSegments: 2, bevelProfile: "round" as const, tracking: 0 },
      pose: pose([x, y - (1 - rise) * size * 0.35, 0], [-62 * (1 - pop), -10 * (1 - rise), 0], [lerp(0.7, 1, pop), lerp(0.7, 1, pop), lerp(0.7, 1, pop)]), keyframes: [],
      material: { color: "#DDE6FF", unlit: false, clipId: `chrome${index}`, texture: { filter: "bilinear", alpha: false }, specular: { strength: 1.3, shininess: 120 }, roughness: 0.2,
        edgeLight: { color: hex(mixRgb(accent, accent2, 0.5)), strength: 0.55, power: 2.4 }, reflection: { strength: 0.12, sky: "#FFFFFF", horizon: "#FFFFFF", ground: hex(mixRgb(accent, [0, 0, 0], 0.5)) } } }];
  });
  return {
    schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: "#000000", gridColor: "#000000", spacing: 72, grid: false },
    light: { direction: [sx, 0.7, 0.75], ambient: 0.62, intensity: 0.38, size: 6, fill: { direction: [0.6, -0.4, 0.6], intensity: 0.25, color: hex(mixRgb(accent2, [1, 1, 1], 0.4)) } },
    segments: [{ id: "title", name: "title", timelineStart: 0, duration: Math.max(1, p.duration + 1), camera, cameraKeyframes: [], objects: objects.length ? objects : [placeholderObject()] }],
  };
}

/** An invisible stand-in (a scene needs one object): far behind the camera. */
function placeholderObject(): Mesh3dObject {
  return { id: "none", name: "none", geometry: { kind: "box", width: 0.01, height: 0.01, depth: 0.01 }, pose: pose([0, 0, 59]), keyframes: [], material: { color: "#000000", unlit: true } };
}

// ---------------------------------------------------------------------------
// Kicker (2D)
// ---------------------------------------------------------------------------

function kickerSvg(p: DeviceScreenParams, t: number): string {
  const { width: W, height: H } = p, s = Math.min(W, H) / 1080, portrait = H >= W;
  if (!p.text.kicker) return svgFrame(W, H, "");
  const face = labelFace(p.text.kicker), latin = face.font === "latin", track = latin ? 0.32 : 0.2;
  const e = expoOut(clamp01((t - 1.0) / 0.7));
  if (e <= 0.001) return svgFrame(W, H, "");
  const size = fitLine(p.text.kicker, face, (latin ? 38 : 30) * s, track, portrait ? W * 0.7 : W * 0.36);
  const y = p.title.cy + p.title.inkTop - 26 * s;
  const line = placeLine(p.text.kicker, face, size, track * (0.55 + 0.45 * e), portrait ? W / 2 + 14 * s : 150 * s, y, portrait ? "center" : "start", "baseline");
  const color = mixHex(p.palette.accent2, "#FFFFFF", 0.72);
  const dot = circle(line.box.x0 - 22 * s, (line.box.y0 + line.box.y1) / 2, 7.5 * s * backOut(clamp01((t - 0.95) / 0.4), 2), { fill: p.palette.highlight });
  const halo = circle(line.box.x0 - 22 * s, (line.box.y0 + line.box.y1) / 2, 14 * s, { fill: p.palette.highlight, "fill-opacity": Number(fmt(0.25 * e, 3)) });
  return svgFrame(W, H, halo + dot + path(line.d, { fill: color, "fill-opacity": Number(fmt(e, 3)), transform: poseAbout(line.box.x0, line.box.y1, { dy: (1 - e) * 10 * s }) }));
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function mirrorCamera(camera: Mesh3dCamera): Mesh3dCamera {
  return { ...camera, position: [camera.position[0], -camera.position[1], camera.position[2]], target: [camera.target[0], -camera.target[1], camera.target[2]] };
}

function frame(params: Record<string, unknown>, t: number): StyleCompositeFrameV1 {
  const p = params as unknown as DeviceScreenParams;
  const camera = deviceCamera(p, t);
  const passes: StyleCompositePassV1[] = [
    { id: "device", scene: deviceScene(p, t, camera, true, true), time: 0, matte: "difference", ss: 2 },
    { id: "reflection", scene: deviceScene(p, t, mirrorCamera(camera), false, false), time: 0, matte: "depth", ss: 1, resolution: 0.5 },
    { id: "title", scene: titleScene(p, t), time: 0, matte: "depth", ss: 2 },
  ];
  return { passes, overlays: { kicker: kickerSvg(p, t) } };
}

/** Eye depth (along the view axis, as the engine's depth buffer) of the hero card's nearest corner: the focus plane. */
function heroNearDistance(p: DeviceScreenParams, t: number, camera: Mesh3dCamera): number {
  const [cx, cy, cz] = camera.position, view = [camera.target[0] - cx, camera.target[1] - cy, camera.target[2] - cz], length = Math.hypot(view[0], view[1], view[2]);
  const depth = (x: number, y: number, z: number) => ((x - cx) * view[0] + (y - cy) * view[1] + (z - cz) * view[2]) / length;
  const hero = deviceObjects(p, t, true).find(object => object.id === "cardHero");
  if (!hero || hero.geometry.kind !== "box") return depth(0, 1, 0);
  const m = eulerMatrix(hero.pose.rotationDegrees as unknown as Vec3), s = hero.pose.scale[0], hw = (hero.geometry.width * s) / 2, hh = (hero.geometry.height * s) / 2;
  let nearest = Infinity;
  for (const [x, y] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) {
    const c = apply(m, [x, y, 0]);
    nearest = Math.min(nearest, depth(hero.pose.position[0] + c[0], hero.pose.position[1] + c[1], hero.pose.position[2] + c[2]));
  }
  return nearest;
}

function composite(params: Record<string, unknown>, t: number, index: number, layers: StyleCompositeLayersV1, out: RasterV1): void {
  const p = params as unknown as DeviceScreenParams;
  const W = p.width, H = p.height, n = W * H, portrait = H >= W, k = W / 1080, s = Math.min(W, H) / 1080;
  const bg = hexRgb(p.palette.bg), glowC = hexRgb(p.palette.glow), accent = hexRgb(p.palette.accent), accent2 = hexRgb(p.palette.accent2);
  const d = out.data, device = layers.passes.device, refl = layers.passes.reflection, title = layers.passes.title;
  for (let i = 0; i < n; i += 1) { d[i * 3] = bg[0]; d[i * 3 + 1] = bg[1]; d[i * 3 + 2] = bg[2]; }
  // Glow field and core behind the device; it breathes in with the intro.
  const intro = expoOut(clamp01(t / 0.9)), breathe = 1 + 0.04 * Math.sin(t * 2.1);
  const [fx, fy] = portrait ? [W * 0.55, H * 0.43] : [W * 0.72, H * 0.55];
  addRadial(out, fx, fy, portrait ? W * 0.95 : W * 0.55, portrait ? H * 0.42 : H * 0.8, glowC, 0.95 * intro * breathe);
  addRadial(out, fx, fy, portrait ? W * 0.4 : W * 0.22, portrait ? H * 0.17 : H * 0.32, accent, 0.55 * intro * breathe);
  // Light columns (vertical streaks), sliding in.
  const slide = (1 - expoOut(clamp01((t - 0.2) / 0.9))) * 60 * s;
  addStreak(out, (portrait ? W * 0.07 : W * 0.47) - slide, 2 * s, accent2, 0.5 * intro, H * 0.45, H * 0.5);
  addStreak(out, (portrait ? W * 0.935 : W * 0.955) + slide, 1.2 * s, mixRgb(accent2, [1, 1, 1], 0.5), 0.85 * intro, H * 0.45, H * 0.42);
  addStreak(out, (portrait ? W * 0.965 : W * 0.975) + slide, 6 * s, accent, 0.25 * intro, H * 0.45, H * 0.5);
  // Device bottom (lowest covered row) for the reflection fade and the light pool.
  let bottom = 0;
  for (let y = H - 1; y >= 0 && !bottom; y -= 1) for (let x = 0; x < W; x += 4) if (device.alpha[y * W + x] > 0.5) { bottom = y; break; }
  if (!bottom) bottom = Math.round(H * 0.6);
  // Glossy floor: the mirrored-camera pass flipped, blurred and faded below the device.
  const rw = refl.width, rh = refl.height, rc = new Float32Array(n * 3), ra = new Float32Array(n);
  for (let y = 0; y < H; y += 1) {
    const fade = Math.pow(clamp01(1 - (y - (bottom - 40 * k)) / (300 * k)), 1.5) * 0.4 * (y > bottom - 60 * k ? 1 : 0);
    if (fade <= 0) continue;
    const sy = Math.min(rh - 1, Math.floor(((H - 1 - y) * rh) / H));
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(rw - 1, Math.floor((x * rw) / W)), si = sy * rw + sx, o = y * W + x, a = refl.alpha[si] * fade * (1 - device.alpha[o]);
      ra[o] = a; rc[o * 3] = refl.color[si * 3] * fade * (1 - device.alpha[o]); rc[o * 3 + 1] = refl.color[si * 3 + 1] * fade * (1 - device.alpha[o]); rc[o * 3 + 2] = refl.color[si * 3 + 2] * fade * (1 - device.alpha[o]);
    }
  }
  over(out, rgbaFromPlanes(W, H, gaussianBlur(rc, W, H, 3, 2.5 * k), gaussianBlur(ra, W, H, 1, 2.5 * k)), 0.9);
  addRadial(out, W * (portrait ? 0.55 : 0.72), bottom - 20 * k, W * (portrait ? 0.48 : 0.3), 60 * k, mixRgb(accent, accent2, 0.5), 0.35 * intro);
  // Front-of-focus depth of field from the hero card (thin-lens circle of confusion of nearer pixels: the pill card and the
  // deck front soften, the screen and the cards behind stay sharp, as in the style frame), then the soft shadow
  // of the device on the void and the device with its cards (exact matte from the black/white renders).
  const camera = deviceCamera(p, t), focus = heroNearDistance(p, t, camera);
  const coc = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const z = device.depth[i];
    if (Number.isFinite(z)) coc[i] = clamp01((focus / ndcToDistance(z, camera.near, camera.far) - 1) * 24 - 0.05);
  }
  // The largest blur follows the frame's short side (landscape: the same softness as portrait, not 1.8x).
  const focused = depthOfField(device.color, device.alpha, coc, W, H, 2.6 * s);
  darken(out, gaussianBlur(focused.alpha, W, H, 1, 38 * k), 0.55);
  over(out, rgbaFromPlanes(W, H, focused.color, focused.alpha));
  // Tinted bloom: the screen and the white cards glow in the field's colour.
  bloom(out, 0.9, [[10 * k, 0.1], [36 * k, 0.1], [90 * k, 0.09]], mixRgb(accent, accent2, 0.5));
  // Title: an accent glow under the chrome, then the extruded glyphs.
  // (a light accent glows no brighter than the frame's blue: luminance 0.3)
  glow(out, title.alpha, scaleRgb(accent, Math.min(1, 0.3 / Math.max(1e-3, luminance(accent)))), [[10 * k, 0.5], [34 * k, 0.35], [90 * k, 0.25]]);
  over(out, rgbaFromPlanes(W, H, title.color, title.alpha));
  over(out, layers.overlays.kicker);
  bloom(out, 0.93, [[6 * k, 0.12], [24 * k, 0.12], [80 * k, 0.16]]);
  vignette(out, 0.32, 0.78, 0.72, 0.5);
  grain(out, 0.01, 41, index);
}

function preflight(params: Record<string, unknown>): void {
  const p = params as unknown as DeviceScreenParams;
  assertMotionText(p.text.title, TITLE_FACE);
  if (p.text.kicker) assertMotionText(p.text.kicker, labelFace(p.text.kicker));
}

function textures(params: Record<string, unknown>, images: Readonly<Record<string, string>>): Record<string, StyleSvgArtV1> {
  const p = params as unknown as DeviceScreenParams;
  const out: Record<string, StyleSvgArtV1> = { keys: keyboardTexture(p) };
  for (const slot of DEVICE_SCREEN_IMAGE_SLOTS) out[slot] = slotTexture(p, slot, images);
  p.title.glyphs.forEach((glyph, index) => { out[`chrome${index}`] = chromeSlice(p, glyph.top, glyph.bottom); });
  return out;
}

export const deviceScreenCompositeV1: StyleCompositeHooksV1 = { textures, frame: (params, t) => frame(params, t), composite, preflight };

export function deviceScreenImageWindowV1(slotId: string): { w: number; h: number } | undefined {
  const texture = (TEXTURE as Record<string, { w: number; h: number }>)[slotId];
  return texture ? { w: texture.w, h: texture.h } : undefined;
}


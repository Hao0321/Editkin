import { createSvgDocument, fmt, g, rect, roundRect, transform, tf } from "../../motionLibrary/svg/document";
import { clamp01, curve, lerp } from "../../motionLibrary/svg/easing";
import { S1V2 } from "../uiCard/design";
import { uiCardGrid, type UiCardGrid } from "../uiCard/grid";
import {
  cardChromeSvg, chapterChipFrame, easeInOut, fitSize, lowerThirdFrame, toolTagFrame, uiBackdropSvg, UI_CARD_REVISION,
  type CardChromeParams, type UiBackdropParams,
} from "../uiCard/components";
import { svgImageElement, imagePlacement, type SlotImageParams } from "./svgImage";

/**
 * uiCardScene (S1 v2 as an editable template clip): Claude's approved style frames (S1v2_styleframe_A/B) as one clip whose
 * text, accent colours and card picture are slots. Layers, bottom → top:
 *   designed backdrop (a still under the clip, rendered once) · card shadows · the card picture (cover/contain about its
 *   focal point, rounded window, punched in 1.15× on the keyword) · rim light · chapter chip · tool tag (pinned to the card)
 *   · lower-third lockup (lead, then the keyword pops on its beat).
 * Every element is S1 v2's own component (uiCard/components.ts) at the S1 v2 grid (9:16 and 16:9), so the clip looks like
 * the template applied to a whole video. Pure in (params, t); the picture arrives as a data URI resource whose bytes the
 * params identify by sha256.
 */

export const UI_CARD_SCENE_REVISION = 1;

export interface UiCardSceneParams {
  readonly component: "uiCardScene";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  /** Clip length (s) = frameCount / fps. */
  readonly duration: number;
  readonly accent: string;
  readonly ink: string;
  /** Tag text on the accent plate: the ink when it reads (≥ 4.5:1), else the derived contrast colour. */
  readonly onAccent: string;
  readonly text: { readonly chapterNumber?: string; readonly chapterLabel?: string; readonly lead?: string; readonly keyword: string; readonly tag?: string };
  /** The card picture (slot `card`); absent → the placeholder. */
  readonly image?: SlotImageParams;
  readonly placeholder: "ui_panel" | "none";
  readonly backdropSeed: number;
  /** Local times (s). */
  readonly timing: { readonly cardIn: number; readonly tagAt: number; readonly leadAt: number; readonly keywordAt: number; readonly exitAt: number };
}

export interface UiCardSceneResources {
  /** data:image/png|jpeg;base64,… of the picture params.image names. */
  readonly image?: string;
  /** data:image/png of the card shadow still (uiCardSceneShadowStill), rendered once; absent → the live blur (same design, slower). */
  readonly cardShadow?: string;
  /** Draw the backdrop inside the frame (previews, contact sheets); the clip renderer lays it under as a still instead. */
  readonly includeBackdrop?: boolean;
}

/** The card window (px) for an output frame. */
export function uiCardSceneWindow(width: number, height: number): { x: number; y: number; w: number; h: number; radius: number; grid: UiCardGrid } {
  const grid = uiCardGrid(width, height);
  return { x: grid.card.x, y: grid.card.squareY, w: grid.card.w, h: grid.card.squareH, radius: S1V2.card.radius * grid.s, grid };
}

/** The backdrop still under the clip (the S1 v2 backdrop: charcoal, warm key, cool fill, vignette, grain). */
export function uiCardSceneBackdrop(params: UiCardSceneParams): UiBackdropParams {
  return { component: "uiBackdrop", revision: UI_CARD_REVISION, width: params.width, height: params.height, seed: params.backdropSeed };
}

function cardChrome(params: Pick<UiCardSceneParams, "width" | "height">) {
  const win = uiCardSceneWindow(params.width, params.height), s = win.grid.s;
  return { win, s, shadows: S1V2.card.shadows.map(shadow => ({ blur: shadow.blur * s, dy: shadow.dy * s, alpha: shadow.alpha })),
    rim: { width: S1V2.card.rim.width * s, alpha: S1V2.card.rim.alpha } };
}

/**
 * The card's layered shadows as one still (two large Gaussian blurs are most of a frame's raster time): rendered once at
 * the size of its own bounds and laid under the card with the card's pose. `x`, `y` place it in the frame.
 */
export function uiCardSceneShadowStill(params: Pick<UiCardSceneParams, "width" | "height">): { params: CardChromeParams; x: number; y: number } {
  const { win, shadows, rim } = cardChrome(params);
  const reach = Math.max(...shadows.map(shadow => shadow.blur * 3 + 2 + shadow.dy)) + 2;
  const x = Math.floor(win.x - reach), y = Math.floor(win.y - reach);
  const even = (value: number) => 2 * Math.ceil(value / 2);
  return { x, y, params: { component: "cardChrome", revision: UI_CARD_REVISION, part: "under", width: even(win.w + 2 * reach + (win.x - reach - x)), height: even(win.h + 2 * reach + (win.y - reach - y)),
    rect: { x: win.x - x, y: win.y - y, w: win.w, h: win.h }, radius: win.radius, shadows, rim } };
}

/** Default timing for a clip of `duration` seconds (≥ 2.2 s: the keyword holds ≥ 1.1 s before the 0.35 s exit). */
export function uiCardSceneTiming(duration: number): UiCardSceneParams["timing"] {
  return { cardIn: 0.05, tagAt: 0.35, leadAt: 0.3, keywordAt: 0.75, exitAt: Math.max(1.85, Math.round((duration - 0.35) * 1000) / 1000) };
}

/** Card pose at local t: slide up + fade in, settle + fade out (S1 v2 motion tokens). */
export function uiCardScenePose(params: UiCardSceneParams, t: number): { dy: number; scale: number; opacity: number } {
  const m = S1V2.motion, s = uiCardGrid(params.width, params.height).s;
  const e = curve("expoOut", clamp01((t - params.timing.cardIn) / m.enter));
  const x = clamp01((t - params.timing.exitAt) / m.exit);
  return { dy: (1 - e) * m.enterDy * s, scale: lerp(1, m.exitScale, easeInOut(x)), opacity: e * (1 - curve("snapIn", x)) };
}

/** Punch-in of the picture on the keyword (1.15×: 0.35 s attack, 0.85 s hold, 0.6 s release), never past the exit. */
export function uiCardScenePunch(params: UiCardSceneParams, t: number): number {
  const p = S1V2.motion.punch, k = t - params.timing.keywordAt;
  if (k <= 0) return 1;
  const release = Math.min(params.timing.keywordAt + p.attack + p.hold, params.timing.exitAt);
  if (t < release) return lerp(1, p.scale, curve("expoOut", clamp01(k / p.attack)));
  const peak = lerp(1, p.scale, curve("expoOut", clamp01((release - params.timing.keywordAt) / p.attack)));
  return lerp(peak, 1, easeInOut(clamp01((t - release) / p.release)));
}

function placeholderPanel(x: number, y: number, w: number, h: number, s: number): string {
  // A drawn UI panel (S1's fallback when there is no screenshot): top bar, sidebar, three content rows.
  const pad = 28 * s, bar = Math.max(24 * s, h * 0.09), side = w * 0.22, row = (h - bar - 4 * pad) / 3;
  return g(undefined,
    rect(x, y, w, h, { fill: "#161A22" }),
    rect(x, y, w, bar, { fill: "#FFFFFF", "fill-opacity": 0.06 }),
    roundRect(x + pad, y + bar + pad, side - pad, h - bar - 2 * pad, 14 * s, { fill: "#FFFFFF", "fill-opacity": 0.045 }),
    ...[0, 1, 2].map(index => roundRect(x + side + pad, y + bar + pad + index * (row + pad), w - side - 2 * pad, row, 16 * s, { fill: "#FFFFFF", "fill-opacity": index === 0 ? 0.09 : 0.06 })));
}

export function uiCardSceneFrame(params: UiCardSceneParams, t: number, resources: UiCardSceneResources = {}): string {
  const { width: W, height: H } = params;
  const win = uiCardSceneWindow(W, H), grid = win.grid, s = grid.s;
  const doc = createSvgDocument({ width: W, height: H }, { idPrefix: "uc" });
  const layers: string[] = [];
  if (resources.includeBackdrop) layers.push(uiBackdropSvg(uiCardSceneBackdrop(params)));

  // Card: shadows, picture, rim — all under one pose.
  const pose = uiCardScenePose(params, t);
  const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
  const poseTransform = transform(tf.translate(0, pose.dy), pose.scale !== 1 ? tf.translate(cx, cy) : false, pose.scale !== 1 ? tf.scale(pose.scale) : false,
    pose.scale !== 1 ? tf.translate(-cx, -cy) : false);
  if (pose.opacity > 0.001) {
    const { shadows, rim } = cardChrome(params);
    const chrome = { width: W, height: H, rect: { x: win.x, y: win.y, w: win.w, h: win.h }, radius: win.radius, shadows, rim };
    const still = resources.cardShadow ? uiCardSceneShadowStill(params) : undefined;
    const under = still && resources.cardShadow ? svgImageElement(resources.cardShadow, still.x, still.y, still.params.width, still.params.height)
      : cardChromeSvg({ component: "cardChrome", revision: UI_CARD_REVISION, part: "under", ...chrome });
    const over = cardChromeSvg({ component: "cardChrome", revision: UI_CARD_REVISION, part: "over", ...chrome });
    const clip = doc.clipPath(roundRect(win.x, win.y, win.w, win.h, win.radius));
    let content: string;
    if (params.image && resources.image) {
      // The keyword punch-in zooms a covering picture; a contained one stays whole (contain promises the full picture).
      const placed = imagePlacement(params.image, { w: win.w, h: win.h }, params.image.fit === "cover" ? uiCardScenePunch(params, t) : 1);
      content = g(undefined, params.image.fit === "contain" ? rect(win.x, win.y, win.w, win.h, { fill: "#0B0D12" }) : "",
        svgImageElement(resources.image, win.x + placed.x, win.y + placed.y, placed.w, placed.h));
    } else if (params.image) {
      throw new Error("uiCardScene: the card picture's bytes were not supplied");
    } else {
      content = params.placeholder === "ui_panel" ? placeholderPanel(win.x, win.y, win.w, win.h, s) : rect(win.x, win.y, win.w, win.h, { fill: "#161A22" });
    }
    layers.push(g({ transform: poseTransform, opacity: pose.opacity < 0.999 ? Number(fmt(pose.opacity, 3)) : undefined }, under, g({ "clip-path": clip }, content), over));
  }

  // Chapter chip (only with a number or a title).
  const text = params.text;
  if (text.chapterNumber || text.chapterLabel) {
    layers.push(chapterChipFrame({ component: "chapterChip", revision: UI_CARD_REVISION, width: W, height: H, number: text.chapterNumber ?? "", label: text.chapterLabel ?? "",
      accent: params.accent, duration: params.duration, exitAt: params.timing.exitAt, scale: s, cx: grid.chip.cx, y: grid.chip.y }, t));
  }
  // Tool tag pinned to the card's top-left edge, moving and fading with it.
  if (text.tag && t >= params.timing.tagAt) {
    layers.push(toolTagFrame({ component: "toolTag", revision: UI_CARD_REVISION, width: W, height: H, text: text.tag, accent: params.accent, ink: params.onAccent,
      x: win.x + S1V2.tag.dx * s, y: win.y + S1V2.tag.dy * s, duration: params.duration - params.timing.tagAt, exitAt: params.timing.exitAt - params.timing.tagAt,
      follow: [{ t: 0, dx: 0, dy: pose.dy, opacity: pose.opacity }], scale: s },
    t - params.timing.tagAt));
  }
  // Lower-third lockup: the lead lands, the keyword pops on its beat (≥ 1.1 s hold), both leave before the clip ends.
  if (t >= params.timing.leadAt) {
    const L = S1V2.lower, display = (weight: number) => ({ font: "display" as const, weight });
    const lead = text.lead ?? "";
    const leadSize = lead ? fitSize(lead, display(L.lead.weight), L.lead.size * s, L.lead.tracking, grid.lower.lockupMaxWidth) : L.lead.size * s;
    const keywordSize = fitSize(text.keyword, display(L.keyword.weight), L.keyword.size * s, L.keyword.tracking, grid.lower.lockupMaxWidth);
    layers.push(lowerThirdFrame({ component: "lowerThird", revision: UI_CARD_REVISION, width: W, height: H, duration: params.duration - params.timing.leadAt,
      exitAt: params.timing.exitAt - params.timing.leadAt, accent: params.accent, ink: params.ink,
      content: { mode: "lockup", lead, leadSize, keyword: text.keyword, keywordSize, keywordAt: params.timing.keywordAt - params.timing.leadAt }, scale: s,
      at: { subtitleCx: grid.lower.subtitleCx, subtitleY: grid.lower.subtitleY, lockupCx: grid.lower.lockupCx, leadY: grid.lower.leadY, keywordY: grid.lower.keywordY, stepsY: grid.lower.stepsY } },
    t - params.timing.leadAt));
  }
  return doc.render(...layers);
}

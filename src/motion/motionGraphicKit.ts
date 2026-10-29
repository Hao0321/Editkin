import type { EditProject, MotionGraphic, MotionGraphicV2Motion } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "./composition";
import { motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt, type MotionGraphicV2LayoutReceipt } from "./compositionV2";
import { canonicalJson } from "../shared/canonicalJson";
import { resolveBundledFontFace } from "../typography/fontFaces";
import type { PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { MOTION_CURVES, kineticTextMotion, type KineticTextStyle, type MotionEnergy } from "./motionLanguage";

/**
 * Native Motion Graphic Kit: Editkin translations of Hao's approved original CSS
 * study (design-lab/yui-game-css-20261001) — a bright blue-white board with a
 * fine grid, kicker + drawn rule, cascading headline, chat bubbles that pop and
 * then type, chips, cards and bloom ripples. Every element is an ordinary
 * editable text or vector MotionGraphic driven by Motion Language curves, so the
 * SVG preview, ASS export and saved projects need no new renderer.
 */
export const MOTION_GRAPHIC_KIT_VERSION = "hao.motion-graphic-kit/v1" as const;

export interface MotionKitPalette {
  primary: string; onPrimary: string; background: string; ink: string;
  muted: string; surface: string; line: string; grid: string; tint: string;
}

/** Editkin 藍白 — the study's default roles; callers may pass a brand palette. */
export const EDITKIN_BLUE_WHITE: MotionKitPalette = Object.freeze({
  primary: "#2855EE", onPrimary: "#FFFFFF", background: "#F8FAFF", ink: "#22345A",
  muted: "#5B6678", surface: "#FFFFFF", line: "#D8DEE8", grid: "#527BEA", tint: "#E8EEFF",
});

export type MotionKitElement =
  | { kind: "board"; grid?: boolean }
  | { kind: "kicker"; text: string; x: number; y: number; rule?: boolean }
  | { kind: "headline"; text: string; x: number; y: number; width: number; size?: number; style?: KineticTextStyle; align?: "left" | "center" }
  | { kind: "body"; text: string; x: number; y: number; width: number; size?: number; align?: "left" | "center" }
  | { kind: "bubble"; text: string; x: number; y: number; role: "ask" | "reply"; size?: number }
  | { kind: "chip"; text: string; x: number; y: number; size?: number }
  | { kind: "card"; title: string; body?: string; x: number; y: number; width: number }
  | { kind: "ripple"; x: number; y: number; radius?: number };

export interface MotionKitScene {
  id: string;
  startFrame: number;
  durationFrames: number;
  /** Elements in back-to-front order; `at` is seconds after the scene starts. */
  elements: Array<MotionKitElement & { at: number }>;
  palette?: MotionKitPalette;
  energy?: MotionEnergy;
  fontFamily?: string;
}

export interface MotionKitOptions {
  /** Physical glyph layout (exact box sizes); estimated layout when omitted. */
  layoutForGraphic?: (graphic: MotionGraphic) => MotionGraphicV2LayoutReceipt;
}

const KIT_SAFE = { top: .03, right: .03, bottom: .03, left: .03 };
const FULL_FRAME = { top: 0, right: 0, bottom: 0, left: 0 };
const alpha = (color: string, opacity: number) => `${color.slice(0, 7)}${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0").toUpperCase()}`;

/** Exits clear quickly in reverse build order; the board leaves last. */
const EXIT_STEP_FRAMES = 2;

export function compileMotionGraphicKit(project: EditProject, scene: MotionKitScene, options: MotionKitOptions = {}): MotionGraphic[] {
  const { fps, width: W, height: H } = project;
  if (!Number.isInteger(scene.startFrame) || scene.startFrame < 0 || !Number.isInteger(scene.durationFrames) || scene.durationFrames < Math.ceil(fps)) {
    throw new Error("Motion Graphic Kit 需要整數起點與至少 1 秒的場景");
  }
  if (!scene.elements.length || scene.elements.length > 24) throw new Error("Motion Graphic Kit 每場景需要 1–24 個元素");
  const palette = scene.palette ?? EDITKIN_BLUE_WHITE, energy = scene.energy ?? "standard";
  const unit = Math.min(W, H) / 1080, family = scene.fontFamily ?? "Noto Sans TC";
  const graphics: MotionGraphic[] = [];
  const layoutOf = (graphic: MotionGraphic) => options.layoutForGraphic?.(graphic) ?? motionGraphicV2LayoutReceipt(project, graphic);
  // Last in, first out: later elements clear first and the board (index 0) leaves last.
  const exitOffset = (index: number) => index * EXIT_STEP_FRAMES;

  function window(index: number, at: number, extraExit = 0) {
    const start = scene.startFrame + Math.round(at * fps);
    const end = scene.startFrame + scene.durationFrames - exitOffset(index) - extraExit;
    if (end - start < Math.ceil(fps * .8)) throw new Error(`Motion Graphic Kit 元素 ${index + 1} 沒有留下至少 0.8 秒閱讀時間`);
    return { start, end };
  }
  function base(id: string, presetId: string, text: string, start: number, end: number, fields: Partial<MotionGraphic>): MotionGraphic {
    const graphic = { ...createMotionGraphic(`${scene.id}:${id}`, "title", text, start / fps, (end - start) / fps, undefined, structuredClone(findMotionGraphicPreset(presetId).seed)), ...fields };
    delete (graphic as Partial<MotionGraphic>).presetId; // composed kit styling is not a registered stock seed
    return graphic;
  }
  function textGraphic(id: string, text: string, start: number, end: number, fields: Partial<MotionGraphic> & { motionV2: MotionGraphicV2Motion }): MotionGraphic {
    return base(id, "kinetic_rise", text, start, end, { fontFamily: family, backgroundColor: "#00000000", accentColor: "#00000000",
      outlineWidth: 0, shadowDepth: 0, cornerRadius: 0, letterSpacing: 0, ...fields,
      layoutV2: { safeArea: KIT_SAFE, maxLines: 2, minFontSize: Math.max(8, (fields.fontSize ?? 40) * .6), lineGap: 8 * unit, align: "left", widthMode: "fit_content", ...fields.layoutV2 } });
  }
  // Decorative shapes are measured from their text, so a safe-area clamp would
  // only misalign them; the text layers above keep the readable safe area.
  function vector(id: string, presetId: string, start: number, end: number, fields: Partial<MotionGraphic>): MotionGraphic {
    return base(id, presetId, "", start, end, { layoutV2: { safeArea: FULL_FRAME, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" }, ...fields });
  }
  const still = (frames = 1): MotionGraphicV2Motion => ({ sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: frames, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: MOTION_CURVES.quintOut },
    exit: { durationFrames: Math.max(1, Math.round(.27 * fps)), offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: MOTION_CURVES.snapIn } });
  /** A shape that lands: centered scale pop with a visible spring settle. */
  const pop = (from: number, frames: number, rise = 0): MotionGraphicV2Motion => ({ sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: frames, offsetXPixels: 0, offsetYPixels: rise, scale: from, opacity: 0, easing: energy === "calm" ? MOTION_CURVES.backOutSoft : MOTION_CURVES.springSnappy },
    exit: { durationFrames: Math.max(1, Math.round(.23 * fps)), offsetXPixels: 0, offsetYPixels: 0, scale: .92, opacity: 0, easing: MOTION_CURVES.snapIn } });
  /** Character-by-character typing inside a landed bubble or chip. */
  const typing = (text: string): MotionGraphicV2Motion => ({ sequence: { unit: "character", order: "forward", exitOrder: "forward",
    staggerFrames: Math.max(1, Math.min(2, Math.floor(Math.round(.6 * fps) / Math.max(1, [...text].length - 1)))), exitStaggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: 3, offsetXPixels: 0, offsetYPixels: 6 * unit, scale: .9, opacity: 0, easing: MOTION_CURVES.expoOut },
    exit: { durationFrames: Math.max(1, Math.round(.2 * fps)), offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: MOTION_CURVES.snapIn } });
  /** Shift a left-aligned text so its ink, not its padded box, starts at x. */
  const inkAligned = (graphic: MotionGraphic, x: number) => { graphic.x = x - layoutOf(graphic).padding / W; return graphic; };
  /** Panel exactly behind a measured text box, plus breathing room. */
  const behind = (layout: MotionGraphicV2LayoutReceipt, padX: number, padY: number) => ({
    x: (layout.box.x - padX) / W, y: (layout.box.y - padY) / H, width: (layout.box.width + padX * 2) / W, height: layout.box.height + padY * 2 });

  scene.elements.forEach((element, index) => {
    const id = `${index}-${element.kind}`;
    if (element.kind === "board") {
      const { start, end } = window(index, element.at);
      graphics.push(vector(`${id}:surface`, "reel_native_panel", start, end, { x: 0, y: 0, width: 1, cornerRadius: 0, outlineWidth: 0,
        backgroundColor: palette.background, accentColor: palette.background, motionV2: still(Math.max(1, Math.round(.2 * fps))),
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: H, revealFrames: 1 },
        layoutV2: { safeArea: FULL_FRAME, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" } }));
      if (element.grid !== false) graphics.push(vector(`${id}:grid`, "reel_line_grid", start, end, { x: 0, y: 0, width: 1,
        accentColor: alpha(palette.grid, .22), textColor: alpha(palette.grid, .1), motionV2: still(Math.max(1, Math.round(.33 * fps))),
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "line_grid", heightPixels: H, revealFrames: 1,
          spacingPixels: Math.round(48 * unit), lineWidthPixels: Math.max(.5, unit), majorEvery: 4 },
        layoutV2: { safeArea: FULL_FRAME, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" } }));
      return;
    }
    const { start, end } = window(index, element.at);
    if (element.kind === "kicker") {
      const text = inkAligned(textGraphic(id, element.text, start, end, { x: element.x, y: element.y, width: .6, fontSize: 30 * unit, fontWeight: 800,
        letterSpacing: 5 * unit, textColor: palette.primary, layoutV2: { safeArea: KIT_SAFE, maxLines: 1, minFontSize: 16 * unit, lineGap: 0, align: "left", widthMode: "fit_content" },
        motionV2: kineticTextMotion("swipe", { fps, unit, energy: "calm", text: element.text }) }), element.x);
      graphics.push(text);
      if (element.rule !== false) {
        const box = layoutOf(text).box, ruleWidth = 96 * unit;
        graphics.push(vector(`${id}:rule`, "reel_rule_reveal", start + Math.round(.12 * fps), end, { x: (box.x + box.width + 14 * unit) / W,
          y: (box.y + box.height / 2 - unit) / H, width: ruleWidth / W, accentColor: alpha(palette.primary, .55), cornerRadius: 0,
          motionV2: still(), vectorV2: { schema: "editkin.motion-vector/v1", kind: "rule", heightPixels: Math.max(1, 2 * unit), revealFrames: Math.round(.4 * fps) } }));
      }
      return;
    }
    if (element.kind === "headline" || element.kind === "body") {
      const headline = element.kind === "headline";
      const graphic = textGraphic(id, element.text, start, end, { x: element.x, y: element.y, width: element.width,
        fontSize: (element.size ?? (headline ? 112 : 40)) * unit, fontWeight: headline ? 900 : 500, textColor: headline ? palette.ink : palette.muted,
        layoutV2: { safeArea: KIT_SAFE, maxLines: 2, minFontSize: (headline ? 56 : 24) * unit, lineGap: (headline ? 10 : 8) * unit, align: element.align ?? "left", widthMode: "fixed" },
        motionV2: kineticTextMotion(headline ? element.style ?? "rise" : "focus", { fps, unit, energy, text: element.text }) });
      graphics.push((element.align ?? "left") === "left" ? inkAligned(graphic, element.x) : graphic);
      return;
    }
    if (element.kind === "bubble" || element.kind === "chip") {
      const ask = element.kind === "chip" || element.role === "ask";
      const size = (element.size ?? (element.kind === "chip" ? 30 : 46)) * unit;
      const land = Math.round(.3 * fps);
      // element.x / y place the shape's top-left corner; the text sits inside its padding.
      const padX = element.kind === "chip" ? 6 * unit : 14 * unit, padY = element.kind === "chip" ? 2 * unit : 8 * unit;
      const text = textGraphic(id, element.text, start + land, end, { x: element.x + padX / W, y: element.y + padY / H, width: .9 - element.x, fontSize: size,
        fontWeight: element.kind === "chip" ? 800 : 700, textColor: element.kind === "chip" ? palette.primary : ask ? palette.onPrimary : palette.ink,
        letterSpacing: element.kind === "chip" ? 2 * unit : 0,
        layoutV2: { safeArea: KIT_SAFE, maxLines: 1, minFontSize: 16 * unit, lineGap: 0, align: "left", widthMode: "fit_content" }, motionV2: typing(element.text) });
      const layout = layoutOf(text);
      const panel = behind(layout, padX, padY);
      graphics.push(vector(`${id}:panel`, "reel_native_panel", start, end, { x: panel.x, y: panel.y, width: panel.width,
        cornerRadius: element.kind === "chip" ? panel.height / 2 : 26 * unit,
        backgroundColor: element.kind === "chip" ? palette.tint : ask ? palette.primary : palette.surface,
        outlineWidth: ask ? 0 : Math.max(1, 2 * unit), accentColor: palette.line,
        motionV2: pop(element.kind === "chip" ? .7 : .55, Math.round(.47 * fps), 10 * unit),
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: panel.height, revealFrames: 1 } }));
      graphics.push(text);
      return;
    }
    if (element.kind === "card") {
      const titleStart = start + Math.round(.2 * fps);
      const inset = element.x + 28 * unit / W;
      const title = textGraphic(`${id}:title`, element.title, titleStart, end, { x: inset, y: element.y + 26 * unit / H,
        width: element.width - 56 * unit / W, fontSize: 40 * unit, fontWeight: 800, textColor: palette.ink,
        layoutV2: { safeArea: KIT_SAFE, maxLines: 1, minFontSize: 20 * unit, lineGap: 0, align: "left", widthMode: "fixed" },
        motionV2: kineticTextMotion("rise", { fps, unit, energy: "calm", text: element.title }) });
      inkAligned(title, inset);
      const titleBox = layoutOf(title).box;
      const body = element.body ? textGraphic(`${id}:body`, element.body, titleStart + Math.round(.2 * fps), end, { x: element.x + 28 * unit / W,
        y: (titleBox.y + titleBox.height + 4 * unit) / H, width: element.width - 56 * unit / W, fontSize: 30 * unit, fontWeight: 500, textColor: palette.muted,
        layoutV2: { safeArea: KIT_SAFE, maxLines: 2, minFontSize: 18 * unit, lineGap: 6 * unit, align: "left", widthMode: "fixed" },
        motionV2: kineticTextMotion("focus", { fps, unit, energy: "calm", text: element.body }) }) : undefined;
      if (body) inkAligned(body, inset);
      const bottom = body ? layoutOf(body).box : titleBox;
      const height = bottom.y + bottom.height + 24 * unit - element.y * H;
      graphics.push(vector(`${id}:panel`, "reel_native_panel", start, end, { x: element.x, y: element.y, width: element.width,
        cornerRadius: 24 * unit, backgroundColor: palette.surface, outlineWidth: Math.max(1, 2 * unit), accentColor: palette.line,
        motionV2: { ...pop(.94, Math.round(.5 * fps), 40 * unit), entrance: { ...pop(.94, Math.round(.5 * fps), 40 * unit).entrance, easing: MOTION_CURVES.expoOut } },
        vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: height, revealFrames: 1 } }));
      graphics.push(title);
      if (body) graphics.push(body);
      return;
    }
    // ripple: a soft bloom that clears, then a solid core that stays
    const radius = (element.radius ?? 54) * unit;
    graphics.push(vector(`${id}:bloom`, "reel_native_disc", start, Math.min(end, start + Math.round(.9 * fps)), {
      x: (element.x * W - radius) / W, y: (element.y * H - radius) / H, width: radius * 2 / W, backgroundColor: alpha(palette.primary, .22),
      motionV2: { sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, scaleOrigin: "center" },
        entrance: { durationFrames: Math.round(.2 * fps), offsetXPixels: 0, offsetYPixels: 0, scale: .2, opacity: 0, easing: MOTION_CURVES.expoOut },
        exit: { durationFrames: Math.round(.5 * fps), offsetXPixels: 0, offsetYPixels: 0, scale: 2.2, opacity: 0, easing: MOTION_CURVES.quintOut } },
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: radius * 2, revealFrames: 1 } }));
    const core = 9 * unit;
    graphics.push(vector(`${id}:core`, "reel_native_disc", start, end, { x: (element.x * W - core) / W, y: (element.y * H - core) / H,
      width: core * 2 / W, backgroundColor: palette.primary, motionV2: pop(.2, Math.round(.4 * fps)),
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "ellipse", heightPixels: core * 2, revealFrames: 1 } }));
  });
  return graphics;
}

/**
 * Exact compile: prepares every kit text with the caller's physical glyph
 * provider (the same one reference templates use), so bubbles, chips and cards
 * are sized from true ink advances rather than estimates.
 */
export async function prepareMotionGraphicKit(project: EditProject, scene: MotionKitScene,
  prepareText: (faceId: string, text: string) => Promise<PreparedGlyphRun>): Promise<MotionGraphic[]> {
  const runs = new Map<string, PreparedGlyphRun>();
  for (const { text, fontFamily, fontWeight } of motionGraphicKitTexts(scene)) {
    const face = resolveBundledFontFace(fontFamily, fontWeight);
    if (!face) throw new Error(`FONT_BYTES_REQUIRED: ${fontFamily} ${fontWeight}`);
    const key = canonicalJson([face.faceId, text]);
    if (!runs.has(key)) runs.set(key, await prepareText(face.faceId, text));
  }
  return compileMotionGraphicKit(project, scene, { layoutForGraphic: graphic => {
    const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
    const run = face && runs.get(canonicalJson([face.faceId, graphic.text]));
    if (!run) throw new Error(`Motion Graphic Kit 缺少實體字形：${graphic.text}`);
    return motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
  } });
}

/** Texts whose physical glyph runs must be prepared before an exact compile. */
export function motionGraphicKitTexts(scene: MotionKitScene): Array<{ text: string; fontFamily: string; fontWeight: number }> {
  const family = scene.fontFamily ?? "Noto Sans TC";
  return scene.elements.flatMap(element => {
    if (element.kind === "kicker") return [{ text: element.text, fontFamily: family, fontWeight: 800 }];
    if (element.kind === "headline") return [{ text: element.text, fontFamily: family, fontWeight: 900 }];
    if (element.kind === "body") return [{ text: element.text, fontFamily: family, fontWeight: 500 }];
    if (element.kind === "bubble") return [{ text: element.text, fontFamily: family, fontWeight: 700 }];
    if (element.kind === "chip") return [{ text: element.text, fontFamily: family, fontWeight: 800 }];
    if (element.kind === "card") return [{ text: element.title, fontFamily: family, fontWeight: 800 },
      ...(element.body ? [{ text: element.body, fontFamily: family, fontWeight: 500 }] : [])];
    return [];
  });
}

// Genre design themes for every reference-motion family (Hao 2026-10-07: 「把每個主題做成一種模板」).
// One shared family grammar — measured physical type, reading holds, real footage in themed image blocks — and a complete
// visual and motion language per genre (swiss_blue formal, trip_pop lively, tech_spec sleek, game_hud energetic). Every
// colour comes from the editable palette (「要記得做到能讓用戶自由改色」); every element is an editable v2 vector,
// physical-glyph line or clip keyframe.
import type { z } from "zod";
import type { EditorCommand } from "../domain/commandTypes";
import { motionGraphicV2ExitStaggerFrames, motionGraphicV2UnitCount } from "../domain/motionCompositionV2Contract";
import type { MotionSceneStyle } from "../domain/motionSceneStyle";
import type { MotionPresetVariant } from "../domain/schema";
import type { ClipLayout, EditProject, KeyframeEasing, MediaAsset, MotionGraphic, MotionVectorShapeCommand, NormalizedRect, TimelineClip, Transform2D } from "../domain/types";
import { CONNECTION_FIELD_GROUP_CENTERS } from "../motion/connectionField";
import { MOTION_CURVES } from "../motion/motionLanguage";
import { REFERENCE_MOTION_DESIGN_CONTRACT, REFERENCE_MOTION_DESIGN_THEMES, designThemeDefaultStyle, type ReferenceMotionDesignSystem,
  type referenceMotionTemplateInputSchema } from "../motion/referenceMotionTemplates";
import { numberKit, SCENE_FAMILY_IDS, SCENE_LAYOUTS } from "./referenceMotionDesignScenes";
import { launchKit, reelKit } from "./referenceMotionDesignStyles";

type Overrides = MotionPresetVariant["overrides"];
export type DesignMotion = NonNullable<MotionGraphic["motionV2"]>;
export type Easing = DesignMotion["entrance"]["easing"];
export type DesignInput = z.output<typeof referenceMotionTemplateInputSchema>;
export interface DesignType { size: number; weight: number; color: string; family?: string; tracking?: number; align?: "left" | "center" | "right"; maxLines?: number }
export interface DesignInk { left: number; right: number; top: number; bottom: number }
export interface DesignMask { shape: "rounded" | "arch" | "chamfer"; radiusPixels?: number }
export interface DesignKeyframe { key: string; frame: number; transform?: Partial<Transform2D>; easing?: KeyframeEasing }
interface ShapeExtra { softness?: number; motionV2?: DesignMotion; revealFrom?: "left" | "right" | "top" | "bottom"; revealFrames?: number; overText?: boolean; underMedia?: boolean }
export interface Rect { x: number; y: number; w: number; h: number }
export type Surface = "light" | "bold";
export type Family = DesignInput["templateId"];
export type Shape = MotionVectorShapeCommand[];
/** A narrative beat the template declares where its roles are drawn (one-tool Short, M1 design §5.1). */
export interface DesignBeat {
  id: string;
  narrativeRole: "promise" | "build" | "proof" | "reveal" | "payoff";
  designRole: "first_frame" | "proof" | "process" | "comparison" | "payoff";
  /** Template-local, offset by input.startFrame exactly like phase(). */
  startFrame: number;
  /** The beat opens with the hold phase declared at startFrame: when the cadence settles that hold later, the beat follows it. */
  atHold?: true;
}

/** Compiler seams handed to the design themes; nothing here reads files or applies commands. */
export interface DesignContext {
  project: EditProject; input: DesignInput; fps: number; portrait: boolean; unit: number;
  sources: ReadonlyArray<{ assetId: string; sourceStart: number; label: string }>; sourceAssets: readonly MediaAsset[];
  original: TimelineClip; mainAsset: MediaAsset;
  readingFrames(text: string): number;
  add(role: string, presetId: string, text: string, overrides: Overrides, start?: number, end?: number): MotionGraphic;
  place(index: number, region: NormalizedRect, role: string, clone?: boolean, focus?: NormalizedRect, key?: string, mask?: DesignMask): { clip: TimelineClip; layout: ClipLayout };
  animate(role: string, clip: TimelineClip, points: DesignKeyframe[]): void;
  phase(role: "reveal" | "hold" | "focus" | "return", start: number, end: number): void;
  /** Opens a narrative beat: every role drawn from here on belongs to it (roles drawn before the first beat join the first). */
  beat(spec: DesignBeat): void;
  /** Draws into an already declared beat without changing any timing, then returns to the current beat. */
  withBeat<T>(id: string, draw: () => T): T;
  push(command: EditorCommand): void;
  line(role: string, text: string, spec: DesignType, x: number, width: number, inkTop: number, motionV2: DesignMotion, start: number, end: number,
    extra?: { clip?: Rect; flash?: boolean }): MotionGraphic;
  /** Count-up: the number climbs from zero in two-frame steps, then the final text holds (last graphic). */
  count(role: string, text: string, spec: DesignType, x: number, width: number, inkTop: number, motionV2: DesignMotion, start: number, end: number,
    steps?: number, from?: number): MotionGraphic[];
  /** A self-drawing centerline in canvas pixels (donut arc, chart line, underline, route). */
  stroke(role: string, commands: Shape, color: string, start: number, end: number, extra: { width: number; revealFrames: number; from?: number; to?: number;
    tip?: number; tipColor?: string; cap?: "round" | "butt"; overText?: boolean; underMedia?: boolean; softness?: number; motionV2?: DesignMotion }): MotionGraphic;
  /** A block in several colour runs. `heldFrom`: every piece is on screen from that frame, and a piece whose turn in the
   * per-character cascade comes later holds its first pose until then (the block still lands in reading order). */
  inline(role: string, runs: Array<{ text: string; color: string }>, spec: DesignType, x: number, width: number, inkTop: number,
    motionFor: (text: string) => DesignMotion, start: number, end: number,
    extra?: { clipLines?: { padX: number; padTop: number; padBottom: number }; runStarts?: number[]; heldFrom?: number }): MotionGraphic[];
  /** Ink of a block laid out at [x, x + width] with its first ink on 0: absolute left/right, total ink height. */
  measure(text: string, spec: DesignType, x: number, width: number): { left: number; right: number; height: number };
  /** Visible glyphs per visual line when the block wraps in [x, x + width]. */
  measureLines(text: string, spec: DesignType, x: number, width: number): number[];
  ink(graphic: MotionGraphic): DesignInk;
  inkLines(graphic: MotionGraphic): DesignInk[];
  panel(role: string, x: number, y: number, w: number, h: number, radius: number, color: string, layer: "background" | "foreground", start: number, end: number,
    extra?: { softness?: number; motionV2?: DesignMotion; ellipse?: boolean }): MotionGraphic;
  shape(role: string, commands: Shape, color: string, layer: "background" | "foreground", start: number, end: number, extra?: ShapeExtra): MotionGraphic;
  still(): DesignMotion;
  roundedRect(x: number, y: number, w: number, h: number, radius: number, clockwise?: boolean): Shape;
  rotateCommands(commands: Shape, cx: number, cy: number, degrees: number): Shape;
  sourceLayout(asset: MediaAsset, region: NormalizedRect): ClipLayout;
}

// ---- Colour ------------------------------------------------------------------------------------------------------
const rgb = (value: string) => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
const hex = (values: number[]) => `#${values.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
function contrastOf(a: string, b: string) {
  const luminance = (value: string) => { const [r, g, bl] = rgb(value).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return r * .2126 + g * .7152 + bl * .0722; };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
const readableOn = (value: string, ground: string, toward: string, ratio = 3) => {
  let result = value;
  for (let step = 1; contrastOf(result, ground) < ratio && step <= 10; step++) result = mix(value, toward, step / 10);
  return result;
};
/** Every colour a theme uses, derived from the five editable palette roles. */
export function designThemeColors(palette: MotionSceneStyle["palette"]) {
  const white = "#FFFFFF", black = "#000000";
  // Ink on a coloured ground: whichever of white, the text colour and the page colour reads best on it.
  const onColour = (ground: string) => [white, palette.text, palette.surface].reduce((best, value) => contrastOf(value, ground) > contrastOf(best, ground) ? value : best);
  const onAccent = onColour(palette.accent), onSecond = onColour(palette.separator);
  const alternate = [white, palette.text, palette.surface].filter(value => value !== onAccent).reduce((best, value) => contrastOf(value, palette.accent) > contrastOf(best, palette.accent) ? value : best);
  const tint = mix(palette.accent, white, .58), shade = mix(palette.accent, palette.text, .45);
  const dark = contrastOf(palette.surface, black) < contrastOf(palette.surface, white);
  // Readable secondary ink (Shorts v2): muted text reaches 4.5:1 on its page, the translucent on-accent ink on its field.
  return { paper: palette.surface, ink: palette.text, accent: palette.accent, second: palette.separator, mute: readableOn(palette.muted, palette.surface, palette.text, 4.5),
    rule: palette.separator, onAccent, onSecond, onAccentMute: contrastOf(mix(palette.accent, onAccent, .78), palette.accent) >= 4.5 ? `${onAccent}C7` : onAccent,
    onAccentRule: `${onAccent}A6`, onAccentFaint: `${onAccent}40`,
    accentInk: readableOn(palette.accent, palette.surface, palette.text), secondInk: readableOn(palette.separator, palette.surface, palette.text),
    // Accent-coloured text below display size (step numbers, years, counts) still reaches 4.5:1 on the page.
    accentText: readableOn(palette.accent, mix(palette.surface, palette.text, .1), palette.text, 4.5),
    // A second ink for display-size accent words on accent fields; it falls back to the main on-accent ink when too faint.
    accentWord: contrastOf(alternate, palette.accent) >= 3 ? alternate : onAccent,
    light: contrastOf(palette.surface, palette.accent) >= 1.8 ? palette.surface : white, white, dark,
    glow: mix(palette.accent, white, .45), decor: contrastOf(tint, palette.accent) >= 1.6 ? tint : shade,
    raised: mix(palette.surface, palette.text, dark ? .08 : .04),
    gridMinor: `${palette.text}0C`, gridMajor: `${palette.text}18`, hairline: `${palette.text}26` };
}
type Colours = ReturnType<typeof designThemeColors>;

// ---- Poster scope ------------------------------------------------------------------------------------------------
/** Inside a poster scope every element is complete on frame 0: no entrance, reveal or developing. A template that starts
 * the video opens on its finished media window, because the first frame is what a Short is judged on. */
interface Settle { travel: number; frames: number; easing: Easing; drift?: { dy: number; frames: number } }
interface ScopeState { depth: number; until?: { stop: number; exit: DesignMotion["exit"] }; from?: number; settle?: Settle; lead?: number }
/** Contours moved by (dx, dy) canvas pixels. */
const translateCommands = (commands: Shape, dx: number, dy: number): Shape => commands.map(command => command.type === "Z" ? command : command.type === "C"
  ? { ...command, x1: command.x1 + dx, y1: command.y1 + dy, x2: command.x2 + dx, y2: command.y2 + dy, x: command.x + dx, y: command.y + dy }
  : { ...command, x: command.x + dx, y: command.y + dy });
function posterContext(raw: DesignContext, state: ScopeState): DesignContext {
  const ctx = untilContext(raw, state), on = () => state.depth > 0;
  // A poster element is complete on frame 0 (no entrance, no stagger) but still leaves with its own designed exit.
  const held = (motion?: DesignMotion): DesignMotion => motion
    ? { ...motion, sequence: { ...motion.sequence, staggerFrames: 0 }, entrance: ctx.still().entrance } : ctx.still();
  // ...and it may settle into place (readable on frame 0, yet alive): by default only headlines and large lines settle a
  // few pixels; a scope that sets its own settle moves everything it draws together (a card and its copy, a title and its
  // underline), so no text ever drifts inside a still shape.
  // A drift (when the scope asks for one) keeps a landed group breathing: a slow, fully visible move through the hold.
  const settle = (motion: DesignMotion | undefined, end?: number): DesignMotion => {
    const base = motion ?? ctx.still(), how = state.settle ?? { travel: 6 * ctx.unit, frames: 12, easing: MOTION_CURVES.springLand };
    const drifting = how.drift !== undefined && how.drift.frames >= 24 && end !== undefined && end - how.frames - how.drift.frames >= 2;
    return { ...base, sequence: { ...base.sequence, staggerFrames: Math.min(2, base.sequence.staggerFrames), ...(drifting ? { exitStaggerFrames: 0 } : {}) },
      entrance: { durationFrames: how.frames, offsetXPixels: 0, offsetYPixels: how.travel, scale: 1, opacity: 1, easing: how.easing },
      ...(drifting ? { exit: { durationFrames: how.drift!.frames, offsetXPixels: 0, offsetYPixels: how.drift!.dy, scale: 1, opacity: 1, easing: { type: "ease_in_out" } as Easing } } : {}) };
  };
  const forText = (motion: DesignMotion | undefined, _size: number, end?: number) => state.settle ? settle(motion, end) : held(motion);
  const forShape = (motion: DesignMotion | undefined, end?: number) => state.settle ? settle(motion, end) : held(motion);
  return { ...ctx,
    add: (role, presetId, text, overrides, start, end) => on()
      ? ctx.add(role, presetId, text, { ...overrides, motionV2: text ? forText(overrides.motionV2, overrides.fontSize ?? 0, end) : forShape(overrides.motionV2, end),
        ...(overrides.vectorV2 ? { vectorV2: { ...overrides.vectorV2, revealFrames: 1 } } : {}) }, 0, end)
      : ctx.add(role, presetId, text, overrides, start, end),
    line: (role, text, spec, x, width, inkTop, motionV2, start, end, extra) => on()
      ? ctx.line(role, text, spec, x, width, inkTop, forText(motionV2, spec.size, end), 0, end, extra) : ctx.line(role, text, spec, x, width, inkTop, motionV2, start, end, extra),
    panel: (role, x, y, w, h, radius, color, layer, start, end, extra = {}) => on()
      ? ctx.panel(role, x, y, w, h, radius, color, layer, 0, end, { ...extra, motionV2: forShape(extra.motionV2, end) }) : ctx.panel(role, x, y, w, h, radius, color, layer, start, end, extra),
    shape: (role, commands, color, layer, start, end, extra = {}) => {
      if (!on()) return ctx.shape(role, commands, color, layer, start, end, extra);
      const { revealFrom: _from, ...rest } = extra, lead = state.settle && state.lead ? state.lead : 0;
      // A mark on a word that settles later in the cascade holds the word's first pose until the word starts to move.
      if (lead > 0) ctx.shape(`${role}:lead`, translateCommands(commands, 0, state.settle!.travel), color, layer, 0, lead, { ...rest, motionV2: ctx.still(), revealFrames: 1 });
      return ctx.shape(role, commands, color, layer, lead, end, { ...rest, motionV2: forShape(rest.motionV2, end), revealFrames: 1 });
    },
    stroke: (role, commands, color, start, end, extra) => on()
      ? ctx.stroke(role, commands, color, 0, end, { ...extra, revealFrames: 1, motionV2: forShape(extra.motionV2, end) }) : ctx.stroke(role, commands, color, start, end, extra),
    inline: (role, runs, spec, x, width, inkTop, motionFor, start, end, extra) => {
      if (!on()) return ctx.inline(role, runs, spec, x, width, inkTop, motionFor, start, end, extra);
      if (!state.settle) return ctx.inline(role, runs, spec, x, width, inkTop, text => held(motionFor(text)), 0, end, { ...extra, runStarts: runs.map(() => 0) });
      // A settling block keeps one per-character cascade in reading order across its colour runs: every piece is on screen
      // from frame 0 and a later run holds its first pose until its turn. Line windows grow by the settle's travel and
      // drift, so a displaced glyph is never cut by its own mask.
      const { runStarts: _starts, ...rest }: NonNullable<typeof extra> = extra ?? {}, how = state.settle, drift = how.drift?.dy ?? 0;
      const clipLines = rest.clipLines && { ...rest.clipLines, padTop: rest.clipLines.padTop + Math.max(0, -how.travel, -drift),
        padBottom: rest.clipLines.padBottom + Math.max(0, how.travel, drift) };
      return ctx.inline(role, runs, spec, x, width, inkTop, text => settle(motionFor(text), end), 0, end, { ...rest, ...(clipLines ? { clipLines } : {}), heldFrom: 0 });
    },
    count: (role, text, spec, x, width, inkTop, motionV2, start, end, steps, from) => on()
      ? [ctx.line(role, text, spec, x, width, inkTop, forText(motionV2, spec.size, end), 0, end)]
      : ctx.count(role, text, spec, x, width, inkTop, motionV2, start, end, steps, from) };
}
/** Inside an until scope everything that would outlast `stop` leaves at `stop` with the scope's exit: a line that has been
 * read gives its place to the next one (Shorts v2 time-shares one reading slot instead of crowding the frame). */
function untilContext(ctx: DesignContext, state: ScopeState): DesignContext {
  const cut = (end: number, motionV2: DesignMotion | undefined): [number, DesignMotion | undefined] => {
    const until = state.until;
    return until && end >= until.stop ? [until.stop, { ...(motionV2 ?? ctx.still()), exit: until.exit }] : [end, motionV2];
  };
  // A from scope starts everything at `from` with no entrance of its own (it takes over from something already there).
  const begin = (start: number | undefined, motionV2: DesignMotion | undefined): [number | undefined, DesignMotion | undefined] =>
    state.from === undefined ? [start, motionV2] : [Math.max(start ?? 0, state.from), { ...(motionV2 ?? ctx.still()), entrance: ctx.still().entrance }];
  return { ...ctx,
    add: (role, presetId, text, overrides, start0, end) => { const [start, m0] = begin(start0, overrides.motionV2), [stop, motionV2] = cut(end ?? Number.POSITIVE_INFINITY, m0);
      return ctx.add(role, presetId, text, motionV2 ? { ...overrides, motionV2 } : overrides, start, Number.isFinite(stop) ? stop : end); },
    line: (role, text, spec, x, width, inkTop, motion0, start0, end, extra) => { const [start, m0] = begin(start0, motion0), [stop, motion] = cut(end, m0);
      return ctx.line(role, text, spec, x, width, inkTop, motion ?? m0 ?? motion0, start!, stop, extra); },
    panel: (role, x, y, w, h, radius, color, layer, start0, end, extra = {}) => { const [start, m0] = begin(start0, extra.motionV2), [stop, motionV2] = cut(end, m0);
      return ctx.panel(role, x, y, w, h, radius, color, layer, start!, stop, motionV2 ? { ...extra, motionV2 } : extra); },
    shape: (role, commands, color, layer, start0, end, extra = {}) => { const [start, m0] = begin(start0, extra.motionV2), [stop, motionV2] = cut(end, m0);
      return ctx.shape(role, commands, color, layer, start!, stop, motionV2 ? { ...extra, motionV2 } : extra); },
    stroke: (role, commands, color, start0, end, extra) => { const [start, m0] = begin(start0, extra.motionV2), [stop, motionV2] = cut(end, m0);
      return ctx.stroke(role, commands, color, start!, stop, motionV2 ? { ...extra, motionV2 } : extra); },
    inline: (role, runs, spec, x, width, inkTop, motionFor, start, end, extra) => {
      const [stop] = cut(end, undefined), until = state.until;
      return ctx.inline(role, runs, spec, x, width, inkTop, until && end >= until.stop ? text => ({ ...motionFor(text), exit: until.exit }) : motionFor, start, stop, extra);
    },
    count: (role, text, spec, x, width, inkTop, motionV2, start, end, steps, from) => { const [stop, motion] = cut(end, motionV2);
      return ctx.count(role, text, spec, x, width, inkTop, motion ?? motionV2, start, stop, steps, from); } };
}

// ---- Shared base -------------------------------------------------------------------------------------------------
function createBase(raw: DesignContext) {
  const posterState: ScopeState = { depth: 0 }, ctx = posterContext(raw, posterState), opener = raw.input.startFrame === 0;
  const { input, project, fps } = ctx, W = project.width, H = project.height, end = input.durationFrames;
  const D = REFERENCE_MOTION_DESIGN_CONTRACT, themeId = input.designSystem as ReferenceMotionDesignSystem, theme = REFERENCE_MOTION_DESIGN_THEMES[themeId];
  if (!ctx.portrait) throw new Error("設計主題目前提供直式 9:16 版面；橫式長片請先輸出直式或改用其他 Motion 呈現");
  const original = ctx.original;
  if (!["kinetic_network", "stat_reveal", "statement_cut", ...SCENE_FAMILY_IDS].includes(input.templateId) && (original.keyframes.length || original.layout || original.floatingFrame || original.transform3d
    || original.layer?.parentClipId || original.masks?.some(mask => mask.enabled) || original.chromaKey?.enabled || Object.keys(original.expressions ?? {}).length
    || original.transform.x !== 0 || original.transform.y !== 0 || original.transform.scale !== 1 || original.transform.rotation !== 0 || original.transform.opacity !== 1
    || original.creative?.transitionIn || original.creative?.transitionOut)) {
    throw new Error("設計主題需要乾淨片段；既有動畫、遮罩、透視、版面與轉場必須先另行處理");
  }
  const style = input.style ?? designThemeDefaultStyle(themeId), col = designThemeColors(style.palette);
  const u = (value: number) => value * ctx.unit, X = (value: number) => value * W / 1080, Y = (value: number) => value * H / 1920;
  const speed = style.animationSpeed ?? 1, fr = (frames: number) => Math.max(1, Math.round(frames * fps / 30 / speed));
  // Text column (Shorts safe area) and the wider footage column; text never uses MX/MW.
  const M = X(D.grid.margin), CW = X(D.grid.textRight) - M, R = M + CW, MX = X(D.grid.mediaMargin), MW = W - 2 * MX;
  // Centred copy sits on the canvas axis, as wide as the right safe edge allows (150-930).
  const cW = 2 * (R - W / 2), cM = W / 2 - cW / 2;
  const textTop = Y(D.grid.contentTop), textBottom = Y(D.grid.contentBottom), mediaBottom = Y(D.grid.mediaBottom);
  const heading = style.typography.headingFamily, body = style.typography.bodyFamily, numerals = theme.numeralFamily as string;
  const layoutLine = { safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, maxLines: 1, minFontSize: 8, lineGap: 0, align: "left" as const };
  const exitFrames = fr(8);

  // Motion vocabulary ----------------------------------------------------------------------------------------------
  const units = (text: string) => motionGraphicV2UnitCount({ text, motionV2: { sequence: { unit: "character" } } });
  interface TextMotion { dy?: number; dx?: number; perCharacter?: boolean; frames?: number; easing?: Easing; rotation?: number; scale?: number; blur?: number;
    staggerMax?: number; tailMax?: number; rest?: number }
  function text(value: string, options: TextMotion = {}): DesignMotion {
    const count = units(value), per = (options.perCharacter ?? true) && count > 1;
    const stagger = per ? Math.max(1, Math.min(fr(options.staggerMax ?? 2), Math.floor(fr(options.tailMax ?? 12) / (count - 1)))) : 0;
    const entrance: DesignMotion["entrance"] = { durationFrames: options.frames ?? fr(10), offsetXPixels: options.dx ?? 0, offsetYPixels: options.dy ?? u(40),
      scale: options.scale ?? 1, opacity: 0, easing: options.easing ?? MOTION_CURVES.expoOut };
    if (options.rotation) entrance.rotationDegrees = options.rotation;
    if (options.blur) entrance.blurPixels = Math.min(64, options.blur);
    return { sequence: { unit: per ? "character" : "all", order: "forward", exitOrder: "forward", staggerFrames: stagger, exitStaggerFrames: 0, scaleOrigin: "center",
      ...(options.rest ? { restRotationDegrees: options.rest } : {}) },
      entrance, exit: { durationFrames: exitFrames, offsetXPixels: 0, offsetYPixels: -u(20), scale: 1, opacity: 0, easing: MOTION_CURVES.expoOut } };
  }
  /** Vector entrance: fades (optionally from a scale and an offset); vectors never carry rotation or blur. */
  const fade = (frames = fr(8), scale = 1, easing: Easing = MOTION_CURVES.expoOut, dy = 0, dx = 0): DesignMotion => ({
    sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: frames, offsetXPixels: dx, offsetYPixels: dy, scale, opacity: 0, easing },
    exit: { durationFrames: exitFrames, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 0, easing: MOTION_CURVES.expoOut } });
  const span = (value: string, motion: DesignMotion) => motion.entrance.durationFrames + (motion.sequence.unit === "all" ? 0 : (units(value) - 1) * motion.sequence.staggerFrames);
  const exitSpan = (value: string, motion: DesignMotion) => motion.exit.durationFrames + (motion.sequence.unit === "all" ? 0 : (units(value) - 1) * motionGraphicV2ExitStaggerFrames(motion));
  const need = (value: string | undefined, start: number, motion: DesignMotion) => value ? start + span(value, motion) + ctx.readingFrames(value) + exitSpan(value, motion) : 0;
  const requireTime = (frames: number, what: string) => { if (frames > end) throw new Error(`${what}缺少完整閱讀停留；延長片段或縮短文字`); };

  // Geometry ---------------------------------------------------------------------------------------------------------
  const clockwise = (points: Array<{ x: number; y: number }>): Shape => {
    const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
    const ordered = area < 0 ? [...points].reverse() : points;
    return [{ type: "M", x: ordered[0].x, y: ordered[0].y }, ...ordered.slice(1).map(p => ({ type: "L" as const, x: p.x, y: p.y })), { type: "Z" }];
  };
  const reverse = (points: Array<{ x: number; y: number }>): Shape => {
    const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
    const ordered = area > 0 ? [...points].reverse() : points;
    return [{ type: "M", x: ordered[0].x, y: ordered[0].y }, ...ordered.slice(1).map(p => ({ type: "L" as const, x: p.x, y: p.y })), { type: "Z" }];
  };
  /** A thick straight stroke as one filled contour, clockwise like every other contour. */
  function stroke(ax: number, ay: number, bx: number, by: number, thickness: number, extend = thickness / 2): Shape {
    const length = Math.hypot(bx - ax, by - ay) || 1, dx = (bx - ax) / length, dy = (by - ay) / length, nx = -dy * thickness / 2, ny = dx * thickness / 2;
    const a = { x: ax - dx * extend, y: ay - dy * extend }, b = { x: bx + dx * extend, y: by + dy * extend };
    return clockwise([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]);
  }
  /** A polyline of thick strokes (round-ish joins from overlapping ends). */
  const polyline = (points: Array<[number, number]>, thickness: number): Shape =>
    points.slice(1).flatMap((point, i) => stroke(points[i][0], points[i][1], point[0], point[1], thickness));
  function ellipseContour(cx: number, cy: number, rx: number, ry: number, cw = true): Shape {
    const k = .5523, top = { x: cx, y: cy - ry }, right = { x: cx + rx, y: cy }, bottom = { x: cx, y: cy + ry }, left = { x: cx - rx, y: cy };
    if (cw) return [{ type: "M", ...top }, { type: "C", x1: cx + k * rx, y1: cy - ry, x2: cx + rx, y2: cy - k * ry, ...right },
      { type: "C", x1: cx + rx, y1: cy + k * ry, x2: cx + k * rx, y2: cy + ry, ...bottom }, { type: "C", x1: cx - k * rx, y1: cy + ry, x2: cx - rx, y2: cy + k * ry, ...left },
      { type: "C", x1: cx - rx, y1: cy - k * ry, x2: cx - k * rx, y2: cy - ry, ...top }, { type: "Z" }];
    return [{ type: "M", ...top }, { type: "C", x1: cx - k * rx, y1: cy - ry, x2: cx - rx, y2: cy - k * ry, ...left },
      { type: "C", x1: cx - rx, y1: cy + k * ry, x2: cx - k * rx, y2: cy + ry, ...bottom }, { type: "C", x1: cx + k * rx, y1: cy + ry, x2: cx + rx, y2: cy + k * ry, ...right },
      { type: "C", x1: cx + rx, y1: cy - k * ry, x2: cx + k * rx, y2: cy - ry, ...top }, { type: "Z" }];
  }
  const ring = (outer: Shape, inner: Shape) => [...outer, ...inner];
  /** A four-point sparkle: concave sides drawn with curves toward the centre. */
  function sparkle(cx: number, cy: number, r: number): Shape {
    const k = r * .18;
    return [{ type: "M", x: cx, y: cy - r }, { type: "C", x1: cx + k, y1: cy - k, x2: cx + k, y2: cy - k, x: cx + r, y: cy },
      { type: "C", x1: cx + k, y1: cy + k, x2: cx + k, y2: cy + k, x: cx, y: cy + r }, { type: "C", x1: cx - k, y1: cy + k, x2: cx - k, y2: cy + k, x: cx - r, y: cy },
      { type: "C", x1: cx - k, y1: cy - k, x2: cx - k, y2: cy - k, x: cx, y: cy - r }, { type: "Z" }];
  }
  /** A map pin: round head over a point, with a hole. */
  function pin(cx: number, top: number, h: number): Shape {
    const r = h * .36, cy = top + r, tip = top + h, k = .5523 * r;
    const head: Shape = [{ type: "M", x: cx, y: tip }, { type: "C", x1: cx - r * .55, y1: tip - h * .32, x2: cx - r, y2: cy + r * .55, x: cx - r, y: cy },
      { type: "C", x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r }, { type: "C", x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
      { type: "C", x1: cx + r, y1: cy + r * .55, x2: cx + r * .55, y2: tip - h * .32, x: cx, y: tip }, { type: "Z" }];
    return [...head, ...ellipseContour(cx, cy, r * .42, r * .42, false)];
  }
  /** A hand-drawn wave as one band of thickness t from x0 to x1. */
  function wave(x0: number, x1: number, y: number, amplitude: number, waves: number, thickness: number): Shape {
    const steps = Math.max(12, Math.round(waves * 12)), top: Array<{ x: number; y: number }> = [], bottom: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = x0 + (x1 - x0) * t, phase = t * waves * Math.PI * 2;
      const yy = y + Math.sin(phase) * amplitude, slope = Math.cos(phase) * amplitude * waves * Math.PI * 2 / (x1 - x0);
      const n = Math.hypot(1, slope), nx = -slope / n * thickness / 2, ny = 1 / n * thickness / 2;
      top.push({ x: x - nx, y: yy - ny }); bottom.push({ x: x + nx, y: yy + ny });
    }
    return clockwise([...top, ...bottom.reverse()]);
  }
  /** A rectangle with cut corners (HUD chamfer). */
  const chamfer = (x: number, y: number, w: number, h: number, cut: number, cw = true) => {
    const c = Math.min(cut, w / 3, h / 3);
    const points = [{ x: x + c, y }, { x: x + w, y }, { x: x + w, y: y + h - c }, { x: x + w - c, y: y + h }, { x, y: y + h }, { x, y: y + c }];
    return cw ? clockwise(points) : reverse(points);
  };
  /** A regular-looking octagon (all four corners cut) around a centre. */
  const octagon = (cx: number, cy: number, r: number, cw = true) => {
    const c = r * .42, points = [{ x: cx - r + c, y: cy - r }, { x: cx + r - c, y: cy - r }, { x: cx + r, y: cy - r + c }, { x: cx + r, y: cy + r - c },
      { x: cx + r - c, y: cy + r }, { x: cx - r + c, y: cy + r }, { x: cx - r, y: cy + r - c }, { x: cx - r, y: cy - r + c }];
    return cw ? clockwise(points) : reverse(points);
  };
  const slanted = (x: number, y: number, w: number, h: number, slant: number) => clockwise([{ x: x + slant, y }, { x: x + w, y }, { x: x + w - slant, y: y + h }, { x, y: y + h }]);
  const pill = (x: number, y: number, w: number, h: number, cw = true) => ctx.roundedRect(x, y, w, h, h / 2, cw);
  /** Four L-shaped corner marks just outside a rectangle. */
  function brackets(rect: Rect, offset: number, arm: number, thickness: number): Shape {
    const corners: Array<[number, number, number, number]> = [[rect.x - offset, rect.y - offset, 1, 1], [rect.x + rect.w + offset, rect.y - offset, -1, 1],
      [rect.x - offset, rect.y + rect.h + offset, 1, -1], [rect.x + rect.w + offset, rect.y + rect.h + offset, -1, -1]];
    return corners.flatMap(([x, y, sx, sy]) => [...ctx.roundedRect(sx > 0 ? x : x - arm, sy > 0 ? y : y - thickness, arm, thickness, 0),
      ...ctx.roundedRect(sx > 0 ? x : x - thickness, sy > 0 ? y : y - arm, thickness, arm, 0)]);
  }
  /** A solid bar that wipes in from the left (typed rule vector; background bars sit under the footage). */
  function bar(role: string, x: number, y: number, w: number, h: number, color: string, layer: "background" | "foreground", start: number, stop: number,
    reveal = fr(10), motionV2?: DesignMotion, radius = 0) {
    return ctx.add(role, "reel_rule_reveal", "", { x: x / W, y: y / H, width: Math.max(16, w) / W, fontSize: 8, compositeLayer: layer,
      accentColor: color, backgroundColor: "#00000000", cornerRadius: radius, outlineWidth: 0, motionV2: motionV2 ?? ctx.still(), layoutV2: layoutLine,
      vectorV2: { schema: layer === "background" ? "editkin.motion-vector-stage/v1" : "editkin.motion-vector/v1", kind: "rule",
        heightPixels: Math.max(1, h), revealFrames: Math.max(1, reveal) } }, start, stop);
  }
  function dots(role: string, top: number, height: number, spacing: number, radius: number, color: string, layer: "background" | "foreground", start: number, stop: number) {
    const band = Math.max(1, Math.floor(480 / Math.ceil(W / spacing))) * spacing;
    for (let y = top, index = 0; y < top + height; y += band, index++) {
      ctx.add(`${role}:${index}`, "reel_dot_grid", "", { x: 0, y: y / H, width: 1, fontSize: 8, compositeLayer: layer, textColor: "#00000000",
        backgroundColor: "#00000000", accentColor: color, motionV2: ctx.still(), layoutV2: layoutLine,
        vectorV2: { schema: layer === "background" ? "editkin.motion-vector-stage/v1" : "editkin.motion-vector/v1", kind: "dot_grid",
          heightPixels: Math.min(band, top + height - y), revealFrames: 1, spacingPixels: spacing, dotRadiusPixels: radius } }, start, stop);
    }
  }
  function grid(role: string, minor: string, major: string, layer: "background" | "foreground", spacing = u(60)) {
    ctx.add(role, "reel_line_grid", "", { x: 0, y: 0, width: 1, fontSize: 8, compositeLayer: layer, textColor: major, accentColor: minor, backgroundColor: "#00000000",
      motionV2: ctx.still(), layoutV2: layoutLine,
      vectorV2: { schema: layer === "background" ? "editkin.motion-vector-stage/v1" : "editkin.motion-vector/v1", kind: "line_grid", heightPixels: H, revealFrames: 1,
        spacingPixels: spacing, lineWidthPixels: Math.max(.5, u(1.5)), majorEvery: 4 } }, 0, end);
  }
  const shape = (role: string, commands: Shape, color: string, start: number, stop: number, extra: ShapeExtra = {}) =>
    ctx.shape(role, commands, color, extra.underMedia ? "background" : "foreground", start, stop, extra);

  // Learned accents (2026-10-07 Opus motion study): impacts on the beat, mask reveals and lines that draw themselves.
  /** Expands from a scale and fades out by `stop`: the motion of a shock ring, a burst of rays or a flash. */
  const burst = (frames: number, total: number, scaleFrom: number, scaleTo: number, opacity = 1): DesignMotion => ({
    sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: frames, offsetXPixels: 0, offsetYPixels: 0, scale: scaleFrom, opacity, easing: MOTION_CURVES.expoOut },
    exit: { durationFrames: Math.max(1, total - frames), offsetXPixels: 0, offsetYPixels: 0, scale: scaleTo, opacity: 0, easing: MOTION_CURVES.easeIn } });
  /** An impact on a beat: a ring that grows and fades from (cx, cy), optional radial rays and an optional frame flash. */
  function impact(role: string, cx: number, cy: number, radius: number, color: string, start: number,
    options: { rays?: number; flash?: string; thickness?: number; frames?: number } = {}) {
    const grow = fr(9), total = Math.min(end - start, options.frames ?? fr(16));
    if (total < grow + 2) return;
    const t = options.thickness ?? Math.max(2, u(4));
    shape(`${role}:ring`, ring(ellipseContour(cx, cy, radius, radius), ellipseContour(cx, cy, radius - t, radius - t, false)), color, start, start + total,
      { motionV2: burst(grow, total, .3, 1.16) });
    if (options.rays) {
      const rays: Shape = [], width = Math.max(2, u(5));
      for (let i = 0; i < options.rays; i++) {
        const angle = (i + .5) / options.rays * Math.PI * 2, inner = radius * .7, outer = radius * 1.18;
        rays.push(...stroke(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner, cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer, width, 0));
      }
      shape(`${role}:rays`, rays, color, start, start + total, { motionV2: burst(grow, total, .55, 1.22) });
    }
    if (options.flash) ctx.panel(`${role}:flash`, 0, 0, W, H, 0, options.flash, "foreground", start, Math.min(end, start + fr(6)),
      { motionV2: burst(1, fr(6), 1, 1) });
  }
  /** Mask reveal: glyphs rise from below their line inside the line's own window (no fade) and leave upward. */
  function maskRise(value: string, lineHeight: number): DesignMotion {
    const count = units(value), per = count > 1, stagger = per ? Math.max(1, Math.min(fr(2), Math.floor(fr(12) / (count - 1)))) : 0;
    return { sequence: { unit: per ? "character" : "all", order: "forward", exitOrder: "forward", staggerFrames: stagger, exitStaggerFrames: 0, scaleOrigin: "center" },
      entrance: { durationFrames: fr(13), offsetXPixels: 0, offsetYPixels: lineHeight * 1.12, scale: 1, opacity: 1, easing: MOTION_CURVES.expoOut },
      exit: { durationFrames: exitFrames, offsetXPixels: 0, offsetYPixels: -lineHeight * 1.08, scale: 1, opacity: 1, easing: MOTION_CURVES.snapIn } };
  }
  /** A line that draws itself (canvas pixels): routes, orbits, halos, chart lines; optional glowing pen tip. */
  const drawn = (role: string, commands: Shape, color: string, start: number, stop: number,
    extra: { width: number; frames: number; to?: number; from?: number; tip?: number; tipColor?: string; overText?: boolean; underMedia?: boolean; cap?: "round" | "butt" }) =>
    ctx.stroke(role, commands, color, start, stop, { width: extra.width, revealFrames: Math.max(2, Math.min(extra.frames, stop - start - exitFrames - 1)),
      ...(extra.to !== undefined ? { to: extra.to } : {}), ...(extra.from !== undefined ? { from: extra.from } : {}),
      ...(extra.tip ? { tip: extra.tip, tipColor: extra.tipColor ?? color } : {}), ...(extra.overText ? { overText: true } : {}),
      ...(extra.underMedia ? { underMedia: true } : {}), ...(extra.cap ? { cap: extra.cap } : {}), motionV2: fade(1) });
  /** An arc of an ellipse (angles in radians, screen y down), optionally hand-wobbled. The wobble vanishes at 0 and π, so
   * a ring drawn in two halves meets exactly at its ends of the major axis, where the caller placed them. */
  function arcPath(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, wobble = 0): Shape {
    const steps = Math.max(8, Math.round(Math.abs(a1 - a0) / (Math.PI * 2) * 56)), points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (a1 - a0) * i / steps, k = 1 + wobble * Math.sin(3 * a) + wobble * .6 * Math.sin(5 * a);
      points.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
    }
    return [{ type: "M", ...points[0] }, ...points.slice(1).map(p => ({ type: "L" as const, ...p }))];
  }
  /** A ring around a window: its upper half draws behind the footage, then its lower half in front, like a planet's ring. */
  function ringAround(role: string, cx: number, cy: number, rx: number, ry: number, tilt: number, color: string, start: number, stop: number,
    extra: { width: number; frames: number; wobble?: number; tip?: number; tipColor?: string }) {
    const half = Math.max(2, Math.round(extra.frames / 2)), arc = (a0: number, a1: number) => ctx.rotateCommands(arcPath(cx, cy, rx, ry, a0, a1, extra.wobble), cx, cy, tilt);
    drawn(`${role}:back`, arc(Math.PI, 2 * Math.PI), color, start, stop, { width: extra.width, frames: half, underMedia: true });
    drawn(`${role}:front`, arc(0, Math.PI), color, start + half, stop, { width: extra.width, frames: half, tip: extra.tip, tipColor: extra.tipColor });
  }
  /** A hand-drawn loop: an ellipse whose radius wobbles a little, so a drawn orbit looks traced by hand. */
  function wobblyEllipse(cx: number, cy: number, rx: number, ry: number, wobble: number, turns = 1.06): Shape {
    const steps = Math.round(56 * turns), points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + i / steps * Math.PI * 2 * turns, k = 1 + wobble * Math.sin(3 * a + .7) + wobble * .6 * Math.sin(5 * a);
      points.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
    }
    return [{ type: "M", ...points[0] }, ...points.slice(1).map(p => ({ type: "L" as const, ...p }))];
  }

  // Layout helpers ---------------------------------------------------------------------------------------------------
  // The displayed shape of a source, or of an observed subject range inside it (in the source's own proportions).
  const aspectOf = (index: number, focus?: NormalizedRect) => {
    const asset = ctx.sourceAssets[index], whole = asset.displayAspectRatio ?? asset.width! / asset.height!;
    return focus ? whole * focus.width / focus.height : whole;
  };
  function fit(aspect: number, slot: Rect, align: "left" | "center" | "right" = "left", valign: "top" | "center" | "bottom" = "top"): Rect {
    let w = slot.w, h = w / aspect;
    if (h > slot.h) { h = slot.h; w = h * aspect; }
    return { x: align === "left" ? slot.x : align === "right" ? slot.x + slot.w - w : slot.x + (slot.w - w) / 2,
      y: valign === "top" ? slot.y : valign === "bottom" ? slot.y + slot.h - h : slot.y + (slot.h - h) / 2, w, h };
  }
  const runsOf = (value: string, base: string, accent: string) => {
    const word = input.accentText;
    if (!word || !value.includes(word)) return [{ text: value, color: base }];
    const at = value.indexOf(word);
    return [{ text: value.slice(0, at), color: base }, { text: word, color: accent }, { text: value.slice(at + word.length), color: base }].filter(run => run.text.length > 0);
  };
  const union = (boxes: DesignInk[]): DesignInk => ({ left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)),
    top: Math.min(...boxes.map(b => b.top)), bottom: Math.max(...boxes.map(b => b.bottom)) });
  const inkHeight = (value: string, spec: DesignType, width = CW) => ctx.measure(value, spec, M, width).height;
  /** One line whose first ink lands exactly on (inkLeft, inkTop): measured at the margin, then set in a box just wide
   * enough for it, so a label near the frame edge never pushes its layout box off the canvas. */
  function lineAt(role: string, value: string, spec: DesignType, inkLeft: number, inkTop: number, motionV2: DesignMotion, start: number, stop: number) {
    const single = { ...spec, maxLines: 1, align: "left" as const }, m = ctx.measure(value, single, M, CW);
    return ctx.line(role, value, single, inkLeft - (m.left - M), m.right - m.left + u(32), inkTop, motionV2, start, stop);
  }
  /** The display size for a heading: one line when it fits within 78% of the nominal size; otherwise the largest size
   * (down to 70%) that wraps into the allowed lines without leaving one or two characters alone on the last line. */
  function fitSize(value: string, spec: DesignType, width: number) {
    const allowed = spec.maxLines ?? 1, step = Math.max(2, spec.size * .03);
    const lines = (size: number) => ctx.measureLines(value, { ...spec, size, maxLines: 4 }, M, width);
    for (let size = spec.size; size >= spec.size * .78; size -= step) if (lines(Math.floor(size)).length === 1) return Math.floor(size);
    if (allowed === 1) return Math.floor(spec.size * .78);
    for (let size = spec.size; size >= spec.size * .7; size -= step) {
      const rows = lines(Math.floor(size));
      if (rows.length <= allowed && rows.at(-1)! >= Math.min(3, Math.ceil([...value].length / (2 * allowed)))) return Math.floor(size);
    }
    return spec.size;
  }
  const lineSize = (value: string, spec: DesignType) => { const m = ctx.measure(value, { ...spec, maxLines: 1, align: "left" }, M, CW); return { w: m.right - m.left, h: m.height }; };
  /** Place a source as a clip with a mask; keyframes give it an entrance (and an optional tilt or extra moves). */
  function placeImage(index: number, rect: Rect, role: string, start: number, options: { clone?: boolean; key?: string; focus?: NormalizedRect; mask?: DesignMask;
    appearAfter?: number; fadeFrames?: number; dy?: number; dx?: number; scaleFrom?: number; opacity?: number; tilt?: number; extra?: DesignKeyframe[] } = {}) {
    const placed = ctx.place(index, { x: rect.x / W, y: rect.y / H, width: rect.w / W, height: rect.h / H }, role, options.clone ?? false, options.focus, options.key, options.mask);
    const view = placed.layout.viewport, box = { x: view.x * W, y: view.y * H, w: view.width * W, h: view.height * H };
    const key = options.key ?? (options.clone ? `source:${index}:foreground` : `source:${index}`);
    const appear = start + (options.appearAfter ?? 0), settled = appear + (options.fadeFrames ?? fr(D.image.fadeFrames));
    const rotation = options.tilt ?? 0, opacity = options.opacity ?? 1;
    if (posterState.depth > 0) {
      ctx.animate(key, placed.clip, [{ key: "settled", frame: 0, transform: { opacity, rotation } },
        ...(options.extra ?? []).map(point => ({ ...point, transform: { rotation, ...point.transform } }))]);
      return { ...placed, box, key, settled: 0 };
    }
    ctx.animate(key, placed.clip, [
      ...(appear > 0 ? [{ key: "hidden", frame: 0, transform: { opacity: 0, y: options.dy ?? 0, x: options.dx ?? 0, scale: options.scaleFrom ?? 1, rotation } }] : []),
      { key: "appear", frame: appear, transform: { opacity: 0, y: options.dy ?? 0, x: options.dx ?? 0, scale: options.scaleFrom ?? 1, rotation }, easing: "ease_out" },
      { key: "settled", frame: settled, transform: { opacity, rotation } },
      ...(options.extra ?? []).map(point => ({ ...point, transform: { rotation, ...point.transform } }))]);
    return { ...placed, box, key, settled };
  }
  /** Runs `fn` so that everything it draws starts at `start` already in place (no entrance): it takes over from a copy. */
  const from = <T>(start: number, fn: () => T): T => {
    const previous = posterState.from;
    posterState.from = start;
    try { return fn(); } finally { posterState.from = previous; }
  };
  /** Runs `fn` so that everything it draws which would outlast `stop` leaves at `stop` (a soft lift and fade, or `exit`). */
  const until = <T>(stop: number, fn: () => T, exit?: DesignMotion["exit"]): T => {
    const previous = posterState.until;
    posterState.until = { stop, exit: exit ?? { durationFrames: fr(10), offsetXPixels: 0, offsetYPixels: -u(24), scale: 1, opacity: 0, easing: MOTION_CURVES.expoOut } };
    try { return fn(); } finally { posterState.until = previous; }
  };
  /** Inside a settle scope, every shape `fn` draws holds its first pose until `frame`, then settles: a mark on a word that
   * the cascade reaches later moves with that word. Outside a settle scope it changes nothing. */
  const follow = <T>(frame: number, fn: () => T): T => {
    const previous = posterState.lead;
    posterState.lead = Math.max(0, Math.round(frame));
    try { return fn(); } finally { posterState.lead = previous; }
  };
  /** The scene frame at which a drawn text's first (or last) unit starts to move. */
  const turnOf = (graphic: MotionGraphic, last = false) => Math.round(graphic.timelineStart * fps) - input.startFrame
    + (last && graphic.motionV2 && graphic.motionV2.sequence.unit !== "all" ? (units(graphic.text) - 1) * graphic.motionV2.sequence.staggerFrames : 0);
  /** Runs `fn` in the poster scope when `active`: everything it draws is complete on frame 0. */
  const poster = <T>(active: boolean, fn: () => T, settleWith?: Settle): T => {
    if (!active) return fn();
    const previous = posterState.settle;
    posterState.depth++; if (settleWith) posterState.settle = settleWith;
    try { return fn(); } finally { posterState.depth--; posterState.settle = previous; }
  };
  const tilted = (rect: Rect, degrees: number, pivot = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }) => {
    const a = degrees * Math.PI / 180, cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, w = rect.w * cos + rect.h * sin, h = rect.w * sin + rect.h * cos;
    const rx = pivot.x + (cx - pivot.x) * Math.cos(a) - (cy - pivot.y) * Math.sin(a), ry = pivot.y + (cx - pivot.x) * Math.sin(a) + (cy - pivot.y) * Math.cos(a);
    return { x: rx - w / 2, y: ry - h / 2, w, h };
  };
  return { ctx, input, fps, W, H, end, D, themeId, col, u, X, Y, fr, M, CW, R, MX, MW, cM, cW, textTop, textBottom, mediaBottom, heading, body, numerals, layoutLine, exitFrames, opener, poster, until, from,
    follow, turnOf,
    text, fade, span, exitSpan, need, requireTime, clockwise, reverse, stroke, polyline, ellipseContour, ring, sparkle, pin, wave, chamfer, octagon, slanted, pill, brackets,
    bar, dots, grid, shape, burst, impact, maskRise, drawn, wobblyEllipse, arcPath, ringAround, aspectOf, fit, runsOf, union, inkHeight, lineAt, lineSize, fitSize, placeImage, tilted };
}
export type Base = ReturnType<typeof createBase>;
export interface Block { clip: TimelineClip; layout: ClipLayout; box: Rect; outer: Rect; key: string; settled: number }
export interface ImageOptions { clone?: boolean; key?: string; focus?: NormalizedRect; tilt?: number; opacity?: number; plain?: boolean; arch?: boolean;
  keepPlate?: boolean; extra?: DesignKeyframe[]; dy?: number }

/** A theme: type, motion and drawing for the shared family grammar. */
export interface Kit {
  surfaceFor(family: Family): Surface;
  type(surface: Surface): { title: DesignType; claim: DesignType; body: DesignType; label: DesignType; lead: DesignType; detail: DesignType; numeral: DesignType; small: DesignType; tag: DesignType };
  motion: { title(text: string): DesignMotion; body(text: string): DesignMotion; label(text: string): DesignMotion; numeral(text: string): DesignMotion; pop(): DesignMotion };
  accentWord(surface: Surface): string;
  ink(surface: Surface): string;
  page(surface: Surface, options?: { layer?: "background" | "foreground"; grid?: boolean }): void;
  chrome(surface: Surface, start: number, stop: number, options?: { kicker?: boolean; suffix?: string }): void;
  footer(surface: Surface, start?: number, stop?: number, suffix?: string): void;
  title(role: string, text: string, surface: Surface, x: number, width: number, inkTop: number, start: number, end: number,
    options?: { size?: number; maxLines?: number; align?: "left" | "center" }): { ink: DesignInk; settled: number };
  claim(role: string, text: string, x: number, width: number, inkTop: number): MotionGraphic;
  strike(lines: DesignInk[], start: number): number;
  frame: { top: number; right: number; bottom: number; left: number };
  image(index: number, rect: Rect, role: string, start: number, surface: Surface, options?: ImageOptions): Block;
  tag(role: string, text: string, x: number, yTop: number, start: number, stop: number, surface: Surface, tone?: "accent" | "second" | "ink"): Rect;
  tagSize(text: string): { w: number; h: number };
  verdict(role: string, cx: number, cy: number, size: number, kind: "good" | "bad", start: number, surface: Surface): void;
  marker(role: string, x: number, y: number, start: number, surface: Surface): number;
  divider(role: string, x: number, y: number, w: number, start: number, surface: Surface): void;
  card(role: string, rect: Rect, start: number, end: number): void;
  badge(role: string, x: number, y: number, size: number, value: string, emphasis: boolean, start: number, end: number): void;
  /** A capability node of kinetic_network in the theme's own shape, centred on (cx, cy). */
  node(role: string, cx: number, cy: number, r: number, index: number, surface: Surface, start: number, end: number, motionV2: DesignMotion): void;
  /** Ink for a node's label. */
  nodeInk(index: number, surface: Surface): string;
  /** The hub where the three nodes meet; returns its label ink. */
  hub(role: string, cx: number, cy: number, r: number, surface: Surface, start: number, end: number): string;
  /** A ring drawn around the joined group. */
  halo(role: string, cx: number, cy: number, r: number, surface: Surface, start: number, end: number): void;
  /** A loop that draws itself around a focus (level_bridge's orbit), tilted by `tilt` degrees. */
  orbit(role: string, cx: number, cy: number, rx: number, ry: number, tilt: number, surface: Surface, start: number, end: number): void;
  /** A path that draws itself through ordered points as steps appear (context_stack's route). */
  trail(role: string, points: Array<[number, number]>, surface: Surface, start: number, frames: number, end: number): void;
  /** The theme's impact on a beat at (cx, cy): from a quiet ring (formal) to rays and a flash (games). */
  accent(role: string, cx: number, cy: number, size: number, surface: Surface, start: number): void;
  /** The theme's brand mark centred on (cx, cy), `size` across: square, pin, spec chip, HUD badge, signal dot or app mark. */
  mark(role: string, cx: number, cy: number, size: number, surface: Surface, start: number, end: number): void;
  /** The theme's emphasis on one landed word's ink box: bar, wavy underline, brackets, HUD slash, drawn swoosh or highlight. */
  emphasis(role: string, box: DesignInk, surface: Surface, start: number, end: number): void;
  /** How nodes glide from their scattered places into the overlap. */
  glide: Easing;
}

// ---- Swiss Blue: formal (teaching, podcast, interviews, knowledge) -------------------------------------------------
function swissKit(b: Base): Kit {
  const { ctx, input, col, u, X, Y, fr, M, CW, W, D } = b;
  const ink = (s: Surface) => s === "light" ? col.ink : col.onAccent;
  const kit: Kit = {
    surfaceFor: family => ["comparison_pair", "brand_recap", "level_bridge", "kinetic_network", "stat_reveal"].includes(family) ? "bold" : "light",
    type: s => ({ title: { size: 120, weight: 900, color: ink(s), family: b.heading, maxLines: 2 }, claim: { size: 148, weight: 900, color: col.ink, family: b.heading, maxLines: 2 },
      body: { size: 40, weight: 700, color: ink(s), family: b.body, maxLines: 4 }, label: { size: 36, weight: 800, color: ink(s), family: b.body, maxLines: 2 },
      lead: { size: 46, weight: 900, color: s === "light" ? col.ink : col.ink, family: b.heading, maxLines: 2 }, detail: { size: 30, weight: 500, color: col.mute, family: b.body, maxLines: 3 },
      numeral: { size: 124, weight: 400, color: s === "light" ? col.accentInk : col.onAccent, family: b.numerals }, small: { size: 24, weight: 700, color: ink(s), family: b.body, maxLines: 1 },
      tag: { size: 42, weight: 900, color: col.onAccent, family: b.heading } }),
    motion: { title: value => b.text(value), body: value => b.text(value, { perCharacter: false, dy: u(24) }), label: value => b.text(value, { perCharacter: false, dy: u(20) }),
      numeral: value => b.text(value, { dy: u(30) }), pop: () => b.fade(fr(9), .6) },
    accentWord: s => s === "light" ? col.accentInk : col.accentWord,
    ink,
    page(s, options = {}) {
      const layer = options.layer ?? "background";
      ctx.panel("design:page", 0, 0, W, b.H, 0, s === "light" ? col.paper : col.accent, layer, 0, b.end);
      if (options.grid) b.grid("design:grid", s === "light" ? col.gridMinor : `${col.onAccent}12`, s === "light" ? col.gridMajor : `${col.onAccent}26`, layer);
    },
    chrome(s, start, stop, options = {}) {
      const suffix = options.suffix ?? "", color = ink(s), mark = s === "light" ? col.accent : col.onAccent, rule = s === "light" ? col.rule : col.onAccent;
      const top = Y(D.grid.topInk), motionV2 = start === 0 ? ctx.still() : b.fade(fr(6));
      const brand = input.brandMark, kicker = options.kicker === false ? undefined : input.kicker;
      if (brand) ctx.line(`design:brand${suffix}`, brand, { size: 32, weight: 800, color, family: b.body, tracking: 1 }, M, CW * .48, top, motionV2, start, stop);
      if (kicker) {
        const spec: DesignType = { size: 32, weight: 500, color, family: b.body, tracking: 1 }, m = ctx.measure(kicker, spec, M, CW);
        const x = brand ? b.R - (m.right - m.left) - (m.left - M) : M + u(24) - (m.left - M);
        const label = b.lineAt(`design:kicker${suffix}`, kicker, spec, x + (m.left - M), top, motionV2, start, stop);
        const box = ctx.ink(label), size = u(10);
        b.shape(`design:kicker:mark${suffix}`, ctx.roundedRect(box.left - u(14) - size, (box.top + box.bottom) / 2 - size / 2, size, size, 0), mark, start, stop, { motionV2 });
      }
      b.bar(`design:rule${suffix}`, M, Y(D.grid.topRule), CW, Math.max(1, u(3)), rule, "foreground", start, stop, start === 0 ? fr(14) : fr(8));
    },
    footer(s, start = 0, stop = b.end, suffix = "") {
      const color = s === "light" ? col.rule : col.onAccent, y = Y(D.grid.footer), arm = u(13), t = Math.max(1, u(2));
      for (const [index, cx] of [M + arm, W - M - arm].entries()) {
        b.shape(`design:cross:${index}${suffix}`, [...ctx.roundedRect(cx - arm, y - t / 2, 2 * arm, t, 0), ...ctx.roundedRect(cx - t / 2, y - arm, t, 2 * arm, 0)], color, start, stop);
      }
    },
    title(role, value, s, x, width, inkTop, start, end, options = {}) {
      const spec = { ...kit.type(s).title, size: options.size ?? 120, maxLines: options.maxLines ?? 2, align: options.align ?? "left" }
      spec.size = b.fitSize(value, spec, width);
      // Poster headline: each line rises out of its own window (mask reveal), crisp and without a fade.
      const rise = (t: string) => b.maskRise(t, u(spec.size) * .92);
      const pieces = ctx.inline(role, b.runsOf(value, ink(s), kit.accentWord(s)), spec, x, width, inkTop, rise, start, end,
        { clipLines: { padX: u(18), padTop: u(spec.size) * .3, padBottom: u(spec.size) * .12 } });
      return { ink: b.union(pieces.map(ctx.ink)), settled: start + b.span(value, rise(value)) };
    },
    claim: (role, value, x, width, inkTop) => { const spec = kit.type("light").claim; return ctx.line(role, value, { ...spec, size: b.fitSize(value, spec, width) }, x, width, inkTop, ctx.still(), 0, b.end); },
    strike(lines, start) {
      // One bold accent bar per claim line, slightly rising, wiped in from the left over the glyphs.
      lines.forEach((box, index) => {
        const h = box.bottom - box.top, mid = box.top + h * .55;
        b.shape(`strike:${index}`, b.stroke(box.left - u(22), mid + u(8), box.right + u(22), mid - u(8), h * .34, 0), col.accent, start + index * fr(4), b.end,
          { revealFrom: "left", revealFrames: fr(9), overText: true });
      });
      return fr(12) + (lines.length - 1) * fr(4);
    },
    frame: { top: 0, right: 0, bottom: 0, left: 0 },
    image(index, rect, role, start, s, options = {}) {
      const plate = options.plain ? undefined : s === "light" ? col.accent : col.light;
      const block = b.placeImage(index, rect, role, start, { clone: options.clone, key: options.key, focus: options.focus, opacity: options.opacity, extra: options.extra,
        mask: options.arch ? { shape: "arch" } : { shape: "rounded", radiusPixels: u(6) }, appearAfter: plate ? fr(5) : 0, dy: options.dy });
      if (plate) b.bar(`${block.key}:plate`, block.box.x + u(2), block.box.y + u(2), block.box.w - u(4), block.box.h - u(4), plate, "background", start,
        options.keepPlate ? b.end : block.settled + fr(8), fr(8));
      return { ...block, outer: block.box };
    },
    tag(role, value, x, yTop, start, stop, s, tone = "accent") {
      const spec = { ...kit.type(s).tag, color: tone === "ink" ? col.paper : tone === "second" ? col.onSecond : col.onAccent };
      const fill = tone === "ink" ? col.ink : tone === "second" ? col.second : s === "light" ? col.accent : col.light;
      if (tone === "accent" && s === "bold") spec.color = col.accentInk;
      const { w, h } = kit.tagSize(value);
      b.bar(`${role}:box`, x, yTop, w, h, fill, "foreground", start, stop, fr(8), b.fade(1));
      b.lineAt(role, value, spec, x + u(22), yTop + u(16), b.fade(fr(6)), start + fr(4), stop);
      return { x, y: yTop, w, h };
    },
    tagSize(value) { const m = b.lineSize(value, kit.type("light").tag); return { w: m.w + 2 * u(22), h: m.h + 2 * u(16) }; },
    verdict(role, cx, cy, size, kind, start, s) {
      ctx.panel(`${role}`, cx - size / 2, cy - size / 2, size, size, 0, kind === "good" ? (s === "light" ? col.accent : col.light) : col.ink, "foreground", start, b.end,
        { ellipse: true, motionV2: b.fade(fr(9), .6) });
      const d = size, t = d * .12, markColour = kind === "good" ? (s === "light" ? col.onAccent : col.accentInk) : col.paper;
      const mark = kind === "good" ? b.polyline([[cx - .24 * d, cy + .02 * d], [cx - .07 * d, cy + .19 * d], [cx + .25 * d, cy - .17 * d]], t)
        : [...b.stroke(cx - .17 * d, cy - .17 * d, cx + .17 * d, cy + .17 * d, t), ...b.stroke(cx + .17 * d, cy - .17 * d, cx - .17 * d, cy + .17 * d, t)];
      b.shape(`${role}:mark`, mark, markColour, start + fr(3), b.end, { motionV2: b.fade(fr(6), .6) });
    },
    marker(role, x, y, start, s) { b.bar(role, x, y, u(44), Math.max(2, u(6)), s === "light" ? col.accent : col.onAccent, "foreground", start, b.end, fr(8), b.fade(1)); return u(32); },
    divider(role, x, y, w, start, s) { b.bar(role, x, y, w, Math.max(1, u(2)), s === "light" ? col.rule : col.onAccentRule, "foreground", start, b.end, fr(10), b.fade(1)); },
    card(role, rect, start, end) { b.shape(role, ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(6)), col.paper, start, end, { revealFrom: "top", revealFrames: fr(10), motionV2: b.fade(1) }); },
    badge(role, x, y, size, value, emphasis, start, end) {
      b.shape(role, ctx.roundedRect(x, y, size, size, u(4)), emphasis ? col.accent : col.ink, start, end, { motionV2: b.fade(fr(7), .6) });
      const spec: DesignType = { size: 46, weight: 400, color: emphasis ? col.onAccent : col.paper, family: b.numerals, align: "center" };
      ctx.line(`${role}:number`, value, spec, x, size, y + (size - ctx.measure(value, spec, x, size).height) / 2, b.fade(fr(6)), start + fr(3), end);
    },
    // Translucent discs with a bold ring: where they overlap the page brightens, a Venn read in one colour.
    node(role, cx, cy, r, index, sf, start, end, motionV2) {
      const ink = sf === "light" ? col.ink : col.onAccent;
      b.shape(`${role}:fill`, b.ellipseContour(cx, cy, r, r), `${ink}${["24", "33", "1A"][index % 3]}`, start, end, { motionV2 });
      b.shape(`${role}:ring`, b.ring(b.ellipseContour(cx, cy, r, r), b.ellipseContour(cx, cy, r - u(5), r - u(5), false)), ink, start, end, { motionV2 });
    },
    nodeInk: (_index, sf) => sf === "light" ? col.ink : col.onAccent,
    hub(role, cx, cy, r, sf, start, end) {
      b.shape(role, b.ellipseContour(cx, cy, r, r), sf === "light" ? col.accent : col.ink, start, end, { motionV2: b.fade(fr(10), .3) });
      kit.accent(`${role}:impact`, cx, cy, r * 1.3, sf, start + fr(4));
      return sf === "light" ? col.onAccent : col.paper;
    },
    halo(role, cx, cy, r, sf, start, end) {
      // The ring draws itself from twelve o'clock, like a compass stroke on the poster.
      b.drawn(role, b.ellipseContour(cx, cy, r, r), sf === "light" ? col.ink : col.onAccentRule, start, end, { width: Math.max(1, u(2.5)), frames: fr(18) });
    },
    orbit(role, cx, cy, rx, ry, tilt, s, start, end) {
      b.ringAround(role, cx, cy, rx, ry, tilt, s === "light" ? col.ink : col.onAccentRule, start, end, { width: Math.max(1, u(2.5)), frames: fr(26) });
    },
    trail(role, points, s, start, frames, end) {
      b.drawn(role, [{ type: "M", x: points[0][0], y: points[0][1] }, ...points.slice(1).map(([x, y]) => ({ type: "L" as const, x, y }))],
        s === "light" ? col.rule : col.onAccentRule, start, end, { width: Math.max(1, u(2)), frames, cap: "butt" });
    },
    accent(role, cx, cy, size, s, start) {
      // Formal register: one fine ring that grows and fades, no rays and no flash.
      b.impact(role, cx, cy, size, s === "light" ? col.accent : col.onAccent, start, { thickness: Math.max(1, u(3)) });
    },
    mark(role, cx, cy, size, s, start, end) {
      // The poster's solid square.
      b.shape(role, ctx.roundedRect(cx - size / 2, cy - size / 2, size, size, 0), s === "light" ? col.accent : col.onAccent, start, end, { motionV2: b.fade(fr(8), .6) });
    },
    emphasis(role, box, s, start, end) {
      // A bold bar under the word, wiped in from the left.
      const h = Math.max(4, (box.bottom - box.top) * .1);
      b.shape(role, ctx.roundedRect(box.left, box.bottom + h * .9, box.right - box.left, h, 0), s === "light" ? col.accent : col.onAccent, start, end,
        { revealFrom: "left", revealFrames: fr(9) });
    },
    glide: MOTION_CURVES.expoOut,
  };
  return kit;
}

// ---- Trip Pop: lively (travel, food, vlog) -------------------------------------------------------------------------
function tripKit(b: Base): Kit {
  const { ctx, input, col, u, Y, fr, M, CW, W, H } = b;
  const ink = (s: Surface) => s === "light" ? col.ink : col.onAccent;
  const bounce = MOTION_CURVES.backOut;
  const pop = (scale = .45, frames = fr(12)) => b.fade(frames, scale, bounce);
  /** Sticker: hard shadow, fill and an ink outline, all clockwise contours. */
  const sticker = (role: string, contour: (inset: number, cw: boolean) => Shape, fill: string, start: number, stop: number, offset = u(6), outline = u(3.5),
    motionV2: DesignMotion = pop()) => {
    b.shape(`${role}:shadow`, contour(0, true).map(c => c.type === "Z" ? c : c.type === "C"
      ? { ...c, x1: c.x1 + offset, y1: c.y1 + offset, x2: c.x2 + offset, y2: c.y2 + offset, x: c.x + offset, y: c.y + offset } : { ...c, x: c.x + offset, y: c.y + offset }),
    col.ink, start, stop, { motionV2 });
    b.shape(`${role}:fill`, contour(0, true), fill, start, stop, { motionV2 });
    b.shape(`${role}:outline`, b.ring(contour(0, true), contour(outline, false)), col.ink, start, stop, { motionV2 });
  };
  const kit: Kit = {
    surfaceFor: family => ["level_bridge", "kinetic_network"].includes(family) ? "bold" : "light",
    type: s => ({ title: { size: 124, weight: 700, color: ink(s), family: b.heading, maxLines: 2 }, claim: { size: 136, weight: 700, color: col.ink, family: b.heading, maxLines: 2 },
      body: { size: 40, weight: 700, color: ink(s), family: b.heading, maxLines: 4 }, label: { size: 36, weight: 700, color: ink(s), family: b.heading, maxLines: 2 },
      lead: { size: 48, weight: 700, color: col.ink, family: b.heading, maxLines: 2 }, detail: { size: 30, weight: 500, color: col.mute, family: b.body, maxLines: 3 },
      numeral: { size: 110, weight: 700, color: s === "light" ? col.accentInk : col.onAccent, family: b.numerals }, small: { size: 24, weight: 700, color: ink(s), family: b.body, maxLines: 1 },
      tag: { size: 40, weight: 700, color: col.onSecond, family: b.heading } }),
    motion: { title: value => b.text(value, { dy: u(64), rotation: -10, frames: fr(14), easing: bounce, staggerMax: 2, tailMax: 14 }),
      body: value => b.text(value, { perCharacter: false, dy: u(30), frames: fr(12), easing: MOTION_CURVES.backOutSoft }),
      label: value => b.text(value, { perCharacter: false, dy: u(24), frames: fr(12), easing: MOTION_CURVES.backOutSoft }),
      numeral: value => b.text(value, { dy: u(10), scale: .4, frames: fr(13), easing: bounce }), pop: () => pop() },
    accentWord: s => s === "light" ? col.accentInk : col.accentWord,
    ink,
    page(s, options = {}) {
      const layer = options.layer ?? "background", ground = s === "light" ? col.paper : col.accent;
      ctx.panel("design:page", 0, 0, W, H, 0, ground, layer, 0, b.end);
      // Soft colour blooms in the corners, the way sunlight warms a journal page.
      const blooms: Array<[number, number, number, string]> = s === "light"
        ? [[.96, .62, .44, `${col.accent}38`], [.06, .95, .55, `${col.second}2E`], [.02, .78, .3, `${col.accent}1F`]]
        : [[.94, .64, .46, "#FFFFFF2E"], [.08, .94, .55, "#FFFFFF24"]];
      blooms.forEach(([cx, cy, r, color], index) => ctx.panel(`design:bloom:${index}`, cx * W - r * W, cy * H - r * W, 2 * r * W, 2 * r * W, 0, color, layer, 0, b.end,
        { ellipse: true, softness: 64 }));
      if (options.grid) b.dots("design:dots", 0, H, u(46), u(2.2), s === "light" ? `${col.ink}14` : `${col.onAccent}24`, layer, 0, b.end);
    },
    chrome(s, start, stop, options = {}) {
      const suffix = options.suffix ?? "", top = Y(b.D.grid.topInk), motionV2 = start === 0 ? ctx.still() : b.fade(fr(6));
      const brand = input.brandMark, kicker = options.kicker === false ? undefined : input.kicker;
      if (brand) {
        const spec: DesignType = { size: 32, weight: 800, color: col.ink, family: b.body }, m = ctx.measure(brand, spec, M + u(18), CW);
        const w = m.right - m.left + u(36), h = m.height + u(22), x = M, y = top - u(11);
        b.shape(`design:brand:pill${suffix}`, b.pill(x, y, w, h), s === "light" ? "#FFFFFF" : col.light, start, stop, { motionV2 });
        b.shape(`design:brand:outline${suffix}`, b.ring(b.pill(x, y, w, h), b.pill(x + u(2.5), y + u(2.5), w - u(5), h - u(5), false)), col.ink, start, stop, { motionV2 });
        ctx.line(`design:brand${suffix}`, brand, spec, x + u(18) - (m.left - M - u(18)), CW, y + u(11), motionV2, start, stop);
      }
      if (kicker) {
        const spec: DesignType = { size: 32, weight: 700, color: ink(s), family: b.heading }, m = ctx.measure(kicker, spec, M, CW), pinH = u(38);
        const x = brand ? b.R - (m.right - m.left) - (m.left - M) : M + u(38) - (m.left - M);
        const label = b.lineAt(`design:kicker${suffix}`, kicker, spec, x + (m.left - M), top, motionV2, start, stop);
        const box = ctx.ink(label);
        b.shape(`design:kicker:pin${suffix}`, b.pin(box.left - u(22), (box.top + box.bottom) / 2 - pinH / 2, pinH), s === "light" ? col.second : col.onAccent, start, stop,
          { motionV2: start === 0 ? ctx.still() : pop() });
      }
    },
    footer(s, start = 0, stop = b.end, suffix = "") {
      // A dashed route that ends at a pin, with a sparkle: the journal's signature.
      const y = Y(1846), x0 = M + u(10), x1 = W - M - u(70), dash = u(16), gap = u(12), colour = s === "light" ? `${col.ink}66` : col.onAccentRule;
      const dashes: Shape = [];
      for (let x = x0; x + dash <= x1; x += dash + gap) dashes.push(...b.pill(x, y - u(2), dash, u(4)));
      b.shape(`design:route${suffix}`, dashes, colour, start, stop, { revealFrom: "left", revealFrames: start === 0 ? fr(24) : fr(10) });
      b.shape(`design:route:pin${suffix}`, b.pin(W - M - u(34), y - u(46), u(50)), s === "light" ? col.second : col.onAccent, start, stop, { motionV2: start === 0 ? ctx.still() : pop() });
      b.shape(`design:route:sparkle${suffix}`, b.sparkle(W - M - u(4), y - u(58), u(13)), s === "light" ? col.accent : col.onAccent, start, stop, { motionV2: start === 0 ? ctx.still() : pop() });
    },
    title(role, value, s, x, width, inkTop, start, end, options = {}) {
      const spec = { ...kit.type(s).title, size: options.size ?? 124, maxLines: options.maxLines ?? 2, align: options.align ?? "left" }
      spec.size = b.fitSize(value, spec, width);
      const runs = b.runsOf(value, ink(s), kit.accentWord(s));
      const pieces = ctx.inline(role, runs, spec, x, width, inkTop, t => kit.motion.title(t), start, end);
      const settled = start + b.span(value, kit.motion.title(value));
      // Which pieces belong to the accent run, found by their characters' place in the title (colours may coincide).
      const accentRun = runs.findIndex(run => run.text === input.accentText), whole = runs.map(run => run.text).join("");
      const runStart = runs.slice(0, Math.max(0, accentRun)).reduce((sum, run) => sum + [...run.text].length, 0);
      let cursor = 0;
      const accented = pieces.filter(piece => {
        const at = [...whole].join("").indexOf(piece.text, cursor), index = [...whole.slice(0, Math.max(0, at))].length;
        cursor = Math.max(cursor, at + piece.text.length);
        return accentRun >= 0 && runs.length > 1 && at >= 0 && index >= runStart && index < runStart + [...runs[accentRun].text].length;
      });
      // In a settling opener the marks move with their word, which the reading-order cascade reaches after the first run.
      accented.forEach((piece, index) => b.follow(b.turnOf(piece), () => {
        const box = ctx.ink(piece), h = box.bottom - box.top;
        // On a colour field the word keeps the field's ink (contrast) and gains a highlighter swipe behind it.
        if (s === "bold") b.shape(`${role}:highlight:${index}`, ctx.rotateCommands(ctx.roundedRect(box.left - u(10), box.top + h * .42, box.right - box.left + u(20), h * .66, u(8)),
          (box.left + box.right) / 2, box.top + h * .75, -1.5), `${col.light}B3`, settled - fr(4), end, { revealFrom: "left", revealFrames: fr(9) });
        // A hand-drawn wave underlines the accent word once it has landed.
        b.shape(`${role}:underline:${index}`, b.wave(box.left - u(4), box.right + u(6), box.bottom + h * .2, u(5), Math.max(1.5, (box.right - box.left) / u(70)), u(8)),
          s === "light" ? col.second : col.ink, settled, end, { revealFrom: "left", revealFrames: fr(10) });
      }));
      return { ink: b.union(pieces.map(ctx.ink)), settled };
    },
    claim: (role, value, x, width, inkTop) => { const spec = kit.type("light").claim; return ctx.line(role, value, { ...spec, size: b.fitSize(value, spec, width) }, x, width, inkTop, ctx.still(), 0, b.end); },
    strike(lines, start) {
      // A quick scribble across each claim line, drawn over the glyphs.
      lines.forEach((box, index) => {
        const h = box.bottom - box.top;
        b.shape(`strike:${index}`, b.wave(box.left - u(18), box.right + u(18), box.top + h * .55, h * .16, Math.max(2, (box.right - box.left) / u(90)), h * .13),
          col.second, start + index * fr(5), b.end, { revealFrom: "left", revealFrames: fr(12), overText: true });
      });
      return fr(14) + (lines.length - 1) * fr(5);
    },
    frame: { top: u(18), right: u(18), bottom: u(34), left: u(18) },
    image(index, rect, role, start, s, options = {}) {
      // A polaroid: soft shadow, white mat with a deep foot, a strip of tape, and the photo developing inside.
      const tilt = options.tilt ?? 0, f = kit.frame, pivot = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const mat = { x: rect.x - f.left, y: rect.y - f.top, w: rect.w + f.left + f.right, h: rect.h + f.top + f.bottom };
      const turn = (shape: Shape) => tilt ? ctx.rotateCommands(shape, pivot.x, pivot.y, tilt) : shape;
      const matIn = b.fade(fr(12), .9, bounce, u(24)), mounted = !options.arch && !options.plain;
      if (mounted) {
        b.shape(`${options.key ?? `source:${index}`}:shadow`, turn(ctx.roundedRect(mat.x + u(10), mat.y + u(18), mat.w, mat.h, u(6))), `${col.ink}40`, start, b.end,
          { underMedia: true, softness: u(16), motionV2: matIn });
        b.shape(`${options.key ?? `source:${index}`}:mat`, turn(ctx.roundedRect(mat.x, mat.y, mat.w, mat.h, u(5))), "#FFFFFF", start, b.end, { underMedia: true, motionV2: matIn });
      }
      const block = b.placeImage(index, rect, role, start, { clone: options.clone, key: options.key, focus: options.focus, opacity: options.opacity, extra: options.extra,
        mask: options.arch ? { shape: "arch" } : { shape: "rounded", radiusPixels: u(3) }, appearAfter: fr(2), fadeFrames: fr(9), tilt, dy: options.dy });
      if (mounted) {
        const tapeW = Math.min(u(170), mat.w * .42), tapeH = u(42), tx = pivot.x - tapeW / 2, ty = mat.y - tapeH * .45;
        b.shape(`${block.key}:tape`, ctx.rotateCommands(turn(ctx.roundedRect(tx, ty, tapeW, tapeH, u(3))), pivot.x, ty + tapeH / 2, -5), `${mix(col.second, "#FFFFFF", .35)}C7`,
          start + fr(14), b.end, { motionV2: pop(1.3, fr(9)) });
      }
      return { ...block, outer: mounted ? b.tilted(mat, tilt, pivot) : block.box };
    },
    tag(role, value, x, yTop, start, stop, s, tone = "second") {
      const { w, h } = kit.tagSize(value), fill = tone === "accent" ? col.accent : tone === "ink" ? col.ink : col.second;
      const color = tone === "accent" ? col.onAccent : tone === "ink" ? col.paper : col.onSecond;
      sticker(role, (inset, cw) => b.pill(x + inset, yTop + inset, w - 2 * inset, h - 2 * inset, cw), fill, start, stop);
      const spec = { ...kit.type(s).tag, color }, m = b.lineSize(value, spec);
      b.lineAt(role, value, spec, x + u(26), yTop + (h - m.h) / 2, pop(.6, fr(10)), start + fr(3), stop);
      return { x, y: yTop, w, h };
    },
    tagSize(value) { const m = b.lineSize(value, kit.type("light").tag); return { w: m.w + 2 * u(26), h: m.h + 2 * u(18) }; },
    verdict(role, cx, cy, size, kind, start) {
      const r = size / 2;
      sticker(role, (inset, cw) => b.ellipseContour(cx, cy, r - inset, r - inset, cw), kind === "good" ? col.accent : col.second, start, b.end, u(4), u(3));
      const d = size, t = d * .13;
      const mark = kind === "good" ? b.polyline([[cx - .22 * d, cy + .02 * d], [cx - .06 * d, cy + .18 * d], [cx + .24 * d, cy - .16 * d]], t)
        : [...b.stroke(cx - .16 * d, cy - .16 * d, cx + .16 * d, cy + .16 * d, t), ...b.stroke(cx + .16 * d, cy - .16 * d, cx - .16 * d, cy + .16 * d, t)];
      b.shape(`${role}:mark`, mark, kind === "good" ? col.onAccent : col.onSecond, start + fr(4), b.end, { motionV2: pop(.5, fr(9)) });
    },
    marker(role, x, y, start, s) { b.shape(role, b.sparkle(x + u(14), y + u(12), u(14)), s === "light" ? col.second : col.onAccent, start, b.end, { motionV2: pop() }); return u(36); },
    divider(role, x, y, w, start, s) {
      const dash = u(14), gap = u(10), shapes: Shape = [];
      for (let p = x; p + dash <= x + w; p += dash + gap) shapes.push(...b.pill(p, y - u(1.5), dash, u(3)));
      b.shape(role, shapes, s === "light" ? `${col.ink}59` : col.onAccentRule, start, b.end, { revealFrom: "left", revealFrames: fr(10) });
    },
    card(role, rect, start, end) {
      const motionV2 = pop(.92, fr(12));
      b.shape(`${role}:shadow`, ctx.roundedRect(rect.x + u(8), rect.y + u(10), rect.w, rect.h, u(22)), col.ink, start, end, { motionV2 });
      b.shape(`${role}:fill`, ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(22)), "#FFFFFF", start, end, { motionV2 });
      b.shape(`${role}:outline`, b.ring(ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(22)), ctx.roundedRect(rect.x + u(3), rect.y + u(3), rect.w - u(6), rect.h - u(6), u(19), false)),
        col.ink, start, end, { motionV2 });
    },
    badge(role, x, y, size, value, emphasis, start, end) {
      const r = size / 2;
      sticker(role, (inset, cw) => b.ellipseContour(x + r, y + r, r - inset, r - inset, cw), emphasis ? col.second : col.accent, start, end, u(3), u(3));
      const spec: DesignType = { size: 40, weight: 700, color: emphasis ? col.onSecond : col.onAccent, family: b.numerals, align: "center" };
      ctx.line(`${role}:number`, value, spec, x, size, y + (size - ctx.measure(value, spec, x, size).height) / 2, pop(.5, fr(9)), start + fr(3), end);
    },
    // Sticker discs in the journal's three colours, each with its ink outline and hard shadow.
    node(role, cx, cy, r, index, _sf, start, end, motionV2) {
      sticker(role, (inset, cw) => b.ellipseContour(cx, cy, r - inset, r - inset, cw), [col.paper, col.second, "#FFFFFF"][index % 3], start, end, u(9), u(4), motionV2);
    },
    nodeInk: index => index % 3 === 1 ? col.onSecond : col.ink,
    hub(role, cx, cy, r, sf, start, end) {
      sticker(role, (inset, cw) => b.ellipseContour(cx, cy, r - inset, r - inset, cw), col.accent, start, end, u(6), u(4), pop(.3, fr(13)));
      kit.accent(`${role}:impact`, cx, cy, r * 1.3, sf, start + fr(5));
      return col.onAccent;
    },
    halo(role, cx, cy, r, sf, start, end) {
      // A loop traced round the group by hand, the pen tip still sparkling while it draws.
      b.drawn(role, b.wobblyEllipse(cx, cy, r, r, .025), sf === "light" ? `${col.ink}80` : col.onAccentRule, start, end,
        { width: Math.max(2, u(4)), frames: fr(20), tip: u(7), tipColor: sf === "light" ? col.second : col.onAccent });
    },
    orbit(role, cx, cy, rx, ry, tilt, s, start, end) {
      b.ringAround(role, cx, cy, rx, ry, tilt, s === "light" ? `${col.ink}8C` : col.onAccent, start, end,
        { width: Math.max(2, u(4.5)), frames: fr(28), wobble: .03, tip: u(9), tipColor: s === "light" ? col.second : col.light });
    },
    trail(role, points, s, start, frames, end) {
      b.drawn(role, [{ type: "M", x: points[0][0], y: points[0][1] }, ...points.slice(1).map(([x, y]) => ({ type: "L" as const, x, y }))],
        s === "light" ? col.second : col.onAccent, start, end, { width: Math.max(2, u(4)), frames, tip: u(7), tipColor: s === "light" ? col.accent : col.light });
    },
    accent(role, cx, cy, size, s, start) {
      // A sticker pop: a coral ring with short sparkle rays.
      b.impact(role, cx, cy, size, s === "light" ? col.second : col.onAccent, start, { rays: 8, thickness: Math.max(2, u(4)) });
    },
    mark(role, cx, cy, size, s, start, end) {
      // A map pin with its sparkle.
      b.shape(role, b.pin(cx, cy - size / 2, size), s === "light" ? col.second : col.onAccent, start, end, { motionV2: pop() });
      b.shape(`${role}:sparkle`, b.sparkle(cx + size * .5, cy - size * .45, size * .2), s === "light" ? col.accent : col.onAccent, start + fr(4), end, { motionV2: pop() });
    },
    emphasis(role, box, s, start, end) {
      // A hand-drawn wave under the word.
      const w = box.right - box.left, h = box.bottom - box.top;
      b.shape(role, b.wave(box.left, box.right, box.bottom + h * .14, h * .06, Math.max(2, w / (h * 1.1)), Math.max(3, h * .07)), s === "light" ? col.second : col.onAccent,
        start, end, { revealFrom: "left", revealFrames: fr(10) });
    },
    glide: MOTION_CURVES.backOutSoft,
  };
  return kit;
}

// ---- Tech Spec: sleek (unboxing, 3C, reviews, products) -----------------------------------------------------------
function techKit(b: Base): Kit {
  const { ctx, input, col, u, Y, fr, M, CW, W, H } = b;
  const ink = () => col.ink;
  const smooth = MOTION_CURVES.quintOut;
  const kit: Kit = {
    surfaceFor: () => "light",
    type: () => ({ title: { size: 116, weight: 900, color: col.ink, family: b.heading, maxLines: 2 }, claim: { size: 136, weight: 900, color: `${col.ink}D9`, family: b.heading, maxLines: 2 },
      body: { size: 38, weight: 500, color: `${col.ink}E6`, family: b.body, maxLines: 4 }, label: { size: 34, weight: 700, color: col.ink, family: b.body, maxLines: 2 },
      lead: { size: 44, weight: 900, color: col.ink, family: b.heading, maxLines: 2 }, detail: { size: 28, weight: 500, color: col.mute, family: b.body, maxLines: 3 },
      numeral: { size: 128, weight: 400, color: col.accentInk, family: b.numerals }, small: { size: 22, weight: 700, color: col.mute, family: b.body, maxLines: 1, tracking: 3 },
      tag: { size: 34, weight: 800, color: col.accentInk, family: b.body, tracking: 1 } }),
    motion: { title: value => b.text(value, { dy: u(34), frames: fr(12), easing: smooth, staggerMax: 1, tailMax: 10 }),
      body: value => b.text(value, { perCharacter: false, dy: u(20), frames: fr(12), easing: smooth }),
      label: value => b.text(value, { perCharacter: false, dx: -u(20), dy: 0, frames: fr(12), easing: smooth }),
      numeral: value => b.text(value, { dy: u(26), frames: fr(12), easing: smooth }), pop: () => b.fade(fr(10), .8, smooth) },
    accentWord: () => col.accentInk,
    ink,
    page(_s, options = {}) {
      const layer = options.layer ?? "background";
      ctx.panel("design:page", 0, 0, W, H, 0, col.paper, layer, 0, b.end);
      b.dots("design:dots", 0, H, u(34), u(1.6), `${col.ink}17`, layer, 0, b.end);
    },
    chrome(_s, start, stop, options = {}) {
      const suffix = options.suffix ?? "", top = Y(b.D.grid.topInk), motionV2 = start === 0 ? ctx.still() : b.fade(fr(6));
      const brand = input.brandMark, kicker = options.kicker === false ? undefined : input.kicker;
      if (brand) ctx.line(`design:brand${suffix}`, brand, { size: 32, weight: 700, color: col.mute, family: b.body, tracking: 3 }, M, CW * .48, top + u(2), motionV2, start, stop);
      if (kicker) {
        const spec: DesignType = { size: 32, weight: 700, color: col.accentInk, family: b.body, tracking: 1 }, m = ctx.measure(kicker, spec, M, CW);
        const w = m.right - m.left + u(48), h = m.height + u(22), x = brand ? b.R - w : M, y = top - u(9);
        b.shape(`design:kicker:chip${suffix}`, b.ring(ctx.roundedRect(x, y, w, h, u(6)), ctx.roundedRect(x + u(2), y + u(2), w - u(4), h - u(4), u(4), false)), col.accent, start, stop, { motionV2 });
        b.shape(`design:kicker:dot${suffix}`, b.ellipseContour(x + u(16), y + h / 2, u(4.5), u(4.5)), col.accent, start, stop, { motionV2 });
        b.lineAt(`design:kicker${suffix}`, kicker, spec, x + u(30), y + u(11), motionV2, start, stop);
      }
      b.bar(`design:rule${suffix}`, M, Y(b.D.grid.topRule), CW, Math.max(1, u(1.5)), col.hairline, "foreground", start, stop, start === 0 ? fr(16) : fr(8));
    },
    footer(_s, start = 0, stop = b.end, suffix = "") {
      const y = Y(b.D.grid.footer), arm = u(22), t = Math.max(1, u(2));
      b.shape(`design:ticks${suffix}`, [...ctx.roundedRect(M, y, arm, t, 0), ...ctx.roundedRect(M, y - arm + t, t, arm, 0),
        ...ctx.roundedRect(W - M - arm, y, arm, t, 0), ...ctx.roundedRect(W - M - t, y - arm + t, t, arm, 0)], `${col.ink}59`, start, stop);
    },
    title(role, value, _s, x, width, inkTop, start, end, options = {}) {
      const spec = { ...kit.type("light").title, size: options.size ?? 116, maxLines: options.maxLines ?? 2, align: options.align ?? "left" }
      spec.size = b.fitSize(value, spec, width);
      // Spec-sheet headline: lines slide up out of their own windows, precise and fadeless.
      const rise = (t: string) => b.maskRise(t, u(spec.size) * .92);
      const pieces = ctx.inline(role, b.runsOf(value, col.ink, col.accentInk), spec, x, width, inkTop, rise, start, end,
        { clipLines: { padX: u(16), padTop: u(spec.size) * .3, padBottom: u(spec.size) * .12 } });
      return { ink: b.union(pieces.map(ctx.ink)), settled: start + b.span(value, rise(value)) };
    },
    claim: (role, value, x, width, inkTop) => { const spec = kit.type("light").claim; return ctx.line(role, value, { ...spec, size: b.fitSize(value, spec, width) }, x, width, inkTop, ctx.still(), 0, b.end); },
    strike(lines, start) {
      // Two fine accent rules cut through each claim line.
      lines.forEach((box, index) => {
        const h = box.bottom - box.top, mid = box.top + h * .52, t = Math.max(2, h * .07);
        b.shape(`strike:${index}`, [...b.stroke(box.left - u(16), mid - h * .06 + u(4), box.right + u(16), mid - h * .06 - u(4), t, 0),
          ...b.stroke(box.left - u(16), mid + h * .08 + u(4), box.right + u(16), mid + h * .08 - u(4), t, 0)], col.accent, start + index * fr(4), b.end,
        { revealFrom: "left", revealFrames: fr(10), overText: true });
      });
      return fr(13) + (lines.length - 1) * fr(4);
    },
    frame: { top: u(14), right: u(14), bottom: u(14), left: u(14) },
    image(index, rect, role, start, _s, options = {}) {
      const key = options.key ?? (options.clone ? `source:${index}:foreground` : `source:${index}`);
      if (!options.plain) {
        const glow = Math.max(rect.w, rect.h) * .9;
        ctx.panel(`${key}:glow`, rect.x + rect.w / 2 - glow / 2, rect.y + rect.h / 2 - glow * .45, glow, glow * .9, 0, `${col.accent}2E`, "background", start, b.end,
          { ellipse: true, softness: 64, motionV2: b.fade(fr(16)) });
      }
      const block = b.placeImage(index, rect, role, start, { clone: options.clone, key: options.key, focus: options.focus, opacity: options.opacity, extra: options.extra,
        mask: options.arch ? { shape: "arch" } : { shape: "rounded", radiusPixels: u(14) }, fadeFrames: fr(10), scaleFrom: 1.06, dy: options.dy });
      if (!options.plain && !options.arch) {
        const r = block.box, o = u(12);
        b.shape(`${block.key}:edge`, b.ring(ctx.roundedRect(r.x, r.y, r.w, r.h, u(14)), ctx.roundedRect(r.x + u(2), r.y + u(2), r.w - u(4), r.h - u(4), u(12), false)),
          `${col.ink}3D`, start + fr(4), b.end, { motionV2: b.fade(fr(10)) });
        b.shape(`${block.key}:brackets`, b.brackets(r, o, u(32), Math.max(2, u(4))), col.accent, start + fr(8), b.end, { motionV2: b.fade(fr(10), 1.08, smooth) });
      }
      return { ...block, outer: options.plain || options.arch ? block.box : { x: block.box.x - u(16), y: block.box.y - u(16), w: block.box.w + u(32), h: block.box.h + u(32) } };
    },
    tag(role, value, x, yTop, start, stop, _s, tone = "accent") {
      const { w, h } = kit.tagSize(value), edge = tone === "second" ? col.second : col.accent;
      const spec = { ...kit.type("light").tag, color: tone === "second" ? col.secondInk : col.accentInk };
      const motionV2 = b.fade(fr(10), 1, smooth, 0, -u(16));
      b.shape(`${role}:fill`, ctx.roundedRect(x, yTop, w, h, u(8)), `${col.paper}E6`, start, stop, { motionV2 });
      b.shape(`${role}:edge`, b.ring(ctx.roundedRect(x, yTop, w, h, u(8)), ctx.roundedRect(x + u(2), yTop + u(2), w - u(4), h - u(4), u(6), false)), edge, start, stop, { motionV2 });
      b.shape(`${role}:dot`, b.ellipseContour(x + u(20), yTop + h / 2, u(5), u(5)), edge, start, stop, { motionV2 });
      const m = b.lineSize(value, spec);
      b.lineAt(role, value, spec, x + u(36), yTop + (h - m.h) / 2, kit.motion.label(value), start + fr(3), stop);
      return { x, y: yTop, w, h };
    },
    tagSize(value) { const m = b.lineSize(value, kit.type("light").tag); return { w: m.w + u(56), h: m.h + 2 * u(16) }; },
    verdict(role, cx, cy, size, kind, start) {
      b.shape(role, ctx.roundedRect(cx - size / 2, cy - size / 2, size, size, u(8)), kind === "good" ? col.accent : col.second, start, b.end, { motionV2: kit.motion.pop() });
      const d = size, t = d * .12;
      const mark = kind === "good" ? b.polyline([[cx - .22 * d, cy + .02 * d], [cx - .06 * d, cy + .18 * d], [cx + .24 * d, cy - .16 * d]], t)
        : [...b.stroke(cx - .16 * d, cy - .16 * d, cx + .16 * d, cy + .16 * d, t), ...b.stroke(cx + .16 * d, cy - .16 * d, cx - .16 * d, cy + .16 * d, t)];
      b.shape(`${role}:mark`, mark, kind === "good" ? col.onAccent : col.onSecond, start + fr(3), b.end, { motionV2: kit.motion.pop() });
    },
    marker(role, x, y, start) { b.shape(role, b.ellipseContour(x + u(6), y + u(8), u(6), u(6)), col.accent, start, b.end, { motionV2: kit.motion.pop() }); return u(30); },
    divider(role, x, y, w, start) { b.bar(role, x, y, w, Math.max(1, u(1.5)), col.hairline, "foreground", start, b.end, fr(12), b.fade(1)); },
    card(role, rect, start, end) {
      const motionV2 = b.fade(fr(12), 1, smooth, u(30));
      b.shape(`${role}:fill`, ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(16)), col.raised, start, end, { motionV2 });
      b.shape(`${role}:edge`, b.ring(ctx.roundedRect(rect.x, rect.y, rect.w, rect.h, u(16)), ctx.roundedRect(rect.x + u(1.5), rect.y + u(1.5), rect.w - u(3), rect.h - u(3), u(14.5), false)),
        col.hairline, start, end, { motionV2 });
    },
    badge(role, x, y, size, value, emphasis, start, end) {
      b.shape(role, b.ring(ctx.roundedRect(x, y, size, size, u(8)), ctx.roundedRect(x + u(2), y + u(2), size - u(4), size - u(4), u(6), false)), emphasis ? col.second : col.accent, start, end,
        { motionV2: kit.motion.pop() });
      const spec: DesignType = { size: 42, weight: 400, color: emphasis ? col.secondInk : col.accentInk, family: b.numerals, align: "center" };
      ctx.line(`${role}:number`, value, spec, x, size, y + (size - ctx.measure(value, spec, x, size).height) / 2, b.fade(fr(8)), start + fr(3), end);
    },
    // Fine glowing rings with four handle squares, like selection bounds in a spec drawing.
    node(role, cx, cy, r, index, _sf, start, end, motionV2) {
      const edge = index % 3 === 1 ? col.second : col.accent, t = Math.max(1, u(2.5)), h = u(10);
      b.shape(`${role}:fill`, b.ellipseContour(cx, cy, r, r), `${edge}17`, start, end, { motionV2 });
      b.shape(`${role}:ring`, b.ring(b.ellipseContour(cx, cy, r, r), b.ellipseContour(cx, cy, r - t, r - t, false)), edge, start, end, { motionV2 });
      b.shape(`${role}:handles`, [[-1, 0], [1, 0], [0, -1], [0, 1]].flatMap(([dx, dy]) => ctx.roundedRect(cx + dx * r - h / 2, cy + dy * r - h / 2, h, h, 0)), edge, start, end, { motionV2 });
    },
    nodeInk: () => col.ink,
    hub(role, cx, cy, r, sf, start, end) {
      const motionV2 = kit.motion.pop();
      b.shape(`${role}:fill`, ctx.roundedRect(cx - r, cy - r * .62, 2 * r, 1.24 * r, u(12)), col.paper, start, end, { motionV2 });
      b.shape(`${role}:edge`, b.ring(ctx.roundedRect(cx - r, cy - r * .62, 2 * r, 1.24 * r, u(12)), ctx.roundedRect(cx - r + u(2.5), cy - r * .62 + u(2.5), 2 * r - u(5), 1.24 * r - u(5), u(10), false)),
        col.accent, start, end, { motionV2 });
      kit.accent(`${role}:impact`, cx, cy, r * 1.3, sf, start + fr(4));
      return col.accentInk;
    },
    halo(role, cx, cy, r, _sf, start, end) {
      // A measuring dial: the ring draws itself with a glowing head, then its ticks fade in.
      const t = Math.max(1, u(1.5)), ticks: Shape = [];
      for (let i = 0; i < 48; i++) {
        const a = i / 48 * 2 * Math.PI, inner = r - (i % 4 === 0 ? u(16) : u(8));
        ticks.push(...b.stroke(cx + inner * Math.cos(a), cy + inner * Math.sin(a), cx + r * Math.cos(a), cy + r * Math.sin(a), t, 0));
      }
      b.drawn(role, b.ellipseContour(cx, cy, r, r), `${col.accent}B3`, start, end, { width: Math.max(1, u(2)), frames: fr(16), tip: u(6), tipColor: col.accent });
      b.shape(`${role}:ticks`, ticks, `${col.accent}80`, start + fr(10), end, { motionV2: b.fade(fr(10)) });
    },
    orbit(role, cx, cy, rx, ry, tilt, _s, start, end) {
      b.ringAround(role, cx, cy, rx, ry, tilt, `${col.accent}B3`, start, end, { width: Math.max(1, u(2.5)), frames: fr(24), tip: u(6), tipColor: col.accent });
    },
    trail(role, points, _s, start, frames, end) {
      b.drawn(role, [{ type: "M", x: points[0][0], y: points[0][1] }, ...points.slice(1).map(([x, y]) => ({ type: "L" as const, x, y }))],
        `${col.accent}B3`, start, end, { width: Math.max(1, u(2.5)), frames, tip: u(5), tipColor: col.accent, cap: "butt" });
    },
    accent(role, cx, cy, size, _s, start) {
      b.impact(role, cx, cy, size, col.accent, start, { thickness: Math.max(1, u(2.5)) });
    },
    mark(role, cx, cy, size, _s, start, end) {
      // A spec chip: an outlined rounded square with a centre dot.
      const x = cx - size / 2, y = cy - size / 2, r = size * .22, motionV2 = b.fade(fr(10), 1.08, smooth);
      b.shape(role, b.ring(ctx.roundedRect(x, y, size, size, r), ctx.roundedRect(x + u(3), y + u(3), size - u(6), size - u(6), r - u(3), false)), col.accent, start, end, { motionV2 });
      b.shape(`${role}:dot`, b.ellipseContour(cx, cy, size * .14, size * .14), col.accent, start + fr(3), end, { motionV2 });
    },
    emphasis(role, box, _s, start, end) {
      // Viewfinder brackets close around the word.
      b.shape(role, b.brackets({ x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top }, u(10), u(22), Math.max(2, u(3))), col.accent, start, end,
        { motionV2: b.fade(fr(9), 1.1, smooth) });
    },
    glide: MOTION_CURVES.quintOut,
  };
  return kit;
}

// ---- Game HUD: energetic (games, esports, highlights) --------------------------------------------------------------
function gameKit(b: Base): Kit {
  const { ctx, input, col, u, Y, fr, M, CW, W, H } = b;
  const ink = () => col.ink;
  const slamIn = (value: string, scale = 1.45) => b.text(value, { dy: 0, scale, blur: u(12), frames: fr(9), easing: MOTION_CURVES.expoOut, staggerMax: 1, tailMax: 9 });
  const cut = u(22);
  const kit: Kit = {
    surfaceFor: () => "light",
    type: () => ({ title: { size: 122, weight: 900, color: col.ink, family: b.heading, maxLines: 2 }, claim: { size: 136, weight: 900, color: `${col.ink}D9`, family: b.heading, maxLines: 2 },
      body: { size: 38, weight: 700, color: `${col.ink}EB`, family: b.body, maxLines: 4 }, label: { size: 34, weight: 800, color: col.ink, family: b.body, maxLines: 2 },
      lead: { size: 46, weight: 900, color: col.ink, family: b.heading, maxLines: 2 }, detail: { size: 28, weight: 500, color: col.mute, family: b.body, maxLines: 3 },
      numeral: { size: 128, weight: 400, color: col.accentInk, family: b.numerals }, small: { size: 22, weight: 800, color: col.mute, family: b.body, maxLines: 1, tracking: 3 },
      tag: { size: 36, weight: 900, color: col.paper, family: b.heading } }),
    motion: { title: value => slamIn(value), body: value => b.text(value, { perCharacter: false, dx: u(36), dy: 0, frames: fr(8), easing: MOTION_CURVES.expoOut }),
      label: value => b.text(value, { perCharacter: false, dx: u(28), dy: 0, frames: fr(8) }), numeral: value => slamIn(value, 1.6), pop: () => b.fade(fr(7), 1.3) },
    accentWord: () => col.accentInk,
    ink,
    page(_s, options = {}) {
      const layer = options.layer ?? "background", under = layer === "background";
      ctx.panel("design:page", 0, 0, W, H, 0, col.paper, layer, 0, b.end);
      // Scanlines and speed stripes: the HUD's texture, always under the footage.
      const lines: Shape = [];
      for (let y = 0; y < H; y += u(8)) lines.push(...ctx.roundedRect(0, y, W, Math.max(1, u(2)), 0));
      b.shape("design:scanlines", lines, `${col.ink}0A`, 0, b.end, { underMedia: under });
      const stripes = (x: number, y: number, colour: string, index: number) => b.shape(`design:stripes:${index}`,
        [0, 1, 2].flatMap(i => b.slanted(x + i * u(46), y, u(26), u(220), u(120))), colour, 0, b.end, { underMedia: under });
      stripes(W - u(260), Y(120), `${col.accent}2E`, 0); stripes(-u(40), H - u(420), `${col.second}2E`, 1);
      if (options.grid) b.grid("design:grid", `${col.ink}0A`, `${col.ink}14`, layer, u(72));
    },
    chrome(_s, start, stop, options = {}) {
      const suffix = options.suffix ?? "", top = Y(b.D.grid.topInk), motionV2 = start === 0 ? ctx.still() : b.fade(fr(5));
      const brand = input.brandMark, kicker = options.kicker === false ? undefined : input.kicker;
      if (brand) {
        const spec: DesignType = { size: 32, weight: 900, color: col.onSecond, family: b.body, tracking: 1 }, m = ctx.measure(brand, spec, M + u(20), CW);
        const w = m.right - m.left + u(44), h = m.height + u(20), y = top - u(10);
        b.shape(`design:brand:tag${suffix}`, b.slanted(M, y, w, h, u(12)), col.second, start, stop, { motionV2 });
        ctx.line(`design:brand${suffix}`, brand, spec, M + u(22) - (m.left - M - u(20)), CW, y + u(10), motionV2, start, stop);
      }
      if (kicker) {
        const spec: DesignType = { size: 32, weight: 800, color: col.ink, family: b.body, tracking: 1 }, m = ctx.measure(kicker, spec, M, CW);
        const x = brand ? b.R - (m.right - m.left) - (m.left - M) : M + u(30) - (m.left - M);
        const label = b.lineAt(`design:kicker${suffix}`, kicker, spec, x + (m.left - M), top, motionV2, start, stop);
        const box = ctx.ink(label), s = u(14), cy = (box.top + box.bottom) / 2;
        b.shape(`design:kicker:play${suffix}`, b.clockwise([{ x: box.left - u(26), y: cy - s / 2 }, { x: box.left - u(26) + s, y: cy }, { x: box.left - u(26), y: cy + s / 2 }]), col.accent, start, stop, { motionV2 });
      }
      const ticks: Shape = [...ctx.roundedRect(M, Y(b.D.grid.topRule), CW, Math.max(1, u(2)), 0)];
      for (let x = M; x <= b.R; x += u(48)) ticks.push(...ctx.roundedRect(x, Y(b.D.grid.topRule) - u(6), Math.max(1, u(2)), u(6), 0));
      b.shape(`design:rule${suffix}`, ticks, `${col.ink}59`, start, stop, { revealFrom: "left", revealFrames: start === 0 ? fr(12) : fr(6) });
    },
    footer(_s, start = 0, stop = b.end, suffix = "") {
      const y = Y(1868), arm = u(46), t = Math.max(2, u(4));
      b.shape(`design:corners${suffix}`, [...ctx.roundedRect(M, y, arm, t, 0), ...ctx.roundedRect(M, y - arm + t, t, arm, 0),
        ...ctx.roundedRect(W - M - arm, y, arm, t, 0), ...ctx.roundedRect(W - M - t, y - arm + t, t, arm, 0)], col.accent, start, stop);
    },
    title(role, value, _s, x, width, inkTop, start, end, options = {}) {
      const spec = { ...kit.type("light").title, size: options.size ?? 122, maxLines: options.maxLines ?? 2, align: options.align ?? "left" }
      spec.size = b.fitSize(value, spec, width);
      // Colour split: offset copies in both HUD colours sit under the title and slam in with it.
      ctx.line(`${role}:split:0`, value, { ...spec, color: `${col.accent}D9` }, x - u(6), width, inkTop, slamIn(value), start, end);
      ctx.line(`${role}:split:1`, value, { ...spec, color: `${col.second}D9` }, x + u(6), width, inkTop + u(2), slamIn(value), start + 1, end);
      const pieces = ctx.inline(role, b.runsOf(value, col.ink, col.accentInk), spec, x, width, inkTop, t => kit.motion.title(t), start + 1, end);
      return { ink: b.union(pieces.map(ctx.ink)), settled: start + 1 + b.span(value, kit.motion.title(value)) };
    },
    claim: (role, value, x, width, inkTop) => { const spec = kit.type("light").claim; return ctx.line(role, value, { ...spec, size: b.fitSize(value, spec, width) }, x, width, inkTop, ctx.still(), 0, b.end); },
    strike(lines, start) {
      // A slash: a heavy accent bar with a thin offset echo, both over the glyphs.
      lines.forEach((box, index) => {
        const h = box.bottom - box.top, mid = box.top + h * .55;
        b.shape(`strike:${index}`, b.stroke(box.left - u(20), mid + h * .14, box.right + u(20), mid - h * .14, h * .2, 0), col.accent, start + index * fr(3), b.end,
          { revealFrom: "left", revealFrames: fr(6), overText: true });
        b.shape(`strike:${index}:echo`, b.stroke(box.left - u(8), mid + h * .14 + h * .2, box.right + u(30), mid - h * .14 + h * .2, h * .06, 0), col.second, start + index * fr(3) + fr(2), b.end,
          { revealFrom: "left", revealFrames: fr(6), overText: true });
      });
      return fr(9) + (lines.length - 1) * fr(3);
    },
    frame: { top: u(10), right: u(10), bottom: u(10), left: u(10) },
    image(index, rect, role, start, _s, options = {}) {
      const key = options.key ?? (options.clone ? `source:${index}:foreground` : `source:${index}`);
      if (!options.plain) b.shape(`${key}:plate`, b.chamfer(rect.x + u(12), rect.y + u(12), rect.w, rect.h, cut), `${col.second}8C`, start, b.end,
        { underMedia: true, motionV2: b.fade(fr(6), 1, MOTION_CURVES.expoOut, 0, -u(40)) });
      const block = b.placeImage(index, rect, role, start, { clone: options.clone, key: options.key, focus: options.focus, opacity: options.opacity, extra: options.extra,
        mask: options.arch ? { shape: "arch" } : { shape: "chamfer", radiusPixels: cut }, appearAfter: fr(2), fadeFrames: fr(7), dx: -u(48), dy: options.dy });
      if (!options.plain && !options.arch) {
        const r = block.box;
        b.shape(`${block.key}:edge`, b.ring(b.chamfer(r.x, r.y, r.w, r.h, cut), b.chamfer(r.x + u(3), r.y + u(3), r.w - u(6), r.h - u(6), cut - u(1.5), false)), col.accent,
          start + fr(5), b.end, { revealFrom: "left", revealFrames: fr(8) });
      }
      return { ...block, outer: options.plain || options.arch ? block.box : { x: block.box.x, y: block.box.y, w: block.box.w + u(12), h: block.box.h + u(12) } };
    },
    tag(role, value, x, yTop, start, stop, _s, tone = "accent") {
      const { w, h } = kit.tagSize(value), fill = tone === "second" ? col.second : tone === "ink" ? col.ink : col.accent;
      const spec = { ...kit.type("light").tag, color: tone === "second" ? col.onSecond : tone === "ink" ? col.paper : col.onAccent };
      b.shape(`${role}:fill`, b.slanted(x, yTop, w, h, u(16)), fill, start, stop, { motionV2: kit.motion.pop() });
      const m = b.lineSize(value, spec);
      b.lineAt(role, value, spec, x + u(30), yTop + (h - m.h) / 2, slamIn(value, 1.3), start + fr(2), stop);
      return { x, y: yTop, w, h };
    },
    tagSize(value) { const m = b.lineSize(value, kit.type("light").tag); return { w: m.w + u(60), h: m.h + 2 * u(16) }; },
    verdict(role, cx, cy, size, kind, start) {
      b.shape(role, b.chamfer(cx - size / 2, cy - size / 2, size, size, size * .22), kind === "good" ? col.accent : col.second, start, b.end, { motionV2: kit.motion.pop() });
      const d = size, t = d * .13;
      const mark = kind === "good" ? b.polyline([[cx - .22 * d, cy + .02 * d], [cx - .06 * d, cy + .18 * d], [cx + .24 * d, cy - .16 * d]], t)
        : [...b.stroke(cx - .16 * d, cy - .16 * d, cx + .16 * d, cy + .16 * d, t), ...b.stroke(cx + .16 * d, cy - .16 * d, cx - .16 * d, cy + .16 * d, t)];
      b.shape(`${role}:mark`, mark, kind === "good" ? col.onAccent : col.onSecond, start + fr(2), b.end, { motionV2: kit.motion.pop() });
    },
    marker(role, x, y, start) {
      const s = u(16);
      b.shape(role, b.clockwise([{ x, y }, { x: x + s, y: y + s / 2 }, { x, y: y + s }]), col.accent, start, b.end, { motionV2: kit.motion.pop() });
      return u(30);
    },
    divider(role, x, y, w, start) {
      b.shape(role, [...ctx.roundedRect(x, y, u(18), Math.max(2, u(4)), 0), ...ctx.roundedRect(x + u(26), y + u(1), w - u(26), Math.max(1, u(2)), 0)], `${col.ink}4D`, start, b.end,
        { revealFrom: "left", revealFrames: fr(8) });
    },
    card(role, rect, start, end) {
      b.shape(`${role}:fill`, b.chamfer(rect.x, rect.y, rect.w, rect.h, u(28)), col.raised, start, end, { motionV2: b.fade(fr(8), 1, MOTION_CURVES.expoOut, 0, -u(40)) });
      b.shape(`${role}:edge`, b.ring(b.chamfer(rect.x, rect.y, rect.w, rect.h, u(28)), b.chamfer(rect.x + u(2), rect.y + u(2), rect.w - u(4), rect.h - u(4), u(27), false)),
        col.accent, start + fr(3), end, { revealFrom: "left", revealFrames: fr(10) });
    },
    badge(role, x, y, size, value, emphasis, start, end) {
      b.shape(role, b.chamfer(x, y, size, size, size * .22), emphasis ? col.second : col.accent, start, end, { motionV2: kit.motion.pop() });
      const spec: DesignType = { size: 44, weight: 400, color: emphasis ? col.onSecond : col.onAccent, family: b.numerals, align: "center" };
      ctx.line(`${role}:number`, value, spec, x, size, y + (size - ctx.measure(value, spec, x, size).height) / 2, slamIn(value, 1.4), start + fr(2), end);
    },
    // Octagon cores with a hard outline in alternating HUD colours.
    node(role, cx, cy, r, index, _sf, start, end, motionV2) {
      const edge = index % 3 === 1 ? col.second : col.accent, t = Math.max(2, u(3.5));
      b.shape(`${role}:fill`, b.octagon(cx, cy, r), `${edge}2E`, start, end, { motionV2 });
      b.shape(`${role}:edge`, b.ring(b.octagon(cx, cy, r), b.octagon(cx, cy, r - t, false)), edge, start, end, { motionV2 });
    },
    nodeInk: () => col.ink,
    hub(role, cx, cy, r, sf, start, end) {
      b.shape(role, b.octagon(cx, cy, r), col.accent, start, end, { motionV2: kit.motion.pop() });
      kit.accent(`${role}:impact`, cx, cy, r * 1.3, sf, start + fr(2));
      return col.onAccent;
    },
    orbit(role, cx, cy, rx, ry, tilt, _s, start, end) {
      b.ringAround(role, cx, cy, rx, ry, tilt, `${col.second}CC`, start, end, { width: Math.max(2, u(3.5)), frames: fr(16) });
    },
    trail(role, points, _s, start, frames, end) {
      b.drawn(role, [{ type: "M", x: points[0][0], y: points[0][1] }, ...points.slice(1).map(([x, y]) => ({ type: "L" as const, x, y }))],
        col.accent, start, end, { width: Math.max(2, u(4)), frames, cap: "butt" });
    },
    accent(role, cx, cy, size, _s, start) {
      // Arcade hit: a ring, a burst of rays and a short accent flash over the frame.
      b.impact(role, cx, cy, size, col.accent, start, { rays: 12, flash: `${col.accent}4D`, thickness: Math.max(2, u(5)) });
    },
    halo(role, cx, cy, r, _sf, start, end) {
      const t = Math.max(2, u(3));
      b.shape(role, b.ring(b.octagon(cx, cy, r), b.octagon(cx, cy, r - t, false)), `${col.second}B3`, start, end, { revealFrom: "left", revealFrames: fr(10) });
    },
    mark(role, cx, cy, size, _s, start, end) {
      // A chamfered HUD badge with a slash.
      const motionV2 = b.fade(fr(7), 1.3);
      b.shape(role, b.chamfer(cx - size / 2, cy - size / 2, size, size, size * .24), col.accent, start, end, { motionV2 });
      b.shape(`${role}:slash`, b.slanted(cx - size * .12, cy - size * .3, size * .24, size * .6, size * .14), col.paper, start + fr(2), end, { motionV2 });
    },
    emphasis(role, box, _s, start, end) {
      // A slanted HUD bar behind the word.
      const h = box.bottom - box.top;
      b.shape(role, b.slanted(box.left - u(14), box.top + h * .18, box.right - box.left + u(28), h * .74, h * .3), `${col.accent}4D`, start, end,
        { revealFrom: "left", revealFrames: fr(7) });
    },
    glide: MOTION_CURVES.expoOut,
  };
  return kit;
}

// ---- Shared family grammar -----------------------------------------------------------------------------------------
/** Body copy at the Shorts reading floor: never shrunk below it; it wraps to at most `maxLines` lines or is refused. */
function bodyCopy(b: Base, k: Kit, s: Surface, value: string, width: number, align: "left" | "center" = "left", maxLines = 3): DesignType {
  const spec: DesignType = { ...k.type(s).body, align, maxLines: 4 }, lines = b.ctx.measureLines(value, spec, b.M, width).length;
  if (lines > maxLines) throw new Error(`說明在手機閱讀字級下超過 ${maxLines} 行；請縮短說明`);
  return { ...spec, maxLines: lines };
}

/** Copy broken after punctuation: a clause starts its own line when it would not fit beside the previous one, so no line
 * ends mid-phrase or strands a short word (Shorts v2). A clause too long for one line falls back to plain wrapping. */
function clauseLines(b: Base, value: string, spec: DesignType, width: number): string[] {
  const fits = (text: string) => b.ctx.measureLines(text, { ...spec, maxLines: 4 }, b.M, width).length === 1;
  const clauses = value.match(/[^，、。！？；：,!?;]+[，、。！？；：,!?;]*/g) ?? [value];
  if (clauses.length < 2 || fits(value)) return [value];
  const lines: string[] = [];
  for (const clause of clauses) {
    const joined = lines.length ? lines[lines.length - 1] + clause : "";
    if (lines.length && fits(joined)) lines[lines.length - 1] = joined; else lines.push(clause);
  }
  return lines.every(fits) ? lines : [value];
}
const leadingOf = (b: Base, spec: DesignType) => b.u(spec.size) * 1.36;
/** Ink height of `paragraph` without drawing it. */
function paragraphHeight(b: Base, value: string, spec: DesignType, width: number) {
  const lines = clauseLines(b, value, spec, width);
  return lines.length === 1 ? b.ctx.measure(value, spec, b.M, width).height
    : leadingOf(b, spec) * (lines.length - 1) + b.ctx.measure(lines[lines.length - 1], { ...spec, maxLines: 1 }, b.M, width).height;
}
/** Body copy drawn as clause lines (the first keeps `role`, later lines `role:n`); returns the union of their ink. */
function paragraph(b: Base, role: string, value: string, spec: DesignType, x: number, width: number, inkTop: number, motionV2: DesignMotion, start: number, stop: number): DesignInk {
  const lines = clauseLines(b, value, spec, width);
  if (lines.length === 1) return b.ctx.ink(b.ctx.line(role, value, spec, x, width, inkTop, motionV2, start, stop));
  return b.union(lines.map((line, index) => b.ctx.ink(b.ctx.line(index ? `${role}:${index}` : role, line, { ...spec, maxLines: 1 }, x, width,
    inkTop + index * leadingOf(b, spec), motionV2, start + index * b.fr(3), stop))));
}

/** The smallest acceptable footage window: 560 px tall, or 85% of what the footage column allows for a wide source. */
const minWindow = (b: Base, aspect: number, floor = 560) => Math.min(b.Y(floor), b.MW / aspect * .85);

/** Footage first: the largest window for the source between `top` and the media floor, centred on the canvas. */
function mediaRect(b: Base, k: Kit, aspect: number, top: number, bottom = b.mediaBottom): Rect {
  const f = k.frame;
  return b.fit(aspect, { x: b.MX + f.left, y: top + f.top, w: b.MW - f.left - f.right, h: bottom - top - f.top - f.bottom }, "center", "center");
}

/** strike_reframe hierarchy: the struck claim is set at most this share of the answer's size (the answer is the payoff). */
export const STRUCK_CLAIM_SHARE = .8;

function strikeReframe(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, end, textTop } = b, s = k.surfaceFor("strike_reframe"), previous = input.previousText!;
  // Beats: the hook (page, place, the old claim and its strike) promises; the answer, its deck, the footage and the tag pay off.
  ctx.beat({ id: "hook", narrativeRole: "promise", designRole: "first_frame", startFrame: 0 });
  k.page(s);
  // One reading slot under the chrome: the old claim, struck; once the answer has been read the claim leaves and the
  // support line takes its place as the answer's deck (no narrow side column, no copy in the platform overlay).
  // The answer is the payoff, so it always reads larger than the claim it overturns (Claude art review of the r53 T01
  // render: a 136 px struck hook over a 120 px answer inverted the hierarchy): once struck, the claim is set at most
  // STRUCK_CLAIM_SHARE of the answer's size. The hook still opens at the claim's full display size on frame 0.
  const answerSpec: DesignType = { ...k.type(s).title, maxLines: 2 }; answerSpec.size = b.fitSize(input.title, answerSpec, CW);
  const openingSpec = { ...k.type("light").claim }; openingSpec.size = b.fitSize(previous, openingSpec, CW);
  // The struck size is fitted again (one line when it fits, else two lines with no one- or two-character tail), so a long
  // hook re-wrapped at the smaller size never strands a short last line.
  const claimSpec: DesignType = { ...openingSpec, size: b.fitSize(previous, { ...openingSpec, size: Math.min(openingSpec.size, Math.floor(answerSpec.size * STRUCK_CLAIM_SHARE)) }, CW) };
  const openingLines = ctx.measureLines(previous, openingSpec, M, CW).length, claimLines = ctx.measureLines(previous, claimSpec, M, CW).length;
  const titleMotion = k.motion.title(input.title);
  // A one-line hook is read at its opening size, then glides into place before the strike (reading + settle + glide).
  const strikeStart = Math.max(ctx.readingFrames(previous) + (openingLines === 1 ? fr(26) : 0), fr(27)), strikeBound = fr(14) + (claimLines - 1) * fr(5);
  const deck = input.subtitle ? bodyCopy(b, k, s, input.subtitle, CW) : undefined, deckMotion = input.subtitle ? k.motion.body(input.subtitle) : undefined;
  const claimEnd = deck ? strikeStart + strikeBound + b.span(input.title, titleMotion) + Math.max(fr(24), ctx.readingFrames(input.title)) : end;
  if (deck) b.requireTime(b.need(input.subtitle, claimEnd - 2, deckMotion!), "說明");
  // The hook opens large and centred in the reading band (frame 0 is the feed card), then shrinks and glides up into its
  // struck place just before the strike: one scale-and-move, handed over to the struck copy at the same glyph positions.
  const deckH = deck ? paragraphHeight(b, input.subtitle!, deck, CW) : 0, claimInk0 = ctx.measure(previous, claimSpec, M, CW);
  const answerH = ctx.measure(input.title, answerSpec, M, CW).height, tagH = input.tag ? k.tagSize(input.tag).h + Y(30) : 0;
  const bandBottom = Math.max(textTop + claimInk0.height, textTop + deckH) + u(32) + answerH + tagH;
  const hookSpec: DesignType = { ...openingSpec, maxLines: 1 };
  hookSpec.size = Math.max(openingSpec.size, Math.min(Math.round(openingSpec.size * 1.45), Math.floor(40 * CW * .96 / b.lineSize(previous, { ...openingSpec, size: 40, maxLines: 1 }).w)));
  // Only a hook that opens on one line is enlarged and glides; a longer hook (up to the brief's 24 characters) wraps and
  // opens at its struck size, so its one-line hook size is never measured (it cannot fit one line).
  const hookInk = openingLines === 1 ? ctx.measure(previous, hookSpec, M, CW) : undefined, moveEnd = strikeStart - fr(2), moveStart = moveEnd - fr(10);
  const hooked = hookInk !== undefined && hookSpec.size > claimSpec.size * 1.12 && moveStart > ctx.readingFrames(previous);
  if (hooked && hookInk) {
    const hookTop = textTop + Math.max(0, (bandBottom - textTop - hookInk.height) / 2), k1 = claimSpec.size / hookSpec.size;
    const c1 = { x: (hookInk.left + hookInk.right) / 2, y: hookTop + hookInk.height / 2 }, c2 = { x: (claimInk0.left + claimInk0.right) / 2, y: textTop + claimInk0.height / 2 };
    const glide: DesignMotion = { ...ctx.still(), sequence: { ...ctx.still().sequence, unit: "all", scaleOrigin: "center" },
      exit: { durationFrames: moveEnd - moveStart, offsetXPixels: c2.x - c1.x, offsetYPixels: c2.y - c1.y, scale: k1, opacity: 1, easing: { type: "ease_in_out" } as Easing } };
    b.poster(b.opener, () => ctx.line("previous:hook", previous, hookSpec, M, CW, hookTop, glide, 0, moveEnd));
  }
  let answerStart = 0, lastLine: DesignInk | undefined;
  // The struck claim leaves as one piece (lift and an ease-in fade that ends at zero, no lingering ghost); the deck that
  // takes its slot starts only as the claim's last trace goes, so the two never share a glyph.
  const leave: DesignMotion["exit"] = { durationFrames: fr(8), offsetXPixels: 0, offsetYPixels: -u(24), scale: 1, opacity: 0, easing: MOTION_CURVES.easeIn };
  const claimInk = b.until(claimEnd, () => {
    // The kit's claim face and colour at the struck size (k.claim would refit it to the full claim size).
    const drawClaim = () => ctx.line("previous", previous, claimSpec, M, CW, textTop, ctx.still(), 0, end);
    const claim = hooked ? b.from(moveEnd, drawClaim) : drawClaim(), struck = ctx.inkLines(claim);
    answerStart = strikeStart + k.strike(struck, strikeStart); lastLine = struck[struck.length - 1];
    // The impact keeps its proportion to the struck line it lands on.
    k.accent("strike:impact", lastLine.right + u(18), (lastLine.top + lastLine.bottom) / 2, u(64) * claimSpec.size / openingSpec.size, s, answerStart - fr(3));
    return ctx.ink(claim);
  }, leave);
  b.requireTime(b.need(input.title, answerStart, titleMotion), "新主張");
  // Hao's rule (ROADMAP 1.8): the place and the brand belong to the hook only, never a permanent capsule: read for at
  // least 2.5 s, they lift away with the until scope's soft exit as the answer arrives, still drawn into the hook beat.
  b.until(Math.min(end, Math.max(answerStart, fr(75)) + fr(10)), () => k.chrome(s, 0, end));
  const slotBottom = Math.max(claimInk.bottom, deck ? textTop + paragraphHeight(b, input.subtitle!, deck, CW) : 0);
  ctx.beat({ id: "answer", narrativeRole: "payoff", designRole: "payoff", startFrame: answerStart });
  const answer = k.title("headline", input.title, s, M, CW, slotBottom + u(32), answerStart, end);
  // Sequenced handoff: the deck's first (invisible) entrance frame is the claim's last visible one, and its first visible
  // frame is the claim's last frame, already at zero opacity.
  const handoff = claimEnd - 2;
  if (deck) paragraph(b, "subtitle", input.subtitle!, deck, M, CW, textTop, deckMotion!, handoff, end);
  // The footage is the proof of the answer: the largest window below it, allowed to run under the platform overlay.
  const aspect = b.aspectOf(0, input.focusRegion), portrait = aspect < .9, tagSize = input.tag ? k.tagSize(input.tag) : undefined;
  const tagTop = answer.ink.bottom + Y(30), rect = mediaRect(b, k, aspect, (tagSize ? tagTop + tagSize.h : answer.ink.bottom) + Y(34));
  if (rect.h < minWindow(b, aspect, 520)) throw new Error("主標太長，影像區塊沒有足夠空間；請縮短文字");
  const block = k.image(0, rect, input.focusRegion ? "已觀察主體範圍的影像區塊" : "設計主題影像區塊", fr(6), s, { tilt: portrait ? -1.5 : 0, focus: input.focusRegion });
  if (input.tag) {
    const tagStart = answer.settled + fr(6);
    b.requireTime(tagStart + fr(4) + ctx.readingFrames(input.tag) + b.exitFrames, "標籤");
    k.tag("tag", input.tag, M, tagTop, tagStart, end, s);
  }
  if (hooked) { ctx.phase("hold", 0, moveStart); ctx.phase("focus", moveStart, strikeStart); } else ctx.phase("hold", 0, strikeStart);
  ctx.phase("reveal", strikeStart, answer.settled);
  if (deck) {
    const settled = handoff + fr(3) * (clauseLines(b, input.subtitle!, deck, CW).length - 1) + b.span(input.subtitle!, deckMotion!);
    ctx.phase("hold", answer.settled, handoff); ctx.phase("reveal", handoff, settled); ctx.phase("hold", settled, end - b.exitFrames);
  }
  else ctx.phase("hold", answer.settled, end - b.exitFrames);
}

function comparisonPair(b: Base, k: Kit) {
  const { ctx, input, u, X, Y, fr, M, CW, R, MX, MW, end, textTop, textBottom } = b, s = k.surfaceFor("comparison_pair");
  k.page(s); k.chrome(s, 0, end);
  b.requireTime(b.need(input.title, 0, k.motion.title(input.title)), "主標");
  const title = k.title("headline", input.title, s, M, CW, textTop, 0, end);
  const aspects = [b.aspectOf(0), b.aspectOf(1)], f = k.frame, type = k.type(s), letterSpec: DesignType = { ...type.numeral, size: 96, color: s === "light" ? b.col.accentText : b.col.onAccent };
  const deck = input.subtitle ? bodyCopy(b, k, s, input.subtitle, CW) : undefined, deckH = deck ? paragraphHeight(b, input.subtitle!, deck, CW) + Y(48) : 0;
  // Each window carries its letter and label underneath; the label row is measured, not assumed.
  const labelSpec: DesignType = { ...type.label, maxLines: 2 }, twoLines = b.lineSize("同", labelSpec).h * 2 + u(labelSpec.size) * .7;
  const labelRow = Y(28) + Math.max(b.lineSize("A", letterSpec).h, twoLines);
  const top = title.ink.bottom + Y(64), bottom = textBottom - deckH;
  let rects: Rect[];
  if (aspects.every(a => a < 1.05)) {
    // Two portrait windows side by side across the footage column; the second steps down a beat for an asymmetric read.
    const gap = X(32), colW = (MW - gap) / 2 - f.left - f.right, step = Y(90);
    const h = Math.min(...aspects.map(a => colW / a), bottom - top - step - labelRow - f.top - f.bottom);
    const used = h + step + labelRow + f.top + f.bottom, offset = Math.max(0, (bottom - top - used) / 2);
    rects = aspects.map((a, i) => b.fit(a, { x: MX + f.left + i * ((MW - gap) / 2 + gap), y: top + offset + f.top + i * step, w: colW, h }, "center"));
  } else {
    const h = (bottom - top - 2 * labelRow) / 2 - f.top - f.bottom;
    rects = aspects.map((a, i) => b.fit(a, { x: MX + f.left, y: top + f.top + i * (h + labelRow + f.top + f.bottom), w: MW - f.left - f.right, h }, "center"));
  }
  if (rects.some((r, i) => r.h < minWindow(b, aspects[i], 360) * .8)) throw new Error("主標太長，比較素材沒有足夠空間；請縮短文字");
  let lowest = 0, settled = title.settled;
  const labelInks: DesignInk[] = [];
  rects.forEach((rect, index) => b.poster(b.opener, () => {
    const start = fr(6) + index * fr(5), label = ctx.sources[index].label;
    const block = k.image(index, rect, index === 0 ? "主要比較素材" : "獨立比較素材", start, s, { clone: index > 0, key: `source:${index}`, tilt: index === 0 ? -2 : 2 });
    const rowTop = block.outer.y + block.outer.h + Y(24), rowStart = start + fr(12), letter = index === 0 ? "A" : "B", left = Math.max(M, block.box.x);
    const glyph = ctx.line(`source:${index}:letter`, letter, letterSpec, left, u(130), rowTop, k.motion.numeral(letter), rowStart, end);
    const letterInk = ctx.ink(glyph), verdict = input.verdicts?.[index], disc = u(64);
    // The label ends inside the safe column (the right window runs under the platform's action buttons).
    const right = Math.min(block.box.x + block.box.w, R), labelX = letterInk.right + X(18), labelW = right - labelX - (verdict ? disc + u(14) : 0);
    // The label enters once its letter has landed (a sliding letter never crosses it).
    const labelMotion = k.motion.label(label), labelStart = rowStart + b.span(letter, k.motion.numeral(letter));
    b.requireTime(b.need(label, labelStart, labelMotion), "素材標籤");
    // The label sits beside its letter in two lines at most: it steps down to the 40 px label floor if needed, and only
    // when even that cannot fit does it stack under the letter across the window's width.
    let spec = labelSpec, lx = labelX, lw = Math.max(u(160), labelW), ly = letterInk.top + u(4);
    const lines = (with_: DesignType, x: number, w: number) => ctx.measureLines(label, { ...with_, maxLines: 4 }, x, w).length;
    if (lines(spec, lx, lw) > 2) spec = { ...labelSpec, size: 40 };
    if (lines(spec, lx, lw) > 2) { lx = left; lw = right - left; ly = letterInk.bottom + u(10); }
    const text = ctx.line(`source:${index}:label`, label, spec, lx, lw, ly, labelMotion, labelStart, end);
    lowest = Math.max(lowest, letterInk.bottom, ctx.ink(text).bottom); labelInks[index] = ctx.ink(text);
    settled = Math.max(settled, labelStart + b.span(label, labelMotion));
    if (verdict) {
      k.verdict(`source:${index}:verdict`, right - disc / 2, letterInk.top + disc / 2, disc, verdict, rowStart + fr(9), s);
      settled = Math.max(settled, rowStart + fr(20));
    }
  }));
  // The comparison is staged: once both labels are in, A's criterion is underlined, then B's.
  const stageA = settled + fr(8), stageB = stageA + fr(20);
  if (stageB + fr(12) < end - b.exitFrames) labelInks.forEach((ink, index) => k.emphasis(`source:${index}:emphasis`, ink, s, index ? stageB : stageA, end));
  if (deck) {
    const start = fr(30), motionV2 = k.motion.body(input.subtitle!);
    b.requireTime(b.need(input.subtitle, start, motionV2), "說明");
    paragraph(b, "subtitle", input.subtitle!, deck, M, CW, lowest + Y(48), motionV2, start, end);
    settled = Math.max(settled, start + b.span(input.subtitle!, motionV2));
  }
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

function contextStack(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, R, end, col, textTop } = b, s = k.surfaceFor("context_stack"), items = input.items!, type = k.type(s);
  // Beats: the page, title and footage promise; the steps pay off from the first step's steady hold.
  ctx.beat({ id: "promise", narrativeRole: "promise", designRole: "first_frame", startFrame: 0 });
  // Hao's rule (ROADMAP 1.8): the place and the brand belong to the opening only, never a permanent capsule: read for
  // 2.5 s, then they lift away with the until scope's soft exit.
  k.page(s, { grid: true }); b.until(Math.min(end, fr(75) + fr(10)), () => k.chrome(s, 0, end));
  b.requireTime(b.need(input.title, 0, k.motion.title(input.title)), "主標");
  const title = k.title("headline", input.title, s, M, CW, textTop, 0, end);
  // One step at a time (Shorts v2): a progress row of pills, then the current step's number, label and detail in one band;
  // the order is carried by motion instead of a numbered board.
  const numeralSpec: DesignType = { ...type.numeral, size: 48, color: s === "light" ? col.accentText : col.onAccent };
  const numW = b.lineSize("00", numeralSpec).w + u(18), textX = M + numW, textW = R - textX;
  const labelSpec = (value: string): DesignType => { const spec: DesignType = { ...type.lead, size: 60, maxLines: 2 }; spec.size = Math.max(56, b.fitSize(value, spec, textW)); return spec; };
  const detailSpec: DesignType = { ...type.detail, size: 44, maxLines: 2 };
  const pillH = Math.max(4, u(8)), bandTop = title.ink.bottom + Y(52), textTopInBand = bandTop + pillH + Y(30), gap = u(14);
  const heights = items.map(item => { const label = ctx.measure(item.label, labelSpec(item.label), textX, textW).height;
    return label + (item.detail ? gap + ctx.measure(item.detail, detailSpec, textX, textW).height : 0); });
  const bandBottom = textTopInBand + Math.max(...heights);
  // A step hands over as one unit: number, label and detail roll up out of the band's window together while the next step
  // rolls in under them, a full band apart, and its progress pill fills over the same frames. Two steps never share a
  // pixel, a number never sits beside another step's label and the band is never left empty.
  const pad = u(12), band: Rect = { x: M - pad, y: textTopInBand - pad, w: R - M + 2 * pad, h: bandBottom - textTopInBand + 2 * pad };
  const roll = fr(14), rollEasing: Easing = { type: "cubic_bezier", x1: .45, y1: 0, x2: .2, y2: 1 };
  const rollIn = { durationFrames: roll, offsetXPixels: 0, offsetYPixels: band.h, scale: 1, opacity: 1, easing: rollEasing };
  const stepMotion = (leaves: boolean): DesignMotion => ({ sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" },
    entrance: rollIn, exit: leaves ? { ...rollIn, offsetYPixels: -band.h } : ctx.still().exit });
  // Timing: every step is read in full, then the spare time is shared out; the last step holds to the end.
  const firstStep = b.opener ? 0 : Math.max(fr(12), title.settled - fr(6));
  const needs = items.map(item => roll + ctx.readingFrames(item.label + (item.detail ?? "")) + b.exitFrames + fr(2));
  const total = needs.reduce((sum, value) => sum + value, 0);
  if (firstStep + total > end) throw new Error("資訊列缺少逐項閱讀時間；延長片段、縮短說明或減少項目");
  const spare = end - firstStep - total, starts: number[] = [];
  needs.reduce((at, need, index) => { starts.push(at); return at + need + Math.floor(spare / items.length) + (index < spare % items.length ? 1 : 0); }, firstStep);
  const pillW = (CW - gap * (items.length - 1)) / items.length;
  ctx.phase("reveal", 0, firstStep);
  ctx.beat({ id: "steps", narrativeRole: "payoff", designRole: "process", startFrame: starts[0] + roll, atHold: true });
  items.forEach((item, index) => b.poster(b.opener && index === 0, () => {
    const last = index === items.length - 1, start = starts[index], next = last ? end : starts[index + 1], stop = last ? end : next + roll;
    const number = String(index + 1).padStart(2, "0"), motionV2 = stepMotion(!last);
    b.poster(b.opener, () => b.bar(`item:${index}:track`, M + index * (pillW + gap), bandTop, pillW, pillH, s === "light" ? col.hairline : col.onAccentFaint, "foreground",
      Math.max(0, firstStep - fr(6)), end, 1, b.fade(fr(6)), pillH / 2));
    b.bar(`item:${index}:progress`, M + index * (pillW + gap), bandTop, pillW, pillH, s === "light" ? col.accent : col.onAccent, "foreground", start, end, roll, undefined, pillH / 2);
    ctx.line(`item:${index}:number`, number, numeralSpec, M, numW, textTopInBand + u(4), motionV2, start, stop, { clip: band });
    const label = ctx.line(`item:${index}:label`, item.label, labelSpec(item.label), textX, textW, textTopInBand, motionV2, start, stop, { clip: band });
    if (item.detail) ctx.line(`item:${index}:detail`, item.detail, detailSpec, textX, textW, ctx.ink(label).bottom + gap, motionV2, start, stop, { clip: band });
    const landed = start + roll;
    ctx.phase(index === 0 ? "reveal" : "focus", start, landed); ctx.phase("hold", landed, next - (last ? b.exitFrames : 0));
  }));
  // The footage is the context: it takes every pixel below the step band, down under the platform overlay.
  // The window's mount (mat and tape) clears the deepest step line by a full beat of air (the r53 T04 review measured the
  // detail only ~23 px above the tape).
  const aspect = b.aspectOf(0, input.focusRegion), rect = mediaRect(b, k, aspect, bandBottom + Y(64));
  if (rect.h < minWindow(b, aspect, 520)) throw new Error("資訊列太高，影像區塊沒有足夠空間；請縮短說明");
  ctx.withBeat("promise", () => k.image(0, rect, input.focusRegion ? "已觀察主體範圍的影像區塊" : "設計主題影像區塊", fr(6), s, { tilt: aspect < .9 ? -1.5 : 0, focus: input.focusRegion }));
}

function brandRecap(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, R, end, col, textTop } = b, s = k.surfaceFor("brand_recap"), items = input.items!, type = k.type(s);
  if (items.some(item => [...item.label].length > 12)) throw new Error("回顧重點最多 12 字；較長說明放在 detail");
  k.page(s); k.chrome(s, 0, end);
  b.requireTime(b.need(input.title, 0, k.motion.title(input.title)), "主標");
  // The subject leads (no oversized count): the title, then a rail of every point, then the current point, large.
  const title = k.title("headline", input.title, s, M, CW, textTop, 0, end);
  const ink = k.ink(s), quiet = s === "light" ? col.mute : col.onAccentMute, lit = s === "light" ? col.accent : col.onAccent;
  const railSpec: DesignType = { ...type.label, size: 40, maxLines: 1, align: "center", color: quiet };
  const step = items.length > 1 ? CW / items.length : CW, dot = u(11), railY = title.ink.bottom + Y(64) + dot;
  const centres = items.map((_, index) => M + step * (index + .5));
  // Rail labels only when every point is short enough to sit under its own dot; otherwise the dots alone carry the order.
  const railLabels = items.every(item => b.lineSize(item.label, railSpec).w <= step - u(16));
  const railBottom = railY + dot + (railLabels ? Y(18) + b.lineSize("0", railSpec).h : 0);
  const keySpec = (value: string): DesignType => { const spec: DesignType = { ...type.title, size: 88, maxLines: 1, color: s === "light" ? col.accentText : col.onAccent };
    spec.size = Math.max(60, b.fitSize(value, spec, CW)); return spec; };
  const detailSpec: DesignType = { ...type.lead, size: 56, maxLines: 2, color: ink };
  const eventTop = railBottom + Y(44);
  const heights = items.map(item => ctx.measure(item.label, keySpec(item.label), M, CW).height + (item.detail ? u(16) + ctx.measure(item.detail, detailSpec, M, CW).height : 0));
  const eventBottom = eventTop + Math.max(...heights);
  const firstStep = b.opener ? 0 : Math.max(fr(14), title.settled - fr(6));
  const needs = items.map(item => {
    const keyMotion = k.motion.label(item.label), detailMotion = item.detail ? k.motion.body(item.detail) : undefined;
    const read = railLabels ? ctx.readingFrames(item.detail ?? item.label) : ctx.readingFrames(item.label + (item.detail ?? ""));
    return b.span(item.label, keyMotion) + (item.detail ? b.span(item.detail, detailMotion!) : 0) + read + b.exitFrames + fr(2);
  });
  const total = needs.reduce((sum, value) => sum + value, 0);
  if (firstStep + total > end) throw new Error("回顧清單缺少逐項閱讀時間；延長片段、縮短說明或減少重點");
  const spare = end - firstStep - total, starts: number[] = [];
  needs.reduce((at, need, index) => { starts.push(at); return at + need + Math.floor(spare / items.length) + (index < spare % items.length ? 1 : 0); }, firstStep);
  // The rail: a hairline through every dot, drawn once; each dot lights as its point arrives and stays lit.
  b.poster(b.opener, () => b.bar("rail:line", centres[0], railY - Math.max(1, u(1.5)), Math.max(u(16), centres.at(-1)! - centres[0]), Math.max(2, u(3)),
    s === "light" ? col.hairline : col.onAccentFaint, "foreground", Math.max(0, firstStep - fr(8)), end, fr(14)));
  ctx.phase("reveal", 0, firstStep);
  items.forEach((item, index) => b.poster(b.opener && index === 0, () => {
    const start = starts[index], next = index === items.length - 1 ? end : starts[index + 1], stop = index === items.length - 1 ? end : next + b.exitFrames, cx = centres[index];
    b.poster(b.opener, () => {
      b.shape(`item:${index}:dot`, b.ellipseContour(cx, railY, dot, dot), s === "light" ? col.hairline : col.onAccentFaint, Math.max(0, firstStep - fr(6)), end, { motionV2: b.fade(fr(8), .6) });
      if (railLabels) { const m = b.lineSize(item.label, railSpec); b.lineAt(`item:${index}:rail`, item.label, railSpec, cx - m.w / 2, railY + dot + Y(18), b.fade(fr(8)), Math.max(0, firstStep - fr(4)), end); }
    });
    b.shape(`item:${index}:lit`, b.ellipseContour(cx, railY, dot, dot), lit, start, end, { motionV2: k.motion.pop() });
    const keyMotion = k.motion.label(item.label), detailMotion = item.detail ? k.motion.body(item.detail) : undefined;
    const key = ctx.line(`item:${index}:label`, item.label, keySpec(item.label), M, CW, eventTop, keyMotion, start, stop);
    const keyIn = start + b.span(item.label, keyMotion);
    if (item.detail) ctx.line(`item:${index}:detail`, item.detail, detailSpec, M, CW, ctx.ink(key).bottom + u(16), detailMotion!, keyIn, stop);
    const landed = item.detail ? keyIn + b.span(item.detail, detailMotion!) : keyIn;
    ctx.phase(index === 0 ? "reveal" : "focus", start, landed); ctx.phase("hold", landed, next - (index === items.length - 1 ? b.exitFrames : 0));
  }));
  // The footage below the current point, as large as the rest of the frame allows (an observed focus region may crop it).
  const aspect = b.aspectOf(0, input.focusRegion), rect = mediaRect(b, k, aspect, eventBottom + Y(28));
  if (rect.h < Y(480)) throw new Error("回顧清單太高，影像區塊沒有足夠空間；請縮短說明");
  k.image(0, rect, input.focusRegion ? "已觀察主體範圍的影像區塊" : "完整來源影像區塊", fr(8), s, { focus: input.focusRegion, tilt: 1.5 });
}

function levelBridge(b: Base, k: Kit) {
  const { ctx, input, u, X, Y, fr, W, end, col, textTop, textBottom, R, MX, MW, mediaBottom } = b, s = k.surfaceFor("level_bridge"), type = k.type(s);
  k.page(s); k.chrome(s, 0, end, { kicker: false });
  // A centred column on the canvas axis, as wide as the right safe edge allows (150-930).
  const cw = 2 * (R - W / 2), cx = W / 2 - cw / 2;
  // An opening chapter card loops: each group settles from `travel` below its place and, through the last part of its hold,
  // drifts back to exactly that pose, so the last frame is the first frame and the cut back to frame 0 does not jump.
  // Without room for a slow drift the group simply holds in place.
  const breathe = (travel: number, frames: number, easing: Easing, hold: number): Settle => hold >= 24
    ? { travel, frames, easing, drift: { dy: travel, frames: hold } } : { travel: 0, frames, easing };
  let cursor = textTop;
  if (input.kicker) {
    const spec: DesignType = { ...type.small, size: 44, weight: 800, tracking: 4, align: "center", color: k.ink(s) };
    const kickerStart = b.opener ? 0 : fr(4);
    b.requireTime(b.need(input.kicker, kickerStart, b.fade(fr(8))), "眉題");
    const box = b.poster(b.opener, () => {
      const ink = ctx.ink(ctx.line("kicker", input.kicker!, spec, cx, cw, cursor, b.fade(fr(8)), kickerStart, end));
      const t = Math.max(1, u(2)), y = (ink.top + ink.bottom) / 2 - t / 2, rule = s === "light" ? col.hairline : col.onAccentRule;
      if (ink.left - X(28) - cx > u(40)) {
        b.shape("kicker:rule:0", ctx.roundedRect(cx, y, ink.left - X(28) - cx, t, 0), rule, 0, end, { revealFrom: "right", revealFrames: fr(12) });
        b.shape("kicker:rule:1", ctx.roundedRect(ink.right + X(28), y, cx + cw - ink.right - X(28), t, 0), rule, 0, end, { revealFrom: "left", revealFrames: fr(12) });
      }
      return ink;
    }, breathe(u(16), fr(12), { type: "cubic_bezier", x1: .45, y1: 0, x2: .2, y2: 1 }, end - fr(12) - ctx.readingFrames(input.kicker!) - fr(6)));
    cursor = box.bottom + Y(40);
  }
  const titleStart = b.opener ? fr(2) : fr(8);
  b.requireTime(b.need(input.title, titleStart, k.motion.title(input.title)), "主標");
  const title = b.poster(b.opener, () => k.title("headline", input.title, s, cx, cw, cursor, titleStart, end, { size: 136, align: "center" }),
    breathe(u(30), fr(20), { type: "cubic_bezier", x1: .62, y1: 0, x2: .22, y2: 1.18 },
      end - fr(20) - ctx.readingFrames(input.title) - fr(6) - b.span(input.title, k.motion.title(input.title))));
  // The support line sits on a card straddling the window's foot, inside the safe area; the window takes every pixel above.
  const pad = u(30), deck = input.subtitle ? { ...bodyCopy(b, k, s, input.subtitle, cw - 2 * pad, "center"), color: col.ink } : undefined;
  const deckLines = deck ? clauseLines(b, input.subtitle!, deck, cw - 2 * pad) : [];
  const deckW = deck ? Math.max(...deckLines.map(line => { const m = ctx.measure(line, deck, cx + pad, cw - 2 * pad); return m.right - m.left; })) : 0;
  const plateH = deck ? paragraphHeight(b, input.subtitle!, deck, cw - 2 * pad) + 2 * pad : 0;
  const aspect = b.aspectOf(0, input.focusRegion), arch = aspect < .9, top = title.ink.bottom + Y(56), floor = mediaBottom;
  const rect = b.fit(aspect, { x: MX, y: top, w: MW, h: floor - top }, "center", arch ? "bottom" : "center");
  if (rect.h < minWindow(b, aspect)) throw new Error("主標太長，影像窗沒有足夠空間；請縮短文字");
  const glowCx = rect.x + rect.w / 2, glowCy = arch ? rect.y + rect.w * .55 : rect.y + rect.h / 2, glowColour = s === "light" ? col.accent : col.glow;
  b.poster(b.opener, () => {
    for (const [index, scale, alpha] of [[0, 1.75, "59"], [1, 1.25, "73"]] as const) {
      const w = rect.w * scale, h = rect.w * scale * .95;
      ctx.panel(`glow:${index}`, glowCx - w / 2, glowCy - h / 2, w, h, 0, `${glowColour}${alpha}`, "background", 0, end, { ellipse: true, softness: 64, motionV2: b.fade(fr(18)) });
    }
  });
  // The window already takes the whole media column (or the whole height down to the media floor), so any push-in would
  // carry the arch past x 40-1040, under the platform bar and off the canvas: it holds still and the footage moves.
  const block = k.image(0, rect, `${input.focusRegion ? "已觀察主體範圍的" : ""}${arch ? "拱形影像窗" : "章節影像窗"}`, fr(6), s, { arch, plain: true, dy: Y(70), focus: input.focusRegion });
  // The orbit only reads as an orbit while the window leaves page around it. Once the window takes most of the media
  // column the ring could only cut across the footage like a stray stroke, so it is left out.
  if (block.box.w <= MW * .8) {
    // The orbit's two halves meet just outside the window's sides, on the page (never as loose pen ends on the footage),
    // and the hand-drawn ring stays on the canvas.
    const tilt = 9 * Math.PI / 180, orbitCy = arch ? block.box.y + block.box.w * .48 : block.box.y + block.box.h * .62;
    const reach = Math.min(Math.max(block.box.w / 2 + u(18), W * .47 * Math.cos(tilt)), (W / 2 - u(10)) / 1.02);
    b.poster(b.opener, () => k.orbit("orbit", W / 2, orbitCy, reach / Math.cos(tilt), u(118), -9, s, fr(18), end));
  }
  let settled = Math.max(title.settled, block.settled, fr(40));
  if (deck) {
    const start = fr(26), motionV2 = k.motion.body(input.subtitle!);
    b.requireTime(b.need(input.subtitle, start + fr(4), motionV2), "說明");
    const plateW = Math.min(cw, deckW + 2 * pad), plate = { x: W / 2 - plateW / 2, y: Math.min(block.box.y + block.box.h - plateH / 2, textBottom - plateH), w: plateW, h: plateH };
    b.poster(b.opener, () => {
      k.card("subtitle:card", plate, start, end);
      paragraph(b, "subtitle", input.subtitle!, deck, cx + pad, cw - 2 * pad, plate.y + pad, motionV2, start + fr(4), end);
    }, breathe(u(32), fr(28), { type: "cubic_bezier", x1: .78, y1: 0, x2: .2, y2: 1.15 }, end - fr(28) - ctx.readingFrames(input.subtitle!) - fr(10)));
    settled = Math.max(settled, start + fr(4) + b.span(input.subtitle!, motionV2));
  }
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

function evidenceTakeover(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, W, H, end, D, fps, textTop, textBottom, mediaBottom } = b, s = k.surfaceFor("evidence_takeover");
  k.page(s, { grid: true });
  const move = fr(18), titleMotion = k.motion.title(input.title);
  // The opening holds until the title and the page's own small print have each been read.
  let initialHold = Math.max(b.need(input.title, 0, titleMotion) + fr(4), fr(10) + ctx.readingFrames(input.title) + fr(10),
    ...[input.brandMark, input.kicker].map(value => value ? ctx.readingFrames(value) + fr(4) + fr(10) : 0));
  const supportMotion = input.subtitle ? k.motion.body(input.subtitle) : undefined;
  // After the takeover the page comes back whole, so the title must be readable again as well as the support line. The
  // title lands first and its support line follows: the deck never rises while the title is still cascading (Claude art
  // review of the r53 T05 render, where the deck entered two frames after the returning title).
  const titleLands = b.span(input.title, titleMotion);
  const afterReturn = Math.max(fr(36), input.subtitle ? b.need(input.subtitle, titleLands + fr(2), supportMotion!) : 0, b.need(input.title, fr(2), titleMotion),
    ...[input.brandMark, input.kicker].map(value => value ? b.need(value, 0, b.fade(fr(6))) : 0));
  const deckHold = input.subtitle ? b.need(input.subtitle, Math.max(fr(10), b.span(input.title, titleMotion)) + fr(6), supportMotion!) + fr(6) : 0;
  if (deckHold > initialHold && end - move - afterReturn - (deckHold + move) >= fps * 2) initialHold = deckHold;
  const focusStart = initialHold + move, returnStart = end - move - afterReturn;
  if (returnStart - focusStart < Math.ceil(fps * 1.2)) throw new Error("接管場景需要至少 1.2 秒全畫面證據停留；延長片段或縮短標題");
  const title = b.until(initialHold, () => { k.chrome(s, 0, initialHold); return k.title("headline", input.title, s, M, CW, textTop, 0, initialHold); });
  // The window takes the height between the title and the support line (which returns under it after the takeover).
  const deck = input.subtitle ? bodyCopy(b, k, s, input.subtitle, CW) : undefined, deckAt = title.ink.bottom + Y(40);
  const deckH = deck ? paragraphHeight(b, input.subtitle!, deck, CW) + u(36) : 0;
  const aspect = b.aspectOf(0), rect = mediaRect(b, k, aspect, (deck ? deckAt + deckH : title.ink.bottom) + Y(52), mediaBottom);
  if (rect.h < minWindow(b, aspect)) throw new Error("主標太長，證據畫面沒有足夠空間；請縮短文字");
  // The block opens to the whole frame (time-continuous), holds, then returns; the source never re-times.
  const target = ctx.sourceLayout(ctx.mainAsset, { x: 0, y: 0, width: 1, height: 1 }).viewport;
  const a = { x: rect.x / W, y: rect.y / H, width: rect.w / W, height: rect.h / H }, factor = target.width / a.width;
  const full = { scale: factor, rotation: 0, x: W * (target.x + target.width / 2 - a.x - a.width / 2), y: H * (target.y + target.height / 2 - a.y - a.height / 2) };
  const block = k.image(0, rect, "來源連續的接管素材", fr(4), s, { plain: true, extra: [
    { key: "hold-end", frame: initialHold, easing: "ease_in_out" }, { key: "focus-settle", frame: focusStart, transform: full },
    { key: "focus-hold-end", frame: returnStart, transform: full, easing: "ease_in_out" }, { key: "return-settle", frame: returnStart + move }] });
  const marks = (suffix: string, start: number, stop: number) => b.shape(`marks${suffix}`, b.brackets(block.box, u(14), u(36), Math.max(1, u(3))),
    s === "light" ? b.col.accent : b.col.onAccent, start, stop, { motionV2: b.fade(fr(8)) });
  b.until(initialHold, () => marks("", fr(12), initialHold));
  // The full-frame evidence carries no overlay: nothing covers the working hands while the footage holds the screen.
  const deckStart = title.settled + fr(6);
  if (deck && b.need(input.subtitle, deckStart, supportMotion!) + fr(4) <= initialHold) b.until(initialHold, () => {
    const used = k.marker("subtitle:claim:mark", M, deckAt, deckStart, s);
    paragraph(b, "subtitle:claim", input.subtitle!, deck, M, CW, deckAt + used, supportMotion!, deckStart, initialHold);
  });
  const back = returnStart + move;
  marks(":return", back, end);
  k.chrome(s, back, end, { suffix: ":return" });
  k.title("headline:return", input.title, s, M, CW, textTop, back, end);
  if (deck) {
    const used = k.marker("subtitle:mark", M, deckAt, back + titleLands, s);
    paragraph(b, "subtitle", input.subtitle!, deck, M, CW, deckAt + used, supportMotion!, back + titleLands + fr(2), end);
  }
  ctx.phase("hold", fr(10), initialHold); ctx.phase("focus", initialHold, focusStart); ctx.phase("hold", focusStart, returnStart);
  ctx.phase("return", returnStart, back); ctx.phase("hold", back, end);
}

function focusWall(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, W, H, end, D, fps, col, MX, MW, R, textTop, textBottom } = b, s = k.surfaceFor("focus_wall"), sources = ctx.sources, count = sources.length;
  k.page(s); k.chrome(s, 0, end);
  const titleMotion = k.motion.title(input.title);
  b.requireTime(b.need(input.title, 0, titleMotion), "主標");
  const title = k.title("headline", input.title, s, M, CW, textTop, 0, end);
  // Three portrait works: one hero tile with the two others stacked beside it, each named on a sticker inside its own tile
  // (Shorts v2: a full wall instead of a thin strip). The focus beat pushes the hero in while the others step back; no
  // tile is covered and no copy of the chosen work is left behind.
  if (count === 3 && sources.every((_, index) => b.aspectOf(index) < .9)) {
    const top = title.ink.bottom + Y(56), gap = b.X(20), pad = u(18);
    const hero = b.fit(b.aspectOf(0), { x: MX, y: top, w: MW * .66, h: b.mediaBottom - top }, "left", "top");
    const sideX = hero.x + hero.w + gap, sideW = MX + MW - sideX, sideH = (hero.h - gap) / 2;
    const tiles = [hero, ...[1, 2].map((index, row) => b.fit(b.aspectOf(index), { x: sideX, y: top + row * (sideH + gap), w: sideW, h: sideH }, "center", "top"))];
    const named = sources.every((slot, index) => tiles[index].x + pad + k.tagSize(slot.label).w <= Math.min(tiles[index].x + tiles[index].w - pad, R));
    if (named) {
      const cellIn = (index: number) => b.opener ? 0 : fr(6) + index * fr(4), labelsIn = cellIn(2) + fr(8);
      const focusBegin = Math.max(b.span(input.title, titleMotion) + ctx.readingFrames(input.title),
        ...sources.map((slot, index) => labelsIn + index * fr(3) + fr(12) + ctx.readingFrames(slot.label)), Math.ceil(fps * 1.15));
      const move = fr(18), focusEnd = focusBegin + move;
      if (end - focusEnd < Math.ceil(fps * 1.5)) throw new Error("作品牆需要至少 1.5 秒聚焦停留");
      tiles.forEach((rect, index) => {
        const settle = index === 0 ? { opacity: 1, scale: 1.03 } : { opacity: .34 };
        b.poster(b.opener, () => b.placeImage(index, rect, `作品 ${index + 1} · ${sources[index].label}`, cellIn(index), { clone: index > 0, key: `source:${index}`,
          dy: Y(30), mask: { shape: "rounded", radiusPixels: u(14) }, appearAfter: fr(2),
          extra: [{ key: "focus-start", frame: focusBegin, transform: { opacity: 1 }, easing: "ease_in_out" }, { key: "focus-settle", frame: focusEnd, transform: settle }] }));
        b.poster(b.opener, () => k.tag(`source:${index}:label`, sources[index].label, rect.x + pad, rect.y + pad, labelsIn + index * fr(3),
          index === 0 ? end : focusBegin + fr(10), s));
      });
      ctx.phase("reveal", 0, labelsIn + fr(12)); ctx.phase("hold", labelsIn + fr(12), focusBegin); ctx.phase("focus", focusBegin, focusEnd);
      ctx.phase("hold", focusEnd, end - b.exitFrames);
      return;
    }
  }
  const wide = sources.every((_, index) => b.aspectOf(index) >= .9);
  const columns = wide ? (count <= 3 ? 1 : 2) : count === 3 || count > 4 ? 3 : 2, rows = Math.ceil(count / columns), gutter = b.X(24);
  // The wall spans the footage column; each cell's number and label stay inside the safe text column at a readable size.
  const area = { x: MX, y: title.ink.bottom + Y(64), w: MW, h: textBottom - title.ink.bottom - Y(64) };
  const cellW = (area.w - gutter * (columns - 1)) / columns, numeralSpec: DesignType = { ...k.type(s).numeral, size: 44, color: s === "light" ? col.accentText : col.onAccent };
  const labelSpec: DesignType = { ...k.type(s).label, size: 46, maxLines: 2 }, numeralW = b.lineSize("00", numeralSpec).w + u(12);
  const numberX = (index: number) => Math.max(M, area.x + index % columns * (cellW + gutter));
  const labelBox = (index: number) => { const x = numberX(index) + numeralW; return { x, w: Math.min(area.x + index % columns * (cellW + gutter) + cellW, R) - x }; };
  const labelRow = Y(28) + Math.max(...sources.map((slot, index) => ctx.measure(slot.label, labelSpec, labelBox(index).x, labelBox(index).w).height));
  const cellH = (area.h - rows * labelRow - Y(24) * (rows - 1)) / rows;
  // The wall sits centred in its area: cells fitted by width leave the spare height above and below, not under the title.
  const cellFill = Math.max(...sources.map((_, index) => b.fit(b.aspectOf(index), { x: 0, y: 0, w: cellW, h: cellH }).h));
  const wallY = area.y + Math.max(0, (area.h - rows * (cellFill + labelRow) - Y(24) * (rows - 1)) / 2);
  // Opening the video, the wall is already up on frame 0; elsewhere its cells drop in one after another.
  const cellIn = (index: number) => b.opener ? 0 : fr(6) + index * fr(3), labelsIn = cellIn(count - 1) + fr(8);
  // Every cell label is read in full before the chosen work takes the wall.
  const focusBegin = Math.max(b.span(input.title, titleMotion) + ctx.readingFrames(input.title),
    ...sources.map(slot => b.need(slot.label, labelsIn + fr(2), b.fade(fr(6))) - fr(2)), Math.ceil(fps * 1.15));
  const move = fr(18), focusEnd = focusBegin + move;
  if (end - focusEnd < Math.ceil(fps * 1.5)) throw new Error("作品牆需要至少 1.5 秒聚焦停留");
  // Every work shows in its own colour (food, places and products are proof only in true colour, Shorts v2); while the
  // chosen work grows, its own cell hands over to the growing copy (no ghost) and the neighbours step back.
  const cells = sources.map((slot, index) => {
    const slotRect = { x: area.x + index % columns * (cellW + gutter), y: wallY + Math.floor(index / columns) * (cellFill + labelRow + Y(24)), w: cellW, h: cellFill };
    const rect = b.fit(b.aspectOf(index), slotRect, "center", "top");
    const settled = index === 0 ? 0 : D.wall.dimOpacity;
    const block = b.poster(b.opener, () => {
      return b.placeImage(index, rect, `作品 ${index + 1} · ${slot.label}`, cellIn(index), { clone: index > 0, key: `source:${index}`, dy: Y(36),
        mask: { shape: "rounded", radiusPixels: u(10) }, appearAfter: fr(3),
        extra: [{ key: "focus-start", frame: focusBegin, transform: { opacity: 1 } }, { key: "focus-settle", frame: index === 0 ? focusBegin + fr(4) : focusEnd, transform: { opacity: settled } }] });
    });
    const number = String(index + 1).padStart(2, "0"), labelTop = block.box.y + block.box.h + Y(18), box = labelBox(index);
    b.poster(b.opener, () => {
      ctx.line(`source:${index}:number`, number, numeralSpec, numberX(index), numeralW, labelTop, b.fade(fr(6)), labelsIn, focusBegin + fr(2));
      ctx.line(`source:${index}:label`, slot.label, labelSpec, box.x, box.w, labelTop, b.fade(fr(6)), labelsIn + fr(2), focusBegin + fr(2));
    });
    return block;
  });
  // The chosen work develops in full colour from its own cell to the whole wall area.
  const first = cells[0].box;
  const { clip: foreground, layout } = ctx.place(0, { x: first.x / W, y: first.y / H, width: first.w / W, height: first.h / H },
    "選中素材連續前景（不是新證據）", true, undefined, undefined, { shape: "rounded", radiusPixels: u(10) });
  const destination = b.fit(b.aspectOf(0), area, "center", "center"), view = layout.viewport;
  const d = { x: destination.x / W, y: destination.y / H, width: destination.w / W, height: destination.h / H };
  const grow = { scale: d.width / view.width, opacity: 1, x: W * (d.x + d.width / 2 - view.x - view.width / 2), y: H * (d.y + d.height / 2 - view.y - view.height / 2) };
  ctx.animate("source:0:foreground", foreground, [{ key: "initial", frame: 0, transform: { opacity: 0 } }, { key: "hidden-hold", frame: Math.max(0, focusBegin - 1), transform: { opacity: 0 } },
    { key: "focus-start", frame: focusBegin, easing: "ease_in_out" }, { key: "focus-settle", frame: focusEnd, transform: grow }]);
  const size = k.tagSize(sources[0].label), tagStart = focusEnd - fr(6);
  b.requireTime(tagStart + fr(4) + fr(12) + ctx.readingFrames(sources[0].label) + b.exitFrames, "選中作品標籤");
  k.tag("source:0:foreground:label", sources[0].label, destination.x + u(24), destination.y + destination.h - size.h - u(24), tagStart, end, s);
  ctx.phase("reveal", 0, labelsIn + fr(8)); ctx.phase("hold", labelsIn + fr(8), focusBegin); ctx.phase("focus", focusBegin, focusEnd);
  ctx.phase("hold", focusEnd, end - b.exitFrames);
}

function kineticNetwork(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, W, end, col, textTop, textBottom } = b, s = k.surfaceFor("kinetic_network"), items = input.items!, type = k.type(s);
  const move = fr(20), entrance = fr(12), labels = input.network?.labels, hubLabel = input.network?.hubLabel;
  // Each beat holds its phrase (and, in the first beat, the node labels) for their reading time.
  const nodeRead = labels ? fr(22) + entrance + Math.max(...labels.map(label => ctx.readingFrames(label))) : 0;
  const stageFrames = items.map((item, index) => Math.max(ctx.readingFrames(item.label), ctx.readingFrames(item.detail ?? ""), index === 0 ? nodeRead : 0)
    + Math.max(move, entrance) + b.exitFrames + (index === 2 && hubLabel ? entrance : 0) + fr(10));
  const needed = stageFrames.reduce((a, c) => a + c, 0);
  if (needed > end) throw new Error("三幕動態與短語缺少閱讀停留；延長片段或縮短說明");
  const spare = end - needed, lengths = stageFrames.map((length, index) => length + Math.floor(spare / 3) + (index < spare % 3 ? 1 : 0));
  const boundaries = [0, lengths[0], lengths[0] + lengths[1], end];
  // An abstract scene: the themed page covers the live picture while its sound continues.
  k.page(s, { layer: "foreground" }); k.chrome(s, 0, end); k.footer(s);
  const quiet = s === "bold" ? col.onAccentMute : col.mute;
  // Opening the video, the first beat, its scattered nodes and the idea line are complete on frame 0 (a Short is judged on it).
  const first = (index: number, fn: () => void) => b.poster(b.opener && index === 0, fn);
  // The idea in one line at the foot of the safe area.
  const titleMotion = k.motion.body(input.title);
  b.requireTime(b.need(input.title, fr(6), titleMotion), "主標");
  const titleSpec: DesignType = { ...type.title, size: 64, maxLines: 2 };
  titleSpec.size = Math.max(60, b.fitSize(input.title, titleSpec, CW));
  const titleTop = textBottom - ctx.measure(input.title, titleSpec, M, CW).height;
  first(0, () => { ctx.line("headline", input.title, titleSpec, M, CW, titleTop, titleMotion, fr(6), end); });
  // Beat headline: the step number, the phrase set large, and its line of detail.
  let textFloor = 0, firstNumeral: DesignInk | undefined;
  const numSpec: DesignType = { ...type.numeral, size: 104 }, lead = String(items.length).padStart(2, "0").slice(0, -1);
  const leadInk = lead ? b.poster(b.opener, () => ctx.ink(ctx.line("item:number:lead", lead, numSpec, M, u(220), textTop, k.motion.numeral(lead), 0, end))) : undefined;
  items.forEach((item, index) => {
    const start = boundaries[index], next = boundaries[index + 1], stop = index === items.length - 1 ? end : next + b.exitFrames, number = String(index + 1).padStart(2, "0");
    first(index, () => {
      const digit = number.slice(lead.length), whole = ctx.measure(number, numSpec, M, u(220)), alone = ctx.measure(digit, numSpec, M, u(220));
      const digitInk = ctx.ink(b.lineAt(`item:${index}:number`, digit, numSpec, whole.right - (alone.right - alone.left), textTop, k.motion.numeral(digit), start, stop));
      const n = leadInk ? b.union([leadInk, digitInk]) : digitInk;
      firstNumeral ??= n;
      const spec: DesignType = { ...type.title, size: 160, maxLines: 2 };
      spec.size = b.fitSize(item.label, spec, CW);
      const labelMotion = index === 0 ? k.motion.title(item.label) : k.motion.label(item.label);
      const label = ctx.line(`item:${index}:label`, item.label, spec, M, CW, n.bottom + Y(28), labelMotion, start + fr(2), stop);
      let bottom = ctx.ink(label).bottom;
      if (item.detail) bottom = ctx.ink(ctx.line(`item:${index}:detail`, item.detail, { ...type.body, maxLines: 2, color: quiet }, M, CW, bottom + Y(24),
        k.motion.body(item.detail), start + fr(6), stop)).bottom;
      textFloor = Math.max(textFloor, bottom);
      ctx.phase(index === 0 ? "reveal" : "focus", start, start + move);
      ctx.phase("hold", start + Math.max(move, entrance, fr(2) + b.span(item.label, labelMotion)) + (index === 2 && hubLabel ? entrance : 0), next - b.exitFrames);
    });
  });
  // The total stays put while the step number changes beside it.
  first(0, () => b.lineAt("item:count", `/ ${String(items.length).padStart(2, "0")}`, { ...type.small, size: 34, color: quiet }, firstNumeral!.right + u(16),
    firstNumeral!.bottom - u(36), b.fade(fr(8)), b.span("01", k.motion.numeral("01")), end));
  // Three capability nodes, scaled into the room between the beat text and the idea line: scattered in beat one, gliding
  // into an overlap in beat two, joined through a hub in beat three.
  const roomTop = textFloor + Y(48), roomBottom = titleTop - Y(48), span = Y(840), sc = Math.min(1, (roomBottom - roomTop) / span);
  if (sc < .5) throw new Error("節點區塊空間不足；縮短短語或說明");
  // The hub sits where the halo (radius about 400 at full size) clears both the beat text and the idea line.
  const R = u(188) * sc, hubTarget = roomTop + ((roomBottom - roomTop) - span * sc) / 2 + Y(412) * sc, y0 = hubTarget - Y(165) * sc, at = (dy: number) => y0 + Y(dy) * sc;
  const still = ctx.still(), settle = b.fade(fr(10));
  const scatter: Array<[number, number]> = [[W * .27, at(0)], [W * .71, at(80)], [W * .45, at(395)]];
  const gather: Array<[number, number]> = [[W * .385, at(100)], [W * .615, at(100)], [W * .5, at(295)]];
  const nodeText = (role: string, value: string, cx: number, cy: number, index: number, start: number, stop: number, motionV2: DesignMotion, room = R * 1.5) => {
    const spec: DesignType = { ...type.lead, size: 54, maxLines: 1, color: k.nodeInk(index, s) };
    spec.size = Math.max(40, Math.min(spec.size, b.fitSize(value, spec, room)));
    const m = b.lineSize(value, spec);
    b.lineAt(role, value, spec, cx - m.w / 2, cy - m.h / 2, motionV2, start, stop);
  };
  // Every node is drawn before any label, so an overlapping disc never covers another node's name.
  const popStart = (index: number) => fr(10) + index * fr(4);
  const glideFrom = (index: number): DesignMotion => ({ ...settle, entrance: { durationFrames: move, offsetXPixels: scatter[index][0] - gather[index][0],
    offsetYPixels: scatter[index][1] - gather[index][1], scale: 1, opacity: 1, easing: k.glide } });
  // Beat one ends on a hard cut into beat two's node at the very same place, so the glide reads as one object.
  first(0, () => {
    scatter.forEach(([x0, y0n], index) => k.node(`node:${index}:scatter`, x0, y0n, R, index, s, popStart(index), boundaries[1], { ...k.motion.pop(), exit: still.exit }));
    if (labels) scatter.forEach(([x0, y0n], index) => nodeText(`node:${index}:scatter:label`, labels[index], x0, y0n, index, popStart(index) + fr(3), boundaries[1],
      { ...b.fade(fr(8)), exit: still.exit }));
  });
  gather.forEach(([x1, y1], index) => k.node(`node:${index}`, x1, y1, R, index, s, boundaries[1], end, glideFrom(index)));
  // Once gathered, each name sits in its node's own outer lobe, clear of the overlap and the hub; it glides there from beat one.
  const centroid = [gather.reduce((a, [x]) => a + x, 0) / 3, gather.reduce((a, [, y]) => a + y, 0) / 3];
  const lobe = gather.map(([x, y]) => { const dx = x - centroid[0], dy = y - centroid[1], d = Math.hypot(dx, dy) || 1;
    return [x + dx / d * R * .45, y + dy / d * R * .45] as [number, number]; });
  if (labels) lobe.forEach(([lx, ly], index) => nodeText(`node:${index}:label`, labels[index], lx, ly, index, boundaries[1], end,
    { ...settle, entrance: { durationFrames: move, offsetXPixels: scatter[index][0] - lx, offsetYPixels: scatter[index][1] - ly, scale: 1, opacity: 1, easing: k.glide } }, R * 1.05));
  const hubX = W * .5, hubY = (gather[0][1] + gather[1][1] + gather[2][1]) / 3, joined = boundaries[2] + fr(2);
  k.halo("network:halo", hubX, hubY, R + Math.hypot(gather[0][0] - hubX, gather[0][1] - hubY) + u(72) * sc, s, joined, end);
  const hubInk = k.hub("network:hub", hubX, hubY, u(98) * sc, s, joined + fr(4), end);
  if (hubLabel) {
    const spec: DesignType = { ...type.lead, size: 46, maxLines: 1, color: hubInk };
    spec.size = Math.max(40, Math.min(spec.size, b.fitSize(hubLabel, spec, u(160) * sc)));
    const m = b.lineSize(hubLabel, spec);
    b.lineAt("network:hub:label", hubLabel, spec, hubX - m.w / 2, hubY - m.h / 2, b.fade(fr(8), .6), joined + fr(8), end);
  }
}

/** Count-up dashboard: the first verified number lands big (a percentage fills a ring as it counts), then the others
 * count in as rows, each after the one before has been read. Only the stated numbers are drawn; no invented series. */
function statReveal(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, M, CW, W, end, D, col } = b, s = k.surfaceFor("stat_reveal"), items = input.items!, type = k.type(s);
  // An abstract data page: the themed page covers the live picture while its sound continues.
  k.page(s, { layer: "foreground", grid: true }); k.chrome(s, 0, end); k.footer(s);
  b.requireTime(b.need(input.title, 0, k.motion.title(input.title)), "主標");
  const title = k.title("headline", input.title, s, M, CW, Y(D.grid.contentTop), 0, end, { size: 104 });
  const hero = items[0], rows = items.slice(1);
  // Number setting (numeral face + unit, one-line fit, count-up, frame-safe glyph boxes) shared with the data scenes.
  const { fitLine, metrics, value, heroSize, slack } = numberKit(b, k, s);
  const detailSpec = (text: string, width: number) => { const spec: DesignType = { ...type.label, maxLines: 2 }; spec.size = b.fitSize(text, spec, width); return spec; };
  // Supporting rows sit at the foot of the page; the hero is centred in the space between the title and the rows.
  const rowValue = 120, rowGap = Y(44), rowPad = Y(26);
  const rowHeights = rows.map(item => metrics(item.label, rowValue, CW * .5).height + 2 * rowPad);
  const rowsHeight = rowHeights.reduce((sum, h) => sum + h, 0) + rowGap * Math.max(0, rows.length - 1);
  const rowsTop = Y(D.grid.contentBottom) - rowsHeight;
  const zoneTop = title.ink.bottom + Y(70), zoneBottom = rowsTop - Y(60);
  const percent = /^[+-]?\d+(?:\.\d+)?\s*%$/.test(hero.label.trim()) ? Math.max(0, Math.min(100, Number.parseFloat(hero.label))) : undefined;
  const heroDetail = hero.detail ? { text: hero.detail, spec: { ...type.body, maxLines: 2, align: "center" as const } } : undefined;
  const detailHeight = heroDetail ? ctx.measure(heroDetail.text, heroDetail.spec, b.cM, b.cW).height + Y(50) : 0;
  const heroStart = Math.max(fr(12), title.settled - fr(6));
  let heroBottom: number, heroCenter: [number, number], landed: number, heroRadius = u(300);
  if (percent !== undefined) {
    // A ring that fills to the stated share while the number counts up to it.
    const width = u(34), r = Math.max(u(170), Math.min(u(270), (zoneBottom - zoneTop - detailHeight - width) / 2));
    const cy = zoneTop + (zoneBottom - zoneTop - detailHeight) / 2, cx = W / 2;
    b.shape("hero:track", b.ring(b.ellipseContour(cx, cy, r + width / 2, r + width / 2), b.ellipseContour(cx, cy, r - width / 2, r - width / 2, false)),
      s === "light" ? col.hairline : col.onAccentFaint, heroStart, end, { motionV2: b.fade(fr(10), .92) });
    b.drawn("hero:arc", b.ellipseContour(cx, cy, r, r), s === "light" ? col.accent : col.onAccent, heroStart + fr(4), end, { width, frames: fr(24), to: Math.max(.002, percent / 100) });
    const size = fitLine(hero.label.trim(), { ...type.numeral, size: 210, maxLines: 1 }, r * 1.2);
    const h = ctx.measure(hero.label.trim(), { ...type.numeral, size, maxLines: 1 }, M, CW).height;
    const set = value("hero:value", hero.label, size, cx - r * .6, r * 1.2, cy - h / 2, heroStart + fr(4), "center");
    landed = set.landed; heroBottom = cy + r + width / 2; heroCenter = [cx, cy];
  } else {
    // The hero number is the page: centred, as large as the room and the frame allow.
    const size = heroSize(hero.label, zoneBottom - zoneTop - detailHeight), hm = metrics(hero.label, size, CW);
    const total = hm.inkWidth + hm.unitWidth, top = zoneTop + Math.max(0, (zoneBottom - zoneTop - hm.height - detailHeight) / 2);
    const set = value("hero:value", hero.label, size, (W - total) / 2, total + slack(size), top, heroStart, "left");
    landed = set.landed; heroBottom = set.box.bottom; heroCenter = [(set.box.left + set.box.right) / 2, (set.box.top + set.box.bottom) / 2];
    heroRadius = Math.max(u(220), Math.min(u(380), (set.box.bottom - set.box.top) * .85));
  }
  k.accent("hero:impact", heroCenter[0], heroCenter[1], heroRadius, s, landed - fr(2));
  let settled = landed;
  if (heroDetail) {
    const motionV2 = k.motion.body(heroDetail.text), start = landed - fr(4);
    b.requireTime(b.need(heroDetail.text, start, motionV2), "主數字說明");
    ctx.line("hero:detail", heroDetail.text, heroDetail.spec, b.cM, b.cW, heroBottom + Y(50), motionV2, start, end);
    settled = Math.max(settled, start + b.span(heroDetail.text, motionV2));
  }
  // Supporting numbers: one row each, counting in after the one before has been read.
  let start = settled + fr(10), cursor = rowsTop;
  rows.forEach((item, offset) => {
    const index = offset + 1;
    k.divider(`item:${index}:rule`, M, cursor, CW, start, s);
    const set = value(`item:${index}:value`, item.label, rowValue, M, CW * .5, cursor + rowPad, start + fr(2), "left");
    if (item.detail) {
      const detailMotion = k.motion.label(item.detail), x = Math.max(set.box.right + u(30), M + CW * .5), spec = detailSpec(item.detail, M + CW - x);
      const lines = ctx.measureLines(item.detail, spec, x, M + CW - x).length, h = ctx.measure(item.detail, spec, x, M + CW - x).height;
      b.requireTime(b.need(item.detail, set.landed - fr(2), detailMotion), "數據說明");
      ctx.line(`item:${index}:detail`, item.detail, spec, x, M + CW - x, (set.box.top + set.box.bottom) / 2 - (lines > 1 ? h / 2 : u(22)), detailMotion, set.landed - fr(2), end);
    }
    b.requireTime(set.landed + ctx.readingFrames(item.label) + b.exitFrames, "數據");
    cursor += rowHeights[offset] + rowGap; settled = Math.max(settled, set.landed);
    start = set.landed + Math.max(fr(12), ctx.readingFrames(item.label) - fr(10));
  });
  ctx.phase("reveal", 0, settled); ctx.phase("hold", settled, end - b.exitFrames);
}

/** Statement cuts: each short statement owns a beat on its own colour field inside viewfinder corners; the next field
 * grows as a circle from the centre over everything (a circle wipe), then becomes that beat's page. */
function statementCut(b: Base, k: Kit) {
  const { ctx, input, u, Y, fr, cW: CW, cM: M, W, H, end, col, textBottom } = b, items = input.items!, wipe = fr(10);
  const last = items.length - 1;
  // Each beat is read before the next circle starts to cover it; the last also holds the title and the brand.
  const needs = items.map((item, index) => {
    const opening = index === 0 ? 0 : wipe, word = k.motion.title(item.label), landed = opening + fr(2) + b.span(item.label, word);
    // The word is read, and its impact has fully faded with a short steady hold, before the next circle starts.
    let need = Math.max(opening + fr(2) + b.span(item.label, word) + ctx.readingFrames(item.label), landed + fr(24));
    if (item.detail) need = Math.max(need, landed + b.span(item.detail, k.motion.body(item.detail)) + ctx.readingFrames(item.detail));
    if (index === last) {
      need = Math.max(need, b.need(input.title, landed + fr(10), k.motion.body(input.title)));
      if (input.brandMark) need = Math.max(need, b.need(input.brandMark, landed + fr(14), b.fade(fr(8))));
    }
    return need;
  });
  const total = needs.reduce((sum, value) => sum + value, 0);
  if (total > end) throw new Error("宣言快切缺少每拍閱讀停留；延長片段或減少主張");
  const spare = end - total, lengths = needs.map((value, index) => value + Math.floor(spare / items.length) + (index < spare % items.length ? 1 : 0));
  const starts = lengths.map((_, index) => lengths.slice(0, index).reduce((sum, value) => sum + value, 0));
  const fieldOf = (index: number) => index % 2 === 0 ? { surface: "light" as Surface, color: col.paper, ink: col.ink } : { surface: "bold" as Surface, color: col.accent, ink: col.onAccent };
  const cover = (frames: number): DesignMotion => ({ sequence: { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0, exitStaggerFrames: 0, scaleOrigin: "center" },
    entrance: { durationFrames: frames, offsetXPixels: 0, offsetYPixels: 0, scale: .02, opacity: 1, easing: MOTION_CURVES.expoOut },
    exit: { durationFrames: 1, offsetXPixels: 0, offsetYPixels: 0, scale: 1, opacity: 1, easing: MOTION_CURVES.snapIn } });
  const radius = Math.hypot(W, H) / 2 + u(24);
  items.forEach((item, index) => {
    const field = fieldOf(index), begin = starts[index] + (index === 0 ? 0 : wipe), stop = index === last ? end : starts[index + 1] + wipe;
    if (index > 0) b.shape(`beat:${index}:wipe`, b.ellipseContour(W / 2, H / 2, radius, radius), field.color, starts[index], begin + 1, { overText: true, motionV2: cover(wipe) });
    ctx.panel(`beat:${index}:field`, 0, 0, W, H, 0, field.color, "foreground", begin, stop);
    // Display words stop at the numeral cap: a larger glyph box would pad past the frame edge.
    const spec: DesignType = { ...k.type(field.surface).title, size: b.D.numeralMaxPixels, maxLines: 1, align: "center", color: field.ink };
    // One line, scaled down until it fits between the corner marks (the corners sit 34px outside the ink).
    spec.size = Math.min(b.fitSize(item.label, spec, CW - u(84)), Math.floor(40 * (CW - u(84)) / b.lineSize(item.label, { ...spec, size: 40 }).w));
    const motionV2 = k.motion.title(item.label), h = ctx.measure(item.label, spec, M, CW).height, top = H * .44 - h / 2;
    const word = ctx.line(`beat:${index}:word`, item.label, spec, M, CW, top, motionV2, begin + fr(2), stop);
    const box = ctx.ink(word), landed = begin + fr(2) + b.span(item.label, motionV2);
    b.shape(`beat:${index}:corners`, b.brackets({ x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top }, u(34), u(46), Math.max(2, u(5))), field.ink,
      landed - fr(4), stop, { motionV2: b.fade(fr(8), 1.12) });
    k.accent(`beat:${index}:impact`, (box.left + box.right) / 2, (box.top + box.bottom) / 2, Math.max(box.right - box.left, box.bottom - box.top) * .62, field.surface, landed - fr(2));
    let below = box.bottom + Y(90);
    if (item.detail) {
      const detail = ctx.line(`beat:${index}:detail`, item.detail, { ...k.type(field.surface).body, color: field.ink, maxLines: 2, align: "center" }, M, CW, below,
        k.motion.body(item.detail), landed, stop);
      below = ctx.ink(detail).bottom + Y(60);
    }
    if (index === last) {
      // The closing line and the brand sit at the foot of the safe area, never under the platform's caption overlay.
      const brandSpec: DesignType = { size: 32, weight: 800, color: field.ink, family: b.body, align: "center", tracking: 2 };
      const brandTop = input.brandMark ? textBottom - ctx.measure(input.brandMark, brandSpec, M, CW).height : textBottom + Y(40);
      const headSpec: DesignType = { ...bodyCopy(b, k, field.surface, input.title, CW, "center", 2), color: field.ink };
      const headTop = Math.min(Math.max(below, Y(1400)), brandTop - Y(40) - ctx.measure(input.title, headSpec, M, CW).height);
      ctx.line("headline", input.title, headSpec, M, CW, headTop, k.motion.body(input.title), landed + fr(10), stop);
      if (input.brandMark) ctx.line("design:brand", input.brandMark, brandSpec, M, CW, brandTop, b.fade(fr(8)), landed + fr(14), stop);
    }
    // The steady hold starts once the impact has faded and every line has entered, and ends before the next wipe begins.
    const entered = Math.max(landed + fr(16), item.detail ? landed + b.span(item.detail, k.motion.body(item.detail)) : 0,
      index === last ? Math.max(landed + fr(10) + b.span(input.title, k.motion.body(input.title)), input.brandMark ? landed + fr(22) : 0) : 0);
    const holdEnd = index === last ? end - b.exitFrames : starts[index + 1];
    ctx.phase(index === 0 ? "reveal" : "focus", starts[index], Math.min(entered, holdEnd - 1)); ctx.phase("hold", Math.min(entered, holdEnd - 1), holdEnd);
  });
}

const KITS: Record<ReferenceMotionDesignSystem, (b: Base) => Kit> = { swiss_blue_v1: swissKit, trip_pop_v1: tripKit, tech_spec_v1: techKit, game_hud_v1: gameKit,
  reel_bold_v1: reelKit, reel_night_v1: reelKit, launch_clean_v1: launchKit, launch_dark_v1: launchKit };
const LAYOUTS: Record<Family, (b: Base, k: Kit) => void> = { strike_reframe: strikeReframe, comparison_pair: comparisonPair, context_stack: contextStack,
  brand_recap: brandRecap, level_bridge: levelBridge, evidence_takeover: evidenceTakeover, focus_wall: focusWall, kinetic_network: kineticNetwork,
  stat_reveal: statReveal, statement_cut: statementCut, ...SCENE_LAYOUTS };

/** Shorts v2 reading floors (1080-wide design pixels): a phone shows a 1080x1920 frame about 7 cm tall, so supporting
 * text below these sizes is not read. Body copy meets VA's 60px Shorts caption minimum. */
export const SHORTS_TYPE_FLOORS = { body: 60, lead: 56, label: 46, detail: 40, small: 34, tag: 44 } as const;

export function compileDesignThemeScene(ctx: DesignContext): void {
  const base = createBase(ctx), kit = KITS[base.themeId](base), image = kit.image, typeOf = kit.type;
  kit.type = surface => {
    const scale = typeOf(surface);
    for (const [role, floor] of Object.entries(SHORTS_TYPE_FLOORS) as Array<[keyof typeof SHORTS_TYPE_FLOORS, number]>) scale[role] = { ...scale[role], size: Math.max(scale[role].size, floor) };
    return scale;
  };
  // The opening media window of a template that starts the video is complete on its first frame (S-N: a Short is judged
  // on frame 0); later windows, clones and narrative reveals keep their own entrances.
  kit.image = (index, rect, role, start, s, options = {}) => {
    const opening = base.opener && start <= base.fr(24);
    return base.poster(opening, () => image(index, rect, role, opening ? 0 : start, s, options));
  };
  // The hook headline of an opening scene is on frame 0 too (Shorts v2: the first frame is the feed card).
  const title = kit.title;
  kit.title = (role, text, s, x, width, inkTop, start, stop, options) =>
    base.poster(base.opener && start <= base.fr(8) && !role.includes(":return"), () => title(role, text, s, x, width, inkTop, start, stop, options));
  LAYOUTS[ctx.input.templateId](base, kit);
}

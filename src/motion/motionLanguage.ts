import type { EditorCommand } from "../domain/commandTypes";
import type {
  ClipKeyframe,
  MotionGraphicV2Easing,
  MotionGraphicV2Motion,
  MotionGraphicV2Phase,
  MotionGraphicV2SequenceOrder,
  MotionGraphicV2SequenceUnit,
  TimelineClip,
  Transform2D,
} from "../domain/types";
import { motionGraphicV2UnitCount } from "../domain/motionCompositionV2Contract";
import { evaluateMotionGraphicV2Easing } from "./motionEasing";

/**
 * Hao Motion Language v1: one vocabulary for decisive, readable motion.
 *
 * Hao 2026-10-05「動態都太弱了」+ M177 tempo: fast attack, short exits, character
 * from easing (overshoot / anticipation) instead of long fades. Everything here
 * compiles to the existing motionV2 phases or to plain clip keyframes, so the
 * SVG preview, ASS export and native paint keep consuming one evaluator.
 * Amplitudes are authored at 1080 units and scale with min(width, height).
 */
export const MOTION_LANGUAGE_VERSION = "hao.motion-language/v1" as const;

export const MOTION_ENERGIES = ["calm", "standard", "punchy", "hype"] as const;
export type MotionEnergy = typeof MOTION_ENERGIES[number];

const bezier = (x1: number, y1: number, x2: number, y2: number): MotionGraphicV2Easing => ({ type: "cubic_bezier", x1, y1, x2, y2 });
// The v2 evaluator runs springs on normalized phase progress and snaps at 1;
// damping >= 14 keeps the residual below 0.1% of travel at that snap.
const spring = (stiffness: number, damping: number): MotionGraphicV2Easing => ({ type: "spring", stiffness, damping, mass: 1, initialVelocity: 0 });

export const MOTION_CURVES = Object.freeze({
  /** Fast attack (50% at 10% time, 88% at 30%), long glide: the decisive default entrance. */
  expoOut: bezier(.16, 1, .3, 1),
  quintOut: bezier(.22, 1, .36, 1),
  /** About 6% overshoot: lands with a small readable settle. */
  backOutSoft: bezier(.3, 1.35, .55, 1),
  /** About 10% overshoot. */
  backOut: bezier(.34, 1.56, .64, 1),
  /** About 16% overshoot, for hype beats only. */
  backOutStrong: bezier(.3, 1.9, .55, 1),
  /** Exit that accelerates away instead of lingering. */
  snapIn: bezier(.7, 0, .84, 0),
  /** Exit with a short wind-up against the direction of travel. */
  anticipateIn: bezier(.36, 0, .66, -.56),
  easeIn: { type: "ease_in" } as MotionGraphicV2Easing,
  // Springs run on normalized phase time, so stiffness sets bounces per phase:
  // about 1.3-1.7 visible cycles over a 14-18 frame entrance, settled by ~75%.
  /** About 7% overshoot, one visible settle. */
  springLand: spring(120, 14),
  /** About 10% overshoot. */
  springSnappy: spring(110, 12),
  /** About 19% overshoot, two short settles. */
  springPop: spring(140, 11),
});
export type MotionCurveName = keyof typeof MOTION_CURVES;

export const KINETIC_TEXT_STYLES = ["slam", "pop", "rise", "drop", "swipe", "zoom", "focus"] as const;
export type KineticTextStyle = typeof KINETIC_TEXT_STYLES[number];

type CurveTiers = readonly [calm: MotionCurveName, standard: MotionCurveName, punchy: MotionCurveName, hype: MotionCurveName];

interface KineticPhaseSpec {
  seconds: number;
  dx: number;
  dy: number;
  scale: number;
  curves: CurveTiers;
  /** Focus-pull radius, rotation (deg) and letter convergence, 1080 units. */
  blur?: number;
  rotation?: number;
  spread?: number;
}

interface KineticStyleSpec {
  label: string;
  use: string;
  unit: MotionGraphicV2SequenceUnit;
  order: MotionGraphicV2SequenceOrder;
  exitOrder: MotionGraphicV2SequenceOrder;
  staggerSeconds: number;
  exitStaggerSeconds: number;
  entrance: KineticPhaseSpec;
  exit: KineticPhaseSpec;
  /** Slow push reached at the end of the hold; whole-line styles only. */
  holdScale?: number;
}

/** Art-directed defaults at the standard tier: 1080 units, seconds at speed 1. */
export const KINETIC_TEXT_STYLE_SPECS: Readonly<Record<KineticTextStyle, Readonly<KineticStyleSpec>>> = Object.freeze({
  slam: { label: "重擊落定", use: "hook、數字、結論：整行從大且失焦縮回原位並微壓", unit: "all", order: "forward", exitOrder: "forward",
    staggerSeconds: 0, exitStaggerSeconds: 0, holdScale: 1.025,
    entrance: { seconds: .5, dx: 0, dy: 0, scale: 1.55, blur: 10, curves: ["quintOut", "backOutSoft", "backOut", "backOutStrong"] },
    exit: { seconds: .27, dx: 0, dy: 0, scale: .82, blur: 6, curves: ["easeIn", "snapIn", "snapIn", "snapIn"] } },
  pop: { label: "逐字彈出", use: "短關鍵詞、Shorts 重點：逐字從小扭轉彈到位", unit: "character", order: "forward", exitOrder: "reverse",
    staggerSeconds: .067, exitStaggerSeconds: .033,
    entrance: { seconds: .57, dx: 0, dy: 0, scale: .2, rotation: -14, curves: ["backOutSoft", "springLand", "springSnappy", "springPop"] },
    exit: { seconds: .23, dx: 0, dy: 0, scale: .4, rotation: 10, curves: ["easeIn", "snapIn", "snapIn", "snapIn"] } },
  rise: { label: "逐字上升", use: "教學長片主標與說明：失焦上升到清楚、整句一起退", unit: "character", order: "forward", exitOrder: "forward",
    staggerSeconds: .067, exitStaggerSeconds: 0,
    entrance: { seconds: .5, dx: 0, dy: 96, scale: .9, blur: 8, curves: ["quintOut", "expoOut", "backOutSoft", "backOut"] },
    exit: { seconds: .27, dx: 0, dy: -48, scale: 1, blur: 6, curves: ["easeIn", "snapIn", "snapIn", "snapIn"] } },
  drop: { label: "落下回彈", use: "轉折、答案揭曉：從上方落下並回彈", unit: "character", order: "forward", exitOrder: "reverse",
    staggerSeconds: .067, exitStaggerSeconds: .033,
    entrance: { seconds: .6, dx: 0, dy: -96, scale: 1, blur: 4, curves: ["quintOut", "springLand", "springSnappy", "springPop"] },
    exit: { seconds: .3, dx: 0, dy: 60, scale: 1, curves: ["easeIn", "anticipateIn", "anticipateIn", "anticipateIn"] } },
  swipe: { label: "橫掃聚攏", use: "步驟、清單、對照：沿閱讀方向掃入、字距收攏", unit: "character", order: "forward", exitOrder: "forward",
    staggerSeconds: .033, exitStaggerSeconds: .033,
    entrance: { seconds: .43, dx: 150, dy: 0, scale: 1, blur: 14, spread: 60, curves: ["quintOut", "expoOut", "expoOut", "backOutSoft"] },
    exit: { seconds: .27, dx: -110, dy: 0, scale: 1, blur: 10, curves: ["easeIn", "snapIn", "snapIn", "snapIn"] } },
  zoom: { label: "縱深推出", use: "章節、場景切換：整行從失焦縱深推到眼前", unit: "all", order: "forward", exitOrder: "forward",
    staggerSeconds: 0, exitStaggerSeconds: 0, holdScale: 1.03,
    entrance: { seconds: .53, dx: 0, dy: 0, scale: .3, blur: 16, curves: ["quintOut", "expoOut", "backOutSoft", "backOut"] },
    exit: { seconds: .27, dx: 0, dy: 0, scale: 1.3, blur: 10, curves: ["easeIn", "snapIn", "snapIn", "snapIn"] } },
  focus: { label: "克制聚焦", use: "詳細教學、資訊密集段：小位移對焦快速落定", unit: "all", order: "forward", exitOrder: "forward",
    staggerSeconds: 0, exitStaggerSeconds: 0, holdScale: 1.02,
    entrance: { seconds: .4, dx: 0, dy: 40, scale: .96, blur: 12, curves: ["quintOut", "quintOut", "expoOut", "backOutSoft"] },
    exit: { seconds: .23, dx: 0, dy: -20, scale: 1, blur: 8, curves: ["easeIn", "easeIn", "snapIn", "snapIn"] } },
});

/** amplitude scales offsets, scaleDepth scales |scale-1|, time scales durations. */
export const MOTION_ENERGY_PROFILES: Readonly<Record<MotionEnergy, Readonly<{ tier: 0 | 1 | 2 | 3; amplitude: number; scaleDepth: number; time: number }>>> = Object.freeze({
  calm: { tier: 0, amplitude: .55, scaleDepth: .5, time: 1.15 },
  standard: { tier: 1, amplitude: 1, scaleDepth: 1, time: 1 },
  punchy: { tier: 2, amplitude: 1.3, scaleDepth: 1.3, time: .9 },
  hype: { tier: 3, amplitude: 1.7, scaleDepth: 1.6, time: .85 },
});

/** Staggered queues longer than this read as loading, not as motion. */
export const KINETIC_MAX_ENTRANCE_TAIL_SECONDS = .5;
export const KINETIC_MAX_EXIT_TAIL_SECONDS = .25;

export interface KineticTextMotionOptions {
  fps: number;
  /** min(projectWidth, projectHeight) / 1080. */
  unit: number;
  energy?: MotionEnergy;
  /** Measured text; enables the stagger tail cap and the long-text fallback. */
  text?: string;
  /** Overrides the style's preferred unit, e.g. "word" for Latin copy. */
  sequenceUnit?: MotionGraphicV2SequenceUnit;
  /** Same meaning as the cadence speed multiplier: 2 is twice as fast. */
  animationSpeed?: number;
  /** false strips rotation/blur for native paint, which renders the four-field pose only. */
  effects?: boolean;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function assertOptions(options: KineticTextMotionOptions): void {
  if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 240) throw new Error("Motion Language fps 必須在 (0,240]");
  if (!Number.isFinite(options.unit) || options.unit <= 0 || options.unit > 8) throw new Error("Motion Language unit 必須在 (0,8]");
  const speed = options.animationSpeed ?? 1;
  if (!Number.isFinite(speed) || speed < .5 || speed > 2) throw new Error("Motion Language animationSpeed 必須在 [.5,2]");
  if (options.energy !== undefined && !MOTION_ENERGIES.includes(options.energy)) throw new Error(`未知 Motion 能量：${options.energy}`);
}

/** Unknown text (a registered preset) keeps the preferred spacing; measured
 * text caps the queue so long copy never reads as loading. */
function staggerFor(seconds: number, units: number | undefined, tailSeconds: number, fps: number, speed: number): number {
  if (seconds <= 0 || units === 1) return 0;
  const preferred = Math.max(1, Math.round(seconds * fps / speed));
  if (units === undefined) return preferred;
  return Math.min(preferred, Math.floor(Math.floor(tailSeconds * fps / speed) / (units - 1)));
}

/**
 * Compiles a named kinetic style into the existing motionV2 contract. Per-unit
 * styles whose stagger tail would exceed the cap fall back to whole lines rather
 * than silently losing their stagger, which is the failure of the brisk cap.
 */
export function kineticTextMotion(style: KineticTextStyle, options: KineticTextMotionOptions): MotionGraphicV2Motion {
  const spec = KINETIC_TEXT_STYLE_SPECS[style];
  if (!spec) throw new Error(`未知 Motion 文字風格：${style}`);
  assertOptions(options);
  const energy = MOTION_ENERGY_PROFILES[options.energy ?? "standard"];
  const speed = options.animationSpeed ?? 1, fps = options.fps;
  let unit = options.sequenceUnit ?? spec.unit;
  let units = unit === "all" ? 1 : options.text === undefined ? undefined : motionGraphicV2UnitCount({ text: options.text, motionV2: { sequence: { unit } } });
  let stagger = staggerFor(spec.staggerSeconds, units, KINETIC_MAX_ENTRANCE_TAIL_SECONDS, fps, speed);
  if (unit !== "all" && units !== undefined && units > 1 && spec.staggerSeconds > 0 && stagger === 0) { unit = "all"; units = 1; stagger = 0; }
  const exitStagger = staggerFor(spec.exitStaggerSeconds, units, KINETIC_MAX_EXIT_TAIL_SECONDS, fps, speed);
  const effects = options.effects !== false;
  const phase = (source: KineticPhaseSpec): MotionGraphicV2Phase => {
    const result: MotionGraphicV2Phase = {
      durationFrames: Math.max(1, Math.round(source.seconds * energy.time * fps / speed)),
      offsetXPixels: round3(source.dx * energy.amplitude * options.unit),
      offsetYPixels: round3(source.dy * energy.amplitude * options.unit),
      scale: round3(Math.min(2, Math.max(.05, 1 + (source.scale - 1) * energy.scaleDepth))),
      opacity: 0,
      easing: MOTION_CURVES[source.curves[energy.tier]],
    };
    // Zero fields stay omitted so receipts keep the historical four-field pose.
    if (effects && source.blur) result.blurPixels = round3(Math.min(64, source.blur * energy.amplitude * options.unit));
    if (effects && source.rotation) result.rotationDegrees = round3(Math.max(-180, Math.min(180, source.rotation * energy.amplitude)));
    if (unit !== "all" && source.spread) result.spreadPixels = round3(source.spread * energy.amplitude * options.unit);
    return result;
  };
  return {
    sequence: { unit, order: spec.order, exitOrder: spec.exitOrder, staggerFrames: stagger, exitStaggerFrames: exitStagger, scaleOrigin: "center",
      ...(spec.holdScale && unit === "all" ? { holdScale: spec.holdScale } : {}) },
    entrance: phase(spec.entrance),
    exit: phase(spec.exit),
  };
}

// ---------------------------------------------------------------------------
// Clip camera moves for real footage. Canon 🚫18 keeps generated stills static;
// these recipes are for photographed or filmed media only.

export const CLIP_MOTION_RECIPES = ["punch_in", "snap_zoom", "push_settle", "whip_in", "impact_shake", "drift_push"] as const;
export type ClipMotionRecipe = typeof CLIP_MOTION_RECIPES[number];

export interface ClipMotionRecipeOptions {
  fps: number;
  projectWidth: number;
  projectHeight: number;
  energy?: MotionEnergy;
  /** Normalized point that stays fixed while the frame scales; default center. */
  focus?: { x: number; y: number };
  /** Whip direction; 1 enters from the right, -1 from the left. */
  direction?: 1 | -1;
}

export const CLIP_MOTION_RECIPE_SPECS: Readonly<Record<ClipMotionRecipe, Readonly<{ label: string; use: string }>>> = Object.freeze({
  punch_in: { label: "重點推近", use: "旁白重點詞：5 格內推近後停住，直到下一刀" },
  snap_zoom: { label: "衝擊回縮", use: "切入第一格就放大，快速回到原框，製造落地感" },
  push_settle: { label: "推近回穩", use: "推近時略過頭再回穩，適合揭曉與成果" },
  whip_in: { label: "甩入", use: "高能量切換：從側邊甩入並帶動態模糊" },
  impact_shake: { label: "衝擊震動", use: "只給真實撞擊／爆點，8 格內衰減，不全局震動" },
  drift_push: { label: "緩推續動", use: "真實照片或長停留：整段平順推近，不抖動" },
});

interface ClipPose { x: number; y: number; scale: number; rotation: number }

/** Max deviation between baked linear keyframes and the true curve. */
const BAKE_TOLERANCE = { x: .35, y: .35, scale: .0006, rotation: .02 } as const;

function scaleAboutFocus(scale: number, options: ClipMotionRecipeOptions): { x: number; y: number } {
  const focus = options.focus ?? { x: .5, y: .5 };
  if (![focus.x, focus.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Motion 焦點必須是 0–1 的畫面座標");
  // A point p from the frame center maps to s*p + t; keeping the focus fixed needs t = (1 - s) * p.
  return { x: (1 - scale) * (focus.x - .5) * options.projectWidth, y: (1 - scale) * (focus.y - .5) * options.projectHeight };
}

function recipeSampler(recipe: ClipMotionRecipe, options: ClipMotionRecipeOptions, clipFrames: number): { frames: number; at: (frame: number) => ClipPose } {
  const energy = MOTION_ENERGY_PROFILES[options.energy ?? "standard"], fps = options.fps;
  const frames = (seconds: number) => Math.max(1, Math.min(clipFrames, Math.round(seconds * energy.time * fps)));
  const ease = (name: MotionCurveName, frame: number, total: number) => evaluateMotionGraphicV2Easing(Math.min(1, frame / total), MOTION_CURVES[name]);
  const deep = (amount: number) => 1 + amount * energy.scaleDepth;
  if (recipe === "punch_in" || recipe === "push_settle") {
    const peak = deep(recipe === "punch_in" ? .14 : .1);
    const total = frames(recipe === "punch_in" ? .17 : .43);
    const curve: MotionCurveName = recipe === "punch_in" ? "expoOut" : (["backOutSoft", "backOut", "backOut", "backOutStrong"] as const)[energy.tier];
    return { frames: total, at: (frame) => {
      const scale = 1 + (peak - 1) * ease(curve, frame, total);
      return { ...scaleAboutFocus(scale, options), scale, rotation: 0 };
    } };
  }
  if (recipe === "snap_zoom") {
    const start = deep(.18), total = frames(.27);
    return { frames: total, at: (frame) => {
      const scale = start + (1 - start) * ease("expoOut", frame, total);
      return { ...scaleAboutFocus(scale, options), scale, rotation: 0 };
    } };
  }
  if (recipe === "whip_in") {
    const total = frames(.23), travel = (options.direction ?? 1) * .42 * energy.amplitude * options.projectWidth;
    return { frames: total, at: (frame) => {
      const progress = ease("expoOut", frame, total);
      return { x: travel * (1 - progress), y: 0, scale: 1 + .06 * energy.scaleDepth * (1 - progress), rotation: (options.direction ?? 1) * 2.5 * energy.amplitude * (1 - progress) };
    } };
  }
  if (recipe === "impact_shake") {
    const total = frames(.27), amplitude = .011 * energy.amplitude * Math.min(options.projectWidth, options.projectHeight);
    // Fixed incommensurate phases: deterministic across preview, export and native.
    return { frames: total, at: (frame) => {
      const decay = (1 - frame / total) ** 2;
      return { x: amplitude * decay * Math.sin(frame * 2.7), y: amplitude * .8 * decay * Math.sin(frame * 3.9 + 1.3),
        scale: 1 + .02 * energy.scaleDepth * decay, rotation: .6 * energy.amplitude * decay * Math.sin(frame * 2.1 + .4) };
    } };
  }
  const total = clipFrames, peak = deep(.08);
  return { frames: total, at: (frame) => {
    const progress = frame / total, smooth = progress * progress * (3 - 2 * progress);
    const scale = 1 + (peak - 1) * smooth;
    return { ...scaleAboutFocus(scale, options), scale, rotation: 0 };
  } };
}

/** Keeps only the integer frames needed for linear segments to stay within tolerance. */
export function bakeClipMotionFrames(total: number, at: (frame: number) => ClipPose): number[] {
  const keep = new Set<number>([0, total]);
  const poses = Array.from({ length: total + 1 }, (_, frame) => at(frame));
  const visit = (start: number, end: number) => {
    if (end - start < 2) return;
    let worst = -1, worstFrame = -1;
    for (let frame = start + 1; frame < end; frame += 1) {
      const ratio = (frame - start) / (end - start);
      let error = 0;
      for (const key of ["x", "y", "scale", "rotation"] as const) {
        const linear = poses[start][key] + (poses[end][key] - poses[start][key]) * ratio;
        error = Math.max(error, Math.abs(poses[frame][key] - linear) / BAKE_TOLERANCE[key]);
      }
      if (error > worst) { worst = error; worstFrame = frame; }
    }
    if (worst <= 1) return;
    keep.add(worstFrame);
    visit(start, worstFrame);
    visit(worstFrame, end);
  };
  visit(0, total);
  return [...keep].sort((left, right) => left - right);
}

/**
 * Bakes a recipe into ordinary linear EditGraph keyframes. Preview, FFmpeg export
 * and the native engine already interpolate those identically, so no new easing
 * enum, renderer branch or native rebuild is needed.
 */
export function clipMotionRecipeCommands(clip: TimelineClip, recipe: ClipMotionRecipe, options: ClipMotionRecipeOptions): EditorCommand[] {
  if (!CLIP_MOTION_RECIPES.includes(recipe)) throw new Error(`未知 Motion 運鏡：${recipe}`);
  if (clip.keyframes.length) throw new Error("片段已有關鍵幀；請先確認現有動畫再套用 Motion 運鏡");
  if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 240) throw new Error("Motion 運鏡 fps 不合法");
  if (!(options.projectWidth > 0) || !(options.projectHeight > 0)) throw new Error("Motion 運鏡需要有效畫面尺寸");
  if (options.energy !== undefined && !MOTION_ENERGIES.includes(options.energy)) throw new Error(`未知 Motion 能量：${options.energy}`);
  const clipFrames = Math.floor(clip.duration * options.fps);
  if (clipFrames < 8) throw new Error("Motion 運鏡需要至少 8 格有效片段");
  const { frames, at } = recipeSampler(recipe, options, clipFrames);
  const base: Transform2D = clip.transform;
  const keyframe = (frame: number, pose: ClipPose): ClipKeyframe => ({
    id: `motion-${recipe}-${frame}`, time: frame / options.fps, easing: "linear",
    transform: { ...base, x: base.x + round3(pose.x), y: base.y + round3(pose.y), scale: round6(base.scale * pose.scale), rotation: base.rotation + round3(pose.rotation), opacity: base.opacity },
    color: { ...clip.color },
  });
  return bakeClipMotionFrames(frames, at).map((frame) => ({ type: "add_keyframe" as const, clipId: clip.id, keyframe: keyframe(frame, at(frame)) }));
}

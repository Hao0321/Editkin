import { applySecondaryHslNodeV1, compileSecondaryHslNodeV1, type CompiledSecondaryHslNodeV1 } from "./secondaryHslV1";
import { secondaryHslSourceForKeyV1 } from "../domain/secondaryHslV1Nodes";
import type {
  ColorGradeFinishingV2, ColorGradeLutRefV2, ColorGradeNodeV2, ColorGradeV2, ColorManagementSettings, ColorWheelV2,
} from "../domain/visualTypes";
import { findFilmLookV2 } from "../creative/filmLooksV2";
import { acescctOfSdrDisplay } from "./acesDisplayInverse";
import { sampleParsedCube, type ParsedCube } from "./cubeLut";
import {
  angleDifference, buildMonotoneCurve, buildPeriodicCurve, clamp, evaluateMonotoneCurve, evaluatePeriodicCurve,
  linearToAcescct, oklabHueDegrees, oklabHueToWheel, oklabToWorking, smoothstep, wheelToOklabHue, workingLumaWeights, workingToOklab,
  type GradeWorkingSpace, type MonotoneCurve, type Vec3,
} from "./gradeV2Color";

export type { GradeWorkingSpace } from "./gradeV2Color";

/**
 * Color Grade v2 CPU reference. This is the single definition of the non-spatial grade:
 * the 65³ export LUT and the preview LUT are both baked from `applyResolvedColorGradeV2`.
 * Spatial finishing (grain, halation, bloom, vignette) is described here and rendered
 * separately by FFmpeg / the preview shader in output-canvas pixels.
 */

export function gradeWorkingSpace(management?: Pick<ColorManagementSettings, "mode">): GradeWorkingSpace {
  return management?.mode === "aces2" ? "acescct" : "rec709_display";
}

/** Space-aware defaults: pivot near mid grey; log-wheel zone boundaries (DaVinci-like for ACEScct). */
export const GRADE_V2_SPACE_DEFAULTS: Record<GradeWorkingSpace, { pivot: number; lowRange: number; highRange: number }> = {
  rec709_display: { pivot: 0.45, lowRange: 0.3, highRange: 0.68 },
  acescct: { pivot: 0.435, lowRange: 0.333, highRange: 0.55 },
};

const LOG_ZONE_SOFTNESS = 0.12;
/** Width above the black point over which shadow toning fades in (working units). */
const LOG_BLACK_SOFTNESS = 0.06;
/** ACEScct code value of scene-linear 0. */
const ACESCCT_BLACK = 0.0729055341958355;
const CHROMA_WEIGHT_START = 0.004;
const CHROMA_WEIGHT_FULL = 0.03;
const CHROMA_HEADROOM_START = 0.13;
/** softClip 1 starts the roll-off at 0.86; white (1.0) then lands at ≈0.978, values up to ≈1.3 stay below 1. */
const SOFT_CLIP_RANGE = 0.14;
const CHROMA_HEADROOM_FULL = 0.3;

export interface CompiledGradeNode {
  id: string;
  secondaryHslV1?: CompiledSecondaryHslNodeV1;
  lut?: { cube: ParsedCube; strength: number; sha256: string };
  offset?: Vec3;
  lift?: Vec3;
  gain?: Vec3;
  gammaExponent?: Vec3;
  log?: { shadow: Vec3; midtone: Vec3; highlight: Vec3; low: number; high: number; black: number };
  contrast?: number;
  pivot: number;
  curveY?: MonotoneCurve;
  curveRgb?: [MonotoneCurve | undefined, MonotoneCurve | undefined, MonotoneCurve | undefined];
  saturation: number;
  colorBoost: number;
  hueVsHue?: MonotoneCurve;
  hueVsSat?: MonotoneCurve;
  hueVsLum?: MonotoneCurve;
  lumVsSat?: MonotoneCurve;
  skinProtection: number;
  skyProtection: number;
  gamutLimit: boolean;
  /** Soft-clip knee (undefined = off). */
  softClipKnee?: number;
  oklab: boolean;
  mix: number;
}

export interface ResolvedFinishingV2 {
  grain?: { amount: number; size: number };
  halation?: { amount: number; threshold: number; radius: number };
  bloom?: { amount: number; threshold: number; radius: number };
  vignette?: { amount: number };
}

export interface ResolvedColorGradeV2 {
  space: GradeWorkingSpace;
  stages: Array<{ id: string; strength: number; nodes: CompiledGradeNode[] }>;
  finishing?: ResolvedFinishingV2;
  /** True when the non-spatial part is exactly the identity (no LUT needed). */
  identity: boolean;
  /** Canonical description of the non-spatial part; equal keys bake equal LUTs. */
  key: string;
  lutRefs: ColorGradeLutRefV2[];
}

export type ColorLutResolver = (ref: ColorGradeLutRefV2) => ParsedCube;

export const FINISHING_DEFAULTS = {
  grainSize: 1,
  halation: { threshold: 0.78, radius: 0.012 },
  bloom: { threshold: 0.7, radius: 0.03 },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function wheelVector(wheel: ColorWheelV2 | undefined): Vec3 | undefined {
  if (!wheel) return undefined;
  const master = wheel.master ?? 0;
  const vector: Vec3 = [master + (wheel.r ?? 0), master + (wheel.g ?? 0), master + (wheel.b ?? 0)];
  return vector.every(value => value === 0) ? undefined : vector;
}

function identityCurve(points: Array<{ x: number; y: number }> | undefined): boolean {
  return !points || points.every(point => Math.abs(point.x - point.y) < 1e-9);
}

function neutralHueCurve(points: Array<{ value: number }> | undefined, neutral: number): boolean {
  return !points || points.every(point => Math.abs(point.value - neutral) < 1e-9);
}

/** Compiles one node; undefined when it is disabled or provably the identity. */
export function compileGradeNode(node: ColorGradeNodeV2, space: GradeWorkingSpace, resolveLut?: ColorLutResolver): CompiledGradeNode | undefined {
  if (node.enabled === false) return undefined;
  const mix = node.mix ?? 1;
  if (mix === 0) return undefined;
  if (node.secondaryHslV1) return compileSecondaryHslNodeV1(node, space, resolveLut, compileGradeNode);
  const defaults = GRADE_V2_SPACE_DEFAULTS[space];
  let lut: CompiledGradeNode["lut"];
  if (node.lut && node.lut.strength > 0) {
    if (!resolveLut) throw new Error(`調色節點 ${node.id} 引用 LUT ${node.lut.id}，但目前沒有 LUT 素材庫可解析`);
    lut = { cube: resolveLut(node.lut), strength: node.lut.strength, sha256: node.lut.sha256 };
  }
  const gammaWheel = wheelVector(node.gamma);
  const gainWheel = wheelVector(node.gain);
  const logShadow = wheelVector(node.log?.shadow), logMid = wheelVector(node.log?.midtone), logHigh = wheelVector(node.log?.highlight);
  const contrast = node.contrast ?? 1;
  const curveRgb = (["r", "g", "b"] as const).map(channel => {
    const points = node.curves?.[channel];
    return identityCurve(points) ? undefined : buildMonotoneCurve(points!.map(point => point.x), points!.map(point => point.y));
  }) as [MonotoneCurve | undefined, MonotoneCurve | undefined, MonotoneCurve | undefined];
  const periodic = (points: Array<{ hue: number; value: number }> | undefined, neutral: number) =>
    neutralHueCurve(points, neutral) ? undefined : buildPeriodicCurve(points!.map(point => point.hue), points!.map(point => point.value));
  const compiled: CompiledGradeNode = {
    id: node.id,
    ...(lut ? { lut } : {}),
    offset: wheelVector(node.offset),
    lift: wheelVector(node.lift),
    gain: gainWheel ? gainWheel.map(value => Math.max(0, 1 + value)) as Vec3 : undefined,
    gammaExponent: gammaWheel ? gammaWheel.map(value => Math.pow(2, -value)) as Vec3 : undefined,
    log: logShadow || logMid || logHigh ? {
      shadow: logShadow ?? [0, 0, 0], midtone: logMid ?? [0, 0, 0], highlight: logHigh ?? [0, 0, 0],
      low: node.log?.lowRange ?? defaults.lowRange, high: node.log?.highRange ?? defaults.highRange,
      black: space === "acescct" ? ACESCCT_BLACK : 0,
    } : undefined,
    contrast: contrast === 1 ? undefined : contrast,
    pivot: node.pivot ?? defaults.pivot,
    curveY: identityCurve(node.curves?.y) ? undefined : buildMonotoneCurve(node.curves!.y!.map(point => point.x), node.curves!.y!.map(point => point.y)),
    curveRgb: curveRgb.some(Boolean) ? curveRgb : undefined,
    saturation: node.saturation ?? 1,
    colorBoost: node.colorBoost ?? 0,
    hueVsHue: periodic(node.hueVsHue, 0),
    hueVsSat: periodic(node.hueVsSat, 1),
    hueVsLum: periodic(node.hueVsLum, 0),
    lumVsSat: !node.lumVsSat || node.lumVsSat.every(point => Math.abs(point.value - 1) < 1e-9) ? undefined
      : buildMonotoneCurve(node.lumVsSat.map(point => point.lum), node.lumVsSat.map(point => point.value)),
    skinProtection: node.skinProtection ?? 0,
    skyProtection: node.skyProtection ?? 0,
    gamutLimit: node.gamutLimit === true,
    softClipKnee: node.softClip ? 1 - SOFT_CLIP_RANGE * node.softClip : undefined,
    oklab: false,
    mix,
  };
  const oklabOperations = compiled.saturation !== 1 || compiled.colorBoost !== 0 || Boolean(compiled.hueVsHue || compiled.hueVsSat || compiled.hueVsLum || compiled.lumVsSat);
  const rgbOperations = Boolean(compiled.lut || compiled.offset || compiled.lift || compiled.gain || compiled.gammaExponent || compiled.log
    || compiled.contrast !== undefined || compiled.curveY || compiled.curveRgb || compiled.softClipKnee !== undefined);
  if (!oklabOperations && !rgbOperations) return undefined;
  compiled.oklab = oklabOperations || ((compiled.skinProtection > 0 || compiled.skyProtection > 0 || compiled.gamutLimit) && rgbOperations);
  return compiled;
}

function chromaWeight(chroma: number): number {
  return smoothstep(CHROMA_WEIGHT_START, CHROMA_WEIGHT_FULL, chroma);
}

/**
 * Skin and warm-food weight of an Oklab colour: hue 20°–92° (orange/peach/amber),
 * moderate chroma, mid lightness. Used to restore hue (fully) and chroma (60%) of
 * protected colours after a node's creative changes.
 */
export function skinWeight(lab: Vec3): number {
  const chroma = Math.hypot(lab[1], lab[2]);
  const hue = oklabHueDegrees(lab[1], lab[2]);
  return smoothstep(18, 32, hue) * (1 - smoothstep(76, 94, hue))
    * smoothstep(0.012, 0.03, chroma) * (1 - smoothstep(0.17, 0.24, chroma))
    * smoothstep(0.2, 0.36, lab[0]) * (1 - smoothstep(0.9, 0.985, lab[0]));
}

function applyNode(node: CompiledGradeNode, value: Vec3, space: GradeWorkingSpace, luma: Vec3): Vec3 {
  if (node.secondaryHslV1) return applySecondaryHslNodeV1(node.secondaryHslV1, value, (branch, rgb) => applyNode(branch, rgb, space, luma));
  const input: Vec3 = [value[0], value[1], value[2]];
  let v: Vec3 = [value[0], value[1], value[2]];
  if (node.lut) {
    const sampled = sampleParsedCube(node.lut.cube, v);
    const s = node.lut.strength;
    v = [v[0] + (sampled[0] - v[0]) * s, v[1] + (sampled[1] - v[1]) * s, v[2] + (sampled[2] - v[2]) * s];
  }
  if (node.offset) v = [v[0] + node.offset[0], v[1] + node.offset[1], v[2] + node.offset[2]];
  if (node.lift || node.gain || node.gammaExponent) {
    for (let channel = 0; channel < 3; channel += 1) {
      let x = v[channel];
      if (node.lift) x += node.lift[channel] * Math.max(0, 1 - x);
      if (node.gain) x *= node.gain[channel];
      if (node.gammaExponent && x > 0) x = Math.pow(x, node.gammaExponent[channel]);
      v[channel] = x;
    }
  }
  if (node.log) {
    const y = luma[0] * v[0] + luma[1] * v[1] + luma[2] * v[2];
    // Shadow toning fades in above the black point, so black itself stays neutral and never crushes.
    const shadow = (1 - smoothstep(node.log.low - LOG_ZONE_SOFTNESS, node.log.low + LOG_ZONE_SOFTNESS, y)) * smoothstep(node.log.black, node.log.black + LOG_BLACK_SOFTNESS, y);
    const highlight = smoothstep(node.log.high - LOG_ZONE_SOFTNESS, node.log.high + LOG_ZONE_SOFTNESS, y);
    const midtone = Math.max(0, 1 - shadow - highlight);
    for (let channel = 0; channel < 3; channel += 1) {
      v[channel] += node.log.shadow[channel] * shadow + node.log.midtone[channel] * midtone + node.log.highlight[channel] * highlight;
    }
  }
  if (node.contrast !== undefined) {
    const pivot = node.pivot, contrast = node.contrast;
    v = [(v[0] - pivot) * contrast + pivot, (v[1] - pivot) * contrast + pivot, (v[2] - pivot) * contrast + pivot];
  }
  if (node.curveY) {
    const y = luma[0] * v[0] + luma[1] * v[1] + luma[2] * v[2];
    const delta = evaluateMonotoneCurve(node.curveY, y) - y;
    v = [v[0] + delta, v[1] + delta, v[2] + delta];
  }
  if (node.curveRgb) {
    for (let channel = 0; channel < 3; channel += 1) {
      const curve = node.curveRgb[channel];
      if (curve) v[channel] = evaluateMonotoneCurve(curve, v[channel]);
    }
  }
  if (node.oklab) {
    const lab = workingToOklab(v, space);
    let lightness = lab[0];
    let chroma = Math.hypot(lab[1], lab[2]);
    const chromaBefore = chroma;
    let hue = oklabHueDegrees(lab[1], lab[2]);
    const weight = chromaWeight(chroma);
    const wheel = oklabHueToWheel(hue);
    if (node.hueVsHue && weight > 0) hue = wheelToOklabHue(wheel + evaluatePeriodicCurve(node.hueVsHue, wheel) * weight);
    let scale = node.saturation;
    // Vibrance: strongest on muted colours, but never on near-neutrals (no casts on whites and greys).
    if (node.colorBoost !== 0) scale *= 1 + node.colorBoost * (1 - smoothstep(0, 0.2, chroma)) * smoothstep(0.01, 0.04, chroma);
    if (node.hueVsSat && weight > 0) scale *= 1 + (evaluatePeriodicCurve(node.hueVsSat, wheel) - 1) * weight;
    if (node.lumVsSat) scale *= Math.max(0, evaluateMonotoneCurve(node.lumVsSat, clamp(lightness, 0, 1)));
    // Chroma headroom: increases fade out for colours that are already strongly saturated,
    // so boosts never drive them into the gamut edge (no clipping kinks, no hue skew).
    if (scale > 1) scale = 1 + (scale - 1) * (1 - smoothstep(CHROMA_HEADROOM_START, CHROMA_HEADROOM_FULL, chroma));
    chroma *= Math.max(0, scale);
    if (node.hueVsLum && weight > 0) lightness += evaluatePeriodicCurve(node.hueVsLum, wheel) * weight;
    if (node.skinProtection > 0 || node.skyProtection > 0) {
      const source = workingToOklab(input, space);
      const sourceHue = oklabHueDegrees(source[1], source[2]);
      const protectSkin = node.skinProtection > 0 ? skinWeight(source) * node.skinProtection : 0;
      if (protectSkin > 0) {
        const sourceChroma = Math.hypot(source[1], source[2]);
        hue += angleDifference(hue, sourceHue) * protectSkin;
        chroma += (sourceChroma - chroma) * protectSkin * 0.6;
      }
      const protectSky = node.skyProtection > 0 ? skyWeight(source) * node.skyProtection : 0;
      if (protectSky > 0) hue += angleDifference(hue, sourceHue) * protectSky;
    }
    const radians = hue * Math.PI / 180;
    const cos = Math.cos(radians), sin = Math.sin(radians);
    v = oklabToWorking([lightness, chroma * cos, chroma * sin], space);
    // Every per-pixel bound contains the working gamut, so in-gamut results skip the limiter entirely.
    if (node.gamutLimit && !insideWorkingGamut(v, space)) {
      if (space === "acescct" && !insideWorkingGamut(input, space)) {
        // Scene-referred input already above the AP1 ceiling (HLG highlights, saturated lights): only held —
        // no extra chroma — and left to the ACES 2.0 output transform's own gamut compression. Pulling it
        // inside, or pinning its level while the look lifts tone, would grey vivid colours (W1 sheets).
        if (chroma > chromaBefore) v = oklabToWorking([lightness, chromaBefore * cos, chromaBefore * sin], space);
      } else {
        // Display Rec.709 never passes the input's own level (no new clipping); otherwise the working gamut.
        const bounds = gamutBoundsFor(input, space);
        if (!withinGamutBounds(v, bounds) && withinGamutBounds(oklabToWorking([lightness, 0, 0], space), bounds)) {
          // Largest chroma (same lightness and hue) inside this pixel's bounds.
          let low = 0, high = chroma;
          for (let step = 0; step < 8; step += 1) {
            const middle = (low + high) / 2;
            if (withinGamutBounds(oklabToWorking([lightness, middle * cos, middle * sin], space), bounds)) low = middle; else high = middle;
          }
          v = oklabToWorking([lightness, low * cos, low * sin], space);
        }
      }
    }
  }
  if (node.softClipKnee !== undefined) {
    const knee = node.softClipKnee, range = 1 - knee;
    for (let channel = 0; channel < 3; channel += 1) {
      if (v[channel] <= knee) continue;
      const x = (v[channel] - knee) / range;
      v[channel] = knee + range * x / Math.pow(1 + x ** 4, 0.25);
    }
  }
  if (node.mix < 1) v = [input[0] + (v[0] - input[0]) * node.mix, input[1] + (v[1] - input[1]) * node.mix, input[2] + (v[2] - input[2]) * node.mix];
  return v;
}

/**
 * Blue-sky weight: Oklab hue 205°–280° (azure to blue), low-to-moderate chroma, mid-to-high
 * lightness. Restoring this hue keeps toning from rotating pale skies toward purple or cyan.
 */
export function skyWeight(lab: Vec3): number {
  const chroma = Math.hypot(lab[1], lab[2]);
  const hue = oklabHueDegrees(lab[1], lab[2]);
  return smoothstep(195, 212, hue) * (1 - smoothstep(272, 290, hue))
    * smoothstep(0.006, 0.02, chroma) * (1 - smoothstep(0.2, 0.28, chroma))
    * smoothstep(0.4, 0.55, lab[0]);
}

/**
 * Working-display gamut used by gamutLimit: Rec.709 display codes, or AP1 linear below the ACES 2.0
 * SDR saturated-clip point. The ceiling leaves headroom for 4:2:0 delivery: chroma subsampling
 * overshoots saturated edges by several code values after decode.
 */
export const GAMUT_LIMIT = { rec709Max: 0.965, ap1LinearMax: 1.25 } as const;
/** [low, high] per channel in the working encoding (ACEScct is monotonic in linear light, so it compares directly). */
export type GamutBounds = readonly [low: number, high: number];
const REC709_GAMUT: GamutBounds = [0, GAMUT_LIMIT.rec709Max];
const AP1_GAMUT: GamutBounds = [linearToAcescct(0), linearToAcescct(GAMUT_LIMIT.ap1LinearMax)];

/**
 * Bounds one node's gamut limit enforces for one pixel: the working gamut, widened to the node input's
 * own channel extremes when that input already left it. A display colour may stay as far out as it came
 * in, never further (no new clipping, no greying to force it inside). ACES inputs above the ceiling are
 * held instead (see applyNode).
 */
export function gamutBoundsFor(input: Vec3, space: GradeWorkingSpace): GamutBounds {
  const gamut = space === "acescct" ? AP1_GAMUT : REC709_GAMUT;
  return [Math.min(gamut[0], input[0], input[1], input[2]), Math.max(gamut[1], input[0], input[1], input[2])];
}

/** Hot path of the 65³ bake: plain comparisons, no allocation, no transfer function. */
export function withinGamutBounds(rgb: Vec3, bounds: GamutBounds): boolean {
  const low = bounds[0], high = bounds[1];
  return rgb[0] >= low && rgb[0] <= high && rgb[1] >= low && rgb[1] <= high && rgb[2] >= low && rgb[2] <= high;
}

export function insideWorkingGamut(rgb: Vec3, space: GradeWorkingSpace): boolean {
  return withinGamutBounds(rgb, space === "acescct" ? AP1_GAMUT : REC709_GAMUT);
}

/** Applies the resolved non-spatial grade to one working-space RGB triple (unclamped). */
export function applyResolvedColorGradeV2(resolved: ResolvedColorGradeV2, rgb: Vec3): Vec3 {
  if (resolved.identity) return [rgb[0], rgb[1], rgb[2]];
  const luma = workingLumaWeights(resolved.space);
  let value: Vec3 = [rgb[0], rgb[1], rgb[2]];
  for (const stage of resolved.stages) {
    const input = value;
    let output = value;
    for (const node of stage.nodes) output = applyNode(node, output, resolved.space, luma);
    value = stage.strength >= 1 ? output : [
      input[0] + (output[0] - input[0]) * stage.strength,
      input[1] + (output[1] - input[1]) * stage.strength,
      input[2] + (output[2] - input[2]) * stage.strength,
    ];
  }
  return value;
}

function resolveFinishing(source: ColorGradeFinishingV2 | undefined, scale: number): ResolvedFinishingV2 | undefined {
  if (!source) return undefined;
  const result: ResolvedFinishingV2 = {};
  if (source.grain && source.grain.amount * scale > 0) result.grain = { amount: source.grain.amount * scale, size: source.grain.size ?? FINISHING_DEFAULTS.grainSize };
  if (source.halation && source.halation.amount * scale > 0) result.halation = { amount: source.halation.amount * scale,
    threshold: source.halation.threshold ?? FINISHING_DEFAULTS.halation.threshold, radius: source.halation.radius ?? FINISHING_DEFAULTS.halation.radius };
  if (source.bloom && source.bloom.amount * scale > 0) result.bloom = { amount: source.bloom.amount * scale,
    threshold: source.bloom.threshold ?? FINISHING_DEFAULTS.bloom.threshold, radius: source.bloom.radius ?? FINISHING_DEFAULTS.bloom.radius };
  if (source.vignette && source.vignette.amount * scale > 0) result.vignette = { amount: source.vignette.amount * scale };
  return Object.keys(result).length ? result : undefined;
}

/** Resolves user nodes, the referenced Film Look (for this working space) and finishing. */
export function resolveColorGradeV2(grade: ColorGradeV2, space: GradeWorkingSpace, resolveLut?: ColorLutResolver): ResolvedColorGradeV2 {
  const stages: ResolvedColorGradeV2["stages"] = [];
  const keyStages: unknown[] = [];
  const lutRefs: ColorGradeLutRefV2[] = [];
  const userNodes = (grade.nodes ?? []).flatMap(node => {
    const compiled = compileGradeNode(node, space, resolveLut);
    if (!compiled) return [];
    if (compiled.secondaryHslV1) lutRefs.push(...compiled.secondaryHslV1.lutRefs);
    else if (compiled.lut && node.lut) lutRefs.push(node.lut);
    return [{ compiled, source: secondaryHslSourceForKeyV1(node) }];
  });
  if (userNodes.length) {
    stages.push({ id: "nodes", strength: 1, nodes: userNodes.map(entry => entry.compiled) });
    keyStages.push({ stage: "nodes", nodes: userNodes.map(entry => entry.source) });
  }
  let lookFinishing: ColorGradeFinishingV2 | undefined;
  const strength = grade.look?.strength ?? 1;
  if (grade.look) {
    const look = findFilmLookV2(grade.look.id);
    if (!look) throw new Error(`找不到 Hao Film Look v2：${grade.look.id}`);
    const definition = look.grade(space);
    lookFinishing = definition.finishing;
    if (strength > 0) {
      const nodes = definition.nodes.flatMap(node => compileGradeNode(node, space) ?? []);
      if (nodes.length) {
        stages.push({ id: `look:${look.id}`, strength, nodes });
        keyStages.push({ stage: `look:${look.id}`, strength, nodes: definition.nodes });
      }
    }
  }
  const finishing = grade.finishing !== undefined ? resolveFinishing(grade.finishing, 1) : resolveFinishing(lookFinishing, strength);
  return {
    space, stages, ...(finishing ? { finishing } : {}), identity: stages.length === 0,
    key: canonical({ schema: "editkin.color-grade-bake/v1", space, stages: keyStages }), lutRefs,
  };
}

/** Convenience for tests and probes: one working-space pixel through a grade. */
export function applyColorGradeV2Rgb(grade: ColorGradeV2, space: GradeWorkingSpace, rgb: Vec3, resolveLut?: ColorLutResolver): Vec3 {
  return applyResolvedColorGradeV2(resolveColorGradeV2(grade, space, resolveLut), rgb);
}

// ---------------------------------------------------------------- spatial finishing reference

/**
 * Display-referred glow threshold → working-space threshold. ACEScct uses the level the ACES 2.0 SDR output
 * transform renders at that display code (its neutral inverse), so "glow above display 0.8" means the same
 * picture area in both spaces. (pro-w1-1: the former BT.1886 γ2.4 scene model put display 0.8 at ACEScct
 * 0.511 — display ≈0.6 after the output transform — and haloed the upper mid-tones.)
 */
export function finishingThresholdInWorkingSpace(threshold: number, space: GradeWorkingSpace): number {
  if (space === "rec709_display") return threshold;
  return acescctOfSdrDisplay(threshold);
}

/** FFmpeg `vignette` angle for an amount 0–1 (1 = corners reach black). */
export function vignetteAngle(amount: number): number {
  return clamp(amount, 0, 1) * Math.PI / 2;
}

/** Exact vf_vignette forward factor at pixel (x, y): cos(angle·d)^4, integer-truncated offsets, 8-bit white mask. */
export function vignetteMaskValue(x: number, y: number, width: number, height: number, amount: number): number {
  const angle = vignetteAngle(amount);
  const dx = Math.trunc(x - width / 2), dy = Math.trunc(y - height / 2);
  const distance = Math.hypot(dx, dy) / Math.hypot(width / 2, height / 2);
  if (distance > 1) return 0;
  const c = Math.cos(angle * distance);
  return Math.trunc(255 * c * c * c * c) / 255;
}

export const HALATION_TINT: Vec3 = [1, 0.36, 0.1];
export const BLOOM_TINT: Vec3 = [1, 0.97, 0.92];
/** Grain strength for FFmpeg `noise` (Gaussian, σ ≈ strength/√3 code values) from amount and size. */
export function grainNoiseStrength(amount: number, size: number): number {
  return Math.max(1, Math.round(clamp(amount, 0, 1) * 18 * Math.sqrt(Math.max(1, size))));
}

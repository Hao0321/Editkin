import type { ColorCurvePointV2, ColorGradeFinishingV2, ColorGradeNodeV2, HueCurvePointV2, LumCurvePointV2 } from "../domain/visualTypes";
import { buildMonotoneCurve, evaluateMonotoneCurve, type GradeWorkingSpace } from "../color/gradeV2Color";
import { acescctOfSdrDisplay } from "../color/acesDisplayInverse";
import type { LookPreset } from "./corePack";

/**
 * Hao Film Looks v2 — original Editkin looks built from zone toning (log wheels),
 * S-curves / log contrast, hue-vs-saturation, skin/food protection and optional
 * grain/halation. No third-party LUT packs, presets or reference grades are copied.
 *
 * Each look is resolved per working space (display Rec.709 or ACEScct), so the same
 * look id renders correctly in both pipelines (K-572055e8540d: A/B in Rec.709 and ACES,
 * never one hard-coded LUT). Parameters are frozen per id: a visual change ships as a
 * new id or re-opens certification. CERTIFICATION below records which parameter sets
 * passed a visual review; the measurements and sheets live in the evidence folder.
 */
export type FilmLookGenre = "travel" | "food" | "night" | "tech" | "gaming" | "vlog" | "teaching" | "hype";

export interface FilmLookV2Certification {
  /** certified: passed every visual gate on the listed clips in Rec.709 and ACES and was inspected on contact sheets. */
  status: "certified" | "refused" | "pending";
  evidence?: string;
}

export interface FilmLookV2Definition {
  id: string;
  name: string;
  genre: FilmLookGenre;
  summary: string;
  license: "MIT";
  provenance: "Editkin original parametric film look (Claude, 2026-10)";
  certification: FilmLookV2Certification;
  grade(space: GradeWorkingSpace): { nodes: ColorGradeNodeV2[]; finishing?: ColorGradeFinishingV2 };
}

export const FILM_LOOK_GENRES: readonly FilmLookGenre[] = ["travel", "food", "night", "tech", "gaming", "vlog", "teaching", "hype"];

interface HueBand { center: number; width: number; value: number }

/** Triangular hue band on the hue wheel: `value` at `center`, fading to neutral at ±width. */
function band(center: number, width: number, value: number, _neutral: number): HueBand {
  return { center, width, value };
}

const wrapHue = (hue: number) => Math.round((((hue % 360) + 360) % 360) * 1000) / 1000;

/**
 * Sums overlapping bands (neutral + Σ band deltas) and samples the sum at every band
 * centre and edge, giving one strictly increasing periodic control-point curve.
 */
function hueCurve(neutral: number, ...bands: HueBand[]): HueCurvePointV2[] {
  const keys = [...new Set(bands.flatMap(item => [item.center - item.width, item.center, item.center + item.width].map(wrapHue)))].sort((a, b) => a - b);
  const valueAt = (hue: number) => bands.reduce((sum, item) => {
    const distance = Math.abs(((hue - item.center) % 360 + 540) % 360 - 180);
    return sum + (item.value - neutral) * Math.max(0, 1 - distance / item.width);
  }, neutral);
  return keys.map(hue => ({ hue, value: Math.round(valueAt(hue) * 1e6) / 1e6 }));
}

function curve(...pairs: Array<[number, number]>): ColorCurvePointV2[] {
  return pairs.map(([x, y]) => ({ x, y }));
}

function lum(...pairs: Array<[number, number]>): LumCurvePointV2[] {
  return pairs.map(([value, multiplier]) => ({ lum: value, value: multiplier }));
}

const PROVENANCE = "Editkin original parametric film look (Claude, 2026-10)" as const;
/**
 * pro-w1-1 (2026-10-10): every look was re-tuned for a recognisable signature at strength 1 (W1 verdict:
 * safe but too conservative) and ACES 2.0 SDR now reconstructs display-referred clips with the display
 * inverse (color/acesDisplayInverse). Claude (art owner) viewed every contact sheet in W11_EVIDENCE and
 * certified all 14 on 2026-10-11; the reviewed parameter hashes are pinned in filmLooksV2.test.ts, so any
 * parameter change re-opens certification. Gates were measured on 10-bit 4:4:4 masters (the encoder's own
 * near-neutral shift is tracked separately in the delivery pipeline). Looks are for camera footage: do not
 * grade screen recordings.
 */
const W11_EVIDENCE = ".rd/benchmarks/usable-v1-20261009/work/pro-w1-1/";
const CERTIFICATION: Record<string, FilmLookV2Certification["status"]> = Object.fromEntries([
  "hfl2_travel_clear_air", "hfl2_travel_golden_hour", "hfl2_travel_forest_calm",
  "hfl2_food_warm_appetite", "hfl2_food_clean_bright",
  "hfl2_night_neon_clean", "hfl2_night_city_teal",
  "hfl2_tech_cool_precision", "hfl2_tech_product_clean",
  "hfl2_gaming_arena_punch", "hfl2_vlog_soft_film", "hfl2_vlog_natural_daylight",
  "hfl2_teaching_clear_neutral", "hfl2_hype_vivid",
].map(id => [id, "certified" as const]));
const look = (definition: Omit<FilmLookV2Definition, "license" | "provenance" | "certification">): FilmLookV2Definition =>
  Object.freeze({ ...definition, license: "MIT", provenance: PROVENANCE,
    certification: Object.freeze({ status: CERTIFICATION[definition.id] ?? "pending", evidence: `${W11_EVIDENCE}sheets/GATES.json` }) });

/** Display levels at which an ACES tone curve samples its display-space design (14 points + 2 anchors ≤ 16). */
const ACES_CURVE_SAMPLES = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];

/**
 * One tone design for both spaces. Rec.709 uses the display-space Y curve as written. ACEScct samples that
 * curve (monotone cubic, as the engine evaluates it) at fixed display levels and maps both axes through the
 * neutral display inverse (acescctOfSdrDisplay), so reconstructed display-referred footage gets the same tone
 * move after the ACES 2.0 SDR output transform. In ACES the curve is the identity from display `whiteFrom`
 * up (default 0.9): Y curves move every channel by the luma delta, and channels on the output transform's flat
 * shoulder (pale saturated UI, specular) have no soft clip there to absorb a lift. It is also the identity up to
 * display `blackTo` (default 0.02): the output toe spreads display codes 0–5 over ACEScct 0.06–0.20, where a
 * curve interpolated in ACEScct darkens far more than intended and crushes near-black detail. `false` = no guard.
 */
function toneCurve(space: GradeWorkingSpace, pairs: Array<[number, number]>, guards: { whiteFrom?: number | false; blackTo?: number | false } = {}): ColorCurvePointV2[] {
  if (space !== "acescct") return curve(...pairs);
  const whiteFrom = guards.whiteFrom ?? 0.9, blackTo = guards.blackTo ?? 0.02;
  const display = buildMonotoneCurve(pairs.map(([x]) => x), pairs.map(([, y]) => y));
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  const points = ACES_CURVE_SAMPLES.map(x => {
    const identity = (whiteFrom !== false && x >= whiteFrom) || (blackTo !== false && x <= blackTo);
    const y = identity ? x : Math.max(0, Math.min(1, evaluateMonotoneCurve(display, x)));
    return [round(acescctOfSdrDisplay(x)), round(acescctOfSdrDisplay(y))] as [number, number];
  });
  return curve([0, 0], ...points, [1, 1]);
}

/**
 * ACES twin of the Rec.709 soft clip: the engine's soft clip works on working values, which in ACEScct sits above
 * display 0.99 and does nothing. This per-channel RGB curve puts the same shoulder (knee 1 − 0.14·softClip, same
 * roll-off formula) at the same display levels through the neutral display inverse, so a lift can no longer push a
 * saturated highlight channel onto the output transform's ceiling.
 */
function acesShoulderCurve(softClip: number): ColorCurvePointV2[] {
  const knee = 1 - 0.14 * softClip, range = 1 - knee;
  const clip = (code: number) => {
    if (code <= knee) return code;
    const x = (code - knee) / range;
    return knee + range * x / Math.pow(1 + x ** 4, 0.25);
  };
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  const kneeCct = round(acescctOfSdrDisplay(knee));
  const samples = [0.95, 0.98, 1].filter(code => code > knee + 0.01);
  const points = samples.map(code => [round(acescctOfSdrDisplay(code)), round(acescctOfSdrDisplay(clip(code)))] as [number, number]);
  const [lastX, lastY] = points[points.length - 1];
  // A second identity point just below the knee keeps the monotone cubic from bulging above y = x in the mid-tones.
  return curve([0, 0], [round(kneeCct - 0.03), round(kneeCct - 0.03)], [kneeCct, kneeCct], ...points, [1, round(Math.min(1, lastY + (1 - lastX) * 0.5))]);
}

/** Tone fields of a look node: Rec.709 Y curve + soft clip, or the ACEScct Y curve + its RGB shoulder. */
function toneFields(space: GradeWorkingSpace, pairs: Array<[number, number]>, softClip: number, guards: { whiteFrom?: number | false; blackTo?: number | false } = {}): Pick<ColorGradeNodeV2, "curves" | "softClip"> {
  if (space !== "acescct") return { curves: { y: curve(...pairs) }, ...(softClip > 0 ? { softClip } : {}) };
  if (softClip < 0.08) return { curves: { y: toneCurve(space, pairs, guards) } };
  const shoulder = acesShoulderCurve(softClip);
  return { curves: { y: toneCurve(space, pairs, guards), r: shoulder, g: shoulder, b: shoulder } };
}

// ACEScct zones for display-referred footage reconstructed by the display inverse (mid-grey 0.47, display 0.7 → 0.55,
// 0.83 → 0.62, white 0.97). With the engine's ±0.12 zone softness: shadows fully below ≈0.22 (display 0.015) and gone by
// 0.46 (display 0.47); highlights from 0.38 and full by 0.62 (display 0.83), so mid-tone toning never reaches the
// output transform's shoulder, where any channel lift reads as clipping.
const ACES_ZONES = { lowRange: 0.34, highRange: 0.5 } as const;

// Hue-wheel positions of real content (Oklab hue remapped): skin ≈15–30, orange food ≈25–40, yellow
// food/egg ≈50–65, foliage ≈85–110, water/cyan ≈175–195, sky ≈205–225, neon violet ≈260–300.
const SKY = 215, WATER = 185, FOLIAGE = 100;
/** Every creative node keeps colours inside the display gamut and protects skin/food and sky hues. */
const SAFE = { gamutLimit: true, skinProtection: 0.85, skyProtection: 0.9 } as const;
/** Chroma-only nodes: Oklab scaling never moves hue, so food/skin chroma may grow while sky stays protected. */
const CHROMA = { gamutLimit: true, skinProtection: 0, skyProtection: 0.9 } as const;
/**
 * Night shadows: calm the chroma noise just above black. The deepest blacks keep their (tiny) chroma: desaturating
 * dark warm city glow lowers its largest channel and the ACES 2.0 SDR toe then crushes it to code 0–1.
 */
const NIGHT_SHADOW_SAT = [[0, 1], [0.04, 1], [0.09, 0.76], [0.18, 0.92], [0.3, 1], [1, 1]] as Array<[number, number]>;
const NIGHT_SHADOW_SAT_ACES = [[0, 1], [0.21, 1], [0.27, 0.8], [0.35, 0.93], [0.44, 1], [1, 1]] as Array<[number, number]>;
/**
 * Lum-vs-sat breakpoints are Oklab L of the working colour: display-linear in Rec.709 (L ≈ code^0.8), scene-linear
 * in ACES (L = ∛scene; display 0.1 → 0.34, mid-grey → 0.70, display ≥0.7 → ≥1). `shadowSat(space, floor, kneeRec709)`
 * returns the same "calm the deepest shadows" ramp in both spaces.
 */
function shadowSat(space: GradeWorkingSpace, floor: number, knee: number): LumCurvePointV2[] {
  return lum([0, floor], [space === "acescct" ? Math.round((0.18 + knee * 0.9) * 1000) / 1000 : knee, 1], [1, 1]);
}

export const FILM_LOOKS_V2: readonly FilmLookV2Definition[] = Object.freeze([
  look({
    id: "hfl2_travel_clear_air", name: "旅遊・清透空氣", genre: "travel",
    summary: "清透空氣：去霧般的清晰對比、暗部更深但不死黑、天空與水色更藍更乾淨、綠色去黃更乾淨並與藍分離、亮部微冷清澈；人物膚色與地面保持自然。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.03, 0.026], [0.08, 0.062], [0.2, 0.168], [0.45, 0.452], [0.7, 0.726], [0.88, 0.898], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.45),
          log: aces ? { shadow: { b: 0.002 }, highlight: { r: -0.0015, b: 0.002 }, ...ACES_ZONES }
            : { shadow: { g: 0.001, b: 0.003 }, highlight: { r: -0.004, b: 0.006 } }, ...SAFE, skinProtection: 0.9 },
        { id: "air", colorBoost: aces ? 0.44 : 0.38, saturation: aces ? 1.25 : 1.05,
          hueVsHue: hueCurve(0, band(90, 30, aces ? 6 : 10, 0), band(180, 24, 11, 0)),
          hueVsSat: hueCurve(1, band(SKY, 40, 1.5, 1), band(WATER, 30, 1.4, 1), band(125, 30, 1.28, 1), band(FOLIAGE, 22, 1.18, 1), band(58, 18, aces ? 1 : 0.86, 1)),
          hueVsLum: hueCurve(0, band(SKY, 40, -0.065, 0), band(WATER, 26, -0.025, 0), band(115, 30, 0.012, 0)),
          // Dark blue-grey rock in shade sits in the sky band: keep its boost modest so caves stay stone, not blue.
          lumVsSat: aces ? lum([0, 0.78], [0.4, 0.86], [0.55, 0.96], [0.68, 1], [1, 1]) : lum([0, 0.78], [0.3, 0.86], [0.5, 0.96], [0.62, 1], [1, 1]), ...SAFE, skinProtection: 0.9 },
      ] };
    },
  }),
  look({
    id: "hfl2_travel_golden_hour", name: "旅遊・金色時刻", genre: "travel",
    summary: "金色時刻：中間調與有色亮部明顯金暖、暗部微冷對比、植物轉金綠、橙黃發光，柔肩與金色 halation；白雲只微奶油、天空保持藍不轉紫。",
    grade: space => {
      const tone: [number, number][] = space === "acescct" ? [[0, 0], [0.1, 0.088], [0.45, 0.462], [0.8, 0.806], [1, 1]] : [[0, 0], [0.1, 0.088], [0.45, 0.465], [0.8, 0.815], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.6),
          log: aces ? { shadow: { g: 0.003, b: 0.01 }, midtone: { r: 0.0105, g: 0.004, b: -0.0115 }, highlight: { r: 0.001, g: 0.0005, b: -0.002 }, ...ACES_ZONES }
            : { shadow: { r: -0.008, g: 0.002, b: 0.016 }, midtone: { r: 0.022, g: 0.008, b: -0.022 }, highlight: { r: 0.006, g: 0.002, b: -0.007 } },
          ...SAFE, skinProtection: 0.9, skyProtection: 1 },
        // ACES: bright pink-reds (torii, signage) sit on the output transform's red ceiling, so they are calmed, not warmed.
        { id: "gold", colorBoost: aces ? 0.44 : 0.3, saturation: aces ? 1.06 : 1,
          hueVsHue: hueCurve(0, band(FOLIAGE, 34, aces ? -4 : -7, 0), band(12, 14, 5, 0)),
          hueVsSat: hueCurve(1, band(30, 34, aces ? 1.32 : 1.34, 1), band(58, 28, aces ? 1.28 : 1.22, 1), band(FOLIAGE, 30, aces ? 1 : 1.08, 1), band(SKY, 40, 0.95, 1),
            ...(aces ? [band(344, 16, 0.94, 1)] : [])),
          hueVsLum: hueCurve(0, band(45, 30, 0.012, 0)), lumVsSat: aces ? lum([0, 1], [0.95, 1], [1, 0.92]) : lum([0, 1], [0.62, 1], [0.86, 0.86], [1, 0.72]), ...CHROMA, skyProtection: 1 },
      ], finishing: aces
        ? { halation: { amount: 0.15, threshold: 0.88, radius: 0.014 } }
        : { halation: { amount: 0.12, threshold: 0.86, radius: 0.014 }, bloom: { amount: 0.04, threshold: 0.84, radius: 0.03 } } };
    },
  }),
  look({
    id: "hfl2_travel_forest_calm", name: "旅遊・森林靜綠", genre: "travel",
    summary: "森林靜綠：黃綠轉翠綠、綠色更深更沉但不螢光、黃色收斂、陰影帶青綠，整體柔和安靜；天空與膚色保持。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.12, 0.1], [0.45, 0.445], [0.8, 0.812], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.5),
          log: aces ? { shadow: { g: 0.005, b: 0.006 }, midtone: { r: -0.002, g: 0.002, b: 0.001 }, highlight: { r: 0.002, b: -0.002 }, ...ACES_ZONES }
            : { shadow: { r: -0.02, g: 0.01, b: 0.012 }, midtone: { r: -0.006, g: 0.004, b: 0.002 }, highlight: { r: 0.003, b: -0.003 } }, ...SAFE },
        { id: "green", hueVsHue: hueCurve(0, band(85, 30, 12, 0), band(122, 28, 7, 0)), saturation: aces ? 1.04 : 1,
          hueVsSat: hueCurve(1, band(78, 24, aces ? 1 : 0.86, 1), band(128, 34, 1.3, 1), band(58, 18, 0.9, 1)),
          hueVsLum: hueCurve(0, band(108, 40, -0.075, 0)), lumVsSat: shadowSat(space, 0.82, 0.25), ...SAFE },
      ] };
    },
  }),
  look({
    id: "hfl2_food_warm_appetite", name: "美食・暖香食慾", genre: "food",
    summary: "暖香食慾：紅橙黃更濃更透亮、湯汁與醬色有光澤、中間調溫暖、質感對比；食物色相不變、亮部食物不過飽和，白盤與白碗保持乾淨不發黃。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.1, 0.084], [0.4, 0.402], [0.75, 0.762], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.7),
          log: aces ? { shadow: { r: 0.004, b: -0.003 }, midtone: { r: 0.006, g: 0.002, b: -0.007 }, ...ACES_ZONES }
            : { shadow: { r: 0.006, b: -0.004 }, midtone: { r: 0.011, g: 0.004, b: -0.013 } }, ...SAFE, skinProtection: 0.9 },
        { id: "appetite", colorBoost: aces ? 0.24 : 0.2, ...(aces ? { saturation: 1.04 } : {}),
          hueVsSat: hueCurve(1, band(6, 24, 1.26, 1), band(30, 28, 1.28, 1), band(55, 24, 1.18, 1), band(FOLIAGE, 30, 1.16, 1)),
          hueVsLum: hueCurve(0, band(36, 30, 0.022, 0)),
          lumVsSat: aces ? lum([0, 0.85], [0.36, 1], [0.95, 1], [1, 0.88]) : lum([0, 0.85], [0.2, 1], [0.62, 1], [1, 0.7]), ...CHROMA },
      ] };
    },
  }),
  look({
    id: "hfl2_food_clean_bright", name: "美食・明亮乾淨", genre: "food",
    summary: "明亮乾淨：整體提亮通透、白盤更白且中性、蔬菜更鮮、色彩乾淨略增；高光柔肩不爆白。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.15, 0.17], [0.4, 0.45], [0.7, 0.745], [0.9, 0.922], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.6, { whiteFrom: 0.8 }), ...SAFE },
        { id: "fresh", colorBoost: 0.24, saturation: aces ? 1.04 : 1,
          hueVsSat: hueCurve(1, band(FOLIAGE, 30, 1.22, 1), band(125, 25, 1.12, 1), band(8, 26, 1.08, 1)),
          ...(aces ? {} : { lumVsSat: lum([0, 1], [0.82, 1], [1, 0.75]) }), ...CHROMA },
      ] };
    },
  }),
  look({
    id: "hfl2_night_neon_clean", name: "夜景・霓虹乾淨", genre: "night",
    summary: "霓虹乾淨：黑位乾淨低雜色、暗部可讀、霓虹青藍紫綠黃更飽和但不爆、燈芯柔肩，淡淡光暈；不偏紫不偏綠。",
    grade: space => {
      // The first codes above black stay put (0.012 → 0.012): night frames hold large areas at codes 1–3, and the toe
      // dip below them would push those to 0–1 (crushed) on a clean 4:4:4 delivery.
      const tone: [number, number][] = [[0, 0], [0.012, 0.012], [0.03, 0.027], [0.09, 0.094], [0.22, 0.224], [0.5, 0.514], [0.85, 0.874], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.8),
          lumVsSat: lum(...(aces ? NIGHT_SHADOW_SAT_ACES : NIGHT_SHADOW_SAT)),
          log: aces ? { shadow: { g: 0.003, b: 0.012 }, ...ACES_ZONES } : { shadow: { r: -0.008, g: 0.003, b: 0.018 } }, ...SAFE, skinProtection: 0.8 },
        { id: "neon", colorBoost: 0.34, saturation: aces ? 1.09 : 1.02,
          hueVsSat: hueCurve(1, band(60, 20, 1.14, 1), band(130, 28, 1.28, 1), band(WATER, 27, 1.42, 1), band(240, 28, 1.42, 1), band(290, 22, 1.52, 1), band(330, 18, 1.36, 1)),
          hueVsLum: hueCurve(0, band(288, 40, -0.035, 0), band(240, 30, -0.02, 0)), ...CHROMA },
      ], finishing: { halation: aces ? { amount: 0.16, threshold: 0.86, radius: 0.01 } : { amount: 0.22, threshold: 0.8, radius: 0.01 } } };
    },
  }),
  look({
    id: "hfl2_night_city_teal", name: "夜景・城市青調", genre: "night",
    summary: "城市青調：暗部與中間調明顯偏青、暖色燈光更橙更亮，青橙分離；柔和 bloom，不轉紫、不偏綠、不死黑。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.1, 0.088], [0.45, 0.452], [0.85, 0.868], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.5),
          lumVsSat: lum(...(aces ? NIGHT_SHADOW_SAT_ACES : NIGHT_SHADOW_SAT)),
          // ACES: teal by adding green/blue — pulling red out of warm near-black city glow crushes it in the output toe.
          log: aces ? { shadow: { g: 0.009, b: 0.022 }, midtone: { r: -0.005, g: 0.002, b: 0.009 }, highlight: { r: 0.005, g: 0.002, b: -0.005 }, ...ACES_ZONES }
            : { shadow: { r: -0.04, g: 0.006, b: 0.026 }, midtone: { r: -0.018, g: 0.003, b: 0.014 }, highlight: { r: 0.009, g: 0.003, b: -0.008 } }, ...SAFE, skinProtection: 0.9 },
        { id: "split", hueVsHue: hueCurve(0, band(130, 34, 16, 0), band(240, 28, -12, 0), band(60, 24, -9, 0), band(10, 18, 7, 0)),
          hueVsSat: hueCurve(1, band(35, 30, 1.35, 1), band(185, 34, 1.38, 1), band(300, 40, 0.82, 1), band(120, 26, 0.88, 1)), ...SAFE },
      ], finishing: { bloom: aces ? { amount: 0.1, threshold: 0.84, radius: 0.02 } : { amount: 0.14, threshold: 0.76, radius: 0.02 } } };
    },
  }),
  look({
    id: "hfl2_tech_cool_precision", name: "科技・冷調精準", genre: "tech",
    summary: "冷調精準：俐落 S 曲線、暗部與中間調明顯偏冷、藍青更清晰、暖雜色略收；白色與介面白保持中性。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.1, 0.072], [0.3, 0.268], [0.6, 0.638], [0.85, 0.876], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.15),
          log: aces ? { shadow: { r: -0.006, g: 0.002, b: 0.014 }, midtone: { r: -0.006, g: 0.002, b: 0.009 }, ...ACES_ZONES }
            : { shadow: { r: -0.024, g: 0.002, b: 0.029 }, midtone: { r: -0.018, g: 0.004, b: 0.021 } }, ...SAFE },
        { id: "cool", hueVsHue: hueCurve(0, band(196, 26, 7, 0)), saturation: aces ? 1.12 : 1.02,
          hueVsSat: hueCurve(1, band(225, 40, 1.34, 1), band(WATER, 28, 1.24, 1), band(42, 40, aces ? 1 : 0.95, 1)), ...SAFE },
      ] };
    },
  }),
  look({
    id: "hfl2_tech_product_clean", name: "科技・產品白", genre: "tech",
    summary: "產品白：明亮俐落、近白更白更乾淨（去淡色偏）、產品暗部有層次、色彩真實；適合開箱與桌面產品。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.1, 0.084], [0.35, 0.372], [0.65, 0.696], [0.85, 0.888], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.15, { whiteFrom: 0.8 }), colorBoost: aces ? 0.24 : 0.16, saturation: aces ? 1.36 : 1,
          ...(aces ? {} : { lumVsSat: lum([0, 1], [0.78, 1], [0.95, 0.86], [1, 0.78]) }), ...SAFE },
      ] };
    },
  }),
  look({
    id: "hfl2_gaming_arena_punch", name: "遊戲・競技衝擊", genre: "gaming",
    summary: "競技衝擊：強對比、黑位更深、紅藍綠主色明顯更鮮、暗部微冷；白色場地與高光保持，淡 bloom，膚色保護。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.08, 0.042], [0.2, 0.142], [0.4, 0.374], [0.6, 0.634], [0.82, 0.848], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.5),
          log: aces ? { shadow: { g: 0.002, b: 0.01 }, ...ACES_ZONES } : { shadow: { r: -0.012, b: 0.02 } }, ...SAFE },
        { id: "punch", colorBoost: 0.65, saturation: aces ? 1.24 : 1.2,
          hueVsSat: hueCurve(1, band(0, 24, 1.32, 1), band(240, 34, 1.32, 1), band(120, 30, 1.38, 1), band(300, 28, 1.24, 1), band(60, 20, 1.14, 1)),
          lumVsSat: shadowSat(space, 0.85, 0.15), ...SAFE },
      ], finishing: { bloom: aces ? { amount: 0.07, threshold: 0.9, radius: 0.015 } : { amount: 0.1, threshold: 0.86, radius: 0.015 } } };
    },
  }),
  look({
    id: "hfl2_vlog_soft_film", name: "Vlog・柔和底片", genre: "vlog",
    summary: "柔和底片：黑位明顯抬起、柔對比、亮部膠片式柔肩、暖中間調、植物偏橄欖、天空柔和，細顆粒與淡 halation；白色不偏黃、天空不偏紫。",
    grade: space => {
      const tone: [number, number][] = [[0, 0.08], [0.15, 0.196], [0.5, 0.5], [0.85, 0.822], [1, 0.944]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0, { whiteFrom: false, blackTo: false }), saturation: aces ? 0.92 : 0.88,
          // ACES: warmth leans yellow (g) rather than red, so desaturated blue-grey skies are not rotated toward violet.
          log: aces ? { shadow: { r: -0.003, g: 0.003, b: 0.008 }, midtone: { r: 0.009, g: 0.005, b: -0.011 }, ...ACES_ZONES }
            : { shadow: { r: -0.006, g: 0.006, b: 0.016 }, midtone: { r: 0.024, g: 0.007, b: -0.024 } }, ...SAFE, skyProtection: 1 },
        { id: "film", hueVsHue: hueCurve(0, band(FOLIAGE, 35, -12, 0)),
          hueVsSat: hueCurve(1, band(220, 40, aces ? 0.9 : 0.82, 1), band(30, 28, 1.04, 1), band(62, 18, 1.08, 1)), ...SAFE, skyProtection: 1 },
      ], finishing: { grain: { amount: 0.36, size: 1.6 },
        halation: aces ? { amount: 0.12, threshold: 0.88, radius: 0.012 } : { amount: 0.16, threshold: 0.85, radius: 0.012 } } };
    },
  }),
  look({
    id: "hfl2_vlog_natural_daylight", name: "Vlog・自然日光", genre: "vlog",
    summary: "自然日光：誠實日光感——明確但自然的 S 曲線、柔和低彩度色彩增量、天空與植物略清晰、極輕暖中間調；膚色自然。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.12, 0.088], [0.45, 0.46], [0.8, 0.828], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.3), colorBoost: 0.55, saturation: aces ? 1.1 : 1.04,
          hueVsSat: hueCurve(1, band(SKY, 40, 1.28, 1), band(FOLIAGE, 30, 1.2, 1)),
          log: aces ? { midtone: { r: 0.004, g: 0.0015, b: -0.004 }, ...ACES_ZONES } : { midtone: { r: 0.008, g: 0.003, b: -0.008 } }, ...SAFE, skinProtection: 0.9, skyProtection: 1 },
      ] };
    },
  }),
  look({
    id: "hfl2_teaching_clear_neutral", name: "教學・清晰中性", genre: "teaching",
    summary: "清晰中性：提高可讀性的對比（文字與暗部更實、白底保持白）、中性不偏色、膚色準確，色彩幾乎不動。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.1, 0.066], [0.3, 0.248], [0.55, 0.552], [0.8, 0.83], [1, 1]];
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0), colorBoost: 0.1, ...SAFE, skinProtection: 1 },
      ] };
    },
  }),
  look({
    id: "hfl2_hype_vivid", name: "高能・鮮豔", genre: "hype",
    summary: "高能鮮豔：強對比深黑、高色彩能量、藍與綠更深更亮、淡 bloom 與暗角；白色與膚色保持，飽和色不爆。",
    grade: space => {
      const tone: [number, number][] = [[0, 0], [0.08, 0.04], [0.2, 0.132], [0.45, 0.442], [0.7, 0.716], [0.88, 0.888], [1, 1]];
      const aces = space === "acescct";
      return { nodes: [
        { id: "tone", ...toneFields(space, tone, 0.6), ...SAFE, skinProtection: 0.95 },
        { id: "vivid", saturation: aces ? 1.22 : 1.2, colorBoost: 0.6,
          hueVsSat: hueCurve(1, band(240, 34, 1.3, 1), band(120, 30, 1.3, 1), band(0, 24, 1.2, 1), band(300, 28, 1.2, 1)),
          hueVsLum: hueCurve(0, band(230, 34, -0.03, 0)),
          lumVsSat: aces ? lum([0, 0.85], [0.32, 1], [0.95, 1], [1, 0.88]) : lum([0, 0.85], [0.15, 1], [0.7, 1], [1, 0.76]), ...SAFE, skinProtection: 0.95 },
      ], finishing: { vignette: { amount: 0.16 }, bloom: aces ? { amount: 0.06, threshold: 0.88, radius: 0.02 } : { amount: 0.08, threshold: 0.84, radius: 0.02 } } };
    },
  }),
]);

export function findFilmLookV2(id: string): FilmLookV2Definition | undefined {
  return FILM_LOOKS_V2.find(item => item.id === id);
}

export function filmLooksForGenre(genre: FilmLookGenre): FilmLookV2Definition[] {
  return FILM_LOOKS_V2.filter(item => item.genre === genre);
}

/** Compact `get_autopilot_contract` key so VA agents can use Color Grade v2 without VA file changes. */
export function colorGradeV2ContractSummary() {
  return {
    schema: "editkin.color-grade/v2",
    command: "set_clip_grade_v2",
    commandShape: "{type:'set_clip_grade_v2', clipId, grade:{schema:'editkin.color-grade/v2', nodes?, look?:{id,strength?}, finishing?} | null}",
    module: { id: "look.color", family: "film_look_v2", legacyFamilies: ["legacy_basic_tone", "legacy_hue_rotation"] },
    looks: FILM_LOOKS_V2.map(item => ({ id: item.id, genre: item.genre, certification: item.certification.status })),
    order: "≤4 serial nodes → optional Hao Film Look v2 (strength 0–1, resolved per working space) → spatial finishing",
    node: "LUT → offset → lift/gamma/gain (RGB+master) → log wheels → contrast/pivot → Y/R/G/B curves (≤16 points, monotone cubic) → Oklab saturation, colour boost, hue vs hue/sat/lum, lum vs sat, skin/sky protection, gamut limit (adds no out-of-gamut chroma) → soft clip → mix",
    finishing: ["halation", "bloom", "vignette", "grain"],
    execution: "Export bakes one 65³ LUT per grade (FFmpeg lut3d tetrahedral, 8-bit truncation-compensated) after primary/legacy look and before effects; finishing renders in canvas pixels. The GradedMedia preview samples the same table. ACES 2.0 + Rec.709 SDR: a graded display-referred clip (phone Rec.709/sRGB, HLG/PQ rendered to SDR first) enters ACEScct through the inverse of the shipped SDR output LUT, so strength 0 = the source's own look; ungraded clips keep the legacy input transform. Native GPU routes decline graded projects (FFmpeg fallback); scene-linear/OpenEXR export refuses them. Adjustment/controller layers are not supported.",
    policy: "Use certified looks for genre defaults; pending or refused looks need visual review. Keep skin protection on people and food. A look is not shot matching or white balance (use set_clip_color / autoColor first). Legacy look.color variants only change brightness/contrast/saturation; legacy_hue_rotation (舊版) also rotates the whole frame's hue.",
  };
}

// ---------------------------------------------------------------- legacy look honesty (W1-0)

/** Legacy looks only change brightness/contrast/saturation; non-zero hue also rotates the whole frame. */
export function isLegacyHueRotatingLook(preset: Pick<LookPreset, "color">): boolean {
  return preset.color.hue !== 0;
}

export function legacyLookFamily(preset: Pick<LookPreset, "color">): "legacy_basic_tone" | "legacy_hue_rotation" {
  return isLegacyHueRotatingLook(preset) ? "legacy_hue_rotation" : "legacy_basic_tone";
}

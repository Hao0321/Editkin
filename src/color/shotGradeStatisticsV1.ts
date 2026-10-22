import { angleDifference, linearRec709ToOklab, oklabHueDegrees, workingToLinearRec709,
  type GradeWorkingSpace, type Vec3 } from "./gradeV2Color";
import { cieDeltaE2000V1, linearRec709ToCieLabD65V1 } from "./cieDeltaE2000V1";

export const SHOT_GRADE_STATISTICS_LIMITS_V1 = Object.freeze({ frames: 8, pixelsPerFrame: 65536,
  totalPixels: 262144, regions: 32, maximumAbsoluteLinearChannel: 64, hueChromaFloor: 1e-7 });
export const SHOT_GRADE_QUANTILES_V1 = [.05, .25, .5, .75, .95] as const;
const roles = ["neutral", "skin", "food", "sky"] as const;
export type ShotGradeRoleV1 = typeof roles[number];
export interface ShotGradeFrameV1 {
  sampleId: string; timeSeconds: number; width: number; height: number;
  workingSpace: GradeWorkingSpace;
  stage: "clip_working_pre_v2" | "clip_working_post_v2" | "final_output_sdr";
  format: "rgb8" | "rgb16" | "rgb32f" | "rgb64f";
  /** Packed RGB channel values, not raw endian bytes, planar RGB, RGBA, or a strided view. */
  pixels: Uint8Array | Uint16Array | Float32Array | Float64Array;
}
export interface ShotGradeRegionV1 {
  sampleId: string; role: ShotGradeRoleV1;
  /** Half-open normalized rectangle, membership tested at pixel centres. */
  x: number; y: number; width: number; height: number;
}
export interface ShotGradeDistributionV1 {
  minimum: number; maximum: number; mean: number;
  quantiles: [number, number, number, number, number];
}
export interface ShotGradeRegionStatisticsV1 {
  selection: "caller-declared-regions"; pixelCount: number;
  meanLinearRec709: Vec3 | null; meanOklab: Vec3 | null; meanCieLabD65: Vec3 | null;
  meanOklabHueDegrees: number | null;
}
export interface ShotGradeStatisticsV1 {
  schema: "editkin.shot-grade-statistics/v1";
  scope: "provided-working-rgb-surfaces-only";
  workingSpace: GradeWorkingSpace; stage: ShotGradeFrameV1["stage"];
  frameCount: number; pixelCount: number;
  quantileMethod: "exact-nearest-rank";
  quantileProbabilities: readonly number[];
  oklab: { l: ShotGradeDistributionV1; a: ShotGradeDistributionV1; b: ShotGradeDistributionV1 };
  regions: Record<ShotGradeRoleV1, ShotGradeRegionStatisticsV1>;
  displaySurfaceEndpoints: { low: number; high: number; any: number; fraction: number } | null;
  interpretation: { white: "relative-linear-rec709-D65-Y1"; colourConversion: "existing-grade-v2-working-space";
    regionSemantics: "caller-declared-not-classified"; sensorClippingMeasured: false;
    sdrOutputTransformMeasured: false; declaredSdrDisplayBasis: boolean };
}
interface PrivateStatistics {
  stats: ShotGradeStatisticsV1;
  framing: string;
  masks: Uint8Array;
  hues: Float64Array;
}
const ownedStatistics = new WeakMap<ShotGradeStatisticsV1, PrivateStatistics>();
const reject = (message: string): never => { throw new Error("SHOT_GRADE_STATISTICS_INVALID: " + message); };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const unit = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;

function validate(frames: readonly ShotGradeFrameV1[], regions: readonly ShotGradeRegionV1[]) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > SHOT_GRADE_STATISTICS_LIMITS_V1.frames) reject("Invalid representative-frame count");
  if (!Array.isArray(regions) || regions.length > SHOT_GRADE_STATISTICS_LIMITS_V1.regions) reject("Invalid declared-region count");
  const ids = new Set<string>(), offsets = new Map<string, number>();
  let count = 0;
  for (const [index, frame] of frames.entries()) {
    if (!frame || typeof frame.sampleId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(frame.sampleId) || ids.has(frame.sampleId)) reject("Invalid or duplicate sample ID");
    ids.add(frame.sampleId); offsets.set(frame.sampleId, count);
    if (!finite(frame.timeSeconds) || frame.timeSeconds < 0 || (index > 0 && frame.timeSeconds <= frames[index - 1].timeSeconds)) reject("Frame times must be finite and increasing");
    if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1
      || !Number.isSafeInteger(frame.width * frame.height) || frame.width * frame.height > SHOT_GRADE_STATISTICS_LIMITS_V1.pixelsPerFrame) reject("Invalid or oversized frame dimensions");
    count += frame.width * frame.height;
    if (count > SHOT_GRADE_STATISTICS_LIMITS_V1.totalPixels) reject("Shot pixel budget exceeded");
    if (!["rec709_display", "acescct"].includes(frame.workingSpace)
      || !["clip_working_pre_v2", "clip_working_post_v2", "final_output_sdr"].includes(frame.stage)
      || (frame.stage === "final_output_sdr" && frame.workingSpace !== "rec709_display")
      || (index > 0 && (frame.workingSpace !== frames[0].workingSpace || frame.stage !== frames[0].stage))) reject("Explicit consistent working-space/stage required");
    const correctType = frame.format === "rgb8" ? frame.pixels instanceof Uint8Array
      : frame.format === "rgb16" ? frame.pixels instanceof Uint16Array
      : frame.format === "rgb32f" ? frame.pixels instanceof Float32Array
      : frame.format === "rgb64f" && frame.pixels instanceof Float64Array;
    if (!correctType || frame.pixels.length !== frame.width * frame.height * 3) reject("Packed RGB type/length mismatch");
    if ((typeof SharedArrayBuffer !== "undefined" && frame.pixels.buffer instanceof SharedArrayBuffer)
      || (frame.pixels.buffer as ArrayBuffer & { resizable?: boolean }).resizable) reject("Shared/resizable pixel buffers are unsupported");
    const denominator = frame.format === "rgb8" ? 255 : frame.format === "rgb16" ? 65535 : 1;
    for (let i = 0; i < frame.pixels.length; i += 3) {
      const rgb: Vec3 = [frame.pixels[i]/denominator, frame.pixels[i+1]/denominator, frame.pixels[i+2]/denominator];
      if (!rgb.every(v => finite(v) && Math.abs(v) <= 4)) reject("Nonfinite or oversized working channel");
      if (!workingToLinearRec709(rgb, frame.workingSpace).every(v => finite(v) && Math.abs(v) <= SHOT_GRADE_STATISTICS_LIMITS_V1.maximumAbsoluteLinearChannel)) reject("Unsupported relative linear range");
    }
  }
  const projected = regions.map(region => {
    if (!region || !ids.has(region.sampleId) || !roles.includes(region.role)
      || ![region.x,region.y,region.width,region.height].every(unit) || region.width === 0 || region.height === 0
      || region.x + region.width > 1 || region.y + region.height > 1) reject("Invalid declared region");
    const frame = frames.find(value => value.sampleId === region.sampleId)!;
    const x0 = Math.max(0, Math.ceil(region.x * frame.width - .5));
    const x1 = Math.min(frame.width, Math.ceil((region.x + region.width) * frame.width - .5));
    const y0 = Math.max(0, Math.ceil(region.y * frame.height - .5));
    const y1 = Math.min(frame.height, Math.ceil((region.y + region.height) * frame.height - .5));
    if (x0 >= x1 || y0 >= y1) reject("Region contains no pixel centre");
    return { role: roles.indexOf(region.role) + 1, offset: offsets.get(region.sampleId)!, frame, x0, x1, y0, y1 };
  });
  const masks = new Uint8Array(count);
  for (const region of projected) for (let y = region.y0; y < region.y1; y++) for (let x = region.x0; x < region.x1; x++) {
    const i = region.offset + y * region.frame.width + x;
    if (masks[i] !== 0 && masks[i] !== region.role) reject("Conflicting roles cover the same pixel");
    masks[i] = region.role;
  }
  return { count, masks, framing: JSON.stringify(frames.map(frame => ({ sampleId:frame.sampleId,timeSeconds:frame.timeSeconds,
    width:frame.width,height:frame.height,workingSpace:frame.workingSpace }))) };
}

/** Measure every supplied pixel. These surfaces are already in the declared
 * grade working space; no source decoder, white-point detector, or skin model
 * is inferred. Values are not clamped or silently sampled to meet the budget. */
export function analyzeShotGradeStatisticsV1(frames: readonly ShotGradeFrameV1[], regions: readonly ShotGradeRegionV1[] = []): ShotGradeStatisticsV1 {
  const { count, masks, framing } = validate(frames, regions);
  const axes = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const sums = [0,0,0], hues = new Float64Array(count);
  const groups = roles.map(() => ({count:0,linear:[0,0,0] as Vec3,oklab:[0,0,0] as Vec3,cie:[0,0,0] as Vec3}));
  hues.fill(NaN);
  let offset = 0, low = 0, high = 0, any = 0;
  for (const frame of frames) {
    const denominator = frame.format === "rgb8" ? 255 : frame.format === "rgb16" ? 65535 : 1;
    for (let i = 0; i < frame.width * frame.height; i++, offset++) {
      const rgb: Vec3 = [frame.pixels[i*3]/denominator,frame.pixels[i*3+1]/denominator,frame.pixels[i*3+2]/denominator];
      const linear = workingToLinearRec709(rgb, frame.workingSpace), lab = linearRec709ToOklab(linear);
      for (let axis = 0; axis < 3; axis++) { axes[axis][offset] = lab[axis]; sums[axis] += lab[axis]; }
      if (frame.workingSpace === "rec709_display") {
        const atLow = rgb.some(v => v <= 0), atHigh = rgb.some(v => v >= 1);
        if (atLow) low++; if (atHigh) high++; if (atLow || atHigh) any++;
      }
      if (masks[offset]) {
        const group = groups[masks[offset]-1], cie = linearRec709ToCieLabD65V1(linear);
        group.count++;
        for (let axis=0;axis<3;axis++) { group.linear[axis]+=linear[axis]; group.oklab[axis]+=lab[axis]; group.cie[axis]+=cie[axis]; }
        if (Math.hypot(lab[1],lab[2]) > SHOT_GRADE_STATISTICS_LIMITS_V1.hueChromaFloor) hues[offset] = oklabHueDegrees(lab[1],lab[2]);
      }
    }
  }
  const distribution = (axis: number): ShotGradeDistributionV1 => {
    const values = axes[axis]; values.sort();
    return {minimum:values[0],maximum:values[count-1],mean:sums[axis]/count,
      quantiles: SHOT_GRADE_QUANTILES_V1.map(q => values[Math.max(0,Math.ceil(q*count)-1)]) as ShotGradeDistributionV1["quantiles"]};
  };
  const measuredRegions = Object.fromEntries(roles.map((role,index) => {
    const group=groups[index], mean=(sum:Vec3):Vec3|null => group.count ? sum.map(v=>v/group.count) as Vec3 : null;
    const meanLab=mean(group.oklab);
    return [role,{selection:"caller-declared-regions",pixelCount:group.count,meanLinearRec709:mean(group.linear),
      meanOklab:meanLab,meanCieLabD65:mean(group.cie),meanOklabHueDegrees:meanLab && Math.hypot(meanLab[1],meanLab[2]) > SHOT_GRADE_STATISTICS_LIMITS_V1.hueChromaFloor ? oklabHueDegrees(meanLab[1],meanLab[2]) : null}];
  })) as Record<ShotGradeRoleV1,ShotGradeRegionStatisticsV1>;
  const stats: ShotGradeStatisticsV1 = { schema:"editkin.shot-grade-statistics/v1",scope:"provided-working-rgb-surfaces-only",
    workingSpace:frames[0].workingSpace,stage:frames[0].stage,frameCount:frames.length,pixelCount:count,
    quantileMethod:"exact-nearest-rank",quantileProbabilities:[...SHOT_GRADE_QUANTILES_V1],
    oklab:{l:distribution(0),a:distribution(1),b:distribution(2)},regions:measuredRegions,
    displaySurfaceEndpoints:frames[0].workingSpace === "rec709_display" ? {low,high,any,fraction:any/count} : null,
    interpretation:{white:"relative-linear-rec709-D65-Y1",colourConversion:"existing-grade-v2-working-space",
      regionSemantics:"caller-declared-not-classified",sensorClippingMeasured:false,
      sdrOutputTransformMeasured:false,declaredSdrDisplayBasis:frames[0].workingSpace === "rec709_display"} };
  ownedStatistics.set(stats,{stats:structuredClone(stats),framing,masks,hues});
  return stats;
}

function owned(value: ShotGradeStatisticsV1): PrivateStatistics {
  return ownedStatistics.get(value) ?? reject("Statistics must come from this instrument, not serialized or fabricated metrics");
}
function paired(before: ShotGradeStatisticsV1, after: ShotGradeStatisticsV1) {
  const a=owned(before),b=owned(after);
  if (a.framing !== b.framing || a.masks.length !== b.masks.length || a.masks.some((v,i)=>v!==b.masks[i])) reject("Comparison sample geometry/clock/working-space/region membership changed");
  if ((a.stats.stage === "final_output_sdr") !== (b.stats.stage === "final_output_sdr")) reject("Final output and clip working surfaces cannot be paired");
  return {a,b};
}

export function measureShotGradeSafetyV1(before: ShotGradeStatisticsV1, after: ShotGradeStatisticsV1) {
  const {a,b}=paired(before,after);
  const hueChanges=Object.fromEntries((["skin","food","sky"] as const).map(role => {
    const mask=roles.indexOf(role)+1,limit=role === "sky" ? 10 : 8;
    let measured=0,undefinedHue=0,maximum=0,sum=0;
    for (let i=0;i<a.masks.length;i++) if(a.masks[i]===mask) {
      if(!Number.isFinite(a.hues[i]) || !Number.isFinite(b.hues[i])) {undefinedHue++;continue;}
      const delta=Math.abs(angleDifference(a.hues[i],b.hues[i])); measured++;sum+=delta;maximum=Math.max(maximum,delta);
    }
    return [role,{status:undefinedHue ? "partially_measured" : measured ? "measured" : "unmeasured",
      selectedPixels:measured+undefinedHue,measuredPixels:measured,undefinedHuePixels:undefinedHue,
      maximumAbsoluteDegrees:measured ? maximum : null,meanAbsoluteDegrees:measured ? sum/measured : null,
      limitDegrees:limit,withinMeasuredLimit:measured>0 && undefinedHue===0 && maximum<=limit}];
  })) as Record<"skin"|"food"|"sky",{status:string;selectedPixels:number;measuredPixels:number;undefinedHuePixels:number;
    maximumAbsoluteDegrees:number|null;meanAbsoluteDegrees:number|null;limitDegrees:number;withinMeasuredLimit:boolean}>;
  const endpoints = a.stats.displaySurfaceEndpoints && b.stats.displaySurfaceEndpoints
    ? {status:"measured" as const,beforeFraction:a.stats.displaySurfaceEndpoints.fraction,afterFraction:b.stats.displaySurfaceEndpoints.fraction,
      increaseFraction:b.stats.displaySurfaceEndpoints.fraction-a.stats.displaySurfaceEndpoints.fraction,
      maximumIncreaseFraction:.005,withinMeasuredLimit:b.stats.displaySurfaceEndpoints.fraction-a.stats.displaySurfaceEndpoints.fraction<=.005}
    : {status:"unmeasured" as const,reason:"ACES-working-surface-has-no-measured-SDR-output-transform",withinMeasuredLimit:false};
  const declared = Object.values(hueChanges).filter(group=>group.selectedPixels>0);
  return {scope:"provided-surfaces-and-declared-regions-only" as const,hueChanges,displaySurfaceEndpoints:endpoints,
    measuredBoundsSatisfied:endpoints.withinMeasuredLimit && declared.every(group=>group.withinMeasuredLimit),
    missingDeclaredHueRoles:Object.entries(hueChanges).filter(([,group])=>group.selectedPixels===0).map(([role])=>role),
    neutralWhiteAccuracy:{status:"unmeasured" as const,reason:"No-verified-white-target-or-neutral-reference-accuracy-measurement"},
    appearanceCertified:false as const};
}

function quantileDistance(first: ShotGradeStatisticsV1,second: ShotGradeStatisticsV1) {
  let sum=0;
  for(let q=0;q<SHOT_GRADE_QUANTILES_V1.length;q++) sum+=Math.hypot(first.oklab.l.quantiles[q]-second.oklab.l.quantiles[q],
    first.oklab.a.quantiles[q]-second.oklab.a.quantiles[q],first.oklab.b.quantiles[q]-second.oklab.b.quantiles[q]);
  return sum/SHOT_GRADE_QUANTILES_V1.length;
}

/** Independent mean CIELAB distances and Oklab marginal quantile distances.
 * The >=50% and <=4 gate applies only to declared, measured neutral/skin means;
 * differing scene content or reference geometry is not a verified match. */
export function measureShotGradeMatchV1(before: ShotGradeStatisticsV1,after: ShotGradeStatisticsV1,reference: ShotGradeStatisticsV1) {
  const {a,b}=paired(before,after), ref=owned(reference).stats;
  if (a.stats.workingSpace!==ref.workingSpace || (a.stats.stage === "final_output_sdr") !== (ref.stage === "final_output_sdr")) reject("Reference working-space/stage mismatch");
  const groups=Object.fromEntries((["neutral","skin"] as const).map(role=> {
    const source=a.stats.regions[role].meanCieLabD65,updated=b.stats.regions[role].meanCieLabD65,target=ref.regions[role].meanCieLabD65;
    if(!source || !updated || !target) return [role,{status:"unmeasured",beforeDeltaE00:null,afterDeltaE00:null,reductionFraction:null,matchesSpecifiedBounds:false}];
    const beforeDeltaE00=cieDeltaE2000V1(source,target),afterDeltaE00=cieDeltaE2000V1(updated,target);
    const reductionFraction=beforeDeltaE00===0 ? null : 1-afterDeltaE00/beforeDeltaE00;
    return [role,{status:"measured",beforeDeltaE00,afterDeltaE00,reductionFraction,
      matchesSpecifiedBounds:afterDeltaE00<=4 && (reductionFraction===null ? afterDeltaE00===0 : reductionFraction>=.5)}];
  })) as Record<"neutral"|"skin",{status:string;beforeDeltaE00:number|null;afterDeltaE00:number|null;reductionFraction:number|null;matchesSpecifiedBounds:boolean}>;
  return {scope:"provided-surfaces-and-declared-region-means-only" as const,metric:"CIEDE2000-kL-kC-kH-1" as const,
    groups,oklabMarginalQuantileDistance:{before:quantileDistance(a.stats,ref),after:quantileDistance(b.stats,ref)},
    matchesSpecifiedNeutralAndSkinBounds:groups.neutral.matchesSpecifiedBounds && groups.skin.matchesSpecifiedBounds,
    referenceSemantics:"caller-declared-not-classified" as const,appearanceCertified:false as const};
}

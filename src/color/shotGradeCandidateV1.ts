import { assertColorGradeV2, COLOR_GRADE_V2_MAX_NODES } from "../domain/colorGradeV2Schema";
import type { ColorGradeNodeV2, ColorGradeV2 } from "../domain/visualTypes";
import { sampleCubeLut, type CubeLut, type ParsedCube } from "./cubeLut";
import { applyResolvedColorGradeV2, resolveColorGradeV2, type ColorLutResolver, type ResolvedColorGradeV2 } from "./gradeV2";
import { GRADE_LUT_SIZE } from "./gradeLutBake";
import type { Vec3 } from "./gradeV2Color";
import { analyzeShotGradeStatisticsV1, measureShotGradeMatchV1, measureShotGradeSafetyV1,
  type ShotGradeFrameV1, type ShotGradeRegionV1, type ShotGradeStatisticsV1 } from "./shotGradeStatisticsV1";

export const SHOT_GRADE_CANDIDATE_LIMITS_V1 = Object.freeze({ uniformFitPixels: 512, fitPixelsPerRole: 64,
  maximumFitPixels: 768, maximumEvaluations: 56, maximumTimeMs: 2000 });
/** Deliberately narrower than the persisted grade schema. The search cannot add
 * a look, curve, LUT, spatial operation, or change an existing node. */
export const SHOT_GRADE_CANDIDATE_BOUNDS_V1 = Object.freeze({ offset: .06, gain: .24, gamma: .24,
  saturation: Object.freeze([.8, 1.2] as const), contrast: Object.freeze([.8, 1.2] as const) });
export interface ShotGradeCandidateOptionsV1 {
  maximumTimeMs?: number; signal?: AbortSignal; resolveLut?: ColorLutResolver;
}
export interface ShotGradeCandidateInputV1 extends ShotGradeCandidateOptionsV1 {
  frames: readonly ShotGradeFrameV1[]; regions: readonly ShotGradeRegionV1[];
  referenceFrames: readonly ShotGradeFrameV1[]; referenceRegions: readonly ShotGradeRegionV1[];
  gradeV2?: ColorGradeV2;
}
export interface ShotGradeCandidateResultV1 {
  schema: "editkin.shot-grade-candidate/v1";
  status: "candidate" | "unchanged" | "not_applicable" | "cancelled" | "budget_exceeded";
  reason: string; gradeV2: ColorGradeV2 | null;
  before: ShotGradeStatisticsV1 | null; after: ShotGradeStatisticsV1 | null; reference: ShotGradeStatisticsV1 | null;
  safety: ReturnType<typeof measureShotGradeSafetyV1> | null;
  match: ReturnType<typeof measureShotGradeMatchV1> | null;
  search: { evaluations: number; fitSourcePixels: number; fitReferencePixels: number;
    maximumEvaluations: number; elapsedMs: number; allSuppliedPixelsVerified: boolean;
    policy: "deterministic-uniform-raster-plus-fixed-declared-role-samples" };
  scope: "provided-working-surfaces-and-caller-declared-regions-only";
  sourceAndCommandEvidenceBound: false; appearanceCertified: false; actualSixShotPerformanceVerified: false;
}

class SearchStop extends Error {
  constructor(readonly status: "cancelled" | "budget_exceeded") { super("SHOT_GRADE_CANDIDATE_" + status.toUpperCase()); }
}
function fence(options: ShotGradeCandidateOptionsV1) {
  const limit = options.maximumTimeMs ?? SHOT_GRADE_CANDIDATE_LIMITS_V1.maximumTimeMs;
  if (!Number.isFinite(limit) || limit <= 0 || limit > SHOT_GRADE_CANDIDATE_LIMITS_V1.maximumTimeMs)
    throw new Error("SHOT_GRADE_CANDIDATE_INVALID: Time budget must be positive and at most 2000ms");
  const start = performance.now();
  return { elapsed: () => performance.now() - start, check: () => {
    if (options.signal?.aborted) throw new SearchStop("cancelled");
    if (performance.now() - start >= limit) throw new SearchStop("budget_exceeded");
  } };
}
const denominator = (format: ShotGradeFrameV1["format"]) => format === "rgb8" ? 255 : format === "rgb16" ? 65535 : 1;
const copyFrames = (frames: readonly ShotGradeFrameV1[]) => frames.map(frame => ({ ...frame, pixels: frame.pixels.slice() }));
function requirePreGrade(frames: readonly ShotGradeFrameV1[]) {
  if (frames.some(frame => frame.stage !== "clip_working_pre_v2"))
    throw new Error("SHOT_GRADE_CANDIDATE_INVALID: Source surfaces must explicitly precede gradeV2");
}
function frozenLutResolver(resolve?: ColorLutResolver): ColorLutResolver | undefined {
  if (!resolve) return undefined;
  const loaded = new Map<string, ParsedCube>();
  return ref => {
    const key = ref.id + ":" + ref.sha256;
    if (!loaded.has(key)) loaded.set(key, structuredClone(resolve(ref)));
    return loaded.get(key)!;
  };
}

/** Evaluate only the cube vertices actually needed by the bounded search. The
 * shared sampler still reads a real Float32 65-cube, with the exact export bake's
 * six-decimal rounding. One storage allocation is reused between candidates. */
export class GradeSurfaceSampler {
  private readonly cube: CubeLut = { size: GRADE_LUT_SIZE, domainMin: [0,0,0], domainMax: [1,1,1],
    values: new Float32Array(GRADE_LUT_SIZE ** 3 * 3) };
  private readonly stamps = new Uint32Array(GRADE_LUT_SIZE ** 3);
  private generation = 0;
  private resolved?: ResolvedColorGradeV2;
  private eightBit = false;
  constructor(private readonly check: () => void) {}
  private configure(resolved: ResolvedColorGradeV2, format: ShotGradeFrameV1["format"]) {
    if (this.resolved !== resolved || this.eightBit !== (format === "rgb8")) {
      this.resolved = resolved; this.eightBit = format === "rgb8"; this.generation++;
    }
  }
  private vertex(r: number, g: number, b: number) {
    const index = r + g * GRADE_LUT_SIZE + b * GRADE_LUT_SIZE ** 2;
    if (this.stamps[index] === this.generation) return;
    const value = applyResolvedColorGradeV2(this.resolved!, [r/64,g/64,b/64]);
    for (let channel=0;channel<3;channel++) {
      // Same Float32 table as bakeResolvedGradeLut; the 8-bit render copy adds
      // its documented half-code bias, then rounds to six decimals again.
      let v = Math.fround(Math.round(Math.max(0,Math.min(1,value[channel]))*1e6)/1e6);
      if (this.eightBit) v = Math.fround(Math.round((v+.5/255)*1e6)/1e6);
      this.cube.values[index*3+channel] = v;
    }
    this.stamps[index] = this.generation;
  }
  private sample(rgb: Vec3): Vec3 {
    const base = rgb.map(v => Math.min(63,Math.floor(Math.max(0,Math.min(1,v))*64)));
    for (let b=0;b<2;b++) for (let g=0;g<2;g++) for (let r=0;r<2;r++) this.vertex(base[0]+r,base[1]+g,base[2]+b);
    return sampleCubeLut(this.cube,rgb);
  }
  render(frames: readonly ShotGradeFrameV1[], resolved: ResolvedColorGradeV2): ShotGradeFrameV1[] {
    return frames.map(frame => {
      this.check(); this.configure(resolved,frame.format);
      if (resolved.identity) return { ...frame, stage:"clip_working_post_v2",pixels:frame.pixels.slice() };
      const pixels = frame.format === "rgb8" ? new Uint8Array(frame.pixels.length)
        : frame.format === "rgb16" ? new Uint16Array(frame.pixels.length)
        : frame.format === "rgb32f" ? new Float32Array(frame.pixels.length) : new Float64Array(frame.pixels.length);
      const scale = denominator(frame.format);
      for (let i=0;i<frame.width*frame.height;i++) {
        if ((i&255)===0) this.check();
        const rgb: Vec3 = [frame.pixels[i*3]/scale,frame.pixels[i*3+1]/scale,frame.pixels[i*3+2]/scale];
        const value = this.sample(rgb);
        for (let channel=0;channel<3;channel++) pixels[i*3+channel] = scale === 1 ? value[channel]
          : Math.max(0,Math.min(scale,Math.trunc(value[channel]*scale)));
      }
      return { ...frame,stage:"clip_working_post_v2",pixels };
    });
  }
}

/** Pure forward model for already decoded pre-grade surfaces. No source, clip,
 * renderer context or final-output transform is inferred by this helper. */
export function renderShotGradeSurfacesV1(frames: readonly ShotGradeFrameV1[], grade: ColorGradeV2,
  options: ShotGradeCandidateOptionsV1 = {}): ShotGradeFrameV1[] {
  const budget = fence(options); budget.check();
  analyzeShotGradeStatisticsV1(frames); requirePreGrade(frames);
  const saved = copyFrames(frames), parsed = assertColorGradeV2(grade);
  const resolved = resolveColorGradeV2(parsed,frames[0].workingSpace,frozenLutResolver(options.resolveLut));
  if (resolved.finishing) throw new Error("SHOT_GRADE_CANDIDATE_UNSUPPORTED: Spatial finishing requires actual renderer evidence");
  const result = new GradeSurfaceSampler(budget.check).render(saved,resolved); budget.check();
  return result;
}

/** Stable fitting selection. All verification later uses the full original
 * surfaces and fixed original ROI membership, never these fitting pixels. */
export function fitting(frames: readonly ShotGradeFrameV1[], regions: readonly ShotGradeRegionV1[]) {
  const roles = ["neutral","skin","food","sky"] as const;
  const all: Array<{rgb:Vec3;role:number}> = [];
  for (const frame of frames) {
    const masks = new Uint8Array(frame.width*frame.height);
    for (const region of regions.filter(r=>r.sampleId===frame.sampleId)) {
      const x0=Math.max(0,Math.ceil(region.x*frame.width-.5)),x1=Math.min(frame.width,Math.ceil((region.x+region.width)*frame.width-.5));
      const y0=Math.max(0,Math.ceil(region.y*frame.height-.5)),y1=Math.min(frame.height,Math.ceil((region.y+region.height)*frame.height-.5));
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)masks[y*frame.width+x]=roles.indexOf(region.role)+1;
    }
    const scale=denominator(frame.format);
    for(let i=0;i<masks.length;i++) all.push({rgb:[frame.pixels[i*3]/scale,frame.pixels[i*3+1]/scale,frame.pixels[i*3+2]/scale],role:masks[i]});
  }
  const selected = new Set<number>();
  const choose = (indices: readonly number[], maximum: number) => {
    const n=Math.min(maximum,indices.length);
    for(let i=0;i<n;i++)selected.add(indices[Math.floor((i+.5)*indices.length/n)]);
  };
  choose(all.map((_,i)=>i),SHOT_GRADE_CANDIDATE_LIMITS_V1.uniformFitPixels);
  for(let role=1;role<=4;role++)choose(all.flatMap((v,i)=>v.role===role?[i]:[]),SHOT_GRADE_CANDIDATE_LIMITS_V1.fitPixelsPerRole);
  const fitFrames: ShotGradeFrameV1[]=[],fitRegions:ShotGradeRegionV1[]=[];
  const format=frames[0].format,scale=denominator(format);
  for(let role=0;role<=4;role++) {
    const values=[...selected].sort((a,b)=>a-b).filter(i=>all[i].role===role).flatMap(i=>all[i].rgb);
    if(!values.length)continue;
    const sampleId="fit-role-"+role;
    const pixels=format==="rgb8"?Uint8Array.from(values,v=>Math.round(v*scale))
      :format==="rgb16"?Uint16Array.from(values,v=>Math.round(v*scale))
      :format==="rgb32f"?new Float32Array(values):new Float64Array(values);
    fitFrames.push({sampleId,timeSeconds:role,width:values.length/3,height:1,workingSpace:frames[0].workingSpace,
      stage:"clip_working_pre_v2",format,pixels});
    if(role)fitRegions.push({sampleId,role:roles[role-1],x:0,y:0,width:1,height:1});
  }
  return {frames:fitFrames,regions:fitRegions,count:selected.size};
}
function loss(value: ShotGradeStatisticsV1,target: ShotGradeStatisticsV1) {
  let result=0;
  for(let q=0;q<5;q++)result+=Math.hypot(value.oklab.l.quantiles[q]-target.oklab.l.quantiles[q],
    value.oklab.a.quantiles[q]-target.oklab.a.quantiles[q],value.oklab.b.quantiles[q]-target.oklab.b.quantiles[q])/5;
  for(const role of ["neutral","skin"] as const) {
    const a=value.regions[role].meanOklab!,b=target.regions[role].meanOklab!;
    result+=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
  }
  return result/3;
}
// Offset RGB, gain master/R/B, gamma master, saturation, contrast.
const initial = [0,0,0,0,0,0,0,1,1];
const limits = [[-.06,.06],[-.06,.06],[-.06,.06],[-.24,.24],[-.24,.24],[-.24,.24],[-.24,.24],[.8,1.2],[.8,1.2]];
function proposal(grade: ColorGradeV2,values: readonly number[],id: string): ColorGradeV2 {
  const node: ColorGradeNodeV2 = {id,offset:{r:values[0],g:values[1],b:values[2]},
    gain:{master:values[3],r:values[4],b:values[5]},gamma:{master:values[6]},saturation:values[7],contrast:values[8],
    skinProtection:1,skyProtection:1};
  return assertColorGradeV2({...grade,nodes:[...(grade.nodes??[]),node]});
}

/** Search bounded existing gradeV2 controls, preserving every original node and
 * the look's position after them. A candidate is returned only when independent
 * full-surface measurements satisfy the supplied neutral/skin match and hue/
 * endpoint bounds. This is a numerical proposal, not a bound edit command. */
export function proposeShotGradeCandidateV1(input: ShotGradeCandidateInputV1): ShotGradeCandidateResultV1 {
  const budget=fence(input);
  const result:ShotGradeCandidateResultV1={schema:"editkin.shot-grade-candidate/v1",status:"not_applicable",reason:"bounded-search-no-verified-match",
    gradeV2:null,before:null,after:null,reference:null,safety:null,match:null,
    search:{evaluations:0,fitSourcePixels:0,fitReferencePixels:0,maximumEvaluations:SHOT_GRADE_CANDIDATE_LIMITS_V1.maximumEvaluations,
      elapsedMs:0,allSuppliedPixelsVerified:false,policy:"deterministic-uniform-raster-plus-fixed-declared-role-samples"},
    scope:"provided-working-surfaces-and-caller-declared-regions-only",sourceAndCommandEvidenceBound:false,
    appearanceCertified:false,actualSixShotPerformanceVerified:false};
  try {
    budget.check();
    analyzeShotGradeStatisticsV1(input.frames,input.regions); requirePreGrade(input.frames);
    const referenceStats=analyzeShotGradeStatisticsV1(input.referenceFrames,input.referenceRegions);
    if(input.referenceFrames.some(frame=>frame.stage!=="clip_working_post_v2") || referenceStats.workingSpace!==input.frames[0].workingSpace)
      throw new Error("SHOT_GRADE_CANDIDATE_INVALID: Reference must be post-grade in the same working space");
    const frames=copyFrames(input.frames),regions=structuredClone(input.regions);
    const references=copyFrames(input.referenceFrames),referenceRegions=structuredClone(input.referenceRegions);
    const grade=assertColorGradeV2(input.gradeV2??{schema:"editkin.color-grade/v2"});
    result.reference=referenceStats;
    if([frames,references].some(batch=>batch.some(frame=>frame.format!==batch[0].format))) {
      result.reason="mixed-representations-require-a-bound-uniform-surface-producer";return result;
    }
    if(referenceStats.workingSpace!=="rec709_display") {result.reason="ACES-working-surfaces-do-not-measure-the-SDR-output-transform";return result;}
    if((grade.nodes?.length??0)>=COLOR_GRADE_V2_MAX_NODES) {result.reason="four-node-capacity-preserve-existing-stack";return result;}
    const resolve=frozenLutResolver(input.resolveLut),baseline=resolveColorGradeV2(grade,frames[0].workingSpace,resolve);
    if(baseline.finishing) {result.reason="spatial-finishing-requires-actual-renderer-evidence";return result;}
    const sampler=new GradeSurfaceSampler(budget.check);
    result.before=analyzeShotGradeStatisticsV1(sampler.render(frames,baseline),regions); budget.check();
    if([result.before,referenceStats].some(stats=>(["neutral","skin"] as const).some(role=>stats.regions[role].pixelCount===0))) {
      result.reason="measured-declared-neutral-and-skin-regions-required-in-both-shots";return result;
    }
    const existingMatch=measureShotGradeMatchV1(result.before,result.before,referenceStats);
    const existingSafety=measureShotGradeSafetyV1(result.before,result.before);
    if(existingMatch.matchesSpecifiedNeutralAndSkinBounds&&existingSafety.measuredBoundsSatisfied) {
      result.status="unchanged";result.reason="provided-surfaces-already-within-specified-bounds";result.after=result.before;
      result.match=existingMatch;result.safety=existingSafety;result.search.allSuppliedPixelsVerified=true;return result;
    }
    const fit=fitting(frames,regions),target=fitting(references,referenceRegions);
    result.search.fitSourcePixels=fit.count;result.search.fitReferencePixels=target.count;
    const fitBefore=analyzeShotGradeStatisticsV1(sampler.render(fit.frames,baseline),fit.regions);
    const targetStats=analyzeShotGradeStatisticsV1(target.frames.map(frame=>({...frame,stage:"clip_working_post_v2"})),target.regions);
    let id="shot_match_v1",suffix=1;
    while(grade.nodes?.some(node=>node.id===id))id="shot_match_v1_"+(++suffix);
    let best=[...initial],bestLoss=loss(fitBefore,targetStats); result.search.evaluations=1;
    const visited=new Set<string>();
    const evaluate=(values:number[])=>{
      budget.check(); const key=values.join(":");if(visited.has(key))return Infinity;visited.add(key);
      if(result.search.evaluations>=SHOT_GRADE_CANDIDATE_LIMITS_V1.maximumEvaluations)throw new Error("SHOT_GRADE_CANDIDATE_INVALID: Evaluation budget exceeded");
      result.search.evaluations++;
      const resolved=resolveColorGradeV2(proposal(grade,values,id),frames[0].workingSpace,resolve);
      const stats=analyzeShotGradeStatisticsV1(sampler.render(fit.frames,resolved),fit.regions);
      const safety=measureShotGradeSafetyV1(fitBefore,stats);
      budget.check();return safety.measuredBoundsSatisfied?loss(stats,targetStats):Infinity;
    };
    const centreLoss=evaluate(best); if(centreLoss<bestLoss)bestLoss=centreLoss;
    for(const fraction of [.25,.125,.0625])for(let axis=0;axis<initial.length;axis++) {
      const centre=[...best],step=(limits[axis][1]-limits[axis][0])*fraction;
      for(const direction of [-1,1]) {
        const values=[...centre];values[axis]=Number(Math.max(limits[axis][0],Math.min(limits[axis][1],centre[axis]+direction*step)).toFixed(6));
        const score=evaluate(values); if(score<bestLoss-1e-12){best=values;bestLoss=score;}
      }
    }
    const candidate=proposal(grade,best,id),resolved=resolveColorGradeV2(candidate,frames[0].workingSpace,resolve);
    const after=analyzeShotGradeStatisticsV1(sampler.render(frames,resolved),regions); budget.check();
    result.after=after;result.safety=measureShotGradeSafetyV1(result.before,after);
    result.match=measureShotGradeMatchV1(result.before,after,referenceStats);budget.check();
    result.search.allSuppliedPixelsVerified=true;
    if(result.safety.measuredBoundsSatisfied&&result.match.matchesSpecifiedNeutralAndSkinBounds) {
      result.status="candidate";result.reason="independent-full-supplied-surface-bounds-satisfied";result.gradeV2=candidate;
    }
    return result;
  } catch(error) {
    if(!(error instanceof SearchStop))throw error;
    result.status=error.status;result.reason=error.message;result.gradeV2=null;result.search.allSuppliedPixelsVerified=false;return result;
  } finally {result.search.elapsedMs=budget.elapsed();}
}

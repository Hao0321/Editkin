import * as z from "zod/v4";
import { colorDigest,MATERIAL_COLOR_IMPLEMENTATIONS } from "./materialColorSamplingRuntime";
import type { MaterialColorRequest,MaterialColorRequestSnapshot } from "./materialColorSamplingTypes";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
const sha=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().finite().positive(),nonnegative=z.number().finite().nonnegative(),integer=z.number().int().nonnegative();
const unit=z.number().finite().min(0).max(1);
const requestSnapshotSchema=z.strictObject({kind:z.enum(["video","audio","image"]),
  color:z.strictObject({interpretation:z.enum(["auto","rec709","linear_rec709","srgb","hlg","pq","acescct","apple_log","arri_logc3","arri_logc4","bmd_film_gen5","canon_log2","canon_log3","dji_dlog","panasonic_vlog","red_log3g10","sony_slog3_cine","log_unresolved"]),primaries:z.string().max(1024).optional(),transfer:z.string().max(1024).optional(),matrix:z.string().max(1024).optional(),range:z.string().max(1024).optional()}).nullable(),
  colorManagement:z.strictObject({mode:z.enum(["rec709","aces2"]),workingSpace:z.literal("ACEScct"),outputTransform:z.enum(["rec709_sdr","p3d65_sdr","rec2100_hlg_1000","rec2100_pq_1000"]),configId:z.literal("studio-config-v4.0.0_aces-v2.0_ocio-v2.5")}),
  samples:z.array(z.strictObject({id:z.string().min(1).max(128),time:nonnegative,sceneIndex:integer})).max(12),sceneCount:integer.max(10000),sceneCountVerified:z.boolean(),sceneCuts:z.array(positive).max(9999).nullable()});
export function materialColorRequestSnapshot(request:MaterialColorRequest):MaterialColorRequestSnapshot {
  return requestSnapshotSchema.parse(structuredClone({kind:request.kind,color:request.color??null,colorManagement:request.colorManagement??DEFAULT_COLOR_MANAGEMENT,samples:request.samples,sceneCount:request.sceneCount,sceneCountVerified:request.sceneCountVerified??false,sceneCuts:request.sceneCuts??null}));
}
const rate=z.strictObject({count:integer,fraction:unit});
const distribution=z.strictObject({minimum:unit,maximum:unit,mean:unit,p01:unit,p05:unit,p50:unit,p95:unit,p99:unit});
const measurement=z.strictObject({sampleId:z.string(),timeSeconds:nonnegative,pixelCount:integer,
  linearRelativeY:distribution,nearBlack:rate,nearWhite:rate,
  encodedEndpoints:z.strictObject({low:z.tuple([rate,rate,rate]),high:z.tuple([rate,rate,rate]),anyLow:rate,anyHigh:rate}),
  relativeLinearChroma:distribution,neutralCandidates:rate.extend({meanLinearRgb:z.tuple([unit,unit,unit]).nullable(),trustedWhitePoint:z.literal(false)})});
const analysis=z.strictObject({status:z.literal("measured"),scope:z.literal("provided-representative-rgb-surfaces-only"),
  interpretation:z.strictObject({primaries:z.literal("bt709"),transfer:z.literal("bt709-oetf"),range:z.literal("full"),format:z.literal("rgb8")}),
  thresholds:z.strictObject({nearBlackY:unit,nearWhiteY:unit,neutralMaximumRelativeSpread:unit,neutralMinimumY:unit,neutralMaximumY:unit}),
  quantiles:z.strictObject({method:z.literal("nearest-rank-histogram-lower-edge"),bins:z.literal(4096),maximumAbsoluteBinError:positive}),
  frames:z.array(measurement).min(1).max(12),changes:z.array(z.strictObject({fromSampleId:z.string(),toSampleId:z.string(),elapsedSeconds:positive,meanAbsoluteLinearRgbDifference:unit,meanYDifference:z.number().finite(),medianYDifference:z.number().finite(),nearWhiteFractionDifference:z.number().finite(),meanChromaDifference:z.number().finite()})).max(11),
  advice:z.strictObject({exposure:z.strictObject({status:z.literal("unmeasured"),reason:z.literal("scene-intent-and-exposure-target-not-verified")}),whiteBalance:z.strictObject({status:z.literal("unmeasured"),reason:z.literal("no-trusted-neutral-reference-or-illuminant")})})});
const receiptSchema=z.strictObject({schema:z.literal("editkin.material-color-receipt/v1"),receiptSha256:sha,status:z.enum(["measured","unmeasured","not_applicable"]),reason:z.string().min(1).max(200).optional(),
  request:requestSnapshotSchema,
  identity:z.strictObject({schema:z.literal("editkin.material-color-runtime/v1"),status:z.enum(["verified","unmeasured"]),reason:z.string().max(1000).optional(),tools:z.array(z.strictObject({role:z.enum(["ffmpeg","ffprobe"]),sha256:sha,version:z.string().min(1).max(1000)})).max(2),implementations:z.array(z.strictObject({name:z.string(),sha256:sha})).max(33),code:z.strictObject({mode:z.enum(["source","bundle"]),entry:z.string().min(1).max(255).regex(/^[^\\/:]+$/),sha256:sha,size:positive.int().max(64*1024*1024),manifestSha256:sha.optional()}).optional(),identitySha256:sha}),
  source:z.strictObject({sha256:sha,start:nonnegative,duration:positive,beforeSha256:sha.optional(),afterSha256:sha.optional()}),
  coverage:z.strictObject({requestedCount:integer.max(12),sampledCount:integer.max(12),sceneCount:integer.max(10000),sceneCountVerified:z.boolean(),sceneAttributionVerified:z.boolean(),sceneCuts:z.array(positive).max(9999).optional(),sampledSceneIndices:z.array(integer).max(12),omittedSceneIndices:z.array(integer).max(10000)}),
  mapping:z.array(z.strictObject({id:z.string(),sceneIndex:integer,requestedSceneIndex:integer,requestedTime:nonnegative,decodedPts:z.number().int(),timeBase:z.strictObject({numerator:positive.int(),denominator:positive.int()}),decodedSourceTime:nonnegative,decodedRelativeTime:nonnegative,width:positive.int().max(256),height:positive.int().max(256),rawRgbSha256:sha})).max(12),
  probe:z.strictObject({sha256:sha,metadata:z.record(z.string(),z.unknown()),timelineOrigin:z.number().finite()}).optional(),
  normalization:z.strictObject({interpretation:z.enum(["rec709","hlg","pq"]),filters:z.array(z.string()).max(30),format:z.literal("rgb8"),transfer:z.literal("bt709-oetf"),primaries:z.literal("bt709"),range:z.literal("full"),exposure:z.literal(0),creativeLook:z.literal(false)}).optional(),measurements:analysis.optional()});

export function validateMaterialColorRequest(request:MaterialColorRequest):void {
  if(!request||typeof request.sourcePath!=="string"||!request.sourcePath||!sha.safeParse(request.sourceSha256).success||!nonnegative.safeParse(request.sourceStart).success||!positive.safeParse(request.duration).success||!Number.isFinite(request.sourceStart+request.duration)
    ||!["video","audio","image"].includes(request.kind)||!Number.isSafeInteger(request.sceneCount)||request.sceneCount<0||request.sceneCount>10000
    ||(request.sceneCountVerified!==undefined&&typeof request.sceneCountVerified!=="boolean")
    ||!Array.isArray(request.samples)||request.samples.length>12||(request.kind!=="audio"&&request.samples.length===0))throw Error("invalid-color-request");
  const ids=new Set<string>();let previous=-1;
  if(request.sceneCuts!==undefined&&(!Array.isArray(request.sceneCuts)||request.sceneCuts.length+1!==request.sceneCount||request.sceneCuts.some((cut,i)=>!Number.isFinite(cut)||cut<=0||cut>=request.duration||(i>0&&cut<=request.sceneCuts![i-1]))))throw Error("invalid-color-scene-cuts");
  for(const s of request.samples) {
    if(typeof s.id!=="string"||!s.id.trim()||s.id.length>128||ids.has(s.id)||!Number.isFinite(s.time)||s.time<0||s.time>=request.duration||s.time<=previous
      ||!Number.isSafeInteger(s.sceneIndex)||s.sceneIndex<0||s.sceneIndex>=request.sceneCount||(request.sceneCuts!==undefined&&s.sceneIndex!==request.sceneCuts.filter(cut=>s.time>=cut).length))throw Error("invalid-color-sample-request");
    ids.add(s.id);previous=s.time;
  }
}

// Exactly the released revision-3 source-only identity layout. This permits
// historical evidence reading, never current runtime verification or upgrade.
const REVISION_3_IMPLEMENTATIONS=["materialColorSampling.ts","materialColorSamplingTypes.ts","materialColorSamplingRuntime.ts","materialColorSamplingValidation.ts","../color/shotColorAnalysis.ts","../render/sourceColorFilters.ts","../color/primaryGrade.ts","../render/ffmpegExpressions.ts","../domain/types.ts","../shared/canonicalJson.ts","../shared/utf8ByteOrder.ts"];
/** Integrity/self-consistency, not source authenticity or a cryptographic signature.
 * historicalRuntime is exclusively for the cache revision-3 read adapter. */
export function verifyMaterialColorReceipt(input:unknown,options?:{historicalRuntime?:"material-cache-revision-3"}):void {
  const r=receiptSchema.parse(input);
  const fail=()=>{throw Error("inconsistent-material-color-receipt");};
  if(colorDigest({...r,receiptSha256:undefined})!==r.receiptSha256||colorDigest({...r.identity,identitySha256:undefined})!==r.identity.identitySha256)fail();
  const historical=options?.historicalRuntime==="material-cache-revision-3"&&r.identity.code===undefined&&JSON.stringify(r.identity.implementations.map(t=>t.name))===JSON.stringify(REVISION_3_IMPLEMENTATIONS);
  if(r.identity.status==="verified"&&(r.identity.tools.length!==2||new Set(r.identity.tools.map(t=>t.role)).size!==2||(!historical&&JSON.stringify(r.identity.implementations.map(t=>t.name))!==JSON.stringify(MATERIAL_COLOR_IMPLEMENTATIONS))))fail();
  if(r.identity.status==="verified"&&!historical&&(!r.identity.code||(r.identity.code.mode==="bundle"?!r.identity.code.manifestSha256:r.identity.code.entry!=="materialColorCodeIdentity.ts"||r.identity.code.manifestSha256!==undefined)))fail();
  validateMaterialColorRequest({sourcePath:"receipt-source",sourceSha256:r.source.sha256,sourceStart:r.source.start,duration:r.source.duration,...r.request,color:r.request.color??undefined,sceneCuts:r.request.sceneCuts??undefined});
  if(r.request.sceneCount!==r.coverage.sceneCount||r.request.sceneCountVerified!==r.coverage.sceneCountVerified||colorDigest(r.request.sceneCuts)!==colorDigest(r.coverage.sceneCuts??null)||r.request.samples.length!==r.coverage.requestedCount)fail();
  if(r.mapping.some((m,i)=>m.id!==r.request.samples[i]?.id||m.requestedTime!==r.request.samples[i]?.time||m.requestedSceneIndex!==r.request.samples[i]?.sceneIndex))fail();
  const scenes=[...new Set(r.mapping.map(m=>m.sceneIndex))].sort((a,b)=>a-b);
  const cuts=r.coverage.sceneCuts;
  if(r.coverage.sceneAttributionVerified!==(cuts!==undefined)||(cuts!==undefined&&(cuts.length+1!==r.coverage.sceneCount||cuts.some((cut,i)=>cut>=r.source.duration||(i>0&&cut<=cuts[i-1])))))fail();
  if(r.mapping.some(m=>m.requestedSceneIndex>=r.coverage.sceneCount||(cuts!==undefined?(m.requestedSceneIndex!==cuts.filter(c=>m.requestedTime>=c).length||m.sceneIndex!==cuts.filter(c=>m.decodedRelativeTime>=c).length):m.requestedSceneIndex!==m.sceneIndex)))fail();
  if(r.coverage.sampledCount!==r.mapping.length||r.mapping.length>r.coverage.requestedCount||scenes.some(n=>n>=r.coverage.sceneCount)
    ||JSON.stringify(scenes)!==JSON.stringify(r.coverage.sampledSceneIndices)
    ||JSON.stringify(Array.from({length:r.coverage.sceneCount},(_,i)=>i).filter(i=>!scenes.includes(i)))!==JSON.stringify(r.coverage.omittedSceneIndices))fail();
  if(r.status!=="measured") {if(!r.reason||r.measurements||(r.status==="not_applicable"&&r.request.kind!=="audio"))fail();return;}
  if(r.reason||!r.measurements||!r.normalization||!r.probe||r.identity.status!=="verified"||r.mapping.length!==r.coverage.requestedCount||r.mapping.length===0
    ||r.source.beforeSha256!==r.source.sha256||r.source.afterSha256!==r.source.sha256||r.request.kind==="audio"||r.request.colorManagement.mode!=="rec709"||r.request.colorManagement.outputTransform!=="rec709_sdr"
    ||(r.request.color!==null&&r.request.color.interpretation!=="auto"&&r.request.color.interpretation!==r.normalization?.interpretation))fail();
  const measurements=r.measurements!,probe=r.probe!;
  if(measurements.frames.length!==r.mapping.length||measurements.changes.length!==r.mapping.length-1||r.mapping.reduce((sum,m)=>sum+m.width*m.height,0)>786432)fail();
  const ids=new Set<string>();let previous=-1;
  for(const [i,m] of r.mapping.entries()) {
    const observed=m.decodedPts*m.timeBase.numerator/m.timeBase.denominator-probe.timelineOrigin;
    if(!Number.isSafeInteger(m.decodedPts)||ids.has(m.id)||m.decodedRelativeTime<=previous||m.requestedTime>=r.source.duration||m.decodedRelativeTime>=r.source.duration
      ||Math.abs(observed-m.decodedSourceTime)>1e-9||Math.abs(observed-r.source.start-m.decodedRelativeTime)>1e-9||m.decodedRelativeTime<m.requestedTime-1e-7)fail();
    ids.add(m.id);previous=m.decodedRelativeTime;
    const f=measurements.frames[i];if(f.sampleId!==m.id||f.timeSeconds!==m.decodedRelativeTime||f.pixelCount!==m.width*m.height)fail();
    for(const value of [f.nearBlack,f.nearWhite,...f.encodedEndpoints.low,...f.encodedEndpoints.high,f.encodedEndpoints.anyLow,f.encodedEndpoints.anyHigh,f.neutralCandidates])if(value.count>f.pixelCount||value.fraction!==value.count/f.pixelCount)fail();
    // The analyzer accumulates finite [0,1] doubles: summation of a constant
    // surface can place its mean a few ULP outside min/max. This arithmetic
    // error bound is not a color/quality threshold and changes no measurements.
    const sumRoundingBound=f.pixelCount*Number.EPSILON;
    for(const d of [f.linearRelativeY,f.relativeLinearChroma])if(d.minimum>d.maximum||d.mean<d.minimum-sumRoundingBound||d.mean>d.maximum+sumRoundingBound||d.p01>d.p05||d.p05>d.p50||d.p50>d.p95||d.p95>d.p99)fail();
    if(i>0) {const c=measurements.changes[i-1],p=measurements.frames[i-1];if(c.fromSampleId!==p.sampleId||c.toSampleId!==f.sampleId||c.elapsedSeconds!==f.timeSeconds-p.timeSeconds||c.meanYDifference!==f.linearRelativeY.mean-p.linearRelativeY.mean||c.medianYDifference!==f.linearRelativeY.p50-p.linearRelativeY.p50)fail();}
  }
}

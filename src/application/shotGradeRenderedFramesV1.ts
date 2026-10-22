import {mkdir,writeFile,readFile,lstat,realpath} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";
import {findClip} from "../domain/editGraph";
import {assertColorGradeV2} from "../domain/colorGradeV2Schema";
import type {EditProject} from "../domain/types";
import type {ColorGradeV2} from "../domain/visualTypes";
import {resolveColorGradeV2} from "../color/gradeV2";
import {bakeResolvedGradeLut,ffmpegRenderCubeText} from "../color/gradeLutBake";
import {gradeV2LutFilters} from "../color/gradeV2Ffmpeg";
import {readBoundMaterialColorFrameV1} from "./autoColorFrame";
import {readShotGradeWorkingSurfaceV1,unpackShotGradeWorkingPixelsV1,type ShotGradeWorkingSourceV1} from "./shotGradeFramesV1";
import {colorBytesSha,colorDigest,colorFileSha,colorToolPaths} from "./materialColorSamplingRuntime";
import type {MaterialIntelligencePacket} from "./materialIntelligence";
import type {MaterialColorRuntime,MaterialColorReceipt} from "./materialColorSamplingTypes";

export interface ShotGradeRenderedRuntimeV1 extends MaterialColorRuntime {cacheRoot:string}
const refuse=(message:string):never=>{throw Error("SHOT_GRADE_RENDERED_INVALID: "+message);};

/** A real local post-v2 readback. The LUT precedes area sampling; this is never
 * inferred by grading an already-downsampled raster. Spatial effects, layout
 * after v2, other layers and final output remain outside this surface. */
export async function readShotGradeRenderedSurfaceV1(inputMeasured:MaterialColorReceipt|undefined,inputSource:ShotGradeWorkingSourceV1,inputProject:EditProject,
 sampleIndex:number,sourcePath:string,runtime:ShotGradeRenderedRuntimeV1,remainingMs:number,
 inputGrade?:ColorGradeV2|null,highBitDepth=false){
 const started=performance.now();
 if(!Number.isFinite(remainingMs)||remainingMs<=0||remainingMs>120000||!isAbsolute(runtime.cacheRoot))refuse("Invalid budget/cache root");
 const budget=()=>{runtime.signal?.throwIfAborted();const ms=remainingMs-(performance.now()-started);if(ms<=0)refuse("Post-grade time budget exceeded");return ms;};
 const measured=structuredClone(inputMeasured),source=structuredClone(inputSource),project=structuredClone(inputProject),clip=findClip(project,source.clipId);
 const grade=assertColorGradeV2(inputGrade===undefined?clip.gradeV2??{schema:"editkin.color-grade/v2"}:inputGrade??{schema:"editkin.color-grade/v2"});
 const resolved=resolveColorGradeV2(grade,"rec709_display");
 if(resolved.finishing)refuse("Spatial finishing requires its actual renderer");
 budget();const pre=await readShotGradeWorkingSurfaceV1(measured,source,project,sampleIndex,sourcePath,runtime,budget(),highBitDepth);budget();
 let cube:{sha256:string;bytes:number;path:string}|null=null,filters=[...pre.surface.plan.filters];
 let frame={...pre.frame,stage:"clip_working_post_v2" as const,pixels:pre.frame.pixels.slice()},alpha=pre.alpha.slice(),cohort=pre.alphaCohort;
 let rawSha256=pre.surface.hashes.rawRgbaSha256,sourceClock=pre.surface.sourceClock;
 if(!resolved.identity){
  const text=ffmpegRenderCubeText(bakeResolvedGradeLut(resolved),"Editkin local post-v2 evidence",highBitDepth);budget();
  const bytes=Buffer.from(text,"utf8");if(bytes.length>16*1024*1024)refuse("Cube byte budget exceeded");
  const sha256=colorBytesSha(bytes),directory=join(runtime.cacheRoot,"shot-grade-cubes-v1");
  await mkdir(directory,{recursive:true});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())refuse("Aliased cube directory");
  const root=await realpath(runtime.cacheRoot),actual=await realpath(directory),scope=relative(root,actual);
  if(scope.startsWith("..")||isAbsolute(scope))refuse("Cube cache escaped authorized root");
  const path=join(directory,sha256+".cube");
  try{await writeFile(path,bytes,{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  const file=await lstat(path);if(!file.isFile()||file.isSymbolicLink()||file.size!==bytes.length||colorBytesSha(await readFile(path))!==sha256)refuse("Cube cache bytes changed");
  cube={sha256,bytes:bytes.length,path};budget();
  const tail=pre.surface.plan.sampling.resampled?filters.splice(-2):[];
  filters.push(...gradeV2LutFilters(path,highBitDepth),...tail);
  const decoded=await readBoundMaterialColorFrameV1(measured,sampleIndex,filters,pre.surface.plan.pixelFormat,sourcePath,runtime,budget());budget();
  if(decoded.width!==frame.width||decoded.height!==frame.height||decoded.sampleId!==frame.sampleId||decoded.timeSeconds!==frame.timeSeconds)refuse("Post-grade clock/raster differs from pre-grade evidence");
  const unpacked=unpackShotGradeWorkingPixelsV1(decoded.bytes,decoded.width,decoded.height,highBitDepth);
  if(unpacked.alpha.some((value,index)=>value!==pre.alpha[index]))refuse("Pointwise grade changed alpha cohort");
  frame={...frame,pixels:unpacked.rgb};alpha=unpacked.alpha;cohort=unpacked.alphaCohort;rawSha256=colorBytesSha(decoded.bytes);
  sourceClock={...sourceClock,pts:decoded.pts,timeBase:decoded.timeBase,decodedSourceTime:decoded.decodedTime,decodedRelativeTime:decoded.timeSeconds};
  if(colorBytesSha(await readFile(path))!==sha256)refuse("Cube drift during decoding");budget();
 }
 if(await colorFileSha(sourcePath)!==pre.surface.source.sha256||await colorFileSha(colorToolPaths(runtime).ffmpeg)!==pre.surface.tool.sha256)refuse("Source/tool drift during post-grade decoding");budget();
 return {frame,alpha,allPixelsOpaque:cohort.opaquePixels===cohort.totalPixels,alphaCohort:cohort,
  surface:{schema:"editkin.shot-grade-rendered-frame/v1" as const,scope:"actual-source-clock-local-clip-after-v2-before-spatial" as const,
   projectSnapshotSha256:pre.surface.projectSnapshotSha256,measurementSha256:pre.surface.measurementSha256,
   source:pre.surface.source,sourceClock,tool:pre.surface.tool,geometry:pre.surface.plan.geometry,
   gradeSnapshotSha256:colorDigest(grade),cube,filters,workingSpace:frame.workingSpace,stage:frame.stage,
   sampling:{...pre.surface.plan.sampling,order:"after-primary-legacy-look-and-v2" as const},precision:pre.surface.plan.precision,
   hashes:{rawRgbaSha256:rawSha256,packedRgbSha256:colorBytesSha(new Uint8Array(frame.pixels.buffer)),packedAlphaSha256:colorBytesSha(new Uint8Array(alpha.buffer))},
   alphaCohort:cohort,identityGradeBypass:resolved.identity,postV2SpatialEffectsMeasured:false as const,otherLayersMeasured:false as const,finalOutputMeasured:false as const,
   elapsedMs:performance.now()-started},
 };
}

/** Keep the old material-bound entry point; raw local surfaces do not authorize commands. */
export async function readShotGradeRenderedFrameV1(inputPacket:MaterialIntelligencePacket,inputProject:EditProject,
 sampleIndex:number,sourcePath:string,runtime:ShotGradeRenderedRuntimeV1,remainingMs:number,
 inputGrade?:ColorGradeV2|null,highBitDepth=false){
 const packet=structuredClone(inputPacket),source=packet.source;
 const value=await readShotGradeRenderedSurfaceV1(packet.analysis.color,{
  clipId:source.clipId,assetId:source.assetId,sourceSha256:source.sourceSha256,
  sourceStart:source.sourceStart,duration:source.duration,color:source.color,
 },inputProject,sampleIndex,sourcePath,runtime,remainingMs,inputGrade,highBitDepth);
 return {...value,surface:{...value.surface,materialId:packet.materialId}};
}

import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, realpath, lstat, unlink, rmdir } from "node:fs/promises";
import type { EditProject } from "../domain/types";
import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import type { LongformUiFocusProjectClockV1 } from "../domain/longformUiFocusProjectClockV1";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import type { LongformUiFocusProjectClockRuntimeV1 } from "./longformUiFocusProjectClockRuntimeV1";
import { longformUiFocusProjectClockAlgorithmSha256V1 } from "./longformUiFocusProjectClockRuntimeV1";
import { colorBytesSha, colorDigest, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { readBoundedFile } from "../shared/boundedFile";
import { resolveLongformSourceV1, longformSourceSha256V1 } from "./longformMaterialIntakeV1";
import { longformUiFocusHoldAlgorithmSha256V1 } from "./longformUiFocusHoldRuntimeV1";
import { longformUiFocusGeometryGraphV1 } from "../render/longformUiFocusGeometryGraphV1";
import { probeMedia } from "../render/ffmpegMedia";
import { withRenderLifetime, renderLifetimeSignal } from "../render/renderLifetime";
import { finite } from "../render/ffmpegExpressions";
import { runLongformUiFocusGeometryProcessV1 } from "./longformUiFocusGeometryProcessV1";
import { assertLongformUiFocusGeometryClockV1, prepareLongformUiFocusGeometryDraftV1 } from "./longformUiFocusGeometryDraftV1";
export interface LongformUiFocusGeometryRuntimeV1 extends LongformUiFocusProjectClockRuntimeV1 {workRoot:string}
const modulePaths=['longformUiFocusGeometryRuntimeV1.ts','longformUiFocusGeometryDraftV1.ts','longformUiFocusGeometryProcessV1.ts',
  '../domain/longformUiFocusGeometryDraftV1.ts','../render/longformUiFocusGeometryGraphV1.ts','../render/longformUiFocusProjectGeometryV1.ts',
  '../render/longformUiFocusProjectGeometryTraceV1.ts','../domain/longformUiFocusProjectGeometryV1.ts','../domain/longformUiFocusNativeFrameV1.ts',
  'longformUiFocusProjectClockV1.ts','longformUiFocusProjectTraceV1.ts','longformMaterialIntakeV1.ts','../render/ffmpegComposite.ts',
  '../render/animatedGeometryCanvas.ts','../render/compositeFrameClock.ts','../render/ffmpegExpressions.ts','../render/planner.ts',
  '../render/mediaDisplayGeometry.ts','../render/sourceColorFilters.ts','../render/mediaProcess.ts','../render/renderLifetime.ts',
  '../render/creativeFilters.ts','../render/highBitDepthAlphaDelivery.ts','../domain/editGraph.ts','../domain/clipMirrors.ts',
  '../domain/clipAnimation.ts','../domain/clipAlphaPlan.ts','../domain/types.ts','../domain/visualTypes.ts','../shared/boundedFile.ts'];
async function codeSha(){
  const entry=fileURLToPath(import.meta.url);
  if(extname(entry)!=='.ts')return colorDigest({mode:'bundle',sha256:colorBytesSha(await readBoundedFile(entry,64*1024**2))});
  return colorDigest(await Promise.all(modulePaths.map(async path=>({path,sha256:colorBytesSha(await readBoundedFile(resolve(dirname(entry),path),2*1024**2))}))));
}
// Refuse disk bytes that changed after this actual runtime was loaded.
const loadedCode=codeSha();
export async function longformUiFocusGeometryAlgorithmSha256V1(){const current=await codeSha();
  if(current!==await loadedCode)throw Error('UI_FOCUS_GEOMETRY_LOADED_CODE_CHANGED');return current;}
/** Actual framehash output executes the full observed geometry stream. Hashes
 * are process evidence; they do not attest a native/resident project render. */
export function verifyLongformUiFocusGeometryFrameHashV1(bytes:Uint8Array,startFrame:number,count:number,
  timeBase:{numerator:number;denominator:number},width:number,height:number){
  const lines=Buffer.from(bytes).toString('utf8').trim().split(/\r?\n/),base=lines.filter(line=>/^#tb 0:/.test(line));
  if(base.length!==1||base[0]!==`#tb 0: ${timeBase.numerator}/${timeBase.denominator}`)throw Error('UI_FOCUS_GEOMETRY_FRAMEHASH_TIME_BASE');
  const rows=lines.filter(line=>line&&!line.startsWith('#'));
  if(rows.length!==count||count<1||count>65536)throw Error('UI_FOCUS_GEOMETRY_FRAMEHASH_COVERAGE');
  for(const [i,line]of rows.entries()){
    const fields=line.split(',').map(s=>s.trim());
    if(fields.length!==6||fields[0]!=='0'||fields[1]!==String(startFrame+i)||fields[2]!==String(startFrame+i)||fields[3]!=='1'
      ||fields[4]!==String(width*height*4)||!/^[a-f0-9]{64}$/.test(fields[5]))throw Error('UI_FOCUS_GEOMETRY_FRAMEHASH_FRAME');
  }
  return{sha256:colorBytesSha(bytes),frames:rows.length};
}
export async function prepareLongformUiFocusGeometryV1(projectInput:EditProject,artifactInput:LongformUiFocusArtifactV1,
  holdInput:LongformUiFocusHoldResultV1,clockInput:LongformUiFocusProjectClockV1,runtime:LongformUiFocusGeometryRuntimeV1){
  const project=structuredClone(projectInput),artifact=structuredClone(artifactInput),hold=structuredClone(holdInput),clock=structuredClone(clockInput);
  const context=assertLongformUiFocusGeometryClockV1(project,artifact,hold,clock);runtime.signal?.throwIfAborted();
  await runtime.validateCurrent();runtime.signal?.throwIfAborted();
  const source=await resolveLongformSourceV1(runtime.sourceRoot,artifact.sourcePath),before=await longformSourceSha256V1(source,runtime.signal);
  const identity=await getMaterialColorRuntimeIdentity(runtime),algorithm=await longformUiFocusGeometryAlgorithmSha256V1();
  if(identity.status!=='verified'||identity.identitySha256!==hold.provider.decodeRuntimeIdentitySha256||before.sha256!==hold.sourceSha256
    ||await longformUiFocusHoldAlgorithmSha256V1()!==hold.provider.implementationSha256
    ||await longformUiFocusProjectClockAlgorithmSha256V1()!==clock.provider.implementationSha256)throw Error('UI_FOCUS_GEOMETRY_CURRENT_SOURCE_RUNTIME');
  const workRoot=await realpath(runtime.workRoot);if(!(await lstat(workRoot)).isDirectory())throw Error('UI_FOCUS_GEOMETRY_WORK_ROOT');
  const workspace=await mkdtemp(join(workRoot,'uif-geometry-')),script=join(workspace,'graph.txt'),output=join(workspace,'project.framehash');
  try{
    const actual=await withRenderLifetime({signal:runtime.signal,timeoutMs:180000},async()=>{
      const probe=await probeMedia(source,runtime.ffprobePath),graph=longformUiFocusGeometryGraphV1(project,artifact.project.clipId,source,probe,
        context.target.frame.display.normalization.filters);
      if(Buffer.byteLength(graph.graph)>1024**2)throw Error('UI_FOCUS_GEOMETRY_GRAPH_BUDGET');await writeFile(script,graph.graph,{flag:'wx'});
      const args=['-hide_banner','-loglevel','debug','-debug_ts','-nostats','-nostdin',...graph.sourceInputArgs,...graph.baseInputArgs,
        '-filter_complex_threads','1','-filter_complex_script',script,'-map','[uif_gray]','-an','-sn','-dn','-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','pipe:1',
        '-map','[uif_project]','-an','-sn','-dn','-fps_mode','passthrough','-pix_fmt','rgba','-c:v','rawvideo','-f','framehash','-hash','sha256',output];
      return runLongformUiFocusGeometryProcessV1(runtime.ffmpegPath,args,{sourceTimeBase:hold.sourceTimeBase,projectTimeBase:graph.projectTimeBase,
        sourceStart:Number(finite(context.project.sourceStart)),sourceOrigin:context.sourceOrigin,timelineStartFrame:graph.startFrame,duration:Number(finite(context.project.duration)),
        width:context.target.frame.display.decoded.width,height:context.target.frame.display.decoded.height,
        videoStreamIndex:Number(context.target.frame.display.probe.metadata.stream.index)},graph.mode,new Set(clock.frames.map(row=>row.projectFrame)),renderLifetimeSignal());
    });
    runtime.signal?.throwIfAborted();
    const hash=verifyLongformUiFocusGeometryFrameHashV1(await readBoundedFile(output,20*1024**2),Math.round(project.fps*context.project.timelineStart),
      actual.geometryFramesObserved,clock.projectTimeBase,project.width,project.height);
    await runtime.validateCurrent();runtime.signal?.throwIfAborted();const after=await longformSourceSha256V1(source,runtime.signal),current=await getMaterialColorRuntimeIdentity(runtime);
    if(colorDigest(before)!==colorDigest(after)||current.status!=='verified'||current.identitySha256!==identity.identitySha256
      ||await longformUiFocusGeometryAlgorithmSha256V1()!==algorithm||await longformUiFocusProjectClockAlgorithmSha256V1()!==clock.provider.implementationSha256)
      throw Error('UI_FOCUS_GEOMETRY_INPUT_CHANGED');
    if(colorDigest(projectInput)!==colorDigest(project)||colorDigest(artifactInput)!==colorDigest(artifact)||colorDigest(holdInput)!==colorDigest(hold)
      ||colorDigest(clockInput)!==colorDigest(clock))throw Error('UI_FOCUS_GEOMETRY_ARGUMENT_CHANGED');runtime.signal?.throwIfAborted();
    return prepareLongformUiFocusGeometryDraftV1(project,artifact,hold,clock,actual,algorithm,hash.sha256);
  }finally{
    // These exact two regular helper files are owned by this mkdtemp. Links or
    // unexpected additions are preserved and make retirement fail-visible.
    for(const path of [script,output]){const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(info){if(!info.isFile()||info.isSymbolicLink())throw Error('UI_FOCUS_GEOMETRY_HELPER_CHANGED');await unlink(path);}}
    await rmdir(workspace);
  }
}

import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { findClip, findTrack } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import type { GradePanelEditScopeV1 } from "../domain/colorGradePanelEditsV1";
import type { ColorWindowNodeV1 } from "../domain/colorWindowV1";
import { captureWholeGradeCubeV1 } from "../domain/wholeGradeCubeSnapshotV1";
import { resolveAcesInput, resolveInputColorSpace } from "../color/primaryGrade";
import { parseCubeFile } from "../color/cubeLut";
import { exportWholeGradeCubeV1, type WholeGradeCubeRuntimeV1 } from "./wholeGradeCubeExportV1";

export interface WholeGradeCubeSourceV2 { project:EditProject;clipId:string;playhead:number;scope?:GradePanelEditScopeV1; }
export interface WholeGradeCubeRuntimeV2 extends Omit<WholeGradeCubeRuntimeV1,"size"|"highBitDepth"|"readback"> {
  /** Desktop callers supply the current project/selection/scope. CLI callers may use the same immutable source. */
  current?:()=>WholeGradeCubeSourceV2|Promise<WholeGradeCubeSourceV2>;
}
export type WholeGradeCubeRefusalV2 = "WHOLE_GRADE_V2_LEGACY_LOOK" | "WHOLE_GRADE_V2_INPUT" | "WHOLE_GRADE_V2_OUTPUT"
  | "WHOLE_GRADE_V2_SPATIAL_NODE" | "WHOLE_GRADE_V2_STALE" | "WHOLE_GRADE_V2_POLICY" | "WHOLE_GRADE_V2_REFERENCE" | "WHOLE_GRADE_V2_QUALITY";
export interface WholeGradeCubeQualityV2 { size:number;holdouts:number;maximumCodeError:number;limitCodeError:number; }
export class WholeGradeCubeErrorV2 extends Error {
  constructor(readonly code:WholeGradeCubeRefusalV2,options?:ErrorOptions,readonly quality?:WholeGradeCubeQualityV2) { super(code,options);this.name="WholeGradeCubeErrorV2"; }
}
export const wholeGradeCubeSha256V2=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const hash=(value:unknown)=>wholeGradeCubeSha256V2(canonicalJson(value));
function capture(source:WholeGradeCubeSourceV2) {
  const {project,clipId,playhead,scope}=source,clip=findClip(project,clipId),track=findTrack(project,clip.trackId);
  if (clip.creative?.lookPresetId!==undefined)throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_LEGACY_LOOK");
  for(const node of clip.gradeV2?.nodes??[]) {
    const spatial=node as ColorWindowNodeV1;
    if(spatial.windowMaskId!==undefined||spatial.windowOutside!==undefined||
      (node.secondaryHslV1?.cleanup&&Object.hasOwn(node.secondaryHslV1.cleanup,"spatialV1")))throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_SPATIAL_NODE");
  }
  const snapshot=structuredClone(captureWholeGradeCubeV1(project,clipId,playhead));
  const input=snapshot.management.mode==="aces2"?resolveAcesInput(snapshot.asset):resolveInputColorSpace(snapshot.asset);
  if(!["rec709","srgb"].includes(input)||snapshot.rec709Input==="camera")throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_INPUT");
  if(!["rec709_sdr","p3d65_sdr"].includes(snapshot.management.outputTransform))throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_OUTPUT");
  if(!Number.isSafeInteger(project.revision)||project.revision<0||scope&&(!scope.owner||typeof scope.owner!=="object"||!Number.isSafeInteger(scope.sessionId)||scope.sessionId<0))throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_POLICY");
  const bindingSha256=hash({projectId:project.id,revision:project.revision,updatedAt:project.updatedAt,clipId,playhead,snapshot});
  // Only one clip/asset is needed. Do not clone a ten-hour project's other clips or material trees.
  const frozenClip={...clip,color:snapshot.color,gradeV2:snapshot.gradeV2,keyframes:[],creative:clip.creative?structuredClone(clip.creative):undefined};
  const frozenProject:EditProject={...project,fps:snapshot.fps,colorManagement:snapshot.management,
    assets:[snapshot.asset],tracks:[{...track,clips:[frozenClip]}]};
  return {snapshot,input,playhead,bindingSha256,frozenProject,scope:{owner:scope?.owner,sessionId:scope?.sessionId}};
}

/** Accepted Q-E1 policy: refuse legacy looks; do not omit one and call the old failure fixed.
 * The existing FFmpeg reference is unchanged, locked to 65³ and its original fixed512 / 2-code gate.
 */
export async function exportWholeGradeCubeV2(source:WholeGradeCubeSourceV2,runtime:WholeGradeCubeRuntimeV2) {
  runtime.signal?.throwIfAborted();
  if(Object.hasOwn(runtime,"size")||Object.hasOwn(runtime,"highBitDepth")||Object.hasOwn(runtime,"readback"))throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_POLICY");
  const captured=capture(source),current=runtime.current,alphaReadback=captured.snapshot.management.mode==="aces2";
  const assertCurrent=async()=>{
    runtime.signal?.throwIfAborted();
    try {
      const live=capture(current?await current():source);
      if(live.bindingSha256!==captured.bindingSha256||live.scope.owner!==captured.scope.owner||live.scope.sessionId!==captured.scope.sessionId)
        throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_STALE");
    } catch(cause) { runtime.signal?.throwIfAborted();throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_STALE",{cause}); }
    runtime.signal?.throwIfAborted();
  };
  await assertCurrent();
  let reference:Awaited<ReturnType<typeof exportWholeGradeCubeV1>>;
  try {
    reference=await exportWholeGradeCubeV1(captured.frozenProject,captured.snapshot.clipId,captured.playhead,{
      ffmpegPath:runtime.ffmpegPath,ffmpegSha256:runtime.ffmpegSha256,workRoot:runtime.workRoot,
      colorRoot:runtime.colorRoot,lutRoot:runtime.lutRoot,signal:runtime.signal,size:65,...(alphaReadback?{readback:"rgba16-v2" as const}:{})});
  } catch(cause) {
    runtime.signal?.throwIfAborted();
    const quality=(cause as {quality?:WholeGradeCubeQualityV2}|undefined)?.quality;
    if(quality?.size===65&&quality.holdouts===512&&quality.limitCodeError===2&&Number.isFinite(quality.maximumCodeError)&&quality.maximumCodeError>2)
      throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_QUALITY",{cause},{size:65,holdouts:512,maximumCodeError:quality.maximumCodeError,limitCodeError:2});
    throw cause;
  }
  await assertCurrent();
  const q=reference.quality,child=reference.receipt.child,readback=reference.receipt.readback;
  if(reference.size!==65||q.size!==65||q.holdouts!==512||q.channels!==1536||q.limitCodeError!==2||!Number.isFinite(q.maximumCodeError)||q.maximumCodeError>2
    ||q.maximumCodeError<0||!Number.isFinite(q.meanCodeError)||q.meanCodeError<0||q.meanCodeError>q.maximumCodeError+1e-12
    ||q.scope!=="fixed512off-grid-atlas-controls-only"||!child.closed||child.code!==0
    ||child.executableBefore.sha256!==runtime.ffmpegSha256||child.executableAfter.sha256!==runtime.ffmpegSha256
    ||(alphaReadback?(!readback||readback.schema!=="editkin.whole-grade-rgba16-readback/v2"||!readback.alphaOpaque):readback!==undefined)
    ||reference.receipt.snapshotSha256!==wholeGradeCubeSha256V2(JSON.stringify(reference.snapshot))
    ||hash(reference.snapshot)!==hash(captured.snapshot))throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_REFERENCE");
  // A shareable LUT must not expose the author's asset name or local staging paths in TITLE/receipt.
  const title=`Editkin Whole Grade v2 (${captured.input} source to ${captured.snapshot.management.outputTransform})`;
  const text=`TITLE "${title}"\n`+reference.text.replace(/^TITLE[^\r\n]*\r?\n?/gm,"");
  const parsed=parseCubeFile(text);
  if(parsed.kind!=="3d"||parsed.size!==65||parsed.domainMin.some(n=>n!==0)||parsed.domainMax.some(n=>n!==1)
    ||!parsed.values.every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new WholeGradeCubeErrorV2("WHOLE_GRADE_V2_REFERENCE");
  const bytes=Buffer.byteLength(text),cubeSha256=wholeGradeCubeSha256V2(text);
  const resources=[...new Map(reference.receipt.resources.map(r=>[`${r.sha256}:${r.bytes}`,{sha256:r.sha256,bytes:r.bytes}])).values()];
  const receipt={schema:"editkin.whole-grade-cube/v2" as const,purpose:"source-display-rgb-to-output-display-rgb" as const,
    bindingSha256:captured.bindingSha256,snapshotSha256:reference.receipt.snapshotSha256,
    input:captured.input,workingSpace:captured.snapshot.management.mode==="aces2"?"acescct":"rec709_display",
    output:captured.snapshot.management.outputTransform,sample:{localSeconds:captured.snapshot.localTime,fps:captured.snapshot.fps,animationBeyondSample:false},
    legacyLookPolicy:"refused" as const,cube:{size:65,utf8Bytes:bytes,sha256:cubeSha256},
    quality:{size:65,holdouts:512,channels:1536,maximumCodeError:q.maximumCodeError,meanCodeError:q.meanCodeError,limitCodeError:2,scope:q.scope},
    tool:{sha256:child.executableBefore.sha256,closed:true,exitCode:0},resources,...(readback?{readback}:{}),
    exclusions:["spatial-finishing","windows","alpha","geometry","other-layers","animation-beyond-sample",...(captured.snapshot.excluded.effectPresetIds.length?["creative-effects"]:[])],
    measured:{ffmpegStaticColourPrefix:true,fixed512Controls:true,sourceMedia:false,previewParity:false,nativeProcessorParity:false,fullRgbDomain:false}};
  await assertCurrent();
  return {text,receipt,bindingSha256:captured.bindingSha256,assertCurrent,
    /** Private host diagnostics. The file publisher never serializes these paths/arguments. */
    execution:reference.receipt};
}
export type WholeGradeCubeArtifactV2=Awaited<ReturnType<typeof exportWholeGradeCubeV2>>;

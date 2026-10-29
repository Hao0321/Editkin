import { mkdtemp, writeFile, unlink, rmdir, lstat, realpath } from "node:fs/promises";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditProject } from "../domain/types";
import type { PreparedLongformUiFocusNativeFramesV1 } from "../domain/longformUiFocusNativeFrameV1";
import { describeLongformUiFocusNativeFramesV1, longformUiFocusNativeFrameV1, longformUiFocusNativeRuntimeContextV1 } from "./longformUiFocusNativeFrameV1";
import { colorBytesSha, colorDigest, colorFileSha } from "./materialColorSamplingRuntime";
import { resolveLongformSourceV1, longformSourceSha256V1 } from "./longformMaterialIntakeV1";
import { readBoundedFile } from "../shared/boundedFile";
import { runAnalysisProcess } from "./analysisProcess";
export interface LongformUiFocusNativeFrameRuntimeV1 {
  nativeCorePath:string;sourceRoot:string;workRoot:string;signal?:AbortSignal;
  /** The eventual source owner revalidates its actual viewed/confirmed hold job. */
  validateCurrent:()=>Promise<void>;
}
export async function longformUiFocusNativeFrameAlgorithmSha256V1(){
  const entry=fileURLToPath(import.meta.url);
  if(extname(entry)!=='.ts')return colorDigest({mode:'bundle',sha256:colorBytesSha(await readBoundedFile(entry,64*1024**2))});
  const paths=['longformUiFocusNativeFrameRuntimeV1.ts','longformUiFocusNativeFrameV1.ts','../domain/longformUiFocusNativeFrameV1.ts',
    '../render/longformUiFocusNativeGeometryV1.ts','analysisProcess.ts','longformUiFocusProjectClockV1.ts','longformUiFocusHoldV1.ts',
    '../motion/panelGeometry.ts','../motion/compositionV2.ts'];
  return colorDigest(await Promise.all(paths.map(async path=>({path,sha256:colorBytesSha(await readBoundedFile(resolve(dirname(entry),path),1024**2))}))));
}
/** Actual native frame primitive for the normalized source display. It does not
 * attest a resident project render or bypass the frozen project's render path. */
export async function renderLongformUiFocusNativeFrameV1(projectInput:EditProject,handle:PreparedLongformUiFocusNativeFramesV1,timelineFrame:number,
  runtime:LongformUiFocusNativeFrameRuntimeV1){
  const project=structuredClone(projectInput),draft=describeLongformUiFocusNativeFramesV1(project,handle),context=longformUiFocusNativeRuntimeContextV1(project,handle);
  const frame=longformUiFocusNativeFrameV1(project,handle,timelineFrame);runtime.signal?.throwIfAborted();
  await runtime.validateCurrent();runtime.signal?.throwIfAborted();
  const source=await resolveLongformSourceV1(runtime.sourceRoot,context.sourcePath),before=await longformSourceSha256V1(source,runtime.signal);
  const nativeBefore=await colorFileSha(runtime.nativeCorePath),algorithmBefore=await longformUiFocusNativeFrameAlgorithmSha256V1();
  if(before.sha256!==context.sourceSha256||nativeBefore!==context.nativeCoreSha256)throw Error("UI_FOCUS_NATIVE_CURRENT_SOURCE_RUNTIME");
  const workRoot=await realpath(runtime.workRoot);if(!(await lstat(workRoot)).isDirectory())throw Error("UI_FOCUS_NATIVE_WORK_ROOT");
  const workspace=await mkdtemp(join(workRoot,'uif-native-')),input=join(workspace,'request.json'),output=join(workspace,'frame.rgba');
  try{
    const payload=JSON.stringify({schema:'editkin.native-motion-paint-frame/v1',scene:frame.scene,poses:frame.poses,outputPath:output});
    if(Buffer.byteLength(payload)>4*1024**2)throw Error("UI_FOCUS_NATIVE_REQUEST_BUDGET");
    await writeFile(input,payload,{flag:'wx'});runtime.signal?.throwIfAborted();
    const actual=await runAnalysisProcess(runtime.nativeCorePath,['engine-motion-paint-frame',input],{cwd:workspace,timeoutMs:30000,
      signal:runtime.signal,label:'原生焦點影格',maximumStdout:65536,maximumStderr:65536});
    runtime.signal?.throwIfAborted();const receipt=JSON.parse(actual.stdout.toString('utf8')),bytes=frame.scene.width*frame.scene.height*4;
    if(receipt.schema!=='editkin.native-motion-paint-frame/v1'||receipt.width!==frame.scene.width||receipt.height!==frame.scene.height
      ||receipt.bytes!==bytes||receipt.encoding!=='straight-srgb-rgba8'||receipt.interpolation!=='scene-linear-premultiplied')throw Error("UI_FOCUS_NATIVE_OUTPUT_CONTRACT");
    const rgba=await readBoundedFile(output,bytes),rgbaSha256=colorBytesSha(rgba);
    if(rgba.length!==bytes||receipt.rgbaSha256!==rgbaSha256)throw Error("UI_FOCUS_NATIVE_OUTPUT_PIXELS");
    await runtime.validateCurrent();runtime.signal?.throwIfAborted();
    const after=await longformSourceSha256V1(source,runtime.signal);
    if(colorDigest(before)!==colorDigest(after)||await colorFileSha(runtime.nativeCorePath)!==nativeBefore
      ||await longformUiFocusNativeFrameAlgorithmSha256V1()!==algorithmBefore||colorDigest(projectInput)!==colorDigest(project))throw Error("UI_FOCUS_NATIVE_INPUT_CHANGED");
    describeLongformUiFocusNativeFramesV1(projectInput,handle);runtime.signal?.throwIfAborted();
    const row=draft.frames.find(row=>row.projectFrame===timelineFrame);
    return{schema:'editkin.longform-ui-focus-native-frame/v1' as const,draftId:draft.draftId,timelineFrame,width:frame.scene.width,height:frame.scene.height,
      state:row?'ACTIVE_WINDOW' as const:'INACTIVE_WINDOW' as const,sourcePts:row?.sourcePts,sourceImageSha256:row?.imageSha256,opacity:row?.opacity??0,
      rgba,rgbaSha256,nativeFrameReceipt:receipt,nativeCoreSha256:nativeBefore,algorithmSha256:algorithmBefore,
      sourceDisplayOverlayPixelsVerified:true as const,projectGeometryProjected:false as const,editableProjectGraphCompiled:false as const,
      projectModified:false as const,focusHintsReady:false as const,artworkStatus:'ART_PENDING_CLAUDE' as const,selectableByDefault:false as const};
  }finally{
    // Only exact two helper files in this newly created canonical owned folder.
    // Unexpected files or links are preserved and make retirement fail-visible.
    for(const path of [input,output]){const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(info){if(!info.isFile()||info.isSymbolicLink())throw Error("UI_FOCUS_NATIVE_HELPER_CHANGED");await unlink(path);}}
    await rmdir(workspace);
  }
}

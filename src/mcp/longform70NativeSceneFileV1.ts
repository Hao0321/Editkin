import { readProject } from "./storage";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { canonicalJson } from "../shared/canonicalJson";
import { prepareLongform70NativeSceneV1 } from "../application/longform70NativeSceneV1";
import type { Longform70NativeSceneRequestV1 } from "../domain/longform70NativeSceneV1";

/** Verified file/font ingress. Preparation only returns commands; the file is
 * re-read before returning, and no glyph contours cross the MCP response. */
export async function prepareLongform70NativeSceneFileV1(projectPath:string,input:Longform70NativeSceneRequestV1,
  environment:NodeJS.ProcessEnv=process.env,signal?:AbortSignal){
  signal?.throwIfAborted();const project=await readProject(projectPath),pin=canonicalJson(project);
  const prepared=await withReferenceMotionPhysicalFonts(deps=>{
    if(!deps.prepareText)throw Error("LONGFORM70_PHYSICAL_FONT_PROVIDER");
    return prepareLongform70NativeSceneV1(project,input,{prepareText:deps.prepareText,signal});
  },environment,signal);
  signal?.throwIfAborted();if(canonicalJson(await readProject(projectPath))!==pin)throw Error("LONGFORM70_PROJECT_FILE_CHANGED");
  signal?.throwIfAborted();const batch=prepared.commands[0];if(batch.type!=="batch")throw Error("LONGFORM70_ATOMIC_COMMANDS");
  return{schema:"editkin.longform70-native-scene-file-prepared/v1"as const,status:prepared.status,readOnly:true,
    projectRevision:project.revision,sceneId:prepared.sceneId,recipeId:prepared.recipeId,designProfileSha256:prepared.designProfileSha256,
    commands:batch.commands,applyAsOneBatch:true,graphicCount:prepared.graphicCount,
    graphicBindings:prepared.bindings.map(({slot,graphic,presetId,presetVariant,evidenceRefs})=>({slot,id:graphic.id,presetId,presetVariant,
      range:{startFrame:Math.round(graphic.timelineStart*30),endFrame:Math.round((graphic.timelineStart+graphic.duration)*30)},evidenceRefs})),
    physicalLayouts:prepared.layouts.map(layout=>({graphicId:layout.graphicId,fontSize:layout.fontSize,lineCount:layout.lineCount,
      safeRect:layout.safeRect,box:layout.box,physicalFont:layout.physicalFont,receiptId:layout.receiptId,unitCount:layout.unitCount})),checks:prepared.checks,
    artStatus:prepared.artStatus,selectableByDefault:false,freshEvidenceState:prepared.freshEvidenceState,contentVerified:false,projectModified:false,
    next:"Bind flat native commands and exact variants to fresh v4 material/design/motion declarations, independently audit and apply as one batch, then render and review. PREPARED does not authorize or apply a plan."};
}

import type { EditProject } from "../domain/types";
import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import type { LongformUiFocusProjectClockV1 } from "../domain/longformUiFocusProjectClockV1";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import type { LongformUiFocusGeometryDraftV1, PreparedLongformUiFocusGeometryV1 } from "../domain/longformUiFocusGeometryDraftV1";
import type { LongformUiFocusGeometryProcessResultV1 } from "./longformUiFocusGeometryProcessV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { assembleLongformUiFocusProjectClockV1, longformUiFocusProjectContextV1 } from "./longformUiFocusProjectClockV1";
import { projectLongformUiFocusQuadV1 } from "../render/longformUiFocusProjectGeometryV1";
import { LONGFORM_UI_FOCUS_NATIVE_STYLE_V1 } from "../domain/longformUiFocusNativeFrameV1";
const owners=new WeakMap<PreparedLongformUiFocusGeometryV1,LongformUiFocusGeometryDraftV1>();
function freeze(value:unknown){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}}
freeze(LONGFORM_UI_FOCUS_NATIVE_STYLE_V1);
export function assertLongformUiFocusGeometryClockV1(project:EditProject,artifact:LongformUiFocusArtifactV1,hold:LongformUiFocusHoldResultV1,clock:LongformUiFocusProjectClockV1){
  const context=longformUiFocusProjectContextV1(project,artifact,hold),expected=assembleLongformUiFocusProjectClockV1(project,artifact,hold,
    {...clock.provider,sourceTimestampOffsetPts:clock.sourceTimestampOffsetPts,frames:clock.frames},clock.provider,clock.projectTimeBase);
  if(colorDigest(expected)!==colorDigest(clock)||clock.provider.decodeRuntimeIdentitySha256!==hold.provider.decodeRuntimeIdentitySha256)
    throw Error('UI_FOCUS_GEOMETRY_CLOCK_BINDING');return context;
}
/** Internal runtime port. Public metadata/receipt seals grant no source authority;
 * the source owner's current artifact and confirmed completed hold are mandatory. */
export function prepareLongformUiFocusGeometryDraftV1(projectInput:EditProject,artifactInput:LongformUiFocusArtifactV1,holdInput:LongformUiFocusHoldResultV1,
  clockInput:LongformUiFocusProjectClockV1,actual:LongformUiFocusGeometryProcessResultV1,implementationSha256:string,projectFrameHashSha256:string):PreparedLongformUiFocusGeometryV1{
  const project=structuredClone(projectInput),artifact=structuredClone(artifactInput),hold=structuredClone(holdInput),clock=structuredClone(clockInput);
  assertLongformUiFocusGeometryClockV1(project,artifact,hold,clock);
  if(!/^[a-f0-9]{64}$/.test(implementationSha256)||!/^[a-f0-9]{64}$/.test(projectFrameHashSha256)
    ||!/^[a-f0-9]{64}$/.test(actual.processStderrSha256))throw Error('UI_FOCUS_GEOMETRY_PROVIDER');
  const keys=['inputFramesObserved','outputFramesObserved','droppedSourceFrames','duplicatedSourceFrames','processStdoutSha256'] as const;
  if(keys.some(key=>actual[key]!==clock.provider[key])||actual.sourceTimestampOffsetPts!==clock.sourceTimestampOffsetPts
    ||actual.geometryFramesObserved!==actual.outputFramesObserved||actual.frames.length!==clock.frames.length||actual.geometry.length!==clock.frames.length)
    throw Error('UI_FOCUS_GEOMETRY_ACTUAL_SOURCE_CLOCK');
  if(clock.frames.length<11||clock.frames.length*clock.projectTimeBase.numerator/clock.projectTimeBase.denominator<.8-1e-7)
    throw Error('UI_FOCUS_GEOMETRY_HINT_WINDOW');
  const frames=clock.frames.map((row,i)=>{
    const observed=actual.frames[i],witness=actual.geometry[i];
    if(observed.projectFrame!==row.projectFrame||observed.sourcePts!==row.sourcePts||observed.imageSha256!==row.imageSha256
      ||Math.abs(observed.sourceTime-row.sourceTime)>1e-7||witness.projectFrame!==row.projectFrame)throw Error('UI_FOCUS_GEOMETRY_ACTUAL_FRAME_BINDING');
    const projected=projectLongformUiFocusQuadV1(project,artifact.project.clipId,row.targetQuad,witness,LONGFORM_UI_FOCUS_NATIVE_STYLE_V1.subtitleReserveAt1080*project.height/1080);
    return{projectFrame:row.projectFrame,sourcePts:row.sourcePts,sourceTime:row.sourceTime,imageSha256:row.imageSha256,
      sourceQuad:structuredClone(row.targetQuad),witness:structuredClone(witness),projected};
  });
  const body:Omit<LongformUiFocusGeometryDraftV1,'draftId'>={schema:'editkin.longform-ui-focus-geometry-draft/v1',artifactId:artifact.artifactId,
    holdReceiptSha256:hold.receiptSha256,clockReceiptSha256:clock.receiptSha256,projectCanonicalSha256:colorDigest(project),sourceSha256:hold.sourceSha256,
    candidateId:hold.candidateId,canvas:{width:project.width,height:project.height},frames,
    provider:{route:'ffmpeg-source-hold-project-geometry',decodeRuntimeIdentitySha256:clock.provider.decodeRuntimeIdentitySha256,implementationSha256,
      processStdoutSha256:actual.processStdoutSha256,processStderrSha256:actual.processStderrSha256,projectFrameHashSha256,outputFramesObserved:actual.outputFramesObserved},
    actualSourceHoldGeometryIntegrated:true,projectModified:false,editableProjectGraphCompiled:false,nativePresentationVerified:false,browserPresentationVerified:false,
    focusHintsReady:false,artworkStatus:'ART_PENDING_CLAUDE',selectableByDefault:false};
  const draft={...body,draftId:colorDigest(body)};freeze(draft);
  const handle=Object.freeze({schema:'editkin.prepared-longform-ui-focus-geometry/v1' as const,draftId:draft.draftId,frameCount:frames.length});owners.set(handle,draft);return handle;
}
export function describeLongformUiFocusGeometryV1(project:EditProject,handle:PreparedLongformUiFocusGeometryV1){
  const draft=owners.get(handle);if(!draft||colorDigest(project)!==draft.projectCanonicalSha256)throw Error('UI_FOCUS_GEOMETRY_FACTORY_OR_CURRENT_PROJECT');
  return structuredClone(draft);
}

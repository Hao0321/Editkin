import type { EditProject, MotionGraphic } from "../domain/types";
import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import type { LongformUiFocusProjectClockV1 } from "../domain/longformUiFocusProjectClockV1";
import { LONGFORM_UI_FOCUS_NATIVE_STYLE_V1 as STYLE, type LongformUiFocusNativeFrameDraftV1, type PreparedLongformUiFocusNativeFramesV1 } from "../domain/longformUiFocusNativeFrameV1";
import { assembleLongformUiFocusProjectClockV1, longformUiFocusProjectContextV1 } from "./longformUiFocusProjectClockV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { motionGraphicV2LayoutReceipt, motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { longformUiFocusNativeOutlineV1 } from "../render/longformUiFocusNativeGeometryV1";
import type { NativePaintScene, PaintPose } from "../motion/nativeGlyphPaint";
type Owner={draft:LongformUiFocusNativeFrameDraftV1;projectSha256:string;artifact:LongformUiFocusArtifactV1;hold:LongformUiFocusHoldResultV1;
  frames:Map<number,{scene:NativePaintScene;poses:readonly PaintPose[]}>};
const prepared=new WeakMap<PreparedLongformUiFocusNativeFramesV1,Owner>();
function freeze(value:unknown){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
freeze(STYLE);
function owner(project:EditProject,handle:PreparedLongformUiFocusNativeFramesV1){const found=prepared.get(handle);
  if(!found||colorDigest(project)!==found.projectSha256)throw Error("UI_FOCUS_NATIVE_FACTORY_OR_CURRENT_PROJECT");return found;}
/** Internal factory. Source/native project presentation and persisted editable
 * graph are separate requirements; this factory cannot grant MCP authority. */
export function prepareLongformUiFocusNativeFramesV1(project:EditProject,artifactInput:LongformUiFocusArtifactV1,
  holdInput:LongformUiFocusHoldResultV1,clock:LongformUiFocusProjectClockV1):PreparedLongformUiFocusNativeFramesV1{
  const artifact=structuredClone(artifactInput),hold=structuredClone(holdInput),context=longformUiFocusProjectContextV1(project,artifact,hold);
  const expected=assembleLongformUiFocusProjectClockV1(project,artifact,hold,{...clock.provider,sourceTimestampOffsetPts:clock.sourceTimestampOffsetPts,frames:clock.frames},
    {decodeRuntimeIdentitySha256:clock.provider.decodeRuntimeIdentitySha256,implementationSha256:clock.provider.implementationSha256},clock.projectTimeBase);
  if(colorDigest(expected)!==colorDigest(clock)||clock.sourceSha256!==hold.sourceSha256
    ||clock.provider.decodeRuntimeIdentitySha256!==hold.provider.decodeRuntimeIdentitySha256)throw Error("UI_FOCUS_NATIVE_CLOCK_BINDING");
  const {width,height}=context.target.frame.display.decoded,scale=height/1080,count=clock.frames.length;
  if(count<11||count*clock.projectTimeBase.numerator/clock.projectTimeBase.denominator<.8-1e-7)throw Error("UI_FOCUS_NATIVE_HINT_WINDOW");
  const opacityGraphic:MotionGraphic={schema:'hao.motion-composition/v2',id:'uif-native-opacity',presetId:'reel_native_panel',name:'Focus frame primitive',
    kind:'card',text:'',timelineStart:clock.timelineStartFrame/project.fps,duration:count/project.fps,x:0,y:0,width:.5,
    fontSize:32,fontFamily:'Noto Sans TC',fontWeight:700,outlineWidth:STYLE.outlineWidthAt1080*scale,shadowDepth:0,cornerRadius:STYLE.cornerRadiusAt1080*scale,
    textColor:'#24211E',backgroundColor:STYLE.backgroundColor,accentColor:STYLE.accentColor,animation:'fade',offsetX:0,offsetY:0,
    motionV2:structuredClone(STYLE.motion),layoutV2:{safeArea:{top:0,right:0,bottom:0,left:0},maxLines:1,minFontSize:8,lineGap:0,align:'left',widthMode:'fixed'},
    vectorV2:{schema:'editkin.motion-vector/v1',kind:'panel',heightPixels:height/4,revealFrames:1},compositeLayer:'foreground'};
  const sourceCanvas={...project,width,height},layout=motionGraphicV2LayoutReceipt(sourceCanvas,opacityGraphic);
  const frames=new Map<number,{scene:NativePaintScene;poses:readonly PaintPose[]}>();
  const draftFrames=clock.frames.map(row=>{
    const opacity=motionGraphicV2FrameReceipt(sourceCanvas,opacityGraphic,row.projectFrame,layout).vectorState!.opacity;
    const path=longformUiFocusNativeOutlineV1(width,height,row.targetQuad,STYLE.outlineWidthAt1080*scale,STYLE.cornerRadiusAt1080*scale,STYLE.subtitleReserveAt1080*scale);
    const frame={scene:{width,height,max_scale:1,background:[0,0,0,0] as const,layers:[{id:'uif-focus-outline',path,
      paint:{kind:'solid' as const,color:[82/255,132/255,1,1] as const},clips:[]}]},poses:[{x:0,y:0,scale:1,opacity}]};
    freeze(frame);frames.set(row.projectFrame,frame);return{projectFrame:row.projectFrame,sourcePts:row.sourcePts,sourceTime:row.sourceTime,imageSha256:row.imageSha256,
      targetQuad:structuredClone(row.targetQuad),opacity};
  });
  const body:Omit<LongformUiFocusNativeFrameDraftV1,'draftId'>={schema:'editkin.longform-ui-focus-native-frame-draft/v1',artifactId:artifact.artifactId,
    holdReceiptSha256:hold.receiptSha256,clockReceiptSha256:clock.receiptSha256,candidateId:hold.candidateId,sourceSha256:hold.sourceSha256,projectCanonicalSha256:colorDigest(project),
    canvas:{width,height,coordinateSpace:'upright-source-display'},timelineStartFrame:clock.timelineStartFrame,timelineEndFrame:clock.timelineEndFrame,projectTimeBase:{...clock.projectTimeBase},
    style:structuredClone(STYLE),frames:draftFrames,projectGeometryProjected:false,editableProjectGraphCompiled:false,projectModified:false,focusHintsReady:false,
    artworkStatus:'ART_PENDING_CLAUDE',selectableByDefault:false};
  const draft={...body,draftId:colorDigest(body)};freeze(draft);freeze(artifact);freeze(hold);
  const handle=Object.freeze({schema:'editkin.prepared-longform-ui-focus-native-frames/v1' as const,draftId:draft.draftId,frameCount:count});
  prepared.set(handle,{draft,frames,artifact,hold,projectSha256:colorDigest(project)});return handle;
}
export function describeLongformUiFocusNativeFramesV1(project:EditProject,handle:PreparedLongformUiFocusNativeFramesV1){return structuredClone(owner(project,handle).draft);}
export function longformUiFocusNativeFrameV1(project:EditProject,handle:PreparedLongformUiFocusNativeFramesV1,timelineFrame:number){
  const value=owner(project,handle);if(!Number.isSafeInteger(timelineFrame)||timelineFrame<0)throw Error("UI_FOCUS_NATIVE_INTEGER_FRAME");
  const actual=value.frames.get(timelineFrame);
  return actual??{scene:{width:value.draft.canvas.width,height:value.draft.canvas.height,max_scale:1,background:[0,0,0,0] as const,layers:[]},poses:[]};
}
/** Internal current-source port, never returned through public metadata. */
export function longformUiFocusNativeRuntimeContextV1(project:EditProject,handle:PreparedLongformUiFocusNativeFramesV1){
  const value=owner(project,handle);return{sourcePath:value.artifact.sourcePath,sourceSha256:value.hold.sourceSha256,
    nativeCoreSha256:value.hold.provider.nativeCoreSha256,clockReceiptSha256:value.draft.clockReceiptSha256};
}

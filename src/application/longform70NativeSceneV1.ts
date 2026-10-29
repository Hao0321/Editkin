import { longform70NativeSceneRequestV1Schema } from "../domain/longform70NativeSceneV1";
import type { EditProject, MotionGraphic } from "../domain/types";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import { motionGraphicSchema, motionPresetVariantSchema, projectSchema, type MotionPresetVariant } from "../domain/schema";
import { motionGraphicV2UnitCount, motionGraphicV2ExitStaggerFrames, MOTION_V2_MAX_SEGMENT_FRAMES } from "../domain/motionCompositionV2Contract";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt, motionGraphicV2FrameReceipt, prepareMotionGraphicV2FrameLayout,
  type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { assertPreparedGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { canonicalJson } from "../shared/canonicalJson";
import { assertMotionPresetVariantBinding, motionPresetSeedSha256 } from "./motionPresetVariant";
import { LONGFORM70_CATALOG_V1 } from "./longform70NativeCatalogV1";

export interface Longform70NativeSceneDepsV1 {prepareText:(faceId:string,text:string)=>Promise<PreparedGlyphRun>;signal?:AbortSignal}
type Palette=Record<"primary"|"background"|"ink"|"grid",string>;
function freeze(value:unknown){if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
freeze(LONGFORM70_CATALOG_V1);
export function listLongform70NativeRecipesV1(){return{
  schema:LONGFORM70_CATALOG_V1.schema,id:LONGFORM70_CATALOG_V1.id,designProfileSha256:LONGFORM70_CATALOG_V1.designProfileSha256,
  certification:{...LONGFORM70_CATALOG_V1.certification},width:1920,height:1080,fps:30,subtitleReservePixels:200,
  palette:{...LONGFORM70_CATALOG_V1.palette},recipes:LONGFORM70_CATALOG_V1.recipes.map(recipe=>({id:recipe.id,narrativeRole:recipe.narrativeRole,
    bindings:recipe.elements.flatMap(element=>"binding"in element?[element.binding]:[]),elementCount:recipe.elements.length,
    sceneBackgroundRole:"sceneBackgroundRole"in recipe?recipe.sceneBackgroundRole:null})),
  timingPolicy:"Caller supplies new narration frame ranges and reading holds; no historical offsets or copy defaults.",
  evidencePolicy:"Fresh caller-declared evidence references; v4 material audit is still required before applying a producer plan.",
  reviewRequired:true};}
function resolveOverrides(raw:Readonly<Record<string,unknown>>,palette:Palette){
  const overrides=structuredClone(raw)as Record<string,unknown>;delete overrides.kind;
  for(const field of["textColor","backgroundColor","accentColor"]){const color=overrides[field];
    if(color&&typeof color==="object"){const binding=color as {paletteRole:keyof Palette;alphaHex:string};
      if(!palette[binding.paletteRole]||!/^[a-f0-9]{2}$/i.test(binding.alphaHex))throw Error("LONGFORM70_PALETTE_BINDING");
      overrides[field]=palette[binding.paletteRole]+binding.alphaHex;}}
  return overrides;
}
function prepareGlyphRun(deps:Longform70NativeSceneDepsV1,faceId:string,text:string){
  return new Promise<PreparedGlyphRun>((resolve,reject)=>{
    let settled=false;const signal=deps.signal;
    const finish=(action:()=>void)=>{if(settled)return;settled=true;signal?.removeEventListener("abort",onAbort);action();};
    const onAbort=()=>finish(()=>reject(signal!.reason));
    signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted){onAbort();return;}
    try{Promise.resolve(deps.prepareText(faceId,text)).then(run=>finish(()=>resolve(run)),error=>finish(()=>reject(error)));}
    catch(error){finish(()=>reject(error));}
  });
}
/** Text uses authenticated contours. Vectors keep the authored geometry;
 * the visible conservative box includes entrance/exit translation and scale. */
function inspectFrames(project:EditProject,graphic:MotionGraphic,layout:MotionGraphicV2LayoutReceipt,signal?:AbortSignal){
  const start=Math.round(graphic.timelineStart*30),end=start+Math.round(graphic.duration*30),segments=layout.segments.length;
  if(Math.max(1,segments)*(end-start)>MOTION_V2_MAX_SEGMENT_FRAMES)throw Error("LONGFORM70_FRAME_BUDGET");
  prepareMotionGraphicV2FrameLayout(project,graphic,layout);let inspected=0;
  const inside=(x0:number,y0:number,x1:number,y1:number)=>{
    const s=layout.safeRect,tolerance=.00001;
    if(![x0,y0,x1,y1].every(Number.isFinite)||x0<s.x-tolerance||y0<s.y-tolerance||x1>s.x+s.width+tolerance||y1>s.y+s.height+tolerance)
      throw Error("LONGFORM70_FRAME_INK: "+graphic.id);
  };
  for(let n=start;n<end;n++){
    signal?.throwIfAborted();const frame=motionGraphicV2FrameReceipt(project,graphic,n,layout);if(!frame.visible)throw Error("LONGFORM70_FRAME_CLOCK");
    if(graphic.vectorV2){const pose=frame.vectorState!;if(pose.opacity>0){
      const x=layout.box.x+pose.translateXPixels,y=layout.box.y+pose.translateYPixels;
      // Every source vector phase has scale<=1 and no rotation. Checking the
      // unscaled translated authored box also covers its centred scaling.
      if(pose.scale>1||pose.scale<=0||pose.rotationDegrees)throw Error("LONGFORM70_VECTOR_POSE");
      inside(x,y,x+layout.box.width,y+layout.box.height);}}
    else for(const[index,segment]of layout.segments.entries()){
      const pose=frame.segments[index],ink=segment.outline?.ink;if(!ink||pose.opacity===0)continue;
      if(pose.scale!==1||pose.rotationDegrees)throw Error("LONGFORM70_TEXT_POSE");
      const x=segment.x+pose.translateXPixels,y=segment.y+pose.translateYPixels;
      inside(x+ink.xMin,y+ink.yMin,x+ink.xMax,y+ink.yMax);
    }
    inspected++;
  }
  return inspected;
}

/** Read-only native authoring. Returned commands retain ordinary editable
 * graphics and exact preset variants; glyph receipts never replace text. */
export async function prepareLongform70NativeSceneV1(original:EditProject,raw:unknown,deps:Longform70NativeSceneDepsV1){
  const request=longform70NativeSceneRequestV1Schema.parse(raw),project=projectSchema.parse(original),before=canonicalJson(original);
  deps.signal?.throwIfAborted();if(request.expectedRevision!==project.revision)throw Error("LONGFORM70_REVISION");
  if(project.width!==1920||project.height!==1080||project.fps!==30)throw Error("LONGFORM70_CANVAS: approved1920x1080/30fps");
  const totalFrames=Math.round(projectDuration(project)*30);
  if(request.scope==="existing_timeline"&&(totalFrames===0||request.endFrame>totalFrames))throw Error("LONGFORM70_TIMELINE_RANGE");
  if(request.scope==="empty_canvas"&&totalFrames!==0)throw Error("LONGFORM70_EMPTY_CANVAS");
  const recipe=LONGFORM70_CATALOG_V1.recipes.find(row=>row.id===request.recipeId)!;
  const names=recipe.elements.flatMap(row=>"binding"in row?[row.binding]:[]),provided=Object.keys(request.bindings);
  if(names.length!==provided.length||names.some(name=>!provided.includes(name)))throw Error("LONGFORM70_BINDINGS");
  for(const[name,binding]of Object.entries(request.bindings)){
    if(name==="verified_domain"&&/\s/u.test(binding.text))throw Error("LONGFORM70_DOMAIN_ONE_LINE");
    const handoff=recipe.id==="relationship"&&name==="connection_claim"?request.bindings.payoff_claim.startFrame:request.endFrame;
    if(binding.endFrame!==handoff)throw Error("LONGFORM70_COMPLETE_CLAIM_HOLD");
  }
  if(recipe.id==="relationship"&&request.bindings.connection_claim.startFrame!==request.startFrame)throw Error("LONGFORM70_RELATIONSHIP_CLOCK");
  if(recipe.id==="number-hook"&&request.bindings.verified_number.startFrame!==request.startFrame)throw Error("LONGFORM70_FIRST_FRAME_HOOK");
  const palette=request.palette??LONGFORM70_CATALOG_V1.palette;
  const bindings:Array<{slot:string;graphic:MotionGraphic;presetId:string;presetVariant:MotionPresetVariant;evidenceRefs:string[]}>=[];
  const layouts:MotionGraphicV2LayoutReceipt[]=[],checks:Array<{graphicId:string;framesChecked:number;physicalFont?:string;chosenFontSize:number}>=[];
  const add=async(slot:string,presetId:string,overridesRaw:Readonly<Record<string,unknown>>,bindingName?:string)=>{
    deps.signal?.throwIfAborted();const preset=findMotionGraphicPreset(presetId),cue=bindingName?request.bindings[bindingName]:undefined;
    const start=cue?.startFrame??(slot==="connection"?request.startFrame+12:request.startFrame),end=cue?.endFrame??request.endFrame;
    if(start>=end)throw Error("LONGFORM70_STRUCTURAL_CLOCK");
    const graphicId=`lf70-${request.sceneId}-${slot}`;
    if(project.motionGraphics.some(row=>row.id===graphicId))throw Error("LONGFORM70_GRAPHIC_ID_CONFLICT");
    const overrides=resolveOverrides(overridesRaw,palette);
    if(cue?.minimumFontSize!==undefined){
      if(cue.minimumFontSize>Number(overrides.fontSize))throw Error("LONGFORM70_FONT_FLOOR");
      overrides.layoutV2={...(overrides.layoutV2 as object),minFontSize:cue.minimumFontSize};
    }
    const variant=motionPresetVariantSchema.parse({schema:"editkin.motion-preset-variant/v1",basePresetSha256:motionPresetSeedSha256(preset),
      reason:`longform70 native/v1, approved declarative scene ${recipe.id}/${slot}; new narration/copy and explicit palette/font fit, ART_PENDING_CLAUDE`,overrides});
    const graphic=motionGraphicSchema.parse({...createMotionGraphic(graphicId,preset.seed.kind??"card",cue?.text??"",start/30,(end-start)/30,undefined,preset.seed),...variant.overrides});
    assertMotionPresetVariantBinding(graphic,presetId,variant);
    if(cue){const motion=graphic.motionV2!,units=motionGraphicV2UnitCount(graphic),readingFrames=end-start-motion.entrance.durationFrames-motion.exit.durationFrames
      -(units-1)*(motion.sequence.staggerFrames+motionGraphicV2ExitStaggerFrames(motion));
      if(readingFrames<cue.readingHoldFrames)throw Error("LONGFORM70_READING_HOLD: "+bindingName);}
    let layout:MotionGraphicV2LayoutReceipt;
    if(graphic.vectorV2)layout=motionGraphicV2LayoutReceipt(project,graphic);
    else{
      const face=resolveBundledFontFace(graphic.fontFamily!,graphic.fontWeight!);if(!face||face.weightSubstituted)throw Error("LONGFORM70_FONT_REQUIRED");
      const run=await prepareGlyphRun(deps,face.faceId,graphic.text);deps.signal?.throwIfAborted();assertPreparedGlyphRun(run);
      layout=motionGraphicV2PhysicalLayoutReceipt(project,graphic,run);
      if(layout.lineCount!==1||layout.segments.map(segment=>segment.text).join("")!==graphic.text)throw Error("LONGFORM70_PHYSICAL_COPY");
    }
    const framesChecked=inspectFrames(project,graphic,layout,deps.signal);
    if(!graphic.vectorV2){const last=motionGraphicV2FrameReceipt(project,graphic,end-1,layout);
      if(last.segments.some(segment=>segment.opacity!==1))throw Error("LONGFORM70_COMPLETE_EXIT");}
    bindings.push({slot,graphic,presetId,presetVariant:variant,evidenceRefs:[...(cue?.evidenceRefs??request.evidenceRefs)]});layouts.push(layout);
    checks.push({graphicId,framesChecked,physicalFont:layout.physicalFont?.fontSha256,chosenFontSize:layout.fontSize});
  };
  if("sceneBackgroundRole"in recipe){
    const panel=structuredClone(LONGFORM70_CATALOG_V1.recipes[0].elements[0].authoringOverrides) as Record<string,unknown>;
    panel.backgroundColor={paletteRole:recipe.sceneBackgroundRole,alphaHex:"FF"};
    await add("scene-background","reel_native_panel",panel);
  }
  for(const element of recipe.elements)await add(element.slot,element.presetId,element.authoringOverrides,"binding"in element?element.binding:undefined);
  deps.signal?.throwIfAborted();if(canonicalJson(original)!==before)throw Error("LONGFORM70_PROJECT_CHANGED");
  const commands:EditorCommand[]=[{type:"batch",commands:bindings.map(({graphic})=>({type:"add_motion_graphic",graphic}))}];
  const candidate=projectSchema.parse(applyCommand(project,commands[0]));
  if(canonicalJson(candidate.assets)!==canonicalJson(project.assets)||canonicalJson(candidate.tracks)!==canonicalJson(project.tracks)
    ||canonicalJson(candidate.captions)!==canonicalJson(project.captions))throw Error("LONGFORM70_SOURCE_MUTATION");
  return{schema:"editkin.longform70-native-scene-prepared/v1"as const,status:"PREPARED_NOT_APPLIED"as const,readOnly:true,
    recipeId:recipe.id,sceneId:request.sceneId,request,designProfileSha256:LONGFORM70_CATALOG_V1.designProfileSha256,
    commands,bindings,layouts,checks,graphicCount:bindings.length,artStatus:"ART_PENDING_CLAUDE"as const,selectableByDefault:false,
    freshEvidenceState:"CALLER_DECLARED_REQUIRES_V4_MATERIAL_AUDIT",contentVerified:false,projectModified:false};
}

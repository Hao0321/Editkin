import type {EditProject} from "../domain/types";
import {projectSchema} from "../domain/schema";
import {projectDuration} from "../domain/editGraph";
import {rationalRate} from "../domain/clipAlphaPlan";
import {LONGFORM_MODULE_LIMITS_V1, longformModuleScheduleRequestV1Schema} from "../domain/longformModuleScheduleV1";
import {colorDigest} from "./materialColorSamplingRuntime";

/** New longform budget lane only. References/times are declarations, never
 * actual target, layout, native render or v4 apply authority. */
export function prepareLongformModuleScheduleV1(original:EditProject,raw:unknown,signal?:AbortSignal){
  signal?.throwIfAborted();const request=longformModuleScheduleRequestV1Schema.parse(raw),project=projectSchema.parse(original);
  if(request.expectedRevision!==project.revision)throw Error("LONGFORM_MODULE_REVISION");
  if(project.width<=project.height)throw Error("LONGFORM_MODULE_LANDSCAPE");
  // Keep the existing authored nearest-frame operation order. Rational rate
  // describes duration per decoded tick, rather than a new timeline quantizer.
  const totalFrames=Math.round(projectDuration(project)*project.fps),rate=rationalRate(project.fps);
  if(!Number.isSafeInteger(totalFrames)||totalFrames<1)throw Error("LONGFORM_MODULE_TIMELINE");
  const focusMinimumFrames=Math.ceil(4*rate.numerator/(5*rate.denominator));
  const counts={ui_focus:0,concept:0,recap:0},ids=new Set<string>();
  const modules=[...request.modules].sort((a,b)=>a.startFrame-b.startFrame||a.id.localeCompare(b.id));
  let focusEnd=0,focusFrames=0;
  for(const module of modules){
    signal?.throwIfAborted();if(ids.has(module.id))throw Error("LONGFORM_MODULE_DUPLICATE_ID");ids.add(module.id);
    if(++counts[module.kind]>LONGFORM_MODULE_LIMITS_V1[module.kind])throw Error("LONGFORM_MODULE_LIMIT_"+module.kind);
    if(module.endFrame<=module.startFrame||module.endFrame>totalFrames)throw Error("LONGFORM_MODULE_FRAME_RANGE");
    if(module.kind==="ui_focus"){
      if(module.endFrame-module.startFrame<focusMinimumFrames)throw Error("LONGFORM_MODULE_FOCUS_MINIMUM");
      if(module.startFrame<focusEnd)throw Error("LONGFORM_MODULE_FOCUS_OVERLAP");
      focusEnd=module.endFrame;focusFrames+=module.endFrame-module.startFrame;
    }
  }
  // Union declared module windows without allocating one item per film frame.
  const cleanHolds:Array<{startFrame:number;endFrame:number}>=[];let cursor=0;
  for(const module of modules){if(module.startFrame>cursor)cleanHolds.push({startFrame:cursor,endFrame:module.startFrame});cursor=Math.max(cursor,module.endFrame);}
  if(cursor<totalFrames)cleanHolds.push({startFrame:cursor,endFrame:totalFrames});
  signal?.throwIfAborted();return{
    schema:"editkin.longform-module-schedule/v1" as const,status:"TIMING_BUDGET_PREPARED_NOT_APPLIED" as const,readOnly:true,
    projectId:project.id,projectRevision:project.revision,projectCanonicalSha256:colorDigest(project),totalFrames,
    timeBase:{numerator:rate.denominator,denominator:rate.numerator},limits:{...LONGFORM_MODULE_LIMITS_V1},counts,
    focusMinimumFrames,focusMinimumSeconds:.8,focusMinimumGapFrames:0,focusFrames,modules:structuredClone(modules),cleanHolds,
    referenceState:"CALLER_DECLARED_REQUIRES_MODULE_PREPARATION_AND_V4_AUDIT" as const,
    coordinatesVerified:false,layoutOrLayeringVerified:false,nativePresentationVerified:false,
    projectModified:false,focusHintsReady:false,artworkStatus:"ART_PENDING_CLAUDE" as const,selectableByDefault:false,
    next:"Resolve each reference through its actual current module factory, preserve its exact reading hold and source evidence, then independently audit/apply/render the complete producer plan.",
  };
}

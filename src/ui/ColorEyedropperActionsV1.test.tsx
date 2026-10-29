import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { previewPickerValuesV1 } from "../color/previewPixelPickerV1";
import type { EyedropperActionHostV1, EyedropperSampleStateV1 } from "../application/eyedropperActionInteractionV1";
import { ColorEyedropperActionsV1, type ColorEyedropperLabelsV1 } from "./ColorEyedropperActionsV1";

const labels:ColorEyedropperLabelsV1={title:"Sample actions",neutral:"Set neutral",hsl:"Select this colour",cancel:"Cancel",balanceNode:"Balance",help:"Use the original preview sample.",idle:"Choose an action.",pending:"Reading LUT…",applied:"Applied as one Undo.",unchanged:"Already neutral.",held:"Nothing applied.",cancelled:"Cancelled.",uncertain:"Check the grade first.",originalRequired:"Sample the original side.",calibrationRequired:"Route not calibrated.",stale:"Sample again.",locked:"Read only or locked.",nodeRequired:"Select a node.",nodeLimit:"Four nodes already.",sourceUnsupported:"Source stage unsupported.",lutUnavailable:"LUT unavailable."};
function fixture(){
  const project=createDemoProject();project.tracks[0].clips[0].gradeV2={schema:"editkin.color-grade/v2",nodes:[{id:"selected",offset:{g:.1}}]};
  const onApply=vi.fn(()=>true),host:EyedropperActionHostV1={projectOwner:{},contentOwner:{},sessionId:1,revision:0,projectId:project.id,asset:project.assets[0],clip:project.tracks[0].clips[0],management:{...DEFAULT_COLOR_MANAGEMENT,mode:"rec709",outputTransform:"rec709_sdr"},localTime:0,sourceKey:"source",selectedNodeId:"selected",editable:true,locked:false,selectorWidths:{hueHalfWidthDegrees:12,hueSoftnessDegrees:5,saturationRadius:.08,lightnessRadius:.08,bandSoftness:.02},neutralNodeLabel:labels.balanceNode,onApply};
  const sample:EyedropperSampleStateV1={contextKey:"picker",ready:true,sample:{...previewPickerValuesV1(new Uint8ClampedArray([96,124,144,255])),x:0,y:0,width:64,height:40,patchWidth:1,patchHeight:1,basis:"decoded-source-preview",contextKey:"picker"}};
  const html=()=>renderToStaticMarkup(createElement(ColorEyedropperActionsV1,{configuration:{getHost:()=>host,labels},readSample:()=>sample}));
  return{host,sample,onApply,html};
}
describe("eyedropper action-strip source component",()=>{
  it("renders explicit host labels and two manual actions without dispatching on render",()=>{
    const f=fixture(),html=f.html();expect(html).toContain("Set neutral");expect(html).toContain("Select this colour");expect(html).not.toContain('disabled=""');expect(f.onApply).not.toHaveBeenCalled();
  });
  it.each(["graded","stale","locked","uncalibrated"]as const)("shows the %s hold with disabled actions",kind=>{
    const f=fixture();if(kind==="graded")f.sample.sample!.basis="graded-preview";if(kind==="stale")f.sample.ready=false;if(kind==="locked")f.host.locked=true;if(kind==="uncalibrated")f.host.clip.color.temperature=.2;
    const html=f.html();expect((html.match(/disabled=""/g)??[])).toHaveLength(2);expect(html).toContain({graded:labels.originalRequired,stale:labels.stale,locked:labels.locked,uncalibrated:labels.calibrationRequired}[kind]);expect(f.onApply).not.toHaveBeenCalled();
  });
  it("keeps neutral available while HSL requires a node selection",()=>{
    const f=fixture();f.host.selectedNodeId=undefined;const html=f.html();expect((html.match(/disabled=""/g)??[])).toHaveLength(1);expect(html).toContain(labels.nodeRequired);
  });
});

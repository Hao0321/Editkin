import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { setColorQualifierEnabledV1, setColorQualifierHueEnabledV1, setColorQualifierNumberV1, setColorQualifierOutsideWheelV1 } from "../domain/colorQualifierPanelEditsV1";
import { createClipMask } from "../domain/masks";
import { currentCaptionTextReplacementCommandV1, prepareCaptionTextReplacementV1 } from "./captionTextReplacementV1";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";

describe("resumed editor panels through the real desktop/browser file codec",()=>{
  it("persists a real caption replacement without changing translation, time or clip data",()=>{
    const project=createDemoProject();
    project.captions=[{id:"caption",start:0,duration:2,text:"EDITKIN / Editkin",translation:{language:"en",text:"keep original translation"}}];
    const prepared=prepareCaptionTextReplacementV1(project,"editkin","Editkin",undefined,{caseSensitive:false});
    const changed=dispatchCommand(createHistory(project),currentCaptionTextReplacementCommandV1(project,prepared)!);
    const before=structuredClone(changed.present),opened=decodeProjectBytes(encodeProjectBytes(changed.present));
    expect(opened.captions).toStrictEqual(before.captions);expect(opened.captions[0].text).toBe("Editkin / Editkin");
    expect(opened.tracks).toStrictEqual(before.tracks);expect(undo(changed).present.captions).toEqual(project.captions);
    expect(changed.present).toStrictEqual(before);
  });
  it.each([true,false])("persists HSL fields and independent outside wheels with selector enabled=%s",enabled=>{
    const project=createDemoProject(),clip=project.tracks[0].clips[0];
    let node=setColorQualifierHueEnabledV1(setColorQualifierEnabledV1({id:"n",offset:{master:.04}},true),true);
    node=setColorQualifierNumberV1(node,"hue-center",210);node=setColorQualifierNumberV1(node,"sat-min",.2);
    node=setColorQualifierOutsideWheelV1(node,"gain",{master:.12,r:.02});node=setColorQualifierEnabledV1(node,enabled);
    const grade={schema:"editkin.color-grade/v2" as const,nodes:[node]};
    const changed=dispatchCommand(createHistory(project),{type:"set_clip_grade_v2",clipId:clip.id,grade});
    const opened=decodeProjectBytes(encodeProjectBytes(changed.present));
    expect(opened.tracks[0].clips[0].gradeV2).toStrictEqual(grade);expect(changed.past).toHaveLength(1);
    expect(undo(changed).present.tracks[0].clips[0].gradeV2).toBeUndefined();
  });
  it("refuses colour-window persisted fields before H1/H2, rather than dropping them",()=>{
    const project=createDemoProject(),clip=project.tracks[0].clips[0];
    Object.assign(clip,{masks:[{...createClipMask("color-mask","rectangle"),purpose:"color"}],
      gradeV2:{schema:"editkin.color-grade/v2",nodes:[{id:"n",windowMaskId:"color-mask"}]}});
    expect(()=>parseProject(structuredClone(project))).toThrow();expect(()=>encodeProjectBytes(project)).toThrow();
  });
});

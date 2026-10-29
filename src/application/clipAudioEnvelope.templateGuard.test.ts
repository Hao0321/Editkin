import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { withClipAudioFades } from "../domain/clipAudioEnvelope";
import { applyCommand } from "../domain/commands";
import { AUDIO_TEMPLATE_REFUSAL } from "../domain/clipAudioCommands";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace } from "../typography/preparedGlyphRun";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
describe("sound edits preserve real certified template content",()=>{
  it("refuses a real compiled CURRENT title and preserves its exact saved project",async()=>{
    const {project,clip}=audioEnvelopeFixture();project.width=1080;project.height=1920;
    project.assets[0].kind="video";project.tracks[1].clips=[];clip.trackId="video-main";clip.timelineStart=0;clip.duration=6;project.tracks[0].clips=[clip];
    let next=0;
    const packet=await prepareReferenceMotionTemplateInstance(project,{templateId:"level_bridge",clipId:clip.id,startFrame:0,durationFrames:180,title:"FOCUS",kicker:"LOOK",
      purpose:"Owned audio refusal",evidenceRefs:["owned:audio-envelope"],graphicCadence:"kinetic",
      style:{...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE),typography:{headingFamily:"Bebas Neue",bodyFamily:"Bebas Neue"}}},prefix=>`${prefix}-${++next}`,
      {prepareText:async(faceId,text)=>{const bytes=await readFile(join(resolve("public/fonts"),bundledFontFaceSpec(faceId).fontFile));return(await preparePhysicalFace(faceId,new Uint8Array(bytes)))(text);}});
    const managed=applyCommand(project,{type:"batch",commands:packet.commands}),before=JSON.stringify(managed);
    expect((await inspectReferenceMotionTemplateInstance(managed,packet.instance.id)).status).toBe("CURRENT");
    expect(()=>applyCommand(managed,{type:"set_clip_audio_envelope",clipId:clip.id,envelope:withClipAudioFades(clip,1,1)})).toThrow(AUDIO_TEMPLATE_REFUSAL);
    expect(JSON.stringify(managed)).toBe(before);expect((await inspectReferenceMotionTemplateInstance(managed,packet.instance.id)).status).toBe("CURRENT");
  });
});

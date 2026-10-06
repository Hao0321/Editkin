import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProject, projectDuration } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { encodeProjectBytes, decodeProjectBytes } from "./projectCodec";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { motionGraphicPresets } from "../creative/motionGraphicPresets";
import { prepareMotionGraphicCreation, type MotionGraphicCreationInput } from "./motionGraphicCreation";

const faceBytes = new Map<string, Uint8Array>();
async function trueText(faceId: string, text: string) {
  let bytes = faceBytes.get(faceId);
  if (!bytes) { bytes = new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile))); faceBytes.set(faceId, bytes); }
  return prepareGlyphRun(faceId, text, bytes);
}
function project(fps=30, endFrames=120) {
  const p=createEmptyProject("Synthetic creation window graph", {width:1080,height:1920,fps});
  if(endFrames) p.motionGraphics=[createMotionGraphic("existing","title","既有內容",0,endFrames/fps,undefined,legacyMotionGraphicSeed("title"))];
  return p;
}
function input(p=project(), patch: Partial<MotionGraphicCreationInput>={}): MotionGraphicCreationInput {
  return {expectedRevision:p.revision,graphicId:"new",kind:"title",text:"重點 42%",startFrame:30,preferredDurationFrames:90,scope:"existing_timeline",...patch};
}

// Real bundled binary, factory glyphs and current command/history/codec. This is
// source admission, not mounted GUI, output pixel/art or native performance QA.
describe("new creation exact window and authentic glyph admission",()=>{
  it.each(["title","card","tag","counter"] as const)("prepares %s then commits one undo/save without altering prior content",async kind=>{
    const p=project(), before=canonicalJson(p), request=input(p,{kind,text:kind==="counter"?"42%":"重點 42%"}), beforeInput=canonicalJson(request);
    const r=await prepareMotionGraphicCreation(p,request,{prepareText:trueText});
    expect(r.status).toBe("PREPARED_NOT_APPLIED");expect(r.readOnly).toBe(true);
    expect(r.graphic.schema).toBe("hao.motion-composition/v2");expect(r.graphic.presetId).toBe("generic-"+kind+"-v2");
    expect(r.timing).toMatchObject({fps:30,startFrame:30,endFrame:120,durationFrames:90,timelineEndFrame:120,minimumReadingHoldFrames:24});
    expect(r.validation).toMatchObject({framesChecked:90,actualContourInkChecked:true});
    expect(r.physicalLayout.physicalFont?.fontSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.physicalLayout.segments.some(s=>Boolean(s.outline?.svg)&&Boolean(s.outline?.ass))).toBe(true);
    expect(canonicalJson(p)).toBe(before);expect(canonicalJson(request)).toBe(beforeInput);
    const h=dispatchCommand(createHistory(p),r.commands[0],"new-title");
    expect(h.past).toHaveLength(1);expect(projectDuration(h.present)).toBe(projectDuration(p));
    expect(undo(h).present).toEqual(p);expect(redo(undo(h)).present.motionGraphics).toEqual(h.present.motionGraphics);
    const reopened=decodeProjectBytes(encodeProjectBytes(h.present));
    expect(reopened.motionGraphics).toEqual(h.present.motionGraphics);
    for(const field of ["assets","tracks","captions","motionTracks","director","compositions"] as const)expect(h.present[field]).toEqual(p[field]);
  });
  it.each([5,24,30000/1001,60,240])("uses actual %s fps and never rounds past the existing end",async fps=>{
    const endFrames=Math.floor(4*fps),p=project(fps,endFrames),startFrame=1;
    const r=await prepareMotionGraphicCreation(p,input(p,{startFrame,preferredDurationFrames:Math.min(960,endFrames),text:"42%"}),{prepareText:trueText});
    expect(r.timing.startFrame).toBe(startFrame);expect(r.timing.endFrame).toBe(endFrames);
    expect(Math.round(r.graphic.timelineStart*fps)).toBe(startFrame);expect(Math.round(r.graphic.duration*fps)).toBe(endFrames-startFrame);
    expect(r.timing.readingHoldFrames).toBeGreaterThanOrEqual(Math.ceil(.8*fps));
    expect(projectDuration(applyCommand(p,r.commands[0]))).toBeLessThanOrEqual(projectDuration(p)+1e-9);
  });
  it("one-frame/tiny tail or exact end refuses before font requests and does not create a command",async()=>{
    const p=project(),provider=vi.fn(trueText),before=canonicalJson(p);
    for(const startFrame of [119,120,121])await expect(prepareMotionGraphicCreation(p,input(p,{startFrame}),{prepareText:provider})).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();expect(canonicalJson(p)).toBe(before);
    await expect(prepareMotionGraphicCreation(project(5,20),input(project(5,20),{startFrame:15,preferredDurationFrames:5}),{prepareText:provider})).rejects.toThrow();
  });
  it("explicit zero-duration canvas is admitted only at zero and never used to extend existing media",async()=>{
    const p=project(30,0),r=await prepareMotionGraphicCreation(p,input(p,{scope:"empty_canvas",startFrame:0}),{prepareText:trueText});
    expect(r.timing).toMatchObject({scope:"empty_canvas",startFrame:0,endFrame:90});expect(r.timing.timelineEndFrame).toBeUndefined();
    expect(projectDuration(p)).toBe(0);
    for(const [candidate,patch] of [[p,{scope:"existing_timeline",startFrame:0}],[p,{scope:"empty_canvas",startFrame:1}],[project(),{scope:"empty_canvas",startFrame:0}]] as const)
      await expect(prepareMotionGraphicCreation(candidate,input(candidate,patch),{prepareText:trueText})).rejects.toThrow();
  });
  it("preserves registered phase/stagger while protecting actual last-unit reading hold",async()=>{
    const p=project(30,240),request=input(p,{presetId:"v2-word-cascade",text:"ONE TWO THREE",preferredDurationFrames:120});
    const r=await prepareMotionGraphicCreation(p,request,{prepareText:trueText});
    const m=r.graphic.motionV2!,tail=(3-1)*m.sequence.staggerFrames;
    expect(r.timing.readingHoldFrames).toBe(120-m.entrance.durationFrames-m.exit.durationFrames-2*tail);
    const insufficient=m.entrance.durationFrames+m.exit.durationFrames+2*tail+23;
    await expect(prepareMotionGraphicCreation(p,{...request,preferredDurationFrames:insufficient},{prepareText:trueText})).rejects.toThrow();
  });
  it("blocks stale/duplicate/bad frames, legacy/vector/wrong-kind presets and unknown fields before glyph I/O",async()=>{
    const p=project(),provider=vi.fn(trueText),legacy=motionGraphicPresets().find(x=>x.seed.schema!=="hao.motion-composition/v2")!;
    for(const patch of [{expectedRevision:p.revision+1},{graphicId:"existing"},{startFrame:-1},{startFrame:.5},{preferredDurationFrames:0},{preferredDurationFrames:961},{presetId:legacy.id},{presetId:"reel_native_disc"},{presetId:"generic-card-v2"},{unknown:1},{text:" \n "},{text:"A\rB"},{text:"字".repeat(129)}])
      await expect(prepareMotionGraphicCreation(p,{...input(p),...patch},{prepareText:provider})).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });
  it("refuses serialized factory runs and a real run for different text instead of metric guesses",async()=>{
    const p=project(),request=input(p);
    await expect(prepareMotionGraphicCreation(p,request,{prepareText:async(face,text)=>JSON.parse(JSON.stringify(await trueText(face,text))) as PreparedGlyphRun})).rejects.toThrow();
    await expect(prepareMotionGraphicCreation(p,request,{prepareText:(face)=>trueText(face,"Different")})).rejects.toThrow();
    await expect(prepareMotionGraphicCreation(p,input(p,{text:"😀"}),{prepareText:trueText})).rejects.toThrow();
    await expect(prepareMotionGraphicCreation(p,input(p,{text:"很長的正文".repeat(20)}),{prepareText:trueText})).rejects.toThrow();
  });
  it("rejects mutation of source project or request across actual glyph preparation",async()=>{
    for(const which of ["project","request"]){
      const p=project(),request=input(p);
      await expect(prepareMotionGraphicCreation(p,request,{prepareText:async(face,text)=>{const run=await trueText(face,text);if(which==="project")p.name="Changed";else request.text="Changed";return run;}})).rejects.toThrow(/STALE/);
    }
  });
  it("cancelled before or during unresolved provider produces no prepared command",async()=>{
    const p=project(),before=canonicalJson(p),a=new AbortController();a.abort();const provider=vi.fn(trueText);
    await expect(prepareMotionGraphicCreation(p,input(p),{prepareText:provider,signal:a.signal})).rejects.toThrow(/CANCELLED/);expect(provider).not.toHaveBeenCalled();
    const b=new AbortController(),pending=prepareMotionGraphicCreation(p,input(p),{prepareText:()=>new Promise(()=>{}),signal:b.signal});b.abort();await expect(pending).rejects.toThrow(/CANCELLED/);expect(canonicalJson(p)).toBe(before);
  });
});

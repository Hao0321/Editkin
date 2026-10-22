import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { projectDuration } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { LONGFORM70_RECIPE_IDS_V1, longform70NativeSceneRequestV1Schema } from "../domain/longform70NativeSceneV1";
import { LONGFORM70_CATALOG_V1 } from "./longform70NativeCatalogV1";
import { listLongform70NativeRecipesV1, prepareLongform70NativeSceneV1 } from "./longform70NativeSceneV1";
import { longform70NativeFixtureV1 } from "./longform70NativeSceneV1.fixture";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { editorialPlanSchema } from "./editorialPlan";
import { resolveBundledFontFace } from "../typography/fontFaces";

const faces=new Map<string,Promise<(text:string)=>PreparedGlyphRun>>();
async function text(faceId:string,copy:string){
  if(!faces.has(faceId))faces.set(faceId,readFile(resolve("public/fonts",bundledFontFaceSpec(faceId).fontFile)).then(bytes=>preparePhysicalFace(faceId,new Uint8Array(bytes))));
  return(await faces.get(faceId)!)(copy);
}
it("contains the exact8 new native scene identities and no historical text/clock defaults",()=>{
  const list=listLongform70NativeRecipesV1();expect(list.recipes.map(row=>row.id)).toEqual([...LONGFORM70_RECIPE_IDS_V1]);
  expect(list.recipes.reduce((total,row)=>total+row.elementCount,0)).toBe(30);
  expect(list.certification).toEqual({status:"ART_PENDING_CLAUDE",selectableByDefault:false});
  expect(JSON.stringify(LONGFORM70_CATALOG_V1)).not.toMatch(/exampleText|sourceGraphicId|exampleOffset|exampleDuration|freetwai|10,000/);
  expect(Object.isFrozen(LONGFORM70_CATALOG_V1.recipes[0].elements[0].authoringOverrides)).toBe(true);
});
it.each(LONGFORM70_RECIPE_IDS_V1)("prepares %s as editable native graphics with physical glyphs and complete holds",async recipe=>{
  const f=longform70NativeFixtureV1(recipe),before=canonicalJson(f.project),inputBefore=canonicalJson(f.request);
  const prepared=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  expect(prepared.status).toBe("PREPARED_NOT_APPLIED");expect(prepared.artStatus).toBe("ART_PENDING_CLAUDE");expect(prepared.selectableByDefault).toBe(false);
  expect(prepared.commands).toHaveLength(1);expect(prepared.commands[0].type).toBe("batch");
  expect(prepared.graphicCount).toBe(LONGFORM70_CATALOG_V1.recipes.find(row=>row.id===recipe)!.elements.length+(["domain-cta","invitation"].includes(recipe)?1:0));
  expect(prepared.checks.every(row=>row.framesChecked>0)).toBe(true);
  for(const layout of prepared.layouts.filter(row=>row.physicalFont)){
    expect(layout.lineCount).toBe(1);expect(layout.physicalFont?.fontSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(layout.safeRect.y+layout.safeRect.height).toBe(880);expect(layout.segments.some(row=>row.outline?.svg)).toBe(true);
  }
  expect(canonicalJson(f.project)).toBe(before);expect(canonicalJson(f.request)).toBe(inputBefore);
  const history=dispatchCommand(createHistory(f.project),prepared.commands[0],"scene");expect(history.past).toHaveLength(1);
  expect(canonicalJson(undo(history).present)).toBe(before);
  expect(canonicalJson(redo(undo(history)).present)).toBe(canonicalJson(history.present));
  const opened=decodeProjectBytes(encodeProjectBytes(history.present));
  expect(opened.motionGraphics.map(row=>row.text)).toEqual(prepared.bindings.map(row=>row.graphic.text));
  expect(projectDuration(opened)).toBe(6);
});
it("uses new caller clocks instead of historical recipe phase offsets",async()=>{
  const f=longform70NativeFixtureV1("relationship",300),prepared=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  const first=prepared.bindings.find(row=>row.slot==="find")!.graphic,last=prepared.bindings.find(row=>row.slot==="make")!.graphic;
  expect([first.timelineStart,first.duration,last.timelineStart,last.duration]).toEqual([10,3,13,3]);
  expect(prepared.bindings.find(row=>row.slot==="connection")!.graphic.timelineStart).toBe(10.4);
});
it("preserves existing source/caption/timeline fields and rejects range or revision drift",async()=>{
  const f=longform70NativeFixtureV1("recap-left",30);f.project.motionGraphics=[createMotionGraphic("old","title","既有內容",0,10,undefined,legacyMotionGraphicSeed("title"))];
  f.request.scope="existing_timeline";const before=encodeProjectBytes(f.project),prepared=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  expect(encodeProjectBytes(f.project)).toEqual(before);const applied=dispatchCommand(createHistory(f.project),prepared.commands[0]).present;
  expect(applied.motionGraphics[0]).toEqual(f.project.motionGraphics[0]);expect(applied.tracks).toEqual(f.project.tracks);expect(applied.captions).toEqual(f.project.captions);
  expect(projectDuration(applied)).toBe(10);
  await expect(prepareLongform70NativeSceneV1(f.project,{...f.request,expectedRevision:99},{prepareText:text})).rejects.toThrow("LONGFORM70_REVISION");
  await expect(prepareLongform70NativeSceneV1(f.project,{...f.request,scope:"empty_canvas"},{prepareText:text})).rejects.toThrow("LONGFORM70_EMPTY_CANVAS");
  f.project.motionGraphics=[];await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text})).rejects.toThrow("LONGFORM70_TIMELINE_RANGE");
});
it("rejects missing/unknown bindings, evidence, new models, wrong canvas and a split domain",async()=>{
  const f=longform70NativeFixtureV1("domain-cta"),deps={prepareText:text};
  await expect(prepareLongform70NativeSceneV1(f.project,{...f.request,bindings:{}},deps)).rejects.toThrow("LONGFORM70_BINDINGS");
  await expect(prepareLongform70NativeSceneV1(f.project,{...f.request,bindings:{...f.request.bindings,unexpected:f.request.bindings.brand}},deps)).rejects.toThrow("LONGFORM70_BINDINGS");
  await expect(prepareLongform70NativeSceneV1(f.project,{...f.request,evidenceRefs:[]},deps)).rejects.toThrow();
  await expect(prepareLongform70NativeSceneV1(f.project,{...f.request,model:"medium"},deps)).rejects.toThrow();
  await expect(prepareLongform70NativeSceneV1({...f.project,width:1080,height:1920},f.request,deps)).rejects.toThrow("LONGFORM70_CANVAS");
  f.request.bindings.verified_domain.text="example . org";await expect(prepareLongform70NativeSceneV1(f.project,f.request,deps)).rejects.toThrow("LONGFORM70_DOMAIN_ONE_LINE");
});
it("keeps the hook readable from the first frame and requires contiguous relationship claims",async()=>{
  const hook=longform70NativeFixtureV1("number-hook");hook.request.bindings.verified_number.startFrame=1;
  await expect(prepareLongform70NativeSceneV1(hook.project,hook.request,{prepareText:text})).rejects.toThrow("LONGFORM70_FIRST_FRAME_HOOK");
  const f=longform70NativeFixtureV1("relationship");f.request.bindings.connection_claim.endFrame=91;
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text})).rejects.toThrow("LONGFORM70_COMPLETE_CLAIM_HOLD");
  f.request.bindings.connection_claim.endFrame=90;f.request.bindings.payoff_claim.endFrame=170;
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text})).rejects.toThrow("LONGFORM70_COMPLETE_CLAIM_HOLD");
});
it("requires a physical one-line fit and applies only the caller's explicit font floor",async()=>{
  const f=longform70NativeFixtureV1("recap-left"),binding=f.request.bindings.action;binding.text="完整文字內容不能被截掉";delete binding.minimumFontSize;
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text})).rejects.toThrow("auto-fit");
  binding.minimumFontSize=40;const prepared=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  const graphic=prepared.bindings.find(row=>row.slot==="step01-main")!.graphic,layout=prepared.layouts.find(row=>row.graphicId===graphic.id)!;
  expect(graphic.text).toBe(binding.text);expect(layout.fontSize).toBeLessThan(190);expect(layout.fontSize).toBeGreaterThanOrEqual(40);
  binding.minimumFontSize=300;await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text})).rejects.toThrow("LONGFORM70_FONT_FLOOR");
});
it("rejects unreadably short holds, forged glyphs, cancellation and a changing project",async()=>{
  const short=longform70NativeFixtureV1("invitation");short.request.endFrame=30;Object.values(short.request.bindings).forEach(row=>{row.endFrame=30;});
  await expect(prepareLongform70NativeSceneV1(short.project,short.request,{prepareText:text})).rejects.toThrow("LONGFORM70_READING_HOLD");
  const f=longform70NativeFixtureV1("number-hook");
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:async(...args)=>structuredClone(await text(...args))})).rejects.toThrow("not made by this factory");
  const stop=new AbortController();stop.abort();await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text,signal:stop.signal})).rejects.toMatchObject({name:"AbortError"});
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:async(...args)=>{const run=await text(...args);f.project.name="author revision";return run;}})).rejects.toThrow("LONGFORM70_PROJECT_CHANGED");
});
it("rejects graphic identity collisions and preserves original preset seeds",async()=>{
  const f=longform70NativeFixtureV1("number-hook"),prepared=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  const first=prepared.bindings[0].graphic;f.project.motionGraphics=[first];f.request.scope="existing_timeline";
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text})).rejects.toThrow("LONGFORM70_GRAPHIC_ID_CONFLICT");
  expect(longform70NativeSceneRequestV1Schema.safeParse({...f.request,startFrame:4,endFrame:4}).success).toBe(false);
  expect(LONGFORM70_CATALOG_V1.palette.primary).toBe("#2457F5");
});
it("binds every new native graphic to the existing v4 editorial schema",async()=>{
  const f=longform70NativeFixtureV1("relationship");f.request.sceneId="s".repeat(40);
  const packet=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  for(const binding of packet.bindings){
    const graphic=binding.graphic;
    expect(editorialPlanSchema.shape.graphics.element.parse({id:graphic.id,presetId:binding.presetId,presetVariant:binding.presetVariant,
      range:{startFrame:Math.round(graphic.timelineStart*30),endFrame:Math.round((graphic.timelineStart+graphic.duration)*30)},
      kind:graphic.vectorV2?"native_shape":"title_card",purpose:"context",message:graphic.text,evidenceRefs:binding.evidenceRefs}).id).toBe(graphic.id);
  }
  expect(longform70NativeSceneRequestV1Schema.safeParse({...f.request,sceneId:"s".repeat(41)}).success).toBe(false);
});
it("preserves spaces in fresh English copy without breaking its one-line glyph run",async()=>{
  const f=longform70NativeFixtureV1("recap-left");f.request.bindings.action.text="Verify the source";
  f.request.bindings.action.minimumFontSize=40;
  const packet=await prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:text});
  expect(packet.bindings.find(row=>row.slot==="step01-main")!.graphic.text).toBe("Verify the source");
});
it("rejects an authentic glyph run from the wrong exact font face",async()=>{
  const f=longform70NativeFixtureV1("number-hook");
  await expect(prepareLongform70NativeSceneV1(f.project,f.request,{prepareText:async(_face,copy)=>text(resolveBundledFontFace("Noto Sans TC",700)!.faceId,copy)})).rejects.toThrow(/字型與當前圖卡不一致/);
});
it("settles cancellation during a pending font read and absorbs its late rejection",async()=>{
  const f=longform70NativeFixtureV1("number-hook"),before=canonicalJson(f.project),stop=new AbortController();
  let started!:()=>void,late!: (error:Error)=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const work=prepareLongform70NativeSceneV1(f.project,f.request,{signal:stop.signal,prepareText:()=>{started();return new Promise((_resolve,reject)=>{late=reject;});}});
  const rejected=expect(work).rejects.toMatchObject({name:"AbortError"});await ready;stop.abort();await rejected;
  late(new Error("late font failure"));await Promise.resolve();expect(canonicalJson(f.project)).toBe(before);
});

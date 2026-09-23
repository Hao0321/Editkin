import { describe,expect,it } from "vitest";
import { mkdtemp,mkdir,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDemoProject } from "../domain/demo";
import { resolveAssFontRoot } from "./fontRoot";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"editkin-font-root-test-"));await mkdir(join(root,"render"));
 const bytes=Buffer.from("synthetic-font-integrity-fixture-not-raster-proof");
 const face={weight:400,file:"render/EditkinFace-noto-sans-tc-400.ttf",family:"EditkinFace noto-sans-tc 400",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
 const manifest={schemaVersion:2,fonts:[{id:"noto-sans-tc",family:"Noto Sans TC",faces:[face]}]};
 await writeFile(join(root,face.file),bytes);await writeFile(join(root,"editkin-open-fonts.json"),JSON.stringify(manifest));
 const project=createDemoProject();project.captionStyle.fontFamily="Noto Sans TC";project.captionStyle.bold=false;project.captionStyle.translationFontFamily="Noto Sans TC";project.captionStyle.translationBold=false;project.motionGraphics=[];
 return{root,manifest,face,project};
}
describe("font root compatibility and integrity",()=>{
 it("rejects a substituted v2 font even when its local manifest agrees with its bytes",async()=>{
  const f=await fixture(),g=createMotionGraphic('v2','title','文字',0,3,undefined,findMotionGraphicPreset('v2-word-cascade').seed);g.fontWeight=400;f.project.motionGraphics=[g];
  await expect(resolveAssFontRoot(f.root,f.project)).rejects.toThrow(/measured em metrics/);
 });
 it("keeps absent/private/v1 roots legacy and rejects relative roots",async()=>{
  expect(await resolveAssFontRoot()).toEqual({bundledFaces:false});
  const root=await mkdtemp(join(tmpdir(),"editkin-private-font-test-"));expect(await resolveAssFontRoot(root)).toEqual({fontRoot:root,bundledFaces:false});
  await writeFile(join(root,"editkin-open-fonts.json"),'{"schemaVersion":1}');expect((await resolveAssFontRoot(root)).bundledFaces).toBe(false);
  await expect(resolveAssFontRoot("relative/fonts")).rejects.toThrow(/absolute/);
 });
 it("loads validated v2 render directory and detects byte drift",async()=>{
  const f=await fixture();expect(await resolveAssFontRoot(f.root,f.project)).toEqual({fontRoot:join(f.root,"render"),bundledFaces:true});
  await writeFile(join(f.root,f.face.file),Buffer.alloc(f.face.bytes,88));await expect(resolveAssFontRoot(f.root,f.project)).rejects.toThrow(/integrity/);
 });
 it.each(["escape","duplicate","hash","schema","missing"])("fails closed for %s",async kind=>{
  const f=await fixture();if(kind==="escape")f.face.file="render/../../escape.ttf";
  if(kind==="duplicate")f.manifest.fonts[0].faces.push({...f.face});if(kind==="hash")f.face.sha256="no";
  if(kind==="schema")f.manifest.schemaVersion=7;if(kind==="missing")f.project.captionStyle.bold=true;
  await writeFile(join(f.root,"editkin-open-fonts.json"),JSON.stringify(f.manifest));await expect(resolveAssFontRoot(f.root,f.project)).rejects.toThrow();
 });
});

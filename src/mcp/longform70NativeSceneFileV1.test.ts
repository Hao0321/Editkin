import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeProjectBytes } from "../application/projectCodec";
import { longform70NativeFixtureV1 } from "../application/longform70NativeSceneV1.fixture";
import { LONGFORM70_RECIPE_IDS_V1 } from "../domain/longform70NativeSceneV1";
import { prepareLongform70NativeSceneFileV1 } from "./longform70NativeSceneFileV1";
import * as storage from "./storage";

let root:string,path:string,f:ReturnType<typeof longform70NativeFixtureV1>;
const fonts={EDITKIN_FONT_ROOT:resolve("public/fonts")};
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),"editkin-native70-file-"));path=join(root,"owned.editkin.json");vi.stubEnv("EDITKIN_WORKSPACE",root);
  f=longform70NativeFixtureV1("number-hook");await writeFile(path,encodeProjectBytes(f.project));
});
afterEach(async()=>{
  vi.restoreAllMocks();vi.unstubAllEnvs();const abs=resolve(root),relation=relative(resolve(tmpdir()),abs);
  if(isAbsolute(relation)||relation.startsWith("..")||!relation.startsWith("editkin-native70-file-"))throw Error("Owned native70 test root boundary");
  await rm(abs,{recursive:true,force:true});
});
it.each(LONGFORM70_RECIPE_IDS_V1)("prepares %s through real file and font ingress without writes or glyph SVG payload",async recipe=>{
  f=longform70NativeFixtureV1(recipe);await writeFile(path,encodeProjectBytes(f.project));const before=await readFile(path);
  const result=await prepareLongform70NativeSceneFileV1(path,f.request,fonts);
  expect(result.status).toBe("PREPARED_NOT_APPLIED");expect(result.projectModified).toBe(false);expect(result.selectableByDefault).toBe(false);
  expect(result.applyAsOneBatch).toBe(true);expect(result.commands.every(row=>row.type==="add_motion_graphic")).toBe(true);
  expect(result.graphicBindings.map(row=>row.id)).toEqual(result.commands.flatMap(row=>row.type==="add_motion_graphic"?[row.graphic.id]:[]));
  expect(result.physicalLayouts.filter(row=>row.physicalFont).every(row=>row.lineCount===1)).toBe(true);
  expect(result.physicalLayouts.some(row=>row.physicalFont?.fontSha256)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/"svg"|"assDrawing"|"glyphs"/);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256*1024);expect(await readFile(path)).toEqual(before);
  expect(await readdir(root)).toEqual(["owned.editkin.json"]);
});
it("rejects a real project file mutation after its first read",async()=>{
  const realRead=storage.readProject;let count=0;
  vi.spyOn(storage,"readProject").mockImplementation(async file=>{const project=await realRead(file);
    if(++count===1)await writeFile(path,encodeProjectBytes({...project,name:"Changed while preparing"}));return project;});
  await expect(prepareLongform70NativeSceneFileV1(path,f.request,fonts)).rejects.toThrow("LONGFORM70_PROJECT_FILE_CHANGED");expect(count).toBe(2);
});
it("rejects a stale revision and missing exact fonts while preserving file bytes",async()=>{
  const before=await readFile(path);
  await expect(prepareLongform70NativeSceneFileV1(path,{...f.request,expectedRevision:10},fonts)).rejects.toThrow("LONGFORM70_REVISION");
  await expect(prepareLongform70NativeSceneFileV1(path,f.request,{EDITKIN_FONT_ROOT:join(root,"missing")})).rejects.toThrow();
  expect(await readFile(path)).toEqual(before);
});
it("retains canonical workspace and project extension boundaries",async()=>{
  await expect(prepareLongform70NativeSceneFileV1(resolve(root,"../outside.editkin.json"),f.request,fonts)).rejects.toThrow("超出");
  await expect(prepareLongform70NativeSceneFileV1(join(root,"owned.json"),f.request,fonts)).rejects.toThrow("副檔名");
});
it("does not read or modify a pre-cancelled file request",async()=>{
  const before=await readFile(path),stop=new AbortController();stop.abort();
  const read=vi.spyOn(storage,"readProject");await expect(prepareLongform70NativeSceneFileV1(path,f.request,fonts,stop.signal)).rejects.toMatchObject({name:"AbortError"});
  expect(read).not.toHaveBeenCalled();expect(await readFile(path)).toEqual(before);
});

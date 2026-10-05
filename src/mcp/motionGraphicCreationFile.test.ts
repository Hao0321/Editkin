import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { encodeProjectBytes } from "../application/projectCodec";
import type { MotionGraphicCreationInput } from "../application/motionGraphicCreation";
import { prepareMotionGraphicCreationFile } from "./motionGraphicCreationFile";
import * as storage from "./storage";

let root: string;
let path: string;
let request: MotionGraphicCreationInput;
const fonts = { EDITKIN_FONT_ROOT: resolve("public/fonts") };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-creation-window-"));
  path = join(root, "owned.editkin.json");
  vi.stubEnv("EDITKIN_WORKSPACE", root);
  const p = createEmptyProject("Owned synthetic preparation graph", {width:1080,height:1920,fps:30});
  p.motionGraphics = [createMotionGraphic("prior", "title", "既有內容", 0, 4, undefined, legacyMotionGraphicSeed("title"))];
  await writeFile(path, encodeProjectBytes(p));
  request = {expectedRevision:p.revision,graphicId:"new",kind:"tag",text:"重點",startFrame:30,preferredDurationFrames:90,scope:"existing_timeline"};
});
afterEach(async () => {
  vi.restoreAllMocks();vi.unstubAllEnvs();
  const abs=resolve(root), relation=relative(resolve(tmpdir()),abs);
  if(isAbsolute(relation)||relation.startsWith("..")||!relation.startsWith("editkin-creation-window-")) throw new Error("Owned temp root outside intended test directory");
  await rm(abs,{recursive:true,force:true});
});
// Actual file/workspace ingress and verified bundled-font provider. No SDK or
// render; synthetic graphs are never presented as source-media/art authority.
describe("read-only current graphic preparation file ingress", () => {
  it("returns a real glyph and one pending command while preserving exact project bytes", async () => {
    const before=await readFile(path);
    const r=await prepareMotionGraphicCreationFile(path,request,fonts);
    expect(r.status).toBe("PREPARED_NOT_APPLIED");expect(r.readOnly).toBe(true);
    expect(r.commands).toHaveLength(1);expect(r.timing.endFrame).toBe(120);
    expect(r.physicalLayout.physicalFont?.fontSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.physicalLayout.segments.some(s=>Boolean(s.outline?.svg))).toBe(true);
    expect(await readFile(path)).toEqual(before);
  });
  it("rejects an actual project-file change between the two real reads", async () => {
    const realRead=storage.readProject;
    let count=0;
    vi.spyOn(storage,"readProject").mockImplementation(async file => {
      const p=await realRead(file);
      if(++count===1)await writeFile(path,encodeProjectBytes({...p,name:p.name+" changed"}));
      return p;
    });
    await expect(prepareMotionGraphicCreationFile(path,request,fonts)).rejects.toThrow("專案檔已變更");
    expect(count).toBe(2);
  });
  it("rejects exact stale revision without changing file bytes", async () => {
    const before=await readFile(path);
    await expect(prepareMotionGraphicCreationFile(path,{...request,expectedRevision:request.expectedRevision+1},fonts)).rejects.toThrow("版本");
    expect(await readFile(path)).toEqual(before);
  });
  it("rejects a too-short actual timeline window without applying", async () => {
    const before=await readFile(path);
    await expect(prepareMotionGraphicCreationFile(path,{...request,startFrame:119},fonts)).rejects.toThrow(/MOTION_CREATION_WINDOW: 這次可用 1 格，需要 35 格/);
    expect(await readFile(path)).toEqual(before);
  });
  it("keeps canonical workspace and extension boundaries", async () => {
    await expect(prepareMotionGraphicCreationFile(resolve(root,"../outside.editkin.json"),request,fonts)).rejects.toThrow("超出");
    await expect(prepareMotionGraphicCreationFile(join(root,"owned.json"),request,fonts)).rejects.toThrow("副檔名");
  });
  it("missing physical font refuses instead of estimating or substituting", async () => {
    const before=await readFile(path);
    await expect(prepareMotionGraphicCreationFile(path,request,{EDITKIN_FONT_ROOT:join(root,"missing-fonts")})).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  });
  it("pre-cancelled file request returns no preparation or filesystem change", async () => {
    const before=await readFile(path), controller=new AbortController();controller.abort();
    await expect(prepareMotionGraphicCreationFile(path,request,fonts,controller.signal)).rejects.toThrow();
    expect(await readFile(path)).toEqual(before);
  });
});

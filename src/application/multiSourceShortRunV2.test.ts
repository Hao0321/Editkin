import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import { productionMultiSourceShortDeps } from "../mcp/multiSourceShortToolsV2";
import { prepareMediaBootstrap } from "./mediaBootstrap";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { inspectReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { MATERIAL_INTELLIGENCE_SCHEMA, MATERIAL_SEMANTICS_SCHEMA, type MaterialIntelligencePacket } from "./materialIntelligence";
import { TEMPLATE_SHORT_DEFAULTS_SCHEMA, templateShortDefaultsSchema } from "./templateShortWorkspace";
import { MULTI_SOURCE_SHORT_VERSION, MULTI_SOURCE_SHORT_ROOT } from "./multiSourceShortRecipeV2";
import { startMultiSourceShort, makeMultiSourceShort, getMultiSourceShort, type MultiSourceShortDeps } from "./multiSourceShortRunV2";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const copy = { hook: "以為只是風景", proof: "看清細節就會發現", payoff: "其實藏著故事" };
async function fixture(options: { bigFrames?: boolean; musicFileGrant?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "editkin-owned-multi-unit-"));
  await mkdir(join(root, "media"));
  for (const name of ["a.mp4", "b.mp4", "music.wav"]) await writeFile(join(root, "media", name), `UNIT_SOURCE_${name}`);
  const declaration = { provenance: "Owned generated unit fixture", rightsBasis: "Fixture author", distributionScope: "Unit test only", license: "creator-owned" };
  const defaults = templateShortDefaultsSchema.parse({ schema: TEMPLATE_SHORT_DEFAULTS_SCHEMA, rights: [{ scope: "media", declaration },
    ...(options.musicFileGrant === false ? [] : [{ scope: "media/music.wav", declaration }])], excludedSources: [],
    confirmedBy: "creator", confirmedAt: "2026-10-11T00:00:00.000Z" });
  const projects = new Map<string, EditProject>(), materials = new Map<string, MaterialIntelligencePacket>();
  const frames = new Map<string, Buffer>(), edits: EditorCommand[][] = [];
  let nonce = 0;
  const real = productionMultiSourceShortDeps({ EDITKIN_FONT_ROOT: resolve("public/fonts") });
  const deps: MultiSourceShortDeps = {
    ...real, root, now: () => new Date("2026-10-11T00:00:00.000Z"), randomHex: n => (++nonce).toString(16).padStart(n * 2, "0"),
    readDefaults: async () => ({ defaults, sha256: sha256Canonical(defaults) }),
    resolveSource: async path => { const absolute = resolve(root, path), rel = relative(root, absolute);
      if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("outside fixture"); return { absolute, relative: rel.replaceAll("\\", "/") }; },
    probe: async path => ({ duration: 40, width: 320, height: 240, hasVideo: !path.endsWith(".wav"), hasAudio: path.endsWith(".wav"),
      colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709", colorRange: "limited" }),
    fileSha256: async path => sha(await readFile(path)), freeBytes: vi.fn(async () => 100 * 1024 ** 3),
    createProject: async (path, name, width, height, fps, profile) => {
      const project = createEmptyProject(name, { width, height, fps }); project.editorialProfile = profile;
      projects.set(path, project); await writeFile(resolve(root, path), JSON.stringify(project)); return project;
    },
    readProject: async path => structuredClone(projects.get(path)!),
    prepareBootstrap: async request => {
      const current = projects.get(request.projectPath)!;
      const { projectPath: _projectPath, ...intent } = request;
      return prepareMediaBootstrap(current, { ...intent, sourcePath: resolve(root, intent.sourcePath) }, { workspaceRoot: root, readCurrentProject: async () => structuredClone(current) },
        { inspect: deps.probe, hashFile: deps.fileSha256, now: deps.now });
    },
    applyBootstrap: async (path, commands, revision) => {
      const current = projects.get(path)!;
      expect(current.revision).toBe(revision);
      const project = applyCommand(current, { type: "batch", commands }); projects.set(path, project); edits.push(commands);
      await writeFile(resolve(root, path), JSON.stringify(project)); return structuredClone(project);
    },
    speechModelReady: vi.fn(async () => false),
    prepareMaterial: async request => {
      expect(request.maxKeyframes).toBe(1); expect(request.includeTranscript).toBe(false);
      const materialId = sha256Canonical(request), data = options.bigFrames ? Buffer.alloc(600_000, request.clipId.endsWith("0") ? 16 : 32) : Buffer.from(`UNIT_KEYFRAME_${request.clipId}`);
      const packet: MaterialIntelligencePacket = { schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId,
        source: { assetId: request.assetId, clipId: request.clipId, sourceSha256: request.sourceSha256!, sourceStart: request.sourceStart,
          duration: request.duration, kind: "video", fps: request.fps!, hasAudio: false, width: 320, height: 240 },
        analysis: { scene: { state: "not_applicable", cuts: [] }, transcript: { state: "not_applicable", cueCount: 0, cues: [] } },
        keyframes: [{ id: "kf-1", time: 0, sceneIndex: 0, fileName: "unit-keyframe.jpg", mimeType: "image/jpeg", sha256: sha(data), bytes: data.length }], createdAt: deps.now().toISOString() };
      materials.set(materialId, packet); frames.set(materialId, data); return { packet, cacheHit: false };
    },
    readMaterial: async id => structuredClone(materials.get(id)!),
    readKeyframe: async id => ({ frame: materials.get(id)!.keyframes[0], data: frames.get(id)! }),
    recordSemantics: async input => ({ ...input, schema: MATERIAL_SEMANTICS_SCHEMA, semanticReceiptSha256: sha256Canonical(input), createdAt: deps.now().toISOString() }),
    lock: async () => () => Promise.resolve(),
    readback: async (path, id) => ({ instanceStatus: (await inspectReferenceMotionTemplateInstance(projects.get(path)!, id)).status, summary: {} }),
    render: vi.fn(async (_project, output, options) => {
      expect(options.workRoot.startsWith(root)).toBe(true);
      await writeFile(output, "UNIT_RENDER_PLACEHOLDER"); return { planner: "unit-fixture", outputPath: output };
    }),
    analyzeRendered: vi.fn(async () => ({ technical: { pass: true, checks: [{ id: "UNIT_QA_STUB", pass: true }] }, flags: [], sheets: ["sheet_01.jpg"] })),
  };
  const start = () => startMultiSourceShort({ schema: MULTI_SOURCE_SHORT_VERSION, genre: "travel",
    sources: [{ path: "media/a.mp4", in: 2, out: 12 }, { path: "media/b.mp4", in: 4, out: 14 }], music: { path: "media/music.wav" } }, deps);
  const brief = (runId: string) => ({ schema: MULTI_SOURCE_SHORT_VERSION, runId,
    seen: [{ s: 0, kf: "kf-1", note: "第一段場景" }, { s: 1, kf: "kf-1", note: "第二段場景" }], copy, captions: "copy" as const });
  return { root, deps, projects, materials, frames, edits, start, brief };
}

describe("multi-source Short orchestration, owned projects only", () => {
  it("assembles ordered sources, separate measured captions, declared music and a CURRENT opening with one final render", async () => {
    const f = await fixture(), prepared = await f.start(), runId = prepared.text.runId;
    expect(prepared.images).toHaveLength(2);
    const result = await makeMultiSourceShort(f.brief(runId), f.deps, { mode: "mcp", wait: true });
    expect(result.delivered).toBe(true); expect(result.seconds).toBe(20);
    expect(result.artStatus).toBe("ART_PENDING_CLAUDE"); expect(result.status).not.toBe("READY");
    expect(f.deps.render).toHaveBeenCalledTimes(1);
    expect(f.edits).toHaveLength(2); // one bootstrap, one independently recompiled final composition
    const project = f.projects.get(`${MULTI_SOURCE_SHORT_ROOT}/${runId}/short.editkin.json`)!;
    const clips = project.tracks.flatMap(track => track.clips).filter(clip => clip.id.startsWith("multi-clip"));
    expect(clips.map(clip => [clip.id, clip.timelineStart, clip.sourceStart, clip.duration])).toEqual([
      ["multi-clip-0", 0, 2, 10], ["multi-clip-1", 10, 4, 10],
    ]);
    expect(project.captions).toHaveLength(3);
    expect(project.motionGraphics.every(graphic => graphic.timelineStart + graphic.duration <= 10 + 1e-7)).toBe(true);
    const music = project.tracks.flatMap(track => track.clips).find(clip => clip.id === "multi-music")!;
    expect(music.duration).toBe(20); expect(music.volume).toBeCloseTo(10 ** (-18 / 20));
    expect(music.audioEnvelope?.fades).toEqual({ in: .4, out: .4, duration: 20, offset: 0 });
    expect(await getMultiSourceShort(runId, f.deps)).toEqual(result);
    expect(result.sheets).toEqual([`${MULTI_SOURCE_SHORT_ROOT}/${runId}/sheets/sheet_01.jpg`]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20 * 1024);
  }, 30_000);

  it("serves actual bounded pages and requires descriptions for every source", async () => {
    const f = await fixture({ bigFrames: true }), first = await f.start();
    expect(first.images).toHaveLength(1); expect(first.text.imageBytes).toBe(600_000); expect(first.text.pending).toHaveLength(1);
    const second = await startMultiSourceShort({ schema: MULTI_SOURCE_SHORT_VERSION, runId: first.text.runId, framePage: 2 }, f.deps);
    expect(second.images).toHaveLength(1); expect(second.text.pending).toEqual([]);
    expect(second.images[0].sourceIndex).toBe(1);
    const missing = { ...f.brief(first.text.runId), seen: [{ s: 0, kf: "kf-1", note: "畫面" }, { s: 0, kf: "kf-1", note: "重複" }] };
    await expect(makeMultiSourceShort(missing, f.deps, { mode: "mcp", wait: true })).rejects.toThrow("每段");
    expect(f.edits).toHaveLength(1); expect(f.deps.render).not.toHaveBeenCalled();
  });

  it("rejects altered image bytes rather than accepting a matching metadata hash", async () => {
    const f = await fixture({ bigFrames: true }), first = await f.start();
    const later = [...f.frames.keys()][1]; f.frames.get(later)![0] ^= 255;
    await expect(startMultiSourceShort({ schema: MULTI_SOURCE_SHORT_VERSION, runId: first.text.runId, framePage: 2 }, f.deps)).rejects.toThrow("關鍵畫面");
  });

  it("refuses source-byte changes before final composition without touching the original files", async () => {
    const f = await fixture(), start = await f.start();
    await appendFile(join(f.root, "media/b.mp4"), "_CHANGED");
    await expect(makeMultiSourceShort(f.brief(start.text.runId), f.deps, { mode: "mcp", wait: true })).rejects.toThrow("素材來源");
    expect(f.edits).toHaveLength(1); expect(f.deps.render).not.toHaveBeenCalled();
    expect((await readFile(join(f.root, "media/b.mp4"), "utf8")).endsWith("_CHANGED")).toBe(true);
  });

  it("requires file-specific music rights before creating any project", async () => {
    const f = await fixture({ musicFileGrant: false });
    await expect(f.start()).rejects.toThrow("配樂需要"); expect(f.projects.size).toBe(0);
  });

  it("rejects insufficient output-drive space before project creation", async () => {
    const f = await fixture(); f.deps.freeBytes = vi.fn(async () => 1);
    await expect(f.start()).rejects.toThrow("輸出磁碟"); expect(f.projects.size).toBe(0);
  });

  it("detects an independently recompiled template difference before the single final apply", async () => {
    const f = await fixture(), prepared = await f.start(), original = f.deps.compile; let calls = 0;
    f.deps.compile = async (...args) => { const packet = await original(...args); if (++calls === 2) packet.commands = packet.commands.slice(0, -1); return packet; };
    await expect(makeMultiSourceShort(f.brief(prepared.text.runId), f.deps, { mode: "mcp", wait: true })).rejects.toThrow("重新編譯不一致");
    expect(f.edits).toHaveLength(1); expect(f.deps.render).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps a completed run and its saved result unchanged when make is submitted twice", async () => {
    const f = await fixture(), prepared = await f.start();
    const result = await makeMultiSourceShort(f.brief(prepared.text.runId), f.deps, { mode: "mcp", wait: true });
    const statePath = resolve(f.root, `${MULTI_SOURCE_SHORT_ROOT}/${prepared.text.runId}/run.json`);
    const before = await readFile(statePath);
    await expect(makeMultiSourceShort(f.brief(prepared.text.runId), f.deps, { mode: "mcp", wait: true })).rejects.toThrow("已開始或已完成");
    expect(await getMultiSourceShort(prepared.text.runId, f.deps)).toEqual(result);
    expect(await readFile(statePath)).toEqual(before);
    expect(f.edits).toHaveLength(2); expect(f.deps.render).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("records material preparation failure and retains the imported project without claiming it awaits a brief", async () => {
    const f = await fixture();
    f.deps.prepareMaterial = async () => { throw new Error("material fixture preparation failed"); };
    await expect(f.start()).rejects.toThrow("material fixture preparation failed");
    const projectPath = [...f.projects.keys()][0], runId = /\/(ms-[a-f0-9]{24})\//.exec(projectPath)![1];
    expect(await getMultiSourceShort(runId, f.deps)).toMatchObject({ status: "FAILED_PROJECT_PRESERVED", delivered: false,
      projectPath, applied: true, stage: "preparation" });
    expect(f.edits).toHaveLength(1); expect(f.deps.render).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(resolve(f.root, projectPath), "utf8")).tracks.some((track: { clips: unknown[] }) => track.clips.length > 0)).toBe(true);
  });

  it("preserves the applied editable project when decoded render QA fails", async () => {
    const f = await fixture(), start = await f.start();
    f.deps.analyzeRendered = async () => ({ technical: { pass: false, checks: [] }, flags: [] });
    await expect(makeMultiSourceShort(f.brief(start.text.runId), f.deps, { mode: "mcp", wait: true })).rejects.toThrow("技術檢查");
    const result = await getMultiSourceShort(start.text.runId, f.deps);
    expect(result.delivered).toBe(false); expect(result.applied).toBe(true); expect(f.edits).toHaveLength(2);
    const project = [...f.projects.values()][0]; expect(project.referenceMotionInstances).toHaveLength(1);
  }, 30_000);
});

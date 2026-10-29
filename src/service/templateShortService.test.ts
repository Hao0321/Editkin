import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditProject } from "../domain/types";
import { createEmptyEditkinSkillSelectionReceipt } from "../plugins/skillPack";
import { canonicalJson } from "../shared/canonicalJson";
import { executeAutopilotBatch, type AutopilotBatchManifest, type AutopilotBatchRuntime } from "../application/autopilotBatchExecution";
import { sha256Canonical, type LiveAutopilotIdentity } from "../application/autopilotInvocationIdentity";
import { autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import type { MaterialIntelligencePacket, MaterialSemanticsInput } from "../application/materialIntelligence";
import { acquireProjectLock } from "../application/projectFiles";
import { prepareReferenceMotionTemplateInstance } from "../application/referenceMotionTemplateInstances";
import { TEMPLATE_SHORT_BRIEF_MAX_BYTES, TemplateShortBlockError, parseTemplateShortBrief } from "../application/templateShortBrief";
import { TEMPLATE_SHORT_FIXTURE_POLICY, TEMPLATE_SHORT_FIXTURE_SOURCE, physicalText, templateShortFixtureProject,
  warmTemplateShortFonts } from "../application/templateShortFixtures";
import type { TemplateShortDeps, TemplateShortResult, TemplateShortStartResponse } from "../application/templateShortRun";
import { readTemplateShortDefaults } from "../application/templateShortWorkspace";
import {
  TEMPLATE_SHORT_IN_APP_SEEN_NOTE, blockedTemplateShortResult, compactTemplateShortResult, createTemplateShortProgressFile, dispatchTemplateShortServiceCommand,
  inAppTemplateShortBrief, runTemplateShortInApp, runTemplateShortOneShotProcess, templateShortRunDir, trackTemplateShortDeps,
  writeTemplateShortDefaultsInApp, type TemplateShortInAppEngine, type TemplateShortProgress,
} from "./templateShortService";

const SHORT_ID = "ts-20261010-img-4022-3f9a1c";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), "editkin-template-short-service-")); });
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

describe("the in-app brief", () => {
  it("is the creator's 原本以為 → 其實是, one honest seen line per served frame, and a topic made of their words", () => {
    const brief = inAppTemplateShortBrief(SHORT_ID, ["kf-3", "kf-1", "kf-2", "kf-1"], { hook: " 來看蝙蝠 ", payoff: " 其實是來看水簾的 " });
    expect(brief).toEqual({ schema: "editkin.template-short-brief/v1", shortId: SHORT_ID, topic: "來看蝙蝠→其實是來看水簾的",
      seen: ["kf-1", "kf-2", "kf-3"].map(kf => ({ kf, note: TEMPLATE_SHORT_IN_APP_SEEN_NOTE })), copy: { hook: "來看蝙蝠", payoff: "其實是來看水簾的" } });
    expect(() => parseTemplateShortBrief(brief)).not.toThrow();
    expect(TEMPLATE_SHORT_IN_APP_SEEN_NOTE).toBe("未描述，畫面只用於時間定位（非 AI 判讀）");
  });

  it("stays within 1 KB with the longest copy, id and frame count; the topic is left to the engine only when it cannot fit", () => {
    const longestId = "ts-20261010-abcdefghijklmnopqrstuvwx-3f9a1c"; // a 24-character slug, the longest startTemplateShort makes
    const brief = inAppTemplateShortBrief(longestId, ["kf-1", "kf-2", "kf-3", "kf-4"], { payoff: "水".repeat(32), points: Array.from({ length: 4 }, () => "點".repeat(24)) });
    expect(new TextEncoder().encode(canonicalJson(brief)).byteLength).toBeLessThanOrEqual(TEMPLATE_SHORT_BRIEF_MAX_BYTES);
    expect(brief).toHaveProperty("topic", "水".repeat(32));
    expect(() => parseTemplateShortBrief(brief)).not.toThrow();
    const strike = inAppTemplateShortBrief(longestId, ["kf-1", "kf-2", "kf-3", "kf-4"], { hook: "原".repeat(24), payoff: "水".repeat(32) });
    expect(() => parseTemplateShortBrief(strike)).not.toThrow();
    // Defensive: a topic that could not fit is left out rather than sent over the limit.
    expect(inAppTemplateShortBrief(SHORT_ID, ["kf-1"], { hook: "原".repeat(60), payoff: "水".repeat(64) })).not.toHaveProperty("topic");
    const short = inAppTemplateShortBrief(SHORT_ID, ["kf-1"], { payoff: "其實是", points: [" 一 ", "", "二"] });
    expect(short).toMatchObject({ topic: "其實是", copy: { payoff: "其實是", points: [{ label: "一" }, { label: "二" }] } });
  });
});

describe("results for the screens", () => {
  const delivered = (status: string, checks: unknown[] = []): TemplateShortResult => ({ schema: "editkin.template-short-result/v1", status: status as never, shortId: SHORT_ID,
    projectPath: `${templateShortRunDir(SHORT_ID)}/short.editkin.json`, output: { path: `${templateShortRunDir(SHORT_ID)}/output.mp4`, sha256: "b".repeat(64), bytes: 9, frames: 330 },
    qa: { pass: false, checks } });

  it("keeps delivery, output, project and only the art flags with their seconds", () => {
    const result = compactTemplateShortResult(delivered("NEEDS_FIX", [{ id: "R1_raster", pass: true, detail: "1080×1920" },
      { id: "Q8_stall", pass: false, severity: "FLAG", seconds: [3.7, Number.NaN], detail: "tag 在動作中停了一格" }, { id: "Q3_safe_area", pass: false, severity: "BLOCK", seconds: [1] }]),
    { shortId: SHORT_ID, runDir: templateShortRunDir(SHORT_ID), window: { start: 0, end: 15, seconds: 15, clamped: true } });
    expect(result).toEqual({ schema: "editkin.template-short-in-app/v1", status: "NEEDS_FIX", delivered: true, shortId: SHORT_ID, runDir: templateShortRunDir(SHORT_ID),
      window: { start: 0, end: 15, seconds: 15, clamped: true }, projectPath: `${templateShortRunDir(SHORT_ID)}/short.editkin.json`,
      outputPath: `${templateShortRunDir(SHORT_ID)}/output.mp4`, outputSha256: "b".repeat(64), flags: [{ check: "Q8_stall", seconds: [3.7] }] });
  });

  it("never delivers a blocked or failed run", () => {
    const failed = compactTemplateShortResult({ ...delivered("RENDER_FAILED_PROJECT_APPLIED"), detail: "R1 技術檢查失敗" });
    expect(failed).toMatchObject({ delivered: false, detail: "R1 技術檢查失敗" });
    expect(failed).not.toHaveProperty("outputPath");
    expect(blockedTemplateShortResult(new TemplateShortBlockError("BLOCK_DISK", "D: 只剩 0.5 GB"), { shortId: SHORT_ID })).toEqual({ schema: "editkin.template-short-in-app/v1",
      status: "BLOCK_DISK", delivered: false, shortId: SHORT_ID, flags: [], block: { code: "BLOCK_DISK", detail: "D: 只剩 0.5 GB" } });
  });
});

describe("progress for the desktop", () => {
  it("is written atomically, only forward, and keeps the run's id and folder", async () => {
    const path = join(scratch, "jobs", "job-1", "progress.json");
    const progress = createTemplateShortProgressFile(path, () => new Date("2026-10-10T12:00:00Z"));
    progress.sink({ step: 1, fraction: 0.5 });
    progress.sink({ step: 0, fraction: 0.9, shortId: SHORT_ID, runDir: templateShortRunDir(SHORT_ID) });
    progress.sink({ step: 1, fraction: 2 });
    await progress.flush();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema: "editkin.template-short-progress/v1", step: 1, fraction: 1, shortId: SHORT_ID,
      runDir: templateShortRunDir(SHORT_ID), updatedAt: "2026-10-10T12:00:00.000Z" });
    expect((await readdir(join(scratch, "jobs", "job-1"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports the four real steps from the boundaries the run crosses, passing every value through unchanged", async () => {
    const reports: Array<[number, number]> = [], receipt = { schema: "audit" };
    const runtime = { readPlan: vi.fn(), validatePaths: vi.fn(), reconcile: vi.fn(), audit: vi.fn(async () => receipt),
      apply: vi.fn(async (_item: unknown, _plan: unknown, audit: unknown) => ({ audit })),
      render: vi.fn(async () => ({})), verifyRender: vi.fn(async () => undefined) } as unknown as AutopilotBatchRuntime;
    const deps = { prepareBootstrap: vi.fn(async () => "bootstrap"), prepareMaterial: vi.fn(async () => "material"), recordSemantics: vi.fn(async () => "semantics"),
      compileTemplate: vi.fn(async () => "compiled"), compileDesign: vi.fn(async () => "design"),
      prepareBatch: vi.fn(async () => ({ manifest: {}, statePath: "s", runtime })) } as unknown as TemplateShortDeps;
    const tracked = trackTemplateShortDeps(deps, (step, fraction) => reports.push([step, fraction]));
    expect(await tracked.prepareBootstrap({} as never)).toBe("bootstrap");
    await tracked.prepareMaterial({} as never);
    await tracked.recordSemantics({} as never);
    await tracked.compileTemplate("p", {} as never);
    await tracked.compileDesign({} as never, {} as never);
    const prepared = await tracked.prepareBatch("b", {} as never);
    const audit = await prepared.runtime.audit({} as never, {});
    expect(await prepared.runtime.apply({} as never, {}, audit)).toEqual({ audit: receipt });
    await prepared.runtime.render({} as never, "c");
    await prepared.runtime.verifyRender({} as never, "c");
    expect(reports.map(([step]) => step)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 2, 3]);
    expect(reports.every(([, fraction], index) => index === 0 || reports[index - 1][0] < reports[index][0] || reports[index - 1][1] <= fraction)).toBe(true);
  });
});

describe("the run (orchestrator calls stubbed)", () => {
  const page = (images: string[], pending: string[], window = { in: 0, out: 15, seconds: 15, frames: 450, note: "沒有指定出點，只用前 15 秒" }): TemplateShortStartResponse => ({
    text: { status: "AWAITING_BRIEF", shortId: SHORT_ID, window, framesPending: pending }, images: images.map(id => ({ id, data: Buffer.from(id), mimeType: "image/jpeg" as const })) });
  const request = { sourcePath: "videos/_INBOX/IMG_4022.MOV", genre: "travel", copy: { hook: "來看蝙蝠", payoff: "其實是來看水簾的" }, progressPath: join(tmpdir(), "p.json") };

  it("serves every frame page, then makes the Short in this process with the creator's words", async () => {
    const start = vi.fn<TemplateShortInAppEngine["start"]>(async raw => (raw as { framePage?: number }).framePage === 2 ? page(["kf-3"], []) : page(["kf-1", "kf-2"], ["kf-3"]));
    const make = vi.fn<TemplateShortInAppEngine["make"]>(async () => ({ schema: "editkin.template-short-result/v1", status: "REVIEW_REQUIRED", shortId: SHORT_ID,
      output: { path: `${templateShortRunDir(SHORT_ID)}/output.mp4`, sha256: "c".repeat(64) }, qa: { checks: [] } }));
    const progress: TemplateShortProgress[] = [];
    const result = await runTemplateShortInApp(request, {} as TemplateShortDeps, item => progress.push(item), { start, make });
    expect(start.mock.calls.map(call => call[0])).toEqual([{ schema: "editkin.template-short-start/v1", source: { path: "videos/_INBOX/IMG_4022.MOV" }, genre: "travel" },
      { schema: "editkin.template-short-start/v1", shortId: SHORT_ID, framePage: 2 }]);
    expect(start.mock.calls[0][2]).toEqual({ mode: "in_app", provider: "other" });
    const [brief, , options] = make.mock.calls[0];
    expect(options).toMatchObject({ mode: "in_app", provider: "other", wait: true });
    expect((brief as { seen: Array<{ kf: string }> }).seen.map(row => row.kf)).toEqual(["kf-1", "kf-2", "kf-3"]);
    expect(result).toMatchObject({ status: "REVIEW_REQUIRED", delivered: true, shortId: SHORT_ID, window: { seconds: 15, clamped: true },
      outputPath: `${templateShortRunDir(SHORT_ID)}/output.mp4` });
    expect(progress).toContainEqual({ step: 0, fraction: 0.6, shortId: SHORT_ID, runDir: templateShortRunDir(SHORT_ID) });
    expect(progress.at(-1)).toEqual({ step: 3, fraction: 1 });
  });

  it("returns a start refusal (defaults missing, window, rights) as a BLOCK result, and a make refusal with the run it belongs to", async () => {
    const refused = await runTemplateShortInApp(request, {} as TemplateShortDeps, () => undefined, {
      start: async () => { throw new TemplateShortBlockError("BLOCK_START", "找不到 .autopilot/template-short-defaults.json", "defaults"); }, make: vi.fn() });
    expect(refused).toEqual({ schema: "editkin.template-short-in-app/v1", status: "BLOCK_START", delivered: false, flags: [],
      block: { code: "BLOCK_START", detail: "找不到 .autopilot/template-short-defaults.json", field: "defaults" } });
    const glyph = await runTemplateShortInApp(request, {} as TemplateShortDeps, () => undefined, { start: async () => page(["kf-1"], []),
      make: async () => { throw new TemplateShortBlockError("BLOCK_COPY_GLYPH", "hook 第 3 字『・』字型不支援", "copy.hook"); } });
    expect(glyph).toMatchObject({ status: "BLOCK_COPY_GLYPH", shortId: SHORT_ID, runDir: templateShortRunDir(SHORT_ID), block: { field: "copy.hook" } });
    await expect(runTemplateShortInApp({ ...request, progressPath: "relative.json" }, {} as TemplateShortDeps, () => undefined)).rejects.toThrow();
    await expect(runTemplateShortInApp(request, {} as TemplateShortDeps, () => undefined, { start: async () => { throw new Error("disk exploded"); }, make: vi.fn() }))
      .rejects.toThrow("disk exploded");
  });
});

describe("the one-time defaults file", () => {
  const workspace = async () => { const root = join(scratch, "workspace"); await mkdir(join(root, ".autopilot"), { recursive: true }); return root; };
  const now = () => new Date("2026-10-10T06:30:00.000Z");

  it("is written once after the creator's click, readable by the same parser, and never replaced", async () => {
    const root = await workspace();
    const written = await writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: true, scope: "videos", scopeKind: "folder", brandMark: " 小明的旅行 " }, root, now);
    expect(written).toMatchObject({ schema: "editkin.template-short-defaults-write/v1", written: true, path: ".autopilot/template-short-defaults.json" });
    const { defaults, sha256 } = await readTemplateShortDefaults(root);
    expect(written.sha256).toBe(sha256);
    expect(defaults).toEqual({ schema: "editkin.template-short-defaults/v1", confirmedBy: "creator", confirmedAt: "2026-10-10T06:30:00.000Z", excludedSources: [],
      brandMark: "小明的旅行", rights: [{ scope: "videos", declaration: { provenance: "創作者在 Editkin 按下「是，這是我自己拍的素材」，確認「videos」資料夾裡的影片是自己拍的",
        rightsBasis: "創作者確認是自己拍攝的素材", distributionScope: "創作者自己的作品", license: "creator-owned" } }] });
    const before = await readFile(join(root, ".autopilot", "template-short-defaults.json"));
    expect(await writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: true, scope: "other", scopeKind: "folder" }, root, now))
      .toEqual({ schema: "editkin.template-short-defaults-write/v1", written: false, exists: true, path: ".autopilot/template-short-defaults.json" });
    expect(await readFile(join(root, ".autopilot", "template-short-defaults.json"))).toEqual(before);
    expect((await readdir(join(root, ".autopilot"))).sort()).toEqual(["template-short-defaults.json"]);
  });

  it("writes nothing without the click, with a brand the screen cannot show, or without a real .autopilot folder", async () => {
    const root = await workspace();
    await expect(writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: false, scope: "videos", scopeKind: "folder" }, root, now)).rejects.toThrow();
    await expect(writeTemplateShortDefaultsInApp({ scope: "videos", scopeKind: "folder" }, root, now)).rejects.toThrow();
    await expect(writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: true, scope: "videos", scopeKind: "folder", brandMark: "小・明" }, root, now)).rejects.toThrow();
    await expect(writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: true, scope: "../outside", scopeKind: "folder" }, root, now)).rejects.toThrow();
    expect(await readdir(join(root, ".autopilot"))).toEqual([]);
    await expect(writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: true, scope: "videos", scopeKind: "folder" }, join(scratch, "no-workspace-here"), now)).rejects.toThrow();
  });

  it("a loose video at the workspace root is declared by itself, and an empty brand is left out", async () => {
    const root = await workspace();
    await writeTemplateShortDefaultsInApp({ confirmedByCreatorClick: true, scope: "IMG_4022.MOV", scopeKind: "file", brandMark: "   " }, root, now);
    const { defaults } = await readTemplateShortDefaults(root);
    expect(defaults.brandMark).toBeUndefined();
    expect(defaults.rights[0]).toMatchObject({ scope: "IMG_4022.MOV", declaration: { provenance: expect.stringContaining("確認影片「IMG_4022.MOV」是自己拍的") } });
  });
});

describe("the one-shot child", () => {
  const runOnce = async (request: unknown, environment: NodeJS.ProcessEnv) => {
    const input = new PassThrough(), output = new PassThrough(), exit = vi.fn(), chunks: Buffer[] = [];
    output.on("data", chunk => chunks.push(Buffer.from(chunk)));
    input.end(JSON.stringify(request));
    await runTemplateShortOneShotProcess({ input, output, environment, exit, redirectConsole: false });
    return { envelope: JSON.parse(Buffer.concat(chunks).toString("utf8")), exit };
  };

  it("answers exactly one JSON envelope and exits with its status", async () => {
    const root = join(scratch, "workspace");
    await mkdir(join(root, ".autopilot"), { recursive: true });
    const ok = await runOnce({ command: "template_short_write_defaults", payload: { confirmedByCreatorClick: true, scope: "videos", scopeKind: "folder" } }, { EDITKIN_WORKSPACE: root });
    expect(ok.envelope).toMatchObject({ ok: true, result: { written: true } });
    expect(ok.exit).toHaveBeenCalledWith(0);
    const refused = await runOnce({ command: "render_project", payload: {} }, { EDITKIN_WORKSPACE: root });
    expect(refused.envelope).toEqual({ ok: false, error: "單次子程序不接受 render_project" });
    expect(refused.exit).toHaveBeenCalledWith(1);
    await expect(dispatchTemplateShortServiceCommand("template_short_write_defaults", {}, {})).rejects.toThrow("EDITKIN_WORKSPACE");
  });

  it("refuses a run in a program without the material-colour code identity, before creating anything", async () => {
    // service.mjs has no identity sidecar; only mcp.mjs --editkin-one-shot may run a template Short.
    const root = join(scratch, "no-identity");
    await mkdir(join(root, ".autopilot"), { recursive: true });
    vi.resetModules();
    vi.doMock("../application/materialColorCodeIdentity", () => ({ materialColorCodeIdentity: () => { throw new Error("bundle-identity-manifest-required"); } }));
    try {
      const bundled = await import("./templateShortService");
      const progressPath = join(root, "job", "progress.json");
      await expect(bundled.dispatchTemplateShortServiceCommand("template_short_run", { sourcePath: "videos/IMG_4022.MOV", genre: "travel",
        copy: { payoff: "其實是來看水簾的", hook: "來看蝙蝠" }, progressPath }, { EDITKIN_WORKSPACE: root })).rejects.toThrow(/素材色彩身份.*沒有建立任何檔案/);
      expect(await readdir(root)).toEqual([".autopilot"]);
      expect(await readdir(join(root, ".autopilot"))).toEqual([]);
    } finally {
      vi.doUnmock("../application/materialColorCodeIdentity");
      vi.resetModules();
    }
  });
});

// ---- End to end through the real orchestrator and batch engine (media, design bridge and render are fakes) -------------
const KEYFRAMES = [{ id: "kf-1", time: 0.1 }, { id: "kf-2", time: 5.5 }, { id: "kf-3", time: 10.9 }];
const identity = { schema: "editkin.video-autopilot.live-identity/v1", skill: { id: "video-autopilot", revision: TEMPLATE_SHORT_FIXTURE_SOURCE.revision,
  sha256: TEMPLATE_SHORT_FIXTURE_SOURCE.skillSha256, hardRuleCount: 10 }, workflow: { schema: "hao.video-autopilot.workflow-contract/v1", revision: 6,
  sha256: TEMPLATE_SHORT_FIXTURE_SOURCE.workflowContractSha256, planSchema: "hao.video-autopilot.edit-plan/v4", legacyPlanPolicy: "reject" },
  knowledge: { revision: TEMPLATE_SHORT_FIXTURE_SOURCE.knowledgeRevision, packSha256: TEMPLATE_SHORT_FIXTURE_SOURCE.knowledgeSha256,
    stableRulesSha256: TEMPLATE_SHORT_FIXTURE_SOURCE.stableRulesSha256 }, plugins: { sha256: TEMPLATE_SHORT_FIXTURE_SOURCE.pluginRegistrySha256 },
  bindingSha256: TEMPLATE_SHORT_FIXTURE_SOURCE.invocationBindingSha256 } as unknown as LiveAutopilotIdentity;

function endToEndDeps(root: string, recorded: { semantics?: MaterialSemanticsInput; applied: number }): TemplateShortDeps {
  let project: EditProject | undefined, hex = 0x3f9a1c;
  const frameBytes = 400_000, absolute = (relative: string) => resolve(root, relative);
  const frameData = (id: string) => Buffer.concat([Buffer.from(`jpeg:${id}:`), Buffer.alloc(frameBytes - 9 - id.length)]);
  const write = async (path: string, value: EditProject) => { await mkdir(parsePath(path).dir, { recursive: true }); await writeFile(path, JSON.stringify(value)); };
  const material = (): MaterialIntelligencePacket => {
    const clip = project!.tracks[0].clips[0];
    return { schema: "hao.editkin.material-intelligence/v1", materialId: "5".repeat(64),
      source: { assetId: clip.assetId, clipId: clip.id, sourceSha256: "4".repeat(64), sourceStart: 0, duration: clip.duration, kind: "video", width: 1080, height: 1920, fps: 30,
        hasAudio: true, color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv", interpretation: "auto" } },
      analysis: { scene: { state: "ready", cuts: [] }, transcript: { state: "not_applicable", cueCount: 0, cues: [] } },
      keyframes: KEYFRAMES.map(frame => ({ ...frame, sceneIndex: 0, sha256: sha(frameData(frame.id)), bytes: frameBytes, mimeType: "image/jpeg" as const,
        fileName: `frame-0${frame.id.slice(3)}.jpg` })), createdAt: "2026-10-10T00:00:00.000Z" } as MaterialIntelligencePacket;
  };
  return {
    root, now: () => new Date("2026-10-10T12:00:00+08:00"), randomHex: () => (hex++).toString(16).slice(-6),
    readDefaults: async () => {
      const defaults = { schema: "editkin.template-short-defaults/v1" as const, confirmedBy: "creator" as const, confirmedAt: "2026-10-10T00:00:00+08:00", excludedSources: [],
        rights: [{ scope: "videos", declaration: { provenance: "p", rightsBasis: "r", distributionScope: "d", license: "creator-owned" } }] };
      return { defaults, sha256: sha256Canonical(defaults) };
    },
    resolveSource: async path => ({ absolute: absolute(path), relative: path }),
    probe: async () => ({ duration: 11, width: 1080, height: 1920, hasVideo: true, hasAudio: true }),
    readReviewPolicy: async () => ({ policy: structuredClone(TEMPLATE_SHORT_FIXTURE_POLICY) }),
    createProject: async (projectPath, name) => {
      const created = templateShortFixtureProject(); created.name = name; created.assets = []; created.tracks[0].clips = []; created.revision = 1;
      await write(absolute(projectPath), created); return created;
    },
    prepareBootstrap: async input => {
      project = templateShortFixtureProject({ durationFrames: input.durationFrames });
      project.assets[0].id = input.assetId; project.assets[0].derivatives = { sourceSha256: "4".repeat(64), generatedAt: "2026-10-10T00:00:00.000Z" };
      project.tracks[0].clips[0] = { ...project.tracks[0].clips[0], id: input.clipId, assetId: input.assetId };
      return { commands: [], binding: { source: { sha256: "4".repeat(64), bytes: 12_504_006 } } };
    },
    applyBootstrap: async projectPath => { await write(absolute(projectPath), project!); return structuredClone(project!); },
    readProject: async () => structuredClone(project!),
    fileSha256: async path => sha(await readFile(path)),
    speechModelReady: async () => false,
    prepareMaterial: async () => ({ packet: material(), cacheHit: false }),
    readMaterial: async () => material(),
    readKeyframe: async (_material, frameId) => ({ frame: material().keyframes.find(frame => frame.id === frameId)!, data: frameData(frameId) }),
    recordSemantics: async input => { recorded.semantics = input;
      return { ...input, schema: "hao.editkin.material-semantics/v1", semanticReceiptSha256: sha256Canonical(input), createdAt: "2026-10-10T00:00:00.000Z" } as never; },
    readFactSources: async () => [],
    readIdentity: async () => identity,
    resolveSkill: async context => createEmptyEditkinSkillSelectionReceipt(TEMPLATE_SHORT_FIXTURE_SOURCE.pluginRegistrySha256, context),
    compileTemplate: async (_projectPath, input) => {
      let ordinal = 0;
      const prepared = await prepareReferenceMotionTemplateInstance(project!, { ...input, ...(input.templateId === "strike_reframe" ? { strikePresentation: "semantic_replace_v1" } : {}) },
        prefix => `${prefix}-${ordinal++}`, { prepareText: physicalText });
      const ids = new Set(prepared.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id] : []));
      return { ...prepared, editorialGraphics: prepared.editorialGraphics.filter(graphic => ids.has(graphic.id)),
        planDeclaration: { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: prepared.instance.id, mode: "create", commandIndexes: prepared.commands.map((_, index) => index) }] } } as never;
    },
    compileDesign: async request => ({ sourceSha256: "1".repeat(64), context: { learning: { budget: { estimated_tokens: 900, knowledge_rules_trimmed: 0, within_budget: true,
      knowledge_rules_selected: 1 }, knowledge_card: [{ id: "K-03fb82e28066" }] } }, recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: request.styleFamily! } } })) }),
    designIdentity: (brief, current) => ({ projectSha256: sha256Canonical(current), sourceSha256: (brief as { sourceSha256: string }).sourceSha256, briefSha256: sha256Canonical(brief) }),
    prepareBatch: async (batchPath, options) => {
      const raw = JSON.parse(await readFile(absolute(batchPath), "utf8")) as AutopilotBatchManifest;
      const manifest = { ...raw, items: raw.items.map(item => ({ ...item, projectPath: absolute(item.projectPath), planPath: absolute(item.planPath), outputPath: absolute(item.outputPath) })) };
      let committed = false;
      const runtime: AutopilotBatchRuntime = {
        validatePaths: async () => {},
        readPlan: async item => { const plan = parseAutopilotPlan(JSON.parse(await readFile(item.planPath, "utf8"))); return { plan, sha256: autopilotPlanSha256(plan) }; },
        audit: async () => ({ schema: "controlled-audit-receipt" }),
        apply: async item => { recorded.applied++; await writeFile(item.projectPath, JSON.stringify({ ...project!, revision: project!.revision + 1 })); committed = true;
          return { receiptFile: "short.receipt.committed.json" }; },
        reconcile: async () => (committed ? { receiptFile: "short.receipt.committed.json", state: "committed" } : undefined),
        render: async (_item, candidate) => { await writeFile(candidate, "rendered"); return {}; },
        verifyRender: async (item, candidate) => options.verifyRender(item, candidate, { project: project!,
          probe: { duration: 11, width: 1080, height: 1920, hasVideo: true, hasAudio: true } }),
      };
      return { manifest, statePath: `${absolute(batchPath)}.state.json`, runtime };
    },
    executeBatch: executeAutopilotBatch,
    readback: async () => ({ instanceStatus: "CURRENT", summary: {} }),
    freeBytes: async () => 500 * 1024 ** 3,
    tempDirectory: () => join(root, "temp"),
    lock: path => acquireProjectLock(path),
    writeLearningEvent: async () => "event.json",
    readExecutionAttribution: async () => ({}),
  };
}

describe("an in-app run through the real orchestrator", () => {
  beforeAll(() => warmTemplateShortFonts(), 60_000);

  it("creates its run folder where the desktop watches, records honest creator semantics, and delivers", async () => {
    const recorded: { semantics?: MaterialSemanticsInput; applied: number } = { applied: 0 };
    const progress: TemplateShortProgress[] = [];
    const result = await runTemplateShortInApp({ sourcePath: "videos/_INBOX/IMG_4022.MOV", genre: "travel", progressPath: join(scratch, "progress.json"),
      copy: { hook: "門票50元", payoff: "其實是來看水簾的" } }, endToEndDeps(scratch, recorded), item => progress.push(item));
    // A creator's own number is their claim (M10 creator_declared): it is not refused for lack of a transcript source.
    // strike_reframe × trip_pop_v1 is certified, so the first clean run of the pair is drawn for a spot check.
    expect(result.status).toBe("SPOT_CHECK_DUE");
    expect(result).toMatchObject({ delivered: true, shortId: expect.stringMatching(/^ts-20261010-img-4022-[a-f0-9]{6}$/),
      window: { start: 0, end: 11, seconds: 11, clamped: false } });
    const runDir = templateShortRunDir(result.shortId!);
    expect(result.runDir).toBe(runDir);
    expect(result.outputPath).toBe(`${runDir}/output.mp4`);
    expect(await readFile(join(scratch, runDir, "output.mp4"), "utf8")).toBe("rendered");
    expect(recorded.applied).toBe(1);
    expect(recorded.semantics?.segments.map(segment => segment.summary)).toEqual(KEYFRAMES.map(() => `創作者描述：${TEMPLATE_SHORT_IN_APP_SEEN_NOTE}`));
    const state = JSON.parse(await readFile(join(scratch, runDir, "short-run.json"), "utf8"));
    expect(state).toMatchObject({ mode: "in_app", provider: "other", framePages: 2 });
    const plan = JSON.parse(await readFile(join(scratch, runDir, "attempt-1", "plan.v4.json"), "utf8"));
    expect(plan.inference).toMatchObject({ provider: "other", modelId: "editkin-template-composer" });
    expect(progress.some(item => item.shortId === result.shortId && item.runDir === runDir)).toBe(true);
    expect(progress.map(item => item.step)).toContain(2);
    expect(progress.at(-1)).toEqual({ step: 3, fraction: 1 });
  }, 180_000);
});

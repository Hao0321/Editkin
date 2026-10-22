import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse as parsePath, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { createEmptyEditkinSkillSelectionReceipt } from "../plugins/skillPack";
import { executeAutopilotBatch, type AutopilotBatchManifest, type AutopilotBatchRuntime } from "./autopilotBatchExecution";
import { sha256Canonical, type LiveAutopilotIdentity } from "./autopilotInvocationIdentity";
import { autopilotPlanSha256, parseAutopilotPlan } from "./autopilotPlan";
import type { MaterialIntelligencePacket, MaterialSemanticsInput } from "./materialIntelligence";
import { acquireProjectLock } from "./projectFiles";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { TEMPLATE_SHORT_BRIEF_SCHEMA, TEMPLATE_SHORT_START_SCHEMA, TemplateShortBlockError, type TemplateShortCopy } from "./templateShortBrief";
import { TEMPLATE_SHORT_FIXTURE_COPY, TEMPLATE_SHORT_FIXTURE_POLICY, TEMPLATE_SHORT_FIXTURE_SOURCE, physicalText, templateShortFixtureProject,
  warmTemplateShortFonts } from "./templateShortFixtures";
import { AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER } from "./autopilotEvidence";
import { TemplateShortJobs, makeTemplateShort, readTemplateShortState, recordTemplateShortReview, startTemplateShort, templateShortDiskNeed, templateShortSlug,
  type TemplateShortDeps } from "./templateShortRun";
import type { TemplateShortDefaults } from "./templateShortWorkspace";

// M1 one-tool Short, wave 2 step 2.3. Every external system is a fake EXCEPT the batch engine (executeAutopilotBatch): its
// journal, locks, reconcile and hard-link promotion are the real production code the orchestrator drives.
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const blocked = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (error) { if (error instanceof TemplateShortBlockError) return error; throw error; }
  throw new Error("expected a TemplateShortBlockError");
};
const DEFAULTS: TemplateShortDefaults = { schema: "editkin.template-short-defaults/v1", confirmedBy: "creator", confirmedAt: "2026-10-09T00:00:00+08:00",
  rights: [{ scope: "videos", declaration: { provenance: "Hao0321 本人拍攝原始素材", rightsBasis: "創作者本人擁有完整著作權", distributionScope: "Hao0321 Studio 自有頻道", license: "creator-owned" } }],
  excludedSources: ["IMG_6172"], brandMark: "Hao0321 Studio" };
const SOURCE_PATH = "videos/_INBOX/直式/IMG_4022.MOV";
const KEYFRAMES = [{ id: "kf-1", time: 0.1 }, { id: "kf-2", time: 5.5 }, { id: "kf-3", time: 10.9 }];
const SEEN = [{ kf: "kf-1", note: "仰拍洞頂，樹根藤蔓垂落滴水" }, { kf: "kf-2", note: "洞頂滴水連成水簾，陽光照亮植物" }, { kf: "kf-3", note: "洞口全景，一位遊客在欄杆旁" }];
const identity = { schema: "editkin.video-autopilot.live-identity/v1", skill: { id: "video-autopilot", revision: TEMPLATE_SHORT_FIXTURE_SOURCE.revision,
  sha256: TEMPLATE_SHORT_FIXTURE_SOURCE.skillSha256, hardRuleCount: 10 }, workflow: { schema: "hao.video-autopilot.workflow-contract/v1", revision: 6,
  sha256: TEMPLATE_SHORT_FIXTURE_SOURCE.workflowContractSha256, planSchema: "hao.video-autopilot.edit-plan/v4", legacyPlanPolicy: "reject" },
  knowledge: { revision: TEMPLATE_SHORT_FIXTURE_SOURCE.knowledgeRevision, packSha256: TEMPLATE_SHORT_FIXTURE_SOURCE.knowledgeSha256,
    stableRulesSha256: TEMPLATE_SHORT_FIXTURE_SOURCE.stableRulesSha256 }, plugins: { sha256: TEMPLATE_SHORT_FIXTURE_SOURCE.pluginRegistrySha256 },
  bindingSha256: TEMPLATE_SHORT_FIXTURE_SOURCE.invocationBindingSha256 } as unknown as LiveAutopilotIdentity;

// The physical-glyph compile is the slow part; the same project and input always compile to the same packet.
const compiles = new Map<string, Promise<unknown>>();

interface Harness {
  root: string;
  deps: TemplateShortDeps;
  calls: string[];
  project?: EditProject;
  frameBytes: number;
  free: Map<string, number>;
  probeOverride?: Partial<{ hasAudio: boolean; duration: number }>;
  renderProbe: { hasAudio: boolean; width: number; height: number; duration?: number };
  audit: Array<{ receipt: object }>;
  applyReceived: object[];
  committed: boolean;
  applyMode: "ok" | "refuse" | "crash_after_commit";
  auditMode: "ok" | "refuse";
  compileOverride?: (packet: any) => any;
  designOverride?: (brief: any) => any;
  events: Array<Record<string, unknown>>;
}
let h: Harness;

function bootstrapProject(assetId: string, clipId: string, durationFrames: number): EditProject {
  const project = templateShortFixtureProject({ durationFrames });
  project.assets[0].id = assetId; project.assets[0].derivatives = { sourceSha256: "4".repeat(64), generatedAt: "2026-10-09T00:00:00.000Z" };
  project.tracks[0].clips[0] = { ...project.tracks[0].clips[0], id: clipId, assetId };
  return project;
}
function fakeMaterial(): MaterialIntelligencePacket {
  const project = h.project!, clip = project.tracks[0].clips[0];
  return { schema: "hao.editkin.material-intelligence/v1", materialId: "5".repeat(64),
    source: { assetId: clip.assetId, clipId: clip.id, sourceSha256: "4".repeat(64), sourceStart: 0, duration: clip.duration, kind: "video", width: 1080, height: 1920,
      fps: 30, hasAudio: h.probeOverride?.hasAudio ?? true, color: { primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv", interpretation: "auto" } },
    analysis: { scene: { state: "ready", cuts: [] }, transcript: { state: "not_applicable", cueCount: 0, cues: [] } },
    keyframes: KEYFRAMES.map(frame => ({ ...frame, sceneIndex: 0, sha256: sha(frameData(frame.id)), bytes: h.frameBytes, mimeType: "image/jpeg" as const, fileName: `frame-0${frame.id.slice(3)}.jpg` })),
    createdAt: "2026-10-09T00:00:00.000Z" } as MaterialIntelligencePacket;
}
const frameData = (id: string) => Buffer.concat([Buffer.from(`jpeg:${id}:`), Buffer.alloc(h.frameBytes - 9 - id.length)]);

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "editkin-template-short-"));
  let hex = 0x3f9a1c;
  const value: Harness = { root, calls: [], frameBytes: 300_000, free: new Map(), renderProbe: { hasAudio: true, width: 1080, height: 1920 },
    audit: [], applyReceived: [], committed: false, applyMode: "ok", auditMode: "ok", events: [], deps: undefined as unknown as TemplateShortDeps };
  const write = async (path: string, project: EditProject) => { await mkdir(parsePath(path).dir, { recursive: true }); await writeFile(path, JSON.stringify(project)); };
  const absolute = (relative: string) => resolve(root, relative);
  value.deps = {
    root, now: () => new Date("2026-10-09T12:00:00+08:00"), randomHex: () => (hex++).toString(16).slice(-6),
    readDefaults: async () => ({ defaults: structuredClone(DEFAULTS), sha256: sha256Canonical(DEFAULTS) }),
    resolveSource: async path => ({ absolute: absolute(path), relative: path }),
    probe: async () => ({ duration: h.probeOverride?.duration ?? 11.333, width: 1080, height: 1920, hasVideo: true, hasAudio: h.probeOverride?.hasAudio ?? true, colorTransfer: "arib-std-b67" }),
    readReviewPolicy: async () => ({ policy: structuredClone(TEMPLATE_SHORT_FIXTURE_POLICY) }),
    createProject: async (projectPath, name) => {
      h.calls.push("createProject");
      const project = templateShortFixtureProject(); project.name = name; project.assets = []; project.tracks[0].clips = []; project.revision = 1;
      await write(absolute(projectPath), project); return project;
    },
    prepareBootstrap: async input => { h.calls.push(`bootstrap:${input.sourceStartFrame}+${input.durationFrames}`);
      h.project = bootstrapProject(input.assetId, input.clipId, input.durationFrames); return { commands: [], binding: { source: { sha256: "4".repeat(64), bytes: 12_504_006 } } }; },
    applyBootstrap: async projectPath => { h.calls.push("applyBootstrap"); await write(absolute(projectPath), h.project!); return structuredClone(h.project!); },
    readProject: async () => structuredClone(h.project!),
    fileSha256: async path => sha(await readFile(path)),
    speechModelReady: async () => false,
    prepareMaterial: async request => { h.calls.push(`prepare:${request.maxKeyframes}:${request.includeTranscript}`); return { packet: fakeMaterial(), cacheHit: false }; },
    readMaterial: async () => fakeMaterial(),
    readKeyframe: async (_material, frameId) => ({ frame: fakeMaterial().keyframes.find(frame => frame.id === frameId)!, data: frameData(frameId) }),
    recordSemantics: async (input: MaterialSemanticsInput) => { h.calls.push("semantics");
      const packet = fakeMaterial();
      for (const segment of input.segments) if (segment.end <= segment.start || segment.end > packet.source.duration + 1e-6) throw new Error("語意片段時間範圍不合法");
      return { ...input, schema: "hao.editkin.material-semantics/v1", semanticReceiptSha256: sha256Canonical(input), createdAt: "2026-10-09T00:00:00.000Z" } as never; },
    readFactSources: async facts => facts.map(fact => ({ ref: fact.ref, content: "門票 50 元" })),
    readIdentity: async () => identity,
    resolveSkill: async context => createEmptyEditkinSkillSelectionReceipt(TEMPLATE_SHORT_FIXTURE_SOURCE.pluginRegistrySha256, context),
    compileTemplate: async (_projectPath, input) => {
      h.calls.push("compile");
      const project = h.project!, key = canonicalJson([project, input]);
      if (!compiles.has(key)) compiles.set(key, (async () => {
        let ordinal = 0;
        const prepared = await prepareReferenceMotionTemplateInstance(project, { ...input, ...(input.templateId === "strike_reframe" ? { strikePresentation: "semantic_replace_v1" } : {}) },
          prefix => `${prefix}-${ordinal++}`, { prepareText: physicalText });
        const ids = new Set(prepared.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic.id] : []));
        return { ...prepared, editorialGraphics: prepared.editorialGraphics.filter(graphic => ids.has(graphic.id)),
          planDeclaration: { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: prepared.instance.id, mode: "create", commandIndexes: prepared.commands.map((_, index) => index) }] } };
      })());
      const packet = structuredClone(await compiles.get(key)) as any;
      return h.compileOverride ? h.compileOverride(packet) : packet;
    },
    compileDesign: async request => {
      h.calls.push("design");
      const brief = { sourceSha256: "1".repeat(64), context: { learning: { budget: { estimated_tokens: 900, knowledge_rules_trimmed: 0, within_budget: true, knowledge_rules_selected: 1 },
        knowledge_card: [{ id: "K-03fb82e28066" }] } }, recipes: request.beats.map(beat => ({ beatId: beat.id, recipe: { route: { primary_family: request.styleFamily! } } })) };
      return h.designOverride ? h.designOverride(brief) : brief;
    },
    designIdentity: (brief, project) => ({ projectSha256: sha256Canonical(project), sourceSha256: (brief as { sourceSha256: string }).sourceSha256, briefSha256: sha256Canonical(brief) }),
    prepareBatch: async (batchPath, options) => {
      h.calls.push("prepareBatch");
      const raw = JSON.parse(await readFile(absolute(batchPath), "utf8")) as AutopilotBatchManifest;
      const manifest = { ...raw, items: raw.items.map(item => ({ ...item, projectPath: absolute(item.projectPath), planPath: absolute(item.planPath), outputPath: absolute(item.outputPath) })) };
      const runtime: AutopilotBatchRuntime = {
        validatePaths: async () => {},
        readPlan: async item => { const plan = parseAutopilotPlan(JSON.parse(await readFile(item.planPath, "utf8"))); return { plan, sha256: autopilotPlanSha256(plan) }; },
        audit: async () => { h.calls.push("audit"); if (h.auditMode === "refuse") throw new Error("Current design projectSha256 changed; read current sources and revise the plan");
          const receipt = { schema: "controlled-audit-receipt", n: h.audit.length }; h.audit.push({ receipt }); return receipt; },
        apply: async (item, _plan, audit) => {
          h.calls.push("apply"); h.applyReceived.push(audit as object);
          if (h.applyMode === "refuse") throw new Error("Autopilot apply refused: controlled drift");
          await writeFile(item.projectPath, JSON.stringify({ ...h.project!, revision: h.project!.revision + 1, name: "applied" }));
          h.committed = true;
          if (h.applyMode === "crash_after_commit") throw new Error("controlled crash after the atomic commit");
          return { receiptFile: "short.receipt.committed.json" };
        },
        reconcile: async () => (h.committed ? { receiptFile: "short.receipt.committed.json", state: "committed" } : undefined),
        render: async (_item, candidate) => { h.calls.push("render"); await writeFile(candidate, `rendered ${h.calls.length}`); return {}; },
        verifyRender: async (item, candidate) => {
          h.calls.push("verify");
          const probe = { duration: h.renderProbe.duration ?? 11, width: h.renderProbe.width, height: h.renderProbe.height, hasVideo: true, hasAudio: h.renderProbe.hasAudio };
          await options.verifyRender(item, candidate, { project: h.project!, probe });
        },
      };
      return { manifest, statePath: `${absolute(batchPath)}.state.json`, runtime };
    },
    executeBatch: executeAutopilotBatch,
    readback: async () => ({ instanceStatus: "CURRENT", summary: {} }),
    freeBytes: async path => h.free.get(parsePath(resolve(path)).root.toLowerCase()) ?? 500 * 1024 ** 3,
    tempDirectory: () => join(root, "temp"),
    lock: path => acquireProjectLock(path),
    writeLearningEvent: async (_projectPath, event) => { h.events.push(event); return `short.${h.events.length}.json`; },
    readExecutionAttribution: async () => ({ executionReceiptId: "receipt-1" }),
  };
  return value;
}
beforeAll(() => warmTemplateShortFonts(), 60_000);
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await rm(h.root, { recursive: true, force: true }); });

const MODE = { mode: "mcp", provider: "claude_code" } as const;
const start = (source: Record<string, unknown> = { path: SOURCE_PATH, in: 0, out: 11 }) =>
  startTemplateShort({ schema: TEMPLATE_SHORT_START_SCHEMA, source, genre: "travel" }, h.deps, MODE);
const brief = (shortId: string, overrides: { copy?: TemplateShortCopy; seen?: typeof SEEN } = {}) => ({ schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId,
  seen: overrides.seen ?? SEEN, copy: overrides.copy ?? TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, focus: { x: 0, y: 0.12, w: 1, h: 0.62 } });
const make = (shortId: string, overrides: Parameters<typeof brief>[1] = {}, jobs = new TemplateShortJobs()) =>
  makeTemplateShort(brief(shortId, overrides), h.deps, { ...MODE, wait: true, jobs });
const runDir = (shortId: string) => join(h.root, "videos/_AUTOPILOT/editkin-short", shortId.slice(3));
const state = async (shortId: string) => JSON.parse(await readFile(join(runDir(shortId), "short-run.json"), "utf8"));
const projectSha = async (shortId: string) => sha(await readFile(join(runDir(shortId), "short.editkin.json")));
const exists = async (path: string) => stat(path).then(() => true, () => false);

describe("start_template_short", () => {
  it("creates the run, bootstraps the window, prepares four keyframes without a transcript download and serves frames under 1 MB", async () => {
    h.frameBytes = 400_000;
    const first = await start();
    const shortId = String(first.text.shortId);
    expect(shortId).toMatch(/^ts-20261009-img-4022-[a-f0-9]{6}$/);
    expect(h.calls).toEqual(["createProject", "bootstrap:0+330", "applyBootstrap", "prepare:4:false"]);
    expect(first.images.map(image => image.id)).toEqual(["kf-1", "kf-2"]);
    expect(first.images.reduce((sum, image) => sum + image.data.length, 0)).toBeLessThanOrEqual(1_000_000);
    expect(first.text).toMatchObject({ status: "AWAITING_BRIEF", framesPending: ["kf-3"], next: { tool: "start_template_short", arguments: { shortId, framePage: 2 } } });
    expect(Buffer.byteLength(JSON.stringify(first.text))).toBeLessThanOrEqual(8 * 1024);
    const second = await startTemplateShort({ schema: TEMPLATE_SHORT_START_SCHEMA, shortId, framePage: 2 }, h.deps, MODE);
    expect(second.images.map(image => image.id)).toEqual(["kf-3"]);
    expect(second.text).toMatchObject({ framesPending: [], next: { tool: "make_template_short" } });
    const look = JSON.parse(await readFile(join(runDir(shortId), "look.json"), "utf8"));
    expect(look.frames.map((frame: { id: string; page: number }) => [frame.id, frame.page])).toEqual([["kf-1", 1], ["kf-2", 1], ["kf-3", 2]]);
    expect(await state(shortId)).toMatchObject({ phase: "awaiting_brief", status: "AWAITING_BRIEF", framePages: 2, window: { sourceStartFrame: 0, durationFrames: 330 } });
  });

  it("BLOCK_START: a window under 5 s, a source outside every owned scope and an excluded source; nothing is created", async () => {
    h.probeOverride = { duration: 3.2 };
    expect(await blocked(() => start({ path: SOURCE_PATH }))).toMatchObject({ code: "BLOCK_START", detail: "素材只有 3.2 秒，模板短片需要 5–15 秒" });
    h.probeOverride = undefined;
    expect(await blocked(() => start({ path: "outside/IMG_4022.MOV" }))).toMatchObject({ code: "BLOCK_START", field: "source.path" });
    expect(await blocked(() => start({ path: "videos/x/IMG_6172.MOV" }))).toMatchObject({ code: "BLOCK_START", field: "source.path" });
    expect(await exists(join(h.root, "videos/_AUTOPILOT/editkin-short"))).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("uses the first 15 s when no out point is given, and says so", async () => {
    h.probeOverride = { duration: 40 };
    const response = await start({ path: SOURCE_PATH });
    expect(response.text.window).toMatchObject({ frames: 450, note: "沒有指定出點，只用前 15 秒" });
  });
});

describe("make_template_short: the brief is checked before anything is written (§10 awaiting_brief)", () => {
  it("names the unviewed, uncited, glyph, number and slot problems and leaves the project at its bootstrap SHA", async () => {
    h.frameBytes = 400_000;
    const shortId = String((await start()).text.shortId), bootstrap = await projectSha(shortId);
    expect(await blocked(() => make(shortId))).toMatchObject({ code: "BLOCK_UNVIEWED_FRAME" }); // kf-3 not served yet
    await startTemplateShort({ schema: TEMPLATE_SHORT_START_SCHEMA, shortId, framePage: 2 }, h.deps, MODE);
    expect(await blocked(() => make(shortId, { seen: SEEN.slice(0, 2) }))).toMatchObject({ code: "BLOCK_UNVIEWED_FRAME", detail: "kf-3 已提供但 seen 沒有寫下看到什麼" });
    expect(await blocked(() => make(shortId, { copy: { ...TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, hook: "來看・蝙蝠" } })))
      .toMatchObject({ code: "BLOCK_COPY_GLYPH", detail: "hook 第 3 字『・』字型不支援" });
    expect(await blocked(() => make(shortId, { copy: { ...TEMPLATE_SHORT_FIXTURE_COPY.strike_reframe, proof: "門票50元" } })))
      .toMatchObject({ code: "BLOCK_UNSUPPORTED_NUMBER", detail: "proof 的『50』找不到來源" });
    expect(await blocked(() => make(shortId, { copy: { payoff: "其實是來看水簾" } }))).toMatchObject({ code: "BLOCK_BRIEF" });
    expect(await projectSha(shortId)).toBe(bootstrap);
    expect(await exists(join(runDir(shortId), "attempt-1"))).toBe(false);
    expect(h.calls.filter(call => ["semantics", "compile", "audit", "apply"].includes(call))).toEqual([]);
    expect((await readTemplateShortState(shortId, h.deps, new TemplateShortJobs())).block).toMatchObject({ code: "BLOCK_BRIEF" });
  });
});

describe("make_template_short: one process from the brief to the delivered mp4", () => {
  it("delivers through the real batch journal: audit receipt reaches apply by identity, the plan is sealed, QA and status recorded", async () => {
    const shortId = String((await start()).text.shortId);
    const result = await make(shortId);
    expect(h.calls.slice(h.calls.indexOf("semantics"))).toEqual(["semantics", "compile", "design", "prepareBatch", "audit", "apply", "render", "verify"]);
    expect(h.applyReceived).toHaveLength(1);
    expect(h.applyReceived[0]).toBe(h.audit[0].receipt);
    // Certified pair (wave 3): the first run of strike_reframe × trip_pop_v1 is drawn for a spot-check; any art flag makes
    // it NEEDS_FIX (still delivered).
    const failing = (result.qa as { checks: Array<{ pass: boolean }> }).checks.some(check => !check.pass);
    expect(result.status).toBe(failing ? "NEEDS_FIX" : "SPOT_CHECK_DUE");
    if (!failing) expect(result.spotCheck).toEqual({ drawn: true, reason: "first_run" });
    const run = runDir(shortId), output = join(run, "output.mp4");
    expect(result).toMatchObject({ family: "strike_reframe", designSystem: "trip_pop_v1", certification: "certified:2026-10-10T13:05:00+08:00",
      beats: [{ id: "hook", range: [0, 75] }, { id: "answer", range: [75, 330] }], output: { path: `videos/_AUTOPILOT/editkin-short/${shortId.slice(3)}/output.mp4`, frames: 330 },
      receipts: { executionReceiptFile: "short.receipt.committed.json" }, va: { workflowContractRevision: 6, recordedAs: ["execution-receipt/v1"] } });
    expect((result.output as { sha256: string }).sha256).toBe(sha(await readFile(output)));
    if (result.status === "NEEDS_FIX") expect((result.fixSeconds as number[]).length).toBeGreaterThan(0); // Hao: an art flag still delivers, with its seconds
    const plan = JSON.parse(await readFile(join(run, "attempt-1", "plan.v4.json"), "utf8"));
    expect(autopilotPlanSha256(parseAutopilotPlan(plan))).toBe((result.receipts as { planSha256: string }).planSha256);
    expect(plan.inference).toMatchObject({ provider: "claude_code", taskClass: "quality_critical", priority: "quality", modelId: "unreported", modelTier: "unknown" });
    expect(plan.editorial.narrative.beats.map((beat: { id: string; role: string }) => [beat.id, beat.role])).toEqual([["hook", "promise"], ["answer", "payoff"]]);
    const qa = JSON.parse(await readFile(join(run, "qa", "QA.json"), "utf8"));
    expect(qa).toMatchObject({ schema: "editkin.template-short-qa/v1", technical: { pass: true }, candidateSha256: sha(await readFile(output)) });
    const index = (await readFile(join(h.root, "videos/_AUTOPILOT/editkin-short/INDEX.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(index).toEqual([expect.objectContaining({ shortId, family: "strike_reframe", status: result.status, va: expect.objectContaining({ revision: 6 }) })]);
    expect(Buffer.byteLength(JSON.stringify(await readTemplateShortState(shortId, h.deps, new TemplateShortJobs())))).toBeLessThanOrEqual(20 * 1024);
  }, 120_000);

  it("Hao 2026-10-09: a render-time art FLAG still delivers as NEEDS_FIX with its seconds; a render-time technical failure never delivers", async () => {
    const flag = { id: "Q8_stall" as const, severity: "FLAG" as const, role: "tag", frames: [111], seconds: [3.7], detail: "tag 在動作中停了一格" };
    h.deps.analyzeRendered = async () => ({ technical: { pass: true, checks: [{ id: "R1_framecrc", pass: true, detail: "330 frames" }] }, flags: [flag] });
    const flagged = String((await start()).text.shortId), result = await make(flagged);
    expect(result).toMatchObject({ status: "NEEDS_FIX", output: { frames: 330 } });
    expect(result.fixSeconds).toEqual(expect.arrayContaining([3.7]));
    expect(await exists(join(runDir(flagged), "output.mp4"))).toBe(true);
    expect((result.current as { linked: boolean }).linked).toBe(true);
    h.deps.analyzeRendered = async () => ({ technical: { pass: false, checks: [{ id: "R1_framecrc", pass: false, detail: "329 frames, expected 330" }] }, flags: [] });
    const broken = String((await start()).text.shortId), failed = await make(broken);
    expect(failed).toMatchObject({ status: "RENDER_FAILED_PROJECT_APPLIED" });
    expect(String(failed.detail)).toMatch(/R1_framecrc 329 frames/);
    expect(await exists(join(runDir(broken), "output.mp4"))).toBe(false);
  }, 120_000);

  it("M115: the delivered mp4 atomically replaces _out/current.mp4 as a hard link, with history and no vN copies", async () => {
    const first = String((await start()).text.shortId);
    await make(first);
    const second = String((await start()).text.shortId);
    expect(second).not.toBe(first);
    const result = await make(second);
    const current = (result.current as { path: string; linked: boolean });
    expect(current).toMatchObject({ linked: true, path: expect.stringMatching(/^videos\/_AUTOPILOT\/editkin-short\/_videos\/img-4022-[a-f0-9]{6}\/_out\/current\.mp4$/) });
    const currentAbsolute = join(h.root, current.path), output = join(runDir(second), "output.mp4");
    expect((await stat(currentAbsolute, { bigint: true })).ino).toBe((await stat(output, { bigint: true })).ino);
    expect((await readdir(join(currentAbsolute, ".."))).filter(name => name.endsWith(".mp4"))).toEqual(["current.mp4"]);
    const history = (await readFile(join(currentAbsolute, "../../.autocut-history.jsonl"), "utf8")).trim().split("\n");
    expect(history.map(line => JSON.parse(line).shortId)).toEqual([first, second]);
  }, 120_000);
});

describe("make_template_short: failures (§10)", () => {
  it("brief_accepted: a compile refusal, a template without beats and a malformed design are BLOCKs on the bootstrap SHA; make again opens a new attempt", async () => {
    const shortId = String((await start()).text.shortId), bootstrap = await projectSha(shortId);
    h.compileOverride = () => { throw new Error("主標太長，影像區塊沒有足夠空間；請縮短文字"); };
    expect(await make(shortId)).toMatchObject({ status: "BLOCK_TEMPLATE", attempt: 1, block: { code: "BLOCK_TEMPLATE", detail: "主標太長，影像區塊沒有足夠空間；請縮短文字", projectUnchanged: true } });
    h.compileOverride = packet => ({ ...packet, beats: [] });
    expect(await make(shortId)).toMatchObject({ status: "BLOCK_TEMPLATE_BEATS", attempt: 2, block: { detail: "the template declares no beats", projectUnchanged: true } });
    h.compileOverride = undefined;
    h.designOverride = brief => ({ ...brief, recipes: brief.recipes.slice(0, 1) });
    expect(await make(shortId)).toMatchObject({ status: "BLOCK_COMPOSE", attempt: 3, block: { detail: "Design recipes differ from the request beats", projectUnchanged: true } });
    expect(await projectSha(shortId)).toBe(bootstrap);
    expect(h.calls).not.toContain("audit");
  }, 120_000);

  it("an attempt folder left by a crash before it was recorded is never reused: the next attempt takes the following number", async () => {
    const shortId = String((await start()).text.shortId);
    await mkdir(join(runDir(shortId), "attempt-1"), { recursive: true });
    await writeFile(join(runDir(shortId), "attempt-1", "brief.json"), "{}");
    h.compileOverride = () => { throw new Error("controlled compile refusal"); };
    expect(await make(shortId)).toMatchObject({ status: "BLOCK_TEMPLATE", attempt: 2 });
    expect(await readFile(join(runDir(shortId), "attempt-1", "brief.json"), "utf8")).toBe("{}");
  }, 120_000);

  it("composed: an audit refusal is BLOCK_AUDIT on the unchanged project; the next make seals attempt-2 and never rewrites attempt-1/plan.v4.json", async () => {
    const shortId = String((await start()).text.shortId), bootstrap = await projectSha(shortId);
    h.auditMode = "refuse";
    expect(await make(shortId)).toMatchObject({ status: "BLOCK_AUDIT", block: { code: "BLOCK_AUDIT", projectUnchanged: true } });
    const sealed = join(runDir(shortId), "attempt-1", "plan.v4.json"), sealedBytes = await readFile(sealed);
    expect(await projectSha(shortId)).toBe(bootstrap);
    expect(h.calls).not.toContain("apply");
    h.auditMode = "ok";
    const again = await make(shortId);
    expect(again).toMatchObject({ attempt: 2 });
    expect(["NEEDS_FIX", "SPOT_CHECK_DUE"]).toContain(again.status);
    expect(await readFile(sealed)).toEqual(sealedBytes);
    expect(await exists(join(runDir(shortId), "attempt-2", "plan.v4.json"))).toBe(true);
  }, 120_000);

  it("BLOCK_DISK refuses before audit when the render temp drive is too small, and resume continues once there is room", async () => {
    const shortId = String((await start()).text.shortId), bootstrap = await projectSha(shortId);
    h.free.set(parsePath(resolve(join(h.root, "temp"))).root.toLowerCase(), 512 * 1024 ** 2);
    const refused = await make(shortId);
    expect(refused).toMatchObject({ status: "BLOCK_DISK", block: { code: "BLOCK_DISK", projectUnchanged: true } });
    expect(String((refused.block as { detail: string }).detail)).toMatch(/只剩 0\.5 GB/);
    expect(h.calls).not.toContain("audit");
    expect(await projectSha(shortId)).toBe(bootstrap);
    h.free.clear();
    const resumed = await makeTemplateShort({ schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId, resume: true }, h.deps, { ...MODE, wait: true, jobs: new TemplateShortJobs() });
    expect(["NEEDS_FIX", "SPOT_CHECK_DUE"]).toContain(resumed.status);
    expect(resumed.attempt).toBe(1);
  }, 120_000);

  it("a technical render failure never delivers (no output.mp4); resume re-renders a new candidate on the applied project", async () => {
    const shortId = String((await start()).text.shortId);
    h.renderProbe.hasAudio = false;
    const failed = await make(shortId);
    expect(failed).toMatchObject({ status: "RENDER_FAILED_PROJECT_APPLIED" });
    expect(String(failed.detail)).toMatch(/R1 技術檢查失敗：R1_audio_stream/);
    expect(failed.output).toBeUndefined();
    expect(await exists(join(runDir(shortId), "output.mp4"))).toBe(false);
    expect(await exists(join(h.root, "videos/_AUTOPILOT/editkin-short/_videos"))).toBe(false);
    expect(await blocked(() => make(shortId))).toMatchObject({ code: "BLOCK_BRIEF" }); // applied: a new brief needs a new run
    h.renderProbe.hasAudio = true;
    const resumed = await makeTemplateShort({ schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId, resume: true }, h.deps, { ...MODE, wait: true, jobs: new TemplateShortJobs() });
    expect(["NEEDS_FIX", "SPOT_CHECK_DUE"]).toContain(resumed.status);
    expect(h.calls.filter(call => call === "apply")).toHaveLength(1);
    expect(h.calls.filter(call => call === "render")).toHaveLength(2);
    expect(await exists(join(runDir(shortId), "output.mp4"))).toBe(true);
  }, 120_000);

  it("an apply interrupted after its atomic commit is INTERRUPTED; resume reconciles the committed receipt without a second apply", async () => {
    const shortId = String((await start()).text.shortId);
    h.applyMode = "crash_after_commit";
    expect(await make(shortId)).toMatchObject({ status: "INTERRUPTED" });
    h.applyMode = "ok";
    const resumed = await makeTemplateShort({ schema: TEMPLATE_SHORT_BRIEF_SCHEMA, shortId, resume: true }, h.deps, { ...MODE, wait: true, jobs: new TemplateShortJobs() });
    expect(["NEEDS_FIX", "SPOT_CHECK_DUE"]).toContain(resumed.status);
    expect(h.calls.filter(call => call === "apply")).toHaveLength(1);
    expect(h.calls.filter(call => call === "audit")).toHaveLength(1);
  }, 120_000);

  it("with no live job, an attempt left executing reads INTERRUPTED (and RUNNING while another process holds the run lease)", async () => {
    const shortId = String((await start()).text.shortId);
    await make(shortId);
    const path = join(runDir(shortId), "short-run.json"), record = await state(shortId);
    record.attempts[0].phase = "executing"; delete record.attempts[0].finishedAt; record.status = "RUNNING";
    await writeFile(path, JSON.stringify(record));
    expect(await readTemplateShortState(shortId, h.deps, new TemplateShortJobs())).toMatchObject({ status: "INTERRUPTED" });
    const release = await acquireProjectLock(path);
    try { expect(await readTemplateShortState(shortId, h.deps, new TemplateShortJobs())).toMatchObject({ status: "RUNNING" }); }
    finally { await release(); }
  }, 120_000);
});

describe("make_template_short as a job", () => {
  it("returns a jobId at once; get_template_short reports RUNNING, then the final result", async () => {
    const shortId = String((await start()).text.shortId), jobs = new TemplateShortJobs();
    const started = await makeTemplateShort(brief(shortId), h.deps, { ...MODE, jobs });
    expect(started).toMatchObject({ status: "RUNNING", shortId, jobId: expect.any(String), pollAfterMs: 10_000 });
    expect(await readTemplateShortState(shortId, h.deps, jobs)).toMatchObject({ status: "RUNNING" });
    expect(await blocked(() => makeTemplateShort(brief(shortId), h.deps, { ...MODE, jobs }))).toMatchObject({ code: "BLOCK_BRIEF" }); // one live job per shortId
    await jobs.get(shortId)!.done;
    expect(["NEEDS_FIX", "SPOT_CHECK_DUE"]).toContain((await readTemplateShortState(shortId, h.deps, jobs)).status);
  }, 120_000);
});

describe("record_template_short_review (design §8)", () => {
  it("requires an evidence file inside review/, records the agent as agent and cuts the note by the shared outcome-note rule", async () => {
    const shortId = String((await start()).text.shortId);
    await make(shortId);
    const evidencePath = `videos/_AUTOPILOT/editkin-short/${shortId.slice(3)}/review/spot-check.json`;
    expect(await blocked(() => recordTemplateShortReview({ shortId, accepted: true, severeError: false, note: "ok", evidencePath }, h.deps)))
      .toMatchObject({ code: "BLOCK_BRIEF", field: "evidencePath" });
    expect(h.events).toEqual([]);
    await mkdir(join(runDir(shortId), "review"), { recursive: true });
    await writeFile(join(h.root, evidencePath), JSON.stringify({ frames: [0, 75, 330], verdict: "ok" }));
    const note = "看".repeat(1_500);
    const result = await recordTemplateShortReview({ shortId, accepted: true, severeError: false, note, evidencePath }, h.deps);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ schema: "hao.video-autopilot.learning-event/v1", checkpoint: "agent_review", platform: "archive",
      review: { reviewer: "agent", accepted: true, evidenceSha256: sha(await readFile(join(h.root, evidencePath))) }, attribution: { executionReceiptId: "receipt-1" } });
    // The product's one outcome-note rule (ROADMAP 1.13): at most 1,000 UTF-16 units, cut at a boundary, visibly marked.
    const stored = (h.events[0].review as { note: string }).note;
    expect(stored).toHaveLength(1_000);
    expect(stored.endsWith(AUTOPILOT_OUTCOME_NOTE_TRUNCATION_MARKER)).toBe(true);
    expect(result.review).toMatchObject({ accepted: true, eventFile: "short.1.json" });
  }, 120_000);

  it("refuses an agent review when the creator policy is human, and writes nothing for an undelivered run", async () => {
    const shortId = String((await start()).text.shortId);
    expect(await blocked(() => recordTemplateShortReview({ shortId, accepted: true, severeError: false, note: "", evidencePath: "x" }, h.deps)))
      .toMatchObject({ code: "BLOCK_BRIEF", detail: "還沒有交付的成片可以審查" });
    await make(shortId);
    h.deps.readReviewPolicy = async () => ({ policy: { mode: "human" } as never });
    expect(await blocked(() => recordTemplateShortReview({ shortId, accepted: true, severeError: false, note: "", evidencePath: "x" }, h.deps)))
      .toMatchObject({ code: "BLOCK_BRIEF" });
    expect(h.events).toEqual([]);
  }, 120_000);
});

describe("template short run: static guarantees", () => {
  it("the orchestrator never imports a project writer (applyCommand, writeProject, writeProjectFileAtomic)", async () => {
    const source = await readFile(resolve("src/application/templateShortRun.ts"), "utf8");
    const imports = source.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];
    expect(imports.length).toBeGreaterThan(5);
    for (const name of ["applyCommand", "writeProject", "writeProjectFileAtomic", "applyProjectCommands"]) {
      expect(imports.filter(statement => new RegExp(`\\b${name}\\b`).test(statement))).toEqual([]);
    }
    expect(source).not.toMatch(/\bapplyCommand\s*\(|\bwriteProject(?:FileAtomic)?\s*\(/);
  });

  it("slugs, disk need and the render deadline are bounded", () => {
    expect(templateShortSlug("videos/_INBOX/直式/IMG_4022.MOV")).toBe("img-4022");
    expect(templateShortSlug("videos/三民蝙蝠洞.mov")).toBe("clip");
    expect(templateShortSlug(`videos/${"a".repeat(40)}.mov`)).toHaveLength(24);
    const need = templateShortDiskNeed(450, 30);
    expect(need.tempBytes).toBe(1024 ** 3 + 450 * 2 * 1024 ** 2);
    expect(need.outputBytes).toBe(3 * Math.ceil(15 * 100e6 / 8) + 256 * 1024 ** 2);
  });
});

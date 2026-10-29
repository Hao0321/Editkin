import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { autopilotPlanSha256, compactAutopilotContract, parseAutopilotPlan } from "../application/autopilotPlan";
import { MATERIAL_INTELLIGENCE_SCHEMA, recordMaterialSemantics, type MaterialIntelligencePacket } from "../application/materialIntelligence";
import { LONGFORM_PLAN_SET_SCHEMA_V1 } from "../application/longformPlanSetV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { prepareLongformSidecarExportV1, exportLongformSidecarBundleV1 } from "../application/longformSidecarExportV1";
import { proofStillDefaultLayoutV1, proofStillEvidenceReferenceV1, type ProofStillV1 } from "../domain/proofStillV1";
import { motionGraphicPresets } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";

const controls = vi.hoisted(() => ({ driftIdentity: false, driftOnPending: false }));

// Controlled boundaries, as in autopilotTools.commitReceipt.test.ts: the live Skill identity, plugin discovery, Skill
// selection, workflow profile, design recompilation, auto colour and roto. Plan parsing, material evidence (packets,
// semantic receipts and full source hashing), the merge, receipts, atomic project/receipt I/O and rendering are real.
vi.mock("../application/autopilotInvocationIdentity", async importOriginal => {
  const actual = await importOriginal<typeof import("../application/autopilotInvocationIdentity")>();
  return { ...actual, readLiveAutopilotIdentity: async () => ({
    schema: "editkin.video-autopilot.live-identity/v1", bindingSha256: "f".repeat(64),
    engine: { schema: "editkin.engine-continuity-pin/v1", sha256: actual.sha256Canonical((await import("../motion/engineContinuity")).EDITKIN_ENGINE_CONTINUITY) },
    skill: { id: "video-autopilot", revision: 183, sha256: (controls.driftIdentity ? "9" : "a").repeat(64), hardRuleCount: 1 },
    workflow: { schema: "hao.video-autopilot.workflow-contract/v1", revision: 2, sha256: "b".repeat(64), planSchema: "hao.video-autopilot.edit-plan/v4", legacyPlanPolicy: "reject" },
    knowledge: { schema: "editkin.community-knowledge/v1", revision: 77, packSha256: "c".repeat(64), stableRulesSha256: "d".repeat(64), includedModuleCount: 1, stableRuleCount: 1 },
    plugins: { schema: "editkin.plugin-registry-identity/v1", sha256: "e".repeat(64), pluginCount: 0, diagnosticCount: 0 },
  }) };
});
vi.mock("../plugins/registry", async importOriginal => ({ ...await importOriginal<typeof import("../plugins/registry")>(),
  discoverInstalledPlugins: async () => ({ plugins: [], diagnostics: [] }),
  pluginRegistryIdentity: () => ({ sha256: "e".repeat(64) }),
  installedSkillPackCandidates: () => [],
  resolveSkillCapabilityQueries: () => ({ resolutions: [] }),
  verifyPluginAutomationApplications: () => [],
}));
vi.mock("../plugins/skillPack", async importOriginal => ({ ...await importOriginal<typeof import("../plugins/skillPack")>(),
  verifyEditkinSkillSelectionReceipt: (selection: unknown) => selection,
}));
vi.mock("../plugins/workflowProfileFileStore", async importOriginal => ({ ...await importOriginal<typeof import("../plugins/workflowProfileFileStore")>(),
  readHostWorkflowProfile: async () => ({ profile: {} }), assertSelectionUsesHostWorkflowProfile: () => ({}),
}));
vi.mock("./autopilotDesignTools", async importOriginal => ({ ...await importOriginal<typeof import("./autopilotDesignTools")>(),
  verifyAutopilotDesign: async () => ({ state: "CONTROLLED_DESIGN_BOUNDARY" }),
}));
vi.mock("../application/autoColorEvidence", async importOriginal => ({ ...await importOriginal<typeof import("../application/autoColorEvidence")>(),
  verifyAutoColorDecisions: async () => ({ state: "NOT_REQUIRED" }),
}));
vi.mock("../application/rotoKeyerAutopilot", async importOriginal => ({ ...await importOriginal<typeof import("../application/rotoKeyerAutopilot")>(),
  verifyRotoKeyerPlanForProject: async () => ({ state: "NOT_REQUIRED" }),
}));
// Real storage; only the pending-receipt write can flip the identity, i.e. between consume and the atomic commit.
vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, writePendingAutopilotReceipt: async (...args: Parameters<typeof actual.writePendingAutopilotReceipt>) => {
    const pending = await actual.writePendingAutopilotReceipt(...args);
    if (controls.driftOnPending) controls.driftIdentity = true;
    return pending;
  } };
});

import { applyLongformPlanSetV1, auditLongformPlanSetV1, registerLongformPlanSetToolsV1 } from "./longformPlanSetToolsV1";
import { applyAutopilotPlan, auditAutopilotPlan } from "./autopilotTools";
import { applyProjectCommands, createProjectFile, readAutopilotExecutionAttribution, readProject, writeProject } from "./storage";
import { renderAutopilotProject } from "./renderTools";
import {
  LONGFORM_AUDIT_RECEIPT_TTL_MS, AUTOPILOT_AUDIT_RECEIPT_TTL_MS, autopilotAuditReceiptSchema, createAcceptedLongformAuditReceipt, sha256Canonical, type LongformAuditReceipt,
} from "../application/autopilotInvocationIdentity";

const temp = useTempRoots();
const APP = resolve(import.meta.dirname, "../..");
const FFMPEG = join(APP, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), FFPROBE = join(APP, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_CACHE_ROOT", "HAO_FFMPEG_PATH", "HAO_FFPROBE_PATH", "EDITKIN_GPU_COMPOSITOR_PATH"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let workspace: string;
const projectPath = "set.editkin.json";

beforeEach(async () => {
  controls.driftIdentity = false; controls.driftOnPending = false;
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  workspace = await temp.create("ek-planset-");
  process.env.EDITKIN_WORKSPACE = workspace;
  process.env.EDITKIN_CACHE_ROOT = join(workspace, "cache");
  delete process.env.EDITKIN_GPU_COMPOSITOR_PATH;
});
afterEach(() => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

function body(result: { content: Array<{ text: string }> }) { return JSON.parse(result.content[0].text); }
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const AESTHETIC = createAutopilotV4Fixture().commands[0] as unknown as EditorCommand;
const clip = (id: string, assetId: string, trackId: string, timelineStart: number, duration: number) => ({ id, assetId, trackId, timelineStart, sourceStart: 0, duration, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
const caption = (id: string, start: number, duration: number, text = id): EditorCommand => ({ type: "add_caption", caption: { id, text, start, duration } });
const marker = (id: string, time: number): EditorCommand => ({ type: "add_director_marker", marker: { id, time, title: id, note: "", kind: "beat", status: "open", createdAt: "2026-10-15T00:00:00.000Z" } });

/**
 * A synthetic material packet and real semantic receipt for one saved clip (legacy, cache-less evidence as in
 * autopilotMaterialEvidence.test.ts). A still image gets the one viewed keyframe `kf-1` its semantics cite.
 */
async function material(project: EditProject, clipId: string) {
  const found = project.tracks.flatMap(track => track.clips).find(item => item.id === clipId)!;
  const asset = project.assets.find(item => item.id === found.assetId)!;
  const sourceSha256 = sha(await readFile(asset.uri));
  const materialId = sha(`material:${clipId}`);
  const cacheRoot = process.env.EDITKIN_CACHE_ROOT!;
  const still = asset.kind === "image";
  const packet: MaterialIntelligencePacket = {
    schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId,
    source: { assetId: asset.id, clipId, sourceSha256, sourceStart: found.sourceStart, duration: found.duration, kind: still ? "image" : "video", fps: project.fps, hasAudio: !still },
    analysis: { scene: { state: still ? "not_applicable" : "ready", cuts: [] }, transcript: still ? { state: "not_applicable", cueCount: 0, cues: [] }
      : { state: "ready", cueCount: 1, cues: [{ start: 0, end: 0.5, text: `Narration over ${clipId}` }] } },
    keyframes: still ? [{ id: "kf-1", time: 0, sceneIndex: 0, sha256: sourceSha256, bytes: 1, mimeType: "image/jpeg", fileName: "frame-01.jpg" }] : [],
    createdAt: new Date().toISOString(),
  };
  await mkdir(join(cacheRoot, "material-intelligence", materialId), { recursive: true });
  await writeFile(join(cacheRoot, "material-intelligence", materialId, "manifest.json"), JSON.stringify(packet));
  const semantic = await recordMaterialSemantics(cacheRoot, { materialId, sourceSha256, overallTopic: "Tutorial footage", contentType: "test", language: "en", people: [], locations: [],
    segments: [{ start: 0, end: 0.5, summary: still ? "Settings screenshot" : "Narrated step", subjects: [], actions: [], objects: [], importance: 0.5,
      evidenceFrameIds: still ? ["kf-1"] : [], transcriptCueIndexes: still ? [] : [0] }] });
  return { materialId, sourceSha256, assetId: asset.id, clipId, semanticReceiptSha256: semantic.semanticReceiptSha256 };
}

interface ChapterSpec {
  chapterId: string; range: { startFrame: number; endFrame: number }; receipts: Array<Awaited<ReturnType<typeof material>>>; commands: EditorCommand[];
  graphics?: unknown[];
}

/** One v4 chapter plan (three beats spread over its range) written compact to plans/<chapter>.v4.json; planPath is absolute, as VA seals it. */
async function writeChapter(spec: ChapterSpec) {
  const plan = structuredClone(createAutopilotV4Fixture()) as unknown as Record<string, any>;
  const { startFrame, endFrame } = spec.range, third = Math.floor((endFrame - startFrame) / 3);
  plan.editorial.narrative.beats = plan.editorial.narrative.beats.map((beat: object, index: number) => ({ ...beat,
    range: { startFrame: startFrame + index * third, endFrame: index === 2 ? endFrame : startFrame + (index + 1) * third } }));
  plan.editorial.transitions = plan.editorial.transitions.map((transition: object) => ({ ...transition, atFrame: startFrame + third }));
  plan.editorial.audio.impactFrames = [startFrame + 2 * third];
  plan.editorial.audio.breathFrames = [startFrame + third];
  plan.materialEvidence = { schema: MATERIAL_INTELLIGENCE_SCHEMA, receipts: spec.receipts };
  plan.commands = spec.commands;
  if (spec.graphics) plan.editorial.graphics = spec.graphics;
  const planPath = join(workspace, "plans", `${spec.chapterId}.v4.json`);
  await mkdir(join(workspace, "plans"), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan));
  return { chapterId: spec.chapterId, range: spec.range, planPath, planSha256: autopilotPlanSha256(parseAutopilotPlan(plan)) };
}

async function planSet(chapters: ChapterSpec[]) {
  const project = await readProject(projectPath);
  return { schema: LONGFORM_PLAN_SET_SCHEMA_V1, baseProject: { id: project.id, revision: project.revision, contentSha256: sha256Canonical(project) },
    chapters: await Promise.all(chapters.map(writeChapter)) };
}

/** Two 3-second chapters over one shared A-roll clip, each with its own b-roll clip, caption and chapter marker. */
async function twoChapterFixture() {
  await mkdir(join(workspace, "media"));
  for (const name of ["aroll", "broll-1", "broll-2"]) await writeFile(join(workspace, "media", `${name}.bin`), `Controlled source bytes for ${name}; hashed, never decoded`);
  await createProjectFile(projectPath, "Long-form set", 640, 360, 30, [
    { type: "import_asset", asset: { id: "aroll", name: "A-roll", kind: "video", uri: "media/aroll.bin", duration: 60 } },
    { type: "import_asset", asset: { id: "broll-1", name: "B-roll 1", kind: "video", uri: "media/broll-1.bin", duration: 10 } },
    { type: "import_asset", asset: { id: "broll-2", name: "B-roll 2", kind: "video", uri: "media/broll-2.bin", duration: 10 } },
    { type: "add_track", track: { id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clip("aroll-clip", "aroll", "video-main", 0, 6) },
    { type: "add_clip", clip: clip("broll-1-clip", "broll-1", "overlay", 0.5, 1) },
    { type: "add_clip", clip: clip("broll-2-clip", "broll-2", "overlay", 3.5, 1) },
  ]);
  const base = await readProject(projectPath);
  const [aroll, broll1, broll2] = await Promise.all(["aroll-clip", "broll-1-clip", "broll-2-clip"].map(id => material(base, id)));
  const specs: ChapterSpec[] = [
    { chapterId: "ch-1", range: { startFrame: 0, endFrame: 90 }, receipts: [aroll, broll1],
      commands: [AESTHETIC, { type: "rename_project", name: "Long-form set (applied)" }, marker("chapter-1", 0), caption("cap-1", 1, 1, "Chapter one"),
        { type: "set_clip_color", clipId: "broll-1-clip", patch: { saturation: 1.2 } }] },
    { chapterId: "ch-2", range: { startFrame: 90, endFrame: 180 }, receipts: [aroll, broll2],
      commands: [AESTHETIC, marker("chapter-2", 3), caption("cap-2", 4, 1, "Chapter two")] },
  ];
  return { base, specs, set: await planSet(specs) };
}

async function receiptFiles() {
  const names = await readdir(join(workspace, ".editkin-receipts")).catch(() => [] as string[]);
  return { committed: names.filter(name => name.endsWith(".committed.json")), pending: names.filter(name => name.endsWith(".pending.json")) };
}

// Real hashing and atomic disk I/O: allow for a loaded machine rather than the 5 s default.
describe("long-form plan set tools (E2/E4/E5)", { timeout: 60_000 }, () => {
  it("audits and applies a two-chapter set as exactly one revision and one committed receipt", async () => {
    const { base, set } = await twoChapterFixture();
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    expect(audit).toMatchObject({ status: "ACCEPTED", planSchema: LONGFORM_PLAN_SET_SCHEMA_V1, conflicts: [], commandCount: 8,
      coverage: { level: "longform_plan_set", legacy: false, chapterCount: 2, materialCount: 3 },
      // The shared A-roll material is hashed once; ch-2 reuses it.
      materialEvidence: { materialCount: 3, verifiedReceipts: 3, deduplicatedReceipts: 1 },
      merged: { chapterCount: 2, captions: 2, markers: 2 } });
    expect(audit.planSha256).toBe(audit.setSha256);
    expect(audit.chapters.map((chapter: { chapterId: string; materialEvidence: { deduplicatedReceipts: number } }) => [chapter.chapterId, chapter.materialEvidence.deduplicatedReceipts]))
      .toEqual([["ch-1", 0], ["ch-2", 1]]);
    expect(audit.auditReceipt).toMatchObject({ schema: "hao.video-autopilot.longform-audit-receipt/v1", planSchema: LONGFORM_PLAN_SET_SCHEMA_V1, setSha256: audit.setSha256,
      project: { id: base.id, revision: base.revision, contentSha256: sha256Canonical(base) } });
    // The public shape VA pins (LONGFORM_VA_RESULT §7): exact keys, the 4-field project, exact chapter rows and the checksum.
    expect(Object.keys(audit.auditReceipt).sort()).toEqual(["auditedAt", "chapters", "invocation", "issuerProof", "planSchema", "project", "receiptSha256", "schema", "setSha256", "status"]);
    expect(Object.keys(audit.auditReceipt.project).sort()).toEqual(["contentSha256", "id", "pathSha256", "revision"]);
    expect(audit.auditReceipt.chapters).toEqual(set.chapters.map((chapter, index) => ({ chapterId: chapter.chapterId, planSha256: chapter.planSha256,
      materialEvidenceSha256: sha256Canonical(JSON.parse(readFileSync(set.chapters[index].planPath, "utf8")).materialEvidence), range: chapter.range })));
    const { receiptSha256, issuerProof: _proof, ...publicFields } = audit.auditReceipt;
    expect(sha256Canonical(publicFields)).toBe(receiptSha256);
    expect(autopilotAuditReceiptSchema.safeParse(audit.auditReceipt).success).toBe(false);
    expect((await readProject(projectPath)).revision).toBe(base.revision);

    const applied = body(await applyLongformPlanSetV1(projectPath, set, audit.auditReceipt));
    expect(applied).toMatchObject({ status: "REVIEW_REQUIRED", appliedCommandCount: 8, receipt: { state: "committed", planSchema: LONGFORM_PLAN_SET_SCHEMA_V1, planSha256: audit.setSha256,
      projectRevisionBefore: base.revision, projectRevisionAfter: base.revision + 1, quality: { outputState: "review_required", certified: false },
      audit: { receiptSha256: audit.auditReceipt.receiptSha256 }, longformVerification: { merged: { captions: 2 } } } });
    expect(applied.receipt.longformSet).toEqual({ setSha256: audit.setSha256, baseProject: set.baseProject,
      chapters: set.chapters.map(chapter => ({ chapterId: chapter.chapterId, planSha256: chapter.planSha256 })) });
    const saved = await readProject(projectPath);
    expect(saved.revision).toBe(base.revision + 1);
    expect(saved.name).toBe("Long-form set (applied)");
    expect(saved.captions.map(item => [item.id, item.text])).toEqual([["cap-1", "Chapter one"], ["cap-2", "Chapter two"]]);
    expect(saved.director.markers.map(item => item.id)).toEqual(["chapter-1", "chapter-2"]);
    expect(saved.tracks.find(track => track.id === "overlay")!.clips.find(item => item.id === "broll-1-clip")!.color.saturation).toBe(1.2);
    expect(JSON.parse(await readFile(join(workspace, `${projectPath}.previous`), "utf8")).revision).toBe(base.revision);
    const files = await receiptFiles();
    expect(files).toEqual({ committed: [applied.receipt.receiptFile], pending: [] });
    const { receiptFile: _file, ...response } = applied.receipt;
    expect(JSON.parse(await readFile(join(workspace, ".editkin-receipts", applied.receipt.receiptFile), "utf8"))).toEqual(response);
    expect(Buffer.byteLength(await readFile(join(workspace, ".editkin-receipts", applied.receipt.receiptFile)))).toBeLessThan(1024 * 1024);
  });

  it("lets outcome attribution find the committed set receipt by the set SHA", async () => {
    const { set } = await twoChapterFixture();
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    const applied = body(await applyLongformPlanSetV1(projectPath, set, audit.auditReceipt));
    const attribution = await readAutopilotExecutionAttribution(projectPath, audit.setSha256);
    expect(attribution).toMatchObject({ executionReceiptId: applied.receipt.receiptId, executionReceiptFile: applied.receipt.receiptFile, selectedSkills: [] });
  });

  it("leaves the project untouched when the commit-time re-verification fails, and the receipt stays single-use", async () => {
    const { base, set } = await twoChapterFixture();
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    const before = await readFile(join(workspace, projectPath));
    controls.driftOnPending = true;
    await expect(applyLongformPlanSetV1(projectPath, set, audit.auditReceipt)).rejects.toThrow(/skillSha256/);
    expect((await readFile(join(workspace, projectPath))).equals(before)).toBe(true);
    expect((await receiptFiles()).committed).toEqual([]);
    controls.driftOnPending = false; controls.driftIdentity = false;
    // The audit receipt was consumed at the commit boundary: replay is refused, a fresh audit applies.
    await expect(applyLongformPlanSetV1(projectPath, set, audit.auditReceipt)).rejects.toThrow(/^LONGFORM_SET_RECEIPT_REPLAYED/);
    const again = body(await auditLongformPlanSetV1(projectPath, set));
    expect(body(await applyLongformPlanSetV1(projectPath, set, again.auditReceipt)).receipt.projectRevisionAfter).toBe(base.revision + 1);
    await expect(applyLongformPlanSetV1(projectPath, set, again.auditReceipt)).rejects.toThrow(/^LONGFORM_SET_BASE_PROJECT_MISMATCH/);
    expect((await receiptFiles()).committed).toHaveLength(1);
  });

  it("refuses expired, future, tampered, foreign and wrong-kind receipts without writing", async () => {
    const { set } = await twoChapterFixture();
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    const receipt = audit.auditReceipt as LongformAuditReceipt;
    expect(LONGFORM_AUDIT_RECEIPT_TTL_MS).toBe(AUTOPILOT_AUDIT_RECEIPT_TTL_MS);
    const before = await readFile(join(workspace, projectPath));
    const { receiptSha256: _r, issuerProof: _p, auditedAt: _a, schema: _s, status: _st, planSchema: _ps, ...binding } = receipt;
    const expired = createAcceptedLongformAuditReceipt({ ...binding, auditedAt: new Date(Date.now() - LONGFORM_AUDIT_RECEIPT_TTL_MS - 1_000).toISOString() });
    await expect(applyLongformPlanSetV1(projectPath, set, expired)).rejects.toThrow(/^LONGFORM_SET_RECEIPT_EXPIRED/);
    const future = createAcceptedLongformAuditReceipt({ ...binding, auditedAt: new Date(Date.now() + 60_000).toISOString() });
    await expect(applyLongformPlanSetV1(projectPath, set, future)).rejects.toThrow(/^LONGFORM_SET_RECEIPT_FUTURE/);
    const tampered = structuredClone(receipt); tampered.chapters[1].range.endFrame = 200;
    await expect(applyLongformPlanSetV1(projectPath, set, tampered)).rejects.toThrow(/^LONGFORM_SET_RECEIPT_TAMPERED/);
    const { receiptSha256: _x, issuerProof, ...forgedBase } = tampered;
    await expect(applyLongformPlanSetV1(projectPath, set, { ...forgedBase, receiptSha256: sha256Canonical(forgedBase), issuerProof })).rejects.toThrow(/^LONGFORM_SET_RECEIPT_FOREIGN/);
    const single = body(await auditAutopilotPlan(projectPath, JSON.parse(await readFile(set.chapters[0].planPath, "utf8"))));
    await expect(applyLongformPlanSetV1(projectPath, set, single.auditReceipt)).rejects.toThrow(/^LONGFORM_SET_RECEIPT_INVALID/);
    const other = await planSet([{ chapterId: "other-1", range: { startFrame: 0, endFrame: 90 }, receipts: (JSON.parse(await readFile(set.chapters[0].planPath, "utf8"))).materialEvidence.receipts,
      commands: [AESTHETIC, caption("other", 1, 1)] }]);
    await expect(applyLongformPlanSetV1(projectPath, other, receipt)).rejects.toThrow(/^LONGFORM_SET_RECEIPT_SET_MISMATCH/);
    expect((await readFile(join(workspace, projectPath))).equals(before)).toBe(true);
    // The original receipt is still unused and valid for its own set.
    expect(body(await applyLongformPlanSetV1(projectPath, set, receipt)).status).toBe("REVIEW_REQUIRED");
  });

  it("refuses a project that drifted after the set audit", async () => {
    const { base, set } = await twoChapterFixture();
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    await applyProjectCommands(projectPath, [{ type: "rename_project", name: "Edited by hand" }]);
    const drifted = await readFile(join(workspace, projectPath));
    await expect(applyLongformPlanSetV1(projectPath, set, audit.auditReceipt)).rejects.toThrow(/^LONGFORM_SET_BASE_PROJECT_MISMATCH/);
    expect((await readFile(join(workspace, projectPath))).equals(drifted)).toBe(true);
    expect((await readProject(projectPath)).revision).toBe(base.revision + 1);
    expect((await receiptFiles()).committed).toEqual([]);
  });

  it("answers refusals through the MCP tools with a stable code and the conflicting chapters", async () => {
    const { set } = await twoChapterFixture();
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
    registerLongformPlanSetToolsV1({ registerTool: (name: string, _schema: unknown, handler: never) => { handlers.set(name, handler); } } as never);
    expect([...handlers.keys()]).toEqual(["audit_longform_plan_set", "apply_longform_plan_set"]);
    const context = { mcpReq: { signal: new AbortController().signal } };
    const overlapping = structuredClone(set); overlapping.chapters[1].range.startFrame = 60;
    const refused = await handlers.get("audit_longform_plan_set")!({ projectPath, planSet: overlapping }, context);
    expect(refused.isError).toBe(true);
    expect(body(refused)).toMatchObject({ status: "BLOCK", code: "LONGFORM_SET_CHAPTER_ORDER", conflicts: [{ key: "range", chapterIds: ["ch-1", "ch-2"] }] });
    const audit = body(await handlers.get("audit_longform_plan_set")!({ projectPath, planSet: set }, context));
    expect(body(await handlers.get("apply_longform_plan_set")!({ projectPath, planSet: set, auditReceipt: audit.auditReceipt }, context)).status).toBe("REVIEW_REQUIRED");
    expect(body(await handlers.get("apply_longform_plan_set")!({ projectPath, planSet: set, auditReceipt: audit.auditReceipt }, context)))
      .toMatchObject({ status: "BLOCK", code: "LONGFORM_SET_BASE_PROJECT_MISMATCH" });
  });

  it("keeps the single-plan tools and their receipts separate from sets", async () => {
    const { base, set } = await twoChapterFixture();
    const plan = JSON.parse(await readFile(set.chapters[0].planPath, "utf8"));
    const setAudit = body(await auditLongformPlanSetV1(projectPath, set));
    await expect(applyAutopilotPlan(projectPath, plan, setAudit.auditReceipt)).rejects.toThrow();
    const audit = body(await auditAutopilotPlan(projectPath, plan));
    expect(audit).toMatchObject({ status: "ACCEPTED", auditReceipt: { schema: "hao.video-autopilot.audit-receipt/v1" } });
    const applied = body(await applyAutopilotPlan(projectPath, plan, audit.auditReceipt));
    expect(applied).toMatchObject({ status: "REVIEW_REQUIRED", receipt: { planSchema: "hao.video-autopilot.edit-plan/v4", projectRevisionAfter: base.revision + 1 } });
    expect(applied.receipt.longformSet).toBeUndefined();
    // A plan without proof stills keeps the exact single-plan response and receipt shapes: passing its commands to the
    // material verifier (design P5) adds no field and no key, in the same order as before the core extraction.
    expect(Object.keys(audit)).toEqual(["status", "planSha256", "planBytes", "coverage", "commandCount", "materialEvidence", "skillSelection",
      "pluginApplications", "rotoKeyer", "autoColor", "design", "auditReceipt"]);
    expect(audit.materialEvidence).toEqual({ receiptCount: 2, materialIds: plan.materialEvidence.receipts.map((receipt: { materialId: string }) => receipt.materialId) });
    expect(Object.keys(applied)).toEqual(["status", "appliedCommandCount", "receipt", "summary"]);
    expect(Object.keys(applied.receipt)).toEqual(["schema", "projectRevisionBefore", "planSchema", "planSha256", "source", "route", "budget", "inference",
      "materialEvidence", "skillSelection", "pluginApplications", "rotoKeyer", "autoColor", "design", "audit", "coverage", "quality", "createdAt",
      "receiptId", "projectRevisionAfter", "projectIdentityAfter", "committedAt", "state", "receiptFile"]);
    expect(applied.receipt.materialEvidence).toEqual(audit.materialEvidence);
    expect(compactAutopilotContract().longformPlanSet).toEqual({ schema: LONGFORM_PLAN_SET_SCHEMA_V1, auditTool: "audit_longform_plan_set", applyTool: "apply_longform_plan_set",
      renderTool: "render_project", maxChapters: 16, perPlan: { commands: 100, graphics: 64, materials: 32 }, captions: "project_track_burned_only_at_final_render", originalSources: "refused_v1" });
  });
});

/** Three 3-second chapters over one A-roll; a settings screenshot is a base clip in ch-1 and gets its own image receipt. */
async function proofStillFixture() {
  await mkdir(join(workspace, "media"));
  await writeFile(join(workspace, "media", "aroll.bin"), "Controlled A-roll bytes; hashed, never decoded");
  await writeFile(join(workspace, "media", "shot.png"), "Controlled screenshot bytes; hashed, never decoded");
  await createProjectFile(projectPath, "Proof set", 640, 360, 30, [
    { type: "import_asset", asset: { id: "aroll", name: "A-roll", kind: "video", uri: "media/aroll.bin", duration: 60 } },
    { type: "import_asset", asset: { id: "shot", name: "Settings screenshot", kind: "image", uri: "media/shot.png", duration: 10, width: 640, height: 360 } },
    { type: "add_track", track: { id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clip("aroll-clip", "aroll", "video-main", 0, 9) },
    { type: "add_clip", clip: clip("shot-clip", "shot", "overlay", 1, 1) },
  ]);
  const base = await readProject(projectPath);
  const [aroll, shot] = await Promise.all([material(base, "aroll-clip"), material(base, "shot-clip")]);
  const proof: ProofStillV1 = { schema: "editkin.proof-still/v1", sourceSha256: shot.sourceSha256, sourceWidth: 640, sourceHeight: 360,
    crop: { x: 0, y: 0, width: 640, height: 360 }, redactions: [], hold: "static", confirmation: { by: "agent", note: "Checked the settings screenshot; no personal data visible." } };
  // The proof_freeze event needs a bound native card (v4 parse); any registered non-vector card preset will do.
  const preset = motionGraphicPresets().find(item => item.seed.kind === "card" && !item.seed.vectorV2 && !item.seed.designV3
    && !item.id.startsWith("lower_third_") && !item.id.startsWith("editkin.lower-third/"))!;
  expect(preset).toBeDefined();
  const third = (receipts: ChapterSpec["receipts"]): ChapterSpec => ({ chapterId: "ch-3", range: { startFrame: 180, endFrame: 270 }, receipts,
    commands: [AESTHETIC, { type: "add_clip", clip: { ...clip("proof-3", "shot", "overlay", 7, 1), volume: 0, layout: proofStillDefaultLayoutV1(proof, { width: 640, height: 360 }), proofStill: proof } },
      { type: "add_motion_graphic", graphic: createMotionGraphic("proof-3", "card", "截圖證據", 7, 1, undefined, preset.seed) }],
    graphics: [{ id: "proof-3", presetId: preset.id, range: { startFrame: 210, endFrame: 240 }, kind: "proof_freeze", purpose: "proof", message: "截圖證據",
      evidenceRefs: [proofStillEvidenceReferenceV1(shot.materialId, shot.semanticReceiptSha256, "kf-1")] }] });
  const first = (receipts: ChapterSpec["receipts"]): ChapterSpec => ({ chapterId: "ch-1", range: { startFrame: 0, endFrame: 90 }, receipts, commands: [AESTHETIC, caption("cap-1", 0.2, 0.6)] });
  const second: ChapterSpec = { chapterId: "ch-2", range: { startFrame: 90, endFrame: 180 }, receipts: [aroll], commands: [AESTHETIC, caption("cap-2", 4, 1)] };
  return { aroll, shot, proof, first, second, third };
}

describe("long-form plan set proof stills (design P5 across a set)", { timeout: 60_000 }, () => {
  it("accepts a proof still in ch-3 backed by the image receipt first verified for ch-1", async () => {
    const f = await proofStillFixture();
    const set = await planSet([f.first([f.aroll, f.shot]), f.second, f.third([f.aroll, f.shot])]);
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    // ch-1 verifies both receipts; ch-2 and ch-3 reuse them, and the still is checked against the whole set.
    expect(audit.materialEvidence).toMatchObject({ materialCount: 2, verifiedReceipts: 2, deduplicatedReceipts: 3, proofStills: 1 });
    expect(audit.chapters[2].materialEvidence).toMatchObject({ verifiedReceipts: 0, deduplicatedReceipts: 2 });
    const applied = body(await applyLongformPlanSetV1(projectPath, set, audit.auditReceipt));
    expect(applied.receipt.materialEvidence).toMatchObject({ proofStills: 1 });
    const saved = await readProject(projectPath);
    expect(saved.tracks.find(track => track.id === "overlay")!.clips.find(item => item.id === "proof-3")?.proofStill).toEqual(f.proof);
  });

  it("refuses a proof still with no image receipt anywhere in the set, before anything is written", async () => {
    const f = await proofStillFixture();
    const before = await readFile(join(workspace, projectPath));
    const set = await planSet([f.first([f.aroll]), f.second, f.third([f.aroll])]);
    await expect(auditLongformPlanSetV1(projectPath, set)).rejects.toThrow(/^PROOF_STILL_EVIDENCE_MISSING: proof-3/);
    expect((await readFile(join(workspace, projectPath))).equals(before)).toBe(true);
    expect((await receiptFiles()).committed).toEqual([]);
  });
});

/** Decodes one RGB frame at `seconds`. */
function frame(path: string, seconds: number, width: number, height: number): Buffer {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(seconds), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { windowsHide: true, timeout: 60_000, maxBuffer: width * height * 3 + 1024 });
  if (result.status !== 0 || result.stdout.length !== width * height * 3) throw new Error(`frame decode failed at ${seconds}s: ${String(result.stderr)}`);
  return result.stdout;
}
/** Pixels that differ clearly between two decoded frames, and the rows they occupy (gapRows: empty rows inside the band). */
function differingPixels(left: Buffer, right: Buffer): { count: number; lowestRow: number; highestRow: number; gapRows: number } {
  let count = 0, lowestRow = Infinity, highestRow = -1;
  const rows = new Set<number>();
  for (let pixel = 0; pixel < left.length / 3; pixel += 1) {
    const offset = pixel * 3;
    if (Math.max(Math.abs(left[offset] - right[offset]), Math.abs(left[offset + 1] - right[offset + 1]), Math.abs(left[offset + 2] - right[offset + 2])) > 48) {
      count += 1; const row = Math.floor(pixel / 320); rows.add(row); lowestRow = Math.min(lowestRow, row); highestRow = Math.max(highestRow, row);
    }
  }
  return { count, lowestRow, highestRow, gapRows: count ? highestRow - lowestRow + 1 - rows.size : 0 };
}

describe("long-form plan set: 2 chapters → apply → render_project (real FFmpeg)", () => {
  it("burns each caption exactly once at final render, keeps project.captions editable and exports the SRT sidecar", async () => {
    process.env.HAO_FFMPEG_PATH = FFMPEG; process.env.HAO_FFPROBE_PATH = FFPROBE;
    await mkdir(join(workspace, "media"));
    const source = join(workspace, "media", "aroll.mp4");
    const made = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=0x1e3a5f:size=320x180:rate=30:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source],
      { windowsHide: true, timeout: 120_000 });
    expect(made.status, String(made.stderr)).toBe(0);
    await createProjectFile(projectPath, "Rendered set", 320, 180, 30, [
      { type: "import_asset", asset: { id: "aroll", name: "A-roll", kind: "video", uri: "media/aroll.mp4", duration: 6, width: 320, height: 180 } },
      { type: "add_clip", clip: clip("aroll-clip", "aroll", "video-main", 0, 6) },
    ]);
    const aroll = await material(await readProject(projectPath), "aroll-clip");
    const set = await planSet([
      { chapterId: "ch-1", range: { startFrame: 0, endFrame: 90 }, receipts: [aroll], commands: [AESTHETIC, marker("chapter-1", 0), caption("cap-1", 0.5, 1.5, "Chapter one")] },
      { chapterId: "ch-2", range: { startFrame: 90, endFrame: 180 }, receipts: [aroll], commands: [AESTHETIC, marker("chapter-2", 3), caption("cap-2", 3.5, 1.5, "Chapter two")] },
    ]);
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    expect(audit.materialEvidence).toMatchObject({ verifiedReceipts: 1, deduplicatedReceipts: 1 });
    const applied = body(await applyLongformPlanSetV1(projectPath, set, audit.auditReceipt));
    const saved = await readProject(projectPath);
    // No chapter was rendered into an intermediate: the only video asset is the original A-roll.
    expect(saved.assets.map(asset => asset.id)).toEqual(["aroll"]);
    expect(saved.captions.map(item => item.text)).toEqual(["Chapter one", "Chapter two"]);

    await mkdir(join(workspace, "out"));
    const render = body(await renderAutopilotProject(projectPath, "out/set.mp4", false));
    expect(render.status).toBe("GREEN");
    // The same project without its caption track: the source footage itself carries no text.
    await writeProject("baseline.editkin.json", { ...saved, captions: [] }, null);
    expect(body(await renderAutopilotProject("baseline.editkin.json", "out/baseline.mp4", false)).status).toBe("GREEN");
    const output = join(workspace, "out", "set.mp4"), baseline = join(workspace, "out", "baseline.mp4");
    const during = [1.2, 4.2].map(time => differingPixels(frame(output, time, 320, 180), frame(baseline, time, 320, 180)));
    const outside = [0.2, 2.6, 3.2, 5.6].map(time => differingPixels(frame(output, time, 320, 180), frame(baseline, time, 320, 180)).count);
    // Each caption is one contiguous block at the one subtitle position, and nothing is drawn outside its window.
    for (const caption of during) {
      expect(caption.count).toBeGreaterThan(30);
      expect(caption.gapRows).toBeLessThanOrEqual(3);
      expect([caption.lowestRow, caption.highestRow]).toEqual([during[0].lowestRow, during[0].highestRow]);
    }
    expect(outside).toEqual([0, 0, 0, 0]);

    const runtime = { workspaceRoot: workspace };
    await mkdir(join(workspace, "sidecars"));
    const prepared = await prepareLongformSidecarExportV1(runtime, { projectPath, expectedProjectRevision: saved.revision, chapterMarkerIds: ["chapter-1", "chapter-2"], captionMode: "original" });
    const exported = await exportLongformSidecarBundleV1(runtime, { projectPath, expectedProjectRevision: saved.revision, chapterMarkerIds: ["chapter-1", "chapter-2"], captionMode: "original",
      expectedProjectSha256: prepared.binding.projectSha256, expectedProjectFileSha256: prepared.binding.projectFileSha256, expectedBundleSha256: prepared.bundleSha256, outputDirectory: "sidecars/set" });
    expect(exported.status).toBe("COMPLETE");
    const srt = await readFile(join(workspace, "sidecars", "set", "captions.srt"), "utf8");
    expect([srt.split("Chapter one").length - 1, srt.split("Chapter two").length - 1, prepared.cueCount]).toEqual([1, 1, 2]);
    expect(await readFile(join(workspace, "sidecars", "set", "chapters.txt"), "utf8")).toBe("00:00:00.000 chapter-1\n00:00:03.000 chapter-2\n");

    // The captions stay ordinary project data: a later manual edit changes the text without any re-apply.
    const edited = await applyProjectCommands(projectPath, [{ type: "update_caption", captionId: "cap-2", patch: { text: "Chapter two, edited" } }]);
    expect(edited.captions.map(item => item.text)).toEqual(["Chapter one", "Chapter two, edited"]);
    expect(edited.revision).toBe(applied.receipt.projectRevisionAfter + 1);
  }, 300_000);
});

/** Opt-in (EDITKIN_PLANSET_TIMING=1): 16 chapters over a 10-minute timeline, one shared A-roll and two b-rolls per chapter. */
describe.runIf(process.env.EDITKIN_PLANSET_TIMING === "1")("long-form plan set: measured audit+apply on the 16-chapter fixture", () => {
  it("records audit and apply time with real source hashing", async () => {
    const arollMiB = Number(process.env.EDITKIN_PLANSET_AROLL_MIB ?? 600), brollMiB = Number(process.env.EDITKIN_PLANSET_BROLL_MIB ?? 8);
    const fps = 30, chapterFrames = 1125, chapters = 16; // 16 × 37.5 s = 600 s
    await mkdir(join(workspace, "media"));
    const fill = async (path: string, mib: number, seed: string) => {
      const block = Buffer.alloc(8 * 1024 * 1024, 0x5a); Buffer.from(seed).copy(block);
      const handle = await open(path, "w");
      try { for (let written = 0; written < mib; written += 8) await handle.write(block, 0, Math.min(8, mib - written) * 1024 * 1024); } finally { await handle.close(); }
    };
    await fill(join(workspace, "media", "aroll.bin"), arollMiB, "aroll");
    const setup: EditorCommand[] = [
      { type: "import_asset", asset: { id: "aroll", name: "Screen recording", kind: "video", uri: "media/aroll.bin", duration: 600 } },
      { type: "add_track", track: { id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } },
      { type: "add_clip", clip: clip("aroll-clip", "aroll", "video-main", 0, 600) },
    ];
    for (let chapter = 0; chapter < chapters; chapter += 1) for (const part of [0, 1]) {
      const id = `broll-${chapter}-${part}`;
      await fill(join(workspace, "media", `${id}.bin`), brollMiB, id);
      setup.push({ type: "import_asset", asset: { id, name: id, kind: "video", uri: `media/${id}.bin`, duration: 30 } },
        { type: "add_clip", clip: clip(`${id}-clip`, id, "overlay", chapter * 37.5 + 5 + part * 15, 5) });
    }
    await createProjectFile(projectPath, "Ten-minute tutorial", 1920, 1080, fps, setup);
    const base = await readProject(projectPath);
    const aroll = await material(base, "aroll-clip");
    const specs: ChapterSpec[] = [];
    for (let chapter = 0; chapter < chapters; chapter += 1) {
      const start = chapter * 37.5, own = await Promise.all([0, 1].map(part => material(base, `broll-${chapter}-${part}-clip`)));
      specs.push({ chapterId: `ch-${String(chapter + 1).padStart(2, "0")}`, range: { startFrame: chapter * chapterFrames, endFrame: (chapter + 1) * chapterFrames }, receipts: [aroll, ...own],
        commands: [AESTHETIC, marker(`chapter-${chapter + 1}`, start), ...Array.from({ length: 20 }, (_, index) => caption(`cap-${chapter + 1}-${index + 1}`, start + (30 + index * 54) / fps, 1.5, `Step ${chapter + 1}.${index + 1}`)),
          ...[0, 1].map(part => ({ type: "set_clip_color", clipId: `broll-${chapter}-${part}-clip`, patch: { contrast: 1.1 } }) as EditorCommand)] });
    }
    const set = await planSet(specs);
    const hashStarted = performance.now();
    sha(await readFile(join(workspace, "media", "aroll.bin")));
    const hashMs = performance.now() - hashStarted;
    const auditStarted = performance.now();
    const audit = body(await auditLongformPlanSetV1(projectPath, set));
    const auditMs = performance.now() - auditStarted;
    expect(audit.status).toBe("ACCEPTED");
    const applyStarted = performance.now();
    const applied = body(await applyLongformPlanSetV1(projectPath, set, audit.auditReceipt));
    const applyMs = performance.now() - applyStarted;
    expect(applied.status).toBe("REVIEW_REQUIRED");
    const result = { chapters, captions: (await readProject(projectPath)).captions.length, sourceMiB: arollMiB + chapters * 2 * brollMiB, arollMiB, brollMiB,
      materialEvidence: audit.materialEvidence, singleArollHashMs: Math.round(hashMs), auditMs: Math.round(auditMs), applyMs: Math.round(applyMs),
      auditPlusApplyMs: Math.round(auditMs + applyMs), receiptTtlMs: LONGFORM_AUDIT_RECEIPT_TTL_MS };
    console.log(`LONGFORM_PLANSET_TIMING ${JSON.stringify(result)}`);
    if (process.env.EDITKIN_PLANSET_TIMING_OUT) await writeFile(process.env.EDITKIN_PLANSET_TIMING_OUT, `${JSON.stringify(result, null, 2)}\n`);
    expect(applyMs).toBeLessThan(LONGFORM_AUDIT_RECEIPT_TTL_MS);
  }, 1_800_000);
});

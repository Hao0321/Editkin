import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CHROMA_KEY_PRESETS } from "../src/domain/chromaKey";
import { applyCommand } from "../src/domain/commands";
import { compileClipAlphaPlan } from "../src/domain/clipAlphaPlan";
import { createEmptyProject, findClip } from "../src/domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../src/domain/history";
import { projectSchema } from "../src/domain/schema";
import {
  DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM,
  type EditProject, type OpticalAlphaRefinementAggregate, type RotoMatteSequence, type TimelineClip,
} from "../src/domain/types";
import { createAutopilotV3Fixture, createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import { parseAutopilotPlan } from "../src/application/autopilotPlan";
import {
  assertAutopilotPlanSourceCurrent,
  autopilotPlanSourceFromIdentity,
  readLiveAutopilotIdentity,
} from "../src/application/autopilotInvocationIdentity";
import { recordMaterialSemantics, type MaterialIntelligencePacket } from "../src/application/materialIntelligence";
import {
  ROTO_KEYER_CAPABILITY_SCHEMA,
  ROTO_KEYER_CONTRACT_REVISION,
  ROTO_KEYER_DECISION_SCHEMA,
  ROTO_KEYER_EVIDENCE_SCHEMA,
  ROTO_KEYER_PLAN_SCHEMA,
  assertRotoKeyerPlanCommandBinding,
  buildRotoKeyerDecision,
  inspectRotoKeyerCapabilities,
  inspectRotoKeyerMaterialEvidence,
  prepareAutopilotAutoRoto,
  recordRotoKeyerEvidence,
  rotoKeyerSha256,
  sealRotoKeyerDecision,
  verifyRotoKeyerEvidence,
  verifyAutoRotoPreparation,
  verifyRotoKeyerPlanForProject,
  type RotoKeyerCapabilitySnapshot,
  type RotoKeyerEvidenceReceipt,
} from "../src/application/rotoKeyerAutopilot";
import { ROTO_KEYER_AUTOPILOT_TOOL_IDS } from "../src/mcp/rotoKeyerAutopilotTools";
import { applyClipAlphaPlanRgbaInPlace } from "../src/ui/alphaPlanPreview";
import { chromaKeyFfmpegFilter } from "../src/domain/chromaKey";
import { renderProject } from "../src/render/ffmpeg";

const appRoot = resolve(import.meta.dirname, "..");
const outputPath = join(appRoot, ".rd", "benchmarks", "editkin-roto-keyer-autopilot-integration", "report.json");
const canonicalSkillRoot = resolve(homedir(), ".codex", "skills", "video-autopilot");
const canonicalSkillPath = join(canonicalSkillRoot, "SKILL.md");
const canonicalWorkflowPath = join(canonicalSkillRoot, "workflow_contract.json");
const ffmpegPath = process.env.HAO_FFMPEG_PATH ?? join(appRoot, "vendor", "ffmpeg", "win32-x64", "ffmpeg.exe");
const ffprobePath = process.env.HAO_FFPROBE_PATH ?? join(appRoot, "vendor", "ffmpeg", "win32-x64", "ffprobe.exe");
const nativeCorePath = process.env.HAO_NATIVE_CORE_PATH ?? join(appRoot, "native", "bin", "win32-x64", "hao-core.exe");
const exec = promisify(execFile);
const MATERIAL_ID = "c".repeat(64);
const AUTO_MATERIAL_ID = "a".repeat(64);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileIdentity(path: string) {
  const bytes = await readFile(path);
  return { path: path.slice(appRoot.length + 1).replaceAll("\\", "/"), sha256: sha256(bytes), bytes: bytes.length };
}

async function canonicalInvocationFileIdentity(label: string, path: string) {
  const bytes = await readFile(path);
  return { path: `~/.codex/skills/video-autopilot/${label}`, sha256: sha256(bytes), bytes: bytes.length };
}

function parseCurrentProductPlan(input: unknown) {
  const plan = parseAutopilotPlan(input);
  if (plan.schema !== "hao.video-autopilot.edit-plan/v4") {
    throw new Error(`${plan.schema} is import-only; Roto/Keyer product integration requires v4`);
  }
  return plan;
}

function clip(id: string, assetId: string, trackId: string): TimelineClip {
  return {
    id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: .5, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
}

async function generateFormalFixture(directory: string): Promise<{ plate: string; background: string }> {
  const plate = join(directory, "green-plate.png");
  const background = join(directory, "background.png");
  await exec(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x00B140:s=64x32:d=0.1", "-vf", "drawbox=x=24:y=8:w=24:h=16:color=0xDC2319:t=fill", "-frames:v", "1", "-y", plate], { windowsHide: true, timeout: 60_000 });
  await exec(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x184A9C:s=64x32:d=0.1", "-frames:v", "1", "-y", background], { windowsHide: true, timeout: 60_000 });
  return { plate, background };
}

async function generateAutoRotoFixture(directory: string): Promise<string> {
  const source = join(directory, "ordinary-subject.mp4");
  await exec(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x777777:s=64x32:r=24:d=0.5",
    "-vf", "drawbox=x=22:y=6:w=20:h=22:color=0xDC2319:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", source,
  ], { windowsHide: true, timeout: 60_000 });
  return source;
}

function makeProject(plate: string, background: string, sourceSha256: string): EditProject {
  const project = createEmptyProject("Autopilot Roto Keyer", { id: "roto-keyer-autopilot", width: 64, height: 32, fps: 24 });
  project.assets.push(
    { id: "asset-background", name: "Background", kind: "image", uri: background, duration: .5, width: 64, height: 32 },
    { id: "asset-source-1", name: "Green plate", kind: "image", uri: plate, duration: .5, width: 64, height: 32, derivatives: { sourceSha256, generatedAt: "2026-08-28T00:00:00.000Z" } },
  );
  project.tracks[0].clips.push(clip("background-clip", "asset-background", project.tracks[0].id));
  project.tracks.push({ id: "key-layer", name: "Key layer", kind: "video", locked: false, muted: false, clips: [clip("clip-source-1", "asset-source-1", "key-layer")] });
  return project;
}

function makeAutoProject(source: string, background: string, sourceSha256: string): EditProject {
  const project = createEmptyProject("Autopilot Auto Roto", { id: "auto-roto-autopilot", width: 64, height: 32, fps: 24 });
  project.assets.push(
    { id: "asset-background", name: "Background", kind: "image", uri: background, duration: .5, width: 64, height: 32 },
    { id: "asset-source-1", name: "Ordinary subject", kind: "video", uri: source, duration: .5, width: 64, height: 32, derivatives: { sourceSha256, generatedAt: "2026-08-28T00:00:00.000Z" } },
  );
  project.tracks[0].clips.push(clip("background-clip", "asset-background", project.tracks[0].id));
  project.tracks.push({ id: "subject-layer", name: "Subject", kind: "video", locked: false, muted: false, clips: [clip("clip-source-1", "asset-source-1", "subject-layer")] });
  return project;
}

async function prepareMaterialCache(cacheRoot: string, sourceSha256: string): Promise<string> {
  const directory = join(cacheRoot, "material-intelligence", MATERIAL_ID);
  await mkdir(directory, { recursive: true });
  const packet: MaterialIntelligencePacket = {
    schema: "hao.editkin.material-intelligence/v1",
    materialId: MATERIAL_ID,
    source: { assetId: "asset-source-1", clipId: "clip-source-1", sourceSha256, sourceStart: 0, duration: .5, kind: "image", width: 64, height: 32, fps: 24, hasAudio: false },
    analysis: { scene: { state: "not_applicable", cuts: [] }, transcript: { state: "not_applicable", cueCount: 0, cues: [] } },
    keyframes: [
      { id: "kf-1", time: 0, sceneIndex: 0, sha256: "1".repeat(64), bytes: 100, mimeType: "image/jpeg", fileName: "frame-01.jpg" },
      { id: "kf-2", time: .49, sceneIndex: 0, sha256: "2".repeat(64), bytes: 100, mimeType: "image/jpeg", fileName: "frame-02.jpg" },
    ],
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  const semantics = await recordMaterialSemantics(cacheRoot, {
    materialId: MATERIAL_ID, sourceSha256, overallTopic: "人物站在綠幕前", contentType: "studio plate", language: "none",
    people: ["subject"], locations: ["studio"],
    segments: [{ start: 0, end: .5, summary: "主體前後皆位於同一綠幕", subjects: ["subject"], actions: [], objects: ["green screen"], importance: 1, evidenceFrameIds: ["kf-1", "kf-2"], transcriptCueIndexes: [] }],
  });
  return semantics.semanticReceiptSha256;
}

async function greenEvidence(cacheRoot: string, semanticReceiptSha256: string, sourceSha256: string): Promise<RotoKeyerEvidenceReceipt> {
  return recordRotoKeyerEvidence(cacheRoot, {
    materialId: MATERIAL_ID, sourceSha256, semanticReceiptSha256,
    assetId: "asset-source-1", clipId: "clip-source-1",
    observation: {
      subjectPresence: "single", screen: "green", screenCoverage: .68, edgeClass: "solid", confidence: .96,
      evidenceFrameIds: ["kf-1", "kf-2"], note: "兩張 hash-bound 關鍵幀都顯示明確、連續且無歧義的綠幕。",
    },
  });
}

async function prepareAutoMaterialEvidence(cacheRoot: string, sourceSha256: string): Promise<RotoKeyerEvidenceReceipt> {
  const directory = join(cacheRoot, "material-intelligence", AUTO_MATERIAL_ID);
  await mkdir(directory, { recursive: true });
  const packet: MaterialIntelligencePacket = {
    schema: "hao.editkin.material-intelligence/v1", materialId: AUTO_MATERIAL_ID,
    source: { assetId: "asset-source-1", clipId: "clip-source-1", sourceSha256, sourceStart: 0, duration: .5, kind: "video", width: 64, height: 32, fps: 24, hasAudio: false },
    analysis: { scene: { state: "ready", engine: "fixture", cuts: [] }, transcript: { state: "not_applicable", cueCount: 0, cues: [] } },
    keyframes: [
      { id: "kf-1", time: 0, sceneIndex: 0, sha256: "3".repeat(64), bytes: 100, mimeType: "image/jpeg", fileName: "frame-01.jpg" },
      { id: "kf-2", time: .49, sceneIndex: 0, sha256: "4".repeat(64), bytes: 100, mimeType: "image/jpeg", fileName: "frame-02.jpg" },
    ], createdAt: "2026-08-28T00:00:00.000Z",
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  const semantic = await recordMaterialSemantics(cacheRoot, {
    materialId: AUTO_MATERIAL_ID, sourceSha256, overallTopic: "一般背景前的單一主體", contentType: "ordinary subject", language: "none", people: ["subject"], locations: ["room"],
    segments: [{ start: 0, end: .5, summary: "非色幕背景上的單一主體", subjects: ["subject"], actions: [], objects: [], importance: 1, evidenceFrameIds: ["kf-1", "kf-2"], transcriptCueIndexes: [] }],
  });
  return recordRotoKeyerEvidence(cacheRoot, {
    materialId: AUTO_MATERIAL_ID, sourceSha256, semanticReceiptSha256: semantic.semanticReceiptSha256, assetId: "asset-source-1", clipId: "clip-source-1",
    observation: { subjectPresence: "single", screen: "none", screenCoverage: 0, edgeClass: "translucent", confidence: .93, evidenceFrameIds: ["kf-1", "kf-2"], note: "兩張關鍵幀皆為一般灰色背景，主體邊緣需要 fractional alpha。" },
  });
}

function syntheticEvidence(screen: "none" | "blue" | "ambiguous", sourceSha256: string, confidence = .9): RotoKeyerEvidenceReceipt {
  const base = {
    schema: ROTO_KEYER_EVIDENCE_SCHEMA,
    materialId: MATERIAL_ID, sourceSha256, semanticReceiptSha256: "e".repeat(64), assetId: "asset-source-1", clipId: "clip-source-1",
    observation: {
      subjectPresence: "single" as const, screen, screenCoverage: screen === "none" ? 0 : .6,
      edgeClass: "translucent" as const, confidence, evidenceFrameIds: ["kf-1"],
      ...(screen === "ambiguous" || confidence < .75 ? { uncertainty: "無法證明單一幕色" } : {}),
      note: "current-schema mutation fixture",
    },
    evidenceFrames: [{ id: "kf-1", sha256: "1".repeat(64), time: 0 }], createdAt: "2026-08-28T00:00:00.000Z",
  };
  return { ...base, receiptSha256: rotoKeyerSha256(base) };
}

function fixtureCapability(snapshotSha256: string): RotoKeyerCapabilitySnapshot {
  return {
    schema: ROTO_KEYER_CAPABILITY_SCHEMA, contractRevision: ROTO_KEYER_CONTRACT_REVISION,
    routes: [
      { route: "no_op", engine: "none", available: true, productEligible: true, qualityState: "not_applicable", rights: "not_applicable", reasonCode: "explicit-no-op" },
      { route: "manual_mask", engine: "editkin-editgraph-manual-mask/v1", available: true, productEligible: true, qualityState: "editable", rights: "editkin-owned", reasonCode: "manual" },
      { route: "self_authored_auto_roto", engine: "editkin-native-color-temporal-roto/v1", available: true, productEligible: true, qualityState: "diagnostic", rights: "editkin-owned", reasonCode: "fixture" },
      { route: "self_authored_screen_keyer", engine: "editkin-chroma-distance-keyer/v1", available: true, productEligible: true, qualityState: "unmeasured", rights: "editkin-owned", reasonCode: "keyer" },
    ], runtime: {
      nativeCore: { available: true, productAttested: true, reasonCode: "product-manifest-attested" },
      ffmpeg: { available: true, productAttested: true, reasonCode: "product-manifest-attested" },
    },
    productEngineAdmission: {
      mode: "closed_world_route_enum",
      editkinOwnedOnly: true,
      externalModelPacksAllowed: false,
      researchRoutesAllowed: false,
    },
    snapshotSha256,
  };
}

function opticalAlpha(frameCount: number): OpticalAlphaRefinementAggregate {
  return {
    schema: "editkin.optical-alpha-refinement-aggregate/v1", engine: "editkin-self-authored-optical-alpha-refiner/v1",
    appliedFrames: frameCount, radius: 4, backgroundThreshold: .1, foregroundThreshold: .9, coarseWeight: .3,
    temporalStability: .2, temporalGate: .4, changedPixels: 10, fractionalPixels: 20, solvedPixels: 10, meanSolveConfidence: .8,
  };
}

function autoRotoPlanFixture(project: EditProject, evidence: RotoKeyerEvidenceReceipt) {
  const sequence: RotoMatteSequence = {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1", width: 64, height: 32,
    analysisFps: 12, frameCount: 2, sequenceUri: "fixture-alpha8.raw", sequenceSha256: "4".repeat(64), sequenceBytes: 4096,
    manifestUri: "fixture-manifest.json", framePreviewUris: ["fixture-0.png", "fixture-1.png"], meanBoundaryChatter: .01,
    alphaRefinement: opticalAlpha(2), frozen: true, qualityState: "diagnostic",
  };
  const command = {
    type: "add_clip_mask" as const, clipId: evidence.clipId,
    mask: {
      id: "autopilot-roto", name: "Autopilot Auto Roto", kind: "subject" as const, mode: "add" as const, enabled: true,
      inverted: false, opacity: 1, feather: 0, expansion: 0,
      path: [{ id: "p1", x: .2, y: .1 }, { id: "p2", x: .8, y: .1 }, { id: "p3", x: .8, y: .9 }, { id: "p4", x: .2, y: .9 }],
      keyframes: [], refine: { edgeShift: 0, contrast: .7, chatterReduction: .4 },
      matteSequence: sequence, frozenRange: { fromFrame: 0, toFrame: 12 },
    },
  };
  const decision = sealRotoKeyerDecision({
    schema: ROTO_KEYER_DECISION_SCHEMA, projectId: project.id, projectRevision: project.revision,
    materialId: evidence.materialId, sourceSha256: evidence.sourceSha256, semanticReceiptSha256: evidence.semanticReceiptSha256,
    evidenceReceiptSha256: evidence.receiptSha256, capabilitySnapshotSha256: "9".repeat(64), assetId: evidence.assetId, clipId: evidence.clipId,
    route: "self_authored_auto_roto", engine: "editkin-native-color-temporal-roto/v1",
    commandSha256: rotoKeyerSha256(command), preparationReceiptSha256: "7".repeat(64), autoRotoRouteReceiptSha256: "8".repeat(64),
    budget: { decisionContextTokens: 120, maxSourceDurationSeconds: 1, maxAnalyzedFrames: 12, maxMatteBytes: 8192, actualSourceDurationSeconds: .5, actualAnalyzedFrames: 2, actualMatteBytes: 4096 },
    humanReview: { required: true, status: "pending", reviewTarget: "preview_formal_render_and_reopen" },
  });
  return { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [decision], command };
}

async function sampleRgb(path: string, x: number, y: number): Promise<number[]> {
  const target = `${path}.${x}-${y}.rgb`;
  await exec(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", "0.1", "-i", path, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "-y", target], { windowsHide: true, timeout: 60_000 });
  return [...await readFile(target)].slice(0, 3);
}

async function run() {
  const workspace = await mkdtemp(join(tmpdir(), "editkin-roto-keyer-autopilot-"));
  const cacheRoot = join(workspace, "cache");
  const mutations: Array<{ id: string; rejected: boolean }> = [];
  const reject = async (id: string, action: () => unknown | Promise<unknown>) => {
    let rejected = false;
    try { await action(); } catch { rejected = true; }
    mutations.push({ id, rejected });
    assert.equal(rejected, true, `negative mutation escaped: ${id}`);
  };
  try {
    const liveIdentity = await readLiveAutopilotIdentity({ skillPath: canonicalSkillPath });
    const livePlanSource = autopilotPlanSourceFromIdentity(liveIdentity);
    assert.equal(liveIdentity.skill.id, "video-autopilot");
    assert.ok(liveIdentity.skill.hardRuleCount > 0, "canonical Video Autopilot Skill has no hard rules");
    assert.equal(liveIdentity.workflow.planSchema, "hao.video-autopilot.edit-plan/v4");
    assert.equal(liveIdentity.workflow.legacyPlanPolicy, "reject");
    assert.equal(liveIdentity.knowledge.includedModuleCount, 37);
    assert.equal(liveIdentity.knowledge.stableRuleCount, 77);

    const { plate, background } = await generateFormalFixture(workspace);
    const ordinarySource = await generateAutoRotoFixture(workspace);
    const sourceSha256 = sha256(await readFile(plate));
    const project = makeProject(plate, background, sourceSha256);
    const semanticReceiptSha256 = await prepareMaterialCache(cacheRoot, sourceSha256);
    const evidence = await greenEvidence(cacheRoot, semanticReceiptSha256, sourceSha256);
    const material = await inspectRotoKeyerMaterialEvidence(project, cacheRoot, MATERIAL_ID, semanticReceiptSha256);
    assert.equal((material.clipState as { clipId: string }).clipId, evidence.clipId);
    const runtime = { ffmpegPath, nativeCorePath, cacheRoot };
    const capability = await inspectRotoKeyerCapabilities(runtime);
    const keyer = await buildRotoKeyerDecision(project, evidence, capability, { route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 96 });
    const fixture = createAutopilotV4Fixture(livePlanSource);
    const plan = parseCurrentProductPlan({
      ...fixture,
      materialEvidence: { schema: fixture.materialEvidence.schema, receipts: [{ materialId: MATERIAL_ID, sourceSha256, assetId: evidence.assetId, clipId: evidence.clipId, semanticReceiptSha256 }] },
      rotoKeyer: { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [keyer.decision] },
      commands: [...fixture.commands, keyer.command!],
    });
    assertAutopilotPlanSourceCurrent(plan.source, liveIdentity);
    const currentPlan = plan;
    const verified = await verifyRotoKeyerPlanForProject(currentPlan.rotoKeyer, currentPlan.commands, currentPlan.quality.state, currentPlan.budget.contextTokens, project, cacheRoot, runtime, async (assetId) => project.assets.find((asset) => asset.id === assetId)!.uri);
    assert.deepEqual(verified.routes, ["self_authored_screen_keyer"]);

    const history = dispatchCommand(createHistory(project), { type: "batch", commands: currentPlan.commands }, "autopilot-roto-keyer");
    const keyed = findClip(history.present, evidence.clipId);
    assert.equal(keyed.chromaKey?.screen, "green");
    assert.equal(findClip(undo(history).present, evidence.clipId).chromaKey, undefined);
    assert.equal(findClip(redo(undo(history)).present, evidence.clipId).chromaKey?.engine, "editkin-chroma-distance-keyer/v1");
    const savedPath = join(workspace, "journey.editkin.json");
    await writeFile(savedPath, `${JSON.stringify(history.present, null, 2)}\n`, "utf8");
    const reopened = projectSchema.parse(JSON.parse(await readFile(savedPath, "utf8")));
    const reopenedClip = findClip(reopened, evidence.clipId);
    const alphaPlan = compileClipAlphaPlan(reopened, reopenedClip);
    assert.equal(alphaPlan.keyer?.engine, "editkin-chroma-distance-keyer/v1");
    const previewPixels = new Uint8ClampedArray([0, 177, 64, 255, 220, 35, 25, 255]);
    applyClipAlphaPlanRgbaInPlace(previewPixels, 2, 1, alphaPlan, { localProjectFrame: 0 });
    assert.ok(previewPixels[3] < 20 && previewPixels[7] > 220, "Preview keyer alpha did not distinguish screen and subject");
    const formalFilter = chromaKeyFfmpegFilter(alphaPlan.keyer!);
    assert.ok(formalFilter?.includes("geq="), "formal keyer compiler missing");

    const formalOutput = join(workspace, "formal-keyed.mp4");
    await renderProject(reopened, formalOutput, { ffmpegPath, ffprobePath, nativeCorePath, preferGpu: false, timeoutMs: 120_000 });
    const [backgroundPixel, subjectPixel] = await Promise.all([sampleRgb(formalOutput, 4, 4), sampleRgb(formalOutput, 36, 16)]);
    const distance = (left: number[], right: number[]) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
    assert.ok(distance(backgroundPixel, [24, 74, 156]) <= 35, `formal background replacement drifted: ${backgroundPixel}`);
    assert.ok(distance(subjectPixel, [220, 35, 25]) <= 35, `formal subject preservation drifted: ${subjectPixel}`);
    assert.ok((await stat(formalOutput)).size > 1_000);

    const autoSourceSha256 = sha256(await readFile(ordinarySource));
    const autoProject = makeAutoProject(ordinarySource, background, autoSourceSha256);
    const autoEvidence = await prepareAutoMaterialEvidence(cacheRoot, autoSourceSha256);
    const autoCapability = await inspectRotoKeyerCapabilities(runtime);
    const preparedAuto = await prepareAutopilotAutoRoto(autoProject, ordinarySource, autoEvidence, autoCapability, {
      maskId: "autopilot-auto-roto", initialTime: 0, initialRect: { x: .3, y: .15, width: .4, height: .7 }, decisionContextTokens: 120,
      computeBudget: { maxSourceDurationSeconds: 1, maxAnalyzedFrames: 12, maxMatteBytes: 2 * 1024 * 1024 },
      refine: { temporalStability: .22, feather: .01, edgeShift: 0, contrast: 1.7 },
    }, runtime);
    await verifyAutoRotoPreparation(cacheRoot, preparedAuto.preparationReceiptSha256);
    const verifiedAuto = await verifyRotoKeyerPlanForProject(
      { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [preparedAuto.decision] }, [preparedAuto.command], "review_required", 160,
      autoProject, cacheRoot, runtime, async () => ordinarySource,
    );
    assert.deepEqual(verifiedAuto.routes, ["self_authored_auto_roto"]);
    const autoApplied = applyCommand(autoProject, preparedAuto.command);
    const autoAlphaPlan = compileClipAlphaPlan(autoApplied, findClip(autoApplied, "clip-source-1"));
    assert.equal(autoAlphaPlan.operations[0]?.source, "pixel_matte");
    assert.equal(autoAlphaPlan.operations[0]?.source === "pixel_matte" ? autoAlphaPlan.operations[0].matte.sequence.alphaRefinement?.engine : undefined, "editkin-self-authored-optical-alpha-refiner/v1");
    const autoFormalOutput = join(workspace, "formal-auto-roto.mp4");
    await renderProject(autoApplied, autoFormalOutput, {
      ffmpegPath,
      ffprobePath,
      nativeCorePath,
      autoRotoCacheRoot: cacheRoot,
      preferGpu: false,
      timeoutMs: 120_000,
    });
    assert.ok((await stat(autoFormalOutput)).size > 1_000);

    const blue = await buildRotoKeyerDecision(project, syntheticEvidence("blue", sourceSha256), fixtureCapability(capability.snapshotSha256), { route: "self_authored_screen_keyer", screen: "blue", decisionContextTokens: 80 });
    const ambiguous = await buildRotoKeyerDecision(project, syntheticEvidence("ambiguous", sourceSha256, .7), fixtureCapability(capability.snapshotSha256), { route: "no_op", decisionContextTokens: 48 });
    const auto = autoRotoPlanFixture(project, syntheticEvidence("none", sourceSha256));
    assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [blue.decision] }, [blue.command!], "review_required", 100);
    assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [ambiguous.decision] }, [], "review_required", 50);
    assertRotoKeyerPlanCommandBinding({ schema: auto.schema, decisions: auto.decisions }, [auto.command], "review_required", 150);

    await reject("implicit-keyer-without-plan", () => assertRotoKeyerPlanCommandBinding(undefined, [keyer.command!], "review_required", 200));
    const embeddedKeyedClip = {
      ...clip("embedded-keyed-clip", "asset-source-1", "key-layer"),
      timelineStart: 1,
      chromaKey: CHROMA_KEY_PRESETS.green,
    };
    await reject("embedded-keyer-add-clip-without-plan", () => assertRotoKeyerPlanCommandBinding(
      undefined, [{ type: "add_clip", clip: embeddedKeyedClip }], "review_required", 200,
    ));
    const embeddedMatteClip = {
      ...clip("embedded-matte-clip", "asset-source-1", "embedded-alpha-track"),
      masks: [structuredClone(auto.command.mask)],
    };
    await reject("embedded-matte-add-track-without-plan", () => assertRotoKeyerPlanCommandBinding(undefined, [{
      type: "add_track",
      track: { id: "embedded-alpha-track", name: "Embedded alpha", kind: "video", locked: false, muted: false, clips: [embeddedMatteClip] },
    }], "review_required", 200));
    await reject("forged-decision-hash", () => assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [{ ...keyer.decision, decisionSha256: "f".repeat(64) }] }, [keyer.command!], "review_required", 200));
    await reject("stale-exact-command", () => assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [keyer.decision] }, [{ type: "set_clip_chroma_key", clipId: evidence.clipId, settings: CHROMA_KEY_PRESETS.blue }], "review_required", 200));
    await reject("blue-evidence-green-key", () => buildRotoKeyerDecision(project, syntheticEvidence("blue", sourceSha256), fixtureCapability(capability.snapshotSha256), { route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80 }));
    await reject("ambiguous-screen-auto-key", () => buildRotoKeyerDecision(project, syntheticEvidence("ambiguous", sourceSha256, .7), fixtureCapability(capability.snapshotSha256), { route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80 }));
    await reject("no-screen-auto-key", () => buildRotoKeyerDecision(project, syntheticEvidence("none", sourceSha256), fixtureCapability(capability.snapshotSha256), { route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80 }));
    await reject("review-bypass", () => assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [keyer.decision] }, [keyer.command!], "machine_checked", 200));
    await reject("token-budget-overflow", () => assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [keyer.decision] }, [keyer.command!], "review_required", 95));
    await reject("external-product-engine", () => parseAutopilotPlan({ ...fixture, rotoKeyer: { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [{ ...keyer.decision, engine: "editkin-sam21-video-memory-roto/v1" }] }, commands: [...fixture.commands, keyer.command!] }));
    await reject("research-only-route", () => parseAutopilotPlan({ ...fixture, rotoKeyer: { schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [{ ...keyer.decision, route: "research" }] }, commands: [...fixture.commands, keyer.command!] }));
    await reject("legacy-plan-schema", () => parseCurrentProductPlan(createAutopilotV3Fixture()));
    await reject("missing-semantic-evidence", () => {
      const { materialEvidence: _materialEvidence, ...withoutMaterialEvidence } = currentPlan;
      return parseCurrentProductPlan(withoutMaterialEvidence);
    });
    await reject("mismatched-roto-semantic-receipt", () => parseCurrentProductPlan({
      ...currentPlan,
      materialEvidence: {
        ...currentPlan.materialEvidence,
        receipts: currentPlan.materialEvidence.receipts.map((receipt) => ({ ...receipt, semanticReceiptSha256: "0".repeat(64) })),
      },
    }));
    for (const key of [
      "revision", "skillSha256", "workflowContractRevision", "workflowContractSha256", "knowledgeRevision", "knowledgeSha256", "stableRulesSha256",
      "pluginRegistrySha256", "invocationBindingSha256",
    ] as const) {
      const staleValue = typeof livePlanSource[key] === "number" ? Number(livePlanSource[key]) + 1 : "0".repeat(64);
      await reject(`stale-live-identity-${key}`, () => assertAutopilotPlanSourceCurrent({ ...livePlanSource, [key]: staleValue }, liveIdentity));
    }
    await reject("forged-video-autopilot-skill-sha", () => assertAutopilotPlanSourceCurrent({
      ...livePlanSource,
      skillSha256: sha256(`forged:${liveIdentity.skill.sha256}`),
      invocationBindingSha256: liveIdentity.bindingSha256,
    }, liveIdentity));
    const staleSkillRoot = join(workspace, "retired-video-autopilot-copy");
    const staleSkillPath = join(staleSkillRoot, "SKILL.md");
    await mkdir(staleSkillRoot, { recursive: true });
    await writeFile(staleSkillPath, "---\nname: video-autopilot\n---\n- M1: retired fixture\n", "utf8");
    await writeFile(join(staleSkillRoot, "workflow_contract.json"), JSON.stringify({
      schema: "hao.video-autopilot.workflow-contract/v1",
      contract_revision: 1,
      plan_schema: "hao.video-autopilot.edit-plan/v4",
      legacy_plan_policy: "reject",
    }), "utf8");
    const previousSkillOverride = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL;
    try {
      process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = canonicalSkillPath;
      const configuredCanonicalIdentity = await readLiveAutopilotIdentity();
      assert.equal(configuredCanonicalIdentity.bindingSha256, liveIdentity.bindingSha256,
        "canonical agent-setup environment path changed the live invocation identity");
      process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = staleSkillPath;
      const selectedIdentity = await readLiveAutopilotIdentity();
      assert.notEqual(selectedIdentity.bindingSha256, liveIdentity.bindingSha256,
        "switching the active Skill must change the invocation identity");
      await reject("active-video-autopilot-skill-drift", () =>
        assertAutopilotPlanSourceCurrent(livePlanSource, selectedIdentity));
    } finally {
      if (previousSkillOverride === undefined) delete process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL;
      else process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = previousSkillOverride;
    }
    const missingOptical = structuredClone(auto.command);
    delete missingOptical.mask.matteSequence!.alphaRefinement;
    const { routeReceipt: _routeReceipt, decisionSha256: _decisionSha256, ...autoDecisionBase } = auto.decisions[0];
    const badAutoDecision = sealRotoKeyerDecision({ ...autoDecisionBase, commandSha256: rotoKeyerSha256(missingOptical) });
    await reject("auto-roto-without-optical-alpha", () => assertRotoKeyerPlanCommandBinding({ schema: ROTO_KEYER_PLAN_SCHEMA, decisions: [badAutoDecision] }, [missingOptical], "review_required", 200));
    await reject("forged-evidence-receipt", () => verifyRotoKeyerEvidence(cacheRoot, MATERIAL_ID, "f".repeat(64)));
    await reject("stale-source-file", () => verifyRotoKeyerPlanForProject(
      currentPlan.rotoKeyer, currentPlan.commands, currentPlan.quality.state, currentPlan.budget.contextTokens,
      project, cacheRoot, runtime, async () => background,
    ));
    const unavailable = fixtureCapability(capability.snapshotSha256);
    unavailable.routes = unavailable.routes.map((route) => route.route === "self_authored_screen_keyer" ? { ...route, available: false } : route);
    await reject("capability-unavailable", () => buildRotoKeyerDecision(project, evidence, unavailable, { route: "self_authored_screen_keyer", screen: "green", decisionContextTokens: 80 }));

    assert.deepEqual([...ROTO_KEYER_AUTOPILOT_TOOL_IDS].sort(), ["build_autopilot_roto_keyer_decision", "inspect_roto_keyer_capabilities", "prepare_autopilot_auto_roto", "record_roto_keyer_evidence"]);
    const rotoToolsSource = await readFile(join(appRoot, "src/mcp/rotoKeyerAutopilotTools.ts"), "utf8");
    assert.ok(rotoToolsSource.includes("readLiveAutopilotIdentity()"), "Roto/Keyer MCP fragments do not read the canonical live invocation");
    assert.ok(rotoToolsSource.match(/requiredPlanSource:\s*autopilotPlanSourceFromIdentity\(invocation\)/g)?.length === 2,
      "Both Roto/Keyer plan-fragment tools must return the exact required live plan source");
    const sourceFiles = [
      "src/application/rotoKeyerAutopilot.ts", "src/application/rotoKeyerAutopilot.test.ts", "src/application/autopilotPlan.ts", "src/application/autopilotPlanFixture.ts",
      "src/application/autopilotInvocationIdentity.ts",
      "src/mcp/rotoKeyerAutopilotTools.ts", "src/mcp/autopilotTools.ts", "src/mcp/materialIntelligenceTools.ts",
      "src/domain/clipAlphaPlan.ts", "src/ui/alphaPlanPreview.ts", "src/render/ffmpegComposite.ts",
      "scripts/roto-keyer-autopilot-integration.ts",
    ];
    const report = {
      schema: "editkin.roto-keyer-autopilot-integration-report/v1",
      status: "GREEN_INTERNAL_CONTRACT",
      generatedAt: new Date().toISOString(),
      currentPlanSchema: "hao.video-autopilot.edit-plan/v4",
      canonicalInvocation: {
        identity: liveIdentity,
        requiredPlanSource: livePlanSource,
        files: [
          await canonicalInvocationFileIdentity("SKILL.md", canonicalSkillPath),
          await canonicalInvocationFileIdentity("workflow_contract.json", canonicalWorkflowPath),
        ],
        workflowBound: true,
        communityKnowledgeBound: true,
        pluginRegistryBound: true,
      },
      toolIds: ROTO_KEYER_AUTOPILOT_TOOL_IDS,
      fixtures: [
        { id: "ordinary-subject", expectedRoute: "self_authored_auto_roto", state: "full-internal-native-journey" },
        { id: "green-screen", expectedRoute: "self_authored_screen_keyer", state: "full-internal-journey" },
        { id: "blue-screen", expectedRoute: "self_authored_screen_keyer", state: "current-schema-contract-fixture" },
        { id: "translucent-edge", expectedRoute: "self_authored_auto_roto+optical-alpha", state: "full-internal-native-journey" },
        { id: "ambiguous-or-no-screen", expectedRoute: "no_op_or_manual_mask", state: "negative-and-no-op-fixture" },
      ],
      journey: {
        evidenceInspected: true, immutableEvidenceRecorded: true, capabilitySnapshotBound: true,
        exactEditableCommandBound: true, tokenBudgetBound: true, computeBudgetSchemaBound: true,
        auditVerifierRecomputed: true, atomicBatchApplied: true, undoRedo: true,
        previewAlphaExecuted: true, formalRenderExecuted: true, reopenValidated: true,
        humanReviewState: "pending_review_required",
        autoRotoPreparationToolImplemented: true,
        autoRotoDeliveredRuntimeExecutedHere: true,
        rotoPlanFragmentsReturnCanonicalRequiredPlanSource: true,
      },
      formal: { keyerOutputBytes: (await stat(formalOutput)).size, autoRotoOutputBytes: (await stat(autoFormalOutput)).size, backgroundPixel, subjectPixel },
      mutations,
      mutationCoverage: `${mutations.filter((mutation) => mutation.rejected).length}/${mutations.length}`,
      capabilityAtGate: capability,
      sourceIdentities: await Promise.all(sourceFiles.map((path) => fileIdentity(join(appRoot, path)))),
      remainingDeliveredGaps: [
        "This internal gate does not launch a real installed Codex or Claude Code client session; agent-session:integration remains the delivered-session gate.",
        "The staged native Auto Roto runtime is executed here, but extracted public-installer replay and runtime/source freshness after packaging remain separate gates.",
        "No macOS packaged MCP/runtime journey is executed here.",
        "Auto Roto, optical alpha and screen-keyer real-footage quality remain unmeasured; this report does not claim competitor parity or superiority.",
      ],
      claimBoundary: "Proves the bounded internal canonical-live-Video-Autopilot current-v4 identity/evidence/capability/decision/audit/apply contract, a real self-authored green-key Preview/formal-render/reopen journey, and a staged native self-authored Auto Roto+optical-alpha preparation/formal-render journey. It does not prove a launched installed Codex/Claude client, macOS packaging, extracted public-installer replay, or real-footage quality.",
    };
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Roto/Keyer Autopilot internal gate GREEN · ${mutations.length}/${mutations.length} mutations · ${outputPath}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await run();

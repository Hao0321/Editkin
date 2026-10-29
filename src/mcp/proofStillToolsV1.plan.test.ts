import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { isCurrentAutopilotPlan, parseAutopilotPlan } from "../application/autopilotPlan";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "../application/materialIntelligence";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../application/motionTreatment";
import type { EditorCommand } from "../domain/commands";
import { assertProofStillProjectV1 } from "../domain/proofStillV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyAutopilotPlan, auditAutopilotPlan } from "./autopilotTools";
import { prepareProofStillV1 } from "./proofStillToolsV1";
import { createProjectFile, readProject } from "./storage";

// Controlled boundaries, as in autopilotTools.commitReceipt.test.ts: the live Skill/workflow identity, the installed plugin
// registry and host workflow profile, and the design-brief compiler read the creator's machine, so they are fixed here, and the
// OS signing key is never touched. Everything else is real: plan parsing with visible editorial execution and motion treatment
// binding, the project timeline binding, material receipts re-verified against the actual image bytes with the proof-still rule
// (design P5), command application, creator policy, the in-process audit receipt and the atomic apply commit.
vi.mock("../security/userCommitSigningKey", async () => {
  const { createHash: hash, createHmac } = await import("node:crypto");
  const syntheticKey = Buffer.alloc(32, 42), keyId = hash("sha256").update(syntheticKey).digest("hex");
  return {
    prepareUserCommitSigningKey: async () => ({ keyId, protection: "posix_owner_only" }),
    signUserCommitDigest: async (digest: string) => ({ keyId, protection: "posix_owner_only", issuerProof: createHmac("sha256", syntheticKey).update(`original-motion-commit:v2:${digest}`).digest("hex") }),
  };
});
vi.mock("../application/autopilotInvocationIdentity", async importOriginal => {
  const actual = await importOriginal<typeof import("../application/autopilotInvocationIdentity")>();
  return { ...actual, readLiveAutopilotIdentity: async () => ({
    schema: "editkin.video-autopilot.live-identity/v1", bindingSha256: "f".repeat(64),
    engine: { schema: "editkin.engine-continuity-pin/v1", sha256: actual.sha256Canonical((await import("../motion/engineContinuity")).EDITKIN_ENGINE_CONTINUITY) },
    skill: { id: "video-autopilot", revision: 183, sha256: "a".repeat(64), hardRuleCount: 1 },
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

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
const projectPath = "proof-plan.editkin.json";
const environment = { workspace: process.env.EDITKIN_WORKSPACE, cacheRoot: process.env.EDITKIN_CACHE_ROOT };
let fixture: { shotSha256: string; materialId: string; semanticReceiptSha256: string };

/** An owned synthetic screenshot, untagged like a real one, in a project with one ordinary clip of it, and its real receipts. */
beforeAll(async () => {
  const workspace = await temp.create("ppl-"), cacheRoot = join(workspace, "cache"), shot = join(workspace, "shots", "settings.png");
  process.env.EDITKIN_WORKSPACE = workspace; process.env.EDITKIN_CACHE_ROOT = cacheRoot;
  await mkdir(join(workspace, "shots"), { recursive: true });
  const made = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1", "-frames:v", "1", "-vf", "format=rgb24", shot], { windowsHide: true, timeout: 30000 });
  expect(made.status, made.stderr.toString()).toBe(0);
  const shotSha256 = createHash("sha256").update(await readFile(shot)).digest("hex");
  await createProjectFile(projectPath, "Proof plan", 1280, 720, 30, [
    { type: "import_asset", asset: { id: "shot", name: "Settings screenshot", kind: "image", uri: "shots/settings.png", duration: 3, width: 640, height: 360 } },
    { type: "add_clip", clip: { id: "shot-source", assetId: "shot", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 3, volume: 1,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
  ]);
  const { packet } = await prepareMaterialIntelligence({ assetId: "shot", clipId: "shot-source", sourcePath: shot, sourceStart: 0, duration: 3, fps: 30, kind: "image", includeTranscript: false },
    { ffmpegPath, ffprobePath, cacheRoot, modelRoot: cacheRoot });
  const semantic = await recordMaterialSemantics(cacheRoot, { materialId: packet.materialId, sourceSha256: shotSha256, overallTopic: "Settings page screenshot",
    contentType: "screenshot", language: "en", people: [], locations: [], segments: [{ start: 0, end: 3, summary: "The account settings page", subjects: [], actions: [], objects: [],
      importance: .8, evidenceFrameIds: ["kf-1"], transcriptCueIndexes: [] }] });
  fixture = { shotSha256, materialId: packet.materialId, semanticReceiptSha256: semantic.semanticReceiptSha256 };
}, 180000);
afterAll(() => {
  for (const [key, value] of [["EDITKIN_WORKSPACE", environment.workspace], ["EDITKIN_CACHE_ROOT", environment.cacheRoot]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function prepare(withTarget: boolean, frameId = "kf-1") {
  return prepareProofStillV1({ projectPath, assetId: "shot", trackId: "video-main", startFrame: 120, holdFrames: 90,
    crop: { x: 40, y: 30, width: 560, height: 315 }, redactions: [{ id: "email", rect: { x: 60, y: 50, width: 200, height: 30 }, fill: "#000000" }],
    ...(withTarget ? { target: { rect: { x: 300, y: 150, width: 120, height: 50 } } } : {}),
    confirmation: { by: "agent", note: "Email row seen in kf-1; no other personal data claimed." },
    evidence: { materialId: fixture.materialId, semanticReceiptSha256: fixture.semanticReceiptSha256, frameId } });
}

/** A minimal real v4 plan around the tool's output: its receipt, commands, editorial event, a proof beat that cites the viewed frame, and a motion treatment for every family. */
function planFor(prepared: Awaited<ReturnType<typeof prepare>>, graphics: unknown[] = prepared.editorialEvent ? [prepared.editorialEvent] : []) {
  const base = createAutopilotV4Fixture();
  const commands: EditorCommand[] = [...base.commands as unknown as EditorCommand[], ...prepared.commands];
  const decisions = MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = commands.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
    return commandIndexes.length ? { family, action: "use" as const, reason: "Proof-still target annotation on the screenshot", beatIds: ["proof"], commandIndexes }
      : { family, action: "omit" as const, reason: "Not used by this proof still", beatIds: [], commandIndexes: [] };
  });
  return { ...base, commands, materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [prepared.materialEvidence] },
    editorial: { ...base.editorial, motionTreatment: { schema: "editkin.motion-treatment/v1", decisions }, graphics,
      narrative: { ...base.editorial.narrative, setupPayoffs: [], beats: [
        { id: "promise", range: { startFrame: 0, endFrame: 60 }, role: "promise", summary: "展示結果", energy: .8, primaryFocus: "成片差異", evidenceRefs: ["project:preview-final"] },
        { id: "proof", range: { startFrame: 60, endFrame: 210 }, role: "proof", summary: "設定頁截圖證據", energy: .6, primaryFocus: "設定選項", evidenceRefs: [prepared.evidenceRef] },
        { id: "payoff", range: { startFrame: 210, endFrame: 240 }, role: "payoff", summary: "用 receipt 驗證", energy: .95, primaryFocus: "可重做證據", evidenceRefs: ["receipt:render-1"] },
      ] } } };
}
const body = (result: { content: { type: string; text: string }[] }) => JSON.parse(result.content[0].text);

describe("prepare_proof_still output inside a real v4 plan", () => {
  it("parses: the target event is executed by the focus-bracket's anchor corner, and the image clip claims no sound treatment", async () => {
    const prepared = await prepare(true);
    const plan = parseAutopilotPlan(planFor(prepared));
    if (!isCurrentAutopilotPlan(plan)) throw Error("a v4 plan must parse as the current schema");
    expect(plan.editorial.graphics).toEqual([prepared.editorialEvent]);
    const anchor = prepared.commands.find(command => command.type === "add_motion_graphic" && command.graphic.id === `${prepared.clipId}.target`);
    expect(anchor && anchor.type === "add_motion_graphic" && anchor.graphic).toMatchObject({ presetId: "reel_native_panel", kind: "card", text: "", timelineStart: 4, duration: 3,
      vectorV2: { schema: "editkin.motion-vector-shape/v1", kind: "shape" } });
    const treatment = plan.editorial.motionTreatment!.decisions;
    expect(treatment.filter(row => row.action === "use").map(row => row.family).sort()).toEqual(["cards", "motion", "title"]);
    expect(treatment.find(row => row.family === "sound")).toMatchObject({ action: "omit", commandIndexes: [] });
    // Without a target nothing is annotated, so there is no editorial event; the beat still cites the viewed frame.
    const plain = await prepare(false);
    expect(plain.editorialEvent).toBeNull();
    expect(plain.commands.map(command => command.type)).toEqual(["add_clip"]);
    expect(() => parseAutopilotPlan(planFor(plain))).not.toThrow();
  }, 180000);

  it("the first-round output shape (a proof_freeze event with no motion graphic of its id) is what the v4 parse refused", async () => {
    const prepared = await prepare(true);
    const firstRound = { id: prepared.clipId, presetId: "focus-bracket", range: { startFrame: 120, endFrame: 210 }, kind: "proof_freeze", purpose: "proof",
      message: "看這個選項", evidenceRefs: [prepared.evidenceRef] };
    expect(() => parseAutopilotPlan(planFor(prepared, [firstRound]))).toThrow(`editorial graphic 沒有對應 add_motion_graphic 命令：${prepared.clipId}`);
  }, 180000);

  it("audit refuses a target still whose event is missing or cites a frame that was never decoded (design P5)", async () => {
    const prepared = await prepare(true);
    await expect(auditAutopilotPlan(projectPath, planFor(prepared, []))).rejects.toThrow(/^PROOF_STILL_EVENT_MISSING/);
    const uncited = { ...prepared.editorialEvent!, evidenceRefs: [`mi:${fixture.materialId}:${fixture.semanticReceiptSha256}:frame:kf-2`] };
    await expect(auditAutopilotPlan(projectPath, planFor(prepared, [uncited]))).rejects.toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
  }, 180000);

  it("passes audit and apply with its own image receipt re-verified, and the committed project holds the proof still and its target", async () => {
    const before = await readProject(projectPath);
    const plain = await prepare(false);
    expect(body(await auditAutopilotPlan(projectPath, planFor(plain)))).toMatchObject({ status: "ACCEPTED", materialEvidence: { receiptCount: 1 } });
    const prepared = await prepare(true), plan = planFor(prepared);
    const audit = body(await auditAutopilotPlan(projectPath, plan));
    expect(audit).toMatchObject({ status: "ACCEPTED", commandCount: plan.commands.length, materialEvidence: { receiptCount: 1 } });
    const applied = body(await applyAutopilotPlan(projectPath, plan, audit.auditReceipt));
    expect(applied).toMatchObject({ status: "REVIEW_REQUIRED", receipt: { state: "committed", projectRevisionBefore: before.revision, projectRevisionAfter: before.revision + 1 } });
    const saved = await readProject(projectPath);
    const clip = saved.tracks.flatMap(track => track.clips).find(candidate => candidate.id === prepared.clipId);
    expect(clip).toMatchObject({ assetId: "shot", volume: 1, proofStill: prepared.proofStill, layout: prepared.layout });
    expect(saved.motionGraphics.some(graphic => graphic.id === `${prepared.clipId}.target`)).toBe(true);
    expect(() => assertProofStillProjectV1(saved, new Map([[prepared.clipId, fixture.shotSha256]]))).not.toThrow();
  }, 240000);
});

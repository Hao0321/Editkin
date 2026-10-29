import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { prepareMaterialIntelligence, readMaterialIntelligence, recordMaterialSemantics } from "../application/materialIntelligence";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../application/motionTreatment";
import { assertStyleTemplateProjectFilesV1 } from "../styleTemplates/slots/renderTemplateClip";
import type { EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyAutopilotPlan, auditAutopilotPlan } from "../mcp/autopilotTools";
import { createProjectFile, readProject } from "../mcp/storage";
import { prepareEditkinModuleV2 } from "./moduleRegistryV2";

// Editable style templates through VA's real path (prepare_editkin_module → v4 audit → atomic apply), adapted from
// motionLibraryModulesV1.va.test.ts. Controlled boundaries exactly as in proofStillToolsV1.plan.test.ts (live Skill identity, installed plugins, host profile,
// design-brief compiler, OS signing key). Everything else is real: module preparation with real renders, plan parsing,
// material receipts re-verified against the actual footage bytes, command application, the audit receipt and the atomic apply.
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
vi.mock("../mcp/autopilotDesignTools", async importOriginal => ({ ...await importOriginal<typeof import("../mcp/autopilotDesignTools")>(),
  verifyAutopilotDesign: async () => ({ state: "CONTROLLED_DESIGN_BOUNDARY" }),
}));
const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
const projectPath = "style-template-va.editkin.json";
const saved = { workspace: process.env.EDITKIN_WORKSPACE, cacheRoot: process.env.EDITKIN_CACHE_ROOT, ffmpeg: process.env.HAO_FFMPEG_PATH, ffprobe: process.env.HAO_FFPROBE_PATH };
let receipt: { materialId: string; sourceSha256: string; assetId: string; clipId: string; semanticReceiptSha256: string };
const clip = (id: string, timelineStart: number, sourceStart: number) => ({ id, assetId: "footage", trackId: "video-main", timelineStart, sourceStart, duration: 3, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });

/** Synthetic portrait footage (no personal media), a two-shot project and the clip's real material receipts. */
beforeAll(async () => {
  const workspace = await temp.create("styletpl-va-"), cacheRoot = join(workspace, "material-cache"), footage = join(workspace, "footage.mp4");
  Object.assign(process.env, { EDITKIN_WORKSPACE: workspace, EDITKIN_CACHE_ROOT: cacheRoot, HAO_FFMPEG_PATH: ffmpegPath, HAO_FFPROBE_PATH: ffprobePath });
  const made = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=216x384:r=30:d=10",
    "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", footage], { windowsHide: true, timeout: 60_000 });
  expect(made.status, made.stderr.toString()).toBe(0);
  const sourceSha256 = createHash("sha256").update(await readFile(footage)).digest("hex");
  await createProjectFile(projectPath, "Style template VA", 216, 384, 30, [
    { type: "import_asset", asset: { id: "footage", name: "Synthetic footage", kind: "video", uri: "footage.mp4", duration: 10, width: 216, height: 384 } },
    { type: "add_clip", clip: clip("a", 0, 1) }, { type: "add_clip", clip: clip("b", 3, 5) },
  ]);
  const { packet } = await prepareMaterialIntelligence({ assetId: "footage", clipId: "a", sourcePath: footage, sourceStart: 1, duration: 3, fps: 30, kind: "video", includeTranscript: false },
    { ffmpegPath, ffprobePath, cacheRoot, modelRoot: cacheRoot });
  const firstFrame = (await readMaterialIntelligence(cacheRoot, packet.materialId)).keyframes[0].id;
  const semantic = await recordMaterialSemantics(cacheRoot, { materialId: packet.materialId, sourceSha256, overallTopic: "Synthetic colour bars", contentType: "screen_recording",
    language: "en", people: [], locations: [], segments: [{ start: 0, end: 3, summary: "A moving test pattern", subjects: [], actions: [], objects: [], importance: .5,
      evidenceFrameIds: [firstFrame], transcriptCueIndexes: [] }] });
  receipt = { materialId: packet.materialId, sourceSha256, assetId: "footage", clipId: "a", semanticReceiptSha256: semantic.semanticReceiptSha256 };
}, 240_000);
afterAll(() => {
  for (const [key, value] of [["EDITKIN_WORKSPACE", saved.workspace], ["EDITKIN_CACHE_ROOT", saved.cacheRoot], ["HAO_FFMPEG_PATH", saved.ffmpeg], ["HAO_FFPROBE_PATH", saved.ffprobe]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

/** The real v4 plan around a module's flat commands, with every motion treatment family declared. */
function planFor(commands: EditorCommand[]) {
  const base = createAutopilotV4Fixture(), all = [...base.commands as unknown as EditorCommand[], ...commands];
  const decisions = MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = all.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
    return commandIndexes.length ? { family, action: "use" as const, reason: "Motion library module output", beatIds: ["proof"], commandIndexes }
      : { family, action: "omit" as const, reason: "Not used by this module fixture", beatIds: [], commandIndexes: [] };
  });
  return { ...base, commands: all, materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [receipt] },
    editorial: { ...base.editorial, motionTreatment: { schema: "editkin.motion-treatment/v1", decisions },
      narrative: { ...base.editorial.narrative, setupPayoffs: [], beats: [
        { id: "promise", range: { startFrame: 0, endFrame: 30 }, role: "promise", summary: "開場", energy: .8, primaryFocus: "動態標題", evidenceRefs: ["project:preview-final"] },
        { id: "proof", range: { startFrame: 30, endFrame: 150 }, role: "proof", summary: "測試畫面", energy: .6, primaryFocus: "畫面", evidenceRefs: [`mi:${receipt.materialId}`] },
        { id: "payoff", range: { startFrame: 150, endFrame: 180 }, role: "payoff", summary: "收尾", energy: .9, primaryFocus: "成果", evidenceRefs: ["receipt:render-1"] },
      ] } } };
}
const body = (result: { content: { type: string; text: string }[] }) => JSON.parse(result.content[0].text);
async function auditAndApply(commands: EditorCommand[]) {
  const before = await readProject(projectPath), plan = planFor(commands);
  const audit = body(await auditAutopilotPlan(projectPath, plan));
  expect(audit).toMatchObject({ status: "ACCEPTED", commandCount: plan.commands.length });
  const applied = body(await applyAutopilotPlan(projectPath, plan, audit.auditReceipt));
  expect(applied).toMatchObject({ status: "REVIEW_REQUIRED", receipt: { state: "committed", projectRevisionBefore: before.revision, projectRevisionAfter: before.revision + 1 } });
  return readProject(projectPath);
}

describe("graphic.style_template: prepare → v4 audit → atomic apply", () => {
  it("VA adds an S1 template clip with evidence-bound text and a still of the footage, then changes its slots in a second plan", async () => {
    const text = { chapterNumber: "01", chapterLabel: "測試畫面", lead: "這是", keyword: "測試圖樣" };
    const prepared = await prepareEditkinModuleV2({ projectPath, moduleId: "graphic.style_template", variantId: "S1_explainer_ui",
      inputs: { startFrame: 30, durationFrames: 66, text, textEvidence: Object.fromEntries(Object.keys(text).map(slot => [slot, `mi:${receipt.materialId}`])),
        images: { card: { source: { kind: "still", assetId: "footage", time: 2 } } } } });
    expect(prepared).toMatchObject({ readOnly: true, mutationPerformed: false, commandTypes: ["add_style_template_clip"] });
    expect(prepared.carriers.styleTemplate).toMatchObject({ templateId: "S1_explainer_ui", artStatus: "uncertified", autoPicked: false });
    const project = await auditAndApply(prepared.commands as EditorCommand[]);
    const clip = project.tracks.find(track => track.id === "styletpl")!.clips[0];
    expect(clip).toMatchObject({ timelineStart: 1, duration: 66 / 30, styleJob: { template: { id: "S1_explainer_ui" }, slots: { text, image: { card: { source: { kind: "still", assetId: "footage", time: 2 } } } } } });
    expect(await assertStyleTemplateProjectFilesV1(project, join(process.env.EDITKIN_WORKSPACE!, ".editkin-media-cache"))).toBe(1);
    // A second plan changes the keyword and the accent (one update, one Undo in the editor).
    const update = await prepareEditkinModuleV2({ projectPath, moduleId: "graphic.style_template",
      inputs: { updateClipId: clip.id, text: { keyword: "彩色條紋" }, textEvidence: { keyword: `mi:${receipt.materialId}` }, colors: { accent: "#5CE4F4" } } });
    expect(update.commandTypes).toEqual(["update_style_template_clip"]);
    const after = await auditAndApply(update.commands as EditorCommand[]);
    expect(after.tracks.find(track => track.id === "styletpl")!.clips[0]).toMatchObject({ id: clip.id, timelineStart: 1,
      styleJob: { slots: { text: { ...text, keyword: "彩色條紋" }, color: { accent: "#5CE4F4" } } } });
    expect(await assertStyleTemplateProjectFilesV1(after, join(process.env.EDITKIN_WORKSPACE!, ".editkin-media-cache"))).toBe(1);
  }, 600_000);
});

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
import { assertMotionLibraryProjectFilesV1 } from "../application/motionLibraryClipsV1";
import type { EditorCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyAutopilotPlan, auditAutopilotPlan } from "../mcp/autopilotTools";
import { createProjectFile, readProject } from "../mcp/storage";
import { prepareEditkinModuleV2 } from "./moduleRegistryV2";

// Controlled boundaries exactly as in proofStillToolsV1.plan.test.ts (live Skill identity, installed plugins, host profile,
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
// One controlled pending item per kind, whatever Claude has certified by now: the first certified item of a family is
// un-pinned, so auto-pick must skip it and naming it must come back "uncertified".
const PENDING = vi.hoisted(() => new Set(["T41", "X09", "B02"]));
vi.mock("../motionLibrary/certifications", async importOriginal => {
  const actual = await importOriginal<typeof import("../motionLibrary/certifications")>();
  return { ...actual, motionArtStatus: (id: string, revision: number) => PENDING.has(id) ? "pending" as const : actual.motionArtStatus(id, revision) };
});

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
const projectPath = "motion-library-va.editkin.json";
const saved = { workspace: process.env.EDITKIN_WORKSPACE, cacheRoot: process.env.EDITKIN_CACHE_ROOT, ffmpeg: process.env.HAO_FFMPEG_PATH, ffprobe: process.env.HAO_FFPROBE_PATH };
let receipt: { materialId: string; sourceSha256: string; assetId: string; clipId: string; semanticReceiptSha256: string };
const clip = (id: string, timelineStart: number, sourceStart: number) => ({ id, assetId: "footage", trackId: "video-main", timelineStart, sourceStart, duration: 3, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });

/** Synthetic portrait footage (no personal media), a two-shot project and the clip's real material receipts. */
beforeAll(async () => {
  const workspace = await temp.create("p3c-va-"), cacheRoot = join(workspace, "material-cache"), footage = join(workspace, "footage.mp4");
  Object.assign(process.env, { EDITKIN_WORKSPACE: workspace, EDITKIN_CACHE_ROOT: cacheRoot, HAO_FFMPEG_PATH: ffmpegPath, HAO_FFPROBE_PATH: ffprobePath });
  const made = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=216x384:r=30:d=10",
    "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", footage], { windowsHide: true, timeout: 60_000 });
  expect(made.status, made.stderr.toString()).toBe(0);
  const sourceSha256 = createHash("sha256").update(await readFile(footage)).digest("hex");
  await createProjectFile(projectPath, "Motion library VA", 216, 384, 30, [
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

describe("Motion Library modules: prepare → v4 audit → atomic apply", () => {
  it("graphic.text_motion auto-picks a certified variant, never the pending one, and the plan applies", async () => {
    const auto = await prepareEditkinModuleV2({ projectPath, moduleId: "graphic.text_motion", inputs: { startFrame: 15, family: "drama", lines: ["開場"], durationFrames: 45 } });
    expect(auto.carriers.motionLibrary).toMatchObject({ itemId: "T42", artStatus: "certified", autoPicked: true });
    expect((auto.carriers.motionLibrary as { candidates: string[] }).candidates).not.toContain("T41");
    // No add_track: the command places the clip itself (autoTrack), so several prepares compose in one plan.
    expect(auto.commandTypes).toEqual(["add_motion_library_clip"]);
    expect(auto).toMatchObject({ readOnly: true, mutationPerformed: false });
    const named = await prepareEditkinModuleV2({ projectPath, moduleId: "graphic.text_motion", variantId: "T41", inputs: { startFrame: 75, lines: ["點名"], durationFrames: 45 } });
    expect(named.carriers.motionLibrary).toMatchObject({ itemId: "T41", artStatus: "uncertified", autoPicked: false });
    const project = await auditAndApply(auto.commands as EditorCommand[]);
    const added = project.tracks.find(track => track.id === "motionlib-text")!.clips[0];
    expect(added).toMatchObject({ timelineStart: .5, duration: 1.5, motionLibrary: { itemId: "T42", kind: "text" } });
    expect(await assertMotionLibraryProjectFilesV1(project)).toBe(1);
    // M10: no fallback to the item's sample text, through the real registry path.
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: "graphic.text_motion", variantId: "T29", inputs: { startFrame: 90 } }))
      .rejects.toThrow(/MOTION_LIBRARY_TEXT_LINES_REQUIRED/);
  }, 300_000);

  it("composes several text effects prepared against one saved project in one plan; overlapping ones get their own track", async () => {
    const prepare = (startFrame: number, word: string) => prepareEditkinModuleV2({ projectPath, moduleId: "graphic.text_motion",
      inputs: { startFrame, family: "drama", lines: [word], durationFrames: 30 } });
    // 75–105 and 120–150 fit after the first title (15–60) on motionlib-text; 80–110 overlaps 75–105.
    const prepared = [await prepare(75, "一"), await prepare(80, "二"), await prepare(120, "三")];
    for (const result of prepared) expect(result.commandTypes).toEqual(["add_motion_library_clip"]);
    const project = await auditAndApply(prepared.flatMap(result => result.commands as EditorCommand[]));
    const at = (frame: number) => project.tracks.find(track => track.clips.some(clip => Math.round(clip.timelineStart * 30) === frame && clip.motionLibrary?.kind === "text"))?.id;
    expect([at(15), at(75), at(80), at(120)]).toEqual(["motionlib-text", "motionlib-text", "motionlib-text-2", "motionlib-text"]);
    expect(await assertMotionLibraryProjectFilesV1(project)).toBe(4);
  }, 300_000);

  it("transition.motion_pair renders the matte at the window length and applies a matte transition", async () => {
    const auto = await prepareEditkinModuleV2({ projectPath, moduleId: "transition.motion_pair", inputs: { fromClipId: "a", toClipId: "b", durationFrames: 12, family: "shape" } });
    expect(auto.carriers.motionLibrary).toMatchObject({ itemId: "X10", artStatus: "certified", autoPicked: true, frameCount: 12 });
    expect(auto.commandTypes.at(-1)).toBe("set_timeline_transition");
    const named = await prepareEditkinModuleV2({ projectPath, moduleId: "transition.motion_pair", variantId: "X09", inputs: { fromClipId: "a", toClipId: "b", durationFrames: 12 } });
    expect(named.carriers.motionLibrary).toMatchObject({ itemId: "X09", artStatus: "uncertified" });
    // X20 burns in 「轉場」: never auto-picked (see motionLibraryModulesV1.test.ts); named, the result says so.
    const fixedWord = await prepareEditkinModuleV2({ projectPath, moduleId: "transition.motion_pair", variantId: "X20", inputs: { fromClipId: "a", toClipId: "b", durationFrames: 12 } });
    expect(fixedWord.carriers.motionLibrary).toMatchObject({ itemId: "X20", autoPicked: false, fixedText: ["轉場"] });
    expect(auto.carriers.motionLibrary).not.toHaveProperty("fixedText");
    const project = await auditAndApply(auto.commands as EditorCommand[]);
    expect(project.timelineTransitions?.[0]).toMatchObject({ kernel: "matte", beforeFrames: 6, afterFrames: 6, motionLibrary: { itemId: "X10" } });
  }, 300_000);

  it("background.motion_loop places a certified loop and refuses a filter that only matches pending variants", async () => {
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: "background.motion_loop", inputs: { startFrame: 180, role: "layers", family: "halftone", durationFrames: 15 } }))
      .rejects.toThrow(/MOTION_LIBRARY_NO_CERTIFIED_VARIANT/);
    const auto = await prepareEditkinModuleV2({ projectPath, moduleId: "background.motion_loop", inputs: { startFrame: 180, family: "halftone", durationFrames: 15 } });
    expect(auto.carriers.motionLibrary).toMatchObject({ itemId: "B01", artStatus: "certified", autoPicked: true });
    expect((auto.carriers.motionLibrary as { candidates: string[] }).candidates).not.toContain("B02");
    const project = await auditAndApply(auto.commands as EditorCommand[]);
    // Without trackId a background goes on its own Motion Library track beneath the footage.
    expect(project.tracks[0]).toMatchObject({ id: "motionlib-bg", kind: "video" });
    expect(project.tracks[1].id).toBe("video-main");
    expect(project.tracks[0].clips[0]).toMatchObject({ timelineStart: 6, duration: .5, motionLibrary: { itemId: "B01", kind: "background" } });
    await expect(prepareEditkinModuleV2({ projectPath, moduleId: "background.motion_loop", variantId: "T01", inputs: { startFrame: 0 } })).rejects.toThrow(/沒有 variant/);
  }, 300_000);
});

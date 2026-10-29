import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Long-form plan sets with style templates and the Motion Library (L1: audit gaps G1, G2, G3, G5, G6, G7), proven on a
 * 3-minute, 3-chapter project through the handlers of the real MCP tools (prepare_editkin_module, audit_longform_plan_set,
 * apply_longform_plan_set, and validate_project's own checks), with their MCP error mapping. Controlled boundaries exactly as in
 * longformPlanSetToolsV1.test.ts: the live Skill identity, plugin discovery, Skill selection, host profile, design
 * re-verification, auto colour, roto and the OS signing key. Renders, plan parsing, material receipts, the merge,
 * receipts and the atomic apply are real.
 */
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
vi.mock("../application/autoColorEvidence", async importOriginal => ({ ...await importOriginal<typeof import("../application/autoColorEvidence")>(),
  verifyAutoColorDecisions: async () => ({ state: "NOT_REQUIRED" }),
}));
vi.mock("../application/rotoKeyerAutopilot", async importOriginal => ({ ...await importOriginal<typeof import("../application/rotoKeyerAutopilot")>(),
  verifyRotoKeyerPlanForProject: async () => ({ state: "NOT_REQUIRED" }),
}));

import { useTempRoots } from "../test/tempRoot.mjs";
import { createAutopilotV4Fixture } from "../application/autopilotPlanFixture";
import { autopilotPlanSha256, parseAutopilotPlan } from "../application/autopilotPlan";
import { MATERIAL_INTELLIGENCE_SCHEMA, recordMaterialSemantics, type MaterialIntelligencePacket } from "../application/materialIntelligence";
import { LONGFORM_PLAN_SET_SCHEMA_V1 } from "../application/longformPlanSetV1";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../application/motionTreatment";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyProjectCommands, createProjectFile, projectSummaryState, readProject, readStoredProject } from "./storage";
import { clipTimeRemapRenderBlockersV1 } from "../domain/clipTimeRemapCommandsV1";
import { prepareEditkinModuleV2 } from "../modules/moduleRegistryV2";
import { applyLongformPlanSetV1, auditLongformPlanSetV1 } from "./longformPlanSetToolsV1";

const temp = useTempRoots();
const APP = resolve(import.meta.dirname, "../..");
const FFMPEG = join(APP, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), FFPROBE = join(APP, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_CACHE_ROOT", "HAO_FFMPEG_PATH", "HAO_FFPROBE_PATH", "EDITKIN_GPU_COMPOSITOR_PATH"] as const;
const FPS = 30;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let workspace = "";
type Receipt = { materialId: string; sourceSha256: string; assetId: string; clipId: string; semanticReceiptSha256: string };
const receipts: Record<string, Receipt> = {};
const AESTHETIC = createAutopilotV4Fixture().commands[0] as unknown as EditorCommand;
const CHAPTERS = [
  { chapterId: "ch-1", range: { startFrame: 0, endFrame: 1800 }, clips: ["c1", "c2", "c3"] },
  { chapterId: "ch-2", range: { startFrame: 1800, endFrame: 3600 }, clips: ["c4", "c5", "c6"] },
  { chapterId: "ch-3", range: { startFrame: 3600, endFrame: 5400 }, clips: ["c7", "c8", "c9"] },
];
const CARD = { chapterNumber: "02", chapterLabel: "第二章", keyword: "實際操作" };
const evidence = (text: Record<string, string>) => Object.fromEntries(Object.keys(text).map(slot => [slot, `mi:${receipts.c4.materialId}`]));
// 30 s footage; every clip uses source 5–25 s, so each cut has 5 s handles on both sides (a matte transition needs them).
const footageClip = (id: string, timelineStart: number) => ({ id, assetId: "footage", trackId: "video-main", timelineStart, sourceStart: 5, duration: 20, volume: 1,
  transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });

/** A tool handler's MCP result, or its error as the tool reports it (status BLOCK, the refusal code first). */
async function call(run: () => Promise<{ content: Array<{ text?: string }> }>) {
  try {
    const text = (await run()).content?.[0]?.text ?? "";
    return { isError: false, body: JSON.parse(text), text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, body: { status: "BLOCK", code: /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1], error: message }, text: message };
  }
}
/** validate_project's checks (server.ts): the stored project decodes and validates, and every clip speed renders. */
async function validate(projectPath: string) {
  const stored = await readStoredProject(projectPath);
  await projectSummaryState(projectPath, stored.project, stored);
  return clipTimeRemapRenderBlockersV1(stored.project).length ? "BLOCK" : "GREEN";
}

/** A 3-minute, 3-chapter project: nine 20 s A-roll clips (640×360, 30 fps), optional extra tracks. */
async function makeProject(path: string, extraTracks: string[] = []) {
  await createProjectFile(path, "Long-form templates", 640, 360, FPS, [
    { type: "import_asset", asset: { id: "footage", name: "Footage", kind: "video", uri: "media/footage.mp4", duration: 30, width: 640, height: 360 } },
    ...extraTracks.map(id => ({ type: "add_track" as const, track: { id, name: id, kind: "video" as const, locked: false, muted: false, clips: [] } })),
    ...Array.from({ length: 9 }, (_, index) => ({ type: "add_clip" as const, clip: footageClip(`c${index + 1}`, index * 20) })),
  ] as EditorCommand[]);
}

async function prepare(projectPath: string, moduleId: string, variantId: string | undefined, inputs: Record<string, unknown>): Promise<EditorCommand[]> {
  const result = await prepareEditkinModuleV2({ projectPath, moduleId, ...(variantId ? { variantId } : {}), inputs }, { environment: process.env });
  return result.commands as EditorCommand[];
}
const card = (projectPath: string, startFrame: number, text = CARD) =>
  prepare(projectPath, "graphic.style_template", "S1_explainer_ui", { startFrame, durationFrames: 90, text, textEvidence: evidence(text) });
const mlText = (projectPath: string, startFrame: number, lines = ["第二章", "實際操作"]) =>
  prepare(projectPath, "graphic.text_motion", undefined, { startFrame, durationFrames: 60, lines, role: "chapter" });
const mlBackground = (projectPath: string, startFrame: number) => prepare(projectPath, "background.motion_loop", undefined, { startFrame, durationFrames: 90 });

async function writeChapter(tag: string, chapter: (typeof CHAPTERS)[number], commands: EditorCommand[]) {
  const plan = structuredClone(createAutopilotV4Fixture()) as unknown as Record<string, any>;
  const { startFrame, endFrame } = chapter.range, third = Math.floor((endFrame - startFrame) / 3);
  plan.editorial.narrative.beats = plan.editorial.narrative.beats.map((beat: object, index: number) => ({ ...beat,
    range: { startFrame: startFrame + index * third, endFrame: index === 2 ? endFrame : startFrame + (index + 1) * third } }));
  plan.editorial.transitions = plan.editorial.transitions.map((transition: object) => ({ ...transition, atFrame: startFrame + third }));
  plan.editorial.audio.impactFrames = [startFrame + 2 * third];
  plan.editorial.audio.breathFrames = [startFrame + third];
  plan.materialEvidence = { schema: MATERIAL_INTELLIGENCE_SCHEMA, receipts: chapter.clips.map(id => receipts[id]) };
  const all = [AESTHETIC, ...commands];
  plan.commands = all;
  plan.editorial.motionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => {
    const commandIndexes = all.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
    return commandIndexes.length ? { family, action: "use" as const, reason: "Template or Motion Library placement", beatIds: ["setup"], commandIndexes }
      : { family, action: "omit" as const, reason: "Not used in this chapter", beatIds: [], commandIndexes: [] };
  }) };
  const planPath = join(workspace, "plans", `${tag}-${chapter.chapterId}.v4.json`);
  await mkdir(join(workspace, "plans"), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan));
  return { chapterId: chapter.chapterId, range: chapter.range, planPath, planSha256: autopilotPlanSha256(parseAutopilotPlan(plan)) };
}

let setCounter = 0;
async function planSet(projectPath: string, perChapter: EditorCommand[][]) {
  const project = await readProject(projectPath), tag = `set-${(setCounter += 1)}`;
  const chapters = [];
  for (const [index, chapter] of CHAPTERS.entries()) chapters.push(await writeChapter(tag, chapter, perChapter[index] ?? []));
  return { schema: LONGFORM_PLAN_SET_SCHEMA_V1, baseProject: { id: project.id, revision: project.revision, contentSha256: sha256Canonical(project) }, chapters };
}

/** audit_longform_plan_set; the refusal code (first token) when it is not ACCEPTED. */
async function audit(projectPath: string, perChapter: EditorCommand[][]) {
  const planSetValue = await planSet(projectPath, perChapter);
  const result = await call(() => auditLongformPlanSetV1(projectPath, planSetValue));
  const refusal = result.isError || result.body?.status !== "ACCEPTED" ? String(result.body?.error ?? result.body?.code ?? result.text).split(":")[0] : undefined;
  return { planSet: planSetValue, body: result.body, refusal };
}

/** audit + apply: exactly one new revision (one Undo step in the editor), validate_project GREEN. */
async function auditAndApply(projectPath: string, perChapter: EditorCommand[][]) {
  const before = await readProject(projectPath);
  const audited = await audit(projectPath, perChapter);
  expect(audited.refusal, JSON.stringify(audited.body).slice(0, 800)).toBeUndefined();
  const applied = await call(() => applyLongformPlanSetV1(projectPath, audited.planSet, audited.body.auditReceipt));
  expect(applied.isError, applied.text.slice(0, 800)).toBe(false);
  expect(applied.body.receipt).toMatchObject({ state: "committed", projectRevisionBefore: before.revision, projectRevisionAfter: before.revision + 1 });
  expect(await validate(projectPath)).toBe("GREEN");
  return readProject(projectPath);
}

const clipsOn = (project: EditProject, trackId: string) => project.tracks.find(track => track.id === trackId)?.clips ?? [];
const addedClip = (commands: EditorCommand[]) => (commands.find(command => command.type === "add_style_template_clip" || command.type === "add_motion_library_clip") as
  Extract<EditorCommand, { type: "add_style_template_clip" | "add_motion_library_clip" }>);

beforeAll(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  workspace = await temp.create("ek-longform-tpl-");
  Object.assign(process.env, { EDITKIN_WORKSPACE: workspace, EDITKIN_CACHE_ROOT: join(workspace, "cache"), HAO_FFMPEG_PATH: FFMPEG, HAO_FFPROBE_PATH: FFPROBE });
  delete process.env.EDITKIN_GPU_COMPOSITOR_PATH;
  await mkdir(join(workspace, "media"), { recursive: true });
  const made = spawnSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=30", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p",
    join(workspace, "media", "footage.mp4")], { windowsHide: true, timeout: 120_000 });
  expect(made.status, made.stderr.toString()).toBe(0);
  // Synthetic material packets with real semantic receipts, one per A-roll clip (as longformPlanSetToolsV1.test.ts).
  await makeProject("receipts.editkin.json");
  const base = await readProject("receipts.editkin.json");
  const footage = base.assets.find(asset => asset.id === "footage")!;
  const sourceSha256 = createHash("sha256").update(await readFile(isAbsolute(footage.uri) ? footage.uri : join(workspace, footage.uri))).digest("hex");
  const cacheRoot = process.env.EDITKIN_CACHE_ROOT!;
  for (const clip of base.tracks.flatMap(track => track.clips)) {
    const materialId = createHash("sha256").update(`material:${clip.id}`).digest("hex");
    const packet: MaterialIntelligencePacket = { schema: MATERIAL_INTELLIGENCE_SCHEMA, materialId,
      source: { assetId: "footage", clipId: clip.id, sourceSha256, sourceStart: clip.sourceStart, duration: clip.duration, kind: "video", fps: FPS, hasAudio: true },
      analysis: { scene: { state: "ready", cuts: [] }, transcript: { state: "ready", cueCount: 1, cues: [{ start: 0, end: 0.5, text: `Narration over ${clip.id}` }] } },
      keyframes: [], createdAt: new Date().toISOString() };
    await mkdir(join(cacheRoot, "material-intelligence", materialId), { recursive: true });
    await writeFile(join(cacheRoot, "material-intelligence", materialId, "manifest.json"), JSON.stringify(packet));
    const semantic = await recordMaterialSemantics(cacheRoot, { materialId, sourceSha256, overallTopic: "Tutorial footage", contentType: "test", language: "zh", people: [], locations: [],
      segments: [{ start: 0, end: 0.5, summary: "Narrated step", subjects: [], actions: [], objects: [], importance: 0.5, evidenceFrameIds: [], transcriptCueIndexes: [0] }] });
    receipts[clip.id] = { materialId, sourceSha256, assetId: "footage", clipId: clip.id, semanticReceiptSha256: semantic.semanticReceiptSha256 };
  }
}, 300_000);
afterAll(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

describe("long-form plan sets with style templates and the Motion Library", { timeout: 600_000 }, () => {
  it("G1: several chapters each place on auto template tracks the base lacks (styletpl, motionlib-text)", async () => {
    const path = "g1.editkin.json";
    await makeProject(path);
    const [first, second, text2, text3] = [await card(path, 300), await card(path, 1950), await mlText(path, 2100), await mlText(path, 3700, ["第三章", "收尾"])];
    const project = await auditAndApply(path, [first, [...second, ...text2], text3]);
    expect(clipsOn(project, "styletpl").map(clip => clip.id)).toEqual([addedClip(first).clip.id, addedClip(second).clip.id]);
    expect(clipsOn(project, "motionlib-text").map(clip => clip.id)).toEqual([addedClip(text2).clip.id, addedClip(text3).clip.id]);
    expect(project.tracks.filter(track => track.id.startsWith("styletpl") || track.id.startsWith("motionlib")).map(track => track.id).sort()).toEqual(["motionlib-text", "styletpl"]);
  });

  it("G2: the same rendered card reused in a later chapter after that chapter imported another asset", async () => {
    const path = "g2.editkin.json";
    await makeProject(path, ["styletpl", "motionlib-bg"]);
    const [cardTwo, background, cardThree] = [await card(path, 1950), await mlBackground(path, 3650), await card(path, 3900)];
    expect(addedClip(cardThree).asset.id).toBe(addedClip(cardTwo).asset.id);
    const project = await auditAndApply(path, [[], cardTwo, [...background, ...cardThree]]);
    expect(clipsOn(project, "styletpl").map(clip => clip.assetId)).toEqual([addedClip(cardTwo).asset.id, addedClip(cardTwo).asset.id]);
    expect(project.assets.filter(asset => asset.id === addedClip(cardTwo).asset.id)).toHaveLength(1);
  });

  it("G3: a Motion Library transition on the chapter-boundary cut belongs to the chapter its cut opens", async () => {
    const path = "g3.editkin.json";
    await makeProject(path);
    const transition = await prepare(path, "transition.motion_pair", undefined, { fromClipId: "c3", toClipId: "c4" });
    // The cut (c4 starts at frame 1800) opens ch-2; ch-1 still may not place it.
    expect((await audit(path, [transition, [], []])).refusal).toBe("LONGFORM_SET_ENTITY_OUTSIDE_RANGE");
    const project = await auditAndApply(path, [[], transition, []]);
    const placed = project.timelineTransitions ?? [];
    expect(placed.map(item => [item.fromClipId, item.toClipId])).toEqual([["c3", "c4"]]);
    // Removing it takes its matte (and overlay) renders along, in the chapter that owns the cut.
    const renders = [placed[0].motionLibrary!.matteAssetId, ...(placed[0].motionLibrary!.overlayAssetId ? [placed[0].motionLibrary!.overlayAssetId] : [])];
    const remove = await prepare(path, "transition.motion_pair", undefined, { removeTransitionId: placed[0].id });
    expect(remove).toEqual([{ type: "delete_timeline_transition", transitionId: placed[0].id }, ...renders.map(assetId => ({ type: "delete_asset", assetId }))]);
    const removed = await auditAndApply(path, [[], remove, []]);
    expect(removed.timelineTransitions ?? []).toEqual([]);
    expect(removed.assets.map(asset => asset.id)).toEqual(["footage"]);
  });

  it("G5: a project whose layer order was set in the editor still takes later chapters' templates and captions", async () => {
    const path = "g5.editkin.json";
    await makeProject(path);
    const project = await readProject(path);
    const layers = project.tracks.filter(track => track.kind === "video").flatMap(track => track.clips.map(item => ({ kind: "clip" as const, id: item.id }))).reverse();
    await applyProjectCommands(path, [{ type: "set_unified_layer_order", expected: { projectId: project.id, revision: project.revision, updatedAt: project.updatedAt },
      order: { schema: "editkin.unified-layer-order/v1", layers } } as EditorCommand]);
    const ordered = await readProject(path);
    expect(ordered.unifiedLayerOrderV1).toBeDefined();
    const [cardOne, cardTwo] = [await card(path, 300), await card(path, 1950)];
    const caption: EditorCommand = { type: "add_caption", caption: { id: "cap-ch2", text: "第二章", start: 66, duration: 2 } };
    // An explicit order change in a later chapter is still project-wide.
    const explicit: EditorCommand = { type: "set_unified_layer_order", expected: { projectId: ordered.id, revision: ordered.revision, updatedAt: ordered.updatedAt },
      order: { schema: "editkin.unified-layer-order/v1", layers: [...layers].reverse() } } as EditorCommand;
    expect((await audit(path, [[], [explicit], []])).refusal).toBe("LONGFORM_SET_GLOBAL_SETTER_NOT_FIRST");
    const merged = await auditAndApply(path, [cardOne, [...cardTwo, caption], []]);
    const ids = merged.unifiedLayerOrderV1!.layers.map(layer => `${layer.kind}:${layer.id}`);
    expect(ids.slice(0, layers.length)).toEqual(layers.map(layer => `clip:${layer.id}`));
    expect(ids.slice(layers.length).sort()).toEqual([`clip:${addedClip(cardOne).clip.id}`, `clip:${addedClip(cardTwo).clip.id}`, "caption:cap-ch2"].sort());
  });

  it("G6: VA changes the words of a Motion Library text clip and the look of a background clip (one update each)", async () => {
    const path = "g6.editkin.json";
    await makeProject(path);
    const [text, background] = [await mlText(path, 2100), await mlBackground(path, 3700)];
    const placed = await auditAndApply(path, [[], text, background]);
    const textClip = clipsOn(placed, "motionlib-text")[0], backgroundClip = clipsOn(placed, "motionlib-bg")[0];
    await expect(prepare(path, "graphic.text_motion", undefined, { startFrame: 0, updateClipId: textClip.id, lines: ["改過的字"] })).rejects.toThrow(/MOTION_LIBRARY_PLACEMENT_INVALID/);
    await expect(prepare(path, "graphic.text_motion", undefined, { updateClipId: backgroundClip.id, lines: ["改過的字"] })).rejects.toThrow(/MOTION_LIBRARY_TARGET_INVALID/);
    const newText = await prepare(path, "graphic.text_motion", undefined, { updateClipId: textClip.id, lines: ["改過的字"] });
    const newBackground = await prepare(path, "background.motion_loop", undefined, { updateClipId: backgroundClip.id, speed: 1.5 });
    expect([...newText, ...newBackground].map(command => command.type)).toEqual(["update_motion_library_clip", "update_motion_library_clip"]);
    const updated = await auditAndApply(path, [[], newText, newBackground]);
    const textAfter = clipsOn(updated, "motionlib-text")[0], backgroundAfter = clipsOn(updated, "motionlib-bg")[0];
    expect(textAfter).toMatchObject({ id: textClip.id, timelineStart: textClip.timelineStart, duration: textClip.duration });
    expect(textAfter.assetId).not.toBe(textClip.assetId);
    expect(textAfter.motionLibrary!.params).toMatchObject({ lines: ["改過的字"] });
    expect(textAfter.motionLibrary!.itemId).toBe(textClip.motionLibrary!.itemId);
    expect(backgroundAfter).toMatchObject({ id: backgroundClip.id, timelineStart: backgroundClip.timelineStart });
    expect(backgroundAfter.motionLibrary!.params).toMatchObject({ speed: 1.5 });
  });

  it("G7: removing a template or Motion Library clip takes its render with it, unless another clip still uses it", async () => {
    const path = "g7.editkin.json";
    await makeProject(path, ["styletpl", "motionlib-bg"]);
    const [cardTwo, cardThree, background] = [await card(path, 1950), await card(path, 3900), await mlBackground(path, 3650)];
    const placed = await auditAndApply(path, [[], cardTwo, [...cardThree, ...background]]);
    const [secondCard, thirdCard] = clipsOn(placed, "styletpl"), backgroundClip = clipsOn(placed, "motionlib-bg")[0];
    const sharedAsset = secondCard.assetId;
    // Shared render: the clip goes, the asset stays for the ch-3 card. A sole render goes with its clip, even from ch-3.
    const removeSecond: EditorCommand[] = [{ type: "delete_clip", clipId: secondCard.id }];
    const removeBackground: EditorCommand[] = [{ type: "delete_clip", clipId: backgroundClip.id }, { type: "delete_asset", assetId: backgroundClip.assetId }];
    const removal = await audit(path, [[], removeSecond, removeBackground]);
    expect(removal.refusal, JSON.stringify(removal.body).slice(0, 600)).toBeUndefined();
    expect(await prepare(path, "graphic.style_template", undefined, { removeClipId: secondCard.id })).toEqual(removeSecond);
    await expect(prepare(path, "graphic.style_template", undefined, { removeClipId: secondCard.id, startFrame: 0 })).rejects.toThrow(/STYLE_TEMPLATE_PLACEMENT_INVALID/);
    expect(await prepare(path, "background.motion_loop", undefined, { removeClipId: backgroundClip.id })).toEqual(removeBackground);
    const afterFirst = await auditAndApply(path, [[], removeSecond, removeBackground]);
    expect(afterFirst.assets.map(asset => asset.id)).toContain(sharedAsset);
    expect(afterFirst.assets.map(asset => asset.id)).not.toContain(backgroundClip.assetId);
    expect(clipsOn(afterFirst, "styletpl").map(clip => clip.id)).toEqual([thirdCard.id]);
    // The last user of the render goes: so does the asset, from a later chapter.
    const removeThird = await prepare(path, "graphic.style_template", undefined, { removeClipId: thirdCard.id });
    expect(removeThird).toEqual([{ type: "delete_clip", clipId: thirdCard.id }, { type: "delete_asset", assetId: sharedAsset }]);
    const afterSecond = await auditAndApply(path, [[], [], removeThird]);
    expect(afterSecond.assets.map(asset => asset.id)).not.toContain(sharedAsset);
    expect(clipsOn(afterSecond, "styletpl")).toEqual([]);
  });
});

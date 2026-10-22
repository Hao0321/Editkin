import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { encodeProjectBytes } from "../application/projectCodec";
import { prepareMaterialIntelligence, recordMaterialSemantics } from "../application/materialIntelligence";
import { verifyCurrentAutopilotMaterialEvidence } from "../application/autopilotMaterialEvidence";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { motionPresetSeedSha256 } from "../application/motionPresetVariant";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { assertProofStillProjectV1 } from "../domain/proofStillV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { prepareOriginalElementFile } from "./motionGraphicKitTools";
import { prepareProofStillInputV1, prepareProofStillV1, registerProofStillToolsV1 } from "./proofStillToolsV1";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const temp = useTempRoots();
interface Fixture { root: string; projectPath: string; project: EditProject; shot: string; shotSha256: string; materialId: string; semanticReceiptSha256: string; cacheRoot: string }
let fixture: Fixture;

/** Owned synthetic screenshot (lavfi pattern, BT.709-tagged so its one keyframe is admitted), a project with one ordinary clip of it, and its real receipts. */
beforeAll(async () => {
  const root = await temp.create("pst-"), cacheRoot = join(root, "cache"), shot = join(root, "shots", "settings.png");
  await mkdir(join(root, "shots"), { recursive: true });
  const made = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1", "-frames:v", "1",
    "-vf", "format=rgb24,setparams=color_primaries=bt709:color_trc=bt709:colorspace=gbr:range=pc", shot], { windowsHide: true, timeout: 30000 });
  expect(made.status, made.stderr.toString()).toBe(0);
  const bytes = await readFile(shot), shotSha256 = createHash("sha256").update(bytes).digest("hex");
  const project = createEmptyProject("Proof tool", { width: 1280, height: 720, fps: 30 });
  project.assets.push({ id: "shot", name: "Settings screenshot", kind: "image", uri: shot, duration: 3, width: 640, height: 360 });
  project.tracks[0].clips.push({ id: "shot-source", assetId: "shot", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 3, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const projectPath = join(root, "proof.editkin.json");
  await writeFile(projectPath, encodeProjectBytes(project));
  const { packet } = await prepareMaterialIntelligence({ assetId: "shot", clipId: "shot-source", sourcePath: shot, sourceStart: 0, duration: 3, fps: 30, kind: "image", includeTranscript: false },
    { ffmpegPath, ffprobePath, cacheRoot, modelRoot: cacheRoot });
  expect(packet.keyframes.map(frame => frame.id)).toEqual(["kf-1"]);
  const semantic = await recordMaterialSemantics(cacheRoot, { materialId: packet.materialId, sourceSha256: shotSha256, overallTopic: "Settings page screenshot",
    contentType: "screenshot", language: "en", people: [], locations: [], segments: [{ start: 0, end: 3, summary: "The account settings page", subjects: [], actions: [], objects: [],
      importance: .8, evidenceFrameIds: ["kf-1"], transcriptCueIndexes: [] }] });
  fixture = { root, projectPath, project, shot, shotSha256, materialId: packet.materialId, semanticReceiptSha256: semantic.semanticReceiptSha256, cacheRoot };
}, 120000);
afterEach(() => { vi.unstubAllEnvs(); });
function environment() { vi.stubEnv("EDITKIN_WORKSPACE", fixture.root); vi.stubEnv("EDITKIN_CACHE_ROOT", fixture.cacheRoot); }
function request(patch: Record<string, unknown> = {}) {
  return { projectPath: fixture.projectPath, assetId: "shot", trackId: fixture.project.tracks[0].id, startFrame: 120, holdFrames: 90,
    crop: { x: 40, y: 30, width: 560, height: 315 }, redactions: [{ id: "email", rect: { x: 60, y: 50, width: 200, height: 30 }, fill: "#000000" }],
    target: { rect: { x: 300, y: 150, width: 120, height: 50 } }, confirmation: { by: "agent", note: "Email row seen in kf-1; no other personal data claimed." },
    evidence: { materialId: fixture.materialId, semanticReceiptSha256: fixture.semanticReceiptSha256, frameId: "kf-1" }, ...patch };
}
const refusal = async (patch: Record<string, unknown>) => {
  try { await prepareProofStillV1(request(patch)); } catch (error) { return (error as Error).message; }
  return "PREPARED";
};

describe("prepare_proof_still (design P4)", () => {
  it("prepares a static proof-still clip, its focus-bracket target and its evidence-bound editorial event without touching the project", async () => {
    environment();
    const before = await readFile(fixture.projectPath);
    const result = await prepareProofStillV1(request());
    expect(result).toMatchObject({ status: "PREPARED_NOT_APPLIED", schema: "editkin.proof-still-preparation/v1", readOnly: true, visualStatus: "ART_PENDING_CLAUDE",
      privacy: { redactedRegionCount: 1, regionsConfirmedBy: "agent", piiCompleteness: "NOT_ASSERTED" } });
    expect(result.proofStill).toMatchObject({ sourceSha256: fixture.shotSha256, sourceWidth: 640, sourceHeight: 360, hold: "static" });
    const [add, ...annotation] = result.commands;
    expect(add.type).toBe("add_clip");
    if (add.type !== "add_clip") throw Error("unreachable");
    expect(add.clip).toMatchObject({ id: result.clipId, assetId: "shot", timelineStart: 4, sourceStart: 0, duration: 3, volume: 1, keyframes: [], proofStill: result.proofStill, layout: result.layout });
    // Fit x2 into 1280x720: crop canvas (80,60,1120,630), contained into the full canvas.
    expect(result.layout.viewport).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(annotation.length).toBeGreaterThan(0);
    expect(annotation.every(command => command.type === "add_motion_graphic")).toBe(true);
    expect(result.target?.annotation).toBe("focus-bracket");
    expect([result.target!.outputRect.x * 1280, result.target!.outputRect.y * 720].map(v => Math.round(v * 100) / 100)).toEqual([594.29, 274.29]);
    const evidenceRef = `mi:${fixture.materialId}:${fixture.semanticReceiptSha256}:frame:kf-1`, anchorId = `${result.clipId}.target`;
    expect(result.evidenceRef).toBe(evidenceRef);
    expect(result.editorialEvent).toEqual({ id: anchorId, presetId: "reel_native_panel",
      presetVariant: { schema: "editkin.motion-preset-variant/v1", basePresetSha256: motionPresetSeedSha256(findMotionGraphicPreset("reel_native_panel")), reason: expect.any(String),
        overrides: expect.objectContaining({ vectorV2: expect.objectContaining({ schema: "editkin.motion-vector-shape/v1", kind: "shape" }) }) },
      range: { startFrame: 120, endFrame: 210 }, kind: "native_shape", purpose: "proof", message: "", evidenceRefs: [evidenceRef] });
    expect(result.target?.anchorGraphicId).toBe(anchorId);
    // The anchor is the executor's own first full-window corner layer, renamed and declared; every other layer is untouched.
    const executor = await prepareOriginalElementFile(fixture.projectPath, { elementId: "focus-bracket", startFrame: 120, durationFrames: 90, mode: "overlay",
      target: { ...result.target!.outputRect, sourceId: `proof-still:${result.clipId}` } });
    const anchorIndex = executor.commands.findIndex(command => /:focus:corner$/.test(command.graphic.id) && command.graphic.timelineStart === 4 && command.graphic.duration === 3);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    expect(annotation).toEqual(executor.commands.map((command, index) => index === anchorIndex
      ? { type: "add_motion_graphic", graphic: { ...command.graphic, id: anchorId, presetId: "reel_native_panel" } } : command));
    expect(result.materialEvidence).toEqual({ materialId: fixture.materialId, sourceSha256: fixture.shotSha256, assetId: "shot", clipId: "shot-source", semanticReceiptSha256: fixture.semanticReceiptSha256 });
    // Deterministic and read-only.
    expect((await prepareProofStillV1(request())).commands).toEqual(result.commands);
    expect(await readFile(fixture.projectPath)).toEqual(before);
    const applied = applyCommand(structuredClone(fixture.project), { type: "batch", commands: result.commands });
    expect(() => assertProofStillProjectV1(applied, new Map([[result.clipId, fixture.shotSha256]]))).not.toThrow();
  }, 120000);

  it.each([
    ["a region smaller than 4 source pixels", { redactions: [{ id: "dot", rect: { x: 10, y: 10, width: 3, height: 3 }, fill: "#000000" }] }, /^PROOF_STILL_RECT_TOO_SMALL/],
    ["a region outside the image", { redactions: [{ id: "edge", rect: { x: 600, y: 10, width: 80, height: 20 }, fill: "#000000" }] }, /^PROOF_STILL_RECT_OUT_OF_BOUNDS/],
    ["a target outside the crop", { target: { rect: { x: 610, y: 150, width: 20, height: 20 } } }, /^PROOF_STILL_TARGET_OUTSIDE_CROP/],
    ["a target that is fully redacted", { redactions: [{ id: "all", rect: { x: 290, y: 140, width: 150, height: 70 }, fill: "#000000" }] }, /^PROOF_STILL_TARGET_FULLY_REDACTED/],
    ["a target outside the focus-bracket safe area", { target: { rect: { x: 60, y: 40, width: 60, height: 20 } } }, /^PROOF_STILL_TARGET_ANNOTATION_REFUSED: TARGET_OUT_OF_SAFE/],
    ["a hold shorter than the bracket", { holdFrames: 20 }, /^PROOF_STILL_TARGET_ANNOTATION_REFUSED/],
    ["evidence that was never prepared", { evidence: { materialId: "0".repeat(64), semanticReceiptSha256: "0".repeat(64), frameId: "kf-1" } }, /^PROOF_STILL_EVIDENCE_INVALID/],
    ["an unknown asset", { assetId: "missing" }, /^PROOF_STILL_ASSET_MISSING/],
    ["an unknown track", { trackId: "missing" }, /^PROOF_STILL_TRACK_INVALID/],
  ])("refuses %s", async (_label, patch, expected) => {
    environment();
    expect(await refusal(patch)).toMatch(expected);
  }, 60000);

  it("refuses evidence that is not this image's own viewed frame, and a changed source", async () => {
    environment();
    expect(await refusal({ evidence: { materialId: fixture.materialId, semanticReceiptSha256: fixture.semanticReceiptSha256, frameId: "kf-2" } }))
      .toMatch(/^PROOF_STILL_EVIDENCE_INVALID: the frame was not decoded/);
    const original = await readFile(fixture.shot);
    try {
      await writeFile(fixture.shot, Buffer.concat([original, Buffer.from("changed after analysis")]));
      expect(await refusal({})).toMatch(/^PROOF_STILL_EVIDENCE_INVALID: the material receipt is not this image's current bytes/);
    } finally { await writeFile(fixture.shot, original); }
  }, 60000);

  it("registers one read-only tool whose input schema stays portable", () => {
    const tools = new Map<string, { inputSchema: z.ZodType; annotations: Record<string, boolean> }>();
    registerProofStillToolsV1({ registerTool: (name: string, configuration: never) => { tools.set(name, configuration); } } as never);
    expect([...tools.keys()]).toEqual(["prepare_proof_still"]);
    expect(tools.get("prepare_proof_still")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(() => z.toJSONSchema(prepareProofStillInputV1, { io: "input" })).not.toThrow();
    // `<clipId>.target` must stay inside the 80-character editorial id grammar.
    expect(prepareProofStillInputV1.safeParse(request({ clipId: "p".repeat(73) })).success).toBe(true);
    expect(prepareProofStillInputV1.safeParse(request({ clipId: "p".repeat(74) })).success).toBe(false);
  });
});

describe("audit admits a proof still only with its own image receipt (design P5)", () => {
  async function verify(commands: readonly EditorCommand[], graphics: Parameters<typeof verifyCurrentAutopilotMaterialEvidence>[3],
    receipt = { materialId: fixture.materialId, sourceSha256: fixture.shotSha256, assetId: "shot", clipId: "shot-source", semanticReceiptSha256: fixture.semanticReceiptSha256 }) {
    return verifyCurrentAutopilotMaterialEvidence({ schema: "hao.editkin.material-intelligence/v1", receipts: [receipt] }, structuredClone(fixture.project),
      { cacheRoot: fixture.cacheRoot, resolveSource: async () => fixture.shot }, graphics, undefined, undefined, commands);
  }
  it("accepts the prepared commands with their event, and refuses a missing event, an uncited frame or a different source", async () => {
    environment();
    const prepared = await prepareProofStillV1(request());
    const event = { ...prepared.editorialEvent!, evidenceRefs: [...prepared.editorialEvent!.evidenceRefs] };
    await expect(verify(prepared.commands, [event])).resolves.toMatchObject({ receiptCount: 1 });
    await expect(verify(prepared.commands, [])).rejects.toThrow(/^PROOF_STILL_EVENT_MISSING/);
    await expect(verify(prepared.commands, [{ ...event, evidenceRefs: ["screen:settings"] }])).rejects.toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
    await expect(verify(prepared.commands, [{ ...event, evidenceRefs: [`mi:${fixture.materialId}:${fixture.semanticReceiptSha256}:frame:kf-2`] }]))
      .rejects.toThrow(/^PROOF_STILL_EVENT_FRAME_UNCITED/);
    const otherSource = structuredClone(prepared.commands);
    if (otherSource[0].type !== "add_clip") throw Error("unreachable");
    otherSource[0].clip.proofStill!.sourceSha256 = "9".repeat(64);
    await expect(verify(otherSource, [event])).rejects.toThrow(/^PROOF_STILL_EVIDENCE_MISSING/);
    // Plans without proof stills are unaffected.
    await expect(verify([], [])).resolves.toMatchObject({ receiptCount: 1 });
    // A still without a target is not annotated, so it has no event; its own image receipt still decides.
    const plain = await prepareProofStillV1(request({ target: undefined }));
    expect(plain.editorialEvent).toBeNull();
    expect(plain.evidenceRef).toBe(event.evidenceRefs[0]);
    await expect(verify(plain.commands, [])).resolves.toMatchObject({ receiptCount: 1 });
  }, 120000);
});

describe("prepare_proof_still accepts real-world screenshot files (untagged / sRGB PNG, JPEG, WebP)", () => {
  it.each([
    ["untagged PNG", "png", ["-vf", "format=rgb24"], "srgb_assumed_untagged_image"],
    ["sRGB-tagged PNG", "png", ["-vf", "format=rgb24,setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr:range=pc"], "srgb_tagged"],
    ["JPEG", "jpg", ["-q:v", "2"], "srgb_assumed_untagged_image"],
    ["WebP", "webp", ["-c:v", "libwebp", "-lossless", "0", "-q:v", "90"], "srgb_assumed_untagged_image"],
  ])("%s: one keyframe at t=0, then a prepared proof still", async (label, extension, encode, colorInterpretation) => {
    const root = await temp.create("psr-"), cacheRoot = join(root, "cache"), shot = join(root, `screen.${extension}`);
    const made = spawnSync(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1", "-frames:v", "1", ...encode, shot], { windowsHide: true, timeout: 30000 });
    expect(made.status, made.stderr.toString()).toBe(0);
    const sha = createHash("sha256").update(await readFile(shot)).digest("hex");
    const project = createEmptyProject(`Screenshot ${label}`, { width: 1280, height: 720, fps: 30 });
    project.assets.push({ id: "shot", name: label, kind: "image", uri: shot, duration: 3, width: 640, height: 360 });
    project.tracks[0].clips.push({ id: "shot-source", assetId: "shot", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 3, volume: 0,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
    const projectPath = join(root, "screen.editkin.json");
    await writeFile(projectPath, encodeProjectBytes(project));
    const { packet } = await prepareMaterialIntelligence({ assetId: "shot", clipId: "shot-source", sourcePath: shot, sourceStart: 0, duration: 3, fps: 30, kind: "image", includeTranscript: false },
      { ffmpegPath, ffprobePath, cacheRoot, modelRoot: cacheRoot });
    expect(packet.keyframes.map(frame => [frame.id, frame.time])).toEqual([["kf-1", 0]]);
    expect(packet.keyframes[0].display?.normalization).toMatchObject({ interpretation: "srgb", colorInterpretation });
    const semantic = await recordMaterialSemantics(cacheRoot, { materialId: packet.materialId, sourceSha256: sha, overallTopic: "Settings screenshot", contentType: "screenshot",
      language: "en", people: [], locations: [], segments: [{ start: 0, end: 3, summary: "Settings page", subjects: [], actions: [], objects: [], importance: .7, evidenceFrameIds: ["kf-1"], transcriptCueIndexes: [] }] });
    vi.stubEnv("EDITKIN_WORKSPACE", root); vi.stubEnv("EDITKIN_CACHE_ROOT", cacheRoot);
    const result = await prepareProofStillV1({ ...request(), projectPath, trackId: project.tracks[0].id,
      evidence: { materialId: packet.materialId, semanticReceiptSha256: semantic.semanticReceiptSha256, frameId: "kf-1" } });
    expect(result.status).toBe("PREPARED_NOT_APPLIED");
    expect(result.proofStill).toMatchObject({ sourceSha256: sha, sourceWidth: 640, sourceHeight: 360 });
    expect(result.editorialEvent?.evidenceRefs).toEqual([`mi:${packet.materialId}:${semantic.semanticReceiptSha256}:frame:kf-1`]);
  }, 120000);
});

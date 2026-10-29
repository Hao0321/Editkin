import type { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import { readMaterialIntelligence, verifyMaterialSemanticsReceipt } from "../application/materialIntelligence";
import { assertMotionPresetVariantBinding, motionPresetSeedSha256 } from "../application/motionPresetVariant";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import {
  assertProofStillClipV1, assertProofStillProjectV1, parseProofStillV1, proofStillConfirmationV1Schema, proofStillDefaultLayoutV1,
  proofStillEvidenceReferenceV1, proofStillOutputRectV1, proofStillRectV1Schema, proofStillRedactionV1Schema, proofStillTargetEventIdV1,
  PROOF_STILL_V1_CLIP_ID, PROOF_STILL_V1_MAX_REDACTIONS, PROOF_STILL_V1_SCHEMA, PROOF_STILL_V1_SOURCE_EXTENSIONS, ProofStillErrorV1, type ProofStillV1,
} from "../domain/proofStillV1";
import { motionPresetOverridesSchema, type MotionPresetVariant } from "../domain/schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type MotionGraphic, type TimelineClip } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { probeMedia } from "../render/mediaProcess";
import { prepareOriginalElementFile } from "./motionGraphicKitTools";
import { readProject, resolveWorkspaceMediaPath, workspaceRoot } from "./storage";
import { errorResult, textResult } from "./toolRuntime";

export const PROOF_STILL_TOOL_V1 = "prepare_proof_still" as const;
export const PROOF_STILL_PREPARATION_SCHEMA_V1 = "editkin.proof-still-preparation/v1" as const;
export const PROOF_STILL_RESPONSE_BYTES_V1 = 256 * 1024;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const projectId = z.string().min(1).max(160).refine(value => value === value.trim() && !/[\u0000\r\n]/.test(value));
// `<clipId>.target` is the target event id, so the clip id keeps the editorial id grammar with room for the suffix.
const clipIdSchema = z.string().regex(PROOF_STILL_V1_CLIP_ID);
/** The registered seed the focus-bracket compiler builds every vector layer from (it then drops the preset id). */
const TARGET_ANCHOR_PRESET_ID = "reel_native_panel";

export const prepareProofStillInputV1 = z.strictObject({
  projectPath: z.string().min(1).max(1024),
  assetId: projectId,
  clipId: clipIdSchema.optional(),
  trackId: projectId,
  startFrame: z.number().int().nonnegative().max(10_000_000),
  holdFrames: z.number().int().min(1).max(36_000),
  crop: proofStillRectV1Schema,
  redactions: z.array(proofStillRedactionV1Schema).max(PROOF_STILL_V1_MAX_REDACTIONS),
  target: z.strictObject({ rect: proofStillRectV1Schema, label: z.string().min(1).max(14).optional() }).optional(),
  confirmation: proofStillConfirmationV1Schema,
  /** The still's own image material receipt and the keyframe that was actually viewed. */
  evidence: z.strictObject({ materialId: sha, semanticReceiptSha256: sha, frameId: z.string().regex(/^kf-(?:[1-9]|1[0-2])$/) }),
});
export type PrepareProofStillInputV1 = z.infer<typeof prepareProofStillInputV1>;

export interface ProofStillToolDependenciesV1 {
  readProject: (projectPath: string) => Promise<EditProject>;
  resolveSource: (asset: MediaAsset) => Promise<string>;
  hashFile: (path: string) => Promise<string>;
  probe: typeof probeMedia;
  materialCacheRoot: () => string;
  readMaterial: typeof readMaterialIntelligence;
  verifySemantics: typeof verifyMaterialSemanticsReceipt;
  /** The existing focus-bracket executor (prepare_original_element). */
  prepareTargetAnnotation: typeof prepareOriginalElementFile;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function proofStillToolDependenciesV1(): ProofStillToolDependenciesV1 {
  return {
    readProject,
    resolveSource: asset => resolveWorkspaceMediaPath(asset.uri.startsWith("file:") ? fileURLToPath(asset.uri) : asset.uri),
    hashFile: sha256File,
    probe: probeMedia,
    materialCacheRoot: () => process.env.EDITKIN_CACHE_ROOT ?? resolve(process.env.EDITKIN_MODEL_ROOT ?? resolve(workspaceRoot(), ".editkin-models"), "../media-cache"),
    readMaterial: readMaterialIntelligence,
    verifySemantics: verifyMaterialSemanticsReceipt,
    prepareTargetAnnotation: prepareOriginalElementFile,
  };
}

const refuse = (code: string, detail: string): never => { throw new Error(`${code}: ${detail}`); };
const clipsOf = (project: EditProject) => [project, ...project.compositions].flatMap(owner => owner.tracks.flatMap(track => track.clips));

/**
 * The v4 plan executes every editorial graphics event with one preset-bound motion graphic of the same id
 * (an original vector shape binds as `native_shape` with a declared preset variant). The focus-bracket is many
 * preset-less layers, so its anchor corner, the first corner layer spanning the whole bracket window, becomes the
 * target event's graphic: same layer, renamed to the event id and declared as what it is, the registered seed plus
 * the compiler's own values. Nothing about it is redrawn; anything the variant contract cannot state is refused.
 */
function bindTargetAnchorV1(commands: EditorCommand[], eventId: string, window: { startFrame: number; durationFrames: number }, fps: number) {
  const index = commands.findIndex(command => command.type === "add_motion_graphic" && /:focus:corner$/.test(command.graphic.id)
    && Math.abs(command.graphic.timelineStart * fps - window.startFrame) < 1e-6 && Math.abs(command.graphic.duration * fps - window.durationFrames) < 1e-6);
  const anchor = commands[index];
  if (!anchor || anchor.type !== "add_motion_graphic") return refuse("PROOF_STILL_TARGET_ANNOTATION_REFUSED", "the focus-bracket has no anchor corner spanning its whole window");
  const preset = findMotionGraphicPreset(TARGET_ANCHOR_PRESET_ID);
  const graphic: MotionGraphic = { ...structuredClone(anchor.graphic), id: eventId, presetId: preset.id };
  const stock = createMotionGraphic(eventId, preset.seed.kind ?? "card", graphic.text, graphic.timelineStart, graphic.duration, undefined, preset.seed) as unknown as Record<string, unknown>;
  const actual = graphic as unknown as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(stock), ...Object.keys(actual)])]
    .filter(key => !["id", "text", "timelineStart", "duration"].includes(key) && !isDeepStrictEqual(actual[key], stock[key]));
  const overrides = Object.fromEntries(changed.map(key => [key, actual[key]])) as MotionPresetVariant["overrides"];
  const presetVariant: MotionPresetVariant = { schema: "editkin.motion-preset-variant/v1", basePresetSha256: motionPresetSeedSha256(preset),
    reason: "Proof-still target: the focus-bracket's anchor corner over the target observed in the still's viewed frame", overrides };
  try {
    if (changed.some(key => actual[key] === undefined) || !motionPresetOverridesSchema.safeParse(overrides).success) throw Error(`undeclarable fields: ${changed.join(", ")}`);
    assertMotionPresetVariantBinding(graphic, preset.id, presetVariant);
    assertMotionGraphicV2Contract(graphic, fps);
  } catch (error) { return refuse("PROOF_STILL_TARGET_ANNOTATION_REFUSED", `anchor corner: ${error instanceof Error ? error.message : String(error)}`); }
  commands[index] = { type: "add_motion_graphic", graphic };
  return { presetId: preset.id, presetVariant };
}

/**
 * Read-only: builds one static proof-still clip and its target annotation from
 * source-pixel regions on a real image asset, bound to that image's viewed
 * material frame. Nothing is applied or rendered here, no personal-data
 * completeness is claimed, and the visual result stays ART_PENDING_CLAUDE.
 */
export async function prepareProofStillV1(value: unknown, dependencies: ProofStillToolDependenciesV1 = proofStillToolDependenciesV1()) {
  const input = prepareProofStillInputV1.parse(value);
  const project = await dependencies.readProject(input.projectPath);
  const asset = project.assets.find(candidate => candidate.id === input.assetId);
  if (!asset) throw new ProofStillErrorV1("PROOF_STILL_ASSET_MISSING", input.assetId);
  if (asset.kind !== "image" || asset.compositionId || asset.imageSequence) throw new ProofStillErrorV1("PROOF_STILL_ASSET_NOT_IMAGE", asset.id);
  if (!PROOF_STILL_V1_SOURCE_EXTENSIONS.some(extension => asset.uri.toLowerCase().split(/[?#]/, 1)[0]!.endsWith(extension))) {
    throw new ProofStillErrorV1("PROOF_STILL_SOURCE_FORMAT_UNSUPPORTED", asset.id);
  }
  const track = project.tracks.find(candidate => candidate.id === input.trackId);
  if (!track || track.kind !== "video" || track.locked) refuse("PROOF_STILL_TRACK_INVALID", "an existing, unlocked root video track is required");
  if (!Number.isFinite(project.fps) || project.fps <= 0) refuse("PROOF_STILL_PROJECT_INVALID", "project fps");

  // Actual current bytes and raster: the proof binds what will really be decoded.
  const sourcePath = await dependencies.resolveSource(asset);
  const sourceSha256 = await dependencies.hashFile(sourcePath);
  const probe = await dependencies.probe(sourcePath);
  if (!probe.hasVideo || !["png", "mjpeg", "webp"].includes(probe.codecName ?? "") || !Number.isSafeInteger(probe.width) || !Number.isSafeInteger(probe.height)) {
    throw new ProofStillErrorV1("PROOF_STILL_SOURCE_FORMAT_UNSUPPORTED", "a single PNG, JPEG or WebP still is required");
  }
  if ((probe.displayRotationDegrees ?? 0) % 360 !== 0 || (probe.sampleAspectRatio !== undefined && probe.sampleAspectRatio !== 1)) {
    throw new ProofStillErrorV1("PROOF_STILL_SOURCE_GEOMETRY_UNSUPPORTED", "rotated or non-square-pixel still");
  }
  const proof: ProofStillV1 = parseProofStillV1({
    schema: PROOF_STILL_V1_SCHEMA, sourceSha256, sourceWidth: probe.width, sourceHeight: probe.height,
    crop: input.crop, redactions: input.redactions, ...(input.target ? { target: { rect: input.target.rect } } : {}),
    hold: "static", confirmation: input.confirmation,
  });

  // The still's own image receipt: same asset bytes, a decoded keyframe, cited by the recorded semantics.
  const cacheRoot = dependencies.materialCacheRoot();
  let packet: Awaited<ReturnType<typeof readMaterialIntelligence>>, semantic: Awaited<ReturnType<typeof verifyMaterialSemanticsReceipt>>;
  try {
    packet = await dependencies.readMaterial(cacheRoot, input.evidence.materialId);
    semantic = await dependencies.verifySemantics(cacheRoot, input.evidence.materialId, input.evidence.semanticReceiptSha256);
  } catch (error) { return refuse("PROOF_STILL_EVIDENCE_INVALID", error instanceof Error ? error.message : String(error)); }
  if (packet.source.kind !== "image" || packet.source.assetId !== asset.id || packet.source.sourceSha256 !== sourceSha256 || semantic.sourceSha256 !== sourceSha256) {
    refuse("PROOF_STILL_EVIDENCE_INVALID", "the material receipt is not this image's current bytes");
  }
  if (!clipsOf(project).some(clip => clip.id === packet.source.clipId && clip.assetId === asset.id)) refuse("PROOF_STILL_EVIDENCE_INVALID", "the receipt's clip is not in this project");
  if (!packet.keyframes.some(frame => frame.id === input.evidence.frameId)
    || !semantic.segments.some(segment => segment.evidenceFrameIds.includes(input.evidence.frameId))) {
    refuse("PROOF_STILL_EVIDENCE_INVALID", "the frame was not decoded and cited by the recorded semantics");
  }

  const canvas = { width: project.width, height: project.height };
  const layout = proofStillDefaultLayoutV1(proof, canvas);
  const clipId = input.clipId ?? `proof-${createHash("sha256").update(JSON.stringify([asset.id, sourceSha256, input.startFrame, input.holdFrames, proof.crop, proof.redactions, proof.target ?? null])).digest("hex").slice(0, 12)}`;
  const targetEventId = proofStillTargetEventIdV1(clipId);
  if (clipsOf(project).some(clip => clip.id === clipId) || project.motionGraphics.some(graphic => graphic.id === clipId || graphic.id === targetEventId)) refuse("PROOF_STILL_CLIP_ID_TAKEN", clipId);
  // An image has no audio. The neutral volume keeps this clip out of the plan's "sound" treatment family.
  const clip: TimelineClip = { id: clipId, assetId: asset.id, trackId: input.trackId, timelineStart: input.startFrame / project.fps, sourceStart: 0,
    duration: input.holdFrames / project.fps, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layout, proofStill: proof };
  assertProofStillClipV1(clip, { asset, canvas, actualSourceSha256: sourceSha256 });

  const evidenceRef = proofStillEvidenceReferenceV1(input.evidence.materialId, input.evidence.semanticReceiptSha256, input.evidence.frameId);
  let annotation: { commands: EditorCommand[]; timeline: unknown; schema: string; outputRect: { x: number; y: number; w: number; h: number }; durationFrames: number } | undefined;
  if (proof.target) {
    const rect = proofStillOutputRectV1(proof, proof.target.rect, layout, canvas);
    const durationFrames = Math.min(input.holdFrames, 600, Math.floor(20 * project.fps));
    if (durationFrames < 30) refuse("PROOF_STILL_TARGET_ANNOTATION_REFUSED", "the hold is shorter than the focus-bracket's 30-frame minimum");
    const outputRect = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    try {
      const prepared = await dependencies.prepareTargetAnnotation(input.projectPath, { elementId: "focus-bracket", startFrame: input.startFrame, durationFrames,
        mode: "overlay", ...(input.target?.label ? { title: input.target.label } : {}), target: { ...outputRect, sourceId: `proof-still:${clipId}` } });
      annotation = { commands: prepared.commands, timeline: prepared.timeline, schema: prepared.schema, outputRect, durationFrames };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "EXECUTOR";
      refuse("PROOF_STILL_TARGET_ANNOTATION_REFUSED", `${code}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Only the target is visibly annotated, so only it has an editorial event; it cites the viewed frame (design P5).
  const editorialEvent = annotation ? {
    id: targetEventId, ...bindTargetAnchorV1(annotation.commands, targetEventId, { startFrame: input.startFrame, durationFrames: annotation.durationFrames }, project.fps),
    range: { startFrame: input.startFrame, endFrame: input.startFrame + annotation.durationFrames },
    kind: "native_shape" as const, purpose: "proof" as const, message: "", evidenceRefs: [evidenceRef],
  } : null;

  const commands: EditorCommand[] = [{ type: "add_clip", clip }, ...(annotation?.commands ?? [])];
  let candidate: EditProject;
  try { candidate = applyCommand(structuredClone(project), { type: "batch", commands: structuredClone(commands) }); }
  catch (error) { return refuse("PROOF_STILL_COMMANDS_INVALID", error instanceof Error ? error.message : String(error)); }
  assertProofStillProjectV1(candidate, new Map([[clipId, sourceSha256]]));

  return {
    status: "PREPARED_NOT_APPLIED" as const, schema: PROOF_STILL_PREPARATION_SCHEMA_V1, projectRevision: project.revision, readOnly: true as const,
    clipId, proofStill: proof, layout, commands, editorialEvent, evidenceRef,
    materialEvidence: { materialId: input.evidence.materialId, sourceSha256, assetId: asset.id, clipId: packet.source.clipId, semanticReceiptSha256: input.evidence.semanticReceiptSha256 },
    target: annotation ? { annotation: "focus-bracket", executorSchema: annotation.schema, anchorGraphicId: targetEventId, outputRect: annotation.outputRect, timeline: annotation.timeline,
      alignment: "output-space; re-run after any crop or canvas change" } : null,
    privacy: { redactedRegionCount: proof.redactions.length, regionsConfirmedBy: proof.confirmation.by, piiCompleteness: "NOT_ASSERTED" as const,
      redaction: "solid fill drawn at render time in source pixels; the original file is never rewritten",
      rawSurfaces: "editor thumbnails, scopes, proxies and material keyframes stay unredacted" },
    visualStatus: "ART_PENDING_CLAUDE" as const,
    next: "Put the commands, the editorialEvent (when there is a target) and this materialEvidence receipt in one v4 plan; cite evidenceRef in the beat that shows the proof; "
      + "declare these commands' motionTreatment families; then audit/apply and render through render_project.",
  };
}

function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > PROOF_STILL_RESPONSE_BYTES_V1) throw Error("PROOF_STILL_RESPONSE_BUDGET: reduce the redactions or the hold");
  return textResult(value);
}

export function registerProofStillToolsV1(server: McpServer, dependencies?: ProofStillToolDependenciesV1) {
  server.registerTool(PROOF_STILL_TOOL_V1, {
    description: "唯讀準備 M107 截圖證據靜止鏡頭（editkin.proof-still/v1）：以真實 PNG／JPEG／WebP 圖片素材的原始像素座標指定裁切、最多32個純色遮蔽區與可選目標框，"
      + "綁定該圖片自己的素材分析收據與實際看過的關鍵幀。回傳 add_clip（靜態、衍生 layout）、既有 focus-bracket 目標框 commands、"
      + "有目標框時的目標 editorial 事件（native_shape，由框選的錨點框角執行，id 為 <clipId>.target）與要引用的 evidenceRef；"
      + "遮蔽只在輸出時以原始像素純色繪製，原檔永不改寫，非 FFmpeg 的輸出路徑會拒絕。本工具不修改專案、不宣稱已找出所有個資，美術結果為 ART_PENDING_CLAUDE。",
    inputSchema: prepareProofStillInputV1,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { return bounded(await prepareProofStillV1(input, dependencies)); }
    catch (error) { return errorResult(error); }
  });
}

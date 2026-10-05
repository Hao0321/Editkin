import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import * as z from "zod/v4";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { validateProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import type { EditProject, MediaAsset } from "../domain/types";
import type { MediaProbe } from "../render/ffmpegContracts";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { sha256Canonical } from "./autopilotInvocationIdentity";
import { inspectMedia } from "./inspectMedia";
import { planTimelineAssetInsert } from "./timelinePlacement";

const identifier = z.string().trim().min(1).max(160);
const frame = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mediaBootstrapRightsSchema = z.strictObject({
  provenance: z.string().trim().min(1).max(1_000),
  rightsBasis: z.string().trim().min(1).max(2_000).optional(),
  distributionScope: z.string().trim().min(1).max(1_000).optional(),
  license: z.string().trim().min(1).max(1_000).optional(),
});

/** Only source and placement intent; caller-authored visual commands are forbidden. */
export const mediaBootstrapRequestSchema = z.strictObject({
  sourcePath: z.string().min(1).max(32_768),
  assetId: identifier,
  clipId: identifier,
  trackId: identifier,
  timelineStartFrame: frame,
  sourceStartFrame: frame,
  durationFrames: frame.min(1),
  // Source interpretation declaration, never a colour grade or verified colour observation.
  sourceColorInterpretation: z.enum(["auto", "rec709"]).default("auto"),
  rights: mediaBootstrapRightsSchema.optional(),
});
export type MediaBootstrapRequest = z.input<typeof mediaBootstrapRequestSchema>;

export interface MediaBootstrapRuntime {
  workspaceRoot: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  /** Actual current parsed project readback, not a caller-supplied epoch token. */
  readCurrentProject: () => Promise<EditProject>;
}

export interface MediaBootstrapDependencies {
  inspect: typeof inspectMedia;
  hashFile: (path: string) => Promise<string>;
  now: () => Date;
}

interface SourceStat {
  dev: number;
  ino: number;
  bytes: number;
  mtimeMs: number;
  ctimeMs: number;
}
interface SourceObservation {
  path: string;
  sha256: string;
  stat: SourceStat;
}

export interface MediaBootstrapPreparation {
  status: "PREPARED_NOT_APPLIED";
  readOnly: true;
  commands: EditorCommand[];
  binding: {
    schema: "editkin.media-bootstrap-binding/v1";
    project: { id: string; revision: number; sha256: string };
    source: { path: string; bytes: number; sha256: string };
    sourceWindow: { sourceStart: number; duration: number; startFrame: number; durationFrames: number; fps: number };
    sourceColorInterpretation: { value: "auto" | "rec709"; declaration: "CALLER_SOURCE_INTERPRETATION_NOT_COLOR_VERIFIED" };
    requestedTrackId: string;
    actualTrackId: string;
    clipId: string;
    assetId: string;
  };
  probe: MediaProbe;
  sourceObservation: { before: SourceStat; after: SourceStat };
  rights: {
    state: "CALLER_DECLARED_NOT_VERIFIED";
    declaration?: z.infer<typeof mediaBootstrapRightsSchema>;
  };
  warnings: string[];
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const block of createReadStream(path)) digest.update(block);
  return digest.digest("hex");
}
const productionDependencies: MediaBootstrapDependencies = { inspect: inspectMedia, hashFile, now: () => new Date() };

function assertWithin(root: string, path: string): void {
  const relation = relative(root, path);
  if (!relation || relation === ".." || relation.startsWith("../") || relation.startsWith("..\\") || isAbsolute(relation)) {
    throw new Error("素材來源超出目前 workspace");
  }
}

async function sourceStat(path: string): Promise<SourceStat> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
    throw new Error("素材來源必須是真實、非連結、非空的本機 regular file");
  }
  return { dev: stat.dev, ino: stat.ino, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

async function observeSource(input: string, rootInput: string, dependencies: MediaBootstrapDependencies): Promise<SourceObservation> {
  assertLocalMediaPath(input);
  if (!isAbsolute(input) || !input.trim()) throw new Error("素材來源必須是本機絕對路徑");
  assertLocalMediaPath(rootInput);
  const lexical = resolve(input), lexicalRoot = resolve(rootInput), root = await realpath(lexicalRoot);
  assertLocalMediaPath(root);
  assertWithin(lexicalRoot, lexical);
  // Leaf links are rejected before following them. Parent junctions cannot escape the canonical root.
  await sourceStat(lexical);
  const path = await realpath(lexical);
  assertLocalMediaPath(path);
  assertWithin(root, path);
  const before = await sourceStat(path), sha256 = await dependencies.hashFile(path), after = await sourceStat(path);
  if (!/^[a-f0-9]{64}$/.test(sha256) || sha256Canonical(before) !== sha256Canonical(after)
    || await realpath(lexical) !== path) throw new Error("素材來源在 SHA-256 讀取期間改變");
  return { path, sha256, stat: after };
}

function flatCommands(command: EditorCommand): EditorCommand[] {
  return command.type === "batch" ? command.commands.flatMap(flatCommands) : [command];
}

/**
 * Prepare ordinary single-file video/audio imports without project/cache writes.
 * A measured source identity is not legal rights verification or an apply lease.
 */
export async function prepareMediaBootstrap(
  project: EditProject,
  request: MediaBootstrapRequest,
  runtime: MediaBootstrapRuntime,
  overrides: Partial<MediaBootstrapDependencies> = {},
): Promise<MediaBootstrapPreparation> {
  const intent = mediaBootstrapRequestSchema.parse(request), dependencies = { ...productionDependencies, ...overrides };
  runtime.signal?.throwIfAborted();
  // A manifest digest alone cannot bind every frame of a multi-file sequence.
  if (extname(intent.sourcePath).toLowerCase() === ".json") throw new Error("此 ingress 僅接受單檔影片／音訊，不接受序列 manifest");
  const projectBefore = structuredClone(project), projectSha256 = sha256Canonical(projectBefore);
  validateProject(projectBefore);
  if (!Number.isFinite(projectBefore.fps) || projectBefore.fps <= 0 || projectBefore.fps > 240) throw new Error("目前專案 fps 不合法");
  if (projectBefore.assets.some(asset => asset.id === intent.assetId)) throw new Error("匯入素材 ID 已存在");
  if (projectBefore.tracks.some(track => track.clips.some(clip => clip.id === intent.clipId))) throw new Error("匯入片段 ID 已存在");
  if (!Number.isSafeInteger(intent.sourceStartFrame + intent.durationFrames)
    || !Number.isSafeInteger(intent.timelineStartFrame + intent.durationFrames)) throw new Error("來源或落點影格總和超出安全範圍");
  const before = await observeSource(intent.sourcePath, runtime.workspaceRoot, dependencies);
  runtime.signal?.throwIfAborted();
  const probe = structuredClone(await dependencies.inspect(before.path, runtime.ffprobePath));
  runtime.signal?.throwIfAborted();
  if (probe.imageSequence || !Number.isFinite(probe.duration) || probe.duration <= 0
    || typeof probe.hasVideo !== "boolean" || typeof probe.hasAudio !== "boolean" || (!probe.hasVideo && !probe.hasAudio)) {
    throw new Error("探測未提供有效的單檔影片／音訊來源");
  }
  if (probe.hasVideo && (!Number.isSafeInteger(probe.width) || !Number.isSafeInteger(probe.height)
    || probe.width! <= 0 || probe.height! <= 0)) throw new Error("影片未提供有效的真展示尺寸");
  if (probe.displayAspectRatio !== undefined && (!Number.isFinite(probe.displayAspectRatio) || probe.displayAspectRatio <= 0)) {
    throw new Error("探測展示比例不合法");
  }
  const sourceStart = intent.sourceStartFrame / projectBefore.fps, duration = intent.durationFrames / projectBefore.fps;
  if (sourceStart + duration > probe.duration + 1e-6) throw new Error("指定來源窗口超過實際探測時長");
  const generatedAt = dependencies.now().toISOString();
  const asset: MediaAsset = {
    id: intent.assetId, name: basename(before.path), kind: probe.hasVideo ? "video" : "audio", uri: before.path,
    duration: probe.duration,
    ...(probe.hasVideo ? { width: probe.width, height: probe.height,
      ...(probe.displayAspectRatio === undefined ? {} : { displayAspectRatio: probe.displayAspectRatio }),
      color: { interpretation: intent.sourceColorInterpretation, primaries: probe.colorPrimaries, transfer: probe.colorTransfer,
        matrix: probe.colorMatrix, range: probe.colorRange } } : {}),
    role: "primary-source", derivatives: { sourceSha256: before.sha256, generatedAt },
    ...(intent.rights ?? {}),
  };
  const imported = editorCommandSchema.parse({ type: "import_asset", asset });
  const draft = applyCommand(projectBefore, imported);
  // The planner sees the true full asset and the explicit window before checking collisions.
  const plan = planTimelineAssetInsert(draft, asset.id, intent.trackId, intent.timelineStartFrame / draft.fps, intent.clipId,
    prefix => `${prefix}-bootstrap-${intent.clipId}`, { sourceStart, duration });
  const commands = [imported, ...flatCommands(plan.command)].map(command => editorCommandSchema.parse(command));
  let validated = projectBefore;
  for (const command of commands) validated = applyCommand(validated, command);
  validateProject(validated);
  runtime.signal?.throwIfAborted();
  const current = await runtime.readCurrentProject();
  runtime.signal?.throwIfAborted();
  if (sha256Canonical(project) !== projectSha256 || sha256Canonical(current) !== projectSha256) throw new Error("目前專案在素材準備期間改變");
  // The final source observation follows every other asynchronous preparation callback.
  // This remains an optimistic preparation snapshot, never an atomic apply lease.
  const after = await observeSource(intent.sourcePath, runtime.workspaceRoot, dependencies);
  runtime.signal?.throwIfAborted();
  if (sha256Canonical(before) !== sha256Canonical(after)) throw new Error("素材來源在探測／準備期間改變");
  if (sha256Canonical(project) !== projectSha256 || sha256Canonical(current) !== projectSha256) throw new Error("目前專案在素材準備期間改變");
  return {
    status: "PREPARED_NOT_APPLIED", readOnly: true, commands,
    binding: { schema: "editkin.media-bootstrap-binding/v1",
      project: { id: projectBefore.id, revision: projectBefore.revision, sha256: projectSha256 },
      source: { path: before.path, bytes: before.stat.bytes, sha256: before.sha256 },
      sourceWindow: { sourceStart, duration, startFrame: intent.sourceStartFrame, durationFrames: intent.durationFrames, fps: projectBefore.fps },
      sourceColorInterpretation: { value: intent.sourceColorInterpretation, declaration: "CALLER_SOURCE_INTERPRETATION_NOT_COLOR_VERIFIED" },
      requestedTrackId: intent.trackId, actualTrackId: plan.trackId, clipId: intent.clipId, assetId: intent.assetId },
    probe, sourceObservation: { before: before.stat, after: after.stat },
    rights: { state: "CALLER_DECLARED_NOT_VERIFIED", ...(intent.rights ? { declaration: { ...intent.rights } } : {}) },
    warnings: ["來源 SHA 與探測資料不等於權利驗證；仍須同代 v4 素材證據、audit／atomic apply 與成片審查。",
      ...(probe.hasVideo && probe.displayAspectRatio === undefined ? ["來源 SAR 未知，未宣告已核對的展示比例。"] : [])],
  };
}

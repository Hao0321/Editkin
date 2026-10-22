import * as z from "zod/v4";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { pixelMatteOperation, compileClipAlphaPlan, rationalRate, ffmpegRationalRate } from "../domain/clipAlphaPlan";
import { canonicalJson } from "../shared/canonicalJson";
import { dispatchCommandSafely } from "../domain/history";
import { readBoundedFile } from "../shared/boundedFile";
import { buildSubjectOverlayGraphV1, type SubjectOverlayEffectV1 } from "../render/subjectOverlayGraphV1";
import { subjectStickerStyleV1Schema } from "../render/subjectStickerV1";
import { subjectSheenStyleV1Schema } from "../render/subjectSheenV1";
import { withFilterGraphArgs } from "../render/ffmpegComposite";
import { runWithRenderWorkRootV1 } from "../render/renderWorkspace";
import { assertRenderActive } from "../render/renderLifetime";
import { mediaDisplayAspectRatio, mediaDisplayRotation, mediaSampleAspectRatio } from "../render/mediaDisplayGeometry";
import { sourceFrameRateFromProbe } from "../render/sourceFrameRateProbe";
import type { MediaProbe } from "../render/ffmpegContracts";
import { verifyFrozenRotoMatte } from "../render/autoRotoMatteIntegrity";
import { runAnalysisProcess } from "./analysisProcess";
import { admitSubjectOverlaySourceV1, subjectOverlaySourceStageV1, planSubjectOverlayProjectV1, type SubjectOverlayIdsV1, type SubjectOverlayMediaV1 } from "./subjectOverlayProjectV1";
import { beginMatteTrackV1 } from "./matteTrackV1";
import { analyzeMatteTrackV1, type MatteTrackArtifactsV1 } from "./matteTrackAnalysisV1";
import { planRotoV2Media, ROTO_V2_MEDIA_INPUT_POLICY } from "./rotoV2Media";
import { rotoV2Deadline, rotoV2FileIdentity, assertRotoV2IdentityUnchanged, assertRotoV2LocalPath, createRotoV2Workspace } from "./rotoV2Workspace";
import { subjectOverlayClockV1, readSubjectOverlayNativeDigestsV1, createSubjectOverlayFrameHashVerifierV1, verifySubjectOverlayDecodedPixelsV1 } from "./subjectOverlayVerificationV1";
import type { ProjectSession, ProjectTask } from "./projectSession";

const name = z.string().trim().min(1).max(160), range = z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() });
export const subjectOverlayBakeRequestV1Schema = z.strictObject({ schema: z.literal("editkin.subject-overlay-request/v1"), expectedRevision: z.number().int().nonnegative(), clipId: name,
  ids: z.strictObject({ assetId: name, clipId: name, trackId: name, linkGroupId: name, assetName: name, trackName: name }),
  effect: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("sticker"), style: subjectStickerStyleV1Schema }), z.strictObject({ kind: z.literal("sheen"), style: subjectSheenStyleV1Schema, range })]) });
export type SubjectOverlayBakeRequestV1 = z.infer<typeof subjectOverlayBakeRequestV1Schema>;
type Request = SubjectOverlayBakeRequestV1;
export interface SubjectOverlayBakeHostV1 {
  assetBase: string; cacheRoot: string; ffmpegPath: string; ffprobePath: string; legacyProductCacheRoot?: string;
  resolveConfirmed?(clipId: string, signal?: AbortSignal): Promise<MatteTrackArtifactsV1 | undefined>;
}
export interface SubjectOverlayBakeRuntimeV1 { signal?: AbortSignal; isCurrent?(): boolean; timeoutMs?: number; maximumOutputBytes?: number; onProgress?(progress: { stage: "verify" | "render" | "inspect" | "ready"; frames: number; total: number }): void; }
function context(session: ProjectSession, expectedRevision: number, signal?: AbortSignal, timeoutMs = 15000, isCurrent?: () => boolean) {
  if (timeoutMs > 60000) throw Error("SUBJECT_OVERLAY_DEADLINE_BUDGET");
  const snapshot = session.getSnapshot(), projectPath = snapshot.projectPath, project = snapshot.history.present, task = session.beginTask(project), before = canonicalJson(project), deadline = rotoV2Deadline(signal, timeoutMs);
  if (project.revision !== expectedRevision) throw Error("SUBJECT_OVERLAY_REVISION_CHANGED");
  const check = () => { assertRenderActive(); const remaining = deadline(); if (isCurrent && isCurrent() !== true) throw Error("SUBJECT_OVERLAY_HOST_CHANGED"); if (!task.isCurrent()) throw Error("SUBJECT_OVERLAY_PROJECT_CHANGED"); return remaining; };
  const current = () => { const remaining = check(); const now = session.getSnapshot();
    if (now.projectPath !== projectPath || now.history.present !== project || canonicalJson(now.history.present) !== before) throw Error("SUBJECT_OVERLAY_PROJECT_OR_DOCUMENT_PATH_CHANGED"); return remaining; };
  current(); return { session, project, task, before, signal, check, current };
}
type Context = ReturnType<typeof context>;
async function wait<T>(ctx: Context, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    let done = false; const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); ctx.signal?.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(ctx.signal?.reason)), timer = setTimeout(() => finish(() => reject(Error("SUBJECT_OVERLAY_DEADLINE_EXCEEDED"))), ctx.current());
    ctx.signal?.addEventListener("abort", abort, { once: true }); if (ctx.signal?.aborted) abort();
    Promise.resolve().then(() => { ctx.current(); return operation(); }).then(value => finish(() => { try { ctx.current(); resolvePromise(value); } catch (e) { reject(e); } }), e => finish(() => reject(e)));
  });
}
async function verify(ctx: Context, request: Request, artifacts: MatteTrackArtifactsV1, assetBase: string) {
  ctx.current(); const job = beginMatteTrackV1(ctx.project, { clipId: request.clipId, newTrackId: `subject-overlay-${randomUUID()}`, name: "Subject overlay source verification",
    createdAt: new Date().toISOString(), minimumAlpha: .1, referenceFrame: 0 }, ctx.signal);
  const verified = await analyzeMatteTrackV1(ctx.project, job, artifacts, { assetBase }, { signal: ctx.signal, timeoutMs: Math.max(100, ctx.check()) }); ctx.current(); return verified;
}
interface RawStream { index?: number; codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; sample_aspect_ratio?: string; avg_frame_rate?: unknown; pix_fmt?: string; bits_per_raw_sample?: string;
  color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; disposition?: { attached_pic?: number }; side_data_list?: { side_data_type?: string; rotation?: unknown }[]; tags?: { rotate?: unknown }; }
async function sourceProbe(ctx: Context, host: SubjectOverlayBakeHostV1, artifacts: MatteTrackArtifactsV1): Promise<MediaProbe> {
  const reply = await runAnalysisProcess(host.ffprobePath, ["-v", "error", ...ROTO_V2_MEDIA_INPUT_POLICY, "-show_streams", "-show_format", "-of", "json", artifacts.analysis.source.path],
    { signal: ctx.signal, timeoutMs: ctx.check(), label: "SUBJECT_OVERLAY_SOURCE_PROBE", maximumStdout: 65536, maximumStderr: 65536 }); ctx.current();
  const raw = JSON.parse(reply.stdout.toString("utf8")) as { format?: { duration?: string }; streams?: RawStream[] }, planned = planRotoV2Media(raw, artifacts.analysis.request), m = artifacts.analysis.media;
  if (planned.width !== m.width || planned.height !== m.height || planned.frameCount !== m.frameCount || planned.sourceDisplayWidth !== m.sourceDisplayWidth || planned.sourceDisplayHeight !== m.sourceDisplayHeight) throw Error("SUBJECT_OVERLAY_SOURCE_PROBE_CHANGED");
  const video = raw.streams!.find(s => s.codec_type === "video" && !s.disposition?.attached_pic)!;
  const probe: MediaProbe = { duration: Number(raw.format?.duration), width: video.width, height: video.height, encodedWidth: video.width, encodedHeight: video.height,
    displayRotationDegrees: mediaDisplayRotation(video), sampleAspectRatio: mediaSampleAspectRatio(video.sample_aspect_ratio), hasVideo: true, hasAudio: raw.streams!.some(s => s.codec_type === "audio"),
    pixelFormat: video.pix_fmt, codecName: video.codec_name, codecProfile: video.profile, bitsPerRawSample: video.bits_per_raw_sample ? Number(video.bits_per_raw_sample) : undefined,
    colorPrimaries: video.color_primaries, colorTransfer: video.color_transfer, colorMatrix: video.color_space, colorRange: video.color_range, frameRate: sourceFrameRateFromProbe(video.avg_frame_rate) };
  return { ...probe, displayAspectRatio: mediaDisplayAspectRatio(probe) };
}
async function legacyInput(ctx: Context, host: SubjectOverlayBakeHostV1, request: Request) {
  const clip = admitSubjectOverlaySourceV1(ctx.project, request.clipId, request.effect.kind).clip, legacy = pixelMatteOperation(compileClipAlphaPlan(ctx.project, clip, "formal"));
  if (!legacy) return { args: [] as string[], present: false };
  if (!host.legacyProductCacheRoot) throw Error("SUBJECT_OVERLAY_LEGACY_PRODUCT_ROOT_REQUIRED");
  const s = legacy.matte.sequence; await assertRotoV2LocalPath(host.legacyProductCacheRoot);
  for (const path of [s.sequenceUri, s.manifestUri!, ...(s.frameArtifactUris ?? [])]) { ctx.check(); await assertRotoV2LocalPath(path); }
  // This bounded original read-only verifier has no cancellation callback. Await its
  // resource closure, then reject an expired/cancelled job before starting any child.
  await verifyFrozenRotoMatte(s, s.sequenceUri, s.manifestUri!, host.legacyProductCacheRoot); ctx.current();
  return { args: ["-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${s.width}x${s.height}`, "-framerate", ffmpegRationalRate(rationalRate(s.analysisFps)), "-i", s.sequenceUri], present: true };
}
async function outputProbe(ctx: Context, host: SubjectOverlayBakeHostV1, path: string, media: SubjectOverlayMediaV1) {
  const reply = await runAnalysisProcess(host.ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,color_primaries,color_transfer,color_space,color_range:format=duration", "-of", "json", path],
    { signal: ctx.signal, timeoutMs: ctx.check(), label: "SUBJECT_OVERLAY_OUTPUT_PROBE", maximumStdout: 65536, maximumStderr: 65536 }); ctx.current();
  const raw = JSON.parse(reply.stdout.toString("utf8")) as { streams?: (RawStream & { r_frame_rate?: string })[]; format?: { duration?: string } }, video = raw.streams?.[0];
  const fps = /^(\d+)\/([1-9]\d*)$/u.exec(video?.r_frame_rate ?? ""), expected = rationalRate(media.fps), duration = Number(raw.format?.duration);
  if (raw.streams?.length !== 1 || video?.codec_type !== "video" || video.codec_name !== "ffv1" || video.pix_fmt !== media.pixelFormat || video.width !== media.width || video.height !== media.height
    || !fps || BigInt(fps[1]) * BigInt(expected.denominator) !== BigInt(fps[2]) * BigInt(expected.numerator) || !Number.isFinite(duration) || Math.abs(duration - media.duration) > .002
    || video.color_primaries !== "bt709" || video.color_transfer !== "bt709" || video.color_space !== "gbr" || video.color_range !== "pc") throw Error("SUBJECT_OVERLAY_OUTPUT_MEDIA_MISMATCH");
  return raw;
}
export interface PreparedSubjectOverlayBakeV1 {
  schema: "editkin.subject-overlay-plan/v1"; state: "ready"; kind: SubjectOverlayEffectV1["kind"]; projectId: string; expectedRevision: number;
  media: SubjectOverlayMediaV1; manifestPath: string; manifestSha256: string; sourceAlphaSha256: string; qualityState: "ART_PENDING_CLAUDE"; defaultEnabled: false; directApplyAllowed: false;
}
interface Owned { session: ProjectSession; task: ProjectTask; before: string; projectPath?: string; request: Request; host: SubjectOverlayBakeHostV1; artifacts: MatteTrackArtifactsV1; signal?: AbortSignal; isCurrent?: () => boolean;
  fingerprint: string; packet: PreparedSubjectOverlayBakeV1; clipIdentity: Awaited<ReturnType<typeof rotoV2FileIdentity>>; manifestIdentity: Awaited<ReturnType<typeof rotoV2FileIdentity>>; }
const owners = new WeakMap<PreparedSubjectOverlayBakeV1, Owned>();
/** Canonical confirmed matte, full current authored alpha, original-rate RGB, then
 * frozen effect kernels. New ordinary media keeps all editable appearance channels. */
async function prepare(session: ProjectSession, payload: unknown, requestedHost: SubjectOverlayBakeHostV1, runtime: SubjectOverlayBakeRuntimeV1 = {}) {
  const request = subjectOverlayBakeRequestV1Schema.parse(structuredClone(payload)), settings = { ...runtime }, ctx = context(session, request.expectedRevision, settings.signal, settings.timeoutMs, settings.isCurrent);
  const selected = admitSubjectOverlaySourceV1(ctx.project, request.clipId, request.effect.kind);
  const host = { ...requestedHost, resolveConfirmed: requestedHost.resolveConfirmed?.bind(requestedHost) };
  if (!isAbsolute(host.assetBase) || resolve(host.assetBase) !== host.assetBase) throw Error("SUBJECT_OVERLAY_ABSOLUTE_ASSET_BASE_REQUIRED");
  const chosen = host.resolveConfirmed ? await wait(ctx, () => host.resolveConfirmed!(request.clipId, ctx.signal)) : undefined; ctx.current();
  if (!chosen) return { schema: "editkin.subject-overlay-clean-hold/v1" as const, state: "clean_hold" as const, reason: "confirmed_subject_required" as const, nativeProcesses: 0 as const, filesWritten: 0 as const, mutated: false as const, defaultEnabled: false as const };
  const artifacts = structuredClone(chosen), progress = (stage: "verify" | "render" | "inspect" | "ready", frames: number) => { settings.onProgress?.({ stage, frames, total: selected.frames }); ctx.current(); };
  if (!isAbsolute(host.cacheRoot) || resolve(host.cacheRoot) !== host.cacheRoot) throw Error("SUBJECT_OVERLAY_ABSOLUTE_CACHE_ROOT_REQUIRED");
  await assertRotoV2LocalPath(host.cacheRoot); progress("verify", 0); const verified = await verify(ctx, request, artifacts, host.assetBase);
  for (const key of ["ffmpeg", "ffprobe"] as const) { const path = key === "ffmpeg" ? host.ffmpegPath : host.ffprobePath, actual = await rotoV2FileIdentity(path, ctx.check), expected = artifacts.analysis.tools[key];
    if (actual.path.toLowerCase() !== expected.path.toLowerCase() || actual.sha256 !== expected.sha256) throw Error("SUBJECT_OVERLAY_TOOL_CHANGED"); }
  const maximumOutputBytes = settings.maximumOutputBytes ?? 128 * 1024 ** 2;
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 65536 || maximumOutputBytes > 1024 ** 3) throw Error("SUBJECT_OVERLAY_OUTPUT_BYTE_BUDGET");
  const clock = subjectOverlayClockV1(ctx.project.fps, verified.measurement.fps, verified.measurement.frameCount, selected.frames), m = verified.measurement;
  const nativeFrameBytes = m.width * m.height * m.alphaBits / 8, nativeDigests = await readSubjectOverlayNativeDigestsV1(verified.alpha.path, nativeFrameBytes, clock, ctx.check); ctx.current();
  if (nativeDigests.sequenceSha256 !== verified.alpha.sha256) throw Error("SUBJECT_OVERLAY_NATIVE_SOURCE_CHANGED");
  const legacy = await legacyInput(ctx, host, request), probe = await sourceProbe(ctx, host, artifacts), stage = subjectOverlaySourceStageV1(ctx.project, request.clipId, request.effect.kind);
  const graph = buildSubjectOverlayGraphV1(stage, probe, { width: m.width, height: m.height, fps: m.fps, frameCount: m.frameCount, bits: m.alphaBits }, request.effect, legacy.present ? 2 : undefined);
  const rootPath = join(host.cacheRoot, `subject-overlay-${randomUUID()}`), output = join(rootPath, `${request.effect.kind}.mkv`), manifestPath = join(rootPath, "subject-overlay-v1.json");
  const media: SubjectOverlayMediaV1 = { kind: request.effect.kind, path: output, sha256: "0".repeat(64), width: ctx.project.width, height: ctx.project.height, frames: selected.frames, fps: ctx.project.fps,
    duration: selected.clip.duration, sourceSha256: verified.source.sha256, confirmationSha256: m.subjectConfirmationSha256, pixelFormat: graph.pixelFormat };
  planSubjectOverlayProjectV1(ctx.project, request.clipId, media, request.ids); ctx.current(); // All data/dependency failures precede output creation.
  const pixelFrameBytes = media.width * media.height * (media.pixelFormat === "bgra" ? 4 : 8), root = await createRotoV2Workspace(rootPath, Math.min(maximumOutputBytes, pixelFrameBytes * media.frames) + 1048576, ctx.check);
  await writeFile(join(root, "OWNER.json"), JSON.stringify({ producer: "prepareSubjectOverlayBakeV1", sourceProjectSha256: createHash("sha256").update(ctx.before).digest("hex"), request, source: verified.source, alpha: verified.alpha }, null, 2), { flag: "wx" }); ctx.current();
  const filters = [...graph.filters, "[ovOutput]split=2[ovEncode][ovPixelHash]"].join(";"); await writeFile(join(root, "filtergraph.txt"), filters, { flag: "wx" });
  const hashes = createSubjectOverlayFrameHashVerifierV1(clock, nativeDigests.digests, nativeFrameBytes, pixelFrameBytes); progress("render", 0);
  await runWithRenderWorkRootV1(root, () => withFilterGraphArgs(filters, filterArgs => runAnalysisProcess(host.ffmpegPath,
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-filter_complex_threads", "1", ...ROTO_V2_MEDIA_INPUT_POLICY, "-ss", String(selected.clip.sourceStart), "-t", String(selected.clip.duration), "-i", verified.source.path,
      "-f", "rawvideo", "-pixel_format", m.alphaBits === 16 ? "gray16le" : "gray", "-video_size", `${m.width}x${m.height}`, "-framerate", ffmpegRationalRate(clock.native), "-i", verified.alpha.path, ...legacy.args, ...filterArgs,
      "-map", "[ovNativeHash]", "-map", "[ovPixelHash]", "-an", "-frames:v:0", String(media.frames), "-frames:v:1", String(media.frames), "-c:v", "rawvideo", "-pix_fmt:v:0", m.alphaBits === 16 ? "gray16le" : "gray", "-pix_fmt:v:1", graph.pixelFormat,
      "-fps_mode:v:0", "passthrough", "-fps_mode:v:1", "passthrough", "-f", "framehash", "-hash", "sha256", "pipe:1",
      "-map", "[ovEncode]", "-an", "-frames:v", String(media.frames), "-c:v", "ffv1", "-level", "3", "-slicecrc", "1", "-pix_fmt", graph.pixelFormat,
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "0", "-color_range", "pc", "-threads", "1", "-fps_mode", "passthrough", "-fs", String(maximumOutputBytes), "-n", output],
    { signal: ctx.signal, timeoutMs: ctx.check(), label: "SUBJECT_OVERLAY_ENCODE_AND_DUAL_FRAMEHASH", maximumStdout: media.frames * 280 + 16384, maximumStderr: 131072, captureStdout: false, onStdout: chunk => { ctx.check(); hashes.write(chunk); } })));
  ctx.current(); const encoded = hashes.finish(), clipIdentity = await rotoV2FileIdentity(output, ctx.check); if (clipIdentity.bytes > maximumOutputBytes) throw Error("SUBJECT_OVERLAY_OUTPUT_BYTE_BUDGET"); media.sha256 = clipIdentity.sha256;
  progress("inspect", media.frames); const decoded = await verifySubjectOverlayDecodedPixelsV1(output, host.ffmpegPath, graph.pixelFormat, pixelFrameBytes, encoded.pixelDigests, { signal: ctx.signal, check: ctx.check }); ctx.current();
  const outputMetadata = await outputProbe(ctx, host, output, media); await verify(ctx, request, artifacts, host.assetBase); await legacyInput(ctx, host, request); await assertRotoV2IdentityUnchanged(clipIdentity, ctx.check); ctx.current();
  const { pixelDigests: _privateDigests, ...frameHashSummary } = encoded;
  const result = { schema: "editkin.subject-overlay-clip/v1", media, clip: clipIdentity, request, source: verified.source, nativeAlpha: verified.alpha, inputAlphaBits: m.alphaBits,
    confirmationSha256: m.subjectConfirmationSha256, frameHashSummary, decoded, outputMetadata, appearance: graph.appearanceContract, alpha: graph.pixelContract,
    rawMovieFilesStaged: 0, qualityState: "ART_PENDING_CLAUDE", defaultEnabled: false, subjectQualityCertified: false, benchmarkAccepted: false };
  await writeFile(manifestPath, JSON.stringify(result, null, 2), { flag: "wx" }); ctx.current(); const manifestIdentity = await rotoV2FileIdentity(manifestPath, ctx.check);
  progress("ready", media.frames); const packet: PreparedSubjectOverlayBakeV1 = { schema: "editkin.subject-overlay-plan/v1", state: "ready", kind: media.kind, projectId: ctx.project.id, expectedRevision: request.expectedRevision,
    media: structuredClone(media), manifestPath, manifestSha256: manifestIdentity.sha256, sourceAlphaSha256: verified.alpha.sha256, qualityState: "ART_PENDING_CLAUDE", defaultEnabled: false, directApplyAllowed: false };
  owners.set(packet, { session, task: ctx.task, before: ctx.before, projectPath: session.getSnapshot().projectPath, request, host, artifacts, signal: ctx.signal, isCurrent: settings.isCurrent, fingerprint: canonicalJson(packet), packet: structuredClone(packet), clipIdentity, manifestIdentity }); return packet;
}
export async function prepareSubjectOverlayBakeV1(session: ProjectSession, payload: unknown, host: SubjectOverlayBakeHostV1, runtime: SubjectOverlayBakeRuntimeV1 = {}) {
  const settings = { ...runtime };
  try { return await prepare(session, payload, host, settings); }
  catch (error) { settings.signal?.throwIfAborted(); throw error; }
}
/** One accepted attempt, physical source/output/manifest revalidation, then one
 * existing command batch. Never trust a serialized packet as an apply capability. */
async function apply(session: ProjectSession, packet: PreparedSubjectOverlayBakeV1, runtime: Pick<SubjectOverlayBakeRuntimeV1, "signal" | "timeoutMs" | "isCurrent"> = {}) {
  const owned = owners.get(packet);
  if (!owned || owned.session !== session || owned.fingerprint !== canonicalJson(packet)) throw Error("SUBJECT_OVERLAY_PREPARATION_INVALID_OR_USED");
  owners.delete(packet); const signals = [owned.signal, runtime.signal].filter((s): s is AbortSignal => !!s), signal = signals.length ? AbortSignal.any(signals) : undefined;
  const ctx = context(session, packet.expectedRevision, signal, runtime.timeoutMs, runtime.isCurrent);
  const current = () => { ctx.current(); if (!owned.task.isCurrent() || ctx.before !== owned.before || session.getSnapshot().projectPath !== owned.projectPath || canonicalJson(packet) !== owned.fingerprint) throw Error("SUBJECT_OVERLAY_SOURCE_OR_PACKET_CHANGED"); }; current();
  await verify(ctx, owned.request, owned.artifacts, owned.host.assetBase); await legacyInput(ctx, owned.host, owned.request);
  await assertRotoV2IdentityUnchanged(owned.clipIdentity, ctx.check); await assertRotoV2IdentityUnchanged(owned.manifestIdentity, ctx.check); current();
  // Manifest bytes have their own exact identity; do not parse or accept a caller's metadata copy.
  if ((await readBoundedFile(owned.manifestIdentity.path, 4 * 1024 ** 2)).length !== owned.manifestIdentity.bytes) throw Error("SUBJECT_OVERLAY_MANIFEST_CHANGED"); current();
  const plan = planSubjectOverlayProjectV1(ctx.project, owned.request.clipId, owned.packet.media, owned.request.ids), result = dispatchCommandSafely(session.getSnapshot().history, plan.command);
  if (result.error) throw Error(result.error); current(); session.setHistory(result.state);
  return { status: "applied" as const, undoSteps: 1 as const, kind: owned.packet.kind, derivativeClipId: plan.derivativeClipId, retainedSourceClipId: plan.retainedSourceClipId,
    originalPictureRetained: plan.originalPictureRetained, media: structuredClone(owned.packet.media), qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false as const };
}
export async function applyPreparedSubjectOverlayBakeV1(session: ProjectSession, packet: PreparedSubjectOverlayBakeV1, runtime: Pick<SubjectOverlayBakeRuntimeV1, "signal" | "timeoutMs" | "isCurrent"> = {}) {
  const owned = owners.get(packet), initialGuard = owned?.isCurrent, applyGuard = runtime.isCurrent;
  const signals = [owned?.signal, runtime.signal].filter((s): s is AbortSignal => !!s), signal = signals.length ? AbortSignal.any(signals) : undefined;
  const isCurrent = initialGuard || applyGuard ? () => (!initialGuard || initialGuard() === true) && (!applyGuard || applyGuard() === true) : undefined;
  try { return await apply(session, packet, { ...runtime, signal, isCurrent }); }
  catch (error) { signal?.throwIfAborted(); throw error; }
}
export async function prepareSubjectStickerBakeV1(session: ProjectSession, payload: unknown, host: SubjectOverlayBakeHostV1, runtime?: SubjectOverlayBakeRuntimeV1) {
  const request = subjectOverlayBakeRequestV1Schema.parse(payload); if (request.effect.kind !== "sticker") throw Error("SUBJECT_STICKER_KIND_REQUIRED"); return prepareSubjectOverlayBakeV1(session, request, host, runtime);
}
export async function prepareSubjectSheenOverlayBakeV1(session: ProjectSession, payload: unknown, host: SubjectOverlayBakeHostV1, runtime?: SubjectOverlayBakeRuntimeV1) {
  const request = subjectOverlayBakeRequestV1Schema.parse(payload); if (request.effect.kind !== "sheen") throw Error("SUBJECT_SHEEN_KIND_REQUIRED"); return prepareSubjectOverlayBakeV1(session, request, host, runtime);
}

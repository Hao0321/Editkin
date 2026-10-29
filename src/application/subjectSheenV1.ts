import { createHash, randomUUID } from "node:crypto";
import { openSync, readSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import { ffmpegRationalRate } from "../domain/clipAlphaPlan";
import { canonicalJson } from "../shared/canonicalJson";
import { assertRenderActive } from "../render/renderLifetime";
import { buildSubjectSheenFiltersV1, createSubjectSheenKernelV1, subjectSheenStyleV1Schema } from "../render/subjectSheenV1";
import { beginMatteTrackV1 } from "./matteTrackV1";
import { analyzeMatteTrackV1, type MatteTrackArtifactsV1 } from "./matteTrackAnalysisV1";
import { assertRotoV2IdentityUnchanged, assertRotoV2LocalPath, createRotoV2Workspace, rotoV2Deadline, rotoV2FileIdentity } from "./rotoV2Workspace";
import { runAnalysisProcess } from "./analysisProcess";
import { subjectSheenClockV1, subjectSheenSampleV1, expectedSubjectSheenFrameHashesV1, verifySubjectSheenFrameHashesV1 } from "./subjectSheenFrameHashesV1";
import type { ProjectSession, ProjectTask } from "./projectSession";

export const subjectSheenRequestV1Schema = z.strictObject({ schema: z.literal("editkin.subject-sheen-request/v1"), expectedRevision: z.number().int().nonnegative(),
  clipId: z.string().trim().min(1).max(160), range: z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() }), style: subjectSheenStyleV1Schema });
type Request = z.infer<typeof subjectSheenRequestV1Schema>;
export interface SubjectSheenHostV1 { assetBase: string; resolveConfirmed?(clipId: string, signal?: AbortSignal): Promise<MatteTrackArtifactsV1 | undefined>; }
export interface SubjectSheenRuntimeV1 { signal?: AbortSignal; timeoutMs?: number; onProgress?(p: { stage: "verify" | "encode" | "decode" | "complete"; completed: number; total: number }): void; }
export interface SubjectSheenBakeRuntimeV1 extends SubjectSheenRuntimeV1 { cacheRoot: string; ffmpegPath: string; ffprobePath: string; maximumOutputBytes?: number; }
export interface SubjectSheenPreparationV1 {
  schema: "editkin.subject-sheen-preparation/v1"; state: "ready"; clipId: string; projectId: string; projectRevision: number;
  range: Request["range"]; style: Request["style"]; width: number; height: number; frames: number;
  matte: { sourceSha256: string; alphaSha256: string; confirmationSha256: string; alphaBits: 8 | 16; sampleFps: number; sampleCount: number };
  qualityState: "ART_PENDING_CLAUDE"; defaultEnabled: false; directApplyAllowed: false;
}
interface Owned { session: ProjectSession; task: ProjectTask; project: EditProject; before: string; request: Request; artifacts: MatteTrackArtifactsV1;
  assetBase: string; fingerprint: string; signal?: AbortSignal; phase: "ready" | "baking" | "closed"; }
const owners = new WeakMap<SubjectSheenPreparationV1, Owned>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function selected(project: EditProject, request: Request) {
  if (project.revision !== request.expectedRevision) throw Error("SHEEN_PROJECT_REVISION_CHANGED");
  const matches = project.tracks.flatMap(track => track.clips.filter(c => c.id === request.clipId).map(clip => ({ clip, track })));
  if (matches.length !== 1) throw Error("SHEEN_SOURCE_CLIP_MISSING_OR_AMBIGUOUS");
  const { clip, track } = matches[0], asset = project.assets.find(a => a.id === clip.assetId), fps = project.fps;
  if (track.locked || track.hidden || track.kind !== "video" || clip.layer?.enabled === false || !asset || asset.kind !== "video") throw Error("SHEEN_SOURCE_LOCKED_HIDDEN_OR_UNAVAILABLE");
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw Error("SHEEN_PROJECT_CLOCK");
  const start = Math.round(clip.timelineStart * fps), end = Math.round((clip.timelineStart + clip.duration) * fps), total = request.range.endFrame - request.range.startFrame;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || Math.abs(start / fps - clip.timelineStart) > 1e-8
    || Math.abs(end / fps - clip.timelineStart - clip.duration) > 1e-8 || request.range.startFrame < start || request.range.endFrame > end
    || request.range.endFrame / fps > 86400 || total < 3 || total > 240) throw Error("SHEEN_INTERVAL_OR_CLIP_CLOCK");
  return { clip, asset, start, total };
}
function lifetime(signal: AbortSignal | undefined, timeoutMs = 15000) {
  if (timeoutMs > 60000) throw Error("SHEEN_DEADLINE_BUDGET"); const budget = rotoV2Deadline(signal, timeoutMs);
  return () => { assertRenderActive(); return budget(); };
}
async function bounded<T>(operation: () => Promise<T>, check: () => number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false; const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); action(); };
    const abort = () => finish(() => reject(signal?.reason)), timer = setTimeout(() => finish(() => reject(Error("SHEEN_DEADLINE_EXCEEDED"))), check());
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    Promise.resolve().then(() => { check(); return operation(); }).then(value => finish(() => { try { check(); resolve(value); } catch (e) { reject(e); } }), error => finish(() => reject(error)));
  });
}
async function verify(owned: Pick<Owned, "project" | "request" | "artifacts" | "assetBase">, signal: AbortSignal | undefined, check: () => number) {
  check(); const job = beginMatteTrackV1(owned.project, { clipId: owned.request.clipId, newTrackId: `sheen-verification-${randomUUID()}`,
    name: "Confirmed sheen source verification", createdAt: new Date().toISOString(), minimumAlpha: .1, referenceFrame: 0 }, signal);
  const value = await analyzeMatteTrackV1(owned.project, job, owned.artifacts, { assetBase: owned.assetBase }, { signal, timeoutMs: Math.max(100, check()) });
  check(); return value;
}
/** Missing confirmation is an explicit no-op. No model, generated matte, fallback saliency,
 * file output, project command, style default or approval is created here. */
export async function prepareSubjectSheenV1(session: ProjectSession, payload: unknown, host: SubjectSheenHostV1, runtime: SubjectSheenRuntimeV1 = {}) {
  const request = subjectSheenRequestV1Schema.parse(structuredClone(payload)), project = session.getSnapshot().history.present, task = session.beginTask(project);
  const before = canonicalJson(project), settings = { ...runtime }, check = lifetime(settings.signal, settings.timeoutMs), input = selected(project, request);
  const current = () => { const left = check(); if (!task.isCurrent() || canonicalJson(session.getSnapshot().history.present) !== before) throw Error("SHEEN_PROJECT_CHANGED"); return left; };
  current(); const resolveConfirmed = host.resolveConfirmed?.bind(host), assetBase = host.assetBase;
  if (!isAbsolute(assetBase) || resolve(assetBase) !== assetBase) throw Error("SHEEN_ABSOLUTE_ASSET_BASE_REQUIRED");
  const chosen = resolveConfirmed ? await bounded(() => resolveConfirmed(request.clipId, settings.signal), current, settings.signal) : undefined; current();
  if (!chosen) return { schema: "editkin.subject-sheen-clean-hold/v1" as const, state: "clean_hold" as const, reason: "confirmed_subject_required" as const,
    projectId: project.id, clipId: request.clipId, mutated: false as const, mediaProcesses: 0 as const, filesWritten: 0 as const, defaultEnabled: false as const };
  if (project.colorManagement?.mode !== "rec709" || project.colorManagement.outputTransform !== "rec709_sdr"
    || input.asset.alphaMode === "straight" || input.asset.alphaMode === "premultiplied") throw Error("SHEEN_REC709_OPAQUE_ORIGINAL_REQUIRED");
  const artifacts = structuredClone(chosen), provisional = { project, request, artifacts, assetBase };
  settings.onProgress?.({ stage: "verify", completed: 0, total: input.total }); current();
  const verified = await bounded(() => verify(provisional, settings.signal, current), current, settings.signal); current();
  const m = verified.measurement;
  if (artifacts.analysis.request.sourceColor !== "rec709-rgb8") throw Error("SHEEN_REC709_SOURCE_REQUIRED");
  subjectSheenClockV1(project.fps, m.fps, m.frameCount, request.range.startFrame - input.start, input.total);
  const packet: SubjectSheenPreparationV1 = { schema: "editkin.subject-sheen-preparation/v1", state: "ready", projectId: project.id, projectRevision: project.revision, clipId: request.clipId,
    range: request.range, style: request.style, width: m.width, height: m.height, frames: input.total, matte: { sourceSha256: m.sourceSha256, alphaSha256: m.alphaSha256,
      confirmationSha256: m.subjectConfirmationSha256, alphaBits: m.alphaBits, sampleFps: m.fps, sampleCount: m.frameCount },
    qualityState: "ART_PENDING_CLAUDE", defaultEnabled: false, directApplyAllowed: false };
  owners.set(packet, { session, task, project, request: structuredClone(request), before, artifacts, assetBase, signal: settings.signal, fingerprint: canonicalJson(packet), phase: "ready" }); return packet;
}
async function verifyPixels(path: string, alphaPath: string, bits: 8 | 16, width: number, height: number,
  clock: ReturnType<typeof subjectSheenClockV1>, style: Request["style"], executable: string, signal: AbortSignal | undefined, check: () => number) {
  const pixels = width * height, sourceBytes = pixels * bits / 8, frameBytes = pixels * 8, source = Buffer.alloc(sourceBytes), frame = Buffer.alloc(frameBytes), alpha = Buffer.alloc(pixels * 2);
  const fd = openSync(alphaPath, "r"), kernel = createSubjectSheenKernelV1(width, height, clock.frameCount, style), rgbaHash = createHash("sha256"), alphaHash = createHash("sha256");
  let filled = 0, frames = 0, bytes = 0, cached = -1, maximumAlphaError = 0, nonZeroAlphaSamples = 0, subU8AlphaSamples = 0;
  const complete = () => {
    check(); const sampleIndex = subjectSheenSampleV1(clock, frames);
    if (sampleIndex !== cached) { let read = 0; while (read < sourceBytes) { check(); const count = readSync(fd, source, read, sourceBytes - read, sampleIndex * sourceBytes + read); if (!count) throw Error("SHEEN_VERIFY_SOURCE_TRUNCATED"); read += count; } cached = sampleIndex; }
    const sample = kernel.frame(frames);
    for (let y = 0; y < height; y++) { if (y % 32 === 0) check();
      for (let x = 0; x < width; x++) { const p = y * width + x, offset = p * 8;
        if (frame.readUInt32LE(offset) !== 0xffffffff || frame.readUInt16LE(offset + 4) !== 65535) throw Error("SHEEN_DECODED_WHITE_RGB_CHANGED");
        const input = bits === 16 ? source.readUInt16LE(p * 2) : source[p] * 257, actual = frame.readUInt16LE(offset + 6), expected = sample(x, y, input), error = Math.abs(actual - expected);
        maximumAlphaError = Math.max(maximumAlphaError, error);
        if (error > 1 || actual > input || !input && actual) throw Error("SHEEN_DECODED_ALPHA_REFERENCE_MISMATCH");
        if (actual) nonZeroAlphaSamples++; if (actual % 257) subU8AlphaSamples++; alpha.writeUInt16LE(actual, p * 2);
      }
    }
    rgbaHash.update(frame); alphaHash.update(alpha); frames++; check();
  };
  try {
    await runAnalysisProcess(executable, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm", "-i", path,
      "-map", "0:v:0", "-an", "-threads", "1", "-pix_fmt", "rgba64le", "-f", "rawvideo", "pipe:1"],
    { signal, timeoutMs: check(), label: "SHEEN_RGBA16_DECODE_VERIFY", maximumStdout: frameBytes * clock.frameCount, maximumStderr: 65536, captureStdout: false,
      onStdout: chunk => { bytes += chunk.length; let offset = 0;
        while (offset < chunk.length) { check(); if (frames >= clock.frameCount) throw Error("SHEEN_EXTRA_DECODED_FRAME"); const count = Math.min(frameBytes - filled, chunk.length - offset);
          chunk.copy(frame, filled, offset, offset + count); filled += count; offset += count; if (filled === frameBytes) { complete(); filled = 0; } }
      } });
    if (filled || frames !== clock.frameCount || bytes !== frameBytes * clock.frameCount) throw Error("SHEEN_DECODED_FRAME_COUNT");
    return { frames, decodedBytes: bytes, rgbaSha256: rgbaHash.digest("hex"), alphaSha256: alphaHash.digest("hex"), maximumAlphaError, nonZeroAlphaSamples, subU8AlphaSamples,
      decodedFrameBufferBytes: frameBytes, nativeSourceFrameBufferBytes: sourceBytes, decodedAlphaBufferBytes: alpha.length, storedWholeMovieRawFiles: 0 as const };
  } finally { closeSync(fd); }
}
/** One-use Node artifact producer. It never edits the source graph or imports an asset.
 * Host placement must still compose authored masks/pose and owns one Undo. */
export async function bakeSubjectSheenV1(session: ProjectSession, packet: SubjectSheenPreparationV1, requested: SubjectSheenBakeRuntimeV1) {
  const owned = owners.get(packet);
  if (!owned || owned.session !== session || owned.phase !== "ready" || owned.fingerprint !== canonicalJson(packet)) throw Error("SHEEN_PREPARATION_FOREIGN_CHANGED_OR_USED");
  const runtime = { ...requested }, signals = [owned.signal, runtime.signal].filter((s): s is AbortSignal => !!s), signal = signals.length ? AbortSignal.any(signals) : undefined;
  const checkTime = lifetime(signal, runtime.timeoutMs); owned.phase = "baking";
  const check = () => { const left = checkTime(); if (!owned.task.isCurrent()) throw Error("SHEEN_PROJECT_CHANGED"); return left; };
  const current = () => { const left = check(); if (canonicalJson(session.getSnapshot().history.present) !== owned.before || canonicalJson(packet) !== owned.fingerprint) throw Error("SHEEN_PROJECT_OR_PACKET_CHANGED"); return left; };
  const progress = (stage: "verify" | "encode" | "decode" | "complete", completed: number) => { runtime.onProgress?.({ stage, completed, total: packet.frames }); current(); };
  try {
    current(); selected(owned.project, owned.request);
    const maximumOutputBytes = runtime.maximumOutputBytes ?? 256 * 1024 ** 2;
    if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 65536 || maximumOutputBytes > 1024 ** 3 || !isAbsolute(runtime.cacheRoot) || resolve(runtime.cacheRoot) !== runtime.cacheRoot) throw Error("SHEEN_OUTPUT_ROOT_OR_BYTE_BUDGET");
    await assertRotoV2LocalPath(runtime.cacheRoot); current();
    for (const kind of ["ffmpeg", "ffprobe"] as const) {
      const actual = await rotoV2FileIdentity(runtime[kind === "ffmpeg" ? "ffmpegPath" : "ffprobePath"], current), expected = owned.artifacts.analysis.tools[kind];
      if (actual.path.toLowerCase() !== expected.path.toLowerCase() || actual.sha256 !== expected.sha256) throw Error("SHEEN_RUNTIME_TOOL_CHANGED");
    }
    progress("verify", 0); const verified = await verify(owned, signal, current); current();
    const m = verified.measurement, input = selected(owned.project, owned.request), clock = subjectSheenClockV1(owned.project.fps, m.fps, m.frameCount, owned.request.range.startFrame - input.start, input.total);
    if (m.sourceSha256 !== packet.matte.sourceSha256 || m.alphaSha256 !== packet.matte.alphaSha256 || m.subjectConfirmationSha256 !== packet.matte.confirmationSha256) throw Error("SHEEN_CONFIRMED_MATTE_CHANGED");
    const frameBytes = m.width * m.height * m.alphaBits / 8;
    const expected = await expectedSubjectSheenFrameHashesV1(verified.alpha.path, frameBytes, clock, current); current();
    const root = await createRotoV2Workspace(join(runtime.cacheRoot, `subject-sheen-${randomUUID()}`), Math.min(maximumOutputBytes, m.width * m.height * packet.frames * 8) + 1048576, current);
    const output = join(root, "sheen.mkv"), manifest = join(root, "subject-sheen-v1.json");
    await writeFile(join(root, "OWNER.json"), JSON.stringify({ producer: "bakeSubjectSheenV1", state: "candidate", projectId: packet.projectId, sourceProjectSha256: digest(owned.before),
      request: owned.request, sourceSha256: packet.matte.sourceSha256, confirmationSha256: packet.matte.confirmationSha256 }, null, 2), { flag: "wx" }); current();
    const graph = buildSubjectSheenFiltersV1({ alphaLabel: "sheenInput", outputLabel: "sheenOutput", width: m.width, height: m.height, totalFrames: packet.frames, frameOffset: 0, style: owned.request.style });
    const rate = ffmpegRationalRate(clock.projectRate), filters = [`[0:v]fps=${rate}:round=up:start_time=0:eof_action=pass,trim=start_frame=${clock.startFrame}:end_frame=${clock.startFrame + clock.frameCount},setpts=PTS-STARTPTS,split=2[sheenHash][sheenInput]`, ...graph.filters];
    progress("encode", 0);
    const encoded = await runAnalysisProcess(runtime.ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-filter_complex_threads", "1", "-f", "rawvideo", "-pixel_format", m.alphaBits === 16 ? "gray16le" : "gray",
      "-video_size", `${m.width}x${m.height}`, "-framerate", ffmpegRationalRate(clock.sampleRate), "-i", verified.alpha.path, "-filter_complex", filters.join(";"),
      "-map", "[sheenHash]", "-an", "-frames:v", String(packet.frames), "-c:v", "rawvideo", "-pix_fmt", m.alphaBits === 16 ? "gray16le" : "gray", "-fps_mode", "passthrough", "-f", "framehash", "-hash", "sha256", "pipe:1",
      "-map", "[sheenOutput]", "-an", "-frames:v", String(packet.frames), "-c:v", "ffv1", "-level", "3", "-slicecrc", "1", "-pix_fmt", "gbrap16le", "-fps_mode", "passthrough",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "0", "-color_range", "pc", "-threads", "1", "-fs", String(maximumOutputBytes), "-n", output],
    { signal, timeoutMs: current(), label: "SHEEN_FFV1_ENCODE_AND_FLOOR_VERIFY", maximumStdout: 65536, maximumStderr: 131072 }); current();
    const frameHashes = verifySubjectSheenFrameHashesV1(encoded.stdout.toString("utf8"), expected, frameBytes);
    const identity = await rotoV2FileIdentity(output, current); if (identity.bytes > maximumOutputBytes) throw Error("SHEEN_OUTPUT_BYTE_BUDGET");
    progress("decode", 0); const pixels = await verifyPixels(output, verified.alpha.path, m.alphaBits, m.width, m.height, clock, owned.request.style, runtime.ffmpegPath, signal, check); current();
    const probe = await runAnalysisProcess(runtime.ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,color_primaries,color_transfer,color_space,color_range:format=duration", "-of", "json", output],
      { signal, timeoutMs: current(), label: "SHEEN_OUTPUT_PROBE", maximumStdout: 65536, maximumStderr: 65536 });
    const metadata = JSON.parse(probe.stdout.toString("utf8")) as { streams?: { codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string;
      color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string }[]; format?: { duration?: string } };
    const video = metadata.streams?.find(s => s.codec_type === "video"), duration = Number(metadata.format?.duration);
    const rateParts = /^(\d{1,10})\/([1-9]\d{0,9})$/u.exec(video?.r_frame_rate ?? "");
    if (metadata.streams?.length !== 1 || video?.codec_name !== "ffv1" || video.pix_fmt !== "gbrap16le" || video.width !== m.width || video.height !== m.height
      || !rateParts || BigInt(rateParts[1]) * BigInt(clock.projectRate.denominator) !== BigInt(rateParts[2]) * BigInt(clock.projectRate.numerator)
      || video.color_primaries !== "bt709" || video.color_transfer !== "bt709" || video.color_space !== "gbr" || video.color_range !== "pc"
      || !Number.isFinite(duration) || Math.abs(duration - packet.frames / owned.project.fps) > .002) throw Error("SHEEN_OUTPUT_MEDIA_MISMATCH");
    const final = await verify(owned, signal, current); current(); await assertRotoV2IdentityUnchanged(identity, current);
    if (final.alpha.sha256 !== verified.alpha.sha256 || final.measurement.subjectConfirmationSha256 !== packet.matte.confirmationSha256) throw Error("SHEEN_SOURCE_CHANGED_DURING_BAKE");
    progress("complete", packet.frames);
    const result = { schema: "editkin.subject-sheen-bake/v1" as const, manifestPath: manifest, clip: identity, width: m.width, height: m.height, frameCount: packet.frames,
      fps: owned.project.fps, duration: packet.frames / owned.project.fps, codec: "ffv1" as const, pixelFormat: "gbrap16le" as const, alphaMode: "straight" as const,
      audio: "none" as const, sourceSpace: "confirmed-source-matte; authored clip mask/pose placement not baked" as const, lightRGB: "white" as const,
      inputAlphaBits: m.alphaBits, projectId: packet.projectId, projectRevision: packet.projectRevision, range: owned.request.range, style: owned.request.style,
      matte: packet.matte, frameHashes, pixelVerification: pixels, rawMovieFilesStaged: 0 as const, originalGraphEdited: false as const,
      qualityState: "ART_PENDING_CLAUDE" as const, subjectQualityCertified: false as const, benchmarkAccepted: false as const, defaultEnabled: false as const, directApplyAllowed: false as const };
    await writeFile(manifest, JSON.stringify(result, null, 2), { flag: "wx" }); current(); return result;
  } catch (error) { if (signal?.aborted) throw signal.reason; throw error; }
  finally { owned.phase = "closed"; }
}

import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, mkdtemp, realpath, link, rm, rmdir, readdir, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { assertLocalMediaPath } from "../shared/localMediaPath";
import { readBoundedFile } from "../shared/boundedFile";
import { resolveMediaPath, runProcess, FFMPEG_PROGRESS_ARGS } from "./mediaProcess";
import { withRenderLifetime, assertRenderActive, fullDecodeTimeoutMs, renderLifetimeAbort } from "./renderLifetime";
import { sourcePreservingVolumeWatchV1, type SourcePreservingVolumeProbeV1 } from "./sourcePreservingVolumeV1";
import { admitSourcePreservingProjectV1, admitSourcePreservingMp4V1, SOURCE_PRESERVING_POLICY_V1 } from "./sourcePreservingAdmissionV1";
import { assertProofStillRouteV1 } from "./proofStillRouteV1";

const CHUNK_BYTES = 1024 ** 2, hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export interface SourcePreservingRuntimeV1 {
  assetBase: string; ffmpegPath: string; ffprobePath: string; expectedSourceSha256: string;
  policy: typeof SOURCE_PRESERVING_POLICY_V1; signal?: AbortSignal; timeoutMs?: number;
  onCopyProgress?: (bytes: number, total: number) => void;
  withPublicationGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
}
export interface SourcePreservingDependenciesV1 { run: typeof runProcess; volumeProbe?: SourcePreservingVolumeProbeV1 }
async function handleSha(handle: FileHandle, size: number) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES), digest = createHash("sha256"); let position = 0;
  while (position < size) {
    assertRenderActive(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) throw Error("SOURCE_PRESERVING_SOURCE_ENDED_EARLY");
    digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  assertRenderActive(); return digest.digest("hex");
}
/** First LV-03 branch: whole original MP4 bytes; trimmed/GOP/hybrid paths remain separate. */
export async function renderSourcePreservingProjectV1(project: EditProject, outputPath: string, runtime: SourcePreservingRuntimeV1,
  dependencies: SourcePreservingDependenciesV1 = { run: runProcess }) {
  assertProofStillRouteV1(project, "source-preserving-v1");
  const started = performance.now(), projectSha256 = hash(project), admission = admitSourcePreservingProjectV1(project, runtime.policy);
  if (!/^[a-f0-9]{64}$/.test(runtime.expectedSourceSha256)) throw Error("SOURCE_PRESERVING_SOURCE_SHA_REQUIRED");
  const sourcePath = resolveMediaPath(admission.sourceUri, runtime.assetBase), output = resolve(outputPath), parent = dirname(output);
  for (const path of [sourcePath, output, runtime.ffmpegPath, runtime.ffprobePath]) { assertLocalMediaPath(path); if (!isAbsolute(path)) throw Error("SOURCE_PRESERVING_ABSOLUTE_PATH_REQUIRED"); }
  if (extname(sourcePath).toLowerCase() !== ".mp4" || extname(output).toLowerCase() !== ".mp4" || sourcePath.toLowerCase() === output.toLowerCase()) throw Error("SOURCE_PRESERVING_CONTAINER_OR_ALIAS_INVALID");
  return withRenderLifetime({ signal: runtime.signal, timeoutMs: runtime.timeoutMs, workSeconds: admission.expectedDuration }, async () => {
    await mkdir(parent, { recursive: true });
    if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw Error("SOURCE_PRESERVING_OUTPUT_PARENT_LINK");
    try { await lstat(output); throw Error("SOURCE_PRESERVING_OUTPUT_EXISTS"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const source = await open(sourcePath, "r");
    let workspace: string | undefined, temporary: string | undefined, target: FileHandle | undefined, targetIdentity: { dev: number; ino: number } | undefined;
    let monitor: ReturnType<typeof sourcePreservingVolumeWatchV1> | undefined;
    let workspaceIdentity: { dev: number; ino: number } | undefined;
    const token = randomUUID(), owner = JSON.stringify({ schema: "editkin.source-preserving-work/v1", pid: process.pid, token });
    try {
      const sourceBefore = await source.stat({ bigint: true });
      const assertStableSource = async () => {
        const current = await source.stat({ bigint: true });
        if (current.dev !== sourceBefore.dev || current.ino !== sourceBefore.ino || current.size !== sourceBefore.size
          || current.mtimeNs !== sourceBefore.mtimeNs || current.ctimeNs !== sourceBefore.ctimeNs) throw Error("SOURCE_PRESERVING_SOURCE_CHANGED");
      };
      if (!sourceBefore.isFile() || sourceBefore.size <= 0n || sourceBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("SOURCE_PRESERVING_SOURCE_INVALID");
      const size = Number(sourceBefore.size);
      workspace = await mkdtemp(join(parent, ".editkin-source-preserving-work-"));
      const createdWork = await lstat(workspace); if (createdWork.isSymbolicLink()) throw Error("SOURCE_PRESERVING_WORK_LINK");
      workspaceIdentity = { dev: createdWork.dev, ino: createdWork.ino };
      await writeFile(join(workspace, "owner.json"), owner, { flag: "wx" });
      monitor = sourcePreservingVolumeWatchV1({ workRoot: workspace, stagingLimitBytes: CHUNK_BYTES, probe: dependencies.volumeProbe,
        requirements: [{ path: parent, initialBytes: size + 65_536, reserveBytes: 1024 ** 3 },
          { path: process.env.SystemRoot ?? parent, initialBytes: 0, reserveBytes: 2 * 1024 ** 3 }], onFailure: renderLifetimeAbort()! });
      await monitor.check(); monitor.start();
      const sourceSha256 = await handleSha(source, size); if (sourceSha256 !== runtime.expectedSourceSha256) throw Error("SOURCE_PRESERVING_SOURCE_SHA_MISMATCH");
      temporary = join(parent, `.${basename(output)}.${token}.source-preserving.part.mp4`);
      target = await open(temporary, "wx+"); targetIdentity = await target.stat();
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES), digest = createHash("sha256"); let copied = 0, checked = 0;
      while (copied < size) {
        assertRenderActive(); const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - copied), copied);
        if (!bytesRead) throw Error("SOURCE_PRESERVING_SOURCE_ENDED_EARLY");
        digest.update(buffer.subarray(0, bytesRead)); let offset = 0;
        while (offset < bytesRead) { const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset, copied + offset); if (!bytesWritten) throw Error("SOURCE_PRESERVING_WRITE_STALLED"); offset += bytesWritten; }
        copied += bytesRead; runtime.onCopyProgress?.(copied, size);
        if (copied - checked >= 64 * 1024 ** 2) { await monitor.check(); checked = copied; }
      }
      await target.sync(); assertRenderActive(); await monitor.check();
      if (digest.digest("hex") !== sourceSha256 || (await target.stat()).size !== size || await handleSha(target, size) !== sourceSha256) throw Error("SOURCE_PRESERVING_COPY_BYTES_MISMATCH");
      await assertStableSource();
      const probeResult = await dependencies.run(runtime.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", temporary], 30_000, { completeStdoutMaxChars: 1_048_576 });
      const probeBytes = Buffer.from(probeResult.stdout); if (probeBytes.length > 1_048_576) throw Error("SOURCE_PRESERVING_PROBE_BUDGET");
      const media = admitSourcePreservingMp4V1(JSON.parse(probeBytes.toString("utf8")), admission);
      const decode = await dependencies.run(runtime.ffmpegPath, ["-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-i", temporary,
        "-map", "0:v:0", "-map", "0:a?", "-fps_mode", "passthrough", "-f", "null", ...FFMPEG_PROGRESS_ARGS, "-"], fullDecodeTimeoutMs(media.duration), undefined, { ffmpegProgress: true });
      const frameMatches = [...decode.stdout.matchAll(/^frame=[ \t]*(\d+)[ \t]*\r?$/gm)], decodedFrames = Number(frameMatches.at(-1)?.[1]);
      if (!Number.isSafeInteger(decodedFrames) || decodedFrames < 1 || !/^progress=end\r?$/m.test(decode.stdout)) throw Error("SOURCE_PRESERVING_DECODE_FRAME_COUNT_MISSING");
      if ((await target.stat()).size !== size || await handleSha(target, size) !== sourceSha256) throw Error("SOURCE_PRESERVING_CANDIDATE_CHANGED");
      await monitor.check();
      const publish = async () => {
        assertRenderActive(); if (hash(project) !== projectSha256) throw Error("SOURCE_PRESERVING_PROJECT_CHANGED");
        await assertStableSource();
        // A caller may wait for the project lease after decode. Rebind bytes under that lease.
        if ((await target!.stat()).size !== size || await handleSha(target!, size) !== sourceSha256) throw Error("SOURCE_PRESERVING_CANDIDATE_CHANGED");
        const current = await lstat(temporary!); if (current.isSymbolicLink() || current.dev !== targetIdentity!.dev || current.ino !== targetIdentity!.ino) throw Error("SOURCE_PRESERVING_CANDIDATE_OWNER_CHANGED");
        // Atomic create-only link: existing user output is never overwritten by rename.
        await link(temporary!, output);
        const published = await lstat(output);
        if (published.isSymbolicLink() || published.dev !== targetIdentity!.dev || published.ino !== targetIdentity!.ino || published.size !== size) throw Error("SOURCE_PRESERVING_PUBLICATION_OWNER_CHANGED");
      };
      if (runtime.withPublicationGuard) await runtime.withPublicationGuard(publish); else await publish();
      return { schema: "editkin.source-preserving-export/v1" as const, status: "SOURCE_BYTES_AND_DECODE_VERIFIED" as const,
        outputPath: output, duration: media.duration, decodedVideoFrames: decodedFrames, sourceSha256, outputSha256: sourceSha256, bytes: size,
        projectSha256, admission, media, transport: "pinned_handle_whole_container_copy" as const, pixelOrAudioEncodingPasses: 0,
        metadataPreservedBitExact: true, fullDecodeVerified: true, publicationIdentityVerified: true, maximumCopyChunkBytes: CHUNK_BYTES, maximumPendingWrites: 1,
        mediaStagingBytes: 0, volumeWatch: monitor.receipt, elapsedMs: performance.now() - started, qualityCertified: false,
        claimScope: "complete unmodified original MP4 only; no GOP trim/hybrid, frame-rate conversion, art or12h speed certificate" };
    } finally {
      await monitor?.stop(); await target?.close(); await source.close();
      if (temporary && targetIdentity) {
        const current = await lstat(temporary).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (current) { if (current.isSymbolicLink() || current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino) throw Error("SOURCE_PRESERVING_CLEANUP_OWNER_CHANGED"); await rm(temporary); }
      }
      if (workspace) {
        const current = await lstat(workspace);
        if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase() || current.isSymbolicLink()
          || current.dev !== workspaceIdentity?.dev || current.ino !== workspaceIdentity?.ino
          || (await readBoundedFile(join(workspace, "owner.json"), 1024)).toString("utf8") !== owner
          || (await readdir(workspace)).join() !== "owner.json") throw Error("SOURCE_PRESERVING_WORK_OWNER_CHANGED");
        await rm(join(workspace, "owner.json")); await rmdir(workspace);
      }
    }
  });
}

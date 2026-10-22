import { createHash, randomUUID } from "node:crypto";
import { open, lstat, mkdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runAnalysisProcess } from "../application/analysisProcess";
import { assertRenderDiskSpace, exportDiskRequirements } from "./renderDiskSpace";
import { assertRenderActive, MAX_RENDER_TIMER_MS, publishRenderOutput, renderLifetimeRemainingMs, renderLifetimeSignal, withRenderLifetime } from "./renderLifetime";
import { LONGFORM_AUDIO_TARGET_V1, longformAudioDeliveryMeasurementFilterV1, longformAudioSecondPassFilterV1, longformAudioPeakCompensationV1,
  parseLongformEbur128V1, parseLongformLoudnormV1, parseLongformPcmProbeV1 } from "./longformAudioLoudnessV1";

export interface LongformAudioMasterOptionsV1 {
  inputPath: string; outputPath: string; ffmpegPath: string; ffprobePath: string;
  signal?: AbortSignal; timeoutMs?: number;
}
const identity = (s: Awaited<ReturnType<typeof lstat>>) => JSON.stringify({ dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
async function currentFile(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) throw new Error("LONGFORM_AUDIO_FILE_INVALID");
  const handle = await open(path, "r");
  try {
    const digest = createHash("sha256"), chunk = Buffer.allocUnsafe(512 * 1024); let position = 0;
    for (;;) {
      assertRenderActive(); const result = await handle.read(chunk, 0, chunk.length, position);
      if (!result.bytesRead) break; position += result.bytesRead; digest.update(chunk.subarray(0, result.bytesRead));
    }
    if (identity(before) !== identity(await handle.stat()) || identity(before) !== identity(await lstat(path))) throw new Error("LONGFORM_AUDIO_FILE_CHANGED");
    return { sha256: digest.digest("hex"), bytes: before.size, statIdentity: identity(before) };
  } finally { await handle.close(); }
}
const probeArgs = (path: string) => ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,time_base,duration_ts:format=duration", "-of", "json", path];

/** Standalone WAV backend. Project premix/final-video mux and the remaining longform QA are separate consumers. */
export async function renderLongformAudioMasterV1(options: LongformAudioMasterOptionsV1) {
  const started = performance.now(); options.signal?.throwIfAborted();
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_RENDER_TIMER_MS)) {
    throw new Error("LONGFORM_AUDIO_TIMEOUT_INVALID");
  }
  for (const path of [options.inputPath, options.outputPath, options.ffmpegPath, options.ffprobePath]) {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("LONGFORM_AUDIO_PATH_INVALID");
  }
  const inputPath = resolve(options.inputPath), outputPath = resolve(options.outputPath);
  if (inputPath.toLowerCase() === outputPath.toLowerCase() || [inputPath, outputPath].some(path => extname(path).toLowerCase() !== ".wav")) {
    throw new Error("LONGFORM_AUDIO_REQUIRES_DISTINCT_WAV_PATHS");
  }
  const metadata = await runAnalysisProcess(options.ffprobePath, probeArgs(inputPath), { signal: options.signal,
    timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000), label: "長片音訊格式檢查", maximumStdout: 65_536, maximumStderr: 100_000 });
  const sourceProbe = parseLongformPcmProbeV1(metadata.stdout.toString("utf8"));
  const remaining = options.timeoutMs === undefined ? undefined : options.timeoutMs - (performance.now() - started);
  return withRenderLifetime({ signal: options.signal, timeoutMs: remaining, workSeconds: 3 * sourceProbe.durationSeconds }, async () => {
    const sourceBefore = await currentFile(inputPath), ffmpegBefore = await currentFile(options.ffmpegPath), ffprobeBefore = await currentFile(options.ffprobePath);
    const run = (executable: string, args: string[], label: string, maximumStdout = 0) => runAnalysisProcess(executable, args, {
      signal: renderLifetimeSignal(), timeoutMs: renderLifetimeRemainingMs()!, label, maximumStdout, maximumStderr: 100_000 });
    await assertRenderDiskSpace(exportDiskRequirements(outputPath, sourceProbe.samples * 2 * 3 + 4096, 0));
    await mkdir(dirname(outputPath), { recursive: true });
    const candidate = resolve(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.master.wav`);
    const reservation = await open(candidate, "wx"); await reservation.close();
    let published = false;
    try {
      const common = ["-hide_banner", "-nostdin", "-nostats", "-i", inputPath, "-map", "0:a:0", "-vn"];
      const first = await run(options.ffmpegPath, [...common, "-af", longformAudioDeliveryMeasurementFilterV1, "-f", "null", "-"], "長片音訊第一遍量測");
      const firstPass = parseLongformLoudnormV1(first.stderr);
      const firstPassDeliveryEbur128 = parseLongformEbur128V1(first.stderr);
      const peakCompensation = longformAudioPeakCompensationV1(firstPass, firstPassDeliveryEbur128);
      const second = await run(options.ffmpegPath, ["-y", ...common, "-af", longformAudioSecondPassFilterV1(firstPass, peakCompensation.internalTruePeakDbtp),
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", "-rf64", "auto", candidate], "長片音訊第二遍正規化");
      const secondPass = parseLongformLoudnormV1(second.stderr);
      const outputProbe = parseLongformPcmProbeV1((await run(options.ffprobePath, probeArgs(candidate), "長片音訊輸出格式檢查", 65_536)).stdout.toString("utf8"));
      if (outputProbe.codecName !== "pcm_s24le" || outputProbe.samples !== sourceProbe.samples) throw new Error("LONGFORM_AUDIO_OUTPUT_SAMPLE_CLOCK_CHANGED");
      const ebur128 = parseLongformEbur128V1((await run(options.ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-i", candidate,
        "-map", "0:a:0", "-vn", "-af", "ebur128=framelog=verbose:peak=true", "-f", "null", "-"], "長片音訊 ebur128 驗證")).stderr);
      if (ebur128.integratedLufs !== LONGFORM_AUDIO_TARGET_V1.integratedLufs || ebur128.truePeakDbtp > LONGFORM_AUDIO_TARGET_V1.truePeakDbtp) {
        throw new Error("LONGFORM_AUDIO_OUTPUT_LOUDNESS_TARGET_NOT_REPORTED");
      }
      const sourceAfter = await currentFile(inputPath), ffmpegAfter = await currentFile(options.ffmpegPath), ffprobeAfter = await currentFile(options.ffprobePath);
      if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("LONGFORM_AUDIO_SOURCE_CHANGED");
      if (JSON.stringify(ffmpegAfter) !== JSON.stringify(ffmpegBefore) || JSON.stringify(ffprobeAfter) !== JSON.stringify(ffprobeBefore)) throw new Error("LONGFORM_AUDIO_EXECUTABLE_CHANGED");
      const outputIdentity = await currentFile(candidate); assertRenderActive(); await publishRenderOutput(candidate, outputPath); published = true;
      return { schema: "editkin.longform-audio-master/v1" as const, status: "AUDIO_MASTER_RENDERED" as const, outputPath,
        targets: LONGFORM_AUDIO_TARGET_V1, firstPass, firstPassDeliveryEbur128, peakCompensation, secondPass, ebur128, sourceProbe, outputProbe,
        sourceIdentity: sourceBefore, outputIdentity: { sha256: outputIdentity.sha256, bytes: outputIdentity.bytes },
        executables: { ffmpeg: ffmpegBefore, ffprobe: ffprobeBefore }, sourceVerifiedBeforeAndAfter: true as const,
        finalVideoMuxVerified: false as const, subtitleAsrSyncVerified: false as const, otherLongformQaVerified: false as const };
    } finally { if (!published) await unlink(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  });
}

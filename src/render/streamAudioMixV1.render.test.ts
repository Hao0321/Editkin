import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import { shiftedClipAudioEnvelope, withClipAudioFades, withClipVolumePoint } from "../domain/clipAudioEnvelope";
import { buildRenderPlan } from "./planner";
import { buildStreamAudioMixV1 } from "./streamAudioMixV1";
import { captureLegacyAudioCommandV1, stabilizeLegacySidechainEofV1 } from "./streamAudioMixV1.fixture";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { startStreamEncoderV1 } from "./streamEncoderV1";
import { FFMPEG_PROGRESS_ARGS } from "./mediaProcess";

const temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string, png: Buffer;
beforeAll(async () => {
  root = await temp.create("editkin-stream-audio-real-");
  for (const frequency of [440, 1000]) await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    `sine=frequency=${frequency}:sample_rate=48000:duration=4`, "-c:a", "pcm_s16le", join(root, `${frequency}.wav`)], 30_000);
  await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=green:size=64x32:rate=30", "-frames:v", "1",
    "-c:v", "png", "-threads:v", "1", join(root, "source.png")], 30_000);
  png = await readFile(join(root, "source.png"));
}, 60_000);

describe("real streaming audio with owned FFmpeg video pipe", () => {
  it.each(["silence", "music", "ducked-envelope-trim"])("keeps %s PCM and AAC sample identity without a prepared audio bed", async variant => {
    const ffBefore = sha(await readFile(ffmpeg)), fpBefore = sha(await readFile(ffprobe));
    const { project, clip } = audioEnvelopeFixture(); project.assets[0].uri = join(root, "440.wav");
    clip.timelineStart = .4; clip.sourceStart = .2; clip.duration = 2; clip.volume = .4;
    if (variant === "silence") clip.volume = 0;
    if (variant === "music") project.assets[0].role = "background-music";
    if (variant === "ducked-envelope-trim") {
      clip.audioEnvelope = withClipAudioFades(clip, .3, .4);
      for (const [id, time, db] of [["a", 0, -30], ["b", .8, 6], ["c", 2, -12]] as const)
        clip.audioEnvelope = withClipVolumePoint(clip, { id, time, db });
      clip.audioEnvelope = shiftedClipAudioEnvelope(clip, .2);
      project.assets.push({ ...project.assets[0], id: "music", uri: join(root, "1000.wav"), role: "background-music" });
      project.tracks.push({ ...project.tracks[1], id: "music-track", name: "Owned music", clips: [{ ...structuredClone(clip), id: "music-clip", trackId: "music-track", assetId: "music", sourceStart: 0, timelineStart: 0, duration: 2.4, volume: .2, audioEnvelope: undefined }] });
    }
    const plan = { ...buildRenderPlan(project, path => path), duration: 2.4 }, before = structuredClone(project);
    const legacy = await captureLegacyAudioCommandV1(project, plan, path => probeMedia(path, ffprobe));
    const zero = await buildStreamAudioMixV1(project, plan, { inputOffset: 0, ffprobePath: ffprobe });
    const filterIndex = legacy.indexOf("-filter_complex");
    const originalLegacyFilter = legacy[filterIndex + 1];
    legacy[filterIndex + 1] = stabilizeLegacySidechainEofV1(originalLegacyFilter, plan.duration);
    const referencePcm = join(root, `${variant}-reference.f32le`), candidatePcm = join(root, `${variant}-candidate.f32le`);
    const pcmOutput = ["-map", "[aout]", "-vn", "-c:a", "pcm_f32le", "-ar", "48000", "-ac", "2", "-t", "2.4", "-f", "f32le"];
    await runProcess(ffmpeg, [...legacy.slice(0, filterIndex), "-filter_complex", legacy[filterIndex + 1], ...pcmOutput, referencePcm], 30_000);
    await runProcess(ffmpeg, ["-nostdin", "-v", "error", ...zero.inputArgs, "-filter_complex", zero.filterComplex, ...pcmOutput, candidatePcm], 30_000);
    const reference = await readFile(referencePcm), candidate = await readFile(candidatePcm);
    expect(candidate.equals(reference), `PCM ${sha(candidate)} != ${sha(reference)}`).toBe(true); expect(candidate.length).toBe(115_200 * 2 * 4);
    if (variant === "ducked-envelope-trim") {
      const amplitude = (bytes: Buffer, time: number) => {
        const first = Math.round(time * 48_000), count = 480; let real = 0, imaginary = 0;
        for (let n = 0; n < count; n++) { const value = bytes.readFloatLE((first + n) * 8), angle = 2 * Math.PI * 1000 * n / 48_000;
          real += value * Math.cos(angle); imaginary -= value * Math.sin(angle); }
        return 2 * Math.hypot(real, imaginary) / count;
      };
      expect(amplitude(candidate, 2.3)).toBeGreaterThan(.005);
      expect(amplitude(candidate, 2.38)).toBeGreaterThan(.0005);
      expect(amplitude(candidate, 2.38)).toBeLessThan(amplitude(candidate, 2.3));
      const truncated = Buffer.from(candidate); truncated.fill(0, Math.round(2.28 * 48_000) * 8);
      expect(amplitude(truncated, 2.3)).toBe(0); // calibrated EOF-tail-loss negative control
    }
    const legacyAac = join(root, `${variant}-reference.m4a`);
    await runProcess(ffmpeg, [...legacy.slice(0, -1), legacyAac], 30_000);
    const audio = await buildStreamAudioMixV1(project, plan, { inputOffset: 1, ffprobePath: ffprobe });
    const script = join(root, `${variant}-audio-filter.txt`), output = join(root, `${variant}-piped.mp4`);
    await writeFile(script, audio.filterComplex, { flag: "wx" });
    const controller = new AbortController(), encoder = startStreamEncoderV1({ executable: ffmpeg, timeoutMs: 30_000, stallMs: 15_000,
      maximumWriteBytes: 1024 ** 2, expectedWrites: 72, signal: controller.signal,
      args: ["-n", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-thread_queue_size", "1", "-framerate", "30", "-c:v", "png", "-i", "pipe:0",
        ...audio.inputArgs, "-filter_complex_script", script, "-map", "0:v:0", "-map", audio.outputLabel,
        "-frames:v", "72", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", ...audio.codecArgs, "-t", "2.4", ...FFMPEG_PROGRESS_ARGS, output] });
    try { for (let frame = 0; frame < 72; frame++) await encoder.write(png); await encoder.finish(); }
    finally { if (!encoder.closed) await encoder.stop(Error("owned fixture ended")); }
    const decoded: Buffer[] = [];
    for (const [index, source] of [legacyAac, output].entries()) {
      const path = join(root, `${variant}-decoded-${index}.f32le`);
      await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-i", source, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", "-f", "f32le", path], 30_000);
      decoded.push(await readFile(path));
    }
    expect(decoded[1].equals(decoded[0]), `AAC ${sha(decoded[1])} != ${sha(decoded[0])}`).toBe(true);
    const probe = await probeMedia(output, ffprobe); expect(probe.hasVideo && probe.hasAudio).toBe(true); expect(probe.duration).toBeCloseTo(2.4, 2);
    expect(project).toEqual(before); expect(encoder.receipt.writes).toBe(72); expect(encoder.closed).toBe(true);
    expect(sha(await readFile(ffmpeg))).toBe(ffBefore); expect(sha(await readFile(ffprobe))).toBe(fpBefore);
    await writeFile(join(root, `${variant}-receipt.json`), JSON.stringify({ variant, classification: "SYNTHETIC_AUDIO_AND_PNG_TRANSPORT_ONLY",
      ffmpegSha256: ffBefore, ffprobeSha256: fpBefore, pcmBytes: candidate.length, pcmSha256: sha(candidate), decodedAacSha256: sha(decoded[1]),
      originalLegacyFilter, sidechainEofCorrection: legacy[filterIndex + 1] !== originalLegacyFilter,
      correctedLegacyPcmIdentical: true, correctedLegacyDecodedAacIdentical: true, pipe: encoder.receipt, noPreparedAudioInput: true,
      twelveHourSpeedQualityMemory: "NOT_CHECKED", probe }, null, 2), { flag: "wx" });
  }, 90_000);
});

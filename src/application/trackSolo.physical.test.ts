// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { trackSoloFixture } from "./trackSolo.fixture";
import { runConversionProcess, mediaFileSha256 } from "./mediaConversion";
import { stageNativeAudioPreview } from "./nativeAudioPreview";
import { exportVideo } from "./exportVideo";
import { applyCommand } from "../domain/commands";
import { planAudioDetach } from "./audioDetach";

const app = resolve(import.meta.dirname, "../.."), work = join(app, ".rd/benchmarks/usable-v1-20261009/work/r57-b3-codex");
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const preserve = process.env.EDITKIN_B3_WRITE_PHYSICAL_RECEIPTS === "1";
let root: string, video: string, audio: string, baseline: { a440: number; a880: number }, baselinePath: string;
const evidence: Record<string, unknown>[] = [];
beforeAll(async () => {
  const attempt = process.env.EDITKIN_B3_PHYSICAL_ATTEMPT ?? "ATTEMPT1"; if (!/^[A-Z0-9_]+$/.test(attempt)) throw Error("Invalid receipt attempt");
  root = preserve ? join(work, "media", `physical-${attempt.toLowerCase()}`) : await mkdtemp(join(tmpdir(), "editkin-b3-solo-real-"));
  if (preserve) await mkdir(root);
  video = join(root, "video-440.mp4"); audio = join(root, "tone-880.wav");
  await runConversionProcess(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  await runConversionProcess(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=5", "-c:a", "pcm_s16le", audio]);
}, 60_000);
afterAll(async () => {
  if (!root) return;
  if (preserve) await writeFile(join(work, `PHYSICAL_AUDIO_${process.env.EDITKIN_B3_PHYSICAL_ATTEMPT ?? "ATTEMPT1"}.json`), JSON.stringify({ status: evidence.length === 3 ? "ACTUAL_PREVIEW_PCM_EXPORT_SOLO_DETACH_GREEN" : "INCOMPLETE", evidence, root, nativeHardwareOutputCertified: false }, null, 2) + "\n", { flag: "wx" });
  else { if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-b3-solo-real-")) throw Error("Unowned fixture cleanup"); await rm(root, { recursive: true, force: true }); }
});
function spectrum(samples: number[], rate = 48000) {
  const amplitude = (frequency: number) => { let re = 0, im = 0; const start = Math.min(4800, Math.floor(samples.length / 4)), count = Math.min(24000, samples.length - start);
    for (let i = 0; i < count; i++) { const angle = 2 * Math.PI * frequency * i / rate, sample = samples[start + i]; re += sample * Math.cos(angle); im += sample * Math.sin(angle); }
    return 2 * Math.hypot(re, im) / count; };
  return { a440: amplitude(440), a880: amplitude(880) };
}
function decode(path: string) {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", "0.2", "-i", path, "-t", "1", "-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"], { windowsHide: true, timeout: 60000, maxBuffer: 2_000_000 });
  if (result.status !== 0) throw Error(String(result.stderr));
  return spectrum(Array.from({ length: result.stdout.length / 4 }, (_, i) => result.stdout.readFloatLE(i * 4)));
}
async function render(project: ReturnType<typeof trackSoloFixture>, label: string) {
  const path = join(root, `${label}-export.mp4`);
  const result = await exportVideo({ project, outputPath: path, options: { ffmpegPath, ffprobePath, preferGpu: false, workRoot: join(root, `render-${label}`), timeoutMs: 120_000 } });
  return { path, result, sha256: await mediaFileSha256(path), spectrum: decode(path) };
}
describe("real 440/880 Hz media across solo and audio detach", () => {
  it("exports both original tracks before solo, establishing an audible baseline", async () => {
    const output = await render(trackSoloFixture(video, audio), "baseline"); baseline = output.spectrum; baselinePath = output.path;
    expect(baseline.a440).toBeGreaterThan(.005); expect(baseline.a880).toBeGreaterThan(.005);
    evidence.push({ check: "baseline-two-tones", ...output });
  }, 150_000);
  it("stages only the solo track as native preview PCM and exports only that tone", async () => {
    const project = trackSoloFixture(video, audio); project.tracks.find(track => track.kind === "audio")!.solo = true;
    const preview = await stageNativeAudioPreview(project, { ffmpegPath, ffprobePath, cacheRoot: join(root, "preview-solo"), timelineStartSeconds: .2, maxDurationSeconds: 1 });
    expect(preview.sourcePcm.map(source => source.clipId)).toEqual(["solo-sound"]);
    const pcm = await readFile(preview.sourcePcm[0].path), measured = spectrum(Array.from({ length: pcm.length / 8 }, (_, i) => pcm.readFloatLE(i * 8)));
    expect(measured.a880).toBeGreaterThan(.02); expect(measured.a440).toBeLessThan(measured.a880 / 50);
    const output = await render(project, "solo"); expect(output.spectrum.a880).toBeGreaterThan(.005); expect(output.spectrum.a440).toBeLessThan(output.spectrum.a880 / 15);
    expect(project.tracks[0].hidden).not.toBe(true); expect(baselinePath).toBeTruthy();
    evidence.push({ check: "solo-preview-pcm-and-export", preview, previewSpectrum: measured, ...output });
  }, 150_000);
  it("detaches aligned source audio without doubling it; preview and export retain both original tones", async () => {
    const project = trackSoloFixture(video, audio), clip = project.tracks[0].clips[0];
    const next = applyCommand(project, planAudioDetach(project, clip.id, { clipId: "detached", trackId: "detached-track" }).command);
    expect(next.tracks[0].clips[0].volume).toBe(0);
    const preview = await stageNativeAudioPreview(next, { ffmpegPath, ffprobePath, cacheRoot: join(root, "preview-detach"), timelineStartSeconds: .2, maxDurationSeconds: 1 });
    expect(preview.sourcePcm.map(source => source.clipId).sort()).toEqual(["detached", "solo-sound"]);
    const output = await render(next, "detached");
    expect(output.spectrum.a440 / baseline.a440).toBeGreaterThan(.85); expect(output.spectrum.a440 / baseline.a440).toBeLessThan(1.15);
    expect(output.spectrum.a880 / baseline.a880).toBeGreaterThan(.85); expect(output.spectrum.a880 / baseline.a880).toBeLessThan(1.15);
    evidence.push({ check: "detach-aligned-no-double-audio", preview, ...output });
  }, 150_000);
});

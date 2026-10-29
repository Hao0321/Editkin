// LONG-render runner controls on small synthetic sources (forceClass "long"): refusals before any work, guard stop and
// cancellation mid-encode with exact-path cleanup and the previous output preserved, and the resident stream v2 route
// on the real native compositor. Real FFmpeg; the only stubs are the volume probe of the guard control.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderProject, type RenderOptions } from "./ffmpeg";
import { probeVolumeSpace } from "./renderDiskSpace";
import { addCompositionFixtureV1 } from "./referencedCompositionPrepassV1.fixture";

const run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const native = resolve("native/bin/win32-x64/editkin-gpu-compositor.exe");
const nativeAvailable = process.platform === "win32" && existsSync(native);
const temp = useTempRoots();
let root = "", small = "", heavy = "", longAudio = "", plate = "";

beforeAll(async () => {
  root = await temp.create("long-runner-");
  small = join(root, "small-2s.mp4"); heavy = join(root, "heavy-1080p-8s.mp4"); longAudio = join(root, "video2s-audio3s.mp4"); plate = join(root, "plate.ekf32");
  const tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2", "-c:v", "libx264",
    "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-g", "30", ...tags, "-c:a", "aac", "-movflags", "+faststart", small], { windowsHide: true, timeout: 60_000 });
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=8", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=8", "-c:v", "libx264",
    "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-g", "30", ...tags, "-c:a", "aac", "-movflags", "+faststart", heavy], { windowsHide: true, timeout: 120_000 });
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", "-c:v", "libx264",
    "-preset", "veryfast", "-pix_fmt", "yuv420p", ...tags, "-c:a", "aac", "-movflags", "+faststart", longAudio], { windowsHide: true, timeout: 60_000 });
  const values = new Float32Array(64 * 36 * 4).fill(.18), bytes = Buffer.alloc(16 + values.length * 4);
  Buffer.from("EKF32V1\0", "binary").copy(bytes); bytes.writeUInt32LE(64, 8); bytes.writeUInt32LE(36, 12);
  values.forEach((value, index) => bytes.writeFloatLE(value, 16 + index * 4));
  await writeFile(plate, bytes);
}, 180_000);

function videoProject(uri: string, seconds: number, size: [number, number], aces2 = false): EditProject {
  const value = createEmptyProject("long runner control", { id: "long-runner", width: size[0], height: size[1], fps: 30 });
  value.assets.push({ id: "src", name: "source", kind: "video", uri, duration: seconds, width: size[0], height: size[1], displayAspectRatio: size[0] / size[1],
    color: { interpretation: "rec709", primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } });
  value.tracks[0].clips.push({ id: "clip", assetId: "src", trackId: value.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: seconds, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  if (aces2) value.colorManagement = { ...value.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  return value;
}

async function sandbox(name: string) {
  const folder = join(root, name), out = join(folder, "out"), work = join(folder, "work"), registry = join(folder, "registry");
  await mkdir(out, { recursive: true }); await mkdir(work); await mkdir(registry);
  const previous = join(out, "film.mp4");
  await writeFile(previous, "previous user output");
  const options = (patch: Partial<RenderOptions> = {}): RenderOptions => ({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"),
    timeoutMs: 300_000, workRoot: work, ...patch, longRender: { forceClass: "long", journalRegistryRoot: registry, ...patch.longRender } });
  const clean = async () => {
    expect(await readFile(previous, "utf8")).toBe("previous user output");
    expect(await readdir(out)).toEqual(["film.mp4"]);
    expect(await readdir(work)).toEqual([]);
    expect(await readdir(registry)).toEqual([]);
  };
  return { folder, out, work, registry, previous, options, clean };
}

const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
async function videoFrameMd5(path: string) {
  const { stdout } = await run(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"], { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return createHash("sha256").update(stdout.split(/\r?\n/).filter(line => line && !line.startsWith("#")).join("\n")).digest("hex");
}

describe("LONG render runner controls", () => {
  it("refuses unsupported LONG projects with stable codes before writing anything", async () => {
    const box = await sandbox("refusals");
    const linear = createEmptyProject("scene-linear", { width: 64, height: 36, fps: 30 });
    linear.assets.push({ id: "plate", name: "plate", kind: "image", uri: plate, duration: 1, width: 64, height: 36, alphaMode: "straight", color: { interpretation: "linear_rec709" } });
    linear.tracks[0].clips.push({ id: "p", assetId: "plate", trackId: linear.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
    linear.colorManagement = { ...linear.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
    await expect(renderProject(linear, box.previous, box.options({ gpuCompositorPath: native }))).rejects.toMatchObject({ code: "LONG_RENDER_ROUTE_NOT_AVAILABLE" });
    await expect(renderProject(videoProject(longAudio, 3, [640, 360]), box.previous, box.options())).rejects.toMatchObject({ code: "LONG_RENDER_SOURCE_SHORT" });
    await expect(renderProject(videoProject(small, 2, [640, 360]), box.previous, box.options({ workRoot: tmpdir() }))).rejects.toMatchObject({ code: "LONG_RENDER_WORK_ROOT_SYSTEM_TEMP" });
    await expect(renderProject(videoProject(small, 2, [640, 360]), box.previous, box.options({ longRender: { probe: async () => undefined } }))).rejects.toMatchObject({ code: "LONG_RENDER_VOLUME_UNKNOWN" });
    const precomp = videoProject(small, 2, [1920, 1080]); const clip = precomp.tracks[0].clips[0];
    addCompositionFixtureV1(precomp, "used", "src", 2); clip.assetId = "asset:used";
    await expect(renderProject(precomp, box.previous, box.options({ longRender: { policy: { stagingCapBytes: 1024 ** 2 } } }))).rejects.toMatchObject({ code: "LONG_RENDER_PREPASS_STAGING" });
    await expect(renderProject(videoProject(small, 2, [640, 360]), box.previous, box.options({ longRender: { policy: { ramBudgetBytes: 1024 } } }))).rejects.toMatchObject({ code: "LONG_RENDER_ROUTE_NOT_AVAILABLE" });
    await box.clean();
  }, 120_000);

  it("stops mid-encode when the output volume reaches reserve + burst, removes exactly its own paths and keeps the previous output", async () => {
    const box = await sandbox("guard-stop");
    let pressure = false, started = 0;
    const probe = async (path: string) => {
      const real = await probeVolumeSpace(path);
      if (!real || !pressure || !path.toLowerCase().startsWith(box.out.toLowerCase())) return real;
      return { ...real, availableBytes: 1024 ** 3 + 10 * 1024 ** 2 };
    };
    const error = await renderProject(videoProject(heavy, 8, [1920, 1080]), box.previous, box.options({ longRender: { probe,
      onRunStarted: () => { started = performance.now(); setTimeout(() => { pressure = true; }, 1_500); } } })).catch(caught => caught);
    expect(error).toMatchObject({ code: "LONG_RENDER_SPACE_SHORT" });
    expect(performance.now() - started).toBeLessThan(30_000);
    await box.clean();
  }, 180_000);

  it("cancels mid-encode within the release window and keeps the previous output", async () => {
    const box = await sandbox("cancel");
    const controller = new AbortController();
    let cancelledAt = 0;
    const error = await renderProject(videoProject(heavy, 8, [1920, 1080]), box.previous, box.options({ signal: controller.signal, longRender: {
      onRunStarted: () => { setTimeout(() => { cancelledAt = performance.now(); controller.abort(Error("owned cancel control")); }, 1_500); } } })).catch(caught => caught);
    const settled = performance.now() - cancelledAt;
    expect(String(error)).toMatch(/owned cancel control/);
    expect(cancelledAt).toBeGreaterThan(0);
    expect(settled).toBeLessThan(10_000);
    await box.clean();
  }, 180_000);

  it.skipIf(!nativeAvailable)("renders an ACES2 resident project through stream v2 with the same decoded video as the SHORT sequence route", async () => {
    const box = await sandbox("resident-v2");
    const shortOutput = join(box.folder, "short-v1.mp4");
    const short = await renderProject(videoProject(small, 2, [640, 360], true), shortOutput, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: native,
      preferGpu: false, fontRoot: resolve("public/fonts"), timeoutMs: 300_000, workRoot: box.work });
    expect(short.planner).toBe("editkin-resident-video-scene-linear-aces2-formal-sequence/v1");
    const long = await renderProject(videoProject(small, 2, [640, 360], true), box.previous, box.options({ gpuCompositorPath: native }));
    expect(long.planner).toBe("editkin-resident-video-scene-linear-aces2-formal-stream/v2");
    expect(long.longRender).toMatchObject({ route: "resident-stream-v2", residentStreamVersion: 2, cleanup: { leftovers: [] } });
    expect(long.residentStreamPipeline).toMatchObject({ consumedFrames: 60, maximumPendingFrames: 1, retainedConsumedFrames: 0, encoderClosed: true });
    expect(long.longRender!.publish.checks.every(check => check.ok)).toBe(true);
    expect(await videoFrameMd5(box.previous)).toBe(await videoFrameMd5(shortOutput));
    expect(await sha(box.previous)).not.toBe("");
    expect(await readdir(box.out)).toEqual(["film.mp4"]);
    expect(await readdir(box.work)).toEqual([]);
    expect(await readdir(box.registry)).toEqual([]);
  }, 300_000);
});

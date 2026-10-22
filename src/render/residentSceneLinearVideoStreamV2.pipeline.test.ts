import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { audioEnvelopeFixture } from "../domain/clipAudioEnvelope.fixture";
import type { GpuEngineVideoPreviewGraph } from "./gpuCompositor";
import { buildRenderPlan } from "./planner";
import { probeMedia, runProcess } from "./ffmpegMedia";
import { withRenderWorkRoot } from "./renderWorkspace";
import { renderResidentSceneLinearVideoStreamV2 } from "./residentSceneLinearVideoStreamV2";
import type { ResidentSceneLinearVideoSequenceReceipt } from "./residentSceneLinearVideoSequence";

const controlled = vi.hoisted(() => ({ produce: vi.fn() }));
// Deliberately controlled producer boundary. These controls prove orchestration/FFmpeg/cleanup, not native pixels.
vi.mock("./residentSceneLinearVideoSequence", () => ({ renderResidentSceneLinearVideoSequence: controlled.produce }));
const temp = useTempRoots(), ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
let root: string, png: Buffer;
beforeAll(async () => {
  root = await temp.create("editkin-resident-stream-pipeline-");
  const image = join(root, "source.png");
  await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=64x32:rate=30", "-frames:v", "1", "-threads:v", "1", image], 30_000);
  png = await readFile(image);
}, 40_000);
afterEach(() => controlled.produce.mockReset());

describe("version2 combined stream pipeline with real encoder and controlled PNG producer", () => {
  it.each(["complete", "cancel", "producer-failure", "qa-failure"])("handles %s with bounded staging and preserves publication rules", async mode => {
    const folder = join(root, mode); await mkdir(folder);
    const output = join(folder, "output.mp4"), old = Buffer.from("previous user output must survive failures");
    if (mode !== "complete") await writeFile(output, old);
    const work = join(folder, "owned-work"), controller = new AbortController();
    const { project, clip } = audioEnvelopeFixture(); project.width = 64; project.height = 32; clip.timelineStart = 0; clip.duration = 2; clip.volume = 0;
    const plan = buildRenderPlan(project, path => path);
    const preview = { graph: { timebase: { numerator: 1, denominator: 30 } }, assetBindings: [] } as unknown as GpuEngineVideoPreviewGraph;
    let workspace = "", observedPeak = 0, graphSize = 0;
    controlled.produce.mockImplementation(async (request: { outputDirectory: string; frameCount: number; frameSink: (path: string, frame: number) => Promise<void> }) => {
      workspace = resolve(request.outputDirectory, ".."); await mkdir(request.outputDirectory);
      await expect(stat(join(workspace, "audio.m4a"))).rejects.toMatchObject({ code: "ENOENT" });
      graphSize = (await stat(join(workspace, "audio-filter.txt"))).size;
      for (let frame = 0; frame < request.frameCount; frame++) {
        expect(await readdir(request.outputDirectory)).toEqual([]);
        if (frame === 2 && mode === "producer-failure") throw Error("owned producer failure");
        if (frame === 2 && mode === "cancel") { controller.abort(Error("human cancel")); controller.signal.throwIfAborted(); }
        const path = join(request.outputDirectory, `frame-${String(frame).padStart(8, "0")}.png`);
        await writeFile(path, png, { flag: "wx" }); observedPeak = Math.max(observedPeak, (await readdir(request.outputDirectory)).length);
        await request.frameSink(path, frame);
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const hash = createHash("sha256").update(png).digest("hex");
      return { firstFrameSha256: hash, lastFrameSha256: hash, frameCount: request.frameCount,
        testProducerClassification: "CONTROLLED_PNG_NOT_NATIVE_QUALITY" } as unknown as ResidentSceneLinearVideoSequenceReceipt;
    });
    const audioBed = vi.fn(async () => { throw Error("whole audio bed must never be prepared in version2"); });
    const operation = () => withRenderWorkRoot(output, work, () => renderResidentSceneLinearVideoStreamV2(project, preview, output, plan,
      { ffmpegPath: ffmpeg, ffprobePath: ffprobe, gpuCompositorPath: "controlled-source-boundary", signal: controller.signal }, "libx264", 30_000,
      { runProcess, renderAudioBed: audioBed, probeMedia: async (path, executable) => {
        const probe = await probeMedia(path, executable); return mode === "qa-failure" ? { ...probe, hasVideo: false } : probe;
      }, encoderArgs: () => ["-c:v", "libx264", "-crf", "18"], finite: value => String(value) }));
    if (mode === "complete") {
      const result = await operation(); expect(result.residentStreamPipeline?.consumedFrames).toBe(60);
      expect(result.residentStreamPipeline?.maximumPendingFrames).toBe(1); expect(result.residentStreamPipeline?.retainedConsumedFrames).toBe(0);
      expect(result.residentStreamPipeline?.encoderClosed).toBe(true); expect(result.residentStreamPipeline!.peakWorkBytes).toBeLessThan(1024 ** 2);
      expect((await probeMedia(output, ffprobe)).duration).toBeCloseTo(2, 2);
      await writeFile(join(folder, "receipt.json"), JSON.stringify({ classification: "ACTUAL_FFMPEG_CONTROLLED_PNG_PRODUCER", result, observedPeak, graphSize,
        nativeQualityTwelveHourAndPerformance: "NOT_CHECKED" }, null, 2), { flag: "wx" });
    } else {
      await expect(operation()).rejects.toThrow(mode === "cancel" ? "human cancel" : mode === "producer-failure" ? "owned producer failure" : "OUTPUT_QA_FAILED");
      expect(await readFile(output)).toEqual(old);
      expect((await readdir(folder)).filter(name => name.endsWith(".resident-stream.mp4"))).toEqual([]);
    }
    expect(audioBed).not.toHaveBeenCalled(); expect(observedPeak).toBe(1); expect(graphSize).toBeGreaterThan(0);
    await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readdir(work)).toEqual([]);
  }, 60_000);
});

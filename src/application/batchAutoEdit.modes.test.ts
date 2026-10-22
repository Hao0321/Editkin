import { writeProjectFileAtomic } from "./projectFiles";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBatchAutoEditItem } from "./batchAutoEdit";
import { AUTOMATIC_CAPTION_EMPTY_MESSAGE } from "./automaticCaptionOutcome";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function batch(options: { width: number; height: number; hasAudio: boolean; transcribe?: () => Promise<unknown>; smartCut?: () => Promise<unknown> }) {
  const root = await mkdtemp(join(tmpdir(), "editkin-batch-modes-"));
  roots.push(root);
  const source = join(root, "clip.mov");
  await writeFile(source, "fixture-only");
  const detectScenes = vi.fn(async (request: { threshold?: number }) => request.threshold === 1
    ? { cuts: [{ time: 3, score: 33, frame: 90 }, { time: 3.2, score: 29, frame: 96 }], engine: "ffmpeg-scdet-8" as const, threshold: 1, minSceneDuration: 0.2, analyzedSeconds: 30, elapsedMs: 1, cacheHit: false }
    : { cuts: [{ time: 15, score: 40, frame: 450 }], engine: "ffmpeg-scdet-8" as const, threshold: 10, minSceneDuration: 0.5, analyzedSeconds: 30, elapsedMs: 1, cacheHit: false });
  const smartCut = vi.fn(options.smartCut ?? (async () => { throw new Error("no silence evidence in this fixture"); }));
  const result = await runBatchAutoEditItem({ jobId: "job-modes", sourcePath: source, outputRoot: root, targetRatio: 0.65, addMusic: false }, {
    ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", modelRoot: join(root, "models"),
  }, {
    hashFile: async () => "a".repeat(64),
    inspect: async () => ({ duration: 30, width: options.width, height: options.height, hasVideo: true, hasAudio: options.hasAudio }),
    transcribe: (options.transcribe ?? (async () => { throw new Error("transcribe must not run"); })) as never,
    detectScenes: detectScenes as never,
    smartCut: smartCut as never,
    writeProject: writeProjectFileAtomic,
    render: async ({ outputPath }) => { await writeFile(outputPath, "rendered"); return { outputPath, duration: 1, encoder: "libx264", planner: "fixture", ffmpegVersion: "fixture" }; },
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
  const kept = result.project?.tracks.find((track) => track.id === "video-main")?.clips.reduce((sum, clip) => sum + clip.duration, 0) ?? 0;
  return { result, detectScenes, smartCut, kept, note: result.project?.director.markers.at(-1)?.note ?? "" };
}

const transcript = (cues: Array<{ start: number; end: number; text: string }>) => async () => ({ cues, engine: "fixture", modelId: "fixture", modelSha256: "b".repeat(64), language: "zh", analyzedSeconds: 30, elapsedMs: 1, modelDownloaded: false, cacheHit: true, acceleration: "cpu" });
const CUES = [
  { start: 0.5, end: 6, text: "這支影片教你三個剪輯技巧" }, { start: 6.3, end: 11, text: "第一個是先剪掉停頓" },
  { start: 14, end: 20, text: "第二個是字幕要放在安全區" }, { start: 24, end: 29.5, text: "第三個是配樂要依題材" },
];

describe("batch auto edit keeps narration and survives footage without speech (roadmap 1.14)", () => {
  it("a horizontal (long-form) source keeps every spoken cue whole even though the batch asks for 0.65", async () => {
    const smartCut = async () => ({ fps: 30, sourceFrames: 900, ranges: [{ startFrame: 0, endFrame: 345 }, { startFrame: 410, endFrame: 615 }, { startFrame: 710, endFrame: 900 }], removedFrames: 160, cutCount: 2, silenceCount: 2, thresholdDb: -35, analyzedSeconds: 30, engine: "fixture", cacheHit: false });
    const { result, kept, note } = await batch({ width: 1920, height: 1080, hasAudio: true, transcribe: transcript(CUES), smartCut });
    expect(result.status, result.error).toBe("completed");
    expect(result.project?.captions.map((caption) => caption.text)).toEqual(CUES.map((cue) => cue.text));
    for (const [index, caption] of (result.project?.captions ?? []).entries()) expect(caption.duration).toBeCloseTo(CUES[index].end - CUES[index].start, 1);
    expect(kept).toBeLessThan(30);
    expect(kept / 30).toBeGreaterThan(0.75);
    expect(note).toContain("editMode=narration-pause-trim");
  });

  it("falls back to transcript-only pause trimming when silence evidence is unavailable", async () => {
    const { result } = await batch({ width: 1920, height: 1080, hasAudio: true, transcribe: transcript(CUES) });
    expect(result.status, result.error).toBe("completed");
    expect(result.project?.captions).toHaveLength(4);
  });

  it("a vertical (Shorts) source still condenses speech", async () => {
    const { result, smartCut, note } = await batch({ width: 1080, height: 1920, hasAudio: true, transcribe: transcript(CUES) });
    expect(result.status, result.error).toBe("completed");
    expect(smartCut).not.toHaveBeenCalled();
    expect(note).toContain("editMode=highlight");
    expect(result.project?.captionStyle).toMatchObject({ fontSize: 95, marginV: 300, color: "#FFFFFF" });
  });

  it("no usable speech: picks steady footage instead of silence-cutting the scenery", async () => {
    const { result, detectScenes, smartCut, kept, note } = await batch({ width: 1080, height: 1920, hasAudio: true,
      transcribe: async () => { throw Object.assign(new Error(AUTOMATIC_CAPTION_EMPTY_MESSAGE), { code: "AUTOMATIC_CAPTION_EMPTY" }); } });
    expect(result.status, result.error).toBe("completed");
    expect(result.warnings[0]).toContain("畫面穩定度");
    expect(smartCut).not.toHaveBeenCalled();
    expect(detectScenes).toHaveBeenCalledTimes(2);
    expect(result.project?.captions).toHaveLength(0);
    expect(kept).toBeGreaterThanOrEqual(15);
    expect(kept).toBeLessThanOrEqual(23);
    expect(note).toContain("editMode=visual-quality");
  });

  it("ambient chatter that Whisper turned into boilerplate is not captioned", async () => {
    const { result, note } = await batch({ width: 1080, height: 1920, hasAudio: true,
      transcribe: transcript([{ start: 1, end: 3, text: "(people chattering)" }, { start: 9, end: 12, text: "Hãy subscribe cho kênh Ghiền Mì Gõ" }]) });
    expect(result.status, result.error).toBe("completed");
    expect(result.project?.captions).toHaveLength(0);
    expect(note).toContain("editMode=visual-quality");
    expect(note).toContain("speechFilter=no-usable-speech");
  });

  it("no audio track: same picture-steadiness edit, never a failure", async () => {
    const { result, kept, note } = await batch({ width: 1920, height: 1080, hasAudio: false });
    expect(result.status, result.error).toBe("completed");
    expect(result.warnings[0]).toContain("來源沒有音軌");
    expect(kept).toBeGreaterThan(20);
    expect(note).toContain("editMode=visual-quality");
  });
});

import { describe, expect, it, vi } from "vitest";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { dispatchCommand, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditorialProfileId, type MediaAsset } from "../domain/types";
import { createProjectSession } from "../application/projectSession";
import { AUTOMATIC_CAPTION_EMPTY_MESSAGE } from "../application/automaticCaptionOutcome";
import type { NativeEditingPolicy } from "../application/nativeAutopilotPolicy";
import type { HaoDesktopApi } from "./types";
import { useSemanticAutoEdit } from "./useSemanticAutoEdit";

// Actual hook body and real session/commands; the desktop engines are controlled doubles (no media is decoded).
vi.mock("react", () => ({ useState: (initial: unknown) => [initial, () => {}], useRef: (initial: unknown) => ({ current: initial }) }));

const music = (id: string, name: string, category: string) => ({ id: `music:${id}`, name, mediaKind: "audio", role: "background-music", category, domains: [category], duration: 90, bpm: 100, bytes: 1, license: "CC0-1.0", provenance: "test", redistributable: true });

function setup(options: { width?: number; height?: number; kind?: "video" | "audio"; profile?: EditorialProfileId; transcript: () => Promise<unknown>; smartCut?: () => Promise<unknown> }) {
  const width = options.width ?? 1920; const height = options.height ?? 1080;
  let project = createEmptyProject("夜市散步", { id: "modes", width, height, fps: 30 });
  project.editorialProfile = options.profile ?? "auto";
  const asset: MediaAsset = options.kind === "audio"
    ? { id: "source", name: "voice.wav", kind: "audio", uri: "D:/fixture/voice.wav", duration: 20 }
    : { id: "source", name: "walk.mov", kind: "video", uri: "D:/fixture/walk.mov", duration: 20, width, height };
  const trackId = options.kind === "audio" ? "audio-main" : "video-main";
  project = applyCommand(project, { type: "batch", commands: [{ type: "import_asset", asset }, { type: "add_clip", clip: {
    id: "clip", assetId: asset.id, trackId, timelineStart: 0, sourceStart: 0, duration: 20, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  } }] });
  const projectSession = createProjectSession(project);
  const musicAsset = { id: "music-asset", name: "Music", kind: "audio", uri: "creative://music", duration: 90 };
  const api = {
    automaticCaptionMedia: vi.fn(options.transcript),
    detectScenes: vi.fn(async (request: { threshold?: number }) => request.threshold === 1
      ? { cuts: [{ time: 2.2, score: 34, frame: 66 }, { time: 2.4, score: 30, frame: 72 }, { time: 2.6, score: 31, frame: 78 }] }
      : { cuts: [{ time: 10, score: 40, frame: 300 }] }),
    smartCutMedia: vi.fn(async (_request: { options?: unknown }) => (options.smartCut ?? (async () => ({ fps: 30, sourceFrames: 600, ranges: [{ startFrame: 0, endFrame: 600 }], removedFrames: 0, cutCount: 0, silenceCount: 0, thresholdDb: -35, analyzedSeconds: 20, engine: "fixture", cacheHit: false })))()),
    listCreativeLibrary: vi.fn(async () => ({ assets: [music("game", "電玩衝刺", "遊戲"), music("travel", "出國散步", "旅遊")] })),
    importCreativeAsset: vi.fn(async (id: string) => ({ asset: { ...musicAsset, name: id }, previewUrl: "preview://music" })),
    prepareMedia: vi.fn(async () => ({ assetId: musicAsset.id, runtimeUrls: {}, derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-10T00:00:00.000Z" }, cacheHit: false })),
    analyzeMotionTrack: vi.fn(),
  };
  const onStatus = vi.fn();
  const onCommand = vi.fn((command: EditorCommand) => { projectSession.setHistory((history) => dispatchCommand(history, command)); });
  const hook = useSemanticAutoEdit({ api: api as unknown as HaoDesktopApi, project, projectSession, selectedClip: project.tracks.flatMap((track) => track.clips)[0], onCommand, onStatus, onRuntimeUrls: vi.fn() });
  const present = () => projectSession.getSnapshot().history.present;
  return { api, hook, onStatus, onCommand, project, projectSession, present };
}

const speech = (cues: Array<{ start: number; end: number; text: string }>, extra: Record<string, unknown> = {}) => async () => ({ cues, engine: "fixture", modelId: "fixture", modelSha256: "b".repeat(64), language: "zh", analyzedSeconds: 20, elapsedMs: 1, acceleration: "cpu", modelDownloaded: false, cacheHit: false, ...extra });
const LONGFORM: NativeEditingPolicy = { format: "longform", ownership: "automatic" };

describe("in-app auto edit without speech (roadmap 1.14)", () => {
  it.each([
    ["an empty transcript", new Error(AUTOMATIC_CAPTION_EMPTY_MESSAGE)],
    ["no audio stream", new Error("FFmpeg whisper.cpp 轉錄失敗 (exit 1)：Stream map '0:a:0' matches no streams.")],
  ])("picks steady footage and adds genre music after %s instead of failing", async (_label, error) => {
    const f = setup({ width: 1080, height: 1920, profile: "travel", transcript: async () => { throw error; } });
    const outcome = await f.hook.runWithOutcome(LONGFORM);
    expect(outcome).toEqual({ ok: true, segmentCount: expect.any(Number), addedCaptions: 0, music: true });
    expect(f.api.detectScenes).toHaveBeenCalledTimes(2);
    expect(f.api.detectScenes.mock.calls[1][0]).toMatchObject({ threshold: 1, minSceneDuration: 0.2 });
    expect(f.api.importCreativeAsset).toHaveBeenCalledWith("music:travel");
    const result = f.present();
    const kept = result.tracks.find((track) => track.id === "video-main")!.clips.reduce((sum, clip) => sum + clip.duration, 0);
    expect(kept).toBeGreaterThanOrEqual(8);
    expect(kept).toBeLessThanOrEqual(20);
    expect(result.captions).toHaveLength(0);
    expect(result.director.markers.at(-1)?.note).toContain("editMode=visual-quality");
    expect(f.onCommand).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("0 句字幕 · 已配樂 · 短片字幕樣式"));
    expect(f.projectSession.getSnapshot().history.past).toHaveLength(1);
    f.projectSession.setHistory(undo);
    expect(f.present()).toEqual(f.project);
  });

  it("treats Whisper's ambient-only boilerplate as no speech: no garbage captions, picture-led cut", async () => {
    const hallucinated = [
      { start: 0, end: 3.02, text: "." }, { start: 2.98, end: 4.98, text: "ŋ ŋ ŋ ŋ ŋ ŋ ŋ ŋ" },
      { start: 8.96, end: 11.92, text: "outez, thanks for watching, itted, cherish, thank you very much ;)" },
    ];
    const f = setup({ width: 1080, height: 1920, profile: "travel", transcript: speech(hallucinated) });
    const outcome = await f.hook.runWithOutcome(LONGFORM);
    expect(outcome).toMatchObject({ ok: true, addedCaptions: 0, music: true });
    expect(f.present().captions).toHaveLength(0);
    const note = f.present().director.markers.at(-1)?.note ?? "";
    expect(note).toContain("editMode=visual-quality");
    expect(note).toContain("speechFilter=no-usable-speech");
  });

  it("still reports a real recognition failure as a failure", async () => {
    const f = setup({ transcript: async () => { throw new Error("model SHA-256 mismatch"); } });
    const outcome = await f.hook.runWithOutcome(LONGFORM);
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(f.onCommand).not.toHaveBeenCalled();
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("model SHA-256 mismatch"));
  });

  it("has nothing to pick from in audio without speech and says so", async () => {
    const f = setup({ kind: "audio", transcript: async () => { throw new Error(AUTOMATIC_CAPTION_EMPTY_MESSAGE); } });
    const outcome = await f.hook.runWithOutcome(LONGFORM);
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(f.onStatus).toHaveBeenLastCalledWith(expect.stringContaining("沒有可用來判斷重點的語音內容"));
  });
});

describe("in-app long-form auto edit keeps the narration (roadmap 1.14)", () => {
  const cues = [
    { start: 0.3, end: 4, text: "今天來比較三家夜市小吃" }, { start: 4.4, end: 7.5, text: "第一家是蚵仔煎" },
    { start: 10.5, end: 14, text: "第二家排隊的人很多" }, { start: 16.8, end: 19.6, text: "最後是我的結論" },
  ];

  it("keeps every spoken cue whole and cuts only the long pauses", async () => {
    const smartCut = async () => ({ fps: 30, sourceFrames: 600, ranges: [{ startFrame: 0, endFrame: 230 }, { startFrame: 310, endFrame: 430 }, { startFrame: 500, endFrame: 600 }], removedFrames: 150, cutCount: 2, silenceCount: 2, thresholdDb: -35, analyzedSeconds: 20, engine: "fixture", cacheHit: false });
    const f = setup({ transcript: speech(cues), smartCut });
    const outcome = await f.hook.runWithOutcome(LONGFORM);
    expect(outcome).toMatchObject({ ok: true, addedCaptions: 4 });
    expect(f.api.smartCutMedia.mock.calls[0][0]).toMatchObject({ options: { minSilence: 0.75, padding: 0.1 } });
    const result = f.present();
    // Every caption survives with its full length: no spoken word was cut.
    expect(result.captions.map((caption) => caption.text)).toEqual(cues.map((cue) => cue.text));
    for (const [index, caption] of result.captions.entries()) expect(caption.duration).toBeCloseTo(cues[index].end - cues[index].start, 1);
    const kept = result.tracks.find((track) => track.id === "video-main")!.clips.reduce((sum, clip) => sum + clip.duration, 0);
    expect(kept).toBeLessThan(20);
    expect(kept).toBeGreaterThan(cues.reduce((sum, cue) => sum + cue.end - cue.start, 0));
    expect(result.director.markers.at(-1)?.note).toContain("editMode=narration-pause-trim");
    expect(f.onCommand).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("長片白字黑底字幕"));
  });

  it("an explicit Shorts run still condenses, without asking for silence evidence", async () => {
    const f = setup({ transcript: speech(cues) });
    await f.hook.runWithOutcome({ format: "shorts", ownership: "automatic" });
    expect(f.api.smartCutMedia).not.toHaveBeenCalled();
    expect(f.present().director.markers.at(-1)?.note).toContain("editMode=highlight");
  });

  it("reports skipped transcript blocks in the receipt and keeps the other captions", async () => {
    const f = setup({ transcript: speech(cues, { skippedCaptionBlocks: [{ block: 5, reason: "non-positive-duration" }] }) });
    await f.hook.runWithOutcome(LONGFORM);
    expect(f.present().captions).toHaveLength(4);
    expect(f.present().director.markers.at(-1)?.note).toContain("captionParse=skipped-1");
  });

  it("puts 9:16 captions in the Shorts style even when the run is long-form", async () => {
    const f = setup({ width: 1080, height: 1920, transcript: speech(cues) });
    await f.hook.runWithOutcome(LONGFORM);
    expect(f.present().captionStyle).toMatchObject({ fontSize: 95, marginV: 300, color: "#FFFFFF", backgroundColor: "#00000000" });
    expect(f.onCommand).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("短片字幕樣式"));
  });
});

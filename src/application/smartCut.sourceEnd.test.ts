import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";

// FFmpeg silencedetect output for the fake analysis run: one pause from 2 s to 4 s, speech until the end.
let fakeStderr = "";
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      setTimeout(() => { child.stderr.emit("data", fakeStderr); child.emit("exit", 0); }, 0);
      return child;
    }),
  };
});

const { analyzeSmartCut, smartCutSourceFrames } = await import("./smartCut");

let workspace = "";
let sourcePath = "";
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "editkin-smart-cut-end-"));
  sourcePath = join(workspace, "talk.mp4");
  await writeFile(sourcePath, "fake media bytes");
  fakeStderr = "[silencedetect] silence_start: 2\n[silencedetect] silence_end: 4 | silence_duration: 2\n";
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

function projectWithSource(duration: number) {
  const project = createEmptyProject("Smart Cut end", { id: "smart-cut-end", width: 1920, height: 1080, fps: 30 });
  project.assets.push({ id: "talk", name: "Talk", kind: "video", uri: sourcePath, duration });
  project.tracks[0].clips.push({
    id: "talk-clip", assetId: "talk", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration,
    volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  });
  return project;
}

async function cutAndApply(duration: number) {
  const project = projectWithSource(duration);
  const result = await analyzeSmartCut({ sourcePath, sourceStart: 0, duration, fps: 30 }, { ffmpegPath: "ffmpeg" });
  const keepRanges = result.ranges.map((range) => ({ start: range.startFrame / result.fps, end: range.endFrame / result.fps }));
  const updated = applyCommand(project, {
    type: "smart_cut_clip", clipId: "talk-clip", keepRanges,
    segmentIds: keepRanges.map((_, index) => index === 0 ? "talk-clip" : `talk-smart-${index}`),
  });
  return { result, updated };
}

describe("Smart Cut keeps the last segment inside the source", () => {
  it("counts only whole frames that fit inside the source span", () => {
    expect(smartCutSourceFrames(10, 30)).toBe(300);
    expect(smartCutSourceFrames(301 / 30, 30)).toBe(301);
    expect(smartCutSourceFrames(10.02, 30)).toBe(300);
    expect(smartCutSourceFrames(10.0333, 30)).toBe(300);
    expect(smartCutSourceFrames(10, 30000 / 1001)).toBe(299);
  });

  it("clamps the last kept range of a non-frame-multiple source to the real source end", async () => {
    const { result, updated } = await cutAndApply(10.02);
    expect(result.sourceFrames).toBe(300);
    expect(result.ranges.at(-1)?.endFrame).toBe(300);
    const segments = updated.tracks[0].clips;
    const last = segments.at(-1)!;
    expect(last.sourceStart + last.duration).toBeLessThanOrEqual(10.02);
    expect(() => validateProject(updated)).not.toThrow();
  });

  it("keeps the same frame ranges for a frame-exact source", async () => {
    const { result, updated } = await cutAndApply(10);
    expect(result.sourceFrames).toBe(300);
    expect(result.ranges).toEqual([{ startFrame: 0, endFrame: 62 }, { startFrame: 118, endFrame: 300 }]);
    expect(updated.tracks[0].clips.at(-1)!.sourceStart + updated.tracks[0].clips.at(-1)!.duration).toBeCloseTo(10, 9);
    expect(() => validateProject(updated)).not.toThrow();
  });
});

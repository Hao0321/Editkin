import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createEmptyProject } from "../domain/editGraph";
import { createClipMask, resolveMaskPath } from "../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { combinedMaskAlphaExpression, MASK_LINEAR_TIMELINE_SAMPLES } from "./maskFilters";
import { buildRenderPlan } from "./planner";

/**
 * Tracked / keyframed vector masks past about 95 samples failed the export (FFmpeg exit -22: the nested `if()` chain
 * exceeded the expression parser's recursion limit). Long timelines now use a balanced selector with the same
 * boundaries; the export must keep choosing the preview's nearest sample (resolveMaskPath) on every frame.
 */
const run = promisify(execFile);
const app = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpegPath = join(app, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
const ffprobePath = join(app, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
const W = 64, H = 36, FPS = 30, DURATION = 2;

let root = "", white = "";
beforeAll(async () => {
  if (!existsSync(ffmpegPath)) return;
  root = await mkdtemp(join(tmpdir(), "editkin-mask-timeline-"));
  white = join(root, "white.png");
  await run(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `color=c=white:s=${W}x${H}`, "-frames:v", "1", white], { windowsHide: true });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

function maskedProject(samples: number): EditProject {
  const project = createEmptyProject("Mask timeline", { id: "mask-timeline", width: W, height: H, fps: FPS });
  project.assets.push({ id: "white", name: "white", uri: white, kind: "image", duration: 5, width: W, height: H });
  const mask = createClipMask("tracked", "rectangle");
  mask.keyframes = Array.from({ length: samples }, (_, index) => {
    const x = .05 + .6 * index / (samples - 1);
    return { frame: index, time: index * DURATION / samples, confidence: 1, status: "tracked" as const,
      points: [{ id: "a", x, y: .25 }, { id: "b", x: x + .25, y: .25 }, { id: "c", x: x + .25, y: .75 }, { id: "d", x, y: .75 }] };
  });
  project.tracks[0].clips.push({ id: "clip", assetId: "white", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: DURATION,
    volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], masks: [mask] });
  return project;
}

function ifDepth(expression: string): number {
  let depth = 0, maximum = 0;
  const stack: boolean[] = [];
  for (let i = 0; i < expression.length; i += 1) {
    if (expression.startsWith("if(", i)) { stack.push(true); depth += 1; maximum = Math.max(maximum, depth); i += 2; continue; }
    if (expression[i] === "(") stack.push(false);
    else if (expression[i] === ")" && stack.pop()) depth -= 1;
  }
  return maximum;
}

describe("tracked / keyframed vector mask timelines", () => {
  it("keeps the linear chain (and its bytes) up to the threshold, then uses logarithmic depth", () => {
    const short = maskedProject(MASK_LINEAR_TIMELINE_SAMPLES), long = maskedProject(1800);
    const shortExpression = combinedMaskAlphaExpression(compileClipAlphaPlan(short, short.tracks[0].clips[0], "formal"), W, H)!;
    expect(ifDepth(shortExpression)).toBe(MASK_LINEAR_TIMELINE_SAMPLES - 1);
    expect(shortExpression).not.toContain("\\,");
    expect(ifDepth(combinedMaskAlphaExpression(compileClipAlphaPlan(long, long.tracks[0].clips[0], "formal"), W, H)!)).toBeLessThanOrEqual(11);
  });

  it.skipIf(!existsSync(ffmpegPath)).each([90, 150, 1800])("exports %i samples and follows the preview's nearest sample on every frame", async samples => {
    const project = maskedProject(samples), clip = project.tracks[0].clips[0];
    const output = join(root, `mask-${samples}.mkv`);
    await renderComposite(ffmpegPath, ffprobePath, output, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 300_000);
    const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const frames = stdout.length / (W * H);
    expect(frames).toBe(DURATION * FPS);
    const mismatches: string[] = [];
    for (let frame = 0; frame < frames; frame += 1) {
      const points = resolveMaskPath(project, clip, clip.masks![0], frame / FPS).points;
      const left = Math.min(...points.map(p => p.x)) * W, right = Math.max(...points.map(p => p.x)) * W, y = Math.round(H / 2);
      const at = (x: number) => stdout[frame * W * H + y * W + Math.round(x)];
      const inside = at((left + right) / 2), before = left - 4 >= 0 ? at(left - 4) : 0, after = right + 4 < W ? at(right + 4) : 0;
      if (inside < 200 || before > 40 || after > 40) mismatches.push(`frame ${frame}: inside ${inside} before ${before} after ${after}`);
    }
    expect(mismatches).toEqual([]);
  }, 600_000);
});

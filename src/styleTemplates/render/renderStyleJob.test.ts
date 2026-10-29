import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileStylePlanV1 } from "../compiler";
import { styleJobFrame, type StyleRenderJobV1 } from "../jobs";
import { fixturePlan, fixtureProject } from "../styleTemplates.fixture";
import { getStyleTemplateV1 } from "../templates";
import { renderStyleJob } from "./renderStyleJob";

/**
 * Integration: real rasterization by the bundled FFmpeg (librsvg) and one real
 * ProRes 4444 job clip. Skipped when the vendored FFmpeg is absent.
 */
const APP = resolve(import.meta.dirname, "../../..");
const FFMPEG = join(APP, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const FFPROBE = join(APP, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const available = existsSync(FFMPEG) && existsSync(FFPROBE);
const tempRoot = () => {
  const root = process.env.STYLE_TEST_TEMP ?? process.env.TEMP ?? tmpdir();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "style-raster-"));
};

/** Wall time to decode `count` SVG frames in one FFmpeg process (librsvg raster + null sink). */
function rasterMs(dir: string, prefix: string, count: number): number {
  const started = performance.now();
  execFileSync(FFMPEG, ["-v", "error", "-nostdin", "-framerate", "30", "-start_number", "0", "-i", join(dir, `${prefix}%05d.svg`), "-frames:v", String(count), "-f", "null", "-"]);
  return performance.now() - started;
}

function heavyJobs(): readonly StyleRenderJobV1[] {
  const template = getStyleTemplateV1("S2_story_illustrated");
  const fixture = fixturePlan(template.id);
  // Glow is the costliest treatment (two blurred halos at the hold): measure it, plus the box, a section and a leak.
  const plan = { ...fixture, beats: fixture.beats.map((beat, index) => (index === 0 ? { ...beat, treatment: "glow" as const } : beat)) };
  const result = compileStylePlanV1(template, plan, fixtureProject());
  return result.jobs;
}

describe.skipIf(!available)("raster and encode (bundled FFmpeg)", () => {
  it("rasterizes every component in ≤ 150 ms per frame at 1080×1920", () => {
    const dir = tempRoot();
    try {
      const results: Record<string, number> = {};
      for (const job of heavyJobs()) {
        const count = Math.min(24, job.frameCount);
        // Frames from the busiest part: entry (blur) through the hold.
        for (let index = 0; index < count; index += 1) writeFileSync(join(dir, `${job.id}-${String(index).padStart(5, "0")}.svg`), styleJobFrame(job, Math.min(job.frameCount - 1, index * 2)));
        const one = rasterMs(dir, `${job.id}-`, 1);
        const all = rasterMs(dir, `${job.id}-`, count);
        results[job.id] = (all - one) / Math.max(1, count - 1);
      }
      writeFileSync(join(dir, "..", "style-raster-ms.json"), JSON.stringify(results, null, 1));
      for (const [id, ms] of Object.entries(results)) expect(ms, id).toBeLessThanOrEqual(150);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("encodes a caption job to ProRes 4444 with alpha and the exact frame count", async () => {
    const dir = tempRoot();
    try {
      const job = heavyJobs().find(candidate => candidate.component === "caption")!;
      const result = await renderStyleJob(job, { cacheRoot: dir, tempRoot: dir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, schedule: task => task() });
      expect(result.cacheHit).toBe(false);
      const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,pix_fmt,width,height,nb_read_frames", "-of", "json", result.path]).toString()) as { streams: Array<Record<string, string | number>> };
      expect(probe.streams[0]).toMatchObject({ codec_name: "prores", pix_fmt: "yuva444p12le", width: 1080, height: 1920, nb_read_frames: String(job.frameCount) });
      const again = await renderStyleJob(job, { cacheRoot: dir, tempRoot: dir, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, schedule: task => task() });
      expect(again.cacheHit).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

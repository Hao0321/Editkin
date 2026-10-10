import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderProject } from "../src/render/ffmpeg";
import type { EditProject } from "../src/domain/types";
import { initializeStudioCreativeAssets } from "../src/creative/studioAssets";

const root = resolve(import.meta.dirname, "..");
const dir = join(root, ".rd/benchmarks/jpop-mv-motion-20260928/product");
const project = JSON.parse(await readFile(join(dir, "candidate.editkin.json"), "utf8")) as EditProject;
initializeStudioCreativeAssets();
const options = { ffmpegPath: join(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
  ffprobePath: join(root, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
  fontRoot: join(root, "public/fonts"), preferGpu: false, timeoutMs: 120_000 };
for (const variant of ["graphics", "look", "transition", "fade", "whip", "whipfade", "camera", "creative", "bare"] as const) {
  const test = structuredClone(project);
  if (variant !== "graphics") test.motionGraphics = [];
  if (variant === "graphics" || variant === "bare") {
    for (const track of test.tracks) for (const clip of track.clips) {
      clip.keyframes = [];
      clip.creative = undefined;
    }
  }
  if (variant === "look" || variant === "transition" || variant === "fade" || variant === "whip" || variant === "whipfade" || variant === "camera") {
    for (const track of test.tracks) for (const clip of track.clips) {
      if (variant !== "camera") clip.keyframes = [];
      if (variant === "camera") clip.creative = undefined;
      else if (clip.creative) {
        if (variant === "look") { clip.creative.transitionIn = undefined; clip.creative.transitionOut = undefined; }
        else {
          clip.creative.lookPresetId = undefined;
          if (clip.creative.transitionIn && variant === "fade") clip.creative.transitionIn.presetId = "cine_short_fade_through_base";
          if (clip.creative.transitionIn && variant === "whip") clip.creative.transitionIn.presetId = "cine_axis_carry_left";
          if (clip.creative.transitionIn && variant === "whipfade") clip.creative.transitionIn.presetId = "cine_left_slide_fade";
        }
      }
    }
  }
  try {
    const result = await renderProject(test, join(dir, `diagnose-${variant}.mp4`), options);
    console.log(JSON.stringify({ variant, status: "PASS", planner: result.planner }));
  } catch (error) {
    console.log(JSON.stringify({ variant, status: "FAIL", error: String(error).slice(-800) }));
  }
}

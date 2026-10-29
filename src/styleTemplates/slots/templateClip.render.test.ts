import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../../application/materialColorSamplingRuntime";
import { applyCommand } from "../../domain/commands";
import { createEmptyProject, validateProject } from "../../domain/editGraph";
import { createHistory, dispatchCommandSafely, undo } from "../../domain/history";
import { assertStyleJobClipV1 } from "../../domain/styleJobV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset } from "../../domain/types";
import { renderProject } from "../../render/ffmpeg";
import { uiCardSceneWindow } from "./uiCardScene";
import {
  assertStyleTemplateProjectFilesV1, renderStyleTemplateClipV1, styleTemplateAddClipCommandV1, styleTemplateUpdateClipCommandV1,
} from "./renderTemplateClip";

/**
 * Real renders of the S1 v2 template clip (bundled FFmpeg/librsvg → ProRes), the slot cache, picture framing, and a real
 * Editkin export before and after a slot change, decoded and compared region by region.
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const W = 540, H = 960, FPS = 30;
let root: string, cacheRoot: string;
const tools = { ffmpegPath: ffmpeg, ffprobePath: ffprobe };

beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `styletpl-render-${process.pid}`);
  cacheRoot = join(root, ".editkin-media-cache");
  await mkdir(cacheRoot, { recursive: true });
  // A picture split red | blue at its middle (1600 × 900) and a 3 s grey "footage" clip, both owned test media.
  await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=0xD02828:s=800x900", "-f", "lavfi", "-i", "color=c=0x2850D0:s=800x900",
    "-filter_complex", "[0:v][1:v]hstack=inputs=2,format=rgb24", "-frames:v", "1", join(root, "split.png")], 4096, 60_000);
  await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=c=0x606060:s=${W}x${H}:r=${FPS}:d=3`,
    "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p", "-c:v", "libx264", "-crf", "8",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", join(root, "footage.mp4")], 4096, 60_000);
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const picture: MediaAsset = { id: "split", name: "split", kind: "image", uri: "", duration: 5, width: 1600, height: 900 };
function project(): EditProject {
  let value = createEmptyProject("Template clip", { id: "tpl", width: W, height: H, fps: FPS });
  value = applyCommand(value, { type: "import_asset", asset: { id: "footage", name: "footage", kind: "video", uri: join(root, "footage.mp4"), duration: 3, width: W, height: H } });
  value = applyCommand(value, { type: "add_clip", clip: { id: "base", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 3, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  return applyCommand(value, { type: "import_asset", asset: { ...picture, uri: join(root, "split.png") } });
}
const slots = (keyword: string, focal: [number, number] = [0.2, 0.5], fit: "cover" | "contain" = "cover") => ({
  text: { chapterNumber: "01", chapterLabel: "用 AI 做遊戲", lead: "還有", keyword, tag: "GPT" },
  color: {}, image: { card: { source: { kind: "asset", assetId: "split" }, fit, focal } },
});
const render = (base: EditProject, values: unknown, durationSeconds = 2.2) =>
  renderStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: values, project: base, durationSeconds, cacheRoot, ...tools, timeoutMs: 300_000 });
/** One decoded RGB frame (W × H × 3). */
const frameRgb = async (path: string, index: number) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-vf", `select=eq(n\\,${index}),format=rgb24`,
  "-frames:v", "1", "-f", "rawvideo", "pipe:1"], W * H * 3, 60_000)).stdout;
const rgbAt = (frame: Uint8Array, x: number, y: number) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [frame[i], frame[i + 1], frame[i + 2]]; };

describe("S1 v2 template clip: render, slot cache, picture framing", () => {
  it("renders, hits the cache for the same slots and misses for a changed slot", async () => {
    const base = project();
    const first = await render(base, slots("角色立繪"));
    expect(first).toMatchObject({ cacheHit: false, frameCount: 66, field: { template: { id: "S1_explainer_ui" }, component: { id: "uiCardScene", renderer: "svg" }, output: "opaque" } });
    expect((await stat(first.path)).size).toBeGreaterThan(10_000);
    const probe = (await runColorProcess(ffprobe, ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,nb_read_packets",
      "-of", "csv=p=0", first.path], 4096, 30_000)).stdout.toString("utf8").trim();
    expect(probe).toBe("prores,HQ,yuv422p10le,66");
    const again = await render(base, slots("角色立繪"));
    expect(again).toMatchObject({ cacheHit: true, path: first.path, field: { key: first.field.key } });
    expect(again.images.card.cacheHit).toBe(true);
    const changed = await render(base, slots("遊戲引擎"));
    expect(changed.cacheHit).toBe(false);
    expect(changed.field.key).not.toBe(first.field.key);
    expect(changed.field.slotsSha256).not.toBe(first.field.slotsSha256);
    // The picture did not change: its derivative is reused.
    expect(changed.images.card).toMatchObject({ sha256: first.images.card.sha256, cacheHit: true });
    // The field is the one the domain validates: key, slot hash, asset binding.
    const added = applyCommand(base, styleTemplateAddClipCommandV1(base, first, { clipId: "tpl-1", startFrame: 0 }));
    const clip = added.tracks.find(track => track.id === "styletpl")!.clips[0];
    expect(assertStyleJobClipV1(added, "video", clip)).toBe("current");
    expect(await assertStyleTemplateProjectFilesV1(added, cacheRoot)).toBe(1);
    // A crafted project must never make the check touch a path outside the template cache (UNC / NTLM probe, traversal).
    const withUri = (uri: string) => ({ ...added, assets: added.assets.map(asset => asset.id === clip.assetId ? { ...asset, uri } : asset) });
    for (const uri of ["\\\\attacker\\share\\x.mov", "//attacker/share/x.mov", join(root, "outside.mov"), join(cacheRoot, "styletpl-clip", "..", "x.mov"), "relative/x.mov"]) {
      await expect(assertStyleTemplateProjectFilesV1(withUri(uri), cacheRoot)).rejects.toThrow(/STYLE_JOB_ASSET_OUTSIDE_CACHE/);
    }
    await expect(assertStyleTemplateProjectFilesV1(added, "\\\\attacker\\share")).rejects.toThrow(/STYLE_JOB_CACHE_ROOT_INVALID/);
  }, 600_000);

  it("frames the picture with cover about its focal point, and contain inside the window", async () => {
    const base = project(), win = uiCardSceneWindow(W, H);
    const left = await render(base, slots("對焦", [0.2, 0.5])), right = await render(base, slots("對焦", [0.8, 0.5]));
    const contain = await render(base, slots("對焦", [0.5, 0.5], "contain"));
    // Frame 18 (0.6 s): the card has settled (entry ends 0.5 s) and the keyword punch-in (0.75 s) has not started.
    const [a, b, c] = await Promise.all([frameRgb(left.path, 18), frameRgb(right.path, 18), frameRgb(contain.path, 18)]);
    const cx = win.x + win.w / 2, cy = win.y + win.h / 2;
    const isRed = ([r, , bl]: number[]) => r > 150 && bl < 90, isBlue = ([r, , bl]: number[]) => bl > 150 && r < 90;
    expect(isRed(rgbAt(a, cx, cy))).toBe(true);
    expect(isBlue(rgbAt(b, cx, cy))).toBe(true);
    // Cover, focal 0.2: the picture's left edge sits on the window's left edge, so the red | blue split is at 0.5 × the placed width.
    const scale = Math.max(win.w / 1600, win.h / 900), split = win.x + 800 * scale;
    expect(isRed(rgbAt(a, split - 4, cy))).toBe(true);
    expect(isBlue(rgbAt(a, split + 4, cy))).toBe(true);
    // Contain: the whole picture, centred; above it the window's dark letterbox, beside it nothing is cropped.
    const placedH = 900 * Math.min(win.w / 1600, win.h / 900), top = win.y + (win.h - placedH) / 2;
    expect(Math.max(...rgbAt(c, cx, win.y + (top - win.y) / 2))).toBeLessThan(40);
    expect(isRed(rgbAt(c, win.x + 12, cy))).toBe(true);
    expect(isBlue(rgbAt(c, win.x + win.w - 12, cy))).toBe(true);
  }, 600_000);
});

describe("S1 v2 template clip: a real export before and after a slot change", () => {
  it("changes only the keyword region of the exported frames, and Undo returns the first render", async () => {
    const base = project();
    const first = await render(base, slots("角色立繪"), 2.5);
    let history = createHistory(base);
    history = dispatchCommandSafely(history, styleTemplateAddClipCommandV1(base, first, { clipId: "tpl-1", startFrame: 0 }), "add").state;
    const before = validateProject(structuredClone(history.present));
    const clip = before.tracks.find(track => track.id === "styletpl")!.clips[0];
    const second = await render(before, slots("遊戲引擎"), 2.5);
    const updated = dispatchCommandSafely(history, styleTemplateUpdateClipCommandV1(before, clip, second), "update");
    expect(updated.error).toBeUndefined();
    const after = updated.state.present;
    expect(after.tracks.find(track => track.id === "styletpl")!.clips[0]).toMatchObject({ assetId: second.asset.id, styleJob: { key: second.field.key, slots: { text: { keyword: "遊戲引擎" } } } });
    // One Undo restores the first render exactly.
    expect(undo(updated.state).present.tracks.find(track => track.id === "styletpl")!.clips[0]).toEqual(clip);

    const options = { ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferGpu: false, fontRoot: resolve("public/fonts"), colorRoot: resolve("public/color/aces2"), timeoutMs: 300_000 };
    const [outBefore, outAfter] = [await renderProject(before, join(root, "before.mp4"), options), await renderProject(after, join(root, "after.mp4"), options)];
    const frames = 75, bytes = W * H * 3;
    const decode = async (path: string) => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-frames:v", String(frames),
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], frames * bytes, 120_000)).stdout;
    const [x, y] = await Promise.all([decode(outBefore.outputPath), decode(outAfter.outputPath)]);
    expect(x.length).toBe(frames * bytes);
    // The keyword lockup band (S1 v2 grid at this size: ink centre 1463.5 × s, 168 × s glyphs, rise, overshoot and shadow) plus one
    // 16-px macroblock row of H.264 slack on each side.
    const s = W / 1080, centre = 1463.5 * s, half = 168 * s * 1.06 / 2 + 18 * s + 30 * s + 16;
    const inBand = (row: number) => row >= centre - half && row <= centre + half;
    // Inside the band the keyword changed (large differences); outside it nothing visible changed. H.264 rate control may
    // still move a few samples by a level or two outside (frame-level quantizer decisions see the changed band).
    let outsideVisible = 0, outsideNoise = 0, outsideSamples = 0, outsideMax = 0, inside = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let row = 0; row < H; row += 1) {
        for (let column = 0; column < W * 3; column += 1) {
          const index = frame * bytes + row * W * 3 + column, delta = Math.abs(x[index] - y[index]);
          if (inBand(row)) { if (delta > 24) inside += 1; continue; }
          outsideSamples += 1; outsideMax = Math.max(outsideMax, delta);
          if (delta > 24) outsideVisible += 1; else if (delta > 2) outsideNoise += 1;
        }
      }
    }
    console.info(JSON.stringify({ styleTemplateExportDiff: { inside, outsideVisible, outsideNoise, outsideSamples, outsideMax } }));
    expect(inside).toBeGreaterThan(5_000);
    expect(outsideVisible).toBe(0);
    expect(outsideMax).toBeLessThanOrEqual(8);
    expect(outsideNoise / outsideSamples).toBeLessThan(1e-4);
  }, 900_000);
});

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runColorProcess } from "../../application/materialColorSamplingRuntime";
import { applyCommand } from "../../domain/commands";
import { createEmptyProject, validateProject } from "../../domain/editGraph";
import { createHistory, dispatchCommandSafely, undo } from "../../domain/history";
import { motionLibraryFrameRateV1 } from "../../domain/motionLibraryV1";
import { assertStyleJobClipV1 } from "../../domain/styleJobV1";
import type { EditProject } from "../../domain/types";
import { compileStyleTemplateClipV1 } from "./compileClip";
import { styleCompositeFramesV1 } from "./compositeRender";
import {
  assertStyleTemplateProjectFilesV1, renderStyleTemplateClipV1, styleTemplateAddClipCommandV1, styleTemplateUpdateClipCommandV1,
} from "./renderTemplateClip";

/**
 * Real renders of the composited template clips S4 (mesh3d device screen), S5 (paper collage, alpha) and S7 (mesh3d
 * kinetic lyric): pinned frame hashes at a small size, byte identity across engine thread counts, the slot cache, and the
 * add / update commands with one Undo.
 */
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const W = 270, H = 480, FPS = 30;
const tools = { ffmpegPath: ffmpeg, ffprobePath: ffprobe };
let root: string, cacheRoot: string, work = 0;

beforeAll(async () => {
  root = join(resolve(process.env.TEMP ?? "."), `styletpl-s457-${process.pid}`);
  cacheRoot = join(root, ".editkin-media-cache");
  await mkdir(cacheRoot, { recursive: true });
  // An owned test picture, red | blue at its middle (1600 × 1000: the S4 screen's aspect).
  await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=0xD02828:s=800x1000", "-f", "lavfi", "-i", "color=c=0x2850D0:s=800x1000",
    "-filter_complex", "[0:v][1:v]hstack=inputs=2,format=rgb24", "-frames:v", "1", join(root, "split.png")], 4096, 60_000);
}, 120_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const S4 = (kicker = "EDITKIN  ·  AUTO EDIT", image: Record<string, unknown> = {}) => ({ text: { title: "一鍵自動剪輯", kicker }, color: {}, image });
const S5 = () => ({ text: { wordmark: "鶯歌", kicker: "手拉坏・老街", caption: "CLAY", gloss: "原本是泥", step1: "泥團置中", step2: "手指拉開瓶口", step3: "瓶身慢慢拉高" }, color: {}, image: {} });
const S7 = () => ({ text: { word: "剪", band: "自動剪輯 · AUTO EDIT · ", label: "EDITKIN", labelSub: "剪片季", display: "EDITKIN", script: "剪片季", kicker: "AUTO EDIT" }, color: {}, image: {} });

/** Frame hashes straight from the compositor (encoder-ready bytes), placeholders in every picture slot. */
async function frameHashes(templateId: string, slots: unknown, only: number[], options: { width?: number; height?: number; threads?: number } = {}): Promise<string[]> {
  const width = options.width ?? W, height = options.height ?? H;
  const compiled = compileStyleTemplateClipV1({ templateId, slots, frame: { width, height, fps: FPS }, images: {} });
  const workDir = join(root, `frames-${(work += 1)}`);
  const hashes: string[] = [];
  try {
    for await (const bytes of styleCompositeFramesV1({ hooks: compiled.component.composite!, params: compiled.field.job.params, width, height,
      frameCount: compiled.field.job.frameCount, rate: motionLibraryFrameRateV1(FPS), output: compiled.field.output, images: {}, ffmpegPath: ffmpeg, workDir,
      ...(options.threads !== undefined ? { threads: options.threads } : {}), only, timeoutMs: 300_000 })) hashes.push(sha(bytes));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return hashes;
}

describe("S4 / S5 / S7 golden frames", () => {
  // Pinned compositor output: a change to a component, the compositor or the engine must be deliberate (bump the
  // component revision and re-pin with STYLE_GOLDEN_UPDATE=1).
  it("produces stable frames for fixed slots, portrait and landscape", async () => {
    const hashes: Record<string, string> = {};
    const cases: Array<[string, unknown, number[], number[]]> = [
      ["S4_motion_promo_3d", S4(), [10, 40, 100], [100]],
      ["S5_vox_collage", S5(), [30, 100], [100]],
      ["S7_kinetic_lyric_3d", S7(), [20, 62, 105], [105]],
    ];
    for (const [templateId, slots, portrait, landscape] of cases) {
      (await frameHashes(templateId, slots, portrait)).forEach((hash, index) => { hashes[`${templateId}/9:16/${portrait[index]}`] = hash; });
      (await frameHashes(templateId, slots, landscape, { width: H, height: W })).forEach((hash, index) => { hashes[`${templateId}/16:9/${landscape[index]}`] = hash; });
    }
    const goldenPath = join(dirname(fileURLToPath(import.meta.url)), "templateClipsS457.golden.json");
    if (process.env.STYLE_GOLDEN_UPDATE === "1") writeFileSync(goldenPath, JSON.stringify(hashes, null, 1) + "\n");
    const pinned = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, string>;
    expect(Object.keys(pinned)).toHaveLength(11);
    expect(hashes).toEqual(pinned);
  }, 600_000);

  it("renders the same bytes on 1 and on 3 engine threads", async () => {
    expect(await frameHashes("S4_motion_promo_3d", S4(), [40], { threads: 1 })).toEqual(await frameHashes("S4_motion_promo_3d", S4(), [40], { threads: 3 }));
    expect(await frameHashes("S7_kinetic_lyric_3d", S7(), [20, 105], { threads: 1 })).toEqual(await frameHashes("S7_kinetic_lyric_3d", S7(), [20, 105], { threads: 3 }));
  }, 600_000);
});

function project(): EditProject {
  const value = createEmptyProject("S4 S5 S7", { id: "s457", width: W, height: H, fps: FPS });
  return applyCommand(value, { type: "import_asset", asset: { id: "split", name: "split", kind: "image", uri: join(root, "split.png"), duration: 5, width: 1600, height: 1000 } });
}
const probe = async (path: string) => (await runColorProcess(ffprobe, ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
  "stream=codec_name,profile,pix_fmt,nb_read_packets", "-of", "csv=p=0", path], 4096, 30_000)).stdout.toString("utf8").trim();
const decode = async (path: string, frames: number, pixFmt: "rgb24" | "rgba") => (await runColorProcess(ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-frames:v", String(frames),
  "-f", "rawvideo", "-pix_fmt", pixFmt, "pipe:1"], frames * W * H * (pixFmt === "rgba" ? 4 : 3), 120_000)).stdout;

describe("S4 / S5 / S7 template clips: render, slot cache, commands", () => {
  it("S4: renders with a picture on the screen, hits the cache for the same slots, misses for a changed one; add, update and Undo", async () => {
    const base = project();
    const render = (slots: unknown) => renderStyleTemplateClipV1({ templateId: "S4_motion_promo_3d", slots, project: base, durationSeconds: 2.5, cacheRoot, ...tools, timeoutMs: 600_000 });
    const screen = { screen: { source: { kind: "asset", assetId: "split" }, focal: [0.5, 0.5] } };
    const first = await render(S4(undefined, screen));
    expect(first).toMatchObject({ cacheHit: false, frameCount: 75, field: { template: { id: "S4_motion_promo_3d", revision: 2 }, component: { id: "mesh3dDeviceScreen", renderer: "mesh3d" }, output: "opaque" } });
    expect(await probe(first.path)).toBe("prores,HQ,yuv422p10le,75");
    const again = await render(S4(undefined, screen));
    expect(again).toMatchObject({ cacheHit: true, path: first.path, field: { key: first.field.key } });
    const changed = await render(S4("MOTION", screen));
    expect(changed.cacheHit).toBe(false);
    expect(changed.field.key).not.toBe(first.field.key);
    // The picture did not change: its derivative is reused.
    expect(changed.images.screen).toMatchObject({ sha256: first.images.screen.sha256, cacheHit: true });
    // The picture shows: the settled screen (frame 60) holds both halves of the test picture.
    const last = (await decode(first.path, 61, "rgb24")).subarray(60 * W * H * 3);
    let red = 0, blue = 0;
    for (let i = 0; i < W * H * 3; i += 3) { if (last[i] > 140 && last[i + 2] < 110 && last[i + 1] < 110) red += 1; if (last[i + 2] > 150 && last[i] < 110) blue += 1; }
    expect(red).toBeGreaterThan(200); expect(blue).toBeGreaterThan(200);

    let history = createHistory(base);
    history = dispatchCommandSafely(history, styleTemplateAddClipCommandV1(base, first, { clipId: "tpl-1", startFrame: 0 }), "add").state;
    const before = validateProject(structuredClone(history.present));
    const clip = before.tracks.find(track => track.id === "styletpl")!.clips[0];
    expect(assertStyleJobClipV1(before, "video", clip)).toBe("current");
    expect(await assertStyleTemplateProjectFilesV1(before, cacheRoot)).toBe(1);
    const updated = dispatchCommandSafely(history, styleTemplateUpdateClipCommandV1(before, clip, changed), "update");
    expect(updated.error).toBeUndefined();
    const after = updated.state.present.tracks.find(track => track.id === "styletpl")!.clips[0];
    expect(after).toMatchObject({ assetId: changed.asset.id, styleJob: { key: changed.field.key, slots: { text: { kicker: "MOTION" } } } });
    expect(assertStyleJobClipV1(updated.state.present, "video", after)).toBe("current");
    expect(undo(updated.state).present.tracks.find(track => track.id === "styletpl")!.clips[0]).toEqual(clip);
  }, 900_000);

  it("S5: renders a straight-alpha clip whose empty speaker window shows what is under it", async () => {
    const base = project();
    const result = await renderStyleTemplateClipV1({ templateId: "S5_vox_collage", slots: S5(), project: base, durationSeconds: 2, cacheRoot, ...tools, timeoutMs: 600_000 });
    expect(result).toMatchObject({ cacheHit: false, frameCount: 60, field: { component: { id: "collageExplainer", renderer: "svg" }, output: "alpha" } });
    expect(await probe(result.path)).toBe("prores,4444,yuva444p12le,60");
    const rgba = (await decode(result.path, 21, "rgba")).subarray(20 * W * H * 4);
    const alphaAt = (x: number, y: number) => rgba[(y * W + x) * 4 + 3];
    // The collage panel (top) is opaque paper; the speaker window (no picture: placeholder none) stays see-through at its edge.
    expect(alphaAt(Math.round(W * 0.1), Math.round(H * 0.1))).toBe(255);
    expect(alphaAt(Math.round(W * 0.06), Math.round(H * 0.97))).toBeLessThan(16);
    const added = applyCommand(base, styleTemplateAddClipCommandV1(base, result, { clipId: "tpl-5", startFrame: 0 }));
    expect(assertStyleJobClipV1(added, "video", added.tracks.find(track => track.id === "styletpl")!.clips[0])).toBe("current");
  }, 600_000);

  it("S7: the product path renders the same frames on 1 engine thread, and the same slots hit the cache", async () => {
    const base = project();
    const render = (slots: unknown, cache: string, mesh3dThreads?: number) => renderStyleTemplateClipV1({ templateId: "S7_kinetic_lyric_3d", slots, project: base, durationSeconds: 1.5,
      cacheRoot: cache, ...tools, timeoutMs: 600_000, ...(mesh3dThreads !== undefined ? { mesh3dThreads } : {}) });
    const pooled = await render(S7(), cacheRoot), single = await render(S7(), join(root, "single-thread-cache"), 1);
    expect(pooled).toMatchObject({ cacheHit: false, frameCount: 45, field: { component: { id: "mesh3dKineticLyric", renderer: "mesh3d" } } });
    expect(single.field.key).toBe(pooled.field.key);
    expect(sha(await decode(single.path, 45, "rgb24"))).toBe(sha(await decode(pooled.path, 45, "rgb24")));
    expect((await stat(pooled.path)).size).toBeGreaterThan(10_000);
    // A changed slot is a different key (pinned in templateClipsS457.test.ts); the same slots again are a cache hit.
    expect(await render(S7(), cacheRoot)).toMatchObject({ cacheHit: true, path: pooled.path });
  }, 900_000);
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMotionLibraryItem } from "../catalog";
import { motionFrameRate } from "../frames";
import { MotionLibraryGlyphError } from "../svg/glyphs";
import { MotionLibraryNotImplementedError, type MotionLibraryItem } from "../types";
import { motionLibraryCacheKey, renderMotionLibraryItem, resolveMotionLibraryTools } from "./renderItem";

const run = promisify(execFile);
const SIZE = { width: 270, height: 480 };
const PIXELS = SIZE.width * SIZE.height;

/** Alpha range of frame `index` at the decoder's own depth (ProRes 4444 decodes to yuva444p10le or yuva444p12le). */
async function nativeAlpha(tools: { ffmpeg: string; ffprobe: string }, file: string, index: number) {
  const pixFmt = (await run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file])).stdout.trim();
  const bits = Number(/p(\d+)le$/.exec(pixFmt)?.[1] ?? 8);
  const { stdout } = await run(tools.ffmpeg, ["-v", "error", "-i", file, "-vf", `trim=start_frame=${index}:end_frame=${index + 1}`, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", pixFmt, "-"], { encoding: "buffer", maxBuffer: 1 << 26 });
  const raw = stdout as Buffer;
  let min = Infinity, max = -Infinity;
  for (let pixel = 0; pixel < PIXELS; pixel += 1) {
    const alpha = raw.readUInt16LE((3 * PIXELS + pixel) * 2);
    if (alpha < min) min = alpha;
    if (alpha > max) max = alpha;
  }
  return { pixFmt, full: 2 ** bits - 1, min, max };
}

/** Decode frame `index` to straight RGBA. */
async function rgbaFrame(ffmpeg: string, file: string, index: number): Promise<Buffer> {
  const { stdout } = await run(ffmpeg, ["-v", "error", "-i", file, "-vf", `trim=start_frame=${index}:end_frame=${index + 1},format=rgba`,
    "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 24 });
  return stdout as Buffer;
}

function alphaStats(pixels: Buffer) {
  let opaque = 0, clear = 0, x0 = SIZE.width, y0 = SIZE.height, x1 = -1, y1 = -1;
  const colours = new Map<string, number>();
  for (let pixel = 0; pixel < PIXELS; pixel += 1) {
    const alpha = pixels[pixel * 4 + 3];
    if (alpha === 0) { clear += 1; continue; }
    if (alpha === 255) {
      opaque += 1;
      const key = `${pixels[pixel * 4]},${pixels[pixel * 4 + 1]},${pixels[pixel * 4 + 2]}`;
      colours.set(key, (colours.get(key) ?? 0) + 1);
    }
    const x = pixel % SIZE.width, y = Math.floor(pixel / SIZE.width);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const dominant = [...colours.entries()].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number) ?? [];
  return { opaque, clear, box: { x0, y0, x1, y1 }, dominant };
}

describe("renderMotionLibraryItem (real bundled FFmpeg)", () => {
  let root = "", tools = { ffmpeg: "", ffprobe: "" };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "editkin-motionlib-test-"));
    tools = await resolveMotionLibraryTools();
  }, 120_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("resolves Editkin's bundled FFmpeg the same way the app does", () => {
    expect(existsSync(tools.ffmpeg)).toBe(true);
    expect(existsSync(tools.ffprobe)).toBe(true);
  });

  it("renders T01 (270×480, 1 s, 10 fps) to ProRes 4444 with alpha, verifies, caches and cleans up", async () => {
    const cacheRoot = join(root, "cache"), tempRoot = join(root, "temp");
    const phases = new Set<string>();
    const result = await renderMotionLibraryItem({ item: "T01", params: { durationSeconds: 1 }, size: SIZE, fps: 10, cacheRoot, tempRoot,
      onProgress: progress => phases.add(progress.phase) });
    expect(result).toMatchObject({ itemId: "T01", kind: "text", cacheHit: false, frameCount: 10, fps: "10/1", durationSeconds: 1, width: 270, height: 480 });
    expect([...phases]).toEqual(["generate", "encode", "verify", "done"]);
    const clip = result.outputs.clip!;
    expect(clip).toMatchObject({ codec: "prores", profile: "4444", pixFmt: "yuva444p10le", alpha: true });
    expect(clip.path).toBe(join(cacheRoot, "motionlib", "T01", `${result.cacheKey}.mov`));

    // Decode check: every frame decodes, BT.709 tags, an alpha-carrying pixel format.
    const probe = JSON.parse((await run(tools.ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
      "stream=codec_name,pix_fmt,nb_read_frames,color_primaries,color_transfer,color_space", "-of", "json", clip.path])).stdout);
    expect(probe.streams[0]).toMatchObject({ codec_name: "prores", nb_read_frames: "10", color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709" });
    expect(probe.streams[0].pix_fmt).toMatch(/^yuva444p/);

    // Alpha present: transparent surroundings and opaque text in every frame from the pop to the hold (no empty text frame).
    for (let index = 2; index <= 8; index += 1) {
      const stats = alphaStats(await rgbaFrame(tools.ffmpeg, clip.path, index));
      expect(stats.opaque, `frame ${index}`).toBeGreaterThan(500);
      expect(stats.clear, `frame ${index}`).toBeGreaterThan(PIXELS * 0.5);
    }
    // Hold after the burst (t = 0.8 s at this compressed timing): inside the 5% title-safe area, palette cream after the round trip.
    const hold = alphaStats(await rgbaFrame(tools.ffmpeg, clip.path, 8));
    expect(hold.box.x0).toBeGreaterThanOrEqual(SIZE.width * 0.05);
    expect(hold.box.y0).toBeGreaterThanOrEqual(SIZE.height * 0.05);
    expect(hold.box.x1).toBeLessThanOrEqual(SIZE.width * 0.95);
    expect(hold.box.y1).toBeLessThanOrEqual(SIZE.height * 0.95);
    [0xF3, 0xEF, 0xE6].forEach((value, channel) => expect(Math.abs(hold.dominant[channel] - value)).toBeLessThanOrEqual(2));

    // Cache hit, nothing but the clip and its manifest in the cache, temp frames removed.
    const again = await renderMotionLibraryItem({ item: "T01", params: { durationSeconds: 1 }, size: SIZE, fps: 10, cacheRoot, tempRoot });
    expect(again.cacheHit).toBe(true);
    expect(again.cacheKey).toBe(result.cacheKey);
    expect(again.outputs.clip!.bytes).toBe(clip.bytes);
    expect((await readdir(join(cacheRoot, "motionlib", "T01"))).sort()).toEqual([`${result.cacheKey}.json`, `${result.cacheKey}.mov`]);
    expect(await readdir(tempRoot)).toEqual([]);
    const fps10 = { numerator: 10, denominator: 1, value: 10, text: "10/1" };
    expect(motionLibraryCacheKey({ itemId: "T01", itemRevision: result.itemRevision, kind: "text", params: result.params, size: SIZE, fps: fps10, preview: false }))
      .toBe(result.cacheKey);
    expect(motionLibraryCacheKey({ itemId: "T01", itemRevision: result.itemRevision, kind: "text",
      params: { ...result.params, palette: { ...result.params.palette, accent: "#000000" } } as never, size: SIZE, fps: fps10, preview: false })).not.toBe(result.cacheKey);

    // A revision bump misses the old entry and renders a new one beside it (the stale clip is never served).
    const revision = getMotionLibraryItem("T01").revision!;
    expect(result.itemRevision).toBe(revision);
    const bumped = await renderMotionLibraryItem({ item: { ...getMotionLibraryItem("T01"), revision: revision + 1 } as MotionLibraryItem, params: { durationSeconds: 1 },
      size: SIZE, fps: 10, cacheRoot, tempRoot });
    expect([bumped.cacheHit, bumped.itemRevision]).toEqual([false, revision + 1]);
    expect(bumped.cacheKey).not.toBe(result.cacheKey);
    expect((await readdir(join(cacheRoot, "motionlib", "T01"))).sort())
      .toEqual([`${result.cacheKey}.json`, `${result.cacheKey}.mov`, `${bumped.cacheKey}.json`, `${bumped.cacheKey}.mov`].sort());
  }, 120_000);

  it("encodes alpha at full scale: opaque decodes to the maximum, transparent to 0 (text clip and transition matte)", async () => {
    const cacheRoot = join(root, "alpha-cache"), tempRoot = join(root, "alpha-temp");
    // T01 at the hold: the word's interior is fully opaque, the corners fully transparent.
    const text = await renderMotionLibraryItem({ item: "T01", params: { durationSeconds: 1 }, size: SIZE, fps: 10, cacheRoot, tempRoot });
    const hold = await nativeAlpha(tools, text.outputs.clip!.path, 8);
    expect(["yuva444p10le", "yuva444p12le"]).toContain(hold.pixFmt);
    expect([hold.max, hold.min]).toEqual([hold.full, 0]);
    // X01: the first matte frame is all A (alpha 0 everywhere), the last all B (maximum everywhere).
    const wipe = await renderMotionLibraryItem({ item: "X01", size: SIZE, fps: 10, cacheRoot, tempRoot });
    const first = await nativeAlpha(tools, wipe.outputs.matte!.path, 0), last = await nativeAlpha(tools, wipe.outputs.matte!.path, wipe.frameCount - 1);
    expect([first.min, first.max]).toEqual([0, 0]);
    expect([last.min, last.max]).toEqual([last.full, last.full]);
  }, 120_000);

  it("cancels while FFmpeg runs: the child is killed and no partial output or temp frame remains", async () => {
    const cacheRoot = join(root, "cancel-cache"), tempRoot = join(root, "cancel-temp");
    const controller = new AbortController();
    let encodeStarted = false;
    const rendering = renderMotionLibraryItem({ item: "B01", params: { durationSeconds: 30 }, size: SIZE, fps: 10, cacheRoot, tempRoot, signal: controller.signal,
      onProgress: progress => {
        if (progress.phase === "encode" && !encodeStarted) { encodeStarted = true; setTimeout(() => controller.abort(), 400); }
      } });
    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(encodeStarted).toBe(true);
    expect(await readdir(join(cacheRoot, "motionlib", "B01"))).toEqual([]);
    expect(await readdir(tempRoot)).toEqual([]);
  }, 60_000);

  it("refuses before touching the filesystem: aborted signal, missing glyph, unimplemented item, odd size, relative cache", async () => {
    const cacheRoot = join(root, "refuse-cache"), tempRoot = join(root, "refuse-temp");
    await expect(renderMotionLibraryItem({ item: "T01", size: SIZE, cacheRoot, tempRoot, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    const rocket = String.fromCodePoint(0x1F680);
    await expect(renderMotionLibraryItem({ item: "T01", params: { lines: [`出發${rocket}`] }, size: SIZE, cacheRoot, tempRoot }))
      .rejects.toSatisfy(error => error instanceof MotionLibraryGlyphError && error.character === rocket);
    // A synthetic, unregistered stub: never a catalog id, which a Phase 2 batch may implement at any time.
    const unimplemented = { ...getMotionLibraryItem("T01"), id: "T99", implemented: false,
      generate: () => { throw new MotionLibraryNotImplementedError("T99"); } } as MotionLibraryItem;
    await expect(renderMotionLibraryItem({ item: unimplemented, size: SIZE, cacheRoot, tempRoot })).rejects.toBeInstanceOf(MotionLibraryNotImplementedError);
    await expect(renderMotionLibraryItem({ item: "T01", size: { width: 271, height: 480 }, cacheRoot, tempRoot })).rejects.toThrow(/even/);
    await expect(renderMotionLibraryItem({ item: "T01", size: SIZE, cacheRoot: "relative/cache", tempRoot })).rejects.toThrow(/absolute/);
    expect(existsSync(tempRoot)).toBe(false);
    expect(existsSync(cacheRoot)).toBe(false);
  });
});

describe("motionLibraryCacheKey", () => {
  const t01 = getMotionLibraryItem("T01");
  const base = { itemId: "T01", kind: "text" as const, params: t01.defaultParams, size: { width: 1080, height: 1920 }, fps: motionFrameRate(30), preview: false };
  it("rotates when the item revision changes and is stable otherwise", () => {
    const first = motionLibraryCacheKey({ ...base, itemRevision: 1 });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(motionLibraryCacheKey({ ...base, itemRevision: 1 })).toBe(first);
    const second = motionLibraryCacheKey({ ...base, itemRevision: 2 });
    expect(second).not.toBe(first);
    expect(motionLibraryCacheKey({ ...base, itemRevision: 3 })).not.toBe(second);
    expect(motionLibraryCacheKey({ ...base, itemId: "T02", itemRevision: 1 })).not.toBe(first);
  });
  it("refuses a revision that is not an integer ≥ 1", () => {
    for (const itemRevision of [0, -1, 1.5, Number.NaN]) expect(() => motionLibraryCacheKey({ ...base, itemRevision })).toThrow(/revision/);
  });
});

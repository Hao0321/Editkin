import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateMediaDerivatives } from "./mediaDerivatives";
import { CURRENT_MEDIA_PREVIEW_RECIPE, browserProxyColorPlan, browserThumbnailFilters } from "./mediaDerivativeColor";

// Frozen endpoint tolerance: <=3 RGB codes per channel on constant interior
// patches (H.264 + JPEG quantization). This is not a perceptual-quality score.
const TOLERANCE = 3;
const RECIPE = CURRENT_MEDIA_PREVIEW_RECIPE;
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const deadline = Date.now() + 180_000;
function run(exe: string, args: string[]) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Error("thumbnail regression suite exceeded 180s budget");
  const result = spawnSync(exe, args, { windowsHide: true, timeout: Math.min(30_000, remaining), maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`${result.error ?? result.stderr.toString()}`);
  return result.stdout;
}
function ff(args: string[]) { return run(ffmpeg, ["-v", "error", "-threads", "2", "-filter_threads", "2", ...args]); }
function probe(path: string) { return JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", path]).toString()).streams[0]; }
async function sha(path: string) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
// Independent numeric display oracle, not a production filter string.
function srgb(linear: number) { return 255 * (linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055); }
function display(code: number) { return srgb((code / 255) ** 2.4); }
function centerRgb(path: string, video: boolean) {
  // Explicit matrix/range decode, no transfer conversion. Constant patch avoids
  // scaling/interpolation comparisons becoming a second implementation oracle.
  const filters = video ? "scale=in_color_matrix=bt709:in_range=tv:out_range=full,format=rgb24" : "scale=in_color_matrix=bt601:in_range=full:out_range=full,format=rgb24";
  const data = ff(["-i", path, "-vf", `${filters},crop=2:2:iw/2:ih/2`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  expect(data.length).toBe(12);
  return [0, 1, 2].map(channel => (data[channel] + data[channel + 3] + data[channel + 6] + data[channel + 9]) / 4);
}
async function fixture(transfer: string, colored = false) {
  const base = resolve(".rd/hdr-display-20260901"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "thumbnail-test-"));
  const source = join(root, "source.mp4"), hdr = transfer !== "bt709";
  ff(["-f", "lavfi", "-i", `nullsrc=s=96x64:r=10:d=0.5,format=yuv420p10le,geq=lum=502:cb=${colored ? 600 : 512}:cr=${colored ? 440 : 512}`,
    "-c:v", "libx264", "-threads", "2", "-crf", "0", "-pix_fmt", "yuv420p10le",
    "-bsf:v", `h264_metadata=colour_primaries=${hdr ? 9 : 1}:transfer_characteristics=${transfer === "arib-std-b67" ? 18 : transfer === "smpte2084" ? 16 : 1}:matrix_coefficients=${hdr ? 9 : 1}:video_full_range_flag=0`, source]);
  const input = probe(source); expect(input.color_transfer).toBe(transfer); expect(input.color_range).toBe("tv");
  expect(input.color_space).toBe(hdr ? "bt2020nc" : "bt709");
  return { root, source, sourceSha: await sha(source), request: { sourcePath: source, kind: "video" as const, duration: .5, hasAudio: false, cacheRoot: join(root, "cache"), ffmpegPath: ffmpeg, ffprobePath: ffprobe, timeoutMs: 30_000 } };
}

describe("actual thumbnail display endpoint (not native GUI or HDR art approval)", () => {
  it.each(["bt709", "arib-std-b67", "smpte2084"])("%s proxy -> JPEG applies display mapping exactly once", async transfer => {
    const f = await fixture(transfer);
    const result = await generateMediaDerivatives(f.request);
    const proxy = result.derivatives.proxyUri!, thumbnail = result.derivatives.thumbnailUri!;
    const proxyRgb = centerRgb(proxy, true), actual = centerRgb(thumbnail, false), expected = proxyRgb.map(display);
    actual.forEach((value, channel) => expect(Math.abs(value - expected[channel])).toBeLessThanOrEqual(TOLERANCE));
    expect(probe(proxy).color_transfer).toBe("bt709");
    expect(probe(thumbnail).pix_fmt).toBe("yuvj444p"); expect(probe(thumbnail).color_range).toBe("pc");
    if (transfer === "bt709") {
      const ideal = srgb(.5 ** 2.4);
      actual.forEach(value => expect(Math.abs(value - ideal)).toBeLessThanOrEqual(TOLERANCE));
      for (const mutant of [127.5, srgb(((.5 + .099) / 1.099) ** (1 / .45)), display(ideal)]) {
        expect(Math.abs(actual[0] - mutant)).toBeGreaterThan(4);
      }
    }
    const before = { sha: await sha(thumbnail), mtime: (await stat(thumbnail)).mtimeMs };
    expect((await generateMediaDerivatives(f.request)).cacheHit).toBe(true);
    expect({ sha: await sha(thumbnail), mtime: (await stat(thumbnail)).mtimeMs }).toEqual(before);
    expect(await sha(f.source)).toBe(f.sourceSha);
    await writeFile(join(f.root, "endpoint.json"), JSON.stringify({ transfer, sourceSha: f.sourceSha, proxyRgb, actual, expected, tolerance: TOLERANCE, thumbnail: before, scope: "display-stage-only; HDR tone-map is not an independent oracle" }, null, 2));
  }, 60_000);

  it("colored SDR preserves the 709 decode matrix and retires old/corrupt cache", async () => {
    const f = await fixture("bt709", true), first = await generateMediaDerivatives(f.request);
    const thumbnail = first.derivatives.thumbnailUri!, directory = dirname(thumbnail), manifestPath = join(directory, "manifest.json");
    const actual = centerRgb(thumbnail, false), expected = centerRgb(first.derivatives.proxyUri!, true).map(display);
    actual.forEach((value, channel) => expect(Math.abs(value - expected[channel])).toBeLessThanOrEqual(TOLERANCE));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.schemaVersion).toBe(7); expect(manifest.recipe).toBe(RECIPE);
    // Retain a complete historical v6-shaped cache with genuinely old scale-only
    // JPEG bytes. It must remain untouched, never become the v7 warm winner.
    const old = join(f.request.cacheRoot, "v6", f.sourceSha); await cp(directory, old, { recursive: true });
    const oldJpeg = join(old, "thumbnail.jpg");
    ff(["-y", "-i", first.derivatives.proxyUri!, "-vf", "scale=480:-2,setsar=1", "-frames:v", "1", "-q:v", "3", oldJpeg]);
    const legacy = { ...manifest, schemaVersion: 6, recipe: "editkin.browser-proxy-hlg-float-2x/2026-08-31", files: { ...manifest.files, "thumbnail.jpg": { bytes: (await stat(oldJpeg)).size, sha256: await sha(oldJpeg) } } };
    const oldManifest = join(old, "manifest.json"); await writeFile(oldManifest, JSON.stringify(legacy)); const oldSha = await sha(oldManifest);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, recipe: "retired-thumbnail-recipe" }));
    expect((await generateMediaDerivatives(f.request)).cacheHit).toBe(false);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).recipe).toBe(RECIPE);
    expect(await sha(oldManifest)).toBe(oldSha);
    await writeFile(thumbnail, "owned corrupted JPEG");
    expect((await generateMediaDerivatives(f.request)).cacheHit).toBe(false);
    expect(probe(thumbnail).pix_fmt).toBe("yuvj444p"); expect(await sha(f.source)).toBe(f.sourceSha);
    await writeFile(join(f.root, "cache.json"), JSON.stringify({ actual, expected, oldManifestSha: oldSha, recipe: RECIPE, sourceSha: f.sourceSha }, null, 2));
  }, 90_000);

  it("unknown/photo/sRGB are not relabeled or mapped as 709; explicit Log still rejects", () => {
    for (const tags of [{}, { colorPrimaries: "bt709", colorTransfer: "iec61966-2-1", colorMatrix: "gbr", colorRange: "pc" }]) {
      const plan = browserProxyColorPlan(tags), before = structuredClone(plan);
      for (const fromProxy of [false, true]) expect(browserThumbnailFilters(plan, fromProxy).join(",")).not.toContain("tin=bt709");
      expect(plan).toEqual(before); expect(plan.outputColor.interpretation).toBe("auto");
    }
    for (const colorTransfer of ["log", "slog3", "linear"]) expect(() => browserProxyColorPlan({ colorTransfer })).toThrow();
  });
});

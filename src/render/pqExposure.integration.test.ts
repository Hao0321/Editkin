import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM, type MediaAsset } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { compositorSourceColorPlan } from "./sourceColorFilters";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sources: Record<string, { path: string; sha256: string }> = {}; let root: string;
const nits = [0, .1, 1, 10, 100, 200, 400, 1000, 4000, 10000];
const pq = (luminance: number) => { const v = (luminance / 10000) ** (2610 / 16384); return ((3424 / 4096 + 2413 / 128 * v) / (1 + 2392 / 128 * v)) ** (2523 / 32); };
function run(exe: string, args: string[]) {
  const result = spawnSync(exe, args, { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.status, result.stderr.toString()).toBe(0); return result.stdout;
}
beforeAll(async () => {
  const parent = join(app, ".rd/pq-primary-exposure-20260831"); await mkdir(parent, { recursive: true }); root = await mkdtemp(join(parent, "integration-"));
  for (const input of ["pq", "hlg", "rec709"] as const) {
    const codes = input === "pq" ? nits.map(n => Math.round(64 + 876 * pq(n))) : [64, 128, 200, 300, 400, 500, 600, 700, 800, 900];
    const staircase = codes.slice(0, -1).reduceRight((next, value, index) => `if(lt(X,${(index + 1) * 32}),${value},${next})`, String(codes.at(-1)));
    const path = join(root, `${input}.mkv`), p = input === "rec709" ? "bt709" : "bt2020", t = input === "pq" ? "smpte2084" : input === "hlg" ? "arib-std-b67" : "bt709", m = input === "rec709" ? "bt709" : "bt2020nc";
    run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `nullsrc=s=320x180:r=10:d=0.3,format=yuv420p10le,geq=lum='${staircase}':cb=512:cr=512,setparams=range=limited:color_primaries=${p}:color_trc=${t}:colorspace=${m}`, "-c:v", "ffv1", path]);
    const probe = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", path]).toString());
    expect(probe.streams[0]).toMatchObject({ color_primaries: p, color_transfer: t, color_space: m, color_range: "tv", pix_fmt: "yuv420p10le" });
    sources[input] = { path, sha256: sha(await readFile(path)) };
  }
}, 30000);
function asset(input: "pq" | "hlg" | "rec709"): MediaAsset {
  return { id: "asset", name: "Owned engineering steps", uri: sources[input].path, kind: "video", duration: .3,
    color: input === "rec709"
      ? { interpretation: input, primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
      : { interpretation: input, primaries: "bt2020", transfer: input === "hlg" ? "arib-std-b67" : "smpte2084", matrix: "bt2020nc", range: "tv" } };
}
function raw(input: "pq" | "hlg" | "rec709", filters: string[], format = "rgb24") { return run(ffmpeg, ["-v", "error", "-i", sources[input].path, "-vf", filters.join(","), "-frames:v", "1", "-pix_fmt", format, "-f", "rawvideo", "pipe:1"]); }
function centers(bytes: Buffer) { return nits.map((_n, i) => [...bytes.subarray((90 * 320 + i * 32 + 16) * 3, (90 * 320 + i * 32 + 16) * 3 + 3)]).flat(); }
function difference(a: number[], b: number[]) { const errors = a.map((n, i) => Math.abs(n - b[i])); return { mean: errors.reduce((sum, n) => sum + n, 0) / errors.length, maximum: Math.max(...errors) }; }
// Independent literal oracles copied from the approved BEFORE contract, not production builders.
const linear = ["zscale=t=linear:npl=100", "format=gbrpf32le"];
const pqTail = ["tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba", "scale=320:180:force_original_aspect_ratio=decrease", "format=rgba"];
const evFilter = (ev: number) => ev === 0 ? [] : [`exposure=exposure=${ev}:black=0`];
async function render(input: "pq" | "hlg" | "rec709", ev: number) {
  const project = createEmptyProject("Owned static exposure integration", { fps: 10, width: 320, height: 180 });
  project.assets.push(asset(input)); project.tracks[0].clips.push({ id: "clip", assetId: "asset", trackId: project.tracks[0].id, sourceStart: 0, duration: .3, timelineStart: 0, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: ev }, keyframes: [] });
  const output = join(root, `${input}-ev${ev}.mp4`); await renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 30000);
  const bytes = run(ffmpeg, ["-v", "error", "-i", output, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  expect(bytes.length).toBe(320 * 180 * 3 * 3); expect(sha(await readFile(sources[input].path))).toBe(sources[input].sha256);
  return { bytes, output, outputSha256: sha(await readFile(output)), decodedSha256: sha(bytes) };
}
it("retains >1 floating-point PQ highlights and halves them at -1EV before tone mapping", () => {
  const before = raw("pq", linear, "gbrpf32le"), after = raw("pq", [...linear, ...evFilter(-1)], "gbrpf32le");
  const original = nits.map((_n, i) => before.readFloatLE((90 * 320 + i * 32 + 16) * 4)), corrected = nits.map((_n, i) => after.readFloatLE((90 * 320 + i * 32 + 16) * 4));
  expect(Math.max(...original)).toBeGreaterThan(50); expect(Math.max(...corrected)).toBeCloseTo(50, 3);
  original.forEach((value, i) => expect(Math.abs(corrected[i] - value * .5)).toBeLessThanOrEqual(Math.max(1e-8, Math.abs(value) * 1e-5)));
});
it("PQ zero EV is byte-exact to the old neutral filter path", () => {
  const actual = raw("pq", [...compositorSourceColorPlan(asset("pq"), 320, 180, "rgba", 255, DEFAULT_COLOR_MANAGEMENT, undefined, 0).filters, "format=rgb24"]);
  const old = raw("pq", [...linear, ...pqTail, "format=rgb24"]);
  expect(actual.equals(old)).toBe(true); expect(sha(actual)).toBe(sha(old));
});
it.each([-3, -1, 0, 1, 3])("formal PQ EV%s matches pre-tone pixels and never double-applies static exposure", async ev => {
  const result = await render("pq", ev), expected = raw("pq", [...linear, ...evFilter(ev), ...pqTail, "format=rgb24"]);
  const error = difference(centers(result.bytes), centers(expected)); expect(error.mean).toBeLessThanOrEqual(2); expect(error.maximum).toBeLessThanOrEqual(6);
  let postError: ReturnType<typeof difference> | undefined, doubleError: ReturnType<typeof difference> | undefined;
  if (Math.abs(ev) === 1) {
    const post = raw("pq", [...linear, ...pqTail, ...evFilter(ev), "format=rgb24"]);
    const double = raw("pq", [...linear, ...evFilter(ev), ...pqTail, ...evFilter(ev), "format=rgb24"]);
    postError = difference(centers(result.bytes), centers(post)); doubleError = difference(centers(result.bytes), centers(double));
    expect(postError.mean).toBeGreaterThan(5); expect(doubleError.mean).toBeGreaterThan(5);
  }
  await writeFile(join(root, `pq-ev${ev}.json`), JSON.stringify({ ev, error, postError, doubleError, output: result.output, outputSha256: result.outputSha256, decodedSha256: result.decodedSha256, syntheticTechnicalOnly: true }, null, 2));
}, 30000);
it("HLG and SDR retain their existing exposure ownership in the formal compositor", async () => {
  const hlg = await render("hlg", -1), hlgExpected = raw("hlg", [...linear, "zscale=p=bt709", ...evFilter(-1), "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba", "scale=320:180:force_original_aspect_ratio=decrease", "format=rgba", "format=rgb24"]);
  const sdr = await render("rec709", -1), sdrExpected = raw("rec709", ["scale=320:180:force_original_aspect_ratio=decrease", "format=rgba", ...evFilter(-1), "format=rgb24"]);
  for (const error of [difference(centers(hlg.bytes), centers(hlgExpected)), difference(centers(sdr.bytes), centers(sdrExpected))]) { expect(error.mean).toBeLessThanOrEqual(2); expect(error.maximum).toBeLessThanOrEqual(6); }
});
it("unknown Log remains rejected by the real compositor without a completed output", async () => {
  const project = createEmptyProject("Unknown Log engineering negative", { fps: 10, width: 320, height: 180 });
  project.assets.push({ ...asset("pq"), color: { interpretation: "log_unresolved" } }); project.tracks[0].clips.push({ id: "clip", assetId: "asset", trackId: project.tracks[0].id, sourceStart: 0, duration: .3, timelineStart: 0, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: -1 }, keyframes: [] });
  const output = join(root, "unknown-log.mp4"); await expect(renderComposite(ffmpeg, ffprobe, output, project, buildRenderPlan(project, uri => uri), undefined, "libx264", 30000)).rejects.toThrow(/是未解讀 Log/);
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

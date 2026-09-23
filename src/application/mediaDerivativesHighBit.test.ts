import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateMediaDerivatives } from "./mediaDerivatives";
import { CURRENT_MEDIA_PREVIEW_RECIPE } from "./mediaDerivativeColor";

const roots: string[] = [];
const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffprobe = process.env.HAO_FFPROBE_PATH ?? resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
function run(exe: string, args: string[]) {
  const result = spawnSync(exe, args, { windowsHide: true, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${result.error ?? result.stderr}`);
  return result.stdout;
}
async function sha(path: string) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))); });

describe("real 10-bit source -> browser proxy cache", () => {
  it.each(["bt709", "arib-std-b67", "smpte2084"])("decodes %s into an 8-bit playable main/overlay without changing source", async transfer => {
    const root = await mkdtemp(join(tmpdir(), "editkin-10bit-")); roots.push(root);
    const source = join(root, "input.mp4"), hdr = transfer !== "bt709";
    // This bundled FFmpeg does not retain lavfi colour tags through its FFV1
    // fixture encoder. Bind literal H.264 VUI, then independently verify the
    // fixture before exercising the production display transform.
    const vui = `h264_metadata=colour_primaries=${hdr ? 9 : 1}:transfer_characteristics=${transfer === "arib-std-b67" ? 18 : transfer === "smpte2084" ? 16 : 1}:matrix_coefficients=${hdr ? 9 : 1}:video_full_range_flag=0`;
    run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=15:duration=1", "-threads", "2", "-vf", "format=yuv420p10le",
      "-c:v", "libx264", "-profile:v", "high10", "-pix_fmt", "yuv420p10le", "-color_primaries", hdr ? "bt2020" : "bt709", "-color_trc", transfer,
      "-colorspace", hdr ? "bt2020nc" : "bt709", "-color_range", "tv", "-bsf:v", vui, source]);
    const input = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", source])).streams[0];
    expect(input.pix_fmt).toBe("yuv420p10le");
    expect(input.color_transfer).toBe(transfer);
    expect(input.color_primaries).toBe(hdr ? "bt2020" : "bt709");
    expect(input.color_space).toBe(hdr ? "bt2020nc" : "bt709");
    const before = await sha(source);
    const request = { sourcePath: source, kind: "video" as const, duration: 1, hasAudio: false, cacheRoot: join(root, "cache"), ffmpegPath: ffmpeg, ffprobePath: ffprobe, timeoutMs: 30_000 };
    const result = await generateMediaDerivatives(request);
    expect(result.cacheHit).toBe(false);
    expect(result.derivatives.sourceSha256).toBe(before);
    expect(result.derivatives.proxyColorContract).toBe("editkin.browser-display-proxy/v1");
    expect(result.derivatives.proxyColor?.transfer).toBe("bt709");
    for (const path of [result.derivatives.proxyUri!, result.derivatives.overlayProxyUri!]) {
      const probe = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", path])).streams[0];
      expect(probe.codec_name).toBe("h264"); expect(probe.pix_fmt).toBe("yuv420p");
      expect(probe.width % 2).toBe(0); expect(probe.height % 2).toBe(0);
      expect(probe.color_transfer).toBe("bt709");
      expect(run(ffmpeg, ["-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-f", "framemd5", "-"]).split(/\r?\n/).filter(line => /^0,/.test(line))).toHaveLength(15);
    }
    expect(result.derivatives.overlayProxyFrameRateNumerator).toBe(15);
    expect((await generateMediaDerivatives(request)).cacheHit).toBe(true);
    // Damaged derived bytes must not be reused; original remains untouched.
    const proxy = result.derivatives.proxyUri!;
    await writeFile(proxy, "corrupt owned test derivative");
    const repaired = await generateMediaDerivatives(request);
    expect(repaired.cacheHit).toBe(false);
    expect(await readFile(repaired.derivatives.proxyUri!)).not.toEqual(Buffer.from("corrupt owned test derivative"));
    expect((await readdir(dirname(dirname(proxy)))).some(name => name.includes(".invalid-"))).toBe(true);
    if (!hdr) {
      const manifestPath = join(dirname(repaired.derivatives.proxyUri!), "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.schemaVersion).toBe(7);
      expect(manifest.recipe).toBe(CURRENT_MEDIA_PREVIEW_RECIPE);
      manifest.recipe = "retired-full-resolution-experiment";
      await writeFile(manifestPath, JSON.stringify(manifest));
      const currentRecipe = await generateMediaDerivatives(request);
      expect(currentRecipe.cacheHit).toBe(false);
      expect(JSON.parse(await readFile(manifestPath, "utf8")).recipe).toBe(CURRENT_MEDIA_PREVIEW_RECIPE);
    }
    expect(await sha(source)).toBe(before);
  }, 60_000);
});

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findParityBrowserV1 } from "./blendParityCssRendererV1";
import { writePngV1 } from "./blendParityHarnessV1";
import { extractParityVideoFrameV1, measureScanlineFocusParityFrameV1, scanlineFocusParityImagesV1, type ScanlineFocusParityFrameInputV1, type ScanlineFocusParityFrameV1 } from "./scanlineFocusPreviewParityV1";

/**
 * scanline_focus preview ↔ export parity gate (opt-in like the CSS blend parity: EDITKIN_PARITY_CSS=1, or report mode
 * EDITKIN_PARITY_OUT=<dir>, which writes scanline-focus-parity.json there). Frames: two deterministic pictures, one
 * frame of the tracked demo fixture, plus EDITKIN_PARITY_EXTRA_FRAMES=<png,png,…> (measurement only; e.g. real footage).
 */
const app = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpegPath = join(app, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
const ffprobePath = join(app, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
const videoFixture = join(app, "open-source/fixtures/demo-source.mp4");
const reportDirectory = process.env.EDITKIN_PARITY_OUT;
const browserPath = findParityBrowserV1();
const enabled = Boolean(reportDirectory || process.env.EDITKIN_PARITY_CSS === "1") && Boolean(browserPath) && existsSync(ffmpegPath);

let workDirectory = "";
const frames: ScanlineFocusParityFrameInputV1[] = [];
const results: ScanlineFocusParityFrameV1[] = [];

beforeAll(async () => {
  if (!enabled) return;
  workDirectory = reportDirectory ? join(resolve(reportDirectory), "scanline-focus-work") : await mkdtemp(join(tmpdir(), "editkin-scanline-parity-"));
  const images = join(workDirectory, "frames");
  await mkdir(images, { recursive: true });
  for (const image of scanlineFocusParityImagesV1()) {
    const path = join(images, `${image.name}.png`);
    await writePngV1(path, image.width, image.height, image.data);
    frames.push({ name: image.name, path, width: image.width, height: image.height });
  }
  if (existsSync(videoFixture)) {
    frames.push({ name: "demo-source-3s", width: 480, height: 270, path: await extractParityVideoFrameV1(ffmpegPath, videoFixture, 3, 480, 270, join(images, "demo-source-3s.png")) });
  }
  for (const [index, source] of (process.env.EDITKIN_PARITY_EXTRA_FRAMES ?? "").split(",").filter(Boolean).entries()) {
    // Re-encoded without colour chunks, so the browser draws the same code values FFmpeg reads.
    const png = PNG.sync.read(readFileSync(source)), path = join(images, `extra-${index}.png`);
    await writePngV1(path, png.width, png.height, new Uint8Array(png.data));
    frames.push({ name: `extra-${index}-${basename(source).replace(/[^A-Za-z0-9_.-]/g, "_")}`, path, width: png.width, height: png.height });
  }
});

afterAll(async () => {
  if (reportDirectory) await writeFile(join(resolve(reportDirectory), "scanline-focus-parity.json"), `${JSON.stringify({ schema: "editkin.scanline-focus-preview-parity/v1", results }, null, 2)}\n`, "utf8");
  else if (workDirectory) await rm(workDirectory, { recursive: true, force: true, maxRetries: 3 });
});

describe("scanline_focus preview follows the export sharpen", () => {
  it.skipIf(!enabled)("the Preview's SVG unsharp matches the export at one device pixel per project pixel, far closer than the former contrast(1.1)", async () => {
    for (const frame of frames) results.push(await measureScanlineFocusParityFrameV1(frame, { ffmpegPath, ffprobePath, browserPath: browserPath!, workDirectory }));
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const result of results) {
      const detail = JSON.stringify(result);
      // Harness check: without the effect both sides are the same picture through the same delivery.
      expect(result.floor.max, detail).toBeLessThanOrEqual(1);
      // Residual (2026-10-23: max ≤ 6, p99.9 ≤ 4, p99 ≤ 3 codes): FFmpeg's integer rounding and per-YUV-plane clamping.
      expect(result.preview.max, detail).toBeLessThanOrEqual(8);
      expect(result.preview.p999, detail).toBeLessThanOrEqual(5);
      expect(result.preview.p99, detail).toBeLessThanOrEqual(4);
      expect(result.effectDelta.p99, detail).toBeLessThanOrEqual(4);
      expect(result.preview.p999, detail).toBeLessThan(result.formerPreview.p999);
      expect(result.preview.mean, detail).toBeLessThan(result.formerPreview.mean);
      expect(result.effectDelta.p999, detail).toBeLessThan(result.formerEffectDelta.p999);
    }
  }, 900_000);
});

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeStudioCreativeAssets } from "../../creative/studioAssets";
import { PARITY_FIXTURES_V1 } from "./blendParityFixturesV1";
import { mergeParityMatricesV1, parityReportMarkdownV1, prepareParityImagesV1, runParityHarnessV1, type ParityMatrixV1, type ParityRendererV1 } from "./blendParityHarnessV1";
import { loadParityAcesReferenceV1, type ParityAcesReferenceV1 } from "./blendParityReferenceV1";
import { createParityExportRendererV1, measureParityAcesInputDecodeV1 } from "./blendParityExportRendererV1";
import { createParityNativeRendererV1 } from "./blendParityNativeRendererV1";
import { createParityCssRendererV1, findParityBrowserV1 } from "./blendParityCssRendererV1";

/**
 * P4 parity gate. One fixture set (blend mode × opacity, bottom-layer blends, track mattes alpha/luma (inverted,
 * source visible/hidden), adjustment layers; Rec.709 and ACES 2 phone) rendered by every route that runs headlessly
 * here and compared with the CPU W3C reference (blendParityReferenceV1).
 *
 * - export (always, needs vendor FFmpeg): renderComposite → FFV1 → decoded RGB vs the reference through the same
 *   delivery stage.
 * - native (when the development compositor exists): native image preview admission + WGSL on the GPU.
 * - css (opt-in: EDITKIN_PARITY_CSS=1, or report mode): the real Preview component in headless Chromium.
 *
 * Report mode (scripts/parity/blend-parity.mjs): EDITKIN_PARITY_OUT=<dir> writes parity-matrix.json and REPORT.md
 * there and enables every renderer; EDITKIN_PARITY_FIXTURES=<substring> narrows the fixtures.
 * Failures listed in KNOWN_GAPS belong to later packages; they stay in the matrix but do not fail this gate.
 */
const app = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpegPath = join(app, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
const ffprobePath = join(app, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
const colorRoot = join(app, "public/color/aces2");
const nativeExe = process.env.EDITKIN_PARITY_NATIVE_EXE ?? join(app, `native/bin/${platform}/editkin-gpu-compositor${suffix}`);
const reportDirectory = process.env.EDITKIN_PARITY_OUT;
const fixtureFilter = process.env.EDITKIN_PARITY_FIXTURES;
const fixtures = PARITY_FIXTURES_V1.filter(fixture => !fixtureFilter || fixture.id.includes(fixtureFilter));

/** route:fixture → owning package. Recorded in the matrix, excluded from this gate. */
const PARITY_KNOWN_GAPS_V1: ReadonlyMap<string, string> = new Map<string, string>([
  // P5 (compatible preview): CSS `plus-lighter` adds alpha-weighted colour (Cb + αs·Cs); D1 add is min(1, Cb + Cs)
  // under source-over, so they differ wherever the sum clips at partial alpha.
  ["css:rec709/blend/add/op1", "P5: CSS plus-lighter ≠ D1 add at partial alpha"],
  ["css:rec709/blend/add/op0.5", "P5: CSS plus-lighter ≠ D1 add at partial alpha"],
  // P5 BUG-8: the CSS stage blends a bottom layer against the theme's --preview-bg, not the black canvas.
  ...["multiply", "screen", "difference", "overlay"].map(mode => [`css:rec709/bottom/${mode}`, "P5 BUG-8: CSS bottom-layer blend backdrop"] as [string, string]),
  // P5: the native image preview draws the first layer without its blend (the video route declines it).
  ...["multiply", "overlay"].map(mode => [`native:rec709/bottom/${mode}`, "P5: native image admission keeps a bottom-layer blend"] as [string, string]),
  // P2 follow-up: one saturated-yellow sample (r1c3) is 3 delivered Cb codes (1.2 %) from the reference; the kernel
  // itself matches the linear reference within 16 working codes (blendKernelV1.render.test).
  ["export:aces2-phone/blend/add/op0.5", "P2 follow-up: ACES saturated-corner residual"],
]);

let workDirectory = "";
let aces: ParityAcesReferenceV1;
const matrices: ParityMatrixV1[] = [];

beforeAll(async () => {
  initializeStudioCreativeAssets();
  workDirectory = reportDirectory ? join(resolve(reportDirectory), "work") : await mkdtemp(join(tmpdir(), "editkin-blend-parity-"));
  await mkdir(workDirectory, { recursive: true });
  const { paths } = await prepareParityImagesV1(join(workDirectory, "images"));
  aces = await loadParityAcesReferenceV1(colorRoot, existsSync(ffmpegPath) ? await measureParityAcesInputDecodeV1(ffmpegPath, paths) : undefined);
});

afterAll(async () => {
  if (reportDirectory) {
    const matrix = mergeParityMatricesV1(matrices);
    await writeFile(join(resolve(reportDirectory), "parity-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
    await writeFile(join(resolve(reportDirectory), "REPORT.md"), parityReportMarkdownV1(matrix, PARITY_KNOWN_GAPS_V1), "utf8");
  } else if (workDirectory) await rm(workDirectory, { recursive: true, force: true, maxRetries: 3 });
});

async function gate(renderer: ParityRendererV1, skip: (note: string) => void): Promise<void> {
  const matrix = await runParityHarnessV1({ renderers: [renderer], workDirectory, fixtures, aces, includeSamples: Boolean(reportDirectory) });
  matrices.push(matrix);
  const unavailable = matrix.cells.find(cell => cell.status === "unavailable");
  if (unavailable) return skip(unavailable.reason ?? "renderer unavailable");
  const failures = matrix.cells.filter(cell => cell.status === "fail" && !PARITY_KNOWN_GAPS_V1.has(`${cell.renderer}:${cell.fixture}`))
    .map(cell => `${cell.fixture}: Δ${cell.maxDelta ?? "?"} ${cell.worst ? `${cell.worst.label} expected ${cell.worst.expected.join(",")} got ${cell.worst.actual.join(",")}` : cell.reason ?? ""}`);
  expect(failures).toEqual([]);
  // A route that admitted any gated fixture must have measured at least one passing cell (guards an empty run).
  if (matrix.cells.some(cell => cell.status === "fail")) expect(matrix.cells.filter(cell => cell.status === "pass").length).toBeGreaterThan(0);
}

describe("blend / matte / adjustment parity (P4 harness)", () => {
  it.skipIf(!existsSync(ffmpegPath))("export (renderComposite) matches the W3C reference", async context => {
    await gate(createParityExportRendererV1({ ffmpegPath, ffprobePath, colorRoot }), note => context.skip(note));
  }, 1_800_000);

  it.skipIf(!existsSync(nativeExe))("native image preview shader matches the W3C reference", async context => {
    await gate(createParityNativeRendererV1({ executablePath: nativeExe }), note => context.skip(note));
  }, 600_000);

  it.skipIf(!(reportDirectory || process.env.EDITKIN_PARITY_CSS === "1") || !findParityBrowserV1())("CSS compatible preview matches the W3C reference", async context => {
    await gate(createParityCssRendererV1(), note => context.skip(note));
  }, 600_000);
});

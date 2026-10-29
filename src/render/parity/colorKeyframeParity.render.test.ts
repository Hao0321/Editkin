import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COLOR_KEYFRAME_PARITY_FIXTURES_V1, runColorKeyframeParityV1, type ColorKeyframeParityResultV1 } from "./colorKeyframeParityV1";
import { prepareParityImagesV1 } from "./blendParityHarnessV1";

/**
 * Colour keyframe parity gate (AREA_B C1). Each fixture renders one keyframed clip through renderComposite and
 * compares every listed frame with a static export graded with the colour the preview evaluates at that frame
 * (animatedClipState). Report mode: EDITKIN_PARITY_OUT=<dir> writes color-keyframe-parity.json there.
 */
const app = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpegPath = join(app, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
const ffprobePath = join(app, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
const colorRoot = join(app, "public/color/aces2");
const reportDirectory = process.env.EDITKIN_PARITY_OUT;

let workDirectory = "";
let imagePath = "";
const results: ColorKeyframeParityResultV1[] = [];

beforeAll(async () => {
  workDirectory = reportDirectory ? join(resolve(reportDirectory), "color-keyframe-work") : await mkdtemp(join(tmpdir(), "editkin-colour-keyframe-parity-"));
  await mkdir(workDirectory, { recursive: true });
  imagePath = (await prepareParityImagesV1(join(workDirectory, "images"))).paths.backdrop;
});

afterAll(async () => {
  if (reportDirectory) await writeFile(join(resolve(reportDirectory), "color-keyframe-parity.json"), `${JSON.stringify({ schema: "editkin.color-keyframe-parity/v1", results }, null, 2)}\n`, "utf8");
  else if (workDirectory) await rm(workDirectory, { recursive: true, force: true, maxRetries: 3 });
});

describe("colour keyframe parity: animated export equals the preview-evaluated colour per frame", () => {
  it.skipIf(!existsSync(ffmpegPath)).each(COLOR_KEYFRAME_PARITY_FIXTURES_V1.map(fixture => [fixture.id, fixture] as const))("%s", async (_id, fixture) => {
    const result = await runColorKeyframeParityV1(fixture, imagePath, { ffmpegPath, ffprobePath, colorRoot: existsSync(colorRoot) ? colorRoot : undefined, workDirectory });
    results.push(result);
    if (result.status === "declined") return;
    expect(result.frames.filter(frame => frame.maxDelta > result.tolerance), JSON.stringify(result.frames)).toEqual([]);
    // The fixture really animates the fixed fields: the pre-fix export (static colour) differs visibly.
    expect(result.maxFlatDelta).toBeGreaterThan(8);
  }, 900_000);
});

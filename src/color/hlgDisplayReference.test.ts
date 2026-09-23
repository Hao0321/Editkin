import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserProxyColorPlan } from "../application/mediaDerivativeColor";
import { DEFAULT_COLOR_MANAGEMENT, type MediaAsset } from "../domain/types";
import { sourceLinearWhiteBalancePlan } from "../render/sourceLinearWhiteBalance";
import { inputNormalizationFilters } from "./primaryGrade";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpeg = process.platform === "win32" ? resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe") : "ffmpeg";
const width = 16, height = 4, planeSize = width * height;
const asset: MediaAsset = { id: "hlg-reference", name: "Synthetic HLG patches", uri: "synthetic", kind: "video", duration: 1,
  alphaMode: "straight", color: { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" } };
// Independent BT.2100-3 Table 5 reference, not imported production filters:
// zero display black; peak 1000 cd/m²; gamma 1.2; linear unit 100 cd/m².
function hlgReference(rgb: number[]): number[] {
  const a = .17883277, b = 1 - 4 * a, c = .5 - a * Math.log(4 * a);
  const scene = rgb.map(v => v <= .5 ? v * v / 3 : (Math.exp((v - c) / a) + b) / 12);
  const y = .2627 * scene[0] + .6780 * scene[1] + .0593 * scene[2];
  return scene.map(v => y === 0 ? 0 : 10 * v * y ** .2);
}
const patchColors = [[.38, .38, .38], [.75, .75, .75], [.75, .25, .25], [.25, .25, .75]];
// Keep a straight float alpha plane throughout so this decoder test does not
// accidentally measure swscale's RGB<->RGBA format negotiation instead.
const input = Buffer.alloc(planeSize * 4 * 4);
for (let p = 0; p < 3; p++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
  input.writeFloatLE(patchColors[y][[1, 2, 0][p]], (p * planeSize + y * width + x) * 4);
for (let pixel = 0; pixel < planeSize; pixel++) input.writeFloatLE(1, (3 * planeSize + pixel) * 4);
const actualInput = patchColors.map((_, y) => [2, 0, 1].map(p => input.readFloatLE((p * planeSize + y * width + 8) * 4)));
const expected = actualInput.map(hlgReference);

function decoded(filters: string[]): number[][] {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-threads", "2", "-filter_threads", "2",
    "-f", "rawvideo", "-pixel_format", "gbrapf32le", "-video_size", `${width}x${height}`, "-framerate", "1", "-i", "pipe:0",
    "-vf", ["setparams=range=full:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=gbr", ...filters, "format=gbrapf32le"].join(","),
    "-frames:v", "1", "-an", "-c:v", "rawvideo", "-pix_fmt", "gbrapf32le", "-f", "rawvideo", "pipe:1"],
  { input, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, shell: false });
  if (result.error || result.status !== 0) throw Error(`HLG reference subprocess failed: ${result.error ?? result.stderr.toString()}`);
  expect(result.stdout.length).toBe(input.length);
  for (let pixel = 0; pixel < planeSize; pixel++) expect(result.stdout.readFloatLE((3 * planeSize + pixel) * 4)).toBe(1);
  return actualInput.map((_, y) => [2, 0, 1].map(p => result.stdout.readFloatLE((p * planeSize + y * width + 8) * 4)));
}
function expectReference(actual: number[][]) {
  actual.forEach((rgb, y) => rgb.forEach((value, channel) => {
    expect(Math.abs(value - expected[y][channel]), `patch ${y} channel ${channel}: actual ${value}, reference ${expected[y][channel]}`)
      .toBeLessThanOrEqual(.00003 * (1 + Math.abs(expected[y][channel])));
  }));
}
function decodePrefix(filters: string[]): string[] {
  const index = filters.findIndex(filter => filter.startsWith("zscale=") && /(?:^|:)t=linear(?:$|:)/.test(filter.slice("zscale=".length)));
  expect(index, "production plan must contain an explicit HLG linear decode").toBeGreaterThanOrEqual(0);
  const result = filters.slice(0, index + 1);
  expect(result.some(filter => filter.startsWith("tonemap=") || /(?:^|:)p=bt709(?:$|:)/.test(filter))).toBe(false);
  return result;
}

describe("HLG display-linear standard reference, not visual acceptance", () => {
  it("anchors nominal HLG grey and diffuse white to BT.2100/BT.2408 values", () => {
    expect(expected[0][0] * 100).toBeCloseTo(26.2382649, 5);
    expect(expected[1][0] * 100).toBeCloseTo(203.1521459, 5);
  });
  it("calibrates the literal evaluator against exact OOTF and rejects the old per-channel approximation", () => {
    expectReference(decoded(["zscale=t=linear:npl=100:agamma=0"]));
    const approximate = decoded(["zscale=t=linear:npl=100"]);
    expect(Math.abs(approximate[2][0] - expected[2][0])).toBeGreaterThan(.4);
    expect(Math.abs(approximate[3][2] - expected[3][2])).toBeGreaterThan(.6);
  });
  it.each([
    ["browser proxy", () => browserProxyColorPlan({ colorPrimaries: "bt2020", colorTransfer: "arib-std-b67", colorMatrix: "bt2020nc", colorRange: "tv" }).normalization],
    ["formal zero-white-balance normalization", () => inputNormalizationFilters(asset, DEFAULT_COLOR_MANAGEMENT)],
    ["reference/white-balance source", () => sourceLinearWhiteBalancePlan(asset, {}).filters],
  ] as const)("%s actually decodes using the luminance OOTF before gamut or tone mapping", (_name, plan) => {
    const source = Buffer.from(input);
    expectReference(decoded(decodePrefix(plan())));
    expect(input.equals(source)).toBe(true);
  });
});

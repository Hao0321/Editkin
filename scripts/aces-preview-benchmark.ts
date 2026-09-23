import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCubeLut, sampleCubeLut } from "../src/color/cubeLut";

const root = resolve(".");
const input = parseCubeLut(await readFile(resolve(root, "public/color/aces2/luts/input-rec709-to-acescct.cube"), "utf8"));
const output = parseCubeLut(await readFile(resolve(root, "public/color/aces2/luts/output-acescct-to-rec709_sdr.cube"), "utf8"));
const framePixels = 320 * 180;
let checksum = 0;

function runFrame(): number {
  const started = performance.now();
  for (let pixel = 0; pixel < framePixels; pixel += 1) {
    const r = (pixel % 320) / 319;
    const g = (Math.floor(pixel / 320) % 180) / 179;
    const b = ((pixel * 37) % 256) / 255;
    const transformed = sampleCubeLut(output, sampleCubeLut(input, [r, g, b]));
    checksum += transformed[0] + transformed[1] + transformed[2];
  }
  return performance.now() - started;
}

runFrame();
const runs = Array.from({ length: 7 }, runFrame).sort((left, right) => left - right);
const p50Ms = runs[3];
const p95Ms = runs[6];
const thresholds = { p50Ms: 24, p95Ms: 38 };
const status = p50Ms <= thresholds.p50Ms && p95Ms <= thresholds.p95Ms ? "GREEN" : "RED";
const report = { schemaVersion: 1, status, frame: { width: 320, height: 180, pixels: framePixels }, lutSizes: { input: input.size, output: output.size }, p50Ms, p95Ms, thresholds, checksum };
const reportRoot = resolve(root, "reports");
await mkdir(reportRoot, { recursive: true });
await writeFile(resolve(reportRoot, "aces-preview-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (status !== "GREEN") process.exitCode = 1;

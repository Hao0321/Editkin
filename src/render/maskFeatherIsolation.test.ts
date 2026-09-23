import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import type { ClipMask } from "../domain/types";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { buildClipMaskAlphaFilters } from "./maskFilters";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const width = 64, height = 32;

function rectangle(id: string, left = 0, right = 1): ClipMask {
  const mask = createClipMask(id, "rectangle");
  mask.feather = 0;
  mask.path = [
    { id: "a", x: left, y: 0 }, { id: "b", x: right, y: 0 },
    { id: "c", x: right, y: 1 }, { id: "d", x: left, y: 1 },
  ];
  return mask;
}

async function decodedFixture(name: string, masks: ClipMask[], sourceAlpha: (x: number) => number) {
  const evidenceBase = process.env.EDITKIN_MASK_EVIDENCE_ROOT ?? resolve(app, ".rd/tmp");
  await mkdir(evidenceBase, { recursive: true });
  const root = await mkdtemp(resolve(evidenceBase, `mask-${name}-`));
  const processes: object[] = [];
  function run(args: string[], input?: Buffer) {
    const started = performance.now();
    const child = spawnSync(ff, args, { input, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    processes.push({ executable: ff, args, pid: child.pid, exitCode: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr?.toString(), elapsedMs: performance.now() - started });
    if (child.status !== 0 || child.error) throw Error(child.stderr?.toString() || String(child.error));
    return child.stdout;
  }
  const source = resolve(root, "source.png"), output = resolve(root, "output.mp4");
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let p = 0; p < width * height; p += 1) rgba[p * 4 + 3] = sourceAlpha(p % width);
  run(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", source], rgba);
  const project = createDemoProject();
  project.width = width; project.height = height; project.fps = 30;
  Object.assign(project.assets[0], { uri: source, kind: "image", width, height, duration: 1, alphaMode: "straight" });
  const clip = project.tracks[0].clips[0];
  clip.duration = 6 / 30; clip.timelineStart = 3 / 30; clip.volume = 0; clip.masks = masks;
  const before = JSON.stringify(project);
  await renderComposite(ff, fp, output, project, buildRenderPlan(project, p => p), undefined, "libx264", 30000);
  const raw = run(["-v", "error", "-i", output, "-an", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
  const stride = width * height * 3;
  const samples = Array.from({ length: raw.length / stride }, (_, frame) => Array.from({ length: width }, (_, x) => raw[frame * stride + (16 * width + x) * 3]));
  await writeFile(resolve(root, "evidence.json"), JSON.stringify({ scope: "actual formal compositor, synthetic alpha correctness only", ffmpegSha256: sha(await readFile(ff)), sourceSha256: sha(rgba), outputSha256: sha(await readFile(output)), processes, samples }, null, 2));
  expect(JSON.stringify(project)).toBe(before);
  expect(samples).toHaveLength(9);
  for (const row of samples.slice(0, 3)) expect(Math.max(...row)).toBeLessThanOrEqual(4);
  return { samples: samples.slice(3), root };
}

describe("formal compositor per-operation feather isolation", () => {
  it("keeps the existing source-alpha discontinuity under a feathered full-frame mask", async () => {
    const mask = rectangle("full-soft"); mask.feather = .15;
    const { samples, root } = await decodedFixture("source-alpha", [mask], x => x < 32 ? 0 : 128);
    for (const row of samples) {
      expect(row[31], root).toBeLessThanOrEqual(4);
      expect(Math.abs(row[32] - 128), root).toBeLessThanOrEqual(4);
    }
  }, 30000);

  it.each(["add", "subtract", "intersect"] as const)("does not spread another mask's feather across a hard %s edge", async mode => {
    const soft = rectangle("soft", 0, mode === "add" ? .125 : 1); soft.feather = .08;
    const hard = rectangle("hard", .75, 1); hard.mode = mode;
    const { samples, root } = await decodedFixture(mode, [soft, hard], () => 255);
    const left = mode === "subtract" ? 255 : 0, right = 255 - left;
    for (const row of samples) {
      expect(Math.abs(row[47] - left), root).toBeLessThanOrEqual(4);
      expect(Math.abs(row[48] - right), root).toBeLessThanOrEqual(4);
    }
  }, 30000);

  it("evaluates feathered tracked/lost samples in clip-local time at a nonzero timeline start", async () => {
    const mask = rectangle("tracked-soft"); mask.feather = .15; mask.inverted = false;
    mask.keyframes = [
      { frame: 0, time: 0, status: "tracked", confidence: 1, points: mask.path },
      { frame: 6, time: .2, status: "lost", confidence: 0, points: mask.path },
    ];
    const { samples, root } = await decodedFixture("lost-time", [mask], () => 255);
    for (const row of samples.slice(0, 3)) expect(Math.min(...row), root).toBeGreaterThanOrEqual(251);
    for (const row of samples.slice(3)) expect(Math.max(...row), root).toBeLessThanOrEqual(4);
  }, 30000);
});

// Lossless plane checks isolate precision from H.264/ProRes quantization. These
// exercise the exact alpha builder used by renderComposite, not a model/quality claim.
describe.each([255, 65535] as const)("lossless formal mask planes (maximum %s)", maximum => {
  it.each(["source-edge", "baked-detail", "ordered-stack"] as const)("preserves %s", async kind => {
    const evidenceBase = process.env.EDITKIN_MASK_EVIDENCE_ROOT ?? resolve(app, ".rd/tmp");
    await mkdir(evidenceBase, { recursive: true });
    const root = await mkdtemp(resolve(evidenceBase, `mask-plane-${maximum}-${kind}-`));
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const full = rectangle("soft-full"); full.feather = .15;
    clip.masks = [full];
    if (kind === "ordered-stack") {
      full.opacity = .8;
      const cut = rectangle("hard-cut", .5, 1); cut.mode = "subtract"; cut.opacity = .5;
      const limit = rectangle("hard-limit"); limit.mode = "intersect"; limit.opacity = .6;
      clip.masks.push(cut, limit);
    }
    if (kind === "baked-detail") {
      const roto = createClipMask("frozen-roto", "subject");
      roto.inverted = true;
      roto.matteSequence = {
        schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
        width, height, analysisFps: 30, frameCount: 1, sequenceUri: "synthetic.alpha8", manifestUri: "synthetic.json",
        framePreviewUris: ["synthetic.png"], frozen: true, qualityState: "diagnostic", meanBoundaryChatter: 0,
      };
      full.mode = "intersect"; full.opacity = .5;
      clip.masks = [roto, full];
    }
    const plan = compileClipAlphaPlan(project, clip);
    const bytesPerPixel = maximum === 255 ? 1 : 2;
    const format = maximum === 255 ? "gray" : "gray16le";
    const source = Buffer.alloc(width * height * bytesPerPixel), matte = Buffer.alloc(source.length);
    const sourceValue = (x: number) => kind === "source-edge" ? (x < 32 ? 0 : maximum === 255 ? 128 : 32769) : maximum;
    const expected = (x: number) => kind === "source-edge" ? sourceValue(x)
      : kind === "baked-detail" ? (x % 2 ? 0 : Math.floor(maximum * .5))
        : Math.round(maximum * (x < 32 ? .6 : .4));
    for (let p = 0; p < width * height; p += 1) {
      const value = sourceValue(p % width), matteValue = p % 2 ? maximum : 0;
      if (bytesPerPixel === 1) { source[p] = value; matte[p] = matteValue; }
      else { source.writeUInt16LE(value, p * 2); matte.writeUInt16LE(matteValue, p * 2); }
    }
    const sourcePath = resolve(root, "source.raw"), mattePath = resolve(root, "matte.raw");
    await writeFile(sourcePath, source); await writeFile(mattePath, matte);
    const graph = buildClipMaskAlphaFilters(plan, { sourceAlphaLabel: "0:v", pixelMatteLabel: kind === "baked-detail" ? "1:v" : undefined, outputLabel: "alpha", width, height, pixelMaximum: maximum }).join(";");
    const args = ["-v", "error", "-f", "rawvideo", "-pixel_format", format, "-video_size", `${width}x${height}`, "-framerate", "30", "-i", sourcePath,
      ...(kind === "baked-detail" ? ["-f", "rawvideo", "-pixel_format", format, "-video_size", `${width}x${height}`, "-framerate", "30", "-i", mattePath] : []),
      "-filter_complex", graph, "-map", "[alpha]", "-frames:v", "1", "-pix_fmt", format, "-f", "rawvideo", "-"];
    const child = spawnSync(ff, args, { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    expect(child.status, child.stderr?.toString()).toBe(0);
    expect(child.stdout.length).toBe(source.length);
    const values = Array.from({ length: width * height }, (_, p) => bytesPerPixel === 1 ? child.stdout[p] : child.stdout.readUInt16LE(p * 2));
    const errors = values.map((value, p) => Math.abs(value - expected(p % width)));
    await writeFile(resolve(root, "evidence.json"), JSON.stringify({ scope: "lossless alpha builder only; synthetic matte, no tracker inference", maximum, kind, args, ffmpegSha256: sha(await readFile(ff)), pid: child.pid, exitCode: child.status, signal: child.signal, stderr: child.stderr?.toString(), expected: Array.from({ length: width }, (_, x) => expected(x)), row: values.slice(16 * width, 17 * width), maximumError: Math.max(...errors), outputSha256: sha(child.stdout) }, null, 2));
    expect(Math.max(...errors), root).toBeLessThanOrEqual(1);
  }, 30000);
});

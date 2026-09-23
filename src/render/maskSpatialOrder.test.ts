import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import type { ClipMask, RotoMatteSequence, TimelineClip } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 192, height = 128, sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const layout = { crop: { x: .125, y: .125, width: .5, height: .75 }, viewport: { x: .375, y: .125, width: .5, height: .5 } };
const cases: Array<{ id: string; transform?: Partial<TimelineClip["transform"]>; layout?: TimelineClip["layout"]; full?: boolean; pixel?: boolean; letterbox?: boolean }> = [
  { id: "identity-control" },
  { id: "half-scale", transform: { scale: .5 } },
  { id: "quarter-turn", transform: { rotation: 90 } },
  { id: "tilted-full", transform: { rotation: 33 }, full: true },
  { id: "pip-crop", layout },
  { id: "pip-scale-offset", layout, transform: { scale: .75, x: 12, y: -8 } },
  { id: "pip-rotate", layout, transform: { rotation: 27, scale: .8, x: -8, y: 4 } },
  { id: "pixel-pip-crop", layout, pixel: true },
  { id: "letterbox-pip", layout, letterbox: true },
];

it.each(cases)("masked spatial order agrees with independently pre-masked source: $id", async spec => {
  const evidenceBase = process.env.EDITKIN_SPATIAL_EVIDENCE_ROOT ?? resolve(app, ".rd/tmp");
  await mkdir(evidenceBase, { recursive: true });
  const root = await mkdtemp(resolve(evidenceBase, `spatial-${spec.id}-`));
  const processes: object[] = [];
  function run(args: string[], input?: Buffer) {
    const child = spawnSync(ff, args, { input, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    processes.push({ executable: ff, args, pid: child.pid, code: child.status, signal: child.signal, stderr: child.stderr?.toString(), error: child.error?.message });
    if (child.status !== 0 || child.error) throw Error(child.stderr?.toString() || String(child.error));
    return child.stdout;
  }
  function png(rgba: Buffer, path: string, imageHeight = height) {
    run(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${imageHeight}`, "-i", "pipe:0", "-frames:v", "1", path], rgba);
  }
  const sourceHeight = spec.letterbox ? height / 2 : height;
  const sourcePath = resolve(root, "source.png"), referencePath = resolve(root, "premasked.png");
  png(Buffer.alloc(width * sourceHeight * 4, 255), sourcePath, sourceHeight);
  const premasked = Buffer.alloc(width * height * 4, 255);
  const matteBytes = Buffer.alloc(width * height);
  // Independent closed-form raster oracle. No production mask evaluator is used.
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const insideMask = spec.full || (x >= width / 8 && x <= width * 5 / 8 && y >= height / 8 && y <= height * 5 / 8);
    const insideSource = !spec.letterbox || (y >= height / 4 && y < height * 3 / 4);
    matteBytes[y * width + x] = insideMask ? 255 : 0;
    premasked[(y * width + x) * 4 + 3] = insideMask && insideSource ? 255 : 0;
  }
  png(premasked, referencePath);
  const project = createDemoProject(); project.width = width; project.height = height; project.fps = 30;
  Object.assign(project.assets[0], { uri: sourcePath, kind: "image", width, height: sourceHeight, duration: 1, alphaMode: "straight" });
  const clip = project.tracks[0].clips[0]; clip.duration = .2; clip.timelineStart = .1; clip.volume = 0;
  Object.assign(clip.transform, spec.transform); clip.layout = spec.layout;
  const mask: ClipMask = createClipMask("source-space-mask", "rectangle"); mask.feather = 0;
  const left = spec.full ? 0 : .125, right = spec.full ? 1 : .625;
  mask.path = [{ id: "a", x: left, y: left }, { id: "b", x: right, y: left }, { id: "c", x: right, y: right }, { id: "d", x: left, y: right }];
  if (spec.pixel) {
    mask.kind = "subject";
    // Synthetic verified transport fixture, never a claim of executed Roto inference.
    const matteRoot = resolve(root, "auto-roto-product", "d".repeat(64)); await mkdir(matteRoot, { recursive: true });
    const rawPath = resolve(matteRoot, "matte-sequence.alpha8"), manifestPath = resolve(matteRoot, "matte-manifest.json");
    const sequence = Buffer.concat([matteBytes, matteBytes, matteBytes]); await writeFile(rawPath, sequence);
    run(["-v", "error", "-f", "rawvideo", "-pixel_format", "gray", "-video_size", `${width}x${height}`, "-framerate", "12", "-i", "pipe:0", "-start_number", "0", resolve(matteRoot, "frame-%06d.png")], sequence);
    const paths = [0, 1, 2].map(i => resolve(matteRoot, `frame-${String(i).padStart(6, "0")}.png`));
    const routeReceipt = createProductAutoRotoRouteReceipt();
    const regionMemoryRouting = { schema: "editkin.region-memory-routing/v1" as const, requested: "fixed_baseline" as const, executed: "fixed_baseline" as const, candidateAttempted: false as const, deterministicFallback: false as const };
    const alphaRefinement = { schema: "editkin.optical-alpha-refinement-aggregate/v1" as const, engine: "editkin-self-authored-optical-alpha-refiner/v1" as const, appliedFrames: 3, radius: 4, backgroundThreshold: .2, foregroundThreshold: .8, coarseWeight: .5, temporalStability: .5, temporalGate: .5, changedPixels: 0, fractionalPixels: 0, solvedPixels: 0, meanSolveConfidence: 1 };
    const matte: RotoMatteSequence = { schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1", width, height, analysisFps: 12, frameCount: 3, sequenceUri: rawPath, sequenceSha256: sha(sequence), sequenceBytes: sequence.length, manifestUri: manifestPath, framePreviewUris: paths, frameArtifactUris: paths, meanBoundaryChatter: 0, correctionStrokesApplied: 0, correctedFrames: [], regionMemoryRouting, alphaRefinement, routeReceipt, frozen: true, qualityState: "diagnostic" };
    const frames = await Promise.all(paths.map(async (alphaPath, frame) => ({ frame, time: frame / 12, alphaPath, confidence: 1, foregroundRatio: .25, boundaryChatter: 0, previewSha256: sha(await readFile(alphaPath)), alphaFrameSha256: sha(matteBytes) })));
    await writeFile(manifestPath, JSON.stringify({ schema: matte.schema, engine: matte.engine, width, height, analysisFps: 12, initialFrame: 0, sequencePath: rawPath, frames, sequenceSha256: matte.sequenceSha256, sequenceBytes: sequence.length, meanBoundaryChatter: 0, correctionStrokesApplied: 0, correctedFrames: [], regionMemoryRouting, alphaRefinement, routeReceipt, frozen: true, qualityState: "diagnostic" }));
    mask.matteSequence = matte;
  }
  clip.masks = [mask];
  const reference = structuredClone(project); reference.assets[0].uri = referencePath; reference.assets[0].height = height;
  reference.tracks[0].clips[0].masks = [];
  const before = JSON.stringify(project);
  const output = resolve(root, "actual.mp4"), referenceOutput = resolve(root, "reference.mp4");
  await renderComposite(ff, fp, output, project, buildRenderPlan(project, p => p), undefined, "libx264", 30000, undefined, undefined, undefined, root);
  await renderComposite(ff, fp, referenceOutput, reference, buildRenderPlan(reference, p => p), undefined, "libx264", 30000);
  const decode = (path: string) => run(["-v", "error", "-i", path, "-an", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
  const actual = decode(output), expected = decode(referenceOutput);
  expect(actual.length).toBe(expected.length); expect(actual.length).toBe(width * height * 3 * 9);
  let sum = 0, max = 0;
  for (let p = 0; p < actual.length; p += 1) { const error = Math.abs(actual[p] - expected[p]); sum += error; max = Math.max(max, error); }
  for (const [path, input] of [["actual-frame.png", output], ["reference-frame.png", referenceOutput]]) run(["-v", "error", "-i", input, "-vf", "select=eq(n\\,3)", "-frames:v", "1", resolve(root, path)]);
  const evidence = { schema: "editkin.mask-spatial-fixture/v1", id: spec.id, spec, project, reference, width, height, sourcePath, referencePath, output, referenceOutput, actualFrame: resolve(root, "actual-frame.png"), referenceFrame: resolve(root, "reference-frame.png"), maximumError: max, meanError: sum / actual.length, sourceSha256: sha(await readFile(sourcePath)), referenceSourceSha256: sha(premasked), outputSha256: sha(await readFile(output)), ffmpegSha256: sha(await readFile(ff)), processes };
  await writeFile(resolve(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  expect(JSON.stringify(project)).toBe(before);
  expect(max, root).toBeLessThanOrEqual(4); expect(sum / actual.length, root).toBeLessThanOrEqual(.5);
}, 30000);

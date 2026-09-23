import { expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { DEFAULT_TRANSFORM, type EditProject, type TimelineClip, type Transform2D } from "../domain/types";
import { composedTransformExpressions } from "./ffmpegExpressions";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { measureDecodedTransform, decodedTransformAccepted as accepted } from "./decodedTransformMetric.testHelper";

const { productionProcesses } = vi.hoisted(() => ({ productionProcesses: [] as object[] }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    const child = real.spawn(...args);
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on("close", (code, signal) => productionProcesses.push({ executable: args[0], args: args[1], pid: child.pid, code, signal, stderr }));
    return child;
  } };
});

const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 192, height = 128, fps = 30, totalFrames = 12, startFrame = 3;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tx = (patch: Partial<Transform2D> = {}): Transform2D => ({ ...DEFAULT_TRANSFORM, ...patch });
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
// Independent affine composition oracle, not the expression compiler or preview evaluator.
function compose(parent: Transform2D, child: Transform2D): Transform2D {
  const angle = parent.rotation * Math.PI / 180;
  return { x: parent.x + parent.scale * (child.x * Math.cos(angle) - child.y * Math.sin(angle)),
    y: parent.y + parent.scale * (child.x * Math.sin(angle) + child.y * Math.cos(angle)),
    scale: parent.scale * child.scale, rotation: parent.rotation + child.rotation, opacity: parent.opacity * child.opacity };
}
interface Case {
  id: string; base?: Partial<Transform2D>; end?: Partial<Transform2D>; child?: Partial<Transform2D>;
  grand?: Partial<Transform2D>; start?: number; duration?: number; expression?: boolean;
  unmasked?: boolean; colorOnly?: boolean; layout?: TimelineClip["layout"];
}
const cases: Case[] = [
  { id: "identity-parent-control" },
  { id: "static-parent-scale", base: { scale: .6 } },
  { id: "static-parent-rotation", base: { rotation: 33 } },
  { id: "static-parent-opacity", base: { opacity: .5 }, unmasked: true },
  { id: "nested-parents", grand: { x: 7, y: -4, scale: .8, rotation: -12, opacity: .7 }, base: { x: -8, y: 6, scale: .8, rotation: 22, opacity: .8 }, child: { x: 8, y: -4 } },
  { id: "animated-parent-scale", base: { scale: .55 }, end: { scale: .85 } },
  { id: "animated-parent-rotation", base: { scale: .6, rotation: -20 }, end: { rotation: 35 } },
  { id: "animated-parent-opacity-position", base: { x: -12, opacity: .25 }, end: { x: 12, opacity: .85 } },
  { id: "parent-preroll-clamp", start: .2, duration: .2, base: { scale: .7, rotation: -15 }, end: { rotation: 25 } },
  { id: "parent-expression-clamped-time", start: .2, duration: .2, base: { scale: .7 }, expression: true },
  { id: "parent-expression-postroll", duration: .15, base: { scale: .7 }, expression: true },
  { id: "pip-parent", base: { x: -8, y: 4, scale: .8, rotation: 27, opacity: .8 }, layout: { crop: { x: .125, y: .125, width: .5, height: .75 }, viewport: { x: .375, y: .125, width: .5, height: .5 } } },
  { id: "color-only-keyframes", colorOnly: true },
];

function localOracle(spec: Case, time: number): Transform2D {
  const duration = spec.duration ?? .4, local = clamp(time - (spec.start ?? 0), 0, duration);
  const base = tx(spec.base), result = { ...base };
  for (const key of Object.keys(spec.end ?? {}) as Array<keyof Transform2D>) result[key] = base[key] + (spec.end![key]! - base[key]) * local / duration;
  if (spec.expression) { result.x = 40 * local; result.rotation = -12 + 100 * local; result.opacity = .4 + 2 * local; }
  return result;
}

function fixture(spec: Case, source: string): EditProject {
  const project = createDemoProject(); project.width = width; project.height = height; project.fps = fps;
  Object.assign(project.assets[0], { uri: source, kind: "image", width, height, duration: 1, alphaMode: "straight" });
  const parent = project.tracks[0].clips[0]; parent.duration = spec.duration ?? .4; parent.timelineStart = spec.start ?? 0; parent.volume = 0;
  parent.layer = { enabled: true, role: "controller", blendMode: "normal" }; parent.transform = tx(spec.base);
  if (spec.end) parent.keyframes = [{ id: "parent-end", time: parent.duration, transform: { ...parent.transform, ...spec.end }, color: { ...parent.color }, easing: "linear" }];
  if (spec.expression) parent.expressions = { x: "hao.expression/v1: 40 * time", rotation: "hao.expression/v1: -12 + 100 * time", opacity: "hao.expression/v1: 0.4 + 2 * time" };
  if (spec.grand) {
    const grand = structuredClone(parent); grand.id = "grand"; grand.transform = tx(spec.grand); grand.keyframes = []; grand.expressions = undefined;
    grand.trackId = "grand-track";
    project.tracks.push({ id: grand.trackId, kind: "video", name: "Grandparent", muted: false, locked: false, clips: [grand] }); parent.layer.parentClipId = grand.id;
  }
  const child = structuredClone(parent); child.id = "child"; child.trackId = "child-track"; child.timelineStart = startFrame / fps; child.duration = (totalFrames - startFrame) / fps;
  child.transform = tx(spec.child); child.keyframes = []; child.expressions = undefined; child.layout = spec.layout;
  child.layer = { enabled: true, role: "content", blendMode: "normal", parentClipId: parent.id };
  if (spec.colorOnly) child.keyframes = [{ id: "color-only", time: child.duration, transform: { ...child.transform }, color: { ...child.color }, easing: "linear" }];
  if (!spec.unmasked) {
    const mask = createClipMask("rectangle", "rectangle"); mask.feather = 0;
    mask.path = [{ id: "a", x: .125, y: .125 }, { id: "b", x: .625, y: .125 }, { id: "c", x: .625, y: .625 }, { id: "d", x: .125, y: .625 }];
    child.masks = [mask];
  }
  project.tracks.push({ id: child.trackId, kind: "video", name: "Child", muted: false, locked: false, clips: [child] });
  return project;
}

function measure(actual: Buffer, expected: Buffer) {
  return measureDecodedTransform(actual, expected, width, height);
}

it("calibrates encoded geometry/opacity against positive, shifted, empty and wrong-opacity controls", () => {
  const white = Buffer.alloc(width * height); for (let y = 24; y < 80; y++) for (let x = 32; x < 120; x++) white[y * width + x] = 200;
  expect(accepted(measure(white, white))).toBe(true);
  const shifted = Buffer.alloc(white.length); white.copy(shifted, 12, 0, white.length - 12);
  for (const bad of [shifted, Buffer.alloc(white.length), Buffer.from(white.map(n => n / 2))]) expect(accepted(measure(bad, white))).toBe(false);
  const dim = Buffer.from(white.map(n => n / 2)), ringing = Buffer.from(dim); ringing[32 * width + 40] = 125;
  expect(accepted(measure(dim, ringing))).toBe(true);
});

it("compiles unchanged keyframe channels as constants without dropping true animation", () => {
  const project = fixture({ id: "channels", colorOnly: true }, "source.png"), child = project.tracks.at(-1)!.clips[0];
  child.layer!.parentClipId = undefined;
  child.keyframes[0].transform.x = 20; child.keyframes[0].color.brightness = .1;
  const expressions = composedTransformExpressions(project, child, "t", fps);
  expect(expressions.scale).toBe("1"); expect(expressions.rotation).toBe("0"); expect(expressions.opacity).toBe("1");
  expect(expressions.x).toContain("t");
});

it.each(cases)("inherits transforms in decoded output against independent frame snapshots: $id", async spec => {
  const base = process.env.EDITKIN_PARENT_EVIDENCE_ROOT ?? resolve(app, ".rd/tmp"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, `${spec.id}-`)), processes: object[] = []; productionProcesses.length = 0;
  const run = (args: string[], input?: Buffer) => {
    const child = spawnSync(ff, args, { input, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    processes.push({ executable: ff, args, pid: child.pid, code: child.status, signal: child.signal, stderr: child.stderr?.toString() });
    if (child.status !== 0 || child.error) throw Error(child.stderr?.toString() || String(child.error)); return child.stdout;
  };
  const source = resolve(root, "source.png"), premasked = resolve(root, "premasked.png"), rgba = Buffer.alloc(width * height * 4, 255);
  const png = (pixels: Buffer, path: string) => run(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", path], pixels);
  png(rgba, source);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba[(y * width + x) * 4 + 3] = spec.unmasked || x >= width / 8 && x <= width * 5 / 8 && y >= height / 8 && y <= height * 5 / 8 ? 255 : 0;
  png(rgba, premasked);
  const project = fixture(spec, source), before = JSON.stringify(project), reference = structuredClone(project);
  reference.assets[0].uri = premasked; reference.tracks = [reference.tracks.at(-1)!]; reference.tracks[0].clips = [];
  const expectedTransforms: Transform2D[] = [];
  for (let frame = startFrame; frame < totalFrames; frame++) {
    let parent = localOracle(spec, frame / fps); if (spec.grand) parent = compose(tx(spec.grand), parent);
    const transform = compose(parent, tx(spec.child)); expectedTransforms.push(transform);
    const clip = structuredClone(project.tracks.at(-1)!.clips[0]); clip.id = `snapshot-${frame}`; clip.timelineStart = frame / fps; clip.duration = 1 / fps;
    clip.transform = transform; clip.keyframes = []; clip.expressions = undefined; clip.masks = []; clip.layer!.parentClipId = undefined;
    reference.tracks[0].clips.push(clip);
  }
  const output = resolve(root, "actual.mp4"), referenceOutput = resolve(root, "reference.mp4");
  await renderComposite(ff, fp, output, project, buildRenderPlan(project, p => p), undefined, "libx264", 30000);
  await renderComposite(ff, fp, referenceOutput, reference, buildRenderPlan(reference, p => p), undefined, "libx264", 30000);
  const decode = (path: string) => run(["-v", "error", "-i", path, "-an", "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
  const actual = decode(output), expected = decode(referenceOutput), bytesPerFrame = width * height;
  expect(actual.length).toBe(bytesPerFrame * totalFrames); expect(expected.length).toBe(actual.length);
  const metrics = Array.from({ length: totalFrames - startFrame }, (_, i) => { const frame = i + startFrame, offset = frame * bytesPerFrame; return { frame, ...measure(actual.subarray(offset, offset + bytesPerFrame), expected.subarray(offset, offset + bytesPerFrame)) }; });
  for (const [path, input] of [["actual-frame.png", output], ["reference-frame.png", referenceOutput]]) run(["-v", "error", "-i", input, "-vf", "select=eq(n\\,6)", "-frames:v", "1", resolve(root, path)]);
  const evidence = { schema: "editkin.parented-transform-fixture/v1", id: spec.id, spec, project, reference, expectedTransforms, metrics, root, output, referenceOutput, source, premasked, sourceSha256: sha(await readFile(source)), outputSha256: sha(await readFile(output)), referenceSha256: sha(await readFile(referenceOutput)), ffmpegSha256: sha(await readFile(ff)), processes: [...processes, ...productionProcesses] };
  await writeFile(resolve(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  expect(JSON.stringify(project)).toBe(before);
  expect(metrics.filter(m => !accepted(m)), root).toEqual([]);
}, 30000);

import { expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { measureDecodedTransform, decodedTransformAccepted as accepted } from "./decodedTransformMetric.testHelper";

const { productionProcesses } = vi.hoisted(() => ({ productionProcesses: [] as object[] }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    const child = real.spawn(...args); let stderr = "";
    child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on("close", (code, signal) => productionProcesses.push({ executable: args[0], args: args[1], pid: child.pid, code, signal, stderr }));
    return child;
  } };
});

const app = fileURLToPath(new URL("../../", import.meta.url));
const ff = resolve(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), fp = resolve(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const width = 128, height = 96, frameCount = 6, bytesPerFrame = width * height;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cases = [24, 30, 60, 24000 / 1001, 30000 / 1001, 60000 / 1001].map((fps, i) => ({ id: `rate-${i}`, fps, startFrame: 0 }));
cases.push({ id: "nonzero-clip-start", fps: 30, startFrame: 7 });
// Independent editorial schedule, not a call to any product interpolation/compiler.
const values = (frame: number) => frame < 2 ? { x: -24, opacity: 1, brightness: 0 } : frame < 4 ? { x: 24, opacity: .7, brightness: .1 } : { x: 0, opacity: 1, brightness: -.1 };
function fixture(fps: number, startFrame: number, source: string): EditProject {
  const p = createDemoProject(); p.width = width; p.height = height; p.fps = fps;
  Object.assign(p.assets[0], { uri: source, kind: "image", width, height, alphaMode: "straight" });
  const clip = p.tracks[0].clips[0]; clip.timelineStart = startFrame / fps; clip.duration = frameCount / fps; clip.volume = 0;
  clip.keyframes = [0, 2, 4].map(frame => { const v = values(frame); return { id: `key-${frame}`, time: frame / fps,
    transform: { ...DEFAULT_TRANSFORM, x: v.x, opacity: v.opacity }, color: { ...clip.color, brightness: v.brightness }, easing: "hold" }; });
  return p;
}

it("calibrates boundary-frame pixel checks with shifted, empty and wrong-opacity negatives", () => {
  const good = Buffer.alloc(bytesPerFrame); for (let y = 32; y < 64; y++) for (let x = 48; x < 80; x++) good[y * width + x] = 180;
  expect(accepted(measureDecodedTransform(good, good, width, height))).toBe(true);
  const shifted = Buffer.alloc(bytesPerFrame); good.copy(shifted, 24, 0, good.length - 24);
  for (const bad of [shifted, Buffer.alloc(bytesPerFrame), Buffer.from(good.map(v => Math.round(v / 2)))]) expect(accepted(measureDecodedTransform(bad, good, width, height))).toBe(false);
});

it.each(cases)("renders authored zero/hold boundaries against independent frame snapshots: $id", async spec => {
  const base = process.env.EDITKIN_KEYFRAME_EVIDENCE_ROOT ?? resolve(app, ".rd/tmp"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, `${spec.id}-`)), processes: object[] = []; productionProcesses.length = 0;
  const run = (args: string[], input?: Buffer) => {
    const child = spawnSync(ff, args, { input, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    processes.push({ executable: ff, args, pid: child.pid, code: child.status, signal: child.signal, stderr: child.stderr?.toString() });
    if (child.status !== 0 || child.error) throw Error(child.stderr?.toString() || String(child.error)); return child.stdout;
  };
  const source = resolve(root, "source.png"), pixels = Buffer.alloc(bytesPerFrame * 4);
  for (let y = 32; y < 64; y++) for (let x = 48; x < 80; x++) {
    const i = (y * width + x) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 180; pixels[i + 3] = 255;
  }
  run(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", source], pixels);
  const project = fixture(spec.fps, spec.startFrame, source), before = JSON.stringify(project), reference = structuredClone(project), original = project.tracks[0].clips[0];
  reference.tracks[0].clips = Array.from({ length: frameCount }, (_, frame) => {
    const clip = structuredClone(original), v = values(frame); clip.id = `snapshot-${frame}`; clip.timelineStart = (spec.startFrame + frame) / spec.fps; clip.duration = 1 / spec.fps;
    clip.keyframes = []; clip.transform = { ...DEFAULT_TRANSFORM, x: v.x, opacity: v.opacity }; clip.color = { ...clip.color, brightness: v.brightness }; return clip;
  });
  const output = resolve(root, "actual.mp4"), referenceOutput = resolve(root, "reference.mp4");
  await renderComposite(ff, fp, output, project, buildRenderPlan(project, p => p), undefined, "libx264", 30000);
  await renderComposite(ff, fp, referenceOutput, reference, buildRenderPlan(reference, p => p), undefined, "libx264", 30000);
  const decode = (path: string) => run(["-v", "error", "-i", path, "-an", "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "-"]);
  const actual = decode(output), expected = decode(referenceOutput);
  const metrics = Array.from({ length: frameCount }, (_, frame) => { const offset = (frame + spec.startFrame) * bytesPerFrame;
    return { frame, expected: values(frame), ...measureDecodedTransform(actual.subarray(offset, offset + bytesPerFrame), expected.subarray(offset, offset + bytesPerFrame), width, height) }; });
  for (const [name, path] of [["actual-frame2.png", output], ["reference-frame2.png", referenceOutput]]) run(["-v", "error", "-i", path, "-vf", `select=eq(n\\,${spec.startFrame + 2})`, "-frames:v", "1", resolve(root, name)]);
  await writeFile(resolve(root, "evidence.json"), JSON.stringify({ schema: "editkin.keyframe-boundary-fixture/v1", spec, root, source, project, reference, output, referenceOutput, metrics,
    byteCounts: { actual: actual.length, expected: expected.length }, sourceSha256: sha(await readFile(source)), outputSha256: sha(await readFile(output)), referenceSha256: sha(await readFile(referenceOutput)), processes: [...processes, ...productionProcesses] }, null, 2));
  expect(JSON.stringify(project)).toBe(before);
  expect(actual.length).toBe(bytesPerFrame * (spec.startFrame + frameCount)); expect(expected.length).toBe(actual.length);
  expect(metrics.filter(m => !accepted(m)), root).toEqual([]);
}, 30000);

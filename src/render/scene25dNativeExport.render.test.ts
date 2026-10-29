import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_PARTICLE_SIMULATION, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { renderProject } from "./ffmpeg";
import { renderComposite } from "./ffmpegComposite";
import { buildRenderPlan } from "./planner";
import { SCENE25D_IMAGE_ENGINE_PLANNER_V1, scene25dExportPlanV1, scene25dVisualProjectV1 } from "./scene25dNativeExportV1";
import { isExportFeatureRefusalV1 } from "./exportFeatureRefusalV1";

/**
 * Rec.709 2.5D and particle exports go through the native image engine graph the desktop preview runs, never the
 * flat FFmpeg composite. Each exported frame is compared with the native single-frame render (`engine-render`, the
 * preview executor) of the same graph, and with the old flat composite (which must differ).
 */
const run = promisify(execFile);
const app = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpegPath = join(app, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
const ffprobePath = join(app, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
const nativeExe = process.env.EDITKIN_PARITY_NATIVE_EXE ?? join(app, `native/bin/${platform}/editkin-gpu-compositor${suffix}`);
const available = existsSync(ffmpegPath) && existsSync(nativeExe);
const W = 320, H = 180, FPS = 30, DURATION = .5;

let root = "", plate = "", card = "";
beforeAll(async () => {
  if (!available) return;
  root = await mkdtemp(join(tmpdir(), "editkin-scene25d-export-"));
  plate = join(root, "plate.png"); card = join(root, "card.jpg");
  // Smooth pictures keep H.264 4:2:0 delivery error small, so the comparisons measure the route, not chroma loss.
  await run(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=0x2050c0:c1=0xf0c040:x0=0:y0=0:x1=${W}:y1=${H}`, "-frames:v", "1", plate], { windowsHide: true });
  await run(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", `gradients=s=${W}x${H}:c0=0xe04040:c1=0x40e0a0:x0=${W}:y0=0:x1=0:y1=${H}`, "-frames:v", "1", "-q:v", "2", card], { windowsHide: true });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

function imageProject(withScene: boolean, withParticles: boolean): EditProject {
  const project = createEmptyProject("2.5D export", { id: "scene25d-export", width: W, height: H, fps: FPS });
  project.assets.push({ id: "plate", name: "plate.png", uri: plate, kind: "image", duration: 5, width: W, height: H },
    { id: "card", name: "card.jpg", uri: card, kind: "image", duration: 5, width: W, height: H });
  const clip = (id: string, assetId: string, trackId: string) => ({ id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: DURATION, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  project.tracks[0].clips.push(withScene ? { ...clip("back", "plate", project.tracks[0].id), transform3d: { position: [0, 0, -1], rotationDegrees: [0, 0, 0], scale: [1.6, 1.6, 1] } }
    : clip("back", "plate", project.tracks[0].id));
  if (withScene) {
    project.tracks.push({ id: "front-track", name: "front", kind: "video", locked: false, muted: false, clips: [{ ...clip("front", "card", "front-track"),
      transform3d: { position: [.2, 0, .6], rotationDegrees: [0, 50, 0], scale: [.5, .5, 1] } }] });
    project.scene25d = structuredClone(DEFAULT_SCENE_25D);
    project.scene25d.camera.keyframes = [{ id: "c0", time: 1 / FPS, position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 60, easing: "linear" },
      { id: "c1", time: DURATION - 2 / FPS, position: [.5, .1, 3.4], target: [0, 0, 0], verticalFovDegrees: 52, easing: "linear" }];
  }
  if (withParticles) project.particleSimulation = structuredClone(DEFAULT_PARTICLE_SIMULATION);
  return project;
}

async function frames(path: string): Promise<Buffer[]> {
  const { stdout } = await run(ffmpegPath, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const size = W * H * 3, list: Buffer[] = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) list.push(stdout.subarray(offset, offset + size));
  return list;
}
const meanAbs = (a: Uint8Array, b: Uint8Array) => { let sum = 0; for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
/** Fraction of pixels whose largest channel difference exceeds 40 codes (a different picture, not coding noise). */
const strongDifference = (a: Uint8Array, b: Uint8Array) => {
  let count = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 40) count += 1;
  return count / (a.length / 3);
};

/** The preview executor's frame (straight RGBA over black), as RGB. */
async function nativeFrame(project: EditProject, frame: number, directory: string): Promise<Uint8Array> {
  const preview = scene25dExportPlanV1(project, { gpuCompositorPath: nativeExe });
  if (preview.kind !== "native-image-engine") throw new Error(`not admitted: ${preview.kind}`);
  const bindings = Object.fromEntries(await Promise.all(Object.entries(preview.preview.assetBindings).map(async ([id, path]) => {
    if (path.endsWith(".png")) return [id, path];
    const converted = join(directory, `${id}.png`);
    await run(ffmpegPath, ["-v", "error", "-y", "-i", path, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "image2", "-c:v", "png", converted], { windowsHide: true });
    return [id, converted];
  })));
  const graphPath = join(directory, "graph.json"), bindingsPath = join(directory, "bindings.json"), output = join(directory, `native-${frame}.png`);
  await writeFile(graphPath, JSON.stringify(preview.preview.graph)); await writeFile(bindingsPath, JSON.stringify(bindings));
  await run(nativeExe, ["engine-render", graphPath, bindingsPath, String(frame), output, "gpu"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const png = PNG.sync.read(await readFile(output)), rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i += 1) for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = Math.round(png.data[i * 4 + c] * png.data[i * 4 + 3] / 255);
  return rgb;
}

describe("Rec.709 2.5D and particle export through the native image engine", () => {
  it("admits image planes, refuses without a native runtime, and strips audio/captions from the visual graph only", () => {
    const project = imageProject(true, false);
    const refused = scene25dExportPlanV1(project, {});
    expect(refused.kind).toBe("refuse");
    if (refused.kind === "refuse") expect(isExportFeatureRefusalV1(refused.error) && refused.error.messageKey).toContain("原生 GPU 合成程式");
    project.captions.push({ id: "cap", start: 0, duration: .4, text: "字幕" });
    expect(scene25dVisualProjectV1(project).captions).toEqual([]);
    expect(project.captions).toHaveLength(1);
  });

  it.skipIf(!available).each([
    ["2.5D planes with an animated camera", true, false],
    ["particles over an image", false, true],
  ] as const)("%s: export equals the native preview frames and differs from the flat composite", async (_name, scene, particles) => {
    const project = imageProject(scene, particles);
    const directory = await mkdtemp(join(root, "case-"));
    const output = join(directory, "export.mp4");
    const result = await renderProject(project, output, { ffmpegPath, ffprobePath, gpuCompositorPath: nativeExe, preferGpu: false, workRoot: directory });
    expect(result.planner).toBe(SCENE25D_IMAGE_ENGINE_PLANNER_V1);
    expect(result.nativeImageEngine?.frameCount).toBe(DURATION * FPS);
    if (scene) expect(result.nativeImageEngine?.scene25d?.cameraAnimatedFrames).toBeGreaterThan(5);
    if (particles) expect(result.nativeImageEngine?.vfxSimulation).toEqual({ emitterCount: 1, particleCeiling: 64 });
    const exported = await frames(output);
    expect(exported).toHaveLength(DURATION * FPS);
    const flatPath = join(directory, "flat.mkv");
    await renderComposite(ffmpegPath, ffprobePath, flatPath, project, buildRenderPlan(project, uri => uri), undefined, "ffv1", 120_000);
    const flat = await frames(flatPath);
    for (const frame of [6, 10]) {
      const native = await nativeFrame(project, frame, directory);
      // Lossy H.264 4:2:0 delivery of the same pixels: a small mean error; strong differences only along the native
      // executor's hard (un-antialiased) plane edges, where 4:2:0 chroma smears across the edge.
      expect(meanAbs(exported[frame], native)).toBeLessThan(3);
      expect(strongDifference(exported[frame], native)).toBeLessThan(.02);
      // Frame-accurate: the export is closer to this frame's native render than to the next one.
      if (scene) expect(meanAbs(exported[frame], native)).toBeLessThan(meanAbs(exported[frame], await nativeFrame(project, frame + 1, directory)));
      // The flat composite (the pre-fix export) is a different picture: the planes or particles are missing.
      expect(strongDifference(flat[frame], native)).toBeGreaterThan(scene ? .05 : .001);
    }
  }, 600_000);
});

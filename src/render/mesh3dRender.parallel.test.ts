import { createHash } from "node:crypto";
import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { validateMesh3dProject } from "../domain/mesh3dValidation";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset } from "../domain/types";
import { Mesh3dWorkerPoolV1, mesh3dDefaultThreadsV1 } from "../motion/mesh3dParallel";
import { MESH3D_MAX_OBJECTS, MESH3D_MAX_SCENE_TRIANGLES, MESH3D_MAX_TEXTURES } from "../motion/mesh3dRasterizer";
import { MESH3D_SCENE_BUDGET_V1, mesh3dGeometryPeakV1, mesh3dSceneSchema, type Mesh3dObject, type Mesh3dTubeSetGeometryV1 } from "../motion/mesh3dScene";
import { Mesh3dGeometryCache } from "../motion/mesh3dGeometry";
import { renderMesh3dProjectFrameV1 } from "../motion/mesh3dProjectFrameV1";
import { mesh3dTubeSetCountV1 } from "../motion/mesh3dTubeSet";
import { mesh3dShadingExecutorV1 } from "./mesh3dShadingExecutorV1";
import { renderMesh3dVideo, type Mesh3dRenderEngineOptionsV1 } from "./mesh3dRender";

/**
 * The export path (renderMesh3dVideo) on its worker pool writes the same bytes as on the calling thread, and the engine
 * budgets are enforced before any decoder or encoder starts. FFmpeg is replaced by small Node stand-ins: decoders emit
 * deterministic RGBA (varying alpha), the encoder writes the SHA-256 of every raw frame it receives to the output path.
 */
const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const spawn = (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => {
    spawned.push({ command, args: [...args] });
    const after = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    let script: string;
    if (command === "fixture-ffprobe") {
      script = `process.stdout.write(${JSON.stringify(JSON.stringify({ streams: [{ codec_type: "video", width: 40, height: 24, color_transfer: "bt709" }], format: { duration: "1" } }))})`;
    } else if (args.includes("pipe:0")) {
      const [width, height] = after("-s").split("x").map(Number);
      script = [`const { createHash } = require("node:crypto"), fs = require("node:fs"), size = ${width * height * 4}, out = ${JSON.stringify(args.at(-1))};`,
        "let pending = Buffer.alloc(0); const hashes = [];",
        "process.stdin.on(\"data\", data => { pending = Buffer.concat([pending, data]); while (pending.length >= size) { hashes.push(createHash(\"sha256\").update(pending.subarray(0, size)).digest(\"hex\")); pending = pending.subarray(size); } });",
        "process.stdin.on(\"end\", () => fs.writeFileSync(out, JSON.stringify({ hashes, rest: pending.length })));"].join("\n");
    } else {
      const [, width, height] = /scale=(\d+):(\d+)/.exec(after("-vf")) ?? [];
      const bytes = Number(width) * Number(height) * 4 * Number(after("-frames:v")), seed = [...after("-i")].reduce((n, c) => (n * 31 + c.charCodeAt(0)) & 0xffff, 7);
      script = `const b = Buffer.alloc(${bytes}); for (let i = 0; i < b.length; i++) b[i] = (i * 7 + ${seed} * 31 + (i >> 9)) & 255; process.stdout.write(b);`;
    }
    return real.spawn(process.execPath, ["-e", script], options);
  };
  return { ...real, spawn };
});

const roots: string[] = [];
afterEach(async () => {
  spawned.length = 0; vi.restoreAllMocks();
  // A killed stand-in can hold its output file a moment longer on Windows: retry the removal.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 30_000);
const fixtureOptions = (root: string) => ({ ffmpegPath: "fixture-ffmpeg", ffprobePath: "fixture-ffprobe", timeoutMs: 60_000, assetBase: root });
type V = [number, number, number];
const pose = (position: V = [0, 0, 0], rotationDegrees: V = [0, 0, 0], scale: V = [1, 1, 1]) => ({ position, rotationDegrees, scale });
const object = (id: string, geometry: object, material: object, at = pose(), keyframes: object[] = []) =>
  ({ id, name: id, geometry, material: { unlit: false, ...material }, pose: at, keyframes }) as Mesh3dObject;

async function project(frames: number, sources: Array<{ clip: string; file: string; kind: MediaAsset["kind"] }>) {
  const root = await mkdtemp(join(tmpdir(), "editkin-mesh-parallel-")); roots.push(root);
  const result: EditProject = createEmptyProject("mesh parallel", { width: 48, height: 36, fps: 30 });
  for (const source of sources) {
    const path = join(root, source.file);
    await writeFile(path, `fixture bytes for ${source.clip}; the FFmpeg stand-in never decodes them`);
    result.assets.push({ id: `asset-${source.clip}`, name: source.file, kind: source.kind, uri: path, duration: 1, color: { interpretation: "rec709" } });
    result.tracks[0].clips.push({ id: source.clip, assetId: `asset-${source.clip}`, trackId: result.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: frames / 30,
      volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  }
  return { root, project: result };
}
function segment(frames: number, objects: Mesh3dObject[], camera: object = {}) {
  const base = { position: [.4, 1, 4.2], target: [0, .2, 0], verticalFovDegrees: 50, near: .1, far: 30 };
  return { id: "seg", name: "seg", timelineStart: 0, duration: frames / 30, camera: { ...base, ...camera },
    cameraKeyframes: [{ time: frames / 30, camera: { ...base, ...camera, position: [1.1, .9, 3.9] }, easing: "smooth" }], objects };
}
async function encoded(output: string): Promise<string[]> {
  const result = JSON.parse(await readFile(output, "utf8")) as { hashes: string[]; rest: number };
  expect(result.rest).toBe(0);
  return result.hashes;
}

describe("mesh3d export on the worker pool", () => {
  // Every engine path the export can take: a video and an alpha-mipmap texture card, a world-anchored overlay on float64
  // depth, GGX roughness with an area/sphere key, soft shadows, AO + bloom + vignette, grid style and camera roll.
  async function polished(frames = 4) {
    const { root, project: p } = await project(frames, [
      { clip: "footage", file: "footage.mp4", kind: "video" }, { clip: "card", file: "card.jpg", kind: "image" }, { clip: "label", file: "label.jpg", kind: "image" }]);
    p.scene3d = mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: true,
      background: { color: "#101828", gridColor: "#3050A0", spacing: 40, grid: false, radial: { color: "#8A1A4C", center: [.5, .36], radius: .5, strength: .7 } },
      light: { direction: [-.55, .85, .9], ambient: .25, intensity: .95, size: 8, distance: 7, shadow: { strength: .7, softness: 2, mapSize: 256 } },
      segments: [segment(frames, [
        object("screen", { kind: "curved_video", radius: 3, width: 2, height: 1.1, segments: 16 }, { color: "#FFFFFF", unlit: true, clipId: "footage" }, pose([0, .9, -1.2])),
        object("card", { kind: "box", width: .7, height: .7, depth: .01, uvMode: "front" }, { color: "#FFFFFF", unlit: true, clipId: "card", texture: { filter: "mipmap", alpha: true }, doubleSided: true }, pose([-.6, .5, -.2], [0, 20, -5])),
        object("ball", { kind: "sphere", radius: .3, segments: 24 }, { color: "#F868A8", specular: { strength: .6, shininess: 40 }, roughness: .35 }, pose([.5, .1, .3]),
          [{ time: frames / 30, pose: pose([.2, .4, .3]), easing: "linear" }]),
        object("floor", { kind: "box", width: 6, height: .05, depth: 6 }, { color: "#5A1230", grid: true, gridStyle: { cells: 12, lineWidthPx: 1.5, color: "#C8467E" } }, pose([0, -.3, 0])),
      ], { roll: -3 })],
      overlaysV1: { schema: "editkin.mesh-overlays/v1", anchors: [{ id: "a", segmentId: "seg", objectId: "ball", localPoint: [0, .3, 0] }],
        layers: [{ id: "l", anchorId: "a", clipId: "label", size: [.3, .12], offset: [0, -.05], pivot: [.5, 1], opacity: .9, occlusion: "depth_test" }] },
      post: { ao: { strength: .7, radius: .3 }, bloom: { threshold: .7, strength: .6, radius: .05 }, vignette: { strength: .4, softness: .5 } } });
    return { root, project: p };
  }
  async function run(input: EditProject, root: string, name: string, engine: Mesh3dRenderEngineOptionsV1 = {}) {
    const frames: string[] = [], output = join(root, `${name}.mp4`);
    const receipt = await renderMesh3dVideo(input, output, fixtureOptions(root), { ...engine, onFrame: (index, rgba) => {
      expect(index).toBe(frames.length);
      frames.push(createHash("sha256").update(rgba).digest("hex"));
    } });
    const written = await encoded(output);
    expect(written).toEqual(frames);
    return { receipt, frames };
  }

  it("writes byte-identical frames to the encoder for the calling thread and 2, 3 and the default worker count", async () => {
    const { root, project: p } = await polished();
    const serial = await run(p, root, "serial", { threads: 1 });
    expect(serial.receipt.parallel).toEqual({ workers: 0, poolFrames: 0 });
    expect(serial.frames).toHaveLength(4);
    expect(new Set(serial.frames).size).toBe(4);
    for (const threads of [2, 3, undefined]) {
      const pooled = await run(p, root, `pool-${threads ?? "default"}`, threads === undefined ? {} : { threads });
      expect(pooled.frames, `${threads ?? "default"} threads`).toEqual(serial.frames);
      // The default is mesh3dDefaultThreadsV1(); a machine with fewer than 2 spare cores renders on the calling thread.
      const workers = threads ?? mesh3dDefaultThreadsV1();
      expect(pooled.receipt.parallel).toEqual(workers >= 2 ? { workers, poolFrames: 4 } : { workers: 0, poolFrames: 0 });
      expect({ ...pooled.receipt, renderMilliseconds: 0, maxFrameMilliseconds: 0, peakResidentBytes: 0, parallel: undefined })
        .toEqual({ ...serial.receipt, renderMilliseconds: 0, maxFrameMilliseconds: 0, peakResidentBytes: 0, parallel: undefined });
    }
    expect(serial.receipt).toMatchObject({ executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "per-pixel-key-fill-hemisphere-specular/soft-shadowmap/v1",
      post: ["ao", "bloom", "vignette"], lightingFeatures: ["ggx-roughness", "area-key", "sphere-key"] });
  }, 120_000);

  it("finishes on the calling thread with the same bytes when the pool cannot start", async () => {
    const { root, project: p } = await polished(3);
    const serial = await run(p, root, "serial", { threads: 1 });
    const fallback = await run(p, root, "no-pool", { threads: 65 });
    expect(fallback.frames).toEqual(serial.frames);
    expect(fallback.receipt.parallel).toEqual({ workers: 65, poolFrames: 0, fallback: "MESH_PARALLEL_THREADS_INVALID" });
  }, 120_000);

  it("finishes on the calling thread with the same bytes when a worker fails mid-job, and closes the pool once", async () => {
    const { root, project: p } = await polished(4);
    const serial = await run(p, root, "serial", { threads: 1 });
    const original = Mesh3dWorkerPoolV1.prototype.renderProjectFrame;
    let calls = 0;
    vi.spyOn(Mesh3dWorkerPoolV1.prototype, "renderProjectFrame").mockImplementation(function (this: Mesh3dWorkerPoolV1, ...args: Parameters<typeof original>) {
      return ++calls === 2 ? Promise.reject(new Error("MESH_PARALLEL_WORKER_EXIT 1")) : original.apply(this, args);
    });
    const close = vi.spyOn(Mesh3dWorkerPoolV1.prototype, "close");
    const failed = await run(p, root, "worker-exit", { threads: 3 });
    expect(failed.frames).toEqual(serial.frames);
    expect(failed.receipt.parallel).toEqual({ workers: 3, poolFrames: 1, fallback: "MESH_PARALLEL_WORKER_EXIT 1" });
    expect(calls).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("closes its pool after a job, including a failed one", async () => {
    const { root, project: p } = await polished(2);
    const close = vi.spyOn(Mesh3dWorkerPoolV1.prototype, "close");
    await run(p, root, "closed", { threads: 2 });
    expect(close).toHaveBeenCalledTimes(1);
    const broken = structuredClone(p); broken.assets.find(a => a.id === "asset-footage")!.uri = join(root, "missing.mp4");
    await expect(renderMesh3dVideo(broken, join(root, "broken.mp4"), fixtureOptions(root), { threads: 2 })).rejects.toThrow("ENOENT");
    expect(close).toHaveBeenCalledTimes(2);
  }, 120_000);
});

describe("mesh3d validation and export use the engine budgets (128 objects, 16 textures, 200k triangles a frame)", () => {
  it("names the same budgets as the frame planner", () => {
    expect(MESH3D_SCENE_BUDGET_V1).toEqual({ objects: MESH3D_MAX_OBJECTS, textures: MESH3D_MAX_TEXTURES, triangles: MESH3D_MAX_SCENE_TRIANGLES });
    expect(MESH3D_SCENE_BUDGET_V1).toEqual({ objects: 128, textures: 16, triangles: 200_000 });
  });
  const screens = (count: number, first = 0) => Array.from({ length: count }, (_, i) => object(`screen${first + i}`, { kind: "curved_video", radius: 3, width: .4, height: .3, segments: 4 },
    { color: "#FFFFFF", unlit: true, clipId: `clip${first + i}` }, pose([(i % 6) * .5 - 1.25, Math.floor(i / 6) * .4 - .4, -1])));
  const sources = (count: number) => Array.from({ length: count }, (_, i) => ({ clip: `clip${i}`, file: `clip${i}.mp4`, kind: "video" as const }));
  const sceneOf = (objects: Mesh3dObject[], frames = 2, extra: object = {}) => mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: true,
    background: { color: "#FFFFFF", gridColor: "#E0EAF8", spacing: 72, grid: false }, light: { direction: [-.4, .7, 1], ambient: .68, intensity: .36 },
    segments: [segment(frames, objects)], ...extra });

  it("admits 16 material textures in a segment (and exports them) but refuses 17", async () => {
    const sixteen = await project(2, sources(16));
    sixteen.project.scene3d = sceneOf(screens(16));
    expect(() => validateMesh3dProject(sixteen.project)).not.toThrow();
    const receipt = await renderMesh3dVideo(sixteen.project, join(sixteen.root, "sixteen.mp4"), fixtureOptions(sixteen.root));
    expect(receipt.sources).toHaveLength(16);
    expect(receipt.frameCount).toBe(2);
    const seventeen = await project(2, sources(17));
    seventeen.project.scene3d = sceneOf(screens(17));
    expect(() => validateMesh3dProject(seventeen.project)).toThrow("3D 同幕最多 16 個影片材質");
  }, 120_000);

  it("counts material and overlay textures together: 16 admitted, 17 refused", async () => {
    for (const [materials, expected] of [[14, undefined], [15, "合計最多 16 個來源"]] as const) {
      const { project: p } = await project(2, [...sources(materials), { clip: "label0", file: "label0.jpg", kind: "image" }, { clip: "label1", file: "label1.jpg", kind: "image" }]);
      p.scene3d = sceneOf(screens(materials), 2, { overlaysV1: { schema: "editkin.mesh-overlays/v1",
        anchors: [{ id: "a", segmentId: "seg", objectId: "screen0", localPoint: [0, 0, 0] }],
        layers: ["label0", "label1"].map((clipId, i) => ({ id: `l${i}`, anchorId: "a", clipId, size: [.1, .05], offset: [0, i * .06], pivot: [.5, .5], opacity: 1, occlusion: "always_front" })) } });
      if (expected) expect(() => validateMesh3dProject(p)).toThrow(expected); else expect(() => validateMesh3dProject(p)).not.toThrow();
    }
  }, 60_000);

  it("refuses more than 128 objects in a segment", async () => {
    const { project: p } = await project(2, []);
    const many = Array.from({ length: 129 }, (_, i) => object(`o${i}`, { kind: "box", width: .1, height: .1, depth: .1 }, { color: "#203040" }, pose([(i % 16) * .2 - 1.5, Math.floor(i / 16) * .2 - .8, 0])));
    p.scene3d = { ...sceneOf(many.slice(0, 128)), segments: [{ ...sceneOf(many.slice(0, 128)).segments[0], objects: many }] };
    expect(() => validateMesh3dProject(p)).toThrow("3D 場景格式不合法");
    p.scene3d = sceneOf(many.slice(0, 128));
    expect(() => validateMesh3dProject(p)).not.toThrow();
  });

  it("refuses a segment over 200k triangles before any decoder or encoder starts, and renders one at 196,608", async () => {
    // A 64 x 64 torus is 8,192 triangles: 24 = 196,608 (within), 25 = 204,800 (over).
    const torus = (i: number) => object(`t${i}`, { kind: "torus", radius: .3, tube: .05, segments: 64, tubeSegments: 64 }, { color: "#F868A8" }, pose([(i % 5) * .5 - 1, Math.floor(i / 5) * .4 - .8, -1]));
    const over = await project(2, []);
    over.project.scene3d = sceneOf(Array.from({ length: 25 }, (_, i) => torus(i)));
    expect(() => validateMesh3dProject(over.project)).not.toThrow();
    await expect(renderMesh3dVideo(over.project, join(over.root, "over.mp4"), fixtureOptions(over.root))).rejects.toThrow("三角形 204800/200000");
    expect(spawned).toEqual([]);
    const within = await project(2, []);
    within.project.scene3d = sceneOf(Array.from({ length: 24 }, (_, i) => torus(i)));
    const receipt = await renderMesh3dVideo(within.project, join(within.root, "within.mp4"), fixtureOptions(within.root));
    expect(receipt.maxTriangles).toBe(196_608);
  }, 120_000);
});

describe("tube_set in the export path", () => {
  type V = [number, number, number];
  const frames = 6, duration = frames / 30;
  // A branching tube_set with blossom/leaf tips growing in, a vine drawing on by its reveal window, and a floor.
  const branches = (): Mesh3dTubeSetGeometryV1["polylines"] => {
    const lines: Mesh3dTubeSetGeometryV1["polylines"] = [{ points: [[0, -1, 0], [0, -.2, .05], [0, .3, 0]], radius: [.09, .07, .05], growthSpan: [0, .5] }];
    for (const [x, z] of [[.6, .2], [-.5, .3], [.1, -.6]] as const) lines.push({ points: [[0, .3, 0], [x * .5, .6, z * .5], [x, .75, z]] as V[], radius: [.05, .035, .02], growthSpan: [.5, .9] });
    return lines;
  };
  const tubes = (): Mesh3dObject[] => {
    const lines = branches();
    return [
      object("tree", { kind: "tube_set", polylines: lines, growth: 0, growthKeyframes: [{ time: duration, growth: 1, easing: "smooth" }], tipColors: { blossom: "#FFF0F6", leaf: "#5DB86E" },
        tips: lines.flatMap((_, i) => i ? [{ polylineIndex: i, at: "end", mesh: "petal", scale: .12, colorRole: "blossom", revealAt: .9 }, { polylineIndex: i, at: .5, mesh: "leaf", scale: .1, colorRole: "leaf", tilt: 50, revealAt: .6 }] : []) },
      { color: "#6B3A2A", roughness: .5, specular: { strength: .4, shininess: 30 } }),
      object("vine", { kind: "tube_set", radialSegments: 10, polylines: [{ points: Array.from({ length: 41 }, (_, i) => { const a = i / 40 * Math.PI * 3; return [Math.cos(a) * .9, -1 + i / 25, Math.sin(a) * .9] as V; }),
        radius: .03, reveal: [0, .1], revealKeyframes: [{ time: duration, reveal: [.2, 1], easing: "linear" }] }] }, { color: "#FF66AA", emissive: { color: "#FF66AA", strength: 1.2 } }),
      object("floor", { kind: "box", width: 4, height: .05, depth: 4 }, { color: "#3A2030" }, pose([0, -1.05, 0])),
    ];
  };
  const tubeScene = (objects: Mesh3dObject[]) => mesh3dSceneSchema.parse({ schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#14060E", gridColor: "#3050A0", spacing: 40, grid: false },
    light: { direction: [-.5, .9, .7], ambient: .3, intensity: .9, size: 6, shadow: { strength: .7, softness: 2, mapSize: 256 } },
    segments: [segment(frames, objects)], post: { ao: { strength: .6, radius: .3 }, bloom: { threshold: .7, strength: .6, radius: .05 } } });

  it("exports the same bytes on the calling thread and the pool, matches the preview's adapter frame by frame, and names tube_set in the receipt", async () => {
    const { root, project: p } = await project(frames, []);
    p.scene3d = tubeScene(tubes());
    expect(() => validateMesh3dProject(p)).not.toThrow();
    const run = async (name: string, engine: Mesh3dRenderEngineOptionsV1) => {
      const hashes: string[] = [], output = join(root, `${name}.mp4`);
      const receipt = await renderMesh3dVideo(p, output, fixtureOptions(root), { ...engine, onFrame: (_i, rgba) => hashes.push(createHash("sha256").update(rgba).digest("hex")) });
      expect(await encoded(output)).toEqual(hashes);
      return { receipt, hashes };
    };
    const serial = await run("serial", { threads: 1 }), pooled = await run("pool", {}), three = await run("pool-3", { threads: 3 });
    expect(pooled.hashes).toEqual(serial.hashes); expect(three.hashes).toEqual(serial.hashes);
    expect(new Set(serial.hashes).size).toBe(frames);
    // The preview renders through the same adapter (Mesh3dPreview: renderMesh3dProjectFrameV1 at the frame clock); at the export's raster size it is the export.
    const cache = new Mesh3dGeometryCache();
    for (let frame = 0; frame < frames; frame++) {
      const preview = renderMesh3dProjectFrameV1(p.scene3d!, { timelineFrame: frame, fps: 30 }, 72, 54, cache);
      expect(createHash("sha256").update(preview.rgba).digest("hex"), `frame ${frame}`).toEqual(serial.hashes[frame]);
    }
    expect(serial.receipt.executor).toBe(mesh3dShadingExecutorV1(p.scene3d!));
    const peak = p.scene3d!.segments[0].objects.filter(o => o.geometry.kind === "tube_set").reduce((n, o) => n + mesh3dTubeSetCountV1(mesh3dGeometryPeakV1(o.geometry) as Mesh3dTubeSetGeometryV1).triangles, 0);
    expect(serial.receipt.tubeSets).toEqual({ objects: 2, polylines: 5, tips: 6, maxTriangles: peak });
    expect(serial.receipt.maxTriangles).toBeLessThanOrEqual(peak + 12);
  }, 120_000);

  it("refuses tube sets whose triangles (tips included) or draws (tip colour roles) exceed the budget, before any decoder or encoder starts", async () => {
    const buds = (count: number, roles = 1) => object("buds", { kind: "tube_set", polylines: [{ points: [[0, -1, 0], [0, 1, 0]], radius: .05 }],
      tips: Array.from({ length: count }, (_, i) => ({ polylineIndex: 0, at: i / Math.max(1, count - 1), mesh: "sphere", scale: .02, colorRole: `r${i % roles}` })),
      tipColors: Object.fromEntries(Array.from({ length: roles }, (_, i) => [`r${i}`, "#FFFFFF"])) }, { color: "#FFFFFF" });
    const over = await project(2, []);
    over.project.scene3d = tubeScene([buds(2100)]);
    expect(() => validateMesh3dProject(over.project)).toThrow("管線三角形");
    await expect(renderMesh3dVideo(over.project, join(over.root, "over.mp4"), fixtureOptions(over.root))).rejects.toThrow("管線三角形");
    expect(spawned).toEqual([]);
    const draws = await project(2, []);
    draws.project.scene3d = tubeScene([...Array.from({ length: 126 }, (_, i) => object(`b${i}`, { kind: "box", width: .05, height: .05, depth: .05 }, { color: "#203040" }, pose([(i % 16) * .1 - .8, Math.floor(i / 16) * .1, 0]))), buds(8, 3)]);
    expect(MESH3D_SCENE_BUDGET_V1.objects).toBe(128);
    expect(() => validateMesh3dProject(draws.project)).toThrow("130 次繪製");
    const fits = await project(2, []);
    fits.project.scene3d = tubeScene([buds(1900)]);
    expect(() => validateMesh3dProject(fits.project)).not.toThrow();
  }, 60_000);
});

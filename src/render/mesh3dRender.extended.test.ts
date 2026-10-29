import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { EditProject } from "../domain/types";
import type { Mesh3dObject, Mesh3dScene } from "../motion/mesh3dScene";
import { mesh3dSceneTextFaceIdsV1 } from "../motion/mesh3dGeometry";
import { mesh3dDefaultThreadsV1 } from "../motion/mesh3dParallel";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { readMesh3dFaceV1 } from "./mesh3dFontSource";
import { MESH3D_MATERIAL_TEXTURE_MAX_PIXELS, mesh3dRenderTimeoutMsV1, mesh3dShadingReceiptV1, renderMesh3dVideo } from "./mesh3dRender";
import { withRenderProgress, type RenderProgressSnapshot } from "./renderProgress";

const app = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const platform = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const suffix = process.platform === "win32" ? ".exe" : "";
const ffmpegPath = join(app, `vendor/ffmpeg/${platform}/ffmpeg${suffix}`);
const ffprobePath = join(app, `vendor/ffmpeg/${platform}/ffprobe${suffix}`);
const fontRoot = join(app, "public/fonts");
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

type V = [number, number, number];
const object = (id: string, geometry: Mesh3dObject["geometry"], material: Partial<Mesh3dObject["material"]> = {}, position: V = [0, 0, 0]): Mesh3dObject =>
  ({ id, name: id, geometry, pose: { position, rotationDegrees: [0, 20, 0], scale: [1, 1, 1] }, keyframes: [], material: { color: "#E04080", unlit: false, ...material } });
function scene(objects: Mesh3dObject[], extra: Partial<Mesh3dScene> = {}, duration = 2 / 30): Mesh3dScene {
  return { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#101020", gridColor: "#303050", spacing: 72, grid: false },
    light: { direction: [-.5, .8, .9], ambient: .35, intensity: .8 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration, camera: { position: [0, .4, 4], target: [0, 0, 0], verticalFovDegrees: 50, near: .1, far: 30 }, cameraKeyframes: [], objects }], ...extra };
}
const extrude: Mesh3dObject["geometry"] = { kind: "text_extrude", text: "YOU", font: "display", weight: 900, size: .8, depth: .2, bevelSize: .02, bevelThickness: .03, bevelSegments: 2, tracking: 0 };
const band: Mesh3dObject["geometry"] = { kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: .9, height: .25, segments: 48, repeat: 2, tracking: .05 };

describe("mesh3d render integration of the engine extension", () => {
  it("reads any bundled face by compiled ID with its catalog SHA, and refuses unknown IDs before any I/O", async () => {
    const face = await readMesh3dFaceV1(fontRoot, "EditkinFace-noto-sans-tc-900");
    expect(face.sha256).toBe(bundledFontFaceSpec("EditkinFace-noto-sans-tc-900").sha256);
    expect(face.file).toBe(bundledFontFaceSpec("EditkinFace-noto-sans-tc-900").fontFile);
    expect(face.bytes.length).toBeGreaterThan(100_000);
    await expect(readMesh3dFaceV1("Z:/does-not-exist", "EditkinFace-made-up-400")).rejects.toThrow("Unknown bundled physical font face ID");
  });

  it("scales the default budget with frames and size, with a floor and a ceiling", () => {
    expect(mesh3dRenderTimeoutMsV1(0, 1920, 1080, 12)).toBe(120_000);
    // A 2 s S7-like export (60 frames at 1080x1920) measured 0.50 s a frame on 12 workers, 1.19 s on 3 and 3.14 s on the
    // calling thread: a pool job allows 120 s + 2 s a 1080p frame, a calling-thread job 120 s + 4 s.
    expect(mesh3dRenderTimeoutMsV1(60, 1080, 1920, 12)).toBe(120_000 + 120_000);
    expect(mesh3dRenderTimeoutMsV1(60, 1080, 1920, 1)).toBe(120_000 + 240_000);
    expect(mesh3dRenderTimeoutMsV1(300, 1920, 1080, 3)).toBe(120_000 + 600_000);
    expect(mesh3dRenderTimeoutMsV1(300, 960, 540, 3)).toBe(120_000 + 150_000);
    expect(mesh3dRenderTimeoutMsV1(300, 960, 540, 1)).toBe(120_000 + 300_000);
    expect(mesh3dRenderTimeoutMsV1(1_000_000, 3840, 2160, 12)).toBe(6 * 60 * 60_000);
    expect(mesh3dRenderTimeoutMsV1(300, 1920, 1080)).toBe(mesh3dRenderTimeoutMsV1(300, 1920, 1080, mesh3dDefaultThreadsV1()));
    expect(MESH3D_MATERIAL_TEXTURE_MAX_PIXELS).toBe(2048);
  });

  it("names the shading executor: unchanged strings for original scenes, v2 for per-pixel materials, glyph masks and post", () => {
    expect(mesh3dShadingReceiptV1(scene([object("box", { kind: "box", width: 1, height: 1, depth: 1 })]))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v1", lightingContract: "vertex-directional-plus-ambient/no-shadowmap/v1" });
    expect(mesh3dShadingReceiptV1(scene([object("text", extrude)]))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v1", lightingContract: "vertex-directional-plus-ambient/no-shadowmap/v1" });
    expect(mesh3dShadingReceiptV1(scene([object("band", band)]))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "vertex-plus-per-pixel-materials/no-shadowmap/v1" });
    expect(mesh3dShadingReceiptV1(scene([object("box", { kind: "box", width: 1, height: 1, depth: 1 }, { emissive: { color: "#FF00AA", strength: 1 } })]))).toMatchObject({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "vertex-plus-per-pixel-materials/no-shadowmap/v1" });
    expect(mesh3dShadingReceiptV1(scene([object("box", { kind: "box", width: 1, height: 1, depth: 1 })], { post: { vignette: { strength: .4, softness: .5 }, bloom: { threshold: 1, strength: .5, radius: .05 } } }))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "per-pixel-key-fill-hemisphere-specular/no-shadowmap/v1", post: ["bloom", "vignette"] });
  });

  it("describes shadow, AO and GGX sheen (area / sphere key) scenes truthfully", () => {
    const box: Mesh3dObject["geometry"] = { kind: "box", width: 1, height: 1, depth: 1 }, light: Mesh3dScene["light"] = { direction: [-.5, .8, .9], ambient: .35, intensity: .8 };
    // Soft key-light shadows: the per-pixel contract with a shadow map.
    expect(mesh3dShadingReceiptV1(scene([object("box", box)], { light: { ...light, shadow: { strength: .7, softness: 2 } } }))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "per-pixel-key-fill-hemisphere-specular/soft-shadowmap/v1" });
    // AO runs after the motion-blur average and before DOF / bloom / fisheye / vignette.
    expect(mesh3dShadingReceiptV1(scene([object("box", box)], { post: { vignette: { strength: .4, softness: .5 }, dof: { focusDistance: 4, aperture: .01 },
      ao: { strength: .8, radius: .4 }, motionBlur: { shutterSeconds: .02, samples: 2 } } }))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "per-pixel-key-fill-hemisphere-specular/no-shadowmap/v1", post: ["motionBlur", "ao", "dof", "vignette"] });
    // GGX sheen: material roughness alone shades that object per pixel; an area / sphere key makes the scene per pixel.
    expect(mesh3dShadingReceiptV1(scene([object("box", box, { roughness: .3, specular: { strength: 1, shininess: 60 } })]))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "vertex-plus-per-pixel-materials/no-shadowmap/v1", lightingFeatures: ["ggx-roughness"] });
    expect(mesh3dShadingReceiptV1(scene([object("box", box, { roughness: .3 })], { light: { ...light, size: 8, distance: 7, shadow: { strength: .5, softness: 3 } }, post: { ao: { strength: .5, radius: .3 } } }))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "per-pixel-key-fill-hemisphere-specular/soft-shadowmap/v1", post: ["ao"], lightingFeatures: ["ggx-roughness", "area-key", "sphere-key"] });
    // size 0 is a point-sized key (per-pixel scene, no area key).
    expect(mesh3dShadingReceiptV1(scene([object("box", box)], { light: { ...light, size: 0 } }))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "per-pixel-key-fill-hemisphere-specular/no-shadowmap/v1" });
    // A "front" UV mode shades its untextured faces per pixel; "atlas" / "repeat" keep the per-vertex path.
    expect(mesh3dShadingReceiptV1(scene([object("card", { ...box, depth: .01, uvMode: "front" })]))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v2", lightingContract: "vertex-plus-per-pixel-materials/no-shadowmap/v1" });
    expect(mesh3dShadingReceiptV1(scene([object("cube", { ...box, uvMode: "atlas" }), object("torus", { kind: "torus", radius: .5, tube: .1, segments: 16, tubeSegments: 12 })]))).toEqual({
      executor: "shared-cpu-triangle-zbuffer/v1", lightingContract: "vertex-directional-plus-ambient/no-shadowmap/v1" });
  });

  it.skipIf(!existsSync(ffmpegPath))("renders extruded and band text from verified faces, records them, and reports progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-mesh3d-extended-")); roots.push(root);
    const project: EditProject = createEmptyProject("Mesh extended", { id: "mesh-extended", width: 96, height: 64, fps: 30 });
    project.scene3d = scene([object("text", extrude, { specular: { strength: 1, shininess: 40 } }, [0, .3, 0]), object("band", band, {}, [0, -.4, 0])],
      { post: { vignette: { strength: .3, softness: .6 } } });
    const snapshots: RenderProgressSnapshot[] = [];
    const receipt = await withRenderProgress(snapshot => snapshots.push(snapshot), () =>
      renderMesh3dVideo(project, join(root, "mesh.mp4"), { ffmpegPath, ffprobePath, fontRoot }));
    expect(receipt.frameCount).toBe(2);
    expect(receipt.executor).toBe("shared-cpu-triangle-zbuffer/v2");
    expect(receipt.lightingContract).toBe("per-pixel-key-fill-hemisphere-specular/no-shadowmap/v1");
    expect(receipt.post).toEqual(["vignette"]);
    const faceIds = mesh3dSceneTextFaceIdsV1(project.scene3d);
    expect(faceIds).toHaveLength(2);
    expect(receipt.textFaces).toEqual(faceIds.map(faceId => {
      const spec = bundledFontFaceSpec(faceId); return { faceId, file: spec.fontFile, sha256: spec.sha256 };
    }));
    const scene3d = snapshots.filter(snapshot => snapshot.stage === "scene3d");
    expect(scene3d.at(-1)?.fraction).toBe(1);
    expect(scene3d.some(snapshot => snapshot.fraction !== undefined && snapshot.fraction < 1)).toBe(true);
    // Without a font root the faces are refused, never substituted.
    await expect(renderMesh3dVideo(project, join(root, "no-fonts.mp4"), { ffmpegPath, ffprobePath })).rejects.toThrow("開放字型目錄");
  }, 300_000);

  it.skipIf(!existsSync(ffmpegPath))("exports byte-identical frames (and files) on the worker pool and on the calling thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-mesh3d-pool-")); roots.push(root);
    const sha = (bytes: Uint8Array | Uint8ClampedArray) => createHash("sha256").update(bytes).digest("hex");
    const extended = scene([object("text", extrude, { specular: { strength: 1, shininess: 40 } }, [0, .3, 0]), object("band", band, {}, [0, -.4, 0])],
      { post: { vignette: { strength: .3, softness: .6 } } });
    const polish = scene([
      object("text", extrude, { roughness: .3, specular: { strength: 1, shininess: 60 }, gradient: { colors: ["#2B3C86", "#F2F5FF"], axis: "y" } }, [0, .3, 0]),
      object("ring", { kind: "torus", radius: .7, tube: .05, segments: 48, tubeSegments: 16 }, { emissive: { color: "#FF66AA", strength: 1 } }, [0, .3, 0]),
      object("band", band, { unlit: true, color: "#FFE0F0" }, [0, -.25, 0]),
      object("floor", { kind: "box", width: 6, height: .05, depth: 6 }, { color: "#5A1230", grid: true, gridStyle: { cells: 12, lineWidthPx: 1.5, color: "#C8467E", fade: { start: 3, end: 9 } } }, [0, -.6, 0]),
    ], { light: { direction: [-.5, .8, .9], ambient: .3, intensity: .9, size: 8, distance: 7, shadow: { strength: .7, softness: 3, mapSize: 512 } },
      post: { ao: { strength: .7, radius: .3 }, bloom: { threshold: .8, strength: .6, radius: .05 }, motionBlur: { shutterSeconds: .02, samples: 3 } } }, 3 / 30);
    polish.segments[0].camera.roll = -4;
    for (const [name, scene3d] of [["extended", extended], ["polish", polish]] as const) {
      const project: EditProject = createEmptyProject(`Mesh ${name}`, { id: `mesh-${name}`, width: 96, height: 64, fps: 30 });
      project.scene3d = scene3d;
      const frames: Record<string, string[]> = {}, files: Record<string, string> = {};
      for (const [mode, threads] of [["serial", 1], ["pool", undefined], ["pool-3", 3]] as const) {
        const hashes: string[] = [], output = join(root, `${name}-${mode}.mp4`);
        const receipt = await renderMesh3dVideo(project, output, { ffmpegPath, ffprobePath, fontRoot },
          { ...(threads === undefined ? {} : { threads }), onFrame: (_index, rgba) => hashes.push(sha(rgba)) });
        expect(receipt.frameCount).toBe(hashes.length);
        if (mode === "serial") expect(receipt.parallel).toEqual({ workers: 0, poolFrames: 0 });
        if (mode === "pool-3") expect(receipt.parallel).toEqual({ workers: 3, poolFrames: hashes.length });
        frames[mode] = hashes; files[mode] = sha(await readFile(output));
      }
      expect(frames.serial.length, name).toBeGreaterThan(1);
      expect(frames.pool, `${name}: default pool`).toEqual(frames.serial);
      expect(frames["pool-3"], `${name}: 3 workers`).toEqual(frames.serial);
      expect([files.pool, files["pool-3"]], `${name}: encoded files`).toEqual([files.serial, files.serial]);
    }
  }, 300_000);
});

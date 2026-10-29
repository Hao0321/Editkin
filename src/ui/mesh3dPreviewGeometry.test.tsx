import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { Mesh3dGeometryCache, parseMesh3dFont } from "../motion/mesh3dGeometry";
import type { Mesh3dObject, Mesh3dScene } from "../motion/mesh3dScene";
import { mesh3dShadingReceiptV1 } from "../render/mesh3dRender";
import { mesh3dShadingExecutorV1 } from "../render/mesh3dShadingExecutorV1";
import { resolveBundledFontFace } from "../typography/fontFaces";
import Mesh3dPreview from "./Mesh3dPreview";
import { loadMesh3dPreviewFaceV1, loadMesh3dPreviewGeometryV1, mesh3dPreviewFontPlanV1 } from "./mesh3dPreviewGeometryV1";

const app = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const faceBytes = (faceId: string) => new Uint8Array(readFileSync(join(app, "public/fonts/render", `${faceId}.ttf`)));
const notoWeight = async (weight: number) => {
  const bytes = readFileSync(join(app, "public/fonts", resolveBundledFontFace("Noto Sans TC", weight)!.fontFile));
  return parseMesh3dFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

type V = [number, number, number];
const object = (id: string, geometry: Mesh3dObject["geometry"], material: Partial<Mesh3dObject["material"]> = {}, position: V = [0, 0, 0]): Mesh3dObject =>
  ({ id, name: id, geometry, pose: { position, rotationDegrees: [0, 20, 0], scale: [1, 1, 1] }, keyframes: [], material: { color: "#E04080", unlit: false, ...material } });
function scene(objects: Mesh3dObject[], extra: Partial<Mesh3dScene> = {}): Mesh3dScene {
  return { schema: "editkin.mesh-scene/v1", enabled: true, background: { color: "#101020", gridColor: "#303050", spacing: 72, grid: false },
    light: { direction: [-.5, .8, .9], ambient: .35, intensity: .8 },
    segments: [{ id: "s", name: "s", timelineStart: 0, duration: 1, camera: { position: [0, .4, 4], target: [0, 0, 0], verticalFovDegrees: 50, near: .1, far: 30 }, cameraKeyframes: [], objects }], ...extra };
}
const extrude: Mesh3dObject["geometry"] = { kind: "text_extrude", text: "YOU", font: "display", weight: 900, size: .8, depth: .2, bevelSize: .02, bevelThickness: .03, bevelSegments: 2, tracking: 0 };
const band: Mesh3dObject["geometry"] = { kind: "band_text", text: "SOMEONE", font: "latin", weight: 400, form: "cylinder", facing: "outside", radius: .9, height: .25, segments: 48, repeat: 2, tracking: .05 };
const legacy: Mesh3dObject["geometry"] = { kind: "text", text: "3D", fontFamily: "Noto Sans TC", fontWeight: 900, height: .5, depth: .1, bevel: 0 };
const box: Mesh3dObject["geometry"] = { kind: "box", width: 1, height: 1, depth: 1 };
const mixed = () => scene([object("legacy", legacy), object("extrude", extrude, {}, [0, 1, 0]), object("band", band, {}, [0, -1, 0])]);

afterEach(() => { vi.unstubAllGlobals(); });

describe("mesh 3D preview loads the text faces of text_extrude and band_text", () => {
  it("plans Noto weights and bundled face IDs, and reports an unavailable face instead of throwing", () => {
    expect(mesh3dPreviewFontPlanV1(mixed())).toEqual({ weights: [900], faceIds: ["EditkinFace-bebas-neue-400", "EditkinFace-noto-sans-tc-900"] });
    expect(mesh3dPreviewFontPlanV1(scene([object("box", box)]))).toEqual({ weights: [], faceIds: [] });
    const missing = mesh3dPreviewFontPlanV1(scene([object("x", { ...band, weight: 700 } as Mesh3dObject["geometry"])]));
    expect(missing.faceIds).toEqual([]);
    expect(missing.error).toMatch(/MESH_TEXT_FACE_UNAVAILABLE/);
    return expect(loadMesh3dPreviewGeometryV1(missing, { weight: notoWeight })).rejects.toThrow(/MESH_TEXT_FACE_UNAVAILABLE/);
  });

  it("verifies each face's SHA-256 against the compiled catalog before parsing it", async () => {
    const parsed = await loadMesh3dPreviewFaceV1("EditkinFace-bebas-neue-400", async id => faceBytes(id));
    expect(parsed.unitsPerEm).toBeGreaterThan(0);
    const tampered = faceBytes("EditkinFace-bebas-neue-400"); tampered[tampered.length - 1] ^= 1;
    await expect(loadMesh3dPreviewFaceV1("EditkinFace-bebas-neue-400", async () => tampered)).rejects.toThrow(/SHA/);
    const load = vi.fn(async (id: string) => faceBytes(id));
    await expect(loadMesh3dPreviewFaceV1("EditkinFace-made-up-400", load)).rejects.toThrow("Unknown bundled physical font face ID");
    expect(load).not.toHaveBeenCalled();
  });

  it("builds text_extrude, band_text and legacy text geometry from the loaded fonts (the former weight-only cache could not)", async () => {
    const plan = mesh3dPreviewFontPlanV1(mixed());
    const cache = await loadMesh3dPreviewGeometryV1(plan, { weight: notoWeight, face: id => loadMesh3dPreviewFaceV1(id, async faceId => faceBytes(faceId)) });
    for (const geometry of [extrude, band, legacy]) expect(cache.get(geometry).indices.length / 3, geometry.kind).toBeGreaterThan(10);
    const former = new Mesh3dGeometryCache(new Map([[900, await notoWeight(900)]]));
    expect(() => former.get(extrude)).toThrow();
  });

  it("reads faces through the desktop's bundled font IPC by default", async () => {
    const readBundledFontFace = vi.fn(async (faceId: string) => faceBytes(faceId));
    vi.stubGlobal("window", { haoDesktop: { isDesktop: true, readBundledFontFace } });
    const cache = await loadMesh3dPreviewGeometryV1({ weights: [], faceIds: ["EditkinFace-bebas-neue-400"] }, { weight: notoWeight });
    expect(readBundledFontFace).toHaveBeenCalledWith("EditkinFace-bebas-neue-400");
    expect(cache.get(band).indices.length).toBeGreaterThan(0);
  });

  it("data-executor follows the scene's shading executor (same as the render receipt), not a fixed v1", () => {
    const scenes = [scene([object("box", box)]), scene([object("text", extrude)]), scene([object("band", band)]),
      scene([object("box", box, { emissive: { color: "#FF00AA", strength: 1 } })]), scene([object("box", box)], { post: { vignette: { strength: .4, softness: .5 } } }),
      scene([object("box", { ...box, uvMode: "front" } as Mesh3dObject["geometry"])])];
    expect(scenes.map(mesh3dShadingExecutorV1)).toEqual(scenes.map(item => mesh3dShadingReceiptV1(item).executor));
    expect(new Set(scenes.map(mesh3dShadingExecutorV1))).toEqual(new Set(["shared-cpu-triangle-zbuffer/v1", "shared-cpu-triangle-zbuffer/v2"]));
    vi.stubGlobal("document", { createElement: () => ({}) });
    for (const item of [scene([object("box", box)]), mixed()]) {
      const project = createEmptyProject("Mesh preview", { id: "mesh-preview", width: 320, height: 180, fps: 30 });
      project.scene3d = item;
      const html = renderToStaticMarkup(<Mesh3dPreview project={project} playhead={0} playing={false} layers={[]} />);
      expect(html).toContain(`data-executor="${mesh3dShadingReceiptV1(item).executor}"`);
    }
  });
});

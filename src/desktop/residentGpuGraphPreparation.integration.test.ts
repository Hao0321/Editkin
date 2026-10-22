import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { floatingVideoFramePresetV2 } from "../motion/floatingVideoFrame";
import * as floating from "../render/nativeFloatingVideoFrame";
import { buildGpuEngineVideoPreviewGraph } from "../render/gpuCompositor";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { acquireResidentGpuGraphPreparation, prepareResidentGpuGraphs } from "./residentGpuGraphPreparation";
import { RetiredGpuPreview } from "./residentGpuPreviewGeneration";
import { expectedEngineVideoLayers } from "./residentGpuPreviewExpectations";
import { presentResidentEngineVideo, type EngineVideoPreviewContext } from "./residentGpuEngineVideoPresenter";
import type { GpuPreviewApi } from "./gpuPreviewApiTypes";

function fixture() {
  const project = createDemoProject();
  project.width = 640; project.height = 360; project.fps = 30;
  project.captions = []; project.motionGraphics = [];
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  Object.assign(project.assets[0], { uri: "D:/synthetic-controls/product-entry-original.mp4", width: 960, height: 540,
    displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } });
  const clip = project.tracks[0].clips[0];
  Object.assign(clip, { timelineStart: 0, sourceStart: 0, duration: 4, volume: 0,
    floatingFrame: floatingVideoFramePresetV2("matte") });
  return { project, clip };
}

function addDisplayTitle(project: ReturnType<typeof fixture>["project"]) {
  const graphic = createMotionGraphic("actual-entry-title", "title", "FLOAT", .5, 2, undefined,
    findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48, x: .1, y: .1, width: .7,
    backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0, letterSpacing: 0, visualStyle: "native_paint" });
  graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4, widthMode: "fit_content", align: "left" };
  graphic.paintV1 = { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr",
    fill: { kind: "solid", color: "#175CD3" }, clips: [] };
  project.motionGraphics = [graphic];
  return graphic;
}

// The FontFace host is controlled, but readFace supplies the exact bundled
// physical bytes. No glyph run, native frame or runtime receipt is fabricated.
function fontEnvironment(readFace: (faceId: string) => Promise<Uint8Array>) {
  const members = new Set<FontFace>();
  const fonts = { add: (face: FontFace) => { members.add(face); return fonts; },
    delete: (face: FontFace) => members.delete(face), has: (face: FontFace) => members.has(face) };
  class BinaryFace {
    family: string; weight: string; status: FontFaceLoadStatus = "unloaded";
    constructor(family: string, _bytes: ArrayBuffer, descriptor?: FontFaceDescriptors) {
      this.family = family; this.weight = descriptor!.weight!;
    }
    async load() { this.status = "loaded"; return this as unknown as FontFace; }
  }
  return { members, fontDelivery: { document: { fonts } as unknown as Pick<Document, "fonts">,
    FontFaceConstructor: BinaryFace as unknown as typeof FontFace, readFace } };
}
async function bundledBytes(faceId: string) {
  return new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)));
}
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
afterEach(() => vi.restoreAllMocks());

describe("actual desktop resident floating/paint preparation entry (source controls, not native runtime evidence)", () => {
  it("preserves ordinary legacy preparation without preparing a floating owner", async () => {
    const project = createDemoProject(), factory = vi.spyOn(floating, "prepareNativeFloatingVideoFrames");
    project.width = 960; project.height = 540; project.assets[0].uri = "D:/synthetic-controls/legacy.mp4";
    const before = JSON.stringify(project), prepared = prepareResidentGpuGraphs(project);
    expect(prepared.video).toEqual(buildGpuEngineVideoPreviewGraph(project, 0));
    const lease = acquireResidentGpuGraphPreparation(project);
    try { expect(await lease.ready).toEqual(prepared); expect(factory).not.toHaveBeenCalled(); }
    finally { lease.dispose(); }
    expect(JSON.stringify(project)).toBe(before);
  });

  it("prepares one actual floating owner in the lease and retains original coded dimensions", async () => {
    const { project, clip } = fixture(), before = JSON.stringify(project);
    const factory = vi.spyOn(floating, "prepareNativeFloatingVideoFrames");
    const lease = acquireResidentGpuGraphPreparation(project);
    try {
      const prepared = await lease.ready;
      expect(factory).toHaveBeenCalledTimes(1); expect(prepared.image).toBeUndefined();
      expect(prepared.nativeSurfaceSafe).toBe(true); expect(lease.isActive()).toBe(true);
      expect(prepared.video!.assetBindings[clip.assetId]).toBe(project.assets[0].uri);
      expect(prepared.video!.decoderDimensions[clip.assetId]).toEqual({ width: 960, height: 540, source: "original" });
      expect(prepared.video!.graph.nodes.filter(node => node.kind === "floating_video_frame_2d")).toHaveLength(1);
      expect(prepared.video!.graph.nodes.find(node => node.kind === "floating_video_frame_2d")!.spec)
        .toMatchObject({ source: { width: 960, height: 540, displayAspectRatio: 16 / 9 },
          timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 120 } });
      expect(expectedEngineVideoLayers(prepared.video!.graph)).toMatchObject([{ floatingNodeId: `floating-frame:${clip.id}`,
        floatingFrame: { source: { width: 960, height: 540 } } }]);
    } finally { lease.dispose(); }
    expect(lease.isActive()).toBe(false); expect(JSON.stringify(project)).toBe(before);
  });

  it("carries the same owner across real physical title delivery and preserves display paint order", async () => {
    const { project, clip } = fixture(), graphic = addDisplayTitle(project), env = fontEnvironment(bundledBytes);
    const factory = vi.spyOn(floating, "prepareNativeFloatingVideoFrames");
    const lease = acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery });
    try {
      const prepared = await lease.ready, graph = prepared.video!.graph;
      expect(factory).toHaveBeenCalledTimes(1); expect(prepared.nativeSurfaceSafe).toBe(true);
      expect(env.members.size).toBe(1); expect(lease.isActive()).toBe(true);
      const paint = graph.nodes.find(node => node.kind === "native_motion_paint")!;
      expect(paint.graphicId).toBe(graphic.id);
      const track = paint.track as import("../motion/nativeMotionPaint").NativeMotionPaintTrack;
      expect(track.scene.layers.length).toBeGreaterThan(0);
      expect(track.scene.layers.every(layer => layer.path.commands[0].type === "M"
        && layer.path.commands.at(-1)!.type === "Z")).toBe(true);
      const display = graph.nodes.find(node => node.id === "display:aces2")!;
      expect(display.inputs).toEqual([`transform:${clip.id}`]);
      const output = graph.nodes.find(node => node.id === graph.outputNode)!;
      expect(graph.nodes.find(node => node.id === output.inputs[0])!.inputs)
        .toEqual([display.id, `motion-graphic:${graphic.id}`]);
      expect(expectedEngineVideoLayers(graph)).toHaveLength(1);
    } finally { lease.dispose(); }
    expect(env.members.size).toBe(0); expect(lease.isActive()).toBe(false);
  });

  it("rejects rotated/non-square metadata at the actual caller without exposing a legacy graph", async () => {
    const { project } = fixture(); project.assets[0].displayAspectRatio = 9 / 16;
    expect(() => prepareResidentGpuGraphs(project)).toThrow(/rotated or non-square-pixel/);
    const lease = acquireResidentGpuGraphPreparation(project);
    await expect(lease.ready).rejects.toThrow(/rotated or non-square-pixel/);
    expect(lease.isActive()).toBe(false);
  });

  it("rejects floating media used as an affine parent at the actual caller", async () => {
    const { project, clip } = fixture();
    project.tracks[0].clips.push({ ...structuredClone(clip), id: "child", floatingFrame: undefined,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
      layer: { enabled: true, blendMode: "normal", parentClipId: clip.id } });
    const before = JSON.stringify(project), lease = acquireResidentGpuGraphPreparation(project);
    await expect(lease.ready).rejects.toThrow(/affine parent/);
    expect(lease.isActive()).toBe(false); expect(JSON.stringify(project)).toBe(before);
  });

  it("makes stale prepared source identity and unsupported mixed effects visible failures", () => {
    const { project } = fixture(), handle = floating.prepareNativeFloatingVideoFrames(project);
    project.assets[0].uri = "D:/synthetic-controls/different-owner.mp4";
    expect(() => prepareResidentGpuGraphs(project, undefined, handle)).toThrow(/factory-owned/);
    const mixed = fixture().project; mixed.tracks[0].clips[0].creative = { effectPresetIds: ["mono_halftone"] };
    expect(() => prepareResidentGpuGraphs(mixed)).toThrow(/unknown mixed execution/);
  });

  it("retires a floating/font owner changed during delivery before it can publish a graph", async () => {
    const { project } = fixture(); addDisplayTitle(project);
    let deliver!: (bytes: Uint8Array) => void;
    const pending = new Promise<Uint8Array>(resolveBytes => { deliver = resolveBytes; });
    const env = fontEnvironment(async () => pending), factory = vi.spyOn(floating, "prepareNativeFloatingVideoFrames");
    const lease = acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery });
    const rejected = expect(lease.ready).rejects.toBeInstanceOf(RetiredGpuPreview);
    await flush(); expect(factory).toHaveBeenCalledTimes(1); project.revision++;
    deliver(await bundledBytes("EditkinFace-bebas-neue-400")); await rejected;
    expect(lease.isActive()).toBe(false); expect(env.members.size).toBe(0);
  });

  it("refuses a legacy resident API before issuing load for the new floating node", async () => {
    const { project } = fixture(), lease = acquireResidentGpuGraphPreparation(project);
    try {
      const preview = (await lease.ready).video!, load = vi.fn();
      const ref = <T,>(current: T) => ({ current });
      const context: EngineVideoPreviewContext = {
        next: { kind: "engine-video", preview, token: 1, fps: 30, nativeBounds: { x: 0, y: 0, width: 640, height: 360, revision: 1 } },
        desktop: { loadGpuEngineVideoPreviewSession: load } as unknown as GpuPreviewApi,
        imageSessionRef: ref("image"), videoSessionRef: ref("video"), engineVideoSessionRef: ref("engine-video"),
        loadedImageStructureRef: ref(undefined), loadedVideoStructureRef: ref(undefined), loadedEngineVideoStructureRef: ref(undefined),
        surfaceBoundsKeyRef: ref(undefined), surfaceColorSpaceRef: ref(undefined), surfaceBoundRef: ref(false), tokenRef: ref(1),
        releaseSurface: async () => {}, setFrameUrl: vi.fn(), setNativeSurfaceActive: vi.fn(), setFallbackReason: vi.fn(),
      };
      await expect(presentResidentEngineVideo(context)).rejects.toThrow(/能力讀回/);
      expect(load).not.toHaveBeenCalled(); expect(context.setNativeSurfaceActive).not.toHaveBeenCalled();
      // This is an explicit old ready shape negative control, not current
      // runtime evidence or a fabricated success receipt.
      context.desktop.gpuEngineStatus = async () => ({ available: true,
        ready: { event: "ready", engine: "editkin-wgpu-resident-engine/v1", generation: 1, adapter: "legacy-control", backend: "Dx12", deviceType: "DiscreteGpu" },
        status: { engine: "editkin-wgpu-resident-engine/v1", generation: 1, residentSessions: 0, adapter: "legacy-control", backend: "Dx12", deviceType: "DiscreteGpu" } });
      await expect(presentResidentEngineVideo(context)).rejects.toThrow(/matching native runtime/);
      expect(load).not.toHaveBeenCalled(); expect(context.loadedEngineVideoStructureRef.current).toBeUndefined();
    } finally { lease.dispose(); }
  });
});

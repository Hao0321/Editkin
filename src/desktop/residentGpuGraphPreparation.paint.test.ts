import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import * as nativePaint from "../motion/nativeMotionPaint";
import { acquireResidentGpuGraphPreparation, prepareResidentGpuGraphs, sampleResidentGpuGraph } from "./residentGpuGraphPreparation";
import { RetiredGpuPreview } from "./residentGpuPreviewGeneration";
import { presentResidentEngineVideo, validateResidentEngineVideoFrame, type EngineVideoPreviewContext } from "./residentGpuEngineVideoPresenter";
import { engineVideoResourcePlanMatches } from "./residentGpuPreviewResources";
import { estimateGpuEngineVideoResources } from "../render/gpuCompositor";
import type { GpuEngineVideoPresentedFrame } from "./gpuFrameTypes";
import type { GpuPreviewApi } from "./gpuPreviewApiTypes";

const faceId = "EditkinFace-bebas-neue-400";
const bytes = readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function fixture() {
  const project = createDemoProject(); project.width = 640; project.height = 360; project.fps = 30;
  project.assets[0].uri = "C:/fixtures/physical-paint-source.mp4"; project.assets[0].width = 640; project.assets[0].height = 360;
  project.tracks[0].clips[0].duration = 4; project.tracks[0].clips[0].volume = 0;
  project.colorManagement = { ...project.colorManagement!, mode: "aces2", outputTransform: "rec709_sdr" };
  const graphic = createMotionGraphic("paint-title", "title", "AV\nO", .5, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  Object.assign(graphic, { fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 48, backgroundColor: "#00000000", shadowDepth: 0,
    outlineWidth: 0, x: .1, y: .1, width: .7, letterSpacing: 0, visualStyle: "native_paint" });
  graphic.layoutV2 = { ...graphic.layoutV2!, minFontSize: 48, maxLines: 4, widthMode: "fit_content", align: "left" };
  graphic.motionV2!.sequence.unit = "character";
  graphic.paintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
    stops: [{ at: 0, color: "#175CD380" }, { at: 1, color: "#A9E9F7" }] }, clips: [] };
  project.motionGraphics = [graphic]; return { project, graphic };
}
function environment(read: (_face: string) => Promise<Uint8Array> = async (_face: string) => new Uint8Array(await bytes)) {
  const members = new Set<FontFace>();
  const fonts = { add: vi.fn((face: FontFace) => { members.add(face); return fonts; }),
    delete: vi.fn((face: FontFace) => members.delete(face)), has: vi.fn((face: FontFace) => members.has(face)) };
  class BinaryFace {
    family: string; weight: string; status: FontFaceLoadStatus = "unloaded";
    constructor(family: string, _bytes: ArrayBuffer, descriptor?: FontFaceDescriptors) { this.family = family; this.weight = descriptor!.weight!; }
    async load() { this.status = "loaded"; return this as unknown as FontFace; }
  }
  const readFace = vi.fn(read);
  return { fonts, members, readFace, fontDelivery: { document: { fonts } as unknown as Pick<Document, "fonts">,
    FontFaceConstructor: BinaryFace as unknown as typeof FontFace, readFace } };
}
afterEach(() => vi.restoreAllMocks());

describe("desktop resident verified font producer (real font bytes; controlled FontFace, no native runtime proof)", () => {
  it("uses the same numeric native graph for a typed panel and requests no dummy font", async () => {
    const { project, graphic } = fixture(), env = environment();
    graphic.text = "";
    graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 };
    graphic.motionV2!.sequence = { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 };
    graphic.paintV1!.stroke = { widthPixels: 1, color: "#C6DFFF80" };
    graphic.paintV1!.shadow = { blurPixels: 8, offsetXPixels: 0, offsetYPixels: 6, color: "#00000040" };
    const lease = acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery });
    try {
      const prepared = await lease.ready;
      expect(prepared.nativeSurfaceSafe).toBe(true); expect(env.readFace).not.toHaveBeenCalled();
      const track = prepared.video!.graph.nodes.find(node => node.kind === "native_motion_paint")!.track as nativePaint.NativeMotionPaintTrack;
      expect(track.scene.layers).toHaveLength(1);
      expect(track.scene.layers[0].shadow!.blur).toBe(8);
      expect(track.frames).toHaveLength(90); expect(lease.isActive()).toBe(true);
    } finally { lease.dispose(); }
    expect(lease.isActive()).toBe(false); expect(env.members.size).toBe(0);
  });
  it("delivers real multiline numeric paint to the common graph and retains its font lease across frames", async () => {
    const { project, graphic } = fixture(), env = environment(), compile = vi.spyOn(nativePaint, "prepareNativeMotionPaint");
    const lease = acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery });
    try {
      const prepared = await lease.ready;
      expect(prepared.image).toBeUndefined(); expect(prepared.nativeSurfaceSafe).toBe(true); expect(prepared.video).toBeDefined();
      expect(compile).toHaveBeenCalledTimes(1); expect(env.readFace).toHaveBeenCalledExactlyOnceWith(faceId);
      const node = prepared.video!.graph.nodes.find(node => node.kind === "native_motion_paint")!;
      const track = node.track as nativePaint.NativeMotionPaintTrack;
      expect(node.graphicId).toBe(graphic.id); expect(track.scene.layers).toHaveLength(3);
      expect(track.scene.layers.every(layer => layer.path.commands[0].type === "M" && layer.path.commands.at(-1)!.type === "Z")).toBe(true);
      expect(track.frames).toHaveLength(90);
      for (const time of [.5, .6, 1, 2.9, 3.49]) expect(sampleResidentGpuGraph(prepared.video, time)!.graph).toBe(prepared.video!.graph);
      expect(env.members.size).toBe(1); expect(lease.isActive()).toBe(true); expect(env.fonts.delete).not.toHaveBeenCalled();
    } finally { lease.dispose(); }
    expect(env.members.size).toBe(0); expect(lease.isActive()).toBe(false); expect(env.fonts.delete).toHaveBeenCalledTimes(1);
  });
  it("abort during font IPC prevents a late registration, factory compile and graph", async () => {
    const pending = deferred<Uint8Array>(), env = environment(() => pending.promise), controller = new AbortController();
    const compile = vi.spyOn(nativePaint, "prepareNativeMotionPaint"), lease = acquireResidentGpuGraphPreparation(fixture().project,
      { signal: controller.signal, fontDelivery: env.fontDelivery });
    const rejected = expect(lease.ready).rejects.toBeInstanceOf(RetiredGpuPreview);
    await flush(); expect(env.readFace).toHaveBeenCalledTimes(1); controller.abort(); await rejected;
    pending.resolve(new Uint8Array(await bytes)); await flush();
    expect(compile).not.toHaveBeenCalled(); expect(env.fonts.add).not.toHaveBeenCalled(); expect(lease.isActive()).toBe(false);
  });
  it("project generation change before delivery cannot publish an old graph and releases its exact face", async () => {
    const pending = deferred<Uint8Array>(), env = environment(() => pending.promise), { project } = fixture();
    const compile = vi.spyOn(nativePaint, "prepareNativeMotionPaint"), lease = acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery });
    const rejected = expect(lease.ready).rejects.toBeInstanceOf(RetiredGpuPreview);
    await flush(); project.revision++; pending.resolve(new Uint8Array(await bytes)); await rejected;
    expect(compile).not.toHaveBeenCalled(); expect(env.members.size).toBe(0); expect(lease.isActive()).toBe(false);
  });
  it("rejects damaged verified bytes and unsupported encoded paint without exposing an admitted fallback", async () => {
    const damaged = environment(async () => new Uint8Array(64));
    await expect(acquireResidentGpuGraphPreparation(fixture().project, { fontDelivery: damaged.fontDelivery }).ready).rejects.toThrow();
    expect(damaged.members.size).toBe(0);
    const { project } = fixture(); project.colorManagement = undefined;
    expect(prepareResidentGpuGraphs(project).video).toBeUndefined();
    const env = environment(); await expect(acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery }).ready).rejects.toThrow(/covered-video/);
    expect(env.members.size).toBe(0);
  });
  it("keeps the ordinary synchronous graph unchanged and performs no font delivery", async () => {
    const project = createDemoProject(), env = environment(), sync = prepareResidentGpuGraphs(project);
    const lease = acquireResidentGpuGraphPreparation(project, { fontDelivery: env.fontDelivery });
    expect(await lease.ready).toEqual(sync); expect(env.readFace).not.toHaveBeenCalled(); lease.dispose();
  });
  it("requires native initial resource receipts even before entry, and prepares a fresh receipt owner on reload", async () => {
    const env = environment(), lease = acquireResidentGpuGraphPreparation(fixture().project, { fontDelivery: env.fontDelivery });
    try {
      const prepared = await lease.ready, preview = prepared.video!, count = 1;
      const base = { captionCount: 0, captionTextureUploads: 0, captions: [], activeCaptions: [], motionGraphicCount: 0, motionGraphicTextureUploads: 0,
        motionGraphics: [], activeMotionGraphics: [], particleCount: 0, particleTexturesResident: 0, adjustmentCount: 0, adjustments: [],
        controllerCount: 0, controllers: [], layers: [], visualLayers: [], resourcePlan: {}, decodeSchedule: {},
        engineGraph: { directExecution: true, blockedNodeIds: [], ignoredNodeIds: [], executedNodeIds: preview.graph.nodes.map(node => node.id) } };
      let includePaint = false;
      const paint = preview.graph.nodes.find(node => node.kind === "native_motion_paint")!;
      const colorBinding = { nodeId: paint.id, graphicId: paint.graphicId,
        sourceSignatureSha256: createHash("sha256").update((paint.track as nativePaint.NativeMotionPaintTrack).sourceSignature).digest("hex"),
        colorIntent: "scene_linear_rec709", compositionBoundary: "before_aces2", overlayOrder: 0 };
      const load = vi.fn(async () => ({ ...base, ...(includePaint ? { nativeMotionPaintCount: count, nativeMotionPaintResidentTextureCount: count,
        nativeMotionPaintTextureUploads: count, nativeMotionPaintInitialRasterCount: count,
        nativeMotionPaintInitialCpuUploadBytes: count * preview.graph.width * preview.graph.height * 8, activeNativeMotionPaints: [],
        nativeMotionPaintColorBindings: [colorBinding] } : {}) }));
      const ref = <T,>(current: T) => ({ current });
      const context: EngineVideoPreviewContext = { next: { kind: "engine-video", preview, token: 1, fps: 30, nativeBounds: { x: 0, y: 0, width: 640, height: 360, revision: 1 } },
        desktop: { loadGpuEngineVideoPreviewSession: load } as unknown as GpuPreviewApi,
        imageSessionRef: ref("image"), videoSessionRef: ref("video"), engineVideoSessionRef: ref("engine-video"),
        loadedImageStructureRef: ref(undefined), loadedVideoStructureRef: ref(undefined), loadedEngineVideoStructureRef: ref(undefined),
        surfaceBoundsKeyRef: ref(undefined), surfaceColorSpaceRef: ref(undefined), surfaceBoundRef: ref(false), tokenRef: ref(1),
        releaseSurface: async () => {}, setFrameUrl: vi.fn(), setNativeSurfaceActive: vi.fn(), setFallbackReason: vi.fn() };
      await expect(presentResidentEngineVideo(context)).rejects.toThrow(/all initial resources\/uploads/);
      expect(context.loadedEngineVideoStructureRef.current).toBe(`engine-video:${preview.structureKey}`);
      includePaint = true;
      // Both reloads pass the real paint validator and then stop at deliberately
      // absent video-layer receipts. This is a source control, not GPU evidence.
      for (let reload = 0; reload < 2; reload++) {
        context.loadedEngineVideoStructureRef.current = undefined;
        await expect(presentResidentEngineVideo(context)).rejects.toThrow(/共同影片 Engine Graph.*layers/);
      }
      expect(load).toHaveBeenCalledTimes(3); expect(context.setNativeSurfaceActive).not.toHaveBeenCalled();
    } finally { lease.dispose(); }
  });
  it("rejects paint frames without their loaded receipt owner and checks every native allocation field", async () => {
    const env = environment(), lease = acquireResidentGpuGraphPreparation(fixture().project, { fontDelivery: env.fontDelivery });
    try {
      const { video } = await lease.ready, preview = video!;
      const absentOwner = { endOfStream: false, receipt: { timelineFrame: 0, engineGraph: { directExecution: true, blockedNodeIds: [], ignoredNodeIds: [],
        executedNodeIds: preview.graph.nodes.map(node => node.id) } } } as unknown as GpuEngineVideoPresentedFrame;
      expect(() => validateResidentEngineVideoFrame(preview, absentOwner)).toThrow(/此 session/);
      const expected = estimateGpuEngineVideoResources(640, 360, preview.graph.cacheBudgetMb, 1, 1, 0, 0, 0, 0, 8, 0, 0, 1)!;
      const plan = { ...expected, sceneDepthAttachmentCount: 0 as const, depthOfFieldPassCount: 0 as const,
        depthOfFieldAdditionalWorkingBytes: 0 as const, width: 640, height: 360,
        videoLayerCount: 1, overlayCount: 1, remainingBytes: expected.budgetBytes - expected.requiredBytes };
      const matches = (candidate: typeof plan) => engineVideoResourcePlanMatches(candidate, preview.graph, 1, 1, 0, 0, 0);
      expect(matches(plan)).toBe(true);
      for (const field of ["nativePaintCount", "nativePaintCpuBytes", "nativePaintStagingBytes", "nativePaintGeometryBytes"] as const) {
        expect(matches({ ...plan, [field]: plan[field] - 1 })).toBe(false);
      }
    } finally { lease.dispose(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { prepareResidentGpuGraphs } from "./residentGpuGraphPreparation";
import { boundsKey } from "./residentGpuPreviewReceipts";
import { presentResidentEngineVideo, type EngineVideoPreviewContext } from "./residentGpuEngineVideoPresenter";
import type { GpuNativePreviewSurface } from "./nativePreviewTypes";

// Real graph and dispatcher, controlled native boundary. No pixel/GUI evidence.
describe("superseded resident native dispatch preserves the latest queue", () => {
  function fixture() {
    const project = createDemoProject(); project.assets[0].uri = "C:/fixture/supersession.mp4";
    project.assets[0].width = 1920; project.assets[0].height = 1080;
    const preview = prepareResidentGpuGraphs(project).video!;
    const bounds = { x: 0, y: 0, width: 960, height: 540, revision: 1 };
    const ref = <T,>(current: T) => ({ current });
    const present = vi.fn(async () => { throw new Error("controlled native dispatch reached"); });
    const context: EngineVideoPreviewContext = {
      next: { kind: "engine-video", preview, token: 1, fps: 30, nativeBounds: bounds },
      desktop: { presentGpuEngineVideoPreviewFrame: present },
      imageSessionRef: ref("image"), videoSessionRef: ref("video"), engineVideoSessionRef: ref("engine"),
      loadedImageStructureRef: ref(undefined), loadedVideoStructureRef: ref(undefined),
      loadedEngineVideoStructureRef: ref(`engine-video:${preview.structureKey}`),
      surfaceBoundsKeyRef: ref(boundsKey({ ...bounds, surfaceColorSpace: "srgb" })),
      surfaceColorSpaceRef: ref<"srgb" | "rec2100_pq_1000" | undefined>("srgb"), surfaceBoundRef: ref(true), tokenRef: ref(1),
      releaseSurface: vi.fn(async () => {}), setFrameUrl: vi.fn(), setNativeSurfaceActive: vi.fn(), setFallbackReason: vi.fn(),
    };
    return { context, present };
  }
  it("the valid current queue item reaches native presentation, without claiming a fabricated receipt", async () => {
    const { context, present } = fixture();
    await expect(presentResidentEngineVideo(context)).rejects.toThrow("controlled native dispatch reached");
    expect(present).toHaveBeenCalledExactlyOnceWith("engine", 0, 1 / 60);
  });
  it("a queued frame superseded before dispatch never touches the native surface", async () => {
    const { context, present } = fixture(); context.tokenRef.current = 2;
    expect(await presentResidentEngineVideo(context)).toBeUndefined(); expect(present).not.toHaveBeenCalled();
    expect(context.setNativeSurfaceActive).not.toHaveBeenCalled();
  });
  it("supersession during an actual surface rebind releases the surface and does not dispatch the old frame", async () => {
    const { context, present } = fixture(); context.surfaceBoundsKeyRef.current = "previous-size";
    let complete!:(surface: GpuNativePreviewSurface)=>void;
    const rebinding = new Promise<GpuNativePreviewSurface>(yes=>{complete=yes;});
    context.desktop.bindGpuPreviewSurface = vi.fn(()=>rebinding);
    const result = presentResidentEngineVideo(context);
    expect(context.desktop.bindGpuPreviewSurface).toHaveBeenCalledTimes(1);
    context.tokenRef.current = 2;
    complete({bound:true,backend:"Dx12",nativeSwapChain:true,cpuPixelReadbacks:0,surfaceColorSpace:"Auto",
      requestedColorSpace:"srgb",pixelContract:"legacy-sdr-video/v1",hdrTransportConfigured:false,
      legacyVideoPresentationAllowed:true,dxgiColorSpaceConfiguration:"wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1",
      physicalDisplayHdrVisibility:"advisory-unverified",displayHdrInfo:{advisoryOnly:true}} as GpuNativePreviewSurface);
    expect(await result).toBeUndefined(); expect(context.releaseSurface).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
  });
});

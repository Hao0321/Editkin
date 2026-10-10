import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineRenderGraph } from "./engineGraph";
import { DEFAULT_COLOR } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { selectedNativeVideoRuntimeIdentitySchema } from "../application/selectedNativeVideoRuntime";
import { renderResidentSceneLinearVideoSequence } from "./residentSceneLinearVideoSequence";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn }));

const DISPLAY = "editkin-ocio-aces2-linear-rec709-to-rec709-sdr/v1";
const INPUT = "editkin-srgb-to-linear-rec709-primary/v1";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
// Synthetic selected-runtime identity for the mock transport: no native binary, target or pixels are certified.
const METADATA = { schema: "editkin.native-video-runtime-metadata/v1", platform: "win32",
  executableSha256: sha("mock-only.exe"), executableBytes: 13, videoInteropProtocol: "media-foundation-d3d11-d3d12-wgpu/v1",
  nativeFloatingVideoFrameContract: "editkin.native-floating-frame-material/v1",
  offscreenVideoProtocol: "editkin.resident-offscreen-video-target/v1", displayPaintSchema: "editkin.native-motion-paint-track/v2",
  videoTargetAdmission: { schema: "editkin.shared-video-target-admission/v1", requiredBackend: "Dx12", factory: "new_dx12_video",
    selection: "deferred-until-target-bind", offscreenProtocol: "editkin.resident-offscreen-video-target/v1" },
  actualTargetMeasured: false, noNativeWindowCreated: true };
const RUNTIME = selectedNativeVideoRuntimeIdentitySchema.parse({ schema: "editkin.selected-native-video-runtime/v1",
  executablePathSha256: sha("mock-only.exe"), executableSha256: METADATA.executableSha256, executableBytes: METADATA.executableBytes,
  metadataSha256: sha(canonicalJson(METADATA)), metadata: METADATA, verification: "selected_binary_metadata_only" });
const TARGET = { schema: "editkin.actual-video-target-identity/v1", generation: 1, backend: "Dx12", adapter: "mock transport adapter",
  deviceType: "mock", executableSha256: RUNTIME.executableSha256, executableBytes: RUNTIME.executableBytes,
  target: { renderTargetContract: "editkin.resident-offscreen-render-target/v1", offscreen: true, width: 4, height: 4, nativeWindow: false, nativeSwapChain: false } };
function fixture(): EngineRenderGraph {
  const track = { schema: "editkin.native-motion-paint-track/v1", sourceSignature: "source-control-authored-track",
    scene: { width: 4, height: 4, background: [0, 0, 0, 0], max_scale: 1, layers: [{ id: "ink", path: { fill_rule: "non_zero", commands: [
      { type: "M", x: 0, y: 0 }, { type: "L", x: 2, y: 0 }, { type: "L", x: 2, y: 2 }, { type: "L", x: 0, y: 2 }, { type: "Z" }], }, paint: { kind: "solid", color: [1, 0, 0, .5] }, clips: [] }] },
    timeline: { timelineStartFrame: 1, sourceStartFrame: 0, durationFrames: 2 },
    frames: [[{ x: 0, y: 0, scale: 1, opacity: .5 }], [{ x: 1, y: 1, scale: 1, opacity: 1 }]] };
  return { schema: "editkin.engine-graph/v1", graphId: "source-control", width: 4, height: 4,
    timebase: { numerator: 1, denominator: 30 }, workingFormat: "rgba16_float", cacheBudgetMb: 64,
    nodes: [
      { id: "source", kind: "source", inputs: [], enabled: true, assetId: "video", mediaKind: "video", inputColorSpace: "rec709", timeline: { timelineStartFrame: 0, sourceStartFrame: 0, durationFrames: 3 } },
      { id: "input", kind: "color", inputs: ["source"], enabled: true, processor: INPUT, inputSpace: "rec709", workingSpace: "linear_rec709", outputSpace: "linear_rec709", grade: { ...DEFAULT_COLOR } },
      { id: "paint", kind: "native_motion_paint", inputs: [], enabled: true, graphicId: "paint", track },
      { id: "composite", kind: "composite", inputs: ["input", "paint"], enabled: true, blendMode: "normal", opacity: 1 },
      { id: "display", kind: "color", inputs: ["composite"], enabled: true, processor: DISPLAY, inputSpace: "linear_rec709", workingSpace: "ACEScct", outputSpace: "rec709", grade: { ...DEFAULT_COLOR } },
      { id: "output", kind: "output", inputs: ["display"], enabled: true, format: "rgba16_float" },
    ], outputNode: "output" };
}

function mockRuntime(graph: EngineRenderGraph, defect?: "decoded-copy" | "zero-total") {
  const paint = graph.nodes.find(node => node.kind === "native_motion_paint")!;
  const track = paint.track as { sourceSignature: string; timeline: { timelineStartFrame: number; sourceStartFrame: number; durationFrames: number }; frames: unknown[][] };
  const colorBinding = { nodeId: paint.id, graphicId: paint.graphicId,
    sourceSignatureSha256: createHash("sha256").update(track.sourceSignature).digest("hex"),
    colorIntent: "scene_linear_rec709", compositionBoundary: "before_aces2", overlayOrder: 0 };
  let uploads = 1, cachedFrame = 0;
  const receipt = (frame: number) => {
    const cacheHit = frame === cachedFrame, work = cacheHit ? 0 : 1;
    if (work) uploads++;
    cachedFrame = frame;
    return { nodeId: paint.id, graphicId: paint.graphicId, timeline: track.timeline, timelineFrame: frame, localFrame: frame - 1,
      executor: "editkin.resident-native-motion-paint/v1", sourceSignatureSha256: createHash("sha256").update(track.sourceSignature).digest("hex"),
      colorIntent: colorBinding.colorIntent, compositionBoundary: colorBinding.compositionBoundary, overlayOrder: colorBinding.overlayOrder,
      layerCount: 1, poses: track.frames[frame - 1], workingColorSpace: "linear_rec709", workingFormat: "rgba16float", alphaMode: "premultiplied",
      cacheHit, poseContentCacheHit: false, reuseReason: cacheHit ? "same_frame" : "none",
      rasterCount: uploads, textureUploadCount: uploads, frameRasterCount: work, frameTextureUploadCount: work,
      frameCpuUploadBytes: work * 128, rasterMilliseconds: work, uploadMilliseconds: work };
  };
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill(): void };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  // Like an owned child process, a terminated mock reports exit and close.
  child.kill = () => { if (child.killed) return; child.killed = true;
    queueMicrotask(() => { child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); }); };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk));
    void (async () => {
      let result: Record<string, unknown> = {};
      if (request.command === "offscreen_bind") result = { backend: "Dx12", nativeSwapChain: false, nativeWindow: false, offscreen: true,
        bound: false, visible: false, presentCount: 0, renderTargetContract: "editkin.resident-offscreen-render-target/v1", cpuPixelReadbacks: 0,
        videoTargetIdentity: TARGET };
      if (request.command === "engine_video_load") result = { videoTargetIdentity: TARGET,
        executor: "media-foundation-d3d11-d3d12-wgpu/v1", displayTransform: "aces2_rec709_sdr",
        resourcePlan: { workingBytesPerPixel: 8, maximumFullFramePassesPerPresent: 4 },
        engineGraph: { directExecution: true, blockedNodeIds: [], ignoredNodeIds: [] }, gpuEffects: { resolved: true, programs: [] },
        nativeMotionPaintCount: 1, nativeMotionPaintResidentTextureCount: 1, nativeMotionPaintTextureUploads: 1,
        nativeMotionPaintInitialRasterCount: 1, nativeMotionPaintInitialCpuUploadBytes: 128, activeNativeMotionPaints: [],
        nativeMotionPaintColorBindings: [colorBinding],
      };
      if (request.command === "engine_video_verify_frame") {
        const frame = request.timelineFrame, active = frame >= 1 && frame <= 2;
        const activePaint = active ? receipt(frame) : undefined, copies = active ? 1 : 0;
        await writeFile(request.outputPath, `source-control-frame-${frame}`);
        result = { videoTargetIdentity: TARGET, offscreen: true, nativeSurfacePresented: false, outputReadbackCopies: 1,
          renderTarget: { renderTargetContract: "editkin.resident-offscreen-render-target/v1", nativeWindow: false, nativeSwapChain: false },
          sceneLinearExecution: true, workingColorSpace: "linear_rec709", workingFormat: "rgba16_float", displayTransform: DISPLAY,
          inputTransform: INPUT, ocioVersion: "2.5.2", acesVersion: "2.0", configSha256: "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbafac1029a",
          verificationReadback: true, outputWritten: true, engineGraph: { directExecution: true, blockedNodeIds: [], ignoredNodeIds: [] },
          activeNativeMotionPaints: activePaint ? [activePaint] : [], nativeMotionPaintResidentTextureCount: 1, nativeMotionPaintTextureUploads: uploads,
          productPathCpuPixelCopies: defect === "zero-total" ? 0 : copies, decodedVideoCpuPixelCopies: defect === "decoded-copy" ? 1 : 0,
          nativePaintCpuUploadBytes: copies * 128, effectExecutionMode: "none", shaderOperationCount: 0, builtInEffectCount: 0,
          temporalExecutionMode: "none", temporalLayerCount: 0, temporalSampleTextureCount: 0, activeParticleEmitters: [],
          matteExecutionMode: "none", mattePassCount: 0, depthExecutionMode: "none", depthFormat: "none", depthTestedLayerCount: 0, depthPassCount: 0,
          compositeFullFramePassCount: 3, depthOfFieldExecutionMode: "none", depthOfFieldDepthSource: "none", depthOfFieldPassCount: 0 };
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    })().catch(error => child.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: String(error) })}\n`));
    done();
  } });
  mocked.spawn.mockImplementation(() => { queueMicrotask(() => child.stdout.write(`${JSON.stringify({ event: "ready", generation: TARGET.generation,
    offscreenVideoProtocol: "editkin.resident-offscreen-video-target/v1", nativeRuntimeMetadata: METADATA })}\n`)); return child; });
}

const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("editkin-native-paint-sequence-control-")) {
      throw new Error("Sequence control cleanup escaped its owned temp directory");
    }
    await rm(path, { recursive: true, force: true });
  }
  mocked.spawn.mockReset();
});
async function run(defect?: "decoded-copy" | "zero-total") {
  const graph = fixture(), directory = await mkdtemp(join(tmpdir(), "editkin-native-paint-sequence-control-")); owned.push(directory);
  mockRuntime(graph, defect);
  return renderResidentSceneLinearVideoSequence({ executable: "mock-only.exe", graph, assetBindings: { video: "fixture.mp4" }, startFrame: 0,
    frameCount: 3, outputDirectory: directory, timeoutMs: 1000, selectedNativeVideoRuntime: RUNTIME });
}

describe("formal sequence paint upload accounting (mock transport, no GPU)", () => {
  it("counts inactive load work and each active frame upload once while decoded video copies remain zero", async () => {
    const result = await run();
    expect(result).toMatchObject({ productPathCpuPixelCopies: 3, decodedVideoCpuPixelCopies: 0, nativePaintCount: 1,
      nativePaintGraphicIds: ["paint"], nativePaintCpuUploadBytes: 384, nativePaintRasterCount: 3,
      nativePaintTextureUploadCount: 3, nativePaintFramesWithActiveGraphics: 2 });
  });
  it.each(["decoded-copy", "zero-total"] as const)("refuses false %s receipts", async defect => {
    await expect(run(defect)).rejects.toThrow(/receipt/);
  });
});

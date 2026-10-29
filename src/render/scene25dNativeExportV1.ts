import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { EditProject } from "../domain/types";
import { validateProject } from "../domain/editGraph";
import { particleSimulationEmitters } from "../domain/types";
import { buildAssFilter, writeAssContent } from "./captionAss";
import { resolveAssFontRoot } from "./fontRoot";
import { prepareMotionPhysicalLayouts } from "./motionPhysicalGlyphLayouts";
import { AssMotionBudget } from "./assMotionBudget";
import { buildGpuEnginePreviewGraph, buildGpuEngineVideoPreviewGraph, type GpuEnginePreviewGraph } from "./gpuCompositor";
import { containsSceneLinearMedia } from "./aces2SdrVideo";
import { createResidentSequenceWorker } from "./residentSceneLinearVideoSequence";
import { sampleScene25dCameraNode, scene25dCameraGraphKeyframes } from "./scene25dCameraAnimation";
import { residentMuxFrameLimitArgsV3 } from "./residentStreamPlanV3";
import { FFMPEG_PROGRESS_ARGS, type ProcessProgressWatch } from "./mediaProcess";
import { assertRenderActive, publishRenderOutput, renderLifetimeSignal, renderStageTimeout } from "./renderLifetime";
import { renderProgressTimeReporter, reportRenderStage } from "./renderProgress";
import { createRenderWorkDirectory, removeRenderWorkDirectory } from "./renderWorkspace";
import { assertRenderDiskSpace, estimateAudioBedBytes, estimateEncodedOutputBytes, estimatePngSequenceBytes, exportDiskRequirements, planShape } from "./renderDiskSpace";
import type { RenderPlan } from "./planner";
import { ExportFeatureRefusalErrorV1, exportRefusalClipLabelV1, type ExportRefusalMessageIdV1 } from "./exportFeatureRefusalV1";
import { hasExecutableUnifiedLayerOrderV1 } from "../application/unifiedLayerExecutionAdmissionV1";
import { mediaUtilityInputOptions } from "../application/mediaUtilityInputPolicy";

const run = promisify(execFile);

/**
 * 2.5D scenes and particle simulations exist only in the native (wgpu) engine graph. The FFmpeg composite has no
 * 2.5D, transform3d or particle code, so an export that falls back to it would silently flatten the scene. This module
 * decides the export route for a project that enables either feature and runs the Rec.709 one:
 *
 * - Rec.709 projects whose planes are images: the native image engine graph the desktop preview runs
 *   (buildGpuEnginePreviewGraph: linear Rec.709 working space, Rec.709 OETF display output), sampled per frame through
 *   the resident `serve` worker (engine_load at the frame, then render). Each frame's camera, lights and particles are
 *   prepared at that frame, so animated cameras and lights render exactly. Captions and ASS motion graphics are burned
 *   on the display frames afterwards, as in the ACES 2 display-sequence route. Audio is the ordinary audio bed.
 * - ACES 2 (Rec.709 SDR) projects whose planes are videos: the existing resident ACES 2 route (ffmpeg.ts).
 * - Everything else refuses with a message naming the planes, the reason and the workaround.
 */
export type Scene25dExportPlanV1 =
  | { kind: "none" }
  | { kind: "native-image-engine"; preview: GpuEnginePreviewGraph }
  | { kind: "resident-aces2" }
  | { kind: "refuse"; error: ExportFeatureRefusalErrorV1 };

export const SCENE25D_IMAGE_ENGINE_PLANNER_V1 = "editkin-native-image-engine-rec709-display-sequence/v1";
const LINEAR_PREVIEW_PROCESSOR = "editkin-linear-preview-rec709-oetf/v1";

function visibleVideoClips(project: EditProject) {
  return project.tracks.filter(track => track.kind === "video" && !track.hidden).flatMap(track => track.clips)
    .filter(clip => (clip.layer?.enabled ?? true) && (clip.layer?.role ?? "content") === "content");
}

/** The visual graph input: audio is mixed separately; captions and ASS motion graphics are burned afterwards. */
export function scene25dVisualProjectV1(project: EditProject, resolveUri: (uri: string) => string = uri => uri): EditProject {
  const visual = structuredClone(project);
  visual.tracks = visual.tracks.filter(track => track.kind !== "audio");
  for (const track of visual.tracks) for (const clip of track.clips) clip.volume = 0;
  visual.captions = [];
  visual.motionGraphics = [];
  for (const asset of visual.assets) if (!asset.compositionId) asset.uri = resolveUri(asset.uri);
  return visual;
}

type RefusalMessageId = ExportRefusalMessageIdV1;

/** 2.5D wins the message when both are enabled (its planes are what would flatten). */
export function scene25dRefusalV1(project: EditProject, sceneMessage: RefusalMessageId, particleMessage: RefusalMessageId, params: Record<string, string | number> = {}): ExportFeatureRefusalErrorV1 {
  const clips = visibleVideoClips(project), first = clips[0];
  const scene = project.scene25d?.enabled === true;
  const count = scene ? clips.length : particleSimulationEmitters(project.particleSimulation!).length;
  return new ExportFeatureRefusalErrorV1(scene ? "scene25d" : "particleSimulation", scene ? sceneMessage : particleMessage,
    { clip: first ? exportRefusalClipLabelV1(project.assets, first) : "—", count, ...params }, first?.id);
}

/**
 * The route an export takes for a project that enables 2.5D or particles (`none` otherwise). Pure and synchronous: it
 * builds the same admission graphs the route uses, without probing media. Native paint and floating frames are
 * decided by the resident ACES 2 route itself (they need asynchronous font/frame preparation).
 */
export function scene25dExportPlanV1(project: EditProject, options: { gpuCompositorPath?: string; resolveUri?: (uri: string) => string; alphaIntermediate?: boolean }): Scene25dExportPlanV1 {
  if (!project.scene25d?.enabled && !project.particleSimulation?.enabled) return { kind: "none" };
  // An invalid scene (camera, lights, parenting) must report its own validation error, not a route refusal.
  validateProject(project);
  const management = project.colorManagement;
  const aces = management?.mode === "aces2";
  if (options.alphaIntermediate || containsSceneLinearMedia(project) || (aces && management?.outputTransform !== "rec709_sdr")) {
    const route = options.alphaIntermediate ? "透明預合成" : containsSceneLinearMedia(project) ? "Scene-linear EXR" : `ACES 2 ${management?.outputTransform ?? ""}`;
    return { kind: "refuse", error: scene25dRefusalV1(project, "scene25dColorRoute", "particlesColorRoute", { route }) };
  }
  if (!options.gpuCompositorPath) return { kind: "refuse", error: scene25dRefusalV1(project, "scene25dNoRuntime", "particlesNoRuntime") };
  const resolveUri = options.resolveUri ?? (uri => uri);
  if (aces) {
    const paintOrFloating = project.motionGraphics.some(graphic => graphic.paintV1 || graphic.visualStyle === "native_paint")
      || project.tracks.some(track => track.clips.some(clip => clip.floatingFrame));
    if (paintOrFloating) return { kind: "resident-aces2" };
    const nativeProject = structuredClone(project);
    for (const asset of nativeProject.assets) if (asset.kind === "video" && !asset.compositionId) asset.uri = resolveUri(asset.uri);
    return buildGpuEngineVideoPreviewGraph(nativeProject, 0) ? { kind: "resident-aces2" }
      : { kind: "refuse", error: scene25dRefusalV1(project, "scene25dCombination", "particlesCombination") };
  }
  if (hasExecutableUnifiedLayerOrderV1(project)) return { kind: "refuse", error: scene25dRefusalV1(project, "scene25dCombination", "particlesCombination") };
  const preview = buildGpuEnginePreviewGraph(scene25dVisualProjectV1(project, resolveUri), 0);
  if (preview) return { kind: "native-image-engine", preview };
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const videoPlanes = visibleVideoClips(project).some(clip => assets.get(clip.assetId)?.kind === "video");
  return { kind: "refuse", error: scene25dRefusalV1(project, videoPlanes ? "scene25dVideoPlanes" : "scene25dCombination", "particlesCombination") };
}

/** The native image loader reads PNG (and EXR) only: other stills are decoded once by FFmpeg to lossless RGBA PNG. */
async function nativeImageBindings(bindings: Record<string, string>, ffmpegPath: string, directory: string, timeoutMs: number): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  let index = 0;
  for (const [assetId, path] of Object.entries(bindings)) {
    if (extname(path).toLowerCase() === ".png") { resolved[assetId] = path; continue; }
    assertRenderActive();
    const output = join(directory, `still-${index++}.png`);
    // Project media is an untrusted local file: self-contained formats over file:// only (as the mesh texture decoder).
    await run(ffmpegPath, ["-v", "error", "-y", ...mediaUtilityInputOptions(path), "-i", path, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "image2", "-c:v", "png", output],
      { windowsHide: true, timeout: renderStageTimeout(Math.min(timeoutMs, 120_000)), signal: renderLifetimeSignal() });
    resolved[assetId] = output;
  }
  return resolved;
}

const sameF32 = (left: unknown, right: number) => typeof left === "number" && Number.isFinite(left) && Math.abs(left - right) <= 1e-4;

export interface Scene25dImageEngineReceiptV1 {
  schema: "editkin.native-image-engine-sequence/v1";
  executor: "editkin-gpu-compositor-serve-engine-render/v1";
  displayTransform: "scene_linear_preview";
  colorProcessor: typeof LINEAR_PREVIEW_PROCESSOR;
  frameCount: number;
  graphId: string;
  convertedStills: number;
  scene25d?: { planeCount: number; cameraKeyframeCount: number; cameraAnimatedFrames: number };
  vfxSimulation?: { emitterCount: number; particleCeiling: number };
  firstFrameSha256?: string;
  lastFrameSha256?: string;
  captionsBurned: boolean;
}

export interface Scene25dImageEngineDependencies<TEncoder extends string> {
  runProcess: (executable: string, args: string[], timeoutMs: number, capture?: { completeStdoutMaxChars: number }, watch?: ProcessProgressWatch) => Promise<{ stdout: string; stderr: string }>;
  renderAudioBed: (project: EditProject, plan: RenderPlan, outputPath: string, ffmpegPath: string, timeoutMs: number) => Promise<void>;
  probeMedia: (path: string, ffprobePath?: string) => Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean; colorPrimaries?: string; colorTransfer?: string; colorMatrix?: string }>;
  encoderArgs: (encoder: TEncoder) => string[];
  finite: (value: number) => string;
}

/** Renders the preview's native image engine graph frame by frame, then encodes it with the audio bed. */
export async function renderScene25dImageEngineProjectV1<TEncoder extends string>(
  project: EditProject, preview: GpuEnginePreviewGraph, outputPath: string, plan: RenderPlan,
  options: { ffmpegPath?: string; ffprobePath?: string; gpuCompositorPath?: string; fontRoot?: string; signal?: AbortSignal },
  encoder: TEncoder, timeoutMs: number, dependencies: Scene25dImageEngineDependencies<TEncoder>,
): Promise<{ outputPath: string; duration: number; encoder: TEncoder; planner: string; ffmpegVersion: string; nativeImageEngine: Scene25dImageEngineReceiptV1 }> {
  if (!options.gpuCompositorPath) throw scene25dRefusalV1(project, "scene25dNoRuntime", "particlesNoRuntime");
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg", ffprobePath = options.ffprobePath ?? "ffprobe";
  const frameCount = Math.round(plan.duration * project.fps);
  const requested = resolve(outputPath);
  const shape = planShape(plan);
  await assertRenderDiskSpace(exportDiskRequirements(requested, estimateEncodedOutputBytes(shape, encoder as never),
    estimatePngSequenceBytes(shape, "rgba8") + estimateAudioBedBytes(plan.duration)));
  await mkdir(dirname(requested), { recursive: true });
  const workspace = await createRenderWorkDirectory("editkin-render-");
  const temporaryOutput = join(dirname(requested), `.${basename(requested)}.${process.pid}.scene25d-rendering.mp4`);
  const sequence = join(workspace, "display-sequence");
  const graph = preview.graph;
  const camera = graph.nodes.find(node => node.kind === "camera");
  const cameraKeyframeCount = camera ? scene25dCameraGraphKeyframes(camera).length : 0;
  const nodeIds = graph.nodes.map(node => node.id);
  try {
    await mkdir(sequence, { recursive: true });
    const bindings = await nativeImageBindings(preview.assetBindings, ffmpegPath, workspace, timeoutMs);
    const graphPath = join(workspace, "engine-graph.json"), bindingsPath = join(workspace, "asset-bindings.json");
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await writeFile(bindingsPath, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
    reportRenderStage("frames", plan.duration);
    const progress = renderProgressTimeReporter();
    const deadlineAt = performance.now() + renderStageTimeout(timeoutMs);
    const worker = createResidentSequenceWorker({ executable: options.gpuCompositorPath, args: ["serve"], deadlineAt, fontRoot: options.fontRoot, signal: renderLifetimeSignal() ?? options.signal });
    const sessionId = `scene25d-export-${process.pid}-${Date.now()}`;
    let firstFrameSha256: string | undefined, lastFrameSha256: string | undefined, cameraAnimatedFrames = 0, previousCamera = "";
    try {
      await worker.ready;
      for (let frame = 0; frame < frameCount; frame += 1) {
        assertRenderActive();
        // Prepared at this frame: camera, lights and particles are sampled exactly as the preview samples them.
        const load = await worker.request("engine_load", { sessionId, graphPath, bindingsPath, timelineFrame: frame });
        const coverage = load.engineGraph as { directExecution?: boolean; blockedNodeIds?: unknown[]; ignoredNodeIds?: unknown[]; executedNodeIds?: string[] } | undefined;
        if (coverage?.directExecution !== true || coverage.blockedNodeIds?.length || coverage.ignoredNodeIds?.length
          || nodeIds.some(id => !coverage.executedNodeIds?.includes(id))) {
          throw new Error(`2.5D／粒子原生合成第 ${frame} 格沒有完整執行共同 Engine Graph：${JSON.stringify(coverage)}`);
        }
        const output = join(sequence, `frame-${String(frame).padStart(8, "0")}.png`);
        const rendered = await worker.request("render", { sessionId, outputPath: output });
        const scene = rendered.scene25d as { planeCount?: number; sampledTimelineFrame?: number; cameraPosition?: number[]; cameraKeyframeCount?: number } | null | undefined;
        const vfx = rendered.vfxSimulation as { emitterCount?: number; particleCeiling?: number } | null | undefined;
        if (rendered.displayTransform !== "scene_linear_preview" || rendered.colorProcessor !== LINEAR_PREVIEW_PROCESSOR
          || rendered.width !== graph.width || rendered.height !== graph.height || typeof rendered.outputHash !== "string") {
          throw new Error(`2.5D／粒子原生合成第 ${frame} 格的輸出 receipt 不符合 Rec.709 預覽合約：${JSON.stringify({ displayTransform: rendered.displayTransform, colorProcessor: rendered.colorProcessor })}`);
        }
        if (preview.scene25dExpectation) {
          const sample = sampleScene25dCameraNode(camera!, frame);
          if (scene?.planeCount !== preview.scene25dExpectation.planeCount || scene.cameraKeyframeCount !== cameraKeyframeCount
            || (cameraKeyframeCount && scene.sampledTimelineFrame !== frame)
            || !sample.position.every((value, index) => sameF32(scene.cameraPosition?.[index], value))) {
            throw new Error(`2.5D 原生合成第 ${frame} 格的攝影機與專案不一致`);
          }
          const key = JSON.stringify(scene.cameraPosition);
          if (previousCamera && key !== previousCamera) cameraAnimatedFrames += 1;
          previousCamera = key;
        } else if (scene) throw new Error("非 2.5D 專案收到 2.5D 原生 receipt");
        if (preview.vfxSimulationExpectation) {
          if (vfx?.emitterCount !== preview.vfxSimulationExpectation.emitterCount || vfx.particleCeiling !== preview.vfxSimulationExpectation.particleCeiling) {
            throw new Error(`粒子原生合成第 ${frame} 格的發射器與專案不一致`);
          }
        }
        firstFrameSha256 ??= rendered.outputHash as string; lastFrameSha256 = rendered.outputHash as string;
        progress?.((frame + 1) / project.fps);
      }
      await worker.request("release", { sessionId }).catch(() => undefined);
    } finally {
      await worker.close().catch(() => undefined);
    }
    reportRenderStage("audio", plan.duration);
    const audioPath = join(workspace, "audio.m4a");
    await dependencies.renderAudioBed(project, plan, audioPath, ffmpegPath, timeoutMs);
    const captionsBurned = project.captions.length > 0 || project.motionGraphics.length > 0;
    let assPath: string | undefined, assFontRoot: string | undefined;
    if (captionsBurned) {
      const assFonts = await resolveAssFontRoot(options.fontRoot, project);
      const physicalLayouts = await prepareMotionPhysicalLayouts(project, options.fontRoot);
      assPath = join(workspace, "captions.ass"); assFontRoot = assFonts.fontRoot;
      await writeFile(assPath, writeAssContent(project, project.captionStyle, { ...assFonts, physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget: new AssMotionBudget() }), "utf8");
    }
    reportRenderStage("encode", plan.duration);
    // Straight-alpha display frames over the black canvas, then the same Rec.709 delivery tags as the resident route.
    const videoFilter = ["format=gbrap", "premultiply=inplace=1", "format=gbrp", ...(assPath ? [buildAssFilter(assPath, assFontRoot)] : []), "format=yuv420p"].join(",");
    await dependencies.runProcess(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", dependencies.finite(project.fps), "-start_number", "0", "-i", join(sequence, "frame-%08d.png"),
      "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilter, ...residentMuxFrameLimitArgsV3(plan.duration, project.fps, frameCount),
      ...dependencies.encoderArgs(encoder), "-pix_fmt", "yuv420p",
      "-color_primaries:v", "bt709", "-colorspace:v", "bt709", "-color_trc:v", "bt709",
      "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-c:a", "copy", "-t", dependencies.finite(plan.duration), "-video_track_timescale", "90000", "-movflags", "+faststart", ...FFMPEG_PROGRESS_ARGS, temporaryOutput,
    ], timeoutMs, undefined, { ffmpegProgress: true, paths: [temporaryOutput] });
    reportRenderStage("verify");
    const probe = await dependencies.probeMedia(temporaryOutput, ffprobePath);
    if (!probe.hasVideo || !probe.hasAudio || probe.colorPrimaries !== "bt709" || probe.colorTransfer !== "bt709" || probe.colorMatrix !== "bt709"
      || Math.abs(probe.duration - plan.duration) > Math.max(.15, 2 / project.fps)) {
      throw new Error(`2.5D／粒子正式輸出 QA 失敗：duration=${probe.duration}, primaries=${probe.colorPrimaries ?? "unknown"}, transfer=${probe.colorTransfer ?? "unknown"}, matrix=${probe.colorMatrix ?? "unknown"}`);
    }
    await publishRenderOutput(temporaryOutput, requested);
    const version = await dependencies.runProcess(ffmpegPath, ["-version"], 10_000);
    return {
      outputPath: requested, duration: probe.duration, encoder, planner: SCENE25D_IMAGE_ENGINE_PLANNER_V1,
      ffmpegVersion: version.stdout.split(/\r?\n/)[0] ?? "unknown",
      nativeImageEngine: {
        schema: "editkin.native-image-engine-sequence/v1", executor: "editkin-gpu-compositor-serve-engine-render/v1",
        displayTransform: "scene_linear_preview", colorProcessor: LINEAR_PREVIEW_PROCESSOR, frameCount, graphId: graph.graphId,
        convertedStills: Object.values(preview.assetBindings).filter(path => extname(path).toLowerCase() !== ".png").length,
        ...(preview.scene25dExpectation ? { scene25d: { planeCount: preview.scene25dExpectation.planeCount, cameraKeyframeCount, cameraAnimatedFrames } } : {}),
        ...(preview.vfxSimulationExpectation ? { vfxSimulation: { emitterCount: preview.vfxSimulationExpectation.emitterCount, particleCeiling: preview.vfxSimulationExpectation.particleCeiling } } : {}),
        ...(firstFrameSha256 ? { firstFrameSha256 } : {}), ...(lastFrameSha256 ? { lastFrameSha256 } : {}), captionsBurned,
      },
    };
  } finally {
    await rm(temporaryOutput, { force: true });
    await removeRenderWorkDirectory(workspace);
  }
}

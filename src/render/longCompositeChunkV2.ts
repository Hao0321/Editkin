import { link, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { validateProject } from "../domain/editGraph";
import { materializeNativeEffectSegments, projectAfterNativeEffectMaterialization } from "../plugins/nativeEffectRender";
import { AssMotionBudget } from "./assMotionBudget";
import { containsSceneLinearMedia } from "./aces2SdrVideo";
import { writeAssContent } from "./captionAss";
import { compositeChunkOutputPlanV1, type CompositeChunkGraphContextV1, type CompositeChunkOutputV1 } from "./compositeChunkOutputV1";
import { buildLongCompositeChunkPlanV1 } from "./longCompositeChunkPlanV1";
import { renderComposite } from "./ffmpegComposite";
import { resolveMediaPath, runProcess } from "./ffmpegMedia";
import { resolveAssFontRoot } from "./fontRoot";
import { HIGH_BIT_DEPTH_ALPHA_PROFILE } from "./highBitDepthAlphaDelivery";
import { LongRenderRefusalV1, type LongChunkIntermediateRequestV1, type LongChunkIntermediateResultV1 } from "./longRenderContractsV1";
import { prepareMotionPhysicalLayouts } from "./motionPhysicalGlyphLayouts";
import type { RawVideoSinkV1 } from "./rawVideoProcessV1";
import { assertRenderActive, withRenderLifetime } from "./renderLifetime";
import { probeVolumeSpace } from "./renderDiskSpace";
import { createRenderWorkDirectory, currentRenderWorkRoot, removeRenderWorkDirectory, runWithRenderWorkRootV1, selectLongRenderWorkRootV1 } from "./renderWorkspace";

type ChunkRequest = Omit<LongChunkIntermediateRequestV1, "outputPath"> & { durationSeconds?: number; assProject?: EditProject; startFrame?: number; context?: CompositeChunkGraphContextV1 };

/** Shared preparation for both C5 lossless compatibility and B2 zero-video-staging output. */
async function withPreparedChunk<T>(request: ChunkRequest, output: CompositeChunkOutputV1,
  operation: (context: { workspace: string; project: EditProject; render: (path: string) => Promise<void>; duration: number }) => Promise<T>): Promise<T> {
  const project = structuredClone(request.project), { options, timeoutMs } = request;
  return withRenderLifetime({ signal: options.signal, timeoutMs, stallMs: options.stallTimeoutMs }, async () => {
    assertRenderActive();
    const [{ initializeStudioCreativeAssets }, { initializeWave2Registry }] = await Promise.all([import("../creative/studioAssets"), import("../creative/wave2Registry")]);
    initializeStudioCreativeAssets(); initializeWave2Registry();
    validateProject(project);
    if (project.compositions.length || project.scene3d?.enabled || containsSceneLinearMedia(project) || options.deliveryProfile === HIGH_BIT_DEPTH_ALPHA_PROFILE
      || project.motionGraphics.some(graphic => graphic.paintV1 || graphic.visualStyle === "native_paint")) {
      throw new LongRenderRefusalV1("LONG_RENDER_ROUTE_NOT_AVAILABLE", "a composite chunk cannot contain unresolved compositions, mesh, scene-linear media, native paint or alpha delivery");
    }
    const plan = buildLongCompositeChunkPlanV1(project, uri => resolveMediaPath(uri, options.assetBase), request.durationSeconds, request.context?.workingPrecision16);
    compositeChunkOutputPlanV1(project, plan.duration, "ffv1", false, output);
    if (plan.duration > 60 + 1e-6) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "a prepared composite chunk must be at most 60 seconds; use the LONG chunk planner");
    const workspace = await createRenderWorkDirectory("editkin-render-");
    try {
      const nativeEffects = await materializeNativeEffectSegments(project, plan, {
        ffmpegPath: options.ffmpegPath ?? "ffmpeg", nativeCorePath: options.nativeCorePath ?? "", gpuCompositorPath: options.gpuCompositorPath,
        pluginRoots: options.pluginRoots ?? [], fontRoot: options.fontRoot, workspace: join(workspace, "native-effects"), timeoutMs,
      });
      const prepared = projectAfterNativeEffectMaterialization(project, nativeEffects);
      const assProject = request.assProject ?? prepared;
      const fonts = await resolveAssFontRoot(options.fontRoot, assProject);
      const physicalLayouts = await prepareMotionPhysicalLayouts(assProject, options.fontRoot), aggregateBudget = new AssMotionBudget();
      let assPath: string | undefined;
      if (!prepared.unifiedLayerOrderV1 && (prepared.captions.length || prepared.motionGraphics.length)) {
        assPath = join(workspace, "captions.ass");
        await writeFile(assPath, writeAssContent(assProject, assProject.captionStyle, { ...fonts, physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget }), { encoding: "utf8", flag: "wx" });
      }
      const result = await operation({ workspace, project: prepared, duration: plan.duration,
        render: path => renderComposite(options.ffmpegPath ?? "ffmpeg", options.ffprobePath ?? "ffprobe", path, prepared, plan, assPath, "ffv1", timeoutMs,
          fonts.fontRoot, options.colorRoot, options.assetBase, options.autoRotoCacheRoot, false, undefined, fonts.bundledFaces,
          { physicalLayouts, requirePhysicalGlyphs: true, aggregateBudget }, { ...output, ...request.context, assProject: request.assProject, startFrame: request.startFrame }) });
      return typeof result === "object" && result !== null && nativeEffects ? { ...result, nativeEffects } : result;
    } finally {
      await removeRenderWorkDirectory(workspace);
    }
  });
}

export async function renderLongChunkIntermediateV2(request: LongChunkIntermediateRequestV1): Promise<LongChunkIntermediateResultV1> {
  const outputPath = resolve(request.outputPath), output = { kind: "display-ffv1-v1" } as const;
  if (extname(outputPath).toLowerCase() !== ".mkv") throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "a chunk intermediate must be an owned .mkv", { outputPath });
  const exists = await stat(outputPath).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (exists) throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "a chunk intermediate must not exist yet", { outputPath });
  return withPreparedChunk(request, output, async ({ workspace, project, render, duration }) => {
    const temporary = join(workspace, "display-chunk.mkv");
    await render(temporary);
    const policy = compositeChunkOutputPlanV1(project, duration, "ffv1", false, output);
    const { stdout } = await runProcess(request.options.ffprobePath ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
      "stream=codec_name,width,height,pix_fmt,nb_read_packets,color_space,color_range,color_primaries,color_transfer", "-of", "json", temporary], request.timeoutMs, { completeStdoutMaxChars: 64 * 1024 });
    const stream = JSON.parse(stdout).streams?.[0];
    const tag = (name: string) => policy.metadataArgs[policy.metadataArgs.indexOf(name) + 1];
    if (stream?.codec_name !== "ffv1" || stream.width !== project.width || stream.height !== project.height || stream.pix_fmt !== policy.pixelFormat
      || Number(stream.nb_read_packets) !== policy.frameCount || stream.color_range !== "tv" || stream.color_space !== tag("-colorspace")
      || stream.color_primaries !== tag("-color_primaries") || stream.color_transfer !== tag("-color_trc")) {
      throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "the lossless display chunk does not match its pixel/frame/color contract", { stream, policy });
    }
    const bytes = (await stat(temporary)).size;
    assertRenderActive();
    // The caller owns both paths inside the run directory: create-only publication, never overwrite a raced-in file.
    await link(temporary, outputPath);
    return { schema: "editkin.long-chunk-intermediate/v1", outputPath, codec: "ffv1", container: "matroska", pixelFormat: policy.pixelFormat,
      width: project.width, height: project.height, frameRate: policy.frameRate, frameCount: policy.frameCount, durationSeconds: duration,
      bytes, planner: "editkin-long-chunk-display-ffv1/v2" };
  });
}

/** Internal WP-B producer. The parent LONG run owns its guard/journal and must provide its current D work root. */
export async function renderLongChunkRawV1(request: ChunkRequest & { sink: RawVideoSinkV1 }) {
  const root = currentRenderWorkRoot() ?? request.options.workRoot;
  if (!root) throw new LongRenderRefusalV1("LONG_RENDER_WORK_ROOT_UNAVAILABLE", "a raw chunk requires the parent LONG run's explicit work root");
  const selected = await selectLongRenderWorkRootV1({ outputPath: join(root, "unused-raw-chunk.mp4"), configuredRoot: root,
    probe: request.options.longRender?.probe ?? probeVolumeSpace });
  let frames = 0;
  const output: CompositeChunkOutputV1 = { kind: "raw-video-v1", sink: { signal: request.sink.signal,
    async onFrame(frame, index, signal) { await request.sink.onFrame(frame, index, signal); frames++; } } };
  return runWithRenderWorkRootV1(selected.root, () => withPreparedChunk(request, output, async ({ project, render, duration }) => {
    const policy = compositeChunkOutputPlanV1(project, duration, "ffv1", false, output);
    await render("pipe:1");
    return { schema: "editkin.long-chunk-raw/v1" as const, width: project.width, height: project.height, pixelFormat: policy.pixelFormat,
      frameRate: policy.frameRate, frameCount: frames, bytes: frames * policy.frameBytes, durationSeconds: duration,
      maximumPendingFrames: 1 as const, videoStagingBytes: 0 as const, planner: "editkin-long-chunk-raw/v1" as const };
  }));
}

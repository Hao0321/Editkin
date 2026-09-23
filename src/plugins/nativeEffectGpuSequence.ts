import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { EditProject, TimelineClip } from "../domain/types";
import type { NativeEffectRenderRuntime } from "./nativeEffectTypes";
export * from "./nativeEffectGpuHelpers";
import { sha256File } from "./nativeEffectGpuHelpers";
import type { GpuAdjustmentExecution, GpuEffectSequenceResult, GpuParticleExecution } from "./nativeEffectGpuHelpers";

export async function renderGpuEffectSequence(
  graph: Record<string, unknown>,
  assetBindings: Record<string, string>,
  effectBindings: unknown,
  expectedProgramCount: number,
  frameCount: number,
  frameDirectory: string,
  runtime: NativeEffectRenderRuntime,
  execution: {
    timelineStartFrame?: number;
    compositeTimelineRange?: { startFrame: number; endFrame: number; overlayClipId?: string; suppressOverlayClipInProject?: boolean };
    compositeTimelineRanges?: Array<{ startFrame: number; endFrame: number; overlayClipId: string; suppressOverlayClipInProject?: boolean }>;
    typography?: { captionCueIds: string[]; motionGraphicIds: string[] };
    adjustment?: GpuAdjustmentExecution;
    adjustments?: GpuAdjustmentExecution[];
    particle?: GpuParticleExecution;
    particles?: GpuParticleExecution[];
    matte?: {
      sourceClipId: string;
      targetClipId: string;
      sourceNodeId: string;
      targetNodeId: string;
      mode: "alpha" | "alpha_inverted" | "luma" | "luma_inverted";
      targetTimelineStartFrame: number;
      targetDurationFrames: number;
    };
  } = {},
): Promise<GpuEffectSequenceResult> {
  const executable = runtime.gpuCompositorPath;
  if (!executable) throw new Error("GPU effect graph 正式輸出缺少 GPU compositor runtime");
  const graphPath = join(frameDirectory, "graph.json");
  const assetBindingsPath = join(frameDirectory, "assets.json");
  const effectBindingsPath = join(frameDirectory, "effects.json");
  await mkdir(frameDirectory, { recursive: true });
  await Promise.all([
    writeFile(graphPath, `${JSON.stringify(graph)}\n`, "utf8"),
    writeFile(assetBindingsPath, `${JSON.stringify(assetBindings)}\n`, "utf8"),
    writeFile(effectBindingsPath, `${JSON.stringify(effectBindings)}\n`, "utf8"),
  ]);
  const child = spawn(executable, ["serve"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(runtime.fontRoot ? { EDITKIN_FONT_ROOT: runtime.fontRoot } : {}) },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<string, (message: Record<string, unknown>) => void>();
  let stderr = "";
  let sequence = 0;
  let readyResolve: ((value: Record<string, unknown>) => void) | undefined;
  let readyReject: ((reason: Error) => void) | undefined;
  const ready = new Promise<Record<string, unknown>>((resolvePromise, reject) => { readyResolve = resolvePromise; readyReject = reject; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-100_000); });
  child.once("error", (error) => readyReject?.(error));
  child.once("exit", (code) => {
    if (code && code !== 0) readyReject?.(new Error(`GPU compositor exit ${code}: ${stderr.slice(-4_000)}`));
  });
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (message.event === "ready") { readyResolve?.(message); return; }
    const id = typeof message.id === "string" ? message.id : "";
    pending.get(id)?.(message);
    pending.delete(id);
  });
  const request = (command: string, payload: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const id = `formal-gpu-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} 逾時：${stderr.slice(-4_000)}`)); }, Math.min(runtime.timeoutMs, 60_000));
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.ok === true) resolvePromise(message.result as Record<string, unknown>);
      else reject(new Error(`${command} 失敗：${String(message.error ?? "unknown GPU error")}`));
    });
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
  });
  const sessionId = `formal-${process.pid}-${Date.now()}`;
  const timelineStartFrame = execution.timelineStartFrame ?? 0;
  const compositeTimelineRanges = execution.compositeTimelineRanges
    ?? (execution.compositeTimelineRange ? [{ ...execution.compositeTimelineRange, overlayClipId: execution.compositeTimelineRange.overlayClipId ?? "" }] : []);
  const adjustmentExecutions = execution.adjustments ?? (execution.adjustment ? [execution.adjustment] : []);
  const particleExecutions = execution.particles ?? (execution.particle ? [execution.particle] : []);
  let loaded = false;
  const expectsDecodedTemporal = (graph.nodes as Array<Record<string, unknown>>).some((node) => node.kind === "motion_blur" && node.sourceSampling === "decoded_temporal");
  const temporalReceipts: Array<{ distinctDecodedTimestampCount: number; residentFrameRingSize: number; residentBytes: number }> = [];
  const compositeExecutionModes: Array<"dirty-rect-ping-pong/v1" | "fused-four-layer/v1"> = [];
  let framesWithActiveCaptions = 0;
  let framesWithActiveMotionGraphics = 0;
  let framesWithActiveAdjustments = 0;
  let totalAdjustmentPasses = 0;
  const adjustmentActiveCounts: number[] = [];
  const adjustmentBaseLayerCounts: number[] = [];
  let framesWithActiveParticles = 0;
  let totalParticleEmitterPasses = 0;
  const particleActiveCounts: number[] = [];
  let maximumParticleGpuTextureWrites = 0;
  let framesWithActiveMatteTargets = 0;
  const adjustmentNodeIdsByClip: Record<string, string[]> = {};
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`GPU compositor ready 逾時：${stderr.slice(-4_000)}`)), Math.min(runtime.timeoutMs, 60_000));
      timer.unref();
    })]);
    await request("surface_bind", { parentHwnd: "0", x: 0, y: 0, width: 64, height: 36 });
    const load = await request("engine_video_load", { sessionId, graphPath, bindingsPath: assetBindingsPath, effectBindingsPath, timelineFrame: timelineStartFrame });
    loaded = true;
    const gpuEffects = load.gpuEffects as { resolved?: boolean; count?: number; programs?: Array<{ nodeId?: string; pluginIdentity?: string; programSha256?: string; shaderOpCount?: number }> } | undefined;
    const programs = gpuEffects?.programs ?? [];
    if (gpuEffects?.resolved !== true || gpuEffects.count !== expectedProgramCount || programs.length !== expectedProgramCount
      || expectedProgramCount < 0 || expectedProgramCount > 4
      || programs.some((program) => typeof program.nodeId !== "string" || typeof program.pluginIdentity !== "string"
        || !/^[a-f0-9]{64}$/.test(program.programSha256 ?? "")
        || !Number.isSafeInteger(program.shaderOpCount) || program.shaderOpCount! < 1 || program.shaderOpCount! > 4)
      || programs.reduce((total, program) => total + program.shaderOpCount!, 0) > 16) {
      throw new Error("GPU effect graph 正式輸出沒有取得已解析 program receipt");
    }
    const graphNodes = graph.nodes as Array<Record<string, unknown>>;
    const captionNodes = graphNodes.filter((node) => node.kind === "caption");
    const motionGraphicNodes = graphNodes.filter((node) => node.kind === "motion_graphic");
    if (particleExecutions.length) {
      const vfxSimulation = load.vfxSimulation as Record<string, unknown> | undefined;
      const particleCeiling = particleExecutions.reduce((sum, particle) => sum + particle.particleCeiling, 0);
      const uniqueNodeIds = new Set(particleExecutions.map((particle) => particle.nodeId));
      if (particleExecutions.length > 4 || uniqueNodeIds.size !== particleExecutions.length
        || load.particleCount !== particleExecutions.length || load.particleTexturesResident !== particleExecutions.length
        || vfxSimulation?.simulationContract !== "screen_space_analytic_particles/v1"
        || vfxSimulation.emitterCount !== particleExecutions.length
        || vfxSimulation.particleCeiling !== particleCeiling
        || vfxSimulation.timeSource !== "rational_node_local_frame"
        || vfxSimulation.executor !== "wgpu-resident-video-particle-overlay/v1") {
        throw new Error("GPU effect graph 正式輸出沒有取得完整 resident particle load receipt");
      }
    }
    if (execution.matte) {
      const loadedLayers = (load.layers as Array<Record<string, unknown>> | undefined) ?? [];
      const loadedSource = loadedLayers[0];
      const loadedTarget = loadedLayers[1];
      const resourcePlan = load.resourcePlan as Record<string, unknown> | undefined;
      if (load.layerCount !== 2 || load.matteCount !== 1 || load.compositeMode !== "typed-track-matte/v1"
        || resourcePlan?.matteCount !== 1 || loadedLayers.length !== 2
        || loadedSource?.sourceNodeId !== execution.matte.sourceNodeId
        || loadedTarget?.sourceNodeId !== execution.matte.targetNodeId
        || loadedTarget?.matteLayerIndex !== 0 || loadedTarget?.matteMode !== execution.matte.mode
        || (loadedSource?.motionBlur as Record<string, unknown> | undefined)?.sourceSampling !== "decoded_temporal") {
        throw new Error("GPU effect graph 正式輸出沒有取得完整 decoded-temporal track matte load receipt");
      }
    }
    if (adjustmentExecutions.length) {
      const expectedAdjustmentMode = adjustmentExecutions[0].executionMode ?? "trailing-full-frame/v1";
      const expectedPlacement = expectedAdjustmentMode === "pre-typography-full-frame/v1" ? "before-typography/v1" : "trailing/v1";
      const expectedCompositeMode = expectedAdjustmentMode === "pre-typography-full-frame/v1" ? "video-pre-typography-adjustment/v1" : "video-trailing-adjustment/v1";
      const loadedAdjustments = (load.adjustments as Array<Record<string, unknown>> | undefined) ?? [];
      const uniqueClipIds = new Set(adjustmentExecutions.map((adjustment) => adjustment.clipId));
      if (adjustmentExecutions.length > 2 || uniqueClipIds.size !== adjustmentExecutions.length
        || adjustmentExecutions.some((adjustment) => (adjustment.executionMode ?? "trailing-full-frame/v1") !== expectedAdjustmentMode)
        || load.adjustmentCount !== adjustmentExecutions.length || loadedAdjustments.length !== adjustmentExecutions.length
        || load.adjustmentPlacement !== expectedPlacement || load.compositeMode !== expectedCompositeMode) {
        throw new Error("GPU effect graph 正式輸出沒有取得完整調整圖層順序與 load receipt");
      }
      for (let index = 0; index < adjustmentExecutions.length; index += 1) {
        const expected = adjustmentExecutions[index];
        const loaded = loadedAdjustments[index];
        const timeline = loaded?.timeline as Record<string, unknown> | undefined;
        const nodeIds = Array.isArray(loaded?.nodeIds)
          ? loaded.nodeIds.filter((id): id is string => typeof id === "string") : [];
        if (nodeIds.length < 2 || !nodeIds.includes(expected.adjustmentNodeId)
          || timeline?.timelineStartFrame !== expected.timelineStartFrame
          || timeline.durationFrames !== expected.durationFrames) {
          throw new Error(`GPU effect graph 正式輸出調整圖層 ${expected.clipId} 的順序或 timeline receipt 不完整`);
        }
        adjustmentNodeIdsByClip[expected.clipId] = nodeIds;
      }
    }
    if (execution.typography) {
      const loadedCaptions = (load.captions as Array<Record<string, unknown>> | undefined) ?? [];
      const loadedMotionGraphics = (load.motionGraphics as Array<Record<string, unknown>> | undefined) ?? [];
      if (load.captionCount !== execution.typography.captionCueIds.length
        || load.motionGraphicCount !== execution.typography.motionGraphicIds.length
        || load.captionTextureUploads !== execution.typography.captionCueIds.length
        || load.motionGraphicTextureUploads !== execution.typography.motionGraphicIds.length
        || loadedCaptions.length !== execution.typography.captionCueIds.length
        || loadedMotionGraphics.length !== execution.typography.motionGraphicIds.length
        || loadedCaptions.some((caption) => caption.singleTextColor !== true || caption.missingGlyphCount !== 0 || caption.textureUploadCount !== 1)
        || loadedMotionGraphics.some((graphic) => graphic.missingGlyphCount !== 0 || graphic.textureUploadCount !== 1)
        || execution.typography.captionCueIds.some((id) => !loadedCaptions.some((caption) => caption.cueId === id))
        || execution.typography.motionGraphicIds.some((id) => !loadedMotionGraphics.some((graphic) => graphic.graphicId === id))) {
        throw new Error("GPU effect graph 正式輸出沒有取得完整單色字幕／動態圖卡 load receipt");
      }
    }
    for (let frame = 0; frame < frameCount; frame += 1) {
      const outputPath = join(frameDirectory, `frame-${String(frame).padStart(8, "0")}.png`);
      const receipt = await request("engine_video_verify_frame", {
        sessionId, timelineFrame: timelineStartFrame + frame, toleranceSeconds: .5 / Number((graph.timebase as { denominator: number }).denominator), outputPath,
      });
      if (receipt.outputWritten !== true || receipt.productPathCpuPixelCopies !== 0 || receipt.verificationReadback !== true) {
        throw new Error(`GPU effect graph 正式輸出 frame ${frame} receipt 不完整`);
      }
      if (expectsDecodedTemporal) {
        const temporal = receipt.temporalSampling as Record<string, unknown> | undefined;
        if (temporal?.contract !== "decoded-temporal-shutter-accumulation/v1"
          || temporal.sourceSampling !== "decoded_temporal"
          || temporal.sampleCount !== Number((graph.nodes as Array<Record<string, unknown>>).find((node) => node.kind === "motion_blur")?.samples)
          || !Number.isSafeInteger(temporal.distinctDecodedTimestampCount) || Number(temporal.distinctDecodedTimestampCount) < 1
          || !Number.isSafeInteger(temporal.residentFrameRingSize) || Number(temporal.residentFrameRingSize) < Number(temporal.sampleCount)
          || !Number.isSafeInteger(temporal.residentBytes) || Number(temporal.residentBytes) <= 0
          || temporal.productPathCpuPixelCopies !== 0) {
          throw new Error(`GPU effect graph 正式輸出 frame ${frame} 缺少 decoded temporal receipt`);
        }
        temporalReceipts.push({
          distinctDecodedTimestampCount: Number(temporal.distinctDecodedTimestampCount),
          residentFrameRingSize: Number(temporal.residentFrameRingSize),
          residentBytes: Number(temporal.residentBytes),
        });
      }
      const absoluteTimelineFrame = timelineStartFrame + frame;
      const activeCompositeRanges = compositeTimelineRanges.filter((range) => absoluteTimelineFrame >= range.startFrame && absoluteTimelineFrame < range.endFrame);
      const expectsComposite = activeCompositeRanges.length > 0;
      if (execution.typography) {
        const activeNodeIds = (nodes: Array<Record<string, unknown>>, identity: string) => nodes.filter((node) => {
          const timeline = node.timeline as { timelineStartFrame?: number; durationFrames?: number } | undefined;
          return Number.isSafeInteger(timeline?.timelineStartFrame) && Number.isSafeInteger(timeline?.durationFrames)
            && absoluteTimelineFrame >= timeline!.timelineStartFrame!
            && absoluteTimelineFrame < timeline!.timelineStartFrame! + timeline!.durationFrames!;
        }).map((node) => String(node[identity]));
        const expectedCaptionIds = activeNodeIds(captionNodes, "cueId");
        const expectedGraphicIds = activeNodeIds(motionGraphicNodes, "graphicId");
        const activeCaptions = receipt.activeCaptions as Array<Record<string, unknown>> | undefined;
        const activeMotionGraphics = receipt.activeMotionGraphics as Array<Record<string, unknown>> | undefined;
        if (!activeCaptions || !activeMotionGraphics
          || activeCaptions.length !== expectedCaptionIds.length || activeMotionGraphics.length !== expectedGraphicIds.length
          || expectedCaptionIds.some((id) => !activeCaptions.some((caption) => caption.cueId === id && caption.singleTextColor === true))
          || expectedGraphicIds.some((id) => !activeMotionGraphics.some((graphic) => graphic.graphicId === id))) {
          throw new Error(`GPU effect graph 正式輸出 frame ${frame} 的字幕／動態圖卡 timeline receipt 不正確`);
        }
        if (activeCaptions.length) framesWithActiveCaptions += 1;
        if (activeMotionGraphics.length) framesWithActiveMotionGraphics += 1;
      }
      const expectedActiveParticles = particleExecutions.filter((particle) =>
        absoluteTimelineFrame >= particle.timelineStartFrame
        && absoluteTimelineFrame < particle.timelineStartFrame + particle.durationFrames);
      if (particleExecutions.length) {
        const activeParticles = receipt.activeParticleEmitters as Array<Record<string, unknown>> | undefined;
        if (!activeParticles || activeParticles.length !== expectedActiveParticles.length) {
          throw new Error(`GPU effect graph 正式輸出 frame ${frame} 的 particle timeline receipt 不正確：${JSON.stringify({ expectedActiveParticleIds: expectedActiveParticles.map((particle) => particle.nodeId), activeParticles })}`);
        }
        for (const expectedParticle of expectedActiveParticles) {
          const particle = activeParticles.find((candidate) => candidate.nodeId === expectedParticle.nodeId);
          if (!particle) throw new Error(`GPU effect graph 正式輸出 frame ${frame} 缺少 particle ${expectedParticle.nodeId}`);
          const particleTimeline = particle.timeline as Record<string, unknown> | undefined;
          const snapshot = particle.snapshotCache as Record<string, unknown> | undefined;
          const localFrame = absoluteTimelineFrame - expectedParticle.timelineStartFrame;
          const timebase = graph.timebase as { numerator: number; denominator: number };
          const expectedTime = localFrame * timebase.numerator / timebase.denominator;
          if (particle.nodeId !== expectedParticle.nodeId
            || particle.timelineFrame !== absoluteTimelineFrame || particle.localFrame !== localFrame
            || particleTimeline?.timelineStartFrame !== expectedParticle.timelineStartFrame
            || particleTimeline.sourceStartFrame !== 0 || particleTimeline.durationFrames !== expectedParticle.durationFrames
            || typeof particle.timeSeconds !== "number" || Math.abs(particle.timeSeconds - expectedTime) > 1e-5
            || particle.seed !== expectedParticle.seed || particle.particleCeiling !== expectedParticle.particleCeiling
            || particle.executor !== "wgpu-resident-video-particle-overlay/v1"
            || !Number.isSafeInteger(particle.gpuTextureWrites) || Number(particle.gpuTextureWrites) < 1
            || particle.uniformParameterWrites !== particle.gpuTextureWrites
            || particle.cpuPixelUploads !== 0 || particle.cpuPixelReadbacks !== 0
            || particle.queueSubmissionMode !== "ordered-same-device/v1"
            || snapshot?.schema !== "editkin.resident-particle-seek-snapshot/v1"
            || snapshot.capacity !== 2 || typeof snapshot.hit !== "boolean"
            || snapshot.computeTextureWrites !== particle.gpuTextureWrites
            || snapshot.snapshotCopies !== snapshot.computeTextureWrites
            || !Number.isSafeInteger(snapshot.hits) || Number(snapshot.hits) < 0
            || !Number.isSafeInteger(snapshot.misses) || Number(snapshot.misses) < 1
            || Number(snapshot.hits) + Number(snapshot.misses) < 1
            || snapshot.cpuPixelCopies !== 0) {
            throw new Error(`GPU effect graph 正式輸出 frame ${frame} 的 resident particle receipt 不完整`);
          }
          maximumParticleGpuTextureWrites = Math.max(maximumParticleGpuTextureWrites, Number(particle.gpuTextureWrites));
        }
        if (expectedActiveParticles.length) {
          framesWithActiveParticles += 1;
          totalParticleEmitterPasses += expectedActiveParticles.length;
          particleActiveCounts.push(expectedActiveParticles.length);
        }
      }
      if (adjustmentExecutions.length) {
        const expectedAdjustmentMode = adjustmentExecutions[0].executionMode ?? "trailing-full-frame/v1";
        const expectedActive = adjustmentExecutions.filter((adjustment) => absoluteTimelineFrame >= adjustment.timelineStartFrame
          && absoluteTimelineFrame < adjustment.timelineStartFrame + adjustment.durationFrames);
        const activeAdjustments = receipt.activeAdjustments as Array<Record<string, unknown>> | undefined;
        const expectedBaseLayerCount = adjustmentExecutions[0].baseLayerCountByCompositeActivity || particleExecutions.length
          ? 1 + activeCompositeRanges.length + expectedActiveParticles.length
          : (adjustmentExecutions[0].baseLayerCount ?? 1);
        if (!activeAdjustments
          || activeAdjustments.length !== expectedActive.length
          || receipt.adjustmentPassCount !== expectedActive.length
          || expectedActive.some((adjustment, index) => {
            const activeNodeIds = Array.isArray(activeAdjustments[index]?.nodeIds)
              ? activeAdjustments[index].nodeIds.filter((id): id is string => typeof id === "string") : [];
            const expectedNodeIds = adjustmentNodeIdsByClip[adjustment.clipId] ?? [];
            return activeNodeIds.length !== expectedNodeIds.length || activeNodeIds.some((id, nodeIndex) => id !== expectedNodeIds[nodeIndex]);
          })
          || (expectedActive.length > 0 && (receipt.adjustmentExecutionMode !== expectedAdjustmentMode
            || (expectedAdjustmentMode === "pre-typography-full-frame/v1" && receipt.adjustmentBaseLayerCount !== expectedBaseLayerCount)
          ))) {
          throw new Error(`GPU effect graph 正式輸出 frame ${frame} 的調整圖層順序／timeline receipt 不正確`);
        }
        if (expectedActive.length) {
          framesWithActiveAdjustments += 1;
          totalAdjustmentPasses += expectedActive.length;
          adjustmentActiveCounts.push(expectedActive.length);
          adjustmentBaseLayerCounts.push(expectedBaseLayerCount);
        }
      }
      if (execution.matte) {
        const expectedActive = absoluteTimelineFrame >= execution.matte.targetTimelineStartFrame
          && absoluteTimelineFrame < execution.matte.targetTimelineStartFrame + execution.matte.targetDurationFrames;
        const layers = (receipt.layers as Array<Record<string, unknown>> | undefined) ?? [];
        const source = layers[0];
        const target = layers[1];
        if (layers.length !== (expectedActive ? 2 : 1)
          || source?.sourceNodeId !== execution.matte.sourceNodeId
          || (expectedActive && (target?.sourceNodeId !== execution.matte.targetNodeId
            || target.matteLayerIndex !== 0 || target.matteMode !== execution.matte.mode
            || receipt.mattePassCount !== 1 || receipt.matteExecutionMode !== "sampled-track-matte/v1"))
          || (!expectedActive && Number(receipt.mattePassCount ?? 0) !== 0)) {
          throw new Error(`GPU effect graph 正式輸出 frame ${frame} 的 decoded-temporal track matte receipt 不正確`);
        }
        if (expectedActive) framesWithActiveMatteTargets += 1;
      }
      if (expectsComposite) {
        const layers = receipt.layers as unknown[] | undefined;
        const composite = receipt as { compositeLayerCount?: unknown; compositeExecutionMode?: unknown };
        const mode = composite.compositeExecutionMode;
        const expectedVideoLayerCount = 1 + activeCompositeRanges.length;
        const expectedSurfaceCount = expectedVideoLayerCount
          + (((receipt.activeCaptions as unknown[] | undefined) ?? []).length)
          + (((receipt.activeMotionGraphics as unknown[] | undefined) ?? []).length)
          + (((receipt.activeParticleEmitters as unknown[] | undefined) ?? []).length);
        if (layers?.length !== expectedVideoLayerCount
          || composite.compositeLayerCount !== expectedSurfaceCount
          || (mode !== "dirty-rect-ping-pong/v1" && mode !== "fused-four-layer/v1")) {
          throw new Error(`GPU effect graph 正式輸出 frame ${frame} 缺少多影片合成 receipt：${JSON.stringify({ layerCount: layers?.length, expectedVideoLayerCount, expectedSurfaceCount, composite })}`);
        }
        compositeExecutionModes.push(mode);
      } else if (compositeTimelineRanges.length && (receipt.layers as unknown[] | undefined)?.length !== 1) {
        throw new Error(`GPU effect graph 正式輸出 frame ${frame} 的 overlay timeline receipt 不正確`);
      }
    }
    return {
      executableSha256: await sha256File(executable),
      stackSha256: createHash("sha256").update(JSON.stringify(programs)).digest("hex"),
      programs: programs as GpuEffectSequenceResult["programs"],
      firstFrameSha256: await sha256File(join(frameDirectory, "frame-00000000.png")),
      lastFrameSha256: await sha256File(join(frameDirectory, `frame-${String(frameCount - 1).padStart(8, "0")}.png`)),
      temporalSampling: expectsDecodedTemporal ? {
        contract: "decoded-temporal-shutter-accumulation/v1",
        sourceSampling: "decoded_temporal",
        framesWithReceipt: temporalReceipts.length,
        maximumDistinctDecodedTimestampCount: Math.max(...temporalReceipts.map((receipt) => receipt.distinctDecodedTimestampCount)),
        residentFrameRingSize: temporalReceipts[0]?.residentFrameRingSize ?? 0,
        residentBytes: temporalReceipts[0]?.residentBytes ?? 0,
        productPathCpuPixelCopies: 0,
      } : undefined,
      composite: compositeTimelineRanges.length ? {
        contract: "decoded-temporal-video-overlay/v1",
        layerCount: 1 + Math.max(...Array.from({ length: frameCount }, (_, frame) => compositeTimelineRanges.filter((range) => timelineStartFrame + frame >= range.startFrame && timelineStartFrame + frame < range.endFrame).length)),
        overlayClipIds: compositeTimelineRanges.filter((range) => range.overlayClipId && range.suppressOverlayClipInProject).map((range) => range.overlayClipId),
        timelineRanges: compositeTimelineRanges.filter((range) => range.overlayClipId).map((range) => ({
          clipId: range.overlayClipId,
          timelineStartFrame: range.startFrame,
          durationFrames: range.endFrame - range.startFrame,
          fullyMaterialized: range.suppressOverlayClipInProject === true,
        })),
        framesWithReceipt: compositeExecutionModes.length,
        executionMode: compositeExecutionModes[0]!,
        productPathCpuPixelCopies: 0,
      } : undefined,
      typography: execution.typography ? {
        contract: "decoded-temporal-typography-overlays/v1",
        captionCueIds: [...execution.typography.captionCueIds],
        motionGraphicIds: [...execution.typography.motionGraphicIds],
        captionTextureUploads: execution.typography.captionCueIds.length,
        motionGraphicTextureUploads: execution.typography.motionGraphicIds.length,
        framesWithActiveCaptions,
        framesWithActiveMotionGraphics,
        singleColourCaptions: true,
        productPathCpuPixelCopies: 0,
      } : undefined,
      adjustment: adjustmentExecutions.length ? {
        contract: adjustmentExecutions[0].contract ?? "decoded-temporal-trailing-adjustment/v1",
        adjustmentClipIds: adjustmentExecutions.map((adjustment) => adjustment.clipId),
        nodeIdsByClip: Object.fromEntries(adjustmentExecutions.map((adjustment) => [adjustment.clipId, [...adjustmentNodeIdsByClip[adjustment.clipId]]] )),
        timelineRanges: adjustmentExecutions.map((adjustment) => ({
          clipId: adjustment.clipId,
          timelineStartFrame: adjustment.timelineStartFrame,
          durationFrames: adjustment.durationFrames,
        })),
        framesWithActiveAdjustments,
        totalAdjustmentPasses,
        minimumActiveAdjustmentCount: adjustmentActiveCounts.length ? Math.min(...adjustmentActiveCounts) : 0,
        maximumActiveAdjustmentCount: adjustmentActiveCounts.length ? Math.max(...adjustmentActiveCounts) : 0,
        executionMode: adjustmentExecutions[0].executionMode ?? "trailing-full-frame/v1",
        baseLayerCount: adjustmentBaseLayerCounts.length ? Math.max(...adjustmentBaseLayerCounts) : adjustmentExecutions[0].baseLayerCount ?? 1,
        minimumBaseLayerCount: adjustmentBaseLayerCounts.length ? Math.min(...adjustmentBaseLayerCounts) : adjustmentExecutions[0].baseLayerCount ?? 1,
        maximumBaseLayerCount: adjustmentBaseLayerCounts.length ? Math.max(...adjustmentBaseLayerCounts) : adjustmentExecutions[0].baseLayerCount ?? 1,
        productPathCpuPixelCopies: 0,
      } : undefined,
      particle: particleExecutions.length ? {
        contract: particleExecutions.length === 1 ? "decoded-temporal-particle-overlay/v1" : "decoded-temporal-multi-particle-overlay/v1",
        simulationContract: "screen_space_analytic_particles/v1",
        emitterNodeIds: particleExecutions.map((particle) => particle.nodeId),
        timelineRanges: particleExecutions.map((particle) => ({
          nodeId: particle.nodeId,
          timelineStartFrame: particle.timelineStartFrame,
          durationFrames: particle.durationFrames,
        })),
        framesWithActiveParticles,
        totalParticleEmitterPasses,
        minimumActiveEmitterCount: particleActiveCounts.length ? Math.min(...particleActiveCounts) : 0,
        maximumActiveEmitterCount: particleActiveCounts.length ? Math.max(...particleActiveCounts) : 0,
        particleCeiling: particleExecutions.reduce((sum, particle) => sum + particle.particleCeiling, 0),
        maximumGpuTextureWrites: maximumParticleGpuTextureWrites,
        executionMode: "resident-analytic-overlay/v1",
        productPathCpuPixelCopies: 0,
      } : undefined,
      matte: execution.matte ? {
        contract: "decoded-temporal-track-matte/v1",
        sourceClipId: execution.matte.sourceClipId,
        targetClipIds: [execution.matte.targetClipId],
        sourceNodeId: execution.matte.sourceNodeId,
        targetNodeIds: { [execution.matte.targetClipId]: execution.matte.targetNodeId },
        mode: execution.matte.mode,
        framesWithActiveMatteTargets,
        executionMode: "sampled-track-matte/v1",
        productPathCpuPixelCopies: 0,
      } : undefined,
    };
  } finally {
    if (loaded) await request("engine_video_release", { sessionId }).catch(() => undefined);
    await request("surface_release").catch(() => undefined);
    await request("shutdown").catch(() => undefined);
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 1_000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
        child.kill();
      });
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

/** Materializes enabled third-party native effects into lossless, video-only
 * intermediates. Audio remains bound to the original source in RenderPlan. */

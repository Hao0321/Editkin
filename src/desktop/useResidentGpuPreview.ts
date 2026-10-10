import { useEffect, useMemo, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import {
  buildGpuRenderGraph,
  buildGpuVideoPreviewSource,
  gpuLayerPropertyBuffer,
  nativeMediaPath,
  type GpuEnginePreviewGraph,
  type GpuEngineVideoPreviewGraph,
  type GpuRenderGraph,
  type GpuVideoPreviewSource,
} from "../render/gpuCompositor";
import {
  expectedEngineVideoAdjustments,
  expectedEngineVideoCaptions,
  expectedEngineVideoControllers,
  expectedEngineVideoLayers,
  expectedEngineVideoMotionGraphics,
  expectedEngineVideoParticles,
  imageStructureKey,
} from "./residentGpuPreviewExpectations";
import {
  adjustmentActiveAt,
  adjustmentReceiptMatches,
  controllerReceiptMatches,
  engineVisualMatches,
  motionBlurReceiptMatches,
  temporalSamplingReceiptMatches,
} from "./residentGpuPreviewValidation";
import {
  boundsKey,
  captionActiveAt,
  captionReceiptMatches,
  depthOfFieldCoverageMatches,
  legacySdrNativeSurfaceValid,
  legacyVideoFallbackAllowed,
  matteExecutionReceiptMatches,
  motionGraphicExpectedSample,
  motionGraphicReceiptMatches,
  nativeAces2PreviewLoadTransform,
  nativeAces2PreviewSurfaceValid,
  particleActiveAt,
  sceneLinearAces2Output,
  sameF32,
  sceneLinearAces2PresentContractValid,
  sceneLinearCompositeReceiptMatches,
  sceneLinearEffectReceiptMatches,
  scene25dCoverageMatches,
  vfxSimulationCoverageMatches,
  videoParticleReceiptMatches,
} from "./residentGpuPreviewReceipts";
import { presentResidentEngineVideo, type ResidentEngineVideoBakedIds } from "./residentGpuEngineVideoPresenter";
import { renderResidentEngineVideoPng } from "./residentGpuEngineVideoFrameRenderer";
import { offscreenCompositionPreviewGraphSupported as supportsOffscreenCompositionPreview } from "./offscreenCompositionPreviewReceipt";
import { ImmutableDecodedPngFrameHolder } from "./immutableDecodedPngFrame";
import { acquireResidentGpuGraphPreparation, prepareResidentGpuGraphs, residentProjectNeedsNativeMotionPaint, sampleResidentGpuGraph,
  type PreparedResidentGpuGraphs, type ResidentGpuGraphPreparationLease } from "./residentGpuGraphPreparation";
import { ResidentGpuPreviewGeneration, RetiredGpuPreview } from "./residentGpuPreviewGeneration";
import type { NativePreviewBounds } from "./residentGpuPreviewTypes";
import type { ResidentPlaybackTicket, PausedNativeFrame } from "./residentGpuPlayback";
import { projectMayContainAudio, type NativeAudioTransportState } from "./useNativeAudioPreviewPlayback";
export { legacySdrNativeSurfaceValid } from "./residentGpuPreviewReceipts";
export type { NativePreviewBounds } from "./residentGpuPreviewTypes";
export interface ResidentGpuPreviewState {
  frameUrl?: string;
  nativeSurfaceActive: boolean;
  fullComposition: boolean;
  onImagePresented: (url: string) => void;
  onImageRejected: (url: string) => void;
  admission: "disabled" | "engine-image" | "engine-video-native" | "engine-video-frame" | "image" | "video-native" | "video-frame" | "compatible";
  fallbackReason?: string;
  admissionDiagnostic?: string;
  autonomousPlayback: boolean;
  nativePlaybackPreparing: boolean;
  /** Last receipt-validated native frame, never the most recent requested frame. */
  presentedTimelineFrame?: number;
  nativeFrameUpdating: boolean;
  /** Exact current graph IDs, published only after a validated native frame. */
  bakedMotionGraphicIds: readonly string[];
  bakedCaptionIds: readonly string[];
}
export interface ResidentGpuTransport {
  playing: boolean;
  duration: number;
  seekRevision: number;
  audio?: NativeAudioTransportState;
  onClock: (time: number) => void;
  onEnded: () => void;
}
interface PendingPlayback { ticket: ResidentPlaybackTicket; endFrame: number; audioGeneration?: number; audioOwnerId?:number; transport: ResidentGpuTransport }
interface PendingPause { result: Promise<PausedNativeFrame | undefined>; transport: ResidentGpuTransport }
type PendingFrame =
  | { kind: "engine-image"; preview: GpuEnginePreviewGraph; token: number }
  | { kind: "engine-video"; preview: GpuEngineVideoPreviewGraph; token: number; fps: number; nativeBounds: NativePreviewBounds; playback?: PendingPlayback; pause?: PendingPause }
  | { kind: "engine-video-frame"; preview: GpuEngineVideoPreviewGraph; token: number }
  | { kind: "image"; graph: GpuRenderGraph; structureKey: string; token: number }
  | { kind: "video"; source: GpuVideoPreviewSource; token: number; fps: number; nativeBounds?: NativePreviewBounds };

export function useResidentGpuPreview(
  project: EditProject,
  playhead: number,
  enabled: boolean,
  nativeBounds?: NativePreviewBounds,
  transport?: ResidentGpuTransport,
): ResidentGpuPreviewState {
  const [frameUrl, publishFrameUrl] = useState<string>();
  const [nativeSurfaceActive, publishNativeSurfaceActive] = useState(false);
  const [admission, publishAdmission] = useState<ResidentGpuPreviewState["admission"]>(enabled ? "compatible" : "disabled");
  const [fallbackReason, publishFallbackReason] = useState<string>();
  const [admissionDiagnostic, publishAdmissionDiagnostic] = useState<string>();
  const [autonomousPlayback, publishAutonomousPlayback] = useState(false);
  const [nativePlaybackPreparing, publishNativePlaybackPreparing] = useState(false);
  const [presentedRequest, publishPresentedRequest] = useState<object>();
  const [presentedFrame, publishPresentedFrame] = useState<{ request: object; frame: number; token: number; value: ResidentEngineVideoBakedIds }>();
  const [requestedPresentation, publishRequestedPresentation] = useState<{ request: object; token: number }>();
  const [pngFrame, publishPngFrame] = useState<{request:object;token:number;frame:number;url:string;value:ResidentEngineVideoBakedIds}>();
  const [observedPreparation, publishPreparation] = useState<{ request: object; prepared?: PreparedResidentGpuGraphs; reason?: string }>();
  const failedPlaybackKey = useRef<string | undefined>(undefined);
  const generationRef = useRef<ResidentGpuPreviewGeneration<PendingFrame> | undefined>(undefined);
  const preparationRef = useRef<{ request: object; lease?: ResidentGpuGraphPreparationLease } | undefined>(undefined);
  const request = useMemo(() => ({}), [enabled, project, project.revision, project.updatedAt]);
  const requiresNativePaint = residentProjectNeedsNativeMotionPaint(project)
    || project.tracks.some(track => track.clips.some(clip => clip.floatingFrame));
  const synchronousPrepared = useMemo(() => enabled && !requiresNativePaint ? prepareResidentGpuGraphs(project) : undefined,
    [enabled, project, project.revision, project.updatedAt]);
  const owner = preparationRef.current;
  const prepared = synchronousPrepared ?? (observedPreparation?.request === request && owner?.request === request && owner.lease?.isActive()
    ? observedPreparation.prepared : undefined);
  const preparationReason = observedPreparation?.request === request ? observedPreparation.reason
    ?? (observedPreparation.prepared && !owner?.lease?.isActive() ? "實體字型 lease 已失效；請重新開啟專案" : undefined) : undefined;

  useEffect(() => {
    generationRef.current = new ResidentGpuPreviewGeneration(window.haoDesktop?.createGpuPreviewOwner);
    publishFrameUrl(undefined); publishNativeSurfaceActive(false); publishFallbackReason(undefined);
    publishAutonomousPlayback(false); failedPlaybackKey.current = undefined;
    publishNativePlaybackPreparing(false);
    publishPresentedRequest(undefined);
    publishPresentedFrame(undefined);
    publishPngFrame(undefined);
    publishRequestedPresentation(undefined);
    const controller = new AbortController(), preparationOwner: { request: object; lease?: ResidentGpuGraphPreparationLease } = { request };
    preparationRef.current = preparationOwner;
    if (enabled && requiresNativePaint) {
      preparationOwner.lease = acquireResidentGpuGraphPreparation(project, { signal: controller.signal,
        isCurrent: () => preparationRef.current === preparationOwner });
      void preparationOwner.lease.ready.then(value => {
        if (!controller.signal.aborted && preparationRef.current === preparationOwner && preparationOwner.lease?.isActive()) {
          publishPreparation({ request, prepared: value });
        }
      }, error => {
        if (!controller.signal.aborted && preparationRef.current === preparationOwner && !(error instanceof RetiredGpuPreview)) {
          publishPreparation({ request, reason: error instanceof Error ? error.message : String(error) });
        }
      });
    }
    return () => {
      controller.abort(); preparationOwner.lease?.dispose();
      if (preparationRef.current === preparationOwner) preparationRef.current = undefined;
      generationRef.current?.dispose(); generationRef.current = undefined;
    };
  }, [enabled, project, project.revision, project.updatedAt]);

  useEffect(() => {
    const desktop = window.haoDesktop;
    // Admission can temporarily disappear (e.g. hidden/minimized viewport).
    // A retired cohort is never reactivated; StrictMode also gets a fresh owner.
    const generation = generationRef.current?.active ? generationRef.current
      : (generationRef.current = new ResidentGpuPreviewGeneration(desktop?.createGpuPreviewOwner));
    const { imageSessionRef, videoSessionRef, engineVideoSessionRef,
      loadedImageStructureRef, loadedVideoStructureRef, loadedEngineVideoStructureRef,
      surfaceBoundsKeyRef, surfaceColorSpaceRef, surfaceBoundRef, pendingRef, runningRef, tokenRef } = generation;
    const setFrameUrl = (value: string | undefined) => { if (generation.active) publishFrameUrl(value); };
    const setNativeSurfaceActive = (value: boolean) => { if (generation.active) { publishNativeSurfaceActive(value); publishPresentedRequest(value ? request : undefined); } };
    const setAdmission = (value: ResidentGpuPreviewState["admission"]) => { if (generation.active) publishAdmission(value); };
    const setFallbackReason = (value: string | undefined) => { if (generation.active) publishFallbackReason(value); };
    const setAdmissionDiagnostic = (value: string) => { if (generation.active) publishAdmissionDiagnostic(value); };
    const enginePreview = sampleResidentGpuGraph(prepared?.image, playhead);
    const engineVideo = sampleResidentGpuGraph(prepared?.video, playhead);
    const graph = enabled && !requiresNativePaint && !enginePreview ? buildGpuRenderGraph(project, playhead) : undefined;
    const legacyVideoAllowed = !requiresNativePaint && legacyVideoFallbackAllowed(engineVideo?.graph);
    const video = enabled && !enginePreview && !graph && legacyVideoAllowed ? buildGpuVideoPreviewSource(project, playhead) : undefined;
    const token = tokenRef.current + 1;
    const canRenderImage = Boolean(
      graph && desktop?.loadGpuPreviewSession && desktop.updateGpuPreviewProperties && desktop.renderGpuPreviewFrame,
    );
    const canRenderEngineImage = Boolean(
      enginePreview && desktop?.loadGpuEnginePreviewSession && desktop.updateGpuEnginePreviewFrame
        && desktop.renderGpuPreviewFrame && desktop.releaseGpuPreviewSession,
    );
    const canRenderEngineVideo = Boolean(
      engineVideo && nativeBounds && nativeBounds.width >= 2 && nativeBounds.height >= 2
        && prepared?.nativeSurfaceSafe
        && desktop?.loadGpuEngineVideoPreviewSession && desktop.presentGpuEngineVideoPreviewFrame
        && desktop.releaseGpuEngineVideoPreviewSession && desktop.bindGpuPreviewSurface
        && desktop.releaseGpuPreviewSurface,
    );
    const canRenderEngineVideoFrame = Boolean(engineVideo && supportsOffscreenCompositionPreview(engineVideo.graph)
      && desktop?.gpuEngineStatus && desktop.loadGpuEngineVideoFramePreviewSession && desktop.renderGpuEngineVideoPreviewFrame
      && desktop.releaseGpuEngineVideoPreviewSession && desktop.releaseGpuPreviewSurface);
    const canRenderVideo = Boolean(
      video && desktop?.openGpuVideoPreviewSession && desktop.releaseGpuVideoPreviewSession
        && desktop.decodeGpuVideoPreviewAtTime,
    );
    const canPresentNativeVideo = Boolean(
      video && nativeBounds && nativeBounds.width >= 2 && nativeBounds.height >= 2
        && prepared?.nativeSurfaceSafe
        && desktop?.openGpuVideoPreviewSession && desktop.releaseGpuVideoPreviewSession
        && desktop.bindGpuPreviewSurface && desktop.presentGpuVideoPreviewAtTime
        && desktop.releaseGpuPreviewSurface,
    );
    const selectedAdmission: ResidentGpuPreviewState["admission"] = !enabled ? "disabled"
      : !desktop?.createGpuPreviewOwner ? "compatible"
      : canRenderEngineImage ? "engine-image"
      : canRenderEngineVideo ? "engine-video-native"
      : canRenderEngineVideoFrame ? "engine-video-frame"
      : canRenderImage ? "image"
      : canPresentNativeVideo ? "video-native"
      : canRenderVideo ? "video-frame"
      : "compatible";
    setAdmission(selectedAdmission);
    const nativeAudioGeneration = transport?.audio?.mode === "native"
      && transport.audio.seekRevision === transport.seekRevision
      && transport.audio.projectId === project.id && transport.audio.projectRevision === project.revision
      && transport.audio.projectUpdatedAt === project.updatedAt ? transport.audio.generation : undefined;
    const endFrame = Math.max(0, Math.ceil((transport?.duration ?? 0) * project.fps));
    const audioOwnerId=nativeAudioGeneration!==undefined?transport?.audio?.ownerId:undefined;
    if (!transport?.playing) failedPlaybackKey.current = undefined;
    // Autonomous events currently omit per-frame paint cache/upload receipts.
    // Keep paint on the validated presentation path until that channel carries them.
    const playbackKey = !requiresNativePaint && transport?.playing && canRenderEngineVideo && engineVideo && nativeBounds
      && desktop?.startGpuPreviewPlayback && desktop.stopGpuPreviewPlayback && desktop.inspectGpuPreviewPlayback
      && (!projectMayContainAudio(project) || nativeAudioGeneration !== undefined)
      && endFrame > engineVideo.timelineFrame
      ? JSON.stringify([transport.seekRevision, boundsKey(nativeBounds), engineVideo.structureKey, nativeAudioGeneration ?? null,audioOwnerId??null, endFrame]) : undefined;
    const admittedPlaybackKey = playbackKey !== failedPlaybackKey.current ? playbackKey : undefined;
    // Clock-only React updates must not enqueue another frame, rebind a
    // surface, increment the frame token, or restart the native producer.
    if (admittedPlaybackKey && generation.playback.matches(admittedPlaybackKey)) return;
    const playback = admittedPlaybackKey && transport
      ? { ticket: generation.playback.reserve(admittedPlaybackKey), endFrame, audioGeneration: nativeAudioGeneration,audioOwnerId, transport }
      : undefined;
    if (transport?.playing || generation.pendingPause?.seekRevision !== transport?.seekRevision) generation.pendingPause = undefined;
    if (!playback && transport && !transport.playing && generation.playback.canPause()
      && generation.playbackSeekRevision === transport.seekRevision) {
      generation.pendingPause = { seekRevision: transport.seekRevision, result: generation.playback.pause().catch(error => {
        setFallbackReason(error instanceof Error ? error.message : String(error)); return undefined;
      }) };
    }
    if (playback) generation.playbackSeekRevision = transport!.seekRevision;
    const pause = generation.pendingPause && transport ? { result: generation.pendingPause.result, transport } : undefined;
    if (!playback) generation.playback.invalidate();
    publishAutonomousPlayback(false);
    publishNativePlaybackPreparing(Boolean(playback));
    tokenRef.current = token;
    // Keep the last receipt-validated frame of this immutable owner while a
    // seek waits. Clearing it exposes the incompatible paint fallback and
    // flashes a warning on every frame. Project/lease/admission changes still
    // retire it; the requested frame must never masquerade as presented.
    const videoClips = project.tracks.filter((track) => track.kind === "video" && !track.muted).flatMap((track) => track.clips);
    const activeVideoClips = videoClips.filter((clip) => (clip.layer?.enabled ?? true)
      && playhead >= clip.timelineStart && playhead < clip.timelineStart + clip.duration);
    setAdmissionDiagnostic(JSON.stringify({
      enabled,
      engineVideoGraph: Boolean(engineVideo),
      legacyVideoSource: Boolean(video),
      nativePresentationSafe: prepared?.nativeSurfaceSafe ?? false,
      nativeBoundsReady: Boolean(nativeBounds && nativeBounds.width >= 2 && nativeBounds.height >= 2),
      videoClipCount: videoClips.length,
      activeVideoClipCount: activeVideoClips.length,
      captionCount: project.captions.length,
      motionGraphicCount: project.motionGraphics.length,
      project: { width: project.width, height: project.height, fps: project.fps, colorMode: project.colorManagement?.mode ?? "rec709" },
      activeAssets: activeVideoClips.map((clip) => {
        const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
        return {
          kind: asset?.kind ?? "missing",
          width: asset?.width ?? null,
          height: asset?.height ?? null,
          nativePath: Boolean(asset && nativeMediaPath(asset.uri)),
          composition: Boolean(asset?.compositionId),
          role: clip.layer?.role ?? "content",
          layout: Boolean(clip.layout),
          masks: clip.masks?.filter((mask) => mask.enabled).length ?? 0,
          effects: (clip.creative?.effectPresetIds.length ?? 0) + (clip.creative?.nativeEffectInstances?.filter((instance) => instance.enabled).length ?? 0),
        };
      }),
      api: {
        engineVideo: Boolean(desktop?.loadGpuEngineVideoPreviewSession && desktop.presentGpuEngineVideoPreviewFrame),
        legacyVideo: Boolean(desktop?.openGpuVideoPreviewSession && desktop.decodeGpuVideoPreviewAtTime),
        surface: Boolean(desktop?.bindGpuPreviewSurface && desktop.releaseGpuPreviewSurface),
      },
    }));
    if (selectedAdmission === "disabled" || selectedAdmission === "compatible") setFallbackReason(
      requiresNativePaint ? preparationReason ?? (prepared?.video ? "原生 paint 預覽表面尚未就緒" : "正在準備已驗證的實體字型 paint 預覽")
      : selectedAdmission === "compatible" && !legacyVideoAllowed
        ? "目前原生執行環境無法提供 Rec.709 v2 預覽；已停用舊版偏亮的原生替代路徑。" : undefined);

    if (selectedAdmission === "disabled" || selectedAdmission === "compatible") {
      setFrameUrl(undefined); setNativeSurfaceActive(false);
      if (enabled && !desktop?.createGpuPreviewOwner) setFallbackReason("原生執行環境缺少預覽持有者保護；請更新桌面版本。");
      generation.dispose();
      return;
    }
    if (canRenderEngineImage && enginePreview) {
      pendingRef.current = { kind: "engine-image", preview: enginePreview, token };
    } else if (canRenderEngineVideo && engineVideo && nativeBounds) {
      // Device clocks select the current frame (floor), not the nearest
      // future frame used by manual scrubbing. Rounding up here can place
      // the initial cursor ahead of the admitted audio clock.
      const playbackPreview = playback ? { ...engineVideo, timelineFrame: Math.max(0,
        Math.floor(playhead * engineVideo.graph.timebase.denominator / engineVideo.graph.timebase.numerator)) } : engineVideo;
      pendingRef.current = { kind: "engine-video", preview: playbackPreview, token, fps: project.fps, nativeBounds, playback, pause };
      publishRequestedPresentation({ request, token });
    } else if (canRenderEngineVideoFrame && engineVideo) {
      pendingRef.current = {kind:"engine-video-frame",preview:engineVideo,token};
      publishRequestedPresentation({request,token});
    } else if (canRenderImage && graph) {
      pendingRef.current = { kind: "image", graph, structureKey: imageStructureKey(graph), token };
    } else if ((canPresentNativeVideo || canRenderVideo) && video) {
      pendingRef.current = {
        kind: "video",
        source: video,
        token,
        fps: project.fps,
        nativeBounds: canPresentNativeVideo ? nativeBounds : undefined,
      };
    } else {
      pendingRef.current = undefined;
      setFrameUrl(undefined);
      setNativeSurfaceActive(false);
      generation.dispose();
      return;
    }

    if (!canPresentNativeVideo && !canRenderEngineVideo) setNativeSurfaceActive(false);
    if (runningRef.current) return;
    runningRef.current = true;
    void (async () => {
      const desktop = await generation.desktop().catch(error => {
        if (!(error instanceof RetiredGpuPreview)) {
          setFrameUrl(undefined); setAdmission("compatible"); setFallbackReason(error instanceof Error ? error.message : String(error));
        }
        runningRef.current = false;
        return undefined;
      });
      if (!desktop) return;
      const releaseSurface = async () => {
        if (surfaceBoundRef.current && desktop?.releaseGpuPreviewSurface) {
          await desktop.releaseGpuPreviewSurface().catch(() => undefined);
        }
        surfaceBoundRef.current = false;
        surfaceBoundsKeyRef.current = undefined;
        surfaceColorSpaceRef.current = undefined;
        setNativeSurfaceActive(false);
      };
      const invalidateResidentSessions = async () => {
        generation.playback.invalidate();
        if (generation.active) publishAutonomousPlayback(false);
        if (generation.active) publishNativePlaybackPreparing(false);
        await releaseSurface();
        if (loadedImageStructureRef.current && desktop?.releaseGpuPreviewSession) {
          await desktop.releaseGpuPreviewSession(imageSessionRef.current).catch(() => undefined);
        }
        if (loadedVideoStructureRef.current && desktop?.releaseGpuVideoPreviewSession) {
          await desktop.releaseGpuVideoPreviewSession(videoSessionRef.current).catch(() => undefined);
        }
        if (loadedEngineVideoStructureRef.current && desktop?.releaseGpuEngineVideoPreviewSession) {
          await desktop.releaseGpuEngineVideoPreviewSession(engineVideoSessionRef.current).catch(() => undefined);
        }
        loadedImageStructureRef.current = undefined;
        loadedVideoStructureRef.current = undefined;
        loadedEngineVideoStructureRef.current = undefined;
        generation.engineVideoTargetModeRef.current=undefined;
        generation.pngFrames?.dispose(); generation.pngFrames=undefined;
        if(generation.active) publishPngFrame(undefined);
      };
      let recoveredLastFailure = false;
      try {
        while (pendingRef.current) {
          const next = pendingRef.current;
          pendingRef.current = undefined;
          try {
            if (next.kind === "engine-video") {
              if(generation.engineVideoTargetModeRef.current==="offscreen") {
                await desktop.releaseGpuEngineVideoPreviewSession!(engineVideoSessionRef.current);
                loadedEngineVideoStructureRef.current=undefined;
                await releaseSurface();
                generation.pngFrames?.dispose(); generation.pngFrames=undefined;
                publishPngFrame(undefined);
              }
              generation.engineVideoTargetModeRef.current="native";
              const paused = await next.pause?.result;
              if (next.pause && next.token !== tokenRef.current) continue;
              if (paused) {
                next.preview = { ...next.preview, timelineFrame: paused.frame };
                next.pause!.transport.onClock(paused.time);
              }
              const validatedIds = await presentResidentEngineVideo({
                next, desktop: desktop!, imageSessionRef, videoSessionRef, engineVideoSessionRef,
                loadedImageStructureRef, loadedVideoStructureRef, loadedEngineVideoStructureRef,
                surfaceBoundsKeyRef, surfaceColorSpaceRef, surfaceBoundRef, tokenRef, releaseSurface,
                setFrameUrl, setNativeSurfaceActive, setFallbackReason,
              });
              if (generation.active && validatedIds) {
                // A native dispatch may have already changed the real surface
                // before another seek supersedes it. Track its fully validated
                // actual frame/IDs atomically, without completing the newer seek.
                publishPresentedFrame({ request, frame: next.preview.timelineFrame, token: next.token, value: validatedIds });
                setNativeSurfaceActive(true);
              }
              if (next.playback && next.token === tokenRef.current) {
                const intent = next.playback;
                await generation.playback.start(intent.ticket, desktop, engineVideoSessionRef.current,
                  { startFrame: next.preview.timelineFrame, endFrame: intent.endFrame, audioGeneration: intent.audioGeneration,
                    ...(intent.audioOwnerId!==undefined?{audioOwnerId:intent.audioOwnerId}:{}) }, next.preview, {
                    onActive: active => { if (generation.active) { publishAutonomousPlayback(active); publishNativePlaybackPreparing(false); } },
                    onClock: time => { if (generation.active) intent.transport.onClock(time); },
                    onEnded: event => {
                      // Resident audio owns the full timeline; older desktop
                      // adapters renew bounded windows. Video ends only on a
                      // confirmed native-monotonic project-end event.
                      if (generation.active && event.clock === "native-monotonic") {
                        intent.transport.onClock(intent.transport.duration);
                        intent.transport.onEnded();
                      }
                    },
                    onError: reason => {
                      if (!generation.active) return;
                      failedPlaybackKey.current = intent.ticket.key;
                      setFallbackReason(reason);
                    },
                  });
              }
            } else if (next.kind === "engine-video-frame") {
              if(next.token!==tokenRef.current) continue;
              if(loadedImageStructureRef.current) {
                await desktop.releaseGpuPreviewSession!(imageSessionRef.current); loadedImageStructureRef.current=undefined;
              }
              if(loadedVideoStructureRef.current) {
                await desktop.releaseGpuVideoPreviewSession!(videoSessionRef.current); loadedVideoStructureRef.current=undefined;
              }
              const ownerCurrent=()=>generation.active && preparationRef.current?.request===request
                && (!requiresNativePaint || preparationRef.current.lease?.isActive()===true);
              const isCurrent=()=>ownerCurrent() && next.token===tokenRef.current;
              generation.pngFrames ??=new ImmutableDecodedPngFrameHolder({width:project.width,height:project.height},ownerCurrent);
              // Atomic native load retires/binds its own target. Mark ownership
              // before the call, including partial failures, for exact cleanup.
              surfaceBoundRef.current=true;
              const rendered=await renderResidentEngineVideoPng({owner:generation,desktop,preview:next.preview,holder:generation.pngFrames,isCurrent});
              if(rendered && isCurrent()) {
                publishPngFrame({request,token:next.token,frame:rendered.frame,url:rendered.decoded.url,value:rendered.value});
                setFrameUrl(undefined); setNativeSurfaceActive(false); setFallbackReason(undefined);
              }
            } else if (next.kind === "engine-image") {
              await releaseSurface();
              if (loadedEngineVideoStructureRef.current && desktop!.releaseGpuEngineVideoPreviewSession) {
                await desktop!.releaseGpuEngineVideoPreviewSession(engineVideoSessionRef.current).catch(() => undefined);
                loadedEngineVideoStructureRef.current = undefined;
              }
              if (loadedVideoStructureRef.current && desktop!.releaseGpuVideoPreviewSession) {
                await desktop!.releaseGpuVideoPreviewSession(videoSessionRef.current).catch(() => undefined);
                loadedVideoStructureRef.current = undefined;
              }
              const structureKey = `engine:${next.preview.structureKey}`;
              if (loadedImageStructureRef.current !== structureKey) {
                if (loadedImageStructureRef.current && desktop!.releaseGpuPreviewSession) {
                  await desktop!.releaseGpuPreviewSession(imageSessionRef.current).catch(() => undefined);
                }
                const loaded = await desktop!.loadGpuEnginePreviewSession!(
                  imageSessionRef.current,
                  next.preview.graph,
                  next.preview.assetBindings,
                  next.preview.timelineFrame,
                );
                loadedImageStructureRef.current = structureKey;
                const required = next.preview.graph.nodes.map((node) => node.id);
                if (loaded.engineGraph.directExecution !== true || loaded.engineGraph.blockedNodeIds.length
                  || loaded.engineGraph.ignoredNodeIds.length
                  || required.some((id) => !loaded.engineGraph.executedNodeIds.includes(id))
                  || !scene25dCoverageMatches(loaded.scene25d, next.preview.scene25dExpectation, next.preview.graph, next.preview.timelineFrame)
                  || !vfxSimulationCoverageMatches(loaded.vfxSimulation, next.preview.vfxSimulationExpectation)) {
                  throw new Error("共同 Engine Graph 沒有完整進入 native GPU executor");
                }
              } else {
                await desktop!.updateGpuEnginePreviewFrame!(imageSessionRef.current, next.preview.timelineFrame);
              }
              const rendered = await desktop!.renderGpuPreviewFrame!(imageSessionRef.current);
              if (!scene25dCoverageMatches(rendered.receipt.scene25d, next.preview.scene25dExpectation, next.preview.graph, next.preview.timelineFrame)) {
                throw new Error("2.5D resident 預覽回執與載入場景不一致");
              }
              if (!vfxSimulationCoverageMatches(rendered.receipt.vfxSimulation, next.preview.vfxSimulationExpectation)) {
                throw new Error("粒子 VFX resident 預覽回執與載入設定不一致");
              }
              if (next.token === tokenRef.current) { setFrameUrl(rendered.outputUrl); setFallbackReason(undefined); }
            } else if (next.kind === "image") {
              await releaseSurface();
              if (loadedEngineVideoStructureRef.current && desktop!.releaseGpuEngineVideoPreviewSession) {
                await desktop!.releaseGpuEngineVideoPreviewSession(engineVideoSessionRef.current).catch(() => undefined);
                loadedEngineVideoStructureRef.current = undefined;
              }
              if (loadedVideoStructureRef.current && desktop!.releaseGpuVideoPreviewSession) {
                await desktop!.releaseGpuVideoPreviewSession(videoSessionRef.current).catch(() => undefined);
                loadedVideoStructureRef.current = undefined;
              }
              if (loadedImageStructureRef.current !== next.structureKey) {
                if (loadedImageStructureRef.current && desktop!.releaseGpuPreviewSession) {
                  await desktop!.releaseGpuPreviewSession(imageSessionRef.current).catch(() => undefined);
                }
                await desktop!.loadGpuPreviewSession!(imageSessionRef.current, next.graph);
                loadedImageStructureRef.current = next.structureKey;
              }
              await desktop!.updateGpuPreviewProperties!(imageSessionRef.current, gpuLayerPropertyBuffer(next.graph));
              const rendered = await desktop!.renderGpuPreviewFrame!(imageSessionRef.current);
              if (next.token === tokenRef.current) { setFrameUrl(rendered.outputUrl); setFallbackReason(undefined); }
            } else {
              if (loadedEngineVideoStructureRef.current && desktop!.releaseGpuEngineVideoPreviewSession) {
                await desktop!.releaseGpuEngineVideoPreviewSession(engineVideoSessionRef.current).catch(() => undefined);
                loadedEngineVideoStructureRef.current = undefined;
              }
              if (loadedImageStructureRef.current && desktop!.releaseGpuPreviewSession) {
                await desktop!.releaseGpuPreviewSession(imageSessionRef.current).catch(() => undefined);
                loadedImageStructureRef.current = undefined;
              }
              if (loadedVideoStructureRef.current !== next.source.structureKey) {
                if (loadedVideoStructureRef.current) {
                  await desktop!.releaseGpuVideoPreviewSession!(videoSessionRef.current).catch(() => undefined);
                }
                await desktop!.openGpuVideoPreviewSession!(videoSessionRef.current, next.source.inputPath);
                loadedVideoStructureRef.current = next.source.structureKey;
              }
              const tolerance = Math.min(.25, .5 / Math.max(1, next.fps));
              if (next.nativeBounds) {
                const nextBoundsKey = boundsKey(next.nativeBounds);
                if (surfaceBoundRef.current && surfaceColorSpaceRef.current !== "srgb") {
                  await releaseSurface();
                }
                if (!surfaceBoundRef.current || surfaceBoundsKeyRef.current !== nextBoundsKey) {
                  const surface = await desktop!.bindGpuPreviewSurface!(next.nativeBounds);
                  if (!legacySdrNativeSurfaceValid(surface)) throw new Error("原生預覽表面沒有維持明確的 SDR 色彩傳輸契約");
                  surfaceBoundRef.current = true;
                  surfaceBoundsKeyRef.current = nextBoundsKey;
                  surfaceColorSpaceRef.current = "srgb";
                }
                const presented = await desktop!.presentGpuVideoPreviewAtTime!(
                  videoSessionRef.current,
                  next.source.sourceTime,
                  tolerance,
                );
                const frame = presented.receipt.frame;
                if (presented.endOfStream || !frame?.nativeSurfacePresented
                  || frame.nativeSurfaceCpuPixelReadbacks !== 0
                  || !legacySdrNativeSurfaceValid(presented.receipt.surface)) {
                  throw new Error("原生 GPU 預覽沒有完成可驗證的 swap-chain 呈現");
                }
                if (next.token === tokenRef.current) {
                  setFrameUrl(undefined);
                  setNativeSurfaceActive(true);
                  setFallbackReason(undefined);
                }
              } else {
                await releaseSurface();
                const rendered = await desktop!.decodeGpuVideoPreviewAtTime!(
                  videoSessionRef.current,
                  next.source.sourceTime,
                  tolerance,
                );
                if (next.token === tokenRef.current && !rendered.endOfStream) { setFrameUrl(rendered.outputUrl); setFallbackReason(undefined); }
              }
            }
            recoveredLastFailure = false;
          } catch (error) {
            if (!generation.active || error instanceof RetiredGpuPreview) return;
            await invalidateResidentSessions();
            if (!recoveredLastFailure && desktop?.recoverGpuDevice) {
              recoveredLastFailure = true;
              await desktop.recoverGpuDevice();
              if (next.kind === "engine-video" && next.playback && !pendingRef.current) {
                next.playback.ticket = generation.playback.reserve(next.playback.ticket.key);
              }
              if (!pendingRef.current) pendingRef.current = next;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        if (!generation.active || error instanceof RetiredGpuPreview) return;
        setFrameUrl(undefined);
        setAdmission("compatible");
        setFallbackReason(error instanceof Error ? error.message : String(error));
        await invalidateResidentSessions();
      } finally {
        runningRef.current = false;
      }
    })();
  }, [enabled, nativeBounds, playhead, project, prepared, preparationReason, request, transport?.playing, transport?.duration, transport?.seekRevision,
    transport?.audio?.mode, transport?.audio?.generation,transport?.audio?.ownerId, transport?.audio?.seekRevision, transport?.audio?.projectId, transport?.audio?.projectRevision, transport?.audio?.projectUpdatedAt]);

  const currentNativeSurfaceActive = nativeSurfaceActive && presentedRequest === request && (!requiresNativePaint || Boolean(prepared?.video))
    && (admission !== "engine-video-native" || presentedFrame?.request === request);
  const currentPng = admission==="engine-video-frame" && pngFrame?.request===request && prepared?.video
    && generationRef.current?.active && generationRef.current.pngFrames?.isActive() ? pngFrame : undefined;
  const currentBakedIds = currentPng?.value ?? (currentNativeSurfaceActive && admission === "engine-video-native" && presentedFrame?.request === request ? presentedFrame.value : undefined);
  const presentedTimelineFrame = currentPng?.frame ?? (currentNativeSurfaceActive && admission === "engine-video-native" && presentedFrame?.request === request
    ? presentedFrame.frame : undefined);
  const requestedTimelineFrame = sampleResidentGpuGraph(prepared?.video, playhead)?.timelineFrame;
  const nativeFrameUpdating = presentedTimelineFrame !== undefined && !autonomousPlayback && (
    presentedTimelineFrame !== requestedTimelineFrame || requestedPresentation?.request === request && requestedPresentation.token !== (currentPng?.token ?? presentedFrame?.token)
  );
  return { frameUrl:currentPng?.url ?? (admission==="engine-video-frame"?undefined:frameUrl), fullComposition:Boolean(currentPng || currentNativeSurfaceActive && admission==="engine-video-native"),
    onImagePresented:url=>{generationRef.current?.pngFrames?.acknowledgePresented(url);},
    onImageRejected:url=>{if(generationRef.current?.pngFrames?.rejectPresentation(url)) {publishPngFrame(undefined);publishFallbackReason("完整合成預覽影格無法顯示");}},
    nativeSurfaceActive: currentNativeSurfaceActive, admission, fallbackReason, admissionDiagnostic, autonomousPlayback, nativePlaybackPreparing,
    presentedTimelineFrame, nativeFrameUpdating,
    bakedMotionGraphicIds: currentBakedIds?.motionGraphicIds ?? [], bakedCaptionIds: currentBakedIds?.captionIds ?? [] };
}

import { hasExecutableUnifiedLayerOrderV1 } from "../application/unifiedLayerExecutionAdmissionV1";
import { clipMirrorCss, composeClipTransforms, hasClipMirrors } from "../domain/clipMirrors";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { PreviewCaption } from "./PreviewCaption";
import type { ActivePreviewLayer } from "../application/previewMedia";
import { isMediaPreviewCurrent } from "../application/mediaDerivativeColor";
import { compileClipAlphaPlan, type ClipAlphaPlan } from "../domain/clipAlphaPlan";
import { animatedClipState } from "../domain/editGraph";
import { isTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { FLOATING_FRAME_BACKDROP_CSS, FLOATING_FRAME_MEDIA_FIT, floatingFrameCornerRadiusPixels, floatingFrameCssMatrix, floatingFrameFeatherPixels, floatingFrameGeometry, floatingFrameLayout, floatingFrameMatteShadow } from "../motion/floatingVideoFrame";
import type { CaptionCue, CaptionStyle, ColorAdjustments, EditProject, LayerBlendMode, NormalizedRect, Transform2D } from "../domain/types";
import { assertProofStillClipV1, proofStillCanvasRectV1, type ProofStillV1 } from "../domain/proofStillV1";
import { combineLookColor, previewEffectFilter, previewTransitionState } from "../creative/corePack";
import { previewPrimaryFilter } from "../color/previewGrade";
import OcioGpuMedia from "./OcioGpuMedia";
import { usesAcesPhoneSdrV1 } from "../color/acesPhoneInputV1";
import GradedMedia from "./GradedMedia";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import AlphaProcessedPreviewMedia, { AlphaPreviewUnavailable, alphaPreviewFailureMessage } from "./AlphaProcessedPreviewMedia";
import { clipLocalProjectFrame } from "./alphaPlanPreview";
import { nextAutomaticPreviewRepair } from "./previewRepairQueue";
import { useNativeAudioPreviewPlayback, type NativeAudioTransportState } from "../desktop/useNativeAudioPreviewPlayback";
import { PlaybackControls } from "./PlaybackControls";
import { PreviewFlashFilters, previewFlashFilterCss, previewLayerFlashSteps } from "./previewFlash";
import { openTemplateEditorFromStageClick } from "./templateEditorRequests";
import "./captionPreview.css";

const Mesh3dPreview = lazy(() => import("./Mesh3dPreview"));
const MotionOverlay = lazy(() => import("./MotionOverlay"));
// PF1 (2026-10-23): the preview renders on every playhead tick; these parts change only with the caption on screen or a
// flash transition, so they skip the other ticks.
const CaptionLayer = memo(PreviewCaption);
const FlashFilters = memo(PreviewFlashFilters, (a, b) => a.layers.length === b.layers.length && a.layers.every((layer, index) => {
  const other = b.layers[index];
  return layer.clipId === other.clipId && layer.steps.length === other.steps.length && layer.steps.every((step, at) => step === other.steps[at]);
}));

function cssBlendMode(mode: LayerBlendMode): CSSProperties["mixBlendMode"] {
  const map: Record<LayerBlendMode, CSSProperties["mixBlendMode"]> = {
    normal: "normal", add: "plus-lighter", screen: "screen", multiply: "multiply", overlay: "overlay",
    soft_light: "soft-light", hard_light: "hard-light", difference: "difference", darken: "darken", lighten: "lighten",
    color_dodge: "color-dodge", color_burn: "color-burn",
  };
  return map[mode];
}

function composedPreviewTransform(project: EditProject, clip: ActivePreviewLayer["clip"], playhead: number, fps: number, visiting = new Set<string>()): Transform2D {
  if (visiting.has(clip.id)) return animatedClipState(clip, playhead - clip.timelineStart, fps).transform;
  const local = animatedClipState(clip, playhead - clip.timelineStart, fps).transform;
  const parentId = clip.layer?.parentClipId;
  if (!parentId) return local;
  const parent = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === parentId);
  if (!parent) return local;
  const next = new Set(visiting); next.add(clip.id);
  const parentTransform = composedPreviewTransform(project, parent, playhead, fps, next);
  return composeClipTransforms(parentTransform, local);
}

function composePreviewTransforms(parent: Transform2D, child: Transform2D): Transform2D {
  return composeClipTransforms(parent, child);
}

function composePreviewColor(parent: ColorAdjustments, child: ColorAdjustments): ColorAdjustments {
  return {
    brightness: parent.brightness + child.brightness,
    contrast: parent.contrast * child.contrast,
    saturation: parent.saturation * child.saturation,
    hue: parent.hue + child.hue,
    exposure: parent.exposure + child.exposure,
    temperature: parent.temperature + child.temperature,
    tint: parent.tint + child.tint,
    pivot: child.pivot,
    shadows: parent.shadows + child.shadows,
    highlights: parent.highlights + child.highlights,
    blacks: parent.blacks + child.blacks,
    whites: parent.whites + child.whites,
    whiteBalanceRed: 0,
    whiteBalanceGreen: 0,
    whiteBalanceBlue: 0,
  };
}

function trackMattePreviewFailure(layer: ActivePreviewLayer, layers: ActivePreviewLayer[]): string | undefined {
  const clip = layer.displayClip ?? layer.clip;
  const matte = clip.layer?.trackMatte;
  if (!matte) return undefined;
  const sourceLayer = layers.find((candidate) => (candidate.displayClip ?? candidate.clip).id === matte.sourceClipId);
  if (!sourceLayer) return "Track Matte 來源目前不在預覽畫面中";
  if (sourceLayer.asset.kind !== "image") return "相容預覽尚未支援動態影片 Track Matte；已阻擋錯誤的原片預覽";
  const sourceClip = sourceLayer.displayClip ?? sourceLayer.clip;
  const transform = sourceClip.transform;
  const dynamic = sourceClip.keyframes.length > 0 || Object.keys(sourceClip.expressions ?? {}).length > 0
    || transform.x !== 0 || transform.y !== 0 || transform.scale !== 1 || transform.rotation !== 0 || transform.opacity !== 1 || hasClipMirrors(transform)
    || Boolean(sourceClip.layout) || Boolean(sourceLayer.compositionAncestors?.length)
    || Boolean(sourceClip.chromaKey?.enabled) || Boolean(sourceClip.masks?.some((mask) => mask.enabled));
  if (dynamic) return "相容預覽只驗證靜態全畫面 Image Track Matte；此來源含動態、版面或 Alpha 處理";
  return undefined;
}

/** Proof stills are admitted against their own canvas before any of their media is shown (design P3). */
function proofStillPreviewAdmission(clip: ActivePreviewLayer["clip"], asset: ActivePreviewLayer["asset"], canvas: { width: number; height: number }): { proof?: ProofStillV1; failure?: string } {
  if (clip.proofStill === undefined) return {};
  try { return { proof: assertProofStillClipV1(clip, { asset, canvas }) }; }
  catch (error) { return { failure: error instanceof Error ? error.message : String(error) }; }
}

interface PreviewProps {
  onRebuildPreview?: (assetId: string, onOutcome?: (rebuilt: boolean) => void) => Promise<void>;
  previewRepair?: {assetId:string;sessionId:number;operationId:number;phase:"preparing"|"failed"|"prepared";message:string;previewUrl?:string;isCurrent?:()=>boolean};
  layers: ActivePreviewLayer[];
  audioLayers: ActivePreviewLayer[];
  projectWidth: number;
  projectHeight: number;
  playhead: number;
  projectDuration: number;
  projectFps: number;
  captions: CaptionCue[];
  captionStyle: CaptionStyle;
  project: EditProject;
  parameterPreviewEpoch?: number;
  gpuPreviewUrl?: string;
  nativeGpuPreview?: boolean;
  gpuPreviewFullComposition?: boolean;
  onGpuPreviewImagePresented?: (url: string) => void;
  onGpuPreviewImageRejected?: (url: string) => void;
  bakedMotionGraphicIds?: readonly string[];
  bakedCaptionIds?: readonly string[];
  gpuPreviewAdmission?: string;
  gpuPreviewFallbackReason?: string;
  gpuPreviewAdmissionDiagnostic?: string;
  autonomousGpuPlayback?: boolean;
  nativeGpuPlaybackPreparing?: boolean;
  nativeGpuPresentedFrame?: number;
  nativeGpuFrameUpdating?: boolean;
  seekRevision?: number;
  onPlaybackClock?: (time: number) => void;
  onAudioTransportChange?: (state: NativeAudioTransportState) => void;
  nativeEffectPreviewReadyClipIds?: string[];
  nativeEffectPreviewPendingClipIds?: string[];
  nativeEffectPreviewErrors?: Record<string, string>;
  onNativeSurfaceBoundsChange?: (bounds: { x: number; y: number; width: number; height: number }) => void;
  trackingSelectionEnabled?: boolean;
  trackingSelection?: NormalizedRect;
  onTrackingSelectionChange?: (rect: NormalizedRect) => void;
  playing: boolean;
  playbackRate?: number;
  onPlaybackRateChange?: (rate: number) => void;
  onTogglePlayback?: () => void;
  onShuttle?: (direction: -1 | 1) => void;
  onFrameStep?: (direction: -1 | 1) => void;
  onPausePlayback?: () => void;
  onPlayingChange: (playing: boolean) => void;
  onPlayheadChange: (time: number) => void;
  /** A real GPU preview failure from useResidentGpuPreview; the preview keeps a retry next to its mode badge. */
  gpuPreviewFailure?: string;
  onRetryGpuPreview?: () => void;
}

export function Preview({ onRebuildPreview, previewRepair, layers, audioLayers, projectWidth, projectHeight, playhead, projectDuration, projectFps, captions, captionStyle, project, parameterPreviewEpoch = 0, gpuPreviewUrl, nativeGpuPreview = false, gpuPreviewFullComposition = false, onGpuPreviewImagePresented, onGpuPreviewImageRejected, bakedMotionGraphicIds = [], bakedCaptionIds = [], gpuPreviewAdmission, gpuPreviewFallbackReason, gpuPreviewAdmissionDiagnostic, autonomousGpuPlayback = false, nativeGpuPlaybackPreparing = false, nativeGpuPresentedFrame, nativeGpuFrameUpdating = false, seekRevision, onPlaybackClock, onAudioTransportChange, nativeEffectPreviewReadyClipIds = [], nativeEffectPreviewPendingClipIds = [], nativeEffectPreviewErrors = {}, onNativeSurfaceBoundsChange, trackingSelectionEnabled = false, trackingSelection, onTrackingSelectionChange, playing, playbackRate = 1, onPlaybackRateChange, onTogglePlayback, onShuttle, onFrameStep, onPausePlayback, onPlayingChange, onPlayheadChange, gpuPreviewFailure, onRetryGpuPreview }: PreviewProps) {
  useI18n();
  const unifiedOrderPreviewPending = useMemo(() => hasExecutableUnifiedLayerOrderV1(project), [project]);
  const retainingNativeFrame = (nativeGpuPreview || gpuPreviewFullComposition) && nativeGpuFrameUpdating
    && Number.isSafeInteger(nativeGpuPresentedFrame) && nativeGpuPresentedFrame! >= 0;
  // A held native frame and its unbaked overlay must use the same clock. The
  // timeline cursor remains at the user's newly requested time.
  const overlayPlayhead = retainingNativeFrame ? nativeGpuPresentedFrame! / project.fps : playhead;
  // The engine owns typography across its admitted timeline. While native
  // presentation is in flight, no DOM typography may race its actual pixels.
  const nativeCompositionPending = retainingNativeFrame && (gpuPreviewAdmission === "engine-video-native" || gpuPreviewAdmission === "engine-video-frame");
  // Saved scenes own actual graphics. A scene shell alone is not canvas content.
  // The formal no-video compositor starts with black; authored background
  // vectors still draw through MotionOverlay above that same base.
  const originalMotionCanvas = project.motionGraphics.length > 0 && !project.scene3d?.enabled
    && !project.tracks.some(track => track.kind === "video" && !track.hidden
      && track.clips.some(clip => clip.layer?.enabled !== false));
  // CSS/Canvas fallback cannot represent linear-light gains, including nested and future keyframes.
  const hasWb = (clip: ActivePreviewLayer["clip"]) => [clip.color, ...clip.keyframes.map(k => k.color)].some(color =>
    [color.whiteBalanceRed ?? 0, color.whiteBalanceGreen ?? 0, color.whiteBalanceBlue ?? 0].some(value => value !== 0));
  const linearWbFallbackBlocked = !nativeGpuPreview && !gpuPreviewUrl && (
    [project.tracks, ...project.compositions.map(c => c.tracks)].some(tracks => tracks.some(track => !track.hidden && track.clips.some(c => c.layer?.enabled !== false && hasWb(c))))
    || layers.some(layer => hasWb(layer.clip) || Boolean(layer.displayClip && hasWb(layer.displayClip)) || layer.compositionAncestors?.some(ancestor => hasWb(ancestor.clip))));
  const mediaRefs = useRef(new Map<string, HTMLMediaElement>());
  const imageRefs = useRef(new Map<string, HTMLImageElement>());
  const [mediaFailures,setMediaFailures]=useState<Record<string,{name:string;detail:string}>>({});
  const failureKey=(id:string,source:string)=>JSON.stringify([id,source]);
  const clearMediaFailure=(id:string,source:string)=>setMediaFailures(current=>{const key=failureKey(id,source);if(!current[key])return current;const next={...current};delete next[key];return next;});
  const failMedia=(id:string,source:string,name:string,error?:MediaError|null)=>{
    // Keep the failed clip and its repair action visible instead of playing past it.
    onPlayingChange(false);
    setMediaFailures(current=>({...current,[failureKey(id,source)]:{name,detail:error?`解碼錯誤 ${error.code}：${error.message||"瀏覽器無法播放這份預覽"}`:"圖片預覽無法解碼或讀取"}}));
  };
  const attemptedVideoPreparation = useRef(new Set<string>());
  const videoLoaded = (clipId: string, source: string, asset: ActivePreviewLayer["asset"], video: HTMLVideoElement) => {
    // WebView2 can report HAVE_ENOUGH_DATA after decoding only a MOV's audio.
    // loadeddata alone is not evidence that the video has a displayable frame.
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      clearMediaFailure(clipId, source);
      return;
    }
    const detail = "播放器已讀取聲音，但沒有可解碼的影片畫面。請準備相容預覽。";
    setMediaFailures(current => {
      const key = failureKey(clipId, source);
      return current[key]?.detail === detail && current[key]?.name === asset.name
        ? current : { ...current, [key]: { name: asset.name, detail } };
    });
    onPlayingChange(false);
  };
  // A cached local source can finish loading before React commits its event
  // handlers. Reconcile the actual node on mount and when a busy repair ends.
  useEffect(() => {
    for (const layer of layers) {
      const media = mediaRefs.current.get(layer.clip.id);
      if (layer.asset.kind === "video" && media instanceof HTMLVideoElement
        && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        videoLoaded(layer.clip.id, layer.source, layer.asset, media);
      }
    }
  }, [layers, project.id, previewRepair?.phase, onRebuildPreview]);
  // prepareMedia admits one operation per project session. Start exactly one
  // failed source at a time, then revisit the remaining sources on settlement.
  // Calling repair from each loadeddata event loses the concurrent requests.
  useEffect(() => {
    if (!onRebuildPreview || previewRepair?.phase === "preparing") return;
    const next = nextAutomaticPreviewRepair(project.id, layers, new Set(Object.keys(mediaFailures)), attemptedVideoPreparation.current);
    if (!next) return;
    attemptedVideoPreparation.current.add(next.attemptKey);
    void onRebuildPreview(next.assetId);
  }, [layers, mediaFailures, onRebuildPreview, previewRepair?.phase, project.id]);
  useEffect(()=>{const active=new Set(layers.map(layer=>failureKey(layer.clip.id,layer.source)));setMediaFailures(current=>{const entries=Object.entries(current).filter(([key])=>active.has(key));return entries.length===Object.keys(current).length?current:Object.fromEntries(entries);});},[layers]);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageDimensions, setStageDimensions] = useState({ width: projectWidth, height: projectHeight });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (width > 0 && height > 0) setStageDimensions(current => current.width === width && current.height === height ? current : { width, height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, [projectWidth, projectHeight]);
  const lastRepairReload = useRef<{token:string;nodes:WeakSet<HTMLMediaElement>} | undefined>(undefined);
  useEffect(() => {
    if (previewRepair?.phase !== "prepared" || !previewRepair.isCurrent?.()) return;
    const token = `${previewRepair.sessionId}:${previewRepair.operationId}`;
    if (lastRepairReload.current?.token !== token) lastRepairReload.current = {token,nodes:new WeakSet()};
    const seen = lastRepairReload.current.nodes;
    for (const layer of layers) {
      if (layer.asset.kind !== "video" || layer.asset.id !== previewRepair.assetId || layer.source !== previewRepair.previewUrl) continue;
      const media = mediaRefs.current.get(layer.clip.id);
      if (!media || seen.has(media)) continue;
      seen.add(media);
      media.load(); // Each matching node once; only loadeddata clears its error.
    }
  }, [previewRepair, layers]);
  const dragStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const [draftSelection, setDraftSelection] = useState<NormalizedRect>();
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  const activeCaption = captions.find((caption) => overlayPlayhead >= caption.start && overlayPlayhead < caption.start + caption.duration);
  const nativeCaptionComposited = (nativeGpuPreview || gpuPreviewFullComposition) && activeCaption !== undefined && bakedCaptionIds.includes(activeCaption.id);
  const atProjectEnd = projectDuration > 0 && playhead >= projectDuration - 0.5 / projectFps;
  const readyNativeClipIds = new Set(nativeEffectPreviewReadyClipIds);
  const readyNativeEffectCount = layers.reduce((total, layer) => total
    + (readyNativeClipIds.has(layer.clip.id) ? (layer.clip.creative?.nativeEffectInstances?.filter((instance) => instance.enabled && instance.runtimeType !== "gpu_effect_graph" && !isTransformMotionBlurInstance(instance)).length ?? 0) : 0), 0);
  const nativeEffectCount = layers.reduce((total, layer) => total
    + ((layer.displayClip ?? layer.clip).creative?.nativeEffectInstances?.filter((instance) => instance.enabled && instance.runtimeType !== "gpu_effect_graph" && !isTransformMotionBlurInstance(instance)).length ?? 0), 0);
  const pendingNativeEffectCount = Math.max(0, nativeEffectCount - readyNativeEffectCount);
  const previewError = Object.values(nativeEffectPreviewErrors)[0];
  const stalePreviewAssets = nativeGpuPreview || gpuPreviewUrl ? [] : [...new Map(layers
    .filter(({ asset }) => asset.kind === "video" && Boolean(asset.derivatives?.proxyUri) && !isMediaPreviewCurrent(asset.derivatives))
    .map(({ asset }) => [asset.id, asset])).values()];
  const stalePreviewAsset = stalePreviewAssets[0];
  const stalePreviewRepair = stalePreviewAsset && previewRepair?.assetId === stalePreviewAsset.id ? previewRepair : undefined;
  const previewRepairBusy = previewRepair?.phase === "preparing";
  onPlayheadChangeRef.current = onPlayheadChange;
  const nativeAudio = useNativeAudioPreviewPlayback({
    previewEpoch: parameterPreviewEpoch,
    api: typeof window === "undefined" ? undefined : window.haoDesktop,
    project,
    layers,
    audioLayers,
    mediaRefs,
    playhead,
    projectDuration,
    projectFps,
    playing,
    playbackRate,
    onPlayingChange,
    onPlayheadChange: onPlaybackClock ?? onPlayheadChange,
    seekRevision,
    externalVideoClock: playbackRate === 1 && (autonomousGpuPlayback || nativeGpuPlaybackPreparing),
    onRebuildPreview,
  });
  useEffect(() => {
    const bound = nativeAudio.mode === "native" ? nativeAudio.stage : undefined;
    onAudioTransportChange?.({ mode: nativeAudio.mode, generation: nativeAudio.generation,
      ownerId:nativeAudio.ownerId,
      seekRevision: nativeAudio.transportSeekRevision,
      projectId: bound?.projectId ?? project.id, projectRevision: bound?.projectRevision ?? project.revision,
      projectUpdatedAt: bound?.projectUpdatedAt ?? project.updatedAt });
  }, [onAudioTransportChange, nativeAudio.mode, nativeAudio.generation, nativeAudio.ownerId, nativeAudio.stage, nativeAudio.transportSeekRevision, project.id, project.revision, project.updatedAt]);

  useEffect(() => {
    if (!onNativeSurfaceBoundsChange) return;
    let disposed = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    let animationFrame = 0;
    const reportBounds = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const bounds = stageRef.current?.getBoundingClientRect();
        if (disposed || !bounds || bounds.width < 2 || bounds.height < 2) return;
        onNativeSurfaceBoundsChange({
          x: bounds.left,
          y: bounds.top,
          width: bounds.width,
          height: bounds.height,
        });
      });
    };
    const observer = new ResizeObserver(reportBounds);
    if (stageRef.current) observer.observe(stageRef.current);
    window.addEventListener("resize", reportBounds);
    document.addEventListener("scroll", reportBounds, true);
    reportBounds();
    if (window.haoDesktop) {
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        const currentWindow = getCurrentWindow();
        unlistenMoved = await currentWindow.onMoved(reportBounds);
        unlistenResized = await currentWindow.onResized(reportBounds);
      }).catch(() => undefined);
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      document.removeEventListener("scroll", reportBounds, true);
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, [onNativeSurfaceBoundsChange]);

  const togglePlayback = () => {
    if (onTogglePlayback) { onTogglePlayback(); return; }
    if (playing) {
      onPlayingChange(false);
      return;
    }
    if (playhead >= projectDuration) onPlayheadChangeRef.current(0);
    onPlayingChange(projectDuration > 0);
  };
  const pausePlayback = () => { if (onPausePlayback) onPausePlayback(); else onPlayingChange(false); };
  // Flash transitions add brightness like the export's FFmpeg eq (see previewFlash.tsx), not CSS brightness().
  const flashLayers = layers.map((layer, index) => ({ clipId: `${index}-${layer.clip.id}`, steps: previewLayerFlashSteps(layer, playhead) }));

  const pointerPosition = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const updateSelection = (event: React.PointerEvent<HTMLDivElement>, complete: boolean) => {
    const start = dragStartRef.current;
    if (!start) return;
    const current = pointerPosition(event);
    const rect = {
      x: Math.min(start.x, current.x), y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x), height: Math.abs(current.y - start.y),
    };
    setDraftSelection(rect);
    if (complete) {
      dragStartRef.current = undefined;
      if (rect.width >= 0.02 && rect.height >= 0.02) onTrackingSelectionChange?.(rect);
    }
  };

  return (
    <section className={`preview-panel preview-with-transport${stalePreviewAsset ? " has-preview-update" : ""}`} aria-label={uiText("播放器")} data-native-audio-mode={nativeAudio.mode}
      data-native-audio-owner={nativeAudio.ownerId} data-native-audio-generation={nativeAudio.generation} data-playing={playing} data-playback-rate={playbackRate}>
      <div className="preview-toolbar">
        {/* data-preview-detail: engineering details simple mode leaves out (simpleWorkspace.css). */}
        <span data-preview-detail={atProjectEnd ? undefined : "layers"}><i /> {atProjectEnd ? uiText("播放頭在影片結尾") : uiText("預覽畫面 · {value0} 個畫面圖層", { value0: layers.filter(layer => !layer.matteOnly).length })}</span>
        <div className="preview-badges"><span data-testid="canvas-orientation">{projectHeight > projectWidth ? uiText("直式 9:16") : projectWidth > projectHeight ? uiText("橫式 16:9") : uiText("正方形 1:1")}</span><span data-preview-detail="engine">{nativeGpuPreview ? uiText("GPU 直出") : gpuPreviewUrl ? uiText("原生 GPU") : uiText("相容預覽")}</span>{gpuPreviewFailure && onRetryGpuPreview && <button type="button" className="preview-gpu-retry" data-testid="preview-gpu-retry" title={gpuPreviewFailure} onClick={onRetryGpuPreview}>{uiText("GPU 加速暫停 · 重試")}</button>}{nativeAudio.mode === "starting" && <span data-testid="native-audio-starting">{uiText("音訊準備中")}</span>}{nativeAudio.mode === "native" && <span data-testid="native-audio-active" data-audio-fingerprint={nativeAudio.stage?.audioFingerprintSha256}>{uiText("原生音訊 · Sample Clock")}</span>}{nativeAudio.mode === "compatible" && nativeAudio.error && <span data-testid="native-audio-fallback" title={`${uiText("原生音訊無法使用，聲音改用相容方式播放，可能和畫面有些微落差。")}\n${uiText("原因：{value0}", { value0: nativeAudio.error })}`}>{uiText("音訊相容模式")}</span>}{readyNativeEffectCount > 0 && <span className="native-effect-preview-ready" data-testid="native-effect-preview-ready">{readyNativeEffectCount} {uiText("個原生特效 · CPU 快取預覽")}</span>}{pendingNativeEffectCount > 0 && <span className="native-effect-pending" data-testid="native-effect-preview-pending" title={previewError}>{pendingNativeEffectCount} {uiText("個原生特效 ·")}{nativeEffectPreviewPendingClipIds.length ? uiText("正在建立預覽…") : previewError ? uiText("預覽受阻") : uiText("正式輸出生效")}</span>}{nativeGpuPreview && projectDuration > 0 ? <button type="button" className="native-preview-play" onClick={togglePlayback} data-testid="native-preview-play">{playing ? uiText("暫停") : uiText("播放")}</button> : null}</div>
      </div>
      {retainingNativeFrame && <div className="preview-update-notice" data-testid="native-preview-frame-updating" role="status">
        <span>{uiText("正在更新影格…")}</span>
      </div>}
      {stalePreviewAsset && <div className={`preview-update-notice${stalePreviewRepair?.phase === "failed" ? " failed" : ""}`} data-testid="preview-update-notice" role={stalePreviewRepair?.phase === "failed" ? "alert" : "status"} aria-live={stalePreviewRepair?.phase === "failed" ? "assertive" : "polite"}>
        <span className="preview-update-copy">
          <strong>{uiText("預覽色彩可更新")}</strong>
          <span>{stalePreviewRepair?.message ?? uiText("此畫面有 {value0} 份舊預覽；目前畫面仍可播放，正式輸出仍使用原片。", { value0: stalePreviewAssets.length })}</span>
        </span>
        {onRebuildPreview ? <button type="button" disabled={previewRepairBusy} aria-label={uiText("更新「{value0}」的預覽", { value0: stalePreviewAsset.name })} onClick={() => void onRebuildPreview(stalePreviewAsset.id)}>{previewRepairBusy ? uiText("更新中…") : stalePreviewRepair?.phase === "failed" ? uiText("重試更新") : uiText("更新預覽")}</button> : <span className="preview-update-desktop">{uiText("請在桌面版更新")}</span>}
      </div>}
      {previewError && !nativeGpuPreview && <div className="preview-update-notice failed" data-testid="native-effect-preview-error" role="status">
        <span className="preview-update-copy">
          <strong>{uiText("特效預覽暫時做不出來")}</strong>
          <span>{uiText("畫面先不顯示這個特效；輸出影片時會重新處理。")}</span>
          <details><summary>{uiText("查看原因")}</summary><span>{previewError}</span></details>
        </span>
      </div>}
      <div className="preview-viewport" data-testid="preview-viewport" style={{ "--canvas-aspect": projectWidth / projectHeight } as CSSProperties}>
      <FlashFilters layers={flashLayers} />
      <div
        ref={stageRef}
        className={`preview-stage${trackingSelectionEnabled ? " tracking-selecting" : ""}`}
        style={{ aspectRatio: `${projectWidth} / ${projectHeight}`, containerType: "size", ...(originalMotionCanvas && !nativeGpuPreview && !gpuPreviewUrl
          ? { background: "black" } : project.tracks.some(track => track.clips.some(clip => clip.floatingFrame)) ? { background: FLOATING_FRAME_BACKDROP_CSS } : {}) }}
        data-preview-motion-canvas={originalMotionCanvas ? "original" : undefined}
        data-canvas-width={projectWidth}
        data-canvas-height={projectHeight}
        data-gpu-preview-admission={gpuPreviewAdmission}
        data-gpu-presented-frame={nativeGpuPreview ? nativeGpuPresentedFrame : undefined}
        data-gpu-frame-updating={retainingNativeFrame || undefined}
        data-gpu-playback-owner={autonomousGpuPlayback ? "native" : nativeGpuPlaybackPreparing ? "native-starting" : "compatible"}
        data-gpu-preview-fallback-reason={gpuPreviewFallbackReason}
        data-gpu-preview-failure={gpuPreviewFailure ? "true" : undefined}
        data-gpu-preview-admission-diagnostic={gpuPreviewAdmissionDiagnostic}
        onPointerDown={trackingSelectionEnabled ? (event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStartRef.current = pointerPosition(event);
          setDraftSelection({ ...dragStartRef.current, width: 0, height: 0 });
        } : undefined}
        onPointerMove={trackingSelectionEnabled ? (event) => updateSelection(event, false) : undefined}
        onPointerUp={trackingSelectionEnabled ? (event) => updateSelection(event, true) : undefined}
        onClick={trackingSelectionEnabled ? undefined : (event) => { if (openTemplateEditorFromStageClick(event, project, overlayPlayhead)) pausePlayback(); }}
      >
        {unifiedOrderPreviewPending ? <div className="empty-preview" role="status" data-testid="unified-order-preview-pending"><strong>{uiText("此專案的混合圖層排序目前無法預覽。")}</strong><span>{uiText("為保留正確圖層順序，已暫停顯示畫面。")}</span></div> : project.scene3d?.enabled ? <Suspense fallback={<div role="status">{uiText("準備 3D 場景…")}</div>}><Mesh3dPreview project={project} playhead={playhead} playing={playing} layers={layers}/></Suspense> : nativeGpuPreview ? <div className="native-gpu-surface-slot" aria-label={uiText("原生 GPU swap-chain 預覽")} data-testid="native-gpu-surface" /> : gpuPreviewUrl ? <img className="preview-layer" src={gpuPreviewUrl} alt={uiText("原生 GPU 合成預覽")} data-testid="gpu-preview-frame" onLoad={event => onGpuPreviewImagePresented?.(event.currentTarget.getAttribute("src") ?? "")} onError={event => onGpuPreviewImageRejected?.(event.currentTarget.getAttribute("src") ?? "")} /> : linearWbFallbackBlocked ? <div className="empty-preview" role="status" data-testid="linear-white-balance-preview-unavailable"><strong>{uiText("線性白平衡預覽尚不可用")}</strong><span>{uiText("目前相容預覽無法準確顯示這項調色，已停止顯示未調整原片。請使用已驗證的原生合成預覽或檢查正式輸出。")}</span></div> : layers.length > 0 ? layers.map((layer, index) => {
          // A track matte source is read by its target's mask below and never drawn itself (design D3).
          if (layer.matteOnly) return null;
          const { clip, asset, source } = layer;
          const displayClip = layer.displayClip ?? clip;
          const displayProject = layer.displayProject ?? project;
          const displayPlayhead = layer.displayPlayhead ?? playhead;
          const localTime = displayPlayhead - displayClip.timelineStart;
          let { color: animatedColor } = animatedClipState(displayClip, localTime, displayProject.fps);
          let transform = composedPreviewTransform(displayProject, displayClip, displayPlayhead, displayProject.fps);
          const ancestors = layer.compositionAncestors ?? [];
          for (const ancestor of [...ancestors].reverse()) {
            const ancestorState = animatedClipState(ancestor.clip, ancestor.playhead - ancestor.clip.timelineStart, ancestor.project.fps);
            transform = composePreviewTransforms(composedPreviewTransform(ancestor.project, ancestor.clip, ancestor.playhead, ancestor.project.fps), transform);
            animatedColor = composePreviewColor(ancestorState.color, animatedColor);
          }
          const creativeClips = [...ancestors.map((ancestor) => ancestor.clip), displayClip];
          const color = creativeClips.reduce((current, creativeClip) => combineLookColor(current, creativeClip.creative?.lookPresetId), animatedColor);
          const transitions = creativeClips.map((creativeClip, transitionIndex) => previewTransitionState(
            creativeClip,
            transitionIndex === creativeClips.length - 1 ? localTime : ancestors[transitionIndex].playhead - creativeClip.timelineStart,
          ));
          const transition = transitions.reduce((current, item) => ({
            opacity: current.opacity * item.opacity,
            scale: current.scale * item.scale,
            xPercent: current.xPercent + item.xPercent,
            brightness: current.brightness * item.brightness,
          }), { opacity: 1, scale: 1, xPercent: 0, brightness: 1 });
          const effectFilter = previewEffectFilter(creativeClips.flatMap((creativeClip) => creativeClip.creative?.effectPresetIds ?? []));
          // brightness(1) keeps the former identity filter (and its stacking context) when nothing flashes.
          const flashFilter = previewFlashFilterCss(flashLayers[index]?.clipId ?? clip.id, flashLayers[index]?.steps ?? []) || "brightness(1)";
          const ocioManagement = displayProject.colorManagement?.mode === "aces2" ? displayProject.colorManagement : undefined;
          // Color Grade v2 previews through GradedMedia: the export's own 65³ table, primary grade in GLSL.
          const gradeV2 = displayClip.gradeV2;
          const phonePreview = ocioManagement !== undefined && usesAcesPhoneSdrV1(ocioManagement);
          // The surface asset describes display pixels, not the original HDR scene input.
          const originalTransfer = project.assets.find((candidate) => candidate.id === asset.id)?.color?.transfer?.toLowerCase();
          if (ocioManagement && layer.displayProxy && (originalTransfer === "arib-std-b67" || originalTransfer === "smpte2084") && !((gradeV2 || phonePreview) && ocioManagement.outputTransform === "rec709_sdr")) {
            return <div key={clip.id} className="preview-layer empty-preview" role="status" data-testid="hdr-display-proxy-aces-unavailable" style={{ zIndex: index + 1 }}>{uiText("HDR 預覽代理已轉為 SDR，不能再次套用 ACES 顯示轉換。請切換 Rec709 相容預覽；原始素材未更動。此代理不代表 ACES 原始素材的準確預覽。")}</div>;
          }
          if (displayClip.layer?.role === "adjustment") {
            const adjustmentFilter = `${previewPrimaryFilter(color)} ${effectFilter}`;
            return <div key={clip.id} data-testid="preview-adjustment-layer" style={{ position: "absolute", inset: 0, zIndex: index + 1, pointerEvents: "none", backdropFilter: adjustmentFilter, WebkitBackdropFilter: adjustmentFilter }} />;
          }
          let alphaPlan: ClipAlphaPlan | undefined;
          let localProjectFrame = 0;
          let alphaPlanFailure: string | undefined;
          try {
            alphaPlan = compileClipAlphaPlan(displayProject, displayClip);
            localProjectFrame = clipLocalProjectFrame(alphaPlan, localTime);
          } catch (error) {
            alphaPlanFailure = alphaPreviewFailureMessage(error);
          }
          const alphaProcessingRequired = Boolean(alphaPlan?.keyer || alphaPlan?.operations.length);
          const matteLayer = displayClip.layer?.trackMatte ? layers.find((candidate) => (candidate.displayClip ?? candidate.clip).id === displayClip.layer!.trackMatte!.sourceClipId) : undefined;
          const matteInverted = displayClip.layer?.trackMatte?.mode.endsWith("_inverted") ?? false;
          const matteMode = displayClip.layer?.trackMatte?.mode.startsWith("luma") ? "luminance" : "alpha";
          const matteStyle = matteLayer?.asset.kind === "image" ? (matteInverted ? {
            WebkitMaskImage: `linear-gradient(#fff 0 0), url("${matteLayer.source}")`, maskImage: `linear-gradient(#fff 0 0), url("${matteLayer.source}")`,
            WebkitMaskComposite: "xor", maskComposite: "exclude", WebkitMaskMode: matteMode, maskMode: matteMode,
            WebkitMaskSize: "contain", maskSize: "contain", WebkitMaskPosition: "center", maskPosition: "center", WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
          } : {
            WebkitMaskImage: `url("${matteLayer.source}")`, maskImage: `url("${matteLayer.source}")`, WebkitMaskMode: matteMode, maskMode: matteMode,
            WebkitMaskSize: "contain", maskSize: "contain", WebkitMaskPosition: "center", maskPosition: "center", WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
          }) : {};
          const style: CSSProperties = {
            zIndex: index + 1,
            opacity: transform.opacity * transition.opacity,
            transform: `translate(${(transform.x / projectWidth) * 100 + transition.xPercent}%, ${(transform.y / projectHeight) * 100}%) scale(${transform.scale * transition.scale}) rotate(${transform.rotation}deg)${clipMirrorCss(transform)}`,
            filter: ocioManagement || gradeV2
              ? `${flashFilter} ${effectFilter}`
              : `${previewPrimaryFilter(color)} ${flashFilter} ${effectFilter}`,
            mixBlendMode: cssBlendMode(ancestors[0]?.clip.layer?.blendMode ?? displayClip.layer?.blendMode ?? "normal"),
            ...matteStyle,
          };
          const trackMatteFailure = trackMattePreviewFailure(layer, layers);
          const unsupportedAlphaCombination = alphaProcessingRequired && ocioManagement
              ? "ACES 2 顯示轉換與 Canvas Alpha 堆疊尚未完成同源預覽驗證"
              : alphaProcessingRequired && gradeV2
              ? "Color Grade v2 與 Canvas Alpha 堆疊尚未完成同源預覽驗證"
              : undefined;
          const blockedReason = alphaPlanFailure ?? trackMatteFailure ?? unsupportedAlphaCombination;
          const testId = asset.kind === "image" ? "preview-image" : "preview-video";
          if (blockedReason || !alphaPlan) return <AlphaPreviewUnavailable key={`${clip.id}:alpha-blocked`} assetName={asset.name} reason={blockedReason ?? "Alpha plan 無法建立"} className="preview-layer" style={style} testId={testId} />;
          const proofStillAdmission = proofStillPreviewAdmission(displayClip, asset, { width: displayProject.width, height: displayProject.height }), proofStill = proofStillAdmission.proof;
          if (proofStillAdmission.failure !== undefined) return <div key={`${clip.id}:proof-still-blocked`} className="preview-layer empty-preview" role="alert" data-testid="preview-proof-still-blocked" style={style}>
            <strong>{uiText("截圖證據預覽受阻")}</strong><span>{proofStillAdmission.failure}</span>
          </div>;
          if (displayClip.floatingFrame) {
            const frame = displayClip.floatingFrame;
            let geometry: ReturnType<typeof floatingFrameGeometry>;
            let frameOpacity = 1;
            let floatingLocalFrame = localProjectFrame;
            let mediaFit: "cover" | "contain" = FLOATING_FRAME_MEDIA_FIT;
            let fittedMediaStyle: CSSProperties = { width: "100%", height: "100%" };
            try {
              if (frame.schema === "editkin.floating-video-frame/v2") {
                // Share FFmpeg's rounded timeline tick without changing the
                // saved start or v1's continuous scrub/orbit interpretation.
                const startFrame = Math.round(displayClip.timelineStart * displayProject.fps);
                floatingLocalFrame = clipLocalProjectFrame(alphaPlan, displayPlayhead - startFrame / displayProject.fps);
                const ratio = asset.displayAspectRatio;
                const sourceGeometry = ratio !== undefined
                  ? Number.isFinite(ratio) && ratio > 0 ? { width: ratio, height: 1 } : undefined
                  : Number.isFinite(asset.width) && asset.width! > 0 && Number.isFinite(asset.height) && asset.height! > 0
                    ? { width: asset.width!, height: asset.height! } : undefined;
                if (!sourceGeometry) throw new Error("缺少有效原片顯示比例與正向尺寸；請重新讀取素材資訊後再預覽浮窗。");
                const layout = floatingFrameLayout(frame, displayProject.width, displayProject.height, {
                  ...sourceGeometry, fps: displayProject.fps,
                  durationFrames: Math.round(displayClip.duration * displayProject.fps), localFrame: floatingLocalFrame,
                });
                geometry = layout.geometry;
                frameOpacity = layout.visible ? layout.opacity : 0;
                mediaFit = layout.mediaFit;
                // The inset rect is relative to the border's inner plane, so
                // CSS absolute positioning must not add the outer border twice.
                fittedMediaStyle = { position: "absolute", left: `${layout.sourceFit.left / geometry.innerWidth * 100}%`,
                  top: `${layout.sourceFit.top / geometry.innerHeight * 100}%`, width: `${layout.sourceFit.width / geometry.innerWidth * 100}%`,
                  height: `${layout.sourceFit.height / geometry.innerHeight * 100}%` };
              } else {
                // Saved v1 keeps its continuous-time orbit and cover geometry.
                geometry = floatingFrameGeometry(frame, displayProject.width, displayProject.height, localTime);
              }
            } catch (error) {
              return <div key={`${clip.id}:floating-blocked`} className="preview-layer empty-preview" role="alert"
                data-testid="preview-floating-frame-unavailable" style={style}>
                <strong>{uiText("浮空影片框預覽受阻")}</strong><span>{error instanceof Error ? error.message : uiText("浮窗來源資訊無法建立；請重新讀取素材資訊。")}</span>
              </div>;
            }
            const prism = frame.style === "prism";
            const matte = frame.style === "matte";
            const shadow = floatingFrameMatteShadow(displayProject.width, displayProject.height);
            const cqw = (pixels: number) => `${pixels / displayProject.width * 100}cqw`;
            const feather = `${floatingFrameFeatherPixels(displayProject.width, displayProject.height) / displayProject.width * 100}cqw`;
            const featherMask = `linear-gradient(to right, transparent 0, black ${feather}, black calc(100% - ${feather}), transparent 100%), linear-gradient(to bottom, transparent 0, black ${feather}, black calc(100% - ${feather}), transparent 100%)`;
            return <div key={clip.id} className="preview-layer" style={{ ...style, opacity: Number(style.opacity) * frameOpacity }} data-testid="preview-floating-video-frame"
              data-floating-frame-schema={frame.schema} data-floating-local-frame={floatingLocalFrame} data-floating-opacity={frameOpacity}
              data-floating-inner-width={geometry.innerWidth} data-floating-inner-height={geometry.innerHeight}>
              <div style={{ position: "absolute", inset: 0, transformOrigin: "0 0",
                transform: floatingFrameCssMatrix(geometry.quad, stageDimensions.width, stageDimensions.height),
                filter: matte ? `drop-shadow(${cqw(shadow.x)} ${cqw(shadow.y)} ${cqw(shadow.blur)} rgba(8,11,13,${shadow.opacity}))` : undefined }}>
                <div style={{ position: "absolute", boxSizing: "border-box", overflow: "hidden",
                  left: `${geometry.left / displayProject.width * 100}%`, top: `${geometry.top / displayProject.height * 100}%`,
                  width: `${geometry.outerWidth / displayProject.width * 100}%`, height: `${geometry.outerHeight / displayProject.height * 100}%`,
                  maskImage: featherMask, WebkitMaskImage: featherMask, maskComposite: "intersect", WebkitMaskComposite: "source-in",
                  borderRadius: `${floatingFrameCornerRadiusPixels(frame, displayProject.width, displayProject.height, geometry.border) / displayProject.width * 100}cqw`,
                  border: `${geometry.border / displayProject.width * 100}cqw solid ${matte ? "#121516" : prism ? "#101D32" : "#16181D"}`,
                  borderTopColor: matte ? "#303536" : prism ? "#96CCD3" : "#D4C3A5", borderRightColor: matte ? "#23282A" : prism ? "#456C78" : "#66645E",
                  backgroundColor: frame.schema === "editkin.floating-video-frame/v2" ? matte ? "#121516" : prism ? "#101D32" : "#16181D" : undefined,
                  boxShadow: matte ? undefined : `inset 0 0 ${geometry.border / displayProject.width * 80}cqw ${prism ? "rgba(150,204,211,.10)" : "rgba(212,195,165,.10)"}, ${geometry.border / displayProject.width * 80}cqw ${geometry.border / displayProject.width * 120}cqw ${geometry.border / displayProject.width * 220}cqw ${prism ? "rgba(23,56,73,.30)" : "rgba(71,68,62,.30)"}, 0 ${geometry.border / displayProject.width * 210}cqw ${geometry.border / displayProject.width * 360}cqw rgba(0,0,0,.32)` }}>
                  <video key={`${clip.id}:${source}`} ref={node => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }}
                    src={source} playsInline muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} preload="auto"
                    style={{ display: "block", ...fittedMediaStyle, objectFit: mediaFit }} data-testid="preview-video"
                    onError={event => failMedia(clip.id, source, asset.name, event.currentTarget.error)} onLoadedData={event => videoLoaded(clip.id, source, asset, event.currentTarget)} />
                </div>
              </div>
            </div>;
          }
          if (displayClip.layout) {
            const { crop, viewport } = displayClip.layout;
            // A proof still's wrapper is its derived crop; media and redaction rects share the compositor's canvas fit.
            const proofCanvas = { width: displayProject.width, height: displayProject.height };
            const proofRect = (rect: NormalizedRect): CSSProperties => ({ position: "absolute", left: `${(rect.x - crop.x) / crop.width * 100}%`, top: `${(rect.y - crop.y) / crop.height * 100}%`,
              width: `${rect.width / crop.width * 100}%`, height: `${rect.height / crop.height * 100}%` });
            const wrapperStyle = {
              ...style,
              position: "absolute" as const,
              left: `${viewport.x * 100}%`, top: `${viewport.y * 100}%`,
              width: `${viewport.width * 100}%`, height: `${viewport.height * 100}%`, overflow: "hidden",
              transformOrigin: "center",
              // CSS percentage translation is relative to this viewport, while
              // authored x/y and transition travel use the project canvas.
              transform: `translate(${((transform.x / projectWidth) * 100 + transition.xPercent) / viewport.width}%, ${(transform.y / projectHeight) * 100 / viewport.height}%) scale(${transform.scale * transition.scale}) rotate(${transform.rotation}deg)${clipMirrorCss(transform)}`,
            };
            const mediaStyle = proofStill ? { ...proofRect(proofStillCanvasRectV1(proofStill, { x: 0, y: 0, width: proofStill.sourceWidth, height: proofStill.sourceHeight }, proofCanvas)), objectFit: "fill" as const } : {
              position: "absolute" as const,
              left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%`,
              // Crop coordinates refer to the contain-padded project canvas,
              // exactly as in ffmpegComposite; fill stretches mixed-aspect slots.
              width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, objectFit: "contain" as const,
            };
            return <div key={clip.id} style={wrapperStyle} data-testid="preview-layout-layer">
              {alphaProcessingRequired
                ? <AlphaProcessedPreviewMedia asset={asset} source={source} plan={alphaPlan} localProjectFrame={localProjectFrame} projectWidth={displayProject.width} projectHeight={displayProject.height} style={mediaStyle} muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />
                : gradeV2 || phonePreview
                ? <GradedMedia asset={asset} color={color} grade={gradeV2} rec709Input={displayClip.rec709Input} management={displayProject.colorManagement ?? DEFAULT_COLOR_MANAGEMENT} source={source} style={mediaStyle} muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />
                : ocioManagement
                ? <OcioGpuMedia asset={asset} color={color} management={ocioManagement} source={source} style={mediaStyle} muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />
                : asset.kind === "image"
                ? <img ref={node=>{if(node)imageRefs.current.set(clip.id,node);else imageRefs.current.delete(clip.id);}} src={source} alt={asset.name} style={mediaStyle} data-testid="preview-image" onError={()=>failMedia(clip.id,source,asset.name)} onLoad={()=>clearMediaFailure(clip.id,source)}/>
                : <video key={`${clip.id}:${source}`} ref={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} src={source} playsInline muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} preload="auto" style={mediaStyle} data-testid="preview-video" onError={event=>failMedia(clip.id,source,asset.name,event.currentTarget.error)} onLoadedData={event=>videoLoaded(clip.id,source,asset,event.currentTarget)}/>}
              {proofStill?.redactions.map(redaction => <div key={`proof-redaction:${redaction.id}`} data-testid="preview-proof-still-redaction" data-redaction-id={redaction.id} aria-hidden="true"
                style={{ ...proofRect(proofStillCanvasRectV1(proofStill, redaction.rect, proofCanvas)), background: redaction.fill, pointerEvents: "none" }} />)}
            </div>;
          }
          if (alphaProcessingRequired) return <AlphaProcessedPreviewMedia key={`${clip.id}:${source}:alpha`} asset={asset} source={source} plan={alphaPlan} localProjectFrame={localProjectFrame} projectWidth={displayProject.width} projectHeight={displayProject.height} className="preview-layer" style={style} muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />;
          if (gradeV2 || phonePreview) return <GradedMedia key={`${clip.id}:${source}:grade-v2`} asset={asset} color={color} grade={gradeV2} rec709Input={displayClip.rec709Input} management={displayProject.colorManagement ?? DEFAULT_COLOR_MANAGEMENT} source={source} className="preview-layer" style={style} muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />;          if (ocioManagement) return <OcioGpuMedia key={`${clip.id}:${source}:ocio`} asset={asset} color={color} management={ocioManagement} source={source} className="preview-layer" style={style} muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={asset.kind === "image" ? "preview-image" : "preview-video"} />;
          return asset.kind === "image" ? (
            <img ref={node=>{if(node)imageRefs.current.set(clip.id,node);else imageRefs.current.delete(clip.id);}} key={clip.id} className="preview-layer" src={source} alt={asset.name} style={style} data-testid="preview-image" onError={()=>failMedia(clip.id,source,asset.name)} onLoad={()=>clearMediaFailure(clip.id,source)}/>
          ) : (
            <video
              key={`${clip.id}:${source}`}
              ref={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }}
              className="preview-layer"
              src={source}
              playsInline
              muted={nativeAudio.mode === "native" || clip.volume <= 0 || layer.silent === true}
              preload="auto"
              style={style}
              data-testid="preview-video"
              onError={event=>failMedia(clip.id,source,asset.name,event.currentTarget.error)}
              onLoadedData={event=>videoLoaded(clip.id,source,asset,event.currentTarget)}
            />
          );
        }) : originalMotionCanvas ? null : (<div className="empty-preview">
            {projectDuration > 0
              ? <button type="button" className="empty-preview-action" onClick={togglePlayback} aria-label={uiText("從頭播放")}>↺</button>
              : <div>{audioLayers.length > 0 ? "♫" : "▶"}</div>}
            <strong>{atProjectEnd ? uiText("已到影片結尾") : audioLayers.length > 0 ? uiText("正在播放聲音") : uiText("這裡會顯示你的影片")}</strong>
            <span>{atProjectEnd ? uiText("按一下從頭播放") : audioLayers.length > 0 ? uiText("目前只有聲音，所以畫面保持黑色") : uiText("先從左側加入影片或照片")}</span>
          </div>)}
        {!nativeGpuPreview && !gpuPreviewUrl && layers.filter(layer=>mediaFailures[failureKey(layer.clip.id,layer.source)]).map(layer=>{const failure=mediaFailures[failureKey(layer.clip.id,layer.source)]!;return <div key={`error:${layer.clip.id}`} role="alert" data-testid="preview-media-error" style={{position:"absolute",inset:"12px",zIndex:100,background:"var(--surface)",color:"var(--ink)",padding:16,fontSize:16,overflow:"auto"}}><strong>「{failure.name}{uiText("」預覽無法顯示")}</strong><p>{onRebuildPreview&&layer.asset.kind==="video"?uiText("預覽無法解碼或讀取。可重建預覽；原片與既有剪輯保留。"):uiText("預覽無法解碼或讀取。請重新載入並確認來源仍可讀取；原片與既有剪輯保留。")}</p>{onRebuildPreview&&layer.asset.kind==="video"&&<><button type="button" style={{fontSize:16,minHeight:44}} disabled={previewRepair?.phase==="preparing"} onClick={()=>void onRebuildPreview(layer.asset.id)}>{uiText("重建預覽")}</button>{previewRepair?.assetId===layer.asset.id&&<p role="status">{previewRepair.message}</p>}{previewRepair?.phase==="preparing"&&previewRepair.assetId!==layer.asset.id&&<p role="status">{uiText("正在重建另一份素材的預覽，完成後即可重建這份素材。")}</p>}</>}<details><summary>{uiText("查看原因")}</summary><p>{failure.detail}</p></details><button type="button" style={{fontSize:16,minHeight:44}} onClick={()=>{const node=mediaRefs.current.get(layer.clip.id),image=imageRefs.current.get(layer.clip.id);if(node)node.load();else if(image)image.src=layer.source;}}>{uiText("重新載入預覽")}</button></div>;})}
        {project.scene3d?.enabled && layers.filter(layer => layer.asset.kind === "video" && layer.clip.volume > 0 && !layer.silent).map(({clip,source}) => <audio key={`mesh-audio:${clip.id}:${source}`} ref={node=>{if(node)mediaRefs.current.set(clip.id,node);else mediaRefs.current.delete(clip.id);}} src={source} preload="auto" muted={nativeAudio.mode === "native"}/>)}
        {audioLayers.map(({ clip, source }) => (
          <audio key={`audio:${clip.id}:${source}`} ref={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} src={source} preload="auto" muted={nativeAudio.mode === "native"} />
        ))}
        {projectDuration > 0 && !nativeGpuPreview && <button type="button" className="preview-play" onClick={togglePlayback} aria-label={playing ? uiText("暫停播放") : uiText("播放")} aria-keyshortcuts="Space" title={uiText("播放／暫停（Space）")} data-testid="preview-play">{playing ? "❚❚" : "▶"}</button>}
        {!unifiedOrderPreviewPending && activeCaption && !nativeCaptionComposited && !nativeCompositionPending && <CaptionLayer caption={activeCaption} style={captionStyle} projectWidth={projectWidth} projectHeight={projectHeight} />}
        {!unifiedOrderPreviewPending && (!nativeCompositionPending || trackingSelectionEnabled) && (project.motionGraphics.some(graphic => !(nativeGpuPreview || gpuPreviewFullComposition) || !bakedMotionGraphicIds.includes(graphic.id)) || trackingSelectionEnabled) && <Suspense fallback={null}><MotionOverlay project={project} playhead={overlayPlayhead} bakedGraphicIds={nativeGpuPreview || gpuPreviewFullComposition ? bakedMotionGraphicIds : []} suppressGraphics={nativeCompositionPending} trackingSelectionEnabled={trackingSelectionEnabled} trackingSelection={draftSelection ?? trackingSelection} /></Suspense>}
      </div>
      </div>
      <PlaybackControls playing={playing} playhead={playhead} duration={projectDuration} fps={projectFps}
        playbackRate={playbackRate} onTogglePlayback={togglePlayback} onPausePlayback={pausePlayback}
        onSeek={onPlayheadChange} onPlaybackRateChange={onPlaybackRateChange} onShuttle={onShuttle} onFrameStep={onFrameStep} noticePlacement={nativeGpuPreview ? "inline" : "overlay"} />
    </section>
  );
}

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";
import type { ActivePreviewLayer } from "../application/previewMedia";
import { isMediaPreviewCurrent } from "../application/mediaDerivativeColor";
import { compileClipAlphaPlan, type ClipAlphaPlan } from "../domain/clipAlphaPlan";
import { animatedClipState } from "../domain/editGraph";
import { isTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import type { CaptionCue, CaptionStyle, ColorAdjustments, EditProject, LayerBlendMode, NormalizedRect, Transform2D } from "../domain/types";
import { combineLookColor, previewEffectFilter, previewTransitionState } from "../creative/corePack";
import { formatTime } from "../lib/format";
import { previewPrimaryFilter } from "../color/previewGrade";
import OcioGpuMedia from "./OcioGpuMedia";
import AlphaProcessedPreviewMedia, { AlphaPreviewUnavailable, alphaPreviewFailureMessage } from "./AlphaProcessedPreviewMedia";
import { clipLocalProjectFrame } from "./alphaPlanPreview";
import { useNativeAudioPreviewPlayback, type NativeAudioTransportState } from "../desktop/useNativeAudioPreviewPlayback";
import "./captionPreview.css";

const MotionOverlay = lazy(() => import("./MotionOverlay"));

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
  const radians = parentTransform.rotation * Math.PI / 180;
  return {
    x: parentTransform.x + (local.x * Math.cos(radians) - local.y * Math.sin(radians)) * parentTransform.scale,
    y: parentTransform.y + (local.x * Math.sin(radians) + local.y * Math.cos(radians)) * parentTransform.scale,
    scale: parentTransform.scale * local.scale,
    rotation: parentTransform.rotation + local.rotation,
    opacity: parentTransform.opacity * local.opacity,
  };
}

function composePreviewTransforms(parent: Transform2D, child: Transform2D): Transform2D {
  const radians = parent.rotation * Math.PI / 180;
  return {
    x: parent.x + (child.x * Math.cos(radians) - child.y * Math.sin(radians)) * parent.scale,
    y: parent.y + (child.x * Math.sin(radians) + child.y * Math.cos(radians)) * parent.scale,
    scale: parent.scale * child.scale,
    rotation: parent.rotation + child.rotation,
    opacity: parent.opacity * child.opacity,
  };
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
    || transform.x !== 0 || transform.y !== 0 || transform.scale !== 1 || transform.rotation !== 0 || transform.opacity !== 1
    || Boolean(sourceClip.layout) || Boolean(sourceLayer.compositionAncestors?.length)
    || Boolean(sourceClip.chromaKey?.enabled) || Boolean(sourceClip.masks?.some((mask) => mask.enabled));
  if (dynamic) return "相容預覽只驗證靜態全畫面 Image Track Matte；此來源含動態、版面或 Alpha 處理";
  return undefined;
}

interface PreviewProps {
  onRebuildPreview?: (assetId: string) => Promise<void>;
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
  gpuPreviewUrl?: string;
  nativeGpuPreview?: boolean;
  gpuPreviewAdmission?: string;
  gpuPreviewFallbackReason?: string;
  gpuPreviewAdmissionDiagnostic?: string;
  autonomousGpuPlayback?: boolean;
  nativeGpuPlaybackPreparing?: boolean;
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
  onPlayingChange: (playing: boolean) => void;
  onPlayheadChange: (time: number) => void;
}

export function Preview({ onRebuildPreview, previewRepair, layers, audioLayers, projectWidth, projectHeight, playhead, projectDuration, projectFps, captions, captionStyle, project, gpuPreviewUrl, nativeGpuPreview = false, gpuPreviewAdmission, gpuPreviewFallbackReason, gpuPreviewAdmissionDiagnostic, autonomousGpuPlayback = false, nativeGpuPlaybackPreparing = false, seekRevision, onPlaybackClock, onAudioTransportChange, nativeEffectPreviewReadyClipIds = [], nativeEffectPreviewPendingClipIds = [], nativeEffectPreviewErrors = {}, onNativeSurfaceBoundsChange, trackingSelectionEnabled = false, trackingSelection, onTrackingSelectionChange, playing, onPlayingChange, onPlayheadChange }: PreviewProps) {
  // CSS/Canvas fallback cannot represent linear-light gains, including nested and future keyframes.
  const hasWb = (clip: ActivePreviewLayer["clip"]) => [clip.color, ...clip.keyframes.map(k => k.color)].some(color =>
    [color.whiteBalanceRed ?? 0, color.whiteBalanceGreen ?? 0, color.whiteBalanceBlue ?? 0].some(value => value !== 0));
  const linearWbFallbackBlocked = !nativeGpuPreview && !gpuPreviewUrl && (
    [project.tracks, ...project.compositions.map(c => c.tracks)].some(tracks => tracks.some(track => !track.muted && track.clips.some(c => c.layer?.enabled !== false && hasWb(c))))
    || layers.some(layer => hasWb(layer.clip) || Boolean(layer.displayClip && hasWb(layer.displayClip)) || layer.compositionAncestors?.some(ancestor => hasWb(ancestor.clip))));
  const mediaRefs = useRef(new Map<string, HTMLMediaElement>());
  const imageRefs = useRef(new Map<string, HTMLImageElement>());
  const [mediaFailures,setMediaFailures]=useState<Record<string,{name:string;detail:string}>>({});
  const failureKey=(id:string,source:string)=>JSON.stringify([id,source]);
  const clearMediaFailure=(id:string,source:string)=>setMediaFailures(current=>{const key=failureKey(id,source);if(!current[key])return current;const next={...current};delete next[key];return next;});
  const failMedia=(id:string,source:string,name:string,error?:MediaError|null)=>setMediaFailures(current=>({...current,[failureKey(id,source)]:{name,detail:error?`解碼錯誤 ${error.code}：${error.message||"瀏覽器無法播放這份預覽"}`:"圖片預覽無法解碼或讀取"}}));
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
    const key = JSON.stringify([project.id, asset.id, asset.uri, source]);
    if (onRebuildPreview && !asset.derivatives?.proxyUri && previewRepair?.phase !== "preparing" && !attemptedVideoPreparation.current.has(key)) {
      attemptedVideoPreparation.current.add(key);
      void onRebuildPreview(asset.id);
    }
  };
  // A cached local source can finish loading before React commits its event
  // handlers. Reconcile the actual node on mount and when a busy repair ends;
  // repeated checks are idempotent and preparation remains once per source.
  useEffect(() => {
    for (const layer of layers) {
      const media = mediaRefs.current.get(layer.clip.id);
      if (layer.asset.kind === "video" && media instanceof HTMLVideoElement
        && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        videoLoaded(layer.clip.id, layer.source, layer.asset, media);
      }
    }
  }, [layers, project.id, previewRepair?.phase, onRebuildPreview]);
  useEffect(()=>{const active=new Set(layers.map(layer=>failureKey(layer.clip.id,layer.source)));setMediaFailures(current=>{const entries=Object.entries(current).filter(([key])=>active.has(key));return entries.length===Object.keys(current).length?current:Object.fromEntries(entries);});},[layers]);
  const stageRef = useRef<HTMLDivElement>(null);
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
  const activeCaption = captions.find((caption) => playhead >= caption.start && playhead < caption.start + caption.duration);
  const nativeTypographyComposited = gpuPreviewAdmission === "engine-video-native";
  const captionFace = resolveBundledFontFace(captionStyle.fontFamily, captionStyle.bold ? 800 : 400);
  const translationFace = resolveBundledFontFace(captionStyle.translationFontFamily, captionStyle.translationBold ? 800 : 400);
  const captionTextAlign = captionStyle.alignment % 3 === 1 ? "left" : captionStyle.alignment % 3 === 0 ? "right" : "center";
  // Caption sizes are authored in project pixels, not desktop UI pixels. The
  // stage is the query container so dock/sidebar resizing cannot enlarge text.
  const captionUnit = (pixels: number) => `${pixels / projectWidth * 100}cqw`;
  const captionMarginPercent = `${Math.max(0, Math.min(35, captionStyle.marginV / projectHeight * 100))}%`;
  const captionVerticalStyle = captionStyle.alignment >= 7
    ? { top: captionMarginPercent, bottom: "auto", transform: "none" }
    : captionStyle.alignment >= 4
      ? { top: "50%", bottom: "auto", transform: "translateY(-50%)" }
      : { top: "auto", bottom: captionMarginPercent, transform: "none" };
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
    api: typeof window === "undefined" ? undefined : window.haoDesktop,
    project,
    layers,
    audioLayers,
    mediaRefs,
    playhead,
    projectDuration,
    projectFps,
    playing,
    onPlayingChange,
    onPlayheadChange: onPlaybackClock ?? onPlayheadChange,
    seekRevision,
    externalVideoClock: autonomousGpuPlayback || nativeGpuPlaybackPreparing,
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
    if (playing) {
      onPlayingChange(false);
      return;
    }
    if (playhead >= projectDuration) onPlayheadChangeRef.current(0);
    onPlayingChange(projectDuration > 0);
  };

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
    <section className={`preview-panel${stalePreviewAsset ? " has-preview-update" : ""}`} aria-label="播放器" data-native-audio-mode={nativeAudio.mode}
      data-native-audio-owner={nativeAudio.ownerId} data-native-audio-generation={nativeAudio.generation} data-playing={playing}>
      <div className="preview-toolbar">
        <span><i /> {atProjectEnd ? "播放頭在影片結尾" : `預覽畫面 · ${layers.length} 個畫面圖層`}</span>
        <div className="preview-badges"><span data-testid="canvas-orientation">{projectHeight > projectWidth ? "直式 9:16" : projectWidth > projectHeight ? "橫式 16:9" : "正方形 1:1"}</span><span>{nativeGpuPreview ? "GPU 直出" : gpuPreviewUrl ? "原生 GPU" : "相容預覽"}</span>{nativeAudio.mode === "starting" && <span data-testid="native-audio-starting">音訊準備中</span>}{nativeAudio.mode === "native" && <span data-testid="native-audio-active" title={nativeAudio.stage?.audioFingerprintSha256}>原生音訊 · Sample Clock</span>}{nativeAudio.mode === "compatible" && nativeAudio.error && <span data-testid="native-audio-fallback" title={nativeAudio.error}>音訊相容模式</span>}{readyNativeEffectCount > 0 && <span className="native-effect-preview-ready" data-testid="native-effect-preview-ready">{readyNativeEffectCount} 個原生特效 · CPU 快取預覽</span>}{pendingNativeEffectCount > 0 && <span className="native-effect-pending" data-testid="native-effect-preview-pending" title={previewError}>{pendingNativeEffectCount} 個原生特效 · {nativeEffectPreviewPendingClipIds.length ? "正在建立預覽…" : previewError ? "預覽受阻" : "正式輸出生效"}</span>}{nativeGpuPreview && projectDuration > 0 ? <button type="button" className="native-preview-play" onClick={togglePlayback} data-testid="native-preview-play">{playing ? "暫停" : "播放"}</button> : null}</div>
      </div>
      {stalePreviewAsset && <div className={`preview-update-notice${stalePreviewRepair?.phase === "failed" ? " failed" : ""}`} data-testid="preview-update-notice" role={stalePreviewRepair?.phase === "failed" ? "alert" : "status"} aria-live={stalePreviewRepair?.phase === "failed" ? "assertive" : "polite"}>
        <span className="preview-update-copy">
          <strong>預覽色彩可更新</strong>
          <span>{stalePreviewRepair?.message ?? `此畫面有 ${stalePreviewAssets.length} 份舊預覽；目前畫面仍可播放，正式輸出仍使用原片。`}</span>
        </span>
        {onRebuildPreview ? <button type="button" disabled={previewRepairBusy} aria-label={`更新「${stalePreviewAsset.name}」的預覽`} onClick={() => void onRebuildPreview(stalePreviewAsset.id)}>{previewRepairBusy ? "更新中…" : stalePreviewRepair?.phase === "failed" ? "重試更新" : "更新預覽"}</button> : <span className="preview-update-desktop">請在桌面版更新</span>}
      </div>}
      <div className="preview-viewport" data-testid="preview-viewport" style={{ "--canvas-aspect": projectWidth / projectHeight } as CSSProperties}>
      <div
        ref={stageRef}
        className={`preview-stage${trackingSelectionEnabled ? " tracking-selecting" : ""}`}
        style={{ aspectRatio: `${projectWidth} / ${projectHeight}`, containerType: "size" }}
        data-canvas-width={projectWidth}
        data-canvas-height={projectHeight}
        data-gpu-preview-admission={gpuPreviewAdmission}
        data-gpu-playback-owner={autonomousGpuPlayback ? "native" : nativeGpuPlaybackPreparing ? "native-starting" : "compatible"}
        data-gpu-preview-fallback-reason={gpuPreviewFallbackReason}
        data-gpu-preview-admission-diagnostic={gpuPreviewAdmissionDiagnostic}
        onPointerDown={trackingSelectionEnabled ? (event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStartRef.current = pointerPosition(event);
          setDraftSelection({ ...dragStartRef.current, width: 0, height: 0 });
        } : undefined}
        onPointerMove={trackingSelectionEnabled ? (event) => updateSelection(event, false) : undefined}
        onPointerUp={trackingSelectionEnabled ? (event) => updateSelection(event, true) : undefined}
      >
        {nativeGpuPreview ? <div className="native-gpu-surface-slot" aria-label="原生 GPU swap-chain 預覽" data-testid="native-gpu-surface" /> : gpuPreviewUrl ? <img className="preview-layer" src={gpuPreviewUrl} alt="原生 GPU 合成預覽" data-testid="gpu-preview-frame" /> : linearWbFallbackBlocked ? <div className="empty-preview" role="status" data-testid="linear-white-balance-preview-unavailable"><strong>線性白平衡預覽尚不可用</strong><span>目前相容預覽無法準確顯示這項調色，已停止顯示未調整原片。請使用已驗證的原生合成預覽或檢查正式輸出。</span></div> : layers.length > 0 ? layers.map((layer, index) => {
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
          const ocioManagement = displayProject.colorManagement?.mode === "aces2" ? displayProject.colorManagement : undefined;
          // The surface asset describes display pixels, not the original HDR scene input.
          const originalTransfer = project.assets.find((candidate) => candidate.id === asset.id)?.color?.transfer?.toLowerCase();
          if (ocioManagement && layer.displayProxy && (originalTransfer === "arib-std-b67" || originalTransfer === "smpte2084")) {
            return <div key={clip.id} className="preview-layer empty-preview" role="status" data-testid="hdr-display-proxy-aces-unavailable" style={{ zIndex: index + 1 }}>
              HDR 預覽代理已轉為 SDR，不能再次套用 ACES 顯示轉換。請切換 Rec709 相容預覽；原始素材未更動。此代理不代表 ACES 原始素材的準確預覽。
            </div>;
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
            transform: `translate(${(transform.x / projectWidth) * 100 + transition.xPercent}%, ${(transform.y / projectHeight) * 100}%) scale(${transform.scale * transition.scale}) rotate(${transform.rotation}deg)`,
            filter: ocioManagement
              ? `brightness(${transition.brightness}) ${effectFilter}`
              : `${previewPrimaryFilter(color)} brightness(${transition.brightness}) ${effectFilter}`,
            mixBlendMode: cssBlendMode(ancestors[0]?.clip.layer?.blendMode ?? displayClip.layer?.blendMode ?? "normal"),
            ...matteStyle,
          };
          const trackMatteFailure = trackMattePreviewFailure(layer, layers);
          const unsupportedAlphaCombination = alphaProcessingRequired && ocioManagement
              ? "ACES 2 顯示轉換與 Canvas Alpha 堆疊尚未完成同源預覽驗證"
              : undefined;
          const blockedReason = alphaPlanFailure ?? trackMatteFailure ?? unsupportedAlphaCombination;
          const testId = asset.kind === "image" ? "preview-image" : "preview-video";
          if (blockedReason || !alphaPlan) return <AlphaPreviewUnavailable key={`${clip.id}:alpha-blocked`} assetName={asset.name} reason={blockedReason ?? "Alpha plan 無法建立"} className="preview-layer" style={style} testId={testId} />;
          if (displayClip.layout) {
            const { crop, viewport } = displayClip.layout;
            const wrapperStyle = {
              ...style,
              position: "absolute" as const,
              left: `${viewport.x * 100}%`, top: `${viewport.y * 100}%`,
              width: `${viewport.width * 100}%`, height: `${viewport.height * 100}%`, overflow: "hidden",
              transformOrigin: "center",
              // CSS percentage translation is relative to this viewport, while
              // authored x/y and transition travel use the project canvas.
              transform: `translate(${((transform.x / projectWidth) * 100 + transition.xPercent) / viewport.width}%, ${(transform.y / projectHeight) * 100 / viewport.height}%) scale(${transform.scale * transition.scale}) rotate(${transform.rotation}deg)`,
            };
            const mediaStyle = {
              position: "absolute" as const,
              left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%`,
              width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, objectFit: "fill" as const,
            };
            return <div key={clip.id} style={wrapperStyle} data-testid="preview-layout-layer">
              {alphaProcessingRequired
                ? <AlphaProcessedPreviewMedia asset={asset} source={source} plan={alphaPlan} localProjectFrame={localProjectFrame} projectWidth={displayProject.width} projectHeight={displayProject.height} style={mediaStyle} muted={nativeAudio.mode === "native" || clip.volume <= 0} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />
                : ocioManagement
                ? <OcioGpuMedia asset={asset} color={color} management={ocioManagement} source={source} style={mediaStyle} muted={nativeAudio.mode === "native" || clip.volume <= 0} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />
                : asset.kind === "image"
                ? <img ref={node=>{if(node)imageRefs.current.set(clip.id,node);else imageRefs.current.delete(clip.id);}} src={source} alt={asset.name} style={mediaStyle} data-testid="preview-image" onError={()=>failMedia(clip.id,source,asset.name)} onLoad={()=>clearMediaFailure(clip.id,source)}/>
                : <video key={`${clip.id}:${source}`} ref={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} src={source} playsInline muted={nativeAudio.mode === "native" || clip.volume <= 0} preload="auto" style={mediaStyle} data-testid="preview-video" onError={event=>failMedia(clip.id,source,asset.name,event.currentTarget.error)} onLoadedData={event=>videoLoaded(clip.id,source,asset,event.currentTarget)}/>}
            </div>;
          }
          if (alphaProcessingRequired) return <AlphaProcessedPreviewMedia key={`${clip.id}:${source}:alpha`} asset={asset} source={source} plan={alphaPlan} localProjectFrame={localProjectFrame} projectWidth={displayProject.width} projectHeight={displayProject.height} className="preview-layer" style={style} muted={nativeAudio.mode === "native" || clip.volume <= 0} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={testId} />;
          if (ocioManagement) return <OcioGpuMedia key={`${clip.id}:${source}:ocio`} asset={asset} color={color} management={ocioManagement} source={source} className="preview-layer" style={style} muted={nativeAudio.mode === "native" || clip.volume <= 0} videoRef={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} testId={asset.kind === "image" ? "preview-image" : "preview-video"} />;
          return asset.kind === "image" ? (
            <img ref={node=>{if(node)imageRefs.current.set(clip.id,node);else imageRefs.current.delete(clip.id);}} key={clip.id} className="preview-layer" src={source} alt={asset.name} style={style} data-testid="preview-image" onError={()=>failMedia(clip.id,source,asset.name)} onLoad={()=>clearMediaFailure(clip.id,source)}/>
          ) : (
            <video
              key={`${clip.id}:${source}`}
              ref={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }}
              className="preview-layer"
              src={source}
              playsInline
              muted={nativeAudio.mode === "native" || clip.volume <= 0}
              preload="auto"
              style={style}
              data-testid="preview-video"
              onError={event=>failMedia(clip.id,source,asset.name,event.currentTarget.error)}
              onLoadedData={event=>videoLoaded(clip.id,source,asset,event.currentTarget)}
            />
          );
        }) : (
          <div className="empty-preview">
            {projectDuration > 0
              ? <button type="button" className="empty-preview-action" onClick={togglePlayback} aria-label="從頭播放">↺</button>
              : <div>{audioLayers.length > 0 ? "♫" : "▶"}</div>}
            <strong>{atProjectEnd ? "已到影片結尾" : audioLayers.length > 0 ? "正在播放聲音" : "這裡會顯示你的影片"}</strong>
            <span>{atProjectEnd ? "按一下從頭播放" : audioLayers.length > 0 ? "目前只有聲音，所以畫面保持黑色" : "先從左側加入影片或照片"}</span>
          </div>
        )}
        {!nativeGpuPreview&&!gpuPreviewUrl&&layers.filter(layer=>mediaFailures[failureKey(layer.clip.id,layer.source)]).map(layer=>{const failure=mediaFailures[failureKey(layer.clip.id,layer.source)]!;return <div key={`error:${layer.clip.id}`} role="alert" data-testid="preview-media-error" style={{position:"absolute",inset:"12px",zIndex:100,background:"var(--surface)",color:"var(--ink)",padding:16,fontSize:16,overflow:"auto"}}><strong>「{failure.name}」預覽無法顯示</strong><p>{onRebuildPreview&&layer.asset.kind==="video"?"預覽無法解碼或讀取。可重建預覽；原片與既有剪輯保留。":"預覽無法解碼或讀取。請重新載入並確認來源仍可讀取；原片與既有剪輯保留。"}</p>{onRebuildPreview&&layer.asset.kind==="video"&&<><button type="button" style={{fontSize:16,minHeight:44}} disabled={previewRepair?.phase==="preparing"} onClick={()=>void onRebuildPreview(layer.asset.id)}>重建預覽</button>{previewRepair?.assetId===layer.asset.id&&<p role="status">{previewRepair.message}</p>}{previewRepair?.phase==="preparing"&&previewRepair.assetId!==layer.asset.id&&<p role="status">正在重建另一份素材的預覽，完成後即可重建這份素材。</p>}</>}<details><summary>查看原因</summary><p>{failure.detail}</p></details><button type="button" style={{fontSize:16,minHeight:44}} onClick={()=>{const node=mediaRefs.current.get(layer.clip.id),image=imageRefs.current.get(layer.clip.id);if(node)node.load();else if(image)image.src=layer.source;}}>重新載入預覽</button></div>;})}
        {audioLayers.map(({ clip, source }) => (
          <audio key={`audio:${clip.id}:${source}`} ref={(node) => { if (node) mediaRefs.current.set(clip.id, node); else mediaRefs.current.delete(clip.id); }} src={source} preload="auto" muted={nativeAudio.mode === "native"} />
        ))}
        {projectDuration > 0 && !nativeGpuPreview && <button type="button" className="preview-play" onClick={togglePlayback} title="播放／暫停（Space）" data-testid="preview-play">{playing ? "❚❚" : "▶"}</button>}
        {activeCaption && !nativeTypographyComposited && (
          <div className="preview-caption" data-testid="preview-caption" style={{
            backgroundColor: captionStyle.backgroundColor,
            textAlign: captionTextAlign,
            fontSize: captionUnit(captionStyle.fontSize),
            gap: captionUnit(3),
            left: `${40 / projectWidth * 100}%`,
            right: `${40 / projectWidth * 100}%`,
            textShadow: "none",
            ...captionVerticalStyle,
          }}>
            <span className="preview-caption-primary" data-font-weight-substituted={captionFace?.weightSubstituted} title={captionFace?.weightSubstituted ? `字重 ${captionFace.requestedWeight} → ${captionFace.fontWeight}` : undefined} style={{
              color: captionStyle.color,
              fontFamily: cssFontFamily(captionFace?.fontFamily ?? captionStyle.fontFamily),
              fontSize: captionUnit(captionStyle.fontSize),
              fontWeight: captionFace?.fontWeight ?? (captionStyle.bold ? 800 : 400), fontSynthesis: "style",
              fontStyle: captionStyle.italic ? "italic" : "normal",
              letterSpacing: captionUnit(captionStyle.letterSpacing),
              WebkitTextStrokeColor: captionStyle.outlineColor,
              WebkitTextStrokeWidth: captionUnit(captionStyle.outlineWidth),
              paintOrder: "stroke fill",
              textShadow: captionStyle.shadow > 0 ? `0 ${captionUnit(captionStyle.shadow)} ${captionUnit(captionStyle.shadow * 2)} #000000aa` : "none",
            }}>{activeCaption.text}</span>
            {activeCaption.translation && <span className="preview-caption-translation" lang={activeCaption.translation.language} data-testid="preview-caption-translation" data-font-weight-substituted={translationFace?.weightSubstituted} title={translationFace?.weightSubstituted ? `字重 ${translationFace.requestedWeight} → ${translationFace.fontWeight}` : undefined} style={{
              color: captionStyle.translationColor,
              fontFamily: cssFontFamily(translationFace?.fontFamily ?? captionStyle.translationFontFamily),
              fontSize: captionUnit(captionStyle.translationFontSize),
              fontWeight: translationFace?.fontWeight ?? (captionStyle.translationBold ? 800 : 400), fontSynthesis: "style",
              fontStyle: captionStyle.translationItalic ? "italic" : "normal",
              WebkitTextStrokeColor: captionStyle.outlineColor,
              WebkitTextStrokeWidth: captionUnit(captionStyle.outlineWidth),
              paintOrder: "stroke fill",
              textShadow: captionStyle.shadow > 0 ? `0 ${captionUnit(captionStyle.shadow)} ${captionUnit(captionStyle.shadow * 2)} #000000aa` : "none",
            }}>{activeCaption.translation.text}</span>}
          </div>
        )}
        {((project.motionGraphics.length > 0 && !nativeTypographyComposited) || trackingSelectionEnabled) && <Suspense fallback={null}><MotionOverlay project={project} playhead={playhead} trackingSelectionEnabled={trackingSelectionEnabled} trackingSelection={draftSelection ?? trackingSelection} /></Suspense>}
      </div>
      </div>
      <div className="transport-readout">
        <span>{formatTime(playhead)}</span>
        <div className="transport-line"><i style={{ width: `${projectDuration ? (playhead / projectDuration) * 100 : 0}%` }} /></div>
        <span>{formatTime(projectDuration)}</span>
      </div>
    </section>
  );
}

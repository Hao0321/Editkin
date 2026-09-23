import { useEffect, useRef, useState, type CSSProperties } from "react";
import { applyChromaKeyRgbaInPlace } from "../domain/chromaKey";
import type { ChromaKeySettings, MediaAsset } from "../domain/types";
import "./keyedPreviewMedia.css";

interface KeyedPreviewMediaProps {
  asset: MediaAsset;
  source: string;
  settings: ChromaKeySettings;
  className?: string;
  style?: CSSProperties;
  muted: boolean;
  videoRef?: (node: HTMLVideoElement | null) => void;
  testId: string;
}

const MAX_PREVIEW_EDGE = 640;

type KeyedPreviewState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready" }
  | { key: string; status: "error"; reason: string };

function boundedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(1, width, height));
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

export function renderKeyedPreviewFrame(canvas: HTMLCanvasElement, source: CanvasImageSource, sourceWidth: number, sourceHeight: number, settings: ChromaKeySettings): void {
  const size = boundedSize(sourceWidth, sourceHeight);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) throw new Error("瀏覽器未提供 2D Alpha 預覽");
  context.clearRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  const frame = context.getImageData(0, 0, size.width, size.height);
  applyChromaKeyRgbaInPlace(frame.data, settings);
  context.putImageData(frame, 0, 0);
}

export function keyedPreviewFailureMessage(error: unknown): string {
  const candidate = typeof error === "object" && error !== null ? error as { name?: unknown; message?: unknown } : undefined;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = typeof candidate?.message === "string" ? candidate.message : typeof error === "string" ? error : "";
  if (name === "SecurityError" || /cross[- ]origin|cors|taint/i.test(message)) return "素材來源限制阻擋像素讀取（CORS）";
  if (/2D Alpha/i.test(message)) return "此裝置不支援 2D Alpha Canvas 預覽";
  return message ? `去背像素處理失敗：${message}` : "去背像素處理失敗";
}

function previewOperationKey(asset: MediaAsset, source: string, settings: ChromaKeySettings): string {
  return [asset.id, asset.kind, source, settings.screen, settings.screenColor, settings.similarity, settings.softness, settings.despill].join("|");
}

function unavailablePlacement(style?: CSSProperties): CSSProperties {
  return {
    position: style?.position,
    inset: style?.inset,
    left: style?.left,
    top: style?.top,
    right: style?.right,
    bottom: style?.bottom,
    width: style?.width,
    height: style?.height,
    zIndex: style?.zIndex,
    transform: style?.transform,
    transformOrigin: style?.transformOrigin,
  };
}

export function KeyedPreviewUnavailable({ assetName, reason, className, style, testId }: { assetName: string; reason: string; className?: string; style?: CSSProperties; testId: string }) {
  return <div className={[className, "keyed-preview-error"].filter(Boolean).join(" ")} style={unavailablePlacement(style)} role="alert" aria-live="polite" aria-label={`${assetName} 去背預覽受阻`} data-keyed-preview-status="error" data-testid={`${testId}-key-error`}>
    <strong>去背預覽受阻</strong>
    <span>為避免誤顯示未去背原片，這個片段暫時隱藏。</span>
    <small>{reason}</small>
  </div>;
}

/**
 * Compatibility preview for the frozen v1 equation. Native resident preview intentionally
 * rejects keyed clips until its scene-linear alpha shader implements the identical contract.
 */
export default function KeyedPreviewMedia({ asset, source, settings, className, style, muted, videoRef, testId }: KeyedPreviewMediaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const operationKey = previewOperationKey(asset, source, settings);
  const [state, setState] = useState<KeyedPreviewState>({ key: operationKey, status: "loading" });
  const currentState: KeyedPreviewState = state.key === operationKey ? state : { key: operationKey, status: "loading" };

  useEffect(() => {
    let disposed = false;
    const ready = () => { if (!disposed) setState((current) => current.key === operationKey && current.status === "ready" ? current : { key: operationKey, status: "ready" }); };
    const fail = (error: unknown) => { if (!disposed) setState({ key: operationKey, status: "error", reason: keyedPreviewFailureMessage(error) }); };
    setState({ key: operationKey, status: "loading" });
    if (asset.kind === "image") {
      const image = imageRef.current;
      const canvas = canvasRef.current;
      if (!image || !canvas) return;
      const render = () => {
        try { renderKeyedPreviewFrame(canvas, image, image.naturalWidth, image.naturalHeight, settings); ready(); }
        catch (error) { fail(error); }
      };
      const loadError = () => fail(new Error("素材無法載入，去背預覽無法建立"));
      if (image.complete && image.naturalWidth > 0) render();
      image.addEventListener("load", render);
      image.addEventListener("error", loadError);
      return () => { disposed = true; image.removeEventListener("load", render); image.removeEventListener("error", loadError); };
    }

    const video = internalVideoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    let animationFrame = 0;
    let previousTime = Number.NaN;
    let firstFrameReady = false;
    const loadError = () => {
      fail(new Error("素材無法載入，去背預覽無法建立"));
      disposed = true;
      cancelAnimationFrame(animationFrame);
    };
    const render = () => {
      if (disposed) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && (video.currentTime !== previousTime || canvas.width <= 2)) {
        previousTime = video.currentTime;
        try {
          renderKeyedPreviewFrame(canvas, video, video.videoWidth, video.videoHeight, settings);
          if (!firstFrameReady) { firstFrameReady = true; ready(); }
        } catch (error) { fail(error); disposed = true; return; }
      }
      animationFrame = requestAnimationFrame(render);
    };
    video.addEventListener("error", loadError);
    animationFrame = requestAnimationFrame(render);
    return () => { disposed = true; video.removeEventListener("error", loadError); cancelAnimationFrame(animationFrame); };
  }, [asset.kind, operationKey, settings]);

  const sourceStyle: CSSProperties = {
    position: "absolute", width: 2, height: 2, opacity: 0, pointerEvents: "none",
  };
  return <>
    {asset.kind === "image"
      ? <img ref={imageRef} src={source} alt="" aria-hidden="true" style={sourceStyle} data-testid={`${testId}-key-source`} />
      : <video key={source} ref={(node) => { internalVideoRef.current = node; videoRef?.(node); }} src={source} playsInline muted={muted} preload="auto" aria-hidden="true" style={sourceStyle} data-testid={`${testId}-key-source`} />}
    {currentState.status === "error"
      ? <KeyedPreviewUnavailable assetName={asset.name} reason={currentState.reason} className={className} style={style} testId={testId} />
      : <canvas ref={canvasRef} className={className} style={style} aria-label={`${asset.name} 綠／藍幕去背預覽`} data-keyed-preview-status={currentState.status} data-testid={testId} />}
  </>;
}

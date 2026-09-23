import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ClipAlphaPlan } from "../domain/clipAlphaPlan";
import type { MediaAsset } from "../domain/types";
import {
  applyClipAlphaPlanRgbaInPlace,
  pixelMattePreviewUri,
} from "./alphaPlanPreview";
import "./keyedPreviewMedia.css";

interface AlphaProcessedPreviewMediaProps {
  asset: MediaAsset;
  source: string;
  plan: ClipAlphaPlan;
  localProjectFrame: number;
  projectWidth: number;
  projectHeight: number;
  className?: string;
  style?: CSSProperties;
  muted: boolean;
  videoRef?: (node: HTMLVideoElement | null) => void;
  testId: string;
}

const MAX_PREVIEW_EDGE = 640;

type AlphaPreviewState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready" }
  | { key: string; status: "error"; reason: string };

function boundedProjectSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) throw new Error("專案預覽尺寸不合法");
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

function drawContained(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): void {
  if (!Number.isFinite(sourceWidth) || sourceWidth < 1 || !Number.isFinite(sourceHeight) || sourceHeight < 1) throw new Error("素材畫面尺寸不合法");
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) throw new Error("瀏覽器未提供 2D Alpha 預覽");
  return context;
}

function resampledMatteAlpha(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Float32Array {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvasContext(canvas);
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  drawContained(context, source, sourceWidth, sourceHeight, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const result = new Float32Array(width * height);
  for (let index = 0; index < result.length; index += 1) {
    const red = rgba[index * 4];
    const green = rgba[index * 4 + 1];
    const blue = rgba[index * 4 + 2];
    if (Math.abs(red - green) > 1 || Math.abs(red - blue) > 1) throw new Error("Auto Roto 預覽不是受驗證的灰階 Alpha frame");
    result[index] = red / 255;
  }
  return result;
}

export function renderAlphaPlanPreviewFrame(
  canvas: HTMLCanvasElement,
  matteCanvas: HTMLCanvasElement,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  plan: ClipAlphaPlan,
  localProjectFrame: number,
  projectWidth: number,
  projectHeight: number,
  matteSource?: { source: CanvasImageSource; width: number; height: number },
): void {
  const size = boundedProjectSize(projectWidth, projectHeight);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const context = canvasContext(canvas);
  context.clearRect(0, 0, size.width, size.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  drawContained(context, source, sourceWidth, sourceHeight, size.width, size.height);
  const frame = context.getImageData(0, 0, size.width, size.height);
  const matteAlpha = matteSource
    ? resampledMatteAlpha(matteCanvas, matteSource.source, matteSource.width, matteSource.height, size.width, size.height)
    : undefined;
  applyClipAlphaPlanRgbaInPlace(frame.data, size.width, size.height, plan, { localProjectFrame, matteAlpha });
  context.putImageData(frame, 0, 0);
}

export function alphaPreviewFailureMessage(error: unknown): string {
  const candidate = typeof error === "object" && error !== null ? error as { name?: unknown; message?: unknown } : undefined;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = typeof candidate?.message === "string" ? candidate.message : typeof error === "string" ? error : "";
  if (name === "SecurityError" || /cross[- ]origin|cors|taint/i.test(message)) return "素材來源限制阻擋像素讀取（CORS）";
  if (/2D Alpha/i.test(message)) return "此裝置不支援 2D Alpha Canvas 預覽";
  return message ? `Alpha 計畫處理失敗：${message}` : "Alpha 計畫處理失敗";
}

function operationKey(asset: MediaAsset, source: string, plan: ClipAlphaPlan, matteUri: string | undefined): string {
  return [asset.id, asset.kind, source, matteUri ?? "", JSON.stringify(plan)].join("|");
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

export function AlphaPreviewUnavailable({ assetName, reason, className, style, testId }: { assetName: string; reason: string; className?: string; style?: CSSProperties; testId: string }) {
  return <div className={[className, "keyed-preview-error", "alpha-plan-preview-error"].filter(Boolean).join(" ")} style={unavailablePlacement(style)} role="alert" aria-live="polite" aria-label={`${assetName} Alpha 預覽受阻`} data-alpha-preview-status="error" data-testid={`${testId}-alpha-error`}>
    <strong>Alpha 預覽受阻</strong>
    <span>為避免誤顯示未處理原片，這個片段暫時隱藏。</span>
    <small>{reason}</small>
  </div>;
}

/** Closed-world Canvas executor for the shared ClipAlphaPlan contract. */
export default function AlphaProcessedPreviewMedia({
  asset,
  source,
  plan,
  localProjectFrame,
  projectWidth,
  projectHeight,
  className,
  style,
  muted,
  videoRef,
  testId,
}: AlphaProcessedPreviewMediaProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const matteCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const matteImageRef = useRef<HTMLImageElement>(null);
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const planRef = useRef(plan);
  const localProjectFrameRef = useRef(localProjectFrame);
  planRef.current = plan;
  localProjectFrameRef.current = localProjectFrame;
  let matteUri: string | undefined;
  let selectionError: string | undefined;
  try { matteUri = pixelMattePreviewUri(plan, localProjectFrame); }
  catch (error) { selectionError = alphaPreviewFailureMessage(error); }
  const previewKey = operationKey(asset, source, plan, matteUri);
  // Images need an explicit redraw as the Timeline advances. Video already has a
  // stable requestAnimationFrame executor and reads the latest frame through refs.
  const imageFrameKey = asset.kind === "image" ? localProjectFrame : 0;
  const [state, setState] = useState<AlphaPreviewState>(selectionError
    ? { key: previewKey, status: "error", reason: selectionError }
    : { key: previewKey, status: "loading" });
  const currentState: AlphaPreviewState = state.key === previewKey
    ? state
    : selectionError
      ? { key: previewKey, status: "error", reason: selectionError }
      : { key: previewKey, status: "loading" };

  useEffect(() => {
    if (selectionError) {
      setState({ key: previewKey, status: "error", reason: selectionError });
      return;
    }
    let disposed = false;
    let animationFrame = 0;
    const ready = () => { if (!disposed) setState({ key: previewKey, status: "ready" }); };
    const fail = (error: unknown) => {
      if (!disposed) setState({ key: previewKey, status: "error", reason: alphaPreviewFailureMessage(error) });
      disposed = true;
      cancelAnimationFrame(animationFrame);
    };
    setState({ key: previewKey, status: "loading" });
    const canvas = canvasRef.current;
    const matteCanvas = matteCanvasRef.current;
    const matteImage = matteImageRef.current;
    if (!canvas || !matteCanvas) return;
    const matteReady = () => !matteUri || Boolean(matteImage?.complete && matteImage.naturalWidth > 0);
    const matteSource = () => matteUri && matteImage
      ? { source: matteImage as CanvasImageSource, width: matteImage.naturalWidth, height: matteImage.naturalHeight }
      : undefined;

    if (asset.kind === "image") {
      const image = imageRef.current;
      if (!image) return;
      const render = () => {
        if (!image.complete || image.naturalWidth < 1 || !matteReady()) return;
        try {
          renderAlphaPlanPreviewFrame(canvas, matteCanvas, image, image.naturalWidth, image.naturalHeight, planRef.current, localProjectFrameRef.current, projectWidth, projectHeight, matteSource());
          ready();
        } catch (error) { fail(error); }
      };
      const sourceError = () => fail(new Error("素材無法載入，Alpha 預覽無法建立"));
      const matteError = () => fail(new Error("逐像素 Matte 預覽無法載入"));
      image.addEventListener("load", render);
      image.addEventListener("error", sourceError);
      matteImage?.addEventListener("load", render);
      matteImage?.addEventListener("error", matteError);
      if (image.complete && image.naturalWidth < 1) sourceError();
      else if (matteUri && matteImage?.complete && matteImage.naturalWidth < 1) matteError();
      else render();
      return () => {
        disposed = true;
        image.removeEventListener("load", render);
        image.removeEventListener("error", sourceError);
        matteImage?.removeEventListener("load", render);
        matteImage?.removeEventListener("error", matteError);
      };
    }

    const video = internalVideoRef.current;
    if (!video) return;
    let previousTime = Number.NaN;
    let firstFrameReady = false;
    const sourceError = () => fail(new Error("素材無法載入，Alpha 預覽無法建立"));
    const matteError = () => fail(new Error("逐像素 Matte 預覽無法載入"));
    const render = () => {
      if (disposed) return;
      if (matteReady() && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && (video.currentTime !== previousTime || canvas.width <= 2)) {
        previousTime = video.currentTime;
        try {
          renderAlphaPlanPreviewFrame(canvas, matteCanvas, video, video.videoWidth, video.videoHeight, planRef.current, localProjectFrameRef.current, projectWidth, projectHeight, matteSource());
          if (!firstFrameReady) { firstFrameReady = true; ready(); }
        } catch (error) { fail(error); return; }
      }
      animationFrame = requestAnimationFrame(render);
    };
    video.addEventListener("error", sourceError);
    matteImage?.addEventListener("error", matteError);
    if (matteUri && matteImage?.complete && matteImage.naturalWidth < 1) matteError();
    else animationFrame = requestAnimationFrame(render);
    return () => {
      disposed = true;
      video.removeEventListener("error", sourceError);
      matteImage?.removeEventListener("error", matteError);
      cancelAnimationFrame(animationFrame);
    };
  }, [asset.kind, imageFrameKey, matteUri, previewKey, projectHeight, projectWidth, selectionError]);

  const sourceStyle: CSSProperties = { position: "absolute", width: 2, height: 2, opacity: 0, pointerEvents: "none" };
  const canvasStyle: CSSProperties = currentState.status === "ready" ? (style ?? {}) : { ...style, visibility: "hidden" };
  return <>
    {asset.kind === "image"
      ? <img ref={imageRef} src={source} alt="" aria-hidden="true" style={sourceStyle} data-testid={`${testId}-alpha-source`} />
      : <video key={source} ref={(node) => { internalVideoRef.current = node; videoRef?.(node); }} src={source} playsInline muted={muted} preload="auto" aria-hidden="true" style={sourceStyle} data-testid={`${testId}-alpha-source`} />}
    {matteUri ? <img key={matteUri} ref={matteImageRef} src={matteUri} alt="" aria-hidden="true" style={sourceStyle} data-testid={`${testId}-alpha-matte-source`} /> : null}
    <canvas ref={matteCanvasRef} aria-hidden="true" style={sourceStyle} data-testid={`${testId}-alpha-matte-canvas`} />
    {currentState.status === "error"
      ? <AlphaPreviewUnavailable assetName={asset.name} reason={currentState.reason} className={className} style={style} testId={testId} />
      : <canvas ref={canvasRef} className={className} style={canvasStyle} aria-label={`${asset.name} Alpha 計畫預覽`} data-alpha-plan-schema={plan.schema} data-alpha-preview-status={currentState.status} data-testid={testId} />}
  </>;
}

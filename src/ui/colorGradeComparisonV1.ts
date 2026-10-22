/** Two bounded display surfaces; the existing GPU canvas and source decoder are reused. */
export const COLOR_COMPARISON_LIMITS_V1 = { width: 1280, height: 720 } as const;
/** Re-rendering a slider must not seek the same paused video again. */
export function seekColorScopeSourceV1(video: Pick<HTMLVideoElement, "currentTime">, time: number): void {
  if (!Number.isFinite(time)) throw new Error("Invalid comparison source time");
  const target = Math.max(0, time);
  if (Math.abs(video.currentTime - target) > 1e-7) video.currentTime = target;
}
export function colorComparisonGeometryV1(width: number, height: number, split: number) {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || !Number.isFinite(split)) throw new Error("Invalid comparison geometry");
  const scale = Math.min(1, COLOR_COMPARISON_LIMITS_V1.width / width, COLOR_COMPARISON_LIMITS_V1.height / height);
  const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  return { width: w, height: h, boundary: Math.round(w * Math.max(0, Math.min(1, split))) };
}
export function drawColorComparisonV1(output: HTMLCanvasElement, raw: HTMLCanvasElement, graded: HTMLCanvasElement, split: number) {
  const size = colorComparisonGeometryV1(graded.width, graded.height, split);
  if (raw.width !== size.width || raw.height !== size.height) throw new Error("Comparison frame dimensions differ");
  if (output.width !== size.width || output.height !== size.height) { output.width = size.width; output.height = size.height; }
  const ctx = output.getContext("2d"); if (!ctx) throw new Error("Comparison canvas unavailable");
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(raw, 0, 0, size.width, size.height);
  ctx.save();
  try { ctx.beginPath(); ctx.rect(size.boundary, 0, size.width - size.boundary, size.height); ctx.clip(); ctx.drawImage(graded, 0, 0, size.width, size.height); }
  finally { ctx.restore(); }
  if (size.boundary > 0 && size.boundary < size.width) { ctx.fillStyle = "#ffffff"; ctx.fillRect(size.boundary, 0, 1, size.height); }
  output.dataset.comparisonStatus = "ready";
  output.dataset.comparisonBoundary = String(size.boundary);
}
export type ComparisonMediaV1 = HTMLImageElement | HTMLVideoElement;
function sourceTime(source: ComparisonMediaV1): number | undefined { return source.tagName === "VIDEO" ? (source as HTMLVideoElement).currentTime : undefined; }
function readablePausedFrame(source: ComparisonMediaV1, time: number | undefined) {
  if (source.tagName !== "VIDEO") return (source as HTMLImageElement).complete && (source as HTMLImageElement).naturalWidth > 0;
  const video = source as HTMLVideoElement;
  return video.paused && !video.seeking && video.readyState >= 2 && video.currentTime === time;
}
export function createColorComparisonV1(getRaw: () => HTMLCanvasElement | null, getOutput: () => HTMLCanvasElement | null, onReady: (ready: boolean) => void) {
  let enabled = false, split = .5;
  let frame: { graded: HTMLCanvasElement; source: ComparisonMediaV1; time?: number; copied: boolean } | undefined;
  const clearSurfaces = () => {
    for (const canvas of [getRaw(), getOutput()]) if (canvas) { canvas.width = 1; canvas.height = 1; canvas.dataset.comparisonStatus = "waiting"; delete canvas.dataset.comparisonBoundary; }
    onReady(false);
  };
  const paint = () => {
    if (!enabled || !frame) { clearSurfaces(); return; }
    const raw = getRaw(), output = getOutput(); if (!raw || !output) return;
    if (!frame.copied) {
      if (!readablePausedFrame(frame.source, frame.time)) { clearSurfaces(); return; }
      const size = colorComparisonGeometryV1(frame.graded.width, frame.graded.height, split);
      if (raw.width !== size.width || raw.height !== size.height) { raw.width = size.width; raw.height = size.height; }
      const ctx = raw.getContext("2d"); if (!ctx) throw new Error("Comparison source canvas unavailable");
      ctx.clearRect(0, 0, size.width, size.height); ctx.drawImage(frame.source, 0, 0, size.width, size.height); frame.copied = true;
    }
    drawColorComparisonV1(output, raw, frame.graded, split); onReady(true);
  };
  return {
    /** Called synchronously after the same source element was drawn by the GPU. */
    receive: (graded: HTMLCanvasElement, source: ComparisonMediaV1) => { frame = { graded, source, time: sourceTime(source), copied: false }; if (enabled) paint(); },
    setMode: (active: boolean, position: number) => { enabled = active; split = position; if (!active && frame) frame.copied = false; paint(); },
    clear: () => { frame = undefined; clearSurfaces(); },
  };
}

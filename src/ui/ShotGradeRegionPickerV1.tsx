import { useEffect, useRef, useState, type PointerEvent } from "react";
import { previewPickerPointV1 } from "../color/previewPixelPickerV1";
import type { ShotGradeFrameV1, ShotGradeRegionV1 } from "../color/shotGradeStatisticsV1";
import { regionFromShotMatchPixelsV1 } from "./shotMatchPanelModelV1";

interface Props {
  frame: ShotGradeFrameV1; contextKey: string; regions: ShotGradeRegionV1[]; role: "neutral" | "skin";
  label: string; help: string; disabled?: boolean; onMark(region: ShotGradeRegionV1): void;
}
/** Only actual local post-v2 RGB8 raster pixels; overlay marks never alter the measured canvas. */
export function ShotGradeRegionPickerV1(props: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null), start = useRef<{ x: number; y: number; key: string } | undefined>(undefined);
  const [cursor, setCursor] = useState({ x: 0, y: 0 }), latest = useRef(props); latest.current = props;
  useEffect(() => {
    const f = props.frame, node = canvas.current; start.current = undefined; setCursor({ x: Math.floor(f.width / 2), y: Math.floor(f.height / 2) });
    if (!node || f.format !== "rgb8" || !(f.pixels instanceof Uint8Array) || f.pixels.length !== f.width * f.height * 3) return;
    node.width = f.width; node.height = f.height; const ctx = node.getContext("2d"); if (!ctx) return;
    const image = ctx.createImageData(f.width, f.height);
    for (let i = 0; i < f.width * f.height; i++) { for (let c = 0; c < 3; c++) image.data[i * 4 + c] = f.pixels[i * 3 + c]; image.data[i * 4 + 3] = 255; }
    ctx.putImageData(image, 0, 0);
  }, [props.contextKey, props.frame]);
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const node = event.currentTarget, css = getComputedStyle(node);
    return previewPickerPointV1(props.frame, node.getBoundingClientRect(), { x: event.clientX, y: event.clientY }, {
      left: parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft), right: parseFloat(css.borderRightWidth) + parseFloat(css.paddingRight),
      top: parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop), bottom: parseFloat(css.borderBottomWidth) + parseFloat(css.paddingBottom) });
  };
  const mark = (a: { x: number; y: number }, b = a) => { if (!latest.current.disabled) props.onMark(regionFromShotMatchPixelsV1(props.frame, props.role, a, b)); };
  return <figure style={{ margin: 0 }} data-testid="shot-grade-region-picker">
    <div style={{ position: "relative" }}>
      <canvas ref={canvas} width={props.frame.width} height={props.frame.height} style={{ display: "block", width: "100%", height: "auto", touchAction: "none" }}
        tabIndex={props.disabled ? -1 : 0} role="img" aria-label={props.label} aria-disabled={props.disabled} data-testid="shot-grade-region-canvas"
        onPointerDown={event => {
          if (props.disabled || event.button !== 0) return; const p = point(event); if (!p) return; event.preventDefault();
          start.current = { ...p, key: props.contextKey }; setCursor(p); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerUp={event => {
          const a = start.current; start.current = undefined; if (!a || a.key !== props.contextKey || props.disabled) return;
          const p = point(event); if (p) { setCursor(p); mark(a, p); }
        }} onPointerCancel={() => { start.current = undefined; }}
        onKeyDown={event => {
          if (props.disabled) return;
          if (event.key === "Escape") { start.current = undefined; return; }
          if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) mark(cursor); return; }
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1;
          setCursor(p => ({ x: Math.max(0, Math.min(props.frame.width - 1, p.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))),
            y: Math.max(0, Math.min(props.frame.height - 1, p.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))) }));
        }}/>
      <svg viewBox={`0 0 ${props.frame.width} ${props.frame.height}`} aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", color: "var(--accent)" }}>
        {props.regions.filter(r => r.sampleId === props.frame.sampleId).map((r, i) => <rect key={i} data-role={r.role} x={r.x * props.frame.width} y={r.y * props.frame.height}
          width={r.width * props.frame.width} height={r.height * props.frame.height} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke"/>)}
        <path d={`M${cursor.x + .5} ${cursor.y - 1.5}v4m-2-2h4`} stroke="currentColor" strokeWidth="1" fill="none" vectorEffect="non-scaling-stroke"/>
      </svg>
    </div>
    <figcaption><small>{props.help} · {props.frame.timeSeconds.toFixed(2)}s · {cursor.x}, {cursor.y}</small></figcaption>
  </figure>;
}

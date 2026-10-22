import { useEffect, useRef } from "react";
import { createFrameDeltaScheduler } from "./frameDeltaScheduler";

interface WorkspaceResizeHandleProps {
  axis: "horizontal" | "vertical";
  label: string;
  value: number;
  min: number;
  max: number;
  onDelta: (delta: number) => void;
}

export function WorkspaceResizeHandle({ axis, label, value, min, max, onDelta }: WorkspaceResizeHandleProps) {
  const last = useRef(0);
  const callback = useRef(onDelta);
  callback.current = onDelta;
  const scheduler = useRef<ReturnType<typeof createFrameDeltaScheduler> | undefined>(undefined);
  if (!scheduler.current) scheduler.current = createFrameDeltaScheduler({ requestFrame: action => requestAnimationFrame(action), cancelFrame: id => cancelAnimationFrame(id), onDelta: delta => callback.current(delta) });
  const batch = scheduler.current;
  useEffect(() => () => batch.cancel(), [batch]);
  return <div
    className={`workspace-resizer ${axis}`}
    role="separator"
    aria-label={label}
    aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
    aria-valuenow={value}
    aria-valuemin={min}
    aria-valuemax={max}
    tabIndex={0}
    onPointerDown={(event) => {
      last.current = axis === "horizontal" ? event.clientX : event.clientY;
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = axis === "horizontal" ? event.clientX : event.clientY;
      const delta = next - last.current;
      batch.add(delta);
      last.current = next;
    }}
    onPointerUp={(event) => {
      batch.flush();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={batch.flush}
    onLostPointerCapture={batch.flush}
    onKeyDown={(event) => {
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -16 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 16 : 0;
      if (delta) { event.preventDefault(); onDelta(delta); }
    }}
  ><span /></div>;
}

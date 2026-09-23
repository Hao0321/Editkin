import { useRef } from "react";

interface WorkspaceResizeHandleProps {
  axis: "horizontal" | "vertical";
  label: string;
  onDelta: (delta: number) => void;
}

export function WorkspaceResizeHandle({ axis, label, onDelta }: WorkspaceResizeHandleProps) {
  const last = useRef(0);
  return <div
    className={`workspace-resizer ${axis}`}
    role="separator"
    aria-label={label}
    aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
    tabIndex={0}
    onPointerDown={(event) => {
      last.current = axis === "horizontal" ? event.clientX : event.clientY;
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = axis === "horizontal" ? event.clientX : event.clientY;
      const delta = next - last.current;
      if (delta) onDelta(delta);
      last.current = next;
    }}
    onKeyDown={(event) => {
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -16 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 16 : 0;
      if (delta) { event.preventDefault(); onDelta(delta); }
    }}
  ><span /></div>;
}

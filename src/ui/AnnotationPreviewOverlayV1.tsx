import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import type { createAnnotationInteractionV1, AnnotationStateV1 } from "../application/annotationInteractionV1";
import { annotationCanvasPointV1 } from "../application/annotationDraftV1";

export interface AnnotationPreviewOverlayPropsV1 {
  driver: ReturnType<typeof createAnnotationInteractionV1>; state: AnnotationStateV1;
  width: number; height: number; label: string;
}
/** Mounted over the host's positioned preview stage. Its actual SVG screen CTM owns
 * canvas conversion, including viewBox letterboxing, scroll and CSS scale/zoom. */
export function AnnotationPreviewOverlayV1({ driver, state, width, height, label }: AnnotationPreviewOverlayPropsV1) {
  const root = useRef<SVGSVGElement>(null);
  useEffect(() => { root.current?.focus(); const blur = () => driver.cancel(); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("blur", blur); }; }, [driver]);
  const point = (event: PointerEvent<SVGSVGElement>, clamp: boolean) => {
    try { const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return undefined;
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      return annotationCanvasPointV1(p, width, height, clamp);
    } catch { return undefined; }
  };
  const release = (element: SVGSVGElement, pointer: number) => { if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer); };
  return <svg ref={root} className="annotation-preview-v1" data-testid="annotation-overlay" viewBox={`0 0 ${width} ${height}`}
    preserveAspectRatio="xMidYMid meet" role="application" aria-label={label} tabIndex={0}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); event.stopPropagation(); const p = point(event, false);
      if (!p || !driver.begin(p, event.pointerId)) return;
      event.currentTarget.focus(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { driver.cancelPointer(event.pointerId); }
    }}
    onPointerMove={event => { const p = point(event, true); if (p && driver.move(p, event.pointerId)) { event.preventDefault(); event.stopPropagation(); } }}
    onPointerUp={event => { const p = point(event, true); if (p) driver.finish(p, event.pointerId); else driver.cancelPointer(event.pointerId);
      release(event.currentTarget, event.pointerId); event.preventDefault(); event.stopPropagation(); }}
    onPointerCancel={event => { driver.cancelPointer(event.pointerId); release(event.currentTarget, event.pointerId); }}
    onLostPointerCapture={event => driver.cancelPointer(event.pointerId)}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); driver.cancel(); return; }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!event.repeat) void driver.commit(); return; }
      const step = event.shiftKey ? 10 : 1, movement: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const delta = movement[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); driver.nudge(...delta); }
    }}>
    <title>{label}</title>
    {state.draft && <g transform={`translate(${state.draft.guide.box.x} ${state.draft.guide.box.y})`} data-testid="annotation-guide" pointerEvents="none">
      {state.draft.guide.paths.map((path, index) => <path key={index} d={path.svg} fill={path.color} fillRule="nonzero" />)}
    </g>}
  </svg>;
}

import type { EditProject, MotionGraphic } from "../domain/types";
import type { MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import type { TrackedTextFrameV1 } from "../application/trackedTextGeometryV1";
import type { MotionFontSelection } from "../typography/motionFontReadiness";
import { translateUi as uiText } from "./i18n/interfacePreferences";

/** Presentation only. The parent prepares physical glyphs and the same bounded
 * world-space paths as ASS, and retains its existing visible error boundary. */
export default function TrackedPhysicalTextGraphicV1({ project, graphic, layout, frame, attributes, selection }: {
  project: EditProject; graphic: MotionGraphic; layout: MotionGraphicV2LayoutReceipt; frame: TrackedTextFrameV1;
  attributes: Record<string, string | undefined>; selection: MotionFontSelection;
}) {
  if (!frame.visible) return null;
  return <div className={`motion-graphic-v2 motion-${graphic.kind}`} data-testid="motion-tracked-text-v2" {...attributes}
    data-motion-preset={graphic.presetId} data-motion-composite-layer="foreground" data-motion-layout-receipt={layout.receiptId}
    data-motion-font-sha={frame.fontSha256} data-motion-font-manifest-sha={layout.physicalFont!.manifestSha256}
    data-motion-glyph-source="physical-outline" data-motion-track={frame.trackId} data-motion-tracking-mode={frame.mode}
    data-font-weight-substituted={selection.face?.weightSubstituted}
    title={selection.face?.weightSubstituted ? uiText("字重 {value0} → {value1}", { value0: selection.face.requestedWeight, value1: selection.face.fontWeight }) : undefined}
    style={{ left: 0, top: 0, width: "100%", height: "100%" }}>
    <svg data-testid="motion-glyph-outlines" viewBox={`0 0 ${project.width} ${project.height}`} preserveAspectRatio="none"
      role="img" aria-label={graphic.text} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
      {frame.paths.map(path => <path key={path.slot} data-motion-path-slot={path.slot} d={path.svg} fill={path.color} fillRule="nonzero"
        opacity={path.opacity} style={path.blurPixels ? { filter: `blur(${path.blurPixels}px)` } : undefined} />)}
    </svg>
  </div>;
}

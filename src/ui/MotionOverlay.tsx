import type { EditProject, NormalizedRect } from "../domain/types";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";
import { motionGraphicFrame } from "../motion/composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionPanelPaths } from "../motion/panelGeometry";
import "./motionStudio.css";

interface MotionOverlayProps {
  project: EditProject;
  playhead: number;
  trackingSelectionEnabled: boolean;
  trackingSelection?: NormalizedRect;
}

export default function MotionOverlay({ project, playhead, trackingSelectionEnabled, trackingSelection }: MotionOverlayProps) {
  return <>
    {project.motionGraphics.map((graphic) => {
      const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
      if (graphic.schema === "hao.motion-composition/v2") {
        try {
          const layout = motionGraphicV2LayoutReceipt(project, graphic);
          const frame = motionGraphicV2FrameReceipt(project, graphic, Math.round(playhead * project.fps), layout);
          if (!frame.visible) return null;
          const states = new Map(frame.segments.map((segment) => [segment.segmentId, segment]));
          const panel = motionPanelPaths(layout.box.width, layout.box.height, graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
          return <div key={graphic.id} className={`motion-graphic-v2 motion-${graphic.kind}`} data-testid="motion-graphic-v2" data-motion-preset={graphic.presetId} data-font-weight-substituted={face?.weightSubstituted} title={face?.weightSubstituted ? `字重 ${face.requestedWeight} → ${face.fontWeight}` : undefined} data-motion-layout-receipt={layout.receiptId} style={{
            left: `${layout.box.x / project.width * 100}%`, top: `${layout.box.y / project.height * 100}%`,
            width: `${layout.box.width / project.width * 100}%`, height: `${layout.box.height / project.height * 100}%`,
            color: graphic.textColor,
          }}>
            <svg className="motion-v2-background" viewBox={`0 0 ${layout.box.width} ${layout.box.height}`} preserveAspectRatio="none" aria-hidden="true" style={{ opacity: frame.backgroundOpacity }}>
              <path d={panel.fillSvg} fill={graphic.backgroundColor} />
              {panel.borderSvg && <path d={panel.borderSvg} fill={graphic.accentColor} fillRule="nonzero" />}
            </svg>
            {layout.segments.map((segment) => {
              const state = states.get(segment.id)!;
              return <span key={segment.id} style={{
                left: `${(segment.x - layout.box.x) / layout.box.width * 100}%`, top: `${(segment.y - layout.box.y) / layout.box.height * 100}%`,
                width: `${segment.width / layout.box.width * 100}%`, height: `${segment.height / layout.box.height * 100}%`,
                opacity: state.opacity, fontSize: `${layout.fontSize / layout.box.width * 100}cqw`, lineHeight: `${segment.height / layout.box.width * 100}cqw`,
                fontFamily: cssFontFamily(face?.fontFamily ?? graphic.fontFamily), fontWeight: face?.fontWeight ?? graphic.fontWeight, fontSynthesis: "style", letterSpacing: `${(graphic.letterSpacing ?? 0) / layout.box.width * 100}cqw`,
                transform: `translate(${state.translateXPixels / layout.box.width * 100}cqw, ${state.translateYPixels / layout.box.width * 100}cqw) scale(${state.scale})`,
                textShadow: graphic.shadowDepth ? `${graphic.shadowDepth / layout.box.width * 100}cqw ${graphic.shadowDepth / layout.box.width * 100}cqw ${(graphic.shadowDepth * 2) / layout.box.width * 100}cqw ${graphic.accentColor}` : undefined,
              }}>{segment.text}</span>;
            })}
          </div>;
        } catch (error) {
          return <div key={graphic.id} className="motion-v2-blocked" data-testid="motion-v2-blocked" title={error instanceof Error ? error.message : String(error)}>v2 排版受阻</div>;
        }
      }
      const frame = motionGraphicFrame(project, graphic, playhead);
      if (!frame.visible) return null;
      const projectPixel = (value: number) => `${value / project.width * 100}cqw`;
      return <div key={graphic.id} className={`motion-graphic motion-${graphic.kind}`} style={{
        left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, opacity: frame.opacity,
        transform: `rotate(${frame.rotationDegrees}deg) scale(${frame.scale})`, color: graphic.textColor, backgroundColor: graphic.backgroundColor,
        borderColor: graphic.accentColor, fontSize: projectPixel(graphic.fontSize),
        fontFamily: cssFontFamily(face?.fontFamily ?? graphic.fontFamily), fontWeight: face?.fontWeight ?? graphic.fontWeight, fontSynthesis: "style", letterSpacing: projectPixel(graphic.letterSpacing ?? 0),
        borderWidth: projectPixel(graphic.outlineWidth ?? 3), borderRadius: projectPixel(graphic.cornerRadius ?? 10),
        textShadow: graphic.shadowDepth ? `${projectPixel(graphic.shadowDepth * .35)} ${projectPixel(graphic.shadowDepth * .35)} 0 ${graphic.accentColor}, 0 ${projectPixel(graphic.shadowDepth * .45)} ${projectPixel(graphic.shadowDepth)} rgba(0,0,0,.38)` : undefined,
      }} data-testid="motion-graphic" data-font-weight-substituted={face?.weightSubstituted} title={face?.weightSubstituted ? `字重 ${face.requestedWeight} → ${face.fontWeight}` : undefined} data-visual-style={graphic.visualStyle ?? "solid_panel"}><span>{graphic.text}</span></div>;
    })}
    {trackingSelectionEnabled && <div className="tracking-help">框住要跟著跑的人或物件</div>}
    {trackingSelectionEnabled && trackingSelection && <div className="tracking-box" style={{
      left: `${trackingSelection.x * 100}%`, top: `${trackingSelection.y * 100}%`, width: `${trackingSelection.width * 100}%`, height: `${trackingSelection.height * 100}%`,
    }}><i /><i /><i /><i /></div>}
  </>;
}

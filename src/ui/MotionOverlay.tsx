import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import type { EditProject, NormalizedRect } from "../domain/types";
import { cloneElement, useMemo, type ReactElement } from "react";
import { cssFontFamily } from "../typography/fontFaces";
import { motionFontSelection, type MotionFontSelection } from "../typography/motionFontReadiness";
import { motionFontInLookahead } from "../typography/motionFontDelivery";
import { useMotionFontReadiness } from "./useMotionFontReadiness";
import { motionGraphicFrame } from "../motion/composition";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { trackedMotionVectorPathsV1 } from "../application/trackedVectorPathsV1";
import MotionPhysicalGlyphGraphic from "./MotionPhysicalGlyphGraphic";
import { motionClipWindowStyle } from "./motionClipWindow";
import { assertMotionScene2DGraphicFrameInk, prepareMotionSceneCamera2D, projectMotionScenePoint } from "../motion/sceneCamera2d";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import MotionV3Graphic from "./MotionV3Graphic";
import "./motionStudio.css";

interface MotionOverlayProps {
  project: EditProject;
  playhead: number;
  bakedGraphicIds?: readonly string[];
  /** Keep tracking controls while native presentation owns the whole image. */
  suppressGraphics?: boolean;
  trackingSelectionEnabled: boolean;
  trackingSelection?: NormalizedRect;
}

function MotionFontBoundary({ selection, children }: { selection: MotionFontSelection; children: ReactElement<Record<string, unknown>> | null }) {
  useI18n();
  const readiness = useMotionFontReadiness(selection, children ? "current" : "lookahead");
  // Stay mounted before the timeline interval so loading can finish before entry.
  if (!children) return null;
  const attributes = { "data-motion-font-status": readiness.status, "data-motion-font-face": selection.face?.faceId,
    "data-motion-font-file": selection.face?.fontFile };
  if (!["ready", "unobserved", "not-required"].includes(readiness.status)) return <div className="motion-v2-blocked" data-testid="motion-font-blocked"
    {...attributes} role={readiness.status === "pending" ? "status" : "alert"} title={readiness.reason}>
    <strong>{readiness.status === "pending" ? uiText("字型載入中") : readiness.status === "unverified" ? uiText("字型尚未驗證") : uiText("字型載入受阻")}</strong>
    {readiness.status !== "pending" && <span>{readiness.reason}{readiness.status === "unverified" ? uiText("。請選擇內建字型，或先完成自訂字型驗證。") : ""}</span>}
  </div>;
  return cloneElement(children, attributes);
}

export default function MotionOverlay({ project, playhead, bakedGraphicIds = [], suppressGraphics = false, trackingSelectionEnabled, trackingSelection }: MotionOverlayProps) {
  useI18n();
  const cameraScope = useMemo(() => {
    try { return { resolver: prepareMotionSceneCamera2D(project) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [project, project.motionScenes, project.motionGraphics, project.width, project.height, project.fps]);
  if (!cameraScope.resolver) return <div className="motion-v2-blocked" data-testid="motion-scene-blocked" role="alert" title={cameraScope.error}>{uiText("scene2d 鏡頭受阻")}</div>;
  return <>
    {project.motionGraphics.map((graphic) => {
      if (suppressGraphics) return null;
      if (bakedGraphicIds.includes(graphic.id)) return null;
      if (graphic.schema === "hao.motion-composition/v3") {
        try {
          const layout = motionGraphicV3Layout(project, graphic);
          const frame = motionGraphicV3Frame(project, graphic, Math.round(playhead * project.fps), layout);
          return frame.visible ? <MotionV3Graphic key={graphic.id} project={project} graphic={graphic} template={layout.template} frame={frame} /> : null;
        } catch (error) {
          return <div key={graphic.id} className="motion-v2-blocked" data-testid="motion-v3-blocked" title={error instanceof Error ? error.message : String(error)}>{uiText("v3 版型受阻")}</div>;
        }
      }
      if (!(graphic.schema === "hao.motion-composition/v2" && graphic.vectorV2) && !motionFontInLookahead(graphic, playhead)) return null;
      const selection = graphic.schema === "hao.motion-composition/v2" && graphic.vectorV2 ? undefined : motionFontSelection({ family: graphic.fontFamily ?? "Noto Sans TC", weight: graphic.fontWeight ?? 700, text: graphic.text });
      const face = selection?.face;
      if (graphic.schema === "hao.motion-composition/v2" && !graphic.vectorV2) return <MotionPhysicalGlyphGraphic key={graphic.id}
        project={project} graphic={graphic} playhead={playhead} selection={selection!} cameraScope={cameraScope.resolver} />;
      if (graphic.schema === "hao.motion-composition/v2") {
        try {
          const layout = motionGraphicV2LayoutReceipt(project, graphic);
          const timelineFrame = Math.round(playhead * project.fps);
          const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout);
          const camera = cameraScope.resolver.sample(graphic.id, timelineFrame);
          assertMotionScene2DGraphicFrameInk(project, graphic, layout, frame, camera);
          const origin = projectMotionScenePoint({ x: layout.box.x, y: layout.box.y }, camera);
          if (!frame.visible) return selection ? <MotionFontBoundary key={graphic.id} selection={selection}>{null}</MotionFontBoundary> : null;
          if (graphic.paintV1) return <div key={graphic.id} className="motion-v2-blocked" role="alert"
            data-testid="motion-paint-preview-unavailable">{uiText("漸層與遮罩預覽尚未就緒")}</div>;
          if (graphic.vectorV2 && frame.vectorState) {
            const state = frame.vectorState;
            return <div key={graphic.id} className="motion-graphic-v2" data-testid="motion-vector-v2"
              data-motion-font-status="not-required"
              data-motion-scene={camera.sceneId} data-motion-scene-receipt={camera.sceneId ? cameraScope.resolver.sourceSignature : undefined}
              data-motion-vector={graphic.vectorV2.kind} data-motion-vector-schema={graphic.vectorV2.schema}
              data-motion-composite-layer={graphic.compositeLayer ?? "foreground"} data-motion-layout-receipt={layout.receiptId} style={{
                ...(graphic.compositeLayer === "background" ? { zIndex: 0 } : {}),
                // Shapes stacked over text paint above every glyph, as the formal ASS layer does.
                ...((graphic.vectorV2.kind === "shape" || graphic.vectorV2.kind === "stroke") && graphic.vectorV2.stack === "over_text" ? { zIndex: graphic.vectorTrackingV1 ? 13 : 3 } : {}),
                left: `${origin.x / project.width * 100}%`, top: `${origin.y / project.height * 100}%`,
                width: `${layout.box.width * camera.scale / project.width * 100}%`, height: `${layout.box.height * camera.scale / project.height * 100}%`,
                ...motionClipWindowStyle(project, graphic, origin, layout.box.width * camera.scale, layout.box.height * camera.scale, camera),
              }}><svg className="motion-v2-background" viewBox={`0 0 ${layout.box.width} ${layout.box.height}`} preserveAspectRatio="none" aria-hidden="true" style={graphic.vectorTrackingV1 ? { overflow: "visible" } : undefined}>
                <g opacity={state.opacity} transform={`translate(${state.translateXPixels} ${state.translateYPixels}) scale(${state.scale})`}
                  style={(graphic.vectorV2 as { softnessPixels?: number }).softnessPixels ? { filter: `blur(${(graphic.vectorV2 as { softnessPixels?: number }).softnessPixels}px)` } : undefined}>
                  {trackedMotionVectorPathsV1(project, graphic, layout, frame).map((path, index) => path.clip
                    ? <g key={index}><clipPath id={`${graphic.id}-wipe-${index}`}><rect x={path.clip.x0} y={path.clip.y0} width={path.clip.x1 - path.clip.x0} height={path.clip.y1 - path.clip.y0} /></clipPath>
                      <path d={path.svg} fill={path.color} fillRule="nonzero" clipPath={`url(#${graphic.id}-wipe-${index})`} /></g>
                    : <path key={index} d={path.svg} fill={path.color} fillRule="nonzero" />)}
                </g>
              </svg></div>;
          }
          throw new Error("v2 vector 缺少同 frame evaluator 狀態");
        } catch (error) {
          return <div key={graphic.id} className="motion-v2-blocked" data-testid="motion-v2-blocked" title={error instanceof Error ? error.message : String(error)}>{uiText("v2 排版受阻")}</div>;
        }
      }
      const frame = motionGraphicFrame(project, graphic, playhead);
      if (!frame.visible) return <MotionFontBoundary key={graphic.id} selection={selection!}>{null}</MotionFontBoundary>;
      const projectPixel = (value: number) => `${value / project.width * 100}cqw`;
      return <MotionFontBoundary key={graphic.id} selection={selection!}><div className={`motion-graphic motion-${graphic.kind}`} style={{
        left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, opacity: frame.opacity,
        transform: `rotate(${frame.rotationDegrees}deg) scale(${frame.scale})`, color: graphic.textColor, backgroundColor: graphic.backgroundColor,
        borderColor: graphic.accentColor, fontSize: projectPixel(graphic.fontSize),
        fontFamily: cssFontFamily(face?.fontFamily ?? graphic.fontFamily), fontWeight: face?.fontWeight ?? graphic.fontWeight, fontSynthesis: "style", letterSpacing: projectPixel(graphic.letterSpacing ?? 0),
        borderWidth: projectPixel(graphic.outlineWidth ?? 3), borderRadius: projectPixel(graphic.cornerRadius ?? 10),
        textShadow: graphic.shadowDepth ? `${projectPixel(graphic.shadowDepth * .35)} ${projectPixel(graphic.shadowDepth * .35)} 0 ${graphic.accentColor}, 0 ${projectPixel(graphic.shadowDepth * .45)} ${projectPixel(graphic.shadowDepth)} rgba(0,0,0,.38)` : undefined,
      }} data-testid="motion-graphic" data-font-weight-substituted={face?.weightSubstituted} title={face?.weightSubstituted ? uiText("字重 {value0} → {value1}", { value0: face.requestedWeight, value1: face.fontWeight }) : undefined} data-visual-style={graphic.visualStyle ?? "solid_panel"}><span>{graphic.text}</span></div></MotionFontBoundary>;
    })}
    {trackingSelectionEnabled && <div className="tracking-help">{uiText("框住要跟著跑的人或物件")}</div>}
    {trackingSelectionEnabled && trackingSelection && <div className="tracking-box" style={{
      left: `${trackingSelection.x * 100}%`, top: `${trackingSelection.y * 100}%`, width: `${trackingSelection.width * 100}%`, height: `${trackingSelection.height * 100}%`,
    }}><i /><i /><i /><i /></div>}
  </>;
}

import { useMemo } from "react";
import type { EditProject, MotionGraphic } from "../domain/types";
import { motionGraphicV2FrameReceipt, motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout } from "../motion/compositionV2";
import { motionPanelPaths } from "../motion/panelGeometry";
import type { MotionFontSelection } from "../typography/motionFontReadiness";
import { useMotionFontReadiness } from "./useMotionFontReadiness";
import { assertMotionScene2DGraphicFrameInk, prepareMotionSceneCamera2D, projectMotionScenePoint } from "../motion/sceneCamera2d";

/** Client text uses prepared contours only. SSR/web readiness cannot create a
 * run. Outlines are segment-local and already include the physical baseline. */
export default function MotionPhysicalGlyphGraphic({ project, graphic, playhead, selection, cameraScope }: {
  project: EditProject; graphic: MotionGraphic; playhead: number; selection: MotionFontSelection;
  cameraScope?: ReturnType<typeof prepareMotionSceneCamera2D>;
}) {
  const timelineFrame = Math.round(playhead * project.fps);
  const startFrame = Math.round(graphic.timelineStart * project.fps);
  const durationFrames = Math.max(1, Math.round(graphic.duration * project.fps));
  const visible = timelineFrame >= startFrame && timelineFrame < startFrame + durationFrames;
  const readiness = useMotionFontReadiness(selection, visible ? "current" : "lookahead", { prepareGlyphs: true });
  const preparedCamera = useMemo(() => {
    try { return { resolver: cameraScope ?? prepareMotionSceneCamera2D(project) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [cameraScope, project, project.motionScenes, project.motionGraphics, project.width, project.height, project.fps]);
  // A playhead change reuses layout; authored edits and run identity rebuild it.
  const prepared = useMemo(() => {
    if (!readiness.glyphRun) return undefined;
    try { return { layout: prepareMotionGraphicV2FrameLayout(project, graphic,
      motionGraphicV2PhysicalLayoutReceipt(project, graphic, readiness.glyphRun)) }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [readiness.glyphRun, graphic, project.width, project.height, project.fps]);
  if (!visible) return null;
  const attributes = { "data-motion-font-status": readiness.status, "data-motion-font-face": selection.face?.faceId,
    "data-motion-font-file": selection.face?.fontFile };
  const blocked = (reason: string, pending = false) => <div className="motion-v2-blocked" data-testid="motion-font-blocked"
    {...attributes} role={pending ? "status" : "alert"} title={reason}>
    <strong>{pending ? "字形準備中" : "實體字形載入受阻"}</strong><span>{reason}</span>
  </div>;
  if (graphic.paintV1) return blocked("原生漸層與遮罩預覽尚未接入；不以純色預覽替代");
  if (readiness.status !== "ready" || !readiness.glyphRun) return blocked(readiness.reason
    ?? "此執行環境尚未準備實體 glyph 輪廓；請使用支援實體字型介面的桌面版本", readiness.status === "pending");
  if (!prepared?.layout) return blocked(prepared?.error ?? "實體 glyph 排版未完成");
  if (!preparedCamera.resolver) return blocked(preparedCamera.error ?? "scene2d 鏡頭未準備");
  try {
    const layout = prepared.layout;
    const frame = motionGraphicV2FrameReceipt(project, graphic, timelineFrame, layout);
    if (!frame.visible) return null;
    const camera = preparedCamera.resolver.sample(graphic.id, timelineFrame);
    assertMotionScene2DGraphicFrameInk(project, graphic, layout, frame, camera);
    const origin = projectMotionScenePoint({ x: layout.box.x, y: layout.box.y }, camera);
    if (!layout.physicalFont || layout.segments.some(segment => !segment.outline)) throw new Error("實體 glyph receipt 缺少 exact font identity／輪廓");
    const states = new Map(frame.segments.map(state => [state.segmentId, state]));
    const panel = motionPanelPaths(layout.box.width, layout.box.height, graphic.cornerRadius ?? 10, graphic.outlineWidth ?? 2);
    return <div className={`motion-graphic-v2 motion-${graphic.kind}`} data-testid="motion-graphic-v2" {...attributes}
      data-motion-preset={graphic.presetId} data-motion-composite-layer={graphic.compositeLayer ?? "foreground"}
      data-motion-layout-receipt={layout.receiptId} data-motion-font-sha={layout.physicalFont.fontSha256}
      data-motion-scene={camera.sceneId} data-motion-scene-receipt={camera.sceneId ? preparedCamera.resolver.sourceSignature : undefined}
      data-motion-font-manifest-sha={layout.physicalFont.manifestSha256} data-motion-glyph-source="physical-outline"
      data-font-weight-substituted={selection.face?.weightSubstituted}
      title={selection.face?.weightSubstituted ? `字重 ${selection.face.requestedWeight} → ${selection.face.fontWeight}` : undefined}
      style={{ ...(graphic.compositeLayer === "background" ? { zIndex: 0 } : {}),
        left: `${origin.x / project.width * 100}%`, top: `${origin.y / project.height * 100}%`,
        width: `${layout.box.width * camera.scale / project.width * 100}%`, height: `${layout.box.height * camera.scale / project.height * 100}%` }}>
      {!/^#[0-9a-f]{6}00$/i.test(graphic.backgroundColor) && <svg className="motion-v2-background"
        viewBox={`0 0 ${layout.box.width} ${layout.box.height}`} preserveAspectRatio="none" aria-hidden="true" style={{ opacity: frame.backgroundOpacity }}>
        <path d={panel.fillSvg} fill={graphic.backgroundColor} />
        {panel.borderSvg && <path d={panel.borderSvg} fill={graphic.accentColor} fillRule="nonzero" />}
      </svg>}
      <svg data-testid="motion-glyph-outlines" viewBox={`0 0 ${layout.box.width} ${layout.box.height}`} preserveAspectRatio="none"
        role="img" aria-label={graphic.text} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}>
        {layout.segments.map(segment => {
          const state = states.get(segment.id);
          if (!state) throw new Error("實體 glyph segment 缺少同 frame evaluator 狀態");
          if (state.rotationDegrees || state.blurPixels) {
            // Same pose as the ASS export: each layer rotates about its own scaled
            // segment center, and the shadow offset stays in screen space.
            const tx = segment.x - layout.box.x + state.translateXPixels, ty = segment.y - layout.box.y + state.translateYPixels;
            const rotate = state.rotationDegrees ? ` rotate(${state.rotationDegrees} ${segment.width / 2} ${segment.height / 2})` : "";
            const blur = state.blurPixels ? { filter: `blur(${state.blurPixels / state.scale}px)` } : undefined;
            const offset = (graphic.shadowDepth ?? 0) * state.scale;
            return <g key={segment.id} data-motion-segment={segment.id} opacity={state.opacity}>
              {graphic.shadowDepth ? <path d={segment.outline!.svg} fill={graphic.accentColor} fillRule="nonzero" style={blur}
                transform={`translate(${tx + offset} ${ty + offset}) scale(${state.scale})${rotate}`} aria-hidden="true" /> : null}
              <path d={segment.outline!.svg} fill={graphic.textColor} fillRule="nonzero" style={blur}
                transform={`translate(${tx} ${ty}) scale(${state.scale})${rotate}`} />
            </g>;
          }
          return <g key={segment.id} data-motion-segment={segment.id} opacity={state.opacity}
            transform={`translate(${segment.x - layout.box.x + state.translateXPixels} ${segment.y - layout.box.y + state.translateYPixels}) scale(${state.scale})`}>
            {graphic.shadowDepth ? <path d={segment.outline!.svg} fill={graphic.accentColor} fillRule="nonzero"
              transform={`translate(${graphic.shadowDepth} ${graphic.shadowDepth})`} aria-hidden="true" /> : null}
            <path d={segment.outline!.svg} fill={graphic.textColor} fillRule="nonzero" />
          </g>;
        })}
      </svg>
    </div>;
  } catch (error) { return blocked(error instanceof Error ? error.message : String(error)); }
}

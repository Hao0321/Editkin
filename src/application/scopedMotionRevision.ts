import type { EditorCommand } from "../domain/commands";
import type { EditProject, MotionGraphic } from "../domain/types";
import { assertMotionGraphicV2Contract, motionGraphicV2UnitCount, motionGraphicV2ExitStaggerFrames } from "../domain/motionCompositionV2Contract";
import { canonicalJson } from "../shared/canonicalJson";
import { assertContinuityVectorFrameRange, assertContinuityVectorLayout } from "../domain/motionContinuityContract";
import { sampleSpringGeometryTrack } from "../motion/springGeometryTrack";
import { motionPanelPaths } from "../motion/panelGeometry";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";

/** Existing-layer timing revisions have no new title/card identity to infer. */
export function isScopedMotionRevision(command: EditorCommand): boolean {
  return command.type === "update_motion_graphic" && Object.keys(command.patch).length === 1
    && (command.patch.motionV2 !== undefined || command.patch.vectorV2?.kind === "spring_panel");
}

/** This revision lane preserves the same reading-hold floor as its authoring tool. */
export function assertScopedMotionReadingHold(graphic: MotionGraphic, fps: number): void {
  const motion = graphic.motionV2;
  if (!motion) throw new Error("Scoped Motion revision needs v2 motion");
  if (!graphic.text.trim()) return;
  const stagger = Math.max(0, motionGraphicV2UnitCount(graphic) - 1) * (motion.sequence.staggerFrames + motionGraphicV2ExitStaggerFrames(motion));
  if (motion.entrance.durationFrames + motion.exit.durationFrames + stagger + Math.ceil(fps * .8) > Math.round(graphic.duration * fps)) {
    throw new Error("修訂會吃掉文字的閱讀停留，請延長這個元素或縮短入出場");
  }
}

function assertGeometryBinding(original: MotionGraphic, revised: MotionGraphic): void {
  if (original.vectorV2?.kind !== "spring_panel" || revised.vectorV2?.kind !== "spring_panel") throw new Error("Scoped geometry revision needs an existing continuity target");
  if (original.id !== revised.id || original.timelineStart !== revised.timelineStart || original.duration !== revised.duration
    || original.x !== revised.x || original.y !== revised.y || original.width !== revised.width
    || (original.compositeLayer ?? "foreground") !== (revised.compositeLayer ?? "foreground")
    || canonicalJson(original.vectorV2.geometry.envelope) !== canonicalJson(revised.vectorV2.geometry.envelope)) {
    throw new Error("Scoped geometry revision must preserve identity, range, position and fixed envelope");
  }
}

/** A zero-delta event or sub-contour-rounding edit cannot earn visual credit. */
function geometryChangesVisibleContour(original: MotionGraphic, revised: MotionGraphic, project: EditProject): boolean {
  if (original.vectorV2?.kind !== "spring_panel" || revised.vectorV2?.kind !== "spring_panel") return false;
  const colorVisible = (color: string) => color.length !== 9 || parseInt(color.slice(7), 16) > 0;
  const fillVisible = colorVisible(revised.backgroundColor), strokeVisible = (revised.outlineWidth ?? 0) > 0 && colorVisible(revised.accentColor);
  if (!fillVisible && !strokeVisible) return false;
  const layout = motionGraphicV2LayoutReceipt(project, revised), fps = project.fps;
  for (let frame = 0, frames = Math.round(original.duration * fps); frame < frames; frame++) {
    const receipt = motionGraphicV2FrameReceipt(project, revised, Math.round(revised.timelineStart * fps) + frame, layout);
    if (!receipt.visible || !receipt.vectorState || receipt.vectorState.opacity <= .001) continue;
    const before = sampleSpringGeometryTrack(original.vectorV2.geometry, frame).geometry;
    const after = sampleSpringGeometryTrack(revised.vectorV2.geometry, frame).geometry;
    const paths = (geometry: typeof before) => motionPanelPaths(geometry.width, geometry.height, geometry.cornerRadius,
      original.outlineWidth ?? 0, { x: geometry.x, y: geometry.y });
    const a = paths(before), b = paths(after);
    if (fillVisible && a.fillSvg !== b.fillSvg || strokeVisible && a.borderSvg !== b.borderSvg) return true;
  }
  return false;
}

/** Read-only, ordered target check; the regular v4 dry apply remains mandatory. */
export function assertScopedMotionRevisionEffects(project: EditProject, commands: readonly EditorCommand[]): void {
  const graphics = new Map<string, MotionGraphic>(project.motionGraphics.map(graphic => [graphic.id, structuredClone(graphic)]));
  const revisedIds = new Set<string>();
  const baselines = new Map<string, MotionGraphic>();
  const geometryBaselines = new Map<string, MotionGraphic>();
  const inspect = (command: EditorCommand): void => {
    if (command.type === "batch") { command.commands.forEach(inspect); return; }
    if (command.type === "add_motion_graphic") { graphics.set(command.graphic.id, structuredClone(command.graphic)); return; }
    if (command.type === "delete_motion_graphic") { graphics.delete(command.graphicId); return; }
    if (command.type !== "update_motion_graphic") return;
    const original = graphics.get(command.graphicId);
    const geometryRevision = command.patch.vectorV2 !== undefined && (command.patch.vectorV2.kind === "spring_panel" || original?.vectorV2?.kind === "spring_panel");
    if (command.patch.motionV2 !== undefined || geometryRevision) {
      if (!isScopedMotionRevision(command)) throw new Error("Scoped Motion revision must change motionV2 or continuity vectorV2 alone");
      if (original?.schema !== "hao.motion-composition/v2" || !original.motionV2) throw new Error("Scoped Motion revision needs an existing v2 target");
      const revised = { ...original, ...structuredClone(command.patch) };
      assertMotionGraphicV2Contract(revised, project.fps);
      assertContinuityVectorFrameRange(revised, project.fps);
      assertContinuityVectorLayout(project, revised);
      if (geometryRevision) {
        assertGeometryBinding(original, revised);
        if (!geometryChangesVisibleContour(original, revised, project)) throw new Error("Scoped geometry revision is unchanged; no visible contour decision was executed");
        if (!geometryBaselines.has(command.graphicId)) geometryBaselines.set(command.graphicId, structuredClone(original));
      } else if (canonicalJson(original.motionV2) === canonicalJson(command.patch.motionV2)) throw new Error("Scoped Motion revision is unchanged; no visual decision was executed");
      assertScopedMotionReadingHold(revised, project.fps);
      if (!baselines.has(command.graphicId)) baselines.set(command.graphicId, structuredClone(original));
      revisedIds.add(command.graphicId);
    }
    if (original) graphics.set(command.graphicId, { ...original, ...structuredClone(command.patch) });
  };
  commands.forEach(inspect);
  // Later ordinary patches must not undo the scoped lane's hold protection.
  // Credit is only given to the final surviving target, not an intermediate map.
  for (const id of revisedIds) {
    const final = graphics.get(id);
    if (!final || final.schema !== "hao.motion-composition/v2" || !final.motionV2) throw new Error("Scoped Motion revision needs a final surviving v2 target");
    assertMotionGraphicV2Contract(final, project.fps);
    assertContinuityVectorFrameRange(final, project.fps);
    assertContinuityVectorLayout(project, final);
    const geometryBaseline = geometryBaselines.get(id);
    if (geometryBaseline) {
      assertGeometryBinding(geometryBaseline, final);
      if (!geometryChangesVisibleContour(geometryBaseline, final, project)) throw new Error("Scoped geometry final contour is unchanged");
    } else if (canonicalJson(baselines.get(id)!.motionV2) === canonicalJson(final.motionV2)) throw new Error("Scoped Motion final revision is unchanged");
    assertScopedMotionReadingHold(final, project.fps);
  }
}

import type { EditorCommand } from "../domain/commands";
import type { EditProject, MotionGraphic } from "../domain/types";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { canonicalJson } from "../shared/canonicalJson";

const colorFields = ["textColor", "backgroundColor", "accentColor"] as const;
const colorPattern = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
export function isScopedPaletteRevision(command: EditorCommand): command is Extract<EditorCommand, { type: "update_motion_graphic" }> {
  return command.type === "update_motion_graphic" && Object.keys(command.patch).length > 0
    && Object.entries(command.patch).every(([key, value]) => colorFields.includes(key as typeof colorFields[number])
      && typeof value === "string" && colorPattern.test(value));
}
export function isPaletteTargetManaged(project: Pick<EditProject, "motionScenes" | "referenceMotionInstances">, graphic: MotionGraphic): boolean {
  return Boolean(graphic.templateOwner || project.motionScenes?.some(scene => scene.graphicIds.includes(graphic.id))
    || project.referenceMotionInstances?.some(instance => instance.roles.some(role => role.kind === "graphic" && role.id === graphic.id)));
}
const paint = (color: string) => color.toUpperCase().slice(0, 7) + (color.length === 9 ? color.slice(7).toUpperCase() : "FF");
const visiblePaint = (color: string) => !color.endsWith("00");

/** A bounded witness of an actual active paint change, not full pixel/art acceptance. */
function changesActivePaint(project: EditProject, before: MotionGraphic, after: MotionGraphic): boolean {
  // These roles do not drive versioned glyph ink; never award ineffective edits.
  if (before.paintV1 || after.paintV1) return false;
  if (before.schema !== "hao.motion-composition/v2" || after.schema !== before.schema) return false;
  if (!colorFields.some(key => paint(before[key]) !== paint(after[key]))) return false;
  // Hold final geometry, typography and clocks fixed: another edit cannot earn
  // palette credit after its colors have been undone or its paint role removed.
  const baseline = { ...after, textColor: before.textColor, backgroundColor: before.backgroundColor, accentColor: before.accentColor };
  if (!after.vectorV2) {
    const panelVisible = visiblePaint(paint(baseline.backgroundColor)) || visiblePaint(paint(after.backgroundColor));
    const active = ["backgroundColor", ...(after.text.trim() ? ["textColor"] : []),
      ...((panelVisible && (after.outlineWidth ?? 2) > 0) || (after.text.trim() && (after.shadowDepth ?? 0) > 0) ? ["accentColor"] : [])] as typeof colorFields[number][];
    return active.some(key => paint(baseline[key]) !== paint(after[key]) && (visiblePaint(paint(baseline[key])) || visiblePaint(paint(after[key]))));
  }
  const layout = motionGraphicV2LayoutReceipt(project, after), count = Math.round(after.duration * project.fps);
  const revealFrame = "revealFrames" in after.vectorV2 ? after.vectorV2.revealFrames : after.motionV2?.entrance.durationFrames ?? 0;
  const exitStart = count - (after.motionV2?.exit.durationFrames ?? 0);
  const candidates = [0, Math.floor(count / 2), revealFrame, exitStart - 1, exitStart];
  if (after.vectorV2.kind === "connection_field") {
    candidates.push(after.vectorV2.connectStartFrame + 1, after.vectorV2.connectStartFrame + after.vectorV2.connectFrames);
  }
  const samples = new Set(candidates.map(local => Math.max(0, Math.min(count - 1, local))));
  for (const local of samples) {
    const frame = motionGraphicV2FrameReceipt(project, after, Math.round(after.timelineStart * project.fps) + local, layout);
    const signature = (graphic: MotionGraphic) => motionVectorPaths(graphic, layout, frame)
      .filter(path => path.svg && visiblePaint(paint(path.color))).map(path => ({ path: path.svg, color: paint(path.color) }));
    if (canonicalJson(signature(baseline)) !== canonicalJson(signature(after))) return true;
  }
  return false;
}

/** Audit and apply check the ordered targets and the final surviving paint. */
export function assertScopedPaletteRevisionEffects(project: EditProject, commands: readonly EditorCommand[]): void {
  const graphics = new Map(project.motionGraphics.map(graphic => [graphic.id, graphic]));
  const originalIds = new Set(graphics.keys()), replacedIds = new Set<string>();
  const baselines = new Map<string, MotionGraphic>();
  const managedIds = new Set(project.motionGraphics.filter(graphic => isPaletteTargetManaged(project, graphic)).map(graphic => graphic.id));
  const inspect = (command: EditorCommand) => {
    if (command.type === "batch") { command.commands.forEach(inspect); return; }
    if (command.type === "add_motion_scene" || command.type === "update_motion_scene") command.scene.graphicIds.forEach(id => managedIds.add(id));
    if (command.type === "upsert_reference_motion_instance") command.instance.roles.filter(role => role.kind === "graphic").forEach(role => managedIds.add(role.id));
    if (command.type === "add_motion_graphic") {
      if (originalIds.has(command.graphic.id)) replacedIds.add(command.graphic.id);
      graphics.set(command.graphic.id, command.graphic); return;
    }
    if (command.type === "delete_motion_graphic") { replacedIds.add(command.graphicId); graphics.delete(command.graphicId); return; }
    if (command.type !== "update_motion_graphic") return;
    const before = graphics.get(command.graphicId), after = before ? { ...before, ...command.patch } : undefined;
    if (colorFields.some(field => Object.prototype.hasOwnProperty.call(command.patch, field))) {
      if (!isScopedPaletteRevision(command)) throw new Error("Scoped palette must change color fields alone");
      if (!before || before.schema !== "hao.motion-composition/v2" || !after || !originalIds.has(before.id) || replacedIds.has(before.id)) throw new Error("Scoped palette needs an existing unreplaced v2 target");
      if (managedIds.has(before.id) || before.templateOwner) throw new Error("Scoped palette target is owner-managed");
      if (!changesActivePaint(project, before, after)) throw new Error("Scoped palette has no active paint change");
      if (!baselines.has(before.id)) baselines.set(before.id, before);
    }
    if (after) graphics.set(command.graphicId, after);
  };
  commands.forEach(inspect);
  for (const [id, baseline] of baselines) {
    const final = graphics.get(id);
    if (!final || replacedIds.has(id) || managedIds.has(id) || final.templateOwner || !changesActivePaint(project, baseline, final)) {
      throw new Error("Scoped palette needs a final surviving unowned paint change");
    }
  }
}

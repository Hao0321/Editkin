import type { EditorCommand } from "./commandTypes";
import type { EditProject, MotionGraphic } from "./types";
import { assertMotionScene2D } from "./motionScene2d";
import { assertMotionPaintContract } from "./motionPaint";
import { assertMotionGraphicV2Contract, motionGraphicV2UnitCount, motionGraphicV2ExitStaggerFrames } from "./motionCompositionV2Contract";
import { canonicalJson } from "../shared/canonicalJson";

export type OriginalSceneGraphicRevisionCommand = Extract<EditorCommand, { type: "revise_motion_scene_graphics" }>;
const preparedCommands = new WeakMap<OriginalSceneGraphicRevisionCommand, { project: string; command: string }>();
/** Internal application authority after true physical/full-frame preparation.
 * A serialized command or a caller's boolean is never this process-owned proof. */
export function issueOriginalSceneGraphicRevision(project: EditProject, command: OriginalSceneGraphicRevisionCommand): void {
  assertOriginalSceneGraphicRevision(project, command);
  preparedCommands.set(command, { project: canonicalJson(project), command: canonicalJson(command) });
}
export function assertPreparedOriginalSceneGraphicRevision(project: EditProject, command: OriginalSceneGraphicRevisionCommand): void {
  const proof = preparedCommands.get(command);
  if (!proof || proof.project !== canonicalJson(project) || proof.command !== canonicalJson(command)) {
    throw new Error("ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED: exact current project and physically prepared command authority are required");
  }
}
const editable = new Set(["text", "fontFamily", "fontWeight", "fontSize", "letterSpacing", "textColor", "backgroundColor", "layoutV2", "paintV1", "motionV2"]);
function immutableGraphic(graphic: MotionGraphic): unknown {
  return Object.fromEntries(Object.entries(graphic).filter(([key]) => !editable.has(key)));
}
function paintWithoutColors(graphic: MotionGraphic): unknown {
  if (!graphic.paintV1) return undefined;
  const paint = structuredClone(graphic.paintV1);
  const fill = paint.fill.kind === "solid" ? { kind: "solid" }
    : { ...paint.fill, stops: paint.fill.stops.map(({ color: _color, ...stop }) => stop) };
  return { ...paint, fill };
}

/** Manual scene-owner content editing, never an authored-source/rights proof.
 * Full-scene physical preparation belongs to the application; canonical v4
 * explicitly refuses this command until source-bound revision admission exists. */
export function assertOriginalSceneGraphicRevision(project: EditProject, command: OriginalSceneGraphicRevisionCommand): void {
  if (project.revision !== command.expectedRevision) throw new Error("Motion scene project revision is stale");
  const matches = (project.motionScenes ?? []).filter(scene => scene.id === command.expectedScene.id);
  if (matches.length !== 1 || canonicalJson(matches[0]) !== canonicalJson(command.expectedScene)) throw new Error("Motion scene owner changed; re-read its current content");
  const scene = matches[0], ids = scene.graphicIds;
  if (command.expectedGraphics.length !== ids.length || command.graphics.length !== ids.length
    || command.expectedGraphics.some((graphic, i) => graphic.id !== ids[i]) || command.graphics.some((graphic, i) => graphic.id !== ids[i])) {
    throw new Error("Motion scene revision must preserve its exact ordered graphic identities");
  }
  const current = ids.map(id => project.motionGraphics.filter(graphic => graphic.id === id));
  if (current.some(list => list.length !== 1) || canonicalJson(current.map(list => list[0])) !== canonicalJson(command.expectedGraphics)) {
    throw new Error("Motion scene graphic content changed; re-read before editing");
  }
  for (let i = 0; i < ids.length; i++) {
    const before = current[i][0], after = command.graphics[i];
    if (before.templateOwner || project.referenceMotionInstances?.some(instance => instance.roles.some(role => role.kind === "graphic" && role.id === before.id))
      || project.motionScenes?.some(other => other.id !== scene.id && other.graphicIds.includes(before.id))) {
      throw new Error("Motion scene graphic has another owner; revise that owner instead");
    }
    if (canonicalJson(immutableGraphic(before)) !== canonicalJson(immutableGraphic(after))
      || canonicalJson(before.layoutV2?.safeArea) !== canonicalJson(after.layoutV2?.safeArea)
      || before.layoutV2?.widthMode !== after.layoutV2?.widthMode
      || canonicalJson(paintWithoutColors(before)) !== canonicalJson(paintWithoutColors(after))) {
      throw new Error("Motion scene content edit cannot change geometry, source, paint topology, layer, range or ownership");
    }
    if (before.vectorV2 && (before.text !== after.text || before.fontFamily !== after.fontFamily || before.fontSize !== after.fontSize
      || before.fontWeight !== after.fontWeight || before.letterSpacing !== after.letterSpacing || canonicalJson(before.layoutV2) !== canonicalJson(after.layoutV2))) {
      throw new Error("Motion scene shape editing cannot silently turn a vector into text");
    }
    if (before.paintV1 && after.paintV1) {
      const colors = (graphic: MotionGraphic) => graphic.paintV1!.fill.kind === "solid" ? [graphic.paintV1!.fill.color]
        : graphic.paintV1!.fill.stops.map(stop => stop.color);
      const a = colors(before), b = colors(after);
      if (a.length !== b.length || a.some((color, index) => color.slice(7).toLowerCase() !== b[index].slice(7).toLowerCase())) {
        throw new Error("Motion scene palette edit must preserve authored paint alpha");
      }
    }
    assertMotionPaintContract(after); assertMotionGraphicV2Contract(after, project.fps);
    if (!after.vectorV2 && after.motionV2) {
      const motion = after.motionV2, stagger = Math.max(0, motionGraphicV2UnitCount(after) - 1) * (motion.sequence.staggerFrames + motionGraphicV2ExitStaggerFrames(motion));
      if (motion.entrance.durationFrames + motion.exit.durationFrames + stagger + Math.ceil(project.fps * .8) > Math.round(after.duration * project.fps)) {
        throw new Error("Motion scene content edit would remove the text reading hold");
      }
    }
  }
  const replacements = new Map(command.graphics.map(graphic => [graphic.id, graphic]));
  assertMotionScene2D(scene, { ...project, motionGraphics: project.motionGraphics.map(graphic => replacements.get(graphic.id) ?? graphic) });
}

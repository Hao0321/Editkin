import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectCodec";
import { prepareReferenceMotionTemplateInstance, referenceMotionTemplateInstanceScopeSha256 } from "./referenceMotionTemplateInstances";

// Test fixture: titles made by "an older Editkin", built with today's real compiler and the bundled font bytes, then
// given the recipe identity (and, where asked, the slightly different layout) an older version recorded, with their
// saved scope hashed exactly as that version saved it. Only tests import this file.

const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
/** The real glyph runs from public/fonts, as the desktop and the MCP use them. */
export async function physicalTemplateText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    faces.set(faceId, face);
  }
  return (await face)(text);
}

function clip(id: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart: 1, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
function input(clipId: string, startFrame: number, durationFrames: number, title: string, kicker: string, subtitle: string): ReferenceMotionTemplateInput {
  return { templateId: "level_bridge", clipId, startFrame, durationFrames, title, kicker, subtitle, purpose: "Owned control", evidenceRefs: ["owned:fixture"],
    graphicCadence: "kinetic", style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
}

export const instanceOf = (project: EditProject, id: string): ReferenceMotionTemplateInstance => project.referenceMotionInstances!.find(item => item.id === id)!;

/**
 * As an older Editkin left the template: another recipe identity (`older`, by default an older recipe digest) and, via
 * `change`, whatever else that version laid out differently; its scope is then hashed as that version saved it.
 */
export async function madeByOlderEditkin(project: EditProject, id: string,
  change: (project: EditProject, instance: ReferenceMotionTemplateInstance) => void = () => undefined,
  older: (instance: ReferenceMotionTemplateInstance) => void = instance => {
    instance.dependencies.recipeVersion = `${instance.dependencies.recipeVersion.split(":")[0]}:${"0".repeat(64)}`;
  }): Promise<EditProject> {
  const value = structuredClone(project), instance = instanceOf(value, id);
  older(instance);
  change(value, instance);
  instance.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(value, instance);
  return value;
}

export interface OldTitlesFixture {
  /** Before any aging: today's compiled project (for comparing the layout an update produces). */
  compiled: EditProject;
  project: EditProject;
  /** fresh: old and untouched (updated); edited: old, then changed by hand; current: today's, changed by hand (EDITED);
   *  short: old, on a clip today's template finds too short. */
  ids: { fresh: string; edited: string; current: string; short: string };
  /** The headline-like graphic of `fresh` the older version placed differently. */
  movedGraphicId: string;
}

/**
 * [a 1–7 s FOCUS][b 8–14 s RIVER][c 15–21 s CAVE][d 22–25.5 s BATS], each with a level_bridge title template (≥ 3 s).
 * `mediaUri` places the video (it is part of each template's saved scope), e.g. inside an MCP test workspace.
 */
export async function oldTitlesProject(options: { mediaUri?: string } = {}): Promise<OldTitlesFixture> {
  const value = createEmptyProject("Old titles", { id: "old-titles", width: 1080, height: 1920, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: options.mediaUri ?? "D:/owned/trip.mp4", duration: 60, width: 1080, height: 1920,
    displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  value.tracks[0].clips = [clip("a", 1, 6), clip("b", 8, 6), clip("c", 15, 6), clip("d", 22, 3.5)];
  let project = parseProject(validateProject(value));
  const ids: string[] = [];
  for (const [clipId, start, frames, title, kicker, subtitle] of [["a", 30, 180, "FOCUS", "LOOK", "Slow down"], ["b", 240, 180, "RIVER", "WALK", "Follow it"],
    ["c", 450, 180, "CAVE", "STEP", "Mind the bats"], ["d", 660, 105, "BATS", "GONE", "Not any more"]] as const) {
    let next = 0;
    const packet = await prepareReferenceMotionTemplateInstance(project, input(clipId, start, frames, title, kicker, subtitle),
      (kind, role) => `${clipId}-${kind}-${role ?? ""}-${next++}`, { prepareText: physicalTemplateText });
    project = applyCommand(project, { type: "batch", commands: packet.commands });
    ids.push(packet.instance.id);
  }
  const compiled = project;
  const [fresh, edited, current, short] = ids;
  const textGraphic = (id: string) => instanceOf(project, id).roles.find(role => role.kind === "graphic"
    && project.motionGraphics.find(graphic => graphic.id === role.id)?.text === instanceOf(project, id).input.title)!.id;
  const movedGraphicId = textGraphic(fresh);
  // fresh: the older version put its title a little higher.
  project = await madeByOlderEditkin(project, fresh, value => {
    const graphic = value.motionGraphics.find(item => item.id === movedGraphicId)!;
    graphic.y = Math.max(0, graphic.y - 0.05);
  });
  // edited: old, then its words changed by hand afterwards (the saved scope no longer matches).
  project = await madeByOlderEditkin(project, edited);
  project = structuredClone(project);
  project.motionGraphics.find(item => item.id === textGraphic(edited))!.text = "RIVER!";
  // current: today's recipe, changed by hand (EDITED).
  project.motionGraphics.find(item => item.id === textGraphic(current))!.text = "CAVE!";
  // short: the older version accepted a 2-second clip; today's template needs 3 seconds.
  project = await madeByOlderEditkin(project, short, (value, instance) => {
    value.tracks[0].clips.find(item => item.id === "d")!.duration = 2;
    instance.input.durationFrames = 60;
  });
  return { compiled, project, ids: { fresh, edited, current, short }, movedGraphicId };
}

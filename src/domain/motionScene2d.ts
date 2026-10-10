import type { EditProject, MotionGraphic } from "./types";
import type { SpringTargetTrack } from "./motionContinuity";
import { assertMotionGraphicV2Contract } from "./motionCompositionV2Contract";
import { assertSpringTargetTrack, sampleSpringTargetTrack } from "../motion/springTargetTrack";

export const MOTION_SCENE_2D_LIMITS = Object.freeze({ scenes: 16, frames: 1800, graphics: 32,
  semanticCues: 32, eventsPerTrack: 32, graphicFrameEvaluations: 100_000,
  coordinate: 100_000, coordinateVelocity: 32768, minZoom: .05, maxZoom: 20, zoomVelocity: 100 });

export interface MotionScene2DSemanticCue {
  id: string;
  /** Scene-local integer frame, not seconds or an inferred equal division. */
  frame: number;
  purpose: string;
  graphicIds: readonly string[];
  evidenceRefs: readonly string[];
}

/** Saved original scene data. Camera targets retain the same oscillator identity. */
export interface MotionScene2D {
  schema: "editkin.motion-scene-2d/v1";
  id: string;
  startFrame: number;
  durationFrames: number;
  fps: number;
  graphicIds: readonly string[];
  camera: { centerX: SpringTargetTrack; centerY: SpringTargetTrack; zoom: SpringTargetTrack };
  semanticCues: readonly MotionScene2DSemanticCue[];
  /** Pixel insets from the project canvas edges. */
  safeArea: { left: number; right: number; top: number; bottom: number };
}

export type MotionScene2DProject = Pick<EditProject, "width" | "height" | "fps" | "motionGraphics">
  & { motionScenes?: readonly MotionScene2D[] };

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Motion scene ${label} must be an object`);
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Motion scene ${label} has unknown fields`);
}

function text(value: unknown, label: string, maximum = 80): asserts value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Motion scene ${label} requires a bounded nonempty identifier/text`);
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Motion scene ${label} exceeds supported bounds`);
}

function ids(value: readonly string[], label: string, maximum = MOTION_SCENE_2D_LIMITS.graphics): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(`Motion scene ${label} requires 1 to ${maximum} entries`);
  const seen = new Set<string>();
  for (const id of value) {
    text(id, label);
    if (seen.has(id)) throw new Error(`Motion scene ${label} contains a duplicate identity`);
    seen.add(id);
  }
}

function assertProjectCanvas(project: MotionScene2DProject): void {
  for (const [name, value] of [["width", project.width], ["height", project.height]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Motion scene project ${name} must be a positive safe integer`);
  }
  finiteRange(project.fps, 1, 240, "project fps");
  if (!Array.isArray(project.motionGraphics)) throw new Error("Motion scene needs the project graphic collection");
}

function alignedGraphicRange(graphic: MotionGraphic, fps: number): { start: number; end: number } {
  const start = graphic.timelineStart * fps, duration = graphic.duration * fps;
  const startFrame = Math.round(start), durationFrames = Math.round(duration);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || !Number.isSafeInteger(startFrame) || startFrame < 0
    || !Number.isSafeInteger(durationFrames) || durationFrames < 2
    || !Number.isSafeInteger(startFrame + durationFrames)
    || Math.abs(start - startFrame) > 1e-6 || Math.abs(duration - durationFrames) > 1e-6) {
    throw new Error(`Motion scene graphic ${graphic.id} must align to integer project frames`);
  }
  return { start: startFrame, end: startFrame + durationFrames };
}

function assertCameraTrack(track: SpringTargetTrack, scene: MotionScene2D, name: "centerX" | "centerY" | "zoom"): void {
  record(track, `camera.${name}`);
  exactKeys(track, ["fps", "initialPosition", "initialVelocity", "initialTarget", "spring", "events"], `camera.${name}`);
  assertSpringTargetTrack(track);
  record(track.spring, `camera.${name}.spring`);
  exactKeys(track.spring, ["stiffness", "damping", "mass"], `camera.${name}.spring`);
  if (track.fps !== scene.fps) throw new Error("Motion scene camera fps must match its scene/project");
  const zoom = name === "zoom", minimum = zoom ? MOTION_SCENE_2D_LIMITS.minZoom : -MOTION_SCENE_2D_LIMITS.coordinate;
  const maximum = zoom ? MOTION_SCENE_2D_LIMITS.maxZoom : MOTION_SCENE_2D_LIMITS.coordinate;
  finiteRange(track.initialPosition, minimum, maximum, `camera.${name}.initialPosition`);
  finiteRange(track.initialTarget, minimum, maximum, `camera.${name}.initialTarget`);
  const velocity = zoom ? MOTION_SCENE_2D_LIMITS.zoomVelocity : MOTION_SCENE_2D_LIMITS.coordinateVelocity;
  finiteRange(track.initialVelocity, -velocity, velocity, `camera.${name}.initialVelocity`);
  for (const event of track.events) {
    exactKeys(event, ["frame", "target"], `camera.${name}.event`);
    if (event.frame >= scene.durationFrames) throw new Error("Motion scene camera event is outside its local half-open range");
    finiteRange(event.target, minimum, maximum, `camera.${name}.event.target`);
  }
}

function assertSceneStructure(scene: MotionScene2D, project: MotionScene2DProject): void {
  assertProjectCanvas(project);
  record(scene, "data");
  exactKeys(scene, ["schema", "id", "startFrame", "durationFrames", "fps", "graphicIds", "camera", "semanticCues", "safeArea"], "data");
  if (scene.schema !== "editkin.motion-scene-2d/v1") throw new Error("Motion scene requires editkin.motion-scene-2d/v1");
  text(scene.id, "id");
  if (!Number.isSafeInteger(scene.startFrame) || scene.startFrame < 0
    || !Number.isSafeInteger(scene.durationFrames) || scene.durationFrames < 2 || scene.durationFrames > MOTION_SCENE_2D_LIMITS.frames
    || !Number.isSafeInteger(scene.startFrame + scene.durationFrames)) throw new Error("Motion scene range must be 2 to 1800 safe integer frames");
  if (scene.fps !== project.fps) throw new Error("Motion scene fps must match the project");
  ids(scene.graphicIds, "graphicIds");
  const end = scene.startFrame + scene.durationFrames;
  const graphicRanges = new Map<string, { start: number; end: number }>();
  for (const id of scene.graphicIds) {
    const matching = project.motionGraphics.filter(graphic => graphic.id === id);
    if (matching.length !== 1) throw new Error(`Motion scene graphic ${id} is missing or duplicated`);
    const graphic = matching[0];
    if (graphic.schema !== "hao.motion-composition/v2" || graphic.compositeLayer === "background"
      || graphic.trackId !== undefined || graphic.trackingMode !== undefined) throw new Error("Motion scene supports only foreground untracked v2 vector/physical glyph graphics");
    if (!graphic.vectorV2 && !graphic.text.trim()) throw new Error("Motion scene physical glyph graphics require text");
    assertMotionGraphicV2Contract(graphic, project.fps);
    const range = alignedGraphicRange(graphic, project.fps);
    if (range.start < scene.startFrame || range.end > end) throw new Error(`Motion scene graphic ${id} is outside its scene range`);
    graphicRanges.set(id, range);
  }
  record(scene.camera, "camera");
  exactKeys(scene.camera, ["centerX", "centerY", "zoom"], "camera");
  for (const name of ["centerX", "centerY", "zoom"] as const) assertCameraTrack(scene.camera[name], scene, name);
  record(scene.safeArea, "safeArea");
  exactKeys(scene.safeArea, ["left", "right", "top", "bottom"], "safeArea");
  for (const name of ["left", "right", "top", "bottom"] as const) finiteRange(scene.safeArea[name], 0, Number.MAX_SAFE_INTEGER, `safeArea.${name}`);
  if (scene.safeArea.left + scene.safeArea.right >= project.width || scene.safeArea.top + scene.safeArea.bottom >= project.height) throw new Error("Motion scene safe-area has no available canvas");
  if (!Array.isArray(scene.semanticCues) || scene.semanticCues.length < 1 || scene.semanticCues.length > MOTION_SCENE_2D_LIMITS.semanticCues) throw new Error("Motion scene requires 1 to 32 semantic cues");
  const cues = new Set<string>(), boundGraphics = new Set<string>();
  let previousCueFrame = -1;
  for (const cue of scene.semanticCues as readonly MotionScene2DSemanticCue[]) {
    record(cue, "semantic cue");
    exactKeys(cue, ["id", "frame", "purpose", "graphicIds", "evidenceRefs"], "semantic cue");
    text(cue.id, "semantic cue id"); text(cue.purpose, "semantic cue purpose", 480);
    if (cues.has(cue.id)) throw new Error("Motion scene semantic cue identity is duplicated");
    cues.add(cue.id);
    if (!Number.isSafeInteger(cue.frame) || cue.frame < 0 || cue.frame >= scene.durationFrames) throw new Error("Motion scene semantic cue is outside its local half-open range");
    if (cue.frame <= previousCueFrame) throw new Error("Motion scene semantic cue frames must ascend strictly");
    previousCueFrame = cue.frame;
    ids(cue.graphicIds, "semantic cue graphicIds");
    if (cue.graphicIds.some(id => !scene.graphicIds.includes(id))) throw new Error("Motion scene semantic cue refers to a graphic outside the scene");
    for (const id of cue.graphicIds) {
      const range = graphicRanges.get(id)!, timelineFrame = scene.startFrame + cue.frame;
      if (timelineFrame < range.start || timelineFrame >= range.end) throw new Error(`Motion scene semantic cue ${cue.id} binds inactive graphic ${id}`);
      boundGraphics.add(id);
    }
    if (!Array.isArray(cue.evidenceRefs) || cue.evidenceRefs.length < 1 || cue.evidenceRefs.length > 32) throw new Error("Motion scene semantic cue requires 1 to 32 evidence references");
    for (const reference of cue.evidenceRefs) text(reference, "semantic evidence reference", 320);
  }
  if (scene.graphicIds.some(id => !boundGraphics.has(id))) throw new Error("Every scoped motion scene graphic requires a semantic cue binding");
}

function assertCollectionBudgetAndOverlap(scenes: readonly MotionScene2D[]): void {
  if (!Array.isArray(scenes) || scenes.length > MOTION_SCENE_2D_LIMITS.scenes) throw new Error("Motion scene project supports at most 16 scenes");
  const seen = new Set<string>();
  let evaluations = 0;
  for (const scene of scenes) {
    if (seen.has(scene.id)) throw new Error("Motion scene project contains a duplicate scene identity");
    seen.add(scene.id);
    const cost = scene.durationFrames * scene.graphicIds.length;
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > MOTION_SCENE_2D_LIMITS.graphicFrameEvaluations - evaluations) throw new Error("Motion scene project exceeds 100000 graphic-frame preflight evaluations");
    evaluations += cost;
  }
  for (let left = 0; left < scenes.length; left++) for (let right = left + 1; right < scenes.length; right++) {
    const a: MotionScene2D = scenes[left], b: MotionScene2D = scenes[right];
    if (a.startFrame < b.startFrame + b.durationFrames && b.startFrame < a.startFrame + a.durationFrames
      && a.graphicIds.some(id => b.graphicIds.includes(id))) throw new Error("Overlapping motion scenes cannot own the same graphic identity");
  }
}

/** Commit/preparation preflight once. Saved validation does not require fonts. */
function assertCameraFrameRange(scene: MotionScene2D): void {
  for (let frame = 0; frame < scene.durationFrames; frame++) {
    for (const name of ["centerX", "centerY", "zoom"] as const) {
      const sample = sampleSpringTargetTrack(scene.camera[name], frame);
      finiteRange(sample.position, name === "zoom" ? MOTION_SCENE_2D_LIMITS.minZoom : -Number.MAX_SAFE_INTEGER,
        name === "zoom" ? MOTION_SCENE_2D_LIMITS.maxZoom : Number.MAX_SAFE_INTEGER, `sample ${name} frame ${frame}`);
      finiteRange(sample.velocity, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, `sample ${name} velocity frame ${frame}`);
    }
  }
}

export function assertMotionScene2D(scene: MotionScene2D, project: MotionScene2DProject): void {
  assertSceneStructure(scene, project);
  const scenes = project.motionScenes ?? [];
  for (const other of scenes) assertSceneStructure(other, project);
  assertCollectionBudgetAndOverlap(scenes.some(other => other.id === scene.id)
    ? scenes.map(other => other.id === scene.id ? scene : other) : [...scenes, scene]);
  assertCameraFrameRange(scene);
}

export function assertMotionScenes2D(project: MotionScene2DProject): void {
  const scenes = project.motionScenes ?? [];
  if (!Array.isArray(scenes) || scenes.length > MOTION_SCENE_2D_LIMITS.scenes) throw new Error("Motion scene project supports at most 16 scenes");
  // All collection costs are admitted before evaluating the first camera frame.
  for (const scene of scenes) assertSceneStructure(scene, project);
  assertCollectionBudgetAndOverlap(scenes);
  for (const scene of scenes) assertCameraFrameRange(scene);
}

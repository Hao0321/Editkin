import { describe, expect, it } from "vitest";
import { createEmptyProject, migrateProject, projectDuration, validateProject } from "./editGraph";
import { applyCommand } from "./commands";
import { projectSchema, editorCommandSchema } from "./schema";
import { projectFromComposition } from "./projectComposition";
import type { EditComposition } from "./types";
import type { MotionScene2D } from "./motionScene2d";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createHistory, dispatchCommand, undo, redo } from "./history";
import { clearTemplateApplicationInPlace, templateApplicationSnapshot } from "./templateApplication";

function fixture() {
  const project = createEmptyProject("Original saved scene", { width: 1080, height: 1920, fps: 30 });
  const graphic = createMotionGraphic("persistent-panel", "card", "", 2, 2, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  graphic.x = .3; graphic.y = .3; graphic.width = .4;
  graphic.motionV2!.sequence.unit = "all";
  graphic.motionV2!.sequence.staggerFrames = 0;
  graphic.vectorV2 = { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 };
  project.motionGraphics = [graphic];
  const track = (value: number) => ({ fps: 30, initialPosition: value, initialVelocity: 0, initialTarget: value, spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] });
  const scene: MotionScene2D = {
    schema: "editkin.motion-scene-2d/v1", id: "saved-focus", startFrame: 60, durationFrames: 60, fps: 30,
    graphicIds: [graphic.id], camera: { centerX: track(540), centerY: track(960), zoom: track(1) },
    safeArea: { left: 20, top: 20, right: 20, bottom: 20 },
    semanticCues: [{ id: "identify", frame: 0, purpose: "Identify our original vector", graphicIds: [graphic.id], evidenceRefs: ["original-scene-brief:identify"] }],
  };
  return { project, scene };
}

describe("versioned Motion scene persistence and atomic editing", () => {
  it("saves schema9 and reopens exact targets, velocities, semantic frame and scope", () => {
    const { project, scene } = fixture(); project.motionScenes = [scene];
    scene.camera.centerX.initialVelocity = 10;
    scene.camera.centerX.events = [{ frame: 19, target: 560 }];
    const saved = JSON.stringify(project), reopened = projectSchema.parse(migrateProject(JSON.parse(saved)));
    expect(reopened.schemaVersion).toBe(9); expect(reopened.motionScenes).toEqual([scene]);
    expect(validateProject(reopened).motionGraphics).toEqual(project.motionGraphics);
  });
  it("upgrades old schema8 without altering its graphic motion or adding a camera", () => {
    const { project } = fixture(); const old = { ...project, schemaVersion: 8 };
    const upgraded = migrateProject(old); expect(upgraded.schemaVersion).toBe(9);
    expect(upgraded.motionGraphics).toEqual(old.motionGraphics); expect(upgraded.motionScenes).toBeUndefined();
  });
  it("rejects scene payload under an old version instead of silently stripping it", () => {
    const { project, scene } = fixture();
    expect(() => migrateProject({ ...project, schemaVersion: 8, motionScenes: [scene] })).toThrow(/schema 9/);
    expect(() => projectSchema.parse({ ...project, schemaVersion: 8, motionScenes: [scene] })).toThrow();
  });
  it("rejects unknown nested camera data on reopen and commands", () => {
    const { project, scene } = fixture(); const bad = { ...scene, camera: { ...scene.camera, cssTransform: "unbound" } };
    expect(() => projectSchema.parse({ ...project, motionScenes: [bad] })).toThrow();
    expect(() => editorCommandSchema.parse({ type: "add_motion_scene", scene: bad })).toThrow();
  });
  it("adds and updates the same editable scene identity while retaining unrelated state", () => {
    const { project, scene } = fixture(); const before = JSON.stringify(project);
    const added = applyCommand(project, { type: "add_motion_scene", scene });
    const revised = structuredClone(scene); revised.camera.centerY.events = [{ frame: 26, target: 970 }];
    const updated = applyCommand(added, { type: "update_motion_scene", sceneId: scene.id, scene: revised });
    expect(updated.motionScenes).toEqual([revised]); expect(updated.motionGraphics).toEqual(project.motionGraphics);
    expect(updated.tracks).toEqual(project.tracks); expect(JSON.stringify(project)).toBe(before);
  });
  it("refuses duplicate and missing scene identities without mutating the input", () => {
    const { project, scene } = fixture(); const added = applyCommand(project, { type: "add_motion_scene", scene });
    const before = JSON.stringify(added);
    expect(() => applyCommand(added, { type: "add_motion_scene", scene })).toThrow();
    expect(() => applyCommand(added, { type: "update_motion_scene", sceneId: scene.id, scene: { ...scene, id: "different" } })).toThrow();
    expect(() => applyCommand(added, { type: "delete_motion_scene", sceneId: "missing" })).toThrow();
    expect(JSON.stringify(added)).toBe(before);
  });
  it("deletes only its scene and keeps graphics editable; scoped graphic deletion requires explicit scene removal", () => {
    const { project, scene } = fixture(); const added = applyCommand(project, { type: "add_motion_scene", scene });
    expect(() => applyCommand(added, { type: "delete_motion_graphic", graphicId: scene.graphicIds[0] })).toThrow(/owning Motion scene/);
    const deleted = applyCommand(added, { type: "delete_motion_scene", sceneId: scene.id });
    expect(deleted.motionScenes).toEqual([]); expect(deleted.motionGraphics).toEqual(project.motionGraphics);
    expect(applyCommand(deleted, { type: "delete_motion_graphic", graphicId: scene.graphicIds[0] }).motionGraphics).toEqual([]);
  });
  it("rolls back an entire invalid batch rather than keeping an admitted first scene", () => {
    const { project, scene } = fixture(); const before = JSON.stringify(project);
    expect(() => applyCommand(project, { type: "batch", commands: [
      { type: "add_motion_scene", scene }, { type: "add_motion_scene", scene },
    ] })).toThrow(); expect(JSON.stringify(project)).toBe(before);
  });
  it("requires explicit recomposition when changing a scene canvas", () => {
    const { project, scene } = fixture(); const added = applyCommand(project, { type: "add_motion_scene", scene });
    expect(() => applyCommand(added, { type: "set_project_resolution", width: 1920, height: 1080 })).toThrow(/Recompose/);
    expect(() => applyCommand(added, { type: "batch", commands: [{ type: "set_project_resolution", width: 1920, height: 1080 }] })).toThrow(/Recompose/);
    expect(applyCommand(added, { type: "set_project_resolution", width: 1080, height: 1920 }).motionScenes).toEqual([scene]);
  });
  it("retains the scene duration and nested composition scope on materialization", () => {
    const { project, scene } = fixture(); project.motionScenes = [scene];
    expect(projectDuration(project)).toBe(4);
    const composition: EditComposition = {
      schema: "editkin.composition/v1", id: "nested", name: "nested", width: project.width, height: project.height, fps: project.fps, duration: 4,
      tracks: project.tracks, captions: [], captionStyle: project.captionStyle, motionTracks: [], motionGraphics: project.motionGraphics,
      motionScenes: [scene], director: project.director, updatedAt: project.updatedAt,
    };
    const nested = projectFromComposition(project, composition);
    expect(nested.schemaVersion).toBe(9); expect(nested.motionScenes).toEqual([scene]);
    expect(nested.motionScenes).not.toBe(composition.motionScenes);
    expect(projectSchema.parse(nested).motionScenes).toEqual([scene]);
  });
  it("undoes and redoes the exact camera/cue edit while preserving the disk revision", () => {
    const { project, scene } = fixture();
    const added = dispatchCommand(createHistory(project), { type: "add_motion_scene", scene });
    const revised = structuredClone(scene); revised.camera.centerX.events = [{ frame: 20, target: 555 }];
    const edited = dispatchCommand(added, { type: "update_motion_scene", sceneId: scene.id, scene: revised });
    edited.present.revision = 7;
    const undone = undo(edited), redone = redo(undone);
    expect(undone.present.motionScenes).toEqual([scene]); expect(redone.present.motionScenes).toEqual([revised]);
    expect(undone.present.revision).toBe(7); expect(redone.present.revision).toBe(7);
    expect(edited.past[0].motionScenes).toBeUndefined();
  });
  it("removes a wholly template-owned scene without removing user-authored graphics", () => {
    const { project, scene } = fixture(); project.motionScenes = [scene];
    project.motionGraphics.push({ ...structuredClone(project.motionGraphics[0]), id: "user-extra" });
    project.motionGraphics[0].templateOwner = { schema: "editkin.template-element-owner/v1", sessionId: "session", templateId: "original-scene-template", format: "short", role: "panel" };
    const snapshot = templateApplicationSnapshot(project, []);
    project.templateApplication = { schema: "editkin.template-application/v1", sessionId: "session", templateId: "original-scene-template", templateName: "Original", format: "short", createdAt: project.updatedAt, before: snapshot, applied: structuredClone(snapshot) };
    validateProject(project);
    clearTemplateApplicationInPlace(project);
    expect(project.motionScenes).toEqual([]); expect(project.motionGraphics.map(g => g.id)).toEqual(["user-extra"]);
    expect(validateProject(project).templateApplication).toBeUndefined();
  });
  it("refuses mixed-ownership scene removal before changing the project", () => {
    const { project, scene } = fixture(); project.motionScenes = [scene];
    project.motionGraphics.push({ ...structuredClone(project.motionGraphics[0]), id: "user-extra" });
    scene.graphicIds = [...scene.graphicIds, "user-extra"];
    scene.semanticCues = [{ ...scene.semanticCues[0], graphicIds: [...scene.graphicIds] }];
    project.motionGraphics[0].templateOwner = { schema: "editkin.template-element-owner/v1", sessionId: "session", templateId: "original-scene-template", format: "short", role: "panel" };
    const before = JSON.stringify(project);
    expect(() => clearTemplateApplicationInPlace(project)).toThrow(/mixed-ownership/);
    expect(JSON.stringify(project)).toBe(before);
  });
});

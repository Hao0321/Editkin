import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./editGraph";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { assertMotionScene2D, assertMotionScenes2D, type MotionScene2D } from "./motionScene2d";
import type { SpringTargetTrack } from "./motionContinuity";

function track(position: number): SpringTargetTrack {
  return { fps: 30, initialPosition: position, initialVelocity: 0, initialTarget: position,
    spring: { stiffness: 100, damping: 20, mass: 1 }, events: [] };
}
function fixture() {
  const project = createEmptyProject("Saved original scene", { width: 320, height: 240, fps: 30 });
  const graphic = createMotionGraphic("stable-vector", "card", "", 0, 2, undefined, findMotionGraphicPreset("reel_rule_reveal").seed);
  project.motionGraphics = [graphic];
  const scene: MotionScene2D = { schema: "editkin.motion-scene-2d/v1", id: "original-scene", startFrame: 0,
    durationFrames: 60, fps: 30, graphicIds: [graphic.id], camera: { centerX: track(160), centerY: track(120), zoom: track(1) },
    safeArea: { left: 8, right: 8, top: 8, bottom: 8 },
    semanticCues: [{ id: "meaning", frame: 0, purpose: "Introduce the original stable object", graphicIds: [graphic.id], evidenceRefs: ["original-brief:meaning"] }] };
  return { project: { ...project, motionScenes: [scene] }, graphic, scene };
}

describe("saved original 2D scene contract", () => {
  it("admits a complete bounded scene independently of prepared font/runtime data", () => {
    const { project, scene } = fixture();
    expect(() => assertMotionScene2D(scene, project)).not.toThrow();
    expect(() => assertMotionScenes2D(JSON.parse(JSON.stringify(project)))).not.toThrow();
    expect(() => assertMotionScenes2D({ ...project, motionScenes: undefined })).not.toThrow();
  });

  it("rejects unsafe ranges, fractional graphic frames and scene/project/track clock drift", () => {
    for (const change of [ { startFrame: Number.MAX_SAFE_INTEGER }, { durationFrames: 1801 }, { durationFrames: 2.5 }, { fps: 24 } ]) {
      const { project, scene } = fixture(); Object.assign(scene, change);
      expect(() => assertMotionScene2D(scene, project)).toThrow();
    }
    for (const property of ["timelineStart", "duration"] as const) {
      const { project, scene, graphic } = fixture(); graphic[property] += .5 / project.fps;
      expect(() => assertMotionScene2D(scene, project)).toThrow(/integer project frames/);
    }
    const { project, scene } = fixture(); scene.camera.centerX.fps = 24;
    expect(() => assertMotionScene2D(scene, project)).toThrow(/camera fps/);
  });

  it("refuses missing/duplicate, v1, tracked and background scope rather than downgrading", () => {
    for (const invalid of ["missing", "duplicate", "v1", "tracked", "background"] as const) {
      const { project, scene, graphic } = fixture();
      if (invalid === "missing") scene.graphicIds = ["not-present"];
      if (invalid === "duplicate") scene.graphicIds = [graphic.id, graphic.id];
      if (invalid === "v1") graphic.schema = "hao.motion-composition/v1";
      if (invalid === "tracked") graphic.trackId = "source-track";
      if (invalid === "background") graphic.compositeLayer = "background";
      expect(() => assertMotionScene2D(scene, project)).toThrow();
    }
  });

  it("keeps semantic evidence, object identities and camera events inside the half-open local range", () => {
    for (const invalid of ["cue-end", "cue-scope", "cue-evidence", "cue-id", "event-end", "event-order", "id-length"] as const) {
      const { project, scene } = fixture();
      if (invalid === "cue-end") scene.semanticCues[0].frame = 60;
      if (invalid === "cue-scope") scene.semanticCues[0].graphicIds = ["other"];
      if (invalid === "cue-evidence") scene.semanticCues[0].evidenceRefs = [];
      if (invalid === "cue-id") scene.semanticCues = [scene.semanticCues[0], { ...scene.semanticCues[0] }];
      if (invalid === "event-end") scene.camera.centerX.events = [{ frame: 60, target: 140 }];
      if (invalid === "event-order") scene.camera.centerX.events = [{ frame: 20, target: 150 }, { frame: 10, target: 140 }];
      if (invalid === "id-length") scene.id = "x".repeat(81);
      expect(() => assertMotionScene2D(scene, project)).toThrow();
    }
  });

  it("rejects shared ownership during overlap and admits disjoint graphic scenes", () => {
    const { project, scene, graphic } = fixture();
    const other = structuredClone(scene); other.id = "second-scene";
    project.motionScenes.push(other);
    expect(() => assertMotionScenes2D(project)).toThrow(/Overlapping/);
    const second = structuredClone(graphic); second.id = "second-vector";
    project.motionGraphics.push(second); other.graphicIds = [second.id]; other.semanticCues[0].graphicIds = [second.id];
    expect(() => assertMotionScenes2D(project)).not.toThrow();
  });

  it("binds every object to a strictly ascending semantic cue at its actual active frame", () => {
    const { project, scene, graphic } = fixture();
    graphic.timelineStart = 1; graphic.duration = 1;
    expect(() => assertMotionScene2D(scene, project)).toThrow(/inactive graphic/);
    scene.semanticCues[0].frame = 30;
    expect(() => assertMotionScene2D(scene, project)).not.toThrow();
    scene.semanticCues[0].frame = 59;
    expect(() => assertMotionScene2D(scene, project)).not.toThrow();
    const duplicate = { ...scene.semanticCues[0], id: "second-meaning" };
    scene.semanticCues = [scene.semanticCues[0], duplicate];
    expect(() => assertMotionScene2D(scene, project)).toThrow(/ascend strictly/);
    duplicate.frame = 58;
    expect(() => assertMotionScene2D(scene, project)).toThrow(/ascend strictly/);
    scene.semanticCues = [scene.semanticCues[0]];
    const second = { ...structuredClone(graphic), id: "unbound-vector" };
    project.motionGraphics.push(second); scene.graphicIds = [graphic.id, second.id];
    expect(() => assertMotionScene2D(scene, project)).toThrow(/requires a semantic cue binding/);
  });

  it("admits total preflight work before loops, including otherwise legal long vector scenes", () => {
    const { project, scene, graphic } = fixture();
    scene.durationFrames = 1800; graphic.duration = 60;
    const graphics = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(graphic), id: `vector-${index}` }));
    const secondGraphics = graphics.map((item, index) => ({ ...structuredClone(item), id: `second-${index}` }));
    project.motionGraphics = [...graphics, ...secondGraphics];
    scene.graphicIds = graphics.map(item => item.id); scene.semanticCues[0].graphicIds = scene.graphicIds;
    const other = structuredClone(scene); other.id = "large-second";
    other.graphicIds = secondGraphics.map(item => item.id); other.semanticCues[0].graphicIds = other.graphicIds;
    project.motionScenes.push(other);
    expect(() => assertMotionScenes2D(project)).toThrow(/100000/);
  });

  it("blocks intermediate zoom overshoot despite positive valid authored targets", () => {
    const { project, scene } = fixture();
    scene.camera.zoom = { ...track(1), initialTarget: .1, spring: { stiffness: 100, damping: 0, mass: 1 } };
    expect(() => assertMotionScene2D(scene, project)).toThrow(/sample zoom/);
    scene.camera.zoom = { ...track(1), initialTarget: 11, spring: { stiffness: 100, damping: 0, mass: 1 } };
    expect(() => assertMotionScene2D(scene, project)).toThrow(/sample zoom/);
  });
});

import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createDemoProject } from "../domain/demo";
import { createMotionGraphic, motionGraphicFrame, trackRectAt } from "./composition";
import type { MotionTrack } from "../domain/types";

const track: MotionTrack = {
  id: "track", clipId: "clip", name: "Subject", engine: "hao-core-rust-motion-track-0.2", analysisFps: 10,
  initialRect: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }, lostRatio: 0, createdAt: "2026-08-22T00:00:00Z",
  points: [
    { frame: 0, time: 0, rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }, confidence: 1, status: "manual" },
    { frame: 10, time: 1, rect: { x: 0.3, y: 0.4, width: 0.2, height: 0.3 }, confidence: 0.9, status: "tracked" },
  ],
};

describe("hao.motion-composition/v1", () => {
  it("interpolates a tracked rectangle deterministically", () => {
    const rect = trackRectAt(track, 0.5)!;
    expect(rect.x).toBeCloseTo(0.2);
    expect(rect.y).toBeCloseTo(0.3);
    expect(rect.width).toBeCloseTo(0.2);
    expect(rect.height).toBeCloseTo(0.3);
  });

  it("creates a frame-quantized graphic preset", () => {
    const project = createEmptyProject();
    const graphic = createMotionGraphic("graphic", "title", "重點", 1, 3);
    project.motionGraphics.push(graphic);
    const frame = motionGraphicFrame(project, graphic, 1.5);
    expect(frame.visible).toBe(true);
    expect(frame.x).toBe(graphic.x);
    expect(frame.opacity).toBeGreaterThan(0.9);
    expect(graphic.offsetX).toBe(0);
    expect(graphic.offsetY).toBe(0);
  });

  it("matches native entry and exit timing instead of disappearing abruptly", () => {
    const project = createEmptyProject();
    const graphic = createMotionGraphic("graphic", "title", "重點", 1, 3);
    const entering = motionGraphicFrame(project, graphic, 1.09);
    const sameFrame = motionGraphicFrame(project, graphic, 1.11);
    const holding = motionGraphicFrame(project, graphic, 2);
    const exiting = motionGraphicFrame(project, graphic, 3.93);
    expect(entering.opacity).toBeCloseTo(0.6);
    expect(sameFrame).toEqual(entering);
    expect(holding.opacity).toBe(1);
    expect(exiting.opacity).toBeCloseTo(0.5);
    expect(exiting.y).toBeLessThan(graphic.y);
  });

  it("hides an attachment throughout an explicit lost span and resumes on reacquisition", () => {
    const lost: MotionTrack = { ...track, points: [
      track.points[0],
      { ...track.points[1], frame: 5, time: .5, status: "lost", confidence: 0 },
      { ...track.points[1], frame: 10, time: 1, status: "tracked" },
    ] };
    expect(trackRectAt(lost, .25)).toEqual(track.points[0].rect);
    expect(trackRectAt(lost, .5)).toBeUndefined();
    expect(trackRectAt(lost, .75)).toBeUndefined();
    expect(trackRectAt(lost, 1)).toEqual(track.points[1].rect);
  });

  it("keeps DOM fallback rotation and scale on the same sampled tracking frame", () => {
    const project = createDemoProject();
    const rotating: MotionTrack = { ...track, clipId: "clip-demo", points: [
      { ...track.points[0], rotationDegrees: 0, scale: 1 },
      { ...track.points[1], rotationDegrees: 30, scale: 1.4 },
    ] };
    project.motionTracks = [rotating];
    const graphic = createMotionGraphic("tracked", "tag", "追蹤", 0, 2, rotating.id);
    const frame = motionGraphicFrame(project, graphic, .5);
    expect(frame.rotationDegrees).toBeCloseTo(15);
    expect(frame.scale).toBeCloseTo(1.2);
  });
});

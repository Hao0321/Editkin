import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "./composition";
import { nativeMotionPaintFrame, nativeMotionPaintTrack, prepareNativeMotionPaint } from "./nativeMotionPaint";

function panel(id: string, start: number, exitScale: number) {
  const graphic = createMotionGraphic(id, "title", "", start, .6, undefined, findMotionGraphicPreset("reel_native_panel").seed);
  Object.assign(graphic, { x: .3, y: .35, width: .3, cornerRadius: 8, visualStyle: "native_paint",
    backgroundColor: "#00000000", shadowDepth: 0, outlineWidth: 0,
    vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 40, revealFrames: 1 },
    paintV1: { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#DAE9FF" }, clips: [],
      stroke: { color: "#FFFFFF80", widthPixels: 1 } } });
  graphic.motionV2!.sequence = { unit: "all", order: "forward", exitOrder: "forward", staggerFrames: 0 };
  graphic.motionV2!.entrance = { ...graphic.motionV2!.entrance, durationFrames: 3, offsetXPixels: 0, offsetYPixels: 0,
    scale: .98, opacity: 0, easing: { type: "ease_out" } };
  graphic.motionV2!.exit = { ...graphic.motionV2!.exit, durationFrames: 3, offsetXPixels: 0, offsetYPixels: 0,
    scale: exitScale, opacity: 0, easing: { type: "ease_in" } };
  return graphic;
}

describe("native paint curve preparation uses admitted whole-animation scale", () => {
  it("includes later graphics and exit peaks, with identical bounds for frame, track, seek and reopen", () => {
    const project = createEmptyProject("Actual scale", { width: 640, height: 360, fps: 30 });
    project.motionGraphics = [panel("near", .5, 1.06), panel("later", 1.2, 1.25)];
    const handle = prepareNativeMotionPaint(project, new Map());
    // Asking for an early frame must not prepare a smaller tolerance than export.
    const early = nativeMotionPaintFrame(project, handle, 17);
    const tracks = project.motionGraphics.map(g => nativeMotionPaintTrack(project, handle, g.id));
    const actualMaximum = Math.max(1, ...tracks.flatMap(t => t.frames.flatMap(row => row.map(p => p.scale))));
    expect(actualMaximum).toBeGreaterThan(1.06);
    expect(actualMaximum).toBeLessThanOrEqual(1.25);
    expect(early.scene.max_scale).toBe(actualMaximum);
    for (const track of tracks) expect(track.scene.max_scale).toBe(actualMaximum);
    expect(nativeMotionPaintTrack(project, handle, "near")).toBe(tracks[0]);
    const reopened = structuredClone(project), reopenedHandle = prepareNativeMotionPaint(reopened, new Map());
    for (const frame of [17, 51, 36, 17]) {
      expect(nativeMotionPaintFrame(project, handle, frame)).toEqual(nativeMotionPaintFrame(reopened, reopenedHandle, frame));
    }
    reopened.motionGraphics[1].motionV2!.exit.scale = 1.1;
    expect(() => nativeMotionPaintTrack(reopened, reopenedHandle, "later")).toThrow(/stale/);
  });

  it("keeps the native 1x preparation floor and rejects an actual pose beyond the existing ceiling", () => {
    const project = createEmptyProject("Scale floor", { width: 640, height: 360, fps: 30 });
    project.motionGraphics = [panel("small", 0, .96)];
    const handle = prepareNativeMotionPaint(project, new Map());
    expect(nativeMotionPaintTrack(project, handle, "small").scene.max_scale).toBe(1);
    expect(nativeMotionPaintFrame(project, handle, 0).scene.max_scale).toBe(1);
    const invalid = structuredClone(project);
    invalid.motionGraphics[0].motionV2!.exit.scale = 33;
    expect(() => nativeMotionPaintTrack(invalid, prepareNativeMotionPaint(invalid, new Map()), "small")).toThrow();
  });
});

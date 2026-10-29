import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { editorCommandSchema } from "./schema";
import type { FloatingVideoFrameV2, TimelineClip } from "./types";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "./types";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";

const frame: FloatingVideoFrameV2 = { schema: "editkin.floating-video-frame/v2", style: "matte", size: .58,
  yawDegrees: -12, pitchDegrees: 3, aspect: "source", mediaFit: "contain",
  motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } };
function fixture(fps = 30) {
  const project = createEmptyProject("Original source geometry control", { id: "source-geometry", width: 360, height: 640, fps });
  project.assets.push({ id: "original", name: "Original marked source", kind: "video", uri: "owned-source.mkv", duration: 6,
    width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } });
  const clip: TimelineClip = { id: "keep-id", assetId: "original", trackId: "video-main", timelineStart: 15 / fps, sourceStart: 1,
    duration: 60 / fps, volume: .4, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} };
  project.tracks[0]!.clips.push(clip);
  return project;
}
const upgrade = (project: ReturnType<typeof fixture>) => applyCommand(project, { type: "set_clip_floating_frame", clipId: "keep-id", frame });

describe("persisted floating frame v2 source geometry and clip clock", () => {
  it("reopens v1 with its old plane and no automatic fit or motion upgrade", () => {
    const project = fixture(), legacy = { schema: "editkin.floating-video-frame/v1" as const, style: "matte" as const,
      size: .58, yawDegrees: -12, pitchDegrees: 3, aspect: "portrait" as const };
    project.tracks[0]!.clips[0]!.floatingFrame = legacy;
    const reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(reopened.tracks[0]!.clips[0]!.floatingFrame).toEqual(legacy);
    expect(reopened.tracks[0]!.clips[0]!).toEqual(project.tracks[0]!.clips[0]!);
  });
  it("explicitly upgrades, undoes and reopens while preserving IDs, source time and audio", () => {
    const project = fixture(), original = structuredClone(project.tracks[0]!.clips[0]!);
    const history = dispatchCommand(createHistory(project), { type: "set_clip_floating_frame", clipId: original.id, frame }, "explicit-upgrade");
    const reopened = decodeProjectBytes(encodeProjectBytes(history.present)), updated = reopened.tracks[0]!.clips[0]!;
    expect(updated.floatingFrame).toEqual(frame);
    const { floatingFrame: _frame, ...unchanged } = updated;
    expect(unchanged).toEqual(original);
    expect(undo(history).present.tracks[0]!.clips[0]!).toEqual(original);
    expect(redo(undo(history)).present.tracks[0]!.clips[0]!.floatingFrame).toEqual(frame);
    expect(reopened.assets[0]!.uri).toBe(project.assets[0]!.uri);
  });
  it("saves non-square-pixel physical display ratio separately from upright raster dimensions", () => {
    const project = fixture(); project.assets[0]!.displayAspectRatio = 64 / 27;
    const reopened = decodeProjectBytes(encodeProjectBytes(upgrade(project)));
    expect([reopened.assets[0]!.width, reopened.assets[0]!.height, reopened.assets[0]!.displayAspectRatio]).toEqual([640, 360, 64 / 27]);
  });
  it("strictly rejects marker/policy smuggling, cover and unknown nested fields", () => {
    for (const invalid of [
      { ...frame, schema: "editkin.floating-video-frame/v1" }, { ...frame, mediaFit: "cover" },
      { ...frame, aspect: "unknown" }, { ...frame, extra: true }, { ...frame, motion: { ...frame.motion!, wallClock: true } },
    ]) expect(() => editorCommandSchema.parse({ type: "set_clip_floating_frame", clipId: "keep-id", frame: invalid })).toThrow();
    expect(() => editorCommandSchema.parse({ type: "set_clip_floating_frame", clipId: "keep-id", frame })).not.toThrow();
  });
  it("rejects overlapping phases including absent-motion defaults on short clips", () => {
    for (const motion of [{ entranceFrames: 6, exitFrames: 6, travelY: .012 }, undefined]) {
      const project = fixture(); project.tracks[0]!.clips[0]!.duration = 12 / 30;
      expect(() => applyCommand(project, { type: "set_clip_floating_frame", clipId: "keep-id", frame: { ...frame, motion } })).toThrow();
    }
    const short = fixture(); short.tracks[0]!.clips[0]!.duration = 1 / 30;
    expect(() => applyCommand(short, { type: "set_clip_floating_frame", clipId: "keep-id",
      frame: { ...frame, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 } } })).not.toThrow();
  });
  it("rejects missing or invalid real dimensions and display ratios rather than using the canvas", () => {
    for (const patch of [{ width: undefined }, { height: 0 }, { width: 1.5 }, { width: NaN },
      { displayAspectRatio: 0 }, { displayAspectRatio: -1 }, { displayAspectRatio: Infinity }, { displayAspectRatio: NaN }]) {
      const project = fixture(); Object.assign(project.assets[0]!, patch);
      expect(() => upgrade(project)).toThrow();
    }
    const legacyGeometry = fixture(); delete legacyGeometry.assets[0]!.displayAspectRatio;
    expect(() => validateProject(upgrade(legacyGeometry))).not.toThrow();
  });
  it("retains fractional project fps on its frame grid and rejects fractional start or duration frames", () => {
    const project = fixture(30_000 / 1001), reopened = decodeProjectBytes(encodeProjectBytes(upgrade(project)));
    expect(reopened.fps).toBe(project.fps);
    expect(reopened.tracks[0]!.clips[0]!.timelineStart).toBe(15 / project.fps);
    expect(reopened.tracks[0]!.clips[0]!.duration).toBe(60 / project.fps);
    const invalid = fixture(); invalid.tracks[0]!.clips[0]!.duration = 60.5 / 30;
    expect(() => upgrade(invalid)).toThrow(/整數專案影格/);
    const fractionalStart = fixture(); fractionalStart.tracks[0]!.clips[0]!.timelineStart = .51;
    expect(() => upgrade(fractionalStart)).toThrow(/起點.*整數專案影格/);
  });
  it("rejects invalid phase numbers and travel while permitting an explicit zero-motion hold", () => {
    for (const motion of [{ entranceFrames: .5, exitFrames: 6, travelY: .012 }, { entranceFrames: 25, exitFrames: 0, travelY: 0 },
      { entranceFrames: 0, exitFrames: -1, travelY: 0 }, { entranceFrames: 6, exitFrames: 6, travelY: .031 },
      { entranceFrames: 6, exitFrames: 6, travelY: NaN }]) {
      expect(() => editorCommandSchema.parse({ type: "set_clip_floating_frame", clipId: "keep-id", frame: { ...frame, motion } })).toThrow();
    }
    expect(() => applyCommand(fixture(), { type: "set_clip_floating_frame", clipId: "keep-id",
      frame: { ...frame, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 } } })).not.toThrow();
  });
});

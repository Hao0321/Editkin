import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject } from "./editGraph";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { editorCommandSchema, projectSchema } from "../mcp/schemas";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorGradeV2, type EditProject } from "./types";
import { colorGradeV2Schema } from "./colorGradeV2Schema";

function project(): EditProject {
  const value = createEmptyProject("Grade v2 command", { width: 360, height: 640, fps: 30 });
  value.assets.push({ id: "a", name: "a", uri: "a.mp4", kind: "video", duration: 6, width: 360, height: 640 },
    { id: "s", name: "s", uri: "s.wav", kind: "audio", duration: 6 });
  value.tracks[0].clips.push({ id: "c", trackId: "video-main", assetId: "a", timelineStart: 0, sourceStart: 0, duration: 3, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  value.tracks[1].clips.push({ id: "sound", trackId: "audio-main", assetId: "s", timelineStart: 0, sourceStart: 0, duration: 3, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return value;
}

const GRADE: ColorGradeV2 = {
  schema: "editkin.color-grade/v2",
  nodes: [
    { id: "balance", lift: { master: 0.01 }, gain: { r: 0.02 }, contrast: 1.05, curves: { y: [{ x: 0, y: 0 }, { x: 0.5, y: 0.52 }, { x: 1, y: 1 }] } },
    { id: "creative", log: { shadow: { b: 0.01 } }, hueVsSat: [{ hue: 200, value: 1 }, { hue: 240, value: 1.1 }, { hue: 280, value: 1 }], skinProtection: 0.8 },
  ],
  look: { id: "hfl2_food_warm_appetite", strength: 0.8 },
  finishing: { grain: { amount: 0.2 }, vignette: { amount: 0.1 } },
};

describe("set_clip_grade_v2", () => {
  it("sets, replaces and removes the grade through the normal command path", () => {
    const graded = applyCommand(project(), { type: "set_clip_grade_v2", clipId: "c", grade: GRADE });
    expect(graded.tracks[0].clips[0].gradeV2).toEqual(GRADE);
    expect(graded.schemaVersion).toBe(9);
    const replaced = applyCommand(graded, { type: "set_clip_grade_v2", clipId: "c", grade: { schema: "editkin.color-grade/v2", look: { id: "hfl2_hype_vivid" } } });
    expect(replaced.tracks[0].clips[0].gradeV2).toEqual({ schema: "editkin.color-grade/v2", look: { id: "hfl2_hype_vivid" } });
    const removed = applyCommand(replaced, { type: "set_clip_grade_v2", clipId: "c", grade: null });
    expect("gradeV2" in removed.tracks[0].clips[0]).toBe(false);
    expect(graded.tracks[0].clips[0].gradeV2).toEqual(GRADE);
  });

  it("is undoable and redoable", () => {
    const start = createHistory(project());
    const graded = dispatchCommand(start, { type: "set_clip_grade_v2", clipId: "c", grade: GRADE }, "grade");
    const changed = dispatchCommand(graded, { type: "set_clip_grade_v2", clipId: "c", grade: { schema: "editkin.color-grade/v2", nodes: [{ id: "x", saturation: 0.5 }] } }, "grade-2");
    const undone = undo(changed);
    expect(undone.present.tracks[0].clips[0].gradeV2).toEqual(GRADE);
    expect(undo(undone).present.tracks[0].clips[0].gradeV2).toBeUndefined();
    expect(redo(undone).present.tracks[0].clips[0].gradeV2).toEqual({ schema: "editkin.color-grade/v2", nodes: [{ id: "x", saturation: 0.5 }] });
  });

  it.each([
    ["five nodes", { schema: "editkin.color-grade/v2", nodes: ["a", "b", "c", "d", "e"].map(id => ({ id, contrast: 1.1 })) }],
    ["duplicate node ids", { schema: "editkin.color-grade/v2", nodes: [{ id: "a" }, { id: "a" }] }],
    ["unordered curve", { schema: "editkin.color-grade/v2", nodes: [{ id: "a", curves: { y: [{ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.3 }] } }] }],
    ["seventeen curve points", { schema: "editkin.color-grade/v2", nodes: [{ id: "a", curves: { r: Array.from({ length: 17 }, (_, index) => ({ x: index / 16, y: index / 16 })) } }] }],
    ["misspelled control", { schema: "editkin.color-grade/v2", nodes: [{ id: "a", contrastt: 1.2 }] }],
    ["out of range", { schema: "editkin.color-grade/v2", nodes: [{ id: "a", saturation: 9 }] }],
    ["bad lut id", { schema: "editkin.color-grade/v2", nodes: [{ id: "a", lut: { id: "lut:ffffffffffffffff", sha256: "0".repeat(64), strength: 1 } }] }],
    ["unknown look", { schema: "editkin.color-grade/v2", look: { id: "hfl2_not_a_look" } }],
    ["wrong schema", { schema: "editkin.color-grade/v1" }],
  ])("rejects %s", (_label, grade) => {
    expect(() => applyCommand(project(), { type: "set_clip_grade_v2", clipId: "c", grade: grade as ColorGradeV2 })).toThrow();
  });

  it("refuses audio clips and non-content layers", () => {
    expect(() => applyCommand(project(), { type: "set_clip_grade_v2", clipId: "sound", grade: GRADE })).toThrow(/影像片段/);
    const adjustment = project();
    adjustment.tracks[0].clips[0].layer = { enabled: true, blendMode: "normal", role: "adjustment" };
    expect(() => applyCommand(adjustment, { type: "set_clip_grade_v2", clipId: "c", grade: GRADE })).toThrow(/內容圖層/);
  });

  it("parses through the MCP command schema and rejects extra keys", () => {
    expect(editorCommandSchema.parse({ type: "set_clip_grade_v2", clipId: "c", grade: GRADE })).toEqual({ type: "set_clip_grade_v2", clipId: "c", grade: GRADE });
    expect(editorCommandSchema.parse({ type: "set_clip_grade_v2", clipId: "c", grade: null })).toEqual({ type: "set_clip_grade_v2", clipId: "c", grade: null });
    expect(() => editorCommandSchema.parse({ type: "set_clip_grade_v2", clipId: "c", grade: GRADE, extra: true })).toThrow();
    expect(colorGradeV2Schema.safeParse({ schema: "editkin.color-grade/v2", nodes: [{ id: "n", log: { lowRange: 0.5, highRange: 0.5 } }] }).success).toBe(false);
  });
});

describe("persisted schema", () => {
  it("keeps schema 9/10 and survives save/reopen byte-for-byte with a grade", () => {
    const graded = applyCommand(project(), { type: "set_clip_grade_v2", clipId: "c", grade: GRADE });
    const bytes = encodeProjectBytes(graded);
    const reopened = decodeProjectBytes(bytes);
    expect(reopened.schemaVersion).toBe(9);
    expect(reopened.tracks[0].clips[0].gradeV2).toEqual(GRADE);
    expect(Buffer.from(encodeProjectBytes(reopened)).equals(Buffer.from(bytes))).toBe(true);
    const ten = { ...structuredClone(graded), schemaVersion: 10 as const };
    expect(projectSchema.parse(ten).tracks[0].clips[0].gradeV2).toEqual(GRADE);
  });

  it("never adds a gradeV2 key to projects that omit it", () => {
    const plain = project();
    const bytes = encodeProjectBytes(plain);
    expect(new TextDecoder().decode(bytes)).not.toContain("gradeV2");
    expect(Buffer.from(encodeProjectBytes(decodeProjectBytes(bytes))).equals(Buffer.from(bytes))).toBe(true);
  });

  it("refuses a malformed persisted grade instead of dropping it silently", () => {
    const broken = structuredClone(project()) as unknown as { tracks: Array<{ clips: Array<Record<string, unknown>> }> };
    broken.tracks[0].clips[0].gradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "n", gain: { master: 7 } }] };
    expect(() => decodeProjectBytes(new TextEncoder().encode(JSON.stringify(broken)))).toThrow();
  });
});

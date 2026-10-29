import { describe, expect, it } from "vitest";
import { colorGradeV2Schema } from "./colorGradeV2Schema";
import { createEmptyProject } from "./editGraph";
import { applyCommand } from "./commands";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type ColorGradeV2, type EditProject } from "./types";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { editorCommandSchema, projectSchema } from "../mcp/schemas";
import { secondaryHslSourceNodesV1 } from "./secondaryHslV1Nodes";
import type { SecondaryHslV1 } from "./secondaryHslV1Types";

const selection: SecondaryHslV1 = { schema: "editkin.secondary-hsl/v1", selectorSpace: "working_rgb_code",
  qualifier: { hue: { centerDegrees: 0, halfWidthDegrees: 20, softnessDegrees: 10 }, saturation: { minimum: .2, maximum: 1 } },
  cleanup: { blackPoint: .1, whitePoint: .9 }, outside: { offset: { g: .05 }, skinProtection: .8 } };
const grade: ColorGradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "select", offset: { r: .05 }, mix: .8, secondaryHslV1: selection }] };
function project(): EditProject {
  const value = createEmptyProject("Secondary HSL contract", { width: 320, height: 180, fps: 30 });
  value.assets.push({ id: "a", name: "engineering-fixture", uri: "engineering-fixture.mp4", kind: "video", duration: 3, width: 320, height: 180 });
  value.tracks[0].clips.push({ id: "c", trackId: value.tracks[0].id, assetId: "a", timelineStart: 0, sourceStart: 0, duration: 3, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  return value;
}
describe("secondary HSL v1 persisted admission", () => {
  it("uses the existing command, MCP contract, codec and schema version", () => {
    const command = { type: "set_clip_grade_v2" as const, clipId: "c", grade };
    expect(editorCommandSchema.parse(command)).toEqual(command);
    const original = project(), before = structuredClone(original), updated = applyCommand(original, command);
    expect(original).toEqual(before);
    expect(updated.schemaVersion).toBe(original.schemaVersion);
    expect(updated.tracks[0].clips[0].gradeV2).toEqual(grade);
    expect(projectSchema.parse(updated).tracks[0].clips[0].gradeV2).toEqual(grade);
    expect(decodeProjectBytes(encodeProjectBytes(updated)).tracks[0].clips[0].gradeV2).toEqual(grade);
  });
  it("undoes and redoes inside/outside parameters as one existing command", () => {
    const state = createHistory(project());
    const next = dispatchCommand(state, { type: "set_clip_grade_v2", clipId: "c", grade }, "secondary-hsl");
    const previous = undo(next);
    expect(previous.present.tracks[0].clips[0].gradeV2).toBeUndefined();
    expect(redo(previous).present.tracks[0].clips[0].gradeV2).toEqual(grade);
  });
  it.each([
    ["wrong version", { ...selection, schema: "editkin.secondary-hsl/v2" }],
    ["undeclared selector space", { ...selection, selectorSpace: "sRGB" }],
    ["missing explicit space", { ...selection, selectorSpace: undefined }],
    ["empty selection", { ...selection, qualifier: {} }],
    ["unordered band", { ...selection, qualifier: { lightness: { minimum: .8, maximum: .2 } } }],
    ["negative hue", { ...selection, qualifier: { hue: { centerDegrees: -1, halfWidthDegrees: 10 } } }],
    ["unwrapped hue", { ...selection, qualifier: { hue: { centerDegrees: 360, halfWidthDegrees: 10 } } }],
    ["oversized hue width", { ...selection, qualifier: { hue: { centerDegrees: 0, halfWidthDegrees: 181 } } }],
    ["negative softness", { ...selection, qualifier: { saturation: { minimum: 0, maximum: 1, softness: -.01 } } }],
    ["nonfinite band", { ...selection, qualifier: { lightness: { minimum: NaN, maximum: 1 } } }],
    ["infinite hue", { ...selection, qualifier: { hue: { centerDegrees: Infinity, halfWidthDegrees: 10 } } }],
    ["collapsed cleanup", { ...selection, cleanup: { blackPoint: .5, whitePoint: .5 } }],
    ["spatial blur in RGB LUT", { ...selection, cleanup: { blurRadius: 2 } }],
    ["mask track in RGB LUT", { ...selection, maskId: "window" }],
    ["recursive outside selection", { ...selection, outside: { secondaryHslV1: selection } }],
    ["outside enable", { ...selection, outside: { enabled: false } }],
    ["outside mix", { ...selection, outside: { mix: .5 } }],
    ["outside oversized offset", { ...selection, outside: { offset: { r: .51 } } }],
    ["outside typo", { ...selection, outside: { contrasst: 1.2 } }],
  ])("refuses %s before applying", (_name, value) => {
    const rejected = { schema: "editkin.color-grade/v2", nodes: [{ id: "select", secondaryHslV1: value }] };
    expect(colorGradeV2Schema.safeParse(rejected).success).toBe(false);
    expect(editorCommandSchema.safeParse({ type: "set_clip_grade_v2", clipId: "c", grade: rejected }).success).toBe(false);
    expect(() => applyCommand(project(), { type: "set_clip_grade_v2", clipId: "c", grade: rejected as ColorGradeV2 })).toThrow();
  });
  it("keeps original loader entries and adds only explicit active outside nodes", () => {
    const original = grade.nodes![0], disabled = { ...original, enabled: false }, zero = { ...original, mix: 0 };
    const off = { ...original, secondaryHslV1: { ...selection, enabled: false } };
    const before = structuredClone([original, disabled, zero, off]);
    const expanded = secondaryHslSourceNodesV1([original, disabled, zero, off]);
    expect(expanded).toHaveLength(5);
    expect(expanded[0]).toBe(original);
    expect(expanded[1]).toEqual({ id: "select", ...selection.outside, enabled: undefined, mix: .8 });
    expect([original, disabled, zero, off]).toEqual(before);
  });
});

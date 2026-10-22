import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { animatedClipState, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, dispatchCommandSafely, undo, redo } from "./history";
import { editorCommandSchema } from "./schema";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "./types";
import { captureClipGradeSnapshotV1, pasteClipGradeSnapshotV1 } from "./clipGradeSnapshotV1";
import { combineLookColor, LOOK_PRESETS, EFFECT_PRESETS } from "../creative/corePack";
function fixture() {
  const p = createDemoProject(), source = p.tracks[0].clips[0]; source.id = "source"; source.duration = 4;
  source.color = { ...DEFAULT_COLOR, temperature: .1 }; source.creative = { lookPresetId: LOOK_PRESETS[0].id, effectPresetIds: [] };
  source.keyframes = [{ id: "s0", time: 0, easing: "linear", transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: 0 } }, { id: "s2", time: 2, easing: "hold", transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR, exposure: 2 } }];
  source.gradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "n", gain: { r: .1 } }], look: { id: "hfl2_food_warm_appetite", strength: .4 }, finishing: { vignette: { amount: .2 } } };
  const target = { ...structuredClone(source), id: "target", timelineStart: 4, sourceStart: 4, volume: .35, speed: 2, color: { ...DEFAULT_COLOR, saturation: .4 }, creative: { lookPresetId: LOOK_PRESETS[1].id, effectPresetIds: [EFFECT_PRESETS[0].id] },
    keyframes: [{ id: "t0", time: 0, easing: "ease_in" as const, transform: { ...DEFAULT_TRANSFORM, x: .1 }, color: { ...DEFAULT_COLOR, exposure: -1 } }, { id: "t2", time: 2, easing: "hold" as const, transform: { ...DEFAULT_TRANSFORM, x: .4 }, color: { ...DEFAULT_COLOR, exposure: -2 } }] };
  p.tracks[0].clips.push(target); return { p: validateProject(p), sourceId: source.id, targetId: target.id };
}
const protectedClip = (clip: any) => {
  const copy = structuredClone(clip); delete copy.color; delete copy.gradeV2;
  for (const k of copy.keyframes) delete k.color;
  if (copy.creative) delete copy.creative.lookPresetId;
  return copy;
};
describe("current-frame grade snapshot command", () => {
  it("captures animated Primary plus the existing legacy look and all v2 fields, without mutating source", () => {
    const { p, sourceId } = fixture(), before = JSON.stringify(p), source = p.tracks[0].clips[0], captured = captureClipGradeSnapshotV1(p, sourceId, 1);
    expect(captured.localTime).toBe(1); expect(captured.snapshot.color).toEqual(combineLookColor(animatedClipState(source, 1, p.fps).color, source.creative?.lookPresetId));
    expect(captured.snapshot.color.exposure).toBe(1); expect(captured.snapshot.gradeV2).toEqual(source.gradeV2); expect(JSON.stringify(p)).toBe(before);
  });
  it("pastes once with one Undo/Redo, makes target color constant and preserves every non-colour field", () => {
    const { p, sourceId, targetId } = fixture(), target = p.tracks[0].clips[1], snapshot = captureClipGradeSnapshotV1(p, sourceId, 1).snapshot, before = JSON.stringify(p);
    const command = { type: "paste_clip_grade_v1" as const, clipId: targetId, snapshot }, history = createHistory(p), next = dispatchCommand(history, command);
    expect(next.past).toHaveLength(1); expect(next.journal).toHaveLength(1); const after = next.present.tracks[0].clips[1];
    expect(after.color).toEqual(snapshot.color); expect(after.keyframes.every(k => JSON.stringify(k.color) === JSON.stringify(snapshot.color))).toBe(true);
    expect(after.gradeV2).toEqual(snapshot.gradeV2); expect(after.creative?.lookPresetId).toBeUndefined(); expect(protectedClip(after)).toEqual(protectedClip(target));
    expect(next.present.tracks[0].clips[0]).toBe(p.tracks[0].clips[0]); expect(next.present.assets).toBe(p.assets); expect(next.present.motionTracks).toBe(p.motionTracks);
    expect(JSON.stringify(p)).toBe(before); expect(undo(next).present.tracks[0].clips[1]).toEqual(target); expect(redo(undo(next)).present.tracks[0].clips[1]).toEqual(after);
    expect(validateProject(JSON.parse(JSON.stringify(next.present))).tracks[0].clips[1]).toEqual(after);
  });
  it("removes target v2 when source has none and preserves destination effects", () => {
    const { p, targetId } = fixture(), snapshot = { schema: "editkin.clip-grade-snapshot/v1" as const, color: { ...DEFAULT_COLOR } };
    const result = pasteClipGradeSnapshotV1(p, targetId, snapshot); expect(result.gradeV2).toBeUndefined(); expect(result.creative?.effectPresetIds).toEqual(p.tracks[0].clips[1].creative?.effectPresetIds);
    expect(result.keyframes[0].transform).toBe(p.tracks[0].clips[1].keyframes[0].transform);
  });
  it("uses identical colour semantics in batch fallback and fast path", () => {
    const { p, sourceId, targetId } = fixture(), command = { type: "paste_clip_grade_v1" as const, clipId: targetId, snapshot: captureClipGradeSnapshotV1(p, sourceId, 1).snapshot };
    expect(applyCommand(p, { type: "batch", commands: [command] }).tracks[0].clips[1]).toEqual(applyCommand(p, command).tracks[0].clips[1]);
    expect(editorCommandSchema.parse(command)).toEqual(command);
  });
  it.each(["locked", "unknown look", "NaN", "unknown field", "audio", "control layer"])("rejects %s atomically", kind => {
    const { p, sourceId, targetId } = fixture(), snapshot = captureClipGradeSnapshotV1(p, sourceId, 1).snapshot;
    if (kind === "locked") p.tracks[0].locked = true;
    if (kind === "unknown look") snapshot.gradeV2!.look!.id = "hfl2_unavailable";
    if (kind === "NaN") snapshot.color.exposure = NaN;
    if (kind === "unknown field") (snapshot as any).secret = 1;
    if (kind === "audio") p.assets[0].kind = "audio";
    if (kind === "control layer") p.tracks[0].clips[1].layer = { role: "control", blendMode: "normal", matteOnly: false } as any;
    const history = createHistory(p), before = JSON.stringify(p), result = dispatchCommandSafely(history, { type: "paste_clip_grade_v1", clipId: targetId, snapshot });
    expect(result.state).toBe(history); expect(result.error).toBeTruthy(); expect(JSON.stringify(p)).toBe(before);
  });
  it("edits 10000 model keyframes with one journal record and no sort, keeping motion values exact", () => {
    const { p, sourceId, targetId } = fixture(), target = p.tracks[0].clips[1], snapshot = captureClipGradeSnapshotV1(p, sourceId, 1).snapshot;
    target.keyframes = Array.from({ length: 10000 }, (_, i) => ({ id: `key${i}`, time: i / 3000, easing: "linear" as const, transform: { ...DEFAULT_TRANSFORM, x: i / 10000 }, color: { ...DEFAULT_COLOR } }));
    Object.defineProperty(target.keyframes, "sort", { value: () => { throw Error("per-keyframe sort forbidden"); }, enumerable: false });
    const next = dispatchCommand(createHistory(p), { type: "paste_clip_grade_v1", clipId: targetId, snapshot });
    expect(next.journal).toHaveLength(1); expect(next.present.tracks[0].clips[1].keyframes).toHaveLength(10000);
    expect(next.present.tracks[0].clips[1].keyframes[9999].transform).toBe(target.keyframes[9999].transform);
    expect(next.present.tracks[0].clips[1].keyframes[9999].color).toEqual(snapshot.color);
  });
});

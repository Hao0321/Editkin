import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { activeMediaLayers } from "./previewMedia";
import { ADJUSTMENT_LAYER_HOST_REQUIRED, ADJUSTMENT_LAYER_RANGE_REQUIRED, adjustmentLayerRangeV1, planAdjustmentLayerV1 } from "./adjustmentLayerPlanV1";

// P7 (2026-10-23): ＋ 調整圖層 with the existing commands. Real domain apply, validation, history and preview layers.
let next = 0;
const ids = (prefix: string) => `${prefix}-${++next}`;

describe("＋ 調整圖層", () => {
  it("adds an adjustment clip over the selected clip on a new top picture track, as one Undo", () => {
    const project = createDemoProject();
    const plan = planAdjustmentLayerV1(project, { selectedClipId: "clip-demo", trackName: "調整圖層" }, ids);
    const before = createHistory(project), after = dispatchCommand(before, plan.command);
    expect(after.past.length).toBe(before.past.length + 1);
    validateProject(after.present);
    const pictures = after.present.tracks.filter(track => track.kind === "video");
    expect(pictures.at(-1)!.id).toBe(plan.trackId);
    expect(pictures.at(-1)!.name).toBe("調整圖層");
    const clip = pictures.at(-1)!.clips[0]!;
    expect(clip).toMatchObject({ id: plan.clipId, timelineStart: 0, duration: 12, sourceStart: 0, volume: 0, layer: { enabled: true, blendMode: "normal", role: "adjustment" } });
    // It never plays as a picture or a sound layer of its own.
    for (const kind of ["video", "audio"] as const) expect(activeMediaLayers(after.present, 3, {}, kind).some(layer => layer.clip.id === plan.clipId)).toBe(false);
    expect(undo(after).present).toEqual(project);
  });
  it("covers the marked I/O range first, frame aligned, and reuses the adjustment track on top when it is free", () => {
    const project = createDemoProject();
    expect(adjustmentLayerRangeV1(project, "clip-demo", { in: 2.01, out: 5.49 })).toEqual({ start: 2, end: 5.5 });
    const first = dispatchCommand(createHistory(project), planAdjustmentLayerV1(project, { markRange: { in: 2, out: 5 }, trackName: "調整圖層" }, ids).command);
    const secondPlan = planAdjustmentLayerV1(first.present, { markRange: { in: 6, out: 8 }, trackName: "調整圖層" }, ids);
    expect(secondPlan.command.commands.map(command => command.type)).toEqual(["add_clip"]);
    const second = dispatchCommand(first, secondPlan.command);
    validateProject(second.present);
    expect(second.present.tracks.filter(track => track.kind === "video").at(-1)!.clips.map(clip => [clip.timelineStart, clip.duration])).toEqual([[2, 3], [6, 2]]);
    // An overlapping range gets a new track (named apart), never stacks on the same one.
    const overlap = planAdjustmentLayerV1(second.present, { markRange: { in: 4, out: 7 }, trackName: "調整圖層" }, ids);
    expect(overlap.command.commands[0]).toMatchObject({ type: "add_track", track: { name: "調整圖層 2", kind: "video" } });
    validateProject(dispatchCommand(second, overlap.command).present);
  });
  it("never reuses 主畫面, an empty track someone added or a locked adjustment track", () => {
    const project = createDemoProject();
    project.tracks.splice(1, 0, { id: "empty", name: "影像圖層", kind: "video", locked: false, muted: false, clips: [] });
    expect(planAdjustmentLayerV1(project, { selectedClipId: "clip-demo", trackName: "調整圖層" }, ids).command.commands[0]!.type).toBe("add_track");
    const added = dispatchCommand(createHistory(project), planAdjustmentLayerV1(project, { markRange: { in: 0, out: 1 }, trackName: "調整圖層" }, ids).command).present;
    added.tracks.filter(track => track.kind === "video").at(-1)!.locked = true;
    expect(planAdjustmentLayerV1(added, { markRange: { in: 3, out: 4 }, trackName: "調整圖層" }, ids).command.commands[0]!.type).toBe("add_track");
  });
  it("asks for a range when nothing is selected or marked, and for long enough media", () => {
    const project = createDemoProject();
    expect(() => planAdjustmentLayerV1(project, { trackName: "調整圖層" }, ids)).toThrow(ADJUSTMENT_LAYER_RANGE_REQUIRED);
    expect(() => planAdjustmentLayerV1(project, { markRange: { in: 0, out: 40 }, trackName: "調整圖層" }, ids)).toThrow(ADJUSTMENT_LAYER_HOST_REQUIRED);
  });
});

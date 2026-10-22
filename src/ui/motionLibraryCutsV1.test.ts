import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { motionLibraryFixtureProject, plainClip } from "../domain/motionLibraryV1.fixture";
import type { EditProject } from "../domain/types";
import { defaultTransitionFramesV1, findCutV1, listProjectCutsV1, listTrackCutsV1, matteTransitionFrameLimitsV1, nearestCutV1, resizeTransitionWindowV1,
  transitionWindowV1 } from "./motionLibraryCutsV1";

const cutRef = { trackId: "video-main", fromClipId: "a", toClipId: "b" };
function withTransition(project: EditProject, before = 7, after = 8): EditProject {
  return applyCommand(project, { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "t1", ...cutRef, beforeFrames: before, afterFrames: after, kernel: "dissolve" } });
}

describe("Motion Library cut points", () => {
  it("lists the cut between adjacent content clips with the domain's handle limits", () => {
    const project = motionLibraryFixtureProject();
    const [cut] = listTrackCutsV1(project, "video-main");
    // a: 0–3 s from source 1 s; b: 3–6 s from source 5 s; footage lasts 10 s.
    expect(cut).toMatchObject({ ...cutRef, cutFrame: 90, time: 3, maxBefore: 90, maxAfter: 90, locked: false, eligible: true });
    expect(cut.transition).toBeUndefined();
    expect(listTrackCutsV1(project, "overlay")).toEqual([]);
    expect(listProjectCutsV1(withTransition(project))[0].transition?.id).toBe("t1");
  });

  it("limits each side by the unused source before the in point and after the out point", () => {
    let project = motionLibraryFixtureProject();
    project = applyCommand(project, { type: "slip_clip", clipId: "b", sourceStart: 0.1 });
    const cut = findCutV1(project, cutRef)!;
    expect(cut.maxBefore).toBe(3);
    // 15 frames centred would be 7 + 8; only 3 fit before the cut, so the rest moves after it.
    expect(transitionWindowV1(cut, 15, { min: 2, max: 300 })).toEqual({ window: { before: 3, after: 12 } });
  });

  it("refuses a window when neither clip has handles and gives stills unlimited handles", () => {
    const project = motionLibraryFixtureProject();
    const tight = { maxBefore: 0, maxAfter: 1 };
    expect(transitionWindowV1(tight, 15, { min: 2, max: 300 })).toHaveProperty("refusal");
    let stills = applyCommand(project, { type: "import_asset", asset: { id: "still", name: "Still", kind: "image", uri: "still.png", duration: 5, width: 1080, height: 1920 } });
    stills = applyCommand(stills, { type: "add_clip", clip: plainClip("s1", "still", "overlay", 0, 0, 2) });
    stills = applyCommand(stills, { type: "add_clip", clip: plainClip("s2", "still", "overlay", 2, 0, 2) });
    const cut = listTrackCutsV1(stills, "overlay")[0];
    expect(cut.maxBefore).toBe(60);
    expect(cut.maxAfter).toBe(60);
  });

  it("keeps neighbouring windows apart", () => {
    let project = motionLibraryFixtureProject();
    project = applyCommand(project, { type: "add_clip", clip: plainClip("c", "footage", "video-main", 6, 8, 1) });
    project = applyCommand(project, { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "t2", trackId: "video-main",
      fromClipId: "b", toClipId: "c", beforeFrames: 80, afterFrames: 10, kernel: "dissolve" } });
    // b runs frames 90–180; the b→c window starts at 100, so the a→b window can reach only 10 frames after its cut.
    expect(findCutV1(project, cutRef)!.maxAfter).toBe(10);
  });

  it("picks the editable cut nearest the playhead, preferring the selected clip's track", () => {
    let project = motionLibraryFixtureProject();
    project = applyCommand(project, { type: "add_clip", clip: plainClip("o1", "footage", "overlay", 0, 0, 5) });
    project = applyCommand(project, { type: "add_clip", clip: plainClip("o2", "footage", "overlay", 5, 5, 3) });
    expect(nearestCutV1(project, 4.6)?.fromClipId).toBe("o1");
    expect(nearestCutV1(project, 4.6, "video-main")?.fromClipId).toBe("a");
    project = applyCommand(project, { type: "toggle_track_lock", trackId: "overlay" });
    expect(nearestCutV1(project, 4.6)?.fromClipId).toBe("a");
  });

  it("resizes one edge within the handles and the length limits", () => {
    const cut = { maxBefore: 20, maxAfter: 9 };
    const limits = matteTransitionFrameLimitsV1(30);
    expect(limits).toEqual({ min: 6, max: 60 });
    expect(resizeTransitionWindowV1(cut, { before: 7, after: 8 }, "before", 100, limits)).toEqual({ before: 20, after: 8 });
    expect(resizeTransitionWindowV1(cut, { before: 7, after: 8 }, "after", 5, limits)).toEqual({ before: 7, after: 9 });
    expect(resizeTransitionWindowV1(cut, { before: 3, after: 4 }, "before", -10, limits)).toEqual({ before: 2, after: 4 });
    expect(defaultTransitionFramesV1(30)).toBe(15);
    expect(defaultTransitionFramesV1(24)).toBe(12);
    expect(matteTransitionFrameLimitsV1(30000 / 1001)).toEqual({ min: 6, max: 59 });
  });
});

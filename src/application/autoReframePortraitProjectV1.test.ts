import { describe, expect, it } from "vitest";
import { validateProject } from "../domain/editGraph";
import { canonicalJson } from "../shared/canonicalJson";
import { createAutoReframePortraitProjectV1, assertAutoReframeVideoV1 } from "./autoReframePortraitProjectV1";
import { autoReframeWorkflowFixtureV1, workflowIdentityV1 } from "./__fixtures__/autoReframeWorkflowV1.fixture";
import { resolveAestheticSystem } from "./editkinAesthetic";

describe("selected original to separate portrait draft", () => {
  it("preserves sources/rights, authored audio/colour/masks/tracks and cue words without modifying the source", () => {
    const p = autoReframeWorkflowFixtureV1(false), before = canonicalJson(p), sourceClip = structuredClone(p.tracks[0].clips[0]);
    const r = createAutoReframePortraitProjectV1(p, "selected", 90, 160, workflowIdentityV1()), q = r.project;
    expect(canonicalJson(p)).toBe(before); expect(q.id).not.toBe(p.id); expect(q.width).toBe(90); expect(q.height).toBe(160); expect(q.revision).toBe(0);
    expect(q.tracks[0].clips).toEqual([{ ...sourceClip, timelineStart: 0 }]);
    expect(q.tracks[1]).toEqual({ ...p.tracks[1], clips: [{ ...p.tracks[1].clips[0], timelineStart: .25 }] });
    expect(q.assets).toEqual(p.assets); expect(q.motionTracks).toEqual(p.motionTracks); expect(q.colorManagement).toEqual(p.colorManagement); expect(q.captionStyle).toEqual(p.captionStyle);
    expect(q.captions).toEqual([{ ...p.captions[0], start: 0, duration: .5 }, { ...p.captions[1], start: 1, duration: .25 }]);
    expect(q.director.markers).toEqual([{ ...p.director.markers[0], time: .5 }]); expect(r.summary).toMatchObject({ linkedAudioClips: 1, captions: 2, masks: 1, motionTracks: 1, originalProjectModified: false, inheritedApproval: false });
    q.assets[0].rightsBasis = "changed-copy"; q.tracks[0].clips[0].masks![0].path[0].x = .9;
    expect(canonicalJson(p)).toBe(before); validateProject(q);
  });
  it("resets review status and approval rather than inheriting the original's approval", () => {
    const p = autoReframeWorkflowFixtureV1(false); p.aestheticSystem = resolveAestheticSystem("auto", "longform");
    p.aestheticSystem.review.status = "PASSED"; p.aestheticSystem.review.score = 100; p.director.reviewState = "ready_for_hao_review";
    const q = createAutoReframePortraitProjectV1(p, "selected", 90, 160, workflowIdentityV1()).project;
    expect(q.director.reviewState).toBe("draft"); expect(q.aestheticSystem?.review.status).toBe("REVIEW"); expect(q.aestheticSystem?.review.score).toBe(0);
    expect(p.aestheticSystem.review.score).toBe(100);
  });
  it.each(["locked", "camera", "keyframes", "retime", "uninspected", "stale-matte"])("refuses %s instead of discarding authored settings", reason => {
    const p = autoReframeWorkflowFixtureV1(false), c = p.tracks[0].clips[0];
    if (reason === "locked") p.tracks[0].locked = true;
    if (reason === "camera") c.transform.x = 4;
    if (reason === "keyframes") c.keyframes = [{ id: "authored", time: 0, transform: { ...c.transform }, color: { ...c.color }, easing: "linear" }];
    if (reason === "retime") c.speed = 2;
    if (reason === "uninspected") delete p.assets[0].derivatives;
    if (reason === "stale-matte") c.masks![0].matteSequence = { stale: true } as never;
    const before = canonicalJson(p); expect(() => createAutoReframePortraitProjectV1(p, "selected", 90, 160, workflowIdentityV1())).toThrow(); expect(canonicalJson(p)).toBe(before);
  });
  it.each(["foreign-linked-video", "audio-window", "parent", "transition", "fixed-window", "missing-mask-track", "template-caption", "template-marker", "motion-overlay", "3d"])("refuses unsupported %s dependencies", reason => {
    const p = autoReframeWorkflowFixtureV1(false), c = p.tracks[0].clips[0];
    if (reason === "foreign-linked-video") p.tracks[0].clips[1].linkGroupId = c.linkGroupId;
    if (reason === "audio-window") p.tracks[1].clips[0].timelineStart = 1;
    if (reason === "parent") c.layer = { parentClipId: "outside" } as never;
    if (reason === "transition") c.creative = { transitionOut: { id: "crossfade", duration: .5 } } as never;
    if (reason === "fixed-window") c.masks![0].fixedWindowV3 = { schema: "editkin.fixed-template-window/v3" };
    if (reason === "missing-mask-track") p.motionTracks = [];
    if (reason === "template-caption") p.captions[0].templateOwner = { id: "template" } as never;
    if (reason === "template-marker") p.director.markers[0].templateOwner = { id: "template" } as never;
    if (reason === "motion-overlay") p.motionGraphics = [{ id: "overlay", timelineStart: 2, duration: 1 } as never];
    if (reason === "3d") p.scene3d = { segments: [{}] } as never;
    expect(() => createAutoReframePortraitProjectV1(p, "selected", 90, 160, workflowIdentityV1())).toThrow();
  });
  it("requires a separate identity, deterministic ISO time and exact 9:16 dimensions", () => {
    const p = autoReframeWorkflowFixtureV1(false);
    for (const id of [{ ...workflowIdentityV1(), id: p.id }, { ...workflowIdentityV1(), createdAt: "yesterday" }, { ...workflowIdentityV1(), name: " " }])
      expect(() => createAutoReframePortraitProjectV1(p, "selected", 90, 160, id)).toThrow();
    expect(() => createAutoReframePortraitProjectV1(p, "selected", 160, 90, workflowIdentityV1())).toThrow("PORTRAIT_SIZE");
    expect(createAutoReframePortraitProjectV1(p, "selected", 90, 160, { ...workflowIdentityV1(), name: "  My portrait  " }).project.name).toBe("My portrait");
    expect(() => assertAutoReframeVideoV1(p, "unknown")).toThrow("VIDEO_REQUIRED");
  });
});

import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { referenceMotionSourceDraft, referenceMotionSourceChoices, referenceMotionSourceDraftRequest, selectReferenceMotionDraftAsset,
  snappedReferenceMotionSourceTime } from "./referenceMotionSourceDraft";

function fixture() {
  const project = createDemoProject(), primary = project.tracks[0].clips[0]; primary.duration = 8; primary.volume = 0;
  project.assets[0].duration = 30;
  project.assets.push({ ...structuredClone(project.assets[0]), id: "extra", uri: "D:/fixture/extra.mp4" },
    { ...structuredClone(project.assets[0]), id: "new", uri: "D:/fixture/new.mp4" });
  const instance = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "synthetic-owner", authoringGeneration: 2,
    instanceRevision: 1, input: { templateId: "context_stack", clipId: primary.id, startFrame: 0, durationFrames: 240, title: "Title",
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), sources: [{ assetId: "extra", sourceStart: 2, label: "Original" }], intent: "shortform",
      purpose: "Selector tests only", evidenceRefs: ["old:observation"], overlayPresentation: "source_editorial_v1",
      focusRegion: { x: .1, y: .1, width: .5, height: .5 }, textRegion: { x: .1, y: .1, width: .5, height: .5 } },
    frameFormat: { width: project.width, height: project.height, fps: project.fps }, primaryBefore: { layout: null },
    roles: [{ key: "source:1:clip", kind: "clip", id: "extra-clip", parentId: "extra-track" }],
    dependencies: { recipeVersion: "synthetic", fonts: [], presetHashes: [] }, appliedScopeSha256: "1".repeat(64) });
  project.tracks.push({ id: "extra-track", name: "Extra", kind: "video", locked: false, muted: false,
    clips: [{ ...structuredClone(primary), id: "extra-clip", trackId: "extra-track", assetId: "extra", sourceStart: 2 }] });
  project.referenceMotionInstances = [instance]; return { project, instance, primary };
}
describe("template source draft decisions without a physical acceptance claim", () => {
  it("preserves intentional mute and clears old crop/text placement unless explicitly selected", () => {
    const f = fixture(), draft = referenceMotionSourceDraft(f.project, f.instance);
    expect(draft.primaryAudio).toBe("mute"); expect(draft.keepFocus).toBe(false); expect(draft.keepText).toBe(false);
    draft.purpose = "New observed source"; draft.confirmed = true;
    const request = referenceMotionSourceDraftRequest(f.project, f.instance, draft, "fresh-decision");
    expect(request).toMatchObject({ focusRegion: null, textRegion: null, audio: { primary: "mute", extra: ["muted"] } });
    expect(request.evidenceRefs).not.toEqual(f.instance.input.evidenceRefs);
    draft.keepText = true; expect(referenceMotionSourceDraftRequest(f.project, f.instance, draft, "optin").textRegion).toEqual(f.instance.input.textRegion);
  });
  it("preselects a managed extra clone, excludes another slot's file, and resets its label for a new file", () => {
    const f = fixture(), draft = referenceMotionSourceDraft(f.project, f.instance, "extra-clip");
    expect(draft.selectedSlot).toBe(1);
    expect(referenceMotionSourceChoices(f.project, f.instance, draft).some(asset => asset.id === f.primary.assetId)).toBe(false);
    const selected = selectReferenceMotionDraftAsset(draft, "new");
    expect(selected.slots[1]).toEqual({ assetId: "new", sourceStart: "0", label: "" }); expect(selected.confirmed).toBe(false);
    selected.confirmed = true; selected.purpose = "Fresh material";
    expect(() => referenceMotionSourceDraftRequest(f.project, f.instance, selected, "new")).toThrow();
    selected.slots[1].label = "New footage"; expect(referenceMotionSourceDraftRequest(f.project, f.instance, selected, "new").sources?.[0]?.label).toBe("New footage");
  });
  it("snaps typed source seconds and duration to the nearest project frame, not to source FPS", () => {
    expect(snappedReferenceMotionSourceTime(".117", 30)).toEqual({ seconds: 4 / 30, frame: 4 });
    for (const value of ["", " ", "-1", "Infinity", "NaN"]) expect(snappedReferenceMotionSourceTime(value, 30)).toBeUndefined();
  });
  it("refuses aliased bytes, insufficient length and a shrink adjacent to a foreign clip", () => {
    const f = fixture(), draft = referenceMotionSourceDraft(f.project, f.instance); draft.confirmed = true; draft.purpose = "Choice";
    const original = structuredClone(f.project);
    f.project.assets[1].uri = f.project.assets[0].uri; expect(() => referenceMotionSourceDraftRequest(f.project, f.instance, draft, "alias")).toThrow("同一個影片");
    f.project.assets[1].uri = original.assets[1].uri;
    draft.slots[0].sourceStart = "29"; expect(() => referenceMotionSourceDraftRequest(f.project, f.instance, draft, "short")).toThrow("長度不足");
    draft.slots[0].sourceStart = "0"; draft.durationMode = "change"; draft.duration = "6";
    f.project.tracks[0].clips.push({ ...structuredClone(f.primary), id: "following", timelineStart: 8, duration: 2 });
    expect(() => referenceMotionSourceDraftRequest(f.project, f.instance, draft, "adjacent")).toThrow("不能縮短");
  });
  it("drops an unused pending import when another existing file is selected", () => {
    const f = fixture(); const picked = { asset: { ...structuredClone(f.project.assets[2]), id: "pending" }, previewUrl: "asset:pending" };
    const draft = selectReferenceMotionDraftAsset({ ...referenceMotionSourceDraft(f.project, f.instance), picked }, "pending");
    expect(draft.picked).toBe(picked); expect(selectReferenceMotionDraftAsset(draft, "new").picked).toBeUndefined();
    expect(f.project.assets.some(asset => asset.id === "pending")).toBe(false);
  });
});

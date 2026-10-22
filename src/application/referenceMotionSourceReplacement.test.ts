import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { referenceMotionSourceReplacementRequestSchema, referenceMotionSourceSlots, referenceMotionClipOwner,
  sourceReplacementExactFrame, sourceReplacementMinimumFrames } from "./referenceMotionSourceReplacement";

function fixture() {
  const project = createDemoProject(); project.width = 1080; project.height = 1920;
  const primary = project.tracks[0].clips[0]; primary.duration = 8;
  project.assets.push({ ...project.assets[0], id: "extra", uri: "extra.mp4" });
  project.tracks[0].clips.push({ ...primary, id: "extra-clip", assetId: "extra", timelineStart: 10, sourceStart: 2 });
  const instance = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "source-owner", authoringGeneration: 2,
    instanceRevision: 1, input: { templateId: "comparison_pair", clipId: primary.id, startFrame: 0, durationFrames: 240,
      title: "測試主標", style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), sources: [{ assetId: "extra", sourceStart: 2, label: "第二份" }], intent: "shortform", purpose: "Synthetic selector only",
      evidenceRefs: ["synthetic:not-current-proof"] }, frameFormat: { width: 1080, height: 1920, fps: 30 },
    roles: [{ key: "source:1:clip", kind: "clip", id: "extra-clip", parentId: primary.trackId }], primaryBefore: { layout: null },
    appliedScopeSha256: "1".repeat(64), dependencies: { recipeVersion: "synthetic-view-only", presetHashes: [], fonts: [] } });
  project.referenceMotionInstances = [instance]; return { project, instance };
}
describe("T09 source request and numbered view (not a physical source verification)", () => {
  const base = { instanceId: "owner", expectedInstanceRevision: 1, expectedProjectRevision: 0, audio: { primary: "keep_level" } };
  it("requires explicit audio and refuses copy, style, timing-origin or approval overrides", () => {
    expect(referenceMotionSourceReplacementRequestSchema.parse(base)).toEqual(base);
    expect(referenceMotionSourceReplacementRequestSchema.safeParse({ instanceId: "owner", expectedInstanceRevision: 1, expectedProjectRevision: 0 }).success).toBe(false);
    for (const field of ["title", "style", "clipId", "startFrame", "templateId", "rightsBasis", "aestheticReview"]) {
      expect(referenceMotionSourceReplacementRequestSchema.safeParse({ ...base, [field]: "bad" }).success).toBe(false);
    }
  });
  it("supports aligned source changes, nullable kept slots and window-only requests without invented defaults", () => {
    const request = { ...base, primary: { assetId: "new-video", sourceStart: 1 }, sources: [null, { assetId: "new-extra", sourceStart: 2 }],
      durationFrames: 180, focusRegion: null, audio: { primary: "mute", extra: ["muted", "muted"] } };
    expect(referenceMotionSourceReplacementRequestSchema.parse(request)).toEqual(request);
    for (const patch of [{ durationFrames: 1801 }, { primary: { assetId: " new-video", sourceStart: 1 } },
      { primary: { assetId: "new-video", sourceStart: -.001 } }, { audio: { primary: "automatic" } },
      { audio: { primary: "mute", extra: ["source"] } }, { expectedInstanceRevision: 0 }]) {
      expect(referenceMotionSourceReplacementRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
  });
  it("maps the primary and every retained slot clip without changing any saved input", () => {
    const { project, instance } = fixture(), before = structuredClone(project);
    expect(referenceMotionSourceSlots(project, instance).map(slot => [slot.slot, slot.clipIds, slot.assetId, slot.sourceStart, slot.audio])).toEqual([
      [0, ["clip-demo"], "asset-demo", 0, "primary"], [1, ["extra-clip"], "extra", 2, "muted"],
    ]);
    expect(referenceMotionClipOwner(project, "extra-clip")?.slot).toBe(1); expect(referenceMotionClipOwner(project, "ordinary")).toBeUndefined();
    expect(project).toEqual(before);
  });
  it("refuses missing roles, ambiguous owners and unknown semantic clip slots", () => {
    const { project, instance } = fixture(); instance.roles[0].key = "unrecognized";
    expect(() => referenceMotionSourceSlots(project, instance)).toThrow("模板結構"); instance.roles[0].key = "source:1:clip";
    project.tracks[0].clips.pop(); expect(() => referenceMotionSourceSlots(project, instance)).toThrow("模板結構");
    project.referenceMotionInstances!.push({ ...instance, id: "other-owner" });
    expect(() => referenceMotionClipOwner(project, "clip-demo")).toThrow("模板結構");
  });
  it("enforces exact safe project frames and the family's existing minimum without using a source FPS as a refusal", () => {
    const { project, instance } = fixture(); expect(sourceReplacementExactFrame(1.5, 30)).toBe(45);
    for (const seconds of [-1, .001, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) expect(sourceReplacementExactFrame(seconds, 30)).toBeUndefined();
    expect(sourceReplacementExactFrame(1, 241)).toBeUndefined(); expect(sourceReplacementMinimumFrames(project, instance)).toBe(120);
    instance.input.templateId = "kinetic_network"; expect(sourceReplacementMinimumFrames(project, instance)).toBe(240);
  });
});

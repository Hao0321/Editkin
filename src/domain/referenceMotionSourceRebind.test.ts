import { describe, expect, it } from "vitest";
import { issueReferenceMotionSourceOwnerProof } from "./referenceMotionSourceOwnerProof";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import type { EditorCommand } from "./commandTypes";
import { editorCommandSchema } from "./schema";
import { referenceMotionInstanceSchema } from "./referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { getReferenceMotionSourceRebindError, assertReferenceMotionSourceRebindBatch } from "./referenceMotionSourceRebind";

function fixture() {
  const project = createDemoProject(); project.schemaVersion = 10;
  const primary = project.tracks[0].clips[0]; primary.duration = 8;
  project.assets[0].duration = 30;
  project.assets.push({ ...structuredClone(project.assets[0]), id: "extra", uri: "extra.mp4" },
    { ...structuredClone(project.assets[0]), id: "replacement", uri: "replacement.mp4", width: 1440, height: 900 });
  project.tracks.push({ id: "source-extra-track", name: "Synthetic managed source", kind: "video", locked: false, muted: false,
    clips: [{ ...structuredClone(primary), id: "extra-clip", trackId: "source-extra-track", assetId: "extra", sourceStart: 2, volume: 0 }] });
  const instance = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "synthetic-owner", authoringGeneration: 2,
    instanceRevision: 1, input: { templateId: "comparison_pair", clipId: primary.id, startFrame: 0, durationFrames: 240, title: "Synthetic",
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), sources: [{ assetId: "extra", sourceStart: 2, label: "Extra" }], intent: "shortform",
      purpose: "Domain invariants only; not a CURRENT or physical source claim", evidenceRefs: ["synthetic:domain-only"] },
    frameFormat: { width: project.width, height: project.height, fps: project.fps }, primaryBefore: { layout: null },
    roles: [{ key: "source:1:track", kind: "track", id: "source-extra-track" }, { key: "source:1:clip", kind: "clip", id: "extra-clip", parentId: "source-extra-track" }],
    dependencies: { recipeVersion: "synthetic-domain-only", fonts: [], presetHashes: [] }, appliedScopeSha256: "1".repeat(64) });
  project.referenceMotionInstances = [instance];
  const next = structuredClone(instance); next.instanceRevision = 2; next.input.durationFrames = 180;
  const rebind: Extract<EditorCommand, { type: "rebind_reference_motion_clip_source" }> = { type: "rebind_reference_motion_clip_source", clipId: primary.id,
    expected: { assetId: primary.assetId, sourceStart: primary.sourceStart, duration: 8 }, assetId: "replacement", sourceStart: 1, duration: 6 };
  const extra: typeof rebind = { ...rebind, clipId: "extra-clip", expected: { assetId: "extra", sourceStart: 2, duration: 8 }, assetId: "extra", sourceStart: 2 };
  const upsert: Extract<EditorCommand, { type: "upsert_reference_motion_instance" }> = { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: 1 };
  return { project, primary, instance, next, rebind, extra, upsert, batch: { type: "batch", commands: [rebind, extra, upsert] } as EditorCommand };
}

describe("source rebind domain guards, with structurally valid synthetic ownership", () => {
  it("accepts one aligned whole-instance source-window commit and preserves the original graph", () => {
    const f = fixture(), before = structuredClone(f.project);
    expect(editorCommandSchema.parse(f.rebind)).toEqual(f.rebind);
    const result = commit(f.project, f.batch);
    expect(result.tracks[0].clips[0]).toMatchObject({ id: f.primary.id, assetId: "replacement", sourceStart: 1, duration: 6, timelineStart: 0 });
    expect(result.tracks.find(track => track.id === "source-extra-track")!.clips[0].duration).toBe(6);
    expect(result.referenceMotionInstances![0].instanceRevision).toBe(2); expect(f.project).toEqual(before);
  });
  it("refuses standalone, nested, duplicate, early, missing and stale owner commits", () => {
    const f = fixture();
    const cases: EditorCommand[] = [f.rebind, { type: "batch", commands: [{ type: "batch", commands: [f.rebind, f.upsert] }] },
      { type: "batch", commands: [f.rebind, f.rebind, f.upsert] }, { type: "batch", commands: [f.upsert, f.rebind] },
      { type: "batch", commands: [f.rebind] }, { type: "batch", commands: [f.rebind, { ...f.upsert, expectedInstanceRevision: 2 }] },
      { type: "batch", commands: [f.rebind, f.upsert, f.upsert] }];
    for (const command of cases) expect(() => applyCommand(f.project, command)).toThrow();
  });
  it("refuses source commands that smuggle copy, typography, topology, clocks or primary-before changes", () => {
    for (const mutation of ["copy", "style", "slots", "start", "format", "before", "role"] as const) {
      const f = fixture();
      if (mutation === "copy") f.next.input.title = "Other";
      if (mutation === "style") f.next.input.style.palette.accent = "#010203";
      if (mutation === "slots") f.next.input.sources = [];
      if (mutation === "start") f.next.input.startFrame = 30;
      if (mutation === "format") f.next.frameFormat.fps = 24;
      if (mutation === "before") f.next.primaryBefore.creative = null;
      if (mutation === "role") f.next.roles[0].id = "forged-track";
      expect(() => assertReferenceMotionSourceRebindBatch(f.project, f.batch)).toThrow();
    }
  });
  it("refuses rehashed metadata whose retained extra source or duration does not match its clips", () => {
    const f = fixture(); f.next.appliedScopeSha256 = "2".repeat(64); f.next.input.sources[0].assetId = "replacement";
    expect(() => commit(f.project, f.batch)).toThrow("不一致");
    const second = fixture(); second.next.input.durationFrames = 240;
    expect(() => commit(second.project, second.batch)).toThrow("不一致");
  });
  it("checks all expected fields exactly and refuses locked, linked and ambiguous owners", () => {
    for (const patch of [{ assetId: "extra" }, { sourceStart: 1 }, { duration: 7 }]) {
      const f = fixture(); expect(getReferenceMotionSourceRebindError(f.project, { ...f.rebind, expected: { ...f.rebind.expected, ...patch } })).toContain("已變更");
    }
    const locked = fixture(); locked.project.tracks[0].locked = true; expect(() => commit(locked.project, locked.batch)).toThrow("鎖定");
    const linked = fixture(); linked.primary.linkGroupId = "authored-link"; expect(getReferenceMotionSourceRebindError(linked.project, linked.rebind)).toContain("解除連結");
    const ambiguous = fixture(); ambiguous.project.referenceMotionInstances!.push({ ...structuredClone(ambiguous.instance), id: "second-owner" });
    expect(() => applyCommand(ambiguous.project, ambiguous.batch)).toThrow();
  });
  it("rejects unmeasured geometry, nonvideo, short and non-frame-aligned source windows without mutation", () => {
    for (const mode of ["geometry", "image", "short", "frame", "duration"] as const) {
      const f = fixture(), asset = f.project.assets.find(asset => asset.id === "replacement")!;
      if (mode === "geometry") delete asset.width;
      if (mode === "image") asset.kind = "image";
      if (mode === "short") asset.duration = 2;
      if (mode === "frame") f.rebind.sourceStart = .001;
      if (mode === "duration") f.rebind.duration = 6.001;
      const before = structuredClone(f.project); expect(() => applyCommand(f.project, f.batch)).toThrow(); expect(f.project).toEqual(before);
    }
  });
  it("supports a same-asset in-point change but refuses extending into the next authored clip", () => {
    const f = fixture(); f.rebind.assetId = f.primary.assetId; expect(getReferenceMotionSourceRebindError(f.project, f.rebind)).toBeUndefined();
    f.project.tracks[0].clips.push({ ...structuredClone(f.primary), id: "next", timelineStart: 8, duration: 2 });
    expect(getReferenceMotionSourceRebindError(f.project, { ...f.rebind, duration: 9 })).toContain("後面的片段");
  });
  it("requires strict identities and finite expected windows", () => {
    const f = fixture();
    for (const patch of [{ assetId: " replacement" }, { sourceStart: -1 }, { duration: Number.NaN }, { title: "injected" },
      { expected: { ...f.rebind.expected, duration: Number.POSITIVE_INFINITY } }]) expect(editorCommandSchema.safeParse({ ...f.rebind, ...patch }).success).toBe(false);
  });
  it("refuses unmuting a retained extra source in a forged commit", () => {
    const f = fixture();
    if (f.batch.type !== "batch") throw new Error("fixture must be a batch");
    f.batch.commands.splice(2, 0, { type: "set_clip_volume", clipId: "extra-clip", volume: 1 });
    expect(() => commit(f.project, f.batch)).toThrow("聲音選擇");
  });
  it("requires opaque authority bound to the exact original project and complete batch", () => {
    const f = fixture(), proof = issueReferenceMotionSourceOwnerProof(f.project, f.batch, [f.instance.id]);
    for (const fake of [undefined, {}, structuredClone(proof)]) expect(() => applyCommand(f.project, f.batch, { referenceMotionSourceOwnerProof: fake })).toThrow("提交證明");
    expect(() => applyCommand(f.project, f.batch, { referenceMotionSourceOwnerProof: proof })).not.toThrow();
    f.project.updatedAt = "2026-10-12T00:00:00.000Z";
    expect(() => applyCommand(f.project, f.batch, { referenceMotionSourceOwnerProof: proof })).toThrow("提交證明");
  });
  it("refuses shrinking a primary with a transition before touching its sibling graph", () => {
    const f = fixture(); f.primary.creative = { effectPresetIds: [], transitionOut: { presetId: "cross_dissolve", duration: .5 } };
    expect(getReferenceMotionSourceRebindError(f.project, f.rebind)).toContain("不能縮短");
  });
});

// Exercises structural domain invariants with explicitly issued synthetic authority.
// Physical glyph authority is tested in the application transaction suite.
function commit(project: ReturnType<typeof fixture>["project"], command: EditorCommand) {
  return applyCommand(project, command, { referenceMotionSourceOwnerProof:
    issueReferenceMotionSourceOwnerProof(project, command, project.referenceMotionInstances!.map(instance => instance.id)) });
}

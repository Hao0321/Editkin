import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import type { EditorCommand } from "./commandTypes";
import type { ReferenceMotionTemplateInstance } from "./referenceMotionInstance";
import type { MotionPaintV1 } from "./motionPaint";
import { assertMotionPaintEditOwner } from "./motionPaint";
import { issueNativePaintOwnerRevisionProof, verifyNativePaintOwnerRevisionProof } from "./nativePaintOwnerRevision";

// Structural grant-boundary controls only. These fixtures are not a physical
// compiler receipt, native pixels, an art review, or a product acceptance.
function fixture() {
  const project = createDemoProject(), clip = project.tracks[0].clips[0];
  const paint: MotionPaintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#EEF4FFFF" }, clips: [] };
  const graphic = createMotionGraphic("owned-panel", "card", "", 0, 4, undefined, {
    ...findMotionGraphicPreset("reel_native_panel").seed, schema: "hao.motion-composition/v2", visualStyle: "native_paint",
    paintV1: paint, backgroundColor: "#00000000", outlineWidth: 0, shadowDepth: 0,
    vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 },
  });
  project.motionGraphics = [graphic]; project.schemaVersion = 10;
  const instance: ReferenceMotionTemplateInstance = {
    schema: "editkin.reference-motion-instance/v1", id: "instance-a", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: clip.id, startFrame: 0, durationFrames: 120,
      title: "Original title", sources: [], intent: "shortform", purpose: "Boundary fixture", evidenceRefs: ["fixture:grant"],
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: project.width, height: project.height, fps: project.fps },
    roles: [{ key: "title", kind: "graphic", id: graphic.id }], primaryBefore: { layout: null }, appliedScopeSha256: "a".repeat(64),
    dependencies: { recipeVersion: "fixture:structural-only", presetHashes: [], fonts: [] },
  };
  project.referenceMotionInstances = [instance];
  const batch: EditorCommand = { type: "batch", commands: [
    { type: "update_motion_graphic", graphicId: graphic.id, patch: { paintV1: { ...paint, fill: { kind: "solid", color: "#3344FFFF" } } } },
    { type: "rename_project", name: "Exact compiled batch" },
  ] };
  return { project, graphic, instance, batch };
}

describe("process-owned native paint reference revision proof", () => {
  it("binds the complete canonical project/batch and grants only actual updated reference targets", () => {
    const f = fixture(), before = structuredClone(f.project), commandsBefore = structuredClone(f.batch);
    const proof = issueNativePaintOwnerRevisionProof(f.project, f.batch, [f.instance.id]);
    const ids = verifyNativePaintOwnerRevisionProof(structuredClone(f.project), structuredClone(f.batch), proof);
    expect([...ids]).toEqual([f.graphic.id]); expect(ids.has("unrelated")).toBe(false);
    expect(Object.isFrozen(ids)).toBe(true); expect("add" in ids).toBe(false);
    expect(f.project).toEqual(before); expect(f.batch).toEqual(commandsBefore);
    expect(() => assertMotionPaintEditOwner(f.project, f.graphic)).toThrow(/owner-managed/);
  });

  it("rejects serialized, cloned, fabricated and caller-boolean authority", () => {
    const f = fixture(), proof = issueNativePaintOwnerRevisionProof(f.project, f.batch, [f.instance.id]);
    for (const fake of [undefined, true, {}, { allowed: true }, structuredClone(proof), JSON.parse(JSON.stringify(proof)), { ...proof }]) {
      expect(() => verifyNativePaintOwnerRevisionProof(f.project, f.batch, fake)).toThrow(/not issued/);
    }
  });

  it("rejects unrelated source drift, another project and changed instance generation", () => {
    const f = fixture(), proof = issueNativePaintOwnerRevisionProof(f.project, f.batch, [f.instance.id]);
    const mutations = [
      (project: typeof f.project) => { project.id += "-different"; },
      (project: typeof f.project) => { project.name += " changed"; },
      (project: typeof f.project) => { project.assets[0].uri += "-changed"; },
      (project: typeof f.project) => { project.referenceMotionInstances![0].instanceRevision++; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(f.project); mutate(changed);
      expect(() => verifyNativePaintOwnerRevisionProof(changed, f.batch, proof)).toThrow(/project or exact batch changed/);
    }
  });

  it("rejects edited, extended, reordered or narrowed batches rather than authorizing an ID alone", () => {
    const f = fixture(), proof = issueNativePaintOwnerRevisionProof(f.project, f.batch, [f.instance.id]);
    const revised = structuredClone(f.batch); if (revised.type !== "batch") throw new Error("fixture batch");
    revised.commands[0] = { type: "update_motion_graphic", graphicId: f.graphic.id, patch: { x: .25 } };
    const extended = structuredClone(f.batch); if (extended.type !== "batch") throw new Error("fixture batch");
    extended.commands.push({ type: "rename_project", name: "Unauthorized extra mutation" });
    const reordered = structuredClone(f.batch); if (reordered.type !== "batch") throw new Error("fixture batch");
    reordered.commands.reverse();
    const narrowed = structuredClone(f.batch); if (narrowed.type !== "batch") throw new Error("fixture batch");
    narrowed.commands.pop();
    for (const changed of [revised, extended, reordered, narrowed]) {
      expect(() => verifyNativePaintOwnerRevisionProof(f.project, changed, proof)).toThrow(/project or exact batch changed/);
    }
  });

  it("refuses unknown, duplicate or ungranted reference instance identities", () => {
    const f = fixture();
    expect(() => issueNativePaintOwnerRevisionProof(f.project, f.batch, ["missing"])).toThrow(/unique current instance/);
    expect(() => issueNativePaintOwnerRevisionProof(f.project, f.batch, [f.instance.id, f.instance.id])).toThrow(/duplicate/);
    expect(() => issueNativePaintOwnerRevisionProof(f.project, f.batch, [])).toThrow(/outside the compiled/);
  });

  it("preserves movie template/scene boundaries and refuses multiple reference owners", () => {
    const f = fixture(), template = structuredClone(f.project);
    template.motionGraphics[0].templateOwner = { schema: "editkin.template-element-owner/v1", sessionId: "movie-a",
      templateId: "movie-template", format: "short", role: "title" };
    expect(() => issueNativePaintOwnerRevisionProof(template, f.batch, [f.instance.id])).toThrow(/movie template or Motion scene/);
    const scene = structuredClone(f.project);
    // Ownership-only negative fixture: this is not a valid scene or product receipt.
    scene.motionScenes = [{ id: "scene-a", graphicIds: [f.graphic.id] }] as unknown as typeof scene.motionScenes;
    expect(() => issueNativePaintOwnerRevisionProof(scene, f.batch, [f.instance.id])).toThrow(/movie template or Motion scene/);
    const multiple = structuredClone(f.project);
    multiple.referenceMotionInstances!.push({ ...structuredClone(f.instance), id: "instance-b" });
    expect(() => issueNativePaintOwnerRevisionProof(multiple, f.batch, [f.instance.id])).toThrow(/single reference owner/);
    const newlyOwned = structuredClone(f.batch); if (newlyOwned.type !== "batch") throw new Error("fixture batch");
    if (newlyOwned.commands[0].type !== "update_motion_graphic") throw new Error("fixture update");
    newlyOwned.commands[0].patch.templateOwner = template.motionGraphics[0].templateOwner;
    expect(() => issueNativePaintOwnerRevisionProof(f.project, newlyOwned, [f.instance.id])).toThrow(/movie template or Motion scene/);
  });

  it("permits exact sequential metadata but refuses detach, stale revisions and role transfers", () => {
    const f = fixture(), next = { ...structuredClone(f.instance), instanceRevision: 2 };
    if (f.batch.type !== "batch") throw new Error("fixture batch");
    const final: EditorCommand = { type: "batch", commands: [...f.batch.commands,
      { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: 1 }] };
    const proof = issueNativePaintOwnerRevisionProof(f.project, final, [f.instance.id]);
    expect([...verifyNativePaintOwnerRevisionProof(f.project, final, proof)]).toEqual([f.graphic.id]);
    const detach: EditorCommand = { type: "batch", commands: [...f.batch.commands,
      { type: "remove_reference_motion_instance", id: f.instance.id, expectedInstanceRevision: 1 }] };
    expect(() => issueNativePaintOwnerRevisionProof(f.project, detach, [f.instance.id])).toThrow(/detach/);
    const stale: EditorCommand = { type: "batch", commands: [{ type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: 2 }] };
    expect(() => issueNativePaintOwnerRevisionProof(f.project, stale, [f.instance.id])).toThrow(/sequential/);
    const rebind = structuredClone(next); rebind.roles[0].id = "foreign-panel";
    const invalid: EditorCommand = { type: "batch", commands: [{ type: "upsert_reference_motion_instance", instance: rebind, expectedInstanceRevision: 1 }] };
    expect(() => issueNativePaintOwnerRevisionProof(f.project, invalid, [f.instance.id])).toThrow(/rebind/);
    const transfer = { ...structuredClone(next), id: "new-owner", instanceRevision: 1 };
    const extra: EditorCommand = { type: "batch", commands: [{ type: "upsert_reference_motion_instance", instance: transfer }] };
    expect(() => issueNativePaintOwnerRevisionProof(f.project, extra, [f.instance.id])).toThrow(/transfer or duplicate/);
  });
});

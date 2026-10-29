import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { applyCommand } from "./commands";
import { migrateProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommand, dispatchCommandSafely, redo, undo } from "./history";
import { editorCommandSchema, projectSchema } from "./schema";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "../application/projectCodec";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { createMotionGraphic } from "../motion/composition";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { assertReferenceMotionInstances, referenceMotionInstanceBytes, referenceMotionInstanceSchema,
  referenceMotionTemplateRevisionPatchSchema, type ReferenceMotionTemplateInstance } from "./referenceMotionInstance";
import type { EditProject } from "./types";

const digest = "a".repeat(64);
function instance(project: EditProject, id = "reference-1"): ReferenceMotionTemplateInstance {
  const clip = project.tracks[0].clips[0], font = bundledFontFaceSpec("EditkinFace-noto-sans-tc-700");
  // Structural persisted metadata fixture, not a prepared glyph or execution authority.
  return { schema: "editkin.reference-motion-instance/v1", id, authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: clip.id, startFrame: 0, durationFrames: 120,
      title: "Readable title", sources: [], intent: "shortform", purpose: "An original title", evidenceRefs: ["fixture:source-order"],
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: project.width, height: project.height, fps: project.fps },
    roles: [{ key: "source:0:clip", kind: "clip", id: clip.id, parentId: clip.trackId }],
    primaryBefore: { layout: clip.layout ? structuredClone(clip.layout) : null }, appliedScopeSha256: digest,
    dependencies: { recipeVersion: "fixture:physical-generation2", presetHashes: [{ presetId: "reel_spatial_headline", sha256: digest }],
      fonts: [{ schema: "editkin.motion-physical-layout/v1", faceId: font.faceId, fontSha256: font.sha256,
        manifestSha256: font.manifestSha256, parserVersion: "opentype.js@1.3.4" }] } };
}
function saved(project = createDemoProject()): EditProject { return applyCommand(project, { type: "upsert_reference_motion_instance", instance: instance(project) }); }

describe("Persisted Reference Motion instance domain", () => {
  it("keeps a legacy project schema9 and omits instance metadata through binary roundtrip", () => {
    const reopened = decodeProjectBytes(encodeProjectBytes(createDemoProject()));
    expect(reopened.schemaVersion).toBe(9);
    expect(reopened).not.toHaveProperty("referenceMotionInstances");
  });

  it("rejects raw instance metadata in every older project version rather than discarding it", () => {
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(() => migrateProject({ ...createDemoProject(), schemaVersion: version, referenceMotionInstances: [] })).toThrow(/schema 10/);
    }
    expect(() => projectSchema.parse({ ...createDemoProject(), referenceMotionInstances: [] })).toThrow();
  });

  it("preserves schema10 instance input roles and physical identity through actual project codec", () => {
    const project = saved(), reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(reopened.schemaVersion).toBe(10);
    expect(reopened.referenceMotionInstances).toEqual(project.referenceMotionInstances);
    expect(reopened.tracks).toEqual(project.tracks);
    expect(reopened.assets).toEqual(project.assets);
  });

  it("rejects root metadata hidden in a composition before migration or schema stripping", () => {
    const project = createDemoProject(), composition = { schema: "editkin.composition/v1", id: "nested", name: "Nested", width: project.width,
      height: project.height, fps: project.fps, duration: 12, tracks: project.tracks, captions: [], captionStyle: project.captionStyle,
      motionTracks: [], motionGraphics: [], director: project.director, updatedAt: project.updatedAt, referenceMotionInstances: [] };
    expect(() => migrateProject({ ...project, schemaVersion: 10, compositions: [composition] })).toThrow(/root project/);
    expect(() => projectSchema.parse({ ...project, schemaVersion: 10, compositions: [composition] })).toThrow();
  });

  it("promotes only the successful atomic create and Undo restores the exact schema9 graph", () => {
    const project = createDemoProject(), history = createHistory(project);
    const applied = dispatchCommand(history, { type: "batch", commands: [{ type: "rename_project", name: "New title" },
      { type: "upsert_reference_motion_instance", instance: instance(project) }] }, "instance-create");
    expect(applied.present.schemaVersion).toBe(10);
    expect(applied.past).toEqual([project]);
    expect(undo(applied).present).toEqual(project);
    expect(redo(undo(applied)).present).toEqual(applied.present);
    expect(project.schemaVersion).toBe(9);
  });

  it("rolls back all earlier batch mutations when create or a following command fails", () => {
    const project = createDemoProject(), before = structuredClone(project), history = createHistory(project);
    const result = dispatchCommandSafely(history, { type: "batch", commands: [
      { type: "upsert_reference_motion_instance", instance: instance(project) }, { type: "delete_motion_graphic", graphicId: "missing" }] });
    expect(result.error).toMatch(/missing/);
    expect(result.state).toBe(history);
    expect(project).toEqual(before);
    const invalid = instance(project); invalid.roles[0].id = "replaced"; invalid.input.clipId = "replaced";
    expect(() => applyCommand(project, { type: "upsert_reference_motion_instance", instance: invalid })).toThrow(/missing or replaced/);
    expect(project).toEqual(before);
  });

  it("requires an explicit current sequential revision and refuses duplicate creation", () => {
    const project = saved(), original = project.referenceMotionInstances![0], next = structuredClone(original);
    next.instanceRevision = 2; next.input.title = "Updated title";
    expect(() => applyCommand(project, { type: "upsert_reference_motion_instance", instance: original })).toThrow(/revision/);
    expect(() => applyCommand(project, { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: 2 })).toThrow(/revision/);
    expect(() => applyCommand(project, { type: "upsert_reference_motion_instance", instance: { ...next, instanceRevision: 3 }, expectedInstanceRevision: 1 })).toThrow(/revision/);
    const updated = applyCommand(project, { type: "upsert_reference_motion_instance", instance: next, expectedInstanceRevision: 1 });
    expect(updated.referenceMotionInstances![0]).toEqual(next);
    expect(project.referenceMotionInstances![0]).toEqual(original);
    next.input.title = "Caller mutated after apply";
    expect(updated.referenceMotionInstances![0].input.title).toBe("Updated title");
  });

  it("requires revision1 for a new identity even when the create expectation is explicit zero", () => {
    const project = createDemoProject(), value = instance(project);
    expect(applyCommand(project, { type: "upsert_reference_motion_instance", instance: value, expectedInstanceRevision: 0 }).schemaVersion).toBe(10);
    expect(() => applyCommand(project, { type: "upsert_reference_motion_instance", instance: { ...value, instanceRevision: 2 } })).toThrow(/starts at revision 1/);
    expect(() => applyCommand(project, { type: "upsert_reference_motion_instance", instance: value, expectedInstanceRevision: Number.NaN })).toThrow(/invalid/);
  });

  it("detaches at the current revision without restoring clips or downgrading schema10", () => {
    const project = saved(), changed = applyCommand(project, { type: "set_clip_volume", clipId: "clip-demo", volume: .35 });
    expect(() => applyCommand(changed, { type: "remove_reference_motion_instance", id: "reference-1", expectedInstanceRevision: 2 })).toThrow(/current instance revision/);
    const detached = applyCommand(changed, { type: "remove_reference_motion_instance", id: "reference-1", expectedInstanceRevision: 1 });
    expect(detached.referenceMotionInstances).toEqual([]);
    expect(detached.schemaVersion).toBe(10);
    expect(detached.tracks).toEqual(changed.tracks);
    expect(parseProject(detached).schemaVersion).toBe(10);
  });

  it("allows manually missing roles to save but blocks a new upsert onto missing graph targets", () => {
    const project = saved(), missing = applyCommand(project, { type: "delete_clip", clipId: "clip-demo" });
    expect(decodeProjectBytes(encodeProjectBytes(missing)).referenceMotionInstances).toEqual(project.referenceMotionInstances);
    const value = structuredClone(project.referenceMotionInstances![0]); value.instanceRevision = 2;
    expect(() => applyCommand(missing, { type: "upsert_reference_motion_instance", instance: value, expectedInstanceRevision: 1 })).toThrow(/missing or replaced/);
    expect(applyCommand(missing, { type: "remove_reference_motion_instance", id: value.id, expectedInstanceRevision: 1 }).schemaVersion).toBe(10);
  });

  it("rejects duplicate instance identities and cross-instance role ownership", () => {
    const project = saved(), value = project.referenceMotionInstances![0];
    expect(() => assertReferenceMotionInstances({ ...project, referenceMotionInstances: [value, structuredClone(value)] })).toThrow(/Duplicate/);
    expect(() => assertReferenceMotionInstances({ ...project, referenceMotionInstances: [value, { ...structuredClone(value), id: "another" }] })).toThrow(/more than one/);
  });

  it("keeps persisted metadata closed to outlines commands approval fields and extra font fields", () => {
    const value = instance(createDemoProject());
    expect(() => referenceMotionInstanceSchema.parse({ ...value, commands: [] })).toThrow();
    expect(() => referenceMotionInstanceSchema.parse({ ...value, certified: true })).toThrow();
    expect(() => referenceMotionInstanceSchema.parse({ ...value, dependencies: { ...value.dependencies, fonts: [{ ...value.dependencies.fonts[0], outlines: [] }] } })).toThrow();
    expect(() => referenceMotionInstanceSchema.parse({ ...value, input: { ...value.input, style: undefined } })).toThrow();
    expect(() => editorCommandSchema.parse({ type: "upsert_reference_motion_instance", instance: value, approval: true })).toThrow();
  });

  it("rejects duplicate semantic roles unsafe frame ranges and invalid child ownership", () => {
    const value = instance(createDemoProject());
    expect(() => referenceMotionInstanceSchema.parse({ ...value, roles: [...value.roles, { ...value.roles[0] }] })).toThrow(/unique/);
    expect(() => referenceMotionInstanceSchema.parse({ ...value, roles: [{ key: "mask", kind: "mask", id: "mask", parentId: "not-declared" }] })).toThrow(/declared clip/);
    expect(() => referenceMotionInstanceSchema.parse({ ...value, roles: [{ key: "graphic", kind: "graphic", id: "g", parentId: "p" }] })).toThrow(/no parent/);
    expect(() => referenceMotionInstanceSchema.parse({ ...value, input: { ...value.input, startFrame: Number.MAX_SAFE_INTEGER } })).toThrow(/unsafe/);
    expect(() => referenceMotionInstanceSchema.parse({ ...value, roles: [{ ...value.roles[0], id: "x".repeat(161) }] })).toThrow();
  });

  it("enforces role dependency and aggregate metadata limits including UTF8 byte counts", () => {
    const value = instance(createDemoProject());
    expect(() => referenceMotionInstanceSchema.parse({ ...value, roles: Array.from({ length: 129 }, (_, i) => ({ key: `g:${i}`, kind: "graphic", id: `g-${i}` })) })).toThrow();
    expect(() => referenceMotionInstanceSchema.parse({ ...value, dependencies: { ...value.dependencies, fonts: Array.from({ length: 17 }, (_, i) => ({ ...value.dependencies.fonts[0], faceId: `face-${i}` })) } })).toThrow();
    expect(() => referenceMotionInstanceSchema.parse({ ...value, dependencies: { ...value.dependencies, presetHashes: Array.from({ length: 33 }, (_, i) => ({ presetId: `p-${i}`, sha256: digest })) } })).toThrow();
    const huge = { ...value, roles: Array.from({ length: 128 }, (_, i) => ({ key: `${i}${"字".repeat(116)}`, kind: "clip" as const, id: `${i}${"字".repeat(155)}`, parentId: "字".repeat(160) })) };
    expect(referenceMotionInstanceBytes(huge)).toBeGreaterThan(128 * 1024);
    expect(() => referenceMotionInstanceSchema.parse(huge)).toThrow(/128KiB/);
    const project = createDemoProject(); project.schemaVersion = 10;
    project.referenceMotionInstances = Array.from({ length: 32 }, (_, i) => ({ ...structuredClone(value), id: `instance-${i}`,
      roles: Array.from({ length: 128 }, (_, r) => ({ key: `role:${r}${"字".repeat(85)}`, kind: "graphic" as const, id: `i${i}:g${r}${"字".repeat(105)}` })) }));
    expect(referenceMotionInstanceBytes(project.referenceMotionInstances)).toBeGreaterThan(1024 * 1024);
    expect(() => assertReferenceMotionInstances(project)).toThrow(/1MiB/);
    expect(() => assertReferenceMotionInstances({ ...project, referenceMotionInstances: Array.from({ length: 33 }, (_, i) => ({ ...value, id: `i-${i}` })) })).toThrow();
  });

  it("accepts explicit text font and palette patch leaves while rejecting source clocks or empty patches", () => {
    expect(referenceMotionTemplateRevisionPatchSchema.parse({ kicker: null, subtitle: "A longer readable detail", items: [{ label: "A" }, { label: "B", detail: null }],
      network: { labels: null }, style: { palette: { accent: "#123456" }, typography: { bodyFamily: "Noto Sans TC" } } })).toMatchObject({ kicker: null, network: { labels: null } });
    for (const patch of [{}, { style: {} }, { style: { palette: {} } }, { network: {} }, { sourceStart: 2 }, { durationFrames: 60 },
      { style: { animationSpeed: 2 } }, { network: { seed: 9 } }, { purpose: "Caller changed rationale" }]) {
      expect(() => referenceMotionTemplateRevisionPatchSchema.parse(patch)).toThrow();
    }
  });

  it("keeps changed environment metadata saveable but rejects upsert against a different frame format", () => {
    const project = saved(), changed = { ...project, width: 1280 };
    expect(validateProject(changed)).toBe(changed);
    expect(parseProject(changed).referenceMotionInstances![0].frameFormat.width).toBe(1920);
    const value = structuredClone(project.referenceMotionInstances![0]); value.instanceRevision = 2;
    expect(() => applyCommand(changed, { type: "upsert_reference_motion_instance", instance: value, expectedInstanceRevision: 1 })).toThrow(/frame format/);
  });

  it("reorders only selected graphic slots preserving every unrelated index content and Undo", () => {
    const project = createDemoProject();
    project.motionGraphics = ["outside-a", "field", "outside-b", "area", "outside-c", "title"].map((id, i) =>
      createMotionGraphic(id, "card", `Content ${i}`, 0, 3));
    const before = structuredClone(project), history = createHistory(project);
    const result = dispatchCommand(history, { type: "reorder_motion_graphics", graphicIds: ["area", "field", "title"] });
    expect(result.present.motionGraphics.map(graphic => graphic.id)).toEqual(["outside-a", "area", "outside-b", "field", "outside-c", "title"]);
    for (const index of [0, 2, 4]) expect(result.present.motionGraphics[index]).toEqual(before.motionGraphics[index]);
    for (const graphic of result.present.motionGraphics) expect(graphic).toEqual(before.motionGraphics.find(previous => previous.id === graphic.id));
    expect(project).toEqual(before);
    expect(undo(result).present).toEqual(project);
    expect(decodeProjectBytes(encodeProjectBytes(result.present)).motionGraphics).toEqual(JSON.parse(JSON.stringify(result.present.motionGraphics)));
  });

  it("rejects missing duplicate empty or over-budget reorder targets before committing any mutation", () => {
    const project = createDemoProject(); project.motionGraphics = [createMotionGraphic("field", "card", "Field", 0, 3), createMotionGraphic("area", "card", "Area", 0, 3)];
    const before = structuredClone(project), history = createHistory(project);
    for (const graphicIds of [["field", "missing"], ["field", "field"], [], Array.from({ length: 129 }, (_, i) => `graphic-${i}`)]) {
      const result = dispatchCommandSafely(history, { type: "batch", commands: [{ type: "rename_project", name: "Must roll back" },
        { type: "reorder_motion_graphics", graphicIds }] });
      expect(result.error).toMatch(/reorder/);
      expect(result.state).toBe(history);
      expect(project).toEqual(before);
    }
    expect(() => editorCommandSchema.parse({ type: "reorder_motion_graphics", graphicIds: ["field", "field"] })).toThrow(/unique/);
    expect(() => editorCommandSchema.parse({ type: "reorder_motion_graphics", graphicIds: ["field"], certified: true })).toThrow();
  });
});

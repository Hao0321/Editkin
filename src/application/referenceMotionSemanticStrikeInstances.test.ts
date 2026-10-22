import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE, REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT,
  referenceMotionTemplate, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { GRAPHIC_CADENCE_CONTRACT, compileGraphicCadence } from "../motion/graphicCadence";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { referenceMotionInstanceDraft, referenceMotionInstanceDraftPatch, referenceMotionInstanceEditorKey } from "../ui/SavedReferenceMotionInstances";
import { createProjectSession } from "./projectSession";
import { canonicalJson } from "../shared/canonicalJson";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { REFERENCE_MOTION_INSTANCE_RECIPE_VERSION } from "./referenceMotionTemplates";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Actual bundled bytes are prepared once per requested face. Synthetic source
// metadata is not an assertion that a video or a full template was rendered.
const faces = new Map<string, Uint8Array>();
async function prepareText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    if (faces.size >= 8) throw new Error("Unexpectedly many physical faces in the bounded semantic strike fixture");
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids() { let ordinal = 0; return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`; }
function fixture() {
  const project = createEmptyProject("Synthetic editable semantic replacement", { id: "semantic-saved-project", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source", kind: "video", name: "Synthetic original source metadata", uri: "D:/synthetic/semantic-strike.mp4",
    duration: 20, width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "primary", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0,
    sourceStart: 2, duration: 8, volume: .37, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  project.captions.push({ id: "unrelated-caption", text: "KEEP", start: 12, duration: 1 });
  const input: ReferenceMotionTemplateInput = { templateId: "strike_reframe", clipId: "primary", startFrame: 0, durationFrames: 240,
    title: "CLEAR", previousText: "SLOW", kicker: "MOTION", subtitle: "READ IT", sources: [], intent: "standalone_showcase",
    purpose: "Synthetic editable semantic replacement; no product art or media rights assertion", evidenceRefs: ["synthetic:semantic-strike"],
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" } } };
  return { project, input };
}
function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function sourceState(project: EditProject) {
  return { assets: structuredClone(project.assets), tracks: structuredClone(project.tracks), captions: structuredClone(project.captions),
    fps: project.fps, width: project.width, height: project.height };
}
async function saved(presentation?: "legacy_layout" | "semantic_replace_v1", cadence?: "legacy" | "brisk", mark?: string) {
  const f = fixture();
  if (presentation !== undefined) f.input.strikePresentation = presentation;
  if (cadence !== undefined) f.input.graphicCadence = cadence;
  if (mark !== undefined) f.input.brandMark = mark;
  const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText });
  return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
}

describe("opt-in semantic strike saved revision with actual physical glyphs", () => {
  it.each([undefined, "legacy", "brisk"] as const)("retains the old dependency and appearance for omitted/explicit legacy (%s)", async cadence => {
    const omitted = await saved(undefined, cadence), explicit = await saved("legacy_layout", cadence);
    const expected = cadence === "brisk"
      ? `editkin.reference-motion-recipes/brisk-v1:${hash({ recipe: referenceMotionTemplate("strike_reframe"), mediaPresentation: "legacy_layout", graphicCadence: GRAPHIC_CADENCE_CONTRACT })}`
      : `${REFERENCE_MOTION_INSTANCE_RECIPE_VERSION}:${hash(referenceMotionTemplate("strike_reframe"))}`;
    expect(omitted.packet.instance.dependencies.recipeVersion).toBe(expected);
    expect(explicit.packet.instance.dependencies.recipeVersion).toBe(expected);
    expect(omitted.packet.commands.filter(command => command.type !== "upsert_reference_motion_instance"))
      .toEqual(explicit.packet.commands.filter(command => command.type !== "upsert_reference_motion_instance"));
    expect(omitted.packet.instance.roles).toEqual(explicit.packet.instance.roles);
    expect(Object.hasOwn(omitted.packet.instance.input, "strikePresentation")).toBe(false);
    expect((await inspectReferenceMotionTemplateInstance(decodeProjectBytes(encodeProjectBytes(omitted.current)), omitted.packet.instance.id)).status).toBe("CURRENT");
  });

  it("binds the selected semantic contract and reopens the true wordmark/font/scope metadata", async () => {
    const f = await saved("semantic_replace_v1", "brisk", "EDITKIN");
    const { staggerFrames, ...profileFrames } = compileGraphicCadence(30, 1, "brisk");
    expect(f.packet.instance.dependencies.recipeVersion).toBe(`editkin.reference-motion-recipes/semantic-replace-v1:${hash({
      recipe: referenceMotionTemplate("strike_reframe"), strikePresentation: "semantic_replace_v1",
      semanticReplace: REFERENCE_MOTION_SEMANTIC_REPLACE_CONTRACT, graphicCadence: GRAPHIC_CADENCE_CONTRACT,
      profileFrames: { ...profileFrames, staggerFrames: [1, 2, 16, 128].map(count => ({ count, frames: staggerFrames(count) })) },
    })}`);
    const brand = f.packet.instance.roles.find(role => role.key === "brand-mark");
    expect(brand?.kind).toBe("graphic");
    const brandLayout = f.packet.layouts.find(layout => layout.graphicId === brand!.id);
    expect(brandLayout?.physicalFont).toBeDefined();
    expect(f.packet.instance.dependencies.fonts).toContainEqual(brandLayout!.physicalFont!);
    const reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(reopened.referenceMotionInstances?.[0].input.strikePresentation).toBe("semantic_replace_v1");
    expect(reopened.referenceMotionInstances?.[0].input.brandMark).toBe("EDITKIN");
    expect(reopened.referenceMotionInstances?.[0].roles).toEqual(f.packet.instance.roles);
    expect(sourceState(reopened)).toEqual(sourceState(decodeProjectBytes(encodeProjectBytes(f.project))));
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("revises text, physical font, brand and palette in one atomic Undo/Redo without touching source/audio clocks", async () => {
    const f = await saved("semantic_replace_v1", "brisk", "EDITKIN"), before = sourceState(f.current);
    const prepared = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, {
      previousText: "NOISE", title: "FOCUS", brandMark: "MY STUDIO", subtitle: "READ FIRST",
      style: { palette: { accent: "#0B3B95", surface: "#F5F7FB" }, typography: { headingFamily: "Noto Serif TC" } },
    }, { expectedInstanceRevision: 1, prepareText });
    expect(prepared.status).toBe("REVIEW_REQUIRED");
    for (const role of f.packet.instance.roles) expect(prepared.instance.roles.find(value => value.key === role.key)?.id).toBe(role.id);
    expect(prepared.instance.dependencies.recipeVersion).toBe(f.packet.instance.dependencies.recipeVersion);
    expect(prepared.instance.dependencies.fonts.some(face => face.faceId.includes("noto-serif"))).toBe(true);
    const allowed = new Set(["upsert_reference_motion_instance", "update_motion_graphic", "add_motion_graphic", "delete_motion_graphic", "reorder_motion_graphics"]);
    expect(prepared.commands.every(command => allowed.has(command.type))).toBe(true);
    const history = dispatchCommand(createHistory(f.current), { type: "batch", commands: prepared.commands });
    expect(history.past).toHaveLength(1); expect(sourceState(history.present)).toEqual(before);
    const reversed = undo(history);
    expect(reversed.present.referenceMotionInstances).toEqual(f.current.referenceMotionInstances);
    expect(reversed.present.motionGraphics).toEqual(f.current.motionGraphics);
    const repeated = redo(reversed);
    expect(repeated.present.referenceMotionInstances).toEqual(history.present.referenceMotionInstances);
    expect(sourceState(repeated.present)).toEqual(before);
    const reopened = decodeProjectBytes(encodeProjectBytes(repeated.present));
    expect(reopened.referenceMotionInstances?.[0].input.brandMark).toBe("MY STUDIO");
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("explicitly upgrades and restores the legacy presentation while retaining every original role ID", async () => {
    const f = await saved(undefined, "brisk"), before = sourceState(f.current);
    const upgraded = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id,
      { strikePresentation: "semantic_replace_v1", brandMark: "EDITKIN" }, { expectedInstanceRevision: 1, prepareText });
    for (const role of f.packet.instance.roles) expect(upgraded.instance.roles.find(value => value.key === role.key)?.id).toBe(role.id);
    const upgradedProject = applyCommand(f.current, { type: "batch", commands: upgraded.commands });
    const restored = await prepareReferenceMotionTemplateRevision(upgradedProject, f.packet.instance.id,
      { strikePresentation: "legacy_layout" }, { expectedInstanceRevision: 2, prepareText });
    for (const role of f.packet.instance.roles) expect(restored.instance.roles.find(value => value.key === role.key)?.id).toBe(role.id);
    expect(restored.instance.dependencies.recipeVersion).toBe(f.packet.instance.dependencies.recipeVersion);
    expect(Object.hasOwn(restored.instance.input, "brandMark")).toBe(false);
    const final = applyCommand(upgradedProject, { type: "batch", commands: restored.commands });
    expect(sourceState(final)).toEqual(before);
    expect((await inspectReferenceMotionTemplateInstance(decodeProjectBytes(encodeProjectBytes(final)), f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("clears only the optional brand graphic and keeps retained roles and semantic recipe identity", async () => {
    const f = await saved("semantic_replace_v1", "brisk", "EDITKIN"), brand = f.packet.instance.roles.find(role => role.key === "brand-mark")!;
    const prepared = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { brandMark: null }, { expectedInstanceRevision: 1, prepareText });
    expect(Object.hasOwn(prepared.instance.input, "brandMark")).toBe(false);
    expect(prepared.instance.roles.some(role => role.key === "brand-mark")).toBe(false);
    expect(prepared.commands).toContainEqual({ type: "delete_motion_graphic", graphicId: brand.id });
    for (const role of f.packet.instance.roles.filter(value => value.key !== "brand-mark")) {
      expect(prepared.instance.roles.find(value => value.key === role.key)?.id).toBe(role.id);
    }
    expect(prepared.instance.dependencies.recipeVersion).toBe(f.packet.instance.dependencies.recipeVersion);
    expect(sourceState(applyCommand(f.current, { type: "batch", commands: prepared.commands }))).toEqual(sourceState(f.current));
  });

  it("rejects wrong saved family, legacy brand and stale revision before requesting glyphs", async () => {
    const fixtureOther = fixture(); fixtureOther.input.templateId = "level_bridge";
    const packetOther = await prepareReferenceMotionTemplateInstance(fixtureOther.project, fixtureOther.input, ids(), { prepareText });
    const other = applyCommand(fixtureOther.project, { type: "batch", commands: packetOther.commands }), observed = vi.fn(prepareText);
    await expect(prepareReferenceMotionTemplateRevision(other, packetOther.instance.id,
      { strikePresentation: "semantic_replace_v1" }, { expectedInstanceRevision: 1, prepareText: observed })).rejects.toThrow(/saved strike template/);
    const old = await saved(undefined, "brisk");
    await expect(prepareReferenceMotionTemplateRevision(old.current, old.packet.instance.id,
      { brandMark: "NOT ENABLED" }, { expectedInstanceRevision: 1, prepareText: observed })).rejects.toThrow(/explicit semantic replacement/);
    await expect(prepareReferenceMotionTemplateRevision(old.current, old.packet.instance.id,
      { strikePresentation: "semantic_replace_v1" }, { expectedInstanceRevision: 2, prepareText: observed })).rejects.toThrow(/stale/);
    expect(observed).not.toHaveBeenCalled();
    expect(referenceMotionTemplateRevisionPatchSchema.safeParse({ brandMark: "ABCDEFGHIJKLMNOPQ" }).success).toBe(false);
    expect(referenceMotionTemplateRevisionPatchSchema.safeParse({ sourceStart: 0 }).success).toBe(false);
  });

  it("preserves historical omission in the saved UI draft and emits only deliberate opt-in or brand-clear changes", async () => {
    const old = await saved(undefined, "brisk"), draft = referenceMotionInstanceDraft(old.packet.instance);
    expect(draft.strikePresentation).toBe("legacy_layout");
    const ordinary = referenceMotionInstanceDraftPatch(old.packet.instance, { ...draft, title: "FOCUS" });
    expect(Object.hasOwn(ordinary, "strikePresentation")).toBe(false); expect(Object.hasOwn(ordinary, "brandMark")).toBe(false);
    const opted = referenceMotionInstanceDraftPatch(old.packet.instance, { ...draft, strikePresentation: "semantic_replace_v1", brandMark: "EDITKIN" });
    expect(opted.strikePresentation).toBe("semantic_replace_v1"); expect(opted.brandMark).toBe("EDITKIN");
    const semantic = await saved("semantic_replace_v1", "brisk", "EDITKIN"), semanticDraft = referenceMotionInstanceDraft(semantic.packet.instance);
    const cleared = referenceMotionInstanceDraftPatch(semantic.packet.instance, { ...semanticDraft, brandMark: "" });
    expect(cleared.brandMark).toBeNull(); expect(Object.hasOwn(cleared, "strikePresentation")).toBe(false);
    const reopened = decodeProjectBytes(encodeProjectBytes(semantic.current)), reopenedDraft = referenceMotionInstanceDraft(reopened.referenceMotionInstances![0]);
    expect(reopenedDraft.brandMark).toBe("EDITKIN"); expect(reopenedDraft.strikePresentation).toBe("semantic_replace_v1");
    const session = createProjectSession(semantic.current), beforeKey = referenceMotionInstanceEditorKey(session, semantic.packet.instance);
    session.replaceProject(reopened);
    expect(beforeKey).not.toBe(referenceMotionInstanceEditorKey(session, reopened.referenceMotionInstances![0]));
  });
});

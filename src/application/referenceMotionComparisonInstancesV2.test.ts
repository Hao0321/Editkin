import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  prepareReferenceMotionTemplateRevision, referenceMotionTemplateInstanceScopeSha256 } from "./referenceMotionTemplateInstances";

const faces = new Map<string, Uint8Array>();
async function prepareText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    if (faces.size >= 2) faces.delete(faces.keys().next().value!);
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids() { let ordinal = 0; return (prefix: string, key?: string) => `${prefix}-${key?.replaceAll(":", "-")}-${ordinal++}`; }
function fixture() {
  const project = createEmptyProject("Synthetic mixed-aspect comparison", { id: "soft-pair-project", width: 1080, height: 1920, fps: 30 });
  project.assets = [
    { id: "landscape", name: "Synthetic landscape metadata", uri: "D:/owned/soft-landscape.mp4", kind: "video", duration: 20,
      width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } },
    { id: "square", name: "Synthetic square metadata", uri: "D:/owned/soft-square.mp4", kind: "video", duration: 20,
      width: 480, height: 480, displayAspectRatio: 1, color: { interpretation: "rec709" } },
  ];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "landscape", timelineStart: 0,
    sourceStart: 2, duration: 12, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input: ReferenceMotionTemplateInput = { templateId: "comparison_pair", clipId: "primary", startFrame: 0, durationFrames: 360,
    title: "保留原片", primaryLabel: "原片", intent: "standalone_showcase", sources: [{ assetId: "square", sourceStart: 3, label: "對照" }],
    purpose: "Synthetic comparison source-clock and physical-glyph control; no artwork acceptance", evidenceRefs: ["synthetic:comparison-source-windows"],
    style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) };
  return { project, input };
}
async function saved(presentation?: "legacy_layout" | "source_soft_v2") {
  const f = fixture(); if (presentation) f.input.mediaPresentation = presentation;
  const before = canonicalJson(f.project), packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText });
  expect(canonicalJson(f.project)).toBe(before);
  return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
}
const allClips = (project: EditProject) => project.tracks.flatMap(track => track.clips);
const clocks = (project: EditProject) => allClips(project).map(clip => ({ id: clip.id, assetId: clip.assetId, trackId: clip.trackId,
  sourceStart: clip.sourceStart, timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume }));

describe("saved comparison source soft v2 instance binding", () => {
  it("defaults only new saved comparison to measured source contain frames with physical TC text", async () => {
    const f = await saved();
    expect(f.input.mediaPresentation).toBeUndefined(); expect(f.packet.instance.input.mediaPresentation).toBe("source_soft_v2");
    expect(f.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/comparison-soft-v2:/);
    expect(f.packet.status).toBe("REVIEW_REQUIRED"); expect(f.packet.instance.dependencies.fonts.every(font => font.faceId.includes("noto-"))).toBe(true);
    expect(f.packet.physicalLayoutBindings.length).toBeGreaterThan(0);
    expect(f.packet.layouts.filter(layout => layout.physicalFont).every(layout => layout.segments.every(segment => segment.outline?.svg && segment.outline.ass))).toBe(true);
    expect(f.packet.instance.roles.some(role => role.kind === "mask")).toBe(false);
    expect(f.packet.commands.some(command => command.type === "set_clip_layout" || command.type === "add_clip_mask")).toBe(false);
    const clips = allClips(f.current); expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(clip.layout).toBeUndefined(); expect(clip.masks?.filter(mask => mask.enabled) ?? []).toEqual([]);
      expect(clip.floatingFrame).toMatchObject({ schema: "editkin.floating-video-frame/v2", aspect: "source", mediaFit: "contain",
        style: "matte", yawDegrees: 0, pitchDegrees: 0, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 } });
    }
    expect(clocks(f.current)).toEqual([
      { id: "primary", assetId: "landscape", trackId: f.project.tracks[0].id, sourceStart: 2, timelineStart: 0, duration: 12, volume: .7 },
      { id: f.packet.instance.roles.find(role => role.key === "source:1:clip")!.id, assetId: "square",
        trackId: f.packet.instance.roles.find(role => role.key === "source:1:track")!.id, sourceStart: 3, timelineStart: 0, duration: 12, volume: 0 },
    ]);
  });
  it("persists exact soft frames scope and physical dependencies through actual file bytes", async () => {
    const f = await saved(), reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(reopened.referenceMotionInstances?.[0]).toEqual(f.packet.instance);
    expect(allClips(reopened)).toEqual(allClips(f.current));
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
    expect(await referenceMotionTemplateInstanceScopeSha256(reopened, f.packet.instance)).toBe(f.packet.instance.appliedScopeSha256);
  });
  it("keeps explicit legacy layout and original recipe identity on real byte reopen", async () => {
    const f = await saved("legacy_layout"), reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(f.packet.instance.input.mediaPresentation).toBe("legacy_layout");
    expect(f.packet.instance.dependencies.recipeVersion).toMatch(/^editkin\.reference-motion-recipes\/semantic-roles-v1:/);
    expect(f.packet.instance.roles.some(role => role.kind === "mask")).toBe(true);
    expect(allClips(reopened).every(clip => clip.floatingFrame === undefined && clip.layout !== undefined)).toBe(true);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });
  it("recompiles historical omitted presentation without migrating its legacy scope", async () => {
    const f = await saved("legacy_layout"), historical = structuredClone(f.current), instance = historical.referenceMotionInstances![0];
    // Reconstruct exactly the pre-field legacy metadata, using its same legacy graph and dependency contract.
    delete instance.input.mediaPresentation;
    instance.appliedScopeSha256 = await referenceMotionTemplateInstanceScopeSha256(historical, instance);
    const reopened = decodeProjectBytes(encodeProjectBytes(historical));
    expect((await inspectReferenceMotionTemplateInstance(reopened, instance.id)).status).toBe("CURRENT");
    const changed = await prepareReferenceMotionTemplateRevision(reopened, instance.id, { title: "看清原片" }, { expectedInstanceRevision: 1, prepareText });
    const final = applyCommand(reopened, { type: "batch", commands: changed.commands });
    expect(changed.instance.input.mediaPresentation).toBeUndefined(); expect(changed.instance.dependencies.recipeVersion).toBe(instance.dependencies.recipeVersion);
    expect(changed.commands.some(command => command.type === "set_clip_floating_frame")).toBe(false);
    expect(allClips(final).every(clip => clip.floatingFrame === undefined && clip.layout !== undefined)).toBe(true);
    expect((await inspectReferenceMotionTemplateInstance(final, instance.id)).status).toBe("CURRENT");
  });
  it("revises true text and palette while retaining soft geometry role IDs source clocks and edited primary gain", async () => {
    const f = await saved(); f.current.tracks[0].clips[0].volume = .31;
    const beforeClips = structuredClone(allClips(f.current)), beforeRoles = f.packet.instance.roles;
    const changed = await prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id,
      { title: "素材對照", style: { palette: { accent: "#0B3B95", surface: "#F7F9FF" } } }, { expectedInstanceRevision: 1, prepareText });
    const final = applyCommand(f.current, { type: "batch", commands: changed.commands });
    expect(changed.instance.instanceRevision).toBe(2); expect(changed.instance.input.mediaPresentation).toBe("source_soft_v2");
    expect(changed.instance.roles).toEqual(beforeRoles); expect(clocks(final)).toEqual(clocks(f.current));
    expect(allClips(final).map(clip => clip.floatingFrame)).toEqual(beforeClips.map(clip => clip.floatingFrame));
    expect(changed.commands.some(command => command.type === "set_clip_floating_frame")).toBe(false);
    expect(changed.commands.some(command => command.type === "update_motion_graphic" && command.patch.text === "素材對照")).toBe(true);
    expect(changed.physicalLayoutBindings.length).toBeGreaterThan(0);
    expect((await inspectReferenceMotionTemplateInstance(decodeProjectBytes(encodeProjectBytes(final)), f.packet.instance.id)).status).toBe("CURRENT");
  });
  it("commits source frames graphics and metadata in one Undo step with identical Redo identities", async () => {
    const f = await saved(), history = dispatchCommand(createHistory(f.project), { type: "batch", commands: f.packet.commands });
    expect(history.past).toHaveLength(1);
    const restored = undo(history); expect(allClips(restored.present)).toEqual(allClips(f.project));
    expect(restored.present.referenceMotionInstances).toBeUndefined(); expect(restored.present.motionGraphics).toEqual([]);
    const repeated = redo(restored); expect(allClips(repeated.present)).toEqual(allClips(history.present));
    expect(repeated.present.referenceMotionInstances).toEqual(history.present.referenceMotionInstances);
    expect((await inspectReferenceMotionTemplateInstance(repeated.present, f.packet.instance.id)).status).toBe("CURRENT");
  });
  it("rejects stale revision before physical preparation and leaves source frames untouched", async () => {
    const f = await saved(), provider = vi.fn(prepareText), before = canonicalJson(f.current);
    await expect(prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { title: "看清" },
      { expectedInstanceRevision: 2, prepareText: provider })).rejects.toThrow(/stale/);
    expect(provider).not.toHaveBeenCalled(); expect(canonicalJson(f.current)).toBe(before);
  });
  it("rejects manually changed owned soft frame instead of erasing it during scratch compile", async () => {
    const f = await saved(), clip = f.current.tracks[0].clips[0];
    if (!clip.floatingFrame) throw new Error("Control requires the actual soft frame");
    clip.floatingFrame.centerX = (clip.floatingFrame.centerX ?? .5) + .001;
    const before = canonicalJson(f.current), provider = vi.fn(prepareText);
    expect((await inspectReferenceMotionTemplateInstance(f.current, f.packet.instance.id)).status).toBe("EDITED");
    await expect(prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { title: "看清" },
      { expectedInstanceRevision: 1, prepareText: provider })).rejects.toThrow(/EDITED/);
    expect(provider).not.toHaveBeenCalled(); expect(canonicalJson(f.current)).toBe(before);
  });
  it("retains legacy unmanaged floating edits as drift instead of adopting soft ownership", async () => {
    const legacy = await saved("legacy_layout"), soft = await saved();
    legacy.current.tracks[0].clips[0].floatingFrame = structuredClone(soft.current.tracks[0].clips[0].floatingFrame);
    const before = canonicalJson(legacy.current);
    expect((await inspectReferenceMotionTemplateInstance(legacy.current, legacy.packet.instance.id)).status).toBe("EDITED");
    await expect(prepareReferenceMotionTemplateRevision(legacy.current, legacy.packet.instance.id, { title: "看清" },
      { expectedInstanceRevision: 1, prepareText })).rejects.toThrow(/EDITED/);
    expect(canonicalJson(legacy.current)).toBe(before);
  });
});

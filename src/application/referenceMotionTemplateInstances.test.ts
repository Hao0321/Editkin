import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { REFERENCE_MOTION_TEMPLATES, DEFAULT_REFERENCE_NETWORK_COLORS, type ReferenceMotionTemplateId,
  type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { normalizeReferenceMotionTemplateInput } from "./referenceMotionTemplates";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  inspectReferenceMotionTemplateInstance, referenceMotionTemplateInstanceScopeSha256,
  type ReferenceMotionTemplateRevisionPatch } from "./referenceMotionTemplateInstances";

const fontBytes = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  let bytes = fontBytes.get(faceId);
  if (!bytes) {
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    if (fontBytes.size >= 2) fontBytes.delete(fontBytes.keys().next().value!);
    fontBytes.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
const deps = () => ({ prepareText: physicalText });
function makeIds() { let next = 0; return (prefix: string, roleKey?: string) => `${prefix}-${roleKey?.replaceAll(":", "-")}-${next++}`; }
function fixture(templateId: ReferenceMotionTemplateId = "level_bridge") {
  const project = createEmptyProject("Saved original recipe", { id: "instance-project", width: 1080, height: 1920, fps: 30 });
  project.assets = Array.from({ length: 9 }, (_, index) => ({ id: `asset-${index}`, name: `Owned source ${index}`, kind: "video" as const,
    uri: `D:/owned/instance-source-${index}.mp4`, duration: 20, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" as const } }));
  project.tracks[0].clips = [{ id: "primary", assetId: "asset-0", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: 2, duration: 12, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input: ReferenceMotionTemplateInput = { templateId, clipId: "primary", startFrame: 0, durationFrames: 360,
    title: "FOCUS", previousText: "OLD", primaryLabel: "MAIN", purpose: "Keep declared sources readable and preserve their real clocks", evidenceRefs: ["owned:observed-source"],
    items: [{ label: "ONE", detail: "READ" }, { label: "TWO", detail: "KEEP" }, { label: "THREE", detail: "RETURN" }],
    sources: Array.from({ length: templateId === "comparison_pair" ? 1 : templateId === "focus_wall" ? 2 : 0 }, (_, index) => ({
      assetId: `asset-${index + 1}`, sourceStart: 3, label: `VIEW ${index + 1}` })),
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
  return { project, input };
}
async function saved(templateId: ReferenceMotionTemplateId = "level_bridge") {
  const { project, input } = fixture(templateId), packet = await prepareReferenceMotionTemplateInstance(project, input, makeIds(), deps());
  const current = applyCommand(project, { type: "batch", commands: packet.commands });
  return { project, input, packet, current };
}
function roleId(packet: Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>, key: string) {
  return packet.instance.roles.find(role => role.key === key)!.id;
}
afterEach(() => { vi.restoreAllMocks(); });

describe("saved reference template instances with actual semantic recompile", () => {
  it.each(REFERENCE_MOTION_TEMPLATES)("creates and reopens generation 2 instance for $id with actual TC font identities", async ({ id }) => {
    const { project, input } = fixture(id); input.style = undefined;
    input.title = "保留焦點"; input.previousText = "不要亂堆";
    input.items = [{ label: "素材", detail: "核對內容" }, { label: "焦點", detail: "保留閱讀" }, { label: "收束", detail: "回到原片" }];
    const before = canonicalJson(project), packet = await prepareReferenceMotionTemplateInstance(project, input, makeIds(), deps());
    expect(canonicalJson(project)).toBe(before); expect(packet.status).toBe("REVIEW_REQUIRED");
    expect(packet.commands.at(-1)?.type).toBe("upsert_reference_motion_instance");
    expect(packet.commands.some(command => command.type === "batch")).toBe(false);
    const current = applyCommand(project, { type: "batch", commands: packet.commands }), reopened = decodeProjectBytes(encodeProjectBytes(current));
    expect(project.schemaVersion).toBe(9); expect(reopened.schemaVersion).toBe(10);
    expect(reopened.referenceMotionInstances?.[0]).toEqual(packet.instance); expect(packet.instance.instanceRevision).toBe(1);
    expect(packet.instance.dependencies.fonts.length).toBeGreaterThan(0);
    expect(packet.instance.dependencies.fonts.every(font => font.faceId.includes("noto-"))).toBe(true);
    expect((await inspectReferenceMotionTemplateInstance(reopened, packet.instance.id)).status).toBe("CURRENT");
    expect(reopened.tracks[0].clips[0]).toMatchObject({ id: "primary", assetId: "asset-0", sourceStart: 2, timelineStart: 0, duration: 12, volume: .7 });
    expect(JSON.stringify(packet.instance)).not.toMatch(/pathCommands|outline|glyphs/);
  });
  it("upgrades schema and graph in one Undo step and restores identical IDs on Redo", async () => {
    const { project, input } = fixture(), packet = await prepareReferenceMotionTemplateInstance(project, input, makeIds(), deps());
    const applied = dispatchCommand(createHistory(project), { type: "batch", commands: packet.commands });
    expect(applied.past).toHaveLength(1); expect(applied.present.schemaVersion).toBe(10);
    const restored = undo(applied); expect(restored.present.schemaVersion).toBe(9); expect(restored.present.referenceMotionInstances).toBeUndefined();
    expect(restored.present.motionGraphics).toHaveLength(0); expect(redo(restored).present.referenceMotionInstances?.[0]).toEqual(packet.instance);
  });
  it("adds optional kicker without changing retained headline or panel IDs", async () => {
    const { current, packet } = await saved();
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { kicker: "OWNED" }, {
      ...deps(), expectedInstanceRevision: 1, idFactory: makeIds() });
    expect(changed.instance.roles.find(role => role.key === "headline")?.id).toBe(roleId(packet, "headline"));
    expect(changed.instance.roles.find(role => role.key === "panel")?.id).toBe(roleId(packet, "panel"));
    expect(changed.instance.roles.some(role => role.key === "kicker")).toBe(true); expect(changed.instance.instanceRevision).toBe(2);
    const applied = applyCommand(current, { type: "batch", commands: changed.commands });
    expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT");
  });
  it("clears optional subtitle with null and retains all other semantic IDs", async () => {
    const { project, input } = fixture(); input.subtitle = "READ";
    const packet = await prepareReferenceMotionTemplateInstance(project, input, makeIds(), deps()), current = applyCommand(project, { type: "batch", commands: packet.commands });
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { subtitle: null }, { ...deps(), expectedInstanceRevision: 1 });
    expect(changed.commands).toContainEqual({ type: "delete_motion_graphic", graphicId: roleId(packet, "subtitle") });
    expect(changed.instance.roles.find(role => role.key === "headline")?.id).toBe(roleId(packet, "headline"));
    expect(changed.instance.input.subtitle).toBeUndefined();
  });
  it("clears only one item detail and preserves every other indexed role", async () => {
    const { packet, current } = await saved("context_stack");
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { items: [
      { label: "ONE", detail: null }, { label: "TWO" }, { label: "THREE" },
    ] }, { ...deps(), expectedInstanceRevision: 1 });
    expect(changed.instance.input.items?.[1].detail).toBe("KEEP"); expect(changed.instance.input.items?.[0].detail).toBeUndefined();
    for (const role of packet.instance.roles.filter(role => role.key !== "item:0:detail")) expect(changed.instance.roles.find(value => value.key === role.key)?.id).toBe(role.id);
  });
  it("changes real physical font and rederives strike from the new TC ink", async () => {
    const { packet, current } = await saved("strike_reframe");
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { previousText: "保留焦點", title: "先看素材",
      style: { typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" } } }, { ...deps(), expectedInstanceRevision: 1 });
    const previous = changed.instance.roles.find(role => role.key === "previous")!, strike = changed.instance.roles.find(role => role.key === "strike")!;
    const applied = applyCommand(current, { type: "batch", commands: changed.commands });
    const layout = changed.layouts.find(layout => layout.graphicId === previous.id)!, graphic = applied.motionGraphics.find(graphic => graphic.id === strike.id)!;
    const left = Math.min(...layout.segments.map(segment => segment.x + segment.outline!.ink!.xMin));
    const right = Math.max(...layout.segments.map(segment => segment.x + segment.outline!.ink!.xMax));
    expect(graphic.x * current.width).toBeCloseTo(left, 8); expect(graphic.width * current.width).toBeCloseTo(right - left, 8);
    expect(layout.physicalFont?.faceId).toBe("EditkinFace-noto-sans-tc-700"); expect(strike.id).toBe(roleId(packet, "strike"));
  });
  it("changes palette while preserving source clocks audio and unrelated layers", async () => {
    const { packet, current } = await saved("comparison_pair");
    const sourceBefore = current.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, assetId: clip.assetId, sourceStart: clip.sourceStart, timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume }));
    current.captions.push({ id: "unrelated-caption", text: "KEEP", start: 15, duration: 1 });
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { style: { palette: { accent: "#0B3B95" } } }, { ...deps(), expectedInstanceRevision: 1 });
    const applied = applyCommand(current, { type: "batch", commands: changed.commands });
    expect(applied.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, assetId: clip.assetId, sourceStart: clip.sourceStart, timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume }))).toEqual(sourceBefore);
    expect(applied.captions).toEqual(current.captions); expect(changed.commands.filter(command => command.type === "update_motion_graphic").every(command => "schema" in command.patch)).toBe(true);
  });
  it("preserves current primary audio gain after ordinary user audio editing", async () => {
    const { packet, current } = await saved("comparison_pair"); current.tracks[0].clips[0].volume = .31;
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("CURRENT");
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { ...deps(), expectedInstanceRevision: 1 });
    expect(applyCommand(current, { type: "batch", commands: changed.commands }).tracks[0].clips[0].volume).toBe(.31);
  });
  it("retains keyframe phase IDs while reading text moves the actual focus handoff", async () => {
    const { packet, current } = await saved("evidence_takeover");
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ THE REAL SOURCE" }, { ...deps(), expectedInstanceRevision: 1 });
    for (const role of packet.instance.roles.filter(role => role.kind === "clip" || role.kind === "mask" || role.kind === "keyframe")) expect(changed.instance.roles.find(value => value.key === role.key)?.id).toBe(role.id);
    expect(changed.commands.some(command => command.type === "update_keyframe" && command.patch.time !== undefined)).toBe(true);
    expect(changed.phases.find(phase => phase.role === "focus")?.startFrame).toBeGreaterThan(packet.phases.find(phase => phase.role === "focus")!.startFrame);
  });
  it("freezes effective default network colors before normalized style is saved", async () => {
    const { project, input } = fixture("kinetic_network"); input.style = undefined;
    const normalized = normalizeReferenceMotionTemplateInput(input); expect(normalized.network?.groupColors).toEqual(DEFAULT_REFERENCE_NETWORK_COLORS);
    const packet = await prepareReferenceMotionTemplateInstance(project, input, makeIds(), deps()), current = applyCommand(project, { type: "batch", commands: packet.commands });
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: input.title }, { ...deps(), expectedInstanceRevision: 1 });
    expect(changed.status).toBe("UNCHANGED"); expect(changed.commands).toHaveLength(0);
  });
  it("inserts optional network areas behind retained field using actual owned draw order", async () => {
    const { packet, current } = await saved("kinetic_network");
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { network: { labels: ["ONE", "TWO", "THREE"] } }, {
      ...deps(), expectedInstanceRevision: 1, idFactory: makeIds() });
    expect(changed.commands.some(command => command.type === "reorder_motion_graphics")).toBe(true);
    const applied = applyCommand(current, { type: "batch", commands: changed.commands });
    const fieldId = roleId(packet, "network:field"), fieldIndex = applied.motionGraphics.findIndex(graphic => graphic.id === fieldId);
    for (const role of changed.instance.roles.filter(role => role.key.startsWith("network:area:"))) {
      expect(applied.motionGraphics.findIndex(graphic => graphic.id === role.id)).toBeLessThan(fieldIndex);
    }
    expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT");
  });
  it("detects manually changed owned draw order instead of claiming the same scope", async () => {
    const { packet, current } = await saved("kinetic_network"); current.motionGraphics.reverse();
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("EDITED");
  });
  it("returns UNCHANGED without increasing metadata revision or manufacturing an Undo entry", async () => {
    const { packet, current } = await saved(), before = canonicalJson(current);
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "FOCUS" }, { ...deps(), expectedInstanceRevision: 1 });
    expect(changed.status).toBe("UNCHANGED"); expect(changed.commands).toEqual([]); expect(changed.instance.instanceRevision).toBe(1);
    expect(canonicalJson(current)).toBe(before); expect(changed.sourceGeneration.projectSha256).toBe(createHash("sha256").update(before).digest("hex"));
  });
  it("normalizes empty optional copy to absence so explicit clearing is a genuine no-op", async () => {
    const { project, input } = fixture(); input.kicker = " "; input.subtitle = "";
    const packet = await prepareReferenceMotionTemplateInstance(project, input, makeIds(), deps()), current = applyCommand(project, { type: "batch", commands: packet.commands });
    expect(packet.instance.input.kicker).toBeUndefined(); expect(packet.instance.input.subtitle).toBeUndefined();
    const changed = await prepareReferenceMotionTemplateRevision(current, packet.instance.id, { kicker: null, subtitle: null }, { ...deps(), expectedInstanceRevision: 1 });
    expect(changed.status).toBe("UNCHANGED"); expect(changed.commands).toEqual([]);
  });
  it.each(["sources", "startFrame", "durationFrames", "templateId", "focusRegion", "animationSpeed"])("rejects unsupported $0 revision fields without font work", async key => {
    const { packet, current } = await saved(), prepareText = vi.fn(physicalText);
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { [key]: key === "sources" ? [] : 1 } as ReferenceMotionTemplateRevisionPatch,
      { prepareText, expectedInstanceRevision: 1 })).rejects.toThrow(); expect(prepareText).not.toHaveBeenCalled();
  });
  it("rejects item count changes rather than treating rows as interchangeable", async () => {
    const { packet, current } = await saved("context_stack");
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { items: [{ label: "ONE" }, { label: "TWO" }] }, { ...deps(), expectedInstanceRevision: 1 })).rejects.toThrow(/count/);
  });
  it("rejects a stale instance revision before requesting any glyphs", async () => {
    const { packet, current } = await saved(), prepareText = vi.fn(physicalText);
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { prepareText, expectedInstanceRevision: 9 })).rejects.toThrow(/stale/);
    expect(prepareText).not.toHaveBeenCalled();
  });
  it("blocks a manually edited graphic and preserves the actual edited graph", async () => {
    const { packet, current } = await saved(); current.motionGraphics.find(graphic => graphic.id === roleId(packet, "headline"))!.text = "USER EDIT";
    const before = canonicalJson(current); expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("EDITED");
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { ...deps(), expectedInstanceRevision: 1 })).rejects.toThrow(/EDITED/);
    expect(canonicalJson(current)).toBe(before);
  });
  it("reports a deleted semantic role as MISSING", async () => {
    const { packet, current } = await saved(); current.motionGraphics = current.motionGraphics.filter(graphic => graphic.id !== roleId(packet, "headline"));
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("MISSING");
  });
  it("rejects source window drift even when graphic contents were untouched", async () => {
    const { packet, current } = await saved(); current.tracks[0].clips[0].sourceStart += 1;
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("EDITED");
  });
  it("rejects an external clip added to a generated track without deleting it", async () => {
    const { packet, current } = await saved("comparison_pair"), trackId = packet.instance.roles.find(role => role.kind === "track")!.id;
    const track = current.tracks.find(track => track.id === trackId)!;
    track.clips.push({ ...structuredClone(track.clips[0]), id: "user-clip", timelineStart: 14, duration: 1 });
    const before = canonicalJson(current);
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { ...deps(), expectedInstanceRevision: 1 })).rejects.toThrow(/external clip/);
    expect(canonicalJson(current)).toBe(before);
  });
  it("blocks an external matte dependency on an owned generated clip", async () => {
    const { packet, current } = await saved("comparison_pair"), ownedClip = packet.instance.roles.find(role => role.kind === "clip" && role.id !== "primary")!;
    current.tracks[0].clips.push({ ...structuredClone(current.tracks[0].clips[0]), id: "dependent", timelineStart: 14, duration: 1,
      layer: { enabled: true, blendMode: "normal", trackMatte: { sourceClipId: ownedClip.id, mode: "alpha" } } });
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("EDITED");
  });
  it("blocks an unowned primary keyframe instead of erasing a manual animation", async () => {
    const { packet, current } = await saved("evidence_takeover"), clip = current.tracks[0].clips[0];
    clip.keyframes.push({ ...structuredClone(clip.keyframes[0]), id: "manual-key", time: 11 });
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("EDITED");
  });
  it("classifies changed canvas and physical dependency as ENVIRONMENT_CHANGED", async () => {
    const { packet, current } = await saved();
    const resized = structuredClone(current); resized.width += 2;
    expect((await inspectReferenceMotionTemplateInstance(resized, packet.instance.id)).status).toBe("ENVIRONMENT_CHANGED");
    current.referenceMotionInstances![0].dependencies.fonts[0].fontSha256 = "f".repeat(64);
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("ENVIRONMENT_CHANGED");
  });
  it("rejects a stale registered preset digest before compilation", async () => {
    const { packet, current } = await saved(); current.referenceMotionInstances![0].dependencies.presetHashes[0].sha256 = "f".repeat(64);
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("ENVIRONMENT_CHANGED");
  });
  it("rejects duplicate caller IDs without applying partial graphics", async () => {
    const { project, input } = fixture();
    await expect(prepareReferenceMotionTemplateInstance(project, input, () => "same-id", deps())).rejects.toThrow(/collides/);
    expect(project.schemaVersion).toBe(9); expect(project.motionGraphics).toHaveLength(0);
  });
  it("rejects copied JSON glyph provenance on a saved-instance revision", async () => {
    const { packet, current } = await saved();
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { expectedInstanceRevision: 1,
      prepareText: async (faceId, text) => structuredClone(await physicalText(faceId, text)) })).rejects.toThrow(/not made by this factory/);
  });
  it("rejects changed source generation during actual font preparation", async () => {
    const { packet, current } = await saved();
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { expectedInstanceRevision: 1,
      prepareText: async (faceId, text) => { const run = await physicalText(faceId, text); current.assets[0].uri = "D:/other.mp4"; return run; } })).rejects.toThrow(/source generation changed/);
  });
  it("honours already-cancelled revision without invoking the provider", async () => {
    const { packet, current } = await saved(), controller = new AbortController(), prepareText = vi.fn(physicalText); controller.abort();
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { expectedInstanceRevision: 1, prepareText, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(prepareText).not.toHaveBeenCalled();
  });
  it("preserves the original deadline after true glyph preparation and commits nothing", async () => {
    const { packet, current } = await saved(); let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, { title: "READ" }, { expectedInstanceRevision: 1,
      prepareText: async (faceId, text) => { const run = await physicalText(faceId, text); clock = 10_001; return run; } })).rejects.toThrow(/10-second deadline/);
    expect(current.referenceMotionInstances![0].instanceRevision).toBe(1);
  });
  it("checks exact scope hashing while ignoring save revision and updatedAt", async () => {
    const { packet, current } = await saved(); current.revision += 2; current.updatedAt = new Date(0).toISOString();
    expect(await referenceMotionTemplateInstanceScopeSha256(current, packet.instance)).toBe(packet.instance.appliedScopeSha256);
  });
});

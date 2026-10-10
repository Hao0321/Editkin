import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type MotionGraphic } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { buildReferenceMotionTemplateCommands } from "./referenceMotionTemplateCommands";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";

const bytes = new Map<string, Uint8Array>();
const dependencies = { prepareText: async (faceId: string, text: string) => {
  if (!bytes.has(faceId)) bytes.set(faceId, new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile))));
  return prepareGlyphRun(faceId, text, bytes.get(faceId)!);
} };
function fixture() {
  const project = createEmptyProject("Semantic strike", { id: "semantic-strike", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "owned", name: "Original atmosphere", kind: "video", uri: "D:/owned/atmosphere.mkv", duration: 12,
    width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "source", trackId: project.tracks[0].id, assetId: "owned", timelineStart: 0,
    sourceStart: 2, duration: 8, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const input: ReferenceMotionTemplateInput = { templateId: "strike_reframe", clipId: "source", startFrame: 0, durationFrames: 240,
    strikePresentation: "semantic_replace_v1", graphicCadence: "brisk", previousText: "動態太慢", title: "重點一到，畫面跟上",
    subtitle: "動作俐落，閱讀完整", kicker: "EDITKIN / MOTION", brandMark: "Editkin", purpose: "Original semantic handoff, not a platform performance claim",
    evidenceRefs: ["owned:original-atmosphere"], sources: [], style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE),
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" } } };
  let next = 0;
  return { project: parseProject(project), input, ids: (prefix: string, role?: string) => `${prefix}-${role ?? next++}` };
}
const byRole = (packet: Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>, role: string): MotionGraphic => {
  const id = packet.instance.roles.find(r => r.key === role)!.id;
  const command = packet.commands.find(c => c.type === "add_motion_graphic" && c.graphic.id === id);
  if (!command || command.type !== "add_motion_graphic") throw new Error(`Missing actual graphic command for role ${role}`);
  return command.graphic;
};

describe("semantic strike presentation with real physical glyphs", () => {
  it("uses one focus, readable old claim, complete annotation and exclusive handoff across all 240 frames", async () => {
    const { project, input, ids } = fixture(), before = structuredClone(project);
    const packet = await prepareReferenceMotionTemplateInstance(project, input, ids, dependencies);
    expect(project).toEqual(before);
    const old = byRole(packet, "previous"), main = byRole(packet, "headline"), rule = byRole(packet, "strike"), support = byRole(packet, "subtitle");
    expect([old.x, old.y, old.width]).toEqual([main.x, main.y, main.width]);
    expect(Math.round(main.timelineStart * 30)).toBe(Math.round((old.timelineStart + old.duration) * 30));
    const strikeStart = Math.round(rule.timelineStart * 30), oldEnd = Math.round(old.duration * 30);
    expect(strikeStart - old.motionV2!.entrance.durationFrames).toBeGreaterThanOrEqual(Math.ceil((.65 + [...old.text].length / 8) * 30));
    expect(oldEnd - old.motionV2!.exit.durationFrames - strikeStart).toBeGreaterThanOrEqual(rule.vectorV2!.revealFrames + Math.ceil(.3 * 30));
    expect(rule.vectorV2?.schema).toBe("editkin.motion-vector-annotation/v1");
    const oldLayout = packet.layouts.find(l => l.graphicId === old.id)!, mainLayout = packet.layouts.find(l => l.graphicId === main.id)!;
    const supportLayout = packet.layouts.find(l => l.graphicId === support.id)!;
    expect(supportLayout.box.y).toBeGreaterThanOrEqual(mainLayout.box.y + mainLayout.box.height + 27);
    expect(supportLayout.box.y + supportLayout.box.height).toBeLessThanOrEqual(.79 * 1920);
    expect(oldLayout.physicalFont).toBeDefined(); expect(mainLayout.physicalFont).toBeDefined();
    for (let frame = 0; frame < 240; frame++) {
      const a = motionGraphicV2FrameReceipt(project, old, frame, oldLayout), b = motionGraphicV2FrameReceipt(project, main, frame, mainLayout);
      expect(a.segments.some(s => s.opacity > .001) && b.segments.some(s => s.opacity > .001)).toBe(false);
    }
    const eyebrow = byRole(packet, "kicker"), layout = packet.layouts.find(l => l.graphicId === eyebrow.id)!;
    expect(motionGraphicV2FrameReceipt(project, eyebrow, 0, layout).segments.every(s => s.opacity === 1)).toBe(true);
    expect(motionGraphicV2FrameReceipt(project, eyebrow, 239, layout).segments.every(s => s.opacity === 1)).toBe(true);
    expect(motionGraphicV2FrameReceipt(project, main, 239, mainLayout).segments.every(s => s.opacity === 1)).toBe(true);
  });
  it("preserves source/audio clocks and exact new graphics through actual byte reopen", async () => {
    const { project, input, ids } = fixture(), original = structuredClone(project.tracks[0].clips[0]);
    const packet = await prepareReferenceMotionTemplateInstance(project, input, ids, dependencies);
    const applied = applyCommand(project, { type: "batch", commands: packet.commands });
    const reopened = decodeProjectBytes(encodeProjectBytes(applied));
    expect(reopened.tracks[0].clips[0]).toEqual(original);
    expect(reopened.motionGraphics).toEqual(applied.motionGraphics);
    expect(byRole(packet, "brand-mark").text).toBe("Editkin");
    expect(packet.commands.some(c => c.type === "set_clip_layout" || c.type === "set_clip_floating_frame" || c.type === "add_keyframe")).toBe(false);
  });
  it("rejects absent physical preparation and insufficient full reading holds instead of shortening footage", async () => {
    const { project, input, ids } = fixture();
    expect(() => buildReferenceMotionTemplateCommands(project, { ...input, graphicCadence: "legacy" }, ids)).toThrow(/physical layout/);
    const shortProject = structuredClone(project); shortProject.tracks[0].clips[0].duration = 4;
    await expect(prepareReferenceMotionTemplateInstance(shortProject, { ...input, durationFrames: 120, previousText: "這是一段需要完整閱讀停留的真實原句", title: "這是一個需要完整閱讀的新主張" }, ids, dependencies)).rejects.toThrow(/閱讀|沒有有效範圍|停留/);
    expect(project.motionGraphics).toHaveLength(0);
  });
  it("does not change historical omitted versus explicit legacy appearance", async () => {
    const { project, input } = fixture();
    const historical = { ...input }; delete historical.strikePresentation; delete historical.brandMark;
    const stable = () => { let n = 0; return (prefix: string) => `${prefix}-${n++}`; };
    const old = await prepareReferenceMotionTemplateInstance(project, historical, stable(), dependencies);
    const explicit = await prepareReferenceMotionTemplateInstance(project, { ...historical, strikePresentation: "legacy_layout" }, stable(), dependencies);
    expect(explicit.commands.filter(c => c.type !== "upsert_reference_motion_instance")).toEqual(old.commands.filter(c => c.type !== "upsert_reference_motion_instance"));
    expect(explicit.instance.dependencies).toEqual(old.instance.dependencies); expect(explicit.layouts).toEqual(old.layouts);
    expect(byRole(old, "strike").vectorV2?.schema).toBe("editkin.motion-vector/v1");
  });
});

import { describe, expect, it } from "vitest";
import { createEmptyProject, animatedClipState, validateProject, migrateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { projectSchema } from "../domain/schema";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { REFERENCE_MOTION_TEMPLATES, type ReferenceMotionTemplateInput, type ReferenceMotionTemplateId } from "../motion/referenceMotionTemplates";
import { buildReferenceMotionTemplateCommands, motionSourceLayout } from "./referenceMotionTemplateCommands";
import { prepareReferenceMotionTemplate } from "./referenceMotionTemplates";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";

export function motionTemplateFixture(): EditProject {
  const project = createEmptyProject("Original motion test", { id: "motion-template-test", width: 1080, height: 1920, fps: 30 });
  for (let index = 0; index < 9; index++) project.assets.push({ id: `source-${index}`, name: `Owned ${index}`, kind: "video", uri: `D:/owned/source-${index}.mp4`,
    duration: 12, width: 1080, height: 1920, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "main", assetId: "source-0", trackId: "video-main", timelineStart: 0, sourceStart: 1, duration: 8, volume: .7,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { enabled: true, blendMode: "normal", role: "content" } });
  return project;
}
function input(templateId: ReferenceMotionTemplateId): ReferenceMotionTemplateInput {
  return { templateId, clipId: "main", startFrame: 0, durationFrames: 240, title: "把細節放在主位", kicker: "EDITKIN", subtitle: "先看清楚，再往下走",
    previousText: "動態越多越好", items: [{ label: "素材", detail: "核對內容" }, { label: "焦點", detail: "保留閱讀" }, { label: "收束", detail: "回到原片" }],
    sources: Array.from({ length: templateId === "comparison_pair" ? 1 : templateId === "focus_wall" ? 5 : 0 }, (_, i) => ({ assetId: `source-${i + 1}`, sourceStart: 2, label: `視角 ${i + 2}` })),
    primaryLabel: "主要手勢", purpose: "核對素材的觀看順序", evidenceRefs: ["test:owned-source-observation"] };
}
function compile(project: EditProject, value: ReferenceMotionTemplateInput) { let counter = 0; return buildReferenceMotionTemplateCommands(project, value, prefix => `${prefix}-${counter++}`); }

describe("replaceable reference motion scenes", () => {
  it.each(REFERENCE_MOTION_TEMPLATES)("compiles, saves and reopens $id without changing source media clocks or original audio", ({ id }) => {
    const project = motionTemplateFixture(), before = structuredClone(project), packet = compile(project, input(id));
    expect(project).toEqual(before);
    const commandSnapshot = structuredClone(packet.commands);
    const applied = applyCommand(project, { type: "batch", commands: packet.commands });
    expect(packet.commands).toEqual(commandSnapshot);
    expect(() => applyCommand(project, { type: "batch", commands: packet.commands })).not.toThrow();
    const reopened = validateProject(migrateProject(projectSchema.parse(JSON.parse(JSON.stringify(applied)))));
    const main = reopened.tracks[0].clips[0];
    expect(main).toMatchObject({ sourceStart: 1, timelineStart: 0, duration: 8, volume: .7 });
    expect(reopened.tracks.flatMap(t => t.clips).filter(c => c.volume > 0)).toHaveLength(1);
    expect(reopened.motionGraphics.length).toBeGreaterThan(0);
    for (const graphic of reopened.motionGraphics) expect(motionGraphicV2LayoutReceipt(reopened, graphic)).toEqual(packet.layouts.find(r => r.graphicId === graphic.id));
    for (const hold of packet.phases.filter(p => p.role === "hold")) {
      for (const clip of reopened.tracks.flatMap(t => t.clips)) {
        const start = animatedClipState(clip, (hold.startFrame - input(id).startFrame) / project.fps).transform;
        for (let frame = hold.startFrame; frame < hold.endFrame; frame++) expect(animatedClipState(clip, frame / project.fps).transform).toEqual(start);
      }
    }
    expect(packet.status).toBe("REVIEW_REQUIRED");
    expect(packet.capabilityBoundary).toMatch(/not a sphere/);
  });
  it("keeps selected-source identity continuous through takeover and distinguishes a focus continuation from independent evidence", () => {
    const project = motionTemplateFixture();
    const takeover = compile(project, input("evidence_takeover"));
    expect(takeover.mediaBindings).toHaveLength(1);
    const applied = applyCommand(project, { type: "batch", commands: takeover.commands });
    const fullHold = takeover.phases.filter(p => p.role === "hold")[1];
    const transform = animatedClipState(applied.tracks[0].clips[0], fullHold.startFrame / 30).transform;
    const viewport = applied.tracks[0].clips[0].layout!.viewport;
    expect(viewport.width * transform.scale).toBeCloseTo(1);
    expect(viewport.height * transform.scale).toBeCloseTo(1);
    expect(viewport.y + viewport.height / 2 + transform.y / 1920).toBeCloseTo(.5);
    const wall = compile(project, input("focus_wall"));
    expect(wall.sourceCount).toBe(6);
    expect(wall.mediaBindings).toHaveLength(7);
    expect(wall.mediaBindings.at(-1)).toMatchObject({ assetId: "source-0", sourceStart: 1, role: "選中素材連續前景（不是新證據）" });
  });
  it("replacement changes actual compiled media and text; variants bind those exact graphic intervals", async () => {
    const project = motionTemplateFixture(), value = input("comparison_pair");
    value.sources = [{ assetId: "source-8", sourceStart: 3, label: "作品特寫" }]; value.title = "先看手勢";
    let counter = 0;
    const packet = await prepareReferenceMotionTemplate(project, value, p => `${p}-${counter++}`, {
      prepareText: async (faceId, text) => prepareGlyphRun(faceId, text,
        new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)))),
    });
    expect(packet.mediaBindings[1]).toMatchObject({ assetId: "source-8", sourceStart: 3 });
    expect(packet.editorialGraphics.find(g => g.message === "先看手勢")?.presetVariant?.overrides).toMatchObject({ textColor: "#172033" });
    for (const event of packet.editorialGraphics) {
      const graphic = packet.commands.flatMap(c => c.type === "add_motion_graphic" ? [c.graphic] : []).find(g => g.id === event.id)!;
      expect(event.range).toEqual({ startFrame: Math.round(graphic.timelineStart * 30), endFrame: Math.round((graphic.timelineStart + graphic.duration) * 30) });
      expect(event.presetVariant?.basePresetSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("preserves mixed source aspect ratios instead of stretching a landscape source into a portrait panel", () => {
    const project = motionTemplateFixture(), region = { x: .1, y: .3, width: .8, height: .4 };
    const asset = { width: 1920, height: 1080 };
    const layout = motionSourceLayout(project, asset, region);
    expect(layout.viewport.width * project.width / (layout.viewport.height * project.height)).toBeCloseTo(16 / 9);
    expect(layout.crop.width).toBe(1); expect(layout.crop.height).toBeCloseTo(.31640625);
    expect(layout.viewport.x).toBeGreaterThanOrEqual(region.x); expect(layout.viewport.y + layout.viewport.height).toBeLessThanOrEqual(.7);
  });
  it("rejects insufficient sources, file aliases, short source intervals, overlapping Motion and existing clip treatment", () => {
    const project = motionTemplateFixture();
    expect(() => compile(project, { ...input("comparison_pair"), sources: [] })).toThrow(/獨立素材槽/);
    project.assets[1].uri = "d:\\owned\\SOURCE-0.mp4";
    expect(() => compile(project, input("comparison_pair"))).toThrow(/別名/);
    project.assets[1].uri = "D:/owned/source-1.mp4";
    expect(() => compile(project, { ...input("comparison_pair"), sources: [{ assetId: "source-1", sourceStart: 8, label: "過短" }] })).toThrow(/足夠長度/);
    const applied = applyCommand(project, { type: "batch", commands: compile(project, input("level_bridge")).commands });
    expect(() => compile(applied, input("level_bridge"))).toThrow(/重複套用/);
    project.tracks[0].clips[0].transform.rotation = 3;
    expect(() => compile(project, input("evidence_takeover"))).toThrow(/乾淨片段/);
  });
  it("rejects unreadable timing and unverified fields, and does not apply a portrait board by default to long-form", () => {
    const project = motionTemplateFixture();
    project.tracks[0].clips[0].duration = 4;
    expect(() => compile(project, { ...input("strike_reframe"), durationFrames: 120, title: "這段文字需要更長停留時間才讓觀眾讀得完" })).toThrow(/閱讀停留/);
    expect(() => compile(project, { ...input("level_bridge"), durationFrames: 119 })).toThrow(/精確對應/);
    expect(() => compile(project, { ...input("level_bridge"), templateId: "sphere_overview" as ReferenceMotionTemplateId })).toThrow();
    project.width = 1920; project.height = 1080; project.tracks[0].clips[0].duration = 8;
    expect(() => compile(project, input("context_stack"))).toThrow(/長片保留/);
    expect(compile(project, { ...input("context_stack"), intent: "standalone_showcase" }).commands.length).toBeGreaterThan(0);
  });
  it("animation speed edits motion timing only, and rejects inaccessible palettes or missing physical fonts", () => {
    const project = motionTemplateFixture(), normal = compile(project, input("level_bridge"));
    const style = { palette: { surface: "#15242D", text: "#F7F8FA", accent: "#5BE0C1", muted: "#B5C4CC", separator: "#354A54" }, typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: .7 };
    const slower = compile(project, { ...input("level_bridge"), style });
    expect(slower.bindings.find(b => b.graphic.text === "把細節放在主位")!.graphic.motionV2!.entrance.durationFrames).toBeGreaterThan(normal.bindings.find(b => b.graphic.text === "把細節放在主位")!.graphic.motionV2!.entrance.durationFrames);
    expect(slower.sourceContinuity).toEqual(normal.sourceContinuity);
    expect(() => compile(project, { ...input("level_bridge"), style: { ...style, palette: { ...style.palette, text: "#15242D" } } })).toThrow(/對比不足/);
    expect(() => compile(project, { ...input("level_bridge"), style: { ...style, typography: { ...style.typography, headingFamily: "No Such Font" } } })).toThrow(/FONT_REQUIRED/);
  });
  it("fits the observed recap subject without stretching and rejects focus outside real source pixels", () => {
    const project = motionTemplateFixture(), region = { x: .1, y: .12, width: .8, height: .6 };
    const packet = compile(project, { ...input("brand_recap"), focusRegion: region });
    const layout = packet.mediaBindings[0].layout;
    expect(layout.crop).toEqual(region);
    expect(layout.viewport.width / layout.viewport.height).toBeCloseTo(region.width / region.height);
    expect(layout.viewport.y).toBeGreaterThanOrEqual(.215);
    expect(layout.viewport.y + layout.viewport.height).toBeLessThanOrEqual(.785);
    expect(() => compile(project, { ...input("brand_recap"), focusRegion: { ...region, x: .9 } })).toThrow();
    project.assets[0].width = 1920; project.assets[0].height = 1080;
    expect(() => compile(project, { ...input("brand_recap"), focusRegion: { x: 0, y: 0, width: 1, height: 1 } })).toThrow(/letterbox/);
  });
  it("connection story binds three editable semantic states and explicit diagram limits", () => {
    const project = motionTemplateFixture(), packet = compile(project, { ...input("kinetic_network"), network: { seed: 721, points: 48 } });
    expect(packet.bindings.find(b => b.graphic.vectorV2?.kind === "connection_field")?.graphic.vectorV2).toMatchObject({ seed: 721, points: 48 });
    expect(packet.illustration).toMatch(/does not represent actual members/);
    expect(packet.bindings.filter(b => ["素材", "焦點", "收束"].includes(b.graphic.text))).toHaveLength(3);
    expect(() => compile(project, { ...input("kinetic_network"), items: input("kinetic_network").items!.slice(0, 2) })).toThrow(/三幕/);
    expect(() => compile(project, { ...input("level_bridge"), network: { seed: 1, points: 32 } })).toThrow(/只適用/);
  });
  it.each([[1080, 1920], [540, 960], [1920, 1080], [1280, 720]])("keeps connection headlines and details apart at %d × %d", (width, height) => {
    const project = motionTemplateFixture(); project.width = width; project.height = height;
    const value = { ...input("kinetic_network"), intent: "standalone_showcase" as const,
      items: [{ label: "每個人都行", detail: "每個人都有專長" }, { label: "找到彼此", detail: "讓能力找到夥伴" }, { label: "一起創造", detail: "一起做出作品" }] };
    const packet = compile(project, value), field = packet.bindings.find(b => b.graphic.vectorV2?.kind === "connection_field")!.graphic;
    for (const item of value.items) {
      const box = (text: string) => packet.layouts.find(r => r.graphicId === packet.bindings.find(b => b.graphic.text === text)!.graphic.id)!.box;
      const headline = box(item.label), detail = box(item.detail);
      expect(headline.y + headline.height + 6 * Math.min(width, height) / 1080).toBeLessThanOrEqual(detail.y);
      expect(detail.y + detail.height).toBeLessThan(field.y * height);
    }
  });
});

import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { projectSchema } from "../domain/schema";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";
import { prepareNativeReelScene } from "./nativeReelScenes";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { parseAutopilotPlan } from "./autopilotPlan";
import { motionGraphicV2LayoutReceipt, motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { writeAssContent } from "../render/captionAss";
import { floatingFrameCssMatrix, floatingFrameGeometry } from "../motion/floatingVideoFrame";

function fixture() {
  const project = createEmptyProject("Original scene", { width: 1080, height: 1920, fps: 30 });
  project.assets = [0, 1, 2].map(i => ({ id: `owned-${i}`, name: `Original ${i}`, uri: `owned-${i}.mp4`, kind: "video" as const, duration: 4, width: 1080, height: 1920 }));
  project.tracks[0].clips = [{ id: "main", assetId: "owned-0", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0, duration: 3, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  return validateProject(project);
}
const input = { templateId: "editorial_steps" as const, startFrame: 0, durationFrames: 90, title: "先看素材", body: "一幕只講一個重點", progress: { steps: 6, activeStep: 2 }, evidenceRefs: ["brief:user-provided-original-copy"] };
function compile() { let i = 0; return prepareNativeReelScene(fixture(), input, prefix => `${prefix}-${i++}`); }

describe("native original reel scene compilation", () => {
  it("preserves editable geometry through commands and reopen, with exact v4 seed variants", () => {
    const source = fixture(), untouched = structuredClone(source), scene = compile();
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(source, { type: "batch", commands: scene.commands }))));
    expect(reopened.motionGraphics.filter(g => g.vectorV2)).toHaveLength(5);
    scene.editorialGraphics.forEach(event => {
      const graphic = reopened.motionGraphics.find(g => g.id === event.id)!;
      expect(event.message).toBe(graphic.text);
      if (event.presetVariant) expect(() => assertMotionPresetVariantBinding(graphic, event.presetId, event.presetVariant!)).not.toThrow();
    });
    expect(source).toEqual(untouched);
  });
  it("binds native_shape to vector commands in v4 and rejects an empty typography event", () => {
    const scene = compile(), fixturePlan = createAutopilotV4Fixture();
    const plan = { ...fixturePlan, editorial: { ...fixturePlan.editorial, graphics: scene.editorialGraphics }, commands: [...fixturePlan.commands, ...scene.commands] };
    expect(() => parseAutopilotPlan(plan)).not.toThrow();
    plan.editorial.graphics[0].kind = "context_card";
    expect(() => parseAutopilotPlan(plan)).toThrow();
  });
  it("is seek-independent, invalidates changed geometry receipts and exports real paths instead of placeholder glyphs", () => {
    const project = applyCommand(fixture(), { type: "batch", commands: compile().commands });
    const progress = project.motionGraphics.find(g => g.vectorV2?.kind === "step_progress")!;
    const layout = motionGraphicV2LayoutReceipt(project, progress);
    const sample = (f: number) => motionVectorPaths(progress, layout, motionGraphicV2FrameReceipt(project, progress, f, layout));
    expect(sample(17)).toEqual(sample(17));
    expect(sample(0)).toEqual([]);
    expect(sample(17).length).toBe(2);
    expect(sample(17)).not.toEqual(sample(4));
    expect(sample(90)).toEqual([]);
    const changed = { ...progress, vectorV2: { ...progress.vectorV2!, heightPixels: 20 } };
    expect(() => motionGraphicV2FrameReceipt(project, changed, 17, layout)).toThrow(/receipt/);
    const ass = writeAssContent(project, project.captionStyle);
    expect(ass).toContain("\\p1");
    expect(ass).toContain("先看素材");
    expect(ass).not.toContain("●");
  });
  it("blocks invalid progress, oversized grids and v1 payloads before rendering", () => {
    expect(() => prepareNativeReelScene(fixture(), { ...input, progress: { steps: 2, activeStep: 3 } }, p => p)).toThrow(/章節/);
    const project = applyCommand(fixture(), { type: "batch", commands: compile().commands });
    const dots = project.motionGraphics.find(g => g.vectorV2?.kind === "dot_grid")!;
    expect(() => motionGraphicV2LayoutReceipt(project, { ...dots, vectorV2: { ...dots.vectorV2!, kind: "dot_grid", spacingPixels: 8, dotRadiusPixels: 1 } })).toThrow(/512/);
    expect(() => applyCommand(project, { type: "update_motion_graphic", graphicId: dots.id, patch: { text: "假文字" } })).toThrow(/空文字/);
    expect(() => projectSchema.parse({ ...project, motionGraphics: [{ ...dots, schema: "hao.motion-composition/v1", motionV2: undefined, layoutV2: undefined }] })).toThrow();
  });
  it("uses three independent clips and preserves exactly one audio source", () => {
    const project = fixture(); let i = 0;
    const sources = { rearRight: { assetId: "owned-1", sourceStart: .5 }, front: { assetId: "owned-2", sourceStart: 1 } };
    const scene = prepareNativeReelScene(project, { ...input, templateId: "spatial_gallery", clipId: "main", sources }, p => `${p}-${i++}`);
    const applied = applyCommand(project, { type: "batch", commands: scene.commands });
    const clips = applied.tracks.flatMap(t => t.clips);
    expect(new Set(clips.map(c => c.assetId)).size).toBe(3);
    expect(clips.filter(c => c.volume > 0)).toHaveLength(1);
    expect(clips.find(c => c.assetId === "owned-2")?.sourceStart).toBe(1);
    expect(() => prepareNativeReelScene(project, { ...input, templateId: "spatial_gallery", clipId: "main", sources: { ...sources, front: sources.rearRight } }, p => p)).toThrow(/三個不同/);
    expect(() => prepareNativeReelScene(project, { ...input, templateId: "spatial_gallery", clipId: "main", sources: { ...sources, front: { ...sources.front, sourceStart: 2 } } }, p => p)).toThrow(/足夠有效/);
  });
  it("keeps the title clear of all three moving video planes for the full section", () => {
    const project = fixture(); let i = 0;
    const scene = prepareNativeReelScene(project, { ...input, templateId: "spatial_gallery", clipId: "main",
      sources: { rearRight: { assetId: "owned-1", sourceStart: 0 }, front: { assetId: "owned-2", sourceStart: 0 } } }, p => `${p}-${i++}`);
    const applied = applyCommand(project, { type: "batch", commands: scene.commands });
    const title = motionGraphicV2LayoutReceipt(applied, applied.motionGraphics[0]);
    const keepoutBottom = title.box.y + title.box.height + 16 + 24;
    for (let f = 0; f < 90; f++) for (const clip of applied.tracks.flatMap(t => t.clips)) {
      const g = floatingFrameGeometry(clip.floatingFrame!, 1080, 1920, f / 30);
      const m = floatingFrameCssMatrix(g.quad, 1080, 1920).slice(9, -1).split(",").map(Number);
      const corners = [[g.left, g.top], [g.left + g.outerWidth, g.top], [g.left, g.top + g.outerHeight], [g.left + g.outerWidth, g.top + g.outerHeight]];
      const top = Math.min(...corners.map(([x, y]) => (m[1] * x + m[5] * y + m[13]) / (m[3] * x + m[7] * y + m[15])));
      expect(top, `${clip.id} frame ${f}`).toBeGreaterThan(keepoutBottom);
    }
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { encodeProjectBytes, decodeProjectBytes } from "./projectCodec";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  inspectReferenceMotionTemplateInstance, referenceMotionTemplateRevisionCommandContext } from "./referenceMotionTemplateInstances";
import { referenceMotionTemplateInputSchema, DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { prepareMotionNativePaintForRender } from "../render/motionPhysicalGlyphLayouts";
import { nativeMotionPaintTrack } from "../motion/nativeMotionPaint";

function fixture() {
  const project = createEmptyProject("Native layer hierarchy", { width: 1080, height: 1920, fps: 30 });
  project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  project.assets = [{ id: "source", kind: "video", name: "Fixture, not a rights claim", uri: "D:/fixture.mp4", duration: 12,
    width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "clip", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0,
    sourceStart: 1, duration: 10, volume: .6, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    expressions: {}, layer: { enabled: true, blendMode: "normal", role: "content" } }];
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "clip", startFrame: 0, durationFrames: 300,
    title: "CLEAR VIEW", kicker: "EDITKIN", subtitle: "KEEP THE MOMENT", sources: [], graphicCadence: "brisk",
    graphicPresentation: "native_paint_v1", intent: "shortform", purpose: "Verified source with stable, readable hierarchy",
    evidenceRefs: ["fixture:explicit-template-only"], style: { ...DEFAULT_REFERENCE_MOTION_STYLE,
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  return { project, input };
}
function ids() { let i = 0; return (prefix: string) => `${prefix}-${i++}`; }
const deps = { prepareText: async (faceId: string, text: string) => prepareGlyphRun(faceId, text,
  new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)))) };

describe("saved native paint level bridge, with actual font bytes", () => {
  it("keeps source clocks and physical text through create, save/reopen and palette/text revision", async () => {
    const { project, input } = fixture(), before = JSON.stringify(project);
    const prepared = await prepareReferenceMotionTemplateInstance(project, input, ids(), deps);
    expect(JSON.stringify(project)).toBe(before);
    const current = applyCommand(project, { type: "batch", commands: prepared.commands });
    const reopened = decodeProjectBytes(encodeProjectBytes(current));
    expect(reopened.motionGraphics).toHaveLength(4);
    expect(reopened.motionGraphics.every(g => g.paintV1 && g.visualStyle === "native_paint")).toBe(true);
    expect(reopened.tracks[0].clips).toEqual(project.tracks[0].clips);
    expect(prepared.instance.dependencies.recipeVersion).toContain("native-paint-v1");
    expect((await inspectReferenceMotionTemplateInstance(reopened, prepared.instance.id)).status).toBe("CURRENT");
    const native = await prepareMotionNativePaintForRender(reopened, resolve("public/fonts"));
    for (const g of reopened.motionGraphics) {
      const track = nativeMotionPaintTrack(reopened, native, g.id);
      expect(track.frames).toHaveLength(Math.round(g.duration * reopened.fps));
      expect(track.scene.max_scale).toBe(1);
    }
    const patch = { title: "NEW VIEW", style: { palette: { ...input.style!.palette, text: "#20283A" } } };
    const revision = await prepareReferenceMotionTemplateRevision(reopened, prepared.instance.id, patch,
      { ...deps, expectedInstanceRevision: 1, idFactory: ids() });
    const command = { type: "batch" as const, commands: revision.commands };
    expect(() => applyCommand(reopened, command)).toThrow(/owner-managed/);
    expect(() => applyCommand(reopened, command, { nativePaintOwnerRevisionProof: {} })).toThrow();
    const changed = applyCommand(reopened, command, referenceMotionTemplateRevisionCommandContext(revision));
    expect(changed.motionGraphics.find(g => g.text === "NEW VIEW")?.paintV1?.fill).toEqual({ kind: "solid", color: "#20283A" });
    expect(changed.tracks[0].clips).toEqual(project.tracks[0].clips);
    expect((await inspectReferenceMotionTemplateInstance(changed, prepared.instance.id)).status).toBe("CURRENT");
  });

  it("preserves historical templates and stops unsupported output, family or excessive project graphics", async () => {
    const { project, input } = fixture();
    const legacy = structuredClone(input); delete legacy.graphicPresentation;
    project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT };
    const old = await prepareReferenceMotionTemplateInstance(project, legacy, ids(), deps);
    expect(old.commands.filter(c => c.type === "add_motion_graphic").every(c => c.type === "add_motion_graphic" && !c.graphic.paintV1)).toBe(true);
    expect(old.instance.dependencies.recipeVersion).not.toContain("native-paint");
    await expect(prepareReferenceMotionTemplateInstance(project, input, ids(), deps)).rejects.toThrow(/ACES2/);
    project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2", outputTransform: "rec2100_hlg_1000" };
    await expect(prepareReferenceMotionTemplateInstance(project, input, ids(), deps)).rejects.toThrow(/rec709_sdr/);
    expect(() => referenceMotionTemplateInputSchema.parse({ ...input, templateId: "evidence_takeover" })).toThrow(/level_bridge/);
    const { project: accepted } = fixture();
    const prepared = await prepareReferenceMotionTemplateInstance(accepted, input, ids(), deps);
    accepted.motionGraphics = prepared.commands.flatMap(c => c.type === "add_motion_graphic" ? [{ ...c.graphic, id: "existing-outside", timelineStart: 11 }] : []).slice(0, 1);
    await expect(prepareReferenceMotionTemplateInstance(accepted, input, ids(), deps)).rejects.toThrow(/four-graphic/);
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_SCENE_25D, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { motionPaintDescriptorSchema, motionPaintV1Schema, motionPaintV2Schema, type MotionPaintV1 } from "../domain/motionPaint";
import { editorCommandSchema, motionPresetOverridesSchema } from "../domain/schema";
import { referenceMotionTemplateRevisionPatchSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE, referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { nativeMotionPaintFrame, nativeMotionPaintTrack, prepareNativeMotionPaint } from "../motion/nativeMotionPaint";
import { prepareMotionNativePaintForRender } from "../render/motionPhysicalGlyphLayouts";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { canonicalJson } from "../shared/canonicalJson";
import { encodeProjectBytes, decodeProjectBytes } from "./projectCodec";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  inspectReferenceMotionTemplateInstance, referenceMotionTemplateRevisionCommandContext } from "./referenceMotionTemplateInstances";
import type { ReferenceMotionPlan } from "./referenceMotionPlan";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import { prepareOriginalMotionScene2d } from "./originalMotionScene2d";

const fontRoot = resolve("public/fonts");
const deps = { prepareText: async (faceId: string, text: string) => prepareGlyphRun(faceId, text,
  new Uint8Array(await readFile(resolve(fontRoot, bundledFontFaceSpec(faceId).fontFile)))) };
const env = { ...process.env, EDITKIN_FONT_ROOT: fontRoot };
function ids() { let next = 0; return (prefix: string) => `${prefix}-display-${++next}`; }
function fixture(presentation: "native_paint_v1" | "native_paint_display_v2" = "native_paint_display_v2") {
  const project = createEmptyProject("Display intent ownership control", { width: 1080, height: 1920, fps: 30 });
  project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  project.assets = [{ id: "source", kind: "video", name: "Synthetic source, no rights claim", uri: "D:/fixture-display.mp4", duration: 12,
    width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "clip", assetId: "source", trackId: project.tracks[0].id, timelineStart: 0,
    sourceStart: 1, duration: 10, volume: .6, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    expressions: {}, layer: { enabled: true, blendMode: "normal", role: "content" } }];
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "clip", startFrame: 0, durationFrames: 300,
    title: "CLEAR VIEW", kicker: "EDITKIN", sources: [], graphicCadence: "brisk", graphicPresentation: presentation,
    intent: "shortform", purpose: "Explicit display artwork ownership control", evidenceRefs: ["synthetic:display-intent"],
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  return { project, input };
}
async function created(presentation?: "native_paint_v1" | "native_paint_display_v2") {
  const f = fixture(presentation), idFactory = ids();
  const prepared = await prepareReferenceMotionTemplateInstance(f.project, f.input, idFactory, deps);
  const current = applyCommand(f.project, { type: "batch", commands: prepared.commands });
  return { ...f, idFactory, prepared, current };
}
const legacyPaint: MotionPaintV1 = { schema: "editkin.motion-paint/v1", fill: { kind: "solid", color: "#FFFFFFF2" }, clips: [],
  stroke: { color: "#D8DEE860", widthPixels: 1 }, shadow: { color: "#09284930", offsetXPixels: 0, offsetYPixels: 4, blurPixels: 8 } };

describe("explicit display-referred native paint authoring", () => {
  it("retains exact V1 descriptor bytes and admits only versioned, required display intent", () => {
    expect(motionPaintDescriptorSchema.parse(legacyPaint)).toEqual(legacyPaint);
    expect(motionPaintV1Schema.parse(legacyPaint)).not.toHaveProperty("colorIntent");
    const display = { ...legacyPaint, schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr" };
    expect(motionPaintV2Schema.parse(display)).toEqual(display);
    expect(motionPresetOverridesSchema.parse({ visualStyle: "native_paint", paintV1: display }).paintV1).toEqual(display);
    for (const invalid of [
      { ...legacyPaint, colorIntent: "display_rec709_sdr" },
      { ...legacyPaint, schema: "editkin.motion-paint/v2" },
      { ...display, colorIntent: "scene_linear_rec709" },
      { ...display, colorIntent: "display_pq" },
      { ...display, transfer: "skip_aces" },
    ]) expect(motionPaintDescriptorSchema.safeParse(invalid).success).toBe(false);
  });

  it("saves true physical display glyphs and unmodified alpha into separately versioned native tracks", async () => {
    const f = await created(), reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(reopened.tracks).toEqual(f.project.tracks);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.prepared.instance.id)).status).toBe("CURRENT");
    expect(f.prepared.instance.dependencies.recipeVersion).toContain("/display-paint-v2:");
    const native = await prepareMotionNativePaintForRender(reopened, fontRoot);
    for (const graphic of reopened.motionGraphics) {
      const track = nativeMotionPaintTrack(reopened, native, graphic.id);
      expect(track).toMatchObject({ schema: "editkin.native-motion-paint-track/v2", colorIntent: "display_rec709_sdr" });
      expect(JSON.parse(track.sourceSignature).displayBoundary).toEqual(reopened.colorManagement);
      expect(track.frames).toHaveLength(Math.round(graphic.duration * reopened.fps));
    }
    const panel = reopened.motionGraphics.find(graphic => graphic.vectorV2)!;
    const panelTrack = nativeMotionPaintTrack(reopened, native, panel.id), paint = panelTrack.scene.layers[0].paint;
    expect(paint).toEqual({ kind: "solid", color: [1, 1, 1, 242 / 255] });
    expect(nativeMotionPaintFrame(reopened, native, 30).colorIntent).toBe("display_rec709_sdr");
    const drift = structuredClone(reopened); drift.colorManagement!.outputTransform = "rec2100_hlg_1000";
    expect(() => nativeMotionPaintTrack(drift, native, panel.id)).toThrow(/stale/);
  });

  it("keeps V1 saved recipe identity and signatures unchanged without automatic promotion", async () => {
    const f = await created("native_paint_v1");
    // Fixed pre-display recipe identity from the existing native-paint/brisk
    // contract. Copy and font choice do not enter this recipe dependency hash.
    expect(f.prepared.instance.dependencies.recipeVersion).toBe("editkin.reference-motion-recipes/native-paint-v1:f1e4ae8e867026daa490c6be7d9442325081454725c39c9460e63d4ec5ffc05d");
    const native = await prepareMotionNativePaintForRender(f.current, fontRoot);
    const graphic = f.current.motionGraphics[0], track = nativeMotionPaintTrack(f.current, native, graphic.id);
    expect(track.schema).toBe("editkin.native-motion-paint-track/v1");
    expect(track).not.toHaveProperty("colorIntent");
    expect(JSON.parse(track.sourceSignature)).toEqual(JSON.parse(canonicalJson({ width: f.current.width, height: f.current.height,
      fps: f.current.fps, graphics: f.current.motionGraphics, scenes: [] })));
    const edited = await prepareReferenceMotionTemplateRevision(f.current, f.prepared.instance.id, { title: "NEW VIEW" },
      { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory });
    const final = applyCommand(f.current, { type: "batch", commands: edited.commands }, referenceMotionTemplateRevisionCommandContext(edited));
    expect(final.motionGraphics.every(graphic => graphic.paintV1?.schema === "editkin.motion-paint/v1")).toBe(true);
    expect(final.tracks).toEqual(f.project.tracks);
  });

  it("upgrades saved scene paint only by explicit one-way recompile with true same-role authority", async () => {
    const f = await created("native_paint_v1"), before = canonicalJson(f.current);
    const patch = { graphicPresentation: "native_paint_display_v2" as const };
    const revised = await prepareReferenceMotionTemplateRevision(f.current, f.prepared.instance.id, patch,
      { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory });
    expect(canonicalJson(f.current)).toBe(before);
    expect(revised.instance.roles).toEqual(f.prepared.instance.roles);
    expect(revised.instance.dependencies.recipeVersion).not.toBe(f.prepared.instance.dependencies.recipeVersion);
    const batch = { type: "batch" as const, commands: revised.commands };
    expect(() => applyCommand(f.current, batch)).toThrow(/owner-managed/);
    expect(() => applyCommand(f.current, batch, { nativePaintOwnerRevisionProof: {} })).toThrow();
    const changed = applyCommand(f.current, batch, referenceMotionTemplateRevisionCommandContext(revised));
    expect(changed.tracks).toEqual(f.project.tracks);
    expect(changed.motionGraphics.map(graphic => graphic.id)).toEqual(f.current.motionGraphics.map(graphic => graphic.id));
    expect(changed.motionGraphics.every(graphic => graphic.paintV1?.schema === "editkin.motion-paint/v2")).toBe(true);
    expect((await inspectReferenceMotionTemplateInstance(changed, f.prepared.instance.id)).status).toBe("CURRENT");
    expect(referenceMotionTemplateRevisionPatchSchema.safeParse({ graphicPresentation: "native_paint_v1" }).success).toBe(false);
  });

  it("independently recompiles the exact display upgrade for audit and rejects forged fill or intent", async () => {
    const f = await created("native_paint_v1"), patch = { graphicPresentation: "native_paint_display_v2" as const };
    const revised = await prepareReferenceMotionTemplateRevision(f.current, f.prepared.instance.id, patch,
      { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory });
    const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: f.prepared.instance.id,
      mode: "revise", expectedInstanceRevision: 1, patch, commandIndexes: revised.commands.map((_, index) => index) }] };
    const verified = await verifyReferenceMotionPlan(declaration, f.current, revised.commands, env);
    const changed = applyCommand(f.current, { type: "batch", commands: revised.commands },
      { nativePaintOwnerRevisionProof: verified.nativePaintOwnerRevisionProof });
    expect(changed.motionGraphics.every(graphic => graphic.paintV1?.schema === "editkin.motion-paint/v2")).toBe(true);
    for (const change of ["fill", "intent"] as const) {
      const forged = structuredClone(revised.commands), target = forged.find(command => command.type === "update_motion_graphic");
      if (!target || target.type !== "update_motion_graphic" || !target.patch.paintV1) throw new Error("Needs actual revised paint graphic");
      if (change === "fill") target.patch.paintV1.fill = { kind: "solid", color: "#CCCCCC" };
      else target.patch.paintV1 = { ...legacyPaint };
      await expect(verifyReferenceMotionPlan(declaration, f.current, forged, env)).rejects.toThrow(/independently recompiled/);
    }
  });

  it("retains owner protection when revising a saved display recipe's text and palette", async () => {
    const f = await created();
    const revised = await prepareReferenceMotionTemplateRevision(f.current, f.prepared.instance.id,
      { title: "NEW VIEW", style: { palette: { text: "#20283A" } } }, { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory });
    const changed = applyCommand(f.current, { type: "batch", commands: revised.commands }, referenceMotionTemplateRevisionCommandContext(revised));
    expect(changed.motionGraphics.find(graphic => graphic.text === "NEW VIEW")?.paintV1).toMatchObject({
      schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr", fill: { kind: "solid", color: "#20283A" } });
    expect((await inspectReferenceMotionTemplateInstance(changed, f.prepared.instance.id)).status).toBe("CURRENT");
    expect(changed.tracks).toEqual(f.project.tracks);
  });

  it("carries display intent through original authored 2D elements and physical preset variants", async () => {
    const f = fixture(), display = { ...legacyPaint, schema: "editkin.motion-paint/v2" as const, colorIntent: "display_rec709_sdr" as const };
    const before = canonicalJson(f.project);
    const prepared = await prepareOriginalMotionScene2d(f.project, {
      expectedRevision: f.project.revision, sceneId: "original-display", intent: "authored_overlay", reason: "Original display authoring control",
      startFrame: 0, durationFrames: 90, safeArea: { left: 0, right: 0, top: 0, bottom: 0 }, style: f.input.style!,
      camera: { initial: { centerX: 540, centerY: 960, zoom: 1 }, dynamics: { stiffness: 100, damping: 20, mass: 1 } },
      elements: [
        { id: "original-panel", kind: "panel", range: { startFrame: 0, endFrame: 90 }, xPixels: 60, yPixels: 120,
          widthPixels: 900, heightPixels: 200, cornerRadiusPixels: 16, colorRole: "surface", paintV1: display },
        { id: "original-text", kind: "text", range: { startFrame: 0, endFrame: 90 }, xPixels: 100, yPixels: 160,
          widthPixels: 800, text: "CLEAR VIEW", typographyRole: "heading", fontWeight: 400, fontSize: 60,
          minFontSize: 60, maxLines: 1, lineGapPixels: 0, letterSpacingPixels: 0, colorRole: "text",
          paintV1: { ...display, fill: { kind: "solid", color: "#172033" }, stroke: undefined, shadow: undefined } },
      ],
      semanticCues: [{ id: "read", frame: 0, purpose: "Read actual authored title", graphicIds: ["original-panel", "original-text"],
        evidenceRefs: ["synthetic:original-display"] }],
    }, ids(), deps);
    expect(canonicalJson(f.project)).toBe(before);
    expect(prepared.graphicBindings.every(binding => binding.presetVariant.overrides.paintV1?.schema === "editkin.motion-paint/v2")).toBe(true);
    expect(prepared.graphicBindings.find(binding => binding.graphicId === "original-text")?.physicalFont).toBeDefined();
    const applied = applyCommand(f.project, { type: "batch", commands: prepared.commands });
    expect(applied.tracks).toEqual(f.project.tracks);
    const native = await prepareMotionNativePaintForRender(applied, fontRoot);
    expect(nativeMotionPaintTrack(applied, native, "original-text")).toMatchObject({ schema: "editkin.native-motion-paint-track/v2",
      colorIntent: "display_rec709_sdr" });
  });

  it("refuses unsupported authoring outputs and display background composition without downgrade", async () => {
    for (const mode of ["rec709", "hdr", "3d", "25d"] as const) {
      const f = fixture();
      if (mode === "rec709") f.project.colorManagement!.mode = "rec709";
      if (mode === "hdr") f.project.colorManagement!.outputTransform = "rec2100_hlg_1000";
      if (mode === "3d") f.project.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true,
        background: { color: "#101010", gridColor: "#202020", spacing: 48, grid: false },
        light: { direction: [0, 0, 1], ambient: .2, intensity: .8 }, segments: [{ id: "three-d", name: "Unsupported 3D control",
          timelineStart: 0, duration: 10, camera: { position: [0, 0, 4], target: [0, 0, 0], verticalFovDegrees: 60, near: .1, far: 20 },
          cameraKeyframes: [], objects: [{ id: "box", name: "Control box", geometry: { kind: "box", width: 1, height: 1, depth: 1 },
            material: { color: "#FFFFFF", unlit: true }, pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [] }] }] };
      if (mode === "25d") f.project.scene25d = structuredClone(DEFAULT_SCENE_25D);
      await expect(prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), deps)).rejects.toThrow();
    }
    const f = await created(), graphic = structuredClone(f.current.motionGraphics[0]); graphic.compositeLayer = "background";
    expect(editorCommandSchema.safeParse({ type: "add_motion_graphic", graphic }).success).toBe(false);
    expect(referenceMotionTemplateInputSchema.safeParse({ ...f.input, templateId: "focus_wall" }).success).toBe(false);
  });

  it("keeps individual mixed-domain tracks explicit and refuses the flattening helper", async () => {
    const f = await created();
    const mixed = structuredClone(f.current), text = mixed.motionGraphics.find(graphic => graphic.text)!;
    text.paintV1 = { ...legacyPaint, fill: { kind: "solid", color: text.textColor } };
    const runs = new Map(await Promise.all(mixed.motionGraphics.filter(graphic => !graphic.vectorV2).map(async graphic =>
      [graphic.id, await deps.prepareText("EditkinFace-bebas-neue-400", graphic.text)] as const)));
    const native = prepareNativeMotionPaint(mixed, runs);
    expect(nativeMotionPaintTrack(mixed, native, text.id).schema).toBe("editkin.native-motion-paint-track/v1");
    expect(nativeMotionPaintTrack(mixed, native, mixed.motionGraphics[0].id).schema).toBe("editkin.native-motion-paint-track/v2");
    expect(() => nativeMotionPaintFrame(mixed, native, 30)).toThrow(/cannot flatten scene and display/);
  });
});

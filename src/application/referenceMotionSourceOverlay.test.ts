import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt,
  type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionSceneContourInk, type MotionSceneInk } from "../motion/sceneCamera2d";
import { motionVectorPaths } from "../motion/vectorGeometry";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import type { ReferenceMotionPlan } from "./referenceMotionPlan";
import { buildReferenceMotionTemplateCommands } from "./referenceMotionTemplateCommands";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance,
  prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Graph metadata is explicitly synthetic: no file probe, media rights, native
// pixels or complete template art are asserted. Glyphs use the real font bytes.
const faces = new Map<string, Uint8Array>();
async function physicalText(faceId: string, text: string) {
  let bytes = faces.get(faceId);
  if (!bytes) {
    if (faces.size >= 8) throw new Error("Physical face budget exceeded in source-overlay controls");
    bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    faces.set(faceId, bytes);
  }
  return prepareGlyphRun(faceId, text, bytes);
}
function ids() {
  let ordinal = 0;
  return (prefix: string, role?: string) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`;
}
type Variant = "portrait" | "portrait_multiline" | "landscape_serif";
function fixture(variant: Variant = "portrait") {
  const landscape = variant === "landscape_serif";
  const project = createEmptyProject("Synthetic source-overlay control", {
    id: `source-overlay-${variant}`, width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920, fps: 30,
  });
  project.assets = [
    { id: "primary-media", name: "Synthetic source metadata", kind: "video", uri: "D:/synthetic/source-overlay.mp4",
      duration: 20, width: landscape ? 720 : 1280, height: landscape ? 1280 : 720,
      displayAspectRatio: landscape ? 9 / 16 : 16 / 9, color: { interpretation: "rec709" },
      provenance: "Synthetic graph only; not a file, rights or footage-content verification" },
    { id: "independent-audio", name: "Synthetic independent audio metadata", kind: "audio",
      uri: "D:/synthetic/independent-track.wav", duration: 20 },
  ];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "primary-media",
    timelineStart: 0, sourceStart: 2, duration: 8, volume: .37,
    transform: { ...DEFAULT_TRANSFORM, x: .012, y: -.008, scale: .98 }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: .03, y: .04, width: .94, height: .92 } },
    floatingFrame: { schema: "editkin.floating-video-frame/v2", style: "matte", size: .58,
      yawDegrees: -12, pitchDegrees: 3, aspect: "source", mediaFit: "contain",
      motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } } }];
  // Existing production validation intentionally forbids combining these
  // representations. Exercise each legal source picture, without relaxing it.
  if (variant === "portrait_multiline") delete project.tracks[0].clips[0].layout;
  else delete project.tracks[0].clips[0].floatingFrame;
  const audio = project.tracks.find(track => track.kind === "audio")!;
  audio.clips = [{ id: "independent-audio-clip", trackId: audio.id, assetId: "independent-audio",
    timelineStart: 0, sourceStart: 3, duration: 8, volume: .21,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  project.captions.push({ id: "unrelated-caption", text: "KEEP", start: 12, duration: 1 });
  const input: ReferenceMotionTemplateInput = {
    templateId: "strike_reframe", clipId: "primary", startFrame: 0, durationFrames: 240,
    strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay", graphicCadence: "brisk",
    previousText: variant === "portrait_multiline" ? "動態太慢" : "SLOW", title: variant === "portrait_multiline" ? "重點到了\n畫面跟上" : "FOCUS",
    subtitle: variant === "portrait_multiline" ? "俐落動作，完整閱讀" : "READ FIRST", kicker: "MOTION", brandMark: "Editkin",
    sources: [], intent: "standalone_showcase", evidenceRefs: ["synthetic:source-overlay"],
    purpose: "Synthetic source-preserving overlay control; no rendered art or ownership assertion",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: {
      headingFamily: landscape ? "Noto Serif TC" : "Noto Sans TC", bodyFamily: "Noto Sans TC",
    } },
  };
  // Use the actual codec's normalization before comparing against command apply.
  return { project: parseProject(project), input };
}
type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;
const savedControls = new Map<Variant, Promise<ReturnType<typeof fixture> & { packet: Packet; current: EditProject }>>();
function saved(variant: Variant = "portrait") {
  if (!savedControls.has(variant)) savedControls.set(variant, (async () => {
    const f = fixture(variant);
    const packet = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    return { ...f, packet, current: applyCommand(f.project, { type: "batch", commands: packet.commands }) };
  })());
  return savedControls.get(variant)!;
}
function sourceState(project: EditProject) {
  return canonicalJson({ assets: project.assets, tracks: project.tracks, compositions: project.compositions,
    captions: project.captions, captionStyle: project.captionStyle, motionTracks: project.motionTracks,
    motionScenes: project.motionScenes, scene3d: project.scene3d, scene25d: project.scene25d,
    colorManagement: project.colorManagement, width: project.width, height: project.height, fps: project.fps });
}
function roleGraphic(packet: Packet, role: string): MotionGraphic {
  const id = packet.instance.roles.find(row => row.key === role)?.id;
  const command = packet.commands.find(row => row.type === "add_motion_graphic" && row.graphic.id === id);
  if (!command || command.type !== "add_motion_graphic") throw new Error(`Actual ${role} command is absent`);
  return command.graphic;
}
function layoutFor(project: EditProject, graphic: MotionGraphic, layouts: readonly MotionGraphicV2LayoutReceipt[]) {
  // Vector mutants receive a genuine layout from their changed production
  // graphic. Thus a fullscreen negative reaches geometry, not stale receipts.
  if (graphic.vectorV2) return motionGraphicV2LayoutReceipt(project, graphic);
  const layout = layouts.find(row => row.graphicId === graphic.id);
  if (!layout?.physicalFont || layout.segments.some(segment => !segment.outline?.ink)) {
    throw new Error("Observer requires actual physical text outlines");
  }
  return layout;
}
function transformed(ink: MotionSceneInk, x: number, y: number, scale: number): MotionSceneInk {
  return { xMin: x + ink.xMin * scale, yMin: y + ink.yMin * scale,
    xMax: x + ink.xMax * scale, yMax: y + ink.yMax * scale };
}
const area = (ink: MotionSceneInk) => (ink.xMax - ink.xMin) * (ink.yMax - ink.yMin);
function contains(outer: MotionSceneInk, inner: MotionSceneInk) {
  // SVG/ASS geometry shares two-decimal path rounding; this is <1 pixel.
  const tolerance = .03;
  return inner.xMin >= outer.xMin - tolerance && inner.yMin >= outer.yMin - tolerance
    && inner.xMax <= outer.xMax + tolerance && inner.yMax <= outer.yMax + tolerance;
}
function vectorInk(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: number) {
  const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout), state = receipt.vectorState;
  if (!receipt.visible || !state || state.opacity <= .001) return [];
  return motionVectorPaths(graphic, layout, receipt).flatMap(path => {
    const ink = motionSceneContourInk(path.svg);
    return ink ? [transformed(ink, layout.box.x + state.translateXPixels, layout.box.y + state.translateYPixels, state.scale)] : [];
  });
}

/** Independent observation of actual physical outlines and emitted draw order.
 * No role names, claimed surface labels or compiler envelope constants decide
 * acceptance. This is structural visibility, not native pixels or aesthetic QA. */
function observeOverlay(before: EditProject, current: EditProject, layouts: readonly MotionGraphicV2LayoutReceipt[]) {
  if (sourceState(before) !== sourceState(current)) throw new Error("Source picture or media/audio clock changed");
  const graphics = current.motionGraphics, canvasArea = current.width * current.height;
  const layoutMap = new Map(graphics.map(graphic => [graphic.id, layoutFor(current, graphic, layouts)]));
  const panels = graphics.map((graphic, index) => ({ graphic, index })).filter(({ graphic }) =>
    graphic.vectorV2?.kind === "panel" && graphic.compositeLayer !== "background");
  if (!panels.length || panels.length > 2) throw new Error("Overlay requires one or two local matte panels");
  let graphicFrames = 0, glyphFrames = 0, maxMatteArea = 0, maxTotalArea = 0;
  for (let frame = 0; frame < 240; frame++) {
    const visiblePanels = panels.flatMap(({ graphic, index }) => {
      const layout = layoutMap.get(graphic.id)!, receipt = motionGraphicV2FrameReceipt(current, graphic, frame, layout);
      if (!receipt.visible || !receipt.vectorState || receipt.vectorState.opacity <= .001) return [];
      const alpha = graphic.backgroundColor.length === 9 ? parseInt(graphic.backgroundColor.slice(7), 16) / 255 : 1;
      if (!Number.isFinite(alpha) || alpha * receipt.vectorState.opacity < .8) throw new Error("Readable matte is not present");
      return vectorInk(current, graphic, layout, frame).map(ink => ({ ink, index }));
    });
    const areas = visiblePanels.map(panel => area(panel.ink) / canvasArea), total = areas.reduce((sum, value) => sum + value, 0);
    maxMatteArea = Math.max(maxMatteArea, ...areas); maxTotalArea = Math.max(maxTotalArea, total);
    if (areas.some(value => value > .45 + 1e-6) || total > .50 + 1e-6) throw new Error("Matte obscures too much source area");
    const canvas = { xMin: 0, yMin: 0, xMax: current.width, yMax: current.height };
    for (const panel of visiblePanels) if (!contains(canvas, panel.ink)) throw new Error("Matte leaves the complete source canvas");
    graphics.forEach((graphic, index) => {
      const layout = layoutMap.get(graphic.id)!, receipt = motionGraphicV2FrameReceipt(current, graphic, frame, layout);
      graphicFrames++;
      if (!receipt.visible || panels.some(panel => panel.graphic.id === graphic.id)) return;
      const ink: MotionSceneInk[] = graphic.vectorV2 ? vectorInk(current, graphic, layout, frame)
        : receipt.segments.flatMap(state => {
          if (state.opacity <= .001) return [];
          const segment = layout.segments.find(value => value.id === state.segmentId);
          if (!segment?.outline?.ink) throw new Error("Visible glyph lacks an actual outline");
          glyphFrames++;
          return [transformed(segment.outline.ink, segment.x + state.translateXPixels,
            segment.y + state.translateYPixels, state.scale)];
        });
      for (const bounds of ink) {
        if (!contains(canvas, bounds)) throw new Error("Visible dynamic ink leaves source canvas");
        const covering = visiblePanels.filter(panel => contains(panel.ink, bounds));
        if (!covering.length) throw new Error("Visible dynamic ink leaves local reading matte");
        if (covering.some(panel => panel.index >= index)) throw new Error("Matte draws after covered text or annotation");
      }
    });
  }
  if (glyphFrames < 240) throw new Error("Observer did not see persistent real glyphs");
  return { frames: 240, graphicFrames, glyphFrames, matteCount: panels.length, maxMatteArea, maxTotalArea };
}
function inkBounds(layout: MotionGraphicV2LayoutReceipt) {
  const bounds = layout.segments.map(segment => transformed(segment.outline!.ink!, segment.x, segment.y, 1));
  return { xMin: Math.min(...bounds.map(ink => ink.xMin)), xMax: Math.max(...bounds.map(ink => ink.xMax)),
    yMin: Math.min(...bounds.map(ink => ink.yMin)), yMax: Math.max(...bounds.map(ink => ink.yMax)) };
}
function isSettled(project: EditProject, graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: number) {
  const receipt = motionGraphicV2FrameReceipt(project, graphic, frame, layout);
  return receipt.visible && receipt.segments.length > 0 && receipt.segments.every(state =>
    state.opacity === 1 && state.scale === 1 && state.translateXPixels === 0 && state.translateYPixels === 0);
}

describe("physical semantic source-overlay visibility and saved ownership", () => {
  it.each(["portrait", "portrait_multiline", "landscape_serif"] as const)("keeps real source state beneath local readable geometry for all 240 frames (%s)", async variant => {
    const f = await saved(variant), clip = f.project.tracks[0].clips[0];
    if (variant === "portrait_multiline") {
      expect(clip.floatingFrame?.schema).toBe("editkin.floating-video-frame/v2"); expect(clip.layout).toBeUndefined();
    } else {
      expect(clip.layout).toBeDefined(); expect(clip.floatingFrame).toBeUndefined();
    }
    const report = observeOverlay(f.project, f.current, f.packet.layouts);
    expect(report.frames).toBe(240); expect(report.graphicFrames).toBe(f.current.motionGraphics.length * 240);
    expect(report.matteCount).toBe(2); expect(report.maxMatteArea).toBeLessThanOrEqual(.45);
    expect(report.maxTotalArea).toBeLessThanOrEqual(.50);
    expect(f.packet.commands.every(command => command.type === "add_motion_graphic" || command.type === "upsert_reference_motion_instance")).toBe(true);
    const headingFace = f.packet.layouts.find(layout => layout.graphicId === roleGraphic(f.packet, "headline").id)!.physicalFont!;
    const bodyFace = f.packet.layouts.find(layout => layout.graphicId === roleGraphic(f.packet, "subtitle").id)!.physicalFont!;
    expect(headingFace.faceId).toContain(variant === "landscape_serif" ? "noto-serif" : "noto-sans");
    expect(bodyFace.faceId).toContain("noto-sans");
    if (variant === "portrait_multiline") expect(f.packet.layouts.find(layout => layout.graphicId === roleGraphic(f.packet, "headline").id)!.lineCount).toBe(2);
    const reopened = decodeProjectBytes(encodeProjectBytes(f.current));
    expect(sourceState(reopened)).toBe(sourceState(f.project)); expect(reopened.motionGraphics).toEqual(f.current.motionGraphics);
    expect((await inspectReferenceMotionTemplateInstance(reopened, f.packet.instance.id)).status).toBe("CURRENT");
  });

  it("retains one semantic focus, whole-phrase strike and full reading holds in the localized surface", async () => {
    const f = await saved(), previous = roleGraphic(f.packet, "previous"), headline = roleGraphic(f.packet, "headline"), strike = roleGraphic(f.packet, "strike");
    const oldLayout = layoutFor(f.project, previous, f.packet.layouts), newLayout = layoutFor(f.project, headline, f.packet.layouts);
    expect([previous.x, previous.y, previous.width]).toEqual([headline.x, headline.y, headline.width]);
    const oldInk = inkBounds(oldLayout), strikeLayout = layoutFor(f.project, strike, f.packet.layouts);
    const strikeStart = Math.round(strike.timelineStart * f.project.fps);
    let readableBeforeStrike = 0, completelyStruck = 0, replacementHold = 0;
    for (let frame = 0; frame < 240; frame++) {
      const a = motionGraphicV2FrameReceipt(f.project, previous, frame, oldLayout), b = motionGraphicV2FrameReceipt(f.project, headline, frame, newLayout);
      expect(a.segments.some(state => state.opacity > .001) && b.segments.some(state => state.opacity > .001)).toBe(false);
      if (frame < strikeStart && isSettled(f.project, previous, oldLayout, frame)) readableBeforeStrike++;
      if (isSettled(f.project, headline, newLayout, frame)) replacementHold++;
      const ink = vectorInk(f.project, strike, strikeLayout, frame)[0];
      if (ink && isSettled(f.project, previous, oldLayout, frame) && Math.abs(ink.xMin - oldInk.xMin) <= .03
        && Math.abs(ink.xMax - oldInk.xMax) <= .03 && ink.yMin >= oldInk.yMin && ink.yMax <= oldInk.yMax) completelyStruck++;
    }
    expect(readableBeforeStrike).toBeGreaterThanOrEqual(Math.ceil((.65 + [...previous.text].length / 8) * 30));
    expect(completelyStruck).toBeGreaterThanOrEqual(9);
    expect(replacementHold).toBeGreaterThanOrEqual(Math.ceil((.65 + [...headline.text].length / 8) * 30));
    expect(isSettled(f.project, headline, newLayout, 239)).toBe(true);
    const eyebrow = roleGraphic(f.packet, "kicker"), layout = layoutFor(f.project, eyebrow, f.packet.layouts);
    expect(isSettled(f.project, eyebrow, layout, 0)).toBe(true); expect(isSettled(f.project, eyebrow, layout, 239)).toBe(true);
    expect(strike.vectorV2?.schema).toBe("editkin.motion-vector-annotation/v1");
  });

  it("calibrates the observer against a true fullscreen foreground matte, independent of its role or claimed surface", async () => {
    const f = await saved(); expect(() => observeOverlay(f.project, f.current, f.packet.layouts)).not.toThrow();
    const mutant = structuredClone(f.current), matte = mutant.motionGraphics.find(graphic => graphic.vectorV2?.kind === "panel")!;
    matte.x = 0; matte.y = 0; matte.width = 1;
    if (!matte.vectorV2) throw new Error("Calibration needs an actual vector matte");
    matte.vectorV2.heightPixels = mutant.height;
    expect(() => observeOverlay(f.project, mutant, f.packet.layouts)).toThrow(/Matte obscures too much source area/);
  });
  it("calibrates actual late draw order and catches source transform and source-window mutations", async () => {
    const f = await saved(), late = { ...f.current, motionGraphics: [...f.current.motionGraphics.filter(graphic => graphic.vectorV2?.kind !== "panel"),
      ...f.current.motionGraphics.filter(graphic => graphic.vectorV2?.kind === "panel")] };
    expect(() => observeOverlay(f.project, late, f.packet.layouts)).toThrow(/Matte draws after/);
    for (const property of ["transform", "sourceStart", "duration", "volume"] as const) {
      const changed = structuredClone(f.current), clip = changed.tracks[0].clips[0];
      if (property === "transform") clip.transform.x += .1; else clip[property] += .1;
      expect(() => observeOverlay(f.project, changed, f.packet.layouts)).toThrow(/Source picture or media\/audio clock changed/);
    }
  });

  it("keeps omitted and explicit standalone appearance and dependencies exactly identical", async () => {
    const f = fixture(); delete f.input.strikeSurface;
    const omitted = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    const explicit = await prepareReferenceMotionTemplateInstance(f.project, { ...f.input, strikeSurface: "standalone" }, ids(), { prepareText: physicalText });
    const visual = (commands: EditorCommand[]) => commands.filter(command => command.type !== "upsert_reference_motion_instance");
    expect(visual(explicit.commands)).toEqual(visual(omitted.commands)); expect(explicit.layouts).toEqual(omitted.layouts);
    expect(explicit.instance.dependencies).toEqual(omitted.instance.dependencies);
    expect(Object.hasOwn(omitted.instance.input, "strikeSurface")).toBe(false);
    expect(roleGraphic(omitted, "stage").width).toBe(1);
    expect(roleGraphic(omitted, "stage").vectorV2?.heightPixels).toBe(f.project.height);
    const original = applyCommand(f.project, { type: "batch", commands: omitted.commands });
    expect(() => observeOverlay(f.project, original, omitted.layouts)).toThrow(/Matte obscures too much source area/);
  });

  it("revises standalone to source-overlay with stable IDs, real byte CURRENT, one Undo and Redo", async () => {
    const f = fixture(); f.input.strikeSurface = "standalone";
    const original = await prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: physicalText });
    const current = applyCommand(f.project, { type: "batch", commands: original.commands }), before = sourceState(current);
    const revised = await prepareReferenceMotionTemplateRevision(current, original.instance.id, { strikeSurface: "source_overlay" },
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: ids() });
    expect(revised.status).not.toBe("UNCHANGED");
    for (const role of original.instance.roles) expect(revised.instance.roles.find(row => row.key === role.key)?.id).toBe(role.id);
    expect(revised.instance.dependencies.recipeVersion).not.toBe(original.instance.dependencies.recipeVersion);
    const history = dispatchCommand(createHistory(current), { type: "batch", commands: revised.commands });
    expect(history.past).toHaveLength(1); expect(sourceState(history.present)).toBe(before);
    observeOverlay(f.project, history.present, revised.layouts);
    const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(reopened.referenceMotionInstances![0].input.strikeSurface).toBe("source_overlay");
    expect((await inspectReferenceMotionTemplateInstance(reopened, original.instance.id)).status).toBe("CURRENT");
    const undone = undo(history); expect(undone.present.motionGraphics).toEqual(current.motionGraphics);
    expect(undone.present.referenceMotionInstances).toEqual(current.referenceMotionInstances); expect(sourceState(undone.present)).toBe(before);
    const redone = redo(undone); expect(redone.present.motionGraphics).toEqual(history.present.motionGraphics);
    expect(redone.present.referenceMotionInstances).toEqual(history.present.referenceMotionInstances);
    expect((await inspectReferenceMotionTemplateInstance(decodeProjectBytes(encodeProjectBytes(redone.present)), original.instance.id)).status).toBe("CURRENT");
  });

  it("refuses manual EDITED and stale saved surface requests before glyph work", async () => {
    const f = await saved(), observed = vi.fn(physicalText), old = canonicalJson(f.current);
    const changed = applyCommand(f.current, { type: "update_motion_graphic", graphicId: roleGraphic(f.packet, "headline").id, patch: { x: .2 } });
    expect((await inspectReferenceMotionTemplateInstance(changed, f.packet.instance.id)).status).toBe("EDITED");
    await expect(prepareReferenceMotionTemplateRevision(changed, f.packet.instance.id, { strikeSurface: "standalone" },
      { expectedInstanceRevision: 1, prepareText: observed })).rejects.toThrow(/EDITED/);
    await expect(prepareReferenceMotionTemplateRevision(f.current, f.packet.instance.id, { strikeSurface: "standalone" },
      { expectedInstanceRevision: 2, prepareText: observed })).rejects.toThrow(/stale/);
    expect(observed).not.toHaveBeenCalled(); expect(canonicalJson(f.current)).toBe(old);
  });
  it("rejects invalid family and historical presentation before physical work, and generation1 cannot author an overlay", async () => {
    const f = fixture(), observed = vi.fn(physicalText), before = canonicalJson(f.project);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, templateId: "level_bridge" }, ids(),
      { prepareText: observed })).rejects.toThrow(/semantic_replace_v1|畫面用途|strike/);
    const omitted = { ...f.input }; delete omitted.strikePresentation; delete omitted.brandMark;
    await expect(prepareReferenceMotionTemplateInstance(f.project, omitted, ids(), { prepareText: observed })).rejects.toThrow(/semantic_replace_v1|畫面用途/);
    expect(() => buildReferenceMotionTemplateCommands(f.project, { ...f.input, graphicCadence: "legacy" }, ids())).toThrow(/generation 2/);
    expect(observed).not.toHaveBeenCalled(); expect(canonicalJson(f.project)).toBe(before);
  });
  it("blocks genuine missing glyphs and unsafe multi-line copy without committing or shrinking the source", async () => {
    const f = fixture(), before = canonicalJson(f.project);
    // Han is a permitted simple script, but the genuine Latin-only Bebas face
    // has no Han outline. This reaches MISSING_GLYPH, not the emoji text guard.
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, title: "字", style: {
      ...f.input.style!, typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" },
    } }, ids(),
      { prepareText: physicalText })).rejects.toThrow(/MISSING_GLYPH|no exact glyph/);
    await expect(prepareReferenceMotionTemplateInstance(f.project, { ...f.input, title: "一\n二\n三" }, ids(),
      { prepareText: physicalText })).rejects.toThrow(/safe-area|auto-fit|閱讀|來源疊字/);
    expect(canonicalJson(f.project)).toBe(before); expect(f.project.motionGraphics).toHaveLength(0);
  });
  it("does not issue overlay commands when the source generation changes during true glyph preparation", async () => {
    const f = fixture(), source = sourceState(f.project); let changed = false;
    await expect(prepareReferenceMotionTemplateInstance(f.project, f.input, ids(), { prepareText: async (faceId, text) => {
      const run = await physicalText(faceId, text);
      if (!changed) { changed = true; f.project.revision++; }
      return run;
    } })).rejects.toThrow(/source generation changed/);
    expect(sourceState(f.project)).toBe(source); expect(f.project.motionGraphics).toHaveLength(0);
  });
  it("allows actual trusted v4 recompile and rejects caller fullscreen tampering despite genuine saved metadata", async () => {
    const f = await saved(), declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{
      mode: "create", instanceId: f.packet.instance.id, commandIndexes: f.packet.commands.map((_, index) => index),
    }] };
    const environment = { ...process.env, EDITKIN_FONT_ROOT: resolve("public/fonts") }, before = canonicalJson(f.project);
    const verified = await verifyReferenceMotionPlan(declaration, f.project, f.packet.commands, environment);
    expect(verified.instanceCount).toBe(1); expect([...verified.indexes]).toEqual(declaration.instances[0].commandIndexes);
    const commands = structuredClone(f.packet.commands), panel = commands.find(command => command.type === "add_motion_graphic" && command.graphic.vectorV2?.kind === "panel");
    if (!panel || panel.type !== "add_motion_graphic" || !panel.graphic.vectorV2) throw new Error("Actual tamper control needs a compiled matte");
    panel.graphic.x = 0; panel.graphic.y = 0; panel.graphic.width = 1; panel.graphic.vectorV2.heightPixels = f.project.height;
    await expect(verifyReferenceMotionPlan(declaration, f.project, commands, environment)).rejects.toThrow(/independently recompiled/);
    expect(canonicalJson(f.project)).toBe(before);
  });
});

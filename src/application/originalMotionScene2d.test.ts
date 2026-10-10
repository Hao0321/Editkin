import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, projectDuration } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { parseProject } from "./projectFiles";
import { prepareMotionSceneCamera2D, projectMotionScenePoint } from "../motion/sceneCamera2d";
import { sampleSpringTargetTrack } from "../motion/springTargetTrack";
import { motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { canonicalJson } from "../shared/canonicalJson";
import { assertMotionPresetVariantBinding } from "./motionPresetVariant";
import { motionCommandFamilies } from "./motionTreatment";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import type { MotionPaintV1 } from "../domain/motionPaint";
import { ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS, originalMotionScene2dOutlineCodeUnits,
  originalMotionScene2dInputSchema, prepareOriginalMotionScene2d, type OriginalMotionScene2dInput } from "./originalMotionScene2d";

const faceId = "EditkinFace-bebas-neue-400";
let fontBytes: Uint8Array;
beforeAll(async () => {
  fontBytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
});

function fixture() {
  const project = parseProject(createEmptyProject("Original scene source", { width: 640, height: 360, fps: 30 }));
  const input: OriginalMotionScene2dInput = { expectedRevision: project.revision, sceneId: "original-scene",
    intent: "standalone_showcase", reason: "原創節點保持同一身份，由編寫的焦點節拍帶向下一個狀態", startFrame: 30, durationFrames: 150,
    safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "original-panel", kind: "panel", range: { startFrame: 7, endFrame: 145 },
      xPixels: 120, yPixels: 110, widthPixels: 180, heightPixels: 100, cornerRadiusPixels: 12, colorRole: "accent" }],
    semanticCues: [
      { id: "introduce-node", frame: 7, purpose: "先看到同一個原創節點", graphicIds: ["original-panel"], evidenceRefs: ["brief:original-node"], focus: { centerX: 335, centerY: 185, zoom: 1.02 } },
      { id: "handoff-node", frame: 19, purpose: "保留速度並改變焦點目標", graphicIds: ["original-panel"], evidenceRefs: ["brief:node-handoff"], focus: { centerX: 312, centerY: 178, zoom: 1.06 } },
      { id: "settle-node", frame: 59, purpose: "回到完整原創節點供閱讀", graphicIds: ["original-panel"], evidenceRefs: ["brief:node-hold"], focus: { centerX: 320, centerY: 180, zoom: 1 } },
    ] };
  return { project, input };
}

function textFixture() {
  const { project, input } = fixture();
  input.elements = [{ id: "original-panel", kind: "text", text: "FOCUS", typographyRole: "heading", fontWeight: 400,
    range: { startFrame: 7, endFrame: 145 }, xPixels: 120, yPixels: 90, widthPixels: 380,
    fontSize: 64, minFontSize: 32, maxLines: 1, lineGapPixels: 0, letterSpacingPixels: 0, colorRole: "text" }];
  return { project, input };
}

const trueText = (requestedFace: string, text: string) => prepareGlyphRun(requestedFace, text, fontBytes);
const authoredPaint: MotionPaintV1 = { schema: "editkin.motion-paint/v1", clips: [],
  fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 1 },
    stops: [{ at: 0, color: "#3E8DFA" }, { at: 1, color: "#D9F7FF" }] } };
function paintFixture() {
  const { project, input } = textFixture();
  project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  input.intent = "authored_overlay";
  if (input.elements[0].kind !== "text") throw new Error("fixture lost text");
  input.elements[0].paintV1 = structuredClone(authoredPaint);
  return { project, input };
}

function paintPanelFixture() {
  const { project, input } = fixture();
  project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  input.intent = "authored_overlay";
  input.elements[0].paintV1 = { ...structuredClone(authoredPaint), stroke: { color: "#E8F6FF80", widthPixels: .75 },
    shadow: { color: "#05112260", offsetXPixels: 0, offsetYPixels: 5, blurPixels: 8 } };
  return { project, input };
}

describe("original scene compiler with actual semantic frames and shared camera", () => {
  it("authors an exact rounded native paint panel without fake text or font work, retaining effect ownership on reopen", async () => {
    const { project, input } = paintPanelFixture(), before = structuredClone(project), prepareText = vi.fn(trueText);
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, { prepareText });
    expect(project).toEqual(before); expect(prepareText).not.toHaveBeenCalled();
    const creation = prepared.commands[0], binding = prepared.graphicBindings[0];
    if (creation.type !== "add_motion_graphic") throw new Error("fixture creation missing");
    expect(creation.graphic).toMatchObject({ text: "", cornerRadius: 12, backgroundColor: "#00000000", outlineWidth: 0, shadowDepth: 0,
      visualStyle: "native_paint", paintV1: input.elements[0].paintV1,
      vectorV2: { schema: "editkin.motion-vector/v1", kind: "panel", heightPixels: 100, revealFrames: 1 } });
    expect(binding.physicalFont).toBeUndefined();
    expect(binding.presetVariant.overrides).toMatchObject({ paintV1: input.elements[0].paintV1, cornerRadius: 12 });
    expect(() => assertMotionPresetVariantBinding(creation.graphic, binding.presetId, binding.presetVariant)).not.toThrow();
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands: prepared.commands }))));
    expect(reopened.motionGraphics[0]).toEqual(creation.graphic);
    expect(reopened.motionScenes?.[0]).toEqual(prepared.scene);
    expect(prepared.preparedSafety).toMatchObject({ framesChecked: 150, graphicFramesChecked: 150 });
    const drift = structuredClone(creation.graphic); drift.paintV1!.shadow!.blurPixels = 9;
    expect(() => assertMotionPresetVariantBinding(drift, binding.presetId, binding.presetVariant)).toThrow(/paintV1/);
  });

  it("keeps physical glyph proof for text beside a native paint panel and rejects mixed ordinary paint routes", async () => {
    const { project, input } = paintPanelFixture();
    const text = textFixture().input.elements[0]; text.id = "paint-heading"; text.yPixels = 220; text.paintV1 = structuredClone(authoredPaint);
    input.elements.push(text);
    input.semanticCues.push({ id: "read-heading", frame: 90, purpose: "讀取同一個節點的文字", graphicIds: [text.id], evidenceRefs: ["brief:heading"] });
    const prepareText = vi.fn(trueText);
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, { prepareText });
    expect(prepareText).toHaveBeenCalledExactlyOnceWith(faceId, "FOCUS");
    expect(prepared.graphicBindings[0].physicalFont).toBeUndefined();
    expect(prepared.graphicBindings[1].physicalFont?.faceId).toBe(faceId);
    expect(prepared.resources.outlineCodeUnits).toBeGreaterThan(0);
    const mixed = structuredClone(input); delete mixed.elements[1].paintV1;
    const notCalled = vi.fn(trueText);
    await expect(prepareOriginalMotionScene2d(project, mixed, undefined, { prepareText: notCalled })).rejects.toThrow(/Native paint source/);
    expect(notCalled).not.toHaveBeenCalled();
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands: prepared.commands }))));
    expect(reopened.motionGraphics).toHaveLength(2);
    expect(reopened.motionGraphics.every(graphic => graphic.visualStyle === "native_paint")).toBe(true);
  });

  it("compiles declared physical paint into the exact preset variant and preserves it on editable reopen", async () => {
    const { project, input } = paintFixture(), before = structuredClone(project);
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, { prepareText: trueText });
    expect(project).toEqual(before);
    const creation = prepared.commands[0], binding = prepared.graphicBindings[0];
    if (creation.type !== "add_motion_graphic") throw new Error("fixture creation missing");
    expect(creation.graphic).toMatchObject({ visualStyle: "native_paint", paintV1: authoredPaint });
    expect(binding.presetVariant.overrides).toMatchObject({ visualStyle: "native_paint", paintV1: authoredPaint });
    expect(binding.physicalFont?.faceId).toBe(faceId);
    expect(() => assertMotionPresetVariantBinding(creation.graphic, binding.presetId, binding.presetVariant)).not.toThrow();
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands: prepared.commands }))));
    expect(reopened.motionGraphics[0].paintV1).toEqual(authoredPaint);
    expect(reopened.colorManagement).toEqual(before.colorManagement);
    const hdr = structuredClone(reopened); hdr.colorManagement!.outputTransform = "rec2100_pq_1000";
    expect(() => parseProject(hdr)).toThrow(/Motion scenes require/);
    const changed = structuredClone(creation.graphic);
    changed.paintV1!.fill = { kind: "solid", color: "#FFFFFF" };
    expect(() => assertMotionPresetVariantBinding(changed, binding.presetId, binding.presetVariant)).toThrow(/paintV1/);
  });

  it("rejects unsupported paint routes before glyph work without implicit display promotion or media substitution", async () => {
    const prepareText = vi.fn(trueText);
    for (const route of ["rec709", "hdr", "standalone", "unpainted"] as const) {
      const { project, input } = paintFixture(), before = structuredClone(project);
      if (route === "rec709") project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT };
      if (route === "hdr") project.colorManagement!.outputTransform = "rec2100_pq_1000";
      if (route === "standalone") input.intent = "standalone_showcase";
      if (route === "unpainted") {
        const second = structuredClone(input.elements[0]); second.id = "ordinary-text";
        if (second.kind !== "text") throw new Error("fixture lost text");
        delete second.paintV1; input.elements.push(second);
      }
      const actualBefore = structuredClone(project);
      await expect(prepareOriginalMotionScene2d(project, input, undefined, { prepareText })).rejects.toThrow(/Native paint source/);
      expect(project).toEqual(actualBefore);
      expect(project.assets).toEqual(before.assets);
    }
    expect(prepareText).not.toHaveBeenCalled();
    const { project, input } = paintFixture();
    await expect(prepareOriginalMotionScene2d(project, input)).rejects.toThrow(/FONT_BYTES_REQUIRED/);
  });
  it("prepares original vector commands read-only and saves/reopens the same editable identities", async () => {
    const { project, input } = fixture(), before = structuredClone(project), prepareText = vi.fn(trueText);
    const prepared = await prepareOriginalMotionScene2d(project, input, () => "unused", { prepareText });
    expect(project).toEqual(before); expect(prepareText).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "PREPARED_NOT_APPLIED", readOnly: true, v4Binding: { admission: "NOT_V4_ADMITTED" },
      source: { kind: "original_authored_graphics", noMediaCommands: true, existingMediaUntouched: true } });
    expect(prepared.commands.map(command => command.type)).toEqual(["add_motion_graphic", "add_motion_scene"]);
    const creation = prepared.commands[0], binding = prepared.graphicBindings[0];
    if (creation.type !== "add_motion_graphic") throw new Error("fixture creation missing");
    expect(() => assertMotionPresetVariantBinding(creation.graphic, binding.presetId, binding.presetVariant)).not.toThrow();
    expect(binding).toMatchObject({ graphicId: "original-panel", presetId: "reel_native_panel", commandIndex: 0,
      range: { startFrame: 37, endFrame: 175 } });
    expect(prepared.editorialGraphics[0]).toMatchObject({ id: "original-panel", kind: "native_shape", message: "", presetVariant: binding.presetVariant });
    const reopened = parseProject(JSON.parse(JSON.stringify(applyCommand(project, { type: "batch", commands: prepared.commands }))));
    expect(reopened.motionScenes?.[0]).toEqual(prepared.scene);
    expect(reopened.motionGraphics[0].id).toBe("original-panel");
    expect(reopened.tracks).toEqual(before.tracks); expect(reopened.assets).toEqual(before.assets);
    expect(projectDuration(reopened)).toBeCloseTo(6, 12);
    expect(prepared.preparedSafety).toMatchObject({ sceneId: "original-scene", framesChecked: 150 });
    expect(prepared.sceneSha256).toBe(createHash("sha256").update(canonicalJson(prepared.scene)).digest("hex"));
  });

  it("binds authored cue frames and the actual scene/graphic command families without equal subdivision", async () => {
    const { project, input } = fixture();
    const prepared = await prepareOriginalMotionScene2d(project, input);
    expect(prepared.scene.semanticCues.map(cue => cue.frame)).toEqual([7, 19, 59]);
    expect(prepared.scene.camera.centerX.events).toEqual([{ frame: 7, target: 335 }, { frame: 19, target: 312 }, { frame: 59, target: 320 }]);
    expect(prepared.v4Binding.semanticCues.map(cue => ({ frame: cue.frame, absoluteFrame: cue.absoluteFrame, commandIndexes: cue.commandIndexes })))
      .toEqual([{ frame: 7, absoluteFrame: 37, commandIndexes: [0, 1] }, { frame: 19, absoluteFrame: 49, commandIndexes: [0, 1] }, { frame: 59, absoluteFrame: 89, commandIndexes: [0, 1] }]);
    prepared.v4Binding.commands.forEach(row => expect(row.visibleFamilies).toEqual(motionCommandFamilies(prepared.commands[row.commandIndex])));
    expect(prepared.v4Binding.commands[0].visibleFamilies).toEqual(["cards", "motion"]);
    expect(new Set(prepared.v4Binding.commands[1].visibleFamilies)).toEqual(new Set(["motion", "transitions_camera"]));
  });

  it("retargets the same fractional-fps camera with continuous position/velocity and seek-order independence", async () => {
    const { project, input } = fixture(); project.fps = 29.97;
    const prepared = await prepareOriginalMotionScene2d(project, input), track = prepared.scene.camera.centerX;
    expect(track.fps).toBe(29.97);
    const precedingTrack = { ...track, events: track.events.filter(event => event.frame < 19) };
    expect(sampleSpringTargetTrack(track, 19)).toEqual(sampleSpringTargetTrack(precedingTrack, 19));
    expect(Math.abs(sampleSpringTargetTrack(track, 19).velocity)).toBeGreaterThan(.01);
    const reopened = applyCommand(project, { type: "batch", commands: prepared.commands });
    const camera = prepareMotionSceneCamera2D(reopened), first = camera.sample("original-panel", 73);
    camera.sample("original-panel", 42); camera.sample("original-panel", 126);
    expect(camera.sample("original-panel", 73)).toEqual(first);
    expect(projectMotionScenePoint({ x: 120, y: 110 }, first)).toEqual({ x: 120 * first.scale + first.translateX, y: 110 * first.scale + first.translateY });
  });

  it("prepares exact bundled glyph bytes and exposes only their physical identity and layout receipt metadata", async () => {
    const { project, input } = textFixture(), prepareText = vi.fn(trueText);
    const prepared = await prepareOriginalMotionScene2d(project, input, () => "unused", { prepareText });
    expect(prepareText).toHaveBeenCalledExactlyOnceWith(faceId, "FOCUS");
    const binding = prepared.graphicBindings[0], spec = bundledFontFaceSpec(faceId);
    expect(binding.physicalFont).toMatchObject({ faceId, fontSha256: spec.sha256, manifestSha256: spec.manifestSha256 });
    expect(binding.layoutReceiptId).toBeTruthy();
    expect(prepared.editorialGraphics[0]).toMatchObject({ kind: "title_card", message: "FOCUS" });
    const creation = prepared.commands[0];
    if (creation.type !== "add_motion_graphic") throw new Error("fixture creation missing");
    expect(() => assertMotionPresetVariantBinding(creation.graphic, binding.presetId, binding.presetVariant)).not.toThrow();
    expect(Object.keys(binding)).not.toContain("glyphRun"); expect(Object.keys(binding)).not.toContain("bytes");
  });

  it("requires actual glyph preparation and rejects JSON-rebuilt or text-mismatched factory runs", async () => {
    const { project, input } = textFixture();
    await expect(prepareOriginalMotionScene2d(project, input)).rejects.toThrow(/FONT_BYTES_REQUIRED/);
    const run = await trueText(faceId, "FOCUS");
    await expect(prepareOriginalMotionScene2d(project, input, undefined, { prepareText: async () => JSON.parse(JSON.stringify(run)) as PreparedGlyphRun })).rejects.toThrow();
    const otherText = await trueText(faceId, "OTHER");
    await expect(prepareOriginalMotionScene2d(project, input, undefined, { prepareText: async () => otherText })).rejects.toThrow(/文字|text/);
  });

  it("counts both actual SVG and ASS strings before retaining a layout and rejects one unit over the cumulative bound", async () => {
    const { project, input } = textFixture();
    const prepared = await prepareOriginalMotionScene2d(project, input, undefined, { prepareText: trueText });
    const creation = prepared.commands[0];
    if (creation.type !== "add_motion_graphic") throw new Error("fixture creation missing");
    const layout = motionGraphicV2PhysicalLayoutReceipt(project, creation.graphic, await trueText(faceId, "FOCUS"));
    const actualUnits = layout.segments.reduce((total, segment) => total + segment.outline!.svg.length + segment.outline!.ass.length, 0);
    expect(actualUnits).toBeGreaterThan(0);
    expect(prepared.resources.outlineCodeUnits).toBe(actualUnits);
    expect(originalMotionScene2dOutlineCodeUnits(ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS - actualUnits, layout))
      .toBe(ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS);
    expect(() => originalMotionScene2dOutlineCodeUnits(ORIGINAL_MOTION_SCENE_2D_MAX_OUTLINE_CODE_UNITS - actualUnits + 1, layout)).toThrow(/outline budget/);
    expect(() => originalMotionScene2dOutlineCodeUnits(NaN, layout)).toThrow(/outline budget/);
  });

  it("stops missing/complex text rather than creating substitute glyphs and preserves the existing reading hold", async () => {
    const { project, input } = textFixture();
    for (const text of ["字", "A\u0301"]) {
      const changed = structuredClone(input);
      if (changed.elements[0].kind !== "text") throw new Error("fixture lost text");
      changed.elements[0].text = text;
      await expect(prepareOriginalMotionScene2d(project, changed, undefined, { prepareText: trueText })).rejects.toThrow();
    }
    const short = structuredClone(input); short.elements[0].range.endFrame = 20;
    short.semanticCues = short.semanticCues.slice(0, 2);
    await expect(prepareOriginalMotionScene2d(project, short, undefined, { prepareText: trueText })).rejects.toThrow(/閱讀停留/);
  });

  it("detects revision and unversioned project drift while actual asynchronous text preparation is pending", async () => {
    for (const revisionChange of [true, false]) {
      const { project, input } = textFixture();
      await expect(prepareOriginalMotionScene2d(project, input, undefined, { prepareText: async (requestedFace, text) => {
        if (revisionChange) project.revision++; else project.name = "changed without revision";
        return trueText(requestedFace, text);
      } })).rejects.toThrow(/changed|stale/);
    }
    const { project, input } = fixture();
    await expect(prepareOriginalMotionScene2d(project, { ...input, expectedRevision: 1 })).rejects.toThrow(/stale/);
  });

  it("rejects occupied, duplicated and foreign identities without replacing existing project data", async () => {
    const { project, input } = fixture(), before = structuredClone(project);
    await expect(prepareOriginalMotionScene2d(project, { ...input, sceneId: project.id })).rejects.toThrow(/unique/);
    const duplicate = structuredClone(input); duplicate.elements.push(structuredClone(duplicate.elements[0]));
    await expect(prepareOriginalMotionScene2d(project, duplicate)).rejects.toThrow(/unique/);
    const occupied = structuredClone(input); occupied.elements[0].id = "video-main";
    await expect(prepareOriginalMotionScene2d(project, occupied)).rejects.toThrow(/unique/);
    const foreign = structuredClone(input); foreign.semanticCues[0].graphicIds = ["outside-scene"];
    await expect(prepareOriginalMotionScene2d(project, foreign)).rejects.toThrow(/active/);
    expect(project).toEqual(before);
  });

  it("rejects malformed/inactive cue clocks and out-of-scene element ranges", async () => {
    const { project, input } = fixture();
    const variants = [structuredClone(input), structuredClone(input), structuredClone(input), structuredClone(input), structuredClone(input)];
    variants[0].semanticCues[1].frame = 7;
    variants[1].semanticCues[1].frame = 150;
    variants[2].semanticCues[1].id = variants[2].semanticCues[0].id;
    variants[3].semanticCues[0].frame = 6;
    variants[4].elements[0].range.endFrame = 151;
    for (const changed of variants) await expect(prepareOriginalMotionScene2d(project, changed)).rejects.toThrow();
  });

  it("rejects an actually projected contour outside safe area even when the authored unprojected box is inside", async () => {
    const { project, input } = fixture();
    input.camera.initial.centerX = 500;
    input.semanticCues.forEach(cue => { cue.focus = { centerX: 500, centerY: 180, zoom: 1 }; });
    expect(input.elements[0].xPixels).toBeGreaterThan(input.safeArea.left);
    await expect(prepareOriginalMotionScene2d(project, input)).rejects.toThrow(/safe|安全/i);
    const clamped = fixture(); clamped.input.elements[0].xPixels = 5;
    await expect(prepareOriginalMotionScene2d(clamped.project, clamped.input)).rejects.toThrow(/clamp|reposition/);
    const truncated = fixture(); truncated.input.elements[0].xPixels = 20; truncated.input.elements[0].widthPixels = 620;
    await expect(prepareOriginalMotionScene2d(truncated.project, truncated.input)).rejects.toThrow(/truncate/);
  });

  it("enforces the registered authoring scope, finite camera and hard graphics/frame budgets", async () => {
    const { project, input } = fixture();
    expect(() => originalMotionScene2dInputSchema.parse({ ...input, intent: "longform" })).toThrow();
    expect(() => originalMotionScene2dInputSchema.parse({ ...input, mediaEvidence: "invented-clip" })).toThrow();
    expect(() => originalMotionScene2dInputSchema.parse({ ...input, durationFrames: 1801 })).toThrow();
    expect(() => originalMotionScene2dInputSchema.parse({ ...input, elements: Array.from({ length: 33 }, () => input.elements[0]) })).toThrow();
    const invalidCamera = structuredClone(input); invalidCamera.camera.initial.zoom = Infinity;
    await expect(prepareOriginalMotionScene2d(project, invalidCamera)).rejects.toThrow();
    const unsupportedFont = structuredClone(input); unsupportedFont.style.typography.headingFamily = "Unknown external font";
    await expect(prepareOriginalMotionScene2d(project, unsupportedFont)).rejects.toThrow(/FONT_REQUIRED/);
  });
});

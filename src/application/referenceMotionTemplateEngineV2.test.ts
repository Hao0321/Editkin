import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { parseProject } from "./projectCodec";
import { motionGraphicV2FrameReceipt, motionGraphicV2LayoutReceipt, motionGraphicV2PhysicalLayoutReceipt,
  type MotionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { REFERENCE_MOTION_TEMPLATES, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { buildReferenceMotionTemplateCommands, motionSourceLayout, type ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";

const latinFace = "EditkinFace-bebas-neue-400", hanFace = "EditkinFace-noto-sans-tc-700";
const runs = new Map<string, PreparedGlyphRun>();
const key = (faceId: string, text: string) => JSON.stringify([faceId, text]);
const latinTexts = ["FOCUS", "EDITKIN", "CLEAR VIEW", "MORE MOTION", "SOURCE", "RETURN", "CHECK", "READ", "HOLD",
  "MAIN VIEW", "VIEW 2", "VIEW 3", "VIEW 4", "VIEW 5", "VIEW 6", "01", "02", "03",
  "01  /  03", "02  /  03", "03  /  03", "MAKE", "LEARN", "BUILD", "JOIN"];
beforeAll(async () => {
  // Real compiled physical bytes and factory brands. Asset URIs below are
  // controlled graph fixtures, not measured media or full-template evidence.
  for (const [faceId, texts] of [[latinFace, latinTexts], [hanFace, ["j漢g", "把焦點留下來", "把焦點留下來把焦點留下來", "EDITKIN", "看清楚"]]] as const) {
    const bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
    for (const text of texts) runs.set(key(faceId, text), await prepareGlyphRun(faceId, text, bytes));
  }
});

function fixture(): EditProject {
  const project = parseProject(createEmptyProject("Physical template source", { id: "physical-template", width: 1080, height: 1920, fps: 30 }));
  for (let i = 0; i < 9; i++) project.assets.push({ id: `source-${i}`, name: `Owned ${i}`, kind: "video",
    uri: `D:/owned/physical-source-${i}.mp4`, duration: 12, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "main", assetId: "source-0", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: 1, duration: 8, volume: .7, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], expressions: {}, layer: { enabled: true, blendMode: "normal", role: "content" } });
  return project;
}
function input(templateId: ReferenceMotionTemplateId): ReferenceMotionTemplateInput {
  return { templateId, clipId: "main", startFrame: 0, durationFrames: 240, title: "FOCUS", kicker: "EDITKIN",
    subtitle: "CLEAR VIEW", previousText: "MORE MOTION", items: [{ label: "SOURCE", detail: "CHECK" },
      { label: "FOCUS", detail: "READ" }, { label: "RETURN", detail: "HOLD" }],
    sources: Array.from({ length: templateId === "comparison_pair" ? 1 : templateId === "focus_wall" ? 5 : 0 },
      (_, i) => ({ assetId: `source-${i + 1}`, sourceStart: 2, label: `VIEW ${i + 2}` })),
    primaryLabel: "MAIN VIEW", purpose: "Original readable sequence", evidenceRefs: ["fixture:authored-viewing-order"],
    ...(templateId === "kinetic_network" ? { network: { seed: 721, points: 32, labels: ["MAKE", "LEARN", "BUILD"], hubLabel: "JOIN" } } : {}),
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
}
function trueLayout(project: EditProject, graphic: MotionGraphic): MotionGraphicV2LayoutReceipt {
  const face = resolveBundledFontFace(graphic.fontFamily ?? "Noto Sans TC", graphic.fontWeight ?? 700);
  if (!face) throw new Error("Fixture selected no physical face");
  const run = runs.get(key(face.faceId, graphic.text.replaceAll("\r", "")));
  if (!run) throw new Error(`Fixture has no genuine prepared run for ${face.faceId}/${graphic.text}`);
  return motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
}
function compile(project: EditProject, value: ReferenceMotionTemplateInput, options?: ReferenceMotionTemplateCompileOptions) {
  let serial = 0;
  return buildReferenceMotionTemplateCommands(project, value, prefix => `${prefix}-${serial++}`, options);
}
function physical(project: EditProject): ReferenceMotionTemplateCompileOptions {
  return { generation: 2, layoutForGraphic: graphic => trueLayout(project, graphic) };
}
function assertFamily(id: ReferenceMotionTemplateId) {
  const project = fixture(), before = structuredClone(project), packet = compile(project, input(id), physical(project));
  expect(project).toEqual(before);
  expect(packet).toMatchObject({ schema: "editkin.reference-motion-template/v2", status: "REVIEW_REQUIRED",
    authoringGeneration: 2, typography: "physical_glyph_layout_required" });
  expect(packet.cameraScope).toMatch(/no_scene_camera_commands/);
  expect(packet.commands.some(command => command.type === "add_motion_scene")).toBe(false);
  const applied = applyCommand(project, { type: "batch", commands: packet.commands }), reopened = parseProject(JSON.parse(JSON.stringify(applied)));
  const main = reopened.tracks.flatMap(track => track.clips).find(clip => clip.id === "main")!;
  expect(main).toMatchObject({ sourceStart: 1, timelineStart: 0, duration: 8, volume: .7 });
  expect(reopened.tracks.flatMap(track => track.clips).filter(clip => clip.volume > 0)).toHaveLength(1);
  expect(reopened.assets).toEqual(project.assets);
  expect(packet.layouts.filter(layout => layout.physicalFont).length).toBeGreaterThan(0);
  for (const graphic of reopened.motionGraphics) {
    const saved = packet.layouts.find(layout => layout.graphicId === graphic.id)!;
    if (graphic.vectorV2) expect(saved).toEqual(motionGraphicV2LayoutReceipt(reopened, graphic));
    else {
      expect(saved).toEqual(trueLayout(reopened, graphic));
      expect(saved.physicalFont).toMatchObject({ faceId: latinFace, fontSha256: bundledFontFaceSpec(latinFace).sha256 });
      expect(saved.segments.every(segment => !!segment.outline?.svg && !!segment.outline?.ass)).toBe(true);
      const last = Math.round((graphic.timelineStart + graphic.duration) * reopened.fps) - 1;
      const at = motionGraphicV2FrameReceipt(reopened, graphic, last, saved);
      motionGraphicV2FrameReceipt(reopened, graphic, Math.round(graphic.timelineStart * reopened.fps), saved);
      expect(motionGraphicV2FrameReceipt(reopened, graphic, last, saved)).toEqual(at);
    }
  }
  expect(packet.phases.every(phase => Number.isInteger(phase.startFrame) && Number.isInteger(phase.endFrame))).toBe(true);
}

describe("reference template generation 2 physical layout seam", () => {
  it("prepares strike reframe with real physical glyphs and preserves editable source clocks", () => { assertFamily("strike_reframe"); });
  it("prepares level bridge with real physical glyphs and preserves editable source clocks", () => { assertFamily("level_bridge"); });
  it("prepares comparison pair with real physical glyphs and preserves editable source clocks", () => { assertFamily("comparison_pair"); });
  it("prepares context stack with real physical glyphs and preserves editable source clocks", () => { assertFamily("context_stack"); });
  it("prepares evidence takeover with real physical glyphs and preserves editable source clocks", () => { assertFamily("evidence_takeover"); });
  it("prepares focus wall with real physical glyphs and preserves editable source clocks", () => { assertFamily("focus_wall"); });
  it("prepares brand recap with real physical glyphs and preserves editable source clocks", () => { assertFamily("brand_recap"); });
  it("prepares kinetic network with real physical glyphs and preserves editable source clocks", () => { assertFamily("kinetic_network"); });

  it("uses actual Han and Latin ink for the strike instead of estimated advances and box padding", () => {
    const project = fixture(), value = input("strike_reframe");
    value.previousText = "j漢g"; value.title = "把焦點留下來"; value.subtitle = "看清楚";
    value.style!.typography = { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" };
    const packet = compile(project, value, physical(project));
    const previous = packet.bindings.find(binding => binding.graphic.text === "j漢g")!.graphic;
    const layout = packet.layouts.find(item => item.graphicId === previous.id)!;
    const rule = packet.bindings.find(binding => binding.graphic.vectorV2?.kind === "rule")!.graphic;
    const ink = layout.segments.map(segment => ({ left: segment.x + segment.outline!.ink!.xMin,
      right: segment.x + segment.outline!.ink!.xMax, top: segment.y + segment.outline!.ink!.yMin,
      bottom: segment.y + segment.outline!.ink!.yMax }));
    const left = Math.min(...ink.map(box => box.left)), right = Math.max(...ink.map(box => box.right));
    const top = Math.min(...ink.map(box => box.top)), bottom = Math.max(...ink.map(box => box.bottom));
    expect(rule.x * project.width).toBeCloseTo(left, 5);
    expect(rule.width * project.width).toBeCloseTo(right - left, 5);
    expect(rule.y * project.height).toBeCloseTo(top + (bottom - top) * .52, 5);
    const estimated = motionGraphicV2LayoutReceipt(project, previous);
    const estimatedWidth = Math.max(...estimated.segments.map(segment => segment.x + segment.width)) - Math.min(...estimated.segments.map(segment => segment.x));
    expect(Math.abs(rule.width * project.width - estimatedWidth)).toBeGreaterThan(2);
  });

  it("positions later copy from the physical headline height before compilation completes", () => {
    const project = fixture(), value = input("level_bridge");
    value.title = "把焦點留下來把焦點留下來"; value.subtitle = "看清楚";
    value.style!.typography = { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" };
    const packet = compile(project, value, physical(project));
    const headline = packet.bindings.find(binding => binding.graphic.text === value.title)!.graphic;
    const subtitle = packet.bindings.find(binding => binding.graphic.text === value.subtitle)!.graphic;
    const current = trueLayout(project, headline).box;
    expect(subtitle.y * project.height).toBeCloseTo(Math.max(.275 * project.height, current.y + current.height + 12), 5);
    const estimated = motionGraphicV2LayoutReceipt(project, headline).box;
    expect(current.height).not.toBe(estimated.height);
    expect(subtitle.y * project.height).toBeGreaterThan(Math.max(.275 * project.height, estimated.y + estimated.height + 12));
  });

  it("keeps the omitted generation option on the explicit legacy estimated compiler", () => {
    const project = fixture(), packet = compile(project, input("level_bridge"));
    expect(packet.schema).toBe("editkin.reference-motion-template/v1");
    expect(packet).not.toHaveProperty("authoringGeneration");
    expect(packet.layouts.every(layout => !layout.physicalFont)).toBe(true);
    for (const binding of packet.bindings) expect(packet.layouts.find(layout => layout.graphicId === binding.graphic.id))
      .toEqual(motionGraphicV2LayoutReceipt(project, binding.graphic));
    expect(REFERENCE_MOTION_TEMPLATES.every(recipe => recipe.latestAuthoringGeneration === 2)).toBe(true);
  });

  it("blocks missing providers and estimated or empty-contour fallbacks in generation 2", () => {
    const project = fixture(), value = input("level_bridge");
    expect(() => compile(project, value, { generation: 2 } as ReferenceMotionTemplateCompileOptions)).toThrow(/physical layout provider/);
    expect(() => compile(project, value, { generation: 2, layoutForGraphic: graphic => motionGraphicV2LayoutReceipt(project, graphic) })).toThrow(/physical glyph/);
    expect(() => compile(project, value, { generation: 2, layoutForGraphic: graphic => {
      const layout = trueLayout(project, graphic), copy = structuredClone(layout);
      copy.segments[0].outline!.ass = "";
      return copy;
    } })).toThrow(/physical glyph/);
  });

  it("blocks a physical receipt for stale text instead of accepting its font label", () => {
    const project = fixture();
    expect(() => compile(project, input("level_bridge"), { generation: 2, layoutForGraphic: graphic =>
      trueLayout(project, { ...graphic, text: graphic.text === "FOCUS" ? "SOURCE" : "FOCUS" }) })).toThrow(/receipt|不一致/);
  });

  it("blocks contour-body tampering even when physical font and source signature stay current", () => {
    const project = fixture();
    expect(() => compile(project, input("level_bridge"), { generation: 2, layoutForGraphic: graphic => {
      const copy = structuredClone(trueLayout(project, graphic));
      copy.segments[0].x += 1;
      return copy;
    } })).toThrow(/receipt|不一致/);
  });

  it("contains upright anamorphic and quarter-turn display aspects without encoded-ratio stretching", () => {
    const project = fixture(), region = { x: .1, y: .3, width: .8, height: .4 };
    const anamorphic = motionSourceLayout(project, { width: 640, height: 480, displayAspectRatio: 16 / 9 }, region);
    const rotated = motionSourceLayout(project, { width: 480, height: 640, displayAspectRatio: 9 / 16 }, region);
    const legacy = motionSourceLayout(project, { width: 640, height: 480 }, region);
    const ratio = (layout: ReturnType<typeof motionSourceLayout>) => layout.viewport.width * project.width / (layout.viewport.height * project.height);
    expect(ratio(anamorphic)).toBeCloseTo(16 / 9, 9);
    expect(ratio(rotated)).toBeCloseTo(9 / 16, 9);
    expect(ratio(legacy)).toBeCloseTo(4 / 3, 9);
    for (const layout of [anamorphic, rotated, legacy]) {
      expect(layout.viewport.x).toBeGreaterThanOrEqual(region.x);
      expect(layout.viewport.y + layout.viewport.height).toBeLessThanOrEqual(region.y + region.height + 1e-12);
    }
    for (const displayAspectRatio of [0, -1, NaN, Infinity]) expect(() => motionSourceLayout(project,
      { width: 640, height: 480, displayAspectRatio }, region)).toThrow(/display aspect ratio/);
  });

  it("rejects enabled true 3D before reading glyphs or issuing template commands", () => {
    const project = fixture();
    project.scene3d = { schema: "editkin.mesh-scene/v1", enabled: true,
      background: { color: "#FFFFFF", gridColor: "#D8DEE8", spacing: 64, grid: false },
      light: { direction: [0, 0, -1], ambient: .5, intensity: 1 }, segments: [{ id: "actual-3d", name: "Box", timelineStart: 0, duration: 8,
        camera: { position: [0, 0, 5], target: [0, 0, 0], verticalFovDegrees: 45, near: .1, far: 100 }, cameraKeyframes: [],
        objects: [{ id: "box", name: "Box", geometry: { kind: "box", width: 1, height: 1, depth: 1 },
          material: { color: "#175CD3", unlit: false }, pose: { position: [0, 0, 0], rotationDegrees: [0, 0, 0], scale: [1, 1, 1] }, keyframes: [] }] }] };
    const before = structuredClone(project);
    expect(() => compile(project, input("level_bridge"), { generation: 2, layoutForGraphic: () => { throw new Error("Glyph provider must not run"); } })).toThrow(/Rec.709 2D/);
    expect(project).toEqual(before);
  });
});

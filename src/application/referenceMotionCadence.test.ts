import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { motionGraphicV2FrameReceipt, motionGraphicV2PhysicalLayoutReceipt } from "../motion/compositionV2";
import { evaluateMotionGraphicV2Easing } from "../motion/motionEasing";
import { MOTION_CURVES } from "../motion/motionLanguage";
import { GRAPHIC_CADENCE_CONTRACT, compileGraphicCadence, type GraphicCadenceProfile } from "../motion/graphicCadence";
import { referenceMotionTemplateInputSchema, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { parseProject } from "./projectCodec";
import { buildReferenceMotionTemplateCommands, type ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";

const faceId = "EditkinFace-bebas-neue-400", runs = new Map<string, PreparedGlyphRun>();
beforeAll(async () => {
  // Actual bundled bytes and factory-branded physical runs. These controlled
  // media graphs are not measured footage or complete-template art evidence.
  const bytes = new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)));
  for (const text of ["FOCUS", "EDITKIN", "CLEAR VIEW", "MORE MOTION", "SOURCE", "RETURN", "CHECK", "READ", "HOLD",
    "MAIN VIEW", "VIEW 2", "VIEW 3", "VIEW 4", "VIEW 5", "VIEW 6", "01", "02", "03",
    "01  /  03", "02  /  03", "03  /  03", "MAKE", "LEARN", "BUILD", "JOIN", "FOCUSABC"]) {
    runs.set(text, await prepareGlyphRun(faceId, text, bytes));
  }
});
function fixture(fps = 30, startFrame = 0): EditProject {
  const project = parseProject(createEmptyProject("Actual physical cadence source", { id: "cadence-project", width: 1080, height: 1920, fps }));
  for (let index = 0; index < 9; index++) project.assets.push({ id: `source-${index}`, name: `Owned ${index}`, kind: "video",
    uri: `D:/owned/cadence-${index}.mp4`, duration: 24, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "main", assetId: "source-0", trackId: project.tracks[0].id,
    timelineStart: startFrame / fps, sourceStart: 1, duration: Math.round(18 * fps) / fps, volume: .7,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], expressions: {},
    layer: { enabled: true, blendMode: "normal", role: "content" } });
  return project;
}
function input(project: EditProject, templateId: ReferenceMotionTemplateId, graphicCadence: GraphicCadenceProfile = "brisk"): ReferenceMotionTemplateInput {
  const main = project.tracks[0].clips[0];
  return { templateId, clipId: main.id, startFrame: Math.round(main.timelineStart * project.fps), durationFrames: Math.round(main.duration * project.fps),
    title: "FOCUS", kicker: "EDITKIN", subtitle: "CLEAR VIEW", previousText: "MORE MOTION", primaryLabel: "MAIN VIEW",
    items: [{ label: "SOURCE", detail: "CHECK" }, { label: "FOCUS", detail: "READ" }, { label: "RETURN", detail: "HOLD" }],
    sources: Array.from({ length: templateId === "comparison_pair" ? 1 : templateId === "focus_wall" ? 5 : 0 },
      (_, index) => ({ assetId: `source-${index + 1}`, sourceStart: 2, label: `VIEW ${index + 2}` })),
    ...(templateId === "comparison_pair" ? { mediaPresentation: "source_soft_v2" as const } : {}),
    ...(templateId === "kinetic_network" ? { network: { seed: 721, points: 32, labels: ["MAKE", "LEARN", "BUILD"], hubLabel: "JOIN" } } : {}),
    graphicCadence, purpose: "Original graphic cadence and unchanged listening reference", evidenceRefs: ["fixture:authored-cadence-purpose"],
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
}
function physical(project: EditProject): ReferenceMotionTemplateCompileOptions {
  return { generation: 2, allocateRoleId: role => `role-${role.key.replaceAll(":", "-")}`,
    layoutForGraphic: (graphic: MotionGraphic) => {
      const run = runs.get(graphic.text);
      if (!run) throw new Error(`Missing actual fixture glyph run: ${graphic.text}`);
      return motionGraphicV2PhysicalLayoutReceipt(project, graphic, run);
    } };
}
function compile(project: EditProject, value: ReferenceMotionTemplateInput, options = physical(project)) {
  let serial = 0;
  return buildReferenceMotionTemplateCommands(project, value, prefix => `${prefix}-${serial++}`, options);
}
const clocks = (project: EditProject) => project.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, assetId: clip.assetId,
  trackId: clip.trackId, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration, volume: clip.volume }));
function assertFamily(templateId: ReferenceMotionTemplateId) {
  const project = fixture(), before = canonicalJson(project), value = input(project, templateId);
  const candidate = compile(project, value), legacy = compile(project, { ...value, graphicCadence: "legacy" });
  expect(canonicalJson(project)).toBe(before);
  expect(candidate).toMatchObject({ schema: "editkin.reference-motion-template/v2", graphicCadence: "brisk", status: "REVIEW_REQUIRED" });
  expect(candidate.roles).toEqual(legacy.roles);
  expect(candidate.sourceContinuity).toEqual(legacy.sourceContinuity);
  const applied = applyCommand(project, { type: "batch", commands: candidate.commands });
  const prior = applyCommand(project, { type: "batch", commands: legacy.commands });
  expect(clocks(applied)).toEqual(clocks(prior));
  expect(applied.assets).toEqual(project.assets);
  expect(applied.tracks.flatMap(track => track.clips).filter(clip => clip.volume > 0)).toHaveLength(1);
  const text = applied.motionGraphics.find(graphic => !graphic.vectorV2)!;
  const currentLayout = candidate.layouts.find(layout => layout.graphicId === text.id)!;
  expect(currentLayout.physicalFont!.fontSha256).toBe(bundledFontFaceSpec(faceId).sha256);
  const start = Math.round(text.timelineStart * project.fps), settle = start + text.motionV2!.entrance.durationFrames - 1;
  const current = motionGraphicV2FrameReceipt(applied, text, settle, currentLayout);
  expect(current.segments.every(state => state.opacity === 1 && state.translateXPixels === 0 && state.translateYPixels === 0)).toBe(true);
  const oldText = prior.motionGraphics.find(graphic => graphic.id === text.id)!;
  expect(oldText.motionV2!.entrance.durationFrames).toBeGreaterThan(text.motionV2!.entrance.durationFrames);
  expect(motionGraphicV2FrameReceipt(prior, oldText, Math.round(oldText.timelineStart * project.fps) + text.motionV2!.entrance.durationFrames - 1,
    legacy.layouts.find(layout => layout.graphicId === text.id)!).segments.some(state => state.opacity < 1)).toBe(true);
  for (const graphic of applied.motionGraphics.filter(graphic => !graphic.vectorV2)) {
    const layout = candidate.layouts.find(layout => layout.graphicId === graphic.id)!;
    const motion = graphic.motionV2!, tail = Math.max(0, layout.unitCount - 1) * motion.sequence.staggerFrames;
    const hold = Math.round(graphic.duration * project.fps) - motion.entrance.durationFrames - motion.exit.durationFrames - 2 * tail;
    expect(hold).toBeGreaterThanOrEqual(Math.ceil((.65 + [...graphic.text].length / 8) * project.fps));
    expect(layout.segments.every(segment => !!segment.outline?.svg && !!segment.outline?.ass)).toBe(true);
  }
  expect(candidate.phases.every(phase => Number.isInteger(phase.startFrame) && phase.endFrame >= phase.startFrame)).toBe(true);
}

describe("physical reference Motion brisk cadence compiler", () => {
  it("compiles strike reframe with earlier physical settle and unchanged source clocks", () => { assertFamily("strike_reframe"); });
  it("compiles level bridge with earlier physical settle and unchanged source clocks", () => { assertFamily("level_bridge"); });
  it("compiles comparison pair with earlier physical settle and unchanged source clocks", () => { assertFamily("comparison_pair"); });
  it("compiles context stack with earlier physical settle and unchanged source clocks", () => { assertFamily("context_stack"); });
  it("compiles evidence takeover with earlier physical settle and unchanged source clocks", () => { assertFamily("evidence_takeover"); });
  it("compiles focus wall with earlier physical settle and unchanged source clocks", () => { assertFamily("focus_wall"); });
  it("compiles brand recap with earlier physical settle and unchanged source clocks", () => { assertFamily("brand_recap"); });
  it("compiles kinetic network with earlier physical settle and unchanged source clocks", () => { assertFamily("kinetic_network"); });

  it("compiles integer trajectories at 24 29.97 30 and 60 fps across all supported speed endpoints", () => {
    for (const fps of [24, 29.97, 30, 60]) for (const speed of [.5, 1, 2]) {
      const cadence = compileGraphicCadence(fps, speed, "brisk");
      expect(cadence.entranceFrames).toBe(Math.max(1, Math.round(.22 * fps / speed)));
      expect(cadence.exitFrames).toBe(Math.max(1, Math.round(.12 * fps / speed)));
      expect(cadence.moveFrames).toBe(Math.max(1, Math.round(.36 * fps / speed)));
      expect(cadence.returnHoldFrames).toBe(Math.ceil(.65 * fps));
      expect(Object.entries(cadence).filter(([key]) => key.endsWith("Frames")).every(([, value]) => typeof value === "function"
        || (typeof value === "number" && Number.isSafeInteger(value)))).toBe(true);
      const project = fixture(fps), value = input(project, "level_bridge"); value.style!.animationSpeed = speed;
      const packet = compile(project, value), applied = applyCommand(project, { type: "batch", commands: packet.commands });
      expect(clocks(applied)).toEqual(clocks(project));
      expect(packet.bindings.every(binding => Number.isInteger(binding.startFrame) && Number.isInteger(binding.endFrame))).toBe(true);
      expect(applied.motionGraphics.filter(graphic => !graphic.vectorV2).every(graphic => graphic.motionV2!.entrance.durationFrames === cadence.entranceFrames
        && graphic.motionV2!.exit.durationFrames === cadence.exitFrames)).toBe(true);
    }
  });

  it("uses E minus one for actual settled glyphs while phase markers include late comparison labels and arbitrary seek order", () => {
    const project = fixture(30, 90), packet = compile(project, input(project, "comparison_pair"));
    const applied = applyCommand(project, { type: "batch", commands: packet.commands });
    const label = applied.motionGraphics.find(graphic => graphic.id === "role-source-0-label")!;
    const layout = packet.layouts.find(layout => layout.graphicId === label.id)!;
    const first = Math.round(label.timelineStart * project.fps), e = label.motionV2!.entrance.durationFrames;
    const settled = motionGraphicV2FrameReceipt(applied, label, first + e - 1, layout);
    expect(settled.segments.every(state => state.opacity === 1 && state.translateYPixels === 0)).toBe(true);
    expect(motionGraphicV2FrameReceipt(applied, label, first + e - 2, layout).segments.some(state => state.opacity < 1)).toBe(true);
    motionGraphicV2FrameReceipt(applied, label, first + 90, layout);
    motionGraphicV2FrameReceipt(applied, label, first, layout);
    expect(motionGraphicV2FrameReceipt(applied, label, first + e - 1, layout)).toEqual(settled);
    const hold = packet.phases.find(phase => phase.role === "hold")!;
    expect(hold.startFrame).toBe(first + e);
    expect(packet.phases[0].endFrame).toBe(hold.startFrame);
    expect(hold.startFrame).toBe(90 + 2 * e);
    expect(applied.tracks.flatMap(track => track.clips).every(clip => clip.keyframes.at(-1)!.time === e / 30)).toBe(true);
    const evidence = fixture(), evidencePacket = compile(evidence, input(evidence, "evidence_takeover"));
    const evidenceApplied = applyCommand(evidence, { type: "batch", commands: evidencePacket.commands });
    const headline = evidenceApplied.motionGraphics.find(graphic => graphic.id === "role-headline")!;
    const headlineLayout = evidencePacket.layouts.find(layout => layout.graphicId === headline.id)!;
    const firstHold = evidencePacket.phases[0], graphicEnd = Math.round((headline.timelineStart + headline.duration) * evidence.fps);
    expect(firstHold.endFrame).toBe(graphicEnd - headline.motionV2!.exit.durationFrames);
    const at = (frame: number) => motionGraphicV2FrameReceipt(evidenceApplied, headline, frame, headlineLayout);
    expect(at(firstHold.endFrame - 1).segments.every(state => state.opacity === 1 && state.translateYPixels === 0)).toBe(true);
    // Exit starts at zero progress on its first frame; the next frame is the
    // first observable fade. Neither belongs to the half-open steady hold.
    expect(at(firstHold.endFrame).segments.every(state => state.opacity === 1)).toBe(true);
    expect(at(firstHold.endFrame + 1).segments.some(state => state.opacity < 1)).toBe(true);
    expect(evidencePacket.phases[1].startFrame).toBe(graphicEnd);
    expect(evidencePacket.phases.at(-1)!.endFrame).toBe(input(evidence, "evidence_takeover").durationFrames);
    expect(at(evidencePacket.phases.at(-1)!.startFrame).visible).toBe(false);
  });

  it("caps the complete recap stagger tail and reports actual full entrance including detail and rule reveal", () => {
    const project = fixture(60), value = input(project, "brand_recap");
    value.items = [{ label: "FOCUSABC", detail: "CHECK" }, { label: "SOURCE", detail: "READ" }, { label: "RETURN", detail: "HOLD" }];
    const packet = compile(project, value), applied = applyCommand(project, { type: "batch", commands: packet.commands });
    const headings = applied.motionGraphics.filter(graphic => /^role-item-\d-label$/u.test(graphic.id));
    for (const graphic of headings) {
      const layout = packet.layouts.find(layout => layout.graphicId === graphic.id)!, motion = graphic.motionV2!;
      const tail = (layout.unitCount - 1) * motion.sequence.staggerFrames;
      expect(tail / project.fps).toBeLessThanOrEqual(.12);
      const start = Math.round(graphic.timelineStart * project.fps);
      const hold = packet.phases.find(phase => phase.role === "hold" && phase.startFrame >= start
        && phase.endFrame <= Math.round((graphic.timelineStart + graphic.duration) * project.fps))!;
      const entries = packet.bindings.filter(binding => binding.startFrame >= start && binding.startFrame < hold.endFrame);
      for (const binding of entries) {
        const current = packet.layouts.find(layout => layout.graphicId === binding.graphic.id)!;
        const m = binding.graphic.motionV2!;
        expect(hold.startFrame).toBeGreaterThanOrEqual(binding.startFrame + Math.max(m.entrance.durationFrames
          + (current.unitCount - 1) * m.sequence.staggerFrames, binding.graphic.vectorV2?.revealFrames ?? 1));
      }
    }
    expect(compileGraphicCadence(30, 1, "brisk").staggerFrames(8)).toBe(0);
    expect(Object.isFrozen(GRAPHIC_CADENCE_CONTRACT)).toBe(true);
  });

  it("retains exact canonical commands and phases for omitted and explicit legacy without a raw default", () => {
    const project = fixture();
    for (const templateId of ["strike_reframe", "level_bridge", "comparison_pair", "context_stack", "evidence_takeover", "focus_wall", "brand_recap", "kinetic_network"] as const) {
      const omitted = input(project, templateId); delete omitted.graphicCadence;
      expect(referenceMotionTemplateInputSchema.parse(omitted)).not.toHaveProperty("graphicCadence");
      const before = compile(project, omitted), explicit = compile(project, { ...omitted, graphicCadence: "legacy" });
      expect(canonicalJson(explicit)).toBe(canonicalJson(before));
      expect(before).not.toHaveProperty("graphicCadence");
      expect(compileGraphicCadence(30, 1).entranceFrames).toBe(10);
      expect(compileGraphicCadence(30, 1, "legacy").exitFrames).toBe(5);
    }
  });

  it("retains unscaled reading minima and rejects insufficient copy or grouped network holds at faster speed", () => {
    const project = fixture(); project.tracks[0].clips[0].duration = 3;
    const value = input(project, "level_bridge"); value.title = "FOCUS".repeat(6); value.style!.animationSpeed = 2;
    expect(() => compile(project, value)).toThrow(/閱讀停留/);
    const network = fixture(); network.tracks[0].clips[0].duration = 8;
    const grouped = input(network, "kinetic_network");
    grouped.items = [{ label: "SOURCE", detail: "READ".repeat(10) }, { label: "FOCUS", detail: "READ".repeat(10) }, { label: "RETURN", detail: "READ".repeat(10) }];
    expect(() => compile(network, grouped)).toThrow(/閱讀停留/);
    const short = compileGraphicCadence(30, 2, "brisk");
    expect(short.returnHoldFrames).toBe(20);
    expect(Math.ceil((.65 + 30 / 8) * 30)).toBe(132);
  });

  it("rejects unknown cadence invalid fps speed units and missing physical generation before authoring", () => {
    for (const fps of [0, -1, NaN, Infinity, 241]) expect(() => compileGraphicCadence(fps, 1, "brisk")).toThrow(/fps/);
    for (const speed of [0, .49, 2.01, NaN, Infinity]) expect(() => compileGraphicCadence(30, speed, "brisk")).toThrow(/speed/);
    expect(() => compileGraphicCadence(30, 1, "fast" as GraphicCadenceProfile)).toThrow(/profile/);
    for (const units of [0, 129, 1.5, Infinity]) expect(() => compileGraphicCadence(30, 1, "brisk").staggerFrames(units)).toThrow(/unit count/);
    const project = fixture(), before = canonicalJson(project), value = input(project, "level_bridge"), allocate = vi.fn(() => "never");
    expect(() => buildReferenceMotionTemplateCommands(project, value, allocate)).toThrow(/generation 2.*physical/);
    const provider = vi.fn(physical(project).layoutForGraphic);
    expect(() => compile(project, { ...value, graphicCadence: "fast" } as unknown as ReferenceMotionTemplateInput,
      { generation: 2, layoutForGraphic: provider })).toThrow();
    expect(provider).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    expect(canonicalJson(project)).toBe(before);
  });
});

const KINETIC_TEMPLATES: ReferenceMotionTemplateId[] = ["strike_reframe", "level_bridge", "comparison_pair", "context_stack",
  "evidence_takeover", "focus_wall", "brand_recap", "kinetic_network"];

describe("physical reference Motion kinetic (Motion Language) cadence", () => {
  it.each(KINETIC_TEMPLATES)("compiles %s with a monotone expo-out glide, centered scale and unchanged source clocks", (templateId) => {
    const project = fixture(), before = canonicalJson(project), value = input(project, templateId, "kinetic");
    const kinetic = compile(project, value), brisk = compile(project, { ...value, graphicCadence: "brisk" });
    expect(canonicalJson(project)).toBe(before);
    expect(kinetic).toMatchObject({ schema: "editkin.reference-motion-template/v2", graphicCadence: "kinetic", status: "REVIEW_REQUIRED" });
    expect(kinetic.roles).toEqual(brisk.roles);
    const applied = applyCommand(project, { type: "batch", commands: kinetic.commands });
    expect(clocks(applied)).toEqual(clocks(applyCommand(project, { type: "batch", commands: brisk.commands })));
    const moving = applied.motionGraphics.filter(graphic => !graphic.vectorV2 && graphic.motionV2!.entrance.durationFrames > 1);
    expect(moving.length).toBeGreaterThan(0);
    for (const graphic of applied.motionGraphics) expect(graphic.motionV2!.sequence.scaleOrigin).toBe("center");
    for (const graphic of moving) {
      const motion = graphic.motionV2!, layout = kinetic.layouts.find(row => row.graphicId === graphic.id)!;
      expect(motion.entrance.easing).toEqual(MOTION_CURVES.expoOut);
      expect(motion.entrance).not.toHaveProperty("blurPixels");
      const start = Math.round(graphic.timelineStart * project.fps);
      const tail = Math.max(0, layout.unitCount - 1) * motion.sequence.staggerFrames;
      const settled = motionGraphicV2FrameReceipt(applied, graphic, start + motion.entrance.durationFrames - 1 + tail, layout);
      expect(settled.segments.every(state => state.opacity === 1 && Math.abs(state.translateXPixels) < 1e-6 && Math.abs(state.translateYPixels) < 1e-6)).toBe(true);
      const hold = Math.round(graphic.duration * project.fps) - motion.entrance.durationFrames - motion.exit.durationFrames - 2 * tail;
      expect(hold).toBeGreaterThanOrEqual(Math.ceil((.65 + [...graphic.text].length / 8) * project.fps));
    }
  });

  it("glides longer than brisk while the perceived attack stays early, and staggers instead of zeroing", () => {
    const kinetic = compileGraphicCadence(30, 1, "kinetic"), brisk = compileGraphicCadence(30, 1, "brisk");
    expect(kinetic.profile).toBe("kinetic");
    expect(kinetic.entranceFrames).toBeGreaterThan(brisk.entranceFrames);
    expect(kinetic.staggerFrames(6)).toBe(2);
    expect(brisk.staggerFrames(6)).toBe(0);
    expect(kinetic.staggerFrames(16)).toBe(1);
    const attack = Array.from({ length: kinetic.entranceFrames }, (_, frame) => frame).find(frame =>
      evaluateMotionGraphicV2Easing(frame / (kinetic.entranceFrames - 1), MOTION_CURVES.expoOut) >= .88)!;
    expect(attack).toBeLessThanOrEqual(5);
  });

  it("amplifies authored travel without changing brisk or legacy geometry", () => {
    const project = fixture(), value = input(project, "strike_reframe");
    const brisk = compile(project, value), kinetic = compile(project, { ...value, graphicCadence: "kinetic" });
    const offsets = (packet: ReturnType<typeof compile>) => packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : [])
      .filter(graphic => !graphic.vectorV2).map(graphic => Math.abs(graphic.motionV2!.entrance.offsetYPixels) + Math.abs(graphic.motionV2!.exit.offsetXPixels));
    expect(Math.max(...offsets(kinetic))).toBeGreaterThan(Math.max(...offsets(brisk)) * 2.5);
    expect(brisk.commands.every(command => command.type !== "add_motion_graphic" || command.graphic.motionV2?.sequence.scaleOrigin === undefined)).toBe(true);
  });
});

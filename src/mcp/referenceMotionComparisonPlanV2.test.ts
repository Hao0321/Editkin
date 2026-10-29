import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { canonicalJson } from "../shared/canonicalJson";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "../application/referenceMotionTemplateInstances";
import { referenceMotionRequestedIndexes, type ReferenceMotionPlan } from "../application/referenceMotionPlan";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { verifyReferenceMotionPlan } from "./referenceMotionPlanVerification";

async function created() {
  const project = createEmptyProject("Synthetic soft comparison verification", { id: "soft-v4-source", width: 1080, height: 1920, fps: 30 });
  project.assets = [
    { id: "landscape", name: "Synthetic landscape metadata", kind: "video", uri: "D:/synthetic/soft-v4-landscape.mp4", duration: 20,
      width: 640, height: 360, displayAspectRatio: 16 / 9, color: { interpretation: "rec709" } },
    { id: "square", name: "Synthetic square metadata", kind: "video", uri: "D:/synthetic/soft-v4-square.mp4", duration: 20,
      width: 480, height: 480, displayAspectRatio: 1, color: { interpretation: "rec709" } },
  ];
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "landscape", timelineStart: 0,
    sourceStart: 2, duration: 12, volume: .7, keyframes: [], transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR } }];
  const input: ReferenceMotionTemplateInput = { templateId: "comparison_pair", clipId: "primary", startFrame: 0, durationFrames: 360,
    title: "保留原片", primaryLabel: "原片", sources: [{ assetId: "square", sourceStart: 3, label: "對照" }], intent: "standalone_showcase",
    purpose: "Synthetic trusted source-aware comparison compilation; no artwork acceptance", evidenceRefs: ["synthetic:soft-comparison-control"],
    style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) };
  let ordinal = 0;
  const idFactory = (prefix: string, key?: string) => `${prefix}-${key?.replaceAll(":", "-")}-${ordinal++}`;
  const prepared = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateInstance(project, input, idFactory, deps));
  const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: prepared.instance.id,
    mode: "create", commandIndexes: prepared.commands.map((_, index) => index) }] };
  return { project, input, idFactory, prepared, declaration };
}

describe("trusted v4 saved comparison source soft v2 recompilation", () => {
  it("recompiles complete physical soft creation without changing source and preserves primary audio", async () => {
    const f = await created(), before = canonicalJson(f.project);
    expect(f.prepared.instance.input.mediaPresentation).toBe("source_soft_v2");
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, f.prepared.commands)).resolves.toMatchObject({ instanceCount: 1 });
    expect(canonicalJson(f.project)).toBe(before);
    const final = applyCommand(f.project, { type: "batch", commands: f.prepared.commands });
    expect(final.tracks[0].clips[0]).toMatchObject({ id: "primary", assetId: "landscape", sourceStart: 2, duration: 12, volume: .7,
      floatingFrame: { schema: "editkin.floating-video-frame/v2", aspect: "source", mediaFit: "contain" } });
    expect(final.tracks.flatMap(track => track.clips).find(clip => clip.assetId === "square")).toMatchObject({ sourceStart: 3, duration: 12, volume: 0 });
    expect(f.prepared.physicalLayoutBindings.every(binding => binding.physicalFont.faceId.includes("noto-"))).toBe(true);
  });
  it("recompiles declared text palette revision while retaining measured frames IDs source clocks and user primary gain", async () => {
    const f = await created(), current = applyCommand(f.project, { type: "batch", commands: f.prepared.commands });
    current.tracks[0].clips[0].volume = .31;
    const patch = { title: "素材對照", style: { palette: { accent: "#0B3B95" } } };
    const revised = await withReferenceMotionPhysicalFonts(deps => prepareReferenceMotionTemplateRevision(current, f.prepared.instance.id, patch,
      { ...deps, expectedInstanceRevision: 1, idFactory: f.idFactory }));
    if (revised.status === "UNCHANGED") throw new Error("Control requires changed physical text");
    const declaration: ReferenceMotionPlan = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: f.prepared.instance.id,
      mode: "revise", expectedInstanceRevision: 1, patch, commandIndexes: revised.commands.map((_, index) => index) }] };
    await expect(verifyReferenceMotionPlan(declaration, current, revised.commands)).resolves.toMatchObject({ instanceCount: 1 });
    const final = applyCommand(current, { type: "batch", commands: revised.commands });
    expect(revised.instance.roles).toEqual(f.prepared.instance.roles);
    const shape = (project: typeof current) => project.tracks.flatMap(track => track.clips).map(clip => ({ id: clip.id, assetId: clip.assetId,
      sourceStart: clip.sourceStart, timelineStart: clip.timelineStart, duration: clip.duration, volume: clip.volume, floatingFrame: clip.floatingFrame }));
    expect(shape(final)).toEqual(shape(current)); expect(final.tracks[0].clips[0].volume).toBe(.31);
  });
  it("rejects forged primary soft geometry despite valid declaration metadata and unchanged indexes", async () => {
    const f = await created(), commands = structuredClone(f.prepared.commands);
    const target = commands.find(command => command.type === "set_clip_floating_frame");
    if (!target || target.type !== "set_clip_floating_frame" || !target.frame) throw new Error("Control requires the actual primary soft command");
    target.frame.centerX = (target.frame.centerX ?? .5) + .001;
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });
  it("rejects forged generated source frame instead of trusting saved role metadata", async () => {
    const f = await created(), commands = structuredClone(f.prepared.commands);
    const target = commands.find(command => command.type === "add_clip" && command.clip.assetId === "square");
    if (!target || target.type !== "add_clip" || !target.clip.floatingFrame) throw new Error("Control requires the actual generated soft source");
    target.clip.floatingFrame.centerY = (target.clip.floatingFrame.centerY ?? .5) + .001;
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });
  it("rejects unmuting the generated secondary source despite unchanged visual commands", async () => {
    const f = await created(), commands = structuredClone(f.prepared.commands);
    const target = commands.find(command => command.type === "add_clip" && command.clip.assetId === "square");
    if (!target || target.type !== "add_clip") throw new Error("Control requires the actual generated secondary source");
    target.clip.volume = .5;
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, commands)).rejects.toThrow(/independently recompiled/);
  });
  it("rejects full soft creation without its exact current compiler declaration", async () => {
    const f = await created();
    expect(() => referenceMotionRequestedIndexes(undefined, f.prepared.commands)).toThrow(/declaration/);
    await expect(verifyReferenceMotionPlan(undefined, f.project, f.prepared.commands)).rejects.toThrow(/declaration/);
  });
  it("rejects a later outside float write that drifts the trusted compiled instance", async () => {
    const f = await created(), actual = f.prepared.commands.find(command => command.type === "set_clip_floating_frame");
    if (!actual || actual.type !== "set_clip_floating_frame" || !actual.frame) throw new Error("Control requires the actual soft frame");
    const frame = structuredClone(actual.frame); frame.centerX = (frame.centerX ?? .5) + .001;
    await expect(verifyReferenceMotionPlan(f.declaration, f.project, [...f.prepared.commands,
      { type: "set_clip_floating_frame", clipId: "primary", frame }])).rejects.toThrow(/Later plan/);
  });
});

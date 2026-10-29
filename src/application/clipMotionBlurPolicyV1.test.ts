import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { createClipMask } from "../domain/masks";
import { createTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import type { NativeEffectInstance } from "../domain/types";
import { motionClipPresetCommands, MOTION_CLIP_PRESETS } from "../motion/motionClipPresets";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { CLIP_MOTION_BLUR_RECIPES_V1, CLIP_MOTION_BLUR_POLICY_V1, planClipMotionWithBlurV1 } from "./clipMotionBlurPolicyV1";
const capabilities = { gpuCompositorAvailable: true, colorWindowAttached: false };
const gpu = (id: string): NativeEffectInstance => ({ id, pluginId: "creator.gpu", capabilityId: "gain", pluginVersion: "1.0.0", manifestSha256: "a".repeat(64), runtimeType: "gpu_effect_graph", enabled: true, parameters: { gain: .8 } });
describe("opt-in blur policy beside frozen clip motion presets", () => {
  it.each(MOTION_CLIP_PRESETS.map(p => p.id))("preserves all old commands exactly when default-off: %s", preset => {
    const p = createDemoProject(), before = structuredClone(p), clip = p.tracks[0].clips[0];
    const plan = planClipMotionWithBlurV1(p, clip.id, preset);
    expect(plan.command.commands).toEqual(motionClipPresetCommands(clip, p.fps, preset, { projectWidth: p.width, projectHeight: p.height }));
    expect(plan).toMatchObject({ blurAction: "unchanged", enabledByDefault: false, certification: "pending", vaDefaultEligible: false });
    expect(p).toEqual(before);
  });
  it.each(CLIP_MOTION_BLUR_RECIPES_V1)("adds one 180deg/8 blur with all keyframes in one Undo/Redo: %s", preset => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0];
    const plan = planClipMotionWithBlurV1(p, clip.id, preset, { addMotionBlur: true, capabilities });
    const h = dispatchCommand(createHistory(p), plan.command, "instrument-blur");
    expect(h.past).toHaveLength(1);
    expect(h.present.tracks[0].clips[0].keyframes).not.toHaveLength(0);
    expect(h.present.tracks[0].clips[0].creative?.nativeEffectInstances).toEqual([createTransformMotionBlurInstance()]);
    expect(undo(h).present).toEqual(p); expect(redo(undo(h)).present).toEqual(h.present);
    const reopened = decodeProjectBytes(encodeProjectBytes(h.present));
    expect(reopened).toEqual(parseProject(h.present)); expect(reopened.tracks).toEqual(h.present.tracks);
  });
  it("preserves existing disabled user parameters, moves it last and enables without duplicates", () => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0], blur = { ...createTransformMotionBlurInstance(), enabled: false, parameters: { shutter_angle: 90, samples: 4 } };
    clip.creative = { effectPresetIds: [], nativeEffectInstances: [blur, gpu("second")] };
    const plan = planClipMotionWithBlurV1(p, clip.id, "whip_in", { addMotionBlur: true, capabilities });
    const result = dispatchCommand(createHistory(p), plan.command).present.tracks[0].clips[0];
    expect(plan.blurAction).toBe("reenabled");
    expect(result.creative?.nativeEffectInstances).toEqual([gpu("second"), { ...blur, enabled: true }]);
    expect(clip.creative.nativeEffectInstances?.[0]).toEqual(blur);
  });
  it("retains an enabled custom blur without adding or overwriting it", () => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0], blur = { ...createTransformMotionBlurInstance(), parameters: { shutter_angle: 270, samples: 6 } };
    clip.creative = { effectPresetIds: [], nativeEffectInstances: [gpu("first"), blur] };
    const plan = planClipMotionWithBlurV1(p, clip.id, "snap_zoom", { addMotionBlur: true, capabilities });
    expect(plan.blurAction).toBe("already-enabled"); expect(plan.command.commands.every(c => c.type === "add_keyframe")).toBe(true);
    expect(dispatchCommand(createHistory(p), plan.command).present.tracks[0].clips[0].creative).toEqual(clip.creative);
  });
  it("default-off does not remove or silently enable a saved disabled blur", () => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0], blur = { ...createTransformMotionBlurInstance(), enabled: false };
    clip.creative = { effectPresetIds: [], nativeEffectInstances: [blur] };
    const plan = planClipMotionWithBlurV1(p, clip.id, "punch_in");
    expect(dispatchCommand(createHistory(p), plan.command).present.tracks[0].clips[0].creative?.nativeEffectInstances).toEqual([blur]);
  });
  it.each(["float_in", "slow_push", "gallery_drift", "chapter_snap", "push_settle", "drift_push"] as const)("does not add uncertified blur to an unapproved recipe: %s", preset => {
    const p = createDemoProject(), before = structuredClone(p);
    expect(() => planClipMotionWithBlurV1(p, "clip-demo", preset, { addMotionBlur: true, capabilities })).toThrow("MOTION_BLUR_RECIPE_NOT_APPROVED"); expect(p).toEqual(before);
  });
  it.each(["mask", "window", "aces", "gpu", "unknown", "clock", "cpu", "full", "locked", "template"])("refuses %s without changes", kind => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0], caps = { ...capabilities };
    if (kind === "mask") clip.masks = [createClipMask("mask", "rectangle")];
    if (kind === "window") caps.colorWindowAttached = true;
    if (kind === "aces") p.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
    if (kind === "gpu") caps.gpuCompositorAvailable = false;
    if (kind === "clock") clip.speed = 2;
    if (kind === "cpu") clip.creative = { effectPresetIds: [], nativeEffectInstances: [{ ...gpu("cpu"), runtimeType: "native_effect" }] };
    if (kind === "full") clip.creative = { effectPresetIds: [], nativeEffectInstances: [1, 2, 3, 4].map(n => gpu(`gpu-${n}`)) };
    if (kind === "locked") p.tracks[0].locked = true;
    if (kind === "template") p.templateApplication = { generatedClips: [{ clipId: clip.id }] } as NonNullable<typeof p.templateApplication>;
    const before = structuredClone(p);
    expect(() => planClipMotionWithBlurV1(p, clip.id, "whip_in", { addMotionBlur: true, capabilities: kind === "unknown" ? undefined : caps })).toThrow(kind === "locked" ? TRACK_LOCKED_MESSAGE : /MOTION_BLUR/);
    expect(p).toEqual(before);
  });
  it("chooses a unique effect id without changing an unrelated saved instance", () => {
    const p = createDemoProject(), clip = p.tracks[0].clips[0], existing = gpu("builtin-transform-motion-blur");
    clip.creative = { effectPresetIds: [], nativeEffectInstances: [existing] };
    const plan = planClipMotionWithBlurV1(p, clip.id, "whip_in", { addMotionBlur: true, capabilities });
    const stack = dispatchCommand(createHistory(p), plan.command).present.tracks[0].clips[0].creative!.nativeEffectInstances!;
    expect(stack[0]).toEqual(existing); expect(stack[1].id).toBe("builtin-transform-motion-blur-1");
  });
  it("keeps policy explicitly off, uncertified and unavailable to VA defaults", () => {
    expect(CLIP_MOTION_BLUR_POLICY_V1).toMatchObject({ enabledByDefault: false, certification: "pending", vaDefaultEligible: false, shutterAngle: 180, samples: 8 });
  });
});

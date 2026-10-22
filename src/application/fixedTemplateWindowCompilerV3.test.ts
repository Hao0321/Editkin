import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { animatedClipState, createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { resolveMaskPath } from "../domain/masks";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { DEFAULT_GRAPHIC_TIMING_V2 } from "../domain/graphicTimingV2";
import { REFERENCE_MOTION_DESIGN_THEMES, referenceMotionTemplateInputSchema, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { prepareReferenceMotionTemplateInstance, inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  referenceMotionTemplateRevisionCommandContext, prepareReferenceMotionTemplateFollow } from "./referenceMotionTemplateInstances";
import { prepareReferenceMotionTemplateReuse } from "./referenceMotionTemplateReuse";
import { prepareReferenceMotionTemplateSourceReplacement, referenceMotionSourceReplacementCommandContext } from "./referenceMotionSourceTransaction";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";
import { AUTOPILOT_MAX_PLAN_BYTES } from "./autopilotPlan";
import { compileFixedTemplateWindowMaskV3 } from "./fixedTemplateWindowV3";
import { fixedTemplateWindowKeyRevisionV3 } from "./fixedTemplateWindowRevisionV3";

const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
const prepareText = async (faceId: string, text: string) => {
  if (!faces.has(faceId)) faces.set(faceId, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile))
    .then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))));
  return (await faces.get(faceId)!)(text);
};
const choice = { schema: "editkin.fixed-template-window/v3" as const, peakScale: 1.096 };
let serial = 0;
const id = (prefix: string) => `fixed-window-${prefix}-${++serial}`;
function fixture(): EditProject {
  const p = parseProject(createEmptyProject("Fixed window themed compiler", { id: "fixed-themed", width: 1080, height: 1920, fps: 30 }));
  p.assets.push({ id: "source", name: "Source metadata", kind: "video", uri: "D:/owned/fixed-source.mp4", duration: 80,
    width: 1080, height: 1920, displayAspectRatio: 9/16, color: { interpretation: "rec709" } });
  p.assets.push({ ...p.assets[0], id: "replacement", uri: "D:/owned/fixed-replacement.mp4" });
  p.tracks[0].clips.push({ id: "main", trackId: p.tracks[0].id, assetId: "source", timelineStart: 1, sourceStart: 2, duration: 18, volume: .35,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, expressions: {}, keyframes: [] });
  p.tracks[0].clips.push({ ...structuredClone(p.tracks[0].clips[0]), id: "reuse", assetId: "replacement", timelineStart: 22 });
  return p;
}
function input(theme: keyof typeof REFERENCE_MOTION_DESIGN_THEMES = "swiss_blue_v1"): ReferenceMotionTemplateInput {
  return { templateId: "level_bridge", clipId: "main", startFrame: 30, durationFrames: 540, title: "測試", sources: [],
    designSystem: theme, graphicCadence: "kinetic", fixedWindowV3: choice,
    intent: "shortform", purpose: "Owned fixed window engineering", evidenceRefs: ["fixture:owned-window"],
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 } };
}
const clocks = (p: EditProject) => p.tracks.flatMap(t => t.clips).map(c => ({ id: c.id, assetId: c.assetId,
  sourceStart: c.sourceStart, timelineStart: c.timelineStart, duration: c.duration, volume: c.volume }));

describe("explicit fixed-window themed compiler v3", () => {
  it.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as Array<keyof typeof REFERENCE_MOTION_DESIGN_THEMES>)(
    "keeps %s artwork/source clocks while actually pushing and returning inside its compact fixed window", async theme => {
      const p = fixture(), original = encodeProjectBytes(p), packet = await prepareReferenceMotionTemplateInstance(p, input(theme), id, { prepareText });
      expect(encodeProjectBytes(p)).toEqual(original);
      const next = applyCommand(p, { type: "batch", commands: packet.commands }), clip = next.tracks[0].clips[0], mask = clip.masks![0];
      expect(mask.fixedWindowV3?.schema).toBe(choice.schema); expect(mask.keyframes).toHaveLength(0);
      expect(clocks(next)).toEqual(clocks(p));
      expect(Math.max(...clip.keyframes.map(k => k.transform.scale))).toBe(choice.peakScale);
      expect(animatedClipState(clip, mask.fixedWindowV3!.fromFrame!/30, 30).transform).toEqual(DEFAULT_TRANSFORM);
      expect(animatedClipState(clip, clip.duration - 1/30, 30).transform).toEqual(DEFAULT_TRANSFORM);
      const materialized = compileFixedTemplateWindowMaskV3(next, clip, mask);
      const operation = compileClipAlphaPlan(next, clip).operations[0]; if (operation.source !== "vector") throw new Error("Expected vector window");
      expect(operation.samples).toHaveLength(540);
      for (let frame = 0; frame < 540; frame++) {
        expect(operation.samples[frame].points).toEqual(materialized.keyframes[frame].points);
        expect(resolveMaskPath(next, clip, mask, frame/30).points).toEqual(materialized.keyframes[frame].points);
      }
      expect(Buffer.byteLength(JSON.stringify(packet.commands))).toBeLessThan(AUTOPILOT_MAX_PLAN_BYTES);
      const reopened = decodeProjectBytes(encodeProjectBytes(next));
      expect((await inspectReferenceMotionTemplateInstance(reopened, packet.instance.id)).status).toBe("CURRENT");
    }, 30_000);

  it("composes after graphic timing and updates the same owner with one Undo/Redo and exact return to the old version", async () => {
    const p = fixture(), { fixedWindowV3: _window, ...legacy } = input();
    const saved = await prepareReferenceMotionTemplateInstance(p, legacy, id, { prepareText });
    const before = applyCommand(p, { type: "batch", commands: saved.commands });
    const patch = { fixedWindowV3: choice, graphicTimingV2: { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 2 } };
    const changed = await prepareReferenceMotionTemplateRevision(before, saved.instance.id, patch,
      { prepareText, idFactory: id, expectedInstanceRevision: 1 });
    const history = dispatchCommand(createHistory(before), { type: "batch", commands: changed.commands }, "fixed-window-revision", referenceMotionTemplateRevisionCommandContext(changed));
    expect(undo(history).present).toEqual(before); expect(redo(undo(history)).present).toEqual(history.present);
    expect((await inspectReferenceMotionTemplateInstance(history.present, saved.instance.id)).status).toBe("CURRENT");
    const clip = history.present.tracks[0].clips[0];
    expect(clip.keyframes.find(k => k.transform.scale === choice.peakScale)).toBeDefined();
    expect(clocks(history.present)).toEqual(clocks(before));
    const reverted = await prepareReferenceMotionTemplateRevision(history.present, saved.instance.id, { fixedWindowV3: null, graphicTimingV2: null },
      { prepareText, idFactory: id, expectedInstanceRevision: 2 });
    const restored = applyCommand(history.present, { type: "batch", commands: reverted.commands });
    expect(restored.tracks[0].clips[0].masks).toEqual(before.tracks[0].clips[0].masks);
    expect(restored.tracks[0].clips[0].keyframes).toEqual(before.tracks[0].clips[0].keyframes);
    expect(restored.motionGraphics).toEqual(before.motionGraphics);
  }, 30_000);

  it("carries the explicit version into reuse, source replacement and ordinary trim with CURRENT owners", async () => {
    const p = fixture(), packet = await prepareReferenceMotionTemplateInstance(p, input(), id, { prepareText });
    const saved = applyCommand(p, { type: "batch", commands: packet.commands });
    const reused = await prepareReferenceMotionTemplateReuse(saved, { sourceInstanceId: packet.instance.id, expectedInstanceRevision: 1,
      expectedProjectRevision: saved.revision, targetClipId: "reuse", sources: [], purpose: "Owned reuse", evidenceRefs: ["fixture:reuse"] }, id, { prepareText });
    const withReuse = applyCommand(saved, { type: "batch", commands: reused.commands });
    expect(reused.instance.input.fixedWindowV3).toEqual(choice);
    expect((await inspectReferenceMotionTemplateInstance(withReuse, reused.instance.id)).status).toBe("CURRENT");
    const replacement = await prepareReferenceMotionTemplateSourceReplacement(saved, { instanceId: packet.instance.id, expectedInstanceRevision: 1,
      expectedProjectRevision: saved.revision, primary: { assetId: "replacement", sourceStart: 3 }, durationFrames: 480,
      sources: [], audio: { primary: "keep_level", extra: [] }, focusRegion: null, textRegion: null, evidenceRefs: ["fixture:fresh-replacement"] }, id, { prepareText });
    const replaced = applyCommand(saved, { type: "batch", commands: replacement.commands }, referenceMotionSourceReplacementCommandContext(saved, replacement));
    expect(replacement.instance.input.fixedWindowV3).toEqual(choice);
    expect((await inspectReferenceMotionTemplateInstance(replaced, packet.instance.id)).status).toBe("CURRENT");
    const follow = await prepareReferenceMotionTemplateFollow(replaced, packet.instance.id, [{ type: "trim_clip_end", clipId: "main", seconds: 1 }],
      { prepareText, idFactory: id, expectedInstanceRevision: 2 });
    const trimmed = applyCommand(replaced, { type: "batch", commands: follow.commands });
    expect((await inspectReferenceMotionTemplateInstance(trimmed, packet.instance.id)).status).toBe("CURRENT");
  }, 30_000);

  it("independently recompiles a v4 revision and refuses a forged mask marker or camera scale", async () => {
    const p = fixture(), { fixedWindowV3: _window, ...legacy } = input();
    const packet = await prepareReferenceMotionTemplateInstance(p, legacy, id, { prepareText });
    const saved = applyCommand(p, { type: "batch", commands: packet.commands });
    const changed = await prepareReferenceMotionTemplateRevision(saved, packet.instance.id, { fixedWindowV3: choice },
      { prepareText, idFactory: id, expectedInstanceRevision: 1 });
    const declaration = { schema: "editkin.reference-motion-plan/v1" as const, instances: [{ instanceId: packet.instance.id, mode: "revise" as const,
      expectedInstanceRevision: 1, patch: { fixedWindowV3: choice }, commandIndexes: changed.commands.map((_, index) => index) }] };
    expect((await verifyReferenceMotionPlan(declaration, saved, changed.commands)).instanceCount).toBe(1);
    for (const forgery of ["mask", "camera"]) {
      const forged = structuredClone(changed.commands);
      if (forgery === "mask") {
        const c = forged.find(c => c.type === "update_clip_mask"); if (c?.type !== "update_clip_mask") throw new Error("No fixed mask"); delete c.patch.fixedWindowV3;
      } else {
        const c = forged.find(c => c.type === "add_keyframe" && c.keyframe.transform.scale > 1);
        if (c?.type !== "add_keyframe") throw new Error("No push pose"); c.keyframe.transform.scale = 1.2;
      }
      await expect(verifyReferenceMotionPlan(declaration, saved, forged)).rejects.toThrow();
    }
  }, 30_000);

  it("has no default selection and refuses incompatible family/presentation and invalid scale", () => {
    const { fixedWindowV3: _window, ...legacy } = input();
    expect(referenceMotionTemplateInputSchema.parse(legacy).fixedWindowV3).toBeUndefined();
    for (const patch of [{ templateId: "brand_recap" }, { designSystem: undefined }, { graphicPresentation: "native_paint_v1" },
      { fixedWindowV3: { ...choice, peakScale: 1 } }, { fixedWindowV3: { ...choice, peakScale: 2 } }]) {
      expect(referenceMotionTemplateInputSchema.safeParse({ ...input(), ...patch }).success).toBe(false);
    }
  });

  it("also keeps the authored entrance poses for a standalone scene", async () => {
    const p = fixture(), { fixedWindowV3: _window, ...legacy } = { ...input(), intent: "standalone_showcase" as const };
    const old = await prepareReferenceMotionTemplateInstance(p, legacy, id, { prepareText });
    const next = await prepareReferenceMotionTemplateInstance(p, { ...legacy, fixedWindowV3: choice }, id, { prepareText });
    const oldPoses = old.commands.flatMap(c => c.type === "add_keyframe" ? [c.keyframe] : []);
    const newPoses = next.commands.flatMap(c => c.type === "add_keyframe" ? [c.keyframe] : []);
    expect(oldPoses.length).toBeGreaterThan(1);
    expect(newPoses.map(k => ({ time: k.time, transform: k.transform })).slice(0, oldPoses.length))
      .toEqual(oldPoses.map(k => ({ time: k.time, transform: k.transform })));
    const applied = applyCommand(p, { type: "batch", commands: next.commands }), clip = applied.tracks[0].clips[0], mask = clip.masks![0];
    expect(resolveMaskPath(applied, clip, mask, 0).points).toEqual(mask.path);
  }, 30_000);

  it("refuses extra keyframe topology, cross-clip roles and conflicting animated or pixel mattes", async () => {
    const p = fixture(), packet = await prepareReferenceMotionTemplateInstance(p, input(), id, { prepareText });
    const saved = applyCommand(p, { type: "batch", commands: packet.commands });
    const role = packet.instance.roles.find(r => r.key.endsWith(":fixed-window-v3:peak"))!;
    expect(fixedTemplateWindowKeyRevisionV3(p, packet.instance, saved, role, "add")?.type).toBe("add_keyframe");
    for (const patch of [{ parentId: "reuse" }, { key: "source:0:clip:fixed-window-v3:arbitrary" }, { id: "missing" }, { kind: "mask" as const }]) {
      expect(fixedTemplateWindowKeyRevisionV3(p, packet.instance, saved, { ...role, ...patch }, "add")).toBeUndefined();
    }
    const clip = saved.tracks[0].clips[0], mask = clip.masks![0];
    for (const patch of [{ trackId: "missing" }, { keyframes: [{ frame: 0, time: 0, points: mask.path, status: "manual" as const, confidence: 1 }] },
      { frozenRange: { fromFrame: 0, toFrame: 1 } }, { fixedWindowV3: { schema: choice.schema, fromFrame: 0, toFrame: 999 } }]) {
      const invalid = { ...structuredClone(clip), masks: [{ ...structuredClone(mask), ...patch }] };
      expect(() => compileClipAlphaPlan(saved, invalid)).toThrow();
      expect(() => resolveMaskPath(saved, invalid, invalid.masks[0], 0)).toThrow();
    }
    const peak = clip.keyframes.find(k => k.transform.scale === choice.peakScale)!;
    const fractionalTime = peak.time - .5/30;
    const resolved = resolveMaskPath(saved, clip, mask, fractionalTime).points;
    const state = animatedClipState(clip, fractionalTime, 30).transform, crop = clip.layout!.crop;
    const centre = { x: crop.x + crop.width/2, y: crop.y + crop.height/2 };
    resolved.forEach((point, i) => {
      expect(centre.x + (point.x-centre.x)*state.scale).toBeCloseTo(mask.path[i].x, 12);
      expect(centre.y + (point.y-centre.y)*state.scale).toBeCloseTo(mask.path[i].y, 12);
    });
  }, 30_000);
});

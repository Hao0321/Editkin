import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GRAPHIC_TIMING_V2 } from "../domain/graphicTimingV2";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { REFERENCE_MOTION_DESIGN_THEMES, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision,
  referenceMotionTemplateRevisionCommandContext } from "./referenceMotionTemplateInstances";
import { prepareReferenceMotionTemplateReuse } from "./referenceMotionTemplateReuse";
import { prepareReferenceMotionTemplateSourceReplacement, referenceMotionSourceReplacementCommandContext } from "./referenceMotionSourceTransaction";
import { prepareReferenceMotionTemplateFollow } from "./referenceMotionTemplateInstances";
import { verifyReferenceMotionPlan } from "../mcp/referenceMotionPlanVerification";

const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
const prepareText = async (id: string, text: string) => {
  if (!faces.has(id)) faces.set(id, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(id).fontFile))
    .then(bytes => preparePhysicalFace(id, new Uint8Array(bytes))));
  return (await faces.get(id)!)(text);
};
function fixture(seconds = 12): EditProject {
  const p = parseProject(createEmptyProject("Timing v2 physical fixture", { id: "timing-test", width: 1080, height: 1920, fps: 30 }));
  p.assets.push({ id: "video", name: "Original", kind: "video", uri: "D:/owned/timing-original.mp4", duration: 60,
    width: 1080, height: 1920, displayAspectRatio: 9/16, color: { interpretation: "rec709" } });
  p.assets.push({ ...p.assets[0], id: "replacement", name: "Replacement", uri: "D:/owned/timing-new.mp4" });
  p.tracks[0].clips.push({ id: "main", assetId: "video", trackId: p.tracks[0].id, timelineStart: 1, sourceStart: 2, duration: seconds, volume: .35,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, expressions: {}, keyframes: [] });
  p.tracks[0].clips.push({ ...structuredClone(p.tracks[0].clips[0]), id: "reuse-target", assetId: "replacement", timelineStart: 20 });
  return p;
}
function input(p: EditProject, theme?: keyof typeof REFERENCE_MOTION_DESIGN_THEMES): ReferenceMotionTemplateInput {
  return { templateId: "level_bridge", clipId: "main", startFrame: 30, durationFrames: Math.round(p.tracks[0].clips[0].duration*30),
    title: "測試", sources: [], intent: "standalone_showcase", purpose: "Own physical timing test", evidenceRefs: ["fixture:timing"],
    ...(theme ? { designSystem: theme, graphicCadence: "kinetic" } : {}),
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 } };
}
let serial = 0;
const id = (prefix: string) => `${prefix}-${++serial}`;
const create = (p: EditProject, theme?: keyof typeof REFERENCE_MOTION_DESIGN_THEMES) =>
  prepareReferenceMotionTemplateInstance(p, input(p, theme), id, { prepareText });
const clocks = (p: EditProject) => p.tracks.flatMap(t => t.clips).map(c => ({ id: c.id, assetId: c.assetId, sourceStart: c.sourceStart,
  timelineStart: c.timelineStart, duration: c.duration, volume: c.volume }));
async function revision(p: EditProject, owner: string, timing = DEFAULT_GRAPHIC_TIMING_V2) {
  return prepareReferenceMotionTemplateRevision(p, owner, { graphicTimingV2: timing },
    { prepareText, idFactory: id, expectedInstanceRevision: p.referenceMotionInstances![0].instanceRevision });
}

describe("physical independent graphic timing v2", () => {
  it("changes the actual three motion clocks independently, with current physical frame receipts and unchanged source/audio", async () => {
    const before = fixture(), saved = await create(before), p = applyCommand(before, { type: "batch", commands: saved.commands });
    const a = await revision(p, saved.instance.id, { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 2 });
    const b = await revision(p, saved.instance.id, { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 4 });
    const fastIn = await revision(p, saved.instance.id, { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 2, entranceSpeed: 2 });
    const fastOut = await revision(p, saved.instance.id, { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 2, exitSpeed: 2 });
    const graphic = (packet: typeof a) => packet.editorialGraphics.find(row => row.message === "測試")!;
    const actual = (packet: typeof a) => applyCommand(p, { type: "batch", commands: packet.commands }, referenceMotionTemplateRevisionCommandContext(packet));
    const ga = actual(a).motionGraphics.find(g => g.id === graphic(a).id)!;
    const gb = actual(b).motionGraphics.find(g => g.id === graphic(b).id)!;
    const gi = actual(fastIn).motionGraphics.find(g => g.id === graphic(fastIn).id)!;
    const go = actual(fastOut).motionGraphics.find(g => g.id === graphic(fastOut).id)!;
    expect(gi.motionV2!.entrance.durationFrames).toBeLessThan(ga.motionV2!.entrance.durationFrames);
    expect(gi.motionV2!.exit).toEqual(ga.motionV2!.exit);
    expect(go.motionV2!.exit.durationFrames).toBeLessThan(ga.motionV2!.exit.durationFrames);
    expect(go.motionV2!.entrance).toEqual(ga.motionV2!.entrance);
    expect(gb.duration).toBeGreaterThan(ga.duration + 1.5);
    const candidate = actual(a), layout = a.layouts.find(l => l.graphicId === ga.id)!;
    const first = Math.round(ga.timelineStart * 30), end = first + Math.round(ga.duration * 30);
    expect(motionGraphicV2FrameReceipt(candidate, ga, first, layout).segments.some(s => s.opacity < 1)).toBe(true);
    expect(motionGraphicV2FrameReceipt(candidate, ga, first + ga.motionV2!.entrance.durationFrames, layout).segments.every(s => s.opacity === 1)).toBe(true);
    expect(motionGraphicV2FrameReceipt(candidate, ga, end - 1, layout).segments.every(s => s.opacity === 0)).toBe(true);
    expect(clocks(candidate)).toEqual(clocks(p));
    expect((await inspectReferenceMotionTemplateInstance(candidate, saved.instance.id)).status).toBe("CURRENT");
    expect((await inspectReferenceMotionTemplateInstance(parseProject(JSON.parse(new TextDecoder().decode(encodeProjectBytes(candidate)))), saved.instance.id)).status).toBe("CURRENT");
  }, 30_000);
  it("keeps one revision/Undo/Redo, restores old timing explicitly, and carries independent controls into reuse", async () => {
    const before = fixture(), saved = await create(before), p = applyCommand(before, { type: "batch", commands: saved.commands });
    const packet = await revision(p, saved.instance.id), batch = { type: "batch" as const, commands: packet.commands };
    const history = dispatchCommand(createHistory(p), batch, "timing-change", referenceMotionTemplateRevisionCommandContext(packet));
    expect(undo(history).present).toEqual(p); expect(redo(undo(history)).present).toEqual(history.present);
    const reverted = await prepareReferenceMotionTemplateRevision(history.present, saved.instance.id, { graphicTimingV2: null },
      { prepareText, idFactory: id, expectedInstanceRevision: 2 });
    const restored = applyCommand(history.present, { type: "batch", commands: reverted.commands });
    expect(restored.motionGraphics).toEqual(p.motionGraphics);
    const reused = await prepareReferenceMotionTemplateReuse(history.present, { sourceInstanceId: saved.instance.id, expectedInstanceRevision: 2,
      expectedProjectRevision: history.present.revision, targetClipId: "reuse-target", sources: [], purpose: "Different owned clip", evidenceRefs: ["fixture:new-source"] }, id, { prepareText });
    const next = applyCommand(history.present, { type: "batch", commands: reused.commands });
    expect(reused.instance.input.graphicTimingV2).toEqual(DEFAULT_GRAPHIC_TIMING_V2);
    expect((await inspectReferenceMotionTemplateInstance(next, reused.instance.id)).status).toBe("CURRENT");
  }, 30_000);
  it.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as Array<keyof typeof REFERENCE_MOTION_DESIGN_THEMES>)("reads graphicCadence for the %s theme without changing its geometry or source", async theme => {
    const before = fixture(18), raw = { ...input(before, theme), graphicTimingV2: { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 2 } };
    const kinetic = await prepareReferenceMotionTemplateInstance(before, raw, id, { prepareText });
    const brisk = await prepareReferenceMotionTemplateInstance(before, { ...raw, graphicCadence: "brisk" }, id, { prepareText });
    const gk = kinetic.commands.flatMap(c => c.type === "add_motion_graphic" && c.graphic.text === "測試" ? [c.graphic] : [])[0];
    const gb = brisk.commands.flatMap(c => c.type === "add_motion_graphic" && c.graphic.text === "測試" ? [c.graphic] : [])[0];
    expect(gk).toBeDefined(); expect(gb).toBeDefined();
    expect(gk.motionV2!.entrance.durationFrames).toBeGreaterThan(gb.motionV2!.entrance.durationFrames);
    expect([gk.x,gk.y,gk.width,gk.textColor,gk.fontSize]).toEqual([gb.x,gb.y,gb.width,gb.textColor,gb.fontSize]);
    const next = applyCommand(before, { type: "batch", commands: kinetic.commands });
    expect(clocks(next).filter(c => c.id === "main" || c.id === "reuse-target")).toEqual(clocks(before));
    expect((await inspectReferenceMotionTemplateInstance(next, kinetic.instance.id)).status).toBe("CURRENT");
  }, 30_000);
  it("rejects an impossible requested hold before applying any partial graph", async () => {
    const before = fixture(3), saved = await create(before), p = applyCommand(before, { type: "batch", commands: saved.commands });
    const unchanged = structuredClone(p);
    await expect(revision(p, saved.instance.id, { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 8 })).rejects.toThrow(/放不下/);
    expect(p).toEqual(unchanged);
  });
  it("takes a longer recap hold from its clean source tail without stretching the footage", async () => {
    const p=fixture(), raw={...input(p),templateId:"brand_recap" as const,overlayPresentation:"source_editorial_v1" as const,
      graphicCadence:"kinetic" as const,kicker:"測試眉題",title:"固定 模板",items:[{label:"1個重點",detail:"1分"},{label:"2個重點",detail:"2分"},{label:"3個重點",detail:"3分"}],
      graphicTimingV2:{...DEFAULT_GRAPHIC_TIMING_V2}};
    const packet=await prepareReferenceMotionTemplateInstance(p,raw,id,{prepareText});
    const next=applyCommand(p,{type:"batch",commands:packet.commands});
    expect(clocks(next)).toEqual(clocks(p));
    expect((await inspectReferenceMotionTemplateInstance(next,packet.instance.id)).status).toBe("CURRENT");
    expect(Math.max(...next.motionGraphics.map(g=>g.timelineStart+g.duration))).toBeLessThan(13);
  });
  it("carries timing through a source replacement and a main-clip trim while both owners remain CURRENT", async () => {
    const before = fixture(), saved = await create(before), initial = applyCommand(before, { type: "batch", commands: saved.commands });
    const changed = await revision(initial, saved.instance.id), p = applyCommand(initial, { type: "batch", commands: changed.commands });
    const request = { instanceId: saved.instance.id, expectedInstanceRevision: 2, expectedProjectRevision: p.revision,
      primary: { assetId: "replacement", sourceStart: 3 }, durationFrames: 240, sources: [], audio: { primary: "keep_level" as const, extra: [] },
      focusRegion: null, textRegion: null, evidenceRefs: ["fixture:fresh-new-source"] };
    const replacement = await prepareReferenceMotionTemplateSourceReplacement(p, request, id, { prepareText });
    const next = applyCommand(p, { type: "batch", commands: replacement.commands }, referenceMotionSourceReplacementCommandContext(p, replacement));
    expect(replacement.instance.input.graphicTimingV2).toEqual(DEFAULT_GRAPHIC_TIMING_V2);
    expect((await inspectReferenceMotionTemplateInstance(next, saved.instance.id)).status).toBe("CURRENT");
    const follow = await prepareReferenceMotionTemplateFollow(next, saved.instance.id,
      [{ type: "trim_clip_end", clipId: "main", seconds: 1 }], { prepareText, idFactory: id, expectedInstanceRevision: 3 });
    const trimmed = applyCommand(next, { type: "batch", commands: follow.commands });
    expect(trimmed.referenceMotionInstances![0].input.graphicTimingV2).toEqual(DEFAULT_GRAPHIC_TIMING_V2);
    expect((await inspectReferenceMotionTemplateInstance(trimmed, saved.instance.id)).status).toBe("CURRENT");
  }, 30_000);
  it.each([false,true])("independently audits the complete timed revision, including native display paint=%s", async native => {
    const before = fixture();
    if (native) before.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
    const raw = { ...input(before), ...(native ? { graphicPresentation: "native_paint_display_v2" as const } : {}) };
    const saved = await prepareReferenceMotionTemplateInstance(before, raw, id, { prepareText });
    const p = applyCommand(before, { type: "batch", commands: saved.commands }), prepared = await revision(p, saved.instance.id);
    const declaration = { schema: "editkin.reference-motion-plan/v1" as const, instances: [{ instanceId: saved.instance.id, mode: "revise" as const,
      expectedInstanceRevision: 1, patch: { graphicTimingV2: DEFAULT_GRAPHIC_TIMING_V2 }, commandIndexes: prepared.commands.map((_,index) => index) }] };
    expect((await verifyReferenceMotionPlan(declaration,p,prepared.commands)).instanceCount).toBe(1);
    const next = applyCommand(p, { type: "batch", commands: prepared.commands }, referenceMotionTemplateRevisionCommandContext(prepared));
    expect((await inspectReferenceMotionTemplateInstance(next, saved.instance.id)).status).toBe("CURRENT");
    const forged = structuredClone(prepared.commands);
    const update = forged.find(c => c.type === "update_motion_graphic")!;
    if (update.type === "update_motion_graphic") update.patch.duration = .5;
    await expect(verifyReferenceMotionPlan(declaration,p,forged)).rejects.toThrow();
  },30_000);
});

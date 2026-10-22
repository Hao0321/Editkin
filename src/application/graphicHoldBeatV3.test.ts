import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GRAPHIC_HOLD_BEAT_V3_CONTRACT, graphicHoldBeatV3Schema, graphicHoldEnvelopeV3Schema, type GraphicHoldBeatV3 } from "../domain/graphicHoldBeatV3";
import { REFERENCE_MOTION_DESIGN_THEMES, type ReferenceMotionDesignSystem, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { graphicPosterFixtureV3, POSTER_FAMILIES_V3 } from "./graphicPosterRangeV3.fixture";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision, inspectReferenceMotionTemplateInstance, referenceMotionTemplateRevisionCommandContext } from "./referenceMotionTemplateInstances";
import { motionGraphicV2FrameReceipt, motionGraphicV2PhysicalLayoutReceipt, prepareMotionGraphicV2FrameLayout } from "../motion/compositionV2";
import { applyGraphicHoldEnvelopeV3 } from "../motion/graphicHoldEnvelopeV3";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { resolveBundledFontFace } from "../typography/fontFaces";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import type { EditProject, MotionGraphic } from "../domain/types";
import type { GraphicHoldBeatReceiptV3 } from "./graphicHoldBeatV3";
import { DEFAULT_GRAPHIC_TIMING_V2 } from "../domain/graphicTimingV2";
import { planClipMoveWithAttachments } from "./timelineMotionEdits";

const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function prepareText(faceId: string, text: string) {
  if (!faces.has(faceId)) faces.set(faceId, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))));
  return (await faces.get(faceId)!)(text);
}
function ids(namespace = "") { let ordinal = 0; return (prefix: string) => `${namespace}${prefix}-${++ordinal}`; }
const posterV3 = { schema: "editkin.graphic-poster-range/v3" as const };
const clock = { holdIndex: 0, fromFraction: .2, peakFraction: .35, toFraction: .5, origin: { x: .5, y: .5 }, peakScale: 1, translateXPixels: 0, translateYPixels: 1 };
type Packet = Awaited<ReturnType<typeof prepareReferenceMotionTemplateInstance>>;
const graphics = (packet: Packet) => packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : []);
const info = (packet: Packet) => (packet as Packet & { graphicHoldBeatV3Receipt: GraphicHoldBeatReceiptV3 }).graphicHoldBeatV3Receipt;
function choice(project: EditProject, packet: Packet): GraphicHoldBeatV3 {
  const hold = packet.phases.filter(phase => phase.role === "hold" && phase.endFrame > phase.startFrame).sort((a, b) => a.startFrame - b.startFrame)[0];
  const from = hold.startFrame + Math.round((hold.endFrame - 1 - hold.startFrame) * clock.fromFraction);
  const to = hold.startFrame + Math.round((hold.endFrame - 1 - hold.startFrame) * clock.toFraction);
  // Exercise the largest readable copy, rather than choosing chrome or a hidden later card.
  const copy = graphics(packet).filter(graphic => graphic.text && !graphic.vectorV2 &&
    Math.round(graphic.timelineStart * project.fps) <= from && Math.round((graphic.timelineStart + graphic.duration) * project.fps) > to &&
    [from, to].every(frame => motionGraphicV2FrameReceipt(project, graphic, frame, packet.layouts.find(row => row.graphicId === graphic.id)).segments
      .every(segment => Math.round(segment.opacity * 255) === 255))).sort((a, b) => b.fontSize - a.fontSize).slice(0, 2);
  expect(copy.length).toBeGreaterThan(0);
  return { schema: "editkin.graphic-hold-beat/v3", ...clock, roleKeys: copy.map(graphic => packet.roles!.find(role => role.id === graphic.id)!.key) };
}

it("has no selected defaults or opacity/blur/rotation/shrink controls", () => {
  expect(GRAPHIC_HOLD_BEAT_V3_CONTRACT.defaultSelection).toBe(false);
  expect(GRAPHIC_HOLD_BEAT_V3_CONTRACT.certification).toBe("ART_PENDING_CLAUDE");
  const value = { schema: "editkin.graphic-hold-beat/v3", ...clock, roleKeys: ["headline"] };
  expect(() => graphicHoldBeatV3Schema.parse({ ...value, opacity: 0 })).toThrow();
  expect(() => graphicHoldBeatV3Schema.parse({ ...value, peakScale: .99 })).toThrow();
  expect(() => graphicHoldBeatV3Schema.parse({ ...value, roleKeys: ["headline", "headline"] })).toThrow();
  expect(() => graphicHoldBeatV3Schema.parse({ ...value, peakFraction: clock.fromFraction })).toThrow();
  expect(() => graphicHoldEnvelopeV3Schema.parse({ schema: "editkin.graphic-hold-envelope/v3", clock: "graphic_local_frames", fromFrame: 0, peakFrame: 0, toFrame: 2,
    originXPixels: 1, originYPixels: 1, peakScale: 1, translateXPixels: 1, translateYPixels: 0 })).toThrow();
});

describe.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as ReferenceMotionDesignSystem[])("readable hold event %s", theme => {
  it.each(Object.keys(POSTER_FAMILIES_V3) as ReferenceMotionTemplateInput["templateId"][])("%s moves its largest readable copy and returns without changing authored clocks", async family => {
    const { project, input } = graphicPosterFixtureV3(theme, family), before = encodeProjectBytes(project);
    const base = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
    const selected = choice(project, base);
    const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3, holdBeatV3: selected }, ids(), { prepareText });
    const receipt = info(packet); expect(receipt.roleKeys).toEqual(selected.roleKeys);
    expect(packet.phases).toEqual(base.phases); expect(receipt.checkedSegmentFrames).toBeGreaterThan(0);
    const current = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("CURRENT");
    expect(encodeProjectBytes(project)).toEqual(before);
    expect(current.tracks).toEqual(applyCommand(project, { type: "batch", commands: base.commands }).tracks);
    for (const key of selected.roleKeys) {
      const original = graphics(base).find(graphic => base.roles!.find(role => role.id === graphic.id)!.key === key)!;
      const actual = graphics(packet).find(graphic => packet.roles!.find(role => role.id === graphic.id)!.key === key)!;
      const { holdBeatV3: _event, ...plain } = actual; expect(plain).toEqual(original);
      const a = base.layouts.find(row => row.graphicId === original.id)!, b = packet.layouts.find(row => row.graphicId === actual.id)!;
      for (const frame of [receipt.projectWindow.fromFrame, receipt.projectWindow.toFrame])
        expect(motionGraphicV2FrameReceipt(project, actual, frame, b)).toEqual(motionGraphicV2FrameReceipt(project, original, frame, a));
      const oldPeak = motionGraphicV2FrameReceipt(project, original, receipt.projectWindow.peakFrame, a);
      const peak = motionGraphicV2FrameReceipt(project, actual, receipt.projectWindow.peakFrame, b);
      peak.segments.forEach((segment, index) => {
        expect(segment.opacity).toBe(oldPeak.segments[index].opacity); expect(segment.scale).toBe(oldPeak.segments[index].scale);
        expect(segment.translateYPixels - oldPeak.segments[index].translateYPixels).toBeCloseTo(1, 5);
      });
    }
    expect(packet.instance.input.title).toBe(input.title);
  }, 30000);
});

it("moves real glyph ink around one shared canvas origin, with identical neutral receipt objects", async () => {
  const { project, input } = graphicPosterFixtureV3("game_hud_v1", "mark_open");
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
  const selected = choice(project, packet), hold = packet.phases.find(phase => phase.role === "hold")!;
  const marker = { schema: "editkin.graphic-hold-envelope/v3" as const, clock: "graphic_local_frames" as const, fromFrame: hold.startFrame + 2, peakFrame: hold.startFrame + 12, toFrame: hold.startFrame + 22,
    originXPixels: 540, originYPixels: 960, peakScale: 1.04, translateXPixels: 12, translateYPixels: 6 };
  let checked = 0;
  for (const key of selected.roleKeys) {
    const graphic = graphics(packet).find(graphic => packet.roles!.find(role => role.id === graphic.id)!.key === key)!;
    const layout = packet.layouts.find(row => row.graphicId === graphic.id)!;
    const base = motionGraphicV2FrameReceipt(project, graphic, marker.peakFrame, layout);
    expect(applyGraphicHoldEnvelopeV3(project, graphic, marker.peakFrame, layout, base)).toBe(base);
    const marked: MotionGraphic = { ...graphic, holdBeatV3: marker };
    const actual = applyGraphicHoldEnvelopeV3(project, marked, marker.peakFrame, layout, base);
    for (let index = 0; index < layout.segments.length; index++) {
      const segment = layout.segments[index], ink = segment.outline?.ink; if (!ink) continue;
      const x = segment.x + base.segments[index].translateXPixels + ink.xMin * base.segments[index].scale;
      const y = segment.y + base.segments[index].translateYPixels + ink.yMin * base.segments[index].scale;
      expect(segment.x + actual.segments[index].translateXPixels + ink.xMin * actual.segments[index].scale).toBeCloseTo(540 + 1.04 * (x - 540) + 12, 4);
      expect(segment.y + actual.segments[index].translateYPixels + ink.yMin * actual.segments[index].scale).toBeCloseTo(960 + 1.04 * (y - 960) + 6, 4); checked++;
    }
    for (const frame of [0, marker.fromFrame, marker.toFrame, input.durationFrames - 1]) {
      const original = motionGraphicV2FrameReceipt(project, graphic, frame, layout);
      expect(applyGraphicHoldEnvelopeV3(project, marked, frame, layout, original)).toBe(original);
    }
  }
  expect(checked).toBeGreaterThan(5);
});

it("rejects unknown roles and clipping without mutating the project", async () => {
  const { project, input } = graphicPosterFixtureV3("game_hud_v1", "mark_open"), before = encodeProjectBytes(project);
  const base = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
  const selected = choice(project, base);
  await expect(prepareReferenceMotionTemplateInstance(project, { ...input, posterV3, holdBeatV3: { ...selected, roleKeys: ["foreign:graphic"] } }, ids(), { prepareText })).rejects.toMatchObject({ code: "HOLD_BEAT_ROLE" });
  await expect(prepareReferenceMotionTemplateInstance(project, { ...input, posterV3, holdBeatV3: { ...selected, translateXPixels: 1080 } }, ids(), { prepareText })).rejects.toMatchObject({ code: "HOLD_BEAT_INK_WINDOW" });
  expect(encodeProjectBytes(project)).toEqual(before);
});

it("adds and removes the saved event through one undo/redo and a real codec reopen", async () => {
  const { project, input } = graphicPosterFixtureV3("game_hud_v1", "mark_open");
  const base = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
  const before = applyCommand(project, { type: "batch", commands: base.commands });
  const change = await prepareReferenceMotionTemplateRevision(before, base.instance.id, { holdBeatV3: choice(project, base) }, { expectedInstanceRevision: 1, idFactory: ids("revised-"), prepareText });
  const history = dispatchCommand(createHistory(before), { type: "batch", commands: change.commands }, "hold-event-v3", referenceMotionTemplateRevisionCommandContext(change));
  expect(undo(history).present).toEqual(before); expect(redo(undo(history)).present).toEqual(history.present);
  const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
  expect((await inspectReferenceMotionTemplateInstance(reopened, base.instance.id)).status).toBe("CURRENT");
  const remove = await prepareReferenceMotionTemplateRevision(reopened, base.instance.id, { holdBeatV3: null }, { expectedInstanceRevision: 2, idFactory: ids("removed-"), prepareText });
  const restored = decodeProjectBytes(encodeProjectBytes(applyCommand(reopened, { type: "batch", commands: remove.commands })));
  expect(restored.motionGraphics).toEqual(before.motionGraphics);
  expect((await inspectReferenceMotionTemplateInstance(restored, base.instance.id)).status).toBe("CURRENT");
});

it("moves a vector card and physical headline with the same event", async () => {
  const { project, input } = graphicPosterFixtureV3("game_hud_v1", "mark_open");
  const base = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3,
    holdBeatV3: { ...choice(project, base), roleKeys: ["headline", "field:top"] } }, ids(), { prepareText });
  for (const key of ["headline", "field:top"]) {
    const original = graphics(base).find(graphic => base.roles!.find(role => role.id === graphic.id)!.key === key)!;
    const actual = graphics(packet).find(graphic => packet.roles!.find(role => role.id === graphic.id)!.key === key)!;
    const before = motionGraphicV2FrameReceipt(project, original, info(packet).projectWindow.peakFrame, base.layouts.find(row => row.graphicId === original.id));
    const after = motionGraphicV2FrameReceipt(project, actual, info(packet).projectWindow.peakFrame, packet.layouts.find(row => row.graphicId === actual.id));
    const a = before.vectorState ? [before.vectorState] : before.segments, b = after.vectorState ? [after.vectorState] : after.segments;
    b.forEach((pose, index) => { expect(pose.translateYPixels - a[index].translateYPixels).toBeCloseTo(1, 5); expect(pose.opacity).toBe(a[index].opacity); });
  }
});

it.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as ReferenceMotionDesignSystem[])("keeps %s chapter-card first and last poses equal", async theme => {
  const { project, input } = graphicPosterFixtureV3(theme, "level_bridge");
  const base = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
  const selected = choice(project, base);
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3, holdBeatV3: selected }, ids(), { prepareText });
  for (const key of selected.roleKeys) {
    const graphic = graphics(packet).find(graphic => packet.roles!.find(role => role.id === graphic.id)!.key === key)!;
    const layout = packet.layouts.find(row => row.graphicId === graphic.id)!;
    const first = motionGraphicV2FrameReceipt(project, graphic, 0, layout), last = motionGraphicV2FrameReceipt(project, graphic, input.durationFrames - 1, layout);
    expect(first.visible && last.visible).toBe(true);
    first.segments.forEach((pose, index) => { for (const field of ["opacity", "scale", "translateXPixels", "translateYPixels"] as const)
      expect(Math.abs(pose[field] - last.segments[index][field])).toBeLessThan(.05); });
  }
});

it("uses the final hold clock alongside shrinking, timing, poster and the fixed source window", async () => {
  const { project, input } = graphicPosterFixtureV3("swiss_blue_v1", "level_bridge"); project.tracks[0].clips[0].duration = 15;
  const combined: ReferenceMotionTemplateInput = { ...input, durationFrames: 450, title: "W".repeat(32), accentText: undefined,
    brandMark: undefined, kicker: undefined, subtitle: "說明", posterV3,
    copyFitV3: { schema: "editkin.graphic-copy-fit/v3", fontScales: [1, .8, .6, .4, .25], secondaryFields: ["subtitle"] },
    graphicTimingV2: { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 5 }, fixedWindowV3: { schema: "editkin.fixed-template-window/v3", peakScale: 1.096 } };
  const base = await prepareReferenceMotionTemplateInstance(project, combined, ids(), { prepareText });
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...combined, holdBeatV3: choice(project, base) }, ids(), { prepareText });
  const current = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
  expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("CURRENT");
  expect(packet.phases).toEqual(base.phases); expect(current.tracks[0].clips[0].duration).toBe(15);
  expect(current.tracks[0].clips[0].sourceStart).toBe(1); expect(current.tracks[0].clips[0].masks![0].fixedWindowV3).toBeDefined();
});

it("keeps its local event current through the opening move and a later whole-clip move", async () => {
  const { project, input } = graphicPosterFixtureV3("game_hud_v1", "mark_open");
  const base = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3 }, ids(), { prepareText });
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3, holdBeatV3: choice(project, base) }, ids(), { prepareText });
  let current = applyCommand(project, { type: "batch", commands: packet.commands });
  for (const target of [2, 3]) {
    const before = current, inspection = await inspectReferenceMotionTemplateInstance(before, packet.instance.id);
    const moved = await planClipMoveWithAttachments(before, input.clipId, before.tracks[0].id, target, ids(`placement-${target}-`),
      { expectedInstanceRevision: inspection.instance!.instanceRevision, idFactory: ids(`follow-${target}-`), prepareText });
    expect(moved?.needsReapply).toBe(false);
    const history = dispatchCommand(createHistory(before), moved!.command); current = history.present;
    expect(undo(history).present).toEqual(before);
    expect((await inspectReferenceMotionTemplateInstance(decodeProjectBytes(encodeProjectBytes(current)), packet.instance.id)).status).toBe("CURRENT");
    const graphic = current.motionGraphics.find(graphic => graphic.holdBeatV3)!;
    const { holdBeatV3: marker, ...plain } = graphic;
    const face = resolveBundledFontFace(graphic.fontFamily!, graphic.fontWeight!)!;
    const layout = prepareMotionGraphicV2FrameLayout(current, graphic, motionGraphicV2PhysicalLayoutReceipt(current, graphic, await prepareText(face.faceId, graphic.text)));
    const peak = Math.round(graphic.timelineStart * current.fps) + marker!.peakFrame;
    const actual = motionGraphicV2FrameReceipt(current, graphic, peak, layout), original = motionGraphicV2FrameReceipt(current, plain, peak, layout);
    actual.segments.forEach((pose, index) => expect(pose.translateYPixels - original.segments[index].translateYPixels).toBeCloseTo(1, 5));
    expect(current.tracks[0].clips[0].timelineStart).toBe(target); expect(current.tracks[0].clips[0].sourceStart).toBe(1);
  }
});

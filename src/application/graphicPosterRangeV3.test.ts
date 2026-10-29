import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GRAPHIC_POSTER_RANGE_V3_CONTRACT, graphicPosterRangeV3Schema } from "../domain/graphicPosterRangeV3";
import { DEFAULT_GRAPHIC_TIMING_V2 } from "../domain/graphicTimingV2";
import { REFERENCE_MOTION_DESIGN_THEMES, type ReferenceMotionTemplateInput, type ReferenceMotionDesignSystem } from "../motion/referenceMotionTemplates";
import { motionGraphicV2FrameReceipt } from "../motion/compositionV2";
import { applyCommand } from "../domain/commands";
import { animatedClipState } from "../domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision, inspectReferenceMotionTemplateInstance, referenceMotionTemplateRevisionCommandContext } from "./referenceMotionTemplateInstances";
import { graphicPosterFixtureV3, POSTER_FAMILIES_V3 } from "./graphicPosterRangeV3.fixture";
import type { GraphicPosterRangeReceiptV3 } from "./graphicPosterRangeV3";

const choice = { schema: "editkin.graphic-poster-range/v3" as const };
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function prepareText(faceId: string, text: string) {
  if (!faces.has(faceId)) faces.set(faceId, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))));
  return (await faces.get(faceId)!)(text);
}
function ids() { let ordinal = 0; return (prefix: string) => `${prefix}-${++ordinal}`; }
const families = Object.keys(POSTER_FAMILIES_V3) as ReferenceMotionTemplateInput["templateId"][];
function receipt(packet: object) { return (packet as { graphicPosterV3Receipt: GraphicPosterRangeReceiptV3 }).graphicPosterV3Receipt; }

it("has no default selection or invented motion/layout settings", () => {
  expect(GRAPHIC_POSTER_RANGE_V3_CONTRACT.defaultSelection).toBe(false);
  expect(GRAPHIC_POSTER_RANGE_V3_CONTRACT.certification).toBe("ART_PENDING_CLAUDE");
  expect(() => graphicPosterRangeV3Schema.parse({ ...choice, size: 44 })).toThrow();
  expect(families).toHaveLength(17);
});

describe.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as ReferenceMotionDesignSystem[])("physical first-card poster %s", theme => {
  it.each(families)("%s exposes all glyphs and its initial footage at frame zero without exemptions", async family => {
    const { project, input } = graphicPosterFixtureV3(theme, family), original = encodeProjectBytes(project);
    const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3: choice }, ids(), { prepareText });
    const info = receipt(packet); expect(info.applied).toBe(true); expect(info.operations.length).toBeGreaterThan(0);
    const current = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("CURRENT");
    expect(encodeProjectBytes(project)).toEqual(original);
    let visibleText = 0;
    for (const graphic of packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : [])) {
      const startFrame = Math.round(graphic.timelineStart * current.fps);
      if (startFrame > info.throughFrame!) continue;
      expect(startFrame, packet.roles!.find(role => role.id === graphic.id)?.key).toBe(0);
      const layout = packet.layouts.find(layout => layout.graphicId === graphic.id)!;
      const frame = motionGraphicV2FrameReceipt(current, graphic, 0, layout);
      expect(frame.visible).toBe(true);
      if (graphic.text && !graphic.vectorV2) {
        expect(layout.physicalFont?.fontSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(frame.segments.length).toBeGreaterThan(0);
        // Authored cubic curves bisect their endpoints; complete opacity still quantizes to 255 in the output plane.
        for (const segment of frame.segments) expect(Math.round(segment.opacity * 255)).toBe(255);
        visibleText++;
      } else expect(Math.round((frame.vectorState?.opacity ?? frame.backgroundOpacity) * 255)).toBe(255);
    }
    expect(visibleText).toBeGreaterThan(0);
    const clip = current.tracks[0].clips[0];
    expect({ sourceStart: clip.sourceStart, duration: clip.duration, volume: clip.volume }).toEqual({ sourceStart: 1, duration: input.durationFrames / 30, volume: .7 });
    // A takeover may initially hide the clean primary behind its visible foreground window. Inspect real owned clips.
    const footage = current.tracks.flatMap(track => track.clips).filter(clip => clip.assetId === "media-0");
    expect(footage.some(clip => animatedClipState(clip, 0, current.fps).transform.opacity > 0)).toBe(true);
    expect(packet.instance.input.title).toBe(input.title);
  }, 30000);
});

it("keeps a later scene's complete original commands, roles and physical layouts", async () => {
  const { project, input } = graphicPosterFixtureV3("trip_pop_v1", "strike_reframe");
  project.tracks[0].clips[0].timelineStart = 2; input.startFrame = 60;
  const base = await prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText });
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3: choice }, ids(), { prepareText });
  expect(receipt(packet).applied).toBe(false);
  expect(canonicalJson(packet.commands.filter(command => command.type !== "upsert_reference_motion_instance")))
    .toBe(canonicalJson(base.commands.filter(command => command.type !== "upsert_reference_motion_instance")));
  for (const field of ["roles", "layouts", "phases"] as const) expect(canonicalJson(packet[field])).toBe(canonicalJson(base[field]));
}, 30000);

it.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as ReferenceMotionDesignSystem[])(
  "preserves %s chapter-card loop poses after exposing the initial card", async theme => {
    const { project, input } = graphicPosterFixtureV3(theme, "level_bridge");
    const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3: choice }, ids(), { prepareText });
    const current = applyCommand(project, { type: "batch", commands: packet.commands });
    for (const graphic of current.motionGraphics) {
      if (Math.round((graphic.timelineStart + graphic.duration) * current.fps) !== input.durationFrames) continue;
      const layout = packet.layouts.find(row => row.graphicId === graphic.id)!;
      const first = motionGraphicV2FrameReceipt(current, graphic, 0, layout);
      const last = motionGraphicV2FrameReceipt(current, graphic, input.durationFrames - 1, layout);
      expect(first.visible).toBe(true); expect(last.visible).toBe(true);
      const a = first.vectorState ? [first.vectorState] : first.segments, b = last.vectorState ? [last.vectorState] : last.segments;
      expect(a).toHaveLength(b.length);
      for (let i = 0; i < a.length; i++) for (const key of ["opacity", "scale", "translateXPixels", "translateYPixels"] as const) expect(Math.abs(a[i][key] - b[i][key])).toBeLessThan(.05);
    }
    const clip = current.tracks[0].clips[0];
    expect(animatedClipState(clip, 0, current.fps).transform).toEqual(animatedClipState(clip, (input.durationFrames - 1) / current.fps, current.fps).transform);
  }, 30000);

it("keeps later word cards at their original clocks and full visual payloads", async () => {
  const { project, input } = graphicPosterFixtureV3("swiss_blue_v1", "word_cycle");
  const base = await prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText });
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3: choice }, ids(), { prepareText });
  const through = receipt(packet).throughFrame!;
  const key = (value: typeof packet, id: string) => value.roles!.find(role => role.id === id)!.key;
  const graphics = (value: typeof packet) => value.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : []);
  const later = graphics(base).filter(graphic => Math.round(graphic.timelineStart * project.fps) > through);
  expect(later.length).toBeGreaterThan(0);
  for (const original of later) {
    const actual = graphics(packet).find(graphic => key(packet, graphic.id) === key(base, original.id))!;
    const { id: _before, ...before } = original, { id: _after, ...after } = actual;
    expect(canonicalJson(after)).toBe(canonicalJson(before));
  }
}, 30000);

it.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as ReferenceMotionDesignSystem[])(
  "keeps %s mark opening preludes out of the first held card", async theme => {
    const { project, input } = graphicPosterFixtureV3(theme, "mark_open");
    const original = await prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText });
    const firstHold = original.phases.filter(phase => phase.role === "hold").sort((a, b) => a.startFrame - b.startFrame)[0].startFrame;
    const baseline = original.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : []);
    const originalKey = (id: string) => original.roles!.find(role => role.id === id)!.key;
    const expectedCopy = baseline.filter(graphic => graphic.text &&
      Math.round(graphic.timelineStart * project.fps) <= firstHold &&
      Math.round((graphic.timelineStart + graphic.duration) * project.fps) > firstHold)
      .map(graphic => originalKey(graphic.id)).sort();
    const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, posterV3: choice }, ids(), { prepareText });
    const actual = packet.commands.flatMap(command => command.type === "add_motion_graphic" ? [command.graphic] : []);
    const firstCopy = actual.filter(graphic => graphic.text && graphic.timelineStart === 0)
      .map(graphic => packet.roles!.find(role => role.id === graphic.id)!.key).sort();
    expect(firstCopy).toEqual(expectedCopy);
    expect(firstCopy).toContain("headline"); expect(firstCopy).toContain("subtitle"); expect(firstCopy).not.toContain("kicker");
    const current = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
    expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("CURRENT");
  }, 30000);

it("composes the poster with shrinking, timing and the fixed source window while staying current", async () => {
  const { project, input } = graphicPosterFixtureV3("swiss_blue_v1", "level_bridge");
  project.tracks[0].clips[0].duration = 15;
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, durationFrames: 450, title: "W".repeat(32), accentText: undefined, subtitle: "說明", brandMark: undefined, kicker: undefined,
    posterV3: choice, copyFitV3: { schema: "editkin.graphic-copy-fit/v3", fontScales: [1, .8, .6, .4, .25], secondaryFields: ["subtitle"] },
    graphicTimingV2: { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 5 }, fixedWindowV3: { schema: "editkin.fixed-template-window/v3", peakScale: 1.096 } }, ids(), { prepareText });
  const current = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
  expect((await inspectReferenceMotionTemplateInstance(current, packet.instance.id)).status).toBe("CURRENT");
  expect(current.tracks[0].clips[0].duration).toBe(15); expect(current.tracks[0].clips[0].sourceStart).toBe(1);
  expect(current.tracks[0].clips[0].masks![0].fixedWindowV3).toBeDefined(); expect(receipt(packet).applied).toBe(true);
}, 30000);

it("can enable and remove the first-card version with one undo, redo and an actual codec reopen", async () => {
  const { project, input } = graphicPosterFixtureV3("swiss_blue_v1", "word_build");
  const base = await prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText });
  const before = applyCommand(project, { type: "batch", commands: base.commands });
  const change = await prepareReferenceMotionTemplateRevision(before, base.instance.id, { posterV3: choice }, { expectedInstanceRevision: 1, idFactory: ids(), prepareText });
  const history = dispatchCommand(createHistory(before), { type: "batch", commands: change.commands }, "poster-v3", referenceMotionTemplateRevisionCommandContext(change));
  expect(undo(history).present).toEqual(before); expect(redo(undo(history)).present).toEqual(history.present);
  const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
  expect((await inspectReferenceMotionTemplateInstance(reopened, base.instance.id)).status).toBe("CURRENT");
  const remove = await prepareReferenceMotionTemplateRevision(reopened, base.instance.id, { posterV3: null }, { expectedInstanceRevision: 2, idFactory: ids(), prepareText });
  const restored = decodeProjectBytes(encodeProjectBytes(applyCommand(reopened, { type: "batch", commands: remove.commands })));
  expect((await inspectReferenceMotionTemplateInstance(restored, base.instance.id)).status).toBe("CURRENT");
  expect(restored.referenceMotionInstances![0].input.posterV3).toBeUndefined();
}, 30000);

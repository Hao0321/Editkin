import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GRAPHIC_COPY_FIT_V3_CONTRACT, graphicCopyFitV3Schema, type GraphicCopyFitV3 } from "../domain/graphicCopyFitV3";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { REFERENCE_MOTION_DESIGN_THEMES, type ReferenceMotionDesignSystem, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { MeasuredTextLayoutError } from "../typography/measuredTextLayoutV2";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision, referenceMotionTemplateRevisionCommandContext } from "./referenceMotionTemplateInstances";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_GRAPHIC_TIMING_V2 } from "../domain/graphicTimingV2";
import { compileGraphicCopyFitPacketV3, type GraphicCopyFitReceiptV3 } from "./graphicCopyFitCompilerV3";
import type { ReferenceMotionTemplateCompileOptions } from "./referenceMotionTemplateCommands";

const choice: GraphicCopyFitV3 = { schema: "editkin.graphic-copy-fit/v3", fontScales: [1, .8, .6, .4, .25], secondaryFields: ["subtitle", "kicker", "item_details"] };
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function prepareText(faceId: string, text: string) {
  if (!faces.has(faceId)) faces.set(faceId, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))));
  return (await faces.get(faceId)!)(text);
}
function fixture(theme: ReferenceMotionDesignSystem = "trip_pop_v1", title = "完整主標", subtitle = "說明".repeat(20), frames = 180) {
  const project = parseProject(createEmptyProject("Owned copy fitting metadata", { id: "copy-fit", width: 1080, height: 1920, fps: 30 }));
  project.assets.push({ id: "source", name: "Synthetic source metadata", uri: "D:/owned/copy-fit.mov", kind: "video", duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "main", trackId: project.tracks[0].id, assetId: "source", timelineStart: 0, sourceStart: 1, duration: frames / 30, volume: .35,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "main", startFrame: 0, durationFrames: frames, title, subtitle,
    sources: [], intent: "shortform", purpose: "Owned physical copy fit control", evidenceRefs: ["fixture:copy-fit"], designSystem: theme };
  return { project, input };
}
function ids() { let ordinal = 0; return (prefix: string) => `${prefix}-${++ordinal}`; }
function receipt(packet: object) { return (packet as { copyFitV3Receipt: GraphicCopyFitReceiptV3 }).copyFitV3Receipt; }

describe("copy-fit v3 retry contract", () => {
  it("requires caller size/omission order and stays unaccepted and out of defaults", () => {
    expect(GRAPHIC_COPY_FIT_V3_CONTRACT.defaultSelection).toBe(false); expect(GRAPHIC_COPY_FIT_V3_CONTRACT.certification).toBe("ART_PENDING_CLAUDE");
    for (const bad of [{ ...choice, fontScales: [.8, .5] }, { ...choice, fontScales: [1, 1] }, { ...choice, fontScales: [1, .2] }, { ...choice, secondaryFields: ["title"] }, { ...choice, secondaryFields: ["subtitle", "subtitle"] }]) {
      expect(() => graphicCopyFitV3Schema.parse(bad)).toThrow();
    }
  });
  it("exhausts permitted sizes before dropping secondary copy and preserves every primary field", () => {
    const { input } = fixture(), calls: ReferenceMotionTemplateInput[] = [], original = structuredClone(input);
    const options = { generation: 2, layoutForGraphic: () => { throw Error("not reached"); } } as ReferenceMotionTemplateCompileOptions;
    const packet = compileGraphicCopyFitPacketV3(input, choice, options, effective => {
      calls.push(effective); if (effective.subtitle) throw new MeasuredTextLayoutError("文字在最小字級仍放不下；請縮短文字或加寬文字區，詞語會保持完整。");
      return { text: effective.title, sources: effective.sources };
    });
    expect(calls).toHaveLength(choice.fontScales.length + 1); expect(calls.slice(0, -1).every(call => call.subtitle === original.subtitle)).toBe(true);
    expect(receipt(packet).omittedFields).toEqual(["subtitle"]); expect(packet.text).toBe(original.title); expect(input).toEqual(original);
  });
  it("propagates font, cancellation, glyph suspension, source, graph and primary reading failures without fallback", () => {
    const { input } = fixture(), options = { generation: 2, layoutForGraphic: () => { throw Error("not reached"); } } as ReferenceMotionTemplateCompileOptions;
    for (const message of ["FONT_BYTES_REQUIRED", "NeedGlyph", "preparation cancelled", "source generation changed", "source geometry", "主標缺少完整閱讀停留；延長片段或縮短文字"]) {
      const error = new Error(message); let calls = 0;
      expect(() => compileGraphicCopyFitPacketV3(input, choice, options, () => { calls++; throw error; })).toThrow(error); expect(calls).toBe(1);
    }
  });
});

describe.each(Object.keys(REFERENCE_MOTION_DESIGN_THEMES) as ReferenceMotionDesignSystem[])("physical copy-fit theme %s", theme => {
  it("shrinks a schema-maximum wide headline without shortening it or changing source/audio clocks", async () => {
    const { project, input } = fixture(theme, "W".repeat(32), "說明", 450), before = encodeProjectBytes(project);
    await expect(prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText })).rejects.toThrow();
    const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, copyFitV3: choice }, ids(), { prepareText });
    expect(receipt(packet).fontScale).toBeLessThan(1); expect(receipt(packet).primaryCopyPreserved).toBe(true); expect(packet.instance.input.title).toBe(input.title);
    const applied = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
    expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT"); expect(encodeProjectBytes(project)).toEqual(before);
    const clip = applied.tracks[0].clips[0]; expect({ sourceStart: clip.sourceStart, duration: clip.duration, volume: clip.volume }).toEqual({ sourceStart: 1, duration: 15, volume: .35 });
    for (const binding of packet.physicalLayoutBindings) expect(binding.physicalFont.fontSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 20000);
  it("omits an overlong support line after trying the requested sizes and keeps its original author text on reopen", async () => {
    const { project, input } = fixture(theme), before = encodeProjectBytes(project);
    await expect(prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText })).rejects.toThrow();
    const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, copyFitV3: choice }, ids(), { prepareText });
    expect(receipt(packet).omittedFields).toContain("subtitle"); expect(receipt(packet).attempts.slice(0, choice.fontScales.length).every(attempt => attempt.omittedFields.length === 0)).toBe(true);
    const applied = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
    expect(applied.referenceMotionInstances![0].input.subtitle).toBe(input.subtitle);
    expect(packet.roles!.filter(role => /^subtitle(?:$|:)/.test(role.key))).toEqual([]);
    expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT"); expect(encodeProjectBytes(project)).toEqual(before);
  }, 20000);
});

it("can explicitly enable and remove copy fitting through a current saved-instance revision", async () => {
  const { project, input } = fixture("trip_pop_v1", "完整主標", "短說明", 300);
  const packet = await prepareReferenceMotionTemplateInstance(project, input, ids(), { prepareText });
  let applied = applyCommand(project, { type: "batch", commands: packet.commands });
  for (const copyFitV3 of [choice, null]) {
    const revision = await prepareReferenceMotionTemplateRevision(applied, packet.instance.id, { copyFitV3 }, { expectedInstanceRevision: applied.referenceMotionInstances![0].instanceRevision, prepareText, idFactory: ids() });
    applied = applyCommand(applied, { type: "batch", commands: revision.commands });
    expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT");
  }
  expect(applied.referenceMotionInstances![0].input.copyFitV3).toBeUndefined();
}, 20000);

it("keeps omitted support roles current through a text revision and one undo/redo", async () => {
  const { project, input } = fixture("trip_pop_v1", "完整主標", "短說明", 180);
  const saved = await prepareReferenceMotionTemplateInstance(project, { ...input, copyFitV3: choice }, ids(), { prepareText });
  const before = applyCommand(project, { type: "batch", commands: saved.commands });
  const revision = await prepareReferenceMotionTemplateRevision(before, saved.instance.id, { subtitle: "說明".repeat(20) }, { expectedInstanceRevision: 1, prepareText, idFactory: ids() });
  const history = dispatchCommand(createHistory(before), { type: "batch", commands: revision.commands }, "copy-fit-revision", referenceMotionTemplateRevisionCommandContext(revision));
  expect(undo(history).present).toEqual(before); expect(redo(undo(history)).present).toEqual(history.present);
  const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
  expect((await inspectReferenceMotionTemplateInstance(reopened, saved.instance.id)).status).toBe("CURRENT");
  expect(reopened.referenceMotionInstances![0].input.subtitle).toBe("說明".repeat(20));
  expect(reopened.referenceMotionInstances![0].roles.filter(role => /^subtitle(?:$|:)/.test(role.key))).toEqual([]);
}, 20000);

it("composes shrinking with explicit timing and a fixed source window without extending the source clip", async () => {
  const { project, input } = fixture("trip_pop_v1", "W".repeat(32), "說明", 450);
  const packet = await prepareReferenceMotionTemplateInstance(project, { ...input, copyFitV3: choice,
    graphicTimingV2: { ...DEFAULT_GRAPHIC_TIMING_V2, holdSeconds: 2 }, fixedWindowV3: { schema: "editkin.fixed-template-window/v3", peakScale: 1.096 } }, ids(), { prepareText });
  const applied = decodeProjectBytes(encodeProjectBytes(applyCommand(project, { type: "batch", commands: packet.commands })));
  expect((await inspectReferenceMotionTemplateInstance(applied, packet.instance.id)).status).toBe("CURRENT");
  expect(receipt(packet).fontScale).toBeLessThan(1); expect(applied.tracks[0].clips[0].duration).toBe(15);
  expect(applied.tracks[0].clips[0].masks![0].fixedWindowV3).toBeDefined();
}, 20000);

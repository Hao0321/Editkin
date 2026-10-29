import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_TRANSFORM, DEFAULT_COLOR } from "../domain/types";
import { applyCommand } from "../domain/commands";
import { canonicalJson } from "../shared/canonicalJson";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { createProjectSession } from "./projectSession";
import { prepareReferenceMotionTemplateInstance, inspectReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { prepareValueLadderV1 } from "./valueLadderV1";
import { applyPreparedEditorialDataGraphicsV1 } from "./editorialDataGraphicsV1";
import { undo, redo } from "../domain/history";

const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(face: string, text: string) {
  if (!faces.has(face)) faces.set(face, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(face).fontFile)).then(bytes => preparePhysicalFace(face, new Uint8Array(bytes))));
  return (await faces.get(face)!)(text);
}
function fixture() {
  const p = createEmptyProject("Synthetic value data", { id: "ladder-control", fps: 30, width: 1080, height: 1920 });
  p.assets = [{ id: "source", kind: "video", name: "Synthetic graph; not real footage", uri: "D:/synthetic/data.mov", duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  p.tracks[0].clips = [{ id: "primary", assetId: "source", trackId: p.tracks[0].id, timelineStart: 0, sourceStart: 1, duration: 10, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }]; return p;
}
function request() { return { schema: "editkin.value-ladder/v1", expectedRevision: 0, idPrefix: "ladder", direction: "increase", unit: { prefix: "", suffix: " 支", groupThousands: false },
  rungs: ["1", "2", "3"].map(value => ({ value, detail: "完成作品", evidenceRefs: ["synthetic:ladder"] })),
  template: { clipId: "primary", startFrame: 0, durationFrames: 300, graphicCadence: "kinetic", intent: "shortform", designSystem: "tech_spec_v1", title: "每週剪輯成果", purpose: "Synthetic data control" } }; }

describe("value ladder data through the unchanged physical stat_reveal compiler", () => {
  it("matches a direct original compiler invocation and keeps its saved instance CURRENT in one Undo", async () => {
    const p = fixture(), before = canonicalJson(p), r = request(), session = createProjectSession(p);
    const plan = await prepareValueLadderV1(session, r, { prepareText: physicalText }); let ordinal = 0;
    const original = await prepareReferenceMotionTemplateInstance(p, { ...r.template, graphicCadence: "kinetic", intent: "shortform", designSystem: "tech_spec_v1", templateId: "stat_reveal",
      items: r.rungs.map(r => ({ label: `${r.value} 支`, detail: r.detail })), evidenceRefs: ["synthetic:ladder"] }, prefix => `ladder-${prefix}-${++ordinal}`, { prepareText: physicalText });
    expect(canonicalJson(p)).toBe(before); expect(plan.hooks.some(h => h.phase === "final")).toBe(true);
    await applyPreparedEditorialDataGraphicsV1(session, plan); const h = session.getSnapshot().history;
    const oracle = applyCommand(p, { type: "batch", commands: original.commands });
    expect(h.present.motionGraphics).toEqual(oracle.motionGraphics); expect(h.present.referenceMotionInstances).toEqual(oracle.referenceMotionInstances);
    expect(h.present.tracks).toEqual(p.tracks); expect(h.present.assets).toEqual(p.assets); expect(h.past).toHaveLength(1);
    expect((await inspectReferenceMotionTemplateInstance(h.present, original.instance.id)).status).toBe("CURRENT");
    expect(canonicalJson(undo(h).present)).toBe(before); expect(redo(undo(h)).present).toEqual(h.present);
    expect(plan.defaultEnabled).toBe(false); expect(plan.sound).toBeNull();
  }, 20000);
  it.each(["equal", "wrong-order", "missing-theme", "override-items", "precision", "outside", "locked", "too-many-refs"])("rejects %s before producing a live edit", async reason => {
    const p = fixture(), r = request();
    if (reason === "equal") r.rungs[1].value = "1.00"; if (reason === "wrong-order") r.direction = "decrease";
    if (reason === "missing-theme") delete (r.template as Record<string, unknown>).designSystem;
    if (reason === "override-items") Object.assign(r.template, { items: [{ label: "FORGED" }] });
    if (reason === "precision") r.rungs[2].value = "999999999999.123456";
    if (reason === "outside") r.template.durationFrames = 301; if (reason === "locked") p.tracks[0].locked = true;
    if (reason === "too-many-refs") r.rungs = r.rungs.map((v, i) => ({ ...v, evidenceRefs: Array.from({ length: 4 }, (_, k) => `ref:${i}:${k}`) }));
    const before = canonicalJson(p), session = createProjectSession(p); let glyphCalls = 0;
    await expect(prepareValueLadderV1(session, r, { prepareText: async (...args) => { glyphCalls++; return physicalText(...args); } })).rejects.toThrow();
    expect(glyphCalls).toBe(0); expect(canonicalJson(p)).toBe(before); expect(session.getSnapshot().history.past).toHaveLength(0);
  });
  it("cancels a stalled glyph request with the exact parent reason and does not publish a draft", async () => {
    const p = fixture(), session = createProjectSession(p), controller = new AbortController(), reason = Error("glyph-stop");
    const run = prepareValueLadderV1(session, request(), { prepareText: async () => { controller.abort(reason); return new Promise<PreparedGlyphRun>(() => {}); } }, { signal: controller.signal });
    await expect(run).rejects.toBe(reason); expect(session.getSnapshot().history.past).toHaveLength(0);
  });
});

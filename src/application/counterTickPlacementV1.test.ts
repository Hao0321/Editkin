import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject, migrateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { undo, redo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { createProceduralSfxLibraryV1, type ProceduralSfxLibraryV1 } from "./proceduralSfxLibraryV1";
import { writeProceduralSfxPackV1 } from "./proceduralSfxPackV1";
import { deriveCounterVisualTicksV1 } from "./counterVisualTicksV1";
import { prepareCounterTickPlacementV1 } from "./counterTickPlacementV1";
import { applyPreparedProceduralSfxPlacementV1 } from "./proceduralSfxPlacementV1";
import { createProjectSession } from "./projectSession";

const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  if (!faces.has(faceId)) faces.set(faceId, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))));
  return (await faces.get(faceId)!)(text);
}
let project: EditProject, library: ProceduralSfxLibraryV1, root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-counter-sfx-a-"));
  const pins = await Promise.all(["Catalogue", "Synth"].map(async kind => {
    const path = `src/application/proceduralSfx${kind}V1.ts`, bytes = await readFile(path);
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  await writeProceduralSfxPackV1(join(root, "pack"), pins); library = await createProceduralSfxLibraryV1(join(root, "pack"), pins);
  const base = createEmptyProject("counter tick physical template control", { id: "counter-source", fps: 30, width: 1080, height: 1920 });
  base.assets = [{ id: "source", kind: "video", name: "Synthetic graph; not real footage", uri: "D:/synthetic/counter.mov", duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  base.tracks[0].clips = [{ id: "primary", assetId: "source", trackId: base.tracks[0].id, timelineStart: 0, sourceStart: 1, duration: 10, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  let ordinal = 0;
  const packet = await prepareReferenceMotionTemplateInstance(base, { templateId: "stat_reveal", clipId: "primary", startFrame: 0, durationFrames: 300,
    graphicCadence: "kinetic", intent: "shortform", designSystem: "tech_spec_v1", title: "一週剪完三支片", accentText: "三支片", sources: [],
    items: [{ label: "69%", detail: "挑選素材" }, { label: "3 支", detail: "一週完成" }, { label: "NT$0", detail: "不另付費" }],
    evidenceRefs: ["synthetic:counter-control"], purpose: "Physical glyph counter timing control; no real footage or art certification" },
    (prefix, role) => `${prefix}-${role?.replaceAll(":", "-")}-${ordinal++}`, { prepareText: physicalText });
  project = applyCommand(base, { type: "batch", commands: packet.commands });
}, 30_000);
afterAll(async () => {
  if (!root) return;
  await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "counterTickPlacementV1.test.ts", root, testsTerminal: true }), { flag: "wx" });
  console.log(`COUNTER_SFX_A_OWNED_TEST_FIXTURE=${root}`);
});
const request = () => ({ enabled: true, durationFrames: 300, trackId: "audio-main", idPrefix: "counter-sound",
  bindings: [{ source: "reference_instance", instanceId: project.referenceMotionInstances![0].id }], sound: { variant: 1, gain: .42 } });
describe("actual saved stat_reveal to verified original tick placement", () => {
  it("extracts actual count frames, prioritizes finals, verifies full sources and inserts one Undo with exact old visuals", async () => {
    const session = createProjectSession(project), before = JSON.stringify(project), result = await prepareCounterTickPlacementV1(session, library, request());
    expect(result.visual.hooks.length).toBeGreaterThan(3); expect(result.visual.selected.some(h => h.phase === "final")).toBe(true);
    expect(result.visual.suppressed.some(h => h.reason === "sound_overlap")).toBe(true);
    expect(result.placement.sourceBindings).toHaveLength(1); expect(JSON.stringify(project)).toBe(before);
    await applyPreparedProceduralSfxPlacementV1(session, result.placement);
    const changed = session.getSnapshot().history;
    expect(changed.past).toHaveLength(1); expect(changed.present.motionGraphics).toEqual(project.motionGraphics);
    expect(changed.present.referenceMotionInstances).toEqual(project.referenceMotionInstances);
    const reopened = migrateProject(JSON.parse(JSON.stringify(changed.present))), clips = reopened.tracks.find(t => t.id === "audio-main")!.clips;
    expect(clips.map(c => Math.round(c.timelineStart * reopened.fps))).toEqual(result.visual.selected.map(h => h.frame));
    expect(clips.every(c => c.duration === .1 && c.volume === .42)).toBe(true);
    expect(undo(changed).present).toEqual(project); expect(redo(undo(changed)).present).toEqual(changed.present);
    await expect(applyPreparedProceduralSfxPlacementV1(session, result.placement)).rejects.toThrow("PACKET_INVALID");
  });
  it("rejects edited template scope before source I/O; missing/non-counter families and role discontinuities are not inferred", async () => {
    const changed = structuredClone(project), graphic = changed.motionGraphics.find(g => changed.referenceMotionInstances![0].roles.some(r => r.kind === "graphic" && r.id === g.id && r.key.includes(":count:")))!;
    graphic.text = "999";
    const session = createProjectSession(changed); await expect(prepareCounterTickPlacementV1(session, library, request())).rejects.toThrow("INSTANCE_EDITED");
    expect(session.getSnapshot().history.past).toHaveLength(0);
    graphic.duration += 1 / 30; expect(() => deriveCounterVisualTicksV1(changed, request())).toThrow("SEQUENCE_EDITED");
    const missing = request(); missing.bindings[0].instanceId = "missing"; await expect(prepareCounterTickPlacementV1(createProjectSession(project), library, missing)).rejects.toThrow("INSTANCE_MISSING");
  });
  it("cancels changes during catalogue await, including reopening the same project id", async () => {
    const session = createProjectSession(project), delayed: ProceduralSfxLibraryV1 = { ...library, list: async (...args) => {
      const result = await library.list(...args); session.replaceProject(structuredClone(project)); return result;
    } };
    await expect(prepareCounterTickPlacementV1(session, delayed, request())).rejects.toThrow("PROJECT_CHANGED");
    expect(session.getSnapshot().history.past).toHaveLength(0); expect(session.getSnapshot().history.present.assets).toEqual(project.assets);
  });
  it("cancelled requests and locked target tracks leave all graphics and history unchanged", async () => {
    const controller = new AbortController(); controller.abort(); const session = createProjectSession(project);
    await expect(prepareCounterTickPlacementV1(session, library, request(), controller.signal)).rejects.toThrow();
    const locked = structuredClone(project); locked.tracks.find(t => t.id === "audio-main")!.locked = true;
    await expect(prepareCounterTickPlacementV1(createProjectSession(locked), library, request())).rejects.toThrow("TARGET_TRACK_UNAVAILABLE");
    expect(session.getSnapshot().history.present).toEqual(project); expect(session.getSnapshot().history.past).toHaveLength(0);
  });
  it("refuses an occupied audio track without a second Undo or partial source import", async () => {
    const session = createProjectSession(project), prepared = await prepareCounterTickPlacementV1(session, library, request());
    await applyPreparedProceduralSfxPlacementV1(session, prepared.placement);
    const before = JSON.stringify(session.getSnapshot().history);
    await expect(prepareCounterTickPlacementV1(session, library, { ...request(), idPrefix: "second-tick-batch" })).rejects.toThrow("TARGET_TRACK_OCCUPIED");
    expect(JSON.stringify(session.getSnapshot().history)).toBe(before);
  });
  it("packet tampering and edits after preparation cannot commit an old visual generation", async () => {
    const session = createProjectSession(project), prepared = await prepareCounterTickPlacementV1(session, library, request());
    prepared.placement.sourceBindings[0].sha256 = "a".repeat(64);
    await expect(applyPreparedProceduralSfxPlacementV1(session, prepared.placement)).rejects.toThrow("PACKET_INVALID");
    const fresh = await prepareCounterTickPlacementV1(session, library, request()); session.replaceProject(structuredClone(project));
    await expect(applyPreparedProceduralSfxPlacementV1(session, fresh.placement)).rejects.toThrow("PROJECT_CHANGED");
    expect(session.getSnapshot().history.past).toHaveLength(0);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { encodeProjectBytes, decodeProjectBytes } from "./projectCodec";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareGlyphRun } from "../typography/preparedGlyphRun";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { editorCommandSchema } from "../domain/schema";
import { assertOriginalSceneGraphicRevision } from "../domain/originalSceneGraphicRevision";
import { applyProjectCommands } from "../mcp/storage";
import { assertOriginalMotionSceneV4Boundary } from "./originalMotionSceneV4Boundary";
import { prepareOriginalMotionScene2d, type OriginalMotionScene2dInput } from "./originalMotionScene2d";
import { prepareOriginalSceneGraphicRevision, originalSceneGraphicRevisionInputSchema } from "./originalSceneGraphicRevision";

const faces = new Map<string, Uint8Array>();
beforeAll(async () => {
  for (const id of ["EditkinFace-noto-sans-tc-500", "EditkinFace-noto-sans-tc-700"]) {
    faces.set(id, new Uint8Array(await readFile(join(resolve("public/fonts"), bundledFontFaceSpec(id).fontFile))));
  }
});
const physical = (face: string, text: string) => {
  const bytes = faces.get(face); if (!bytes) throw new Error("fixture font unavailable");
  return prepareGlyphRun(face, text, bytes);
};
async function fixture(paintVersion: "v1" | "v2" = "v2") {
  const empty = createEmptyProject("Manual owner content editing", { width: 640, height: 360, fps: 30 });
  empty.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  const input: OriginalMotionScene2dInput = { sceneId: "owner-scene", expectedRevision: empty.revision,
    intent: "authored_overlay", reason: "原創作者的可編輯標題，保留鏡頭與時間", startFrame: 30, durationFrames: 150,
    safeArea: { left: 20, right: 20, top: 20, bottom: 20 },
    style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
      typography: { headingFamily: "Noto Sans TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1 },
    camera: { initial: { centerX: 320, centerY: 180, zoom: 1 }, dynamics: { stiffness: 120, damping: 24, mass: 1 } },
    elements: [{ id: "owner-title", kind: "text", text: "我的作品", typographyRole: "heading", fontWeight: 700,
      range: { startFrame: 15, endFrame: 145 }, xPixels: 60, yPixels: 100, widthPixels: 500,
      fontSize: 64, minFontSize: 32, maxLines: 1, lineGapPixels: 8, letterSpacingPixels: 0, colorRole: "text",
      paintV1: { ...(paintVersion === "v1" ? { schema: "editkin.motion-paint/v1" as const }
        : { schema: "editkin.motion-paint/v2" as const, colorIntent: "display_rec709_sdr" as const }), clips: [],
        fill: { kind: "linear", start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, stops: [{ at: 0, color: "#175CD3" }, { at: 1, color: "#17203380" }] } } }],
    semanticCues: [{ id: "owner-read", frame: 15, purpose: "鏡頭已穩定後閱讀原創標題", graphicIds: ["owner-title"], evidenceRefs: ["brief:manual-owner-title"] }] };
  const prepared = await prepareOriginalMotionScene2d(empty, input, undefined, { prepareText: physical });
  return applyCommand(empty, { type: "batch", commands: prepared.commands });
}
const edit = (project: Awaited<ReturnType<typeof fixture>>, text = "我的作品可以換成更長的標題") => ({
  sceneId: "owner-scene", expectedRevision: project.revision, edits: [{ graphicId: "owner-title", text,
    fontFamily: "Noto Sans TC", fontWeight: 500, fontSize: 48, minFontSize: 32, maxLines: 2,
    paintColors: ["#E04D35", "#4C256E80"], motionV2: { ...structuredClone(project.motionGraphics[0].motionV2!),
      sequence: { ...project.motionGraphics[0].motionV2!.sequence, unit: "character" as const, staggerFrames: 2 },
      entrance: { ...project.motionGraphics[0].motionV2!.entrance, durationFrames: 8 },
      exit: { ...project.motionGraphics[0].motionV2!.exit, durationFrames: 5 } } }],
});
async function changed(project: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await prepareOriginalSceneGraphicRevision(project, edit(project), { prepareText: physical });
  if (prepared.status !== "REVIEW_REQUIRED") throw new Error("fixture missing explicit revision");
  return prepared;
}

describe("manual original-scene owner content editor", () => {
  it("uses real 500-weight glyphs for long text, preserves scene and other content, and checks every camera frame", async () => {
    const project = await fixture(), before = structuredClone(project), prepareText = vi.fn(physical);
    const prepared = await prepareOriginalSceneGraphicRevision(project, edit(project), { prepareText });
    expect(project).toEqual(before); expect(prepareText).toHaveBeenCalledExactlyOnceWith("EditkinFace-noto-sans-tc-500", edit(project).edits[0].text);
    expect(prepared).toMatchObject({ status: "REVIEW_REQUIRED", v4Admission: "NOT_V4_ADMITTED", preparedSafety: { framesChecked: 150, graphicFramesChecked: 150 } });
    const after = applyCommand(project, { type: "batch", commands: prepared.commands });
    expect(after.motionScenes).toEqual(before.motionScenes); expect(after.tracks).toEqual(before.tracks);
    expect(after.assets).toEqual(before.assets); expect(after.colorManagement).toEqual(before.colorManagement);
    expect(after.motionGraphics[0]).toMatchObject({ id: "owner-title", text: edit(project).edits[0].text,
      fontWeight: 500, timelineStart: before.motionGraphics[0].timelineStart, duration: before.motionGraphics[0].duration,
      layoutV2: { maxLines: 2 }, paintV1: { schema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr" } });
  });
  it("is one real history operation and saves/reopens edited content and unchanged cameras exactly", async () => {
    const project = await fixture(), prepared = await changed(project);
    const history = dispatchCommand(createHistory(project), { type: "batch", commands: prepared.commands });
    expect(history.past).toHaveLength(1); expect(undo(history).present).toEqual(project);
    expect(redo(undo(history)).present).toEqual(history.present);
    const reopened = decodeProjectBytes(encodeProjectBytes(history.present));
    expect(reopened.motionGraphics).toEqual(history.present.motionGraphics); expect(reopened.motionScenes).toEqual(history.present.motionScenes);
    expect(reopened.assets).toEqual(history.present.assets); expect(reopened.tracks).toEqual(history.present.tracks);
  });
  it("keeps historical scene paint v1 explicit instead of silently promoting display v2", async () => {
    const project = await fixture("v1"), prepared = await changed(project);
    expect(applyCommand(project, prepared.commands[0]).motionGraphics[0].paintV1?.schema).toBe("editkin.motion-paint/v1");
  });
  it("rejects real stale owner, graphic content and revision snapshots atomically", async () => {
    const project = await fixture(), command = (await changed(project)).commands[0];
    for (const mutation of ["revision", "camera", "text"] as const) {
      const drift = structuredClone(project);
      if (mutation === "revision") drift.revision++;
      if (mutation === "camera") drift.motionScenes![0].camera.zoom.initialVelocity = .01;
      if (mutation === "text") drift.motionGraphics[0].text = "已改字";
      const before = structuredClone(drift);
      expect(() => assertOriginalSceneGraphicRevision(drift, command)).toThrow(/stale|changed/);
      expect(() => applyCommand(drift, command)).toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/); expect(drift).toEqual(before);
    }
  });
  it("refuses foreign IDs, geometry, range, paint topology/alpha and camera-bearing command tampering", async () => {
    const project = await fixture(), command = (await changed(project)).commands[0];
    for (const mutation of ["id", "position", "range", "paint", "alpha", "camera"] as const) {
      const forged = structuredClone(command);
      if (mutation === "id") forged.graphics[0].id = "foreign";
      if (mutation === "position") forged.graphics[0].x += .1;
      if (mutation === "range") forged.graphics[0].duration -= 1;
      if (mutation === "paint" && forged.graphics[0].paintV1!.fill.kind === "linear") forged.graphics[0].paintV1!.fill.end.x = .5;
      if (mutation === "alpha" && forged.graphics[0].paintV1!.fill.kind === "linear") forged.graphics[0].paintV1!.fill.stops[1].color = "#4C256E40";
      if (mutation === "camera") forged.expectedScene.camera.zoom.initialPosition = 1.1;
      const before = canonicalJson(project);
      expect(() => assertOriginalSceneGraphicRevision(project, forged)).toThrow(/identities|cannot change|alpha|owner changed/);
      expect(() => applyCommand(project, forged)).toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/); expect(canonicalJson(project)).toBe(before);
    }
  });
  it("refuses shared scene or template owners instead of detaching them", async () => {
    const project = await fixture(), input = edit(project);
    const template = structuredClone(project); template.motionGraphics[0].templateOwner = { schema: "editkin.template-element-owner/v1", sessionId: "fixture", templateId: "fixture", format: "short", role: "title" };
    await expect(prepareOriginalSceneGraphicRevision(template, input, { prepareText: physical })).rejects.toThrow(/another owner/);
    const shared = structuredClone(project); shared.motionScenes!.push({ ...structuredClone(shared.motionScenes![0]), id: "other", startFrame: 180 });
    await expect(prepareOriginalSceneGraphicRevision(shared, input, { prepareText: physical })).rejects.toThrow(/another owner/);
  });
  it("rejects genuine excessive stagger reading time and full-frame overshooting contours", async () => {
    const project = await fixture(), reading = edit(project); reading.edits[0].motionV2.sequence.staggerFrames = 4;
    await expect(prepareOriginalSceneGraphicRevision(project, reading, { prepareText: physical })).rejects.toThrow(/reading hold|閱讀/);
    const overshoot = edit(project); overshoot.edits[0].motionV2.entrance.offsetXPixels = 1000;
    await expect(prepareOriginalSceneGraphicRevision(project, overshoot, { prepareText: physical })).rejects.toThrow(/safe|contour|超|bounds/i);
  });
  it("rejects nonexistent fonts, wrong glyph bytes, cancellation and content changed during actual preparation", async () => {
    const project = await fixture(), unavailable = edit(project); unavailable.edits[0].fontFamily = "Unverified";
    await expect(prepareOriginalSceneGraphicRevision(project, unavailable, { prepareText: physical })).rejects.toThrow(/FONT|字型|font/i);
    await expect(prepareOriginalSceneGraphicRevision(project, edit(project), { prepareText: (face, text) => prepareGlyphRun(face, text, new Uint8Array([0])) })).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); const prepareText = vi.fn(physical);
    await expect(prepareOriginalSceneGraphicRevision(project, edit(project), { signal: controller.signal, prepareText })).rejects.toThrow(/cancelled/); expect(prepareText).not.toHaveBeenCalled();
    const mutable = structuredClone(project);
    await expect(prepareOriginalSceneGraphicRevision(mutable, edit(mutable), { prepareText: async (face, text) => {
      const run = await physical(face, text); mutable.name = "Changed while preparing"; return run;
    } })).rejects.toThrow(/changed during/);
  });
  it("keeps unchanged/no-op content uncommitted and refuses unknown keys or unbound current v4 use", async () => {
    const project = await fixture(), prepareText = vi.fn(physical);
    expect(await prepareOriginalSceneGraphicRevision(project, { sceneId: "owner-scene", expectedRevision: project.revision,
      edits: [{ graphicId: "owner-title", text: project.motionGraphics[0].text }] }, { prepareText })).toEqual({ status: "UNCHANGED", commands: [] });
    expect(prepareText).not.toHaveBeenCalled();
    expect(() => originalSceneGraphicRevisionInputSchema.parse({ ...edit(project), rights: "verified" })).toThrow();
    const command = (await changed(project)).commands[0]; expect(editorCommandSchema.parse(command)).toEqual(command);
    expect(() => editorCommandSchema.parse({ ...command, ownerProof: true })).toThrow();
    expect(() => assertOriginalMotionSceneV4Boundary([command])).toThrow(/V4_REVISION_CONTRACT_REQUIRED/);
  });
  it("rejects serialized/raw automation, cloned commands, mixed batches and unrelated same-revision project drift at the exact authority fence", async () => {
    const project = await fixture(), command = (await changed(project)).commands[0], clone = structuredClone(command);
    expect(() => applyCommand(project, clone)).toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/);
    expect(() => applyCommand(project, { type: "batch", commands: [clone] })).toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/);
    expect(() => applyCommand(project, { type: "batch", commands: [{ type: "rename_project", name: "Mixed" }, command] })).toThrow(/ORIGINAL_SCENE_MANUAL_SINGLE_COMMIT_REQUIRED/);
    const drift = { ...project, name: "Other project content" };
    expect(() => applyCommand(drift, command)).toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/);
    await expect(applyProjectCommands("does-not-exist.editkin", [clone], project.revision)).rejects.toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/);
    await expect(applyProjectCommands("does-not-exist.editkin", [{ type: "batch", commands: [clone] }], project.revision)).rejects.toThrow(/ORIGINAL_SCENE_MANUAL_PREPARATION_REQUIRED/);
  });
});

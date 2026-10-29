import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EditorCommand } from "../domain/commands";
import { createEmptyProject } from "../domain/editGraph";
import { dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { assertPreparedGlyphRun, prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import type { MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";
import { type MotionGraphicCreationInput } from "./motionGraphicCreation";
import { createMotionGraphicCreationOwner } from "./motionGraphicCreationOwner";
import { createProjectSession } from "./projectSession";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fontBytes = new Map<string, Uint8Array>();
const glyphRuns = new Map<string, Promise<PreparedGlyphRun>>();
function physicalText(faceId: string, text: string): Promise<PreparedGlyphRun> {
  const key = canonicalJson([faceId, text]);
  let run = glyphRuns.get(key);
  if (!run) {
    run = (async () => {
      let bytes = fontBytes.get(faceId);
      if (!bytes) {
        bytes = new Uint8Array(await readFile(resolve("public/fonts", bundledFontFaceSpec(faceId).fontFile)));
        fontBytes.set(faceId, bytes);
      }
      const prepared = await prepareGlyphRun(faceId, text, bytes);
      assertPreparedGlyphRun(prepared);
      return prepared;
    })();
    glyphRuns.set(key, run);
  }
  return run;
}
function projectFixture() {
  const project = createEmptyProject("Current owned creation", { id: "motion-creation-owner", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "owned-source", name: "Controlled existing source", kind: "video", uri: "D:/fixture-only/owned-source.mp4",
    duration: 8, width: 1080, height: 1920, displayAspectRatio: 9 / 16, color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [{ id: "owned-clip", assetId: "owned-source", trackId: project.tracks[0].id,
    timelineStart: 0, sourceStart: 0, duration: 8, volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, expressions: {} }];
  return project;
}
function inputFor(session: ReturnType<typeof createProjectSession>, graphicId = "created-title", text = "新重點"): MotionGraphicCreationInput {
  return { expectedRevision: session.getSnapshot().history.present.revision, graphicId, kind: "title", text,
    startFrame: 0, preferredDurationFrames: 90, scope: "existing_timeline" };
}
interface ControlledPreparer {
  signal: AbortSignal;
  entered: ReturnType<typeof deferred<{ faceId: string; text: string }>>;
  gate: ReturnType<typeof deferred<void>>;
  dispose: ReturnType<typeof vi.fn>;
  work?: Promise<PreparedGlyphRun>;
}
const cleanups: (() => void)[] = [];
const controls: ControlledPreparer[] = [];
const pending = new Set<Promise<boolean>>();
const glyphWork = new Set<Promise<PreparedGlyphRun>>();
async function finishGlyphWork(control: ControlledPreparer) {
  if (!control.work) throw new Error("The actual physical glyph reader was not entered");
  const run = await control.work;
  assertPreparedGlyphRun(run);
  return run;
}
function track(task: Promise<boolean>): Promise<boolean> {
  pending.add(task);
  void task.then(() => pending.delete(task), () => pending.delete(task));
  return task;
}
function setup(controlled = false) {
  const project = projectFixture(), session = createProjectSession(project);
  const submitted: EditorCommand[] = [], statuses: string[] = [], preparers: ControlledPreparer[] = [];
  const owner = createMotionGraphicCreationOwner({ session,
    onStatus: message => { statuses.push(message); },
    onCommand: (command, _message) => {
      submitted.push(structuredClone(command));
      session.setHistory(history => dispatchCommand(history, command, `owned-${submitted.length}`));
      return true;
    },
    createTextPreparer: ({ signal }): MotionTemplateTextPreparer => {
      const entry: ControlledPreparer = { signal, entered: deferred(), gate: deferred(), dispose: vi.fn() };
      preparers.push(entry); controls.push(entry);
      return { dispose: entry.dispose, prepareText: (faceId, text) => {
        entry.entered.resolve({ faceId, text });
        // A deliberately noncooperative controlled reader still returns only
        // an authentic run from the real bundled binary/factory after release.
        const work = (controlled ? entry.gate.promise : Promise.resolve()).then(() => physicalText(faceId, text));
        entry.work = work;
        glyphWork.add(work);
        void work.then(() => glyphWork.delete(work), () => glyphWork.delete(work));
        return work;
      } };
    },
  });
  const detach = owner.attach(); cleanups.push(detach);
  return { project, session, submitted, statuses, preparers, owner, detach };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const control of controls.splice(0)) control.gate.resolve();
  await Promise.allSettled([...pending]);
  await Promise.allSettled([...glyphWork]);
  vi.restoreAllMocks();
});

describe("current physical Motion creation ownership (source controls, not mounted/native artwork proof)", () => {
  it("prepares authentic glyphs, submits one ordinary command and gives exactly one Undo without source edits", async () => {
    const h = setup(), before = canonicalJson(h.project), source = canonicalJson([h.project.assets, h.project.tracks]);
    expect(await track(h.owner.start(inputFor(h.session)))).toBe(true);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({ type: "add_motion_graphic", graphic: {
      id: "created-title", text: "新重點", schema: "hao.motion-composition/v2", presetId: "generic-title-v2",
    } });
    expect(h.session.getSnapshot().history.past).toHaveLength(1);
    expect(h.session.getSnapshot().history.journal).toHaveLength(1);
    expect(canonicalJson([h.session.getSnapshot().history.present.assets, h.session.getSnapshot().history.present.tracks])).toBe(source);
    expect(h.statuses[0]).toMatch(/實體字形.*Esc/);
    expect(h.preparers[0].dispose).toHaveBeenCalledTimes(1);
    h.session.setHistory(undo);
    expect(canonicalJson(h.session.getSnapshot().history.present)).toBe(before);
    expect(h.session.getSnapshot().history.past).toHaveLength(0);
  });

  it("cancels a noncooperative late glyph completion with zero commands or Undo entries", async () => {
    const h = setup(true), history = h.session.getSnapshot().history;
    const task = track(h.owner.start(inputFor(h.session)));
    await h.preparers[0].entered.promise;
    h.owner.cancel();
    const statusAfterCancel = [...h.statuses];
    expect(h.preparers[0].signal.aborted).toBe(true);
    h.preparers[0].gate.resolve();
    expect(await task).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(h.session.getSnapshot().history).toBe(history);
    expect(h.submitted).toHaveLength(0);
    expect(h.statuses).toEqual(statusAfterCancel);
    expect(h.preparers[0].dispose).toHaveBeenCalledTimes(1);
  });

  it("a repeat start owns the only commit and an older completion cannot clear its preparer or status", async () => {
    const h = setup(true);
    const old = track(h.owner.start(inputFor(h.session, "old-title", "舊重點")));
    await h.preparers[0].entered.promise;
    const current = track(h.owner.start(inputFor(h.session, "new-title", "新重點")));
    await h.preparers[1].entered.promise;
    expect(h.preparers[0].signal.aborted).toBe(true);
    expect(h.preparers[1].signal.aborted).toBe(false);
    h.preparers[1].gate.resolve();
    expect(await current).toBe(true);
    const statusAfterCurrent = [...h.statuses];
    h.preparers[0].gate.resolve();
    expect(await old).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(h.submitted).toHaveLength(1);
    expect(h.session.getSnapshot().history.present.motionGraphics.map(graphic => graphic.id)).toEqual(["new-title"]);
    expect(h.session.getSnapshot().history.past).toHaveLength(1);
    expect(h.statuses).toEqual(statusAfterCurrent);
    for (const entry of h.preparers) expect(entry.dispose).toHaveBeenCalledTimes(1);
  });

  it("switching to a same-ID project session rejects old completion without writing its status into the replacement", async () => {
    const h = setup(true);
    const old = track(h.owner.start(inputFor(h.session)));
    await h.preparers[0].entered.promise;
    h.session.replaceProject(structuredClone(h.project));
    const replacement = h.session.getSnapshot(), statuses = [...h.statuses];
    h.preparers[0].gate.resolve();
    expect(await old).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(h.session.getSnapshot()).toBe(replacement);
    expect(h.submitted).toHaveLength(0);
    expect(h.statuses).toEqual(statuses);
  });

  it("an edit followed by Undo never revives a pending preparation even when canonical content returns", async () => {
    const h = setup(true), before = canonicalJson(h.project);
    const task = track(h.owner.start(inputFor(h.session)));
    await h.preparers[0].entered.promise;
    h.session.setHistory(history => dispatchCommand(history, { type: "rename_project", name: "Changed while preparing" }));
    h.session.setHistory(undo);
    expect(canonicalJson(h.session.getSnapshot().history.present)).toBe(before);
    const afterUndo = h.session.getSnapshot().history;
    h.preparers[0].gate.resolve();
    expect(await task).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(h.session.getSnapshot().history).toBe(afterUndo);
    expect(h.submitted).toHaveLength(0);
    expect(h.preparers[0].signal.aborted).toBe(true);
  });

  it("a real session save acknowledgment revision cancels work without adding an Undo or undoing the save", async () => {
    const h = setup(true);
    const task = track(h.owner.start(inputFor(h.session)));
    await h.preparers[0].entered.promise;
    const request = h.session.beginSave()!;
    expect(h.preparers[0].signal.aborted).toBe(false);
    const saved = { ...structuredClone(request.project), revision: request.project.revision + 1, updatedAt: "2026-10-03T04:00:00.000Z" };
    expect(h.session.completeSave(request, { path: "D:/fixture-only/saved.editkin.json", project: saved })).toBe(true);
    h.session.finishSave(request);
    const afterSave = h.session.getSnapshot();
    expect(h.preparers[0].signal.aborted).toBe(true);
    h.preparers[0].gate.resolve();
    expect(await task).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(h.session.getSnapshot()).toBe(afterSave);
    expect(h.submitted).toHaveLength(0);
    expect(afterSave.history.past).toHaveLength(0);
    expect(afterSave.diskRevision).toBe(1);
  });

  it("detects in-place metadata drift even without a session publication or revision change", async () => {
    const h = setup(true);
    const task = track(h.owner.start(inputFor(h.session)));
    await h.preparers[0].entered.promise;
    h.session.getSnapshot().history.present.updatedAt = "2026-10-03T04:01:00.000Z";
    const afterEdit = canonicalJson(h.session.getSnapshot().history);
    h.preparers[0].gate.resolve();
    expect(await task).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(canonicalJson(h.session.getSnapshot().history)).toBe(afterEdit);
    expect(h.submitted).toHaveLength(0);
  });

  it("StrictMode cleanup and reattach allow fresh work but never revive the detached operation", async () => {
    const h = setup(true);
    const old = track(h.owner.start(inputFor(h.session, "detached-title")));
    await h.preparers[0].entered.promise;
    h.detach();
    expect(await track(h.owner.start(inputFor(h.session, "unmounted-title")))).toBe(false);
    const reattached = h.owner.attach(); cleanups.push(reattached);
    h.detach(); // A stale cleanup must not detach the new attachment.
    const current = track(h.owner.start(inputFor(h.session, "reattached-title")));
    await h.preparers[1].entered.promise;
    h.preparers[1].gate.resolve();
    expect(await current).toBe(true);
    const statuses = [...h.statuses];
    h.preparers[0].gate.resolve();
    expect(await old).toBe(false);
    await finishGlyphWork(h.preparers[0]);
    expect(h.submitted).toHaveLength(1);
    expect(h.session.getSnapshot().history.present.motionGraphics[0].id).toBe("reattached-title");
    expect(h.statuses).toEqual(statuses);
  });

  it("pins the requested scope and text rather than using caller mutations during font I/O", async () => {
    const h = setup(true), input = inputFor(h.session);
    const task = track(h.owner.start(input));
    await h.preparers[0].entered.promise;
    input.scope = "empty_canvas"; input.text = "改掉內容"; input.startFrame = 239;
    h.preparers[0].gate.resolve();
    expect(await task).toBe(true);
    expect(h.submitted[0]).toMatchObject({ type: "add_motion_graphic", graphic: { text: "新重點", timelineStart: 0 } });
  });

  it("reports insufficient actual tail space without extending the timeline or leaving a preparer alive", async () => {
    const h = setup(), before = canonicalJson(h.session.getSnapshot().history);
    expect(await track(h.owner.start({ ...inputFor(h.session), startFrame: 239, preferredDurationFrames: 90 }))).toBe(false);
    expect(h.submitted).toHaveLength(0);
    expect(canonicalJson(h.session.getSnapshot().history)).toBe(before);
    expect(h.statuses.at(-1)).toMatch(/無法建立圖卡.*MOTION_CREATION_WINDOW/);
    expect(h.preparers[0].dispose).toHaveBeenCalledTimes(1);
  });
});

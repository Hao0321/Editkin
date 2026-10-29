import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import { canonicalJson } from "../shared/canonicalJson";
import { undo, redo } from "../domain/history";
import { writeProceduralSfxPackV1 } from "./proceduralSfxPackV1";
import { createProceduralSfxLibraryV1, type ProceduralSfxLibraryV1 } from "./proceduralSfxLibraryV1";
import { createProjectSession } from "./projectSession";
import { beginEditorialDataGraphicsV1, prepareEditorialDataGraphicsV1, applyPreparedEditorialDataGraphicsV1 } from "./editorialDataGraphicsV1";

let root: string, library: ProceduralSfxLibraryV1;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-editorial-data-control-"));
  const pins = await Promise.all(["Catalogue", "Synth"].map(async kind => { const path = `src/application/proceduralSfx${kind}V1.ts`, bytes = await readFile(path); return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }));
  await writeProceduralSfxPackV1(join(root, "pack"), pins); library = await createProceduralSfxLibraryV1(join(root, "pack"), pins);
});
afterAll(async () => { if (root) { await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "editorialDataGraphicsV1.test.ts", root, testsTerminal: true }), { flag: "wx" }); console.log(`EDITORIAL_DATA_OWNED_TEST_FIXTURE=${root}`); } });
const sound = { enabled: true as const, variant: 1, gain: .42, trackId: "audio-main" };
function fixture() { const p = createEmptyProject("One Undo data control", { id: "data-owner", fps: 30, width: 640, height: 360 }); return { p, session: createProjectSession(p) }; }
const graphic = () => createMotionGraphic("datum", "counter", "3", 0, 3);
const hooks = () => [1, 2, 30, 89].map(frame => ({ graphicId: "datum", role: "control", frame, text: "3", phase: "state" as const }));
async function prepare(f = fixture(), selectedLibrary = library, runtime = {}) {
  const c = beginEditorialDataGraphicsV1(f.session, 0, runtime);
  return { ...f, plan: await prepareEditorialDataGraphicsV1(c, "challenge_progress", [{ type: "add_motion_graphic", graphic: graphic() }], { control: true }, hooks(), 90, "datum", sound, selectedLibrary) };
}
describe("one process-owned visual/audio draft and existing live history batch", () => {
  it("reuses whole WAV selection, re-resolves at apply and adds graphics plus sounds in one Undo", async () => {
    let resolves = 0; const host = { ...library, resolve: async (...args: Parameters<typeof library.resolve>) => { resolves++; return library.resolve(...args); } };
    const { p, session, plan } = await prepare(fixture(), host), before = canonicalJson(p);
    expect(plan.sound!.selected.map(h => h.frame)).toEqual([1, 30]); expect(plan.sound!.suppressed.map(h => h.reason).sort()).toEqual(["full_sound_tail", "sound_overlap"]);
    expect(resolves).toBe(1); expect(canonicalJson(p)).toBe(before); expect(session.getSnapshot().history.past).toHaveLength(0);
    await applyPreparedEditorialDataGraphicsV1(session, plan); const h = session.getSnapshot().history;
    expect(resolves).toBe(2); expect(h.past).toHaveLength(1); expect(h.present.motionGraphics).toEqual([graphic()]);
    expect(h.present.tracks.find(t => t.id === sound.trackId)!.clips).toHaveLength(2); expect(h.present.assets).toHaveLength(1);
    expect(canonicalJson(undo(h).present)).toBe(before); expect(redo(undo(h)).present).toEqual(h.present);
    await expect(applyPreparedEditorialDataGraphicsV1(session, plan)).rejects.toThrow("PACKET_INVALID");
  });
  it.each(["foreign-session", "JSON-clone", "tampered", "reopen", "in-place", "cancel-apply", "WAV-changed"])("refuses %s without a partial graphic or audio edit", async reason => {
    const f = fixture(); let failSource = false;
    const host = { ...library, resolve: async (...args: Parameters<typeof library.resolve>) => { if (failSource) throw Error("ACTUAL_WAV_REFERENCE_MISMATCH"); return library.resolve(...args); } };
    const { session, plan } = await prepare(f, host); let target = session, packet = plan;
    if (reason === "foreign-session") target = createProjectSession(f.p);
    if (reason === "JSON-clone") packet = structuredClone(plan);
    if (reason === "tampered") plan.hooks[0].frame++;
    if (reason === "reopen") session.replaceProject(structuredClone(f.p)); if (reason === "in-place") f.p.name = "User changed project";
    if (reason === "WAV-changed") failSource = true;
    const controller = new AbortController(); if (reason === "cancel-apply") controller.abort(Error("user-stop"));
    await expect(applyPreparedEditorialDataGraphicsV1(target, packet, controller.signal)).rejects.toThrow();
    expect(target.getSnapshot().history.past).toHaveLength(0); expect(target.getSnapshot().history.present.motionGraphics).toHaveLength(0); expect(target.getSnapshot().history.present.assets).toHaveLength(0);
  });
  it("stale changes during apply file await leave the live project untouched", async () => {
    const f = fixture(); let reads = 0;
    const host = { ...library, resolve: async (...args: Parameters<typeof library.resolve>) => { const reply = await library.resolve(...args); if (++reads === 2) f.p.name = "Changed during file verification"; return reply; } };
    const { plan } = await prepare(f, host); await expect(applyPreparedEditorialDataGraphicsV1(f.session, plan)).rejects.toThrow("PROJECT_CHANGED");
    expect(f.session.getSnapshot().history.past).toHaveLength(0); expect(f.p.motionGraphics).toHaveLength(0);
  });
  it("bounds a nonresponsive catalogue and preserves the exact parent cancellation", async () => {
    const f = fixture(), never = { ...library, list: () => new Promise<Awaited<ReturnType<typeof library.list>>>(() => {}) };
    await expect(prepare(f, never, { timeoutMs: 15 })).rejects.toThrow("TIMEOUT");
    const controller = new AbortController(), reason = Error("catalogue-stop");
    const pending = prepare(f, never, { signal: controller.signal }); setTimeout(() => controller.abort(reason), 5);
    await expect(pending).rejects.toBe(reason); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("starts a fresh bounded apply phase after an idle prepared visual-only plan", async () => {
    const f = fixture(), c = beginEditorialDataGraphicsV1(f.session, 0, { timeoutMs: 40 });
    const plan = await prepareEditorialDataGraphicsV1(c, "value_ladder", [{ type: "add_motion_graphic", graphic: graphic() }], {}, hooks(), 90, "idle");
    await new Promise(resolve => setTimeout(resolve, 50)); await applyPreparedEditorialDataGraphicsV1(f.session, plan);
    expect(f.session.getSnapshot().history.past).toHaveLength(1);
  });
  it("rejects an occupied/locked target, missing explicit library, or a stale source during list", async () => {
    const locked = fixture(); locked.p.tracks.find(t => t.id === sound.trackId)!.locked = true; await expect(prepare(locked)).rejects.toThrow("UNAVAILABLE");
    const f = fixture(), c = beginEditorialDataGraphicsV1(f.session, 0);
    await expect(prepareEditorialDataGraphicsV1(c, "value_ladder", [], {}, hooks(), 90, "x", sound)).rejects.toThrow("LIBRARY_REQUIRED");
    await expect(prepare(f, { ...library, list: async (...args) => { const page = await library.list(...args); f.session.replaceProject(structuredClone(f.p)); return page; } })).rejects.toThrow("PROJECT_CHANGED");
    expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
});

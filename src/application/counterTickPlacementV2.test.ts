import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { undo, redo } from "../domain/history";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import type { MotionGraphic } from "../domain/types";
import type { ProceduralSfxLibraryEntryV1 } from "../domain/proceduralSfxLibraryContractV1";
import { canonicalJson } from "../shared/canonicalJson";
import { createProjectSession } from "./projectSession";
import { applyPreparedProceduralSfxPlacementV1 } from "./proceduralSfxPlacementV1";
import { prepareCounterTickPlacementV2 } from "./counterTickPlacementV2";
function fixture() {
  const p = createEmptyProject("Counter placement unit", { width: 640, height: 360, fps: 30 });
  p.motionGraphics = [{ ...structuredClone(MOTION_DESIGN_V3_PRESETS.find(x => x.id === "v3_stat_counter")!.seed), id: "modern", timelineStart: 0, duration: 3, text: "100\nCounter control" } as MotionGraphic];
  const session = createProjectSession(p), request = { schema: "editkin.counter-ticks/v2", enabled: true, durationFrames: 180, trackId: "audio-main", idPrefix: "ticks", bindings: [{ source: "compiled_v3_counter", graphicId: "modern" }], sound: { variant: 1, gain: .42 } };
  // Deliberate unit-only source resolver double; actual pinned pack is exercised separately.
  const entry: ProceduralSfxLibraryEntryV1 = { id: "sfx:editkin-procedural-v1-tick-01", name: "Instrument tick", kind: "tick", bytes: 9644, durationSamples: 4800, durationSeconds: .1,
    sha256: "a".repeat(64), sourceSha256: "b".repeat(64), source: "local-original-mathematical-synthesis", rightsBasis: "owner-authorized-local-generation", distributionScope: "private-owner-only",
    certification: "AUDIO_PENDING_HAO_CLAUDE", defaultEnabled: false, redistributable: false, contentVerified: true };
  const library = { list: vi.fn(async () => ({ entries: [entry], total: 1 })), resolve: vi.fn(async (_reference: { id: string; sha256: string }, _signal?: AbortSignal) => ({ entry, absolutePath: "D:/instrument-only-tick.wav" })) };
  return { p, session, request, entry, library };
}
describe("compiled v3 hooks reuse the verified placement/apply owner", () => {
  it("analysis is read-only; existing apply preserves all graphics and makes one Undo", async () => {
    const f = fixture(), before = canonicalJson(f.p), r = await prepareCounterTickPlacementV2(f.session, f.library, f.request);
    expect(canonicalJson(f.p)).toBe(before); expect(f.session.getSnapshot().history.past).toHaveLength(0); expect(f.library.resolve).toHaveBeenCalledTimes(1);
    const result = await applyPreparedProceduralSfxPlacementV1(f.session, r.placement), history = f.session.getSnapshot().history;
    expect(result.undoSteps).toBe(1); expect(f.library.resolve).toHaveBeenCalledTimes(2); expect(history.past).toHaveLength(1); expect(history.present.motionGraphics).toEqual(f.p.motionGraphics);
    expect(history.present.tracks[1].clips.map(c => Math.round(c.timelineStart * f.p.fps))).toEqual(r.visual.selected.map(h => h.frame));
    expect(history.present.tracks[1].clips.every(c => c.duration === .1 && c.volume === .42)).toBe(true); expect(undo(history).present).toEqual(f.p); expect(redo(undo(history)).present).toEqual(history.present);
    await expect(applyPreparedProceduralSfxPlacementV1(f.session, r.placement)).rejects.toThrow("PACKET_INVALID");
  });
  it.each(["locked", "muted", "source-missing", "unverified", "default-promotion"])("refuses %s without a partial import", async reason => {
    const f = fixture(); if (reason === "locked") f.p.tracks[1].locked = true; if (reason === "muted") f.p.tracks[1].muted = true;
    if (reason === "source-missing") f.library.list.mockResolvedValue({ entries: [], total: 0 }); if (reason === "unverified") f.entry.contentVerified = false;
    if (reason === "default-promotion") f.entry.defaultEnabled = true as never;
    await expect(prepareCounterTickPlacementV2(f.session, f.library, f.request)).rejects.toThrow(); expect(f.session.getSnapshot().history.past).toHaveLength(0); expect(f.p.assets).toHaveLength(0);
  });
  it("refuses missing or edited saved instances before requesting any source", async () => {
    const f = fixture(); await expect(prepareCounterTickPlacementV2(f.session, f.library, { ...f.request, bindings: [{ source: "reference_instance", instanceId: "absent" }] })).rejects.toThrow("INSTANCE_MISSING");
    expect(f.library.list).not.toHaveBeenCalled(); expect(f.library.resolve).not.toHaveBeenCalled();
  });
  it.each(["session", "graph-in-place"])("rejects a %s change during catalogue resolution", async kind => {
    const f = fixture(); f.library.list.mockImplementationOnce(async () => { if (kind === "session") f.session.replaceProject(structuredClone(f.p)); else f.p.motionGraphics[0].text = "999\nChanged"; return { entries: [f.entry], total: 1 }; });
    await expect(prepareCounterTickPlacementV2(f.session, f.library, f.request)).rejects.toThrow("PROJECT_CHANGED"); expect(f.library.resolve).not.toHaveBeenCalled();
  });
  it("does not apply a packet after an in-place graphic change, even if session identity did not change", async () => {
    const f = fixture(), r = await prepareCounterTickPlacementV2(f.session, f.library, f.request); f.p.motionGraphics[0].text = "999\nChanged after analysis";
    await expect(applyPreparedProceduralSfxPlacementV1(f.session, r.placement)).rejects.toThrow("PROJECT_CHANGED"); expect(f.session.getSnapshot().history.past).toHaveLength(0);
  });
  it("rechecks the source graph after the final apply-time source await", async () => {
    const f = fixture(), r = await prepareCounterTickPlacementV2(f.session, f.library, f.request);
    f.library.resolve.mockImplementationOnce(async () => { f.p.name = "changed during commit verification"; return { entry: f.entry, absolutePath: "D:/instrument-only-tick.wav" }; });
    await expect(applyPreparedProceduralSfxPlacementV1(f.session, r.placement)).rejects.toThrow("PROJECT_CHANGED"); expect(f.p.assets).toHaveLength(0);
  });
  it("cancels a pending source list promptly and ignores its late resolution", async () => {
    const f = fixture(), c = new AbortController(), reason = Error("cancel-pending-list"), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<{ entries: ProceduralSfxLibraryEntryV1[]; total: number }>();
    f.library.list.mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const pending = prepareCounterTickPlacementV2(f.session, f.library, f.request, c.signal); await entered.promise; c.abort(reason); await expect(pending).rejects.toBe(reason);
    gate.resolve({ entries: [f.entry], total: 1 }); await Promise.resolve(); expect(f.library.resolve).not.toHaveBeenCalled(); expect(f.p.assets).toHaveLength(0);
  });
  it("counts a pending source list against one total preparation deadline", async () => {
    const f = fixture(); f.library.list.mockImplementationOnce(() => new Promise(() => {}));
    await expect(prepareCounterTickPlacementV2(f.session, f.library, f.request, undefined, { timeoutMs: 30 })).rejects.toThrow("TIMEOUT"); expect(f.p.assets).toHaveLength(0);
  });
  it("retains source binding, foreign-packet rejection and a single successful concurrent apply", async () => {
    const f = fixture(), r = await prepareCounterTickPlacementV2(f.session, f.library, f.request);
    await expect(applyPreparedProceduralSfxPlacementV1(f.session, { ...r.placement })).rejects.toThrow("PACKET_INVALID");
    const applied = await Promise.allSettled([applyPreparedProceduralSfxPlacementV1(f.session, r.placement), applyPreparedProceduralSfxPlacementV1(f.session, r.placement)]);
    expect(applied.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.session.getSnapshot().history.past).toHaveLength(1);
  });
  it("preserves runtime identity and refuses conflicting cancellation owners", async () => {
    const f = fixture(); await expect(prepareCounterTickPlacementV2(f.session, f.library, f.request, new AbortController().signal, { signal: new AbortController().signal })).rejects.toThrow("SINGLE_LIFETIME");
    expect(f.library.list).not.toHaveBeenCalled();
  });
});

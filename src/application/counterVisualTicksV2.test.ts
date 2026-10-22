import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic } from "../motion/composition";
import type { MotionGraphic } from "../domain/types";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { deriveCounterVisualTicksV1 } from "./counterVisualTicksV1";
import { counterTickRequestV2Schema, deriveCounterVisualTicksV2 } from "./counterVisualTicksV2";
function fixture() {
  const p = createEmptyProject("Explicit v3 hook control", { width: 640, height: 360, fps: 30 });
  p.motionGraphics = [{ ...structuredClone(MOTION_DESIGN_V3_PRESETS.find(x => x.id === "v3_stat_counter")!.seed), id: "modern", timelineStart: 0, duration: 3, text: "100\nCounter control" } as MotionGraphic];
  const request = { schema: "editkin.counter-ticks/v2" as const, enabled: true as const, durationFrames: 300, trackId: "audio-main", idPrefix: "v3-count", bindings: [{ source: "compiled_v3_counter" as const, graphicId: "modern" }], sound: { variant: 1, gain: .42 } };
  return { p, request };
}
describe("opt-in v2 count ticks keep one complete-WAV selector", () => {
  it("selects only actual draw-op changes, prioritizes the real final and reports dense omissions", async () => {
    const f = fixture(), r = await deriveCounterVisualTicksV2(f.p, f.request);
    expect(r.hooks[0].frame).toBe(2); expect(r.hooks.at(-1)).toMatchObject({ frame: 27, text: "100", phase: "final" });
    expect(r.selected).toContainEqual(r.hooks.at(-1)); expect(r.suppressed.length).toBeGreaterThan(0);
    expect(r.selected.every(h => r.hooks.includes(h))).toBe(true); expect(r.selected.length + r.suppressed.length).toBe(r.hooks.length);
    expect(r.qualityState).toBe("AUDIO_PENDING_HAO_CLAUDE"); expect(r.defaultEnabled).toBe(false); expect(r.storedWholeFrames).toBe(0); expect(r.diagnostics.length).toBeLessThanOrEqual(8);
  });
  it("legacy-only v2 requests keep all original hook/selection/suppression fields exact", async () => {
    const f = fixture(); f.p.motionGraphics = [0, 2, 4, 6, 15].map((n, i) => createMotionGraphic("state-" + i, "counter", String(i), n / 30, 1 / 30));
    const old = { enabled: true, durationFrames: 300, trackId: "audio-main", idPrefix: "states", bindings: [{ source: "editorial_states", role: "challenge_ledger", graphicIds: f.p.motionGraphics.map(g => g.id) }], sound: { variant: 1, gain: .42 } };
    const before = deriveCounterVisualTicksV1(f.p, old), after = await deriveCounterVisualTicksV2(f.p, { ...old, schema: "editkin.counter-ticks/v2" });
    for (const key of ["hooks", "selected", "suppressed", "soundId", "durationSamples"] as const) expect(after[key]).toEqual(before[key]); expect(after.analyzedFrames).toBe(0);
  });
  it("mixes compiled and explicit state bindings without treating v3 onset as a tick", async () => {
    const f = fixture(); f.p.motionGraphics.push(createMotionGraphic("state", "counter", "Round 2", 4, 1));
    const r = await deriveCounterVisualTicksV2(f.p, { ...f.request, bindings: [...f.request.bindings, { source: "editorial_states", role: "challenge_ledger", graphicIds: ["state"] }] });
    expect(r.hooks).toContainEqual({ graphicId: "state", frame: 120, text: "Round 2", role: "challenge_ledger", phase: "state" }); expect(r.hooks.find(h => h.graphicId === "modern")?.frame).toBe(2);
  });
  it("retains v1's explicit refusal of an onset-only dynamic v3 request", () => {
    const f = fixture(), { schema: _schema, ...r } = f.request;
    expect(() => deriveCounterVisualTicksV1(f.p, { ...r, bindings: [{ source: "editorial_states", role: "challenge_ledger", graphicIds: ["modern"] }] })).toThrow("V3_TICKS_UNSUPPORTED");
  });
  it.each(["duplicate", "outside", "total-budget", "request-extra", "disabled", "sound", "invalid-clock"])("refuses %s with no partial result", async reason => {
    const f = fixture(); let request: unknown = f.request, runtime = {};
    if (reason === "duplicate") f.request.bindings.push(f.request.bindings[0]); if (reason === "outside") f.request.durationFrames = 30;
    if (reason === "total-budget") runtime = { maximumTotalFrames: 89 }; if (reason === "request-extra") request = { ...f.request, force: true };
    if (reason === "disabled") request = { ...f.request, enabled: false }; if (reason === "sound") request = { ...f.request, sound: { variant: 6, gain: .42 } };
    if (reason === "invalid-clock") f.p.fps = 0;
    await expect(deriveCounterVisualTicksV2(f.p, request, runtime)).rejects.toThrow();
  });
  it("rejects a real aggregate over256 hooks instead of silently losing count events", async () => {
    const f = fixture(); f.p.fps = 240; f.p.motionGraphics[0].text = "99999999\nDense control";
    f.p.motionGraphics.push({ ...structuredClone(f.p.motionGraphics[0]), id: "second", timelineStart: 3 });
    await expect(deriveCounterVisualTicksV2(f.p, { ...f.request, durationFrames: 1500, bindings: [...f.request.bindings, { source: "compiled_v3_counter", graphicId: "second" }] })).rejects.toThrow("HOOK_BUDGET");
  });
  it("keeps total diagnostics bounded across more than one compiled graphic", async () => {
    const f = fixture(); f.p.motionGraphics.push({ ...structuredClone(f.p.motionGraphics[0]), id: "second", timelineStart: 3, text: "3\nSecond" });
    const r = await deriveCounterVisualTicksV2(f.p, { ...f.request, bindings: [...f.request.bindings, { source: "compiled_v3_counter", graphicId: "second" }] });
    expect(r.analyses).toHaveLength(2); expect(r.diagnostics).toHaveLength(8); expect(r.diagnostics.every(d => d.graphicId === "second")).toBe(true);
    expect(r.analyses.every(a => !("hooks" in a) && !("diagnostics" in a))).toBe(true);
  });
  it("refuses a source graph edit made in progress while preserving explicit cancellation", async () => {
    const f = fixture(); await expect(deriveCounterVisualTicksV2(f.p, f.request, { onProgress: p => { if (p.completed === 64) f.p.name = "changed in place"; } })).rejects.toThrow("PROJECT_CHANGED");
    const g = fixture(), c = new AbortController(), reason = Error("cancel-v2"); c.abort(reason); await expect(deriveCounterVisualTicksV2(g.p, g.request, { signal: c.signal })).rejects.toBe(reason);
  });
  it("strict schema does not let clients set approval, source paths or a private frame budget", () => {
    const f = fixture(); for (const fields of [{ approved: true }, { sourcePath: "foreign.wav" }, { maximumTotalFrames: 9999999 }]) expect(() => counterTickRequestV2Schema.parse({ ...f.request, ...fields })).toThrow();
  });
});

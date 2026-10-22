import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { MOTION_DESIGN_V3_PRESETS } from "../creative/motionDesignV3Presets";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import type { MotionGraphic } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { analyzeCompiledCounterFramesV3 } from "./counterCompiledFramesV3";
function fixture(copy = "100\nCount control") {
  const p = createEmptyProject("Compiled-count instrument", { id: "count-test", width: 640, height: 360, fps: 30 });
  p.motionGraphics = [{ ...structuredClone(MOTION_DESIGN_V3_PRESETS.find(x => x.id === "v3_stat_counter")!.seed), id: "counter", timelineStart: 1, duration: 3, text: copy } as MotionGraphic]; return p;
}
describe("bounded frozen v3 value-op producer", () => {
  it.each(["100\nCount control", "NT$4,990\nPrice control", "3 支\nCount control", "12.50%\nRatio control"])("reads actual compiler changes for %s without another interpolator", async copy => {
    const p = fixture(copy), before = canonicalJson(p), g = p.motionGraphics[0], layout = motionGraphicV3Layout(p, g), oracle: { frame: number; text: string }[] = [];
    let prior = "";
    for (let f = 30; f < 120; f++) { const text = motionGraphicV3Frame(p, g, f, layout).ops.filter(o => o.kind === "text" && o.id.startsWith("value:") && !o.id.endsWith(":shadow")).map(o => o.kind === "text" ? o.text : "").join("");
      if (text && text !== prior) { oracle.push({ frame: f, text }); prior = text; } }
    const r = await analyzeCompiledCounterFramesV3(p, "counter"); expect(r.hooks.map(({ frame, text }) => ({ frame, text }))).toEqual(oracle);
    expect(r.hooks.at(-1)?.phase).toBe("final"); expect(r.hooks.filter(h => h.phase === "final")).toHaveLength(1); expect(canonicalJson(p)).toBe(before);
    expect(r.analyzedFrames).toBe(90); expect(r.diagnostics).toHaveLength(8); expect(r.storedWholeFrames).toBe(0); expect(r.compositedPixelVisibilityCertified).toBe(false);
  });
  it("a real zero target ticks at its first drawn numeric op, not at the graphic onset", async () => {
    const r = await analyzeCompiledCounterFramesV3(fixture("0\nZero control"), "counter");
    expect(r.hooks).toEqual([{ graphicId: "counter", role: "compiled_v3:stat_counter:value", frame: 32, text: "0", phase: "final" }]);
  });
  it("refuses a valid but too-short counter whose final value never gets drawn", async () => {
    const p = fixture("100000\nShort control"); p.motionGraphics[0].duration = 1;
    await expect(analyzeCompiledCounterFramesV3(p, "counter")).rejects.toThrow("FINAL_VALUE_NOT_DRAWN");
  });
  it.each(["missing", "duplicate", "family", "non-numeric", "multiple-numbers", "subframe", "duration-clock", "raster", "fps"])("refuses %s before returning hooks", async reason => {
    const p = fixture(); let id = "counter";
    if (reason === "missing") id = "absent"; if (reason === "duplicate") p.motionGraphics.push(structuredClone(p.motionGraphics[0]));
    if (reason === "family") p.motionGraphics[0].designV3!.template = "progress_bar";
    if (reason === "non-numeric") p.motionGraphics[0].text = "AI\nNo value"; if (reason === "multiple-numbers") p.motionGraphics[0].text = "3/5\nAmbiguous value";
    if (reason === "subframe") p.motionGraphics[0].timelineStart = .01; if (reason === "duration-clock") p.motionGraphics[0].duration = 1.001;
    if (reason === "raster") p.width = Infinity; if (reason === "fps") p.fps = 0;
    await expect(analyzeCompiledCounterFramesV3(p, id)).rejects.toThrow();
  });
  it.each([{ maximumFrames: 89 }, { maximumFrames: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60001 }])("enforces declared analysis budget %j", async runtime => {
    await expect(analyzeCompiledCounterFramesV3(fixture(), "counter", runtime)).rejects.toThrow("BUDGET");
  });
  it("yields to a real event-loop cancellation and preserves the exact parent reason", async () => {
    const c = new AbortController(), reason = Error("event-loop-stop"), progress: number[] = [];
    await expect(analyzeCompiledCounterFramesV3(fixture(), "counter", { signal: c.signal, onProgress: p => { progress.push(p.completed); if (p.completed === 64) setTimeout(() => c.abort(reason), 0); } })).rejects.toBe(reason);
    expect(progress).toEqual([0, 64]);
  });
  it("detects the same-id source change across a cooperative yield", async () => {
    const p = fixture(); await expect(analyzeCompiledCounterFramesV3(p, "counter", { onProgress: r => { if (r.completed === 64) p.motionGraphics[0].text = "999\nChanged"; } })).rejects.toThrow("SOURCE_CHANGED");
  });
  it("uses one elapsed deadline and immutable runtime options", async () => {
    await expect(analyzeCompiledCounterFramesV3(fixture(), "counter", { timeoutMs: 1, onProgress: () => { const end = performance.now() + 4; while (performance.now() < end) { /* Tiny deterministic synchronous overrun. */ } } })).rejects.toThrow("TIMEOUT");
    const runtime = { timeoutMs: 5000, maximumFrames: 90, onProgress: () => { runtime.timeoutMs = 0; runtime.maximumFrames = 0; } };
    expect((await analyzeCompiledCounterFramesV3(fixture(), "counter", runtime)).analyzedFrames).toBe(90);
  });
  it("retains a 20-hour placement coordinate without signed integer wrapping", async () => {
    const p = fixture("0\nLate control"); p.motionGraphics[0].timelineStart = 72000;
    const r = await analyzeCompiledCounterFramesV3(p, "counter"); expect(r.hooks[0].frame).toBe(2160002); expect(Math.round(r.hooks[0].frame * 48000 / p.fps)).toBe(3456003200);
  });
});

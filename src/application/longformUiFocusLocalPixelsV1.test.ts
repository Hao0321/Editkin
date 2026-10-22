import { expect, it } from "vitest";
import { uiFocusHoldFixtureV1 } from "./longformUiFocusHoldV1.fixture";
import { locateLongformUiFocusPixelsV1 } from "./longformUiFocusLocalPixelsV1";
import { assembleLongformUiFocusHoldEvidenceV1 } from "./longformUiFocusHoldV1";

it.each([false, true])("measures every actual frame against the immutable initial pixels, translation=%s", async translation => {
  const f = uiFocusHoldFixtureV1({ translation }), rows = await locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels);
  expect(rows).toHaveLength(24);
  for (const [frame, row] of rows.entries()) {
    expect(row.state).toBe("measured"); expect(row.correlation).toBeCloseTo(1, 10); expect(row.difference).toBeLessThan(1e-8);
    expect(row.targetQuad[0].x - f.candidate.quad[0].x).toBeCloseTo((translation ? frame : 0) / 160, 10);
    if (frame) { expect(row.testedOffsets).toBeGreaterThan(0); expect(row.verifiedHypotheses).toBe(1); }
  }
});
it("retains native failure diagnostics while independently measuring all current target pixels", async () => {
  const f = uiFocusHoldFixtureV1({ translation: true });
  f.plan.points.slice(1).forEach(p => { p.status = "lost"; p.confidence = 0; p.planarDiagnostics!.globalSearch = true; });
  f.plan.lostRatio = 23 / 24;
  const rows = await locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels);
  const result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan, rows);
  expect(result.state).toBe("TRACKING_EVIDENCE_READY"); expect(result.focusHintsReady).toBe(false);
  expect(result.frames.every(row => row.trackingProvider === "independent-local-pixels")).toBe(true);
  expect(result.frames[1].nativeStatus).toBe("lost"); expect(result.frames[1].nativeConfidence).toBe(0);
  expect(result.frames[1].nativeDiagnostics).toEqual(["TRACK_NOT_CONTINUOUS", "LOW_UNCALIBRATED_TRACK_SCORE", "REACQUISITION_REQUIRES_NEW_CONFIRMATION"]);
});
it("retires on disappearance and never reacquires when identical text pixels return later", async () => {
  const f = uiFocusHoldFixtureV1(), size = f.sequence.width * f.sequence.height;
  f.pixels.fill(240, 8 * size, 9 * size); f.resealPixels();
  const rows = await locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels);
  expect(rows[7].state).toBe("measured"); expect(rows[8].state).toBe("missing");
  expect(rows.slice(9).every(row => row.state === "retired" && row.targetQuad.length === 0 && row.testedOffsets === 0)).toBe(true);
  expect(assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan, rows).state).toBe("BLOCKED");
});
it("refuses competing repeated pixel patterns instead of picking a convenient location", async () => {
  const f = uiFocusHoldFixtureV1(), { width, height } = f.sequence;
  for (let frame = 0; frame < 24; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    f.pixels[frame * width * height + y * width + x] = ((x % 4) * 57 + (y % 4) * 33) % 220 + 20;
  f.resealPixels(); const rows = await locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels);
  expect(rows[1].state).toBe("ambiguous"); expect(rows[1].verifiedHypotheses).toBeGreaterThan(1);
  expect(rows.slice(2).every(row => row.state === "retired")).toBe(true);
});
it("retires at a same-decode cut even when the target pixels remain identical", async () => {
  const f = uiFocusHoldFixtureV1(); f.sequence.cuts = [{ frame: 12, sourceTime: .6, score: 10 }];
  const rows = await locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels);
  expect(rows[11].state).toBe("measured"); expect(rows.slice(12).every(row => row.state === "retired")).toBe(true);
  const result = assembleLongformUiFocusHoldEvidenceV1(f.draft, f.request, f.sequence, f.pixels, f.plan, rows);
  expect(result.flags).toContain("SCENE_CHANGE_REQUIRES_NEW_CONFIRMATION"); expect(result.state).toBe("BLOCKED");
});
it("rejects a textureless template and responds to asynchronous cancellation during pixel analysis", async () => {
  const f = uiFocusHoldFixtureV1(), controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  await expect(locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  f.pixels.fill(128); f.resealPixels();
  expect((await locateLongformUiFocusPixelsV1(f.draft, f.request, f.sequence, f.pixels)).every(row => row.state === "retired")).toBe(true);
});

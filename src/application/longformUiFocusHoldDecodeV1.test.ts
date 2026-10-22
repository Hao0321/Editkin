import { expect, it } from "vitest";
import { uiFocusHoldFixtureV1 } from "./longformUiFocusHoldV1.fixture";
import { parseLongformUiFocusHoldDecodeV1 } from "./longformUiFocusHoldRuntimeV1";
import { colorBytesSha } from "./materialColorSamplingRuntime";
it("binds the same-decode gray bytes, integer duration/PTS and scdet observations without changing source time to ordinal/fps", () => {
  const f = uiFocusHoldFixtureV1(), parsed = parseLongformUiFocusHoldDecodeV1(f.log + "[scdet] lavfi.scd.score: 12.000, lavfi.scd.time: 0.600\n", f.pixels, f.draft, f.request);
  expect(parsed.frames).toEqual(f.sequence.frames); expect(parsed.cuts).toEqual([{ frame: 12, sourceTime: .6, score: 12 }]);
  expect(parsed.frames[0].sourceTime).toBe(.2); expect(parsed.frames[0].pts).toBe(6); expect(parsed.rawSha256).toBe(f.sequence.rawSha256);
});
it.each([
  (text: string) => text.replace("config in time_base: 1/30", "config in time_base: 0/30"),
  (text: string) => text.replace("n: 3 pts: 9", "n: 4 pts: 9"),
  (text: string) => text.replace("duration: 1 duration_time:0.0333333", "duration: 0 duration_time:0"),
  (text: string) => text.replace("fmt:gray", "fmt:rgb24"),
  (text: string) => text.replace("s:160x100", "s:161x100"),
  (text: string) => text.replace("n: 3 pts: 9", "n: 3 pts: 10"),
])("rejects malformed/incomplete clock or byte coverage rather than estimating a missing frame", transform => {
  const f = uiFocusHoldFixtureV1(); expect(() => parseLongformUiFocusHoldDecodeV1(transform(f.log), f.pixels, f.draft, f.request)).toThrow();
});
it("rejects foreign scdet clocks, missing presentation duration and truncated output bytes", () => {
  const f = uiFocusHoldFixtureV1();
  expect(() => parseLongformUiFocusHoldDecodeV1(f.log + "lavfi.scd.score: 10, lavfi.scd.time: 20\n", f.pixels, f.draft, f.request)).toThrow("CUT_CLOCK");
  expect(() => parseLongformUiFocusHoldDecodeV1(f.log.replaceAll("duration: 1", "duration: N/A"), f.pixels, f.draft, f.request)).toThrow("FRAME_BUDGET");
  expect(() => parseLongformUiFocusHoldDecodeV1(f.log, f.pixels.subarray(0, -1), f.draft, f.request)).toThrow("BYTE_COVERAGE");
});
it("uses the next actually decoded integer PTS for millisecond rounding, retaining reported duration and the boundary frame hash", () => {
  const f = uiFocusHoldFixtureV1(), size = 160 * 100, pixels = new Uint8Array(size * 25);
  pixels.set(f.pixels); pixels.set(f.pixels.subarray(0, size), f.pixels.length);
  const log = "[Parsed_showinfo_9 @ 000001] config in time_base: 1/1000, frame_rate: 30/1\n" +
    Array.from({ length: 25 }, (_, n) => "[Parsed_showinfo_9 @ 000001] n: " + n + " pts: " + Math.round(200 + n * 1000 / 30)
      + " pts_time:unused duration: 33 duration_time:0.033 fmt:gray s:160x100\n").join("");
  const result = parseLongformUiFocusHoldDecodeV1(log + "lavfi.scd.score: 20, lavfi.scd.time: 1.000\n", pixels, f.draft, f.request);
  expect(result.frames).toHaveLength(24); expect(result.rawBytes).toBe(f.pixels.length); expect(result.rawSha256).toBe(f.sequence.rawSha256);
  expect(result.frames[1]).toMatchObject({ pts: 233, durationPts: 34, reportedDurationPts: 33, durationAuthority: "next-decoded-pts-with-millisecond-quantization" });
  expect(result.followingFrame).toEqual({ pts: 1000, sourceTime: 1, imageSha256: colorBytesSha(pixels.subarray(24 * size)) });
  expect(result.cuts).toEqual([]);
  for (let i = 1; i < 24; i++) expect(result.frames[i - 1].pts + result.frames[i - 1].durationPts).toBe(result.frames[i].pts);
  expect(() => parseLongformUiFocusHoldDecodeV1(log.replace("n: 7 pts: 433", "n: 7 pts: 436"), pixels, f.draft, f.request)).toThrow("CLOCK_OR_PIXEL_COVERAGE");
});
it("keeps only one following frame and never substitutes it for a missing target frame", () => {
  const f = uiFocusHoldFixtureV1(), size = 160 * 100, pixels = new Uint8Array(size * 26); pixels.set(f.pixels);
  const guard = (n: number, pts: number) => "[Parsed_showinfo_9 @ 000001] n: " + n + " pts: " + pts + " pts_time:unused duration: 1 duration_time:unused fmt:gray s:160x100\n";
  expect(() => parseLongformUiFocusHoldDecodeV1(f.log + guard(24, 30) + guard(25, 31), pixels, f.draft, f.request)).toThrow("FOLLOWING_FRAME_BUDGET");
  const firstGuard = parseLongformUiFocusHoldDecodeV1(f.log + guard(24, 30), pixels.subarray(0, size * 25), f.draft, f.request);
  expect(firstGuard.frames).toHaveLength(24); expect(firstGuard.followingFrame!.sourceTime).toBe(1);
  expect(() => parseLongformUiFocusHoldDecodeV1(f.log.replace("n: 23 pts: 29", "n: 23 pts: 28") + guard(24, 30), pixels.subarray(0, size * 25), f.draft, f.request)).toThrow("CLOCK_OR_PIXEL_COVERAGE");
});

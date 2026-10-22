import { describe, expect, it } from "vitest";
import { beatReviewRequestSchemaV1, planBeatReviewSheetV1, reduceBeatReviewPcmV1, type BeatReviewRequestV1 } from "./beatReviewSheetV1";
import { beatReviewHtmlV1, beatReviewSvgV1 } from "./beatReviewSheetSvgV1";
import { fixtureReceiptV1 } from "./musicBeats.fixture";
import { musicBeatsReceiptSchemaV1, type MusicBeatsRequestV1 } from "./musicBeatsTypesV1";

const request = (change: Record<string, unknown> = {}) => ({ schema: "editkin.beat-review-request/v1", title: "Review",
  analysis: { path: "D:/review/cache.json", sha256: "a".repeat(64) }, music: { path: "D:/music.wav", sha256: "b".repeat(64) },
  window: { sourceStartSeconds: 0, durationSeconds: 8 }, montage: { path: "D:/montage.mp4", sha256: "c".repeat(64), sourceStartSeconds: 10 },
  reviewFps: 24, ...change });
function native(refined = true, octave = false) {
  const raw = fixtureReceiptV1(8), a = raw.analysis, bpm = octave ? 60 : 120;
  a.tempoBpm = bpm; a.beats = Array.from({ length: octave ? 8 : 16 }, (_, i) => ({ timeSeconds: i * 60 / bpm, confidence: .8, downbeat: false, downbeatConfidence: 0 }));
  if (refined) Object.assign(a, { rhythmV2: { schema: "editkin.music-rhythm-refinement/v2", policy: "prior-octave-four-beat-candidate/v2",
    tempo: { rawBpm: bpm, bpm: 120, priorBpm: 120, octaveMultiplier: octave ? 2 : 1, state: octave ? "prior-octave-corrected" : "unchanged", confidence: octave ? .5 : .8 },
    pulseRecipe: { mode: octave ? "insert-midpoints" : "native-observed", phase: 0 }, bars: { mode: "inferred-four-beat-grid", beatsPerBar: 4,
      anchorSourceSeconds: 0, anchorNativeIndex: 0, periodSeconds: 2, confidence: octave ? .1 : .16, inferred: true, reason: octave ? "octave-adjusted-meter-hypothesis" : "weak-accent-first-beat-anchor" },
    nativeBeatCount: a.beats.length, nativeDownbeatCount: 0, regularIntervalFraction: 1, humanQualityCertified: false } });
  const nr: MusicBeatsRequestV1 = { sourcePath: "D:/music.wav", sourceStartSeconds: 0, durationSeconds: 8, priorBpm: 120, ...(refined ? { rhythmRefinementV2: true } : {}) };
  return { receipt: musicBeatsReceiptSchemaV1.parse(raw), nr };
}
const plan = (r = request(), refined = true, octave = false) => { const n = native(refined, octave); return planBeatReviewSheetV1(r, n.receipt, n.nr); };
function pcm(sampleCount = 4000, value: (i: number) => number = () => 0) {
  const bytes = new Uint8Array(sampleCount * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < sampleCount; i++) view.setFloat32(i * 4, value(i), true);
  return bytes;
}

describe("beat review source clocks, provenance and budgets", () => {
  it("keeps inferred bars distinct from coincident observed pulses without changing native observations", () => {
    const n = native(), before = JSON.stringify(n.receipt), p = planBeatReviewSheetV1(request(), n.receipt, n.nr);
    expect(p.events).toHaveLength(20); expect(p.events.filter(e => e.kind === "bar")).toHaveLength(4);
    expect(p.events.filter(e => e.timeSeconds === 0).map(e => [e.kind, e.inferred, e.confidence])).toEqual([["bar", true, .16], ["pulse", false, .8]]);
    expect(JSON.stringify(n.receipt)).toBe(before); expect(p.quality).toMatchObject({ humanQualityCertified: false, vaDefaultEligible: false, fMeasure: "NOT_MEASURED" });
  });
  it("includes only a half-open source window and maps its explicit montage offset", () => {
    const p = plan(request({ window: { sourceStartSeconds: 2, durationSeconds: 4 } }));
    expect(p.events.every(e => e.timeSeconds >= 2 && e.timeSeconds < 6 && e.offsetSeconds === e.timeSeconds - 2)).toBe(true);
    expect(p.groups.map(g => g.event!.timeSeconds)).toEqual([2, 4]); expect(p.groups[0].centerFrame).toBe(0);
    expect(p.frameIndices).toEqual([0, 1, 47, 48, 49]); expect(p.request.montage!.sourceStartSeconds).toBe(10);
  });
  it("supports NTSC review fps without claiming original decoder PTS", () => {
    const p = plan(request({ reviewFps: 30000 / 1001 }));
    expect(p.frameIndices.every(n => Number.isInteger(n) && n >= 0 && n < Math.ceil(8 * 30000 / 1001))).toBe(true);
    expect(p.samplingConvention).toContain("not-decoder-pts"); expect(p.alignmentAuthority).toContain("caller_asserted");
  });
  it("shows the corrected tempo and marks subdivided pulses inferred", () => {
    const p = plan(request(), true, true);
    expect(p.tempo).toMatchObject({ rawBpm: 60, bpm: 120, state: "prior-octave-corrected" });
    expect(p.events.filter(e => e.kind === "pulse" && e.inferred)).toHaveLength(7);
    expect(p.events.filter(e => e.inferred).every(e => e.confidence <= .2)).toBe(true);
  });
  it("accepts legacy observed downbeats without inventing a v2 fallback", () => {
    const receipt = musicBeatsReceiptSchemaV1.parse(fixtureReceiptV1(8));
    const p = planBeatReviewSheetV1(request({ montage: undefined }), receipt, native(false).nr);
    expect(p.events.map(e => e.inferred)).toEqual([false, false]); expect(p.groups).toEqual([]);
    expect(p.tempo.state).toBe("legacy-observations");
    expect(() => planBeatReviewSheetV1(request(), receipt, native().nr)).toThrow();
  });
  it("uses uniform frame context for silence without inventing events", () => {
    const n = native(false); n.receipt.analysis.tempoBpm = null; n.receipt.analysis.tempoConfidence = 0;
    n.receipt.analysis.beats = []; n.receipt.analysis.tempoWindows = []; n.receipt.analysis.onsets = [];
    const p = planBeatReviewSheetV1(request(), n.receipt, n.nr);
    expect(p.events).toEqual([]); expect(p.groups).toHaveLength(4); expect(p.groups.every(g => g.event === null)).toBe(true);
  });
  it("limits frame groups, clips boundaries and decodes duplicate review indices only once", () => {
    const p = plan(request({ reviewFps: 1, maximumFrameGroups: 4 }));
    expect(p.groups).toHaveLength(4); expect(p.frameIndices).toHaveLength(8);
    expect(new Set(p.frameIndices).size).toBe(p.frameIndices.length);
    expect(plan(request({ maximumFrameGroups: 1 })).groups).toHaveLength(1);
  });
  it("refuses an uncovered range instead of silently cropping the requested evidence", () => {
    expect(() => plan(request({ window: { sourceStartSeconds: 7, durationSeconds: 2 } }))).toThrow(/NOT_COVERED/);
  });
  it("refuses more than4096 events without truncation", () => {
    const n = native(false); n.receipt.analysis.beats = Array.from({ length: 4097 }, (_, i) => ({ timeSeconds: i / 600, confidence: 1, downbeat: false, downbeatConfidence: 0 }));
    expect(() => planBeatReviewSheetV1(request(), n.receipt, n.nr)).toThrow(/EVENT_LIMIT/);
  });
  it.each([{ window: { sourceStartSeconds: 0, durationSeconds: 61 } }, { window: { sourceStartSeconds: .00001, durationSeconds: 2 } },
    { reviewFps: Infinity }, { reviewFps: 241 }, { waveformBins: 2049 }, { maximumFrameGroups: 5 }, { humanApproved: true }, { title: " " }])("refuses invalid or authority-changing request %o", change => {
    expect(() => beatReviewRequestSchemaV1.parse(request(change))).toThrow();
  });
});

describe("bounded waveform and standalone diagnostic documents", () => {
  it("accounts for every sample, including first/last extrema, and respects Uint8Array offsets", () => {
    const data = pcm(4000, i => i === 0 ? -.75 : i === 3999 ? .5 : .125), padded = new Uint8Array(data.length + 8);
    padded.set(data, 4); const w = reduceBeatReviewPcmV1(padded.subarray(4, -4), 4000, 64);
    expect(w.bins.reduce((n, b) => n + b.samples, 0)).toBe(4000); expect(w.bins[0].min).toBe(-.75);
    expect(w.bins.at(-1)!.max).toBe(.5); expect(w.pcm16.length).toBe(8000);
  });
  it("counts clipped samples and saturates the audition without silently normalizing the waveform", () => {
    const w = reduceBeatReviewPcmV1(pcm(4000, i => i === 0 ? -2 : i === 1 ? 2 : 0), 4000, 64), v = new DataView(w.pcm16.buffer);
    expect(w.clippedSamples).toBe(2); expect(w.peak).toBe(2); expect(w.bins[0]).toMatchObject({ min: -2, max: 2 });
    expect([v.getInt16(0, true), v.getInt16(2, true)]).toEqual([-32768, 32767]);
  });
  it.each([NaN, Infinity, -Infinity])("rejects non-finite decoded sample %s", value => {
    expect(() => reduceBeatReviewPcmV1(pcm(4000, i => i === 3999 ? value : 0), 4000, 64)).toThrow(/NOT_FINITE/);
  });
  it.each([0, 63, 2049, 1.5])("rejects waveform bin budget %s", bins => {
    expect(() => reduceBeatReviewPcmV1(pcm(), 4000, bins)).toThrow();
  });
  it("refuses partial or excess PCM and supports the maximum bin count", () => {
    expect(() => reduceBeatReviewPcmV1(pcm().subarray(4), 4000, 64)).toThrow();
    expect(() => reduceBeatReviewPcmV1(pcm(4001), 4000, 64)).toThrow();
    expect(reduceBeatReviewPcmV1(pcm(), 4000, 2048).bins).toHaveLength(2048);
  });
  it("escapes authored diagnostic titles and retains dashed inferred bars in SVG and passive HTML", () => {
    const p = plan(request({ title: '</text><script>alert("x")</script>' })), { pcm16: _pcm, ...wave } = reduceBeatReviewPcmV1(pcm(p.sampleCount), p.sampleCount, p.request.waveformBins);
    const thumbs = new Map(p.frameIndices.map(n => [n, "data:image/png;base64,AA=="]));
    const svg = beatReviewSvgV1(p, wave, thumbs), html = beatReviewHtmlV1(p.request.title, svg, "AA==");
    expect(svg).toContain("&lt;script&gt;"); expect(svg).not.toContain("<script>");
    expect(svg).toContain('data-event-kind="inferred-bar"'); expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain("confidence 16.0%"); expect(html).toContain("<audio controls");
    expect(html).toContain("default-src 'none'"); expect(html).not.toContain("autoplay"); expect(html).not.toContain("<script>");
  });
  it("refuses missing or remotely linked thumbnails", () => {
    const p = plan(), { pcm16: _pcm, ...wave } = reduceBeatReviewPcmV1(pcm(p.sampleCount), p.sampleCount, p.request.waveformBins);
    expect(() => beatReviewSvgV1(p, wave, new Map())).toThrow(/THUMBNAILS/);
    expect(() => beatReviewSvgV1(p, wave, new Map(p.frameIndices.map(n => [n, "https://example.invalid/frame.png"])))).toThrow(/THUMBNAILS/);
  });
  it("makes missing montage and pending human approval explicit", () => {
    const p = plan(request({ montage: undefined })), { pcm16: _pcm, ...wave } = reduceBeatReviewPcmV1(pcm(p.sampleCount), p.sampleCount, p.request.waveformBins);
    const svg = beatReviewSvgV1(p, wave, new Map()); expect(svg).toContain("No montage supplied");
    expect(svg).toContain("ART_PENDING_CLAUDE"); expect(svg).toContain("NOT_MEASURED");
  });
});

import { describe, expect, it } from "vitest";
import { pairedVideoDurationV2 } from "./timelineTransitionVideoBoundsV2";

const probe = (video: Record<string, unknown>, audio = true) => ({ format: { duration: "10" }, streams: [
  { codec_type: "video", ...video }, ...(audio ? [{ codec_type: "audio", duration: "10" }] : []),
] });
describe("paired-only video duration authority", () => {
  it("uses numeric video duration rather than a longer audio/container", () => {
    expect(pairedVideoDurationV2(probe({ duration: "0.8" }))).toBe(0.8);
  });
  it("uses exact rational ticks and the most conservative available duration", () => {
    expect(pairedVideoDurationV2(probe({ duration: "1", duration_ts: 800, time_base: "1/1000" }))).toBe(0.8);
  });
  it("reads ordinary zero-origin Matroska video DURATION tags", () => {
    expect(pairedVideoDurationV2(probe({ start_time: "0.000", tags: { DURATION: "00:00:00.800000000" } }))).toBe(0.8);
  });
  it("refuses unknown mixed-media timing and ambiguous tag origins", () => {
    for (const video of [{}, { duration: "N/A" }, { duration: Infinity }, { duration: true }, { start_time: "2", tags: { DURATION: "00:00:03" } }])
      expect(() => pairedVideoDurationV2(probe(video))).toThrow("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
  });
  it("keeps container fallback for a video-only source and excludes cover artwork", () => {
    expect(pairedVideoDurationV2(probe({}, false))).toBe(10);
    expect(pairedVideoDurationV2({ format: { duration: "10" }, streams: [
      { codec_type: "video", duration: "10", disposition: { attached_pic: 1 } }, { codec_type: "video", duration: ".8" },
    ] })).toBe(.8);
  });
  it("refuses a missing actual video stream and malformed or oversized rows", () => {
    expect(() => pairedVideoDurationV2({ streams: [{ codec_type: "audio" }] })).toThrow("TIMELINE_TRANSITION_VIDEO_STREAM_MISSING");
    expect(() => pairedVideoDurationV2({ streams: Array.from({ length: 257 }, () => ({ codec_type: "video", duration: 1 })) })).toThrow("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
    expect(() => pairedVideoDurationV2(null)).toThrow("TIMELINE_TRANSITION_ACTUAL_HANDLE_MISSING");
  });
});

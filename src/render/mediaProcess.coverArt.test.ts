import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMedia } from "./mediaProcess";

const fixture = vi.hoisted(() => ({ response: {} as Record<string, unknown>, argv: [] as string[] }));
// Exercise the real probe parser and process closure; only ffprobe output is controlled.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (_exe: string, argv: string[], options: import("node:child_process").SpawnOptions) => {
    fixture.argv = argv;
    return actual.spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(fixture.response))})`], options);
  } };
});

afterEach(() => { fixture.response = {}; fixture.argv = []; });
const audio = { codec_type: "audio", codec_name: "mp3" };
const cover = { codec_type: "video", codec_name: "png", width: 64, height: 48, sample_aspect_ratio: "1:1", disposition: { attached_pic: 1 } };
const video = { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, sample_aspect_ratio: "1:1", disposition: { attached_pic: 0 } };

describe("playable video probing with attached cover art", () => {
  it("keeps covered music audio-only and does not export cover geometry", async () => {
    fixture.response = { streams: [audio, cover], format: { duration: "2.5" } };
    const result = await probeMedia("covered.mp3", "controlled-ffprobe");
    expect(result).toMatchObject({ hasVideo: false, hasAudio: true, duration: 2.5, audioCodecName: "mp3" });
    expect(result.width).toBeUndefined(); expect(result.height).toBeUndefined(); expect(result.displayAspectRatio).toBeUndefined();
    expect(result.codecName).toBeUndefined();
    expect(fixture.argv).toContainEqual(expect.stringContaining("stream_disposition=attached_pic"));
  });

  it("selects real video after a cover instead of taking the first video-shaped stream", async () => {
    fixture.response = { streams: [cover, audio, video], format: { duration: "3" } };
    expect(await probeMedia("movie.mp4", "controlled-ffprobe")).toMatchObject({ hasVideo: true, hasAudio: true, codecName: "h264", width: 1920, height: 1080, displayAspectRatio: 16 / 9 });
  });

  it("preserves ordinary streams whose disposition is absent", async () => {
    const { disposition: _unused, ...ordinary } = video;
    fixture.response = { streams: [ordinary], format: { duration: "1" } };
    expect(await probeMedia("movie.mp4", "controlled-ffprobe")).toMatchObject({ hasVideo: true, hasAudio: false, codecName: "h264", width: 1920, height: 1080 });
  });

  it("does not invent a playable stream from a lone attached picture", async () => {
    fixture.response = { streams: [cover], format: { duration: "1" } };
    expect(await probeMedia("attachment.mp4", "controlled-ffprobe")).toMatchObject({ hasVideo: false, hasAudio: false });
  });
});

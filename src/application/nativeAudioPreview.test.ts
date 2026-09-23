import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { PreviewAudioClip } from "./nativeAudioPreview";
import { buildMusicGainAutomation, buildNativeAudioPreviewDecoderArgs } from "./nativeAudioPreview";

function previewClips(): PreviewAudioClip[] {
  const project = createDemoProject();
  const baseClip = project.tracks[0].clips[0];
  const voice = { ...project.assets[0], id: "voice", uri: resolve("voice.wav"), role: "dialogue" };
  const music = { ...project.assets[0], id: "music", uri: resolve("music.wav"), role: "background-music" };
  return [
    {
      clip: { ...baseClip, id: "voice-clip", assetId: voice.id, volume: 0.8 },
      asset: voice,
      assetPath: voice.uri,
      overlapStart: 0.5,
      overlapDuration: 2,
      sourceStart: 1,
      localDelay: 0.5,
    },
    {
      clip: { ...baseClip, id: "music-clip", assetId: music.id, duration: 6, volume: 0.25 },
      asset: music,
      assetPath: music.uri,
      overlapStart: 0,
      overlapDuration: 3,
      sourceStart: 0,
      localDelay: 0,
    },
  ];
}

describe("native audio preview staging", () => {
  it("keeps FFmpeg at the independent source decode boundary", () => {
    const item = previewClips()[0];
    const args = buildNativeAudioPreviewDecoderArgs(item, resolve("voice-source.f32le"));
    const serialized = args.join(" ");
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)).toEqual(["-ss", "1", "-t", "2"]);
    expect(args.at(-1)).toBe(resolve("voice-source.f32le"));
    expect(serialized).toContain("aresample=48000");
    expect(serialized).not.toMatch(/filter_complex|amix|volume=|adelay|sidechaincompress|loudnorm|alimiter/);
  });

  it("materializes music fades as sample-addressed native gain automation", () => {
    const music = previewClips()[1];
    const points = buildMusicGainAutomation(music, 3 * 48_000);
    expect(points.length).toBeGreaterThanOrEqual(3);
    expect(points[0]).toEqual({ sample: 0, valueDb: -144 });
    expect(points.some((point) => point.sample > 0 && point.valueDb > -20)).toBe(true);
    expect(points.every((point, index) => index === 0 || point.sample > points[index - 1].sample)).toBe(true);
  });

  it("rejects unbounded windows and unmanaged relative output targets", () => {
    const item = { ...previewClips()[0], overlapDuration: 31 };
    expect(() => buildNativeAudioPreviewDecoderArgs(item, resolve("preview.f32le"))).toThrow("0..=30");
    expect(() => buildNativeAudioPreviewDecoderArgs(previewClips()[0], "preview.f32le")).toThrow("絕對路徑");
  });
});

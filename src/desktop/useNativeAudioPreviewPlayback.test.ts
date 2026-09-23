import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { NativeAudioPreviewStageReceipt } from "./types";
import { nativeAudioStageMatchesProject, playheadRequiresTransportSeek } from "./useNativeAudioPreviewPlayback";

describe("native audio preview project binding", () => {
  it("accepts only the current project revision and an honest native DAG stage", () => {
    const project = createDemoProject();
    const receipt: NativeAudioPreviewStageReceipt = {
      schema: "editkin.native-audio-preview-stage/v2",
      status: "GREEN",
      manifestBytes: 1_024,
      manifestSha256: "a".repeat(64),
      projectId: project.id,
      projectRevision: project.revision,
      projectUpdatedAt: project.updatedAt,
      audioFingerprintSha256: "b".repeat(64),
      timelineStartSeconds: 0,
      durationSeconds: 1,
      sampleRate: 48_000,
      channels: 2,
      clipCount: 1,
      voiceClipCount: 1,
      musicClipCount: 0,
      sourceIds: ["asset"],
      sourcePcm: [{ id: "source-0", clipId: "clip", assetId: "asset", role: "voice", bytes: 384_000, sha256: "c".repeat(64), startFrame: 0, gainDb: 0, gainAutomation: [] }],
      decoderExecutor: "ffmpeg-source-decode/v1",
      decodeMode: "independent-source-pcm",
      mixExecutor: "hao-core-native-dag/v1",
      nativeGraphExecution: true,
      claimBoundary: "bounded",
    };
    expect(nativeAudioStageMatchesProject(receipt, project)).toBe(true);
    expect(nativeAudioStageMatchesProject({ ...receipt, projectRevision: project.revision + 1 }, project)).toBe(false);
    expect(nativeAudioStageMatchesProject({ ...receipt, nativeGraphExecution: false as true }, project)).toBe(false);
    expect(nativeAudioStageMatchesProject({ ...receipt, schema: "editkin.native-audio-preview-stage/v1" as typeof receipt.schema }, project)).toBe(false);
    expect(nativeAudioStageMatchesProject({ ...receipt, mixExecutor: "ffmpeg-window-staging/v1" as typeof receipt.mixExecutor }, project)).toBe(false);
    expect(nativeAudioStageMatchesProject({ ...receipt, sourcePcm: [] }, project)).toBe(false);
    expect(nativeAudioStageMatchesProject({ ...receipt, durationSeconds: 31 }, project)).toBe(false);
  });

  it("distinguishes an external seek from the transport's own frame-sized clock update", () => {
    expect(playheadRequiresTransportSeek(2, 1, 30)).toBe(true);
    expect(playheadRequiresTransportSeek(1 + 0.5 / 30, 1, 30)).toBe(false);
    expect(playheadRequiresTransportSeek(Number.NaN, 1, 30)).toBe(false);
  });
});

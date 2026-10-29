export function fixtureReceiptV1(duration = 2, start = 0) {
  const count = Math.round(duration * 16_000);
  return { schema: "editkin.music-beats-receipt/v1", sourceSha256: "a".repeat(64), sourceBytes: 10, ffmpegSha256: "b".repeat(64), pcmSha256: "c".repeat(64),
    decodedBytes: count * 4, pcmStagedBytes: 0, maximumPcmQueueBytes: 131_072, elapsedMs: 2,
    analysis: { schema: "editkin.music-beats-analysis/v1", executor: "hao-core-spectral-flux-autocorrelation-dp/v1", sampleRate: 16_000,
      decodedSamples: count, durationSeconds: count / 16_000, sourceStartSeconds: start, fftSize: 1024, hopSamples: 160, peakFeatureFrames: 100, maximumFeatureFrames: 6400,
      tempoBpm: 120, tempoConfidence: .8, meterHypothesis: "four-beat-accent-hypothesis; not a learned meter classifier",
      onsets: [{ timeSeconds: start + .5, strength: .9 }], beats: [{ timeSeconds: start + .5, confidence: .8, downbeat: true, downbeatConfidence: .7 }],
      tempoWindows: [{ startSeconds: start, endSeconds: start + duration, bpm: 120, confidence: .8 }], sections: [], qualityState: "analysis_candidate_real_music_quality_unmeasured" },
    decoderAudit: [{ sourceId: "music-beats-source", pid: 123, reason: "finished", exitBeforeCleanup: 0, exitCode: 0, treeClosed: true, pipeThreadsClosed: true,
      decodedBytes: count * 4, expectedBytes: count * 4, maxQueuedChunks: 2, chunkBytes: 32_768, elapsedMs: 1, stderr: "", cleanupError: null }] };
}

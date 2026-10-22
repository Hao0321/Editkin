import { describe, expect, it } from "vitest";
import { musicBeatsRequestSchemaV1, validateMusicBeatsReceiptV1 } from "./musicBeatsTypesV1";

import { fixtureReceiptV1 } from "./musicBeats.fixture";

const request = { sourcePath: "owned.wav", sourceStartSeconds: 0, durationSeconds: 2 }, identity = { sourceSha256: "a".repeat(64), sourceBytes: 10, ffmpegSha256: "b".repeat(64) };
describe("native music analysis boundary", () => {
  it("accepts a complete bounded command result and its declared source clock", () => {
    expect(validateMusicBeatsReceiptV1(fixtureReceiptV1(), request, identity).analysis.beats).toHaveLength(1);
    expect(validateMusicBeatsReceiptV1(fixtureReceiptV1(2, 36_000), { ...request, sourceStartSeconds: 36_000 }, identity).analysis.beats[0].timeSeconds).toBe(36_000.5);
  });
  it("refuses source substitution, missing samples and staged PCM", () => {
    const result = fixtureReceiptV1(); result.sourceSha256 = "d".repeat(64);
    expect(() => validateMusicBeatsReceiptV1(result, request, identity)).toThrow("IDENTITY_MISMATCH");
    result.sourceSha256 = identity.sourceSha256; result.decodedBytes--;
    expect(() => validateMusicBeatsReceiptV1(result, request, identity)).toThrow("IDENTITY_MISMATCH");
    expect(() => validateMusicBeatsReceiptV1({ ...fixtureReceiptV1(), pcmStagedBytes: 1 }, request, identity)).toThrow();
  });
  it("refuses false child closure and invalid event clocks", () => {
    const result = fixtureReceiptV1(); result.decoderAudit[0].treeClosed = false;
    expect(() => validateMusicBeatsReceiptV1(result, request, identity)).toThrow();
    result.decoderAudit[0].treeClosed = true; result.analysis.beats[0].timeSeconds = 3;
    expect(() => validateMusicBeatsReceiptV1(result, request, identity)).toThrow("EVENT_CLOCK_INVALID");
  });
  it("requires strict finite request fields and does not admit a new model", () => {
    expect(musicBeatsRequestSchemaV1.safeParse({ ...request, model: "download-me" }).success).toBe(false);
    expect(musicBeatsRequestSchemaV1.safeParse({ ...request, durationSeconds: Infinity }).success).toBe(false);
    expect(musicBeatsRequestSchemaV1.safeParse({ ...request, priorBpm: 0 }).success).toBe(false);
  });
});

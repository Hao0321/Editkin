import { describe, expect, it } from "vitest";
import { confirmRotoSubjectV1, verifyRotoMatteTrustV1 } from "./rotoMatteTrustV1";
const now = Date.parse("2026-10-16T00:00:00.000Z");
const identity = () => ({ schema: "editkin.roto-matte-identity/v1", sourceSha256: "a".repeat(64), cutoutSha256: "b".repeat(64), alphaSha256: "c".repeat(64),
  analysisSha256: "d".repeat(64), nativeCoreSha256: "e".repeat(64), sourceStart: 0, width: 64, height: 40, frameCount: 5, fps: 4, qualityState: "diagnostic" });
const action = () => ({ subjectCorrect: true, reviewerId: "f".repeat(64), reviewedAt: new Date(now).toISOString() });
describe("explicit subject placement trust, never benchmark certification", () => {
  it("records an explicit instrument-only review fixture and preserves diagnostic status", () => {
    const value = confirmRotoSubjectV1(identity(), action(), now);
    expect(verifyRotoMatteTrustV1(value, identity())).toMatchObject({ subjectCorrect: true, fromFrame: 0, toFrame: 4,
      scope: "subject-placement-only", qualityState: "diagnostic", benchmarkAccepted: false });
  });
  it.each(["sourceSha256", "cutoutSha256", "alphaSha256", "analysisSha256", "nativeCoreSha256", "sourceStart", "frameCount"])("invalidates changed %s", field => {
    const value = confirmRotoSubjectV1(identity(), action(), now), other = identity() as Record<string, unknown>;
    other[field] = typeof other[field] === "number" ? Number(other[field]) + 1 : "0".repeat(64);
    expect(() => verifyRotoMatteTrustV1(value, other)).toThrow();
  });
  it("refuses implicit approval, future review, invalid reviewer and quality promotion", () => {
    expect(() => confirmRotoSubjectV1(identity(), { ...action(), subjectCorrect: false }, now)).toThrow("EXPLICIT");
    expect(() => confirmRotoSubjectV1(identity(), { ...action(), reviewedAt: new Date(now + 600000).toISOString() }, now)).toThrow("TIME");
    expect(() => confirmRotoSubjectV1(identity(), { ...action(), reviewerId: "anonymous" }, now)).toThrow();
    const value = confirmRotoSubjectV1(identity(), action(), now);
    expect(() => verifyRotoMatteTrustV1({ ...value, benchmarkAccepted: true }, identity())).toThrow();
    expect(() => verifyRotoMatteTrustV1({ ...value, fromFrame: 1 }, identity())).toThrow();
  });
});

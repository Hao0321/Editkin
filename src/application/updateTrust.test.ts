import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeUpdateMetadataForSigning, parseUpdateTrustPolicy, verifyTrustedUpdateEnvelope } from "./updateTrust";

const pair = generateKeyPairSync("ed25519");
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const certificateSha256 = "a".repeat(64);
const artifactSha256 = "b".repeat(64);

function policy() {
  return {
    schema: "editkin.update-trust-policy/v1",
    policyVersion: 3,
    repository: "https://github.com/hao/editkin",
    channel: "stable",
    platform: "windows",
    arch: "x86_64",
    abi: "msvc",
    manifestUrl: "https://updates.editkin.example/stable/windows-x86_64.json",
    artifactBaseUrl: "https://updates.editkin.example/stable/windows-x86_64/",
    publisherKeyId: "editkin-release-2026",
    publisherPublicKeyPem: publicPem,
    authenticodeSubject: "CN=Editkin Studio, O=Hao",
    authenticodeCertificateSha256: certificateSha256,
    maxManifestBytes: 262_144,
    maxArtifactBytes: 2_147_483_648,
    checkIntervalMs: 21_600_000,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schema: "editkin.update-metadata/v1",
    policyVersion: 3,
    sequence: 42,
    repository: "https://github.com/hao/editkin",
    channel: "stable",
    platform: "windows",
    arch: "x86_64",
    abi: "msvc",
    version: "1.2.0",
    publishedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
    minimumProjectSchema: 6,
    minimumOsVersion: "10.0.19045",
    artifact: {
      url: "https://updates.editkin.example/stable/windows-x86_64/Editkin_1.2.0.exe",
      sha256: artifactSha256,
      size: 123456,
      authenticodeSubject: "CN=Editkin Studio, O=Hao",
      certificateSha256,
    },
    ...overrides,
  };
}

function envelope(signed = metadata()) {
  return {
    schema: "editkin.signed-update-metadata/v1",
    keyId: "editkin-release-2026",
    signed,
    signature: sign(null, Buffer.from(canonicalizeUpdateMetadataForSigning(signed)), pair.privateKey).toString("base64url"),
  };
}

const options = {
  now: new Date("2026-09-04T00:00:00.000Z"),
  currentVersion: "1.1.0",
  currentProjectSchema: 6,
  currentOsVersion: "10.0.22631",
};

describe("pinned update trust policy", () => {
  it("accepts only a correctly signed, identity-bound and compatible release", () => {
    expect(parseUpdateTrustPolicy(policy()).publisherKeyId).toBe("editkin-release-2026");
    const decision = verifyTrustedUpdateEnvelope(envelope(), policy(), options);
    expect(decision.status).toBe("available");
    expect(decision.nextState).toMatchObject({ highestSequence: 42, version: "1.2.0", artifactSha256 });
  });

  it("rejects tampering, unknown fields, the wrong publisher and path escape", () => {
    const tampered = envelope();
    tampered.signed.version = "9.9.9";
    expect(() => verifyTrustedUpdateEnvelope(tampered, policy(), options)).toThrow(/簽章/);
    expect(() => verifyTrustedUpdateEnvelope({ ...envelope(), callerVerdict: "PASS" }, policy(), options)).toThrow(/封閉集合/);
    expect(() => verifyTrustedUpdateEnvelope(envelope(), { ...policy(), publisherKeyId: "attacker-key" }, options)).toThrow(/keyId/);
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ artifact: { ...metadata().artifact, url: "https://evil.example/Editkin.exe" } })), policy(), options)).toThrow(/發行路徑/);
  });

  it("rejects expired, future, downgrade, rollback, mix-and-match and same-version-different-bytes metadata", () => {
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ expiresAt: "2026-09-03T00:00:00.000Z" })), policy(), options)).toThrow(/過期/);
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ publishedAt: "2026-09-05T00:00:00.000Z" })), policy(), options)).toThrow(/未來/);
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ version: "1.0.0" })), policy(), options)).toThrow(/降級/);
    const accepted = verifyTrustedUpdateEnvelope(envelope(), policy(), options).nextState;
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ sequence: 41 })), policy(), { ...options, highestTrustedState: accepted })).toThrow(/rollback|freeze/);
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ version: "1.3.0" })), policy(), { ...options, highestTrustedState: accepted })).toThrow(/mix-and-match/);
    expect(() => verifyTrustedUpdateEnvelope(envelope(metadata({ version: "1.1.0" })), policy(), { ...options, currentArtifactSha256: "c".repeat(64) })).toThrow(/相同版本/);
  });

  it("returns an explicit incompatible state without downloading", () => {
    expect(verifyTrustedUpdateEnvelope(envelope(metadata({ minimumProjectSchema: 7 })), policy(), options)).toMatchObject({ status: "incompatible", reason: "project_schema" });
    expect(verifyTrustedUpdateEnvelope(envelope(metadata({ minimumOsVersion: "11.0.0" })), policy(), options)).toMatchObject({ status: "incompatible", reason: "operating_system" });
  });
});

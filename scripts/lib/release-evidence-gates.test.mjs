import { describe, expect, it } from "vitest";
import {
  authenticodeMatchesPolicy,
  deliveredArtifactJourneyMatches,
  missingReleaseInputs,
  releaseDistribution,
  releaseEvidenceExitCode,
  releaseEvidenceStatus,
} from "./release-evidence-gates.mjs";

const installerHash = "a".repeat(64);
const executableHash = "b".repeat(64);
const policy = { authenticodeSubject: "CN=Editkin Publisher", authenticodeCertificateSha256: "c".repeat(64) };
const publisherSignature = { Status: "Valid", SignerSubject: policy.authenticodeSubject, CertificateSha256: policy.authenticodeCertificateSha256 };
const journey = {
  status: "GREEN",
  deliveryEnvelope: { sha256: installerHash },
  deliveredExecutable: { sha256: executableHash },
};

describe("release evidence gates", () => {
  it("reports exactly the unavailable inputs once, preserving input order", async () => {
    const present = new Set(["package.json", "vendor/node/node.exe"]);
    const required = ["package.json", "vendor/node/manifest.json", "vendor/node/node.exe", "installer.exe", "installer.exe"];
    expect(await missingReleaseInputs(required, async (path) => present.has(path)))
      .toEqual(["vendor/node/manifest.json", "installer.exe"]);
    expect(await missingReleaseInputs([...present], (path) => present.has(path))).toEqual([]);
  });

  it.each([
    [{ identity: false }, { signing: true }, "INTERNAL_RELEASE_BLOCKED", 1],
    [{ identity: false }, { signing: false }, "INTERNAL_RELEASE_BLOCKED", 1],
    [{ identity: true }, { signing: false }, "INTERNAL_GREEN_PUBLIC_BLOCKED", 1],
    [{ identity: true }, { signing: true }, "PUBLIC_RELEASE_GREEN", 0],
  ])("gives internal blocks precedence and only public green succeeds (%s, %s)", (internal, publicGates, status, exitCode) => {
    expect(releaseEvidenceStatus(internal, publicGates)).toBe(status);
    expect(releaseEvidenceExitCode(status)).toBe(exitCode);
  });

  it("fails closed for missing-input and unrecognized statuses", () => {
    expect(releaseEvidenceExitCode("RELEASE_INPUTS_MISSING")).toBe(1);
    expect(releaseEvidenceExitCode(undefined)).toBe(1);
  });

  it("accepts a green journey only for the exact installer and delivered executable", () => {
    expect(deliveredArtifactJourneyMatches(journey, installerHash, executableHash)).toBe(true);
    expect(deliveredArtifactJourneyMatches(journey, "c".repeat(64), executableHash)).toBe(false);
    expect(deliveredArtifactJourneyMatches(journey, installerHash, "c".repeat(64))).toBe(false);
    expect(deliveredArtifactJourneyMatches({ ...journey, status: "BLOCK" }, installerHash, executableHash)).toBe(false);
    expect(deliveredArtifactJourneyMatches(null, installerHash, executableHash)).toBe(false);
    expect(deliveredArtifactJourneyMatches({ status: "GREEN" }, undefined, undefined)).toBe(false);
  });

  it.each([
    [{ Status: "NotSigned" }, { Status: "Valid" }],
    [{ Status: "Valid" }, { Status: "NotSigned" }],
    [{ Status: "Valid" }, null],
    [{ Status: "UnknownError" }, { Status: "Valid" }],
  ])("labels an unsigned or unverifiable envelope or payload as community-only (%s, %s)", (installer, executable) => {
    expect(releaseDistribution(installer, executable, true)).toEqual({
      label: "unsigned-community-binary",
      autoUpdate: "disabled-until-authenticode-and-reviewed-project-key-update",
    });
  });

  it("requires both Authenticode signatures and project-key metadata before update eligibility", () => {
    const valid = publisherSignature;
    expect(releaseDistribution(valid, valid, false, policy)).toEqual({
      label: "authenticode-signed",
      autoUpdate: "disabled-until-authenticode-and-reviewed-project-key-update",
    });
    expect(releaseDistribution(valid, valid, true, policy)).toEqual({ label: "authenticode-signed", autoUpdate: "eligible" });
  });

  it.each([
    ["a different publisher", { ...publisherSignature, SignerSubject: "CN=Another Publisher" }],
    ["a different certificate", { ...publisherSignature, CertificateSha256: "d".repeat(64) }],
    ["no publisher", { Status: "Valid", CertificateSha256: policy.authenticodeCertificateSha256 }],
    ["no certificate", { Status: "Valid", SignerSubject: policy.authenticodeSubject }],
    ["a malformed certificate", { ...publisherSignature, CertificateSha256: "not-a-sha256" }],
    ["an unverified signature", { ...publisherSignature, Status: "UnknownError" }],
  ])("rejects %s even when project-key metadata claims the expected publisher", (_name, actual) => {
    expect(authenticodeMatchesPolicy(actual, policy)).toBe(false);
    expect(releaseDistribution(actual, publisherSignature, true, policy).autoUpdate).not.toBe("eligible");
    expect(releaseDistribution(publisherSignature, actual, true, policy).autoUpdate).not.toBe("eligible");
  });

  it("fails closed without a reviewed publisher policy or with malformed policy fields", () => {
    for (const badPolicy of [undefined, null, {}, { ...policy, authenticodeSubject: "" }, { ...policy, authenticodeCertificateSha256: "short" }]) {
      expect(authenticodeMatchesPolicy(publisherSignature, badPolicy)).toBe(false);
      expect(releaseDistribution(publisherSignature, publisherSignature, true, badPolicy).autoUpdate).not.toBe("eligible");
    }
  });

  it("normalizes hex case without accepting a mismatched certificate", () => {
    const uppercase = { ...publisherSignature, CertificateSha256: policy.authenticodeCertificateSha256.toUpperCase() };
    expect(authenticodeMatchesPolicy(uppercase, policy)).toBe(true);
    expect(releaseDistribution(uppercase, uppercase, true, policy).autoUpdate).toBe("eligible");
  });
});

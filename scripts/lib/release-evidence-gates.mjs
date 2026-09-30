export async function missingReleaseInputs(requiredPaths, exists) {
  const uniquePaths = [...new Set(requiredPaths)];
  const present = await Promise.all(uniquePaths.map((path) => exists(path)));
  return uniquePaths.filter((_, index) => !present[index]);
}

export function releaseEvidenceStatus(internalGates, publicGates) {
  if (!Object.values(internalGates).every(Boolean)) return "INTERNAL_RELEASE_BLOCKED";
  return Object.values(publicGates).every(Boolean) ? "PUBLIC_RELEASE_GREEN" : "INTERNAL_GREEN_PUBLIC_BLOCKED";
}

export function releaseEvidenceExitCode(status) {
  return status === "PUBLIC_RELEASE_GREEN" ? 0 : 1;
}

export function deliveredArtifactJourneyMatches(receipt, installerSha256, deliveredExecutableSha256) {
  return receipt?.status === "GREEN"
    && typeof installerSha256 === "string" && /^[a-f0-9]{64}$/u.test(installerSha256)
    && typeof deliveredExecutableSha256 === "string" && /^[a-f0-9]{64}$/u.test(deliveredExecutableSha256)
    && receipt.deliveryEnvelope?.sha256 === installerSha256
    && receipt.deliveredExecutable?.sha256 === deliveredExecutableSha256;
}

export function releaseDistribution(installerSignature, deliveredExecutableSignature, projectKeySignedUpdateMetadata) {
  const signed = installerSignature?.Status === "Valid" && deliveredExecutableSignature?.Status === "Valid";
  return {
    label: signed ? "authenticode-signed" : "unsigned-community-binary",
    autoUpdate: signed && projectKeySignedUpdateMetadata
      ? "eligible" : "disabled-until-authenticode-and-reviewed-project-key-update",
  };
}

const ROOT = "personal-packs/hao-music-library/";
const MANIFEST = `${ROOT}editkin-personal-music.json`;
const LICENSE = "COMMUNITY-ASSET-GRANT.md";
const SHA = /^[a-f0-9]{64}$/;

// Authorization is a closed file set, not a folder-level redistribution flag.
export function publicMusicPayloadFiles(
  entries,
  textPayloads,
  fileIdentities = [],
) {
  const allowed = new Set();
  const payloads = textPayloads.filter((item) => item.path === MANIFEST);
  if (payloads.length !== 1 || !entries.includes(MANIFEST)) return allowed;
  try {
    const manifest = JSON.parse(payloads[0].text);
    if (
      manifest.schemaVersion !== 2 ||
      manifest.id !== "studio.hao.personal-music-library" ||
      manifest.distributionScope !== "community-redistributable" ||
      manifest.redistributable !== true ||
      manifest.provenanceAudit?.status !== "owner_attested_ai_generated" ||
      manifest.provenanceAudit?.publicExportAllowed !== true ||
      manifest.provenanceAudit?.attestationId !==
        "owner-attestation-2026-08-22" ||
      manifest.licenseFile !== LICENSE ||
      !SHA.test(manifest.licenseSha256) ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length === 0 ||
      manifest.assetCount !== manifest.assets.length
    )
      return allowed;
    const ids = new Set();
    const paths = new Set();
    const expected = [
      { path: `${ROOT}${LICENSE}`, sha256: manifest.licenseSha256 },
    ];
    let bytes = 0;
    for (const asset of manifest.assets) {
      if (
        !/^music:[a-f0-9]{20}$/.test(asset.id) ||
        ids.has(asset.id) ||
        asset.path !== `assets/${asset.id.slice(6)}.m4a` ||
        paths.has(asset.path) ||
        asset.mediaKind !== "audio" ||
        asset.redistributable !== true ||
        asset.license !== "HAO-COMMUNITY-ASSET-GRANT-1.0" ||
        asset.rightsBasis !== "owner-attestation-2026-08-22" ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes <= 0 ||
        !SHA.test(asset.sha256)
      )
        return allowed;
      ids.add(asset.id);
      paths.add(asset.path);
      bytes += asset.bytes;
      expected.push({
        path: `${ROOT}${asset.path}`,
        sha256: asset.sha256,
        bytes: asset.bytes,
      });
    }
    if (!Number.isSafeInteger(bytes) || bytes !== manifest.assetBytes)
      return allowed;
    for (const item of expected) {
      const actual = fileIdentities.filter(
        (identity) => identity.path === item.path,
      );
      if (
        entries.filter((path) => path === item.path).length !== 1 ||
        actual.length !== 1 ||
        actual[0].sha256 !== item.sha256 ||
        !Number.isSafeInteger(actual[0].bytes) ||
        actual[0].bytes <= 0 ||
        (item.bytes !== undefined && actual[0].bytes !== item.bytes)
      )
        return allowed;
    }
    allowed.add(MANIFEST);
    for (const item of expected) allowed.add(item.path);
  } catch {
    /* Invalid manifests never authorize a partial or arbitrary file set. */
  }
  return allowed;
}

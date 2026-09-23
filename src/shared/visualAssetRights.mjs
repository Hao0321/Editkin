// The community source edition carries no owner visual grant or owner media.
// Claims for that grant fail closed; ordinary redistributable pack assets use
// the same metadata checks as the source product.
export const OWNER_VISUAL_LICENSE = "LicenseRef-Editkin-Owner-Visual-Bundle-Grant-1.0";
export const OWNER_VISUAL_GRANT_ID = "owner-visual-attestation-2026-09-01";
export const OWNER_VISUAL_GRANT = Object.freeze({
  id: "editkin-community-no-owner-visuals", assetCount: 0,
  assets: Object.freeze([]), legacyAliases: Object.freeze([]),
  document: Object.freeze({ path: "", sha256: "" }),
});
const STANDARD_LICENSES = new Set(["CC-BY-4.0", "MIT", "CC0-1.0", "GPL-3.0-or-later"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const reject = message => { throw new Error(`Public visual rights: ${message}`); };

function ownerClaim(asset) {
  return asset.id?.startsWith("owner-visual:") || asset.license === OWNER_VISUAL_LICENSE
    || asset.rightsBasis === OWNER_VISUAL_GRANT_ID;
}

export function validatePublicAssetRights(asset, manifestGrant) {
  if (!object(asset) || typeof asset.id !== "string" || !asset.id.trim()) reject("asset id is missing");
  if (asset.id.startsWith("private-visual:") || ownerClaim(asset) || manifestGrant
    || asset.license === "PRIVATE-OWNER-ONLY" || asset.redistributable === false
    || asset.distributionScope === "private-owner-only" || asset.rightsBasis === "private-owner-only"
    || asset.category === "private_animation" || asset.role === "private-animation") {
    reject("owner or private visuals are not included in this source edition");
  }
  if (!STANDARD_LICENSES.has(asset.license)) reject("unknown public license");
  if (asset.distributionScope !== undefined && asset.distributionScope !== "community-redistributable") reject("unexpected public distribution scope");
  if (asset.rightsBasis !== undefined) reject("unrecognized public rights basis");
  if (asset.redistributable !== undefined && asset.redistributable !== true) reject("invalid redistribution flag");
  return { kind: "standard" };
}

/** @returns {{grant: typeof OWNER_VISUAL_GRANT, legacyAliases: Array<{legacyId: string, assetId: string}>} | undefined} */
export function validatePublicGrant(manifest, _options = {}) {
  if (!object(manifest) || !Array.isArray(manifest.assets)) reject("manifest assets must be an array");
  if (manifest.ownerVisualGrant || manifest.assets.some(asset => object(asset) && ownerClaim(asset))) {
    reject("owner visual grant is absent from this source edition");
  }
  for (const asset of manifest.assets) validatePublicAssetRights(asset);
  return undefined;
}

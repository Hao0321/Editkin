import grantSource from '../../../../community/hao-motion-kit/OWNER_VISUAL_GRANT.json' with { type: 'json' };

export const OWNER_VISUAL_LICENSE = 'LicenseRef-Editkin-Owner-Visual-Bundle-Grant-1.0';
export const OWNER_VISUAL_GRANT_ID = 'owner-visual-attestation-2026-09-01';
const STANDARD_LICENSES = new Set(['CC-BY-4.0', 'MIT', 'CC0-1.0']);

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const OWNER_VISUAL_GRANT = freeze(grantSource);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const expectedGrant = canonical(OWNER_VISUAL_GRANT);
const ownerRows = new Map(OWNER_VISUAL_GRANT.assets.map(asset => [asset.id, asset]));
const ownerHashes = new Set(OWNER_VISUAL_GRANT.assets.map(asset => asset.sha256));
const legacyIds = new Set(OWNER_VISUAL_GRANT.legacyAliases.map(alias => alias.legacyId));
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function reject(message) { throw new Error(`Public visual rights: ${message}`); }
function assertGrant(value) {
  if (value === OWNER_VISUAL_GRANT) return; // Only this recursively frozen, bundled authority can skip structural comparison.
  if (!object(value) || canonical(value) !== expectedGrant) reject('grant document/permission/membership/alias identity mismatch');
}
function ownerClaim(asset) {
  return typeof asset.id === 'string' && asset.id.startsWith('owner-visual:')
    || asset.license === OWNER_VISUAL_LICENSE || asset.rightsBasis === OWNER_VISUAL_GRANT_ID
    || ownerHashes.has(asset.sha256);
}

/** Pure rights semantics only. Filesystem consumers must verify actual bytes separately. */
export function validatePublicAssetRights(asset, manifestGrant) {
  if (!object(asset)) reject('asset must be an object');
  if (typeof asset.id !== 'string' || !asset.id.trim()) reject('asset id is missing');
  if (asset.id.startsWith('private-visual:') || legacyIds.has(asset.id)
    || asset.license === 'PRIVATE-OWNER-ONLY' || asset.redistributable === false
    || asset.distributionScope === 'private-owner-only' || asset.rightsBasis === 'private-owner-only'
    || asset.category === 'private_animation' || asset.role === 'private-animation') reject('private asset is not publicly redistributable');
  if (!ownerClaim(asset)) {
    if (!STANDARD_LICENSES.has(asset.license)) reject('unknown public license');
    if (asset.distributionScope !== undefined && asset.distributionScope !== 'community-redistributable') reject('unexpected public distribution scope');
    if (asset.rightsBasis !== undefined) reject('unrecognized public rights basis');
    if (asset.redistributable !== undefined && asset.redistributable !== true) reject('invalid redistribution flag');
    return { kind: 'standard' };
  }
  assertGrant(manifestGrant);
  const source = ownerRows.get(asset.id);
  if (!source || asset.license !== OWNER_VISUAL_LICENSE || asset.rightsBasis !== OWNER_VISUAL_GRANT_ID
    || asset.distributionScope !== 'bundled-redistributable' || asset.redistributable !== true
    || asset.mediaKind !== 'video' || asset.bytes !== source.bytes || asset.sha256 !== source.sha256) reject('asset does not match its authorized source and scope');
  return { kind: 'owner-visual', grantId: OWNER_VISUAL_GRANT_ID };
}

/** Require the full 63-member grant and the caller's hash of the actual bundled grant document. */
export function validatePublicGrant(manifest, { documentSha256 } = {}) {
  if (!object(manifest) || !Array.isArray(manifest.assets)) reject('manifest assets must be an array');
  const claimed = manifest.assets.filter(asset => object(asset) && ownerClaim(asset));
  if (manifest.ownerVisualGrant === undefined && claimed.length === 0) {
    for (const asset of manifest.assets) validatePublicAssetRights(asset);
    return undefined;
  }
  assertGrant(manifest.ownerVisualGrant);
  if (documentSha256 !== OWNER_VISUAL_GRANT.document.sha256) reject('actual grant document SHA-256 missing or mismatched');
  if (claimed.length !== OWNER_VISUAL_GRANT.assetCount) reject('exact owner asset membership is required');
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!object(asset) || typeof asset.id !== 'string' || ids.has(asset.id)) reject('duplicate or malformed manifest asset');
    ids.add(asset.id);
    if (legacyIds.has(asset.id)) reject('legacy alias collides with a canonical manifest asset');
  }
  for (const asset of manifest.assets) validatePublicAssetRights(asset, OWNER_VISUAL_GRANT);
  for (const id of ownerRows.keys()) if (!ids.has(id)) reject('authorized source missing from manifest');
  return { grant: OWNER_VISUAL_GRANT, assets: OWNER_VISUAL_GRANT.assets, legacyAliases: OWNER_VISUAL_GRANT.legacyAliases };
}

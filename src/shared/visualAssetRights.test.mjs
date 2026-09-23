import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { OWNER_VISUAL_GRANT as grant, OWNER_VISUAL_GRANT_ID, OWNER_VISUAL_LICENSE, validatePublicAssetRights, validatePublicGrant } from './visualAssetRights.mjs';

const document = readFileSync(new URL('../../../../community/hao-motion-kit/OWNER_VISUAL_BUNDLE_GRANT.md', import.meta.url));
const documentSha256 = createHash('sha256').update(document).digest('hex');
const ownerAsset = row => ({ ...structuredClone(row), license: OWNER_VISUAL_LICENSE, rightsBasis: OWNER_VISUAL_GRANT_ID, distributionScope: 'bundled-redistributable', redistributable: true });
const manifest = () => ({ ownerVisualGrant: structuredClone(grant), assets: grant.assets.map(ownerAsset) });
const standard = { id: 'standard:one', mediaKind: 'image', license: 'CC-BY-4.0' };

test('real owner grant has exact 63 unique source and alias identities and actual document bytes', () => {
  assert.equal(grant.assetCount, 63); assert.equal(grant.assets.length, 63); assert.equal(grant.legacyAliases.length, 63);
  assert.equal(grant.assetBytes, 275617266); assert.equal(grant.assets.reduce((n, row) => n + row.bytes, 0), grant.assetBytes);
  assert.equal(new Set(grant.assets.map(row => row.id)).size, 63); assert.equal(new Set(grant.assets.map(row => row.sha256)).size, 63);
  assert.equal(document.length, grant.document.bytes); assert.equal(documentSha256, grant.document.sha256);
  assert(grant.assets.every(row => /^owner-visual:[a-f0-9]{20}$/.test(row.id) && /^assets\/owner-visual\/[a-f0-9]{20}\.(mp4|mov)$/.test(row.sourcePath)));
  assert(grant.assets.every(row => !('sourceFilename' in row) && row.originalProvenance && row.provenance.includes('2026-09-01')));
  for (const alias of grant.legacyAliases) {
    const row = grant.assets.find(item => item.id === alias.assetId);
    assert.equal(alias.legacyId.replace('private-visual:', 'owner-visual:'), row.id);
    assert.equal(alias.sha256, row.sha256); assert.equal(alias.bytes, row.bytes);
  }
});

test('positive legacy standard grant-less pack and all three existing preset licenses remain accepted', () => {
  assert.equal(validatePublicGrant({ assets: [standard] }), undefined);
  for (const license of ['CC-BY-4.0', 'MIT', 'CC0-1.0']) assert.deepEqual(validatePublicAssetRights({ ...standard, license }), { kind: 'standard' });
});

test('positive actual 63 members validates, returns frozen authority, and accepts property reordering', () => {
  const input = manifest(), result = validatePublicGrant(input, { documentSha256 });
  assert.equal(result.grant, grant); assert.equal(result.legacyAliases, grant.legacyAliases);
  for (const asset of input.assets) assert.deepEqual(validatePublicAssetRights(asset, result.grant), { kind: 'owner-visual', grantId: grant.id });
  input.ownerVisualGrant = Object.fromEntries(Object.entries(input.ownerVisualGrant).reverse());
  assert.equal(validatePublicGrant(input, { documentSha256 }).grant, grant);
  assert(Object.isFrozen(grant) && Object.isFrozen(grant.assets) && Object.isFrozen(grant.assets[0]) && Object.isFrozen(grant.permissions));
  assert.throws(() => { grant.permissions.standaloneAssetResale = true; }, TypeError);
});

for (const [name, mutate] of [
  ['missing grant', input => { delete input.ownerVisualGrant; }],
  ['document path', input => { input.ownerVisualGrant.document.path = '../outside.md'; }],
  ['document hash', input => { input.ownerVisualGrant.document.sha256 = '0'.repeat(64); }],
  ['forged owner', input => { input.ownerVisualGrant.rightsOwner = 'Someone else'; }],
  ['remove bundling permission', input => { input.ownerVisualGrant.permissions.bundledRedistribution = false; }],
  ['remove commercial permission', input => { input.ownerVisualGrant.permissions.commercialAudiovisualUse = false; }],
  ['add standalone resale', input => { input.ownerVisualGrant.permissions.standaloneAssetResale = true; }],
  ['invent independent legal review', input => { input.ownerVisualGrant.independentLegalReview = true; }],
  ['extra grant field', input => { input.ownerVisualGrant.privateSourcePath = 'not authorized'; }],
  ['grant missing member', input => { input.ownerVisualGrant.assets.pop(); }],
  ['grant extra member', input => { input.ownerVisualGrant.assets.push({ ...input.ownerVisualGrant.assets[0], id: 'owner-visual:' + 'f'.repeat(20) }); }],
  ['grant changed source', input => { input.ownerVisualGrant.assets[0].sha256 = '0'.repeat(64); }],
  ['alias collision', input => { input.ownerVisualGrant.legacyAliases[1].legacyId = input.ownerVisualGrant.legacyAliases[0].legacyId; }],
  ['alias points elsewhere', input => { input.ownerVisualGrant.legacyAliases[0].assetId = input.ownerVisualGrant.legacyAliases[1].assetId; }],
  ['alias changed bytes', input => { input.ownerVisualGrant.legacyAliases[0].bytes += 1; }],
  ['manifest missing owner member', input => { input.assets.pop(); }],
  ['manifest duplicate owner member', input => { input.assets.push(input.assets[0]); }],
  ['manifest legacy alias canonical collision', input => { input.assets.push({ ...standard, id: grant.legacyAliases[0].legacyId }); }],
  ['manifest changed source bytes', input => { input.assets[0].bytes += 1; }],
  ['manifest changed source hash', input => { input.assets[0].sha256 = '0'.repeat(64); }],
  ['manifest changed source ID', input => { input.assets[0].id = 'owner-visual:' + 'f'.repeat(20); }],
  ['owner source relicensed CC0', input => { input.assets[0].license = 'CC0-1.0'; }],
  ['owner source renamed to standard CC0', input => { input.assets[0] = { ...input.assets[0], id: 'standard:fake', license: 'CC0-1.0', rightsBasis: undefined, distributionScope: undefined }; }],
]) test(`rejects ${name}`, () => { const input = manifest(); mutate(input); assert.throws(() => validatePublicGrant(input, { documentSha256 }), /Public visual rights:/); });

test('missing/incorrect actual document hash cannot be supplied by manifest self-assertion', () => {
  assert.throws(() => validatePublicGrant(manifest()), /actual grant document/);
  assert.throws(() => validatePublicGrant(manifest(), { documentSha256: '0'.repeat(64) }), /actual grant document/);
});

for (const [name, patch] of [
  ['unknown license', { license: 'SOME-PUBLIC-LICENSE' }],
  ['private license even with redistribution true', { license: 'PRIVATE-OWNER-ONLY', redistributable: true }],
  ['private id', { id: 'private-visual:' + 'f'.repeat(20) }],
  ['private scope', { distributionScope: 'private-owner-only' }],
  ['private rights basis', { rightsBasis: 'private-owner-only' }],
  ['private category', { category: 'private_animation' }],
  ['private role', { role: 'private-animation' }],
  ['redistribution false', { redistributable: false }],
  ['unknown scope', { distributionScope: 'everything-public' }],
  ['unknown rights basis', { rightsBasis: 'forged' }],
]) test(`standard asset rejects ${name}`, () => assert.throws(() => validatePublicAssetRights({ ...standard, ...patch }), /Public visual rights:/));

test('no mutable grant cache: same object changed after a successful validation is rejected', () => {
  const input = manifest(); validatePublicGrant(input, { documentSha256 });
  input.ownerVisualGrant.permissions.standaloneAssetResale = true;
  assert.throws(() => validatePublicGrant(input, { documentSha256 }), /identity mismatch/);
  assert.throws(() => validatePublicAssetRights(input.assets[0], input.ownerVisualGrant), /identity mismatch/);
});

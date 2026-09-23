import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { evaluateCreativePack } from './lib/creative-pack-gate.mjs';

const minimums = { looks: 1, effects: 1, transitions: 1, textStyles: 1, templates: 1, assets: 1 };
const preset = (id, renderer) => ({ id, name: id, license: 'CC-BY-4.0', provenance: 'synthetic gate fixture', renderer });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'editkin-public-pack-rights-'));
  const put = (path, bytes) => { const target = resolve(root, path); assert(target.startsWith(root + sep)); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); return { path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }; };
  const source = put('assets/video.mp4', 'FIXTURE ORIGINAL NOT REAL MEDIA');
  const poster = put('previews/video/poster.jpg', 'FIXTURE POSTER');
  const media = put('previews/video/preview.mp4', 'FIXTURE MEDIA');
  const manifest = { schemaVersion: 1, id: 'fixture', name: 'Fixture', version: '1', license: 'CC-BY-4.0', attribution: 'Fixture', source: { referenceCount: 1, privateImagesEmbedded: false },
    presets: { looks: [preset('look', 'ffmpeg-eq')], effects: [preset('effect', 'ffmpeg-bloom')], transitions: [preset('transition', 'transition-fade')], textStyles: [preset('text', 'ass-text')], templates: [preset('template', 'hao-motion-composition/v1')] },
    assets: [{ ...preset('asset', 'media-asset'), ...source, mediaKind: 'video', derivatives: { sourceSha256: source.sha256, revision: 'a'.repeat(64), poster, media } }] };
  put('NOTICE.md', 'Fixture notice'); put('licenses/CC-BY-4.0.md', 'Fixture license'); put('preview-build-evidence.json', '{"fixture":true}');
  const save = () => put('editkin-pack.json', JSON.stringify(manifest)); save();
  const cleanup = () => { assert(resolve(root).startsWith(resolve(tmpdir()) + sep + 'editkin-public-pack-rights-')); rmSync(root, { recursive: true, force: true }); };
  return { root, manifest, put, save, cleanup };
}

test('positive exact regular-file pack and both preview identities pass the filesystem gate', () => {
  const f = fixture(); try { assert.equal(evaluateCreativePack(f.manifest, { root: f.root, minimums }).status, 'GREEN'); } finally { f.cleanup(); }
});

for (const [name, mutate, expected] of [
  ['private asset license and flags', f => Object.assign(f.manifest.assets[0], { license: 'PRIVATE-OWNER-ONLY', redistributable: false, distributionScope: 'private-owner-only' }), 'public-asset-rights'],
  ['unknown preset license', f => { f.manifest.presets.looks[0].license = 'FAKE'; }, 'public-asset-rights'],
  ['private preset license', f => { f.manifest.presets.looks[0].license = 'PRIVATE-OWNER-ONLY'; }, 'public-asset-rights'],
  ['missing poster metadata', f => { delete f.manifest.assets[0].derivatives.poster; }, 'missing-video-preview'],
  ['missing media metadata', f => { delete f.manifest.assets[0].derivatives.media; }, 'missing-video-preview'],
  ['wrong preview source', f => { f.manifest.assets[0].derivatives.sourceSha256 = '0'.repeat(64); }, 'preview-source-binding'],
  ['wrong preview bytes', f => { f.manifest.assets[0].derivatives.poster.bytes += 1; }, 'hash-mismatch'],
  ['wrong preview hash', f => { f.manifest.assets[0].derivatives.media.sha256 = '0'.repeat(64); }, 'hash-mismatch'],
  ['unexpected file', f => f.put('assets/unlisted.mp4', 'UNAUTHORIZED EXTRA'), 'unexpected-payload'],
  ['unexpected license', f => f.put('licenses/unlisted.md', 'UNDECLARED'), 'unexpected-payload'],
  ['unexpected empty directory', f => mkdirSync(join(f.root, 'unlisted-empty-directory')), 'unexpected-payload'],
  ['missing actual poster', f => rmSync(join(f.root, 'previews/video/poster.jpg')), 'missing-asset'],
  ['missing actual notice', f => rmSync(join(f.root, 'NOTICE.md')), 'missing-asset'],
  ['source changed same size', f => f.put('assets/video.mp4', 'FIXTURE ORIGINAL NOT REAL MEDIB'), 'hash-mismatch'],
  ['case-insensitive duplicate path', f => { f.manifest.assets[0].derivatives.poster.path = 'ASSETS/VIDEO.MP4'; }, 'duplicate-payload-path'],
  ['traversal source path', f => { f.manifest.assets[0].path = '../outside.mp4'; }, 'unsafe-asset-path'],
]) test(`rejects ${name}`, () => {
  const f = fixture(); try { mutate(f); f.save(); const result = evaluateCreativePack(f.manifest, { root: f.root, minimums }); assert.equal(result.status, 'BLOCK'); assert(result.findings.some(row => row.code === expected), JSON.stringify(result.findings)); } finally { f.cleanup(); }
});

test('disk manifest must equal the manifest whose permissions were evaluated', () => {
  const f = fixture(); try { f.put('editkin-pack.json', JSON.stringify({ ...f.manifest, assets: [] })); assert(evaluateCreativePack(f.manifest, { root: f.root, minimums }).findings.some(row => row.code === 'manifest-file-mismatch')); } finally { f.cleanup(); }
});

test('real directory junction is rejected, without following it into another fixture', t => {
  const f = fixture(), outside = fixture();
  try {
    try { symlinkSync(outside.root, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Host disallows fixture junction creation; no rejection claim'); return; } throw error; }
    assert(lstatSync(join(f.root, 'linked')).isSymbolicLink());
    assert(evaluateCreativePack(f.manifest, { root: f.root, minimums }).findings.some(row => row.code === 'unsafe-payload'));
  } finally { f.cleanup(); outside.cleanup(); }
});

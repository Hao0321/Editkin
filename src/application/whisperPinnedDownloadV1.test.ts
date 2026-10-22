import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { REPO_TMP, useTempRoots } from '../test/tempRoot.mjs';
import type { WhisperModelDescriptor } from './automaticCaptions';
import { ensurePinnedModelFileV1, inspectPinnedModelFileV1, type PinnedModelDownloadDepsV1 } from './whisperPinnedDownloadV1';
const roots = useTempRoots(), bytes = Buffer.from('owned fixture model bytes');
const pin: WhisperModelDescriptor = { id: 'owned-test-pin', fileName: 'owned-model.bin', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.test/owned-model.bin', license: 'MIT' };
const fixture = async () => ({ modelRoot: await roots.create('pinned-download-', { parent: REPO_TMP }) });
const transport = (data = bytes): PinnedModelDownloadDepsV1 => ({ stream: vi.fn(async () => Readable.from([data])) });
it('publishes actual verified bytes atomically and reuses a valid existing destination without contacting the network', async () => {
  const runtime = await fixture(), deps = transport();
  const first = await ensurePinnedModelFileV1(runtime, pin, true, deps);
  expect(first).toEqual({ path: join(runtime.modelRoot, pin.fileName), downloaded: true });
  expect(await readFile(first.path)).toEqual(bytes);
  expect(await inspectPinnedModelFileV1(first.path, pin)).toMatchObject({ exists: true, valid: true, bytes: bytes.length, sha256: pin.sha256 });
  expect(await readdir(runtime.modelRoot)).toEqual([pin.fileName]);
  expect(await ensurePinnedModelFileV1(runtime, pin, false, deps)).toEqual({ ...first, downloaded: false });
  expect(deps.stream).toHaveBeenCalledTimes(1);
});
it.each([
  ['truncated', bytes.subarray(0, bytes.length - 1), 'WHISPER_MODEL_DOWNLOAD_PIN_MISMATCH'],
  ['oversized', Buffer.concat([bytes, Buffer.from('x')]), 'WHISPER_MODEL_DOWNLOAD_SIZE'],
  ['same-size substitution', Buffer.alloc(bytes.length, 97), 'WHISPER_MODEL_DOWNLOAD_PIN_MISMATCH'],
])('rejects %s transport bytes and removes only its own partial file', async (_name, data, error) => {
  const runtime = await fixture(); await writeFile(join(runtime.modelRoot, 'preserved.txt'), 'preserved');
  await expect(ensurePinnedModelFileV1(runtime, pin, true, transport(data))).rejects.toThrow(error);
  expect(await readdir(runtime.modelRoot)).toEqual(['preserved.txt']);
  expect(await readFile(join(runtime.modelRoot, 'preserved.txt'), 'utf8')).toBe('preserved');
});
it.each([Buffer.from('wrong-sized'), Buffer.alloc(bytes.length, 98)])('preserves an invalid existing destination instead of replacing it', async data => {
  const runtime = await fixture(), path = join(runtime.modelRoot, pin.fileName), deps = transport();
  await writeFile(path, data);
  await expect(ensurePinnedModelFileV1(runtime, pin, true, deps)).rejects.toThrow('WHISPER_MODEL_CONFIGURED_OR_EXISTING_PIN_INVALID');
  expect(await readFile(path)).toEqual(data); expect(deps.stream).not.toHaveBeenCalled();
});
it('preserves explicit configuration and respects download-disabled requests', async () => {
  const runtime = await fixture(), deps = transport();
  await expect(ensurePinnedModelFileV1({ ...runtime, modelPath: join(runtime.modelRoot, 'custom.bin') }, pin, true, deps))
    .rejects.toThrow('WHISPER_MODEL_CONFIGURED_OR_EXISTING_PIN_INVALID');
  await expect(ensurePinnedModelFileV1(runtime, pin, false, deps)).rejects.toThrow('WHISPER_MODEL_MISSING_DOWNLOAD_DISABLED');
  expect(deps.stream).not.toHaveBeenCalled(); expect(await readdir(runtime.modelRoot)).toEqual([]);
});
it('settles cancellation during an active stream, destroys that stream and cleans its partial output', async () => {
  const runtime = await fixture(), controller = new AbortController(); let pushed = false;
  const input = new Readable({ read() { if (!pushed) { pushed = true; this.push(bytes.subarray(0, 3)); queueMicrotask(() => controller.abort()); } } });
  await expect(ensurePinnedModelFileV1({ ...runtime, signal: controller.signal }, pin, true, { stream: async () => input }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(input.destroyed).toBe(true); expect(await readdir(runtime.modelRoot)).toEqual([]);
});
it('closes a stream when cancellation wins immediately as transport acquisition resolves', async () => {
  const runtime = await fixture(), controller = new AbortController(), input = new Readable({ read() {} });
  await expect(ensurePinnedModelFileV1({ ...runtime, signal: controller.signal }, pin, true,
    { stream: async () => { controller.abort(); return input; } })).rejects.toMatchObject({ name: 'AbortError' });
  expect(input.destroyed).toBe(true); expect(await readdir(runtime.modelRoot)).toEqual([]);
});
it('does not acquire a network stream for an already cancelled request', async () => {
  const runtime = await fixture(), controller = new AbortController(), deps = transport(); controller.abort();
  await expect(ensurePinnedModelFileV1({ ...runtime, signal: controller.signal }, pin, true, deps)).rejects.toMatchObject({ name: 'AbortError' });
  expect(deps.stream).not.toHaveBeenCalled(); expect(await readdir(runtime.modelRoot)).toEqual([]);
});
it('refuses a concurrently created invalid destination without overwriting it', async () => {
  const runtime = await fixture(), path = join(runtime.modelRoot, pin.fileName), other = Buffer.from('other owner');
  await expect(ensurePinnedModelFileV1(runtime, pin, true, { stream: async () => {
    await writeFile(path, other, { flag: 'wx' }); return Readable.from([bytes]);
  } })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path)).toEqual(other); expect(await readdir(runtime.modelRoot)).toEqual([pin.fileName]);
});
it('accepts a concurrently published identical pin while removing its own partial file', async () => {
  const runtime = await fixture(), path = join(runtime.modelRoot, pin.fileName);
  await ensurePinnedModelFileV1(runtime, pin, true, { stream: async () => {
    await writeFile(path, bytes, { flag: 'wx' }); return Readable.from([bytes]);
  } });
  expect(await readFile(path)).toEqual(bytes); expect(await readdir(runtime.modelRoot)).toEqual([pin.fileName]);
});
it('refuses directory destinations and aliased model roots while preserving their targets', async () => {
  const runtime = await fixture(), path = join(runtime.modelRoot, pin.fileName); await mkdir(path);
  await expect(ensurePinnedModelFileV1(runtime, pin, true, transport())).rejects.toThrow('WHISPER_MODEL_ALIAS_OR_TYPE');
  const target = await roots.create('model-alias-target-', { parent: REPO_TMP }); await writeFile(join(target, 'preserved.txt'), 'preserved');
  const alias = join(runtime.modelRoot, 'alias'); await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(ensurePinnedModelFileV1({ modelRoot: alias }, pin, true, transport())).rejects.toThrow('WHISPER_MODEL_ROOT_ALIAS');
  await writeFile(join(target, pin.fileName), bytes);
  await expect(inspectPinnedModelFileV1(join(alias, pin.fileName), pin)).rejects.toThrow('WHISPER_MODEL_ALIAS_OR_TYPE');
  expect(await readFile(join(target, 'preserved.txt'), 'utf8')).toBe('preserved');
});
it.each([
  { ...pin, url: 'http://example.test/model' }, { ...pin, url: 'https://user:pass@example.test/model' },
  { ...pin, fileName: '../other.bin' }, { ...pin, bytes: 0 }, { ...pin, bytes: 2 ** 31 + 1 }, { ...pin, sha256: 'unverified' },
])('rejects inadmissible data pins before filesystem or transport work', async invalid => {
  const runtime = await fixture(), deps = transport();
  await expect(ensurePinnedModelFileV1(runtime, invalid, true, deps)).rejects.toThrow();
  expect(deps.stream).not.toHaveBeenCalled(); expect(await readdir(runtime.modelRoot)).toEqual([]);
});

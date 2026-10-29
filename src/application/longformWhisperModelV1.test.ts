import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { REPO_TMP, useTempRoots } from '../test/tempRoot.mjs';
import { PINNED_WHISPER_MODEL as small } from './automaticCaptions';
import { OPTIONAL_WHISPER_MEDIUM_MODEL_V1 as medium } from './whisperModelChoiceV1';
import { withLongformWhisperModelV1 } from './longformWhisperModelV1';
import { resolveLongformWhisperPromptV1 } from './longformWhisperPromptV1';
import { prepareLongformWordRecognitionV1, readLongformWordPageV1,
  type LongformWordRecognitionRuntimeV1, type LongformWordRecognitionDepsV1 } from './longformWordRecognitionV1';
import type { LongformWordTimingRequestV1 } from '../domain/longformWordTimingV1';
const roots = useTempRoots();
async function fixture() {
  const root = await roots.create('longword-model-', { parent: REPO_TMP }); await writeFile(join(root, 'voice.wav'), 'preserved narration');
  const request: LongformWordTimingRequestV1 = { schema: 'editkin.longform-word-timing-request/v1',
    narration: { id: 'voice', path: 'voice.wav', sourceStart: 0, duration: 2 }, script: { kind: 'text', text: 'Alpha Beta' },
    recordings: [], screenshots: [], language: 'en' };
  const runtime: LongformWordRecognitionRuntimeV1 = { sourceRoot: root, modelRoot: root, modelPath: join(root, 'configured-small.bin'),
    cacheRoot: join(root, 'cache'), workRoot: join(root, 'work'), ffmpegPath: join(root, 'ffmpeg.exe'), whisperCliPath: join(root, 'whisper.exe'),
    probe: async () => ({ duration: 2, hasAudio: true, hasVideo: false }) };
  const calls: Array<{ exe: string; args: string[] }> = [], inspections: Array<{ path: string; pin: string }> = [];
  const deps: LongformWordRecognitionDepsV1 = {
    inspectModel: async (path, pin = small) => { inspections.push({ path, pin: pin.id }); return { valid: true, bytes: pin.bytes, sha256: pin.sha256 }; },
    runtimeIdentity: async rt => rt.whisperModel === 'medium' ? 'b'.repeat(64) : 'a'.repeat(64),
    run: async (exe, args, options) => {
      options.signal?.throwIfAborted(); calls.push({ exe, args: [...args] });
      if (args[0] === '--help') return { stdout: Buffer.from('--output-json-full\n--prompt PROMPT'), stderr: '' };
      if (exe === runtime.ffmpegPath) await writeFile(args.at(-1)!, 'owned PCM fixture');
      else {
        const text = args[args.indexOf('-m') + 1].endsWith(medium.fileName) ? 'Beta' : 'Alpha';
        await writeFile(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ text, offsets: { from: 0, to: 2000 },
          tokens: [{ text, id: 42, p: .9, offsets: { from: 100, to: 900 } }] }] }));
      }
      return { stdout: Buffer.alloc(0), stderr: '' };
    },
  };
  return { root, runtime, request, deps, calls, inspections, recognitions: () => calls.filter(row => row.args.includes('-ojf')) };
}
it('isolates both real word-window caches by selected pin, preserves the original small artifact and reuses the matching model', async () => {
  const f = await fixture(), first = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  const artifactPath = join(f.runtime.cacheRoot, 'longform-word-timing-v1/artifacts', first.artifact.artifactId + '.json');
  const originalBytes = await readFile(artifactPath);
  const second = await prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps);
  expect(second.artifact.recognizer).toMatchObject({ modelId: medium.id, modelSha256: medium.sha256 });
  expect(first.artifact.recognizer.modelId).toBe(small.id);
  expect(second.artifact.artifactId).not.toBe(first.artifact.artifactId);
  expect(second.artifact.windows[0].key).not.toBe(first.artifact.windows[0].key);
  expect(f.recognitions().map(row => row.args[row.args.indexOf('-m') + 1])).toEqual([f.runtime.modelPath, join(f.root, medium.fileName)]);
  expect((await readLongformWordPageV1(f.runtime, first.artifact.artifactId)).words.map(row => [row.text, row.start, row.end]))
    .toEqual([['Alpha', .1, .9]]);
  expect((await readLongformWordPageV1(f.runtime, second.artifact.artifactId)).words.map(row => [row.text, row.start, row.end]))
    .toEqual([['Beta', .1, .9]]);
  const cached = await prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps);
  expect(cached.cachedWindows).toBe(1); expect(cached.artifact).toEqual(second.artifact);
  const returned = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  expect(returned.cachedWindows).toBe(1); expect(returned.artifact).toEqual(first.artifact); expect(f.recognitions()).toHaveLength(2);
  expect(await readFile(artifactPath)).toEqual(originalBytes); expect(await readdir(f.runtime.workRoot)).toEqual([]);
  expect(f.runtime.modelPath).toBe(join(f.root, 'configured-small.bin'));
  expect(await readFile(join(f.root, 'voice.wav'), 'utf8')).toBe('preserved narration');
});
it('downloads only the missing selected medium pin, then re-inspects before any recognition', async () => {
  const f = await fixture(); let ready = false;
  f.deps.inspectModel = async (_path, pin = small) => ({ valid: ready, bytes: ready ? pin.bytes : 0, sha256: ready ? pin.sha256 : '' });
  f.deps.ensureModel = async (runtime, pin) => {
    expect(f.calls).toEqual([]); expect(pin).toBe(medium); expect(runtime.modelPath).toBeUndefined();
    ready = true; return { path: join(runtime.modelRoot, pin.fileName), downloaded: true };
  };
  const result = await prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps);
  expect(result.artifact.recognizer.modelId).toBe(medium.id); expect(f.recognitions()).toHaveLength(1);
});
it('does not silently fall back to small when the selected medium file remains invalid', async () => {
  const f = await fixture(); f.deps.inspectModel = async () => ({ valid: false, bytes: 0, sha256: '' });
  f.deps.ensureModel = async runtime => ({ path: join(runtime.modelRoot, medium.fileName), downloaded: false });
  await expect(prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps))
    .rejects.toThrow('WORD_TIMING_PINNED_MODEL_UNAVAILABLE');
  expect(f.calls).toEqual([]);
});
it('preserves a missing explicit medium override instead of downloading over its configuration', async () => {
  const f = await fixture(); f.runtime.mediumModelPath = join(f.root, 'missing-configured-medium.bin');
  f.deps.inspectModel = async () => ({ valid: false, bytes: 0, sha256: '' });
  await expect(prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps))
    .rejects.toThrow('WHISPER_MODEL_CONFIGURED_OR_EXISTING_PIN_INVALID');
  expect(f.calls).toEqual([]); expect(await readdir(f.root)).toEqual(['voice.wav']);
});
it('rejects selected-model drift before publishing an otherwise completed word artifact', async () => {
  const f = await fixture(); let checks = 0;
  f.deps.inspectModel = async (_path, pin = small) => ({ valid: ++checks === 1, bytes: pin.bytes, sha256: pin.sha256 });
  await expect(prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps))
    .rejects.toThrow('WORD_TIMING_RECOGNIZER_CHANGED');
  expect(f.recognitions()).toHaveLength(1);
  expect(await readdir(join(f.runtime.cacheRoot, 'longform-word-timing-v1/artifacts'))).toEqual([]);
  expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it('forwards the owning cancellation signal to medium acquisition and starts no recognizer after cancellation', async () => {
  const f = await fixture(), controller = new AbortController(); f.runtime.signal = controller.signal;
  f.deps.inspectModel = async () => ({ valid: false, bytes: 0, sha256: '' });
  f.deps.ensureModel = async runtime => { expect(runtime.signal).toBe(controller.signal); controller.abort(); runtime.signal!.throwIfAborted();
    throw new Error('unreachable'); };
  await expect(prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(f.calls).toEqual([]);
});
it('retains the Chinese vocabulary prompt and selected model in word-clock evidence', async () => {
  const f = await fixture(); f.request.language = 'zh';
  const result = await prepareLongformWordRecognitionV1({ ...f.request, whisperModel: 'medium' }, f.runtime, f.deps);
  expect(f.recognitions()[0].args).toContain('--prompt');
  expect(result.artifact.recognizer.prompt).toEqual(resolveLongformWhisperPromptV1('zh'));
  expect(f.recognitions()[0].args[f.recognitions()[0].args.indexOf('--prompt') + 1]).toBe(resolveLongformWhisperPromptV1('zh').text);
  expect(result.artifact.contentVerified).toBe(false); expect(result.artifact.syntheticTimingUsed).toBe(false);
  const selected = withLongformWhisperModelV1(f.runtime, 'medium');
  expect(withLongformWhisperModelV1(selected, 'small').modelPath).toBe(f.runtime.modelPath);
});

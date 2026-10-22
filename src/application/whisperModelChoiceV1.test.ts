import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { REPO_TMP, useTempRoots } from '../test/tempRoot.mjs';
import { longformWordTimingRequestV1Schema } from '../domain/longformWordTimingV1';
import { automaticCaptionRuntimeSha256, PINNED_WHISPER_MODEL } from './automaticCaptions';
import { OPTIONAL_WHISPER_MEDIUM_MODEL_V1 as medium, selectedWhisperModelV1, whisperModelChoiceV1,
  withWhisperModelRuntimeV1, type WhisperModelRuntimeFieldsV1 } from './whisperModelChoiceV1';
const roots = useTempRoots();
it('admits only the existing small and the explicitly approved multilingual medium pin', () => {
  expect(selectedWhisperModelV1(undefined, PINNED_WHISPER_MODEL)).toBe(PINNED_WHISPER_MODEL);
  expect(selectedWhisperModelV1('medium', PINNED_WHISPER_MODEL)).toBe(medium);
  expect(Object.isFrozen(medium)).toBe(true);
  expect(medium).toMatchObject({ bytes: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f' });
  expect(new URL(medium.url).pathname).toContain('/5359861c739e955e79d9a303bcbc70fb988958b1/');
  for (const value of [null, 'large', 'medium.en', 'https://other/model', { model: 'medium' }])
    expect(() => whisperModelChoiceV1(value)).toThrow('WHISPER_MODEL_CHOICE_INVALID');
});
it('preserves the configured small path and selects a separate medium path through repeated switches', () => {
  const original: WhisperModelRuntimeFieldsV1 = { modelRoot: resolve('owned-models'), modelPath: resolve('old-small.bin') };
  expect(withWhisperModelRuntimeV1(original, undefined, PINNED_WHISPER_MODEL)).toBe(original);
  const selected = withWhisperModelRuntimeV1(original, 'medium', PINNED_WHISPER_MODEL);
  expect(selected.modelPath).toBe(join(original.modelRoot, medium.fileName));
  expect(selected.smallModelPath).toBe(original.modelPath);
  expect(withWhisperModelRuntimeV1(selected, undefined, PINNED_WHISPER_MODEL).modelPath).toBe(selected.modelPath);
  const returned = withWhisperModelRuntimeV1(selected, 'small', PINNED_WHISPER_MODEL);
  expect(returned.modelPath).toBe(original.modelPath);
  expect(withWhisperModelRuntimeV1(returned, 'medium', PINNED_WHISPER_MODEL).modelPath).toBe(selected.modelPath);
  expect(original).toEqual({ modelRoot: resolve('owned-models'), modelPath: resolve('old-small.bin') });
});
it('uses a medium-specific override without borrowing the legacy configured small file', () => {
  const runtime: WhisperModelRuntimeFieldsV1 = { modelRoot: resolve('owned'), modelPath: resolve('small-custom.bin'),
    mediumModelPath: resolve('medium-custom.bin') };
  expect(withWhisperModelRuntimeV1(runtime, 'medium', PINNED_WHISPER_MODEL).modelPath).toBe(runtime.mediumModelPath);
  expect(withWhisperModelRuntimeV1(runtime, 'small', PINNED_WHISPER_MODEL).modelPath).toBe(runtime.modelPath);
});
it('admits the optional word-timing choice while retaining strict request boundaries', () => {
  const request = { schema: 'editkin.longform-word-timing-request/v1', narration: { id: 'n', path: 'n.wav', sourceStart: 0, duration: 2 },
    script: { kind: 'text', text: 'hello' }, recordings: [], screenshots: [], language: 'en' };
  expect(longformWordTimingRequestV1Schema.parse(request)).not.toHaveProperty('whisperModel');
  expect(longformWordTimingRequestV1Schema.parse({ ...request, whisperModel: 'medium' }).whisperModel).toBe('medium');
  for (const patch of [{ whisperModel: 'large' }, { whisperModel: null }, { modelUrl: medium.url }, { modelPath: 'other.bin' }])
    expect(() => longformWordTimingRequestV1Schema.parse({ ...request, ...patch })).toThrow();
});
it('binds actual selected model bytes and runtime libraries while keeping small and medium cache identities independent', async () => {
  const root = await roots.create('model-choice-', { parent: REPO_TMP });
  const smallPath = join(root, 'configured-small.bin'), mediumPath = join(root, medium.fileName);
  await Promise.all([writeFile(smallPath, 'small A'), writeFile(mediumPath, 'medium A'),
    writeFile(join(root, 'ffmpeg.exe'), 'ffmpeg'), writeFile(join(root, 'whisper.exe'), 'whisper'), writeFile(join(root, 'ggml.dll'), 'library A')]);
  const runtime = { modelRoot: root, modelPath: smallPath, ffmpegPath: join(root, 'ffmpeg.exe'),
    whisperCliPath: join(root, 'whisper.exe'), cacheRoot: join(root, 'cache') };
  const smallBefore = await automaticCaptionRuntimeSha256(runtime);
  const selected = withWhisperModelRuntimeV1(runtime, 'medium', PINNED_WHISPER_MODEL);
  const mediumBefore = await automaticCaptionRuntimeSha256(selected);
  expect(mediumBefore).not.toBe(smallBefore);
  await writeFile(mediumPath, 'medium B');
  expect(await automaticCaptionRuntimeSha256(runtime)).toBe(smallBefore);
  expect(await automaticCaptionRuntimeSha256(selected)).not.toBe(mediumBefore);
  const mediumAfter = await automaticCaptionRuntimeSha256(selected);
  await writeFile(smallPath, 'small B');
  expect(await automaticCaptionRuntimeSha256(selected)).toBe(mediumAfter);
  expect(await automaticCaptionRuntimeSha256(runtime)).not.toBe(smallBefore);
  await writeFile(join(root, 'ggml.dll'), 'library B');
  expect(await automaticCaptionRuntimeSha256(selected)).not.toBe(mediumAfter);
});

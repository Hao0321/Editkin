import assert from "node:assert/strict";
import {describe, it} from "vitest";
import {createDemoProject} from "../domain/demo";
import type {EditProject} from "../domain/types";
import {ResidentAudioTransport, type ResidentAudioView} from "./residentAudioTransport";
import type {ResidentAudioApi, ResidentAudioStage, ResidentAudioStatus} from "./residentAudioTypes";

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return {promise, resolve};
}
function fixture() {
  const project = createDemoProject();
  const views: ResidentAudioView[] = [], replacements: Array<{project: EditProject; generation: number}> = [];
  const controls: Array<[number, boolean]> = [], closes: number[] = [];
  let listener!: (status: ResidentAudioStatus) => void, generation = 0, opens = 0;
  let pending: ReturnType<typeof deferred<void>> | undefined;
  const stages = new Map<number, ResidentAudioStage>();
  const api: ResidentAudioApi = {
    capabilities: async () => ({schema: "editkin.desktop-audio-capabilities/v1", supported: true, gpuClock: true, sampleRate: 48000}),
    open: async callback => { listener = callback; opens++; return {ownerId: 7, status: {} as ResidentAudioStatus}; },
    replace: async (ownerId, input, start) => {
      const next = ++generation, wait = pending; pending = undefined;
      replacements.push({project: input, generation: next});
      const stage: ResidentAudioStage = {schema: "editkin.native-audio-project-stage/v1", status: "PREPARED",
        projectId: input.id, projectRevision: input.revision, projectUpdatedAt: input.updatedAt, generation: next,
        startFrame: Math.round(start * 48000), frameCount: 48000, sourceCount: 1, peakActiveSources: 1,
        pcmStagingFiles: 0, planSha256: "a".repeat(64), audioFingerprintSha256: "b".repeat(64), planBytes: 240};
      stages.set(next, stage);
      if (wait) await wait.promise;
      return {ownerId, generation: next, stage};
    },
    control: async (ownerId, current, playing) => { controls.push([current, playing]); return {ownerId, accepted: true, requestId: controls.length}; },
    close: async ownerId => { closes.push(ownerId); return {ownerId, released: true, retainedStageFiles: 0}; },
  };
  const clock: Array<[number, boolean]> = [];
  const transport = new ResidentAudioTransport(api, view => views.push(view), (time, ended) => clock.push([time, ended]));
  const intent = {project, seekRevision: 0, timelineStartSeconds: 0, playing: true, prepare: true, previewEpoch: 0};
  const draft = (volume: number) => { const next = structuredClone(project); next.tracks[0].clips[0].volume = volume; return next; };
  const send = (current: number, sequence: number) => {
    const stage = stages.get(current)!;
    listener({schema: "editkin.desktop-audio-status/v1", ownerId: 7, sequence, generation: current, ready: true, closing: false, failed: false,
      playback: {schema: "editkin.native-audio-session-event/v1", event: "progress", state: "playing", streamGeneration: current,
        timelineStartFrame: stage.startFrame, timelineFrame: stage.startFrame, presentedFrame: 0, sampleMasterFrame: 0, sampleMasterRate: 48000}});
  };
  return {project, intent, transport, views, replacements, controls, closes, clock, draft, send, opens: () => opens,
    deferNext: () => { pending = deferred<void>(); return pending; }};
}

describe("renderer-local audio preview identity", () => {
  it("restages a draft and its cancellation with unchanged durable headers and one owner", async () => {
    const f = fixture(), original = JSON.stringify(f.project);
    try {
      f.transport.update(f.intent); await flush(); f.send(1, 1);
      const draft = f.draft(.25);
      assert.deepEqual([draft.id, draft.revision, draft.updatedAt], [f.project.id, f.project.revision, f.project.updatedAt]);
      f.transport.update({...f.intent, project: draft, previewEpoch: 1}); await flush();
      assert.equal(f.replacements.length, 2); assert.equal(f.replacements[1].project, draft);
      f.send(2, 2); assert.equal(f.views.at(-1)?.previewEpoch, 1);
      f.transport.update({...f.intent, previewEpoch: 2}); await flush();
      assert.equal(f.replacements.length, 3); assert.equal(f.replacements[2].project, f.project);
      f.send(3, 3); assert.equal(f.views.at(-1)?.previewEpoch, 2);
      assert.equal(f.opens(), 1); assert.equal(JSON.stringify(f.project), original);
    } finally { await f.transport.dispose(); }
    assert.deepEqual(f.closes, [7]);
  });

  it("coalesces pending drafts and never autoplays an obsolete preview generation", async () => {
    const f = fixture();
    try {
      f.transport.update(f.intent); await flush();
      const pending = f.deferNext();
      f.transport.update({...f.intent, project: f.draft(.2), previewEpoch: 1}); await flush();
      for (let epoch = 2; epoch <= 8; epoch++) f.transport.update({...f.intent, project: f.draft(epoch / 10), previewEpoch: epoch});
      pending.resolve(); await flush();
      assert.deepEqual(f.replacements.map(row => row.generation), [1, 2, 3]);
      assert.equal(f.replacements[2].project.tracks[0].clips[0].volume, .8);
      assert.deepEqual(f.controls, [[1, true], [3, true]]);
      f.send(2, 1); assert.equal(f.clock.length, 0);
      f.send(3, 2); assert.equal(f.clock.length, 1); assert.equal(f.views.at(-1)?.previewEpoch, 8);
    } finally { await f.transport.dispose(); }
  });

  it("a cancellation while replacement is pending wins over the intermediate draft", async () => {
    const f = fixture();
    try {
      f.transport.update(f.intent); await flush(); const pending = f.deferNext();
      f.transport.update({...f.intent, project: f.draft(.1), previewEpoch: 1}); await flush();
      f.transport.update({...f.intent, previewEpoch: 2, playing: false});
      pending.resolve(); await flush();
      assert.equal(f.replacements.length, 3); assert.equal(f.replacements[2].project, f.project);
      assert.deepEqual(f.controls, [[1, true]]); assert.equal(f.views.at(-1)?.playing, false);
      assert.equal(f.views.at(-1)?.previewEpoch, 2);
    } finally { await f.transport.dispose(); }
  });

  it("retains the same preview plan across telemetry and pause/resume", async () => {
    const f = fixture(), draft = f.draft(.5);
    try {
      const intent = {...f.intent, project: draft, previewEpoch: 4};
      f.transport.update(intent); await flush();
      for (let time = 1; time < 20; time++) f.transport.update({...intent, timelineStartSeconds: time / 10});
      await flush(); f.transport.update({...intent, playing: false}); await flush(); f.transport.update(intent); await flush();
      assert.equal(f.replacements.length, 1); assert.equal(f.opens(), 1);
      assert.deepEqual(f.controls, [[1, true], [1, false], [1, true]]);
    } finally { await f.transport.dispose(); }
  });

  it("rejects malformed preview epochs before altering the desired plan", async () => {
    const f = fixture();
    try {
      f.transport.update(f.intent); await flush();
      for (const previewEpoch of [-1, .5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => f.transport.update({...f.intent, project: f.draft(.4), previewEpoch}));
      await flush(); assert.equal(f.replacements.length, 1); assert.deepEqual(f.controls, [[1, true]]);
    } finally { await f.transport.dispose(); }
  });
});

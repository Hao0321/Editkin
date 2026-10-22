import { readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";
import { useTempRoots } from "../test/tempRoot.mjs";
import { stageNativeAudioPreview, type NativeAudioPreviewStageReceipt } from "./nativeAudioPreview";
import { nativeAudioStageWorkSnapshotV1, withNativeAudioStageWorkV1 } from "./nativeAudioStageWorkOwnerV1";

const controls = vi.hoisted(() => ({ probe: vi.fn(), run: vi.fn() }));
vi.mock("../render/mediaProcess", async original => ({ ...await original<typeof import("../render/mediaProcess")>(), probeMedia: controls.probe, runProcess: controls.run }));
const temp = useTempRoots();
function fixture(root: string, count = 2) {
  const project = createDemoProject(), source = project.assets[0], clip = project.tracks[0].clips[0];
  project.assets = Array.from({ length: count }, (_, index) => ({ ...source, id: `s${index}`, kind: "audio" as const, uri: join(root, `source-${index}.wav`), role: "dialogue" as const }));
  project.tracks = [{ ...project.tracks[0], id: "probe-audio", kind: "audio", muted: false, solo: false,
    clips: project.assets.map(asset => ({ ...clip, id: `c-${asset.id}`, assetId: asset.id, trackId: "probe-audio", timelineStart: 0, sourceStart: 0, duration: .25, volume: .5, audioEnvelope: undefined })) }];
  project.compositions = []; project.captions = []; project.motionGraphics = [];
  return project;
}
const options = (root: string) => ({ cacheRoot: root, ffmpegPath: "controlled-decoder", ffprobePath: "controlled-probe", timelineStartSeconds: 0, maxDurationSeconds: .25 });
async function retire(stage: NativeAudioPreviewStageReceipt) { for (const path of [...stage.managedPaths].reverse()) await rm(path, { force: true }); await rmdir(stage.sessionRoot); }
beforeEach(() => {
  controls.probe.mockReset().mockResolvedValue({ hasAudio: true });
  controls.run.mockReset().mockImplementation(async (_executable: string, args: string[]) => { const pcm = Buffer.alloc(8); pcm.writeFloatLE(.1, 0); pcm.writeFloatLE(-.1, 4); await writeFile(args.at(-1)!, pcm); return { stdout: "", stderr: "" }; });
});
afterEach(() => expect(nativeAudioStageWorkSnapshotV1().active).toBe(0));

describe("native preview probe admission and retirement", () => {
  it("reserves before probes and refuses a third blocked stage without launching its probes", async () => {
    const roots = await Promise.all([0, 1, 2].map(() => temp.create("audio-probe-admission-")));
    const releases: Array<(probe: { hasAudio: boolean }) => void> = [];
    controls.probe.mockImplementation(() => new Promise(done => releases.push(done)));
    const jobs = roots.map(root => stageNativeAudioPreview(fixture(root), options(root)).catch(error => error));
    try {
      await expect(jobs[2]).resolves.toMatchObject({ message: "NATIVE_AUDIO_STAGE_CLEANUP_BUSY" });
      await vi.waitFor(() => expect(controls.probe).toHaveBeenCalledTimes(2));
      expect(nativeAudioStageWorkSnapshotV1().active).toBe(2);
      expect(controls.probe.mock.calls.some(([path]) => String(path).startsWith(roots[2]))).toBe(false);
      expect(await readdir(roots[2])).toEqual([]);
    } finally {
      controls.probe.mockResolvedValue({ hasAudio: true }); for (const release of releases) release({ hasAudio: true });
      for (const result of await Promise.all(jobs)) if (!(result instanceof Error)) await retire(result);
    }
  });

  it("starts the next source probe only after the first finishes", async () => {
    const root = await temp.create("audio-probe-order-"); let release!: (value: { hasAudio: boolean }) => void;
    controls.probe.mockImplementationOnce(() => new Promise(done => { release = done; })).mockResolvedValue({ hasAudio: true });
    const job = stageNativeAudioPreview(fixture(root), options(root));
    try {
      await vi.waitFor(() => expect(controls.probe).toHaveBeenCalledTimes(1));
      await new Promise(done => setImmediate(done)); expect(controls.probe).toHaveBeenCalledTimes(1);
    } finally { release({ hasAudio: true }); await retire(await job); }
    expect(controls.probe).toHaveBeenCalledTimes(2);
  });

  it("keeps the original ordinary probe failure and starts no sibling decoder or probe", async () => {
    const root = await temp.create("audio-probe-failure-"), error = Error("original probe failure"); controls.probe.mockRejectedValue(error);
    await expect(stageNativeAudioPreview(fixture(root), options(root))).rejects.toBe(error);
    expect(controls.probe).toHaveBeenCalledTimes(1); expect(controls.run).not.toHaveBeenCalled();
    expect(await readdir(join(root, "audio-preview"))).toEqual([]);
  });

  it("keeps the pending probe and its reservation until the physical close acknowledgement", async () => {
    const root = await temp.create("audio-probe-pending-"); let close!: () => void;
    const error = new PendingNativeCloseError("pending source probe", new Promise<void>(done => { close = done; }), Error("pipe"));
    controls.probe.mockRejectedValue(error);
    try {
      await expect(stageNativeAudioPreview(fixture(root), options(root))).rejects.toBe(error);
      expect(nativeAudioStageWorkSnapshotV1()).toMatchObject({ active: 1, pendingClose: 1 });
      expect(await readdir(join(root, "audio-preview"))).toHaveLength(1); expect(controls.probe).toHaveBeenCalledTimes(1);
    } finally { close(); await vi.waitFor(() => expect(nativeAudioStageWorkSnapshotV1().active).toBe(0)); }
    expect(await readdir(join(root, "audio-preview"))).toEqual([]); expect(controls.run).not.toHaveBeenCalled();
  });

  it("accepts eight decoded sources among nine candidates when one source is silent", async () => {
    const root = await temp.create("audio-probe-silent-"); controls.probe.mockImplementation(async path => ({ hasAudio: !String(path).endsWith("source-8.wav") }));
    const stage = await stageNativeAudioPreview(fixture(root, 9), options(root));
    try { expect(stage.clipCount).toBe(8); expect(stage.managedPaths).toHaveLength(9); expect(controls.probe).toHaveBeenCalledTimes(9); expect(controls.run).toHaveBeenCalledTimes(8); }
    finally { await retire(stage); }
  });

  it("retains the eight-decoded-source refusal without decoding or leaving a session", async () => {
    const root = await temp.create("audio-probe-limit-");
    await expect(stageNativeAudioPreview(fixture(root, 9), options(root))).rejects.toThrow("最多 8 個重疊來源");
    expect(controls.probe).toHaveBeenCalledTimes(9); expect(controls.run).not.toHaveBeenCalled();
    expect(await readdir(join(root, "audio-preview"))).toEqual([]);
  });

  it("refuses an oversized managed-path bound before allocating any session", async () => {
    const root = await temp.create("audio-probe-path-bound-");
    await expect(withNativeAudioStageWorkV1(root, 10, async () => undefined)).rejects.toThrow("NATIVE_AUDIO_MANAGED_PATH_BOUND_INVALID");
    expect(await readdir(root)).toEqual([]); expect(controls.probe).not.toHaveBeenCalled();
  });
});

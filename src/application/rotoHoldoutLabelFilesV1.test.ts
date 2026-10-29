import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as io from "./rotoHoldoutIoV1";
import { makeRotoHoldoutFixtureV1 } from "./__fixtures__/rotoHoldoutLabelKitV1.fixture";
import { createRotoHoldoutLabelKitV1 } from "./rotoHoldoutLabelFilesV1";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "editkin-holdout-export-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-holdout-export-") || (await realpath(root)).toLowerCase() !== resolve(root).toLowerCase()) throw Error("Fixture cleanup boundary");
  await rm(root, { recursive: true, force: true });
});
describe("export accounting is independent of optional observation", () => {
  it.each([false, true])("accounts for every exported frame with callback=%s", async observed => {
    const f = await makeRotoHoldoutFixtureV1(join(root, "fixture")), calls: number[] = [];
    vi.spyOn(io, "rotoHoldoutProcessV1").mockImplementation(async (_path, args) => {
      if (args.includes("-show_streams")) return { stdout: Buffer.from(JSON.stringify({ format: { duration: "1" }, streams: [{ index: 2, codec_type: "video", width: 16, height: 16, sample_aspect_ratio: "1:1" }] })), stderr: "" };
      expect(args[args.indexOf("-map") + 1]).toBe("0:2");
      return { stdout: await readFile(join(f.root, f.kit.clips[0].samples[0].framePath)), stderr: "" };
    });
    const request = { schema: "editkin.roto-holdout-label-request/v1", datasetId: "export-instrument", candidate: f.kit.candidate,
      clips: [{ id: "clip-a", sourcePath: f.kit.clips[0].source.path, sourceSha256: f.kit.clips[0].source.sha256,
        sourceStart: 0, duration: 1, analysisFps: 5, categories: ["hair-fur"] }] };
    // The request describes raw artifact IDs/hashes; derived bytes/composite digest are not client fields.
    const input = { ...request, candidate: { engine: f.kit.candidate.engine, artifacts: f.kit.candidate.artifacts.map(({ id, path, sha256 }) => ({ id, path, sha256 })) } };
    const result = await createRotoHoldoutLabelKitV1(input, join(root, "output"), {
      ffmpegPath: f.kit.candidate.artifacts[0].path, ffprobePath: f.kit.clips[0].source.path,
      ...(observed ? { onProgress: (p: { completed: number }) => calls.push(p.completed) } : {}) });
    const kit = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(result.frames).toBe(5); expect(kit.clips[0].samples).toHaveLength(5);
    expect(calls).toEqual(observed ? [1, 2, 3, 4, 5] : []);
    expect(result.qualityAcceptanceReady).toBe(false);
  });
});

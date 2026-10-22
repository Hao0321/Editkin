import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
const temp = useTempRoots();
const observation = vi.hoisted(() => ({
  target: "", generation: 0, created: 0, closed: 0, bytesRead: 0,
  onFirstOpen: undefined as undefined | (() => void),
  onFirstClose: undefined as undefined | (() => void),
}));
// Every stream is a real fs ReadStream. Hooks observe actual open/close events;
// no read bytes, digests, process results, or success counters are synthesized.
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, createReadStream: (...args: Parameters<typeof real.createReadStream>) => {
    const stream = real.createReadStream(...args);
    if (String(args[0]) === observation.target) {
      const ordinal = ++observation.created, generation = observation.generation;
      stream.once("open", () => { if (generation === observation.generation && ordinal === 1) observation.onFirstOpen?.(); });
      stream.once("close", () => {
        if (generation !== observation.generation) return;
        observation.closed++; observation.bytesRead += stream.bytesRead;
        if (ordinal === 1) observation.onFirstClose?.();
      });
    }
    return stream;
  } };
});
beforeEach(() => { observation.generation++; Object.assign(observation, { target: "", created: 0, closed: 0, bytesRead: 0, onFirstOpen: undefined, onFirstClose: undefined }); });
async function file() {
  const root = await temp.create("color-hash-"), path = join(root, "source.bin"), bytes = Buffer.alloc(131073, 41);
  await writeFile(path, bytes); observation.target = path;
  return { root, path, bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}
it("ordinary real-file hashing preserves SHA and returns after real stream close", async () => {
  const f = await file(); expect(await colorFileSha(f.path)).toBe(f.sha);
  expect(observation.created).toBe(1); expect(observation.closed).toBe(1); expect(observation.bytesRead).toBe(f.bytes.length);
});
it("pre-aborted source hash allocates no stream", async () => {
  const f = await file(), abort = new AbortController(); abort.abort();
  await expect(colorFileSha(f.path, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(observation.created).toBe(0);
});
it("cancellation after actual open rejects only after close acknowledgement", async () => {
  const f = await file(), abort = new AbortController(); observation.onFirstOpen = () => abort.abort();
  await expect(colorFileSha(f.path, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(observation.created).toBe(1); expect(observation.closed).toBe(1);
  expect(observation.bytesRead).toBeLessThan(f.bytes.length);
});
it("a cancellation at the close boundary cannot return a success digest", async () => {
  const f = await file(), abort = new AbortController(); observation.onFirstClose = () => abort.abort();
  await expect(colorFileSha(f.path, abort.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(observation.closed).toBe(1);
});
it("cancelling one independent source hash leaves a live peer intact", async () => {
  const f = await file(), abort = new AbortController(); let opened!: () => void;
  const isOpen = new Promise<void>(done => { opened = done; }); observation.onFirstOpen = opened;
  const first = colorFileSha(f.path, abort.signal); void first.catch(() => undefined); await isOpen;
  const peer = colorFileSha(f.path); abort.abort();
  const results = await Promise.allSettled([first, peer]);
  expect(results[0].status).toBe("rejected"); expect(results[1]).toEqual({ status: "fulfilled", value: f.sha });
  expect(observation.created).toBe(2); expect(observation.closed).toBe(2);
});
it("runtime identity cancellation is not downgraded to an unmeasured receipt", async () => {
  const f = await file(), abort = new AbortController(); observation.onFirstOpen = () => abort.abort();
  await expect(getMaterialColorRuntimeIdentity({ ffmpegPath: f.path, ffprobePath: f.path, signal: abort.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(observation.closed).toBe(1);
});
it("pre-aborted runtime identity performs no source/tool hash work", async () => {
  const f = await file(), abort = new AbortController(); abort.abort();
  await expect(getMaterialColorRuntimeIdentity({ ffmpegPath: f.path, ffprobePath: f.path, signal: abort.signal }))
    .rejects.toMatchObject({ name: "AbortError" }); expect(observation.created).toBe(0);
});
it("ordinary unsupported runtime remains explicitly unmeasured", async () => {
  const result = await getMaterialColorRuntimeIdentity({ ffmpegPath: "not-absolute" });
  expect(result.status).toBe("unmeasured"); expect(result.reason).toBe("absolute-tool-path-required");
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { renderSourcePreservingProjectV1, type SourcePreservingRuntimeV1 } from "./sourcePreservingExportV1";
import { sourcePreservingFixtureV1, sourcePreservingProbeFixtureV1 } from "./sourcePreservingV1.fixture";
import type { runProcess } from "./mediaProcess";
const roots: string[] = [], sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) { if ((await realpath(root)) !== resolve(root)) throw Error("TEST_ROOT_CHANGED"); await rm(root, { recursive: true }); } });
async function fixture() {
  const root = await mkdtemp(join(process.env.TEMP ?? tmpdir(), "owned-source-copy-control-")); roots.push(root);
  const source = join(root, "source.mp4"), output = join(root, "out.mp4"), bytes = Buffer.alloc(2 * 1024 ** 2 + 17, 77); await writeFile(source, bytes);
  const project = sourcePreservingFixtureV1(source), runtime: SourcePreservingRuntimeV1 = { assetBase: root, ffmpegPath: join(root, "ffmpeg"), ffprobePath: join(root, "ffprobe"),
    expectedSourceSha256: sha(bytes), policy: "preserve_original_container", timeoutMs: 15_000 };
  const run = vi.fn(async (...[exe]: Parameters<typeof runProcess>) => exe === runtime.ffprobePath ? { stdout: JSON.stringify(sourcePreservingProbeFixtureV1()), stderr: "" } : { stdout: "frame=60\nprogress=end\n", stderr: "" });
  const volumeProbe = vi.fn(async (path: string) => ({ key: path.toLowerCase().startsWith("c:") ? "C" : "D", root: path, availableBytes: 80 * 1024 ** 3 }));
  return { root, source, output, bytes, project, runtime, run, volumeProbe };
}
describe("pinned-handle source copy lifecycle; mocked probes do not certify real media", () => {
  it("copies exact bytes, awaits bounded writes, create-only publishes and cleans owned metadata", async () => {
    const f = await fixture(), before = JSON.stringify(f.project);
    const result = await renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: f.run, volumeProbe: f.volumeProbe });
    expect((await readFile(f.output)).equals(f.bytes)).toBe(true); expect((await readFile(f.source)).equals(f.bytes)).toBe(true);
    expect(result.outputSha256).toBe(sha(f.bytes)); expect(result.mediaStagingBytes).toBe(0); expect(result.maximumCopyChunkBytes).toBe(1024 ** 2);
    expect(result.decodedVideoFrames).toBe(60); expect(result.pixelOrAudioEncodingPasses).toBe(0);
    expect(JSON.stringify(f.project)).toBe(before); expect((await readdir(f.root)).sort()).toEqual(["out.mp4", "source.mp4"]);
  });
  it("existing output/aliases/source fingerprint mismatch preserve originals and refuse publication", async () => {
    const f = await fixture(); await writeFile(f.output, "OLD_OUTPUT");
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow("OUTPUT_EXISTS");
    expect(await readFile(f.output, "utf8")).toBe("OLD_OUTPUT");
    await expect(renderSourcePreservingProjectV1(f.project, f.source, f.runtime, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow("ALIAS_INVALID");
    await expect(renderSourcePreservingProjectV1(f.project, join(f.root, "mismatch.mp4"), { ...f.runtime, expectedSourceSha256: "0".repeat(64) }, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow("SOURCE_SHA_MISMATCH");
    expect((await readFile(f.source)).equals(f.bytes)).toBe(true); expect((await readdir(f.root)).sort()).toEqual(["out.mp4", "source.mp4"]);
  });
  it("unknown and dynamically short volume stop before publication", async () => {
    const f = await fixture();
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: f.run, volumeProbe: async () => undefined })).rejects.toThrow("SPACE_UNKNOWN");
    let probes = 0;
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: f.run, volumeProbe: async path => ({ key: path.startsWith("C:") ? "C" : "D", root: path, availableBytes: ++probes > 2 ? 0 : 80 * 1024 ** 3 }) })).rejects.toThrow("SPACE_SHORT");
    expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
  });
  it("mid-copy cancellation and project changes cannot publish a partial file", async () => {
    const f = await fixture(), controller = new AbortController();
    await expect(renderSourcePreservingProjectV1(f.project, f.output, { ...f.runtime, signal: controller.signal,
      onCopyProgress: () => controller.abort(Error("CONTROL_CANCEL")) }, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow("CONTROL_CANCEL");
    let changed = false;
    await expect(renderSourcePreservingProjectV1(f.project, f.output, { ...f.runtime, withPublicationGuard: async operation => {
      f.project.tracks[0].clips[0].color.exposure = .2; changed = true; return operation(); } }, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow("PROJECT_CHANGED");
    expect(changed).toBe(true); expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
  });
  it("an actual concurrent source writer, changed candidate or missing decode receipt refuse publication", async () => {
    const f = await fixture();
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: async (exe, ...args) => {
      if (exe === f.runtime.ffmpegPath) await writeFile(f.source, Buffer.alloc(f.bytes.length, 78)); return f.run(exe, ...args);
    }, volumeProbe: f.volumeProbe })).rejects.toThrow("SOURCE_CHANGED");
    await writeFile(f.source, f.bytes);
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: async (exe, args, ...rest) => {
      if (exe === f.runtime.ffmpegPath) await writeFile(args[args.indexOf("-i") + 1], "CANDIDATE_CHANGED"); return f.run(exe, args, ...rest);
    }, volumeProbe: f.volumeProbe })).rejects.toThrow("CANDIDATE_CHANGED");
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: async (exe, ...args) =>
      exe === f.runtime.ffmpegPath ? { stdout: "frame=60\n", stderr: "" } : f.run(exe, ...args), volumeProbe: f.volumeProbe })).rejects.toThrow("DECODE_FRAME_COUNT_MISSING");
    expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
  });
  it("decoder failure and racing output creation retain that output and remove only owned candidate", async () => {
    const f = await fixture();
    await expect(renderSourcePreservingProjectV1(f.project, f.output, f.runtime, { run: async (exe, ...args) => {
      if (exe === f.runtime.ffmpegPath) throw Error("CONTROL_BROKEN_DECODE"); return f.run(exe, ...args); }, volumeProbe: f.volumeProbe })).rejects.toThrow("CONTROL_BROKEN_DECODE");
    await expect(renderSourcePreservingProjectV1(f.project, f.output, { ...f.runtime, withPublicationGuard: async operation => {
      await writeFile(f.output, "RACING_OUTPUT", { flag: "wx" }); return operation(); } }, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow();
    expect(await readFile(f.output, "utf8")).toBe("RACING_OUTPUT"); expect((await readFile(f.source)).equals(f.bytes)).toBe(true);
    expect((await readdir(f.root)).sort()).toEqual(["out.mp4", "source.mp4"]);
  });
  it("rebinds candidate bytes after waiting for publication lease; same-size late writes cannot publish", async () => {
    const f = await fixture();
    await expect(renderSourcePreservingProjectV1(f.project, f.output, { ...f.runtime, withPublicationGuard: async operation => {
      const names = await readdir(f.root), name = names.find(n => n.endsWith(".source-preserving.part.mp4"))!;
      expect(name).toBeTruthy(); await writeFile(join(f.root, name), Buffer.alloc(f.bytes.length, 79)); return operation();
    } }, { run: f.run, volumeProbe: f.volumeProbe })).rejects.toThrow("CANDIDATE_CHANGED");
    expect((await readFile(f.source)).equals(f.bytes)).toBe(true); expect((await readdir(f.root)).sort()).toEqual(["source.mp4"]);
  });
});

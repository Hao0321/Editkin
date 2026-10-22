import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLongformAudioMasterV1 } from "./longformAudioMasterV1";

// Media calls are controlled. File hashing, disk checks, lifetime, reservation/publication and cleanup are real.
const controls = vi.hoisted(() => ({ run: vi.fn(), mode: "ok", controller: undefined as AbortController | undefined }));
vi.mock("../application/analysisProcess", () => ({ runAnalysisProcess: controls.run }));
const roots: string[] = [];
const stats = { input_i: "-22.10", input_tp: "-10.20", input_lra: "4.30", input_thresh: "-32.10",
  output_i: "-14.00", output_tp: "-2.10", output_lra: "4.30", output_thresh: "-24.00", normalization_type: "linear", target_offset: "0.03" };
beforeEach(() => {
  vi.clearAllMocks(); controls.mode = "ok"; controls.controller = undefined;
  controls.run.mockImplementation(async (executable: string, args: string[], options: { signal?: AbortSignal }) => {
    options.signal?.throwIfAborted(); const candidate = args.at(-1)!;
    if (basename(executable) === "ffprobe.exe") {
      const output = candidate.endsWith(".master.wav"), samples = controls.mode === "sample-drift" && output ? 144001 : 144000;
      return { stdout: Buffer.from(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: output ? "pcm_s24le" : "pcm_f32le",
        sample_rate: "48000", channels: 2, time_base: "1/48000", duration_ts: samples }], format: { duration: String(samples / 48000) } })), stderr: "" };
    }
    const filter = args[args.indexOf("-af") + 1];
    if (filter.startsWith("ebur128=")) return { stdout: Buffer.alloc(0), stderr:
      `Summary:\n Integrated loudness:\n I: ${controls.mode === "wrong-loudness" ? "-13.9" : "-14.0"} LUFS\n Threshold: -24.0 LUFS\n\n Loudness range:\n LRA: 4.3 LU\n\n True peak:\n Peak: -2.1 dBFS` };
    const secondPass = filter.includes("measured_I=");
    if (secondPass) {
      await writeFile(candidate, "controlled PCM output");
      if (controls.mode === "abort-encode") { controls.controller!.abort(new Error("owned cancellation")); options.signal?.throwIfAborted(); }
    } else if (controls.mode === "source-drift") {
      const input = args[args.indexOf("-i") + 1]; await writeFile(input, "changed controlled source");
    }
    return { stdout: Buffer.alloc(0), stderr: JSON.stringify({ ...stats,
      input_i: controls.mode === "silent" && !secondPass ? "-inf" : stats.input_i }) + (secondPass ? "" :
      "\nSummary:\n Integrated loudness:\n I: -14.0 LUFS\n Threshold: -24.0 LUFS\n\n Loudness range:\n LRA: 4.3 LU\n\n True peak:\n Peak: -2.1 dBFS") };
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("editkin-longform-master-") || (await lstat(root)).isSymbolicLink()) {
      throw new Error("Owned mastering fixture escaped temp root");
    }
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-longform-master-")); roots.push(root);
  const paths = { inputPath: join(root, "source.wav"), outputPath: join(root, "master.wav"),
    ffmpegPath: join(root, "ffmpeg.exe"), ffprobePath: join(root, "ffprobe.exe") };
  for (const [key, path] of Object.entries(paths)) await writeFile(path, key === "outputPath" ? "previous master" : "controlled " + key);
  return { root, paths };
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("longform audio file backend (controlled media)", () => {
  it("derives both passes from actual runner diagnostics, measures the candidate and publishes only after verification", async () => {
    const { root, paths } = await fixture(), original = await readFile(paths.inputPath);
    const result = await renderLongformAudioMasterV1(paths);
    expect(controls.run).toHaveBeenCalledTimes(5);
    const filters = controls.run.mock.calls.map(([, args]) => args[args.indexOf("-af") + 1]).filter(value => typeof value === "string");
    expect(filters.some(filter => filter.startsWith("loudnorm=I=-14:LRA=11:TP=-1.5:print_format=json,aresample=48000")
      && filter.includes("ebur128=framelog=verbose:peak=true"))).toBe(true);
    expect(filters.some(filter => filter.includes("measured_I=-22.1:measured_TP=-10.2") && filter.includes("offset=0.03:linear=true"))).toBe(true);
    expect(result.sourceIdentity.sha256).toBe(sha(original)); expect(await readFile(paths.inputPath)).toEqual(original);
    expect(result.outputProbe.samples).toBe(result.sourceProbe.samples); expect(result.ebur128.integratedLufs).toBe(-14);
    expect(result.finalVideoMuxVerified).toBe(false); expect(result.subtitleAsrSyncVerified).toBe(false);
    expect(await readFile(paths.outputPath, "utf8")).toBe("controlled PCM output");
    expect((await readdir(root)).sort()).toEqual(["ffmpeg.exe", "ffprobe.exe", "master.wav", "source.wav"]);
  });
  it.each(["silent", "source-drift", "sample-drift", "abort-encode", "wrong-loudness"])(
    "preserves the previous output and removes only its candidate for %s", async mode => {
      const { root, paths } = await fixture(); controls.mode = mode; controls.controller = new AbortController();
      await expect(renderLongformAudioMasterV1({ ...paths, signal: controls.controller.signal })).rejects.toThrow();
      expect(await readFile(paths.outputPath, "utf8")).toBe("previous master");
      expect((await readdir(root)).some(name => name.endsWith(".master.wav"))).toBe(false);
      if (mode === "silent") expect(controls.run.mock.calls.filter(([, args]) => args.includes("-c:a"))).toEqual([]);
    });
});

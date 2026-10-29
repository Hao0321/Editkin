import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { LongformWordTimingRequestV1 } from "../domain/longformWordTimingV1";
import { PINNED_WHISPER_MODEL } from "./automaticCaptions";
import { resolveLongformWhisperPromptV1 } from "./longformWhisperPromptV1";
import { prepareLongformWordRecognitionV1, readLongformWordArtifactV1, readLongformWordPageV1,
  type LongformWordRecognitionDepsV1, type LongformWordRecognitionRuntimeV1 } from "./longformWordRecognitionV1";
const owned: string[] = [];
afterEach(async () => { for (const root of owned.splice(0)) {
  const inside = relative(tmpdir(), root); assert(inside && !inside.startsWith("..") && !isAbsolute(inside));
  await rm(root, { recursive: true });
} });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "longword-prompt-")); owned.push(root);
  await writeFile(join(root, "voice.wav"), "preserved voice");
  const request: LongformWordTimingRequestV1 = { schema: "editkin.longform-word-timing-request/v1",
    narration: { id: "voice", path: "voice.wav", sourceStart: 0, duration: 2 }, script: { kind: "text", text: "Alpha Beta" },
    recordings: [], screenshots: [], language: "en" };
  const runtime: LongformWordRecognitionRuntimeV1 = { sourceRoot: root, cacheRoot: join(root, "cache"), workRoot: join(root, "work"),
    ffmpegPath: join(root, "ffmpeg.exe"), whisperCliPath: join(root, "whisper.exe"), modelPath: join(root, "model.bin"), modelRoot: root,
    probe: async () => ({ duration: 2, hasAudio: true, hasVideo: false }) };
  const calls: Array<{ exe: string; args: string[] }> = []; let modelChecks = 0;
  const deps: LongformWordRecognitionDepsV1 = {
    inspectModel: async () => { modelChecks++; return { valid: true, bytes: PINNED_WHISPER_MODEL.bytes, sha256: PINNED_WHISPER_MODEL.sha256 }; },
    runtimeIdentity: async () => "a".repeat(64),
    run: async (exe, args, options) => {
      options.signal?.throwIfAborted(); calls.push({ exe, args: [...args] });
      if (args[0] === "--help") return { stdout: Buffer.from("--output-json-full\n--prompt PROMPT"), stderr: "" };
      if (exe === runtime.ffmpegPath) await writeFile(args.at(-1)!, "owned PCM");
      else {
        const prefix = args[args.indexOf("-of") + 1], text = args[args.indexOf("--prompt") + 1]?.includes("Beta") ? "Beta" : "Alpha";
        await writeFile(prefix + ".json", JSON.stringify({ transcription: [{ text, offsets: { from: 0, to: 2000 },
          tokens: [{ text, id: 1, p: 0.9, offsets: { from: 100, to: 900 } }] }] }));
      }
      return { stdout: Buffer.alloc(0), stderr: "" };
    },
  };
  return { root, request, runtime, deps, calls, get modelChecks() { return modelChecks; },
    recognitions: () => calls.filter(row => row.args.includes("-ojf")) };
}
it("wires the resolved context as one literal CLI argument and records its actual identity", async () => {
  const f = await fixture(); f.request.initialPrompt = "--model 'quoted' $() 你好🙂";
  const result = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps), call = f.recognitions()[0];
  const at = call.args.indexOf("--prompt"); expect(at).toBeGreaterThan(0); expect(call.args[at + 1]).toBe(f.request.initialPrompt);
  expect(call.args.filter(value => value === "--prompt")).toHaveLength(1);
  expect(call.args).not.toContain("--carry-initial-prompt");
  expect(result.artifact.recognizer.prompt).toEqual(resolveLongformWhisperPromptV1("en", f.request.initialPrompt));
  expect(result.artifact.recognizer.modelId).toBe(PINNED_WHISPER_MODEL.id);
});
it("adds the canonical Chinese vocabulary with the existing small model while English defaults retain their CLI shape", async () => {
  const f = await fixture(); f.request.language = "zh";
  const result = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  expect(f.recognitions()[0].args).toContain("--prompt");
  expect(result.artifact.recognizer.prompt).toEqual(resolveLongformWhisperPromptV1("zh"));
  expect(result.artifact.recognizer.modelSha256).toBe(PINNED_WHISPER_MODEL.sha256);
  f.request.language = "en"; const english = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  expect(f.recognitions()[1].args).not.toContain("--prompt"); expect(english.artifact.recognizer.prompt?.text).toBe("");
});
it("isolates changed prompts in window and artifact identities, reuses the exact same prompt, and preserves prior raw evidence", async () => {
  const f = await fixture(); f.request.initialPrompt = "Alpha";
  const first = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  const windowRoot = join(f.runtime.cacheRoot, "longform-word-timing-v1/windows");
  const before = await Promise.all((await readdir(windowRoot)).sort().map(async name => ({ name, sha256: hash(await readFile(join(windowRoot, name))) })));
  f.request.initialPrompt = "Beta"; const second = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  expect(second.cachedWindows).toBe(0); expect(second.artifact.artifactId).not.toBe(first.artifact.artifactId);
  expect(second.artifact.windows[0].key).not.toBe(first.artifact.windows[0].key);
  expect((await readLongformWordPageV1(f.runtime, first.artifact.artifactId)).words[0].text).toBe("Alpha");
  expect((await readLongformWordPageV1(f.runtime, second.artifact.artifactId)).words[0].text).toBe("Beta");
  f.request.initialPrompt = "Alpha"; const reused = await prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps);
  expect(reused.cachedWindows).toBe(1); expect(reused.artifact).toEqual(first.artifact); expect(f.recognitions()).toHaveLength(2);
  for (const row of before) expect(hash(await readFile(join(windowRoot, row.name)))).toBe(row.sha256);
  expect(await readLongformWordArtifactV1(f.runtime, first.artifact.artifactId)).toEqual(first.artifact);
});
it("refuses a runtime without the prompt capability before extracting audio or creating a cache", async () => {
  const f = await fixture(); f.request.language = "zh"; const run = f.deps.run;
  f.deps.run = async (exe, args, options) => args[0] === "--help"
    ? { stdout: Buffer.from("--output-json-full\n--carry-initial-prompt\n--prompting TEXT"), stderr: "" } : run(exe, args, options);
  await expect(prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps)).rejects.toThrow("RUNTIME_PROMPT_MISSING");
  expect(f.recognitions()).toEqual([]); expect(f.calls).toEqual([]);
  await expect(stat(f.runtime.cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects invalid or over-budget resolved prompts before model inspection or child processes", async () => {
  const f = await fixture();
  for (const initialPrompt of ["a".repeat(225), "bad\0text", "bad\ud800text"]) {
    f.request.initialPrompt = initialPrompt;
    await expect(prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps)).rejects.toThrow("WORD_TIMING_PROMPT");
  }
  expect(f.modelChecks).toBe(0); expect(f.calls).toEqual([]);
  await expect(stat(f.runtime.cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains source revalidation and cancellation when a vocabulary prompt is present", async () => {
  for (const mode of ["source-change", "cancel"] as const) {
    const f = await fixture(); f.request.language = "zh"; const run = f.deps.run, stop = new AbortController();
    f.runtime.signal = stop.signal;
    f.deps.run = async (exe, args, options) => {
      if (args.includes("-ojf")) {
        expect(args[args.indexOf("--prompt") + 1]).toBe(resolveLongformWhisperPromptV1("zh").text);
        if (mode === "cancel") { stop.abort(); stop.signal.throwIfAborted(); }
        const result = await run(exe, args, options); await writeFile(join(f.root, "voice.wav"), "changed voice"); return result;
      }
      return run(exe, args, options);
    };
    if (mode === "cancel") await expect(prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps)).rejects.toMatchObject({ name: "AbortError" });
    else await expect(prepareLongformWordRecognitionV1(f.request, f.runtime, f.deps)).rejects.toThrow("LONGFORM_SOURCE_CHANGED");
    expect(await readdir(join(f.runtime.cacheRoot, "longform-word-timing-v1/artifacts"))).toEqual([]);
    expect(await readdir(f.runtime.workRoot)).toEqual([]);
    expect(await readFile(join(f.root, "voice.wav"), "utf8")).toBe(mode === "cancel" ? "preserved voice" : "changed voice");
  }
});

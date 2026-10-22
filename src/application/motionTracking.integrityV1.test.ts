import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMotionTrack } from "./motionTracking";
import { runAnalysisProcess } from "./analysisProcess";
import { withRenderLifetime } from "../render/renderLifetime";
vi.mock("./analysisProcess", () => ({ runAnalysisProcess: vi.fn() }));
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex"), digest = (v: unknown) => hash(JSON.stringify(v));
let root: string, request: Parameters<typeof analyzeMotionTrack>[0], runtime: Parameters<typeof analyzeMotionTrack>[1], mode: string, closed: boolean, started: Promise<void>, start: () => void;
const calls = () => vi.mocked(runAnalysisProcess).mock.calls;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-tracking-integrity-unit-"));
  const sourcePath = join(root, "source.mp4"), ffmpegPath = join(root, "fixture-decoder.exe"), nativeCorePath = join(root, "fixture-core.exe");
  await writeFile(sourcePath, "UNIT SOURCE BYTES; NOT ACTUAL VIDEO"); await writeFile(ffmpegPath, "UNIT TOOL BYTES; NEVER EXECUTED"); await writeFile(nativeCorePath, "UNIT CORE BYTES; NEVER EXECUTED");
  request = { sourcePath, sourceStart: 0, duration: 1.5, fps: 12, sourceWidth: 128, sourceHeight: 96, initialTime: .5, initialRect: { x: .2, y: .2, width: .4, height: .4 } };
  runtime = { ffmpegPath, nativeCorePath, cacheRoot: join(root, "cache"), workRoot: join(root, "work") }; mode = "normal"; closed = false;
  started = new Promise<void>(resolve => { start = resolve; }); vi.mocked(runAnalysisProcess).mockReset();
  vi.mocked(runAnalysisProcess).mockImplementation(async (exe, args, options) => {
    if (mode === "hold-decoder" && exe === ffmpegPath || mode === "hold-native" && exe === nativeCorePath) {
      start(); return new Promise((_resolve, reject) => { options.signal!.addEventListener("abort", () => setTimeout(() => { closed = true; reject(Object.assign(new Error("simulated process closed after cancellation"), { name: "AbortError" })); }, 10), { once: true }); });
    }
    if (exe === ffmpegPath) {
      await writeFile(args.at(-1)!, Buffer.alloc(128 * 96 * 18));
      if (mode === "source-after-decode") await writeFile(sourcePath, "CHANGED AFTER DECODER");
      if (mode === "core-after-decode") await writeFile(nativeCorePath, "CHANGED CORE");
      if (mode === "decoder-after-decode") await writeFile(ffmpegPath, "CHANGED DECODER");
      return { stdout: Buffer.alloc(0), stderr: "" };
    }
    const input = JSON.parse(await readFile(args[1], "utf8")), r = input.initialRect;
    const plan = { engine: "hao-core-rust-motion-track-0.4-planar", analysisFps: 12, width: 128, height: 96, lostRatio: 0,
      points: Array.from({ length: 18 }, (_, i) => ({ frame: i, time: i / 12, rect: r, confidence: .8, status: i === 6 ? "manual" : "tracked", activity: .2,
        rotationDegrees: 0, scale: 1, quad: [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }] })) };
    if (mode === "invalid-native-clock") plan.points[1].frame = 99;
    if (mode === "source-after-native") await writeFile(sourcePath, "CHANGED AFTER NATIVE");
    return { stdout: Buffer.from(mode === "invalid-native-json" ? "{" : JSON.stringify(plan)), stderr: "" };
  });
});
afterEach(async () => { await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "motionTracking.integrityV1.test.ts", root, testsTerminal: true }), { flag: "wx" }); console.log("TRACKING_INTEGRITY_OWNED_UNIT=" + root); });
async function sourceSha() { return hash(await readFile(request.sourcePath)); }
async function cacheFile() { return join(runtime.cacheRoot!, "motion-tracking", (await readdir(join(runtime.cacheRoot!, "motion-tracking")))[0]); }
async function noRawWorkspace() { expect(await readdir(runtime.workRoot!)).toEqual([]); }
describe("existing motion tracking analysis integrity and lifetime", () => {
  it("keeps the public result shape, migrates cache and warm-reuses metadata mode without claiming source SHA", async () => {
    const first = await analyzeMotionTrack(request, runtime), before = calls().length, second = await analyzeMotionTrack(request, runtime);
    expect(first.cacheHit).toBe(false); expect(second.cacheHit).toBe(true); expect(second.points).toEqual(first.points); expect(calls()).toHaveLength(before);
    expect(Object.keys(first).sort()).toEqual(["engine", "analysisFps", "width", "height", "lostRatio", "points", "analyzedSeconds", "elapsedMs", "cacheHit"].sort());
    const cache = JSON.parse(await readFile(await cacheFile(), "utf8")); expect(cache.schemaVersion).toBe(3); expect(cache.identity.sourceIdentityMode).toBe("metadata");
    expect(cache.identity.source.sha256).toBeUndefined(); expect(cache.identity.core.sha256).toHaveLength(64); expect(cache.identity.decoder.sha256).toHaveLength(64); await noRawWorkspace();
  });
  it("verifies the asserted source bytes, accepts uppercase SHA and returns an identical warm native result", async () => {
    request.sourceSha256 = await sourceSha(); const first = await analyzeMotionTrack(request, runtime), before = calls().length;
    const second = await analyzeMotionTrack({ ...request, sourceSha256: request.sourceSha256.toUpperCase() }, runtime);
    expect(second.cacheHit).toBe(true); expect(second.points).toEqual(first.points); expect(calls()).toHaveLength(before);
    const cache = JSON.parse(await readFile(await cacheFile(), "utf8")); expect(cache.identity.source.sha256).toBe(request.sourceSha256); expect(cache.identity.sourceIdentityMode).toBe("sha256");
  });
  it("rejects a false asserted SHA before cache or process admission", async () => {
    request.sourceSha256 = "f".repeat(64); await expect(analyzeMotionTrack(request, runtime)).rejects.toThrow("SOURCE_SHA_MISMATCH"); expect(calls()).toHaveLength(0); await expect(access(runtime.workRoot!)).rejects.toThrow();
  });
  it.each(["schema", "identity", "digest", "clock", "engine", "duration", "truncated"])("never admits a %s corrupted cache result", async kind => {
    request.sourceSha256 = await sourceSha(); const first = await analyzeMotionTrack(request, runtime), path = await cacheFile(), cache = JSON.parse(await readFile(path, "utf8"));
    if (kind === "schema") cache.schemaVersion = 2; if (kind === "identity") cache.identity.source.path = "another-source.mp4";
    if (kind === "digest") cache.result.points[0].rect.x = .21;
    if (kind === "clock") { cache.result.points[1].frame = 99; cache.resultSha256 = digest(cache.result); }
    if (kind === "engine") { cache.result.engine = "untrusted-engine"; cache.resultSha256 = digest(cache.result); }
    if (kind === "duration") { cache.result.analyzedSeconds = 2; cache.resultSha256 = digest(cache.result); }
    const corrupt = kind === "truncated" ? "{" : JSON.stringify(cache); await writeFile(join(root, "REJECTED-CACHE.json"), corrupt); await writeFile(path, corrupt);
    const before = calls().length, second = await analyzeMotionTrack(request, runtime); expect(second.cacheHit).toBe(false); expect(second.points).toEqual(first.points); expect(calls().length - before).toBe(2);
  });
  it("keeps metadata and asserted-SHA cache modes separate", async () => {
    const a = await analyzeMotionTrack(request, runtime), b = await analyzeMotionTrack({ ...request, sourceSha256: await sourceSha() }, runtime);
    expect(a.points).toEqual(b.points); expect(b.cacheHit).toBe(false); expect(await readdir(join(runtime.cacheRoot!, "motion-tracking"))).toHaveLength(2);
  });
  it.each(["source-after-decode", "core-after-decode", "decoder-after-decode"])("refuses %s before native execution", async change => {
    request.sourceSha256 = await sourceSha(); mode = change; await expect(analyzeMotionTrack(request, runtime)).rejects.toThrow("SOURCE_OR_TOOL_CHANGED");
    expect(calls().filter(c => c[0] === runtime.nativeCorePath)).toHaveLength(0); await noRawWorkspace();
  });
  it("checks metadata-only source changes too", async () => { mode = "source-after-decode"; await expect(analyzeMotionTrack(request, runtime)).rejects.toThrow("SOURCE_OR_TOOL_CHANGED"); await noRawWorkspace(); });
  it("refuses source changes after native output", async () => { request.sourceSha256 = await sourceSha(); mode = "source-after-native"; await expect(analyzeMotionTrack(request, runtime)).rejects.toThrow("SOURCE_OR_TOOL_CHANGED"); await noRawWorkspace(); });
  it.each(["invalid-native-json", "invalid-native-clock"])("does not cache %s", async bad => {
    mode = bad; await expect(analyzeMotionTrack(request, runtime)).rejects.toThrow(); await noRawWorkspace();
    await expect(access(join(runtime.cacheRoot!, "motion-tracking"))).rejects.toThrow();
  });
  it("captures source, nested rectangle, tool paths and signal before asynchronous work", async () => {
    const original = { ...request.initialRect }, originalCore = runtime.nativeCorePath, originalCache = runtime.cacheRoot!;
    const task = analyzeMotionTrack(request, runtime); request.sourcePath = "http://late.example/other"; request.initialRect.width = 0; runtime.nativeCorePath = "late-change.exe"; runtime.signal = AbortSignal.abort();
    const result = await task; expect(result.points[0].rect).toEqual(original); expect(calls().some(c => c[0] === originalCore)).toBe(true);
    expect(await readdir(join(originalCache, "motion-tracking"))).toHaveLength(1);
  });
  it("settles prior cancellation before I/O/process admission", async () => {
    await expect(analyzeMotionTrack(request, { ...runtime, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" }); expect(calls()).toHaveLength(0); await expect(access(runtime.workRoot!)).rejects.toThrow();
  });
  it.each(["hold-decoder", "hold-native"])("waits for the %s process adapter to close before rejecting cancellation", async stage => {
    mode = stage; const owner = new AbortController(), task = analyzeMotionTrack(request, { ...runtime, signal: owner.signal }); const rejected = task.catch(e => e);
    await started; owner.abort(); expect(closed).toBe(false); expect(await rejected).toMatchObject({ name: "AbortError" }); expect(closed).toBe(true); await noRawWorkspace();
  });
  it("uses one total deadline and still awaits process-close cleanup", async () => {
    mode = "hold-decoder"; const task = analyzeMotionTrack(request, { ...runtime, timeoutMs: 1000 }); const rejected = task.catch(e => e);
    await started; expect(await rejected).toMatchObject({ name: "TimeoutError" }); expect(closed).toBe(true); await noRawWorkspace();
  });
  it.each([0, 1.5, NaN, 14_400_001])("rejects invalid total timeout %s before process admission", async timeoutMs => {
    await expect(analyzeMotionTrack(request, { ...runtime, timeoutMs })).rejects.toThrow("TIMEOUT_INVALID"); expect(calls()).toHaveLength(0);
  });
  it("retains old sampling/source-shape refusals", async () => {
    await expect(analyzeMotionTrack({ ...request, sourceSha256: "wrong-format" }, runtime)).rejects.toThrow("SOURCE_SHA_INVALID");
    await expect(analyzeMotionTrack(request, { ...runtime, rawByteBudget: 1 })).rejects.toThrow("RAW_BUDGET_EXCEEDED"); expect(calls()).toHaveLength(0);
  });
  it("inherits an existing render cancellation and retains its reason after the process closes", async () => {
    mode = "hold-native"; const owner = new AbortController(), reason = new Error("PARENT_RENDER_CANCELLED_FIXTURE");
    const task = withRenderLifetime({ signal: owner.signal, timeoutMs: 5000 }, () => analyzeMotionTrack(request, { ...runtime, timeoutMs: 500 }));
    const rejected = task.catch(e => e); await started; owner.abort(reason); expect(await rejected).toBe(reason); expect(closed).toBe(true); await noRawWorkspace();
  });
  it("inherits an earlier render deadline instead of restarting it for tracking", async () => {
    mode = "hold-decoder"; const task = withRenderLifetime({ timeoutMs: 500 }, () => analyzeMotionTrack(request, { ...runtime, timeoutMs: 1000 }));
    const rejected = task.catch(e => e); await started; expect(String(await rejected)).toContain("影片輸出總時間逾時"); expect(closed).toBe(true); await noRawWorkspace();
  });
});

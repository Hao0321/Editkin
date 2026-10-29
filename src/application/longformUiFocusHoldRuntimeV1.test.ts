import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { colorBytesSha, colorDigest, runColorProcess } from "./materialColorSamplingRuntime";
import { uiFocusHoldFixtureV1 } from "./longformUiFocusHoldV1.fixture";
import { prepareLongformUiFocusHoldV1 } from "./longformUiFocusHoldRuntimeV1";

vi.mock("./materialColorSamplingRuntime", async original => ({
  ...await original<typeof import("./materialColorSamplingRuntime")>(),
  runColorProcess: vi.fn(),
  getMaterialColorRuntimeIdentity: async () => ({ schema: "editkin.material-color-runtime/v1", status: "verified",
    identitySha256: "a".repeat(64), tools: [], implementations: [] }),
}));
const temp = useTempRoots(), run = vi.mocked(runColorProcess); afterEach(() => run.mockReset());
async function fixture() {
  const root = await temp.create("uif-hold-runtime-", { parent: tmpdir() });
  expect(resolve(root).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  const source = join(root, "owned-protocol-source.mp4"), native = join(root, "owned-native-control.exe");
  await writeFile(source, "owned protocol media"); await writeFile(native, "owned protocol native");
  const f = uiFocusHoldFixtureV1({ sourceSha: colorBytesSha(await readFile(source)) });
  const runtime = { sourceRoot: root, workRoot: join(root, "work"), nativeCorePath: native,
    expectedNativeCoreSha256: colorBytesSha(await readFile(native)), ffmpegPath: join(root, "ffmpeg-control.exe"), ffprobePath: join(root, "ffprobe-control.exe") };
  run.mockImplementation(async (executable, args) => {
    if (executable === runtime.ffmpegPath) return { stdout: Buffer.from(f.pixels), stderr: f.log };
    expect(executable).toBe(native); expect(args[0]).toBe("motion-track");
    const request = JSON.parse(await readFile(args[1], "utf8"));
    expect(request.initialRect).toEqual(f.context); expect(request.maxHoldFrames).toBe(0); expect(request.frameCount).toBe(24);
    expect(colorBytesSha(await readFile(request.rawPath))).toBe(f.sequence.rawSha256);
    return { stdout: Buffer.from(JSON.stringify(f.plan)), stderr: "" };
  });
  return { ...f, root, source, native, runtime };
}
it("uses exact full-frame passthrough decode and a pinned native protocol; records current bytes and cleans only its helpers (processes mocked)", async () => {
  const f = await fixture(), before = await readFile(f.source);
  const result = await prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, f.runtime);
  expect(result.state).toBe("TRACKING_EVIDENCE_READY"); expect(result.provider.temporalResampling).toBe(false);
  const args = run.mock.calls[0][1], filters = args[args.indexOf("-vf") + 1];
  expect(filters).not.toMatch(/(?:^|,)fps=/); expect(args.slice(args.indexOf("-fps_mode"), args.indexOf("-fps_mode") + 2)).toEqual(["-fps_mode", "passthrough"]);
  expect(result.frames[0].sourceTime).toBe(.2); expect(result.frames).toHaveLength(24);
  const { receiptSha256, ...body } = result; expect(receiptSha256).toBe(colorDigest(body));
  expect(await readFile(f.source)).toEqual(before); expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it("blocks mismatched native/source identity before invoking either analyzer", async () => {
  const f = await fixture();
  await expect(prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, { ...f.runtime, expectedNativeCoreSha256: "c".repeat(64) })).rejects.toThrow("NATIVE_IDENTITY");
  await writeFile(f.source, "replacement source");
  await expect(prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, f.runtime)).rejects.toThrow("SOURCE_CHANGED");
  expect(run).not.toHaveBeenCalled();
});
it("isolates decoded sinks from pixel/clock authority and refuses an abort before helper publication", async () => {
  const f = await fixture();
  const result = await prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, { ...f.runtime, onDecoded: (sequence, pixels) => {
    sequence.frames[0].sourceTime = 999; pixels.fill(0);
  } });
  expect(result.state).toBe("TRACKING_EVIDENCE_READY"); expect(result.frames[0].sourceTime).toBe(.2);
  run.mockClear(); const controller = new AbortController();
  await expect(prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, { ...f.runtime, signal: controller.signal,
    onDecoded: () => { controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
  expect(run).toHaveBeenCalledTimes(1); expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it("rejects a media edit during native analysis and retains the changed fixture source rather than deleting it", async () => {
  const f = await fixture(), original = run.getMockImplementation()!;
  run.mockImplementation(async (executable, ...rest) => {
    const result = await original(executable, ...rest);
    if (executable === f.native) await writeFile(f.source, "changed during analysis");
    return result;
  });
  await expect(prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, f.runtime)).rejects.toThrow("SOURCE_OR_PROVIDER_CHANGED");
  expect(await readFile(f.source, "utf8")).toBe("changed during analysis"); expect(await readdir(f.runtime.workRoot)).toEqual([]);
});
it("keeps exact helper files until the owned native promise settles after cancellation (lifecycle protocol mocked)", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), done = Promise.withResolvers<{ stdout: Buffer; stderr: string }>(),
    controller = new AbortController(), original = run.getMockImplementation()!;
  run.mockImplementation(async (executable, ...rest) => {
    if (executable === f.native) { entered.resolve(); return done.promise; } return original(executable, ...rest);
  });
  let settled = false;
  const job = prepareLongformUiFocusHoldV1(f.source, f.draft, f.request, { ...f.runtime, signal: controller.signal })
    .then(value => { settled = true; return value; }, error => { settled = true; return error; });
  await entered.promise; controller.abort();
  expect(settled).toBe(false); const directories = await readdir(f.runtime.workRoot);
  expect(directories).toHaveLength(1); expect((await readdir(join(f.runtime.workRoot, directories[0]))).sort()).toEqual(["frames.gray", "request.json"]);
  done.reject(Error("analysis-cancelled")); expect(await job).toMatchObject({ message: "analysis-cancelled" });
  expect(settled).toBe(true); expect(await readdir(f.runtime.workRoot)).toEqual([]);
});

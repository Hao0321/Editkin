import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { createEmptyProject } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import type { MaterialIntelligencePacket } from "./materialIntelligence";
import type { MaterialColorReceipt } from "./materialColorSamplingTypes";
import { colorDigest } from "./materialColorSamplingRuntime";
import { readShotGradeWorkingFrameV1, readShotGradeWorkingSurfaceV1, type ShotGradeWorkingSourceV1 } from "./shotGradeFramesV1";
import { readShotGradeRenderedFrameV1, readShotGradeRenderedSurfaceV1 } from "./shotGradeRenderedFramesV1";

const io = vi.hoisted(() => ({ decode: vi.fn(), hash: vi.fn(), verify: vi.fn() }));
vi.mock("./autoColorFrame", async original => ({ ...await original<typeof import("./autoColorFrame")>(), readBoundMaterialColorFrameV1: io.decode }));
vi.mock("./materialColorSamplingRuntime", async original => ({ ...await original<typeof import("./materialColorSamplingRuntime")>(), colorFileSha: io.hash }));
vi.mock("./materialColorSamplingValidation", async original => ({ ...await original<typeof import("./materialColorSamplingValidation")>(), verifyMaterialColorReceipt: io.verify }));

// I/O/receipt validation doubles isolate ownership and alpha invariants here.
// Genuine receipts, the exact shared decoder commands and actual 8/16 pixels
// are covered by the retained before/after media and MCP integration cohort.
const packed = [30, 60, 90, 255, 120, 130, 140, 128, 0, 0, 0, 0, 200, 220, 240, 255];
function decoded(high: boolean) {
  const bytes = high ? Buffer.alloc(32) : Buffer.from(packed);
  if (high) for (let plane = 0; plane < 4; plane++) for (let pixel = 0; pixel < 4; pixel++) {
    bytes.writeUInt16LE(packed[pixel * 4 + [1, 2, 0, 3][plane]] * 257, (plane * 4 + pixel) * 2);
  }
  return { sampleId: "p", timeSeconds: .25, width: 2, height: 2, decodedTime: .25,
    pts: 250, timeBase: { numerator: 1, denominator: 1000 }, bytes };
}
function fixture() {
  const project = createEmptyProject("Receipt-only source", { width: 2, height: 2, fps: 4 });
  const path = resolve("owned-frame-source.mp4"), runtime = { ffmpegPath: resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), cacheRoot: resolve("owned-test-cache") };
  project.assets.push({ id: "a", name: "Owned sample", uri: path, kind: "video", duration: 1, width: 2, height: 2, color: { interpretation: "rec709" } });
  project.tracks[0].clips.push({ id: "c", assetId: "a", trackId: project.tracks[0].id, timelineStart: 0, sourceStart: 0,
    duration: 1, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] });
  const source: ShotGradeWorkingSourceV1 = { clipId: "c", assetId: "a", sourceSha256: "a".repeat(64), sourceStart: 0, duration: 1, color: { interpretation: "rec709" } };
  const measured = { status: "measured", receiptSha256: "b".repeat(64), source: { sha256: source.sourceSha256, start: 0, duration: 1 },
    mapping: [{ id: "p", decodedSourceTime: .25, decodedRelativeTime: .25 }], normalization: { interpretation: "rec709" },
    probe: { timelineOrigin: 0, metadata: { stream: { codec_type: "video", width: 2, height: 2, sample_aspect_ratio: "1:1",
      color_primaries: "bt709", color_transfer: "bt709", color_space: "bt709", color_range: "tv", pix_fmt: "yuv444p" } } } } as unknown as MaterialColorReceipt;
  const packet = { materialId: "legacy-material", source: { ...source, kind: "video", width: 2, height: 2, fps: 4 }, analysis: { color: measured } } as unknown as MaterialIntelligencePacket;
  const read = (high = false) => readShotGradeWorkingSurfaceV1(measured, source, project, 0, path, runtime, 10000, high);
  return { project, source, measured, packet, path, runtime, read };
}
const untimed = <T,>(value: T): T => JSON.parse(JSON.stringify(value, (key, item) => key === "elapsedMs" ? undefined : item));
beforeEach(() => {
  vi.clearAllMocks(); io.verify.mockImplementation(() => undefined);
  io.hash.mockImplementation(async (path: string) => path.endsWith("ffmpeg.exe") ? "f".repeat(64) : "a".repeat(64));
  io.decode.mockImplementation(async (_receipt, _index, _filters, format) => decoded(format === "gbrap16le"));
});

describe("packet-free working source frames", () => {
  it.each([false, true])("needs no material envelope and preserves every RGB/alpha value (16-bit %s)", async high => {
    const f = fixture(), before = structuredClone({ project: f.project, source: f.source, measured: f.measured }), value = await f.read(high), multiplier = high ? 257 : 1;
    expect([...value.frame.pixels]).toEqual([30, 60, 90, 120, 130, 140, 0, 0, 0, 200, 220, 240].map(v => v * multiplier));
    expect([...value.alpha]).toEqual([255, 128, 0, 255].map(v => v * multiplier)); expect(value.allPixelsOpaque).toBe(false);
    expect(value.alphaCohort).toMatchObject({ totalPixels: 4, opaquePixels: 2, zeroPixels: 1, partialPixels: 1 });
    expect(value.surface).not.toHaveProperty("materialId"); expect(value.surface).toMatchObject({ implementationIdentityBound: false, decisionEvidenceBound: false });
    expect({ project: f.project, source: f.source, measured: f.measured }).toEqual(before);
  });
  it.each([false, true])("keeps the old working envelope and delegates to the same sample (16-bit %s)", async high => {
    const f = fixture(), core = await f.read(high), old = await readShotGradeWorkingFrameV1(f.packet, f.project, 0, f.path, f.runtime, 10000, high);
    expect(old.frame).toEqual(core.frame); expect(old.alpha).toEqual(core.alpha);
    expect(untimed(old.surface)).toEqual({ ...untimed(core.surface), materialId: "legacy-material" });
  });
  it.each([undefined, -1, 1, .5, NaN])("refuses invalid measured index %s before decoding", async index => {
    const f = fixture(); await expect(readShotGradeWorkingSurfaceV1(f.measured, f.source, f.project, index as number, f.path, f.runtime, 10000)).rejects.toThrow(/measured sample/); expect(io.decode).not.toHaveBeenCalled();
  });
  it.each([{ sourceStart: .1 }, { duration: .5 }, { sourceSha256: "c".repeat(64) }])("refuses a source binding inconsistent with the actual clip/receipt: %j", async patch => {
    const f = fixture(); await expect(readShotGradeWorkingSurfaceV1(f.measured, { ...f.source, ...patch }, f.project, 0, f.path, f.runtime, 10000)).rejects.toThrow(/window mismatch/); expect(io.decode).not.toHaveBeenCalled();
  });
  it("does not replace a bad source SHA with the current file's hash", async () => {
    const f = fixture(); io.hash.mockResolvedValue("c".repeat(64)); await expect(f.read()).rejects.toThrow(/Source SHA mismatch/); expect(io.decode).not.toHaveBeenCalled();
  });
  it.each(["source", "tool"])("rejects %s drift after the actual decode", async role => {
    const f = fixture(); let sourceReads = 0, toolReads = 0;
    io.hash.mockImplementation(async (path: string) => { const tool = path.endsWith("ffmpeg.exe"), count = tool ? ++toolReads : ++sourceReads;
      return count === 2 && (tool ? role === "tool" : role === "source") ? "c".repeat(64) : tool ? "f".repeat(64) : "a".repeat(64); });
    await expect(f.read()).rejects.toThrow(/Source\/tool drift/); expect(io.decode).toHaveBeenCalledTimes(1);
  });
  it("does not relabel a mismatched decode raster as the planned raster", async () => {
    const f = fixture(); io.decode.mockResolvedValue({ ...decoded(false), width: 1 }); await expect(f.read()).rejects.toThrow(/raster mismatch/);
  });
  it("does not acquire command authority by copying a project snapshot", async () => {
    const f = fixture(), before = colorDigest(f.project), work = f.read(); f.project.revision++; f.source.clipId = "changed-after-start";
    const value = await work; expect(value.surface.projectSnapshotSha256).toBe(before); expect(value.surface.decisionEvidenceBound).toBe(false);
    expect(value.surface).not.toHaveProperty("command"); expect(value.surface).not.toHaveProperty("currentActualLocalPostGradeVerified");
  });
  it.each([0, -1, NaN, 120001])("rejects deadline %s before any I/O", async limit => {
    const f = fixture(); await expect(readShotGradeWorkingSurfaceV1(f.measured, f.source, f.project, 0, f.path, f.runtime, limit)).rejects.toThrow(/source\/budget/); expect(io.hash).not.toHaveBeenCalled(); expect(io.decode).not.toHaveBeenCalled();
  });
  it("honours pre-abort before any I/O", async () => {
    const f = fixture(), signal = new AbortController(); signal.abort();
    await expect(readShotGradeWorkingSurfaceV1(f.measured, f.source, f.project, 0, f.path, { ...f.runtime, signal: signal.signal }, 10000)).rejects.toThrow(); expect(io.hash).not.toHaveBeenCalled(); expect(io.decode).not.toHaveBeenCalled();
  });
  it("retains the authored-clock refusal in the packet-free path", async () => {
    const f = fixture(); f.project.tracks[0].clips[0].speed = 2; await expect(f.read()).rejects.toThrow(/shared source-clock adapter/); expect(io.decode).not.toHaveBeenCalled();
  });
});

describe("packet-free post-v2 surfaces", () => {
  it.each([false, true])("retains the actual identity bypass and old material envelope (16-bit %s)", async high => {
    const f = fixture(), core = await readShotGradeRenderedSurfaceV1(f.measured, f.source, f.project, 0, f.path, f.runtime, 10000, null, high),
      old = await readShotGradeRenderedFrameV1(f.packet, f.project, 0, f.path, f.runtime, 10000, null, high);
    expect(core.surface.cube).toBeNull(); expect(core.surface.identityGradeBypass).toBe(true); expect(core.surface.stage).toBe("clip_working_post_v2");
    expect(core.frame).toEqual(old.frame); expect(core.alpha).toEqual(old.alpha);
    expect(untimed(old.surface)).toEqual({ ...untimed(core.surface), materialId: "legacy-material" }); expect(core.surface).not.toHaveProperty("materialId");
    expect(core.surface.finalOutputMeasured).toBe(false);
  });
  it("refuses spatial finishing before decoding a pointwise surface", async () => {
    const f = fixture(); await expect(readShotGradeRenderedSurfaceV1(f.measured, f.source, f.project, 0, f.path, f.runtime, 10000,
      { schema: "editkin.color-grade/v2", finishing: { grain: { amount: .1 } } })).rejects.toThrow(/Spatial finishing/); expect(io.decode).not.toHaveBeenCalled();
  });
  it("keeps the absolute-cache-root guard", async () => {
    const f = fixture(); await expect(readShotGradeRenderedSurfaceV1(f.measured, f.source, f.project, 0, f.path, { ...f.runtime, cacheRoot: "relative" }, 10000)).rejects.toThrow(/budget\/cache root/); expect(io.decode).not.toHaveBeenCalled();
  });
});

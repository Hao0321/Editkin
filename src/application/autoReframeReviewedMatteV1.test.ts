import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_TRANSFORM } from "../domain/types";
import { runProcess } from "../render/mediaProcess";
import { buildDecodedPtsIndexV1 } from "../render/decodedPtsIndexV1";
import { createTimeRemapFrameConsumerV2 } from "../render/timeRemapFrameConsumerV2";
import { withRenderLifetime } from "../render/renderLifetime";
import { matteTrackFixtureV1 } from "./__fixtures__/matteTrackV1.fixture";
import { rotoBakeFixture } from "./__fixtures__/rotoCutoutProject.fixture";
import { analyzeMatteTrackV1, type MatteTrackArtifactsV1 } from "./matteTrackAnalysisV1";
import { verifyProductAutoRotoV2 } from "./autoRotoNativeProductV2";
import { confirmRotoSubjectV1, rotoMatteIdentitySchemaV1 } from "./rotoMatteTrustV1";
import { createAutoReframeSparseV2, assertAutoReframeSparseSinkV2 } from "./autoReframeSparseV2";
import { observeReframePixelsV1 } from "./autoReframeV1";
import { prepareAutoReframeSourceV1 } from "./autoReframeSourceV1";
import { prepareAutoReframeReviewedSourceV1 } from "./autoReframeReviewedSourceV1";
import { prepareReframeReviewedMatteV1, assertReframeReviewedMatteV1, claimReframeReviewedMatteV1, reframeReviewedMatteSubjectV1,
  verifyReframeReviewedMatteV1, reframeReviewedMatteReceiptV1, closeReframeReviewedMatteV1, type ReframeReviewedMatteV1 } from "./autoReframeReviewedMatteV1";

// Physical complete-matte admission and media decoding are deliberately doubled in this suite.
// Source/cutout/manifest files, handle cleanup, sparse camera, subject clock and render lifetime are real.
vi.mock("./matteTrackAnalysisV1", () => ({ analyzeMatteTrackV1: vi.fn() }));
vi.mock("./autoRotoNativeProductV2", () => ({ verifyProductAutoRotoV2: vi.fn() }));
vi.mock("../render/mediaProcess", async original => ({ ...await original<typeof import("../render/mediaProcess")>(), runProcess: vi.fn() }));
vi.mock("../render/decodedPtsIndexV1", () => ({ buildDecodedPtsIndexV1: vi.fn() }));
vi.mock("../render/timeRemapFrameConsumerV2", () => ({ createTimeRemapFrameConsumerV2: vi.fn() }));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.mocked(analyzeMatteTrackV1).mockReset(); vi.mocked(verifyProductAutoRotoV2).mockReset().mockResolvedValue(undefined as never); });
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.split(/[\\/]/).at(-1)).toMatch(/^editkin-reviewed-reframe-unit-/);
    await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ root, producer: "autoReframeReviewedMatteV1.test.ts", testsTerminal: true,
      instrumentOnly: true, upstreamMatteAdmissionDoubled: true, mediaDecoderDoubled: true, humanSubjectReview: false }));
  }
});
async function fixture(projectFps = 4, matteFps = 4) {
  const root = await mkdtemp(join(tmpdir(), "editkin-reviewed-reframe-unit-")); roots.push(root); await mkdir(join(root, "cache"));
  await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ root, producer: "autoReframeReviewedMatteV1.test.ts", testsTerminal: false }));
  const { project: p, measurement: m } = matteTrackFixtureV1(), sourceBytes = Buffer.from("source-fixture-not-an-encoded-movie"), sourcePath = join(root, "source.mkv");
  await writeFile(sourcePath, sourceBytes); p.width = 160; p.height = 90; p.fps = projectFps; p.tracks[0].clips[0].transform = { ...DEFAULT_TRANSFORM };
  p.tracks[0].clips[0].sourceStart = 0; p.tracks[0].clips[0].duration = 5 / matteFps; p.assets[0].uri = sourcePath; p.assets[0].duration = 5 / matteFps;
  p.assets[0].derivatives!.sourceSha256 = sha(sourceBytes); m.sourceSha256 = sha(sourceBytes); m.sourceStart = 0; m.fps = matteFps; m.frames.forEach(f => { f.time = f.frame / matteFps; });
  const cutout = rotoBakeFixture(), cutoutBytes = Buffer.from("cutout-fixture-not-an-encoded-movie");
  cutout.clip = { path: join(root, "cutout.mkv"), bytes: cutoutBytes.length, sha256: sha(cutoutBytes) }; cutout.manifestPath = join(root, "cutout-v1.json");
  cutout.sourcePath = sourcePath; cutout.sourceSha256 = m.sourceSha256; cutout.fps = matteFps; cutout.duration = 5 / matteFps;
  cutout.matteIdentity = rotoMatteIdentitySchemaV1.parse({ ...cutout.matteIdentity, sourceStart: 0, sourceSha256: m.sourceSha256, cutoutSha256: cutout.clip.sha256, fps: matteFps });
  await writeFile(cutout.clip.path, cutoutBytes); await writeFile(cutout.manifestPath, JSON.stringify(cutout));
  const trust = confirmRotoSubjectV1(cutout.matteIdentity, { subjectCorrect: true, reviewerId: sha("instrument-only-reviewed-reframe"), reviewedAt: new Date().toISOString() });
  m.subjectConfirmationSha256 = sha(JSON.stringify(trust));
  const artifacts = { analysis: { source: { path: sourcePath, bytes: sourceBytes.length, sha256: m.sourceSha256 } }, cutout, trust } as unknown as MatteTrackArtifactsV1;
  const rgba = Buffer.alloc(64 * 40 * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  for (let y = 12; y < 28; y++) for (let x = 45; x < 57; x++) { const at = (y * 64 + x) * 4; rgba[at] = 255; rgba[at + 1] = 200; rgba[at + 2] = 20; }
  const input = { clipId: "selected", outputWidth: 90, outputHeight: 160, expectedSourceSha256: m.sourceSha256 };
  const selected = { artifacts, minimumAlpha: .1, referenceFrame: 0 };
  vi.mocked(analyzeMatteTrackV1).mockImplementation(async () => ({ measurement: structuredClone(m), source: { path: sourcePath, bytes: sourceBytes.length, sha256: m.sourceSha256 } } as Awaited<ReturnType<typeof analyzeMatteTrackV1>>));
  vi.mocked(runProcess).mockResolvedValue({ stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "ffv1", pix_fmt: "rgba", width: 64, height: 40,
    sample_aspect_ratio: "1:1", time_base: "1/1000" }] }), stderr: "", code: 0 } as Awaited<ReturnType<typeof runProcess>>);
  vi.mocked(buildDecodedPtsIndexV1).mockResolvedValue({ index: { decodedFrameCount: 5, metadataBytes: 0, metadataSha256: "b".repeat(64), assertIdentity: vi.fn(async () => {}) } } as unknown as Awaited<ReturnType<typeof buildDecodedPtsIndexV1>>);
  const decoder = { sample: vi.fn(async () => ({ bytes: rgba })), finish: vi.fn(async () => {}), close: vi.fn(async () => {}), receipt: { instrumentOnly: true }, decoderReceipts: [] };
  vi.mocked(createTimeRemapFrameConsumerV2).mockReturnValue(decoder as unknown as ReturnType<typeof createTimeRemapFrameConsumerV2>);
  const runtime = { sourcePath, assetBase: root, cacheRoot: join(root, "cache"), ffmpegPath: "instrument-ffmpeg", ffprobePath: "instrument-ffprobe", timeoutMs: 5000 };
  const prepare = () => prepareReframeReviewedMatteV1(p, input, selected, { assetBase: root }, { timeoutMs: 5000 });
  return { p, m, input, selected, runtime, prepare, root, rgba, decoder };
}

describe("authenticated sparse camera and reviewed matte capability", () => {
  it("prevents the known accepted authentic-method replacement without changing the numeric API", async () => {
    const f = await fixture(), s = createAutoReframeSparseV2(f.p, f.input), original = s.consume;
    expect(Object.isFrozen(s)).toBe(true); expect(Reflect.set(s, "consume", () => {})).toBe(false); expect(s.consume).toBe(original);
    expect(() => assertAutoReframeSparseSinkV2(s, f.p, f.input)).not.toThrow(); expect(() => assertAutoReframeSparseSinkV2({ ...s }, f.p, f.input)).toThrow("OWNER");
  });
  it.each([[8, 4], [60000 / 1001, 30000 / 1001]])("uses exact rational floor at project%s / matte%s, with no early sample or lost fallback", async (fps, rate) => {
    const f = await fixture(fps, rate), token = await f.prepare(); claimReframeReviewedMatteV1(token, f.p, f.input, f.runtime.sourcePath);
    for (let frame = 0; frame < 10; frame++) {
      const expected = f.m.frames[Math.floor(frame / 2)]; const actual = reframeReviewedMatteSubjectV1(token, frame);
      expect(actual?.rect).toEqual(expected.bbox); expect(actual?.confidence).toEqual(expected.bbox ? expected.confidence : undefined);
      if (actual) actual.rect.x = .99;
    }
    await verifyReframeReviewedMatteV1(token, f.p, f.input, f.runtime.sourcePath);
    const receipt = reframeReviewedMatteReceiptV1(token); expect(receipt.outputFrames).toBe(10); expect(receipt.sampling).toBe("exact-rational-floor");
    expect(receipt.saliencyFallbackOnLoss).toBe(false); closeReframeReviewedMatteV1(token); expect(() => assertReframeReviewedMatteV1(token, f.p, f.input, f.runtime.sourcePath)).toThrow("USED");
  });
  it.each(["foreign", "cloned", "project", "input", "source"])("refuses %s ownership before consuming frames", async kind => {
    const f = await fixture(), real = await f.prepare(); let token = real;
    if (kind === "foreign") token = { schema: "editkin.reframe-reviewed-matte/v1", clipId: "selected" }; if (kind === "cloned") token = { ...real };
    if (kind === "project") f.p.revision++; if (kind === "input") f.input.outputWidth++;
    expect(() => assertReframeReviewedMatteV1(token, f.p, f.input, kind === "source" ? join(f.root, "another.mkv") : f.runtime.sourcePath)).toThrow();
  });
  it("refuses an ambiguous legacy+v2 matte and a wrong requested source SHA", async () => {
    const f = await fixture(); await expect(prepareReframeReviewedMatteV1(f.p, { ...f.input, matteMaskId: "legacy" }, f.selected, { assetBase: f.root })).rejects.toThrow("LEGACY_CONFLICT");
    expect(analyzeMatteTrackV1).not.toHaveBeenCalled(); f.input.expectedSourceSha256 = "0".repeat(64); await expect(f.prepare()).rejects.toThrow("BINDING");
  });
  it("requires claim, exact order, complete consumption and successful physical EOF verification", async () => {
    const f = await fixture(), t = await f.prepare(); expect(() => reframeReviewedMatteReceiptV1(t)).toThrow("NOT_VERIFIED");
    expect(() => reframeReviewedMatteSubjectV1(t, 0)).toThrow("FRAME_ORDER"); claimReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath);
    expect(() => reframeReviewedMatteSubjectV1(t, 1)).toThrow("FRAME_ORDER"); await expect(verifyReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath)).rejects.toThrow("INCOMPLETE");
    for (let i = 0; i < 5; i++) reframeReviewedMatteSubjectV1(t, i);
    vi.mocked(verifyProductAutoRotoV2).mockRejectedValueOnce(new Error("actual-matte-artifact-changed"));
    await expect(verifyReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath)).rejects.toThrow("artifact-changed"); expect(() => reframeReviewedMatteReceiptV1(t)).toThrow("NOT_VERIFIED");
  });
  it.each(["cutout", "manifest", "confirmation-sha"])("refuses changed %s at EOF", async kind => {
    const f = await fixture(); if (kind === "confirmation-sha") f.m.subjectConfirmationSha256 = "0".repeat(64);
    const t = await f.prepare(); claimReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath); for (let i = 0; i < 5; i++) reframeReviewedMatteSubjectV1(t, i);
    if (kind === "cutout") await writeFile(f.selected.artifacts.cutout.clip.path, "changed");
    if (kind === "manifest") await writeFile(f.selected.artifacts.cutout.manifestPath, "{}");
    await expect(verifyReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath)).rejects.toThrow(); expect(() => reframeReviewedMatteReceiptV1(t)).toThrow("NOT_VERIFIED");
  });
  it("pins private measurement/trust snapshots while returning only cloned rectangles", async () => {
    const f = await fixture(), t = await f.prepare(); f.m.frames[0].bbox!.x = .9; f.selected.artifacts.trust.reviewerId = "0".repeat(64);
    claimReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath); const r = reframeReviewedMatteSubjectV1(t, 0)!; expect(r.rect.x).toBe(.125); r.rect.x = .8;
    for (let i = 1; i < 5; i++) reframeReviewedMatteSubjectV1(t, i); await verifyReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath);
    expect(reframeReviewedMatteReceiptV1(t).subjectConfirmationSha256).not.toBe("0".repeat(64));
  });
});

describe("ordinary source producer and sparse reviewed route retain one lifetime/decoder", () => {
  it("uses actual source-file/PTS plumbing and sparse camera, preserving pixel hashes while keeping lost matte unknown", async () => {
    const f = await fixture(), before = structuredClone(f.p); expect(observeReframePixelsV1({ rgba: f.rgba, width: 64, height: 40 }).subject).toBeDefined();
    const r = await prepareAutoReframeReviewedSourceV1(f.p, f.input, f.selected, f.runtime);
    expect(f.p).toEqual(before); expect(r.schema).toBe("editkin.auto-reframe-preparation/v2"); expect(r.metrics.validSubjects).toBe(4); expect(r.metrics.unknownFrames).toBe(1);
    expect(r.observations.map(o => o.subject?.rect)).toEqual(f.m.frames.map(o => o.bbox)); expect(r.observations.every(o => o.pixelSha256 === sha(f.rgba))).toBe(true);
    expect(r.analysis.matte).toMatchObject({ sourceBinding: "explicit_confirmed_v2_matte", sampleCount: 5, outputFrames: 5, alphaBits: 16, saliencyFallbackOnLoss: false, subjectQualityCertified: false });
    expect(r.compression.storedWholeObservationRows).toBe(0); expect(r.subjectQualityCertified).toBe(false); expect(f.decoder.close).toHaveBeenCalledOnce(); expect(await readdir(f.runtime.cacheRoot)).toEqual([]);
  });
  it("retains old unbound source behaviour and never creates a provider implicitly", async () => {
    const f = await fixture(), sink = createAutoReframeSparseV2(f.p, f.input);
    const r = await prepareAutoReframeSourceV1(f.p, f.input, { ...f.runtime, sparseCameraV2: sink });
    expect(r.analysis.matte).toBeNull(); expect(analyzeMatteTrackV1).not.toHaveBeenCalled(); expect(r.observations.every(o => o.subject?.origin === "saliency")).toBe(true);
  });
  it("preflights existing camera moves before any matte verification or decoder", async () => {
    const f = await fixture(); f.p.tracks[0].clips[0].transform.x = 1;
    await expect(prepareAutoReframeReviewedSourceV1(f.p, f.input, f.selected, f.runtime)).rejects.toThrow("CAMERA_REQUIRES_MERGE");
    expect(analyzeMatteTrackV1).not.toHaveBeenCalled(); expect(runProcess).not.toHaveBeenCalled();
  });
  it.each([0, Infinity, 300001])("refuses invalid total budget%s before producers", async timeoutMs => {
    const f = await fixture(); await expect(prepareAutoReframeReviewedSourceV1(f.p, f.input, f.selected, { ...f.runtime, timeoutMs })).rejects.toThrow("BUDGET"); expect(analyzeMatteTrackV1).not.toHaveBeenCalled();
  });
  it("propagates inherited parent cancellation during matte preparation before media starts", async () => {
    const f = await fixture(), c = new AbortController(), reason = new Error("parent-stop-during-matte");
    vi.mocked(analyzeMatteTrackV1).mockImplementationOnce(async (_p, _j, _a, _h, runtime) => { c.abort(reason); runtime?.signal?.throwIfAborted(); throw Error("must abort"); });
    await expect(withRenderLifetime({ signal: c.signal, timeoutMs: 5000 }, () => prepareAutoReframeReviewedSourceV1(f.p, f.input, f.selected, f.runtime))).rejects.toBe(reason); expect(runProcess).not.toHaveBeenCalled();
  });
  it("cancels after a source frame, closes the decoder and exact owned PTS workspace, without a result", async () => {
    const f = await fixture(), c = new AbortController(), reason = new Error("stop-after-first-frame");
    await expect(prepareAutoReframeReviewedSourceV1(f.p, f.input, f.selected, { ...f.runtime, signal: c.signal, onFrame: async () => { c.abort(reason); } })).rejects.toBe(reason);
    expect(f.decoder.close).toHaveBeenCalledOnce(); expect(await readdir(f.runtime.cacheRoot)).toEqual([]); expect(f.p.tracks[0].clips[0].keyframes).toHaveLength(0);
  });
  it("checks late source/graph changes and never publishes a prepared camera", async () => {
    const f = await fixture(); await expect(prepareAutoReframeReviewedSourceV1(f.p, f.input, f.selected, { ...f.runtime,
      onFrame: async frame => { if (frame === 4) f.p.revision++; } })).rejects.toThrow("GRAPH_CHANGED"); expect(f.decoder.close).toHaveBeenCalledOnce(); expect(await readdir(f.runtime.cacheRoot)).toEqual([]);
  });
  it("does not let a failed concurrent preflight close another invocation's claimed capability", async () => {
    const f = await fixture(), t = await f.prepare(); claimReframeReviewedMatteV1(t, f.p, f.input, f.runtime.sourcePath);
    await expect(prepareAutoReframeSourceV1(f.p, f.input, { ...f.runtime, sparseCameraV2: createAutoReframeSparseV2(f.p, f.input), reviewedMatteV1: t })).rejects.toThrow("ALREADY_USED");
    expect(reframeReviewedMatteSubjectV1(t, 0)).toBeDefined(); expect(runProcess).not.toHaveBeenCalled(); closeReframeReviewedMatteV1(t);
  });
});

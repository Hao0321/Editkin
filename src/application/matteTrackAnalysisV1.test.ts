import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import nativeFixture from "./__fixtures__/autoRotoNativeV2.fixture.json";
import { matteTrackFixtureV1 } from "./__fixtures__/matteTrackV1.fixture";
import { verifyProductAutoRotoV2, type ProductAutoRotoAnalysisResultV2 } from "./autoRotoNativeProductV2";
import { parseRotoV2Request, ROTO_V2_DEFAULT_SETTINGS, type NativeAutoRotoReceiptV2 } from "./autoRotoV2Contract";
import { rotoBakeFixture } from "./__fixtures__/rotoCutoutProject.fixture";
import { confirmRotoSubjectV1, rotoMatteIdentitySchemaV1 } from "./rotoMatteTrustV1";
import { beginMatteTrackV1, matteTrackCommandV1 } from "./matteTrackV1";
import { analyzeMatteTrackV1, type MatteTrackArtifactsV1 } from "./matteTrackAnalysisV1";

// Only the upstream complete-analysis verifier is doubled. This suite exercises actual bounded
// alpha/cutout/manifest files; the benchmark separately uses genuine current native+FFV1 artifacts.
vi.mock("./autoRotoNativeProductV2", () => ({ verifyProductAutoRotoV2: vi.fn() }));
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [];
beforeEach(() => { vi.mocked(verifyProductAutoRotoV2).mockReset().mockResolvedValue(undefined as never); });
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.split(/[\\/]/).at(-1)).toMatch(/^editkin-matte-track-unit-/);
    await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "matteTrackAnalysisV1.test.ts", root, testsTerminal: true,
      instrumentOnly: true, humanSubjectReview: false, upstreamAnalysisVerifierDoubled: true }));
  }
});
async function fixture(bits: 8 | 16 = 16) {
  const root = await mkdtemp(join(tmpdir(), "editkin-matte-track-unit-")); roots.push(root); await mkdir(join(root, "native"));
  await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "matteTrackAnalysisV1.test.ts", root, testsTerminal: false }));
  const { project, options, measurement } = matteTrackFixtureV1(), source = Buffer.from("synthetic source instrument"), cutoutBytes = Buffer.from("synthetic cutout instrument");
  const sourcePath = join(root, "source.mkv"), alphaPath = join(root, "native", bits === 16 ? "matte-sequence.alpha16le" : "matte-sequence.alpha8");
  await writeFile(sourcePath, source); project.assets[0].uri = sourcePath; project.assets[0].derivatives!.sourceSha256 = hash(source);
  const alpha = Buffer.alloc(64 * 40 * 5 * bits / 8), maximum = bits === 16 ? 65535 : 255;
  for (const f of measurement.frames) if (f.bbox) {
    const r = f.bbox;
    for (let y = Math.round(r.y * 40); y < Math.round((r.y + r.height) * 40); y++)
      for (let x = Math.round(r.x * 64); x < Math.round((r.x + r.width) * 64); x++) {
        const i = (f.frame * 64 * 40 + y * 64 + x) * bits / 8; alpha[i] = maximum & 255; if (bits === 16) alpha[i + 1] = maximum >>> 8;
      }
  }
  await writeFile(alphaPath, alpha);
  const native = structuredClone(nativeFixture.native) as NativeAutoRotoReceiptV2;
  Object.assign(native, { width: 64, height: 40, alphaFormat: bits === 16 ? "gray16le" : "gray", alphaPath: bits === 16 ? "matte-sequence.alpha16le" : "matte-sequence.alpha8", alphaBytes: alpha.length });
  native.edgeSettings.alpha16 = bits === 16; native.frames.forEach(f => { f.confidence = .75; });
  const tool = { path: sourcePath, bytes: source.length, sha256: hash(source) };
  const request = parseRotoV2Request({ sourcePath, sourceSha256: hash(source), sourceStart: 1, duration: 1.25, fps: 4, initialTime: .5,
    initialRect: { x: .125, y: .2, width: .25, height: .4 }, sourceColor: "rec709-rgb8", maxDimension: 64,
    edgeSettings: { ...ROTO_V2_DEFAULT_SETTINGS, alpha16: bits === 16 } });
  const analysis: ProductAutoRotoAnalysisResultV2 = { schema: "editkin.auto-roto-analysis/v2", contractVersion: "roto-v2-runtime/1", qualityState: "diagnostic", status: "complete",
    workspace: root, nativeRoot: join(root, "native"), manifestPath: join(root, "analysis-v2.json"), request, source: tool, tools: { ffmpeg: tool, ffprobe: tool, nativeCore: tool }, native,
    analysisSha256: "d".repeat(64), artifacts: [{ path: alphaPath, relativePath: native.alphaPath, bytes: alpha.length, sha256: hash(alpha) }],
    media: { width: 64, height: 40, frameCount: 5, rawBytes: 38400, fps: 4, videoStreamIndex: 0, hasAudio: false, initialFrame: 2,
      displayRotationDegrees: 0, sourceSampleAspectRatio: 1, sourceSarAssumedSquare: true, sourceDisplayWidth: 64, sourceDisplayHeight: 40,
      filter: "fps=4,scale=64:40:flags=bilinear,format=rgb24" } };
  const cutout = rotoBakeFixture(); cutout.manifestPath = join(root, "cutout-v1.json"); cutout.clip = { path: join(root, "cutout.mkv"), bytes: cutoutBytes.length, sha256: hash(cutoutBytes) };
  cutout.sourcePath = sourcePath; cutout.sourceSha256 = hash(source); cutout.alphaSha256 = hash(alpha); cutout.inputAlphaBits = bits;
  cutout.matteIdentity = rotoMatteIdentitySchemaV1.parse({ ...cutout.matteIdentity, sourceSha256: hash(source), cutoutSha256: hash(cutoutBytes), alphaSha256: hash(alpha), nativeCoreSha256: tool.sha256 });
  await writeFile(cutout.clip.path, cutoutBytes); await writeFile(cutout.manifestPath, JSON.stringify(cutout));
  const trust = confirmRotoSubjectV1(cutout.matteIdentity, { subjectCorrect: true, reviewerId: hash("instrument-only-test-actor"), reviewedAt: new Date().toISOString() });
  const artifacts: MatteTrackArtifactsV1 = { analysis, cutout, trust };
  return { root, project, options, artifacts, alphaPath, expected: measurement.frames };
}

describe("matte track Node handler physically measures an explicitly confirmed alpha artifact", () => {
  it.each([8, 16] as const)("streams %ibit data, keeps full observations and never runs a decoder/model or writes a project", async bits => {
    const f = await fixture(bits), before = structuredClone(f.project), progress: number[] = [];
    const r = await analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options), f.artifacts, { assetBase: f.root },
      { onProgress: e => { if (e.stage === "measure") progress.push(e.completed); } });
    expect(r.measurement.frames).toEqual(f.expected); expect(progress).toEqual([1, 2, 3, 4, 5]); expect(r.peakAlphaFrameBytes).toBe(64 * 40 * bits / 8);
    expect(r.nativeOrFfmpegProcesses).toBe(0); expect(verifyProductAutoRotoV2).toHaveBeenCalledTimes(2); expect(f.project).toEqual(before);
    expect(r.measurement.subjectConfirmationSha256).toBe(hash(JSON.stringify(f.artifacts.trust)));
    expect(matteTrackCommandV1(f.project, r.plan).type).toBe("add_motion_track"); expect(r.benchmarkAccepted).toBe(false);
  });
  it.each(["unconfirmed", "different-trust", "source", "source-digest", "window", "proxy-size", "relative-base"])("refuses %s before upstream verification or alpha reads", async kind => {
    const f = await fixture();
    if (kind === "unconfirmed") Object.assign(f.artifacts.trust, { subjectCorrect: false });
    if (kind === "different-trust") f.artifacts.cutout.clip.sha256 = "0".repeat(64);
    if (kind === "source") f.project.assets[0].uri = join(f.root, "other.mkv");
    if (kind === "source-digest") f.project.assets[0].derivatives!.sourceSha256 = "0".repeat(64);
    if (kind === "window") f.project.tracks[0].clips[0].sourceStart = 0;
    if (kind === "proxy-size") f.artifacts.analysis.media.sourceDisplayWidth = 128;
    await expect(analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options), f.artifacts, { assetBase: kind === "relative-base" ? "." : f.root })).rejects.toThrow();
    expect(verifyProductAutoRotoV2).not.toHaveBeenCalled();
  });
  it("propagates actual upstream verification failure without returning a command", async () => {
    const f = await fixture(), stop = new Error("physical-analysis-mismatch"); vi.mocked(verifyProductAutoRotoV2).mockRejectedValueOnce(stop);
    await expect(analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options), f.artifacts, { assetBase: f.root })).rejects.toBe(stop);
    expect(verifyProductAutoRotoV2).toHaveBeenCalledOnce(); expect(f.project.motionTracks).toHaveLength(0);
  });
  it.each(["cutout-bytes", "manifest", "alpha-bytes", "truncated-alpha"])("rejects changed actual %s", async kind => {
    const f = await fixture();
    if (kind === "cutout-bytes") await writeFile(f.artifacts.cutout.clip.path, "changed");
    if (kind === "manifest") await writeFile(f.artifacts.cutout.manifestPath, JSON.stringify({ ...f.artifacts.cutout, duration: 2 }));
    if (kind === "alpha-bytes") { const b = await readFile(f.alphaPath); b[0] = 255; await writeFile(f.alphaPath, b); }
    if (kind === "truncated-alpha") await writeFile(f.alphaPath, Buffer.alloc(8));
    await expect(analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options), f.artifacts, { assetBase: f.root })).rejects.toThrow();
    expect(f.project.motionTracks).toHaveLength(0);
  });
  it("checks selected project freshness after asynchronous measurement", async () => {
    const f = await fixture();
    await expect(analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options), f.artifacts, { assetBase: f.root },
      { onProgress: e => { if (e.stage === "measure" && e.completed === 1) f.project.revision++; } })).rejects.toThrow("STALE");
  });
  it("snapshots caller metadata before the first asynchronous file operation", async () => {
    const f = await fixture();
    const r = await analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options), f.artifacts, { assetBase: f.root },
      { onProgress: e => { if (e.stage === "verify-inputs") f.artifacts.analysis.native.frames[0].confidence = 0; } });
    expect(r.measurement.frames[0].confidence).toBe(.75);
  });
  it.each(["inherited", "runtime", "verified"])("retains %s cancellation until apply", async kind => {
    const f = await fixture(), c = new AbortController(), stop = new Error("matte-stop");
    const job = beginMatteTrackV1(f.project, f.options, kind === "inherited" ? c.signal : undefined);
    if (kind === "runtime") {
      const r = await analyzeMatteTrackV1(f.project, job, f.artifacts, { assetBase: f.root }, { signal: c.signal }); c.abort(stop);
      expect(() => matteTrackCommandV1(f.project, r.plan)).toThrow(stop);
    } else await expect(analyzeMatteTrackV1(f.project, job, f.artifacts, { assetBase: f.root }, { signal: c.signal,
      onProgress: e => { if (e.stage === (kind === "verified" ? "verified" : "measure")) c.abort(stop); } })).rejects.toBe(stop);
    expect(f.project.motionTracks).toHaveLength(0);
  });
  it("rejects a conflicting cancellation owner before reading inputs", async () => {
    const f = await fixture();
    await expect(analyzeMatteTrackV1(f.project, beginMatteTrackV1(f.project, f.options, new AbortController().signal), f.artifacts,
      { assetBase: f.root }, { signal: new AbortController().signal })).rejects.toThrow("SINGLE_OWNER"); expect(verifyProductAutoRotoV2).not.toHaveBeenCalled();
  });
});

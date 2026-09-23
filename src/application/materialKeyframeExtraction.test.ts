import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { extractMaterialKeyframes } from "./materialKeyframeExtraction";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { verifyMaterialKeyframeDisplay } from "./materialKeyframeValidation";
import type { MaterialColorRequest } from "./materialColorSamplingTypes";
import { prepareMaterialIntelligence, readMaterialIntelligence } from "./materialIntelligence";
import { hashMaterialJson, sealMaterialPacket } from "./materialEvidenceCache";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const runtime = { ffmpegPath, ffprobePath };
function run(args: string[]) { const r = spawnSync(ffmpegPath, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); expect(r.status, r.stderr.toString()).toBe(0); return r.stdout; }
async function fixture(input: "rec709" | "hlg" | "pq", graph = "nullsrc=s=96x64:r=10:d=1,format=yuv420p10le,geq=lum='128+640*X/W':cb='400+200*Y/H':cr=512") {
  await mkdir(join(app, ".rd/material-keyframe-normalization-20260831"), { recursive: true });
  const root = await mkdtemp(join(app, ".rd/material-keyframe-normalization-20260831/test-")), path = join(root, "source.mkv");
  const hdr = input !== "rec709";
  const tagged = `${graph},setparams=range=limited:color_primaries=${hdr ? "bt2020" : "bt709"}:color_trc=${input === "hlg" ? "arib-std-b67" : input === "pq" ? "smpte2084" : "bt709"}:colorspace=${hdr ? "bt2020nc" : "bt709"}`;
  run(["-v", "error", "-f", "lavfi", "-i", tagged, "-c:v", "ffv1", path]);
  const request: MaterialColorRequest = { sourcePath: path, sourceSha256: await colorFileSha(path), sourceStart: .05, duration: .8, kind: "video", samples: [{ id: "kf-1", time: .1, sceneIndex: 0 }], sceneCount: 2, sceneCountVerified: true, sceneCuts: [.12] };
  return { root, path, request };
}
function decode(path: string) { return run(["-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]); }
// Deliberately literal independent oracle; does not call production filter builders.
const oracle: Record<string, string[]> = {
  rec709: [],
  hlg: ["zscale=t=linear:npl=100:agamma=0", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba"],
  pq: ["zscale=t=linear:npl=100", "format=gbrpf32le", "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv", "format=rgba"],
};
const display = ["scale=96:96:force_original_aspect_ratio=decrease", "format=rgba", "format=gbrpf32le", "zscale=pin=bt709:tin=bt709:min=gbr:rin=full:p=bt709:t=iec61966-2-1:m=gbr:r=full", "format=rgb24"];
it.each(["rec709", "hlg", "pq"] as const)("real %s JPEG agrees with literal neutral PNG oracle and decoded PTS", async input => {
  const f = await fixture(input), identity = await getMaterialColorRuntimeIdentity(runtime);
  expect(identity.status, identity.reason).toBe("verified");
  const result = await extractMaterialKeyframes(f.request, runtime, identity);
  expect(result.analysis.state, JSON.stringify(result.analysis.omitted)).toBe("ready");
  const frame = result.frames[0], path = join(f.root, "actual.jpg"), expected = join(f.root, "oracle.png");
  await writeFile(path, frame.data);
  run(["-v", "error", "-ss", "0.15", "-i", f.path, "-vf", [...oracle[input], ...display].join(","), "-frames:v", "1", expected]);
  const actual = decode(path), pixels = decode(expected); expect(actual.length).toBe(pixels.length);
  const errors = actual.map((value, i) => Math.abs(value - pixels[i])), mean = errors.reduce((a, b) => a + b, 0) / errors.length, maximum = Math.max(...errors);
  expect(mean).toBeLessThanOrEqual(2); expect(maximum).toBeLessThanOrEqual(8);
  let oldScaleOnlyMeanError: number | undefined;
  if (input !== "rec709") {
    // Exact old production filter path on correctly tagged source; expected RED.
    const old = join(f.root, "old-scale-only.jpg");
    run(["-v", "error", "-ss", "0.15", "-i", f.path, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", old]);
    const raw = decode(old); oldScaleOnlyMeanError = raw.reduce((sum, value, i) => sum + Math.abs(value - pixels[i]), 0) / raw.length;
    expect(oldScaleOnlyMeanError).toBeGreaterThan(8);
  }
  expect(frame.display.requested.time).toBe(.1); expect(frame.time).toBeCloseTo(.15, 8); expect(frame.sceneIndex).toBe(1);
  expect(frame.display.decoded.sceneAttributionVerified).toBe(true); expect(frame.display.normalization.transfer).toBe("srgb");
  verifyMaterialKeyframeDisplay(result.analysis, result.frames.map(frame => ({ ...frame, sha256: frame.display.jpeg.sha256, bytes: frame.data.length })), { sourceSha256: f.request.sourceSha256, sourceStart: .05, duration: .8, kind: "video" }, identity.identitySha256, [.12]);
  await writeFile(join(f.root, "report.json"), JSON.stringify({ input, actual: frame.display, meanAbsoluteRgbError: mean, maximumRgbError: maximum, oldScaleOnlyMeanError, syntheticTechnicalOnly: true }, null, 2));
}, 30000);
it("SDR middle grey uses display BT1886→sRGB, not inverse camera OETF or raw code values", async () => {
  const f = await fixture("rec709", "nullsrc=s=96x64:r=10:d=1,format=yuv420p10le,geq=lum=502:cb=512:cr=512");
  const result = await extractMaterialKeyframes(f.request, runtime, await getMaterialColorRuntimeIdentity(runtime));
  expect(result.analysis.state, JSON.stringify(result.analysis.omitted)).toBe("ready");
  const path = join(f.root, "grey.jpg"); await writeFile(path, result.frames[0].data);
  const pixel = [...decode(path).subarray(0, 3)];
  // Independent ICC/BT1886 reference-display oracle: L=V^2.4 (ideal black).
  const srgb = (linear: number) => 255 * (linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055);
  const expected = srgb(.5 ** 2.4), wrongCameraInverse = srgb(((.5 + .099) / 1.099) ** (1 / .45));
  const doubleTransform = srgb((expected / 255) ** 2.4);
  for (const value of pixel) { expect(Math.abs(value - expected)).toBeLessThanOrEqual(3); expect(Math.abs(value - wrongCameraInverse)).toBeGreaterThan(15); expect(Math.abs(value - 127.5)).toBeGreaterThan(4); expect(Math.abs(value - doubleTransform)).toBeGreaterThan(4); }
  await writeFile(join(f.root, "report.json"), JSON.stringify({ pixel, analyticExpected: expected, wrongCameraInverse, doubleTransform, rawCode: 127.5, syntheticTechnicalOnly: true }, null, 2));
}, 30000);
it("unknown tags / contradictory Log and true alpha do not generate trusted JPEG", async () => {
  const f = await fixture("rec709"), identity = await getMaterialColorRuntimeIdentity(runtime);
  const log = await extractMaterialKeyframes({ ...f.request, color: { interpretation: "log_unresolved" } }, runtime, identity);
  expect(log.analysis.state).toBe("blocked"); expect(log.frames).toEqual([]);
  const unknown = join(f.root, "unknown.mkv");
  run(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=10:d=1", "-c:v", "ffv1", unknown]);
  const blocked = await extractMaterialKeyframes({ ...f.request, sourcePath: unknown, sourceSha256: await colorFileSha(unknown) }, runtime, identity);
  expect(blocked.analysis.omitted[0].reason).toBe("unknown-or-incomplete-color-tags"); expect(blocked.frames).toEqual([]);
  const alpha = await fixture("rec709", "nullsrc=s=96x64:r=10:d=1,format=yuva444p,geq=lum=100:cb=128:cr=128:a=100");
  const alphaResult = await extractMaterialKeyframes(alpha.request, runtime, identity);
  expect(alphaResult.analysis.omitted[0].reason).toBe("unsupported-or-alpha-pixel-format"); expect(alphaResult.frames).toEqual([]);
}, 30000);
it("duplicates retain original request coverage without fake time stamps", async () => {
  const f = await fixture("rec709"), identity = await getMaterialColorRuntimeIdentity(runtime);
  const result = await extractMaterialKeyframes({ ...f.request, samples: [{ id: "kf-1", time: .1, sceneIndex: 0 }, { id: "kf-2", time: .11, sceneIndex: 0 }] }, runtime, identity);
  expect(result.analysis.state).toBe("partial"); expect(result.frames).toHaveLength(1);
  expect(result.analysis.omitted).toEqual([{ id: "kf-2", reason: "duplicate-decoded-frame" }]);
}, 30000);
it("real display rotation is preserved and landscape/portrait output stays inside 1280 in both axes", async () => {
  const f = await fixture("rec709"), source = join(f.root, "landscape.mp4"), rotated = join(f.root, "rotated.mp4");
  run(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1600x900:r=2:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv", source]);
  run(["-v", "error", "-display_rotation:v:0", "90", "-i", source, "-c", "copy", rotated]);
  const result = await extractMaterialKeyframes({ ...f.request, sourcePath: rotated, sourceSha256: await colorFileSha(rotated) }, runtime, await getMaterialColorRuntimeIdentity(runtime));
  expect(result.analysis.state, JSON.stringify(result.analysis.omitted)).toBe("ready");
  const frame = result.frames[0]; expect(frame.display.decoded.width).toBe(720); expect(frame.display.decoded.height).toBe(1280); expect(frame.time).toBeCloseTo(.45, 8);
  const actual = join(f.root, "portrait.jpg"), oraclePath = join(f.root, "portrait-oracle.png"); await writeFile(actual, frame.data);
  run(["-v", "error", "-noautorotate", "-ss", "0.15", "-i", rotated, "-vf", ["transpose=cclock", "scale=720:1280", ...display.slice(1)].join(","), "-frames:v", "1", oraclePath]);
  const pixels = decode(actual), expected = decode(oraclePath);
  expect(pixels.length).toBe(720 * 1280 * 3); expect(expected.length).toBe(pixels.length);
  const mean = pixels.reduce((sum, v, i) => sum + Math.abs(v - expected[i]), 0) / pixels.length;
  expect(mean).toBeLessThan(2);
  await writeFile(join(f.root, "rotation-report.json"), JSON.stringify({ decoded: frame.display.decoded, meanAbsoluteRgbError: mean, syntheticTechnicalOnly: true }, null, 2));
}, 30000);
it("real prepare cache4 keeps actual/requested clocks, warm bytes and revision3 read-only history", async () => {
  const f = await fixture("hlg"), request = { ...f.request, assetId: "asset", clipId: "clip", fps: 10, includeTranscript: false, maxKeyframes: 1 }, rt = { ...runtime, cacheRoot: f.root, modelRoot: f.root };
  const first = await prepareMaterialIntelligence(request, rt), warm = await prepareMaterialIntelligence(request, rt);
  expect(first.packet.cache!.identity.engineRevision).toBe(4); expect(warm.cacheHit).toBe(true); expect(warm.packet).toEqual(first.packet);
  expect(first.packet.keyframes[0].time).toBeCloseTo(.15, 8); expect(first.packet.analysis.color?.request.samples[0].time).toBe(.1);
  const legacy = structuredClone(first.packet); delete legacy.analysis.keyframes; legacy.keyframes.forEach(frame => { frame.time = frame.display!.requested.time; delete frame.display; });
  const oldIdentity = { ...legacy.cache!.identity, engineRevision: 3 as const }; legacy.materialId = hashMaterialJson(oldIdentity);
  const oldPacket = sealMaterialPacket(legacy, oldIdentity), oldDir = join(f.root, "material-intelligence", oldPacket.materialId);
  await mkdir(oldDir); const oldBytes = JSON.stringify(oldPacket); await writeFile(join(oldDir, "manifest.json"), oldBytes);
  expect(await readMaterialIntelligence(f.root, oldPacket.materialId)).toEqual(oldPacket);
  expect((await prepareMaterialIntelligence(request, rt)).packet.materialId).not.toBe(oldPacket.materialId);
  expect(await readFile(join(oldDir, "manifest.json"), "utf8")).toBe(oldBytes);
}, 30000);

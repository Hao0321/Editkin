import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { extractMaterialKeyframes } from "./materialKeyframeExtraction";
import { colorFileSha, getMaterialColorRuntimeIdentity } from "./materialColorSamplingRuntime";
import { prepareMaterialIntelligence, readMaterialIntelligence, readMaterialKeyframe } from "./materialIntelligence";
import type { MaterialColorRequest } from "./materialColorSamplingTypes";

const app = fileURLToPath(new URL("../../", import.meta.url));
const ffmpegPath = join(app, "vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobePath = join(app, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const runtime = { ffmpegPath, ffprobePath };
const temp = useTempRoots();
function run(args: string[]) {
  const result = spawnSync(ffmpegPath, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout;
}
// Synthetic stills only (never personal media): left half (200,60,30), right half (40,160,220).
// Mid/dark channels tell the paths apart: re-encoding as BT.1886 video would move 60→~49 and 40→~28.
const LEFT = [200, 60, 30], RIGHT = [40, 160, 220];
const PATTERN = "color=c=0xC83C1E:s=160x90:d=1[l];color=c=0x28A0DC:s=160x90:d=1,crop=80:90:0:0[r];[l][r]overlay=x=80:y=0";
type Still = "png-bt709" | "png-srgb" | "png-untagged" | "jpeg" | "webp-lossy" | "webp-lossless" | "png-transparent" | "png-bt2020";
async function still(root: string, kind: Still) {
  const extension = kind.startsWith("png") ? "png" : kind === "jpeg" ? "jpg" : "webp", path = join(root, `${kind}.${extension}`);
  const tags = (primaries: string, trc: string) => `format=rgb24,setparams=color_primaries=${primaries}:color_trc=${trc}:colorspace=gbr:range=pc`;
  const filter = kind === "png-bt709" ? tags("bt709", "bt709") : kind === "png-srgb" ? tags("bt709", "iec61966-2-1") : kind === "png-bt2020" ? tags("bt2020", "bt709")
    : kind === "png-transparent" ? "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(X,79),0,255)'" : "format=rgb24";
  const codec = kind === "jpeg" ? ["-q:v", "2"] : kind === "webp-lossy" ? ["-c:v", "libwebp", "-lossless", "0", "-q:v", "95"] : kind === "webp-lossless" ? ["-c:v", "libwebp", "-lossless", "1"] : [];
  run(["-v", "error", "-f", "lavfi", "-i", PATTERN, "-frames:v", "1", "-vf", filter, ...codec, path]);
  return path;
}
async function imageRequest(path: string, sourceStart = 0): Promise<MaterialColorRequest> {
  return { sourcePath: path, sourceSha256: await colorFileSha(path), sourceStart, duration: 3, kind: "image",
    samples: [{ id: "kf-1", time: 0, sceneIndex: 0 }], sceneCount: 1, sceneCountVerified: true, sceneCuts: [] };
}
function decodeRgb(path: string) { return run(["-v", "error", "-i", path, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]); }
async function prepare(root: string, path: string, clipId = "shot-clip") {
  const rt = { ...runtime, cacheRoot: join(root, "cache"), modelRoot: join(root, "cache") };
  const request = { assetId: "shot", clipId, sourcePath: path, sourceStart: 0, duration: 3, fps: 30, kind: "image" as const, includeTranscript: false, maxKeyframes: 8 };
  const { packet } = await prepareMaterialIntelligence(request, rt);
  return { packet, cacheRoot: rt.cacheRoot, request, rt };
}
async function keyframePixels(root: string, cacheRoot: string, materialId: string) {
  const { data } = await readMaterialKeyframe(cacheRoot, materialId, "kf-1"), jpeg = join(root, `${materialId.slice(0, 8)}.jpg`);
  await writeFile(jpeg, data);
  const pixels = decodeRgb(jpeg);
  expect(pixels.length).toBe(160 * 90 * 3);
  return (x: number, y: number) => [...pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
}
const near = (actual: number[], expected: number[], tolerance: number) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

describe("still image material preparation (design P1)", () => {
  it("a BT.709-tagged PNG keeps the strict Rec.709 path and yields exactly one keyframe at t=0", async () => {
    const root = await temp.create("p1-"), path = await still(root, "png-bt709"), original = await readFile(path);
    const { packet, cacheRoot, request, rt } = await prepare(root, path);
    expect(packet.analysis.keyframes?.requestedSamples).toEqual([{ id: "kf-1", time: 0, sceneIndex: 0 }]);
    expect(packet.analysis.keyframes?.state, JSON.stringify(packet.analysis.keyframes?.omitted)).toBe("ready");
    expect(packet.keyframes).toHaveLength(1);
    expect(packet.keyframes[0]).toMatchObject({ id: "kf-1", time: 0, sceneIndex: 0, mimeType: "image/jpeg" });
    expect(packet.keyframes[0].display?.decoded).toMatchObject({ pts: 0, sourceTime: 0, relativeTime: 0, timelineOrigin: 0, width: 160, height: 90, sceneAttributionVerified: true });
    expect(packet.keyframes[0].display?.probe.metadata.format.format_name).toBe("image2");
    expect(packet.keyframes[0].display?.normalization).toMatchObject({ interpretation: "rec709", displayEotf: "bt1886-ideal" });
    expect(packet.analysis.color?.status).toBe("measured");
    expect(packet.analysis.color?.mapping.map(row => [row.decodedPts, row.decodedRelativeTime])).toEqual([[0, 0]]);
    expect(await readMaterialIntelligence(cacheRoot, packet.materialId)).toEqual(packet);
    expect((await prepareMaterialIntelligence(request, rt)).cacheHit).toBe(true);
    const at = await keyframePixels(root, cacheRoot, packet.materialId);
    expect(at(20, 45)[0]).toBeGreaterThan(180); expect(at(140, 45)[2]).toBeGreaterThan(200);
    expect(await readFile(path)).toEqual(original);
  }, 60000);

  it.each([
    ["untagged PNG", "png-untagged", "srgb_assumed_untagged_image", "rgb", 4],
    ["sRGB-tagged PNG", "png-srgb", "srgb_tagged", "rgb", 4],
    ["JPEG (full-range BT.601 yuvj)", "jpeg", "srgb_assumed_untagged_image", "yuv-bt601-full", 5],
    ["lossy WebP (BT.601 studio range)", "webp-lossy", "srgb_assumed_untagged_image", "yuv-bt601-limited", 6],
    ["lossless WebP", "webp-lossless", "srgb_assumed_untagged_image", "rgb", 4],
  ] as const)("a real-world %s yields exactly one sRGB keyframe at t=0 and says how its colour was interpreted", async (_label, kind, colorInterpretation, sourceEncoding, tolerance) => {
    const root = await temp.create("p1-"), path = await still(root, kind), original = await readFile(path);
    const { packet, cacheRoot } = await prepare(root, path);
    expect(packet.analysis.keyframes?.requestedSamples).toEqual([{ id: "kf-1", time: 0, sceneIndex: 0 }]);
    expect(packet.analysis.keyframes?.state, JSON.stringify(packet.analysis.keyframes?.omitted)).toBe("ready");
    expect(packet.keyframes.map(frame => [frame.id, frame.time])).toEqual([["kf-1", 0]]);
    expect(packet.keyframes[0].display?.normalization).toMatchObject({ interpretation: "srgb", colorInterpretation, sourceEncoding,
      alpha: "flattened-over-black", transfer: "srgb", primaries: "bt709", range: "full" });
    expect(packet.keyframes[0].display?.normalization).not.toHaveProperty("displayEotf");
    // Colour is not claimed as measured Rec.709 video: the colour receipt stays honestly unmeasured.
    expect(packet.analysis.color?.status).toBe("unmeasured");
    expect(await readMaterialIntelligence(cacheRoot, packet.materialId)).toEqual(packet);
    const at = await keyframePixels(root, cacheRoot, packet.materialId);
    // The sRGB still is shown as stored (correct YCbCr matrix and range), not re-encoded as BT.1886 video.
    expect(at(20, 45), `${kind} left ${at(20, 45)}`).toSatisfy((value: number[]) => near(value, LEFT, tolerance));
    expect(at(140, 45), `${kind} right ${at(140, 45)}`).toSatisfy((value: number[]) => near(value, RIGHT, tolerance));
    expect(await readFile(path)).toEqual(original);
  }, 60000);

  it("shows transparent still pixels over black and refuses stills tagged other than sRGB", async () => {
    const root = await temp.create("p1-"), identity = await getMaterialColorRuntimeIdentity(runtime);
    expect(identity.status, identity.reason).toBe("verified");
    const transparent = await extractMaterialKeyframes(await imageRequest(await still(root, "png-transparent")), runtime, identity);
    expect(transparent.analysis.state).toBe("ready");
    const jpeg = join(root, "transparent.jpg"); await writeFile(jpeg, transparent.frames[0].data);
    const pixels = decodeRgb(jpeg), at = (x: number, y: number) => [...pixels.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
    expect(near(at(20, 45), LEFT, 4)).toBe(true); expect(near(at(140, 45), [0, 0, 0], 3)).toBe(true);
    const bt2020 = await extractMaterialKeyframes(await imageRequest(await still(root, "png-bt2020")), runtime, identity);
    expect(bt2020.analysis).toMatchObject({ state: "blocked", omitted: [{ id: "kf-1", reason: "still-color-tags-not-srgb" }] });
    expect(bt2020.frames).toEqual([]);
  }, 60000);

  it("keeps video byte-for-byte strict: an untagged video is still refused", async () => {
    const root = await temp.create("p1-"), path = join(root, "untagged.mkv"), identity = await getMaterialColorRuntimeIdentity(runtime);
    run(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=96x64:r=10:d=1", "-c:v", "ffv1", path]);
    const result = await extractMaterialKeyframes({ ...(await imageRequest(path)), kind: "video", duration: .8, samples: [{ id: "kf-1", time: .1, sceneIndex: 0 }] }, runtime, identity);
    expect(result.analysis).toMatchObject({ state: "blocked", omitted: [{ id: "kf-1", reason: "unknown-or-incomplete-color-tags" }] });
    expect(result.frames).toEqual([]);
  }, 30000);

  it("refuses a still window that starts after source time 0 instead of claiming a later frame", async () => {
    const root = await temp.create("p1-"), path = await still(root, "png-untagged");
    const result = await extractMaterialKeyframes(await imageRequest(path, 1), runtime, await getMaterialColorRuntimeIdentity(runtime));
    expect(result.analysis).toMatchObject({ state: "blocked", omitted: [{ id: "kf-1", reason: "still-image-source-start-not-zero" }] });
    expect(result.frames).toEqual([]);
  }, 30000);
});

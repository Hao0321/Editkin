import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { motionTrackingSamplingV2, validMotionTrackPlanV2, assertMotionTrackStorageV2 } from "./motionTrackingPolicyV2";
import { analyzeMotionTrack } from "./motionTracking";
import type { NativeMotionTrackPlan } from "../render/nativeCore";

const request = { duration: .2, fps: 15, sourceWidth: 160, sourceHeight: 90 };
function plan(): NativeMotionTrackPlan {
  return { engine: "hao-core-rust-motion-track-0.4-planar", analysisFps: 15, width: 160, height: 90, lostRatio: 1 / 3,
    points: Array.from({ length: 3 }, (_, i) => ({ frame: i, time: i / 15, rect: { x: .2, y: .2, width: .3, height: .3 },
      confidence: i === 2 ? 0 : 1, status: i === 2 ? "lost" : "tracked", activity: 0, rotationDegrees: 0, scale: 1,
      quad: [{ x: .2, y: .2 }, { x: .5, y: .2 }, { x: .5, y: .5 }, { x: .2, y: .5 }] })) };
}
describe("tracking sampling and cache contract", () => {
  it("keeps raw, cache and a 64 MiB reserve on the workspace volume", () => {
    const s = motionTrackingSamplingV2(request), required = s.rawBytes + s.maxFrames * 1200 + 16384 + 64 * 1024 * 1024;
    expect(() => assertMotionTrackStorageV2(required, s)).not.toThrow();
    expect(() => assertMotionTrackStorageV2(required - 1, s)).toThrow("SPACE_INSUFFICIENT");
    expect(() => assertMotionTrackStorageV2(NaN, s)).toThrow("SPACE_INSUFFICIENT");
  });
  it("caps portrait long side while preserving aspect and predicts all gray bytes", () => {
    const result = motionTrackingSamplingV2({ ...request, duration: 2, sourceWidth: 1080, sourceHeight: 1920 });
    expect(result).toMatchObject({ width: 360, height: 640, maxFrames: 30, rawBytes: 360 * 640 * 30 });
    expect(motionTrackingSamplingV2({ ...request, duration: .11 })).toMatchObject({ minFrames: 1, maxFrames: 2 });
  });
  it("refuses excessive raw output before invoking a decoder or touching source media", async () => {
    await expect(analyzeMotionTrack({ ...request, duration: 3600, sourceWidth: 1920, sourceHeight: 1080,
      sourcePath: "D:/missing.mp4", sourceStart: 0, initialTime: 0, initialRect: { x: .2, y: .2, width: .3, height: .3 } },
    { ffmpegPath: "missing", nativeCorePath: "missing" })).rejects.toThrow("TRACK_RAW_BUDGET_EXCEEDED");
    expect(() => motionTrackingSamplingV2(request, 1)).toThrow("BUDGET");
    expect(() => motionTrackingSamplingV2({ ...request, sourceWidth: 65536, sourceHeight: 16 })).toThrow("BUDGET");
  });
  it("validates native planar and fallback output with the same contract as cache reads", () => {
    const p = plan(), s = motionTrackingSamplingV2(request);
    expect(validMotionTrackPlanV2(p, s)).toBe(true); p.engine = "hao-core-rust-motion-track-0.4-region-fallback";
    expect(validMotionTrackPlanV2(p, s)).toBe(true);
  });
  it.each(["engine", "clock", "size", "frame", "time", "status", "rect", "quad", "ratio", "scale", "confidence", "sparse"])("refuses malformed %s cache data", kind => {
    const p = plan();
    if (kind === "engine") p.engine = "hao-core-rust-motion-track-untrusted";
    if (kind === "clock") p.analysisFps = 30;
    if (kind === "size") p.width = 320;
    if (kind === "frame") p.points[1].frame = 2;
    if (kind === "time") p.points[1].time = 0;
    if (kind === "status") p.points[1].status = "invented" as "tracked";
    if (kind === "rect") p.points[1].rect.x = NaN;
    if (kind === "quad") p.points[1].quad[2] = p.points[1].quad[0];
    if (kind === "ratio") p.lostRatio = 0;
    if (kind === "scale") p.points[1].scale = 0;
    if (kind === "confidence") p.points[1].confidence = 1.1;
    if (kind === "sparse") delete p.points[1];
    expect(validMotionTrackPlanV2(p, motionTrackingSamplingV2(request))).toBe(false);
  });
  it("really analyzes media, rejects a corrupt cache and invalidates a changed source even with supplied SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracking-policy-")), media = join(root, "source.mkv");
    try {
    const ffmpegPath = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), nativeCorePath = resolve("native/bin/win32-x64/hao-core.exe");
    const pixels = new Uint8Array(160 * 90 * 18);
    for (let f = 0; f < 18; f++) for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
      const local = x - f * 2;
      pixels[(f * 90 + y) * 160 + x] = local >= 28 && local < 76 && y >= 24 && y < 60 ? (local * 37 + y * 71 + local * y * 3) % 256 : 24;
    }
    const made = spawnSync(ffmpegPath, ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "160x90", "-r", "15", "-i", "pipe:0", "-c:v", "ffv1", media], { input: pixels, windowsHide: true, timeout: 10000 });
    expect(made.status, made.stderr.toString()).toBe(0);
    const input = { ...request, duration: 1.2, sourcePath: media, sourceStart: 0, initialTime: 0,
      initialRect: { x: .175, y: 24 / 90, width: .3, height: .4 }, sourceSha256: createHash("sha256").update(await readFile(media)).digest("hex") };
    const runtime = { ffmpegPath, nativeCorePath, cacheRoot: root, workRoot: root };
    const first = await analyzeMotionTrack(input, runtime); expect(first.cacheHit).toBe(false); expect(first.points).toHaveLength(18);
    expect((await analyzeMotionTrack(input, runtime)).cacheHit).toBe(true);
    const cachedPath = join(root, "motion-tracking", (await readdir(join(root, "motion-tracking")))[0]);
    const cached = JSON.parse(await readFile(cachedPath, "utf8")); cached.result.points[1].time = -1;
    await writeFile(cachedPath, JSON.stringify(cached));
    expect((await analyzeMotionTrack(input, runtime)).cacheHit).toBe(false);
    await appendFile(media, Buffer.from([0, 0]));
    await expect(analyzeMotionTrack(input, runtime)).rejects.toThrow("TRACK_SOURCE_SHA_MISMATCH");
    input.sourceSha256 = createHash("sha256").update(await readFile(media)).digest("hex");
    expect((await analyzeMotionTrack(input, runtime)).cacheHit).toBe(false);
    expect((await readdir(join(root, "motion-tracking"))).length).toBe(2);
    expect((await readdir(root)).some(p => p.startsWith("editkin-motion-track-"))).toBe(false);
    } finally {
      await writeFile(join(root, "TEST-OWNER.json"), JSON.stringify({ producer: "motionTrackingPolicyV2.test.ts", root, testsTerminal: true }), { flag: "wx" });
      console.log("TRACKING_POLICY_OWNED_UNIT=" + root);
    }
  }, 30000);
});

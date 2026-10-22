import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { createDemoProject } from "../domain/demo";
import type { EditProject } from "../domain/types";
import { buildRenderPlan } from "./planner";
import { assertLongRenderAdmissibleV1, chooseLongRouteV1, longRenderRouteProvidersV1, measureLongSourceCoverageV1, measureVideoStreamEndSecondsV1,
  planLongOutputIdentityV1, registerLongRenderRouteProvidersV1 } from "./longRenderRouterV1";
import { defaultLongRenderPolicyV1 } from "./longRenderPolicyV1";
import { isLongRenderRefusalV1, type LongRenderFactsV1 } from "./longRenderContractsV1";

const run = promisify(execFile);
const ffmpeg = resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ffprobe = resolve("vendor/ffmpeg/win32-x64/ffprobe.exe");
const policy = defaultLongRenderPolicyV1(16 * 1024 ** 3);
const temp = useTempRoots();
let root = "", complete = "", longAudio = "", truncated = "";

const facts = (patch: Partial<LongRenderFactsV1> = {}): LongRenderFactsV1 => ({
  durationSeconds: 3600, frameRate: { numerator: 30, denominator: 1 }, frameCount: 108_000, audioClipCount: 1, videoInputCount: 1, ramEstimateBytes: 1024 ** 3,
  legacyStagingEstimateBytes: 0, prepassStagingBytes: 0, nativeEffectStagingBytes: 0, fixedMaskStagingBytes: 0, maxFloatingFramesPerClip: 0,
  finalOutputEstimateBytes: 1024 ** 3, sceneLinear: false, residentCandidate: false, alphaDelivery: false, ...patch });

function refusalCode(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return isLongRenderRefusalV1(error) ? error.code : `OTHER:${String(error)}`; }
  return undefined;
}

beforeAll(async () => {
  root = await temp.create("long-router-");
  complete = join(root, "complete-3s.mp4"); longAudio = join(root, "video2s-audio3s.mp4"); truncated = join(root, "truncated.mp4");
  const encode = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"];
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", ...encode, complete], { windowsHide: true, timeout: 60_000 });
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=3", ...encode, longAudio], { windowsHide: true, timeout: 60_000 });
  const big = join(root, "big-10s.mp4");
  await run(ffmpeg, ["-n", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=10", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", big], { windowsHide: true, timeout: 60_000 });
  // A damaged tail: the header still declares 10 s but the last 45 % of the media data is gone.
  const bytes = (await stat(big)).size, source = await open(big, "r"), target = await open(truncated, "wx");
  try { const keep = Math.floor(bytes * .55), buffer = Buffer.alloc(keep); await source.read(buffer, 0, keep, 0); await target.write(buffer); }
  finally { await source.close(); await target.close(); }
}, 120_000);

function clipProject(uri: string, seconds: number): EditProject {
  const value = createDemoProject();
  value.width = 160; value.height = 90; value.captions = []; value.motionGraphics = [];
  Object.assign(value.assets[0], { uri, width: 160, height: 90, duration: seconds });
  Object.assign(value.tracks[0].clips[0], { timelineStart: 0, sourceStart: 0, duration: seconds });
  return value;
}

describe("long-render router", () => {
  it("refuses staging-heavy prepasses, native effects, fixed masks and over-long floating clips before any work", () => {
    const cap = policy.stagingCapBytes;
    expect(refusalCode(() => assertLongRenderAdmissibleV1(facts(), policy))).toBeUndefined();
    expect(refusalCode(() => assertLongRenderAdmissibleV1(facts({ prepassStagingBytes: cap + 1 }), policy))).toBe("LONG_RENDER_PREPASS_STAGING");
    expect(refusalCode(() => assertLongRenderAdmissibleV1(facts({ nativeEffectStagingBytes: cap + 1 }), policy))).toBe("LONG_RENDER_NATIVE_EFFECT_STAGING");
    expect(refusalCode(() => assertLongRenderAdmissibleV1(facts({ fixedMaskStagingBytes: cap + 1 }), policy))).toBe("LONG_RENDER_FIXED_MASK_STAGING");
    expect(refusalCode(() => assertLongRenderAdmissibleV1(facts({ maxFloatingFramesPerClip: 36_001 }), policy))).toBe("LONG_RENDER_FLOATING_FRAMES");
  });

  it("chooses resident v2 up to 64 audio clips, the single graph within the RAM budget, and refuses WP-B routes that are not registered", () => {
    const none = {};
    expect(chooseLongRouteV1({ kind: "resident", audioClipCount: 64, ramEstimateBytes: 0 }, policy, none)).toEqual({ route: "resident-stream-v2", residentStreamVersion: 2 });
    expect(refusalCode(() => chooseLongRouteV1({ kind: "resident", audioClipCount: 65, ramEstimateBytes: 0 }, policy, none))).toBe("LONG_RENDER_AUDIO_CLIPS_REQUIRE_V3");
    expect(chooseLongRouteV1({ kind: "composite", audioClipCount: 500, ramEstimateBytes: policy.ramBudgetBytes }, policy, none)).toEqual({ route: "ffmpeg-single-graph" });
    expect(refusalCode(() => chooseLongRouteV1({ kind: "composite", audioClipCount: 1, ramEstimateBytes: policy.ramBudgetBytes + 1 }, policy, none))).toBe("LONG_RENDER_ROUTE_NOT_AVAILABLE");
    expect(refusalCode(() => chooseLongRouteV1({ kind: "scene-linear", audioClipCount: 1, ramEstimateBytes: 0 }, policy, none))).toBe("LONG_RENDER_ROUTE_NOT_AVAILABLE");
    const provider = async () => { throw Error("not called"); };
    const all = { residentStreamV3: provider as never, chunkedComposite: provider, chunkedSceneLinear: provider };
    expect(chooseLongRouteV1({ kind: "resident", audioClipCount: 65, ramEstimateBytes: 0 }, policy, all)).toEqual({ route: "resident-stream-v3", residentStreamVersion: 3 });
    expect(chooseLongRouteV1({ kind: "composite", audioClipCount: 1, ramEstimateBytes: policy.ramBudgetBytes + 1 }, policy, all)).toEqual({ route: "ffmpeg-chunked" });
    expect(chooseLongRouteV1({ kind: "scene-linear", audioClipCount: 1, ramEstimateBytes: 0 }, policy, all)).toEqual({ route: "scene-linear-chunked" });
  });

  it("registers WP-B providers through one seam and restores the previous table", () => {
    expect(longRenderRouteProvidersV1()).toEqual({});
    const undo = registerLongRenderRouteProvidersV1({ chunkedComposite: async () => { throw Error("not called"); } });
    expect(Object.keys(longRenderRouteProvidersV1())).toEqual(["chunkedComposite"]);
    undo();
    expect(longRenderRouteProvidersV1()).toEqual({});
  });

  it("plans the output identity from the legacy encoder and colour policy", () => {
    const value = clipProject("D:/owned/a.mp4", 3600), plan = buildRenderPlan(value, uri => uri);
    expect(planLongOutputIdentityV1(value, plan, "libx264", { alphaDelivery: false, sceneLinear: false })).toMatchObject({ container: "mp4", width: 160, height: 90,
      frameRate: { numerator: 30, denominator: 1 }, expectedFrames: 108_000, pixelFormat: "yuv420p", colorPrimaries: "bt709", colorTransfer: "bt709", colorMatrix: "bt709",
      encoderArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"], audio: { codec: "aac", sampleRate: 48000, channels: 2, expectedSamples: 172_800_000 } });
    const hdr = clipProject("D:/owned/a.mp4", 60); hdr.colorManagement = { ...hdr.colorManagement!, mode: "aces2", outputTransform: "rec2100_pq_1000" };
    expect(planLongOutputIdentityV1(hdr, buildRenderPlan(hdr, uri => uri), "libx265", { alphaDelivery: false, sceneLinear: false }))
      .toMatchObject({ pixelFormat: "yuv420p10le", colorPrimaries: "bt2020", colorTransfer: "smpte2084", colorMatrix: "bt2020nc" });
    expect(planLongOutputIdentityV1(value, plan, "prores_ks", { alphaDelivery: true, sceneLinear: false })).toMatchObject({ container: "mov", pixelFormat: "yuva444p12le", audio: { codec: "pcm_s24le" } });
  });

  it("measures the real video end, so long audio cannot mask a short video and a damaged tail is not trusted", async () => {
    expect(await measureVideoStreamEndSecondsV1(complete, ffprobe)).toBeCloseTo(3, 2);
    expect(await measureVideoStreamEndSecondsV1(longAudio, ffprobe)).toBeCloseTo(2, 2);
    const damagedEnd = await measureVideoStreamEndSecondsV1(truncated, ffprobe);
    expect(damagedEnd === undefined || damagedEnd < 9).toBe(true);
    const good = clipProject(complete, 3);
    expect(await measureLongSourceCoverageV1(good, buildRenderPlan(good, uri => uri), { ffprobePath: ffprobe })).toEqual([
      { assetId: "asset-demo", path: complete, measuredVideoEndSeconds: expect.closeTo(3, 2), requiredEndSeconds: 3 }]);
    const masked = clipProject(longAudio, 3);
    await expect(measureLongSourceCoverageV1(masked, buildRenderPlan(masked, uri => uri), { ffprobePath: ffprobe })).rejects.toMatchObject({ code: "LONG_RENDER_SOURCE_SHORT",
      details: expect.objectContaining({ clipId: "clip-demo", measuredVideoEndSeconds: expect.closeTo(2, 2), requiredEndSeconds: 3 }) });
    const damaged = clipProject(truncated, 10);
    await expect(measureLongSourceCoverageV1(damaged, buildRenderPlan(damaged, uri => uri), { ffprobePath: ffprobe })).rejects.toMatchObject({
      code: expect.stringMatching(/^LONG_RENDER_SOURCE_(SHORT|UNMEASURED)$/) });
    const missing = clipProject(join(root, "missing.mp4"), 3);
    // Diagnosable and bounded: every attempt's underlying ffprobe failure is kept on the refusal.
    await expect(measureLongSourceCoverageV1(missing, buildRenderPlan(missing, uri => uri), { ffprobePath: ffprobe })).rejects.toMatchObject({ code: "LONG_RENDER_SOURCE_UNMEASURED",
      message: expect.stringMatching(/could not be measured: ffprobe stream info failed/), details: expect.objectContaining({ attempts: 3, errors: expect.arrayContaining([expect.stringMatching(/ffprobe stream info failed/)]) }) });
    const withinHalfFrame = clipProject(complete, 3 + .4 / 30);
    withinHalfFrame.assets[0].duration = 4;
    await expect(measureLongSourceCoverageV1(withinHalfFrame, buildRenderPlan(withinHalfFrame, uri => uri), { ffprobePath: ffprobe })).resolves.toHaveLength(1);
  }, 120_000);
});


it("measures the complete short source repeatedly without a redundant zero-start seek", async () => {
  for (let i = 0; i < 12; i++) expect(await measureVideoStreamEndSecondsV1(complete, ffprobe)).toBeCloseTo(3, 4);
}, 30_000);

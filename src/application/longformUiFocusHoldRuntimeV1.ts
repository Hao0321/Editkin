import { mkdir, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readBoundedFile } from "../shared/boundedFile";
import type { LongformUiFocusDraftV1 } from "../domain/longformUiFocusV1";
import type { LongformUiFocusHoldSequenceV1 } from "../domain/longformUiFocusHoldV1";
import { LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1, LONGFORM_UI_FOCUS_HOLD_MAX_RAW_BYTES_V1 } from "../domain/longformUiFocusHoldV1";
import { colorBytesSha, colorDigest, colorFileSha, colorToolPaths, getMaterialColorRuntimeIdentity, runColorProcess } from "./materialColorSamplingRuntime";
import { longformSourceSha256V1, resolveLongformSourceV1 } from "./longformMaterialIntakeV1";
import { assembleLongformUiFocusHoldEvidenceV1, longformUiFocusHoldTargetV1, longformUiFocusTrackingContextV1,
  verifyLongformUiFocusHoldSequenceV1 } from "./longformUiFocusHoldV1";
import type { MaterialColorRuntime } from "./materialColorSamplingTypes";
import { longformUiFocusAlgorithmSha256V1 } from "./longformUiFocusArtifactV1";
import { locateLongformUiFocusPixelsV1 } from "./longformUiFocusLocalPixelsV1";

export async function longformUiFocusHoldAlgorithmSha256V1() {
  const entry = fileURLToPath(import.meta.url);
  if (extname(entry) !== ".ts") return colorDigest({ mode: "bundle", sha256: colorBytesSha(await readBoundedFile(entry, 64 * 1024 * 1024)) });
  const modules = await Promise.all(["longformUiFocusHoldRuntimeV1.ts", "longformUiFocusHoldV1.ts", "longformUiFocusLocalPixelsV1.ts", "../domain/longformUiFocusHoldV1.ts"].map(async path =>
    ({ path, sha256: colorBytesSha(await readBoundedFile(resolve(dirname(entry), path), 1024 * 1024)) })));
  return colorDigest({ ocrAlgorithmSha256: await longformUiFocusAlgorithmSha256V1(), modules });
}

export interface LongformUiFocusHoldRuntimeV1 extends MaterialColorRuntime {
  sourceRoot: string; workRoot: string; nativeCorePath: string; expectedNativeCoreSha256: string;
  onDecoded?: (sequence: LongformUiFocusHoldSequenceV1, isolatedPixels: Uint8Array) => void | Promise<void>;
}
/** Parse integer PTS and duration on the same gray decode. No fps resampling,
 * estimated timestamps, cache pixels or native ordinal clocks fill a gap. */
export function parseLongformUiFocusHoldDecodeV1(stderr: string, pixels: Uint8Array, draft: LongformUiFocusDraftV1, raw: unknown): LongformUiFocusHoldSequenceV1 {
  const target = longformUiFocusHoldTargetV1(draft, raw);
  const bases = [...stderr.matchAll(/^\[Parsed_showinfo_\d+ @ [^\]\r\n]+\]\s+config in time_base:\s*(\d+)\/(\d+)/gm)];
  if (bases.length !== 1) throw Error("UI_FOCUS_HOLD_TIME_BASE");
  const timeBase = { numerator: Number(bases[0][1]), denominator: Number(bases[0][2]) };
  const rows = [...stderr.matchAll(/^\[Parsed_showinfo_\d+ @ [^\]\r\n]+\]\s+n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\S+\s+duration:\s*(\d+)\s+duration_time:\S+\s+fmt:gray[^\r\n]*?\bs:(\d+)x(\d+)/gm)];
  if (!rows.length || rows.length > LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1 + 1) throw Error("UI_FOCUS_HOLD_FRAME_BUDGET");
  const width = Number(rows[0][4]), height = Number(rows[0][5]), bytes = width * height;
  if (rows.some((row, i) => Number(row[1]) !== i || Number(row[4]) !== width || Number(row[5]) !== height)
    || pixels.length !== rows.length * bytes) throw Error("UI_FOCUS_HOLD_DECODE_BYTE_COVERAGE");
  const rate = String(target.frame.display.probe.metadata.stream.avg_frame_rate ?? "").match(/^(\d+)\/(\d+)$/);
  const nominalFps = rate ? Number(rate[1]) / Number(rate[2]) : NaN, origin = target.frame.display.decoded.timelineOrigin;
  const decodedFrames = rows.map((row, frame) => ({ frame, pts: Number(row[2]), durationPts: Number(row[3]),
    sourceTime: Number(row[2]) * timeBase.numerator / timeBase.denominator - origin,
    duration: Number(row[3]) * timeBase.numerator / timeBase.denominator, imageSha256: colorBytesSha(pixels.subarray(frame * bytes, (frame + 1) * bytes)) }));
  if (decodedFrames.some((frame, i) => !Number.isSafeInteger(frame.pts) || !Number.isSafeInteger(frame.durationPts) || frame.durationPts <= 0
    || (i > 0 && frame.pts <= decodedFrames[i - 1].pts))) throw Error("UI_FOCUS_HOLD_CLOCK_OR_PIXEL_COVERAGE");
  const boundary = decodedFrames.findIndex(frame => frame.sourceTime >= target.end - 1e-7);
  if (boundary >= 0 && boundary !== decodedFrames.length - 1) throw Error("UI_FOCUS_HOLD_FOLLOWING_FRAME_BUDGET");
  const activeCount = boundary < 0 ? decodedFrames.length : boundary;
  const frames = decodedFrames.slice(0, activeCount).map((frame, i) => {
    const next = decodedFrames[i + 1], reportedDurationPts = frame.durationPts;
    const durationPts = next ? next.pts - frame.pts : reportedDurationPts;
    if (durationPts !== reportedDurationPts && (timeBase.numerator / timeBase.denominator > .001000001
      || Math.abs(durationPts - reportedDurationPts) > 1)) throw Error("UI_FOCUS_HOLD_CLOCK_OR_PIXEL_COVERAGE");
    return { ...frame, durationPts, duration: durationPts * timeBase.numerator / timeBase.denominator, reportedDurationPts,
      durationAuthority: durationPts === reportedDurationPts ? "decoder-duration" as const : "next-decoded-pts-with-millisecond-quantization" as const };
  });
  const cuts = [...stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+)\s*,\s*lavfi\.scd\.time:\s*(-?[\d.]+)/g)].map(row => {
    const absolute = Number(row[2]) - origin, frame = decodedFrames.findIndex(clock => Math.abs(clock.sourceTime - absolute) <= .0006);
    if (frame < 0) throw Error("UI_FOCUS_HOLD_CUT_CLOCK");
    return { frame, sourceTime: decodedFrames[frame].sourceTime, score: Number(row[1]) };
  }).filter(cut => cut.frame < activeCount);
  const activePixels = pixels.subarray(0, activeCount * bytes), following = boundary < 0 ? undefined : decodedFrames[boundary];
  const sequence: LongformUiFocusHoldSequenceV1 = { schema: "editkin.longform-ui-focus-hold-sequence/v1", sourceSha256: draft.source.sha256,
    width, height, origin, timeBase, nominalFps, frames, cuts, filters: [...target.frame.display.normalization.filters, "format=gray"],
    rawSha256: colorBytesSha(activePixels), rawBytes: activePixels.length,
    ...(following ? { followingFrame: { pts: following.pts, sourceTime: following.sourceTime, imageSha256: following.imageSha256 } } : {}) };
  verifyLongformUiFocusHoldSequenceV1(sequence, activePixels, draft, raw); return sequence;
}
export async function prepareLongformUiFocusHoldV1(source: string, draft: LongformUiFocusDraftV1, raw: unknown, runtime: LongformUiFocusHoldRuntimeV1) {
  const target = longformUiFocusHoldTargetV1(draft, raw); runtime.signal?.throwIfAborted();
  if (!isAbsolute(runtime.workRoot) || !isAbsolute(runtime.nativeCorePath) || !/^[a-f0-9]{64}$/.test(runtime.expectedNativeCoreSha256)) throw Error("UI_FOCUS_HOLD_RUNTIME_PATH");
  const sourcePath = await resolveLongformSourceV1(runtime.sourceRoot, source), before = await longformSourceSha256V1(sourcePath, runtime.signal);
  if (before.sha256 !== draft.source.sha256) throw Error("UI_FOCUS_HOLD_SOURCE_CHANGED");
  const identity = await getMaterialColorRuntimeIdentity(runtime), nativeSha = await colorFileSha(runtime.nativeCorePath),
    implementationSha256 = await longformUiFocusHoldAlgorithmSha256V1();
  if (identity.status !== "verified" || identity.identitySha256 !== target.frame.display.runtimeIdentitySha256) throw Error("UI_FOCUS_HOLD_DECODE_RUNTIME_CHANGED");
  if (nativeSha !== runtime.expectedNativeCoreSha256) throw Error("UI_FOCUS_HOLD_NATIVE_IDENTITY");
  const tools = colorToolPaths(runtime), origin = target.frame.display.decoded.timelineOrigin;
  const decoded = await runColorProcess(tools.ffmpeg, ["-hide_banner", "-loglevel", "info", "-nostdin", "-copyts",
    "-ss", String(target.start), "-t", String(target.request.duration + .25), "-i", sourcePath, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", ["select='gte(t," + (origin + target.start - 1e-8) + ")*if(lt(t," + (origin + target.end - 1e-8)
      + "),1,lt(prev_selected_t," + (origin + target.end - 1e-8) + "))'",
      ...target.frame.display.normalization.filters, "format=gray", "scdet=threshold=10", "showinfo"].join(","),
    "-frames:v", String(LONGFORM_UI_FOCUS_HOLD_MAX_FRAMES_V1 + 1), "-fps_mode", "passthrough", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"],
    LONGFORM_UI_FOCUS_HOLD_MAX_RAW_BYTES_V1, 30000, runtime.signal);
  runtime.signal?.throwIfAborted();
  const sequence = parseLongformUiFocusHoldDecodeV1(decoded.stderr, decoded.stdout, draft, raw);
  const activePixels = decoded.stdout.subarray(0, sequence.rawBytes);
  await runtime.onDecoded?.(structuredClone(sequence), Uint8Array.from(activePixels)); runtime.signal?.throwIfAborted();
  await mkdir(runtime.workRoot, { recursive: true }); const root = await realpath(runtime.workRoot), workspace = await mkdtemp(join(root, "ui-focus-hold-"));
  const rawPath = join(workspace, "frames.gray"), requestPath = join(workspace, "request.json"), created: string[] = [];
  try {
    await writeFile(rawPath, activePixels, { flag: "wx" }); created.push(rawPath);
    const context = longformUiFocusTrackingContextV1(target.candidate.bounds, sequence.width, sequence.height);
    const requestBytes = Buffer.from(JSON.stringify({ rawPath, width: sequence.width, height: sequence.height, frameCount: sequence.frames.length,
      analysisFps: sequence.nominalFps, initialFrame: 0, initialRect: context, searchRadius: .1, confidenceThreshold: .6,
      maxHoldFrames: 0, maxRotationStep: 8 }));
    await writeFile(requestPath, requestBytes, { flag: "wx" }); created.push(requestPath);
    if (await colorFileSha(rawPath) !== sequence.rawSha256 || await colorFileSha(requestPath) !== colorBytesSha(requestBytes)
      || await colorFileSha(runtime.nativeCorePath) !== nativeSha) throw Error("UI_FOCUS_HOLD_NATIVE_INPUT_CHANGED");
    const result = await runColorProcess(runtime.nativeCorePath, ["motion-track", requestPath], 2 * 1024 * 1024, 30000, runtime.signal);
    runtime.signal?.throwIfAborted();
    const plan = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    const localObservations = await locateLongformUiFocusPixelsV1(draft, raw, sequence, activePixels, runtime.signal);
    const receipt = assembleLongformUiFocusHoldEvidenceV1(draft, raw, sequence, activePixels, plan, localObservations);
    if (await colorFileSha(rawPath) !== sequence.rawSha256 || await colorFileSha(requestPath) !== colorBytesSha(requestBytes) || await colorFileSha(runtime.nativeCorePath) !== nativeSha
      || (await longformSourceSha256V1(sourcePath, runtime.signal)).sha256 !== before.sha256) throw Error("UI_FOCUS_HOLD_SOURCE_OR_PROVIDER_CHANGED");
    if (colorDigest(await getMaterialColorRuntimeIdentity(runtime)) !== colorDigest(identity)) throw Error("UI_FOCUS_HOLD_DECODE_RUNTIME_CHANGED");
    if (await longformUiFocusHoldAlgorithmSha256V1() !== implementationSha256) throw Error("UI_FOCUS_HOLD_ALGORITHM_CHANGED");
    runtime.signal?.throwIfAborted();
    const { receiptSha256: _integrity, ...body } = receipt;
    const value = { ...body, localObservations, provider: { nativeCoreSha256: nativeSha, decodeRuntimeIdentitySha256: identity.identitySha256, implementationSha256,
      engine: plan.engine, cutHeuristic: "same-decode-ffmpeg-scdet-threshold10", temporalResampling: false },
      limitations: ["Pixel-template and tracker evidence is not calibrated semantic/control identity proof.",
        "No project mutation, hint rendering, installed-native/art approval or public arbitrary-artifact ingress."] };
    return { ...value, receiptSha256: colorDigest(value) };
  } finally {
    if (resolve(await realpath(workspace)) !== resolve(workspace) || !workspace.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) throw Error("UI_FOCUS_HOLD_CLEANUP_BOUNDARY");
    for (const path of created) await unlink(path); await rmdir(workspace);
  }
}

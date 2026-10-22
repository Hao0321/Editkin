import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonicalJson";
import { parseTimeRemapCacheReceiptV1 } from "./timeRemapCacheContractV1";
import type { TimeRemapCacheArtifactV1 } from "./timeRemapCacheServiceV1";

export const TIME_REMAP_BROWSER_SURFACE_POLICY_V1 = "diagnostic-clock-preview-vp9-rgb-lossless/v1" as const;
export const TIME_REMAP_BROWSER_SURFACE_SESSION_BYTES_V1 = 64 * 1024 ** 2;
const sources = new WeakSet<object>();
const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
export interface TimeRemapBrowserSourceV1 {
  readonly sourcePath: string; readonly sourceSha256: string; readonly pixelSha256: string;
  readonly width: number; readonly height: number; readonly frames: number;
  readonly rate: Readonly<{ numerator: number; denominator: number }>;
  readonly firstGlobalFrame: number; readonly clockIdentity: string;
}
function compile(value: TimeRemapBrowserSourceV1) {
  const { width, height, frames, firstGlobalFrame, rate } = value;
  if (![value.sourceSha256, value.pixelSha256, value.clockIdentity].every(hash)
    || ![width, height, frames, firstGlobalFrame, rate.numerator, rate.denominator, firstGlobalFrame + frames].every(Number.isSafeInteger)
    || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height * 4 > 32 * 1024 ** 2
    || frames < 1 || frames > 960 || firstGlobalFrame < 0 || rate.numerator < 1 || rate.denominator < 1
    || rate.numerator > 1_000_000 || rate.denominator > 1_000_000 || rate.numerator / rate.denominator > 240
    || frames * rate.denominator / rate.numerator > 4 + 1e-10) throw Error("CLOCK_BROWSER_SURFACE_BOUNDED_WINDOW_REQUIRED");
  const source = Object.freeze({ ...value, rate: Object.freeze({ ...rate }) }); sources.add(source); return source;
}
/** The host keeps the canonical cache lease until the carrier producer closes. A carrier is never a replacement export cache. */
export function browserSourceFromTimeRemapCacheV1(artifact: Pick<TimeRemapCacheArtifactV1, "mediaPath" | "receipt">) {
  const r = parseTimeRemapCacheReceiptV1(artifact.receipt);
  if (!["absent", "explicitly_muted"].includes(r.audio)) throw Error("CLOCK_BROWSER_SURFACE_SEPARATE_AUDIO_HOST_REQUIRED");
  return compile({ sourcePath: artifact.mediaPath, sourceSha256: r.media.sha256, pixelSha256: r.pixels.sha256,
    width: r.width, height: r.height, frames: r.frames, rate: r.keyInputs.fps, firstGlobalFrame: 0, clockIdentity: r.key });
}
/** Global-window receipts retain the ORIGINAL clock identity; the WebM container itself starts at0. */
export function browserSourceFromTimeRemapWindowV1(r: {
  schema: string; outputPath: string; outputSha256: string; frames: number; duration: number;
  globalClockSha256?: string; outputFrameWindow?: { firstFrame: number; frames: number; endFrame: number; encodedDuration: number };
  outputPixels: { sha256: string; bytes: number; frames: number }; pixelEncoding: string; originalAudio: string;
}, shape: { width: number; height: number; rate: { numerator: number; denominator: number } }) {
  const w = r.outputFrameWindow;
  if (r.schema !== "editkin.source-clock-render/v1" || r.pixelEncoding !== "lossless_ffv1_encoded_rgba8_candidate"
    || !w || !r.globalClockSha256 || !["absent", "explicitly_muted"].includes(r.originalAudio)
    || w.frames !== r.frames || w.endFrame !== w.firstFrame + w.frames || r.outputPixels.frames !== r.frames
    || r.outputPixels.bytes !== shape.width * shape.height * 4 * r.frames || r.duration !== w.encodedDuration
    || Math.abs(w.encodedDuration - r.frames * shape.rate.denominator / shape.rate.numerator) > 1e-9) throw Error("CLOCK_BROWSER_SURFACE_GLOBAL_WINDOW_RECEIPT_REQUIRED");
  return compile({ sourcePath: r.outputPath, sourceSha256: r.outputSha256, pixelSha256: r.outputPixels.sha256,
    width: shape.width, height: shape.height, frames: r.frames, rate: shape.rate, firstGlobalFrame: w.firstFrame, clockIdentity: r.globalClockSha256 });
}
export function assertTimeRemapBrowserSourceV1(value: TimeRemapBrowserSourceV1) {
  if (!sources.has(value)) throw Error("CLOCK_BROWSER_SURFACE_LIVE_DESCRIPTOR_REQUIRED");
}
export function browserSurfaceFrameAtV1(source: TimeRemapBrowserSourceV1, globalFrame: number) {
  assertTimeRemapBrowserSourceV1(source);
  const local = globalFrame - source.firstGlobalFrame;
  if (!Number.isSafeInteger(globalFrame) || local < 0 || local >= source.frames) throw Error("CLOCK_BROWSER_SURFACE_FRAME_OUTSIDE_WINDOW");
  // A container PTS can round up by0.5ms. Seek inside the requested frame, not
  // just before that rounded boundary. At<=240fps a quarter-frame is>1ms.
  return { localFrame: local, globalFrame, localSeconds: local * source.rate.denominator / source.rate.numerator,
    seekSeconds: (local + .25) * source.rate.denominator / source.rate.numerator };
}
/** Only requestVideoFrameCallback.mediaTime is a frame stamp. currentTime is a
 * continuous clock and must not be rounded into a claimed presented frame. */
export function browserSurfacePresentedFrameV1(source: TimeRemapBrowserSourceV1, mediaTime: number) {
  assertTimeRemapBrowserSourceV1(source);
  const local = Math.round(mediaTime * source.rate.numerator / source.rate.denominator);
  if (!Number.isFinite(mediaTime) || local < 0 || local >= source.frames
    || Math.abs(mediaTime - local * source.rate.denominator / source.rate.numerator) > .000511) throw Error("CLOCK_BROWSER_SURFACE_PRESENTED_STAMP_INVALID");
  return browserSurfaceFrameAtV1(source, source.firstGlobalFrame + local);
}
export function timeRemapBrowserSurfaceIdentityV1(source: TimeRemapBrowserSourceV1, ffmpegSha256: string) {
  assertTimeRemapBrowserSourceV1(source); if (!hash(ffmpegSha256)) throw Error("CLOCK_BROWSER_SURFACE_TOOL_SHA_REQUIRED");
  return createHash("sha256").update(canonicalJson({ policy: TIME_REMAP_BROWSER_SURFACE_POLICY_V1, source, ffmpegSha256 })).digest("hex");
}

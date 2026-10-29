import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { rationalRate, floorFrameRateSampleIndex } from "../domain/clipAlphaPlan";
import { runAnalysisProcess } from "./analysisProcess";

export function subjectOverlayClockV1(projectFps: number, nativeFps: number, nativeFrames: number, frames: number) {
  if (!Number.isFinite(projectFps) || projectFps < 1 || projectFps > 240 || !Number.isFinite(nativeFps) || nativeFps < 1 || nativeFps > 60
    || !Number.isSafeInteger(nativeFrames) || nativeFrames < 1 || nativeFrames > 1440 || !Number.isSafeInteger(frames) || frames < 1 || frames > 28800
    || Math.abs(nativeFrames / nativeFps - frames / projectFps) > 1e-7) throw Error("SUBJECT_OVERLAY_VERIFICATION_CLOCK");
  return { project: rationalRate(projectFps), native: rationalRate(nativeFps), nativeFrames, frames };
}
type Clock = ReturnType<typeof subjectOverlayClockV1>;
export async function readSubjectOverlayNativeDigestsV1(path: string, frameBytes: number, clock: Clock, check: () => void) {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 256 || frameBytes > 2073600 * 2) throw Error("SUBJECT_OVERLAY_NATIVE_FRAME_BYTES");
  const file = await open(path, "r"), buffer = Buffer.alloc(frameBytes), sequence = createHash("sha256"), digests: string[] = [];
  try {
    check(); if ((await file.stat()).size !== frameBytes * clock.nativeFrames) throw Error("SUBJECT_OVERLAY_NATIVE_SEQUENCE_BYTES");
    for (let frame = 0; frame < clock.nativeFrames; frame++) {
      let read = 0; while (read < frameBytes) { check(); const part = await file.read(buffer, read, frameBytes - read, frame * frameBytes + read); if (!part.bytesRead) throw Error("SUBJECT_OVERLAY_NATIVE_SEQUENCE_TRUNCATED"); read += part.bytesRead; }
      sequence.update(buffer); digests.push(createHash("sha256").update(buffer).digest("hex"));
    }
    check(); if ((await file.stat()).size !== frameBytes * clock.nativeFrames) throw Error("SUBJECT_OVERLAY_NATIVE_SEQUENCE_CHANGED");
    return { digests, sequenceSha256: sequence.digest("hex"), frameBytes, frames: clock.nativeFrames };
  } finally { await file.close(); }
}
/** One SHA256 framehash muxer with stream0 native alpha and stream1 target pixels.
 * Digests are bounded; no raw image sequence is accumulated. */
export function createSubjectOverlayFrameHashVerifierV1(clock: Clock, nativeDigests: readonly string[], nativeFrameBytes: number, outputFrameBytes: number) {
  if (nativeDigests.length !== clock.nativeFrames || nativeDigests.some(d => !/^[a-f0-9]{64}$/u.test(d))
    || ![nativeFrameBytes, outputFrameBytes].every(v => Number.isSafeInteger(v) && v >= 256 && v <= 2073600 * 8)) throw Error("SUBJECT_OVERLAY_HASH_EXPECTATIONS");
  let pending = "", bytes = 0, header = false, finished = false; const counts = [0, 0], pixels: string[] = [], nativeMap = createHash("sha256"), pixelMap = createHash("sha256");
  const row = (line: string) => {
    const text = line.trim(); if (!text) return;
    if (text.startsWith("#")) { if (text === "#hash: SHA256") header = true; return; }
    const fields = text.split(",").map(v => v.trim()), stream = Number(fields[0]);
    if (!header || fields.length !== 6 || ![0, 1].includes(stream) || !/^[a-f0-9]{64}$/u.test(fields[5])) throw Error("SUBJECT_OVERLAY_FRAMEHASH_FORMAT");
    const frame = counts[stream];
    if (frame >= clock.frames || Number(fields[1]) !== frame || Number(fields[2]) !== frame || fields[3] !== "1" || Number(fields[4]) !== (stream === 0 ? nativeFrameBytes : outputFrameBytes)) throw Error("SUBJECT_OVERLAY_FRAMEHASH_ORDER_OR_BYTES");
    if (stream === 0) { const index = floorFrameRateSampleIndex(frame, clock.project, clock.native, clock.nativeFrames);
      if (fields[5] !== nativeDigests[index]) throw Error("SUBJECT_OVERLAY_NATIVE_FLOOR_OR_PRECISION_CHANGED"); nativeMap.update(`${frame}:${index}:${fields[5]}\n`);
    } else { pixels.push(fields[5]); pixelMap.update(fields[5] + "\n"); }
    counts[stream]++;
  };
  return {
    write(chunk: Buffer) {
      if (finished) throw Error("SUBJECT_OVERLAY_FRAMEHASH_CLOSED"); bytes += chunk.length;
      if (bytes > clock.frames * 280 + 16384) throw Error("SUBJECT_OVERLAY_FRAMEHASH_BUDGET");
      pending += chunk.toString("utf8"); let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { row(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 1024) throw Error("SUBJECT_OVERLAY_FRAMEHASH_LINE_BUDGET");
    },
    finish() {
      if (finished) throw Error("SUBJECT_OVERLAY_FRAMEHASH_CLOSED"); finished = true; if (pending.trim()) row(pending);
      if (!header || counts[0] !== clock.frames || counts[1] !== clock.frames) throw Error("SUBJECT_OVERLAY_FRAMEHASH_COUNT");
      return { pixelDigests: pixels, mappedNativeFrames: counts[0], targetPixelFrames: counts[1], nativeMapSha256: nativeMap.digest("hex"), targetPixelMapSha256: pixelMap.digest("hex"), stdoutBytes: bytes };
    },
  };
}
/** Decode one frame buffer, compare to the exact pre-encoder pixel digest and wait
 * for child close. This proves conservation/count, never subject or artistic quality. */
export async function verifySubjectOverlayDecodedPixelsV1(path: string, executable: string, pixelFormat: "bgra" | "gbrap16le", frameBytes: number,
  expected: readonly string[], runtime: { signal?: AbortSignal; check(): number }) {
  if (!expected.length || expected.length > 28800 || expected.some(d => !/^[a-f0-9]{64}$/u.test(d)) || !Number.isSafeInteger(frameBytes) || frameBytes < 1024 || frameBytes > 2073600 * 8) throw Error("SUBJECT_OVERLAY_DECODE_EXPECTATIONS");
  const frame = Buffer.alloc(frameBytes), full = createHash("sha256"); let filled = 0, count = 0, bytes = 0;
  await runAnalysisProcess(executable, ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm", "-i", path,
    "-map", "0:v:0", "-an", "-frames:v", String(expected.length + 1), "-threads", "1", "-pix_fmt", pixelFormat, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"],
  { signal: runtime.signal, timeoutMs: runtime.check(), label: "SUBJECT_OVERLAY_LOSSLESS_DECODE_VERIFY", maximumStdout: expected.length * frameBytes, maximumStderr: 65536, captureStdout: false,
    onStdout: chunk => { bytes += chunk.length; let offset = 0;
      while (offset < chunk.length) { runtime.check(); if (count >= expected.length) throw Error("SUBJECT_OVERLAY_EXTRA_DECODED_FRAME");
        const size = Math.min(frameBytes - filled, chunk.length - offset); chunk.copy(frame, filled, offset, offset + size); filled += size; offset += size;
        if (filled === frameBytes) { if (createHash("sha256").update(frame).digest("hex") !== expected[count]) throw Error("SUBJECT_OVERLAY_LOSSLESS_PIXELS_CHANGED"); full.update(frame); filled = 0; count++; }
      }
    } });
  runtime.check(); if (filled || count !== expected.length || bytes !== frameBytes * expected.length) throw Error("SUBJECT_OVERLAY_DECODED_COUNT_OR_BYTES");
  return { frames: count, bytes, decodedPixelsSha256: full.digest("hex"), oneFrameBufferBytes: frameBytes, wholeMovieRawFilesWritten: 0 as const, exactEncodedDecodedPixels: true as const };
}

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { floorFrameRateSampleIndex, rationalRate, type RationalRate } from "../domain/clipAlphaPlan";

export interface SubjectSheenClockV1 { projectRate: RationalRate; sampleRate: RationalRate; sampleCount: number; startFrame: number; frameCount: number; }
export function subjectSheenClockV1(projectFps: number, sampleFps: number, sampleCount: number, startFrame: number, frameCount: number): SubjectSheenClockV1 {
  if (!Number.isFinite(projectFps) || projectFps < 1 || projectFps > 240 || !Number.isFinite(sampleFps) || sampleFps < 1 || sampleFps > 60
    || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 1440 || !Number.isSafeInteger(startFrame) || startFrame < 0
    || !Number.isSafeInteger(frameCount) || frameCount < 3 || frameCount > 240 || startFrame + frameCount > Math.ceil(sampleCount / sampleFps * projectFps - 1e-9)) throw Error("SHEEN_SAMPLE_CLOCK_BUDGET");
  const projectRate = rationalRate(projectFps), sampleRate = rationalRate(sampleFps);
  for (const [rate, value] of [[projectRate, projectFps], [sampleRate, sampleFps]] as const) if (Math.abs(rate.numerator / rate.denominator - value) > value * 1e-9) throw Error("SHEEN_UNREPRESENTABLE_RATE");
  return { projectRate, sampleRate, sampleCount, startFrame, frameCount };
}
export function subjectSheenSampleV1(clock: SubjectSheenClockV1, outputFrame: number) {
  if (!Number.isSafeInteger(outputFrame) || outputFrame < 0 || outputFrame >= clock.frameCount) throw Error("SHEEN_OUTPUT_FRAME_ORDER");
  return floorFrameRateSampleIndex(clock.startFrame + outputFrame, clock.projectRate, clock.sampleRate, clock.sampleCount);
}
/** One native alpha buffer and at most240 digest rows. Never stores a raw sequence. */
export async function expectedSubjectSheenFrameHashesV1(path: string, frameBytes: number, clock: SubjectSheenClockV1, check: () => void) {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 256 || frameBytes > 2073600 * 2) throw Error("SHEEN_ALPHA_FRAME_BYTES");
  const file = await open(path, "r"), buffer = Buffer.alloc(frameBytes), result: { frame: number; sourceSample: number; sha256: string }[] = [];
  try {
    check(); if ((await file.stat()).size !== frameBytes * clock.sampleCount) throw Error("SHEEN_ALPHA_SOURCE_BYTES");
    let previous = -1, digest = "";
    for (let frame = 0; frame < clock.frameCount; frame++) {
      check(); const sourceSample = subjectSheenSampleV1(clock, frame);
      if (sourceSample !== previous) {
        let read = 0;
        while (read < frameBytes) { check(); const part = await file.read(buffer, read, frameBytes - read, sourceSample * frameBytes + read);
          if (!part.bytesRead) throw Error("SHEEN_ALPHA_SOURCE_TRUNCATED"); read += part.bytesRead; }
        digest = createHash("sha256").update(buffer).digest("hex"); previous = sourceSample;
      }
      result.push({ frame, sourceSample, sha256: digest });
    }
    check(); if ((await file.stat()).size !== frameBytes * clock.sampleCount) throw Error("SHEEN_ALPHA_SOURCE_CHANGED"); return result;
  } finally { await file.close(); }
}
export function verifySubjectSheenFrameHashesV1(text: string, expected: { frame: number; sourceSample: number; sha256: string }[], frameBytes: number) {
  if (text.length > 65536 || !text.includes("#hash: SHA256")) throw Error("SHEEN_FRAMEHASH_FORMAT");
  const lines = text.split(/\r?\n/u).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  if (lines.length !== expected.length) throw Error("SHEEN_FRAMEHASH_COUNT");
  return lines.map((line, index) => {
    const fields = line.split(",").map(s => s.trim()), row = expected[index];
    if (fields.length !== 6 || fields[0] !== "0" || Number(fields[1]) !== index || Number(fields[2]) !== index || fields[3] !== "1"
      || Number(fields[4]) !== frameBytes || !/^[a-f0-9]{64}$/u.test(fields[5]) || fields[5] !== row.sha256 || row.frame !== index) throw Error("SHEEN_FRAMEHASH_FLOOR_OR_PRECISION_MISMATCH");
    return { frame: index, sourceSample: row.sourceSample, sha256: fields[5], bytes: frameBytes };
  });
}

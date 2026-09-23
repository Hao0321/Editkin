import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { ArtifactIdentity, DecodedMatrixSample, FileIdentity, MatrixSamplePhase } from "./cinematic-decoded-matrix-gate";

export const MATRIX_WIDTH = 320;
export const MATRIX_HEIGHT = 180;
export const MATRIX_FPS = 60;
const FRAME_BYTES = MATRIX_WIDTH * MATRIX_HEIGHT * 3;
const FEATURE_GRID = 4;

export interface SampleRequest {
  phase: MatrixSamplePhase;
  localFrame: number;
  globalFrame: number;
}

interface ProcessOutput {
  stdout: Buffer;
  stderr: string;
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

async function run(executable: string, args: string[], timeoutMs: number, maxStdoutBytes = 64 * 1024 * 1024): Promise<ProcessOutput> {
  return new Promise<ProcessOutput>((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let timedOut = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill();
        fail(new Error(`process stdout exceeded ${maxStdoutBytes} bytes: ${executable}`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timedOut) fail(new Error(`process timed out after ${timeoutMs}ms: ${executable}`));
      else if (code !== 0) fail(new Error(`${executable} exited ${code}: ${stderrText.slice(-4_000)}`));
      else {
        settled = true;
        resolvePromise({ stdout: Buffer.concat(stdout), stderr: stderrText });
      }
    });
  });
}

export async function collectFileIdentity(path: string, appRoot: string): Promise<FileIdentity> {
  const bytes = await readFile(path);
  return {
    path: posix(relative(appRoot, path)),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function ratio(value: string | undefined): number {
  const [numerator, denominator] = String(value ?? "0/1").split("/").map(Number);
  return denominator ? numerator / denominator : 0;
}

export async function collectArtifactIdentity(path: string, appRoot: string, ffprobePath: string): Promise<ArtifactIdentity> {
  const identity = await collectFileIdentity(path, appRoot);
  const output = await run(ffprobePath, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration",
    "-of", "json", path,
  ], 30_000, 2 * 1024 * 1024);
  const probe = JSON.parse(output.stdout.toString("utf8")) as {
    streams?: Array<Record<string, string | number>>;
    format?: { duration?: string };
  };
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  return {
    ...identity,
    codecName: String(video?.codec_name ?? ""),
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: ratio(String(video?.r_frame_rate ?? "0/1")),
    frameCount: Number(video?.nb_read_frames ?? 0),
    duration: Number(probe.format?.duration ?? 0),
    hasAudio: Boolean(audio),
  };
}

export async function decodeMatrixFrames(path: string, indices: number[], ffmpegPath: string): Promise<Map<number, Buffer>> {
  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  const selection = sorted.map((index) => `eq(n\\,${index})`).join("+");
  const output = await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", `select=${selection}`, "-fps_mode", "passthrough", "-an",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], 60_000, sorted.length * FRAME_BYTES + FRAME_BYTES);
  if (output.stdout.length !== sorted.length * FRAME_BYTES) {
    throw new Error(`decoded frame count mismatch for ${path}: ${output.stdout.length} / ${sorted.length * FRAME_BYTES}`);
  }
  return new Map(sorted.map((frame, index) => [frame, output.stdout.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES)]));
}

function frameSha256(frame: Buffer): string {
  return createHash("sha256").update(frame).digest("hex");
}

function featureVector(frame: Buffer): number[] {
  const sums = new Float64Array(FEATURE_GRID * FEATURE_GRID * 3);
  const counts = new Uint32Array(FEATURE_GRID * FEATURE_GRID);
  for (let y = 0; y < MATRIX_HEIGHT; y += 1) {
    const tileY = Math.min(FEATURE_GRID - 1, Math.floor(y * FEATURE_GRID / MATRIX_HEIGHT));
    for (let x = 0; x < MATRIX_WIDTH; x += 1) {
      const tileX = Math.min(FEATURE_GRID - 1, Math.floor(x * FEATURE_GRID / MATRIX_WIDTH));
      const tile = tileY * FEATURE_GRID + tileX;
      const pixel = (y * MATRIX_WIDTH + x) * 3;
      counts[tile] += 1;
      sums[tile * 3] += frame[pixel];
      sums[tile * 3 + 1] += frame[pixel + 1];
      sums[tile * 3 + 2] += frame[pixel + 2];
    }
  }
  return [...sums].map((sum, index) => Number((sum / counts[Math.floor(index / 3)]).toFixed(4)));
}

export function buildDecodedSample(request: SampleRequest, baseline: Buffer, candidate: Buffer): DecodedMatrixSample {
  let absoluteDifference = 0;
  let changedPixels = 0;
  for (let index = 0; index < baseline.length; index += 3) {
    const red = Math.abs(candidate[index] - baseline[index]);
    const green = Math.abs(candidate[index + 1] - baseline[index + 1]);
    const blue = Math.abs(candidate[index + 2] - baseline[index + 2]);
    absoluteDifference += red + green + blue;
    if (Math.max(red, green, blue) > 2) changedPixels += 1;
  }
  const baselineFeatures = featureVector(baseline);
  const candidateFeatures = featureVector(candidate);
  return {
    phase: request.phase,
    localFrame: request.localFrame,
    baselineSha256: frameSha256(baseline),
    candidateSha256: frameSha256(candidate),
    meanAbsoluteError: Number((absoluteDifference / baseline.length).toFixed(6)),
    changedPixelRatio: Number((changedPixels / (MATRIX_WIDTH * MATRIX_HEIGHT)).toFixed(8)),
    deltaFeatures: candidateFeatures.map((value, index) => Number((value - baselineFeatures[index]).toFixed(4))),
  };
}

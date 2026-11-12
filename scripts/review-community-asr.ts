import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { analyzeAutomaticCaptionTranscript, inspectAutomaticCaptionReadiness, PINNED_WHISPER_MODEL } from "../src/application/automaticCaptions";

const [portableRoot, sourcePath] = process.argv.slice(2);
if (!portableRoot || !sourcePath) throw Error("Usage: tsx scripts/review-community-asr.ts <portable-folder> <speech-audio>");
const ffmpegLookup = spawnSync("where.exe", ["ffmpeg.exe"], { encoding: "utf8", windowsHide: true });
assert.equal(ffmpegLookup.status, 0, "FFmpeg is unavailable on PATH");
const runtimeRoot = resolve(portableRoot, "resources/runtime");
const runtime = {
  ffmpegPath: ffmpegLookup.stdout.split(/\r?\n/u).find(Boolean)!,
  whisperCliPath: join(runtimeRoot, "whisper-cli.exe"),
  modelRoot: join(runtimeRoot, "models"),
  modelPath: join(runtimeRoot, "models", PINNED_WHISPER_MODEL.fileName),
};
const readiness = await inspectAutomaticCaptionReadiness(runtime);
assert.equal(readiness.status, "ready", readiness.message);
const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourcePath], { encoding: "utf8", windowsHide: true });
assert.equal(probe.status, 0, probe.stderr);
const duration = Number(probe.stdout.trim());
assert(Number.isFinite(duration) && duration > 0 && duration <= 60, "speech sample must be <= 60 seconds");
const result = await analyzeAutomaticCaptionTranscript({ sourcePath: resolve(sourcePath), sourceStart: 0, duration, language: "zh" }, runtime);
assert.equal(result.recognition.status, "usable-cues");
assert(result.cues.some((cue) => /[\u4e00-\u9fff]/u.test(cue.text)), "recognizer produced no Chinese speech cue");
assert.equal(result.modelDownloaded, false);
process.stdout.write(`${JSON.stringify({ status: "PASS", readiness: readiness.status, engine: result.engine, modelSha256: result.modelSha256, cues: result.cues, elapsedMs: result.elapsedMs })}\n`);

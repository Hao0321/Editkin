import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { PINNED_WHISPER_MODEL, transcribeAutomaticCaptions } from "../src/application/automaticCaptions";

const root = resolve(import.meta.dirname, "..");
const ffmpegPath = process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const whisperCliPath = process.env.EDITKIN_WHISPER_CLI_PATH ?? resolve(root, "vendor/whisper/win32-x64/whisper-cli.exe");
const modelRoot = process.env.EDITKIN_MODEL_ROOT ?? resolve(root, "../../.rd/models/whisper");
const cacheBase = resolve(root, "../../.rd/cache");
const evidencePath = resolve(root, "../../.rd/benchmarks/editkin-automatic-captions-integration.json");
const sourcePath = resolve(root, "../../.rd/fixtures/editkin-caption-ground-truth.wav");
const groundTruth = "Editkin turns speech into captions automatically.";

await access(ffmpegPath);
await access(whisperCliPath);
await mkdir(dirname(sourcePath), { recursive: true });
try { await access(sourcePath); } catch {
  await promisify(execFile)(ffmpegPath, [
    "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", `flite=text='${groundTruth}':voice=slt`,
    "-ar", "16000", "-ac", "1", sourcePath,
  ], { windowsHide: true, timeout: 60_000 });
}
const duration = 8;
const request = { sourcePath, sourceStart: 0, duration, language: "en" };
await mkdir(cacheBase, { recursive: true });
const cacheRoot = await mkdtemp(join(cacheBase, "editkin-caption-integration-"));
try {
  const runtime = { ffmpegPath, whisperCliPath, modelRoot, cacheRoot };
  const first = await transcribeAutomaticCaptions(request, runtime);
  if (!first.cues.length || first.modelSha256 !== PINNED_WHISPER_MODEL.sha256 || first.cacheHit || !first.engine.startsWith("whisper-cli-")) {
    throw new Error("首次本機字幕轉錄沒有產生有效、固定模型的非快取結果");
  }
  const second = await transcribeAutomaticCaptions(request, runtime);
  if (!second.cacheHit || JSON.stringify(second.cues) !== JSON.stringify(first.cues)) {
    throw new Error("字幕快取未命中或改變了 cue 結果");
  }
  const bilingual = await transcribeAutomaticCaptions({ ...request, language: "auto", translationTarget: "en" }, runtime);
  if (!bilingual.cues.length || bilingual.cues.some((cue) => !cue.translation?.text.trim()) || bilingual.translationTarget !== "en") {
    throw new Error("本機雙語字幕沒有產生完整的原文＋英文 cue");
  }
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "GREEN",
    source: ".rd/fixtures/editkin-caption-ground-truth.wav",
    groundTruth,
    duration,
    cueCount: first.cues.length,
    cues: first.cues,
    engine: first.engine,
    whisperCliFallbackVerified: first.engine.startsWith("whisper-cli-"),
    acceleration: first.acceleration,
    modelId: first.modelId,
    modelSha256: first.modelSha256,
    modelDownloaded: first.modelDownloaded,
    firstElapsedMs: first.elapsedMs,
    warmCacheElapsedMs: second.elapsedMs,
    warmCacheHit: second.cacheHit,
    bilingualCueCount: bilingual.cues.length,
    bilingualEngine: bilingual.engine,
    bilingualComplete: bilingual.cues.every((cue) => Boolean(cue.translation?.text.trim())),
    bilingualElapsedMs: bilingual.elapsedMs,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally { await rm(cacheRoot, { recursive: true, force: true }); }

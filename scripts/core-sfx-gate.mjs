import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packRoot = resolve(root, ".creative-packs/hao-creator-library");
const manifest = JSON.parse(await readFile(resolve(packRoot, "editkin-pack.json"), "utf8"));
const ffprobe = resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const required = new Map([
  ["sfx:editkin-whoosh-01", "transition-whoosh"],
  ["sfx:editkin-impact-01", "payoff-impact"],
  ["sfx:editkin-countdown-01", "countdown-tick"],
  ["sfx:editkin-reveal-01", "reveal-spark"],
]);
const results = [];
for (const [id, role] of required) {
  const asset = manifest.assets.find((item) => item.id === id);
  if (!asset || asset.category !== "sfx" || asset.role !== role || asset.mediaKind !== "audio" || asset.license !== "CC-BY-4.0") throw new Error(`Core SFX metadata 缺失：${id}`);
  const path = resolve(packRoot, asset.path);
  const info = await stat(path);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (info.size !== asset.bytes || digest !== asset.sha256) throw new Error(`Core SFX hash/bytes 不一致：${id}`);
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type,sample_rate,channels", "-of", "json", path], { windowsHide: true, timeout: 20_000 });
  const probe = JSON.parse(stdout);
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration ?? 0);
  if (!audio || duration <= 0 || Number(audio.sample_rate) !== 48000 || Number(audio.channels) !== 2) throw new Error(`Core SFX 解碼規格不符：${id}`);
  results.push({ id, role, bytes: info.size, sha256: digest, duration, sampleRate: Number(audio.sample_rate), channels: Number(audio.channels) });
}
process.stdout.write(`${JSON.stringify({ status: "GREEN", requiredCount: required.size, decodedCount: results.length, assets: results })}\n`);

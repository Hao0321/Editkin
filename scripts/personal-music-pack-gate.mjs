import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packRoot = resolve(root, ".personal-packs/hao-music-library");
const manifestPath = resolve(packRoot, "editkin-personal-music.json");
const ffprobe = process.env.HAO_FFPROBE_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffprobe.exe");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const findings = [];
const fail = (code, message) => findings.push({ status: "FAIL", code, message });

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function probe(path) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectProbe);
    child.once("close", (code) => code === 0 ? resolveProbe(JSON.parse(stdout)) : rejectProbe(new Error(stderr || `ffprobe exit ${code}`)));
  });
}

if (manifest.schemaVersion !== 2 || manifest.id !== "studio.hao.personal-music-library") fail("manifest-identity", "Community Music Pack identity 不合法");
if (manifest.distributionScope !== "community-redistributable" || manifest.redistributable !== true
  || manifest.provenanceAudit?.status !== "owner_attested_ai_generated" || manifest.provenanceAudit?.publicExportAllowed !== true
  || manifest.provenanceAudit?.attestationId !== "owner-attestation-2026-08-22") fail("redistribution-attestation", "Community Music Pack 缺少權利人散布聲明");
if (manifest.provenanceAudit?.independentPlatformTermsVerified !== false) fail("provenance-claim-boundary", "不得把權利人聲明冒充平台條款獨立驗證");
const licensePath = resolve(packRoot, String(manifest.licenseFile ?? ""));
if (!licensePath.startsWith(`${packRoot}${sep}`)) fail("license-path", "Community grant path 離開 pack root");
else {
  try { if (await sha256(licensePath) !== manifest.licenseSha256) fail("license-sha256", "Community grant hash 不符"); }
  catch (error) { fail("license-read", error instanceof Error ? error.message : String(error)); }
}
if (!Array.isArray(manifest.assets) || manifest.assets.length !== 175 || manifest.assetCount !== 175) fail("asset-count", `預期 175 首，實際 ${manifest.assets?.length ?? 0}`);
const ids = new Set();
let bytes = 0;
let decoded = 0;
let verified = 0;
for (const asset of manifest.assets ?? []) {
  if (!asset.id?.startsWith("music:") || ids.has(asset.id)) { fail("asset-id", `素材 id 無效或重複：${asset.id}`); continue; }
  ids.add(asset.id);
  if (asset.license !== "HAO-COMMUNITY-ASSET-GRANT-1.0" || asset.rightsBasis !== "owner-attestation-2026-08-22" || asset.redistributable !== true || asset.mediaKind !== "audio") fail("asset-scope", `素材散布 metadata 不合法：${asset.id}`);
  if (!asset.path || isAbsolute(asset.path) || asset.path.split(/[\\/]+/).includes("..")) { fail("asset-path", `素材路徑不安全：${asset.id}`); continue; }
  const absolute = resolve(packRoot, asset.path.replaceAll("/", sep));
  if (!absolute.startsWith(`${packRoot}${sep}`)) { fail("asset-escape", `素材離開 pack root：${asset.id}`); continue; }
  try {
    const info = await stat(absolute);
    bytes += info.size;
    if (!info.isFile() || info.size !== asset.bytes) fail("asset-bytes", `素材大小不符：${asset.id}`);
    else if (await sha256(absolute) !== asset.sha256) fail("asset-sha256", `素材 hash 不符：${asset.id}`);
    else verified += 1;
    const media = await probe(absolute);
    const stream = media.streams?.[0];
    if (stream?.codec_name !== "aac" || Number(stream.sample_rate) !== 48000 || Number(stream.channels) !== 2 || Number(media.format?.duration) <= 0) fail("asset-decode", `素材不可按 pack contract 解碼：${asset.id}`);
    else decoded += 1;
  } catch (error) { fail("asset-read", `${asset.id}: ${error instanceof Error ? error.message : String(error)}`); }
}
if (bytes !== manifest.assetBytes) fail("asset-total-bytes", `assetBytes 不一致：${bytes} != ${manifest.assetBytes}`);
const categories = new Set((manifest.assets ?? []).map((asset) => asset.category));
if (categories.size !== 16) fail("category-count", `預期 16 個情境分類，實際 ${categories.size}`);
const report = {
  schemaVersion: 1, status: findings.length ? "BLOCK" : "GREEN", productVersion: manifest.version,
  pack: { assetCount: manifest.assetCount, assetBytes: manifest.assetBytes, categories: categories.size, verified, decoded, redistribution: "community-redistributable", rightsBasis: manifest.provenanceAudit?.attestationId },
  findings: findings.length ? findings : [{ status: "PASS", code: "community-music-pack", message: "175 首音樂已逐檔 hash、AAC 解碼，並綁定 Hao 2026-08-22 社群散布聲明。" }],
};
const evidence = resolve(root, `../../.rd/benchmarks/editkin-personal-music-pack-${manifest.version}.json`);
await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, evidence })}\n`);
if (report.status !== "GREEN") process.exitCode = 1;

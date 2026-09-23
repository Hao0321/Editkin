import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "../../assets/bgm");
const outputRoot = resolve(root, ".personal-packs/hao-music-library");
const assetRoot = resolve(outputRoot, "assets");
const manifestPath = resolve(outputRoot, "editkin-personal-music.json");
const grantPath = resolve(outputRoot, "COMMUNITY-ASSET-GRANT.md");
const ffmpeg = process.env.HAO_FFMPEG_PATH ?? resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function run(executable, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`FFmpeg personal music encode failed (${code}): ${stderr}`)));
  });
}

async function indices() {
  const categories = (await readdir(sourceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  const rows = [];
  for (const category of categories) {
    const indexPath = join(sourceRoot, category.name, "bgm_index.json");
    if (!await exists(indexPath)) continue;
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    for (const track of index.tracks ?? []) {
      const sourcePath = resolve(sourceRoot, category.name, String(track.file));
      if (!sourcePath.startsWith(`${resolve(sourceRoot)}\\`) && !sourcePath.startsWith(`${resolve(sourceRoot)}/`)) throw new Error("BGM path escaped source root");
      rows.push({ category: category.name, track, sourcePath, relativeSource: relative(sourceRoot, sourcePath).replaceAll("\\", "/") });
    }
  }
  return rows;
}

await Promise.all([access(sourceRoot), access(ffmpeg), access(grantPath), mkdir(assetRoot, { recursive: true })]);
let previous = { assets: [] };
try { previous = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* first build */ }
const previousById = new Map((previous.assets ?? []).map((asset) => [asset.id, asset]));
const sourceRows = await indices();
const tasks = sourceRows.map((row, order) => async () => {
  const sourceInfo = await stat(row.sourcePath);
  const id = `music:${createHash("sha256").update(row.relativeSource).digest("hex").slice(0, 20)}`;
  const destinationName = `${id.slice("music:".length)}.m4a`;
  const destination = resolve(assetRoot, destinationName);
  const old = previousById.get(id);
  let encoded = false;
  if (!(old && old.sourceIdentity?.bytes === sourceInfo.size && old.sourceIdentity?.modifiedMs === sourceInfo.mtimeMs && await exists(destination))) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp.m4a`;
    try {
      await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", row.sourcePath, "-map_metadata", "-1", "-vn", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", temporary]);
      await rm(destination, { force: true });
      await rename(temporary, destination);
      encoded = true;
    } finally { await rm(temporary, { force: true }); }
  }
  const outputInfo = await stat(destination);
  const outputSha256 = !encoded && old?.sha256 && old.bytes === outputInfo.size ? old.sha256 : await sha256(destination);
  return {
    id, name: String(row.track.file).replace(new RegExp(`${extname(row.track.file).replace(".", "\\.")}$`, "i"), ""),
    category: row.category, role: "background-music", domains: [row.category, String(row.track.suggested_use ?? "general")],
    mediaKind: "audio", duration: Number(row.track.duration_sec), bpm: Number(row.track.bpm), energyDb: Number(row.track.rms_db),
    suggestedUse: String(row.track.suggested_use ?? "general/explain"), path: `assets/${destinationName}`, bytes: outputInfo.size, sha256: outputSha256,
    license: "HAO-COMMUNITY-ASSET-GRANT-1.0",
    provenance: "Hao0321 Studio owner attestation 2026-08-22: paid AI-generated media authorized for the free Editkin community pack",
    rightsBasis: "owner-attestation-2026-08-22", renderer: "audio-asset", redistributable: true,
    sourceIdentity: { bytes: sourceInfo.size, modifiedMs: sourceInfo.mtimeMs }, order,
  };
});

const assets = [];
const workers = Array.from({ length: Math.min(3, tasks.length) }, async () => {
  while (tasks.length) {
    const task = tasks.shift();
    if (task) assets.push(await task());
  }
});
await Promise.all(workers);
assets.sort((left, right) => left.order - right.order);
for (const asset of assets) delete asset.order;
const manifest = {
  schemaVersion: 2, id: "studio.hao.personal-music-library", name: "Hao 社群自動剪輯音樂庫", version: packageJson.version,
  attribution: "Hao0321 Studio — owner-authorized AI-generated community music pack",
  distributionScope: "community-redistributable", redistributable: true,
  provenanceAudit: {
    status: "owner_attested_ai_generated", publicExportAllowed: true,
    attestationId: "owner-attestation-2026-08-22", attestedBy: "Hao0321 Studio",
    attestedAt: "2026-08-22", basis: "user-stated-paid-ai-generation",
    independentPlatformTermsVerified: false,
  },
  licenseFile: "COMMUNITY-ASSET-GRANT.md", licenseSha256: await sha256(grantPath),
  encoding: { codec: "aac", bitrate: "128k", sampleRate: 48000, channels: 2 },
  assetCount: assets.length, assetBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0), assets,
};
const temporaryManifest = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await rm(manifestPath, { force: true });
await rename(temporaryManifest, manifestPath);
process.stdout.write(`${JSON.stringify({ status: assets.length === 175 ? "GREEN" : "BLOCK", outputRoot, assetCount: assets.length, assetBytes: manifest.assetBytes, sourceBytes: (await Promise.all(sourceRows.map((row) => stat(row.sourcePath)))).reduce((sum, item) => sum + item.size, 0) })}\n`);
if (assets.length !== 175) process.exitCode = 1;

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const REQUIRED_ROLES = new Set(["ffmpeg-source", "build-scripts"]);
const NON_EXTERNAL_FLAGS = new Set([
  "--enable-gpl", "--enable-version3", "--enable-static", "--enable-mediafoundation", "--enable-cuda-llvm",
  "--enable-cuvid", "--enable-dxva2", "--enable-d3d11va", "--enable-d3d12va", "--enable-nvdec", "--enable-nvenc", "--enable-vaapi",
]);

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function blocked(reason) { return { ready: false, reason }; }
const normalizedFlags = (flags) => [...new Set(flags)].sort();
const requiredExternalFlags = (flags) => normalizedFlags(flags.filter((flag) => flag.startsWith("--enable-") && !NON_EXTERNAL_FLAGS.has(flag)));

async function verifiedArchive(manifestRoot, item, label) {
  if (typeof item?.path !== "string" || isAbsolute(item.path) || !/\.(?:zip|7z|tar|tar\.xz|tar\.gz|tgz)$/i.test(item.path)) throw new Error(`invalid source archive path for ${label}`);
  if (!/^[a-f0-9]{64}$/i.test(item.sha256 ?? "")) throw new Error(`invalid source archive SHA-256 for ${label}`);
  const archivePath = await realpath(resolve(manifestRoot, item.path));
  const boundary = process.platform === "win32" ? `${manifestRoot.toLowerCase()}\\` : `${manifestRoot}/`;
  const candidate = process.platform === "win32" ? archivePath.toLowerCase() : archivePath;
  if (!candidate.startsWith(boundary)) throw new Error(`source archive escapes evidence directory: ${label}`);
  const info = await stat(archivePath);
  if (!info.isFile() || info.size < 1) throw new Error(`source archive is empty or not a file: ${label}`);
  const actualSha256 = await hashFile(archivePath);
  if (actualSha256 !== item.sha256.toLowerCase()) throw new Error(`source archive SHA-256 mismatch: ${label}`);
  return { path: item.path, bytes: info.size, sha256: actualSha256 };
}

export async function inspectFfmpegCorrespondingSource({ manifestPath, expectedBinarySha256, expectedBuild, expectedConfigurationFlags }) {
  let document;
  try { document = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { return blocked(`corresponding-source manifest unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (document.schemaVersion !== 2) return blocked("corresponding-source schemaVersion must be 2");
  if (document.binarySha256 !== expectedBinarySha256) return blocked("corresponding-source binary SHA-256 does not match bundled ffmpeg.exe");
  if (document.build !== expectedBuild) return blocked("corresponding-source build identifier does not match bundled FFmpeg");
  if (!/^[a-f0-9]{40}$/i.test(document.ffmpegCommit ?? "")) return blocked("corresponding-source FFmpeg commit must be a full 40-character commit");
  if (!Array.isArray(document.configurationFlags) || !document.configurationFlags.every((flag) => /^--(?:enable|disable)-[a-z0-9-]+$/i.test(flag))) return blocked("corresponding-source configurationFlags must be normalized FFmpeg flags");
  const actualFlags = normalizedFlags(document.configurationFlags);
  const expectedFlags = normalizedFlags(expectedConfigurationFlags ?? []);
  if (JSON.stringify(actualFlags) !== JSON.stringify(expectedFlags)) return blocked("corresponding-source configuration flags do not exactly match bundled FFmpeg");
  if (!Array.isArray(document.archives) || document.archives.length !== REQUIRED_ROLES.size) return blocked("corresponding-source must contain exact FFmpeg and build-script archives");
  const requiredFlags = requiredExternalFlags(actualFlags);
  if (!Array.isArray(document.externalSources) || document.externalSources.length !== requiredFlags.length) return blocked(`corresponding-source externalSources must cover ${requiredFlags.length} enabled external flags one by one`);
  let manifestRoot;
  try { manifestRoot = await realpath(dirname(manifestPath)); }
  catch (error) { return blocked(`corresponding-source root unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  const roles = new Set();
  const archives = [];
  const paths = new Set();
  try {
    for (const item of document.archives) {
      if (!REQUIRED_ROLES.has(item?.role) || roles.has(item.role)) throw new Error(`unexpected or duplicate source archive role: ${item?.role ?? "none"}`);
      const evidence = await verifiedArchive(manifestRoot, item, item.role);
      if (paths.has(evidence.path)) throw new Error(`duplicate source archive path: ${evidence.path}`);
      paths.add(evidence.path); roles.add(item.role); archives.push({ role: item.role, ...evidence });
    }
    for (const role of REQUIRED_ROLES) if (!roles.has(role)) throw new Error(`missing source archive role: ${role}`);
    const external = [];
    const coveredFlags = new Set();
    for (const item of document.externalSources) {
      if (!requiredFlags.includes(item?.flag) || coveredFlags.has(item.flag)) throw new Error(`unexpected or duplicate external source flag: ${item?.flag ?? "none"}`);
      if (typeof item.name !== "string" || !/^[a-z0-9][a-z0-9+._-]{1,80}$/i.test(item.name)) throw new Error(`invalid external source name for ${item.flag}`);
      if (typeof item.revision !== "string" || item.revision.trim().length < 7 || item.revision.length > 160) throw new Error(`missing exact revision for ${item.flag}`);
      const url = new URL(item.sourceUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`unsafe source URL for ${item.flag}`);
      const evidence = await verifiedArchive(manifestRoot, item.archive, item.flag);
      if (paths.has(evidence.path)) throw new Error(`source archive path reused across components: ${evidence.path}`);
      paths.add(evidence.path); coveredFlags.add(item.flag);
      external.push({ flag: item.flag, name: item.name, revision: item.revision, sourceUrl: item.sourceUrl, archive: evidence });
    }
    if (JSON.stringify([...coveredFlags].sort()) !== JSON.stringify(requiredFlags)) throw new Error("enabled external source flag coverage is incomplete");
    return { ready: true, manifestPath, ffmpegCommit: document.ffmpegCommit.toLowerCase(), configurationFlags: actualFlags, archives, externalSources: external };
  } catch (error) { return blocked(error instanceof Error ? error.message : String(error)); }
}

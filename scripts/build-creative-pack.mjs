import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { evaluateCreativePack } from "./lib/creative-pack-gate.mjs";
import { populateCreativePreviews } from "./lib/creative-preview-producer.mjs";
import { inventory, publishStage } from "./build-personal-visual-pack.mjs";
import { OWNER_VISUAL_GRANT, OWNER_VISUAL_LICENSE, validatePublicAssetRights, validatePublicGrant } from "../src/shared/visualAssetRights.mjs";

const appRoot = resolve(".");
const workspaceRoot = resolve(appRoot, "../..");
const outputRoot = resolve(appRoot, ".creative-packs/hao-creator-library");
const outputParent = dirname(outputRoot);
if (!outputRoot.startsWith(`${appRoot}${sep}`)) throw new Error(`Creative Pack target 離開 app root：${outputRoot}`);

const sourceManifestPath = resolve(workspaceRoot, "community/hao-motion-kit/PUBLIC_ASSET_MANIFEST.json");
const corePackPath = resolve(appRoot, "src/creative/haoCorePack.json");
const filterCatalogPath = resolve(workspaceRoot, "video-autopilot-kit/knowledge/runtime/filter_library.json");
const sourceLicense = resolve(workspaceRoot, "community/hao-motion-kit/ASSET_LICENSE.md");
const sourceNotice = resolve(workspaceRoot, "community/hao-motion-kit/NOTICE.md");
const publicSourceRoot = resolve(workspaceRoot, "community/hao-motion-kit");
const ownerGrantPath = resolve(publicSourceRoot, "OWNER_VISUAL_GRANT.json");
const ownerLicensePath = resolve(publicSourceRoot, "OWNER_VISUAL_BUNDLE_GRANT.md");

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function mediaKind(path) {
  const extension = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"].includes(extension)) return "image";
  if ([".wav", ".mp3", ".m4a", ".aac", ".flac"].includes(extension)) return "audio";
  return "video";
}

await mkdir(outputParent, { recursive: true });
const staging = await mkdtemp(resolve(outputParent, ".hao-creator-library-staging-"));
let promoted = false;
try {
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const corePack = JSON.parse(await readFile(corePackPath, "utf8"));
  const filterCatalog = JSON.parse(await readFile(filterCatalogPath, "utf8"));
  const ownerSources = OWNER_VISUAL_GRANT.assets.map((asset) => ({
    ...asset,
    asset_id: asset.id,
    path: `community/hao-motion-kit/${asset.sourcePath}`,
    license: OWNER_VISUAL_LICENSE,
    rightsBasis: OWNER_VISUAL_GRANT.id,
    distributionScope: "bundled-redistributable",
    redistributable: true,
  }));
  const sourceAssets = [...sourceManifest.assets, ...ownerSources].sort((a, b) => String(a.asset_id).localeCompare(String(b.asset_id)));
  const assets = [];
  const ids = new Set(), destinations = new Set();
  let totalBytes = 0;
  for (const source of sourceAssets) {
    if (ids.has(source.asset_id)) throw new Error(`重複的公開素材 ID：${source.asset_id}`);
    ids.add(source.asset_id);
    const input = resolve(workspaceRoot, String(source.path).replaceAll("/", sep));
    if (!input.startsWith(`${workspaceRoot}${sep}`)) throw new Error(`素材離開 workspace：${source.path}`);
    const sourceBase = await realpath(workspaceRoot), physicalInput = await realpath(input);
    if (!physicalInput.startsWith(`${sourceBase}${sep}`)) throw new Error(`素材實體路徑離開 workspace：${source.asset_id}`);
    const beforeInfo = await stat(physicalInput), beforeSha = await sha256(physicalInput);
    if (!beforeInfo.isFile()) throw new Error(`素材不是一般檔案：${source.asset_id}`);
    if (source.license === OWNER_VISUAL_LICENSE
      && (!physicalInput.startsWith(`${await realpath(publicSourceRoot)}${sep}`)
        || beforeInfo.size !== source.bytes || beforeSha !== source.sha256)) throw new Error(`已授權素材來源身分不符：${source.asset_id}`);
    const extension = extname(input).toLowerCase();
    const relative = `assets/${safeName(source.category)}/${safeName(source.asset_id)}${extension}`;
    if (destinations.has(relative.toLowerCase())) throw new Error(`公開素材目的路徑重複：${source.asset_id}`);
    destinations.add(relative.toLowerCase());
    const output = resolve(staging, relative.replaceAll("/", sep));
    await mkdir(dirname(output), { recursive: true });
    await copyFile(physicalInput, output, constants.COPYFILE_EXCL);
    const info = await stat(output);
    const digest = await sha256(output);
    if (info.size !== beforeInfo.size || digest !== beforeSha || await sha256(physicalInput) !== beforeSha) throw new Error(`素材複製身分不符：${source.asset_id}`);
    totalBytes += info.size;
    const asset = {
      id: source.asset_id,
      name: source.name ?? basename(input, extension).replaceAll("_", " "),
      category: source.category,
      role: source.role,
      domains: source.domains ?? [],
      mediaKind: mediaKind(output),
      path: relative,
      bytes: info.size,
      sha256: digest,
      license: source.license,
      provenance: source.provenance,
      renderer: "media-asset",
      ...(source.license === OWNER_VISUAL_LICENSE ? {
        rightsBasis: source.rightsBasis,
        distributionScope: source.distributionScope,
        redistributable: true,
        ...(source.duration !== undefined ? { duration: source.duration } : {}),
        ...(source.width !== undefined ? { width: source.width, height: source.height } : {}),
        ...(source.colorMetadata ? { colorMetadata: source.colorMetadata } : {}),
      } : {}),
    };
    validatePublicAssetRights(asset, OWNER_VISUAL_GRANT);
    assets.push(asset);
  }
  await mkdir(resolve(staging, "licenses"), { recursive: true });
  await copyFile(sourceLicense, resolve(staging, "licenses/CC-BY-4.0.md"));
  await copyFile(ownerLicensePath, resolve(staging, OWNER_VISUAL_GRANT.document.path), constants.COPYFILE_EXCL);
  const notice = await readFile(sourceNotice, "utf8");
  await writeFile(resolve(staging, "NOTICE.md"), `${notice}\n\n## Additional owner-authorized visual assets\n\nThis is a mixed-license library. Existing assets retain their individual licenses. The 63 owner-visual assets are licensed under ${OWNER_VISUAL_LICENSE}, not CC0 or CC-BY. Their bundled redistribution with Editkin and personal/commercial audiovisual use are owner-authorized; see licenses/OWNER_VISUAL_BUNDLE_GRANT.md and the hash-bound ownerVisualGrant in editkin-pack.json. No independent third-party rights review is claimed.\n`, { encoding: "utf8", flag: "wx" });
  const catalog = Object.fromEntries(Object.entries(filterCatalog.presets).sort(([a], [b]) => a.localeCompare(b)));
  const manifest = {
    ...corePack,
    license: "LicenseRef-Editkin-Creator-Library-Mixed-1.0",
    source: { ...corePack.source, publicAssetManifestSha256: await sha256(sourceManifestPath), filterCatalogSha256: await sha256(filterCatalogPath), ownerVisualGrantSha256: await sha256(ownerGrantPath) },
    ownerVisualGrant: structuredClone(OWNER_VISUAL_GRANT),
    assets,
    assetCount: assets.length,
    assetBytes: totalBytes,
    catalog: { filterLibraryId: filterCatalog.library_id, filterLibraryVersion: filterCatalog.version, filters: catalog },
    portability: { relativePathsOnly: true, privateWorkspaceEmbedded: false, originalPrivateReferencesEmbedded: false },
  };
  validatePublicGrant(manifest, { documentSha256: await sha256(resolve(staging, OWNER_VISUAL_GRANT.document.path)) });
  const manifestPath = resolve(staging, "editkin-pack.json");
  await populateCreativePreviews(staging, manifest, {
    ffmpeg: resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe"),
    ffprobe: resolve(appRoot, "vendor/ffmpeg/win32-x64/ffprobe.exe"),
    cacheRoots: [outputRoot],
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const report = evaluateCreativePack(manifest, { root: staging });
  if (report.status !== "GREEN") throw new Error(`Creative Pack gate 失敗：${JSON.stringify(report.findings.slice(0, 8))}`);

  // Keep the previous generated pack as a recoverable generation. Never rewrite
  // old product trials/receipts or delete the last asset pack during this change.
  const previous = resolve(outputParent, `.hao-creator-library-retained-${randomUUID()}`);
  let inPlacePromotion = false;
  try {
    await rename(outputRoot, previous);
  } catch (error) {
    if (error?.code === "ENOENT") { /* first install */ }
    else if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      const oldFiles = await inventory(outputRoot), newFiles = await inventory(staging);
      const nextPaths = new Set(newFiles.map(file => file.relative));
      if (oldFiles.some(file => !nextPaths.has(file.relative))) throw new Error("Locked public pack contains obsolete/unexpected files; preserved for explicit recovery");
      // Keep an exact rollback copy before touching the known generated root.
      await cp(outputRoot, previous, { recursive: true, force: false, errorOnExist: true });
      for (const file of oldFiles) {
        if (await sha256(file.path) !== await sha256(resolve(previous, file.relative))) throw new Error("Previous public pack backup mismatch");
      }
      inPlacePromotion = true;
    }
    else throw error;
  }
  try {
    if (inPlacePromotion) {
      // The manifest is the commit marker; every declared payload is copied and
      // checked first. Unknown paths were rejected above, never deleted.
      const files = await inventory(staging);
      for (const file of files.filter(file => file.relative !== "editkin-pack.json")) {
        const target = resolve(outputRoot, file.relative);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(file.path, target);
        if (await sha256(file.path) !== await sha256(target)) throw new Error("Public pack payload copy mismatch");
      }
      await copyFile(manifestPath, resolve(outputRoot, "editkin-pack.json"));
      const copiedManifest = JSON.parse(await readFile(resolve(outputRoot, "editkin-pack.json"), "utf8"));
      const copiedReport = evaluateCreativePack(copiedManifest, { root: outputRoot });
      if (copiedReport.status !== "GREEN") throw new Error(`Windows copy promotion 驗證失敗：${JSON.stringify(copiedReport.findings.slice(0, 8))}`);
    } else {
      await publishStage(staging, outputRoot, "editkin-pack.json");
      const copiedManifest = JSON.parse(await readFile(resolve(outputRoot, "editkin-pack.json"), "utf8"));
      const copiedReport = evaluateCreativePack(copiedManifest, { root: outputRoot });
      if (copiedReport.status !== "GREEN") throw new Error(`Public pack publication 驗證失敗：${JSON.stringify(copiedReport.findings.slice(0, 8))}`);
    }
    promoted = true;
  } catch (error) {
    if (!inPlacePromotion) {
      const failed = resolve(outputParent, `.hao-creator-library-failed-${randomUUID()}`);
      try { await rename(outputRoot, failed); } catch { /* retain partial root if locked */ }
      try { await rename(previous, outputRoot); } catch { /* retained exact backup remains recovery authority */ }
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN", outputRoot, retainedPrevious: previous, assets: assets.length, bytes: totalBytes, manifestSha256: await sha256(resolve(outputRoot, "editkin-pack.json")), counts: report.counts })}\n`);
} finally {
  if (!promoted) process.stderr.write(`Creative Pack failed stage retained: ${staging}\n`);
}

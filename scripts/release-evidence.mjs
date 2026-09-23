import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { arch, hostname, platform, release } from "node:os";
import { inspectAuthenticode } from "./lib/authenticode.mjs";
import { evaluateCreativePack } from "./lib/creative-pack-gate.mjs";
import { inspectFfmpegCorrespondingSource } from "./lib/ffmpeg-source-evidence.mjs";
import { inspectRuntimeProvenance } from "./lib/runtime-provenance.mjs";
import { inspectReleaseIdentity } from "./lib/release-identity.mjs";
import { inspectDistributionArtifacts } from "./lib/artifact-lifecycle.mjs";
import { validateSpdx } from "./lib/sbom.mjs";

const root = resolve(import.meta.dirname, "..");
const artifactRoot = resolve(root, "../../.rd/artifacts");
const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const relativePath = (path) => relative(root, path).replaceAll("\\", "/");

async function fileEvidence(path) {
  const info = await stat(path);
  return { path: relativePath(path), bytes: info.size, sha256: await sha256(path) };
}

function auditProduction() {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 })
    : spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, shell: process.platform === "win32" });
  try {
    const report = JSON.parse(result.stdout || result.stderr);
    return { status: result.status === 0 ? "GREEN" : "BLOCK", exitCode: result.status, vulnerabilities: report.metadata?.vulnerabilities ?? null };
  } catch { return { status: "ERROR", exitCode: result.status, reason: String(result.error?.message ?? result.stderr ?? result.stdout ?? "npm audit returned no output").slice(-2_000) }; }
}

const packageJson = await json("package.json");
const tauri = await json("src-tauri/tauri.conf.json");
if (packageJson.version !== tauri.version) throw new Error(`package/Tauri version drift: ${packageJson.version} / ${tauri.version}`);
const version = packageJson.version;
const nodeManifest = await json("vendor/node/win32-x64/manifest.json");
const buildNodeReceipt = await json(".build-node-receipt.json");
const releaseIdentity = await inspectReleaseIdentity(root);
const runtimeProvenance = await inspectRuntimeProvenance({
  packageJson,
  manifest: nodeManifest,
  nodePath: resolve(root, "vendor/node/win32-x64/node.exe"),
  licensePath: resolve(root, "vendor/node/win32-x64/NODE-LICENSE.txt"),
  buildReceipt: buildNodeReceipt,
});
const bundleRoot = resolve(root, "src-tauri/target/release/bundle/nsis");
const installers = (await readdir(bundleRoot)).filter((name) => name === `Editkin_${version}_x64-setup.exe`);
if (installers.length !== 1) throw new Error(`Expected exactly one Editkin ${version} x64 NSIS installer; found ${installers.length}`);
const installer = resolve(bundleRoot, installers[0]);
const executable = resolve(root, "src-tauri/target/release/editkin.exe");
const runtimePaths = [
  "vendor/node/win32-x64/node.exe", "vendor/ffmpeg/win32-x64/ffmpeg.exe", "vendor/ffmpeg/win32-x64/ffprobe.exe",
  "vendor/whisper/win32-x64/whisper-cli.exe", "vendor/whisper/win32-x64/whisper.dll", "vendor/whisper/win32-x64/ggml.dll", "vendor/whisper/win32-x64/ggml-base.dll", "vendor/whisper/win32-x64/ggml-cpu.dll",
  "native/bin/win32-x64/hao-core.exe", "desktop-dist/service.mjs", "desktop-dist/mcp.mjs", "desktop-dist/mcp.mjs.material-color-identity.json", "desktop-dist/remote.mjs",
].map((path) => resolve(root, path));
for (const path of [installer, executable, ...runtimePaths]) if (!await exists(path)) throw new Error(`Missing release input: ${path}`);

const created = new Date().toISOString();
const bundledSbomPath = resolve(root, "release/editkin.spdx.json");
const sbom = JSON.parse(await readFile(bundledSbomPath, "utf8"));
const sbomReport = validateSpdx(sbom, { productVersion: version });
const thirdPartyPackages = sbom.packages.filter((item) => item.SPDXID !== "SPDXRef-Editkin");
const sbomPath = resolve(artifactRoot, `editkin-${version}-windows-x64.spdx.json`);
await mkdir(artifactRoot, { recursive: true });
await writeFile(sbomPath, await readFile(bundledSbomPath));

const installerSignature = inspectAuthenticode(installer);
const executableSignature = inspectAuthenticode(executable);
const productLicense = process.env.EDITKIN_RELEASE_LICENSE_FILE ? resolve(process.env.EDITKIN_RELEASE_LICENSE_FILE) : undefined;
const updateManifestUrl = process.env.EDITKIN_UPDATE_MANIFEST_URL?.trim();
const publicUpdateChannelConfigured = (() => {
  if (!updateManifestUrl) return false;
  try {
    const url = new URL(updateManifestUrl);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
})();
const creativePackManifestPath = resolve(root, ".creative-packs/hao-creator-library/editkin-pack.json");
const creativePackRoot = dirname(creativePackManifestPath);
const creativePackManifest = JSON.parse(await readFile(creativePackManifestPath, "utf8"));
const creativePackReport = evaluateCreativePack(creativePackManifest, { root: creativePackRoot });
const creativePackArchivePath = resolve(artifactRoot, `Hao-Creator-Library-${version}.editkin-pack.zip`);
const creativePackArchive = await exists(creativePackArchivePath) ? await fileEvidence(creativePackArchivePath) : null;
const artifactLifecycle = creativePackArchive ? await inspectDistributionArtifacts({
  root,
  installerPath: installer,
  executablePath: executable,
  creativePackArchivePath,
  sourcePackRoot: creativePackRoot,
  sourcePersonalMusicPackRoot: resolve(root, ".personal-packs/hao-music-library"),
  sourceFontPackRoot: resolve(root, "public/fonts"),
}) : { status: "BLOCK", archive: { status: "BLOCK", findings: [{ code: "missing-archive" }] }, nsis: { status: "BLOCK", findings: [{ code: "not-inspected" }] }, findings: [{ surface: "creator-pack-archive", code: "missing-archive" }] };
const ffmpegBinaryPath = resolve(root, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const ffmpegVersion = spawnSync(ffmpegBinaryPath, ["-hide_banner", "-version"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
if (ffmpegVersion.status !== 0) throw new Error(`Cannot inspect bundled FFmpeg configuration: ${ffmpegVersion.stderr || ffmpegVersion.error?.message}`);
const ffmpegConfigurationFlags = (ffmpegVersion.stdout.match(/^configuration:\s*(.+)$/m)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
if (!ffmpegConfigurationFlags.length) throw new Error("Bundled FFmpeg did not report configuration flags");
const ffmpegSourceEvidence = await inspectFfmpegCorrespondingSource({
  manifestPath: resolve(root, "vendor/ffmpeg/win32-x64/corresponding-source.json"),
  expectedBinarySha256: (await fileEvidence(ffmpegBinaryPath)).sha256,
  expectedBuild: "8.0-full_build-www.gyan.dev",
  expectedConfigurationFlags: ffmpegConfigurationFlags,
});
const publicGates = {
  authenticodeInstaller: installerSignature.Status === "Valid",
  authenticodeExecutable: artifactLifecycle.nsis?.deliveredExecutable?.authenticode?.Status === "Valid",
  publicUpdateChannelConfigured,
  productLicenseSelected: Boolean(productLicense && await exists(productLicense)),
  exactFfmpegCorrespondingSourceRetained: ffmpegSourceEvidence.ready,
  completeThirdPartyLicenseAggregation: sbomReport.status === "GREEN" && thirdPartyPackages.every((item) => item.licenseDeclared !== "NOASSERTION"),
  creatorPackPortableAndRedistributable: creativePackReport.status === "GREEN" && artifactLifecycle.archive?.status === "GREEN",
};
const runtime = await Promise.all(runtimePaths.map(fileEvidence));
const productionAudit = auditProduction();
const internalGates = {
  releaseIdentity: releaseIdentity.status === "GREEN",
  buildAndBundledNodeProvenance: runtimeProvenance.status === "GREEN",
  productionDependencyAudit: productionAudit.status === "GREEN",
  dependencyInventoryAndNotices: sbomReport.status === "GREEN",
  creatorPackValidated: creativePackReport.status === "GREEN" && artifactLifecycle.archive?.status === "GREEN",
  distributionArtifactsClosedWorld: artifactLifecycle.status === "GREEN",
};
const internalGreen = Object.values(internalGates).every(Boolean);
const evidence = {
  status: !internalGreen ? "INTERNAL_RELEASE_BLOCKED" : Object.values(publicGates).every(Boolean) ? "PUBLIC_RELEASE_GREEN" : "INTERNAL_GREEN_PUBLIC_BLOCKED",
  product: { name: packageJson.productName, version, identifier: tauri.identifier, architecture: "x64" },
  scope: "windows-x64-artifact",
  build: { created, host: hostname(), platform: platform(), release: release(), arch: arch(), node: process.version },
  artifacts: {
    installer: await fileEvidence(installer),
    buildExecutable: await fileEvidence(executable),
    deliveredExecutable: artifactLifecycle.nsis?.deliveredExecutable ? {
      path: `${relativePath(installer)}!/editkin.exe`,
      bytes: artifactLifecycle.nsis.deliveredExecutable.bytes,
      sha256: artifactLifecycle.nsis.deliveredExecutable.sha256,
      pe: artifactLifecycle.nsis.deliveredExecutable.pe,
    } : null,
    runtime,
    sbom: await fileEvidence(sbomPath),
  },
  signatures: { installer: installerSignature, buildExecutable: executableSignature, deliveredExecutable: artifactLifecycle.nsis?.deliveredExecutable?.authenticode ?? null },
  dependencyAudit: productionAudit,
  runtimeProvenance,
  releaseIdentity,
  artifactLifecycle,
  internalGates,
  sbom: { format: "SPDX-2.3", packageCount: sbom.packages.length, validation: sbomReport.status, findings: sbomReport.findings, thirdPartyUnknownDeclaredLicenseCount: thirdPartyPackages.filter((item) => item.licenseDeclared === "NOASSERTION").length, productLicenseDeclared: Boolean(productLicense && await exists(productLicense)) },
  creatorPack: {
    status: creativePackReport.status,
    counts: creativePackReport.counts,
    manifest: await fileEvidence(creativePackManifestPath),
    distributionArchive: creativePackArchive,
    privateReferenceImagesEmbedded: creativePackManifest.source?.privateImagesEmbedded ?? null,
  },
  ffmpegSourceEvidence,
  publicGates,
  externalActions: [
    !publicGates.authenticodeInstaller ? "Inject a trusted Windows signing identity and rebuild/sign the installer." : null,
    !publicGates.publicUpdateChannelConfigured ? "Configure a credential-free immutable HTTPS update manifest URL owned by the release operator." : null,
    !publicGates.productLicenseSelected ? "Release owner must select and provide the Editkin product license." : null,
    !publicGates.exactFfmpegCorrespondingSourceRetained ? "Retain and distribute the exact FFmpeg corresponding source/build information required by GPL." : null,
    !publicGates.completeThirdPartyLicenseAggregation ? "Resolve NOASSERTION licenses from original npm/Cargo package metadata and legal-review notices." : null,
    !publicGates.creatorPackPortableAndRedistributable ? "Rebuild and validate the portable Hao Creator Library archive." : null,
  ].filter(Boolean),
};
const evidencePath = resolve(process.argv[2] ?? resolve(artifactRoot, `editkin-${version}-windows-x64-release.json`));
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (!evidence.status.startsWith("INTERNAL_GREEN") && evidence.status !== "PUBLIC_RELEASE_GREEN") process.exitCode = 1;

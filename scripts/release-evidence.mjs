import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { arch, hostname, platform, release } from "node:os";
import { inspectAuthenticode } from "./lib/authenticode.mjs";
import { evaluateCreativePack } from "./lib/creative-pack-gate.mjs";
import { inspectFfmpegCorrespondingSource } from "./lib/ffmpeg-source-evidence.mjs";
import { inspectRuntimeProvenance } from "./lib/runtime-provenance.mjs";
import { inspectReleaseIdentity } from "./lib/release-identity.mjs";
import { inspectDistributionArtifacts } from "./lib/artifact-lifecycle.mjs";
import { validateSpdx } from "./lib/sbom.mjs";
import { deliveredArtifactJourneyMatches, missingReleaseInputs, releaseDistribution, releaseEvidenceExitCode, releaseEvidenceStatus } from "./lib/release-evidence-gates.mjs";

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
const scope = "windows-x64-artifact";
const evidencePath = resolve(process.argv[2] ?? resolve(artifactRoot, `editkin-${version}-windows-x64-release.json`));
const installer = resolve(root, `src-tauri/target/release/bundle/nsis/Editkin_${version}_x64-setup.exe`);
const executable = resolve(root, "src-tauri/target/release/editkin.exe");
const bundledSbomPath = resolve(root, "release/editkin.spdx.json");
const creativePackManifestPath = resolve(root, ".creative-packs/hao-creator-library/editkin-pack.json");
const runtimePaths = [
  "vendor/node/win32-x64/node.exe", "vendor/ffmpeg/win32-x64/ffmpeg.exe", "vendor/ffmpeg/win32-x64/ffprobe.exe",
  "vendor/whisper/win32-x64/whisper-cli.exe", "vendor/whisper/win32-x64/whisper.dll", "vendor/whisper/win32-x64/ggml.dll", "vendor/whisper/win32-x64/ggml-base.dll", "vendor/whisper/win32-x64/ggml-cpu.dll",
  "native/bin/win32-x64/hao-core.exe", "desktop-dist/service.mjs", "desktop-dist/mcp.mjs", "desktop-dist/mcp.mjs.material-color-identity.json", "desktop-dist/remote.mjs",
].map((path) => resolve(root, path));
const requiredInputs = [
  "vendor/node/win32-x64/manifest.json", "vendor/node/win32-x64/NODE-LICENSE.txt",
  ".build-node-receipt.json", "vendor/ffmpeg/win32-x64/corresponding-source.json",
  "scripts/artifact-toolchain.json", "package-lock.json", "product-capabilities.json", "autopilot-capabilities.json",
  "src/creative/haoCorePack.json", ".personal-packs/hao-music-library/editkin-personal-music.json",
  "public/fonts/editkin-open-fonts.json", "src-tauri/Cargo.toml", "src/mcp/server.ts",
  "vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt", "vendor/whisper/win32-x64/WHISPER-LICENSE.txt",
  "vendor/whisper/win32-x64/manifest.json", "native/bin/win32-x64/editkin-gpu-compositor.exe",
  "public/demo-source.mp4", "public/editkin-demo-preview.mp4", ".release-input-manifest.json",
  "release/THIRD_PARTY_NOTICES.md", "src/shared/agentSetupContract.json", "scripts/editkin-product-mcp-launcher.mjs",
].map((path) => resolve(root, path));
// The extraction tool's paths come from the checked-in toolchain receipt, not vendor inputs.
if (await exists(resolve(root, "scripts/artifact-toolchain.json"))) {
  const toolReceipt = await json("scripts/artifact-toolchain.json");
  const sevenZipPath = resolve(root, toolReceipt.sevenZip.path);
  requiredInputs.push(sevenZipPath, resolve(dirname(sevenZipPath), "../package.json"));
}
const missing = await missingReleaseInputs(
  [...requiredInputs, installer, executable, bundledSbomPath, creativePackManifestPath, ...runtimePaths].map(relativePath),
  (path) => exists(resolve(root, path)),
);
if (missing.length) {
  const report = {
    status: "RELEASE_INPUTS_MISSING",
    scope,
    missing,
    externalActions: ["Provision the exact Windows release runtimes, build receipts, installer, source/license evidence, and creative packs before running this gate."],
  };
  try {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    report.externalActions.push(`Provide a writable evidence destination: ${error.code ?? "write-failed"}.`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(releaseEvidenceExitCode(report.status));
}
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

const created = new Date().toISOString();
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
const installerEvidence = await fileEvidence(installer);
const deliveredExecutable = artifactLifecycle.nsis?.deliveredExecutable;
const deliveredJourneyPath = resolve(root, `../../.rd/benchmarks/editkin-delivered-journey-${version}-windows-x64.json`);
let deliveredJourneyReceipt = null;
let deliveredJourneyError = null;
try { deliveredJourneyReceipt = await json(deliveredJourneyPath); }
catch (error) { deliveredJourneyError = error.code ?? "invalid-receipt"; }
const updateMetadataPath = process.env.EDITKIN_UPDATE_METADATA_FILE?.trim();
const updateTrustPolicyPath = process.env.EDITKIN_UPDATE_TRUST_POLICY_FILE?.trim();
let projectKeySignedUpdateMetadata = false;
let updateMetadataVerification = { status: "BLOCK", reason: "metadata-and-reviewed-trust-policy-required" };
if (updateMetadataPath && updateTrustPolicyPath) {
  try {
    const { tsImport } = await import("tsx/esm/api");
    const { verifyTrustedUpdateEnvelope } = await tsImport("../src/application/updateTrust.ts", import.meta.url);
    const [envelope, policy] = await Promise.all([json(resolve(updateMetadataPath)), json(resolve(updateTrustPolicyPath))]);
    const decision = verifyTrustedUpdateEnvelope(envelope, policy, {
      currentVersion: version,
      currentProjectSchema: 8,
      currentOsVersion: release(),
      currentArtifactSha256: installerEvidence.sha256,
    });
    projectKeySignedUpdateMetadata = decision.status === "current"
      && decision.metadata.version === version
      && decision.metadata.artifact.sha256 === installerEvidence.sha256
      && decision.metadata.artifact.size === installerEvidence.bytes
      && policy.platform === "windows" && policy.arch === "x86_64" && policy.abi === "msvc"
      && policy.manifestUrl === updateManifestUrl;
    updateMetadataVerification = {
      status: projectKeySignedUpdateMetadata ? "GREEN" : "BLOCK",
      reason: projectKeySignedUpdateMetadata ? null : "metadata-does-not-match-release-artifact-channel-or-compatibility",
    };
  } catch (error) {
    updateMetadataVerification = { status: "BLOCK", reason: error instanceof Error ? error.message : String(error) };
  }
}
const publicGates = {
  authenticodeInstaller: installerSignature.Status === "Valid",
  authenticodeExecutable: artifactLifecycle.nsis?.deliveredExecutable?.authenticode?.Status === "Valid",
  publicUpdateChannelConfigured,
  deliveredArtifactJourney: deliveredArtifactJourneyMatches(deliveredJourneyReceipt, installerEvidence.sha256, deliveredExecutable?.sha256),
  projectKeySignedUpdateMetadata,
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
const evidence = {
  status: releaseEvidenceStatus(internalGates, publicGates),
  product: { name: packageJson.productName, version, identifier: tauri.identifier, architecture: "x64" },
  scope,
  build: { created, host: hostname(), platform: platform(), release: release(), arch: arch(), node: process.version },
  distribution: releaseDistribution(installerSignature, deliveredExecutable?.authenticode, projectKeySignedUpdateMetadata),
  artifacts: {
    installer: installerEvidence,
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
  deliveredArtifactJourney: { path: relativePath(deliveredJourneyPath), receipt: deliveredJourneyReceipt, error: deliveredJourneyError },
  updateMetadataVerification,
  publicGates,
  externalActions: [
    !publicGates.authenticodeInstaller ? "Inject a trusted Windows signing identity and rebuild/sign the installer." : null,
    !publicGates.authenticodeExecutable ? "Sign and verify the executable extracted from the final installer with a trusted Windows signing identity." : null,
    !publicGates.deliveredArtifactJourney ? "Run scripts/tauri-delivered-smoke.mjs against the exact final installer and retain its GREEN receipt with matching installer and delivered executable SHA-256 hashes." : null,
    !publicGates.projectKeySignedUpdateMetadata ? "Provide EDITKIN_UPDATE_METADATA_FILE and EDITKIN_UPDATE_TRUST_POLICY_FILE with an independently reviewed project-key trust policy and valid Ed25519 metadata bound to the final installer and configured update channel." : null,
    !publicGates.publicUpdateChannelConfigured ? "Configure a credential-free immutable HTTPS update manifest URL owned by the release operator." : null,
    !publicGates.productLicenseSelected ? "Release owner must select and provide the Editkin product license." : null,
    !publicGates.exactFfmpegCorrespondingSourceRetained ? "Retain and distribute the exact FFmpeg corresponding source/build information required by GPL." : null,
    !publicGates.completeThirdPartyLicenseAggregation ? "Resolve NOASSERTION licenses from original npm/Cargo package metadata and legal-review notices." : null,
    !publicGates.creatorPackPortableAndRedistributable ? "Rebuild and validate the portable Hao Creator Library archive." : null,
  ].filter(Boolean),
};
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence)}\n`);
process.exitCode = releaseEvidenceExitCode(evidence.status);

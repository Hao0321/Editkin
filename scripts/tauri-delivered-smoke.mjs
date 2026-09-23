import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectDistributionArtifacts } from "./lib/artifact-lifecycle.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;
const installerPath = resolve(root, `src-tauri/target/release/bundle/nsis/Editkin_${version}_x64-setup.exe`);
const buildExecutablePath = resolve(root, "src-tauri/target/release/editkin.exe");
const archivePath = resolve(root, `../../.rd/artifacts/Hao-Creator-Library-${version}.editkin-pack.zip`);
const artifactEvidencePath = resolve(root, `../../.rd/benchmarks/editkin-artifact-lifecycle-${version}-windows-x64.json`);
const outputPath = resolve(root, `../../.rd/benchmarks/editkin-delivered-journey-${version}-windows-x64.json`);
const toolReceipt = JSON.parse(await readFile(resolve(root, "scripts/artifact-toolchain.json"), "utf8"));
const sevenZipPath = resolve(root, toolReceipt.sevenZip.path);
const deliveredJourneyTimeoutMs = 900_000;

async function identity(path) {
  const info = await stat(path);
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  return { bytes: info.size, sha256: hash };
}

const lifecycle = await inspectDistributionArtifacts({
  root,
  installerPath,
  executablePath: buildExecutablePath,
  creativePackArchivePath: archivePath,
  sourcePackRoot: resolve(root, ".creative-packs/hao-creator-library"),
  sourcePersonalMusicPackRoot: resolve(root, ".personal-packs/hao-music-library"),
  sourceFontPackRoot: resolve(root, "public/fonts"),
});
if (lifecycle.status !== "GREEN") throw new Error(`Actual delivery envelope failed lifecycle gate: ${JSON.stringify(lifecycle.findings)}`);

const workspace = await mkdtemp(join(tmpdir(), "editkin-delivered-journey-"));
let journeyFailure;
try {
  const extraction = spawnSync(sevenZipPath, ["x", "-y", `-o${workspace}`, installerPath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (extraction.status !== 0) throw new Error(`NSIS extraction failed: ${extraction.stderr || extraction.error?.message || extraction.status}`);
  const deliveredExecutablePath = resolve(workspace, "editkin.exe");
  const smoke = spawnSync(process.execPath, [resolve(root, "scripts/tauri-cdp-smoke.mjs"), deliveredExecutablePath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: deliveredJourneyTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (smoke.status !== 0) {
    throw new Error(`Delivered executable journey failed:\nSTDOUT:\n${smoke.stdout || "<empty>"}\nSTDERR:\n${smoke.stderr || smoke.error?.message || smoke.status}`);
  }
  const runtimeJourney = JSON.parse(smoke.stdout.trim());
  if (runtimeJourney.status !== "GREEN" || runtimeJourney.buildManifest?.status !== "GREEN") {
    throw new Error("Delivered executable did not return a green runtime receipt journey");
  }
  const evidence = {
    schemaVersion: 1,
    status: "GREEN",
    product: packageJson.productName,
    productVersion: version,
    generatedAt: new Date().toISOString(),
    deliveryEnvelope: { path: `apps/hao-editor/src-tauri/target/release/bundle/nsis/Editkin_${version}_x64-setup.exe`, ...await identity(installerPath) },
    deliveredExecutable: {
      path: `Editkin_${version}_x64-setup.exe!/editkin.exe`,
      ...await identity(deliveredExecutablePath),
      authority: true,
      source: "delivery-envelope-extraction",
    },
    artifactLifecycleEvidence: { path: `.rd/benchmarks/editkin-artifact-lifecycle-${version}-windows-x64.json`, ...await identity(artifactEvidencePath) },
    runtimeJourney,
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    productVersion: version,
    installer: evidence.deliveryEnvelope,
    deliveredExecutable: evidence.deliveredExecutable,
    receiptReadback: runtimeJourney.buildManifest.status,
    outputPath,
  })}\n`);
} catch (error) {
  journeyFailure = error;
}
try {
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
} catch (cleanupError) {
  if (!journeyFailure) throw cleanupError;
  journeyFailure.message = `${journeyFailure.message}\nCleanup also failed without replacing the journey failure: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`;
}
if (journeyFailure) throw journeyFailure;

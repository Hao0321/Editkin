import { constants as fsConstants } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertSelfAuthoredProductResourceRoots, assertSelfAuthoredProductResources } from "./lib/self-authored-product-resources.mjs";
import { assertPinnedWindowsProductRuntime } from "./lib/pinned-product-runtime.mjs";
import { assertTauriStageReplacementTarget, resolveTauriStageTarget } from "./lib/tauri-stage-target-policy.mjs";
import { replaceStageDirectoriesTransactionally } from "./lib/transactional-stage-replace.mjs";
import { stageMaterialColorRuntimePair } from "./lib/material-color-runtime-pair.mjs";
import {
  assertExactReleaseRuntimeFileSet,
  EDITKIN_RELEASE_RUNTIME_FILES,
} from "./lib/editkin-mcp-generation-contract.mjs";

const { appRoot, targetRoot, envelopeRoot, candidateTarget } = resolveTauriStageTarget(resolve("."), process.argv[2]);
const isolatedCandidateStage = process.argv.includes("--isolated-candidate-stage");
if (isolatedCandidateStage && !candidateTarget) {
  throw new Error("--isolated-candidate-stage is restricted to a new product-release-candidates envelope");
}
const resources = [
  ["desktop-dist/service.mjs", "service.mjs"],
  ["desktop-dist/mcp.mjs", "mcp.mjs"],
  ["desktop-dist/mcp.mjs.material-color-identity.json", "mcp.mjs.material-color-identity.json"],
  ["desktop-dist/remote.mjs", "remote.mjs"],
  [".release-input-manifest.json", "BUILD-MANIFEST.json"],
  ["release/editkin.spdx.json", "editkin.spdx.json"],
  ["release/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["vendor/node/win32-x64/node.exe", "node.exe"],
  ["vendor/node/win32-x64/NODE-LICENSE.txt", "NODE-LICENSE.txt"],
  ["vendor/node/win32-x64/manifest.json", "NODE-MANIFEST.json"],
  ["vendor/ffmpeg/win32-x64/ffmpeg.exe", "ffmpeg.exe"],
  ["vendor/ffmpeg/win32-x64/ffprobe.exe", "ffprobe.exe"],
  ["vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt", "FFMPEG-LICENSE.txt"],
  ["vendor/whisper/win32-x64/whisper-cli.exe", "whisper-cli.exe"],
  ["vendor/whisper/win32-x64/whisper.dll", "whisper.dll"],
  ["vendor/whisper/win32-x64/ggml.dll", "ggml.dll"],
  ["vendor/whisper/win32-x64/ggml-base.dll", "ggml-base.dll"],
  ["vendor/whisper/win32-x64/ggml-cpu.dll", "ggml-cpu.dll"],
  ["vendor/whisper/win32-x64/WHISPER-LICENSE.txt", "WHISPER-LICENSE.txt"],
  ["vendor/whisper/win32-x64/manifest.json", "WHISPER-MANIFEST.json"],
  ["native/bin/win32-x64/hao-core.exe", "hao-core.exe"],
  ["native/bin/win32-x64/editkin-gpu-compositor.exe", "editkin-gpu-compositor.exe"],
  ["public/demo-source.mp4", "demo-source.mp4"],
  ["public/editkin-demo-preview.mp4", "editkin-demo-preview.mp4"],
];
const agentResources = [
  ["scripts/editkin-product-mcp-launcher.mjs", "launcher.mjs"],
  ["src/shared/agentSetupContract.json", "agent-setup-contract.json"],
];

assertSelfAuthoredProductResources(
  [...resources.flat(), ...agentResources.flat()],
  "Tauri staged runtime and Agent launcher",
);
if (process.platform === "win32") await assertPinnedWindowsProductRuntime();
const recursiveResourceRoots = [
  ".creative-packs/hao-creator-library",
  ".personal-packs/hao-music-library",
  "public/fonts",
  "public/color/aces2",
  "plugins",
];
await assertSelfAuthoredProductResourceRoots(recursiveResourceRoots, "Tauri recursive product resources");

await mkdir(envelopeRoot, { recursive: true });
if (isolatedCandidateStage) {
  const existing = await readdir(envelopeRoot);
  if (existing.length > 0) {
    throw new Error(`Isolated release candidate envelope must be empty before staging: ${envelopeRoot}`);
  }
}
const stagingRoot = isolatedCandidateStage
  ? envelopeRoot
  : await mkdtemp(resolve(envelopeRoot, ".editkin-product-resources-stage-"));
const stagedRuntime = resolve(stagingRoot, "runtime");
const stagedAgentRuntime = resolve(stagingRoot, "agent-runtime-v3");
const stagedCreativePack = resolve(stagingRoot, "creative-packs/hao-creator-library");
const stagedPersonalMusicPack = resolve(stagingRoot, "personal-packs/hao-music-library");
const stagedFontPack = resolve(stagingRoot, "font-packs/editkin-open-fonts");
const stagedColor = resolve(stagingRoot, "color/aces2");
const stagedPlugins = resolve(stagingRoot, "plugins");
const replacements = [
  [stagedRuntime, targetRoot],
  [stagedAgentRuntime, resolve(envelopeRoot, "agent-runtime-v3")],
  [stagedCreativePack, resolve(envelopeRoot, "creative-packs/hao-creator-library")],
  [stagedPersonalMusicPack, resolve(envelopeRoot, "personal-packs/hao-music-library")],
  [stagedFontPack, resolve(envelopeRoot, "font-packs/editkin-open-fonts")],
  [stagedColor, resolve(envelopeRoot, "color/aces2")],
  [stagedPlugins, resolve(envelopeRoot, "plugins")],
];
for (const [, target] of replacements) {
  assertTauriStageReplacementTarget(envelopeRoot, target);
}
let preserveStagingForRecovery = false;
let transaction;
try {
  for (const [source, destination] of resources) {
    if (destination === "mcp.mjs.material-color-identity.json") continue;
    if (destination === "mcp.mjs") {
      await stageMaterialColorRuntimePair(resolve(source), resolve(stagedRuntime, destination));
      continue;
    }
    const output = resolve(stagedRuntime, destination);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(resolve(source), output, fsConstants.COPYFILE_EXCL);
  }
  for (const [source, destination] of agentResources) {
    const output = resolve(stagedAgentRuntime, destination);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(resolve(source), output, fsConstants.COPYFILE_EXCL);
  }
  const agentEntries = await readdir(stagedAgentRuntime, { withFileTypes: true });
  const expectedAgentFiles = agentResources.map(([, destination]) => destination).sort();
  const actualAgentFiles = agentEntries.map((entry) => entry.name).sort();
  if (agentEntries.some((entry) => !entry.isFile())
    || JSON.stringify(actualAgentFiles) !== JSON.stringify(expectedAgentFiles)) {
    throw new Error("Tauri staged Agent runtime must contain exactly the launcher and embedded contract");
  }
  const runtimeEntries = await readdir(stagedRuntime, { withFileTypes: true });
  if (runtimeEntries.some((entry) => !entry.isFile())) throw new Error("Tauri staged runtime must contain only regular top-level files");
  assertExactReleaseRuntimeFileSet(
    runtimeEntries.map((entry) => entry.name),
    EDITKIN_RELEASE_RUNTIME_FILES,
    "Tauri staged runtime",
  );
  await cp(resolve(".creative-packs/hao-creator-library"), stagedCreativePack, { recursive: true, force: false, errorOnExist: true });
  await cp(resolve(".personal-packs/hao-music-library"), stagedPersonalMusicPack, { recursive: true, force: false, errorOnExist: true });
  await cp(resolve("public/fonts"), stagedFontPack, { recursive: true, force: false, errorOnExist: true });
  await cp(resolve("public/color/aces2"), stagedColor, { recursive: true, force: false, errorOnExist: true });
  await cp(resolve("plugins"), stagedPlugins, { recursive: true, force: false, errorOnExist: true });
  await assertSelfAuthoredProductResourceRoots([stagingRoot], "Tauri staged product envelope", appRoot);
  transaction = isolatedCandidateStage
    ? { status: "ISOLATED_CANDIDATE_STAGED", replacements: replacements.length, cleanupPending: null }
    : await replaceStageDirectoriesTransactionally(replacements, { envelopeRoot });
} catch (error) {
  preserveStagingForRecovery = isolatedCandidateStage || error?.rollbackComplete === false;
  throw error;
} finally {
  if (!isolatedCandidateStage && !preserveStagingForRecovery) await rm(stagingRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  status: isolatedCandidateStage
    ? "GREEN_ISOLATED_CANDIDATE_STAGE"
    : transaction.cleanupPending ? "GREEN_TRANSACTIONAL_STAGE_BACKUP_RETAINED" : "GREEN_CLEAN_STAGE",
  targetRoot,
  resources: resources.length + agentResources.length,
  envelopeRoot,
  transaction,
})}\n`);

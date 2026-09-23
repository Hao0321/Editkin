import { constants as fsConstants } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertDesktopStageReplacementTarget,
  createIsolatedDesktopCandidateEnvelope,
  resolveDesktopStageTarget,
} from "./lib/desktop-stage-target-policy.mjs";
import { assertSelfAuthoredProductResourceRoots, assertSelfAuthoredProductResources } from "./lib/self-authored-product-resources.mjs";
import { assertPinnedWindowsProductRuntime } from "./lib/pinned-product-runtime.mjs";
import {
  assertExactReleaseRuntimeFileSet,
  EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES,
} from "./lib/editkin-mcp-generation-contract.mjs";
import { replaceStageDirectoriesTransactionally } from "./lib/transactional-stage-replace.mjs";

const runtimeResources = [
  "vendor/ffmpeg/win32-x64/ffmpeg.exe",
  "vendor/ffmpeg/win32-x64/ffprobe.exe",
  "vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt",
  "vendor/ffmpeg/win32-x64/manifest.json",
  "vendor/whisper/win32-x64/whisper-cli.exe",
  "vendor/whisper/win32-x64/whisper.dll",
  "vendor/whisper/win32-x64/ggml.dll",
  "vendor/whisper/win32-x64/ggml-base.dll",
  "vendor/whisper/win32-x64/ggml-cpu.dll",
  "vendor/whisper/win32-x64/WHISPER-LICENSE.txt",
  "vendor/whisper/win32-x64/manifest.json",
  "native/bin/win32-x64/hao-core.exe",
  "public/demo-source.mp4",
  "public/editkin-demo-preview.mp4",
];

assertSelfAuthoredProductResources(runtimeResources, "Electron staged runtime");
if (process.platform === "win32") await assertPinnedWindowsProductRuntime();
await assertSelfAuthoredProductResourceRoots([
  ".creative-packs/hao-creator-library",
  ".personal-packs/hao-music-library",
  "public/fonts",
  "public/color/aces2",
  "plugins",
], "Electron recursive product resources");

const cliArgs = process.argv.slice(2);
const isolatedCandidateStage = cliArgs.includes("--isolated-candidate-stage");
const targetArgs = cliArgs.filter((arg) => arg !== "--isolated-candidate-stage");
if (targetArgs.length > 1 || cliArgs.length !== targetArgs.length + (isolatedCandidateStage ? 1 : 0)) {
  throw new Error("Desktop staging accepts only [approved-runtime-path] [--isolated-candidate-stage]");
}
const { appRoot, targetRoot, envelopeRoot, candidateTarget } = resolveDesktopStageTarget(resolve("."), targetArgs[0]);
if (isolatedCandidateStage && !candidateTarget) {
  throw new Error("--isolated-candidate-stage is restricted to a new .desktop-product-release-candidates envelope");
}
if (candidateTarget && !isolatedCandidateStage) {
  throw new Error("Desktop release candidates must use --isolated-candidate-stage");
}
if (isolatedCandidateStage) {
  await createIsolatedDesktopCandidateEnvelope({ appRoot, targetRoot, envelopeRoot, candidateTarget });
} else {
  await mkdir(envelopeRoot, { recursive: true });
}
const stagingRoot = isolatedCandidateStage
  ? envelopeRoot
  : await mkdtemp(resolve(appRoot, ".editkin-desktop-resources-stage-"));
const output = join(stagingRoot, "runtime");
assertDesktopStageReplacementTarget(stagingRoot, output);
let preserveStagingForRecovery = false;
let transaction;
try {
  await mkdir(output, { recursive: true });
  await copyFile("vendor/ffmpeg/win32-x64/ffmpeg.exe", join(output, "ffmpeg.exe"), fsConstants.COPYFILE_EXCL);
  await copyFile("vendor/ffmpeg/win32-x64/ffprobe.exe", join(output, "ffprobe.exe"), fsConstants.COPYFILE_EXCL);
  await copyFile("vendor/ffmpeg/win32-x64/FFMPEG-LICENSE.txt", join(output, "FFMPEG-LICENSE.txt"), fsConstants.COPYFILE_EXCL);
  await copyFile("vendor/ffmpeg/win32-x64/manifest.json", join(output, "FFMPEG-MANIFEST.json"), fsConstants.COPYFILE_EXCL);
  for (const name of ["whisper-cli.exe", "whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll"]) {
    await copyFile(`vendor/whisper/win32-x64/${name}`, join(output, name), fsConstants.COPYFILE_EXCL);
  }
  await copyFile("vendor/whisper/win32-x64/WHISPER-LICENSE.txt", join(output, "WHISPER-LICENSE.txt"), fsConstants.COPYFILE_EXCL);
  await copyFile("vendor/whisper/win32-x64/manifest.json", join(output, "WHISPER-MANIFEST.json"), fsConstants.COPYFILE_EXCL);
  await copyFile("native/bin/win32-x64/hao-core.exe", join(output, "hao-core.exe"), fsConstants.COPYFILE_EXCL);
  await copyFile("public/demo-source.mp4", join(output, "demo-source.mp4"), fsConstants.COPYFILE_EXCL);
  await copyFile("public/editkin-demo-preview.mp4", join(output, "editkin-demo-preview.mp4"), fsConstants.COPYFILE_EXCL);
  await copyFile(".release-input-manifest.json", join(output, "BUILD-MANIFEST.json"), fsConstants.COPYFILE_EXCL);
  const runtimeEntries = await readdir(output, { withFileTypes: true });
  if (runtimeEntries.some((entry) => !entry.isFile())) throw new Error("Electron staged runtime must contain only regular top-level files");
  assertExactReleaseRuntimeFileSet(
    runtimeEntries.map((entry) => entry.name),
    EDITKIN_DESKTOP_RELEASE_RUNTIME_FILES,
    "Electron staged runtime",
  );
  await cp(".creative-packs/hao-creator-library", join(stagingRoot, "creative-packs/hao-creator-library"), { recursive: true, force: false, errorOnExist: true });
  await cp(".personal-packs/hao-music-library", join(stagingRoot, "personal-packs/hao-music-library"), { recursive: true, force: false, errorOnExist: true });
  await cp("public/fonts", join(stagingRoot, "font-packs/editkin-open-fonts"), { recursive: true, force: false, errorOnExist: true });
  await cp("public/color/aces2", join(stagingRoot, "color/aces2"), { recursive: true, force: false, errorOnExist: true });
  await cp("plugins", join(stagingRoot, "plugins"), { recursive: true, force: false, errorOnExist: true });
  await assertSelfAuthoredProductResourceRoots([stagingRoot], "Electron staged product envelope", appRoot);
  transaction = isolatedCandidateStage
    ? { status: "ISOLATED_CANDIDATE_STAGED", replacements: 1, cleanupPending: null }
    : await replaceStageDirectoriesTransactionally(
      [[stagingRoot, envelopeRoot]],
      { envelopeRoot: appRoot },
    );
} catch (error) {
  preserveStagingForRecovery = isolatedCandidateStage || error?.rollbackComplete === false;
  throw error;
} finally {
  if (!isolatedCandidateStage && !preserveStagingForRecovery) await rm(stagingRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({
  status: isolatedCandidateStage
    ? "GREEN_ISOLATED_DESKTOP_CANDIDATE_STAGE"
    : transaction.cleanupPending ? "GREEN_TRANSACTIONAL_STAGE_BACKUP_RETAINED" : "GREEN_CLEAN_TRANSACTIONAL_STAGE",
  output: targetRoot,
  root: envelopeRoot,
  activation: candidateTarget ? "candidate-not-activated" : "canonical-desktop-resources",
  transaction,
}));

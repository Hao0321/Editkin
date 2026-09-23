import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  assertTauriCandidateArtifactRoot,
  inspectWindowsTauriCandidatePrimaryArtifacts,
  prepareTauriCandidateCargoTarget,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";
import { assertSelfAuthoredProductResourceRoots, assertSelfAuthoredProductResources, tauriResourcePaths } from "./lib/self-authored-product-resources.mjs";
import { assertPinnedWindowsProductRuntime } from "./lib/pinned-product-runtime.mjs";
import {
  assertIsolatedDesktopCandidateAvailable,
  resolveDesktopCandidateForTauriArtifact,
} from "./lib/desktop-stage-target-policy.mjs";
import {
  assertTauriProductFeatureArgs,
  assertTauriProductRustflagEnvironment,
  tauriProductBuildArgs,
} from "./lib/tauri-product-feature-policy.mjs";

function parseBuildArgs(args) {
  let artifactRoot;
  const userArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--artifact-root") {
      userArgs.push(args[index]);
      continue;
    }
    const value = args[index + 1];
    if (artifactRoot || !value || value.startsWith("--")) {
      throw new Error("Tauri build requires exactly one --artifact-root <isolated-candidate-release>");
    }
    artifactRoot = value;
    index += 1;
  }
  if (!artifactRoot) throw new Error("Tauri build requires exactly one --artifact-root <isolated-candidate-release>");
  return { artifactRoot, userArgs };
}

const { artifactRoot: artifactRootInput, userArgs } = parseBuildArgs(process.argv.slice(2));
assertTauriProductRustflagEnvironment(process.env);
assertTauriProductFeatureArgs(userArgs);
const candidate = resolveTauriCandidateArtifactRoot(resolve("."), artifactRootInput);
const desktopCandidateStage = process.platform === "win32"
  ? resolveDesktopCandidateForTauriArtifact(candidate.appRoot, candidate.artifactRoot)
  : undefined;
// Detect a stale/occupied companion generation before any expensive build work.
if (desktopCandidateStage) await assertIsolatedDesktopCandidateAvailable(desktopCandidateStage);
await prepareTauriCandidateCargoTarget(candidate);

const tauriResourceConfigs = ["src-tauri/tauri.conf.json", process.platform === "darwin" ? "src-tauri/tauri.macos.conf.json" : "src-tauri/tauri.windows.conf.json"];
const tauriProductResources = tauriResourceConfigs.flatMap((path) => tauriResourcePaths(JSON.parse(readFileSync(resolve(path), "utf8"))));
assertSelfAuthoredProductResources(tauriProductResources, `Tauri ${process.platform} bundle resources`);
const tauriProductResourceSources = tauriResourceConfigs.flatMap((path) => {
  const configPath = resolve(path);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return Object.keys(config?.bundle?.resources ?? {}).map((source) => resolve(dirname(configPath), source));
});
await assertSelfAuthoredProductResourceRoots(tauriProductResourceSources, `Tauri ${process.platform} recursive bundle resources`);
if (process.platform === "win32") await assertPinnedWindowsProductRuntime();

const thumbprint = process.env.EDITKIN_WINDOWS_CERTIFICATE_THUMBPRINT;
const signCommand = process.env.EDITKIN_WINDOWS_SIGN_COMMAND;
if (thumbprint && signCommand) throw new Error("certificate thumbprint 與 custom sign command 不可同時啟用");
if (signCommand && !signCommand.includes("%1")) throw new Error("EDITKIN_WINDOWS_SIGN_COMMAND 必須包含 %1 binary placeholder");

const pinnedWindowsNode = resolve("vendor/node/win32-x64/node.exe");
const buildNode = process.platform === "win32" && existsSync(pinnedWindowsNode) ? pinnedWindowsNode : process.execPath;
let windowsSigning;
if (thumbprint || signCommand) {
  windowsSigning = thumbprint
    ? {
        certificateThumbprint: thumbprint.replaceAll(" ", ""),
        timestampUrl: process.env.EDITKIN_WINDOWS_TIMESTAMP_URL ?? "http://timestamp.acs.microsoft.com",
      }
    : { signCommand };
}
const args = [
  resolve("node_modules/@tauri-apps/cli/tauri.js"),
  ...tauriProductBuildArgs(userArgs, { windowsSigning }),
];

const cargoDirectory = join(homedir(), ".cargo", "bin");
const environment = { ...process.env };
environment.CARGO_TARGET_DIR = candidate.cargoTargetDir;
environment.CARGO_HOME = resolve(cargoDirectory, "..");
const cargoExecutable = join(cargoDirectory, process.platform === "win32" ? "cargo.exe" : "cargo");
if (existsSync(cargoExecutable)) environment.CARGO = cargoExecutable;
if (buildNode !== process.execPath) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const entries = String(environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  const buildNodeDirectory = resolve("vendor/node/win32-x64");
  if (!entries.some((entry) => resolve(entry) === buildNodeDirectory)) environment[pathKey] = [buildNodeDirectory, ...entries].join(delimiter);
}
if (existsSync(join(cargoDirectory, process.platform === "win32" ? "cargo.exe" : "cargo"))) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const entries = String(environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (!entries.some((entry) => resolve(entry) === resolve(cargoDirectory))) environment[pathKey] = [cargoDirectory, ...entries].join(delimiter);
}

const child = spawn(buildNode, args, { stdio: "inherit", windowsHide: true, env: environment });
const buildResult = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});
if (buildResult.signal) throw new Error(`Tauri build 被 ${buildResult.signal} 終止`);
if (buildResult.code !== 0) process.exit(buildResult.code ?? 1);
await assertTauriCandidateArtifactRoot(candidate, "inspect");

async function runGate(commandArgs, label) {
  const gate = spawn(buildNode, commandArgs, {
    stdio: "inherit",
    windowsHide: true,
    env: environment,
  });
  const result = await new Promise((resolvePromise, reject) => {
    gate.once("error", reject);
    gate.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) throw new Error(`${label} 被 ${result.signal} 終止`);
  if (result.code !== 0) process.exit(result.code ?? 1);
}

await runGate([resolve("scripts/product-release-manifest-policy-gate.mjs")], "Product release manifest policy gate");

if (process.platform === "win32") {
  const artifactTarget = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, JSON.parse(readFileSync(resolve("package.json"), "utf8")).version);
  const sourceManifest = readFileSync(resolve(".release-input-manifest.json"));
  const stagedManifest = readFileSync(resolve(candidate.artifactRoot, "runtime/BUILD-MANIFEST.json"));
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const buildReceipt = {
    schema: "editkin.tauri-candidate-build-receipt/v1",
    artifactTarget,
    cargoTargetDir: candidate.cargoTargetDir,
    desktopCandidateRuntime: desktopCandidateStage.relativeRuntime,
    command: { executable: buildNode, args },
    callerEnvironmentPolicy: "reject-rust-cargo-toolchain-feature-and-target-injection",
    releaseManifest: { bytes: sourceManifest.length, sha256: sha256(sourceManifest) },
    stagedReleaseManifest: { bytes: stagedManifest.length, sha256: sha256(stagedManifest) },
    createdAt: new Date().toISOString(),
  };
  if (buildReceipt.releaseManifest.sha256 !== buildReceipt.stagedReleaseManifest.sha256
    || buildReceipt.releaseManifest.bytes !== buildReceipt.stagedReleaseManifest.bytes) {
    throw new Error("Tauri candidate staged release manifest is not byte-current");
  }
  await writeFile(
    resolve(candidate.artifactRoot, ".editkin-build-receipt.json"),
    `${JSON.stringify(buildReceipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await runGate([
    resolve("scripts/stage-desktop-resources.mjs"),
    desktopCandidateStage.targetRoot,
    "--isolated-candidate-stage",
  ], "Paired desktop candidate resource stage");
  await runGate([
    resolve("node_modules/tsx/dist/cli.mjs"),
    resolve("scripts/auto-roto-native-product-artifact-freshness-gate.ts"),
    "--artifact-root",
    candidate.artifactRoot,
    "--desktop-candidate-runtime",
    desktopCandidateStage.targetRoot,
  ], "Auto Roto native product freshness gate");
  await runGate([resolve("scripts/artifact-lifecycle-gate.mjs"), "--artifact-root", candidate.artifactRoot], "Artifact lifecycle gate");
  await runGate([resolve("scripts/product-agent-connect-delivery-gate.mjs"), "--artifact-root", candidate.artifactRoot], "Product Agent Connect delivery gate");
  await runGate([resolve("scripts/security-hardening-gate.mjs"), "internal", "--artifact-root", candidate.artifactRoot], "Security hardening gate");
} else if (process.platform === "darwin") {
  const macApp = resolve(candidate.artifactRoot, "bundle/macos/Editkin.app");
  await runGate([
    resolve("scripts/macos-bundle-runtime-gate.mjs"),
    macApp,
    process.arch,
    resolve(`.rd/receipts/macos-runtime-${process.arch}.json`),
  ], "macOS bundled runtime gate");
  const codesign = spawn("/usr/bin/codesign", ["--verify", "--deep", "--strict", macApp], { stdio: "inherit", env: environment });
  const codesignResult = await new Promise((resolvePromise, reject) => {
    codesign.once("error", reject);
    codesign.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (codesignResult.signal || codesignResult.code !== 0) throw new Error("macOS product app code-signature verification failed");
} else {
  throw new Error(`Formal Tauri packaging closure is not implemented for ${process.platform}`);
}

process.stdout.write(`${JSON.stringify({ status: "GREEN_ISOLATED_TAURI_BUILD", artifactRoot: candidate.relativeArtifactRoot })}\n`);

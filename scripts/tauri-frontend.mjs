import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { assertTauriNativePolicyPin } from "./lib/tauri-product-feature-policy.mjs";
import { assertProductCargoLocks } from "./lib/cargo-lock-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const pinnedWindowsNode = resolve(root, "vendor/node/win32-x64/node.exe");
const required = [22, 13, 0];

function versionParts(value) {
  const match = String(value).match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function meetsRequired(actual) {
  if (!actual) return false;
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

async function runNode(script, args = []) {
  const child = spawn(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const result = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) throw new Error(`${script} was terminated by ${result.signal}`);
  if (result.code !== 0) throw new Error(`${script} exited with ${result.code}`);
}

if (process.platform === "win32" && existsSync(pinnedWindowsNode) && resolve(process.execPath) !== pinnedWindowsNode) {
  const child = spawn(pinnedWindowsNode, [resolve(import.meta.filename), ...process.argv.slice(2)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const result = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (result.signal) throw new Error(`Pinned Node frontend build was terminated by ${result.signal}`);
  process.exit(result.code ?? 1);
}

if (!meetsRequired(versionParts(process.version))) {
  throw new Error(`Frontend release build requires Node >=22.13; received ${process.version}`);
}

// Keep the bundled-Node bootstrap ahead of modules that require import attributes.
const { PRODUCT_RELEASE_SCOPE } = await import("./lib/build-input-identity.mjs");
assertTauriNativePolicyPin(await readFile(resolve(root, "src-tauri/build.rs"), "utf8"), PRODUCT_RELEASE_SCOPE.policySha256);

const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const standardCargo = resolve(homedir(), ".cargo", "bin", cargoName);
const cargo = process.env.CARGO || (existsSync(standardCargo) ? standardCargo : cargoName);
const lockChecks = await assertProductCargoLocks({ root, cargo });
process.stdout.write(`${JSON.stringify({ status: "GREEN_CARGO_LOCK_PREFLIGHT", manifests: lockChecks.map(item => item.manifest) })}\n`);

const nodeBytes = await readFile(process.execPath);
const receipt = {
  schemaVersion: 1,
  nodeVersion: process.version,
  nodeSource: process.platform === "win32"
    ? relative(root, process.execPath).split(sep).join("/")
    : "operator-node",
  nodeSha256: createHash("sha256").update(nodeBytes).digest("hex"),
};
const receiptPath = resolve(root, ".build-node-receipt.json");
const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rm(receiptPath, { force: true });
  await rename(temporary, receiptPath);
} finally {
  await rm(temporary, { force: true });
}

await runNode("scripts/build-creative-pack.mjs");
await runNode("scripts/archive-creative-pack.mjs");
await runNode("scripts/build-personal-music-pack.mjs");
await runNode("scripts/personal-music-pack-gate.mjs");
await runNode("scripts/build-native-core.mjs", process.platform === "win32" ? ["--windows-only"] : []);
await runNode("scripts/build-gpu-compositor.mjs");
await runNode("scripts/generate-sbom.mjs");
await runNode("node_modules/tsx/dist/cli.mjs", ["scripts/editkin-skill-pack-gate.ts"]);
await runNode("scripts/retired-product-surfaces-gate.mjs");
await runNode("node_modules/typescript/bin/tsc", ["--noEmit"]);
await runNode("scripts/build-web-public.mjs");
await runNode("node_modules/vite/bin/vite.js", ["build"]);
await runNode("scripts/bundle-size-gate.mjs");
await runNode("scripts/build-desktop.mjs");
await runNode("scripts/build-release-input-manifest.mjs");

process.stdout.write(`${JSON.stringify({ status: "GREEN", phase: "tauri-frontend", buildNode: receipt })}\n`);

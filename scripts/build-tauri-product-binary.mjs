import { runOwnedProcess } from "./lib/owned-process-runner.mjs";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { assertTauriNativePolicyPin, assertTauriProductRustflagEnvironment, tauriProductCargoBuildArgs, TAURI_PRODUCT_EMBEDDED_FRONTEND_FEATURE } from "./lib/tauri-product-feature-policy.mjs";
import { computeBuildReceipt, productReleaseManifestFindings, PRODUCT_RELEASE_SCOPE } from "./lib/build-input-identity.mjs";

const root = resolve(import.meta.dirname, "..");
const cargoPath = process.platform === "win32"
  ? resolve(homedir(), ".cargo/bin/cargo.exe")
  : "cargo";
const rustcPath = process.platform === "win32" ? resolve(dirname(cargoPath), "rustc.exe") : "rustc";
const productBuildRoot = resolve(root, "src-tauri/target-product-generations");
const binaryPath = resolve(root, "src-tauri/target/release", process.platform === "win32" ? "editkin.exe" : "editkin");
const receiptPath = resolve(root, ".rd/build-receipts/editkin-tauri-product.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectInputs() {
  const roots = [
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/build.rs",
    "src-tauri/src",
    "src-tauri/remote-relay.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.android.conf.json",
    "src-tauri/tauri.existing-dev-server.conf.json",
    "src-tauri/tauri.ios.conf.json",
    "src-tauri/tauri.macos.conf.json",
    "src-tauri/tauri.windows.conf.json",
    "src-tauri/capabilities",
    "src-tauri/icons",
    "src/shared/agentSetupContract.json",
    "scripts/editkin-product-mcp-launcher.mjs",
    "scripts/product-agent-connect-delivery-gate.mjs",
    ".release-input-manifest.json",
    "scripts/build-tauri-product-binary.mjs",
    "scripts/lib/owned-process-runner.mjs",
    "scripts/lib/tauri-product-feature-policy.mjs",
    "dist",
  ];
  const files = [];
  async function visit(path) {
    const info = await stat(path);
    if (info.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relative(root, path).split(sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) });
      return;
    }
    if (!info.isDirectory()) throw new Error(`Tauri product build rejects non-file input: ${path}`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Tauri product build rejects symlink input: ${join(path, entry.name)}`);
      await visit(join(path, entry.name));
    }
  }
  for (const item of roots) await visit(resolve(root, item));
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const identity = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    identity.update(file.path).update("\0").update(String(file.bytes)).update("\0").update(file.sha256).update("\n");
    bytes += file.bytes;
  }
  return { files, identity: { files: files.length, bytes, sha256: identity.digest("hex") } };
}

function run(executable, args, timeoutMs, environment = process.env) {
  return runOwnedProcess(executable, args, { cwd: root, env: environment, timeoutMs });
}

if (process.platform === "win32" && !existsSync(cargoPath)) throw new Error(`Pinned cargo executable is missing: ${cargoPath}`);
if (process.argv.length > 2) throw new Error("Tauri product binary build does not accept caller-selected arguments");
assertTauriProductRustflagEnvironment(process.env);
assertTauriNativePolicyPin(await readFile(resolve(root, "src-tauri/build.rs"), "utf8"), PRODUCT_RELEASE_SCOPE.policySha256);
// Read-only preflight: never regenerate an attestation to hide stale inputs.
// It runs before even creating a Cargo target, so a known mismatch cannot waste
// a clean native compile or promote an executable with an old frontend receipt.
const releaseManifest = JSON.parse(await readFile(resolve(root, ".release-input-manifest.json"), "utf8"));
const releaseFindings = productReleaseManifestFindings(releaseManifest);
if (releaseFindings.length) throw new Error(`Native build release preflight rejected: ${JSON.stringify(releaseFindings)}`);
const currentRelease = await computeBuildReceipt(root);
if (JSON.stringify(currentRelease.inputIdentity) !== JSON.stringify(releaseManifest.inputIdentity)
  || JSON.stringify(currentRelease.outputIdentity) !== JSON.stringify(releaseManifest.outputIdentity)) {
  throw new Error("Native build release preflight: source or generated output changed; rebuild the canonical frontend first");
}
await mkdir(productBuildRoot, { recursive: true });
const buildTargetDir = await mkdtemp(join(productBuildRoot, "generation-"));
const buildTargetRelation = relative(productBuildRoot, buildTargetDir);
if (!buildTargetRelation || buildTargetRelation.startsWith("..") || isAbsolute(buildTargetRelation)) {
  throw new Error(`Refusing unsafe product build generation path: ${buildTargetDir}`);
}
const builtBinaryPath = resolve(buildTargetDir, "release", process.platform === "win32" ? "editkin.exe" : "editkin");
let buildCompleted = false;
try {
  const before = await collectInputs();
  const [cargoVersion, rustcVersion] = await Promise.all([
    run(cargoPath, ["-Vv"], 30_000),
    run(rustcPath, ["-Vv"], 30_000),
  ]);
  const command = tauriProductCargoBuildArgs();
  const buildEnvironment = { ...process.env, CARGO_TARGET_DIR: buildTargetDir, CARGO_INCREMENTAL: "0" };
  await run(cargoPath, command, 45 * 60_000, buildEnvironment);
  const after = await collectInputs();
  if (before.identity.sha256 !== after.identity.sha256) throw new Error("Tauri product build inputs changed during compilation");
  const binary = await readFile(builtBinaryPath);
  const forbiddenCommandIds = [
    "inspect_auto_roto_video_model",
    "install_auto_roto_video_model",
    "pick_and_install_auto_roto_video_model",
    "repair_auto_roto_video_model",
    "inspect_auto_roto_video_pack",
  ];
  const presentForbiddenCommandIds = forbiddenCommandIds.filter((marker) => binary.includes(Buffer.from(marker)));
  if (presentForbiddenCommandIds.length) throw new Error(`Product Tauri binary contains research command IDs: ${presentForbiddenCommandIds.join(", ")}`);
  await mkdir(dirname(binaryPath), { recursive: true });
  const promotedCandidate = `${binaryPath}.${process.pid}.${randomUUID()}.candidate`;
  const previousBinary = `${binaryPath}.${process.pid}.${randomUUID()}.previous`;
  try {
    await copyFile(builtBinaryPath, promotedCandidate);
    if (sha256(await readFile(promotedCandidate)) !== sha256(binary)) throw new Error("Tauri product binary promotion hash mismatch");
    if (existsSync(binaryPath)) await rename(binaryPath, previousBinary);
    try {
      await rename(promotedCandidate, binaryPath);
    } catch (error) {
      if (existsSync(previousBinary) && !existsSync(binaryPath)) await rename(previousBinary, binaryPath);
      throw error;
    }
    await rm(previousBinary, { force: true });
  } finally {
    await rm(promotedCandidate, { force: true });
  }
  const receipt = {
    schema: "editkin.tauri-product-build-receipt/v1",
    productMode: "no-default-features-no-auto-roto-research",
    frontendMode: "embedded-custom-protocol",
    enabledCargoFeatures: [TAURI_PRODUCT_EMBEDDED_FRONTEND_FEATURE],
    command: { executable: cargoPath, args: command },
    isolatedBuildTarget: relative(root, buildTargetDir).split(sep).join("/"),
    cleanGeneration: true,
    callerEnvironmentPolicy: "reject-rust-cargo-toolchain-feature-and-target-injection",
    toolchain: { cargo: cargoVersion.stdout, rustc: rustcVersion.stdout },
    inputs: after.files,
    inputIdentity: after.identity,
    binary: { path: relative(root, binaryPath).split(sep).join("/"), bytes: binary.length, sha256: sha256(binary) },
    forbiddenCommandIds,
    presentForbiddenCommandIds,
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rm(receiptPath, { force: true });
    await rename(temporary, receiptPath);
  } finally {
    await rm(temporary, { force: true });
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN_PRODUCT_BINARY", receipt: relative(root, receiptPath).split(sep).join("/"), inputIdentity: receipt.inputIdentity, binary: receipt.binary })}\n`);
  buildCompleted = true;
} finally {
  if (buildCompleted) await rm(buildTargetDir, { recursive: true, force: true });
  else process.stderr.write(`Failed build generation retained (no cleanup assumed): ${buildTargetDir}\n`);
}

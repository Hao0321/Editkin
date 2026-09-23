import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, lstat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { resolveCargoReleaseBinary } from "./lib/cargo-artifact-path.mjs";
import { NATIVE_CORE_BUILD_INPUT_ROOTS, NATIVE_SHARED_PROCESS_INPUTS } from "./lib/native-shared-inputs.mjs";

if (process.argv.includes("--windows-only") && process.platform !== "win32") {
  process.stdout.write(`${JSON.stringify({ status: "SKIP", reason: "native core is built before macOS runtime staging", platform: process.platform })}\n`);
  process.exit(0);
}

const executableName = process.platform === "win32" ? "cargo.exe" : "cargo";
const standardCargo = join(homedir(), ".cargo", "bin", executableName);
const cargo = process.env.CARGO || (existsSync(standardCargo) ? standardCargo : "cargo");
const rustc = process.env.RUSTC || join(dirname(cargo), process.platform === "win32" ? "rustc.exe" : "rustc");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collectBuildInputs() {
  const projectRoot = resolve(".");
  const files = [];
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`native build input rejects symlink: ${path}`);
    if (info.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relative(projectRoot, path).split(sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) });
      return;
    }
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`native build input rejects symlink: ${join(path, entry.name)}`);
      await visit(join(path, entry.name));
    }
  }
  for (const path of NATIVE_CORE_BUILD_INPUT_ROOTS) await visit(resolve(path));
  for (const path of NATIVE_SHARED_PROCESS_INPUTS) {
    if (!files.some((file) => file.path === path)) throw new Error(`native build input missing shared launcher source: ${path}`);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const aggregate = createHash("sha256");
  for (const file of files) aggregate.update(file.path).update("\0").update(String(file.bytes)).update("\0").update(file.sha256).update("\n");
  return { files, aggregateSha256: aggregate.digest("hex") };
}

function toolReceipt(path, args) {
  if (!existsSync(path)) throw new Error(`native build tool is not an exact executable: ${path}`);
  const output = spawnSync(path, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (output.status !== 0) throw new Error(`native build tool identity failed: ${path}: ${output.stderr || output.stdout}`);
  return { path: resolve(path), sha256: sha256(readFileSync(path)), version: output.stdout.trim() };
}

const buildInputs = await collectBuildInputs();
// Read-only inventory inspection; does not compile, stage or replace a binary.
if (process.argv.includes("--inputs-only")) {
  process.stdout.write(`${JSON.stringify(buildInputs)}\n`);
  process.exit(0);
}
const cargoReceipt = toolReceipt(cargo, ["--version"]);
const rustcReceipt = toolReceipt(rustc, ["--version", "--verbose"]);
const dependencyTree = spawnSync(cargo, ["tree", "--locked", "--no-default-features", "--manifest-path", "native/hao-core/Cargo.toml", "--prefix", "none"], {
  encoding: "utf8", windowsHide: true, timeout: 60_000,
});
if (dependencyTree.status !== 0) throw new Error(`native product dependency tree failed: ${dependencyTree.stderr || dependencyTree.stdout}`);
if (/^ort(?:\s|$)/m.test(dependencyTree.stdout)) throw new Error("native product dependency closure contains external ONNX Runtime");
const buildCommand = ["build", "--release", "--locked", "--no-default-features", "--manifest-path", "native/hao-core/Cargo.toml"];
const child = spawn(cargo, buildCommand, {
  stdio: "inherit",
  windowsHide: true,
});
const result = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});
if (result.signal) throw new Error(`hao-core build terminated by ${result.signal}`);
if (result.code !== 0) process.exit(result.code ?? 1);

const built = resolveCargoReleaseBinary({
  cwd: resolve("."),
  manifestPath: "native/hao-core/Cargo.toml",
  binaryName: "hao-core",
  platform: process.platform,
  cargoTargetDir: process.env.CARGO_TARGET_DIR,
});
const builtBytes = await readFile(built);
let promoted;
if (process.platform === "win32") {
  promoted = resolve("native/bin/win32-x64/hao-core.exe");
  await mkdir(dirname(promoted), { recursive: true });
  const temporary = `${promoted}.${process.pid}.${randomUUID()}.candidate`;
  const previous = `${promoted}.${process.pid}.${randomUUID()}.previous`;
  try {
    await copyFile(built, temporary);
    if (sha256(await readFile(temporary)) !== sha256(builtBytes)) throw new Error("hao-core staging hash mismatch");
    if (existsSync(promoted)) await rename(promoted, previous);
    try {
      await rename(temporary, promoted);
    } catch (error) {
      if (existsSync(previous) && !existsSync(promoted)) await rename(previous, promoted);
      throw error;
    }
    await rm(previous, { force: true });
  } finally {
    await rm(temporary, { force: true });
  }
}

const promotedBytes = promoted ? await readFile(promoted) : builtBytes;
const receipt = {
  schema: "editkin.native-core-build-receipt/v1",
  generatedAt: new Date().toISOString(),
  productMode: "no-default-features-self-authored-auto-roto",
  command: [cargoReceipt.path, ...buildCommand],
  inputs: buildInputs,
  toolchain: { cargo: cargoReceipt, rustc: rustcReceipt },
  dependencyClosure: { ortPresent: false, sha256: sha256(Buffer.from(dependencyTree.stdout)), lines: dependencyTree.stdout.trim().split(/\r?\n/).length },
  output: { path: built, bytes: builtBytes.length, sha256: sha256(builtBytes) },
  promoted: { path: promoted ?? built, bytes: promotedBytes.length, sha256: sha256(promotedBytes) },
};
const receiptPath = resolve(".rd/benchmarks/editkin-native-core-build-receipt.json");
await mkdir(dirname(receiptPath), { recursive: true });
const receiptTemporary = `${receiptPath}.${process.pid}.${randomUUID()}.candidate`;
await writeFile(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
await rename(receiptTemporary, receiptPath);

process.stdout.write(`${JSON.stringify({ status: "GREEN", cargo: basename(cargo), platform: process.platform, built, promoted, bytes: builtBytes.length, sha256: sha256(builtBytes), receipt: receiptPath, inputSha256: buildInputs.aggregateSha256 })}\n`);

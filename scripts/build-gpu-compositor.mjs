import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { resolveCargoReleaseBinary } from "./lib/cargo-artifact-path.mjs";

const executableName = process.platform === "win32" ? "cargo.exe" : "cargo";
const standardCargo = resolve(homedir(), ".cargo", "bin", executableName);
const cargo = process.env.CARGO || (existsSync(standardCargo) ? standardCargo : "cargo");
const manifest = "spikes/gpu-compositor/Cargo.toml";
const child = spawn(cargo, ["build", "--release", "--locked", "--manifest-path", manifest], { stdio: "inherit", windowsHide: true });
const result = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});
if (result.signal) throw new Error(`GPU compositor build terminated by ${result.signal}`);
if (result.code !== 0) process.exit(result.code ?? 1);

const suffix = process.platform === "win32" ? ".exe" : "";
const built = resolveCargoReleaseBinary({
  cwd: process.cwd(),
  manifestPath: manifest,
  binaryName: "editkin-gpu-compositor",
  platform: process.platform,
  cargoTargetDir: process.env.CARGO_TARGET_DIR,
});
const platformFolder = process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-universal" : "linux-x64";
const promoted = resolve(`native/bin/${platformFolder}/editkin-gpu-compositor${suffix}`);
const bytes = await readFile(built);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
await mkdir(dirname(promoted), { recursive: true });
const temporary = `${promoted}.${process.pid}.${randomUUID()}.candidate`;
const previous = `${promoted}.${process.pid}.${randomUUID()}.previous`;
try {
  await copyFile(built, temporary);
  if (sha256(await readFile(temporary)) !== sha256(bytes)) throw new Error("GPU compositor staging hash mismatch");
  if (existsSync(promoted)) await rename(promoted, previous);
  try { await rename(temporary, promoted); }
  catch (error) {
    if (existsSync(previous) && !existsSync(promoted)) await rename(previous, promoted);
    throw error;
  }
  await rm(previous, { force: true });
} finally { await rm(temporary, { force: true }); }

process.stdout.write(`${JSON.stringify({ status: "GREEN", cargo: basename(cargo), built, promoted, bytes: bytes.length, sha256: sha256(bytes) })}\n`);

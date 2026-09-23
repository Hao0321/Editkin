import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { replaceFileTransactionally } from "./lib/product-ledger-transaction.mjs";

const root = resolve(import.meta.dirname, "..");
const packagePath = resolve(root, "package.json");
const ledgerPath = resolve(root, "product-capabilities.json");
const receiptRoot = resolve(root, ".rd", "capability-receipts");
const scriptName = argument("--script");
const timeoutMs = Number(argument("--timeout-ms") ?? 900_000);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
  return sha256(Buffer.from(text, "utf8"));
}

function safeName(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "script";
}

function tokenize(command) {
  if (/[&|;<>]/.test(command)) throw new Error("Compound or redirected package scripts require a dedicated shell-free wrapper before receipt capture");
  const tokens = [];
  let token = "";
  let quote;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "\"" || character === "'") quote = character;
    else if (/\s/.test(character)) {
      if (token) { tokens.push(token); token = ""; }
    } else token += character;
  }
  if (quote) throw new Error("Unterminated quote in package script");
  if (token) tokens.push(token);
  return tokens;
}

function canonicalRelativePath(value) {
  const normalized = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  const parts = normalized.split("/");
  if (!normalized || isAbsolute(normalized) || /^[a-z]:/i.test(normalized)
    || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error(`Receipt input must be a canonical app-relative path: ${String(value)}`);
  }
  return normalized;
}

async function fileIdentity(value, { allowEmpty = false } = {}) {
  const normalized = canonicalRelativePath(value);
  const absolute = resolve(root, normalized);
  const entry = await lstat(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Receipt input must be a regular non-symlink file: ${normalized}`);
  const physical = await realpath(absolute);
  const escaped = relative(root, physical);
  if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error(`Receipt input escapes app root: ${normalized}`);
  const bytes = await readFile(physical);
  if (!allowEmpty && bytes.length === 0) throw new Error(`Receipt input is empty: ${normalized}`);
  return { value: normalized, bytes: bytes.length, sha256: sha256(bytes) };
}

async function resolveInvocation(command) {
  const [head, ...tail] = tokenize(command);
  if (!head) throw new Error("Package script is empty");
  const normalizedHead = head.replaceAll("\\", "/").toLowerCase();
  if (normalizedHead === "node") {
    return { executable: process.execPath, launcherKind: "current-node", argv: tail };
  }
  if (normalizedHead === "vendor/node/win32-x64/node.exe") {
    const launcher = await fileIdentity(head);
    return { executable: resolve(root, launcher.value), launcherKind: "repo-file", launcher, argv: tail };
  }
  if (normalizedHead === "tsx") {
    return { executable: process.execPath, launcherKind: "current-node", argv: ["node_modules/tsx/dist/cli.mjs", ...tail] };
  }
  if (normalizedHead === "vitest") {
    return { executable: process.execPath, launcherKind: "current-node", argv: ["node_modules/vitest/vitest.mjs", ...tail] };
  }
  if (!isAbsolute(head) && /\.exe$/i.test(head)) {
    const launcher = await fileIdentity(head);
    return { executable: resolve(root, launcher.value), launcherKind: "repo-file", launcher, argv: tail };
  }
  throw new Error(`Unsupported shell-free launcher: ${head}`);
}

async function runChild(executable, argv) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, argv, { cwd: root, env: process.env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    let timer;
    let terminationTimer;
    const maximumBytes = 32 * 1024 * 1024;
    const terminate = (error) => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      try { child.kill(); } catch { /* A concurrent close is handled below. */ }
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else if (process.platform !== "win32") {
        try { child.kill("SIGKILL"); } catch { /* A concurrent close is handled below. */ }
      }
      terminationTimer = setTimeout(() => {
        reject(new AggregateError([failure], `Owned package-script child ${child.pid ?? "unknown"} did not close after termination`));
      }, 5_000);
    };
    const collect = (target) => (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        terminate(new Error(`Child output exceeded ${maximumBytes} bytes`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => terminate(error));
    timer = setTimeout(() => terminate(new Error(`Child timed out after ${timeoutMs}ms`)), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      if (failure) reject(failure);
      else resolvePromise({ exitCode: code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

const MANAGED_SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".rs", ".toml", ".ts", ".tsx"]);

async function collectManagedSourceInputs(values, relativeDirectory) {
  const absoluteDirectory = resolve(root, relativeDirectory);
  let entries;
  try { entries = await readdir(absoluteDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const value = `${relativeDirectory}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`Managed source inventory must not contain symlinks: ${value}`);
    if (entry.isDirectory()) await collectManagedSourceInputs(values, value);
    else if (entry.isFile() && MANAGED_SOURCE_EXTENSIONS.has(value.slice(value.lastIndexOf(".")))) {
      values.set(value.toLowerCase(), value);
    }
  }
}

async function replayInputs(invocation) {
  const values = new Map([
    ["package.json", "package.json"],
    ["scripts/capture-product-script-receipt.mjs", "scripts/capture-product-script-receipt.mjs"],
    ["scripts/lib/product-ledger-transaction.mjs", "scripts/lib/product-ledger-transaction.mjs"],
  ]);
  for (const candidate of ["package-lock.json", "node_modules/.package-lock.json", "tsconfig.json", "vite.config.ts", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json"]) {
    try {
      const entry = await lstat(resolve(root, candidate));
      if (entry.isFile() && !entry.isSymbolicLink()) values.set(candidate.toLowerCase(), candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const sourceRoot of ["scripts", "src", "src-tauri/src"]) await collectManagedSourceInputs(values, sourceRoot);
  if (invocation.launcherKind === "repo-file") values.set(invocation.launcher.value.toLowerCase(), invocation.launcher.value);
  for (const item of invocation.argv) {
    if (isAbsolute(item) || item.split(/[\\/]/).includes("..")) {
      throw new Error(`Replay argv must not escape the app root: ${item}`);
    }
    try {
      const normalized = canonicalRelativePath(item);
      const candidate = await stat(resolve(root, normalized));
      if (candidate.isFile()) values.set(normalized.toLowerCase(), normalized);
    } catch (error) {
      if (error?.code !== "ENOENT" && !String(error?.message).startsWith("Receipt input must be a canonical")) throw error;
    }
  }
  const identities = [];
  for (const value of [...values.values()].sort()) identities.push(await fileIdentity(value));
  return identities;
}

async function directoryMatches(directory, expectedFiles) {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const physical = await realpath(directory);
    const escaped = relative(await realpath(root), physical);
    if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) return false;
    const names = (await readdir(directory)).sort();
    if (names.length !== expectedFiles.size || names.some((name) => !expectedFiles.has(name))) return false;
    for (const [name, expected] of expectedFiles) {
      const filePath = resolve(directory, name);
      const fileEntry = await lstat(filePath);
      if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || !(await readFile(filePath)).equals(expected)) return false;
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeLedgerReceipt(receiptIdentity) {
  const ledgerBytes = await readFile(ledgerPath);
  const document = JSON.parse(ledgerBytes.toString("utf8"));
  let updated = 0;
  const states = document.obligations.flatMap((obligation) => [obligation, ...Object.values(obligation.scopeStates ?? {})]);
  for (const state of states) {
    if (state.status !== "verified") continue;
    for (const evidence of state.evidence ?? []) {
      if (evidence.kind !== "npm_script" || evidence.value !== scriptName) continue;
      if (evidence.commandSha256 !== commandSha256) {
        throw new Error(`Ledger command identity is stale for npm script: ${scriptName}`);
      }
      evidence.receipt = receiptIdentity;
      updated += 1;
    }
  }
  if (updated === 0) throw new Error(`No verified ledger evidence references npm script: ${scriptName}`);
  document.updatedAt = new Date().toISOString().slice(0, 10);
  await replaceFileTransactionally({
    filePath: ledgerPath,
    expectedBytes: ledgerBytes,
    replacementBytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"),
    transactionName: `receipt-capture:${scriptName}`,
  });
  return updated;
}

if (!scriptName) throw new Error("Usage: node scripts/capture-product-script-receipt.mjs --script <package-script> [--timeout-ms <ms>]");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error("--timeout-ms must be 1000..3600000");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const command = packageJson.scripts?.[scriptName];
if (typeof command !== "string" || !command.trim()) throw new Error(`Unknown package script: ${scriptName}`);
const commandSha256 = sha256Text(command);
const invocation = await resolveInvocation(command);
const inputs = await replayInputs(invocation);
const child = await runChild(invocation.executable, invocation.argv);
if (child.exitCode !== 0 || child.signal !== null) {
  process.stderr.write(child.stderr);
  throw new Error(`Package script child failed: ${scriptName} (exit=${child.exitCode}, signal=${child.signal ?? "none"})`);
}

const executableBytes = invocation.launcherKind === "current-node" ? await readFile(process.execPath) : undefined;
const launcher = invocation.launcherKind === "current-node"
  ? { kind: "current-node", version: process.version, bytes: executableBytes.length, sha256: sha256(executableBytes) }
  : { kind: "repo-file", ...invocation.launcher };
const childResult = {
  stdout: { bytes: child.stdout.length, sha256: sha256(child.stdout) },
  stderr: { bytes: child.stderr.length, sha256: sha256(child.stderr) },
};
const runSha256 = sha256Text(JSON.stringify({ scriptName, commandSha256, launcher, argv: invocation.argv, inputs, childResult }));
const successMarker = `EDITKIN_SCRIPT_RECEIPT_OK:${scriptName}:${runSha256}`;
const retainedStdout = Buffer.concat([child.stdout, Buffer.from(`${child.stdout.length && child.stdout.at(-1) !== 0x0a ? "\n" : ""}${successMarker}\n`, "utf8")]);
const relativeDirectory = `.rd/capability-receipts/${safeName(scriptName)}/${runSha256.slice(0, 24)}`;
const directory = resolve(root, relativeDirectory);
const stdoutPath = `${relativeDirectory}/stdout.log`;
const stderrPath = `${relativeDirectory}/stderr.log`;
const receiptPath = `${relativeDirectory}/receipt.json`;
const receipt = {
  schemaVersion: 1,
  kind: "editkin/npm-script-execution-receipt-v1",
  status: "GREEN",
  productVersion: packageJson.version,
  claimBoundary: "Proves this shell-free package command exited zero against the recorded managed source inventory and launcher. It does not replace the command's own product-quality assertions or prove undeclared external inputs.",
  script: { name: scriptName, command, commandSha256 },
  replay: { cwd: ".", launcher, argv: invocation.argv, successMarker, markerOrigin: "capture-wrapper-after-child-close" },
  inputCoverage: { contract: "editkin-managed-source-closed-world/v1", roots: ["scripts", "src", "src-tauri/src"], count: inputs.length },
  inputs,
  result: {
    exitCode: 0,
    signal: null,
    childResultSha256: sha256Text(JSON.stringify(childResult)),
    stdout: { value: stdoutPath, bytes: retainedStdout.length, sha256: sha256(retainedStdout) },
    stderr: { value: stderrPath, bytes: child.stderr.length, sha256: sha256(child.stderr) },
  },
};
const parent = resolve(receiptRoot, safeName(scriptName));
await mkdir(parent, { recursive: true });
const parentEntry = await lstat(parent);
const parentPhysical = await realpath(parent);
const parentEscape = relative(await realpath(root), parentPhysical);
if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink() || parentEscape === ".." || parentEscape.startsWith(`..${sep}`) || isAbsolute(parentEscape)) {
  throw new Error("Capability receipt directory must be a real directory inside the app root");
}
const temporaryDirectory = await mkdtemp(resolve(parent, ".capture-"));
const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
const captureFiles = new Map([
  ["stdout.log", retainedStdout],
  ["stderr.log", child.stderr],
  ["receipt.json", receiptBytes],
]);
try {
  await writeFile(resolve(temporaryDirectory, "stdout.log"), retainedStdout, { flag: "wx" });
  await writeFile(resolve(temporaryDirectory, "stderr.log"), child.stderr, { flag: "wx" });
  await writeFile(resolve(temporaryDirectory, "receipt.json"), receiptBytes, { flag: "wx" });
  try {
    await rename(temporaryDirectory, directory);
  } catch (error) {
    if (!await directoryMatches(directory, captureFiles)) throw error;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
} catch (error) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}
const receiptIdentity = await fileIdentity(receiptPath);
const updatedReferences = await writeLedgerReceipt(receiptIdentity);
process.stdout.write(`${JSON.stringify({ status: "CAPTURED", scriptName, commandSha256, receipt: receiptIdentity, updatedReferences })}\n`);

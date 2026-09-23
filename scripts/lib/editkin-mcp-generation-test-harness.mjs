import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, hashBytes } from "./editkin-mcp-generation-contract.mjs";
import { inspectMcpGenerationCandidate } from "./editkin-mcp-generation-preflight.mjs";

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function encodePayload(value) {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

export function decodePayload(value) {
  const text = Buffer.from(value, "base64url").toString("utf8");
  const parsed = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error("Self-test child payload is not canonical JSON");
  return parsed;
}

export async function runOwnedProcess(executable, args, timeoutMs = 60_000) {
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const closed = await new Promise((resolveClose) => {
    child.once("error", (error) => resolveClose({ code: null, error, signal: null }));
    child.once("close", (code, signal) => resolveClose({ code, error: null, signal }));
  });
  clearTimeout(timer);
  return {
    ...closed,
    pid: child.pid,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
    timedOut,
  };
}

export async function runFixtureBootstrap(selfPath, fixtureChildFlag) {
  const root = await mkdtemp(join(tmpdir(), "editkin-mcp-snapshot-"));
  const bootstrapVendorRoot = resolve(root, "Editkin App/vendor/node/win32-x64");
  const bootstrapNode = resolve(bootstrapVendorRoot, "node.exe");
  try {
    await mkdir(bootstrapVendorRoot, { recursive: true });
    await copyFile(process.execPath, bootstrapNode);
    const sha256 = await sha256File(bootstrapNode);
    const manifest = {
      source: `https://nodejs.org/dist/v${process.versions.node}/node-v${process.versions.node}-win-x64.zip`,
      version: process.versions.node,
      archiveSha256: "a".repeat(64),
      nodeExeSha256: sha256,
      licenseSha256: "b".repeat(64),
    };
    await writeFile(resolve(bootstrapVendorRoot, "manifest.json"), canonicalJson(manifest));
    const child = await runOwnedProcess(bootstrapNode, [selfPath, fixtureChildFlag, encodePayload({ root })]);
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    return child.timedOut ? 124 : (child.code ?? 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runUnownedRuntimeProbe(encoded) {
  const payload = decodePayload(encoded);
  let spawned = 0;
  try {
    await inspectMcpGenerationCandidate(payload.candidateId, {
      appRoot: payload.appRoot,
      supervisorHooks: { onChildSpawn: () => { spawned += 1; } },
    });
    throw new Error("Unowned runtime unexpectedly passed candidate preflight");
  } catch (error) {
    if (!/lexical pinned Node 22 executable path/u.test(error?.message) || spawned !== 0) throw error;
    process.stdout.write(canonicalJson({ spawned, status: "GREEN_UNOWNED_RUNTIME_REJECTED" }));
  }
}

export function childEvents() {
  const spawned = [];
  const terminationRequests = [];
  const exits = [];
  const stderr = [];
  return {
    spawned,
    terminationRequests,
    exits,
    stderr,
    hooks: {
      onChildSpawn: (event) => spawned.push(event),
      onChildTerminationRequested: (event) => terminationRequests.push(event),
      onChildExit: (event) => exits.push(event),
      onChildStderr: (event) => stderr.push(event.chunk),
    },
  };
}

export function assertProcessGone(pid) {
  assert.throws(
    () => process.kill(pid, 0),
    (error) => error?.code === "ESRCH",
    `Preflight worker ${pid} is still alive after its close event`,
  );
}

export async function mutateAndRestore(path, action) {
  const original = await readFile(path);
  try {
    await action(original);
  } finally {
    await writeFile(path, original);
  }
}

// Small owned attack-fixture trees only; never follow the junctions under test.
export async function inventoryFixtureTree(root) {
  const inventory = [];
  async function visit(path, relativePath) {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      inventory.push({ path: relativePath, type: "link", target: await readlink(path) });
    } else if (details.isDirectory()) {
      inventory.push({ path: relativePath, type: "directory" });
      for (const name of (await readdir(path)).sort()) await visit(resolve(path, name), `${relativePath}/${name}`);
    } else {
      assert(details.isFile(), `Unexpected fixture entry: ${path}`);
      inventory.push({ path: relativePath, type: "file", bytes: details.size, sha256: hashBytes(await readFile(path)) });
    }
  }
  await visit(root, ".");
  return inventory;
}

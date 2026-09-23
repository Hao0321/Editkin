import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runOwnedProcess } from "./lib/owned-process-runner.mjs";
import {
  assertTauriArtifactTargetBinding,
  assertTauriCandidateArtifactRoot,
  inspectWindowsTauriCandidatePrimaryArtifacts,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";

const APP_ROOT = resolve(import.meta.dirname, "..");
const WORKSPACE_ROOT = resolve(APP_ROOT, "../..");
const PINNED_NODE = resolve(APP_ROOT, "vendor/node/win32-x64/node.exe");
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(path) {
  return path.split(sep).join("/");
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === "--self-test") return { selfTest: true };
  let artifactRoot;
  const buildArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--artifact-root") {
      if (args[index] !== "--ci" && args[index] !== "--verbose") throw new Error(`Isolation runner rejects argument: ${args[index]}`);
      buildArgs.push(args[index]);
      continue;
    }
    const value = args[index + 1];
    if (artifactRoot || !value || value.startsWith("--")) throw new Error("Isolation runner requires exactly one --artifact-root");
    artifactRoot = value;
    index += 1;
  }
  if (!artifactRoot) throw new Error("Isolation runner requires exactly one --artifact-root");
  return { selfTest: false, artifactRoot, buildArgs };
}

async function fileIdentity(path) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Expected regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return { bytes: details.size, sha256: hash.digest("hex") };
}

async function inventoryTree(rootInput) {
  const root = resolve(rootInput);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Protected runtime root is not a regular directory: ${root}`);
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const path = resolve(directory, child.name);
      const item = await lstat(path);
      const name = normalize(relative(root, path));
      if (item.isSymbolicLink()) throw new Error(`Protected runtime contains a symlink/junction/reparse point: ${name}`);
      if (item.isDirectory()) {
        entries.push({ path: name, kind: "directory" });
        await visit(path);
      } else if (item.isFile()) {
        entries.push({ path: name, kind: "file", ...await fileIdentity(path) });
      } else throw new Error(`Protected runtime contains an unsupported entry: ${name}`);
    }
  }
  await visit(root);
  return entries;
}

async function powershellProcesses() {
  if (process.platform !== "win32") throw new Error("The live-runtime isolation runner is currently Windows-only");
  const systemRoot = resolve(process.env.SystemRoot ?? "C:/Windows");
  if (!isAbsolute(systemRoot)) throw new Error("SystemRoot is not absolute");
  const powershell = resolve(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await runOwnedProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    cwd: APP_ROOT,
    timeoutMs: 30_000,
  });
  const value = JSON.parse(result.stdout || "[]");
  return Array.isArray(value) ? value : [value];
}

async function protectedMcpProcesses(canonicalRuntimeRoot) {
  const expectedExecutable = resolve(canonicalRuntimeRoot, "node.exe");
  const expectedMcp = normalize(resolve(canonicalRuntimeRoot, "mcp.mjs")).toLocaleLowerCase("en-US");
  const candidates = (await powershellProcesses()).filter((item) => {
    const executable = typeof item.ExecutablePath === "string" ? resolve(item.ExecutablePath) : "";
    const command = normalize(String(item.CommandLine ?? "")).toLocaleLowerCase("en-US");
    return executable && resolve(executable).toLocaleLowerCase("en-US") === expectedExecutable.toLocaleLowerCase("en-US")
      && command.includes(expectedMcp);
  });
  const executable = candidates.length ? await fileIdentity(expectedExecutable) : undefined;
  return candidates.map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    executable: { path: normalize(expectedExecutable), ...executable },
    commandSha256: sha256(String(item.CommandLine ?? "")),
  })).sort((left, right) => left.pid - right.pid);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateBuildIsolationCell(input) {
  const failures = [];
  if (!sameJson(input.preRuntime, input.postRuntime)) failures.push("canonical-runtime-byte-drift");
  if (!Array.isArray(input.preProcesses) || input.preProcesses.length === 0) failures.push("no-protected-live-mcp-process");
  for (const before of input.preProcesses ?? []) {
    const after = input.postProcesses?.find((item) => item.pid === before.pid);
    if (!after) failures.push(`protected-pid-exited:${before.pid}`);
    else if (!sameJson(before, after)) failures.push(`protected-pid-identity-drift:${before.pid}`);
  }
  if (input.build?.code !== 0 || input.build?.signal || input.build?.timedOut || input.build?.closed !== true) failures.push("build-child-not-clean-exit");
  if (input.build?.successMarker !== true) failures.push("build-success-marker-missing");
  if (!input.artifactTarget || input.artifactTarget.root !== input.expectedArtifactRoot
    || !SHA256.test(input.artifactTarget.executable?.sha256 ?? "") || input.artifactTarget.executable?.bytes <= 0
    || !SHA256.test(input.artifactTarget.installer?.sha256 ?? "") || input.artifactTarget.installer?.bytes <= 0) {
    failures.push("candidate-primary-artifact-invalid");
  }
  const gates = input.gates ?? {};
  for (const name of ["artifact", "autoRoto", "agentConnect", "security"]) {
    if (gates[name]?.status !== "GREEN" || gates[name]?.artifactRoot !== input.expectedArtifactRoot) failures.push(`gate-target-or-status:${name}`);
  }
  return { status: failures.length ? "BLOCK" : "GREEN_BUILD_ISOLATION_CELL", failures };
}

function runSelfTest() {
  const processIdentity = { pid: 7, parentPid: 3, executable: { path: "runtime/node.exe", bytes: 10, sha256: "a".repeat(64) }, commandSha256: "b".repeat(64) };
  const artifactTarget = {
    root: "src-tauri/product-release-candidates/fixture/release",
    executable: { bytes: 10, sha256: "c".repeat(64) },
    installer: { bytes: 20, sha256: "d".repeat(64) },
  };
  const valid = {
    preRuntime: [{ path: "mcp.mjs", kind: "file", bytes: 5, sha256: "e".repeat(64) }],
    postRuntime: [{ path: "mcp.mjs", kind: "file", bytes: 5, sha256: "e".repeat(64) }],
    preProcesses: [processIdentity], postProcesses: [structuredClone(processIdentity)],
    build: { code: 0, signal: null, timedOut: false, closed: true, successMarker: true },
    expectedArtifactRoot: artifactTarget.root,
    artifactTarget,
    gates: Object.fromEntries(["artifact", "autoRoto", "agentConnect", "security"].map((name) => [name, { status: "GREEN", artifactRoot: artifactTarget.root }])),
  };
  assert.equal(evaluateBuildIsolationCell(valid).status, "GREEN_BUILD_ISOLATION_CELL");
  const mutations = [
    (value) => { value.postRuntime[0].sha256 = "f".repeat(64); },
    (value) => { value.postProcesses = []; },
    (value) => { value.build.code = 1; },
    (value) => { value.build.successMarker = false; },
    (value) => { value.artifactTarget.installer.sha256 = "bad"; },
    (value) => { value.gates.security.artifactRoot = "src-tauri/target/release"; },
    (value) => { value.gates.autoRoto.status = "BLOCK"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid);
    mutate(value);
    assert.equal(evaluateBuildIsolationCell(value).status, "BLOCK");
  }
  process.stdout.write(`${JSON.stringify({ status: "GREEN_SELF_TEST", negativeControls: mutations.length })}\n`);
}

async function diskFree(path) {
  const details = await statfs(path, { bigint: true });
  return Number(details.bavail * details.bsize);
}

async function logicalTreeBytes(root) {
  let bytes = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error(`Candidate peak estimate rejects symlink/junction/reparse entry: ${path}`);
      if (details.isDirectory()) await visit(path);
      else if (details.isFile()) bytes += details.size;
      else throw new Error(`Candidate peak estimate found unsupported target entry: ${path}`);
    }
  }
  await visit(root);
  return bytes;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function gateEvidence(candidate, version, startedAtMs) {
  const [artifact, autoRoto, agentConnect, security] = await Promise.all([
    readJson(resolve(WORKSPACE_ROOT, `.rd/benchmarks/editkin-artifact-lifecycle-${version}-windows-x64.json`)),
    readJson(resolve(APP_ROOT, ".rd/benchmarks/editkin-auto-roto-native-product-artifact-freshness/report.json")),
    readJson(resolve(WORKSPACE_ROOT, `.rd/benchmarks/editkin-product-agent-connect-delivery-${version}-windows-x64.json`)),
    readJson(resolve(WORKSPACE_ROOT, `.rd/benchmarks/editkin-security-hardening-${version}-windows-x64-internal.json`)),
  ]);
  const observed = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, version);
  assertTauriArtifactTargetBinding(candidate, artifact.artifactTarget, observed);
  assertTauriArtifactTargetBinding(candidate, security.artifactTarget, observed);
  const generated = [artifact.generatedAt, autoRoto.generatedAt, agentConnect.generatedAt, security.generatedAt];
  if (generated.some((value) => !value || Date.parse(value) < startedAtMs)) throw new Error("A build gate receipt predates this isolation invocation");
  const expectedRuntime = normalize(relative(APP_ROOT, resolve(candidate.artifactRoot, "runtime")));
  const expectedBinary = normalize(relative(APP_ROOT, resolve(candidate.artifactRoot, "editkin.exe")));
  const expectedInstaller = normalize(relative(WORKSPACE_ROOT, resolve(candidate.artifactRoot, observed.installer.path)));
  return {
    artifact: { status: artifact.status, artifactRoot: artifact.artifactTarget?.root },
    autoRoto: {
      status: String(autoRoto.status).startsWith("GREEN_") && autoRoto.staging?.tauri?.root === expectedRuntime
        && autoRoto.binaries?.tauri?.path === expectedBinary ? "GREEN" : "BLOCK",
      artifactRoot: autoRoto.binaries?.tauri?.receipt?.artifactTarget?.root,
    },
    agentConnect: { status: agentConnect.status, artifactRoot: agentConnect.installer?.path === expectedInstaller ? candidate.relativeArtifactRoot : "mismatch" },
    security: { status: security.status, artifactRoot: security.artifactTarget?.root },
  };
}

async function writeReceipt(path, receipt) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.candidate`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function main(args) {
  if (process.platform !== "win32") throw new Error("The live-runtime isolation runner is currently Windows-only");
  if (!existsSync(PINNED_NODE)) throw new Error(`Pinned Node is missing: ${PINNED_NODE}`);
  const candidate = resolveTauriCandidateArtifactRoot(APP_ROOT, args.artifactRoot);
  await assertTauriCandidateArtifactRoot(candidate, "build");
  const receiptPath = resolve(APP_ROOT, `.rd/benchmarks/tauri-build-isolation/${candidate.candidateId}.json`);
  if (existsSync(receiptPath)) throw new Error(`Isolation invocation receipt already exists: ${receiptPath}`);
  const canonicalRuntime = resolve(APP_ROOT, "src-tauri/target/release/runtime");
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const observedCanonicalTargetLogicalBytes = await logicalTreeBytes(resolve(APP_ROOT, "src-tauri/target"));
  const diskBefore = {
    systemTempFreeBytes: await diskFree(tmpdir()),
    workspaceFreeBytes: await diskFree(APP_ROOT),
    observedCanonicalTargetLogicalBytes,
    candidatePeakEstimateBytes: Math.ceil(observedCanonicalTargetLogicalBytes * 1.35),
    candidatePeakEstimateBasis: "135-percent-of-current-canonical-cargo-target-logical-bytes",
  };
  const preRuntime = await inventoryTree(canonicalRuntime);
  const preProcesses = await protectedMcpProcesses(canonicalRuntime);
  if (preProcesses.length === 0) throw new Error("No live canonical Editkin MCP process is available for the frozen isolation cell");
  let childResult;
  let childError;
  try {
    childResult = await runOwnedProcess(PINNED_NODE, [resolve(APP_ROOT, "scripts/tauri-build.mjs"), "--artifact-root", candidate.artifactRoot, ...args.buildArgs], {
      cwd: APP_ROOT,
      timeoutMs: 60 * 60_000,
      cleanupWaitMs: 30_000,
    });
  } catch (error) {
    childError = String(error);
    childResult = error.result ?? { code: null, signal: null, timedOut: false, closed: false, stdout: "", stderr: childError };
  }
  let postRuntime;
  let postProcesses;
  const observationErrors = [];
  try { postRuntime = await inventoryTree(canonicalRuntime); }
  catch (error) { observationErrors.push(`post-runtime:${String(error)}`); }
  try { postProcesses = await protectedMcpProcesses(canonicalRuntime); }
  catch (error) { observationErrors.push(`post-processes:${String(error)}`); }
  let artifactTarget;
  let gates;
  let verificationError;
  if (childResult.code === 0 && !childResult.signal && !childResult.timedOut) {
    try {
      const packageJson = await readJson(resolve(APP_ROOT, "package.json"));
      artifactTarget = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, packageJson.version);
      gates = await gateEvidence(candidate, packageJson.version, startedAtMs);
    } catch (error) {
      verificationError = String(error);
    }
  }
  const build = {
    pid: childResult.pid ?? null,
    code: childResult.code,
    signal: childResult.signal ?? null,
    timedOut: childResult.timedOut === true,
    closed: childResult.closed === true,
    successMarker: String(childResult.stdout ?? "").includes(`"status":"GREEN_ISOLATED_TAURI_BUILD","artifactRoot":"${candidate.relativeArtifactRoot}"`),
    stdoutSha256: sha256(String(childResult.stdout ?? "")),
    stderrSha256: sha256(String(childResult.stderr ?? "")),
    stdoutTail: String(childResult.stdout ?? "").slice(-32_768),
    stderrTail: String(childResult.stderr ?? "").slice(-32_768),
    error: childError ?? null,
  };
  const decision = evaluateBuildIsolationCell({
    preRuntime, postRuntime, preProcesses, postProcesses, build, artifactTarget,
    expectedArtifactRoot: candidate.relativeArtifactRoot, gates,
  });
  const receipt = {
    schema: "editkin.tauri-live-runtime-build-isolation/v1",
    status: decision.status,
    startedAt,
    finishedAt: new Date().toISOString(),
    artifactRoot: candidate.relativeArtifactRoot,
    protectedCanonicalRuntime: normalize(relative(APP_ROOT, canonicalRuntime)),
    diskBefore,
    preRuntime,
    postRuntime,
    preProcesses,
    postProcesses,
    build,
    artifactTarget: artifactTarget ?? null,
    gates: gates ?? null,
    failures: [...decision.failures, ...observationErrors, ...(verificationError ? [`verification:${verificationError}`] : [])],
    claimBoundary: "Build isolation only; no installation, provider deployment, phone reconnect, macOS, promotion or release-readiness claim.",
  };
  await writeReceipt(receiptPath, receipt);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, receiptPath, artifactRoot: receipt.artifactRoot, failures: receipt.failures })}\n`);
  if (receipt.status !== "GREEN_BUILD_ISOLATION_CELL") process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) runSelfTest();
else await main(args);

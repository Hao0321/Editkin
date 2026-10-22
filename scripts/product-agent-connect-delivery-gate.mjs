import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectWindowsTauriCandidatePrimaryArtifacts,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";

export const PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA = "editkin.product-agent-connect-delivery/v1";
export const PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY = Object.freeze([
  "agent-setup-contract.json",
  "launcher.mjs",
]);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const WORKSPACE_ROOT = resolve(APP_ROOT, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has an unexpected closed-world field set`);
  }
}

function normalizedRelative(root, path) {
  const value = relative(root, path);
  if (!value || value.startsWith("..") || isAbsolute(value)) throw new Error(`Path escaped delivery root: ${path}`);
  return value.split(sep).join("/");
}

async function regularFileIdentity(path, label, { includeContents = false } = {}) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) {
    throw new Error(`${label} is not a non-empty regular file`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  const identity = { bytes: details.size, sha256: hash.digest("hex") };
  return includeContents ? { ...identity, contents: await readFile(path) } : identity;
}

function assertLauncherContract(contract) {
  assertExactKeys(
    contract,
    ["schemaVersion", "contractVersion", "serverId", "launcher", "starterPrompt", "envKeys"],
    "Agent setup contract",
  );
  assertExactKeys(
    contract.launcher,
    ["schemaVersion", "entrypointMode", "resourceRelativePath", "embeddedContractRelativePath", "stateEnvKey", "stateDirectoryName", "args"],
    "Agent setup launcher contract",
  );
  if (contract.schemaVersion !== 2 || contract.contractVersion !== "editkin.agent-setup/v2"
    || contract.serverId !== "editkin" || contract.launcher.schemaVersion !== 3
    || contract.launcher.entrypointMode !== "stable_generation_launcher"
    || contract.launcher.resourceRelativePath !== "agent-runtime-v3/launcher.mjs"
    || contract.launcher.embeddedContractRelativePath !== "agent-runtime-v3/agent-setup-contract.json"
    || contract.launcher.stateEnvKey !== "EDITKIN_AGENT_STATE_ROOT"
    || contract.launcher.stateDirectoryName !== "agent-runtime-v3"
    || !Array.isArray(contract.launcher.args) || contract.launcher.args.length !== 0
    || !Array.isArray(contract.envKeys)
    || contract.envKeys.length !== new Set(contract.envKeys).size
    || !contract.envKeys.includes("EDITKIN_AGENT_STATE_ROOT")) {
    throw new Error("Delivered Agent setup contract is not the closed-world v3 launcher contract");
  }
  return contract.launcher;
}

function assertTauriResourceMapping(baseConfig, platformConfig) {
  const mappings = baseConfig?.bundle?.resources;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Tauri base resource mapping is missing");
  }
  const expected = new Map([
    ["../scripts/editkin-product-mcp-launcher.mjs", "agent-runtime-v3/launcher.mjs"],
    ["../src/shared/agentSetupContract.json", "agent-runtime-v3/agent-setup-contract.json"],
  ]);
  const actualAgentMappings = Object.entries(mappings)
    .filter(([, destination]) => typeof destination === "string" && destination.startsWith("agent-runtime-v3/"));
  if (actualAgentMappings.length !== expected.size
    || actualAgentMappings.some(([source, destination]) => expected.get(source) !== destination)) {
    throw new Error("Tauri base config does not map the exact product Agent launcher resources");
  }
  const platformMappings = platformConfig?.bundle?.resources ?? {};
  if (Object.values(platformMappings).some((destination) => typeof destination === "string" && destination.startsWith("agent-runtime-v3/"))) {
    throw new Error("Tauri platform config must not override product Agent launcher resources");
  }
}

export async function inspectExtractedProductAgentConnect({
  extractedRoot,
  installerPath,
  sourceLauncherPath = resolve(APP_ROOT, "scripts/editkin-product-mcp-launcher.mjs"),
  sourceContractPath = resolve(APP_ROOT, "src/shared/agentSetupContract.json"),
  verifierPath = SCRIPT_PATH,
  tauriBaseConfigPath = resolve(APP_ROOT, "src-tauri/tauri.conf.json"),
  tauriPlatformConfigPath = resolve(APP_ROOT, "src-tauri/tauri.windows.conf.json"),
  generatedAt = new Date().toISOString(),
} = {}) {
  const agentRoot = resolve(extractedRoot, "agent-runtime-v3");
  const agentRootDetails = await lstat(agentRoot);
  if (!agentRootDetails.isDirectory() || agentRootDetails.isSymbolicLink()) {
    throw new Error("Delivered agent-runtime-v3 is not a regular directory");
  }
  const entries = await readdir(agentRoot, { withFileTypes: true });
  const inventory = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(inventory) !== JSON.stringify(PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY)) {
    throw new Error("Delivered agent-runtime-v3 inventory is not closed-world");
  }

  const deliveredLauncherPath = resolve(agentRoot, "launcher.mjs");
  const deliveredContractPath = resolve(agentRoot, "agent-setup-contract.json");
  const [installer, launcher, embeddedContract, sourceLauncher, sourceContract, verifier, baseConfigFile, platformConfigFile] = await Promise.all([
    regularFileIdentity(installerPath, "Installer"),
    regularFileIdentity(deliveredLauncherPath, "Delivered Agent launcher"),
    regularFileIdentity(deliveredContractPath, "Delivered Agent contract", { includeContents: true }),
    regularFileIdentity(sourceLauncherPath, "Source Agent launcher"),
    regularFileIdentity(sourceContractPath, "Source Agent contract"),
    regularFileIdentity(verifierPath, "Agent delivery verifier"),
    regularFileIdentity(tauriBaseConfigPath, "Tauri base config", { includeContents: true }),
    regularFileIdentity(tauriPlatformConfigPath, "Tauri platform config", { includeContents: true }),
  ]);
  if (launcher.sha256 !== sourceLauncher.sha256 || embeddedContract.sha256 !== sourceContract.sha256) {
    throw new Error("Delivered Agent launcher resources are stale relative to current source bytes");
  }
  const contract = JSON.parse(embeddedContract.contents.toString("utf8"));
  const launcherContract = assertLauncherContract(contract);
  assertTauriResourceMapping(
    JSON.parse(baseConfigFile.contents.toString("utf8")),
    JSON.parse(platformConfigFile.contents.toString("utf8")),
  );
  const resourceTree = createHash("sha256");
  for (const [path, identity] of [
    ["agent-setup-contract.json", embeddedContract],
    ["launcher.mjs", launcher],
  ]) resourceTree.update(path).update("\0").update(String(identity.bytes)).update("\0").update(identity.sha256).update("\n");

  const report = {
    schema: PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA,
    status: "GREEN",
    generatedAt,
    installer: {
      path: normalizedRelative(WORKSPACE_ROOT, resolve(installerPath)),
      bytes: installer.bytes,
      sha256: installer.sha256,
    },
    extractedResourceRootSha256: resourceTree.digest("hex"),
    launcher: {
      relativePath: "agent-runtime-v3/launcher.mjs",
      bytes: launcher.bytes,
      sha256: launcher.sha256,
    },
    embeddedContract: {
      relativePath: "agent-runtime-v3/agent-setup-contract.json",
      bytes: embeddedContract.bytes,
      sha256: embeddedContract.sha256,
      schemaVersion: contract.schemaVersion,
      contractVersion: contract.contractVersion,
    },
    closedWorldConfig: {
      entrypointMode: launcherContract.entrypointMode,
      launcherArgs: launcherContract.args,
      launcherResourceRelativePath: launcherContract.resourceRelativePath,
      embeddedContractRelativePath: launcherContract.embeddedContractRelativePath,
      stateEnvKey: launcherContract.stateEnvKey,
      stateDirectoryName: launcherContract.stateDirectoryName,
      resourceInventory: [...PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY],
      directMcpEntrypointAllowed: false,
    },
    sourceIdentities: {
      verifierSha256: verifier.sha256,
      tauriBaseConfigSha256: baseConfigFile.sha256,
      tauriPlatformConfigSha256: platformConfigFile.sha256,
    },
  };
  assertExactKeys(report, [
    "schema", "status", "generatedAt", "installer", "extractedResourceRootSha256",
    "launcher", "embeddedContract", "closedWorldConfig", "sourceIdentities",
  ], "Product Agent Connect delivery report");
  for (const identity of [
    report.installer.sha256,
    report.extractedResourceRootSha256,
    report.launcher.sha256,
    report.embeddedContract.sha256,
    ...Object.values(report.sourceIdentities),
  ]) if (!SHA256.test(identity)) throw new Error("Product Agent Connect delivery report contains an invalid SHA-256");
  return report;
}

async function writeReceiptAtomically(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.candidate`;
  const previous = `${path}.${process.pid}.${randomUUID()}.previous`;
  let movedPrevious = false;
  try {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await writeFile(temporary, bytes, { flag: "wx" });
    if (sha256(await readFile(temporary)) !== sha256(bytes)) throw new Error("Agent delivery receipt write readback failed");
    if (existsSync(path)) {
      await rename(path, previous);
      movedPrevious = true;
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      if (movedPrevious && !existsSync(path)) await rename(previous, path);
      throw error;
    }
    await rm(previous, { force: true });
  } finally {
    await rm(temporary, { force: true });
  }
}

async function run() {
  if (process.platform !== "win32") throw new Error("Product Agent Connect installer delivery gate is currently defined for Windows NSIS");
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--artifact-root" || !args[1] || args[1].startsWith("--")) {
    throw new Error("Product Agent Connect delivery gate requires exactly one --artifact-root <candidate-release>");
  }
  const packageJson = JSON.parse(await readFile(resolve(APP_ROOT, "package.json"), "utf8"));
  const candidate = resolveTauriCandidateArtifactRoot(APP_ROOT, args[1]);
  const artifactTarget = await inspectWindowsTauriCandidatePrimaryArtifacts(candidate, packageJson.version);
  const installerPath = resolve(candidate.artifactRoot, artifactTarget.installer.path);
  const toolReceipt = JSON.parse(await readFile(resolve(APP_ROOT, "scripts/artifact-toolchain.json"), "utf8"));
  const sevenZipPath = resolve(APP_ROOT, toolReceipt.sevenZip.path);
  const extractedRoot = await mkdtemp(resolve(tmpdir(), "editkin-agent-connect-delivery-"));
  try {
    const extraction = spawnSync(sevenZipPath, ["x", "-y", `-o${extractedRoot}`, installerPath], {
      cwd: APP_ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (extraction.status !== 0) throw new Error(`NSIS extraction failed: ${extraction.stderr || extraction.error?.message || extraction.status}`);
    const report = await inspectExtractedProductAgentConnect({ extractedRoot, installerPath });
    const receiptPath = resolve(WORKSPACE_ROOT, `.rd/benchmarks/editkin-product-agent-connect-delivery-${packageJson.version}-windows-x64.json`);
    await writeReceiptAtomically(receiptPath, report);
    process.stdout.write(`${JSON.stringify({ status: report.status, schema: report.schema, receiptPath, installer: report.installer, launcher: report.launcher, embeddedContract: report.embeddedContract })}\n`);
  } finally {
    await rm(extractedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

const launchedAsMain = process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH);
if (launchedAsMain) await run();

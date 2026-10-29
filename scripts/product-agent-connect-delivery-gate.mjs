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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRODUCT_AGENT_CONTRACT_DESTINATION,
  PRODUCT_AGENT_LAUNCHER_DESTINATION,
  PRODUCT_AGENT_RUNTIME_DIRECTORY,
  productAgentRuntimeResources,
  productAgentTauriResourceMappings,
} from "./lib/agent-launcher-closure.mjs";
import {
  inspectWindowsTauriCandidatePrimaryArtifacts,
  resolveTauriCandidateArtifactRoot,
} from "./lib/tauri-candidate-artifact-root.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const WORKSPACE_ROOT = resolve(APP_ROOT, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const LINKED_MARKER = "EDITKIN_PRODUCT_LAUNCHER_LINKED";

export const PRODUCT_AGENT_CONNECT_DELIVERY_SCHEMA = "editkin.product-agent-connect-delivery/v1";
// Derived from the launcher's actual import graph, never hand-listed: the
// 0.15.0 installer shipped launcher.mjs without ./lib/regular-file.mjs.
export const PRODUCT_AGENT_CONNECT_RESOURCE_INVENTORY = Object.freeze(
  productAgentRuntimeResources(APP_ROOT).map(({ destination }) => destination),
);

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

/** The Tauri bundle must map exactly the launcher's module closure plus the embedded contract. */
export function assertProductAgentTauriResourceMapping(baseConfig, platformConfig, sourceRoot = APP_ROOT) {
  const mappings = baseConfig?.bundle?.resources;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Tauri base resource mapping is missing");
  }
  const expected = productAgentTauriResourceMappings(sourceRoot);
  const prefix = `${PRODUCT_AGENT_RUNTIME_DIRECTORY}/`;
  const actualAgentMappings = Object.entries(mappings)
    .filter(([source, destination]) => expected.has(source)
      || (typeof destination === "string" && (destination === PRODUCT_AGENT_RUNTIME_DIRECTORY || destination.startsWith(prefix))));
  const missing = [...expected].filter(([source, destination]) => mappings[source] !== destination);
  if (actualAgentMappings.length !== expected.size || missing.length
    || actualAgentMappings.some(([source, destination]) => expected.get(source) !== destination)) {
    const detail = missing.map(([source, destination]) => `${source} -> ${destination}`).join(", ");
    throw new Error(`Tauri base config does not map the exact product Agent launcher resources${detail ? `; missing ${detail}` : ""}`);
  }
  const platformMappings = platformConfig?.bundle?.resources ?? {};
  if (Object.entries(platformMappings).some(([source, destination]) => expected.has(source)
    || (typeof destination === "string" && (destination === PRODUCT_AGENT_RUNTIME_DIRECTORY || destination.startsWith(prefix))))) {
    throw new Error("Tauri platform config must not override product Agent launcher resources");
  }
}

async function deliveredFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Delivered agent-runtime-v3 contains a link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`Delivered agent-runtime-v3 contains a non-regular entry: ${path}`);
    }
  }
  await visit(root);
  return files.sort();
}

/** Loads the delivered launcher's module graph from the delivered tree with the delivered Node. */
function assertDeliveredLauncherLinks(nodePath, launcherPath, agentRoot) {
  const probe = [
    `const launcher = await import(${JSON.stringify(pathToFileURL(launcherPath).href)});`,
    "if (typeof launcher.launchProductMcpGeneration !== \"function\") throw new Error(\"launchProductMcpGeneration export is missing\");",
    `process.stdout.write(${JSON.stringify(LINKED_MARKER)});`,
  ].join("\n");
  const child = spawnSync(nodePath, ["--input-type=module", "--eval", probe], {
    cwd: agentRoot,
    encoding: "utf8",
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {},
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (child.status !== 0 || child.stdout !== LINKED_MARKER) {
    const detail = (child.stderr || child.error?.message || `exit ${child.status}`).trim().split(/\r?\n/u).slice(0, 4).join(" | ");
    throw new Error(`Delivered Agent launcher cannot load its module graph from the delivered tree: ${detail}`);
  }
}

export async function inspectExtractedProductAgentConnect({
  extractedRoot,
  installerPath,
  sourceRoot = APP_ROOT,
  verifierPath = SCRIPT_PATH,
  tauriBaseConfigPath = resolve(sourceRoot, "src-tauri/tauri.conf.json"),
  tauriPlatformConfigPath = resolve(sourceRoot, "src-tauri/tauri.windows.conf.json"),
  linkCheckNodePath = resolve(extractedRoot, "runtime", process.platform === "win32" ? "node.exe" : "node"),
  generatedAt = new Date().toISOString(),
} = {}) {
  const agentRoot = resolve(extractedRoot, PRODUCT_AGENT_RUNTIME_DIRECTORY);
  const agentRootDetails = await lstat(agentRoot);
  if (!agentRootDetails.isDirectory() || agentRootDetails.isSymbolicLink()) {
    throw new Error("Delivered agent-runtime-v3 is not a regular directory");
  }
  const resources = productAgentRuntimeResources(sourceRoot);
  const expectedInventory = resources.map(({ destination }) => destination);
  const inventory = await deliveredFiles(agentRoot);
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
    const missing = expectedInventory.filter((path) => !inventory.includes(path));
    const extra = inventory.filter((path) => !expectedInventory.includes(path));
    throw new Error(`Delivered agent-runtime-v3 inventory is not closed-world (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
  }

  const delivered = new Map();
  for (const { source, destination } of resources) {
    const [deliveredIdentity, sourceIdentity] = await Promise.all([
      regularFileIdentity(resolve(agentRoot, destination), `Delivered Agent resource ${destination}`, {
        includeContents: destination === PRODUCT_AGENT_CONTRACT_DESTINATION,
      }),
      regularFileIdentity(resolve(sourceRoot, source), `Source Agent resource ${source}`),
    ]);
    if (deliveredIdentity.sha256 !== sourceIdentity.sha256 || deliveredIdentity.bytes !== sourceIdentity.bytes) {
      throw new Error(`Delivered Agent launcher resources are stale relative to current source bytes: ${destination}`);
    }
    delivered.set(destination, deliveredIdentity);
  }
  const launcher = delivered.get(PRODUCT_AGENT_LAUNCHER_DESTINATION);
  const embeddedContract = delivered.get(PRODUCT_AGENT_CONTRACT_DESTINATION);
  const [installer, verifier, baseConfigFile, platformConfigFile] = await Promise.all([
    regularFileIdentity(installerPath, "Installer"),
    regularFileIdentity(verifierPath, "Agent delivery verifier"),
    regularFileIdentity(tauriBaseConfigPath, "Tauri base config", { includeContents: true }),
    regularFileIdentity(tauriPlatformConfigPath, "Tauri platform config", { includeContents: true }),
  ]);
  const contract = JSON.parse(embeddedContract.contents.toString("utf8"));
  const launcherContract = assertLauncherContract(contract);
  assertProductAgentTauriResourceMapping(
    JSON.parse(baseConfigFile.contents.toString("utf8")),
    JSON.parse(platformConfigFile.contents.toString("utf8")),
    sourceRoot,
  );
  assertDeliveredLauncherLinks(linkCheckNodePath, resolve(agentRoot, PRODUCT_AGENT_LAUNCHER_DESTINATION), agentRoot);
  const resourceTree = createHash("sha256");
  for (const destination of expectedInventory) {
    const identity = delivered.get(destination);
    resourceTree.update(destination).update("\0").update(String(identity.bytes)).update("\0").update(identity.sha256).update("\n");
  }

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
      resourceInventory: expectedInventory,
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

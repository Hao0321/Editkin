import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { replaceFileTransactionally } from "./lib/product-ledger-transaction.mjs";

const root = resolve(import.meta.dirname, "..");
const ledgerPath = resolve(root, "product-capabilities.json");
const packagePath = resolve(root, "package.json");
const mode = process.argv[2] ?? "--check";

if (!new Set(["--check", "--write"]).has(mode)) {
  throw new Error("Usage: node scripts/migrate-product-evidence-identities.mjs --check|--write");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(text) {
  return sha256(Buffer.from(text, "utf8"));
}

function evidenceStates(document) {
  return document.obligations.flatMap((obligation) => [
    { id: obligation.id, scope: "aggregate", state: obligation },
    ...Object.entries(obligation.scopeStates ?? {}).map(([scope, state]) => ({ id: obligation.id, scope, state })),
  ]).filter(({ state }) => state.status === "verified");
}

async function repoFileIdentity(value) {
  const normalized = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  const parts = normalized.split("/");
  if (!normalized || value !== normalized || isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error(`Evidence path must be app-relative: ${String(value)}`);
  }
  const absolute = resolve(root, normalized);
  const entry = await lstat(absolute);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Evidence is not a regular non-symlink file: ${normalized}`);
  const physical = await realpath(absolute);
  const escaped = relative(root, physical);
  if (escaped === "" || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error(`Evidence escapes app root: ${normalized}`);
  const bytes = await readFile(physical);
  if (bytes.length <= 0) throw new Error(`Evidence is empty: ${normalized}`);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function assertExistingIdentity(evidence, expected, label) {
  const hasBytes = evidence.bytes !== undefined;
  const hasSha = evidence.sha256 !== undefined;
  if (hasBytes !== hasSha) throw new Error(`${label} has a partial identity`);
  if (hasBytes && (evidence.bytes !== expected.bytes || evidence.sha256 !== expected.sha256)) {
    throw new Error(`${label} identity is stale; this migration refuses to refresh claimed evidence`);
  }
}

const ledgerBytes = await readFile(ledgerPath);
const document = JSON.parse(ledgerBytes.toString("utf8"));
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const stats = {
  verifiedStates: 0,
  fileReferences: 0,
  fileReferencesAdded: 0,
  uniqueFiles: new Set(),
  scriptReferences: 0,
  scriptIdentitiesAdded: 0,
  uniqueScripts: new Set(),
};

for (const { id, scope, state } of evidenceStates(document)) {
  stats.verifiedStates += 1;
  for (const evidence of state.evidence ?? []) {
    const label = `${id}/${scope}/${String(evidence.kind)}:${String(evidence.value)}`;
    if (evidence.kind === "file") {
      stats.fileReferences += 1;
      stats.uniqueFiles.add(evidence.value);
      const identity = await repoFileIdentity(evidence.value);
      assertExistingIdentity(evidence, identity, label);
      if (evidence.bytes === undefined) {
        evidence.bytes = identity.bytes;
        evidence.sha256 = identity.sha256;
        stats.fileReferencesAdded += 1;
      }
    } else if (evidence.kind === "npm_script") {
      stats.scriptReferences += 1;
      stats.uniqueScripts.add(evidence.value);
      const command = packageJson.scripts?.[evidence.value];
      if (typeof command !== "string" || !command.trim()) throw new Error(`${label} has no live package command`);
      const commandSha256 = sha256Text(command);
      if (evidence.commandSha256 !== undefined && evidence.commandSha256 !== commandSha256) {
        throw new Error(`${label} command identity is stale; this migration refuses to refresh it`);
      }
      if (evidence.commandSha256 === undefined) {
        evidence.commandSha256 = commandSha256;
        stats.scriptIdentitiesAdded += 1;
      }
    }
  }
}

const report = {
  schema: "editkin.product-evidence-identity-migration/v1",
  status: stats.fileReferencesAdded === 0 && stats.scriptIdentitiesAdded === 0 ? "CURRENT" : "NEEDS_MIGRATION",
  mode,
  verifiedStates: stats.verifiedStates,
  fileReferences: stats.fileReferences,
  uniqueFiles: stats.uniqueFiles.size,
  fileReferencesAdded: stats.fileReferencesAdded,
  scriptReferences: stats.scriptReferences,
  uniqueScripts: stats.uniqueScripts.size,
  scriptIdentitiesAdded: stats.scriptIdentitiesAdded,
};

if (mode === "--write" && report.status === "NEEDS_MIGRATION") {
  document.updatedAt = new Date().toISOString().slice(0, 10);
  await replaceFileTransactionally({
    filePath: ledgerPath,
    expectedBytes: ledgerBytes,
    replacementBytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"),
    transactionName: "evidence-identity-migration",
  });
  report.status = "MIGRATED";
}

process.stdout.write(`${JSON.stringify(report)}\n`);
if (mode === "--check" && report.status === "NEEDS_MIGRATION") process.exitCode = 1;

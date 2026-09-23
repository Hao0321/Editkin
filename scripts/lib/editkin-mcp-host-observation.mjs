import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson, hashBytes } from "./editkin-mcp-generation-contract.mjs";
import { normalizeHostConfiguration } from "./editkin-mcp-host-migration.mjs";

const MAX_HOST_CONFIG_BYTES = 2 * 1024 * 1024;

async function readCanonicalTextFile(pathInput, label) {
  const path = resolve(pathInput);
  const parent = await realpath(dirname(path));
  const canonical = await realpath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_HOST_CONFIG_BYTES
    || resolve(parent, canonical.slice(parent.length + 1)) !== canonical) {
    throw new Error(`${label} is not a bounded canonical regular file`);
  }
  const bytes = await readFile(canonical);
  return { path: canonical, pathSha256: hashBytes(canonicalJson(canonical)), bytesSha256: hashBytes(bytes), text: bytes.toString("utf8") };
}

function stripTomlComment(raw, label) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote === null && (character === "'" || character === '"')) quote = character;
    else if (quote === character) quote = null;
    else if (quote === null && character === "#") return raw.slice(0, index).trimEnd();
  }
  if (quote !== null) throw new Error(`${label} contains an unterminated string`);
  return raw.trimEnd();
}

function unquoteTomlString(raw, label) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { /* reject below */ }
  }
  throw new Error(`${label} is not a supported literal TOML string`);
}

function splitTomlStringArray(raw, label) {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`${label} is not a TOML array`);
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const result = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    if (index === body.length || (character === "," && quote === null)) {
      const item = body.slice(start, index).trim();
      if (!item) {
        if (index === body.length && start === body.length) break;
        throw new Error(`${label} contains an empty item`);
      }
      result.push(unquoteTomlString(item, `${label} item`));
      start = index + 1;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && character === "\\") { escaped = true; continue; }
    if (quote === null && (character === "'" || character === '"')) quote = character;
    else if (quote === character) quote = null;
  }
  if (quote !== null) throw new Error(`${label} contains an unterminated string`);
  return result;
}

function parseAssignment(line, label) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u.exec(line);
  if (!match) throw new Error(`${label} contains an unsupported assignment`);
  return { key: match[1], raw: match[2] };
}

export async function readCodexEditkinHostConfiguration(pathInput) {
  const source = await readCanonicalTextFile(pathInput, "Codex configuration");
  const lines = source.text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let section = "outside";
  let command = null;
  let args = null;
  const environment = {};
  const serverKeys = new Set();
  const environmentKeys = new Set();
  let editkinSectionCount = 0;
  let editkinEnvSectionCount = 0;
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine, "Codex configuration line").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      section = header[1] === "mcp_servers.editkin" ? "server"
        : header[1] === "mcp_servers.editkin.env" ? "environment" : "outside";
      if (section === "server") editkinSectionCount += 1;
      if (section === "environment") editkinEnvSectionCount += 1;
      continue;
    }
    if (section === "outside") continue;
    const assignment = parseAssignment(line, "Codex editkin configuration");
    if (section === "server") {
      if (serverKeys.has(assignment.key)) throw new Error(`Codex editkin configuration has a duplicate field: ${assignment.key}`);
      serverKeys.add(assignment.key);
      if (assignment.key === "command") command = unquoteTomlString(assignment.raw, "Codex editkin command");
      else if (assignment.key === "args") args = splitTomlStringArray(assignment.raw, "Codex editkin args");
      else throw new Error(`Codex editkin configuration has unsupported field: ${assignment.key}`);
    } else {
      if (environmentKeys.has(assignment.key)) throw new Error(`Codex editkin environment has a duplicate field: ${assignment.key}`);
      environmentKeys.add(assignment.key);
      environment[assignment.key] = unquoteTomlString(assignment.raw, `Codex editkin env ${assignment.key}`);
    }
  }
  if (editkinSectionCount !== 1 || editkinEnvSectionCount !== 1 || command === null || args === null) {
    throw new Error("Codex editkin configuration is missing or ambiguous");
  }
  return {
    sourcePath: source.path,
    sourcePathSha256: source.pathSha256,
    sourceBytesSha256: source.bytesSha256,
    configuration: normalizeHostConfiguration({ command, args, environment }),
  };
}

export async function readClaudeEditkinHostConfiguration(pathInput) {
  const source = await readCanonicalTextFile(pathInput, "Claude Code configuration");
  let parsed;
  try { parsed = JSON.parse(source.text); } catch { throw new Error("Claude Code configuration is not valid JSON"); }
  const server = parsed?.mcpServers?.editkin;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("Claude Code editkin configuration is missing");
  }
  const actualKeys = Object.keys(server).sort();
  const allowed = ["args", "command", "env", "type"];
  if (actualKeys.some((key) => !allowed.includes(key)) || server.type !== "stdio") {
    throw new Error("Claude Code editkin configuration has an unsupported field set or transport");
  }
  return {
    sourcePath: source.path,
    sourcePathSha256: source.pathSha256,
    sourceBytesSha256: source.bytesSha256,
    configuration: normalizeHostConfiguration({
      command: server.command,
      args: server.args,
      environment: server.env ?? {},
    }),
  };
}

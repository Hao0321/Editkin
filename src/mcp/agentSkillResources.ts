// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
/** Pinned original documentation, read lazily; documents never grant execution privileges. */
import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { AGENT_CONTEXT_MAX_TOKENS, estimateAgentContextTokens, sliceTextToAgentBudget } from "../application/agentContextBudget";
import originalSkills from "../shared/originalAgentSkills.json";

export type AgentSkillInventory = typeof originalSkills;
export const originalAgentSkills = {
  schema: originalSkills.schema, kitCommit: originalSkills.kitCommit, editorCommit: originalSkills.editorCommit,
  inventoryDigest: originalSkills.inventoryDigest, skills: originalSkills.skills, resourceCount: originalSkills.files.length,
};

function integer(value: unknown, fallback: number, min: number, max: number, label: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${label}`);
  return value;
}
function bounded<T extends Record<string, unknown>>(value: T) {
  const estimatedTokens = estimateAgentContextTokens(JSON.stringify(value)) + 12;
  if (estimatedTokens > AGENT_CONTEXT_MAX_TOKENS) throw Error("Original skill response exceeds context budget");
  return { ...value, estimatedTokens };
}

export function listOriginalSkillResources(input: { filter?: unknown; offset?: unknown; limit?: unknown } = {}, inventory = originalSkills) {
  const offset = integer(input.offset, 0, 0, inventory.files.length, "offset");
  const limit = integer(input.limit, 10, 1, 20, "limit");
  if (input.filter !== undefined && (typeof input.filter !== "string" || input.filter.length > 160)) throw Error("Invalid resource filter");
  const filter = String(input.filter ?? "").toLowerCase();
  const matches = inventory.files.filter((file) => file.resource.toLowerCase().includes(filter));
  if (offset > matches.length) throw Error("Resource offset exceeds matching inventory");
  const resources = matches.slice(offset, offset + limit).map(({ resource, license, bytes }) => ({ resource, license, bytes }));
  const base = { schema: inventory.schema, inventoryDigest: inventory.inventoryDigest, skills: inventory.skills,
    total: matches.length, offset, tokenBudget: AGENT_CONTEXT_MAX_TOKENS };
  while (resources.length > 1 && estimateAgentContextTokens(JSON.stringify({ ...base, resources })) > 1_030) resources.pop();
  return bounded({ ...base, resources, nextOffset: offset + resources.length < matches.length ? offset + resources.length : undefined });
}

export async function readOriginalSkillResource(root: string, name: unknown, input: { offset?: unknown; maxChars?: unknown } = {}, inventory = originalSkills) {
  // Check the trusted inventory before accessing any client-selected path.
  const entry = typeof name === "string" ? inventory.files.find((file) => file.resource === name) : undefined;
  if (!entry || !/^[a-zA-Z0-9_./-]+$/.test(entry.resource) || entry.resource.split("/").some((part) => !part || part === "." || part === ".."))
    throw Error("Unknown original skill resource");
  const offset = integer(input.offset, 0, 0, 1_000_000, "offset");
  const maxChars = integer(input.maxChars, 4_000, 1, 4_000, "maxChars");
  const canonicalRoot = await realpath(root), file = await realpath(join(canonicalRoot, entry.resource));
  const rel = relative(canonicalRoot, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error("Original skill resource escapes selected Kit");
  const info = await stat(file);
  if (!info.isFile() || info.size !== entry.bytes || info.size > 1_000_000) throw Error("Original skill resource size differs from pinned inventory");
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw Error("Original skill resource integrity check failed");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (offset > content.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset] ?? "") && /[\uD800-\uDBFF]/.test(content[offset - 1])))
    throw Error("Resource offset is outside text or splits a code point");
  const base = { resource: entry.resource, license: entry.license, sha256: entry.sha256,
    inventoryDigest: inventory.inventoryDigest, offset, totalChars: content.length, tokenBudget: AGENT_CONTEXT_MAX_TOKENS,
    interpretation: "Original reference data; host permissions and editor validation remain authoritative" };
  for (let tokens = 700; tokens >= 100; tokens -= 100) {
    const page = sliceTextToAgentBudget(content, offset, maxChars, tokens);
    const result = { ...base, text: page.text, nextOffset: page.nextOffset, complete: page.nextOffset === undefined };
    if (estimateAgentContextTokens(JSON.stringify(result)) <= AGENT_CONTEXT_MAX_TOKENS - 12) return bounded(result);
  }
  throw Error("Original skill resource cannot fit context budget");
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { homedir } from "node:os";

// These are the canonical Skill's explicit production-contract routes, never a recursive include.
export const COMMUNITY_RULE_REFERENCES = Object.freeze([
  "references/production-routing.md", "references/production-execution.md",
  "references/production-governance.md", "references/visual-production-and-delivery.md",
]);
const MAX_BYTES = 512 * 1024;
const idPattern = /\bM\d{1,3}(?:-[A-Z]+)?(?:A)?\b/g;
const definition = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:\*\*)?(M\d{1,3}(?:-[A-Z]+)?(?:A)?)(?:\*\*)?[：:]/;
const secureIds = new Set(["M157", "M158", "M159"]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function communityPolicyPath(override = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL) {
  const path = override ?? join(homedir(), ".codex/skills/video-autopilot/SKILL.md");
  if (!isAbsolute(path) || !/[\\/]SKILL\.md$/i.test(path)) throw new Error("COMMUNITY_POLICY_ABSOLUTE_SKILL_REQUIRED");
  return resolve(path);
}
async function assertUnlinked(path) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("COMMUNITY_POLICY_LINK_REFUSED");
  }
}
async function readPolicyFile(path) {
  await assertUnlinked(path);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error("COMMUNITY_POLICY_FILE_BUDGET_OR_TYPE");
    const bytes = Buffer.alloc(before.size + 1); let used = 0;
    while (used < bytes.length) {
      const next = await handle.read(bytes, used, bytes.length - used, used);
      if (!next.bytesRead) break;
      used += next.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    await assertUnlinked(path);
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || named.dev !== before.dev || named.ino !== before.ino || named.mtimeMs !== before.mtimeMs) throw new Error("COMMUNITY_POLICY_CHANGED_DURING_READ");
    const text = bytes.subarray(0, used).toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes.subarray(0, used))) throw new Error("COMMUNITY_POLICY_UTF8_REQUIRED");
    return text;
  } finally { await handle.close(); }
}
export function communityRuleSourceIdentities(records) {
  return records.map(record => ({ path: record.path, bytes: Buffer.byteLength(record.text), sha256: sha(record.text) }));
}
export async function assertCommunityPolicyCurrent(snapshot) {
  communityPolicyPath(snapshot.policyPath);
  const names = snapshot.records.map(record => record.path);
  if (names[0] !== "SKILL.md" || ![1, 5].includes(names.length)
    || (names.length === 5 && names.slice(1).some((name, i) => name !== COMMUNITY_RULE_REFERENCES[i]))) throw new Error("COMMUNITY_POLICY_SOURCE_SET_INVALID");
  for (const record of snapshot.records) {
    if (record.path !== "SKILL.md" && !COMMUNITY_RULE_REFERENCES.includes(record.path)) throw new Error("COMMUNITY_POLICY_SOURCE_NOT_ALLOWED");
    if (await readPolicyFile(join(dirname(snapshot.policyPath), record.path)) !== record.text) throw new Error("COMMUNITY_POLICY_SOURCE_DRIFT");
  }
}
export async function readCommunityPolicySnapshot({ policyPath = communityPolicyPath() } = {}) {
  const absolute = communityPolicyPath(policyPath), text = await readPolicyFile(absolute);
  const linked = COMMUNITY_RULE_REFERENCES.filter(path => text.includes(`](${path})`));
  if (linked.length && linked.length !== COMMUNITY_RULE_REFERENCES.length) throw new Error("COMMUNITY_POLICY_ROUTE_SET_INCOMPLETE");
  const records = [{ path: "SKILL.md", text }];
  for (const path of linked) records.push({ path, text: await readPolicyFile(join(dirname(absolute), path)) });
  const snapshot = { policyPath: absolute, records };
  await assertCommunityPolicyCurrent(snapshot);
  return snapshot;
}

/** Keep canonical clauses, prefer definitions over incidental mentions, and retain legacy summary IDs. */
export function extractCommunityStableRules(records, sanitize = text => text) {
  const ids = new Set(), definitions = new Map(), mentions = new Map();
  for (const record of records) for (const line of record.text.split(/\r?\n/)) {
    for (const id of line.match(idPattern) ?? []) { ids.add(id); if (!mentions.has(id)) mentions.set(id, line); }
    const match = definition.exec(line);
    if (!match) continue;
    const clause = line.replace(/^\s*(?:[-*]\s+|\d+\.\s+)?/, "").trim();
    const clauses = definitions.get(match[1]) ?? [];
    if (secureIds.has(match[1]) && clauses.some(value => value !== clause)) throw new Error(`COMMUNITY_SECURITY_RULE_CONFLICT: ${match[1]}`);
    if (!clauses.includes(clause)) clauses.push(clause);
    definitions.set(match[1], clauses);
  }
  return [...ids].sort().map(id => ({ id,
    text: sanitize((definitions.get(id) ?? [mentions.get(id).replace(/^\s*(?:[-*]\s+|\d+\.\s+)?/, "")]).join("\n")) }));
}

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { useTempRoots, REPO_TMP } from "../../src/test/tempRoot.mjs";
import { COMMUNITY_RULE_REFERENCES, communityPolicyPath, readCommunityPolicySnapshot,
  assertCommunityPolicyCurrent, communityRuleSourceIdentities, extractCommunityStableRules } from "./community-stable-rules.mjs";

const temp = useTempRoots(after);
const routes = COMMUNITY_RULE_REFERENCES.map(path => `[contract](${path})`).join("\n");
async function fixture(routed = true) {
  const root = await temp.create("community-rules-", { parent: REPO_TMP }), policyPath = join(root, "SKILL.md");
  await writeFile(policyPath, routed ? `# Contract\nM157 is mentioned here, without a definition.\n${routes}` : "1. M101：Inline canonical rule\nM10 legacy summary");
  if (routed) for (const path of COMMUNITY_RULE_REFERENCES) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "# Routed contract\n");
  }
  return { root, policyPath };
}
test("preserves the legacy inline format without reading unlinked references", async () => {
  const f = await fixture(false), snapshot = await readCommunityPolicySnapshot(f);
  assert.equal(snapshot.records.length, 1);
  assert.deepEqual(extractCommunityStableRules(snapshot.records), [
    { id: "M10", text: "M10 legacy summary" }, { id: "M101", text: "M101：Inline canonical rule" },
  ]);
});
test("prefers definitions to mentions and preserves both canonical clauses of M162", async () => {
  const f = await fixture();
  await writeFile(join(f.root, COMMUNITY_RULE_REFERENCES[2]), "1. M157：Authenticated session contract\n2. M162：Shot-selection evidence clause");
  await writeFile(join(f.root, COMMUNITY_RULE_REFERENCES[3]), "- M162：Motion-family source clause\nM34 legacy summary");
  const snapshot = await readCommunityPolicySnapshot(f), rules = extractCommunityStableRules(snapshot.records);
  assert.equal(snapshot.records.length, 5);
  assert.equal(rules.find(r => r.id === "M157").text, "M157：Authenticated session contract");
  assert.equal(rules.find(r => r.id === "M162").text, "M162：Shot-selection evidence clause\nM162：Motion-family source clause");
  assert.equal(rules.find(r => r.id === "M34").text, "M34 legacy summary");
});
test("rejects different security definitions instead of joining fragments into a false complete policy", () => {
  assert.throws(() => extractCommunityStableRules([
    { path: "SKILL.md", text: "M157：URL fragment only" },
    { path: "references/production-governance.md", text: "M157：Cookie only" },
  ]), /SECURITY_RULE_CONFLICT/);
});
test("pins every referenced file and rejects a changed source after snapshot", async () => {
  const f = await fixture(), snapshot = await readCommunityPolicySnapshot(f), before = communityRuleSourceIdentities(snapshot.records);
  await assertCommunityPolicyCurrent(snapshot);
  await writeFile(join(f.root, COMMUNITY_RULE_REFERENCES[2]), "M157：changed RAW_SENTINEL policy");
  await assert.rejects(assertCommunityPolicyCurrent(snapshot), /SOURCE_DRIFT/);
  const fresh = communityRuleSourceIdentities((await readCommunityPolicySnapshot(f)).records);
  assert.notDeepEqual(fresh, before); assert(!JSON.stringify(fresh).includes("RAW_SENTINEL"));
  assert(fresh.every(r => !r.path.includes(f.root) && /^[a-f\d]{64}$/.test(r.sha256)));
});
test("rejects an incomplete or reordered snapshot instead of certifying a partial source list", async () => {
  const f = await fixture(), snapshot = await readCommunityPolicySnapshot(f);
  await assert.rejects(assertCommunityPolicyCurrent({ ...snapshot, records: [] }), /SOURCE_SET_INVALID/);
  await assert.rejects(assertCommunityPolicyCurrent({ ...snapshot, records: snapshot.records.slice(0, 2) }), /SOURCE_SET_INVALID/);
  await assert.rejects(assertCommunityPolicyCurrent({ ...snapshot, records: [...snapshot.records].reverse() }), /SOURCE_SET_INVALID/);
});
test("requires an absolute SKILL.md override and honors a valid one", async () => {
  assert.throws(() => communityPolicyPath("../other/SKILL.md"), /ABSOLUTE_SKILL_REQUIRED/);
  assert.throws(() => communityPolicyPath("D:/other/rules.md"), /ABSOLUTE_SKILL_REQUIRED/);
  const f = await fixture(false), previous = process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL;
  try {
    process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = f.policyPath;
    assert.equal((await readCommunityPolicySnapshot()).policyPath, f.policyPath);
  } finally { if (previous === undefined) delete process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL; else process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = previous; }
});
test("refuses incomplete routed input sets and missing declared files", async () => {
  const f = await fixture(false); await writeFile(f.policyPath, `[partial](${COMMUNITY_RULE_REFERENCES[0]})`);
  await assert.rejects(readCommunityPolicySnapshot(f), /ROUTE_SET_INCOMPLETE/);
  await writeFile(f.policyPath, routes); await assert.rejects(readCommunityPolicySnapshot(f), /ENOENT/);
});
test("does not follow unrelated or traversal links in the entry document", async () => {
  const f = await fixture(false); await writeFile(f.policyPath, "[outside](../../untrusted.md)\nM101：Retained inline rule");
  const snapshot = await readCommunityPolicySnapshot(f);
  assert.equal(snapshot.records.length, 1); assert.equal(extractCommunityStableRules(snapshot.records)[0].id, "M101");
});
test("rejects junction ancestors and oversized or invalid-UTF8 policy files", async () => {
  const f = await fixture(false), foreign = await temp.create("community-rules-foreign-", { parent: REPO_TMP });
  await writeFile(f.policyPath, routes); await symlink(foreign, join(f.root, "references"), "junction");
  await assert.rejects(readCommunityPolicySnapshot(f), /LINK_REFUSED/);
  const huge = await fixture(false); await writeFile(huge.policyPath, Buffer.alloc(512 * 1024 + 1, 65));
  await assert.rejects(readCommunityPolicySnapshot(huge), /BUDGET_OR_TYPE/);
  await writeFile(huge.policyPath, Buffer.from([0xff, 0xfe])); await assert.rejects(readCommunityPolicySnapshot(huge), /UTF8_REQUIRED/);
});

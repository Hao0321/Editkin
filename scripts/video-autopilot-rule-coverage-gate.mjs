import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { strict as assert } from "node:assert";

const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL ?? resolve(homedir(), ".codex/skills/video-autopilot/SKILL.md"));
const [skillText, coverage, packageJson] = await Promise.all([
  readFile(skillPath, "utf8"),
  readFile(resolve(root, "video-autopilot-rule-coverage.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
]);
assert.equal(coverage.schemaVersion, 1);
assert.equal(coverage.product, packageJson.productName);
assert.equal(coverage.productVersion, packageJson.version);
assert.equal(coverage.sourceOfTruth, "dynamic-current-video-autopilot");
const skillRuleIds = [...new Set([...skillText.matchAll(/\bM\d{1,3}(?:-[A-Z]+)?(?:A)?\b/g)].map((match) => match[0]))].sort();
assert.ok(skillRuleIds.length > 0, "最新版 video-autopilot 沒有可辨識的 M 規則");
const integrations = new Set(["native_verified", "contract_enforced", "orchestrator_handoff", "unmeasured", "blocked_external"]);
const mapped = new Map();
for (const group of coverage.ruleGroups) {
  assert.match(group.id, /^[a-z0-9-]+$/);
  assert.ok(integrations.has(group.integration), `${group.id} integration 不合法`);
  assert.ok(Array.isArray(group.ruleIds) && group.ruleIds.length > 0, `${group.id} 沒有 ruleIds`);
  if (["native_verified", "contract_enforced", "orchestrator_handoff"].includes(group.integration)) assert.ok(group.evidence?.length, `${group.id} 缺少 evidence`);
  if (group.integration === "unmeasured") assert.ok(group.nextExperiment?.trim(), `${group.id} 缺少 nextExperiment`);
  if (group.integration === "blocked_external") assert.ok(group.blocker?.trim(), `${group.id} 缺少 blocker`);
  for (const ruleId of group.ruleIds) {
    assert.ok(!mapped.has(ruleId), `${ruleId} 被多個群組重複宣告`);
    mapped.set(ruleId, group.id);
  }
  for (const evidence of group.evidence ?? []) {
    if (evidence.kind === "file") {
      assert.ok(!isAbsolute(evidence.value) && !evidence.value.split(/[\\/]/).includes(".."), `${group.id} evidence path 不安全`);
      const path = resolve(root, evidence.value);
      assert.ok(path.startsWith(`${root}${sep}`));
      await access(path);
    } else if (evidence.kind === "npm_script") assert.ok(packageJson.scripts[evidence.value], `${group.id} 找不到 npm script ${evidence.value}`);
    else if (evidence.kind === "skill_ref") assert.match(evidence.value, /^video-autopilot:[a-z0-9-]+$/);
    else assert.fail(`${group.id} evidence kind 不支援`);
  }
}
const missing = skillRuleIds.filter((id) => !mapped.has(id));
const stale = [...mapped.keys()].filter((id) => !skillRuleIds.includes(id));
assert.deepEqual(missing, [], `最新版 Skill 規則尚未寫入 Editkin 能力矩陣：${missing.join(", ")}`);
assert.deepEqual(stale, [], `能力矩陣含最新版 Skill 已不存在的規則：${stale.join(", ")}`);
const skillSha256 = (await import("node:crypto")).createHash("sha256").update(skillText).digest("hex");
const counts = Object.fromEntries([...integrations].map((integration) => [integration, coverage.ruleGroups.filter((group) => group.integration === integration).flatMap((group) => group.ruleIds).length]));
process.stdout.write(`${JSON.stringify({ status: "GREEN", skillPath, skillSha256, currentRuleCount: skillRuleIds.length, mappedRuleCount: mapped.size, counts })}\n`);

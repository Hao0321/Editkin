import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selfTestWorkflowBundle, workflowIntegrationStatus } from "./lib/video-autopilot-workflow-integration.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = selfTestWorkflowBundle();
if (process.argv.includes("--self-test")) {
  console.log(JSON.stringify(fixtures));
  process.exit(0);
}
const skillRoot = process.env.CODEX_SKILLS_ROOT ?? path.join(process.env.USERPROFILE ?? "", ".codex", "skills");
const skillPath = path.join(skillRoot, "video-autopilot", "SKILL.md");
const skillText = await readFile(skillPath, "utf8");
const installed = new Set((await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
const referenced = new Set([...installed].filter((id) => id !== "video-autopilot" && new RegExp(`(^|[^a-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i").test(skillText)));
const ledger = JSON.parse(await readFile(path.join(root, "video-autopilot-skill-integration.json"), "utf8"));
const mapped = ledger.dependencies.map((row) => row.skillId);
const forbiddenDependencies = new Set(["capcut-agent-ops"]);
assert.equal(new Set(mapped).size, mapped.length, "Skill 整合帳本有重複 dependency");
assert.deepEqual(
  [...new Set([...mapped, ...referenced])].filter((skillId) => forbiddenDependencies.has(skillId)),
  [],
  "Editkin-only 工作流不得依賴外部剪輯器 Skill",
);
assert.deepEqual([...mapped].sort(), [...referenced].sort(), `video-autopilot 直接依賴漂移；目前 Skill=${[...referenced].sort().join(",")}`);
for (const row of ledger.dependencies) {
  assert.ok(["dynamic_latest_skill", "native_plus_dynamic", "external_canonical_handoff"].includes(row.integration), `${row.skillId} integration 無效`);
  assert.ok(row.scope?.trim(), `${row.skillId} 缺 scope`);
  assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0, `${row.skillId} 缺 evidence`);
  for (const evidence of row.evidence) await access(path.join(root, evidence));
}
const kitRoot = process.env.VIDEO_AUTOPILOT_KIT_ROOT ?? path.resolve(root, "..", "..", "video-autopilot-kit");
const workflow = await workflowIntegrationStatus(skillRoot, kitRoot);
console.log(JSON.stringify({ status: workflow.kitStatus === "GREEN" ? "GREEN" : "REVIEW", directDependencyCount: mapped.length, dependencies: ledger.dependencies.map(({ skillId, integration }) => ({ skillId, integration })), ...workflow, fixtureCount: fixtures.fixtures.length }));
if (workflow.kitStatus !== "GREEN") process.exitCode = 1;

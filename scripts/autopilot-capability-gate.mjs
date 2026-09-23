import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { strict as assert } from "node:assert";

const root = resolve(import.meta.dirname, "..");
const [document, packageJson] = await Promise.all([
  readFile(resolve(root, "autopilot-capabilities.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
]);
const integrations = new Set(["native_verified", "contract_enforced", "orchestrator_handoff", "unmeasured", "blocked_external"]);
assert.equal(document.schemaVersion, 1);
assert.equal(document.product, packageJson.productName);
assert.equal(document.productVersion, packageJson.version);
assert.equal(document.sourceOfTruth, "dynamic-current-video-autopilot");
assert.equal(document.requiredIds.length, 78, "能力封閉世界數量漂移");
assert.equal(new Set(document.requiredIds).size, document.requiredIds.length, "requiredIds 重複");
assert.equal(document.capabilities.length, document.requiredIds.length, "能力數量與 requiredIds 不一致");

const byId = new Map();
for (const capability of document.capabilities) {
  assert.match(capability.id, /^VA-\d{3}$/);
  assert.ok(document.requiredIds.includes(capability.id), `未宣告 capability：${capability.id}`);
  assert.ok(!byId.has(capability.id), `重複 capability：${capability.id}`);
  byId.set(capability.id, capability);
  assert.ok(capability.name?.trim());
  assert.ok(capability.skillSource?.trim());
  assert.ok(integrations.has(capability.integration), `${capability.id} integration 不合法`);
  if (capability.integration === "native_verified" || capability.integration === "contract_enforced" || capability.integration === "orchestrator_handoff") {
    assert.ok(Array.isArray(capability.evidence) && capability.evidence.length > 0, `${capability.id} 缺少 evidence`);
  }
  if (capability.integration === "unmeasured") assert.ok(capability.nextExperiment?.trim(), `${capability.id} 缺少 nextExperiment`);
  if (capability.integration === "blocked_external") assert.ok(capability.blocker?.trim(), `${capability.id} 缺少 blocker`);
  for (const evidence of capability.evidence ?? []) {
    if (evidence.kind === "file") {
      assert.ok(!isAbsolute(evidence.value) && !evidence.value.split(/[\\/]/).includes(".."), `${capability.id} evidence path 不安全`);
      const absolute = resolve(root, evidence.value);
      assert.ok(absolute.startsWith(`${root}${sep}`));
      await access(absolute);
    } else if (evidence.kind === "npm_script") assert.ok(packageJson.scripts[evidence.value], `${capability.id} 找不到 npm script ${evidence.value}`);
    else if (evidence.kind === "skill_ref") assert.match(evidence.value, /^video-autopilot:[a-z0-9-]+$/);
    else assert.fail(`${capability.id} evidence kind 不支援`);
  }
}
for (const id of document.requiredIds) assert.ok(byId.has(id), `缺少能力：${id}`);

const counts = Object.fromEntries([...integrations].map((status) => [status, document.capabilities.filter((item) => item.integration === status).length]));
assert.ok(counts.native_verified > 0 && counts.contract_enforced > 0 && counts.orchestrator_handoff > 0);
assert.ok(counts.unmeasured > 0, "禁止把所有能力冒充已驗證");
process.stdout.write(`${JSON.stringify({ status: "GREEN", productVersion: document.productVersion, capabilityCount: document.capabilities.length, counts })}\n`);

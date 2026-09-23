import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const WORKFLOW_FILES = [
  "workflow_contract.json", "workflow_contract.py", "workflow_state.py", "workflow_receipts.py",
  "workflow_material_receipts.py", "workflow_transport.py", "workflow_audit_binding.py",
  "workflow_binding_fixture.py", "workflow_context_chain.py", "workflow_json.py", "workflow_render_retry.py",
];
const REQUIRED_TOOLS = [
  "get_autopilot_contract", "start_ai_editing_session", "prepare_ai_material",
  "view_material_keyframes", "get_material_context", "record_material_semantics",
  "resolve_autopilot_inference_route", "list_installed_plugins", "write_v4_plan",
  "audit_autopilot_plan", "apply_autopilot_plan", "render_project", "human_review",
  "record_autopilot_outcome",
];

function parseContract(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error(`${label} workflow_contract.json 無效`); }
  assert.equal(value.schema, "hao.video-autopilot.workflow-contract/v1", `${label} workflow schema 漂移`);
  assert.ok(Number.isInteger(value.contract_revision) && value.contract_revision > 0, `${label} workflow revision 無效`);
  assert.equal(value.plan_schema, "hao.video-autopilot.edit-plan/v4", `${label} 必須使用 Editkin v4 plan`);
  assert.equal(value.plan_hash_algorithm, "sha256-canonical-json-utf8-keys-v1", `${label} plan hash algorithm 漂移`);
  assert.equal(value.legacy_plan_policy, "reject", `${label} 不得接受舊版計畫`);
  assert.ok(Array.isArray(value.steps), `${label} 缺工作流步驟`);
  const ids = value.steps.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length, `${label} 工作流步驟重複`);
  const tools = new Set(value.steps.map((step) => step.tool));
  for (const tool of REQUIRED_TOOLS) assert.ok(tools.has(tool), `${label} 缺必要步驟 ${tool}`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function verifyWorkflowBundle(files) {
  for (const name of WORKFLOW_FILES) {
    const row = files[name];
    assert.ok(row?.installed && row.source && row.bundled, `工作流模組缺失：${name}`);
  }
  const installed = parseContract(files["workflow_contract.json"].installed, "installed Skill");
  const source = parseContract(files["workflow_contract.json"].source, "public Kit source");
  const bundled = parseContract(files["workflow_contract.json"].bundled, "public Kit Skill");
  assert.deepEqual(source, installed, "公開 Kit 工作流契約落後於目前安裝的 Skill");
  assert.deepEqual(bundled, installed, "公開 Kit Skill 工作流契約與目前安裝的 Skill 不一致");
  for (const name of WORKFLOW_FILES.filter((item) => item !== "workflow_contract.json")) {
    const row = files[name];
    const normalized = (value) => value.toString("utf8").replace(/\r\n/g, "\n");
    assert.equal(normalized(row.source), normalized(row.installed), `公開 Kit source 版本漂移：${name}`);
    assert.equal(normalized(row.bundled), normalized(row.installed), `公開 Kit Skill 版本漂移：${name}`);
  }
  return {
    revision: installed.contract_revision,
    moduleCount: WORKFLOW_FILES.length,
    contractSha256: createHash("sha256").update(JSON.stringify(canonicalJson(installed))).digest("hex"),
  };
}

export function selfTestWorkflowBundle() {
  const contract = {
    schema: "hao.video-autopilot.workflow-contract/v1", contract_revision: 5,
    plan_schema: "hao.video-autopilot.edit-plan/v4",
    plan_hash_algorithm: "sha256-canonical-json-utf8-keys-v1",
    legacy_plan_policy: "reject",
    steps: REQUIRED_TOOLS.map((tool, index) => ({ id: `step-${index}`, tool })),
  };
  const payload = Buffer.from(JSON.stringify(contract));
  const files = Object.fromEntries(WORKFLOW_FILES.map((name) => [name, {
    installed: name.endsWith(".json") ? payload : Buffer.from(`module:${name}\n`),
    source: name.endsWith(".json") ? payload : Buffer.from(`module:${name}\n`),
    bundled: name.endsWith(".json") ? payload : Buffer.from(`module:${name}\n`),
  }]));
  assert.equal(verifyWorkflowBundle(files).revision, 5);
  const cloneFiles = () => Object.fromEntries(Object.entries(files).map(([name, row]) => [name, {
    installed: Buffer.from(row.installed), source: Buffer.from(row.source), bundled: Buffer.from(row.bundled),
  }]));
  const stale = cloneFiles();
  stale["workflow_contract.json"].source = Buffer.from(JSON.stringify({ ...contract, contract_revision: 2 }));
  assert.throws(() => verifyWorkflowBundle(stale), /落後/);
  const missing = cloneFiles();
  delete missing["workflow_render_retry.py"];
  assert.throws(() => verifyWorkflowBundle(missing), /缺失/);
  const downgrade = cloneFiles();
  downgrade["workflow_contract.json"].installed = Buffer.from(JSON.stringify({ ...contract, plan_schema: "hao.video-autopilot.edit-plan/v3" }));
  assert.throws(() => verifyWorkflowBundle(downgrade), /v4/);
  const drift = cloneFiles();
  drift["workflow_receipts.py"].bundled = Buffer.from("stale module\n");
  assert.throws(() => verifyWorkflowBundle(drift), /版本漂移/);
  return { status: "GREEN", fixtures: ["aligned", "stale-revision-rejected", "missing-helper-rejected", "legacy-plan-rejected", "module-drift-rejected"] };
}

export async function workflowIntegrationStatus(skillRoot, kitRoot) {
  const installedRoot = path.join(skillRoot, "video-autopilot");
  const installedContract = await readFile(path.join(installedRoot, "workflow_contract.json"));
  const availableKit = await access(kitRoot).then(() => true, () => false);
  if (!availableKit) {
    const contract = parseContract(installedContract, "installed Skill");
    return { kitStatus: "NOT_PRESENT", workflowContractRevision: contract.contract_revision };
  }
  const files = Object.fromEntries(await Promise.all(WORKFLOW_FILES.map(async (name) => [name, {
    installed: name === "workflow_contract.json" ? installedContract : await readFile(path.join(installedRoot, name)),
    source: await readFile(path.join(kitRoot, "src", name)),
    bundled: await readFile(path.join(kitRoot, "codex-skill", "video-autopilot", name)),
  }])));
  const verified = verifyWorkflowBundle(files);
  return { kitStatus: "GREEN", workflowContractRevision: verified.revision,
    workflowModuleCount: verified.moduleCount, workflowContractSha256: verified.contractSha256 };
}

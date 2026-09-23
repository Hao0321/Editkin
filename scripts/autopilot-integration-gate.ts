import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import {
  AUTOPILOT_CONTRACT,
  AUTOPILOT_MAX_CONTEXT_TOKENS,
  AUTOPILOT_MAX_MEMORY_RULES,
  AUTOPILOT_PLAN_SCHEMA,
  parseAutopilotPlan,
} from "../src/application/autopilotPlan";
import { createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import {
  assertAutopilotPlanSourceCurrent,
  autopilotPlanSourceFromIdentity,
  readLiveAutopilotIdentity,
} from "../src/application/autopilotInvocationIdentity";

const EXPECTED_RULE_FAMILIES = [
  "bounded-context-routing", "bounded-memory-selection", "source-and-memory-receipt", "original-assets-read-only", "structured-edit-commands",
  "semantic-asset-selection", "license-fail-closed", "creative-brief-and-packaging", "promise-stakes-payoff", "energy-beat-curve",
  "captions-graphics-separated", "semantic-graphics", "single-creative-look", "motivated-transitions", "layered-audio-design",
  "frame-quantized-motion", "tracking-confidence-loss", "atomic-project-update", "quality-state-honesty", "artifact-and-outcome-contract",
  "format-specific-builder", "quality-95-human-review", "publish-hub-lifecycle", "outcome-learning",
  "model-capability-routing", "markdown-json-context-separation", "model-independent-semantic-audit",
  "material-multimodal-evidence", "session-subscription-no-editor-api-key",
  "editorial-unit-cardinality", "dynamic-hard-rule-coverage", "anonymous-aesthetic-standard", "anonymous-community-knowledge", "bounded-runtime-loading",
  "dynamic-plugin-capabilities", "declarative-skill-pack-selection", "plugin-command-provenance", "roto-keyer-evidence-routing",
];
const EXPECTED_SKILL_DEPENDENCIES = [
  "yt-script-style", "video-craft-playbook", "yt-algorithm-mastery", "interview-show",
  "ai-media-generator", "ai-short-drama", "social-post",
];
const REQUIRED_STARTER_PROMPT_MARKERS = [
  "get_autopilot_contract",
  "prepare_ai_material",
  "get_material_context(afterCueIndex,maxTokens)",
  "view_material_keyframes",
  "每次最多四張",
  "record_material_semantics",
  "原始影片、整份逐字稿與整批關鍵幀不得送進 Agent context",
  "requiredPlanSource",
  "compile_plugin_application 做唯讀編譯",
  "get_editkin_workflow_profile",
  "resolve_editkin_skill_workflow",
  "capabilityResolution",
  "accepted audit receipt",
  "apply_autopilot_plan",
  "REVIEW_REQUIRED",
] as const;

interface AgentSetupContractFixture {
  schemaVersion: number;
  contractVersion: string;
  serverId: string;
  launcher: {
    schemaVersion: number;
    entrypointMode: string;
    resourceRelativePath: string;
    embeddedContractRelativePath: string;
    stateEnvKey: string;
    stateDirectoryName: string;
    args: string[];
  };
  starterPrompt: string;
  envKeys: string[];
}

function assertAgentSetupContractBinding(
  contract: AgentSetupContractFixture,
  typescriptSource: string,
  rustSource: string,
): void {
  assert.equal(contract.schemaVersion, 2, "Agent setup schemaVersion 漂移");
  assert.equal(contract.contractVersion, "editkin.agent-setup/v2", "Agent setup contractVersion 漂移");
  assert.equal(contract.serverId, "editkin", "Agent setup serverId 漂移");
  assert.deepEqual(contract.launcher, {
    schemaVersion: 3,
    entrypointMode: "stable_generation_launcher",
    resourceRelativePath: "agent-runtime-v3/launcher.mjs",
    embeddedContractRelativePath: "agent-runtime-v3/agent-setup-contract.json",
    stateEnvKey: "EDITKIN_AGENT_STATE_ROOT",
    stateDirectoryName: "agent-runtime-v3",
    args: [],
  }, "Agent setup 必須使用 closed-world v3 generation launcher");
  assert.ok(Array.isArray(contract.envKeys) && contract.envKeys.length > 0, "Agent setup envKeys 不可為空");
  assert.equal(new Set(contract.envKeys).size, contract.envKeys.length, "Agent setup envKeys 不可重複");
  for (const key of contract.envKeys) {
    assert.ok(typescriptSource.includes(key), `Agent setup TypeScript 未使用契約 env key：${key}`);
  }
  for (const marker of REQUIRED_STARTER_PROMPT_MARKERS) {
    assert.ok(contract.starterPrompt.includes(marker), `Agent starter prompt 缺少必要 marker：${marker}`);
  }
  assert.ok(
    typescriptSource.includes('import agentSetupContractJson from "../shared/agentSetupContract.json"'),
    "Agent setup TypeScript 未讀共用 JSON",
  );
  assert.ok(
    typescriptSource.includes("EDITKIN_AGENT_SETUP_CONTRACT.starterPrompt"),
    "Agent setup TypeScript 未從共用 contract 匯出 prompt",
  );
  assert.ok(
    !typescriptSource.includes('export const EDITKIN_AGENT_STARTER_PROMPT = "'),
    "Agent setup TypeScript 不得內嵌第二份 starter prompt",
  );
  assert.ok(
    rustSource.includes('include_str!("../../src/shared/agentSetupContract.json")'),
    "Rust 未 include 共用 agent setup JSON",
  );
  assert.ok(rustSource.includes('.get("starterPrompt")'), "Rust 未從共用 contract 讀 starterPrompt");
  assert.ok(rustSource.includes('.get("envKeys")'), "Rust 未從共用 contract 讀 envKeys closed world");
  assert.ok(rustSource.includes("expected_environment_keys != actual_environment_keys"), "Rust 未 fail-close Agent 環境鍵漂移");
  assert.ok(rustSource.includes("activate_product_agent_generation"), "Rust 未啟用 user-scoped product generation");
  assert.ok(rustSource.includes("runtime.agent_launcher"), "Rust Host config 未指向 stable product launcher");
  assert.ok(rustSource.includes("probe_current_editkin_mcp"), "Rust Agent setup 未真實探測最新版 MCP runtime");
  assert.ok(
    !rustSource.includes("const EDITKIN_AGENT_STARTER_PROMPT"),
    "Rust 不得內嵌第二份 starter prompt",
  );
}

function agentSetupBindingRejected(
  contract: AgentSetupContractFixture,
  typescriptSource: string,
  rustSource: string,
): boolean {
  try {
    assertAgentSetupContractBinding(contract, typescriptSource, rustSource);
    return false;
  } catch {
    return true;
  }
}

const root = resolve(import.meta.dirname, "..");
const liveIdentity = await readLiveAutopilotIdentity();
function fixture() {
  return createAutopilotV4Fixture(autopilotPlanSourceFromIdentity(liveIdentity));
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.equal(AUTOPILOT_CONTRACT.productVersion, packageJson.version, "Autopilot contract 版本漂移");
assert.equal(AUTOPILOT_CONTRACT.planSchema, AUTOPILOT_PLAN_SCHEMA);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.dynamicCanonicalSkill, true);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.packagePrivateSkillOrMemory, false);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.packageAnonymousAestheticMemory, true);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.maxContextTokens, AUTOPILOT_MAX_CONTEXT_TOKENS);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.maxSelectedMemoryRules, AUTOPILOT_MAX_MEMORY_RULES);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.contextProtocol, "markdown-router+json-contract/v1");
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.semanticGateIndependentOfModel, true);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.productAuditApplyCurrentPlanOnly, true);
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.legacyPlanPolicy, "import_only_reject_audit_apply");
assert.equal(AUTOPILOT_CONTRACT.sourcePolicy.liveInvocationIdentityRequired, true);
assert.equal(liveIdentity.workflow.legacyPlanPolicy, "reject");
assert.equal(liveIdentity.workflow.planSchema, AUTOPILOT_PLAN_SCHEMA);
assert.equal(liveIdentity.knowledge.stableRuleCount, 77);
assert.equal(liveIdentity.knowledge.includedModuleCount, 37);
const actualIds = AUTOPILOT_CONTRACT.ruleFamilies.map((item) => item.id);
assert.deepEqual([...actualIds].sort(), [...EXPECTED_RULE_FAMILIES].sort(), "Autopilot rule-family closed world 漂移");
assert.equal(new Set(actualIds).size, actualIds.length, "Autopilot rule-family id 重複");
const actualSkillDependencies = AUTOPILOT_CONTRACT.skillDependencies.map((item) => item.skillId);
assert.deepEqual([...actualSkillDependencies].sort(), [...EXPECTED_SKILL_DEPENDENCIES].sort(), "video-autopilot 直接 Skill 依賴 closed world 漂移");
assert.equal(new Set(actualSkillDependencies).size, actualSkillDependencies.length, "video-autopilot 直接 Skill 依賴重複");
assert.equal(AUTOPILOT_CONTRACT.aesthetic.humanReviewRequired, true);
for (const family of AUTOPILOT_CONTRACT.ruleFamilies) {
  if (family.integration !== "orchestrator_only") await access(resolve(root, family.evidence));
}
const serverSource = await readFile(resolve(root, "src/mcp/autopilotTools.ts"), "utf8");
for (const tool of ["get_autopilot_contract", "list_community_editing_knowledge", "read_community_editing_knowledge", "resolve_autopilot_inference_route", "audit_autopilot_plan", "apply_autopilot_plan", "record_autopilot_outcome"]) assert.ok(serverSource.includes(`\"${tool}\"`), `MCP 缺少 ${tool}`);
for (const marker of ["parseProductAutopilotPlan", "createAcceptedAutopilotAuditReceipt", "verifyAcceptedAutopilotAuditReceipt", "auditReceipt: autopilotAuditReceiptSchema"]) {
  assert.ok(serverSource.includes(marker), `MCP 缺少 live audit/apply binding：${marker}`);
}
const agentSetupContract = JSON.parse(
  await readFile(resolve(root, "src/shared/agentSetupContract.json"), "utf8"),
) as AgentSetupContractFixture;
const agentSetupTypescriptSource = await readFile(resolve(root, "src/application/agentSetup.ts"), "utf8");
const agentSetupRustSource = await readFile(resolve(root, "src-tauri/src/main.rs"), "utf8");
assertAgentSetupContractBinding(agentSetupContract, agentSetupTypescriptSource, agentSetupRustSource);
const agentSetupNegativeControls = {
  promptMarkerDriftRejected: agentSetupBindingRejected(
    { ...agentSetupContract, starterPrompt: agentSetupContract.starterPrompt.replace("requiredPlanSource", "stalePlanSource") },
    agentSetupTypescriptSource,
    agentSetupRustSource,
  ),
  typescriptImportDriftRejected: agentSetupBindingRejected(
    agentSetupContract,
    agentSetupTypescriptSource.replace("../shared/agentSetupContract.json", "../shared/staleAgentSetupContract.json"),
    agentSetupRustSource,
  ),
  rustDuplicatePromptRejected: agentSetupBindingRejected(
    agentSetupContract,
    agentSetupTypescriptSource,
    `${agentSetupRustSource}\nconst EDITKIN_AGENT_STARTER_PROMPT: &str = \"stale\";`,
  ),
  directEntrypointDriftRejected: agentSetupBindingRejected(
    { ...agentSetupContract, launcher: { ...agentSetupContract.launcher, entrypointMode: "direct_mcp", resourceRelativePath: "runtime/mcp.mjs" } },
    agentSetupTypescriptSource,
    agentSetupRustSource,
  ),
};
for (const [name, rejected] of Object.entries(agentSetupNegativeControls)) {
  assert.equal(rejected, true, `Agent setup negative control 未被拒絕：${name}`);
}
const materialServerSource = await readFile(resolve(root, "src/mcp/materialIntelligenceTools.ts"), "utf8");
for (const tool of ["start_ai_editing_session", "prepare_ai_material", "get_material_context", "view_material_keyframes", "record_material_semantics"]) assert.ok(materialServerSource.includes(`\"${tool}\"`), `MCP 缺少 ${tool}`);
const editorialBatchSource = await readFile(resolve(root, "src/mcp/editorialBatchTools.ts"), "utf8");
for (const tool of ["audit_editorial_batch_plan", "create_editorial_batch_projects", "render_editorial_batch"]) assert.ok(editorialBatchSource.includes(`\"${tool}\"`), `MCP 缺少 ${tool}`);
const pluginSource = await readFile(resolve(root, "src/mcp/pluginTools.ts"), "utf8");
for (const tool of ["list_installed_plugins", "get_plugin_capability", "compile_plugin_application", "list_installed_editkin_skills", "get_editkin_skill_pack", "get_editkin_workflow_profile", "resolve_editkin_skill_workflow"]) assert.ok(pluginSource.includes(`\"${tool}\"`), `MCP 缺少 ${tool}`);
parseAutopilotPlan(fixture());
assertAutopilotPlanSourceCurrent(fixture().source, liveIdentity);
const identityNegativeControls: Record<string, boolean> = {};
for (const key of ["skillSha256", "workflowContractSha256", "knowledgeSha256", "stableRulesSha256", "pluginRegistrySha256", "invocationBindingSha256"] as const) {
  let rejected = false;
  try { assertAutopilotPlanSourceCurrent({ ...fixture().source, [key]: "0".repeat(64) }, liveIdentity); } catch { rejected = true; }
  assert.equal(rejected, true, `${key} drift 未被拒絕`);
  identityNegativeControls[key] = rejected;
}
let budgetRejected = false;
try { parseAutopilotPlan({ ...fixture(), budget: { ...fixture().budget, contextTokens: 1_101 } }); } catch { budgetRejected = true; }
assert.equal(budgetRejected, true, "超額 context fixture 未被拒絕");
let certificationRejected = false;
try { parseAutopilotPlan({ ...fixture(), quality: { state: "certified_95" } }); } catch { certificationRejected = true; }
assert.equal(certificationRejected, true, "未審片 certification fixture 未被拒絕");
let payoffRejected = false;
try {
  const plan = fixture();
  parseAutopilotPlan({ ...plan, editorial: { ...plan.editorial, narrative: { ...plan.editorial.narrative, beats: plan.editorial.narrative.beats.slice(0, 2), setupPayoffs: [] } } });
} catch { payoffRejected = true; }
assert.equal(payoffRejected, true, "缺少 payoff 的 build fixture 未被拒絕");
let modelBypassRejected = false;
try {
  const plan = fixture();
  parseAutopilotPlan({ ...plan, inference: { ...plan.inference, safeguards: { ...plan.inference.safeguards, executionMode: "direct_apply" } } });
} catch { modelBypassRejected = true; }
assert.equal(modelBypassRejected, true, "未量測模型 direct_apply fixture 未被拒絕");
let materialEvidenceRejected = false;
try {
  const plan = fixture();
  const { materialEvidence: _materialEvidence, ...withoutMaterial } = plan;
  parseAutopilotPlan(withoutMaterial);
} catch { materialEvidenceRejected = true; }
assert.equal(materialEvidenceRejected, true, "v4 缺少素材語意 evidence 未被拒絕");
process.stdout.write(`${JSON.stringify({ status: "GREEN", planSchema: AUTOPILOT_PLAN_SCHEMA, ruleFamilyCount: actualIds.length, liveIdentity, agentSetupContract: { schemaVersion: agentSetupContract.schemaVersion, contractVersion: agentSetupContract.contractVersion, serverId: agentSetupContract.serverId, envKeyCount: agentSetupContract.envKeys.length }, negativeControls: { budgetRejected, certificationRejected, payoffRejected, modelBypassRejected, materialEvidenceRejected, identity: identityNegativeControls, agentSetup: agentSetupNegativeControls } })}\n`);

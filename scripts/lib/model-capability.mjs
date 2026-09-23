import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
export const EXPECTED_MODEL_CELL_IDS = MODELS.flatMap((model) => EFFORTS.map((effort) => `${model.replace("gpt-5.6-", "")}-${effort}`));

export function evaluateModelCapability(document, root) {
  const findings = [];
  const fail = (code, message, id) => findings.push({ status: "FAIL", code, message, ...(id ? { id } : {}) });
  if (document?.schemaVersion !== 1 || document?.schema !== "hao.video-autopilot.model-eval-matrix/v1") fail("schema", "model capability schema 不合法");
  if (document?.contextProtocol !== "markdown-router+json-contract/v1") fail("context-protocol", "Markdown／JSON context protocol 漂移");
  if (document?.semanticGateIndependentOfModel !== true) fail("model-bypass", "模型身分不得影響語意 gate 是否執行");
  if (document?.claimStatus !== "unmeasured" && document?.claimStatus !== "measured") fail("claim-status", "claimStatus 不合法");
  const required = Array.isArray(document?.requiredCellIds) ? document.requiredCellIds : [];
  if (new Set(required).size !== required.length) fail("duplicate-required-cell", "requiredCellIds 重複");
  if (JSON.stringify([...required].sort()) !== JSON.stringify([...EXPECTED_MODEL_CELL_IDS].sort())) fail("cell-closed-world", "Sol／Terra／Luna × reasoning effort 閉世界矩陣不完整");
  const cells = Array.isArray(document?.cells) ? document.cells : [];
  const byId = new Map();
  for (const cell of cells) {
    if (!cell?.id || byId.has(cell.id)) { fail("duplicate-cell", `cell id 無效或重複：${cell?.id ?? "missing"}`); continue; }
    byId.set(cell.id, cell);
    const expectedId = `${String(cell.modelId).replace("gpt-5.6-", "")}-${cell.reasoningEffort}`;
    if (cell.id !== expectedId || !MODELS.includes(cell.modelId) || !EFFORTS.includes(cell.reasoningEffort)) fail("cell-identity", "model／effort cell identity 不合法", cell.id);
    if (!["unmeasured", "diagnostic", "measured"].includes(cell.status)) fail("cell-status", "cell status 不合法", cell.id);
    if (cell.status === "unmeasured" && !cell.nextExperiment?.trim()) fail("missing-next-experiment", "unmeasured cell 缺少 next experiment", cell.id);
    if (cell.status === "measured") {
      if (!cell.evidence?.path || isAbsolute(cell.evidence.path) || cell.evidence.path.split(/[\\/]/).includes("..")) fail("measured-evidence-path", "measured cell evidence path 不合法", cell.id);
      else {
        const absolute = resolve(root, cell.evidence.path);
        if (!(absolute === root || absolute.startsWith(`${root}${sep}`)) || !existsSync(absolute)) fail("missing-measured-evidence", "measured cell evidence 不存在", cell.id);
      }
      if (!Number.isFinite(cell.metrics?.seriousErrorRate) || !Number.isFinite(cell.metrics?.medianTokens) || !Number.isFinite(cell.metrics?.p95LatencyMs)) fail("missing-measured-metrics", "measured cell 缺少必要 metrics", cell.id);
    }
  }
  for (const id of required) if (!byId.has(id)) fail("missing-cell", `缺少 model cell：${id}`, id);
  for (const route of document?.routingPolicy ?? []) {
    if (!required.includes(route.preferredCellId)) fail("route-cell", `routing policy 指到未宣告 cell：${route.preferredCellId}`);
    if (["editorial_plan", "quality_critical", "contract_audit"].includes(route.taskClass) && route.secondPassRequired !== true) fail("critical-second-pass", `${route.taskClass} 未要求第二次複核`);
  }
  const measuredCount = cells.filter((cell) => cell.status === "measured").length;
  if (document?.claimStatus === "measured" && measuredCount !== required.length) fail("premature-quality-claim", "未完成所有 required cells，不得宣稱 model matrix measured");
  return {
    schemaVersion: 1,
    status: findings.length ? "BLOCK" : "GREEN",
    productVersion: document?.productVersion,
    cellCount: cells.length,
    measuredCount,
    claimStatus: document?.claimStatus,
    findings: findings.length ? findings : [{ status: "PASS", code: "model-capability-contract", message: "模型矩陣、路由與未量測邊界一致。" }],
  };
}

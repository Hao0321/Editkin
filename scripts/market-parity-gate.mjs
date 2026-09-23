import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function evaluateMarketParity(contract) {
  const findings = [];
  const fail = (code, message) => findings.push({ status: "FAIL", code, message });
  if (contract?.schemaVersion !== 1) fail("schema", "schemaVersion 必須是 1");
  if (contract?.claimStatus !== "unmeasured" && contract?.claimStatus !== "verified") fail("claim-status", "claimStatus 不合法");
  if (!Array.isArray(contract?.competitors) || contract.competitors.length < 4) fail("competitors", "競品集合不足");
  if (!Array.isArray(contract?.surfaces) || contract.surfaces.length < 8) fail("surfaces", "比較面向不足");
  if (new Set(contract?.competitors?.map((item) => item.id)).size !== contract?.competitors?.length) fail("duplicate-competitor", "競品 id 重複");
  if (new Set(contract?.surfaces).size !== contract?.surfaces?.length) fail("duplicate-surface", "比較面向重複");
  for (const key of ["sameSourceMedia", "sameBrief", "frozenVersions", "hiddenAssignments", "separateEvaluatorAndPlanner", "requireWallClockAndHardwareReceipt", "requireSeriousErrorRate", "requireTokenAndApiCost"]) {
    if (contract?.protocol?.[key] !== true) fail("protocol", `protocol.${key} 必須為 true`);
  }
  if ((contract?.protocol?.minimumIndependentReviewers ?? 0) < 3) fail("reviewers", "至少需要三位獨立 reviewer");
  const cells = (contract?.competitors?.length ?? 0) * (contract?.surfaces?.length ?? 0);
  const measured = new Set((contract?.results ?? []).map((item) => `${item.competitorId}:${item.surface}`));
  if (contract?.claimStatus === "verified" && measured.size !== cells) fail("false-leadership-claim", "未覆蓋所有 benchmark cells，不得宣告市場領先");
  if (contract?.claimStatus === "unmeasured" && (typeof contract?.nextExperiment !== "string" || !contract.nextExperiment.trim())) fail("next-experiment", "未量測狀態需要 nextExperiment");
  return { status: findings.length ? "BLOCK" : "GREEN", claimStatus: contract?.claimStatus, cells, measuredCells: measured.size, findings: findings.length ? findings : [{ status: "PASS", code: "honest-market-claim", message: "市場領先宣告與現有證據一致" }] };
}

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(await readFile(resolve(root, "market-parity-contract.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (contract.productVersion !== packageJson.version) throw new Error("Market parity contract 版本漂移");
const report = evaluateMarketParity(contract);
if (process.argv.includes("--self-test")) {
  const falseClaim = structuredClone(contract);
  falseClaim.claimStatus = "verified";
  const negative = evaluateMarketParity(falseClaim);
  if (negative.status !== "BLOCK" || !negative.findings.some((item) => item.code === "false-leadership-claim")) throw new Error("市場領先負向 fixture 未被阻擋");
  report.negativeControl = "PASS";
}
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "GREEN") process.exitCode = 1;

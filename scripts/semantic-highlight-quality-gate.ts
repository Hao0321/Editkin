import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { planSemanticAutoEdit } from "../src/application/semanticAutoEdit";
import { evaluateSemanticHighlightQuality, type HighlightAcceptance, type HighlightQualityCase } from "./lib/semantic-highlight-quality";

const datasetPath = resolve("tests/fixtures/semantic-highlight-regression-v1.json");
const baselineReportPath = resolve(".rd/benchmarks/semantic-highlight-quality-baseline.json");
const baseline = process.argv.includes("--baseline");
const selfTest = process.argv.includes("--self-test");
const outputPath = resolve(process.argv.find((item) => item.startsWith("--output="))?.slice(9)
  ?? (baseline ? baselineReportPath : ".rd/benchmarks/semantic-highlight-quality-report.json"));

async function identity(paths: string[]) {
  const files = await Promise.all(paths.map(async (path) => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
  const sha256 = createHash("sha256").update(files.map((item) => `${item.path}\0${item.sha256}`).join("\n")).digest("hex");
  return { sha256, files };
}

if (selfTest) {
  const acceptance: HighlightAcceptance = { minimumCases: 1, requiredLanguages: ["en"], minimumMicroPrecision: .9, minimumMicroRecall: .9, minimumLanguageF1: .9, maximumSevereErrorRate: 0, maximumMeanBudgetErrorRatio: .1 };
  const one: HighlightQualityCase = { id: "self-test", language: "en", duration: 8, fps: 30, targetRatio: .5, cues: [{ start: 0, end: 4, text: "answer" }], reference: { highlightRanges: [{ start: 0, end: 4 }], forbiddenRanges: [{ start: 4, end: 8 }] } };
  const exact = evaluateSemanticHighlightQuality([one], [{ id: one.id, keepRanges: [{ start: 0, end: 4 }], elapsedMs: 0 }], acceptance);
  const all = evaluateSemanticHighlightQuality([one], [{ id: one.id, keepRanges: [{ start: 0, end: 8 }], elapsedMs: 0 }], acceptance);
  const shifted = evaluateSemanticHighlightQuality([one], [{ id: one.id, keepRanges: [{ start: 4, end: 8 }], elapsedMs: 0 }], acceptance);
  let missingRejected = false; try { evaluateSemanticHighlightQuality([one], [], acceptance); } catch { missingRejected = true; }
  const status = exact.status === "GREEN" && all.status === "BLOCK" && shifted.status === "BLOCK" && missingRejected ? "GREEN" : "BLOCK";
  process.stdout.write(`${JSON.stringify({ status, exactAccepted: exact.status === "GREEN", selectAllRejected: all.status === "BLOCK", shiftedRejected: shifted.status === "BLOCK", missingCandidateRejected: missingRejected })}\n`);
  if (status !== "GREEN") process.exitCode = 1;
} else {
  const datasetBytes = await readFile(datasetPath);
  const dataset = JSON.parse(String(datasetBytes)) as { schemaVersion: number; datasetId: string; referenceProvenance: { kind: string; annotatorId: string; developmentVisibility: string; claimBoundary: string }; acceptance: HighlightAcceptance; cases: HighlightQualityCase[] };
  if (dataset.schemaVersion !== 1 || !dataset.datasetId || dataset.referenceProvenance.kind !== "planner-independent" || !dataset.referenceProvenance.annotatorId || dataset.referenceProvenance.developmentVisibility !== "visible") throw new Error("重點品質 dataset provenance 不合法");
  const candidates = dataset.cases.map((item) => {
    const request = { duration: item.duration, fps: item.fps, cues: item.cues, cuts: item.cuts, targetRatio: item.targetRatio };
    const started = performance.now(); const plan = planSemanticAutoEdit(request); const elapsedMs = performance.now() - started;
    return { id: item.id, keepRanges: plan.keepRanges, elapsedMs };
  });
  const result = evaluateSemanticHighlightQuality(dataset.cases, candidates, dataset.acceptance);
  const datasetSha256 = createHash("sha256").update(datasetBytes).digest("hex");
  const planner = await identity([resolve("src/application/semanticAutoEdit.ts"), resolve("src/application/semanticHighlightSignals.ts")]);
  const evaluator = await identity([resolve("scripts/semantic-highlight-quality-gate.ts"), resolve("scripts/lib/semantic-highlight-quality.ts")]);
  let frozenBaseline: { status: string; dataset?: { sha256?: string }; planner?: { sha256?: string }; mode?: string } | undefined;
  if (!baseline) {
    const parsedBaseline = JSON.parse(await readFile(baselineReportPath, "utf8")) as NonNullable<typeof frozenBaseline>;
    if (parsedBaseline.mode !== "baseline" || parsedBaseline.status !== "BLOCK" || parsedBaseline.dataset?.sha256 !== datasetSha256 || !parsedBaseline.planner?.sha256) throw new Error("缺少同 dataset 的 frozen RED baseline");
    frozenBaseline = parsedBaseline;
  }
  const payload = { schema: "editkin.semantic-highlight-quality/v1", measuredAt: new Date().toISOString(), mode: baseline ? "baseline" : "promotion", claimBoundary: dataset.referenceProvenance.claimBoundary, dataset: { id: dataset.datasetId, path: datasetPath, sha256: datasetSha256, provenance: dataset.referenceProvenance }, planner: { engine: "editkin-explainable-highlight-0.2", ...planner }, evaluator, baseline: frozenBaseline ? { rejected: true, reportPath: baselineReportPath, plannerSha256: frozenBaseline.planner?.sha256 } : undefined, ...result };
  await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (baseline ? result.status !== "BLOCK" : result.status !== "GREEN") process.exitCode = 1;
}

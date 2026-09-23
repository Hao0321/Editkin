import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateCaptionQuality, type CaptionAcceptance, type CaptionQualityItem } from "./lib/caption-quality";

const defaultAcceptance: CaptionAcceptance = { maxCer: 0.12, maxWer: 0.2, maxBoundaryP95Ms: 450, maxRealTimeFactor: 1, minDurationHours: 10, requiredLanguages: ["en", "zh-Hant"] };
const selfTest = process.argv.includes("--self-test");

if (selfTest) {
  const exact: CaptionQualityItem = {
    id: "exact", language: "zh-Hant", durationSeconds: 10, processingSeconds: 2,
    referenceProvenance: { kind: "human", annotator: "fixture-reviewer" }, candidateProvenance: { engine: "fixture", model: "exact" },
    reference: [{ start: 1, end: 3, text: "這是關鍵方法" }], candidate: [{ start: 1, end: 3, text: "這是關鍵方法" }],
  };
  const acceptance = { ...defaultAcceptance, minDurationHours: 0, requiredLanguages: ["zh-Hant"] };
  const positive = evaluateCaptionQuality([exact], acceptance);
  const negative = evaluateCaptionQuality([{ ...exact, candidate: [{ start: 2, end: 4, text: "完全錯誤內容" }] }], acceptance);
  const provenanceRejected = (() => { try { evaluateCaptionQuality([{ ...exact, referenceProvenance: { kind: "human", annotator: "" } }], acceptance); return false; } catch { return true; } })();
  const status = positive.status === "GREEN" && negative.status === "BLOCK" && negative.metrics.cer > 0 && negative.metrics.boundaryP95Ms > 0 && provenanceRejected ? "GREEN" : "BLOCK";
  process.stdout.write(`${JSON.stringify({ status, exactAccepted: positive.status === "GREEN", negativeControlRejected: negative.status === "BLOCK", provenanceRejected })}\n`);
  if (status !== "GREEN") process.exitCode = 1;
} else {
  const manifestPath = resolve(process.argv[2] ?? "caption-quality-corpus.json");
  const outputPath = resolve(process.argv[3] ?? "../../.rd/benchmarks/editkin-caption-quality.json");
  const bytes = await readFile(manifestPath);
  const document = JSON.parse(String(bytes)) as { schemaVersion: number; datasetId: string; acceptance?: CaptionAcceptance; items: CaptionQualityItem[] };
  if (document.schemaVersion !== 1 || !document.datasetId) throw new Error("字幕品質 manifest schema／datasetId 不合法");
  const result = evaluateCaptionQuality(document.items, document.acceptance ?? defaultAcceptance);
  const payload = { ...result, dataset: { id: document.datasetId, manifestPath, sha256: createHash("sha256").update(bytes).digest("hex") }, evaluator: "scripts/caption-quality-evaluator.ts" };
  await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(payload)}\n`); if (payload.status !== "GREEN") process.exitCode = 1;
}

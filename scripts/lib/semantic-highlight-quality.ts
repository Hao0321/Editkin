import type { SmartCutKeepRange } from "../../src/domain/smartCut";
import type { SemanticAutoEditRequest } from "../../src/application/semanticAutoEdit";

export interface HighlightQualityCase extends SemanticAutoEditRequest {
  id: string;
  language: string;
  targetRatio: number;
  reference: { highlightRanges: SmartCutKeepRange[]; forbiddenRanges: SmartCutKeepRange[] };
}

export interface HighlightAcceptance {
  minimumCases: number;
  requiredLanguages: string[];
  minimumMicroPrecision: number;
  minimumMicroRecall: number;
  minimumLanguageF1: number;
  maximumSevereErrorRate: number;
  maximumMeanBudgetErrorRatio: number;
}

interface CandidateResult { id: string; keepRanges: SmartCutKeepRange[]; elapsedMs: number }

const sumDuration = (ranges: readonly SmartCutKeepRange[]) => ranges.reduce((sum, range) => sum + range.end - range.start, 0);

function intersectionDuration(left: readonly SmartCutKeepRange[], right: readonly SmartCutKeepRange[]): number {
  let total = 0;
  for (const a of left) for (const b of right) total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return total;
}

function validRanges(ranges: readonly SmartCutKeepRange[], duration: number): boolean {
  return ranges.every((range, index) => Number.isFinite(range.start) && Number.isFinite(range.end)
    && range.start >= 0 && range.end <= duration && range.end > range.start
    && (index === 0 || ranges[index - 1].end <= range.start));
}

const f1 = (precision: number, recall: number) => precision + recall ? 2 * precision * recall / (precision + recall) : 0;

export function evaluateSemanticHighlightQuality(cases: HighlightQualityCase[], candidates: CandidateResult[], acceptance: HighlightAcceptance) {
  if (cases.length < acceptance.minimumCases || new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("重點品質 corpus 案例不足或 ID 重複");
  if (candidates.length !== cases.length || new Set(candidates.map((item) => item.id)).size !== candidates.length) throw new Error("candidate 必須與 frozen corpus 一對一");
  const byCandidate = new Map(candidates.map((item) => [item.id, item]));
  let truePositiveSeconds = 0; let selectedSeconds = 0; let referenceSeconds = 0; let severeErrors = 0; let budgetErrorRatio = 0;
  const languageTotals = new Map<string, { tp: number; selected: number; reference: number }>();
  const details = cases.map((item) => {
    const candidate = byCandidate.get(item.id);
    if (!candidate || !validRanges(candidate.keepRanges, item.duration) || !Number.isFinite(candidate.elapsedMs) || candidate.elapsedMs < 0) throw new Error(`candidate ranges／provenance 不合法：${item.id}`);
    if (!validRanges(item.reference.highlightRanges, item.duration) || !validRanges(item.reference.forbiddenRanges, item.duration)) throw new Error(`reference ranges 不合法：${item.id}`);
    const selected = sumDuration(candidate.keepRanges); const reference = sumDuration(item.reference.highlightRanges);
    const tp = intersectionDuration(candidate.keepRanges, item.reference.highlightRanges);
    const forbidden = intersectionDuration(candidate.keepRanges, item.reference.forbiddenRanges);
    const precision = tp / Math.max(selected, Number.EPSILON); const recall = tp / Math.max(reference, Number.EPSILON);
    const requiredRangesMissed = item.reference.highlightRanges.filter((range) => intersectionDuration(candidate.keepRanges, [range]) / (range.end - range.start) < 0.75).length;
    const targetSeconds = item.duration * item.targetRatio;
    const budgetError = Math.abs(selected - targetSeconds) / item.duration;
    const severe = requiredRangesMissed > 0 || forbidden > 0.25;
    truePositiveSeconds += tp; selectedSeconds += selected; referenceSeconds += reference; budgetErrorRatio += budgetError; severeErrors += Number(severe);
    const language = languageTotals.get(item.language) ?? { tp: 0, selected: 0, reference: 0 };
    language.tp += tp; language.selected += selected; language.reference += reference; languageTotals.set(item.language, language);
    return { id: item.id, language: item.language, precision, recall, f1: f1(precision, recall), selectedSeconds: selected, referenceSeconds: reference, forbiddenSeconds: forbidden, requiredRangesMissed, budgetErrorRatio: budgetError, elapsedMs: candidate.elapsedMs, severe };
  });
  const microPrecision = truePositiveSeconds / Math.max(selectedSeconds, Number.EPSILON);
  const microRecall = truePositiveSeconds / Math.max(referenceSeconds, Number.EPSILON);
  const languageF1 = Object.fromEntries([...languageTotals].map(([language, value]) => {
    const precision = value.tp / Math.max(value.selected, Number.EPSILON); const recall = value.tp / Math.max(value.reference, Number.EPSILON);
    return [language, f1(precision, recall)];
  }));
  const metrics = { caseCount: cases.length, languages: [...languageTotals.keys()].sort(), microPrecision, microRecall, microF1: f1(microPrecision, microRecall), severeErrorRate: severeErrors / cases.length, meanBudgetErrorRatio: budgetErrorRatio / cases.length, languageF1, maxElapsedMs: Math.max(...candidates.map((item) => item.elapsedMs)) };
  const assertions = {
    caseCount: cases.length >= acceptance.minimumCases,
    languages: acceptance.requiredLanguages.every((language) => languageTotals.has(language)),
    precision: microPrecision >= acceptance.minimumMicroPrecision,
    recall: microRecall >= acceptance.minimumMicroRecall,
    languageF1: acceptance.requiredLanguages.every((language) => (languageF1[language] ?? 0) >= acceptance.minimumLanguageF1),
    severeErrors: metrics.severeErrorRate <= acceptance.maximumSevereErrorRate,
    budget: metrics.meanBudgetErrorRatio <= acceptance.maximumMeanBudgetErrorRatio,
  };
  return { status: Object.values(assertions).every(Boolean) ? "GREEN" as const : "BLOCK" as const, evidenceLevel: "frozen-regression" as const, metrics, assertions, acceptance, details };
}

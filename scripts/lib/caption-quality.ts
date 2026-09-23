export interface CaptionCue { start: number; end: number; text: string }
export interface CaptionQualityItem {
  id: string;
  language: string;
  durationSeconds: number;
  processingSeconds: number;
  referenceProvenance: { kind: "human"; annotator: string };
  candidateProvenance: { engine: string; model: string };
  reference: CaptionCue[];
  candidate: CaptionCue[];
}

export interface CaptionAcceptance {
  maxCer: number;
  maxWer: number;
  maxBoundaryP95Ms: number;
  maxRealTimeFactor: number;
  minDurationHours: number;
  requiredLanguages: string[];
}

function tokens(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}']+/gu) ?? [];
}

function characters(text: string): string[] {
  return [...text.toLocaleLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "")];
}

function editDistance<T>(left: readonly T[], right: readonly T[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous[rightIndex - 1]
        : Math.min(previous[rightIndex - 1], previous[rightIndex], current[rightIndex - 1]) + 1;
    }
    previous = current;
  }
  return previous[right.length];
}

const percentile = (values: number[], ratio: number) => values.length
  ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]
  : Number.POSITIVE_INFINITY;

function boundaryErrors(reference: CaptionCue[], candidate: CaptionCue[]): { errorsMs: number[]; unmatched: number } {
  const unused = new Set(candidate.map((_, index) => index));
  const errorsMs: number[] = [];
  let unmatched = 0;
  for (const cue of reference) {
    const referenceTokens = tokens(cue.text);
    let best: { index: number; error: number } | undefined;
    for (const index of unused) {
      const compared = candidate[index];
      const lexical = editDistance(referenceTokens, tokens(compared.text)) / Math.max(1, referenceTokens.length);
      const time = (Math.abs(cue.start - compared.start) + Math.abs(cue.end - compared.end)) / 2;
      const error = lexical * 10 + time;
      if (!best || error < best.error) best = { index, error };
    }
    if (!best || best.error >= 10.75) { unmatched += 1; continue; }
    const matched = candidate[best.index];
    unused.delete(best.index);
    errorsMs.push(Math.abs(cue.start - matched.start) * 1_000, Math.abs(cue.end - matched.end) * 1_000);
  }
  return { errorsMs, unmatched: unmatched + unused.size };
}

export function evaluateCaptionQuality(items: CaptionQualityItem[], acceptance: CaptionAcceptance) {
  if (!items.length) throw new Error("字幕品質資料集不可為空");
  let characterErrors = 0; let characterCount = 0; let wordErrors = 0; let wordCount = 0;
  let durationSeconds = 0; let processingSeconds = 0; let unmatchedCues = 0;
  const cueBoundaryErrorsMs: number[] = [];
  const languages = new Set<string>();
  for (const item of items) {
    if (!item.id || !item.language || item.referenceProvenance.kind !== "human" || !item.referenceProvenance.annotator.trim()) throw new Error(`字幕 reference 必須是獨立人工標註：${item.id || "unknown"}`);
    if (!item.candidateProvenance.engine || !item.candidateProvenance.model) throw new Error(`字幕 candidate 缺少引擎 provenance：${item.id}`);
    if (!(item.durationSeconds > 0) || !(item.processingSeconds >= 0) || !item.reference.length) throw new Error(`字幕資料列不合法：${item.id}`);
    const referenceText = item.reference.map((cue) => cue.text).join(" ");
    const candidateText = item.candidate.map((cue) => cue.text).join(" ");
    const referenceCharacters = characters(referenceText); const candidateCharacters = characters(candidateText);
    const referenceWords = tokens(referenceText); const candidateWords = tokens(candidateText);
    characterErrors += editDistance(referenceCharacters, candidateCharacters); characterCount += referenceCharacters.length;
    wordErrors += editDistance(referenceWords, candidateWords); wordCount += referenceWords.length;
    const boundary = boundaryErrors(item.reference, item.candidate);
    cueBoundaryErrorsMs.push(...boundary.errorsMs); unmatchedCues += boundary.unmatched;
    durationSeconds += item.durationSeconds; processingSeconds += item.processingSeconds; languages.add(item.language);
  }
  const metrics = {
    cer: characterErrors / Math.max(1, characterCount),
    wer: wordErrors / Math.max(1, wordCount),
    boundaryMedianMs: percentile(cueBoundaryErrorsMs, 0.5),
    boundaryP95Ms: percentile(cueBoundaryErrorsMs, 0.95),
    unmatchedCues,
    realTimeFactor: processingSeconds / durationSeconds,
    durationHours: durationSeconds / 3_600,
    languages: [...languages].sort(),
    itemCount: items.length,
  };
  const assertions = {
    cer: metrics.cer <= acceptance.maxCer,
    wer: metrics.wer <= acceptance.maxWer,
    boundaryP95: metrics.boundaryP95Ms <= acceptance.maxBoundaryP95Ms,
    realTimeFactor: metrics.realTimeFactor <= acceptance.maxRealTimeFactor,
    duration: metrics.durationHours >= acceptance.minDurationHours,
    languages: acceptance.requiredLanguages.every((language) => languages.has(language)),
    cueAlignment: unmatchedCues === 0,
  };
  return { status: Object.values(assertions).every(Boolean) ? "GREEN" : "BLOCK", metrics, assertions, acceptance };
}

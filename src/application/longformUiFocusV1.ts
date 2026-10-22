import { colorDigest } from "./materialColorSamplingRuntime";
import { verifyWindowsOcrReceiptV1 } from "./windowsOcrRuntimeV1";
import { verifyMaterialKeyframeDisplay } from "./materialKeyframeValidation";
import { longformUiFocusConfirmationV1Schema, type LongformUiFocusCandidateV1, type LongformUiFocusDraftV1,
  type LongformUiFocusFrameV1 } from "../domain/longformUiFocusV1";

export const normalizeUiFocusTextV1 = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en-US");

/** Windows' official sample rotates OCR rectangles about the image center by
 * TextAngle. Positive angles rotate clockwise in image coordinates (y down).
 * https://github.com/microsoft/Windows-universal-samples/blob/main/Samples/OCR/cs/OcrFileImage.xaml.cs */
export function projectWindowsOcrRectV1(rect: { x: number; y: number; width: number; height: number },
  image: { width: number; height: number; textAngle: number | null }) {
  if (![rect.x, rect.y, rect.width, rect.height, image.width, image.height, image.textAngle ?? 0].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || image.width <= 0 || image.height <= 0) throw Error("OCR_INVALID_PROJECTION");
  const angle = (image.textAngle ?? 0) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = image.width / 2, cy = image.height / 2;
  const quad = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]]
    .map(([x, y]) => ({ x: (cx + cos * (x - cx) - sin * (y - cy)) / image.width,
      y: (cy + sin * (x - cx) + cos * (y - cy)) / image.height }));
  const x = Math.min(...quad.map(p => p.x)), y = Math.min(...quad.map(p => p.y));
  return { quad, bounds: { x, y, width: Math.max(...quad.map(p => p.x)) - x, height: Math.max(...quad.map(p => p.y)) - y },
    eligible: quad.every(p => p.x >= 0 && p.y >= 0 && p.x <= 1 && p.y <= 1) };
}

function candidatesForFrame(frame: LongformUiFocusFrameV1, targetTexts: string[]): LongformUiFocusCandidateV1[] {
  const result = frame.ocr.result, candidates: LongformUiFocusCandidateV1[] = [];
  for (const line of result.lines) {
    const add = (scope: "word" | "line" | "phrase", words: typeof line.words, text: string) => {
      const x = Math.min(...words.map(w => w.x)), y = Math.min(...words.map(w => w.y));
      const geometry = projectWindowsOcrRectV1({ x, y, width: Math.max(...words.map(w => w.x + w.width)) - x,
        height: Math.max(...words.map(w => w.y + w.height)) - y }, result);
      const row: Omit<LongformUiFocusCandidateV1, "candidateId"> = { frameId: frame.id, scope, lineIndex: line.index,
        wordIndexes: words.map(w => w.index), text, normalizedText: normalizeUiFocusTextV1(text),
        sourceTime: frame.display.decoded.sourceTime, relativeTime: frame.display.decoded.relativeTime, ...geometry,
        flags: geometry.eligible ? [] : ["PROJECTED_REGION_OUTSIDE_FRAME"], coordinateSpace: "normalized-upright-display-frame",
        authority: "ocr-text-region", validity: "decoded-instant-only", clickableControlVerified: false };
      candidates.push({ ...row, candidateId: `uif-${colorDigest({ observation: frame.ocr.receiptSha256, display: frame.display.receiptSha256, row })}` });
    };
    for (const word of line.words) add("word", [word], word.text);
    // A one-word line adds no distinct target; do not manufacture ambiguity.
    if (line.words.length > 1) add("line", line.words, line.text);
    // UI toolbars may be one OCR line; CJK labels may be several OCR words.
    // Target text requests identify contiguous observed tokens, never boxes.
    for (const target of targetTexts) {
      const wanted = normalizeUiFocusTextV1(target);
      for (let i = 0; i < line.words.length; i++) {
        let observed = "";
        for (let j = i; j < Math.min(line.words.length, i + 32); j++) {
          observed += normalizeUiFocusTextV1(line.words[j].text);
          if (!wanted.startsWith(observed)) break;
          if (observed === wanted) {
            const words = line.words.slice(i, j + 1);
            if (words.length > 1 && !(i === 0 && j === line.words.length - 1 && normalizeUiFocusTextV1(line.text) === wanted))
              add("phrase", words, words.map(w => w.text).join(" "));
            break;
          }
        }
      }
    }
  }
  return candidates;
}

/** Internal assembly does not grant authenticity to caller-written receipts.
 * The runtime independently extracts and recognizes current source pixels. */
export function assembleLongformUiFocusDraftV1(source: LongformUiFocusDraftV1["source"], frames: LongformUiFocusFrameV1[],
  omitted: LongformUiFocusDraftV1["omitted"] = [], targetTexts: string[] = []): LongformUiFocusDraftV1 {
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !source.recordingId || source.recordingId.length > 160
    || !Number.isFinite(source.start) || source.start < 0 || !Number.isFinite(source.duration) || source.duration <= 0 || !Number.isFinite(source.start + source.duration)
    || frames.length + omitted.length < 1 || frames.length + omitted.length > 12
    || new Set([...frames.map(f => f.id), ...omitted.map(f => f.frameId)]).size !== frames.length + omitted.length) throw Error("UI_FOCUS_SOURCE_OR_FRAME_BUDGET");
  if (!Array.isArray(targetTexts) || targetTexts.length > 16 || targetTexts.some(t => typeof t !== "string" || !t.trim() || t.length > 128)
    || new Set(targetTexts.map(normalizeUiFocusTextV1)).size !== targetTexts.length) throw Error("UI_FOCUS_TARGET_TEXT_BUDGET");
  const candidates: LongformUiFocusCandidateV1[] = [];
  for (const [index, frame] of frames.entries()) {
    const d = frame.display; verifyWindowsOcrReceiptV1(frame.ocr);
    if (index > 0 && (d.decoded.relativeTime <= frames[index - 1].display.decoded.relativeTime
      || d.requested.time <= frames[index - 1].display.requested.time)) throw Error("UI_FOCUS_FRAME_ORDER");
    if (index > 0 && colorDigest({ provider: frame.ocr.provider, runtime: frame.ocr.result.runtime })
      !== colorDigest({ provider: frames[0].ocr.provider, runtime: frames[0].ocr.result.runtime })) throw Error("UI_FOCUS_OCR_RUNTIME_CHANGED");
    verifyMaterialKeyframeDisplay({ schema: "editkin.material-keyframe-analysis/v1", state: "ready", policy: "neutral-srgb-display-v1",
      runtimeIdentitySha256: d.runtimeIdentitySha256, requestedSamples: [d.requested], omitted: [] },
    [{ id: frame.id, time: d.decoded.relativeTime, sceneIndex: d.decoded.sceneIndex, sha256: d.jpeg.sha256, bytes: d.jpeg.bytes, display: d }],
    { sourceSha256: source.sha256, sourceStart: source.start, duration: source.duration, kind: "video" }, d.runtimeIdentitySha256);
    if (frame.ocr.imageSha256 !== d.jpeg.sha256 || frame.ocr.result.width !== d.decoded.width || frame.ocr.result.height !== d.decoded.height)
      throw Error("UI_FOCUS_OCR_FRAME_BINDING");
    candidates.push(...candidatesForFrame(frame, targetTexts));
  }
  const draft: LongformUiFocusDraftV1 = { schema: "editkin.longform-ui-focus-draft/v1", draftId: "", state: "REVIEW_REQUIRED",
    source: structuredClone(source), frames: structuredClone(frames), candidates, omitted: structuredClone(omitted), targetTexts: [...targetTexts], projectModified: false,
    artworkStatus: "ART_PENDING_CLAUDE", selectableByDefault: false };
  draft.draftId = colorDigest({ ...draft, draftId: undefined }); return draft;
}

export function verifyLongformUiFocusDraftV1(draft: LongformUiFocusDraftV1) {
  if (colorDigest(assembleLongformUiFocusDraftV1(draft.source, draft.frames, draft.omitted, draft.targetTexts)) !== colorDigest(draft)) throw Error("UI_FOCUS_DRAFT_INCONSISTENT");
}
export function findLongformUiFocusCandidatesV1(draft: LongformUiFocusDraftV1, text: string) {
  verifyLongformUiFocusDraftV1(draft);
  if (!text.trim() || text.length > 8192) throw Error("UI_FOCUS_TEXT_BUDGET");
  const matches = draft.candidates.filter(c => c.eligible && c.normalizedText === normalizeUiFocusTextV1(text));
  return { state: matches.length === 0 ? "MISSING" : matches.length === 1 ? "ONE_MATCH_REQUIRES_CONFIRMATION" : "AMBIGUOUS",
    candidates: structuredClone(matches), automaticSelection: false as const };
}
export function confirmLongformUiFocusV1(draft: LongformUiFocusDraftV1, raw: unknown) {
  verifyLongformUiFocusDraftV1(draft);
  const confirmation = longformUiFocusConfirmationV1Schema.parse(raw);
  if (confirmation.draftId !== draft.draftId) throw Error("UI_FOCUS_STALE_DRAFT");
  const candidates = confirmation.candidateIds.map(id => {
    const row = draft.candidates.find(c => c.candidateId === id);
    if (!row || !row.eligible) throw Error("UI_FOCUS_CANDIDATE_UNAVAILABLE"); return structuredClone(row);
  });
  return { schema: "editkin.longform-ui-focus-confirmation/v1" as const, draftId: draft.draftId, candidateIds: confirmation.candidateIds,
    candidates, status: "CONFIRMED_TARGET_OBSERVATIONS" as const, projectModified: false as const, focusHintsReady: false as const,
    requiredBeforeHint: "Verify target visibility and movement for the entire intended hold in the current source clip" };
}

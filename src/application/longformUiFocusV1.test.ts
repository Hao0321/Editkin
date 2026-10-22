import { expect, it } from "vitest";
import { colorDigest } from "./materialColorSamplingRuntime";
import { uiFocusFixtureV1 } from "./longformUiFocusV1.fixture";
import { assembleLongformUiFocusDraftV1, confirmLongformUiFocusV1, findLongformUiFocusCandidatesV1,
  projectWindowsOcrRectV1, verifyLongformUiFocusDraftV1 } from "./longformUiFocusV1";
import { longformUiFocusRequestV1Schema } from "../domain/longformUiFocusV1";

it("projects real clock metadata and detected text boxes; confirmation accepts only observed IDs", () => {
  const f = uiFocusFixtureV1(), d = assembleLongformUiFocusDraftV1(f.source, [f.frame]);
  const found = findLongformUiFocusCandidatesV1(d, "儲 存專案");
  expect(found.state).toBe("ONE_MATCH_REQUIRES_CONFIRMATION");
  expect(found.candidates[0]).toMatchObject({ scope: "line", text: "儲存 專案", sourceTime: .2, relativeTime: .15,
    authority: "ocr-text-region", clickableControlVerified: false, validity: "decoded-instant-only" });
  expect(found.candidates[0].bounds).toMatchObject({ x: expect.closeTo(100 / 960), y: expect.closeTo(100 / 640),
    width: expect.closeTo(130 / 960), height: expect.closeTo(30 / 640) });
  const selected = confirmLongformUiFocusV1(d, { draftId: d.draftId, candidateIds: [found.candidates[0].candidateId] });
  expect(selected).toMatchObject({ status: "CONFIRMED_TARGET_OBSERVATIONS", focusHintsReady: false, projectModified: false });
  expect(d.candidates).toHaveLength(3); expect(d.frames[0].ocr.result.lines[0].text).toBe("儲存 專案");
});
it("uses image-center positive rotation rather than rotating around each word or ignoring TextAngle", () => {
  const p = projectWindowsOcrRectV1({ x: 60, y: 40, width: 20, height: 10 }, { width: 200, height: 100, textAngle: 90 });
  expect(p.quad[0].x).toBeCloseTo(.55); expect(p.quad[0].y).toBeCloseTo(.1);
  expect(p.quad[2].x).toBeCloseTo(.5); expect(p.quad[2].y).toBeCloseTo(.3);
  expect(p.bounds.width).toBeCloseTo(.05); expect(p.bounds.height).toBeCloseTo(.2);
});
it("keeps outside projected observations visible but refuses confirmation; no clamped fake target", () => {
  const f = uiFocusFixtureV1(); f.frame.ocr.result.lines[0].words[0].x = -10; f.reseal();
  const d = assembleLongformUiFocusDraftV1(f.source, [f.frame]);
  expect(d.candidates[0]).toMatchObject({ eligible: false, flags: ["PROJECTED_REGION_OUTSIDE_FRAME"] });
  expect(d.candidates[0].bounds.x).toBeLessThan(0);
  expect(() => confirmLongformUiFocusV1(d, { draftId: d.draftId, candidateIds: [d.candidates[0].candidateId] })).toThrow("UNAVAILABLE");
});
it("retains missing and repeated text as missing/ambiguous without selecting a target", () => {
  const f = uiFocusFixtureV1(); f.frame.ocr.result.lines[0].words[1].text = "儲存"; f.frame.ocr.result.lines[0].text = "儲存 儲存"; f.reseal();
  const d = assembleLongformUiFocusDraftV1(f.source, [f.frame]);
  expect(findLongformUiFocusCandidatesV1(d, "儲存")).toMatchObject({ state: "AMBIGUOUS", automaticSelection: false });
  expect(findLongformUiFocusCandidatesV1(d, "不存在")).toMatchObject({ state: "MISSING", candidates: [] });
});
it("a single OCR word does not acquire an artificial duplicate line candidate", () => {
  const f = uiFocusFixtureV1(); f.frame.ocr.result.lines[0].words.pop(); f.frame.ocr.result.lines[0].text = "儲存"; f.reseal();
  expect(assembleLongformUiFocusDraftV1(f.source, [f.frame]).candidates).toHaveLength(1);
});
it.each(["wrong draft", "unknown id", "duplicate id", "manual box"])("refuses %s confirmation", kind => {
  const f = uiFocusFixtureV1(), d = assembleLongformUiFocusDraftV1(f.source, [f.frame]);
  const raw = { draftId: kind === "wrong draft" ? "b".repeat(64) : d.draftId,
    candidateIds: kind === "unknown id" ? [`uif-${"b".repeat(64)}`] : [d.candidates[0].candidateId],
    ...(kind === "manual box" ? { bounds: { x: .1, y: .1, width: .1, height: .1 } } : {}) };
  if (kind === "duplicate id") raw.candidateIds.push(raw.candidateIds[0]);
  expect(() => confirmLongformUiFocusV1(d, raw)).toThrow();
});
it.each(["word box", "JPEG", "dimensions", "PTS", "source window", "confidence"])("rejects altered %s evidence even when caller reseals enclosing draft", kind => {
  const f = uiFocusFixtureV1(), d = assembleLongformUiFocusDraftV1(f.source, [f.frame]);
  if (kind === "word box") d.candidates[0].bounds.x = .8;
  if (kind === "JPEG") d.frames[0].ocr.imageSha256 = "b".repeat(64);
  if (kind === "dimensions") d.frames[0].ocr.result.width = 900;
  if (kind === "PTS") d.frames[0].display.decoded.pts = 9;
  if (kind === "source window") d.source.start = .1;
  if (kind === "confidence") (d.frames[0].ocr.result.lines[0].words[0] as unknown as Record<string, unknown>).confidence = .99;
  d.frames[0].ocr.receiptSha256 = colorDigest({ ...d.frames[0].ocr, receiptSha256: undefined });
  d.frames[0].display.receiptSha256 = colorDigest({ ...d.frames[0].display, receiptSha256: undefined });
  d.draftId = colorDigest({ ...d, draftId: undefined });
  expect(() => verifyLongformUiFocusDraftV1(d)).toThrow();
});
it("retains empty recognized text as zero candidates and explicit omitted-frame coverage", () => {
  const f = uiFocusFixtureV1(); f.frame.ocr.result.lines = []; f.reseal();
  const d = assembleLongformUiFocusDraftV1(f.source, [f.frame], [{ frameId: "focus-frame-2", reason: "display-extraction-failed" }]);
  expect(d.candidates).toHaveLength(0); expect(d.omitted).toHaveLength(1);
  expect(findLongformUiFocusCandidatesV1(d, "儲存").state).toBe("MISSING");
});
it("strict detector intake refuses manual coordinates, shell-like language, bad ordering and ranges", () => {
  const raw = { schema: "editkin.longform-ui-focus-request/v1", recordingId: "screen", sourcePath: "screen.mp4",
    expectedSourceSha256: "a".repeat(64), sourceStart: 2, duration: 3, language: "zh-Hant-TW", frameTimes: [.1, .2], targetTexts: [] };
  expect(longformUiFocusRequestV1Schema.parse(raw)).toEqual(raw);
  for (const bad of [{ ...raw, bounds: {} }, { ...raw, language: "en-US;calc" }, { ...raw, frameTimes: [.2, .1] },
    { ...raw, frameTimes: [3] }, { ...raw, frameTimes: Array.from({ length: 13 }, (_, i) => i / 10) }])
    expect(longformUiFocusRequestV1Schema.safeParse(bad).success).toBe(false);
});
it("detects multi-token CJK targets inside a toolbar OCR line from observed tokens without caller coordinates", () => {
  const f = uiFocusFixtureV1(); f.frame.ocr.result.lines[0].words.push({ index: 2, text: "取消", x: 250, y: 100, width: 60, height: 30 });
  f.frame.ocr.result.lines[0].text = "儲存 專案 取消"; f.reseal();
  const d = assembleLongformUiFocusDraftV1(f.source, [f.frame], [], ["儲存專案"]);
  const target = findLongformUiFocusCandidatesV1(d, "儲存專案");
  expect(target.state).toBe("ONE_MATCH_REQUIRES_CONFIRMATION");
  expect(target.candidates[0]).toMatchObject({ scope: "phrase", text: "儲存 專案", wordIndexes: [0, 1] });
  expect(target.candidates[0].bounds.width).toBeCloseTo(130 / 960);
  expect(() => assembleLongformUiFocusDraftV1(f.source, [f.frame], [], ["儲存 專案", "儲存專案"])).toThrow("TEXT_BUDGET");
});

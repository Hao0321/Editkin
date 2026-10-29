import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { findCaptionTextV1, prepareCaptionTextReplacementV1, currentCaptionTextReplacementCommandV1 } from "./captionTextReplacementV1";

function source(text = "Cloud Code / cloud code / CLOUD CODE") {
  const project = createEmptyProject("Caption search", { id: "search", fps: 30 });
  project.captions = [
    { id: "A", text, start: 0, duration: 3, translation: { text: "Keep translation", language: "en" } },
    { id: "B", text: "Cloud Code", start: 3, duration: 2 },
  ];
  return validateProject(project);
}

describe("the caption GUI's optional literal case mode", () => {
  it("keeps the historical case-sensitive default and includes every case only when explicitly requested", () => {
    const project = source(), before = structuredClone(project);
    expect(findCaptionTextV1(project, "Cloud Code").totalOccurrences).toBe(2);
    expect(findCaptionTextV1(project, "Cloud Code", 0, 200, undefined, { caseSensitive: false }).totalOccurrences).toBe(4);
    expect(project).toEqual(before);
  });

  it("replaces the checked caption in one real Undo while preserving other text, translation and clock", () => {
    const project = source(), before = structuredClone(project);
    const preview = prepareCaptionTextReplacementV1(project, "cloud code", "Claude Code", ["A"], { caseSensitive: false });
    const next = dispatchCommand(createHistory(project), currentCaptionTextReplacementCommandV1(project, preview)!);
    expect(next.present.captions[0].text).toBe("Claude Code / Claude Code / Claude Code");
    expect(next.present.captions[1]).toEqual(before.captions[1]);
    expect(next.present.captions[0].translation).toEqual(before.captions[0].translation);
    expect(next.present.captions[0].start).toBe(0); expect(next.present.captions[0].duration).toBe(3);
    expect(next.past).toHaveLength(1); expect(undo(next).present.captions).toEqual(before.captions);
  });

  it("keeps regex symbols and replacement dollars literal, with correct UTF16 offsets after emoji", () => {
    const project = source("😀[A].* [a].*");
    const found = findCaptionTextV1(project, "[a].*", 0, 200, undefined, { caseSensitive: false });
    expect(found.matches[0]).toMatchObject({ occurrences: 2, firstOffset: 2 });
    const preview = prepareCaptionTextReplacementV1(project, "[a].*", "$&$$$1", undefined, { caseSensitive: false });
    const next = dispatchCommand(createHistory(project), currentCaptionTextReplacementCommandV1(project, preview)!);
    expect(next.present.captions[0].text).toBe("😀$&$$$1 $&$$$1");
  });

  it("uses the actual matched UTF8 size for Unicode folds and refuses growth before allocating a huge replacement", () => {
    const project = source("K".repeat(32));
    expect(findCaptionTextV1(project, "k", 0, 200, undefined, { caseSensitive: false }).matches[0].occurrences).toBe(32);
    expect(() => prepareCaptionTextReplacementV1(project, "k", "x".repeat(40_000), ["A"], { caseSensitive: false })).toThrow(/BUDGET/);
    const preview = prepareCaptionTextReplacementV1(project, "k", "K", ["A"], { caseSensitive: false });
    expect(preview.changes[0].after).toBe("K".repeat(32));
  });

  it("does not add Undo for a case-fold match whose actual text is already the replacement", () => {
    const project = source("CLOUD CODE");
    const preview = prepareCaptionTextReplacementV1(project, "cloud code", "CLOUD CODE", ["A"], { caseSensitive: false });
    expect(preview.status).toBe("UNCHANGED");
    expect(currentCaptionTextReplacementCommandV1(project, preview)).toBeUndefined();
  });

  it("rejects an invalid mode and still refuses empty resulting cues and locked tracks", () => {
    const project = source();
    expect(() => findCaptionTextV1(project, "Cloud", 0, 200, undefined, { caseSensitive: "false" as unknown as boolean })).toThrow(/CASE_MODE/);
    expect(() => prepareCaptionTextReplacementV1(source("ABC"), "abc", "", ["A"], { caseSensitive: false })).toThrow(/EMPTY_CUE/);
    project.tracks.push({ id: "captions", kind: "caption", name: "Captions", locked: true, muted: false, clips: [] });
    expect(() => prepareCaptionTextReplacementV1(project, "cloud", "Claude", undefined, { caseSensitive: false })).toThrow(/鎖定/);
  });
});

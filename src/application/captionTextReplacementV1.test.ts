import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { currentCaptionTextReplacementCommandV1, findCaptionTextV1, prepareCaptionTextReplacementV1 } from "./captionTextReplacementV1";

function source() {
  const project = createEmptyProject("Literal captions", { id: "literal-captions", fps: 30 });
  project.captions = [
    { id: "A", text: "Cloud Code 😃，Cloud Code", start: 0, duration: 2, translation: { text: "Original translation", language: "en" } },
    { id: "B", text: "Cloud Code 和 cloud code", start: 2, duration: 2 },
    { id: "C", text: "完整的字幕，時間保持一致", start: 4, duration: 2 },
  ];
  return validateProject(project);
}
describe("literal caption search/replacement and the real history path", () => {
  it("reports per-cue literal counts and paged original text without altering the project", () => {
    const project = source(), before = structuredClone(project);
    const page = findCaptionTextV1(project, "Cloud Code", 0, 1);
    expect(page.matchingCues).toBe(2); expect(page.totalOccurrences).toBe(3); expect(page.nextOffset).toBe(1);
    expect(page.matches[0]).toMatchObject({ captionId: "A", occurrences: 2, firstOffset: 0, start: 0, duration: 2 });
    expect(findCaptionTextV1(project, "Cloud Code", 1, 1).matches[0].captionId).toBe("B");
    expect(findCaptionTextV1(project, "cloud code").totalOccurrences).toBe(1); expect(project).toEqual(before);
  });
  it("applies all original-caption changes in one real batch/Undo, preserving clock and translation", () => {
    const project = source(), before = structuredClone(project);
    const preview = prepareCaptionTextReplacementV1(project, "Cloud Code", "Claude Code");
    const command = currentCaptionTextReplacementCommandV1(project, preview)!;
    const changed = dispatchCommand(createHistory(project), command, "replace-all");
    expect(changed.past).toHaveLength(1); expect(changed.journal).toHaveLength(1);
    expect(changed.present.captions.map(cue => cue.text)).toEqual(["Claude Code 😃，Claude Code", "Claude Code 和 cloud code", before.captions[2].text]);
    expect(changed.present.captions.map(({ text: _text, ...rest }) => rest)).toEqual(before.captions.map(({ text: _text, ...rest }) => rest));
    expect(undo(changed).present.captions).toEqual(before.captions); expect(project).toEqual(before);
  });
  it("keeps emoji and dollar replacement syntax literal, and supports explicit cue selection", () => {
    const project = source();
    const preview = prepareCaptionTextReplacementV1(project, "😃", "$&$$$1\\folder", ["A"]);
    const changed = dispatchCommand(createHistory(project), currentCaptionTextReplacementCommandV1(project, preview)!);
    expect(changed.present.captions[0].text).toBe("Cloud Code $&$$$1\\folder，Cloud Code");
    expect(changed.present.captions[1]).toEqual(project.captions[1]);
    expect(findCaptionTextV1(project, "Code", 0, 200, ["B"]).matchingCues).toBe(1);
  });
  it("requires a new preview after new generation, in-place content/translation/lock/revision or preview changes", () => {
    const project = source(), preview = prepareCaptionTextReplacementV1(project, "Cloud", "Claude");
    expect(() => currentCaptionTextReplacementCommandV1(structuredClone(project), preview)).toThrow(/STALE_OR_FOREIGN/);
    expect(() => currentCaptionTextReplacementCommandV1(project, structuredClone(preview))).toThrow(/STALE_OR_FOREIGN/);
    for (const mutate of [(p: typeof project) => p.captions[0].text += "!", (p: typeof project) => p.captions[0].translation!.text += "!",
      (p: typeof project) => p.revision++, (p: typeof project) => p.tracks.push({ id: "caption-lock", kind: "caption", name: "Captions", locked: true, muted: false, clips: [] })]) {
      const current = source(), prepared = prepareCaptionTextReplacementV1(current, "Cloud", "Claude"); mutate(current);
      expect(() => currentCaptionTextReplacementCommandV1(current, prepared)).toThrow(/STALE_OR_FOREIGN/);
    }
    preview.changes[0].after = "Tampered";
    expect(() => currentCaptionTextReplacementCommandV1(project, preview)).toThrow(/STALE_OR_FOREIGN/);
  });
  it("does not create a command/Undo when unchanged, and refuses locks, empty cues and growth before mutation", () => {
    const project = source(), before = structuredClone(project);
    expect(currentCaptionTextReplacementCommandV1(project, prepareCaptionTextReplacementV1(project, "missing", "new"))).toBeUndefined();
    expect(currentCaptionTextReplacementCommandV1(project, prepareCaptionTextReplacementV1(project, "Cloud", "Cloud"))).toBeUndefined();
    expect(() => prepareCaptionTextReplacementV1(project, project.captions[2].text, "")).toThrow(/EMPTY_CUE/);
    expect(() => prepareCaptionTextReplacementV1(project, "o", "x".repeat(1024 * 1024))).toThrow(/BUDGET/);
    expect(project).toEqual(before);
    project.tracks.push({ id: "caption-lock", kind: "caption", name: "Captions", locked: true, muted: false, clips: [] });
    expect(findCaptionTextV1(project, "Cloud").matchingCues).toBe(2);
    expect(() => prepareCaptionTextReplacementV1(project, "Cloud", "Claude")).toThrow(/鎖定/);
  });
  it("rejects empty/control/lone-surrogate queries, malformed selections and invalid page bounds", () => {
    const project = source();
    for (const query of ["", "\0", "\ud800", "\udc00"]) expect(() => findCaptionTextV1(project, query)).toThrow(/LITERAL_INPUT/);
    expect(() => prepareCaptionTextReplacementV1(project, "Cloud", "\ud800")).toThrow(/LITERAL_INPUT/);
    for (const ids of [[], ["missing"], ["A", "A"]]) expect(() => findCaptionTextV1(project, "Cloud", 0, 200, ids)).toThrow(/SELECTION/);
    for (const [offset, limit] of [[-1, 1], [0, 201], [0, 0], [.5, 1]]) expect(() => findCaptionTextV1(project, "Cloud", offset, limit)).toThrow(/PAGE/);
    expect(findCaptionTextV1(project, ".*").matchingCues).toBe(0);
  });
});

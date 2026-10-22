import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StickerSheenPanelV1, type StickerSheenPanelPropsV1, type StickerSheenLabelsV1 } from "./StickerSheenPanelV1";
import { rotoProjectFixture } from "../application/__fixtures__/rotoCutoutProject.fixture";
import { createProjectSession } from "../application/projectSession";
const labelKeys = ["title", "sticker", "sheen", "cancel", "idle", "applying", "done", "clean_hold", "cancelled", "failed", "uncertain", "unavailable", "locked", "selectClip", "unsupported", "styleUnavailable", "rangeRequired", "progress", "help", "artPending"];
const labels = Object.fromEntries(labelKeys.map(k => [k, "label-" + k])) as unknown as StickerSheenLabelsV1;
function fixture(): StickerSheenPanelPropsV1 {
  const project = rotoProjectFixture(); project.width = 320; project.height = 200; project.fps = 24;
  return { project, projectSession: createProjectSession(project), clipId: "selected", ids: { assetId: "a", clipId: "c", trackId: "t", linkGroupId: "l", assetName: "Subject", trackName: "Subject" },
    range: { startFrame: 55, endFrame: 73 }, labels, onApply: async () => ({ status: "cancelled" }), styles: {
      sticker: { schema: "editkin.subject-sticker-style/v1", borderPixels: 0, shadowSigma: 0, shadowOpacity: 0, shadowOffsetX: 0, shadowOffsetY: 0, popStartFrame: 0, popFrames: 12, popStartScale: 1, popOvershoot: 0, anchorX: .5, anchorY: .5 },
      sheen: { schema: "editkin.subject-sheen-style/v1", angleDegrees: 35, bandWidthRatio: .28, intensity: .7 } } };
}
const disabled = (html: string, id: string) => /\bdisabled(?:="")?(?=\s|>)/u.test(html.match(new RegExp(`<button\\b[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "");
describe("StickerSheenPanelV1 source component controls", () => {
  it("renders two manual actions with explicit host styles, status and art-pending copy", () => {
    const html = renderToStaticMarkup(<StickerSheenPanelV1 {...fixture()} />); expect(disabled(html, "subject-sticker-add")).toBe(false); expect(disabled(html, "subject-sheen-add")).toBe(false);
    expect(html).toContain('role="status"'); expect(html).toContain(labels.artPending); expect(html).toContain(labels.help); expect(html).not.toContain("subject-overlay-cancel");
  });
  it.each(["locked", "hidden", "missing-backend", "missing-style", "disabled", "missing-clip", "retime"])("disables %s instead of authoring", mode => {
    const p = fixture(); if (mode === "locked") p.project.tracks[0].locked = true; if (mode === "hidden") p.project.tracks[0].hidden = true;
    if (mode === "missing-backend") p.onApply = undefined; if (mode === "missing-style") p.styles = undefined; if (mode === "disabled") p.disabled = true;
    if (mode === "missing-clip") p.clipId = "absent"; if (mode === "retime") p.project.tracks[0].clips[0].speed = 2;
    const html = renderToStaticMarkup(<StickerSheenPanelV1 {...p} />); expect(disabled(html, "subject-sticker-add")).toBe(true); expect(disabled(html, "subject-sheen-add")).toBe(true);
  });
  it.each([[47, 60], [55, 57], [55, 79], [55.5, 73]])("refuses sheen range %s..%s while retaining the full-clip sticker action", (startFrame, endFrame) => {
    const p = fixture(); p.range = { startFrame, endFrame }; const html = renderToStaticMarkup(<StickerSheenPanelV1 {...p} />);
    expect(disabled(html, "subject-sticker-add")).toBe(false); expect(disabled(html, "subject-sheen-add")).toBe(true); expect(html).toContain(labels.rangeRequired);
  });
  it("does not narrow supported sheen when hiding the original sticker would require dependent rebinding", () => {
    const p = fixture(), original = p.project.tracks[0].clips[0]; p.project.tracks[0].clips.push({ ...structuredClone(original), id: "child", timelineStart: 4, masks: [], layer: { enabled: true, blendMode: "normal", parentClipId: original.id } });
    const html = renderToStaticMarkup(<StickerSheenPanelV1 {...p} />); expect(disabled(html, "subject-sticker-add")).toBe(true); expect(disabled(html, "subject-sheen-add")).toBe(false);
  });
});

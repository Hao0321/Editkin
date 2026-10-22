import { describe, expect, it } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { planBehindSubjectV1, type BehindSubjectIdsV1 } from "./behindSubjectRecipeV1";
import type { SubjectMatteMediaV1 } from "./subjectMatteDerivative";

// Instrument-only metadata. No encoded file, segmentation quality or art approval is asserted.
const SOURCE_SHA = "a".repeat(64);
function fixture(): EditProject {
  const p = createEmptyProject("Behind subject instrument", { id: "behind-subject", width: 1080, height: 1920, fps: 30 });
  p.assets = [{ id: "walk", name: "Walk", kind: "video", uri: "D:/control/walk.mov", duration: 5.6, width: 1920, height: 1080, displayAspectRatio: 1080 / 1920,
    derivatives: { sourceSha256: SOURCE_SHA, generatedAt: "2026-10-22T00:00:00Z" }, license: "creator_owned", rightsBasis: "creator_owned" }];
  p.tracks[0].clips = [{ id: "footage", assetId: "walk", trackId: "video-main", timelineStart: 1, sourceStart: 0.5, duration: 4, volume: 0.8,
    transform: { ...DEFAULT_TRANSFORM, x: 12, scale: 1.1 }, color: { ...DEFAULT_COLOR, contrast: 1.1 }, keyframes: [] }];
  p.tracks.push({ id: "logo", name: "Logo", kind: "video", locked: false, muted: true, hidden: false, clips: [] });
  return validateProject(p);
}
function matte(overrides: Partial<SubjectMatteMediaV1> = {}): SubjectMatteMediaV1 {
  return { schema: "editkin.subject-matte-derivative/v1", sourceSha256: SOURCE_SHA, matteUri: "D:/cache/subject-matte-v1/aaa/matte.mkv", matteSha256: "b".repeat(64), matteBytes: 1000,
    receiptUri: "D:/cache/subject-matte-v1/aaa/receipt.json", width: 1080, height: 1920, frames: 168, frameRateNumerator: 30, frameRateDenominator: 1,
    matteFormat: "alpha8", pixelFormat: "bgra", trackMatteMode: "alpha", models: [{ id: "mediapipe-selfie-segmentation-general-256x256", sha256: "c".repeat(64), licence: "Apache-2.0" }],
    licence: "Apache-2.0", qualityState: "diagnostic", generatedAt: "2026-10-22T00:00:00Z", ...overrides };
}
const ids: BehindSubjectIdsV1 = { matteAssetId: "matte-asset", matteClipId: "matte-clip", matteTrackId: "matte-track", foregroundClipId: "fg-clip",
  foregroundTrackId: "fg-track", textTrackId: "text-track", linkGroupId: "behind-link" };
const videoOrder = (p: EditProject) => p.tracks.filter(t => t.kind === "video").map(t => t.id);

describe("behind-subject recipe v1 (existing track matte route)", () => {
  it("stacks matte < footage < text < foreground in one Undo and keeps the original untouched", () => {
    const before = fixture(), untouched = structuredClone(before);
    const plan = planBehindSubjectV1(before, { footageClipId: "footage", matte: matte(), ids });
    expect(before).toEqual(untouched);
    expect(plan.createdTextTrack).toBe(true);
    const history = dispatchCommand(createHistory(before), plan.command, "behind-subject");
    expect(history.past).toHaveLength(1);
    const after = history.present;
    // The pre-existing logo track stays above the subject.
    expect(videoOrder(after)).toEqual(["matte-track", "video-main", "text-track", "fg-track", "logo"]);
    const clip = (id: string) => after.tracks.flatMap(t => t.clips).find(c => c.id === id)!;
    const footage = clip("footage"), matteClip = clip("matte-clip"), fg = clip("fg-clip");
    expect(footage.volume).toBe(0.8);
    expect(fg).toMatchObject({ volume: 0, sourceStart: 0.5, timelineStart: 1, duration: 4, assetId: "walk", color: footage.color, transform: footage.transform });
    expect(fg.layer?.trackMatte).toEqual({ sourceClipId: "matte-clip", mode: "alpha" });
    expect(matteClip).toMatchObject({ volume: 0, sourceStart: 0.5, timelineStart: 1, duration: 4, assetId: "matte-asset", transform: footage.transform, color: DEFAULT_COLOR });
    expect(new Set([footage.linkGroupId, matteClip.linkGroupId, fg.linkGroupId])).toEqual(new Set(["behind-link"]));
    expect(after.assets.find(a => a.id === "matte-asset")).toMatchObject({ alphaMode: "straight", width: 1080, height: 1920, rightsBasis: "creator_owned" });
    // The FFV1 matte has no SAR; a stored aspect would make export refuse the asset.
    expect(after.assets.find(a => a.id === "matte-asset")).not.toHaveProperty("displayAspectRatio");
    expect(after.tracks.find(t => t.id === "text-track")!.clips).toEqual([]);
    expect(undo(history).present).toEqual(before);
    expect(redo(undo(history)).present).toEqual(after);
    const reopened = decodeProjectBytes(encodeProjectBytes(after));
    expect(reopened).toEqual(parseProject(after));
    expect(reopened.tracks).toEqual(after.tracks);
  });

  it("puts the foreground directly above the highest named text track", () => {
    const p = fixture();
    p.tracks.push({ id: "words", name: "Words", kind: "video", locked: false, muted: true, hidden: false, clips: [] },
      { id: "caption-card", name: "Card", kind: "video", locked: false, muted: true, hidden: false, clips: [] });
    const plan = planBehindSubjectV1(p, { footageClipId: "footage", matte: matte(), ids: { ...ids, textTrackId: undefined }, textTrackIds: ["words"] });
    const after = dispatchCommand(createHistory(p), plan.command).present;
    expect(videoOrder(after)).toEqual(["matte-track", "video-main", "logo", "words", "fg-track", "caption-card"]);
    expect(plan.createdTextTrack).toBe(false);
  });

  it("uses a luma track matte for a grey matte and an opaque matte asset", () => {
    const p = fixture();
    const plan = planBehindSubjectV1(p, { footageClipId: "footage", matte: matte({ matteFormat: "gray", pixelFormat: "gray", trackMatteMode: "luma" }), ids });
    const after = dispatchCommand(createHistory(p), plan.command).present;
    expect(after.tracks.flatMap(t => t.clips).find(c => c.id === "fg-clip")!.layer?.trackMatte?.mode).toBe("luma");
    expect(after.assets.find(a => a.id === "matte-asset")!.alphaMode).toBe("opaque");
  });

  it.each([
    ["source sha", (p: EditProject) => { p.assets[0].derivatives!.sourceSha256 = "f".repeat(64); }, {}],
    ["no source sha", (p: EditProject) => { delete p.assets[0].derivatives; }, {}],
    ["size", () => undefined, { width: 720, height: 1280 }],
    ["duration", () => undefined, { frames: 90 }],
    ["licence", () => undefined, { licence: "GPL-3.0" as unknown as "Apache-2.0" }],
    ["format/mode", () => undefined, { trackMatteMode: "luma" as const }],
    ["opacity key", (p: EditProject) => { p.tracks[0].clips[0].keyframes = [{ id: "k", time: 0, transform: { ...DEFAULT_TRANSFORM, opacity: 0.5 }, color: { ...DEFAULT_COLOR }, easing: "linear" }]; }, {}],
    ["locked footage", (p: EditProject) => { p.tracks[0].locked = true; }, {}],
    ["locked upper track", (p: EditProject) => { p.tracks.find(t => t.id === "logo")!.locked = true; }, {}],
    ["speed", (p: EditProject) => { p.tracks[0].clips[0].speed = 2; }, {}],
    ["aces", (p: EditProject) => { p.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" }; }, {}],
  ])("refuses %s without changing the project", (_name, mutate, matteOverrides) => {
    const p = fixture(); mutate(p); const unchanged = structuredClone(p);
    expect(() => planBehindSubjectV1(p, { footageClipId: "footage", matte: matte(matteOverrides), ids })).toThrow(/BEHIND_SUBJECT_/);
    expect(p).toEqual(unchanged);
  });

  it("refuses a text track below the footage and ids already in use", () => {
    const p = fixture();
    p.tracks.splice(0, 0, { id: "under", name: "Under", kind: "video", locked: false, muted: true, hidden: false, clips: [] });
    expect(() => planBehindSubjectV1(validateProject(p), { footageClipId: "footage", matte: matte(), ids: { ...ids, textTrackId: undefined }, textTrackIds: ["under"] })).toThrow("BEHIND_SUBJECT_TEXT_TRACK_BELOW_FOOTAGE");
    expect(() => planBehindSubjectV1(fixture(), { footageClipId: "footage", matte: matte(), ids: { ...ids, matteTrackId: "logo" } })).toThrow("BEHIND_SUBJECT_ID_ALREADY_USED");
  });
});

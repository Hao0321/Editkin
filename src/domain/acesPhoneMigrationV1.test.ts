import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createEmptyProject, migrateProject } from "./editGraph";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM, type TimelineClip } from "./types";
import { projectSchema, editorCommandSchema } from "./schema";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { createPhoneProjectV1 } from "../application/phoneProjectV1";
import { usesAcesClipDisplayInverseV1, withAcesPhonePolicyV1 } from "../color/acesPhoneInputV1";

function fixture(fresh = false) {
  const project = fresh ? createPhoneProjectV1("Phone") : createEmptyProject("Legacy");
  project.colorManagement = { ...project.colorManagement!, mode: "aces2" };
  project.assets = [{ id: "phone", name: "phone.mp4", uri: "phone.mp4", kind: "video", duration: 3, width: 1920, height: 1080, color: { interpretation: "auto", transfer: "bt709", primaries: "bt709", matrix: "bt709", range: "tv" } }];
  const a: TimelineClip = { id: "a", assetId: "phone", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 1, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
  project.tracks[0].clips = [a, { ...structuredClone(a), id: "b", timelineStart: 1, gradeV2: { schema: "editkin.color-grade/v2" } }];
  return project;
}
describe("saved phone and legacy ACES recipes", () => {
  it("pins the historic mixed ungraded/graded interpretation without mutating input, pixels, or shared asset metadata", () => {
    const input = fixture(), before = JSON.stringify(input), migrated = migrateProject(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(migrated.colorManagement?.rec709DisplayPolicy).toBe("legacy-grade-v2");
    expect(migrated.assets).toEqual(input.assets);
    input.tracks[0].clips.forEach((clip, i) => {
      for (const [key, value] of Object.entries(clip)) expect((migrated.tracks[0].clips[i] as unknown as Record<string, unknown>)[key]).toEqual(value);
    });
    expect(usesAcesClipDisplayInverseV1("rec709", migrated.colorManagement!, migrated.tracks[0].clips[0])).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", migrated.colorManagement!, migrated.tracks[0].clips[1])).toBe(true);
    expect(migrateProject(migrated)).toEqual(migrated);
  });
  it("pins every previously supported project version, including inherited composition management", () => {
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const p = fixture();
      const migrated = migrateProject({ ...p, schemaVersion, compositions: [{ colorManagement: { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" }, tracks: [] }] });
      expect(migrated.colorManagement?.rec709DisplayPolicy).toBe("legacy-grade-v2");
      expect(migrated.compositions[0].colorManagement?.rec709DisplayPolicy).toBe("legacy-grade-v2");
    }
  });
  it("preserves fresh and camera choices through schema, migration, and literal save/reopen", () => {
    const p = applyCommand(fixture(true), { type: "set_clip_rec709_input", clipId: "a", interpretation: "camera" });
    const decoded = decodeProjectBytes(encodeProjectBytes(p));
    expect(decoded.colorManagement?.rec709DisplayPolicy).toBe("phone-bt1886");
    expect(decoded.tracks[0].clips[0].rec709Input).toBe("camera");
    expect(decoded.tracks[0].clips[1].rec709Input).toBeUndefined();
    expect(decoded.assets).toEqual(p.assets);
    expect(usesAcesClipDisplayInverseV1("rec709", decoded.colorManagement!, decoded.tracks[0].clips[0])).toBe(false);
    expect(usesAcesClipDisplayInverseV1("rec709", decoded.colorManagement!, decoded.tracks[0].clips[1])).toBe(true);
    expect(encodeProjectBytes(decoded)).toEqual(encodeProjectBytes(p));
  });
  it("lets one shared-asset clip choose camera and return to display without changing its neighbor", () => {
    const p = fixture(true), camera = applyCommand(p, { type: "set_clip_rec709_input", clipId: "a", interpretation: "camera" });
    expect(p.tracks[0].clips[0].rec709Input).toBeUndefined();
    expect(camera.assets).toEqual(p.assets);
    expect(camera.tracks[0].clips[1]).toEqual(p.tracks[0].clips[1]);
    const display = applyCommand(camera, { type: "set_clip_rec709_input", clipId: "a", interpretation: "display" });
    expect(usesAcesClipDisplayInverseV1("rec709", display.colorManagement!, display.tracks[0].clips[0])).toBe(true);
  });
  it("refuses per-clip camera/display changes in legacy, quick, HDR, and actual Log inputs", () => {
    expect(() => applyCommand(fixture(), { type: "set_clip_rec709_input", clipId: "a", interpretation: "camera" })).toThrow(/phone BT.1886/);
    const quick = fixture(true); quick.colorManagement!.mode = "rec709";
    const hdr = fixture(true); hdr.assets[0].color!.interpretation = "hlg";
    const log = fixture(true); log.assets[0].color!.interpretation = "apple_log";
    for (const p of [quick, hdr, log]) expect(() => applyCommand(p, { type: "set_clip_rec709_input", clipId: "a", interpretation: "camera" })).toThrow(/phone BT.1886/);
  });
  it("keeps old quick Rec.709 management exact across migration and literal save/reopen, while preserving an explicit fresh recipe", () => {
    const old = createEmptyProject("Old quick"), before = structuredClone(old.colorManagement);
    expect(migrateProject(old).colorManagement).toStrictEqual(before);
    const bytes = encodeProjectBytes(old), reopened = decodeProjectBytes(bytes);
    expect(reopened.colorManagement).toStrictEqual(before);
    expect(Object.hasOwn(reopened.colorManagement!, "rec709DisplayPolicy")).toBe(false);
    expect(encodeProjectBytes(reopened)).toEqual(bytes);
    const fresh = decodeProjectBytes(encodeProjectBytes(createPhoneProjectV1("Fresh quick")));
    expect(fresh.colorManagement?.mode).toBe("rec709");
    expect(fresh.colorManagement?.rec709DisplayPolicy).toBe("phone-bt1886");
  });
  it("pins only old ACES owners in a mixed quick root/composition project without changing its input", () => {
    const quick = { ...DEFAULT_COLOR_MANAGEMENT }, aces = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" as const };
    const input = { ...createEmptyProject("Mixed"), compositions: [{ colorManagement: quick, tracks: [] }, { colorManagement: aces, tracks: [] }] };
    const before = structuredClone(input), migrated = migrateProject(input);
    expect(input).toStrictEqual(before);
    expect(migrated.colorManagement).toStrictEqual(quick);
    expect(migrated.compositions[0].colorManagement).toStrictEqual(quick);
    expect(migrated.compositions[1].colorManagement).toStrictEqual({ ...aces, rec709DisplayPolicy: "legacy-grade-v2" });
  });
  it("rejects malformed policies and choices instead of stripping them into a different picture", () => {
    const p = fixture();
    expect(projectSchema.safeParse({ ...p, colorManagement: { ...p.colorManagement, rec709DisplayPolicy: "guess" } }).success).toBe(false);
    expect(projectSchema.safeParse({ ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], rec709Input: "guess" }] }, ...p.tracks.slice(1)] }).success).toBe(false);
    expect(editorCommandSchema.safeParse({ type: "set_clip_rec709_input", clipId: "a", interpretation: "camera", unknown: true }).success).toBe(false);
    expect(migrateProject({ ...p, colorManagement: withAcesPhonePolicyV1(p.colorManagement!) }).colorManagement?.rec709DisplayPolicy).toBe("phone-bt1886");
  });
});

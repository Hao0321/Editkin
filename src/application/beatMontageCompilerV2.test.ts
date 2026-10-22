import { describe, expect, it } from "vitest";
import { compileBeatAlignedMontageV2, beatMontageClockV2, type BeatMontageRequestV2 } from "./beatMontageCompilerV2";
import { createEmptyProject, migrateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { editorCommandSchema } from "../domain/schema";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { buildRenderPlan } from "../render/planner";

function fixture() {
  const project = createEmptyProject("energy montage", { id: "energy-test", fps: 30 });
  project.assets = Array.from({ length: 70 }, (_, i) => ({ id: `shot-${i}`, name: `shot ${i}`, kind: "video" as const, uri: `shot-${i}.mp4`, duration: 12 }));
  project.assets.push({ id: "music", name: "owned music", kind: "audio", uri: "music.wav", duration: 90 });
  const request: BeatMontageRequestV2 = { targetTrackId: "video-main", idPrefix: "v2", beats: [0, .5, 1, 1.5, 2, 2.5, 3].map((timeSeconds, i) => ({ timeSeconds, energy: [0, .1, .5, .95, .5, 0, 0][i], downbeat: i === 0 || i === 4 })),
    pace: { lowThreshold: .3, highThreshold: .8 }, candidates: project.assets.filter(a => a.kind === "video").map((a, i) => ({ shotId: a.id, assetId: a.id, sourceStart: 0, sourceEnd: 12, focusTime: 6, storyOrder: i, salience: i / 70 })),
    music: { assetId: "music", trackId: "audio-main", clipId: "v2-music", sourceStart: 1, sourceSha256: "a".repeat(64), rightsEvidenceRefs: ["owned-author-license.json"] } };
  return { project, request };
}
describe("new energy flat montage compiler", () => {
  it("compiles two/one/halfbeat cuts, unique story-ordered evidence and only licensed draft music audio", () => {
    const { project, request } = fixture(), before = JSON.stringify(project), result = compileBeatAlignedMontageV2(project, request);
    expect(result.clock.slots.map(s => s.beatSpan)).toEqual([2, 1, .5, .5, 1, 1]);
    expect(result.clock.boundaries.every(b => Math.abs(b.quantizationErrorFrames) <= .5 + 1e-9)).toBe(true);
    expect(result.clock.boundaries.map(b => b.frame)).toEqual([0, 30, 45, 53, 60, 75, 90]);
    expect(new Set(result.selections.map(s => s.shotId)).size).toBe(6);
    expect(result.selections.map(s => s.storyOrder)).toEqual([64, 65, 66, 67, 68, 69]);
    expect(result.commands.every(c => c.type !== "batch")).toBe(true);
    for (const command of result.commands) expect(() => editorCommandSchema.parse(command)).not.toThrow();
    const updated = applyCommand(project, { type: "batch", commands: result.commands });
    const reopened = migrateProject(JSON.parse(JSON.stringify(updated))), plan = buildRenderPlan(reopened, uri => uri);
    expect(reopened.tracks[0].clips.map(c => c.volume)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(plan.audioClips.map(c => c.clip.assetId)).toEqual(["music"]);
    expect(plan.duration).toBe(3); expect(result.audioHitHooks.map(h => h.frame)).toEqual([0, 60]);
    expect(result.music).toMatchObject({ sourceStart: 1, duration: 3 });
    expect(result).toMatchObject({ defaultEnabled: false, directApplyAllowed: false, qualityState: "ART_PENDING_CLAUDE", certificationPerformed: false });
    expect(JSON.stringify(project)).toBe(before);
  });
  it("explicit paired dissolve commands use true source handles and survive save/reopen", () => {
    const { project, request } = fixture(); request.pairs = { kernel: "dissolve", beforeFrames: 2, afterFrames: 2, cutIndices: [1, 3] };
    const result = compileBeatAlignedMontageV2(project, request), updated = applyCommand(project, { type: "batch", commands: result.commands });
    expect(result.commands.filter(c => c.type === "set_timeline_transition")).toHaveLength(2);
    expect(migrateProject(JSON.parse(JSON.stringify(updated))).timelineTransitions).toEqual(result.pairs);
  });
  it("transition frames cannot borrow content beyond the closed shot evidence", () => {
    const { project, request } = fixture(); request.candidates = request.candidates.map(c => ({ ...c, sourceStart: 2, sourceEnd: 3, focusTime: undefined }));
    request.pairs = { kernel: "dip", beforeFrames: 2, afterFrames: 2, cutIndices: [1] };
    expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("OUTSIDE_SHOT_EVIDENCE");
  });
  it("authored flashes are bounded in every sliding one-second interval; disabled emits no flash", () => {
    const { project, request } = fixture(); request.beats = Array.from({ length: 6 }, (_, i) => ({ timeSeconds: i * .5, energy: 1, downbeat: i === 0 }));
    request.flashes = { cutIndices: [1, 2, 3], durationFrames: 2 };
    expect(compileBeatAlignedMontageV2(project, request).flashEvents).toHaveLength(3);
    request.flashes.cutIndices = [1, 2, 3, 4]; expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("FLASH_RATE");
    delete request.flashes; expect(compileBeatAlignedMontageV2(project, request).commands.some(c => c.type === "set_clip_creative")).toBe(false);
  });
  it("duplicate/absent cuts and overlapping flash or pair windows fail closed", () => {
    const { project, request } = fixture(); request.flashes = { cutIndices: [1, 1], durationFrames: 1 };
    expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("CUT_INDEX");
    request.flashes = { cutIndices: [6], durationFrames: 1 }; expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("CUT_INDEX");
    request.flashes = { cutIndices: [3], durationFrames: 15 }; expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("FLASH_WINDOW");
    delete request.flashes; request.pairs = { kernel: "dip", beforeFrames: 10, afterFrames: 10, cutIndices: [3, 4] };
    expect(() => compileBeatAlignedMontageV2(project, request)).toThrow(/WINDOW_(?:OVERLAP|EXCEEDS)/);
  });
  it("requires music rights/source window, distinct ids and unlocked unoccupied tracks", () => {
    const { project, request } = fixture(); const before = JSON.stringify(project);
    expect(() => compileBeatAlignedMontageV2(project, { ...request, music: { ...request.music, rightsEvidenceRefs: [] } })).toThrow();
    expect(() => compileBeatAlignedMontageV2(project, { ...request, music: { ...request.music, sourceStart: 89 } })).toThrow("MUSIC_SOURCE");
    expect(() => compileBeatAlignedMontageV2(project, { ...request, music: { ...request.music, clipId: "v2-1" } })).toThrow("CLIP_ID");
    project.tracks[1].locked = true; expect(() => compileBeatAlignedMontageV2(project, request)).toThrow(TRACK_LOCKED_MESSAGE);
    project.tracks[1].locked = false; const compiled = compileBeatAlignedMontageV2(project, request); const occupied = applyCommand(project, { type: "batch", commands: compiled.commands });
    expect(() => compileBeatAlignedMontageV2(occupied, { ...request, targetTrackId: "video-main", idPrefix: "different" })).toThrow("MUSIC_TRACK_OCCUPIED");
    expect(JSON.stringify(project)).toBe(before);
  });
  it("rejects impossible halfbeat grid, invalid energy, non-increasing beats and off-grid source evidence", () => {
    const { project, request } = fixture();
    expect(() => beatMontageClockV2({ ...request, beats: [{ timeSeconds: 0, energy: 1, downbeat: false }, { timeSeconds: 1 / 30, energy: 0, downbeat: false }] }, 30)).toThrow("SUBDIVISION");
    expect(() => beatMontageClockV2({ ...request, beats: request.beats.map(b => ({ ...b, energy: NaN })) }, 30)).toThrow();
    expect(() => compileBeatAlignedMontageV2(project, { ...request, beats: [...request.beats].reverse() })).toThrow("INCREASING");
    expect(() => compileBeatAlignedMontageV2(project, { ...request, candidates: request.candidates.map(c => ({ ...c, sourceStart: .01 })) })).toThrow("NOT_ON_FRAME_GRID");
    expect(() => beatMontageClockV2({ ...request, pace: { lowThreshold: .8, highThreshold: .2 } }, 30)).toThrow("PACE");
  });
  it("refuses slot and flat-command overflow rather than truncating or quietly dropping effects", () => {
    const { project, request } = fixture(); const beats = Array.from({ length: 66 }, (_, i) => ({ timeSeconds: i * .5, energy: .5, downbeat: false }));
    expect(() => compileBeatAlignedMontageV2(project, { ...request, beats })).toThrow("SLOT_LIMIT");
    const sixty = beats.slice(0, 61); const pairs = { kernel: "dissolve" as const, beforeFrames: 1, afterFrames: 1, cutIndices: Array.from({ length: 59 }, (_, i) => i + 1) };
    expect(() => compileBeatAlignedMontageV2(project, { ...request, beats: sixty, pairs })).toThrow("FLAT_COMMAND_LIMIT");
  });
  it("different shot and asset ids cannot conceal repeated windows of the same media URI", () => {
    const { project, request } = fixture(); project.assets[69].uri = project.assets[68].uri;
    expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("REPEATED_SOURCE_WINDOW");
  });
  it("does not mute or unknowingly mix unrelated existing audible clips", () => {
    const { project, request } = fixture(), drafted = compileBeatAlignedMontageV2(project, request);
    const add = drafted.commands.find(c => c.type === "add_clip")!; if (add.type !== "add_clip") throw Error("Fixture missing clip");
    project.tracks.push({ id: "other-video", name: "other", kind: "video", locked: false, muted: false, clips: [{ ...add.clip, id: "other-clip", trackId: "other-video", volume: 1 }] });
    const before = JSON.stringify(project); expect(() => compileBeatAlignedMontageV2(project, request)).toThrow("OTHER_AUDIO_OVERLAP"); expect(JSON.stringify(project)).toBe(before);
  });
});

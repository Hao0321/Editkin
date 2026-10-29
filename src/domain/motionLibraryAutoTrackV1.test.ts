import { describe, expect, it } from "vitest";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { applyCommand, type EditorCommand } from "./commands";
import { createHistory, dispatchCommand, undo, type EditorHistory } from "./history";
import { MOTION_LIBRARY_AUTO_TRACKS_V1 } from "./motionLibraryCommandsV1";
import { MotionLibraryRefusalV1 } from "./motionLibraryFieldsV1";
import { fixtureClipField, motionLibraryFixtureProject, plainClip } from "./motionLibraryV1.fixture";
import { editorCommandSchema } from "./schema";
import type { EditProject, TimelineClip } from "./types";

/**
 * autoTrack placement (Phase 3 follow-up): several Motion Library clips prepared against one saved project compose in one
 * plan. Each command finds its own track when it runs: the first Motion Library track of its kind where it fits, else a
 * new one with the next deterministic id, created inside the same command (one Undo).
 */
const TEXT = MOTION_LIBRARY_AUTO_TRACKS_V1.text.base, BACKGROUND = MOTION_LIBRARY_AUTO_TRACKS_V1.background.base;

/** A text (or background) clip `[start, start + seconds)` with its own render, placed by the command. */
function placed(project: EditProject, clipId: string, start: number, seconds: number, itemId = "T01"): EditorCommand {
  const kind = itemId.startsWith("B") ? "background" : "text";
  const { field, asset, frameCount } = fixtureClipField(project, itemId, kind === "text" ? { lines: [clipId], durationSeconds: seconds } : { durationSeconds: seconds });
  const clip: TimelineClip = { ...plainClip(clipId, asset.id, MOTION_LIBRARY_AUTO_TRACKS_V1[kind].base, start, 0, frameCount / project.fps), motionLibrary: field };
  return { type: "add_motion_library_clip", asset, clip, autoTrack: true };
}
const trackOf = (project: EditProject, clipId: string) => project.tracks.find(track => track.clips.some(clip => clip.id === clipId))?.id;
const trackIds = (project: EditProject) => project.tracks.map(track => track.id);
/** Content only: revision and updatedAt count commands and stamp the clock. */
const content = (project: EditProject) => ({ tracks: project.tracks, assets: project.assets });
const roundTrip = (project: EditProject) => {
  const reopened = decodeProjectBytes(encodeProjectBytes(project));
  expect(encodeProjectBytes(reopened)).toEqual(encodeProjectBytes(project));
  return reopened;
};
const code = (action: () => unknown) => {
  try { action(); return "ADMITTED"; } catch (error) { return error instanceof MotionLibraryRefusalV1 ? error.code : (error as Error).message; }
};

describe("Motion Library autoTrack placement", () => {
  it.each([2, 3, 5])("puts %i non-overlapping text effects of one plan on one track, survives save/reopen, one Undo each", count => {
    const base = motionLibraryFixtureProject();
    const commands = Array.from({ length: count }, (_, index) => placed(base, `title-${index}`, index * 1.2, 1));
    // One plan: every command was prepared against the same saved project and is applied together.
    const project = applyCommand(base, { type: "batch", commands });
    expect(trackIds(project)).toEqual([...trackIds(base), TEXT]);
    expect(project.tracks.at(-1)!.clips.map(clip => clip.id)).toEqual(commands.map((_, index) => `title-${index}`));
    expect(roundTrip(project).tracks.at(-1)).toEqual(project.tracks.at(-1));
    // The same commands dispatched one by one: each is one history entry, and one Undo removes exactly one clip
    // (and the track, with the command that created it).
    let history: EditorHistory = createHistory(base);
    for (const [index, command] of commands.entries()) history = dispatchCommand(history, command, `title-${index}`);
    expect(history.past).toHaveLength(count);
    expect(content(history.present)).toEqual(content(project));
    for (let left = count - 1; left >= 0; left -= 1) {
      history = undo(history);
      expect(history.present.tracks.find(track => track.id === TEXT)?.clips.length ?? 0).toBe(left);
    }
    expect(trackIds(history.present)).toEqual(trackIds(base));
  });

  it("gives overlapping text effects separate tracks with deterministic ids, reusing the first track that fits", () => {
    const base = motionLibraryFixtureProject();
    // a 0–2, b 1–3 (overlaps a), c 1.5–2.5 (overlaps a and b), d 2–3 (fits after a), e 3–4 (fits after a, d and b)
    const plan = [placed(base, "a-title", 0, 2), placed(base, "b-title", 1, 2), placed(base, "c-title", 1.5, 1), placed(base, "d-title", 2, 1), placed(base, "e-title", 3, 1)];
    const project = applyCommand(base, { type: "batch", commands: plan });
    expect(Object.fromEntries(["a-title", "b-title", "c-title", "d-title", "e-title"].map(id => [id, trackOf(project, id)]))).toEqual({
      "a-title": TEXT, "b-title": `${TEXT}-2`, "c-title": `${TEXT}-3`, "d-title": TEXT, "e-title": TEXT });
    expect(project.tracks.filter(track => track.id.startsWith(TEXT)).map(track => [track.id, track.name])).toEqual([
      [TEXT, "動態文字"], [`${TEXT}-2`, "動態文字 2"], [`${TEXT}-3`, "動態文字 3"]]);
    // The same plan applied again from the same base gives the same project (deterministic).
    expect(content(applyCommand(base, { type: "batch", commands: structuredClone(plan) }))).toEqual(content(project));
    roundTrip(project);
    // One Undo per command, in a plan dispatched one by one: the third Undo removes c-title and the track it created.
    let history: EditorHistory = createHistory(base);
    for (const command of plan) history = dispatchCommand(history, command, "plan");
    history = undo(undo(history));
    expect(trackIds(history.present)).toContain(`${TEXT}-3`);
    history = undo(history);
    expect(trackIds(history.present)).not.toContain(`${TEXT}-3`);
    expect(trackOf(history.present, "b-title")).toBe(`${TEXT}-2`);
  });

  it("skips a locked or hidden Motion Library track and a track id taken by something else", () => {
    let base = motionLibraryFixtureProject();
    base = applyCommand(base, { type: "add_track", track: { id: TEXT, name: "動態文字", kind: "video", locked: true, muted: false, clips: [] } });
    base = applyCommand(base, { type: "add_track", track: { id: `${TEXT}-2`, name: "動態文字 2", kind: "video", locked: false, muted: false, hidden: true, clips: [] } });
    base = applyCommand(base, { type: "add_track", track: { id: `${TEXT}-3`, name: "Audio", kind: "audio", locked: false, muted: false, clips: [] } });
    const project = applyCommand(base, placed(base, "title", 0, 1));
    expect(trackOf(project, "title")).toBe(`${TEXT}-4`);
    // An explicit, existing track still works as before (no autoTrack).
    const explicit = placed(base, "pinned", 0, 1) as Extract<EditorCommand, { type: "add_motion_library_clip" }>;
    expect(trackOf(applyCommand(base, { ...explicit, autoTrack: undefined, clip: { ...explicit.clip, trackId: "overlay" } }), "pinned")).toBe("overlay");
  });

  it("puts backgrounds on their own tracks beneath the picture stack", () => {
    const base = motionLibraryFixtureProject();
    const project = applyCommand(base, { type: "batch", commands: [placed(base, "bg-1", 0, 2, "B01"), placed(base, "bg-2", 1, 2, "B01"), placed(base, "bg-3", 3, 2, "B01")] });
    expect(trackIds(project)).toEqual([`${BACKGROUND}-2`, BACKGROUND, ...trackIds(base)]);
    expect([trackOf(project, "bg-1"), trackOf(project, "bg-2"), trackOf(project, "bg-3")]).toEqual([BACKGROUND, `${BACKGROUND}-2`, BACKGROUND]);
    roundTrip(project);
  });

  it("refuses a wrong base id and leaves no track behind when a placed command is refused", () => {
    const base = motionLibraryFixtureProject();
    const command = placed(base, "title", 0, 1) as Extract<EditorCommand, { type: "add_motion_library_clip" }>;
    expect(code(() => applyCommand(base, { ...command, clip: { ...command.clip, trackId: "overlay" } }))).toBe("MOTION_LIBRARY_TRACK_INVALID");
    expect(code(() => applyCommand(base, { ...command, clip: { ...command.clip, trackId: BACKGROUND } }))).toBe("MOTION_LIBRARY_TRACK_INVALID");
    // A duplicate clip id is refused before any track is created, and applyCommand never changes its input.
    const duplicate = { ...command, clip: { ...command.clip, id: "a" } };
    expect(code(() => applyCommand(base, duplicate))).toMatch(/重複片段 id/);
    expect(trackIds(base)).not.toContain(TEXT);
    // The shared command schema accepts autoTrack: true only.
    expect(editorCommandSchema.safeParse(command).success).toBe(true);
    expect(editorCommandSchema.safeParse({ ...command, autoTrack: false }).success).toBe(false);
  });
});

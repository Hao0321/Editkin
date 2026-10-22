import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { activeVideoClip, createEmptyProject, migrateProject, validateProject } from "./editGraph";
import { createHistory, dispatchCommandSafely } from "./history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "./types";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "../application/projectCodec";
import { activeMediaLayers } from "../application/previewMedia";
import { planTimelineClipMove } from "../application/timelinePlacement";
import { buildRenderPlan } from "../render/planner";

// 「靜音」 is sound only and 「隱藏畫面」 is picture only. A project saved before the split (where 靜音 on a picture track
// turned off both) is migrated on load so it plays and renders exactly as before.
function clip(id: string, trackId: string, assetId: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] };
}
function project(overlay: Partial<EditProject["tracks"][number]> = {}): EditProject {
  const value = createEmptyProject("Visibility", { id: "visibility", width: 1280, height: 720, fps: 30 });
  value.assets = [
    { id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 10, width: 1280, height: 720 },
    { id: "over", name: "over.mp4", kind: "video", uri: "D:/owned/over.mp4", duration: 10, width: 1280, height: 720 },
  ];
  value.tracks[0].clips = [clip("main", "video-main", "cam", 0, 6)];
  value.tracks.push({ id: "v2", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [clip("over", "v2", "over", 1, 3)], ...overlay });
  return value;
}
/** The saved JSON of a project from before the split: schema 9, `muted` only, no `hidden` anywhere. */
function savedBeforeSplit(): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(project({ muted: true }))) as Record<string, unknown>;
  const composition = { schema: "editkin.composition/v1", id: "comp", name: "Comp", width: 1280, height: 720, fps: 30, duration: 2,
    tracks: [{ id: "c-v", name: "內層畫面", kind: "video", locked: false, muted: true, clips: [clip("c-clip", "c-v", "cam", 0, 2)] },
      { id: "c-a", name: "內層聲音", kind: "audio", locked: false, muted: true, clips: [] }],
    captions: [], captionStyle: (value as { captionStyle: unknown }).captionStyle, motionTracks: [], motionGraphics: [],
    director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt: "2026-10-01T00:00:00.000Z" },
    updatedAt: "2026-10-01T00:00:00.000Z" };
  value.compositions = [composition];
  return value;
}
const paths = (value: EditProject) => buildRenderPlan(value, uri => uri);

describe("loading a project saved before the split keeps it looking and sounding the same", () => {
  it("a muted picture track becomes muted and hidden; sound tracks, unmuted tracks and nested tracks follow the same rule", () => {
    const raw = savedBeforeSplit();
    const migrated = migrateProject(structuredClone(raw));
    expect(migrated.tracks.find(track => track.id === "v2")).toMatchObject({ muted: true, hidden: true });
    expect(migrated.tracks.find(track => track.id === "video-main")!.hidden).toBeUndefined();
    expect(migrated.compositions[0].tracks.map(track => [track.id, track.muted, track.hidden])).toEqual([["c-v", true, true], ["c-a", true, undefined]]);
    // The real load path (desktop files, browser files, MCP readProject): parseProject keeps the field through the schema.
    const parsed = parseProject(structuredClone(raw));
    expect(parsed.tracks.find(track => track.id === "v2")).toMatchObject({ muted: true, hidden: true });
    expect(decodeProjectBytes(encodeProjectBytes(parsed)).tracks.find(track => track.id === "v2")).toMatchObject({ muted: true, hidden: true });
  });

  it("renders the old project exactly as before: the muted picture track adds no picture and no sound", () => {
    const old = parseProject(savedBeforeSplit());
    const bare = project();
    bare.tracks = bare.tracks.filter(track => track.id !== "v2");
    const withoutTrack = parseProject(JSON.parse(JSON.stringify(bare)));
    expect(paths(old).videoLayers.map(layer => layer.trackId)).toEqual(paths(withoutTrack).videoLayers.map(layer => layer.trackId));
    expect(paths(old).audioClips.map(item => item.clip.id)).toEqual(["main"]);
    expect(activeVideoClip(old, 2)?.id).toBe("main");
    expect(activeMediaLayers(old, 2, {}, "video").map(layer => layer.clip.id)).toEqual(["main"]);
  });

  it("an explicit hidden: false is never overwritten (a muted track that still shows its picture)", () => {
    const raw = JSON.parse(JSON.stringify(project({ muted: true, hidden: false })));
    expect(parseProject(raw).tracks.find(track => track.id === "v2")).toMatchObject({ muted: true, hidden: false });
  });
});

describe("mute is sound only; hide is picture only", () => {
  it("toggling mute on a picture track keeps its picture (and says so in the saved form), in preview and export", () => {
    const muted = applyCommand(validateProject(project()), { type: "toggle_track_mute", trackId: "v2" });
    expect(muted.tracks.find(track => track.id === "v2")).toMatchObject({ muted: true, hidden: false });
    expect(paths(muted).videoLayers.map(layer => layer.trackId)).toEqual(["video-main", "v2"]);
    expect(paths(muted).audioClips.map(item => item.clip.id)).toEqual(["main"]);
    expect(activeVideoClip(muted, 2)?.id).toBe("over");
    const layers = activeMediaLayers(muted, 2, {}, "video");
    expect(layers.map(layer => [layer.clip.id, layer.silent ?? false])).toEqual([["main", false], ["over", true]]);
    // Saved and reopened, it is not mistaken for the old form.
    const reopened = decodeProjectBytes(encodeProjectBytes(muted));
    expect(reopened.tracks.find(track => track.id === "v2")).toMatchObject({ muted: true, hidden: false });
    expect(paths(reopened).videoLayers.map(layer => layer.trackId)).toEqual(["video-main", "v2"]);
  });

  it("hiding a picture track removes its picture only; its sound still plays", () => {
    const hidden = applyCommand(validateProject(project()), { type: "toggle_track_hidden", trackId: "v2" });
    expect(hidden.tracks.find(track => track.id === "v2")).toMatchObject({ muted: false, hidden: true });
    expect(paths(hidden).videoLayers.map(layer => layer.trackId)).toEqual(["video-main"]);
    expect(paths(hidden).audioClips.map(item => item.clip.id)).toEqual(["main", "over"]);
    expect(activeVideoClip(hidden, 2)?.id).toBe("main");
    expect(activeMediaLayers(hidden, 2, {}, "video").map(layer => layer.clip.id)).toEqual(["main"]);
    // The media-element preview (browser, and the desktop at other speeds) hears it too: a sound-only layer.
    expect(activeMediaLayers(hidden, 2, {}, "audio").map(layer => [layer.clip.id, layer.silent ?? false])).toEqual([["over", false]]);
    const both = applyCommand(hidden, { type: "toggle_track_mute", trackId: "v2" });
    expect(activeMediaLayers(both, 2, {}, "audio")).toEqual([]);
    expect(paths(both).audioClips.map(item => item.clip.id)).toEqual(["main"]);
    const shown = applyCommand(hidden, { type: "toggle_track_hidden", trackId: "v2" });
    expect(shown.tracks.find(track => track.id === "v2")!.hidden).toBe(false);
    expect(activeMediaLayers(shown, 2, {}, "audio")).toEqual([]);
  });

  it("a hidden precomposition keeps the sound of the picture clips inside it, and still shows none of them", () => {
    const value = project();
    const composition = { schema: "editkin.composition/v1", id: "comp", name: "Comp", width: 1280, height: 720, fps: 30, duration: 2,
      tracks: [{ id: "c-v", name: "內層畫面", kind: "video", locked: false, muted: false, clips: [clip("c-clip", "c-v", "cam", 0, 2)] }],
      captions: [], captionStyle: value.captionStyle, motionTracks: [], motionGraphics: [],
      director: { schema: "editkin.director-console/v1", reviewState: "draft", markers: [], updatedAt: "2026-10-01T00:00:00.000Z" },
      updatedAt: "2026-10-01T00:00:00.000Z" } as unknown as EditProject["compositions"][number];
    value.compositions = [composition];
    value.assets.push({ id: "comp-asset", name: "Comp", kind: "video", uri: "editkin-composition://comp", duration: 2, width: 1280, height: 720, compositionId: "comp" });
    value.tracks.find(track => track.id === "v2")!.clips = [clip("pre", "v2", "comp-asset", 1, 2)];
    const visible = value, hidden = { ...value, tracks: value.tracks.map(track => track.id === "v2" ? { ...track, hidden: true } : track) };
    expect(activeMediaLayers(visible, 2, {}, "video").map(layer => layer.clip.id)).toEqual(["main", "comp/c-clip"]);
    expect(activeMediaLayers(visible, 2, {}, "audio")).toEqual([]);
    expect(activeMediaLayers(hidden, 2, {}, "video").map(layer => layer.clip.id)).toEqual(["main"]);
    expect(activeMediaLayers(hidden, 2, {}, "audio").map(layer => layer.clip.id)).toEqual(["comp/c-clip"]);
  });

  it("a picture track added muted (an agent's add_track) keeps its picture, also after saving and reopening", () => {
    const added = applyCommand(validateProject(project()), { type: "add_track", track: { id: "v3", name: "畫面軌 3", kind: "video", locked: false, muted: true, clips: [] } });
    expect(added.tracks.at(-1)).toMatchObject({ muted: true, hidden: false });
    expect(decodeProjectBytes(encodeProjectBytes(added)).tracks.at(-1)).toMatchObject({ muted: true, hidden: false });
    const sound = applyCommand(validateProject(project()), { type: "add_track", track: { id: "a2", name: "聲音 2", kind: "audio", locked: false, muted: true, clips: [] } });
    expect(sound.tracks.at(-1)!.hidden).toBeUndefined();
  });

  it("only picture tracks can hide their picture", () => {
    expect(dispatchCommandSafely(createHistory(validateProject(project())), { type: "toggle_track_hidden", trackId: "audio-main" }).error)
      .toBe("只有畫面軌可以隱藏畫面。");
  });

  it("a layer made by a collision sounds and shows like the track it came from", () => {
    const value = project({ muted: true, hidden: true });
    value.tracks[1].clips = [clip("voice", "audio-main", "cam", 0, 2)];
    value.tracks.find(track => track.id === "v2")!.clips.push(clip("late", "v2", "cam", 6, 2));
    const valid = validateProject(value);
    const planned = planTimelineClipMove(valid, "late", "v2", 1.5, () => "v2-layer");
    expect(planned.newLayer).toBe(true);
    expect(applyCommand(valid, planned.command).tracks.at(-1)).toMatchObject({ id: "v2-layer", muted: true, hidden: true });
  });
});

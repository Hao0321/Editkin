import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { activeVideoClip, createEmptyProject, findClip, validateProject } from "../domain/editGraph";
import { createHistory, dispatchCommand, redo, undo } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { parseProject, readProjectFile, writeProjectFileAtomic } from "./projectFiles";
import { planTimelineAssetInsert, planTimelineClipMove, timelineAssetDuration } from "./timelinePlacement";

function clip(id: string, assetId: string, trackId: string, timelineStart: number, duration: number, sourceStart = 0): TimelineClip {
  return {
    id, assetId, trackId, timelineStart, duration, sourceStart, volume: .6,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER }, expressions: {},
  };
}

function fixture(fps = 30): EditProject {
  const project = parseProject(createEmptyProject("Owned timeline placement", { id: "placement-project", width: 640, height: 360, fps }));
  project.assets = [
    { id: "video", name: "Owned video", kind: "video", uri: "owned-video.mp4", duration: 20 },
    { id: "audio", name: "Owned audio", kind: "audio", uri: "owned-audio.wav", duration: 30 },
    { id: "short", name: "Measured short video", kind: "video", uri: "measured-short.mp4", duration: 2.017 },
    { id: "image", name: "Owned illustration", kind: "image", uri: "owned-illustration.png", duration: 5 },
  ];
  project.tracks[0].clips = [clip("left", "video", "video-main", 0, 2), clip("right", "video", "video-main", 4, 2)];
  project.tracks[1].clips = [clip("sound", "audio", "audio-main", 0, 10, 2)];
  project.tracks.push({ id: "video-source", name: "Another visual layer", kind: "video", locked: false, muted: false, clips: [clip("moving", "video", "video-source", 8, 1, 3)] });
  return validateProject(project);
}

describe("atomic timeline placement on the live EditGraph", () => {
  it("moves a colliding clip to the top compatible layer with one Undo and untouched neighbours/audio", () => {
    const project = fixture(), before = structuredClone(project), initial = createHistory(project);
    const planned = planTimelineClipMove(project, "moving", "video-main", 1, () => "new-visual");
    expect(planned).toMatchObject({ trackId: "new-visual", newLayer: true, command: { type: "batch" } });
    expect(planned.command.type === "batch" && planned.command.commands.map(command => command.type)).toEqual(["add_track", "move_clip_to_track"]);
    const edited = dispatchCommand(initial, planned.command, "owned-drag");
    expect(edited.past).toHaveLength(1);
    expect(edited.journal).toHaveLength(1);
    expect(findClip(edited.present, "moving")).toEqual({ ...findClip(before, "moving"), trackId: "new-visual", timelineStart: 1 });
    expect(edited.present.tracks.at(-1)).toMatchObject({ id: "new-visual", kind: "video", locked: false, muted: false });
    expect(activeVideoClip(edited.present, 1)?.id).toBe("moving");
    expect(edited.present.tracks[0]).toEqual(before.tracks[0]);
    expect(edited.present.tracks[1]).toEqual(before.tracks[1]);
    expect(project).toEqual(before);
    expect(undo(edited).present).toEqual(before);
    expect(redo(undo(edited)).present).toEqual(edited.present);
  });

  it("ignores the moved clip itself and treats touching half-open edges as free", () => {
    const project = fixture(), makeId = vi.fn(() => "unused");
    const planned = planTimelineClipMove(project, "left", "video-main", 2, makeId);
    expect(planned.newLayer).toBe(false);
    expect(makeId).not.toHaveBeenCalled();
    const result = applyCommand(project, planned.command);
    expect(findClip(result, "left").timelineStart).toBe(2);
    expect(findClip(result, "right")).toEqual(findClip(project, "right"));
    expect(result.tracks).toHaveLength(project.tracks.length);
    const same = planTimelineClipMove(project, "left", "video-main", 1 / 30, makeId);
    expect(same.newLayer).toBe(false);
    expect(findClip(applyCommand(project, same.command), "left").timelineStart).toBe(1 / 30);
  });

  it("keeps a free cross-track move on the requested track at the requested rounded frame", () => {
    const project = fixture(), makeId = vi.fn(() => "unused");
    const planned = planTimelineClipMove(project, "moving", "video-main", 2.017, makeId);
    expect(planned).toMatchObject({ trackId: "video-main", newLayer: false });
    const result = applyCommand(project, planned.command);
    expect(findClip(result, "moving").timelineStart).toBe(61 / 30);
    expect(findClip(result, "moving").sourceStart).toBe(3);
    expect(result.tracks.find(track => track.id === "video-source")?.clips).toEqual([]);
    expect(makeId).not.toHaveBeenCalled();
  });

  it("adds an audio collision layer preserving target mute without moving the existing sound or video", () => {
    const project = fixture();
    project.tracks[1].muted = true;
    project.tracks.push({ id: "audio-source", name: "Second sound", kind: "audio", locked: false, muted: false, clips: [clip("voice", "audio", "audio-source", 12, 2, 4)] });
    const planned = planTimelineClipMove(project, "voice", "audio-main", 3, () => "new-audio");
    const edited = dispatchCommand(createHistory(project), planned.command);
    expect(edited.present.tracks.at(-1)).toMatchObject({ id: "new-audio", kind: "audio", locked: false, muted: true });
    expect(findClip(edited.present, "voice")).toMatchObject({ timelineStart: 3, sourceStart: 4, duration: 2 });
    expect(edited.present.tracks[0]).toEqual(project.tracks[0]);
    expect(edited.present.tracks[1]).toEqual(project.tracks[1]);
    expect(undo(edited).present).toEqual(project);
  });

  it("inserts 2.017 seconds at 30 FPS as 60 usable frames, atomically, rather than exceeding the source", () => {
    const project = fixture(), before = structuredClone(project);
    const planned = planTimelineAssetInsert(project, "short", "video-main", 1.017, "inserted", () => "insert-layer");
    const history = dispatchCommand(createHistory(project), planned.command);
    const added = findClip(history.present, "inserted");
    expect(added).toMatchObject({ timelineStart: 31 / 30, duration: 60 / 30, sourceStart: 0, trackId: "insert-layer" });
    expect(added.duration).toBeLessThanOrEqual(project.assets.find(asset => asset.id === "short")!.duration);
    expect(history.present.tracks[0]).toEqual(before.tracks[0]);
    expect(history.present.tracks[1]).toEqual(before.tracks[1]);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toEqual(before);
  });

  it("keeps 30000/1001 FPS source flooring and a literal integer placement frame through real apply", () => {
    const fps = 30_000 / 1_001, project = fixture(fps), frame = 307;
    const planned = planTimelineAssetInsert(project, "short", "video-main", frame / fps, "fractional", () => "unused");
    expect(planned.newLayer).toBe(false);
    const result = applyCommand(project, planned.command), added = findClip(result, "fractional");
    expect(added.timelineStart).toBe(frame / fps);
    expect(added.duration).toBe(60 / fps);
    expect(added.duration * fps).toBeCloseTo(60, 12);
    expect(added.duration).toBeLessThanOrEqual(2.017);
    expect(result.tracks[1]).toEqual(project.tracks[1]);
  });

  it("limits image placement to three source-bounded seconds without borrowing extra source time", () => {
    const project = fixture();
    const added = findClip(applyCommand(project, planTimelineAssetInsert(project, "image", "video-main", 7, "still", () => "unused").command), "still");
    expect(added.duration).toBe(3);
    project.assets.find(asset => asset.id === "image")!.duration = 1.017;
    expect(timelineAssetDuration(project.assets.find(asset => asset.id === "image")!, project.fps)).toBe(1);
    const shorter = findClip(applyCommand(project, planTimelineAssetInsert(project, "image", "video-main", 7, "short-still", () => "unused").command), "short-still");
    expect(shorter.duration).toBe(1);
  });

  it("rejects less than one usable source frame rather than inventing a one-frame clip", () => {
    const project = fixture();
    project.assets.find(asset => asset.id === "short")!.duration = .02;
    expect(timelineAssetDuration(project.assets.find(asset => asset.id === "short")!, project.fps)).toBe(0);
    expect(() => planTimelineAssetInsert(project, "short", "video-main", 1, "too-short", () => "unused")).toThrow(/不足一個/);
  });

  it("rejects a locked source or target without creating a replacement layer", () => {
    const project = fixture(), makeId = vi.fn(() => "forbidden");
    project.tracks.find(track => track.id === "video-source")!.locked = true;
    expect(() => planTimelineClipMove(project, "moving", "video-main", 1, makeId)).toThrow(/鎖定/);
    project.tracks.find(track => track.id === "video-source")!.locked = false;
    project.tracks[0].locked = true;
    expect(() => planTimelineClipMove(project, "moving", "video-main", 1, makeId)).toThrow(/鎖定/);
    expect(() => planTimelineAssetInsert(project, "short", "video-main", 1, "locked", makeId)).toThrow(/鎖定/);
    expect(makeId).not.toHaveBeenCalled();
  });

  it("rejects cross-kind UI targets and caption tracks while retaining ordinary audio insertion", () => {
    const project = fixture(), makeId = vi.fn(() => "audio-layer");
    expect(() => planTimelineClipMove(project, "moving", "audio-main", 1, makeId)).toThrow(/相同類型/);
    expect(() => planTimelineClipMove(project, "moving", "caption-main", 1, makeId)).toThrow(/畫面或聲音/);
    for (const [assetId, trackId] of [["video", "audio-main"], ["image", "audio-main"], ["audio", "video-main"]]) {
      expect(() => planTimelineAssetInsert(project, assetId, trackId, 1, "wrong-kind", makeId)).toThrow(/種類不同/);
    }
    expect(() => planTimelineAssetInsert(project, "image", "caption-main", 1, "wrong-caption", makeId)).toThrow(/畫面或聲音/);
    expect(makeId).not.toHaveBeenCalled();
    const good = planTimelineAssetInsert(project, "audio", "audio-main", 0, "music", makeId);
    expect(applyCommand(project, good.command).tracks.at(-1)?.kind).toBe("audio");
  });

  it("rejects invalid/outside clocks before alignment and never consumes a new-track ID", () => {
    const project = fixture(), makeId = vi.fn(() => "unused");
    for (const start of [-.001, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => planTimelineClipMove(project, "moving", "video-main", start, makeId)).toThrow(/有效影格/);
      expect(() => planTimelineAssetInsert(project, "short", "video-main", start, "outside", makeId)).toThrow(/有效影格/);
    }
    expect(makeId).not.toHaveBeenCalled();
  });

  it("revalidates live source existence, source bounds, neighbours and finite project clocks", () => {
    const original = fixture(), makeId = vi.fn(() => "unused");
    expect(() => planTimelineAssetInsert(original, "absent", "video-main", 1, "missing", makeId)).toThrow(/找不到素材/);
    expect(() => planTimelineClipMove(original, "absent", "video-main", 1, makeId)).toThrow(/找不到片段/);
    expect(() => planTimelineClipMove(original, "moving", "deleted-track", 1, makeId)).toThrow(/找不到軌道/);
    const missing = structuredClone(original); missing.assets = missing.assets.filter(asset => asset.id !== "video");
    expect(() => planTimelineClipMove(missing, "moving", "video-main", 1, makeId)).toThrow(/找不到素材/);
    const outside = structuredClone(original); findClip(outside, "moving").sourceStart = 19.5;
    expect(() => planTimelineClipMove(outside, "moving", "video-main", 1, makeId)).toThrow(/超過素材/);
    const overlap = structuredClone(original); findClip(overlap, "right").timelineStart = 1;
    expect(() => planTimelineAssetInsert(overlap, "short", "video-main", 7, "stale", makeId)).toThrow(/重疊/);
    const invalid = structuredClone(original); invalid.fps = NaN;
    expect(() => planTimelineClipMove(invalid, "moving", "video-main", 1, makeId)).toThrow(/fps/);
    const badSource = structuredClone(original); badSource.assets.find(asset => asset.id === "short")!.duration = Infinity;
    expect(() => planTimelineAssetInsert(badSource, "short", "video-main", 1, "nonfinite", makeId)).toThrow(/有效影格/);
    expect(makeId).not.toHaveBeenCalled();
  });

  it("rejects duplicate clip or generated track IDs and preserves the original graph on failure", () => {
    const project = fixture(), before = structuredClone(project);
    expect(() => planTimelineAssetInsert(project, "short", "video-main", 1, "left", () => "unused")).toThrow(/id.*存在/);
    expect(() => planTimelineClipMove(project, "moving", "video-main", 1, () => "video-main")).toThrow(/id.*存在/);
    expect(() => planTimelineAssetInsert(project, "short", "video-main", 1, "new", () => " ")).toThrow(/id 空白/);
    expect(project).toEqual(before);
  });

  it("atomically imports then places a real catalog asset with the same planner command and one Undo", () => {
    const project = fixture(), asset = { id: "imported", name: "Measured import", kind: "video" as const, uri: "imported.mp4", duration: 2.017 };
    const staged = applyCommand(project, { type: "import_asset", asset });
    const planned = planTimelineAssetInsert(staged, asset.id, "video-main", 1, "imported-clip", () => "imported-layer");
    const history = dispatchCommand(createHistory(project), { type: "batch", commands: [{ type: "import_asset", asset }, planned.command] });
    expect(history.past).toHaveLength(1);
    expect(findClip(history.present, "imported-clip")).toMatchObject({ timelineStart: 1, duration: 2, trackId: "imported-layer" });
    expect(history.present.tracks[0]).toEqual(project.tracks[0]);
    expect(history.present.tracks[1]).toEqual(project.tracks[1]);
    expect(undo(history).present).toEqual(project);
  });

  it("persists the actual new layer, source trim and fractional-FPS frame through parse, save and reopen", async () => {
    const project = fixture(30_000 / 1_001), frame = 31;
    const planned = planTimelineClipMove(project, "moving", "video-main", frame / project.fps, () => "saved-layer");
    const applied = applyCommand(project, planned.command), parsed = parseProject(JSON.parse(JSON.stringify(applied)));
    expect(findClip(parsed, "moving")).toMatchObject({ trackId: "saved-layer", timelineStart: frame / project.fps, sourceStart: 3, duration: 1 });
    const root = await mkdtemp(join(tmpdir(), "editkin-timeline-placement-"));
    try {
      const path = join(root, "owned.editkin.json"), saved = await writeProjectFileAtomic(path, parsed, 0, { createOnly: true });
      const reopened = await readProjectFile(path);
      expect(reopened).toEqual(saved);
      expect(reopened.tracks).toEqual(parsed.tracks);
      expect(findClip(reopened, "moving").timelineStart).toBe(frame / project.fps);
      expect(reopened.assets).toEqual(project.assets);
      expect(reopened.tracks[1]).toEqual(project.tracks[1]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

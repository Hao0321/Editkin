import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { LongformPlanSetRefusal, type LongformChapterRangeV1 } from "./longformPlanSetV1";
import { assertNoLongformOwnerProofsV1, mergeLongformPlanSetV1, type LongformMergeChapterV1 } from "./longformPlanSetMergeV1";
import { MOTION_LIBRARY_AUTO_TRACKS_V1 } from "../domain/motionLibraryCommandsV1";
import { fixtureClipField } from "../domain/motionLibraryV1.fixture";

// Two chapters on a 30 fps base: ch-1 is 0–5 s, ch-2 is 5–10 s.
const RANGES: LongformChapterRangeV1[] = [{ startFrame: 0, endFrame: 150 }, { startFrame: 150, endFrame: 300 }];
const AESTHETIC = createAutopilotV4Fixture().commands[0] as unknown as EditorCommand;

function clip(id: string, assetId: string, trackId: string, timelineStart: number, duration: number, extra: Partial<TimelineClip> = {}): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], ...extra };
}
const caption = (id: string, start: number, duration = 1, text = id): EditorCommand => ({ type: "add_caption", caption: { id, text, start, duration } });
const marker = (id: string, time: number): EditorCommand => ({ type: "add_director_marker", marker: { id, time, title: id, note: "", kind: "beat", status: "open", createdAt: "2026-10-15T00:00:00.000Z" } });
const broll = (uri = "broll.png"): EditorCommand => ({ type: "import_asset", asset: { id: "broll", name: "B-roll", kind: "video", uri, duration: 30 } });

function baseProject(extra: EditorCommand[] = []): EditProject {
  return applyCommand(createEmptyProject("Merge base", { id: "project-merge", width: 640, height: 360, fps: 30 }), { type: "batch", commands: [
    { type: "import_asset", asset: { id: "aroll", name: "A-roll", kind: "video", uri: "aroll.mp4", duration: 30 } },
    { type: "add_track", track: { id: "overlay", name: "Overlay", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: clip("base-1", "aroll", "video-main", 0, 5) },
    { type: "add_clip", clip: clip("base-2", "aroll", "video-main", 5, 5) },
    ...extra,
  ] });
}

function chapters(base: EditProject, batches: EditorCommand[][], ranges: LongformChapterRangeV1[] = RANGES): LongformMergeChapterV1[] {
  return batches.map((commands, index) => ({ chapterId: `ch-${index + 1}`, range: ranges[index], commands,
    candidate: applyCommand(base, { type: "batch", commands: structuredClone(commands) }) }));
}

function refusal(run: () => unknown): LongformPlanSetRefusal {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(LongformPlanSetRefusal);
    return error as LongformPlanSetRefusal;
  }
  throw new Error("expected a refusal");
}

describe("long-form plan set merge (E3)", () => {
  it("folds two disjoint chapters into one project and reports each footprint", () => {
    const base = baseProject();
    const first = [AESTHETIC, { type: "rename_project", name: "Long-form set" } as EditorCommand, marker("chapter-1", 0), caption("c1", 1), caption("c1b", 3),
      { type: "set_clip_color", clipId: "base-1", patch: { saturation: 1.1 } } as EditorCommand];
    const second = [AESTHETIC, marker("chapter-2", 5), caption("c2", 6), broll(),
      { type: "add_clip", clip: clip("broll-1", "broll", "overlay", 6, 2) } as EditorCommand];
    const result = mergeLongformPlanSetV1(base, chapters(base, [first, second]));
    expect(result.merged.captions.map(item => item.id)).toEqual(["c1", "c1b", "c2"]);
    expect(result.merged.director.markers.map(item => item.id)).toEqual(["chapter-1", "chapter-2"]);
    expect(result.merged.name).toBe("Long-form set");
    expect(result.merged.tracks.find(track => track.id === "overlay")?.clips.map(item => item.id)).toEqual(["broll-1"]);
    expect(result.merged.tracks[0].clips.find(item => item.id === "base-1")?.color.saturation).toBe(1.1);
    expect(result.chapters).toEqual([
      { chapterId: "ch-1", footprint: { created: 4, changed: 2, removed: 0, projectWide: ["global:aestheticSystem", "global:name"], restated: [] } },
      { chapterId: "ch-2", footprint: { created: 5, changed: 0, removed: 0, projectWide: ["global:aestheticSystem"], restated: ["global:aestheticSystem"] } },
    ]);
    expect(result.summary).toMatchObject({ chapterCount: 2, captions: 3, markers: 2, assets: 2, clips: 3 });
    // The merge is exactly the fold, and the base is untouched.
    const folded = applyCommand(applyCommand(base, { type: "batch", commands: structuredClone(first) }), { type: "batch", commands: structuredClone(second) });
    expect({ ...result.merged, updatedAt: "", director: { ...result.merged.director, updatedAt: "" } }).toEqual({ ...folded, updatedAt: "", director: { ...folded.director, updatedAt: "" } });
    expect(base.captions).toEqual([]);
  });

  it("lets two chapters import the same new asset byte for byte, once", () => {
    const base = baseProject();
    const result = mergeLongformPlanSetV1(base, chapters(base, [[broll(), caption("c1", 1)], [broll(), caption("c2", 6)]]));
    expect(result.merged.assets.filter(asset => asset.id === "broll")).toHaveLength(1);
  });

  it("refuses the same new asset with a different record", () => {
    const base = baseProject();
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[broll("a.png")], [broll("b.png")]])));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_ASSET_RECORD_CONFLICT", [{ key: "asset:broll", chapterIds: ["ch-1", "ch-2"] }]]);
  });

  it("refuses a duplicate new entity id across chapters", () => {
    const base = baseProject();
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("same", 1)], [caption("same", 6)]])));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_DUPLICATE_ENTITY_ID", [{ key: "caption:same", chapterIds: ["ch-1", "ch-2"] }]]);
  });

  it("refuses overlapping footprints (the backstop behind ordered, disjoint set ranges)", () => {
    const base = baseProject();
    const whole = [{ startFrame: 0, endFrame: 300 }, { startFrame: 0, endFrame: 300 }];
    const color = (saturation: number): EditorCommand => ({ type: "set_clip_color", clipId: "base-1", patch: { saturation } });
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[color(1.1)], [color(1.2)]], whole)));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_FOOTPRINT_OVERLAP", [{ key: "clip:base-1", chapterIds: ["ch-1", "ch-2"] }]]);
  });

  it("refuses an entity whose before or after interval leaves its chapter", () => {
    const base = baseProject([{ type: "add_clip", clip: clip("spanning", "aroll", "overlay", 0, 10) }]);
    const late = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("late", 4.5)], [caption("c2", 6)]])));
    expect([late.code, late.conflicts]).toEqual(["LONGFORM_SET_ENTITY_OUTSIDE_RANGE", [{ key: "caption:late", chapterIds: ["ch-1"] }]]);
    const wide = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [{ type: "set_clip_color", clipId: "spanning", patch: { contrast: 1.2 } }]])));
    expect(wide.conflicts).toEqual([{ key: "clip:spanning", chapterIds: ["ch-2"] }]);
    const moved = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[{ type: "move_clip", clipId: "base-1", timelineStart: 12 }], [caption("c2", 6)]])));
    expect(moved.code).toBe("LONGFORM_SET_ENTITY_OUTSIDE_RANGE");
    const boundaryMarker = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[marker("edge", 5)], [caption("c2", 6)]])));
    expect(boundaryMarker.conflicts).toEqual([{ key: "marker:edge", chapterIds: ["ch-1"] }]);
  });

  it("lets only the first chapter set project-wide state, and later chapters only restate it", () => {
    const base = baseProject();
    const style = (fontSize: number): EditorCommand => ({ type: "set_caption_style", patch: { fontSize } });
    const repeated = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[style(40)], [style(48)]])));
    expect([repeated.code, repeated.conflicts]).toEqual(["LONGFORM_SET_GLOBAL_SETTER_REPEATED", [{ key: "global:captionStyle", chapterIds: ["ch-1", "ch-2"] }]]);
    const notFirst = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [style(48)]])));
    expect([notFirst.code, notFirst.conflicts]).toEqual(["LONGFORM_SET_GLOBAL_SETTER_NOT_FIRST", [{ key: "global:captionStyle", chapterIds: ["ch-2"] }]]);
    const track = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [{ type: "toggle_track_mute", trackId: "overlay" }]])));
    expect(track.conflicts).toEqual([{ key: "track:overlay", chapterIds: ["ch-2"] }]);
    const restated = mergeLongformPlanSetV1(base, chapters(base, [[style(40), caption("c1", 1)], [style(40), caption("c2", 6)]]));
    expect(restated.merged.captionStyle.fontSize).toBe(40);
    expect(restated.chapters[1].footprint.restated).toEqual(["global:captionStyle"]);
    const format = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[{ type: "set_project_resolution", width: 1280, height: 720 }], [caption("c2", 6)]])));
    expect(format.code).toBe("LONGFORM_SET_PROJECT_FORMAT_REFUSED");
  });

  it("refuses any owner-revision authority produced while verifying a chapter", () => {
    expect(() => assertNoLongformOwnerProofsV1("ch-2", { nativePaintOwnerRevisionProof: undefined, referenceMotionSourceOwnerProof: undefined, originalSourceOwnerRevisionProof: undefined })).not.toThrow();
    const error = refusal(() => assertNoLongformOwnerProofsV1("ch-2", { nativePaintOwnerRevisionProof: {}, referenceMotionSourceOwnerProof: undefined }));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_OWNER_REVISION_REFUSED", [{ key: "nativePaintOwnerRevisionProof", chapterIds: ["ch-2"] }]]);
  });

  it("refuses a chapter whose effect changes once the other chapters are applied (commutativity)", () => {
    const base = baseProject();
    // Alone, ch-2's opening dissolve has no clip before it and is normalized away; after ch-1 it would survive.
    const dissolve = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [
      [{ type: "add_clip", clip: clip("a", "aroll", "overlay", 3, 2) }],
      [{ type: "add_clip", clip: clip("b", "aroll", "overlay", 5, 2, { creative: { effectPresetIds: [], transitionIn: { presetId: "cross-dissolve", duration: 0.3 } } }) }],
    ])));
    expect([dissolve.code, dissolve.conflicts]).toEqual(["LONGFORM_SET_COMMUTATIVITY", [{ key: "clip:b", chapterIds: ["ch-2"] }]]);
    // ch-1 may lock a shared track, but then ch-2's own clip on it no longer applies.
    const locked = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [
      [{ type: "toggle_track_lock", trackId: "overlay" }],
      [{ type: "add_clip", clip: clip("b", "aroll", "overlay", 6, 2) }],
    ])));
    expect([locked.code, locked.conflicts]).toEqual(["LONGFORM_SET_COMMUTATIVITY", [{ key: "fold", chapterIds: ["ch-2"] }]]);
  });

  it("refuses a merged project over the project caps", () => {
    const base = baseProject();
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [caption("c2", 6)]]), { maxProjectBytes: 4096 }));
    expect(error.code).toBe("LONGFORM_SET_CAP_OVERFLOW");
    expect(mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [caption("c2", 6)]])).summary.projectBytes).toBeGreaterThan(4096);
  });

  it("refuses a project that contains a pre-rendered native assembly chapter (anti-burn guard)", () => {
    const base = baseProject([{ type: "import_asset", asset: { id: "chapter-1-render", name: "Chapter 1", kind: "video", uri: "candidate.mp4", duration: 5, role: "native-assembly-chapter" } }]);
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [caption("c2", 6)]])));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_NATIVE_ASSEMBLY_REFUSED", [{ key: "asset:chapter-1-render", chapterIds: [] }]]);
  });
});

describe("long-form plan set merge: templates and the Motion Library (L1)", () => {
  /** A Motion Library text clip placed by autoTrack, with its own render (no file is touched: the merge reads records). */
  function textClip(project: EditProject, clipId: string, start: number, lines = [clipId], itemId = "T01"): EditorCommand {
    const { field, asset, frameCount } = fixtureClipField(project, itemId, itemId.startsWith("B") ? { durationSeconds: 1 } : { lines, durationSeconds: 1 });
    const kind = itemId.startsWith("B") ? "background" : "text";
    return { type: "add_motion_library_clip", asset, autoTrack: true,
      clip: { ...clip(clipId, asset.id, MOTION_LIBRARY_AUTO_TRACKS_V1[kind].base, start, frameCount / project.fps), motionLibrary: field } };
  }
  const assetOf = (command: EditorCommand) => (command as Extract<EditorCommand, { type: "add_motion_library_clip" }>).asset.id;

  it("G1: lets each chapter create the same auto-placed template track; the fold creates it once", () => {
    const base = baseProject();
    const result = mergeLongformPlanSetV1(base, chapters(base, [[AESTHETIC, textClip(base, "t1", 1)], [AESTHETIC, textClip(base, "t2", 6)]]));
    expect(result.merged.tracks.filter(track => track.id.startsWith("motionlib")).map(track => [track.id, track.clips.map(item => item.id)])).toEqual([["motionlib-text", ["t1", "t2"]]]);
    // Any other track two chapters both create is still a conflict.
    const track: EditorCommand = { type: "add_track", track: { id: "extra", name: "Extra", kind: "video", locked: false, muted: false, clips: [] } };
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[track, caption("c1", 1)], [track, caption("c2", 6)]])));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_DUPLICATE_ENTITY_ID", [{ key: "track:extra", chapterIds: ["ch-1", "ch-2"] }]]);
  });

  it("G2: lets a later chapter reuse a render after importing another asset first", () => {
    const base = baseProject();
    const shared = textClip(base, "t1", 1, ["同一張"]), again = textClip(base, "t3", 8, ["同一張"]);
    expect(assetOf(again)).toBe(assetOf(shared));
    const result = mergeLongformPlanSetV1(base, chapters(base, [[shared], [broll(), again]]));
    expect(result.merged.assets.map(asset => asset.id)).toEqual(["aroll", assetOf(shared), "broll"]);
    expect(result.merged.tracks.find(track => track.id === "motionlib-text")?.clips.map(item => item.id)).toEqual(["t1", "t3"]);
  });

  it("G3: a transition belongs to the chapter whose cut it dresses, not to the frames its window covers", () => {
    // Clips with 5 s source handles on both sides of the 5 s cut.
    const base = applyCommand(createEmptyProject("Cut", { id: "project-cut", width: 640, height: 360, fps: 30 }), { type: "batch", commands: [
      { type: "import_asset", asset: { id: "aroll", name: "A-roll", kind: "video", uri: "aroll.mp4", duration: 30 } },
      { type: "add_clip", clip: clip("p1", "aroll", "video-main", 0, 5, { sourceStart: 5 }) },
      { type: "add_clip", clip: clip("p2", "aroll", "video-main", 5, 5, { sourceStart: 5 }) },
    ] });
    const cut: EditorCommand = { type: "set_timeline_transition", transition: { schema: "editkin.timeline-transition/v1", id: "dissolve-p1", trackId: "video-main",
      fromClipId: "p1", toClipId: "p2", beforeFrames: 8, afterFrames: 8, kernel: "dissolve" } };
    expect(mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [cut]])).merged.timelineTransitions?.map(item => item.id)).toEqual(["dissolve-p1"]);
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[cut], [caption("c2", 6)]])));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_ENTITY_OUTSIDE_RANGE", [{ key: "timelineTransition:dissolve-p1", chapterIds: ["ch-1"] }]]);
  });

  it("G5: a layer order the editor saved is extended by later chapters; setting it is still the first chapter's", () => {
    const unordered = baseProject();
    const order = { schema: "editkin.unified-layer-order/v1" as const, layers: [{ kind: "clip" as const, id: "base-2" }, { kind: "clip" as const, id: "base-1" }] };
    const base = applyCommand(unordered, { type: "set_unified_layer_order", expected: { projectId: unordered.id, revision: unordered.revision, updatedAt: unordered.updatedAt }, order });
    const result = mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [caption("c2", 6), textClip(base, "t2", 7)]]));
    const layers = result.merged.unifiedLayerOrderV1!.layers.map(layer => `${layer.kind}:${layer.id}`);
    // The saved order stays as it was; each chapter's new layers are added to it.
    expect(layers.slice(0, 2)).toEqual(["clip:base-2", "clip:base-1"]);
    expect(layers.slice(2).sort()).toEqual(["caption:c1", "caption:c2", "clip:t2"]);
    expect(result.chapters.map(chapter => chapter.footprint.projectWide)).toEqual([[], []]);
    const explicit: EditorCommand = { type: "set_unified_layer_order", expected: { projectId: base.id, revision: base.revision, updatedAt: base.updatedAt },
      order: { ...order, layers: [...order.layers].reverse() } };
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], [explicit]])));
    expect([error.code, error.conflicts[0]?.key]).toEqual(["LONGFORM_SET_GLOBAL_SETTER_NOT_FIRST", "global:unifiedLayerOrderV1"]);
  });

  it("G7: a later chapter may remove a render with its last clip; original media stay the first chapter's decision", () => {
    const seed = baseProject([broll(), { type: "add_clip", clip: clip("broll-2", "broll", "overlay", 7, 1) }]);
    const placed = textClip(seed, "t2", 6);
    const base = applyCommand(seed, { type: "batch", commands: [placed] });
    const removeRender: EditorCommand[] = [{ type: "delete_clip", clipId: "t2" }, { type: "delete_asset", assetId: assetOf(placed) }];
    const result = mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], removeRender]));
    expect(result.merged.assets.map(asset => asset.id)).toEqual(["aroll", "broll"]);
    const removeOriginal: EditorCommand[] = [{ type: "delete_clip", clipId: "broll-2" }, { type: "delete_asset", assetId: "broll" }];
    const error = refusal(() => mergeLongformPlanSetV1(base, chapters(base, [[caption("c1", 1)], removeOriginal])));
    expect([error.code, error.conflicts]).toEqual(["LONGFORM_SET_GLOBAL_SETTER_NOT_FIRST", [{ key: "asset:broll", chapterIds: ["ch-2"] }]]);
  });
});

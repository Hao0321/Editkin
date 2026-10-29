import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionGraphic, type TimelineClip } from "../domain/types";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";
import { captionOwnerClip, clipAttachments, clipMoveRefusal, hasClipAttachments, motionGraphicBounds, motionGraphicDurationLimits, OWNED_GRAPHIC_REFUSAL,
  planClipExtensionWithAttachments, planClipMoveWithAttachments, planClipTrimWithAttachments, planMotionGraphicDelete, planMotionGraphicRange, planTemplateMove,
  TEMPLATE_OVERLAP_REFUSAL, TEMPLATE_TRACK_REFUSAL, TRACKED_RANGE_REFUSAL } from "./timelineMotionEdits";

// Real EditGraph commands, real history and the real saved-template compiler with bundled glyph bytes.
// No rendered pixels or mounted GUI are claimed here.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
async function physicalText(faceId: string, text: string) {
  let face = faces.get(faceId);
  if (!face) {
    face = readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile)).then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes)));
    if (faces.size >= 6) faces.delete(faces.keys().next().value!);
    faces.set(faceId, face);
  }
  return (await face)(text);
}
function ids(prefix = "id") { let next = 0; return (kind: string, role?: string) => `${prefix}-${kind}-${role?.replaceAll(":", "-") ?? ""}-${next++}`; }
let generated = 0;
const makeId = (kind: string) => `${kind}-made-${++generated}`;

function clip(id: string, trackId: string, timelineStart: number, duration: number, assetId = "source"): TimelineClip {
  return { id, assetId, trackId, timelineStart, sourceStart: 1, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** 主畫面: A [0,4) and B [4,8); 30 fps portrait. */
function base(): EditProject {
  const project = createEmptyProject("Motion lane", { id: "motion-lane", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "D:/owned/trip.mp4", duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [clip("A", "video-main", 0, 4), clip("B", "video-main", 4, 4)];
  return validateProject(project);
}
function title(id: string, start: number, duration: number, text = "標題"): MotionGraphic {
  return createMotionGraphic(id, "title", text, start, duration);
}
function withGraphics(project: EditProject, graphics: MotionGraphic[]): EditProject {
  return applyCommand(project, { type: "batch", commands: graphics.map(graphic => ({ type: "add_motion_graphic" as const, graphic })) });
}
const frameOf = (seconds: number) => Math.round(seconds * 30);
function graphic(project: EditProject, id: string) { return project.motionGraphics.find(item => item.id === id)!; }

describe("free titles on the 標題與圖卡 lane: move, trim, delete as one command", () => {
  it("moves a title on the frame grid, and one Undo restores it", () => {
    const project = withGraphics(base(), [title("t1", 1, 2)]);
    const plan = planMotionGraphicRange(project, "t1", 45, 60);
    expect(plan.command).toEqual({ type: "update_motion_graphic", graphicId: "t1", patch: { timelineStart: 1.5 } });
    expect(plan.message).toBe("已把「標題」移到 1.50 秒；一次復原即可還原。");
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(graphic(history.present, "t1").timelineStart).toBe(1.5);
    expect(graphic(undo(history).present, "t1").timelineStart).toBe(1);
  });
  it("trims within the title's own animation floor and says the shortest length in seconds", () => {
    const project = withGraphics(base(), [title("t1", 1, 3)]);
    const limits = motionGraphicDurationLimits(project, graphic(project, "t1"));
    expect(limits.minFrames).toBeGreaterThan(1);
    expect(limits.minFrames).toBeLessThan(90);
    expect(() => planMotionGraphicRange(project, "t1", 30, limits.minFrames - 1)).toThrow(/最短要 \d+\.\d\d 秒，才放得下進場和退場動畫/);
    const plan = planMotionGraphicRange(project, "t1", 40, limits.minFrames);
    expect(plan.command).toMatchObject({ type: "update_motion_graphic", patch: { timelineStart: 40 / 30, duration: limits.minFrames / 30 } });
    expect(plan.message).toMatch(/^已調整「標題」：1\.33 秒開始，長 \d+\.\d\d 秒；一次復原即可還原。$/);
  });
  it("refuses an unchanged position and a start before 0", () => {
    const project = withGraphics(base(), [title("t1", 1, 2)]);
    expect(() => planMotionGraphicRange(project, "t1", 30, 60)).toThrow("位置沒有改變。");
    expect(() => planMotionGraphicRange(project, "t1", -1, 60)).toThrow("圖卡不能移到 0 秒以前。");
  });
  it("keeps a tracked label inside the clip it tracks", () => {
    let project = base();
    project = applyCommand(project, { type: "add_motion_track", track: { id: "track-1", clipId: "B", name: "人", engine: "fixture", analysisFps: 30,
      initialRect: { x: .4, y: .4, width: .2, height: .2 }, points: [{ frame: 0, time: 0, rect: { x: .4, y: .4, width: .2, height: .2 }, confidence: 1, status: "tracked" }],
      lostRatio: 0, createdAt: "2026-10-10T00:00:00.000Z" } });
    const tag = createMotionGraphic("tag", "tag", "主角", 5, 1, "track-1", legacyMotionGraphicSeed("tag"));
    project = withGraphics(project, [tag]);
    expect(motionGraphicBounds(project, "tag")).toMatchObject({ minStartFrame: 120, maxStartFrame: 210, trackedRange: [120, 240] });
    expect(() => planMotionGraphicRange(project, "tag", 100, 30)).toThrow(TRACKED_RANGE_REFUSAL);
    expect(planMotionGraphicRange(project, "tag", 200, 30).command).toMatchObject({ patch: { timelineStart: 200 / 30 } });
    expect(clipAttachments(project, "B").graphics.map(item => item.id)).toEqual(["tag"]);
  });
  it("deletes a free title in one command and refuses template or scene graphics", async () => {
    const project = withGraphics(base(), [title("t1", 1, 2)]);
    const plan = planMotionGraphicDelete(project, "t1");
    expect(plan).toEqual({ command: { type: "delete_motion_graphic", graphicId: "t1" }, message: "已刪除「標題」；一次復原即可還原。" });
    const owned = await savedLegacy();
    const graphicId = owned.current.referenceMotionInstances![0].roles.find(role => role.kind === "graphic")!.id;
    expect(() => planMotionGraphicDelete(owned.current, graphicId)).toThrow(OWNED_GRAPHIC_REFUSAL);
    expect(() => planMotionGraphicRange(owned.current, graphicId, 300, 30)).toThrow(OWNED_GRAPHIC_REFUSAL);
  }, 60_000);
});

describe("a clip carries the titles that follow it", () => {
  it("moves the titles connected to a 主畫面 clip in the same command; one Undo restores both", async () => {
    const project = withGraphics(base(), [title("on-a", 1, 2, "第一段"), title("on-b", 5, 2, "第二段")]);
    const plan = (await planClipMoveWithAttachments(project, "A", "video-main", 10, makeId))!;
    expect(plan.message).toBe("已把片段移到 10.00 秒，上面的標題也一起移動；一次復原即可還原。");
    const history = dispatchCommand(createHistory(project), plan.command);
    const moved = history.present;
    expect(moved.tracks[0].clips.find(item => item.id === "A")!.timelineStart).toBe(10);
    expect(graphic(moved, "on-a").timelineStart).toBe(11);
    expect(graphic(moved, "on-b").timelineStart).toBe(5);
    const restored = undo(history).present;
    expect(restored.tracks[0].clips.find(item => item.id === "A")!.timelineStart).toBe(0);
    expect(graphic(restored, "on-a").timelineStart).toBe(1);
  });
  it("leaves the ordinary move alone when nothing follows the clip", async () => {
    expect(await planClipMoveWithAttachments(base(), "A", "video-main", 10, makeId)).toBeUndefined();
  });
  it("a head trim keeps a title lined up with the clip start; others stay over the unchanged picture", () => {
    const project = withGraphics(base(), [title("at-start", 0, 2), title("inside", 2, 1.5)]);
    const plan = planClipTrimWithAttachments(project, "A", "start", 0.5)!;
    expect(plan.message).toBe("已修剪片段開頭 0.50 秒，貼齊這個邊的標題也一起調整；一次復原即可還原。");
    const trimmed = applyCommand(project, plan.command);
    expect(trimmed.tracks[0].clips.find(item => item.id === "A")).toMatchObject({ timelineStart: 0.5, duration: 3.5, sourceStart: 1.5 });
    expect(graphic(trimmed, "at-start")).toMatchObject({ timelineStart: 0.5, duration: 1.5 });
    expect(graphic(trimmed, "inside")).toMatchObject({ timelineStart: 2, duration: 1.5 });
    expect(planClipTrimWithAttachments(withGraphics(base(), [title("inside", 2, 1.5)]), "A", "start", 0.5)).toBeUndefined();
  });
  it("a tail trim and a tail extension keep a title that ends with the clip ending with it", () => {
    const project = withGraphics(base(), [title("to-end", 1, 3)]);
    const trimmed = applyCommand(project, planClipTrimWithAttachments(project, "A", "end", 1)!.command);
    expect(graphic(trimmed, "to-end")).toMatchObject({ timelineStart: 1, duration: 2 });
    const spaced = applyCommand(project, { type: "move_clip", clipId: "B", timelineStart: 6 });
    const extended = applyCommand(spaced, planClipExtensionWithAttachments(spaced, "A", "end", 1)!.command);
    expect(extended.tracks[0].clips.find(item => item.id === "A")!.duration).toBe(5);
    expect(graphic(extended, "to-end")).toMatchObject({ timelineStart: 1, duration: 4 });
  });
  it("a start extension that has to grow later moves the picture and its titles later together", () => {
    const project = withGraphics(base(), [title("on-b", 5, 2)]);
    const plan = planClipExtensionWithAttachments(project, "B", "start", 0.5)!;
    const extended = applyCommand(project, plan.command);
    expect(extended.tracks[0].clips.find(item => item.id === "B")).toMatchObject({ timelineStart: 4, sourceStart: 0.5, duration: 4.5 });
    expect(graphic(extended, "on-b").timelineStart).toBe(5.5);
  });
  it("refuses to move a template's clip to another track or onto another clip, with the reason", async () => {
    const owned = await savedLegacy();
    await expect(planClipMoveWithAttachments(owned.current, "primary", "video-second", 2, makeId)).rejects.toThrow(TEMPLATE_TRACK_REFUSAL);
    // primary [1,7) moved to 8 s would cover "after" [12,14): that needs a new layer, which a template cannot follow.
    await expect(planClipMoveWithAttachments(owned.current, "primary", "video-main", 8, makeId)).rejects.toThrow(TEMPLATE_OVERLAP_REFUSAL);
  }, 60_000);
});

async function savedLegacy(startFrame = 30) {
  const project = base();
  project.tracks[0].clips = [clip("primary", "video-main", startFrame / 30, 6), clip("after", "video-main", 12, 2)];
  project.tracks.push({ id: "video-second", name: "第二畫面", kind: "video", locked: false, muted: false, clips: [] });
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "primary", startFrame, durationFrames: 180, title: "FOCUS", kicker: "LOOK",
    purpose: "Owned control", evidenceRefs: ["owned:fixture"], graphicCadence: "kinetic",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(project), input, ids("legacy"), { prepareText: physicalText });
  return { project, packet, current: applyCommand(parseProject(project), { type: "batch", commands: packet.commands }) };
}

async function savedDesign(startFrame: number) {
  const project = createEmptyProject("Design move", { id: "design-move", width: 1080, height: 1920, fps: 30 });
  project.assets = [{ id: "media-0", name: "蝙蝠洞.mov", kind: "video", uri: "D:/owned/cave.mov", duration: 30, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" } }];
  project.tracks[0].clips = [clip("primary", "video-main", startFrame / 30, 11, "media-0")];
  const input = { templateId: "strike_reframe", clipId: "primary", startFrame, durationFrames: 330, graphicCadence: "kinetic", intent: "shortform",
    designSystem: "trip_pop_v1", kicker: "桃園復興｜三民蝙蝠洞", previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", tag: "沒有蝙蝠",
    sources: [], evidenceRefs: ["owned:fixture"], purpose: "Owned design control" } as ReferenceMotionTemplateInput;
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(project), input, ids("design"), { prepareText: physicalText });
  return { packet, current: applyCommand(parseProject(project), { type: "batch", commands: packet.commands }) };
}

describe("a saved template moves with its main clip and stays editable (real compiler, real glyph bytes)", () => {
  it("re-records a CURRENT legacy template at its new start: one Undo, CURRENT after save and reopen, and a recompile changes nothing", async () => {
    const { current, packet } = await savedLegacy();
    const instanceId = packet.instance.id;
    expect((await inspectReferenceMotionTemplateInstance(current, instanceId)).status).toBe("CURRENT");
    const plan = await planTemplateMove(current, instanceId, 15, makeId);
    expect(plan.message).toBe("已把標題模板「FOCUS」和主片段一起移到 1.50 秒；一次復原即可還原。");
    const history = dispatchCommand(createHistory(current), plan.command);
    const moved = history.present;
    expect(history.past).toHaveLength(1);
    expect(moved.tracks[0].clips.find(item => item.id === "primary")!.timelineStart).toBe(1.5);
    const before = packet.instance.roles.filter(role => role.kind === "graphic").map(role => frameOf(graphic(current, role.id).timelineStart));
    const after = packet.instance.roles.filter(role => role.kind === "graphic").map(role => frameOf(graphic(moved, role.id).timelineStart));
    expect(after).toEqual(before.map(frame => frame + 15));
    const saved = moved.referenceMotionInstances![0];
    expect(saved).toMatchObject({ instanceRevision: 2, input: { startFrame: 45 } });
    expect((await inspectReferenceMotionTemplateInstance(moved, instanceId)).status).toBe("CURRENT");
    const reopened = decodeProjectBytes(encodeProjectBytes(moved));
    expect(reopened.referenceMotionInstances![0]).toEqual(saved);
    expect((await inspectReferenceMotionTemplateInstance(reopened, instanceId)).status).toBe("CURRENT");
    // The real compiler at the new start produces exactly the moved graph: nothing to update.
    const revision = await prepareReferenceMotionTemplateRevision(moved, instanceId, { title: "FOCUS" },
      { expectedInstanceRevision: 2, prepareText: physicalText, idFactory: makeId });
    expect(revision.status).toBe("UNCHANGED");
    const restored = undo(history).present;
    expect(restored.referenceMotionInstances![0]).toEqual(packet.instance);
    expect((await inspectReferenceMotionTemplateInstance(restored, instanceId)).status).toBe("CURRENT");
  }, 120_000);

  it("refuses to drop a template onto another title, and refuses moving a title into a template", async () => {
    const { current, packet } = await savedLegacy();
    const crowded = withGraphics(current, [title("later", 9, 1, "別的標題")]);
    await expect(planTemplateMove(crowded, packet.instance.id, 90, makeId)).rejects.toThrow("標題模板「FOCUS」移過去會和「別的標題」重疊，模板就不能再改字；請換個位置。");
    expect(() => planMotionGraphicRange(crowded, "later", 60, 30)).toThrow("這裡是標題模板「FOCUS」的範圍，放進去之後模板就不能再改字；請放到模板外面。");
  }, 120_000);

  it("re-records a CURRENT design-theme template moved later in the video; the recompile is unchanged", async () => {
    const { current, packet } = await savedDesign(60);
    const plan = await planTemplateMove(current, packet.instance.id, 30, makeId);
    const moved = applyCommand(current, plan.command);
    expect(moved.referenceMotionInstances![0]).toMatchObject({ instanceRevision: 2, input: { startFrame: 90 } });
    expect((await inspectReferenceMotionTemplateInstance(moved, packet.instance.id)).status).toBe("CURRENT");
    const revision = await prepareReferenceMotionTemplateRevision(moved, packet.instance.id, { title: "其實是來看水簾" },
      { expectedInstanceRevision: 2, prepareText: physicalText, idFactory: makeId });
    expect(revision.status).toBe("UNCHANGED");
  }, 120_000);

  // With a glyph source the move off 0 s is recompiled and stays editable (referenceMotionTemplateFollow.test.ts).
  it("without a glyph source, a template that opens the video moves off frame 0 unchanged and asks to be re-applied", async () => {
    const { current, packet } = await savedDesign(0);
    const plan = await planTemplateMove(current, packet.instance.id, 30, makeId);
    const commands = plan.command.type === "batch" ? plan.command.commands : [plan.command];
    expect(commands.some(command => command.type === "upsert_reference_motion_instance")).toBe(false);
    const moved = applyCommand(current, plan.command);
    expect(moved.referenceMotionInstances![0]).toEqual(packet.instance);
    expect((await inspectReferenceMotionTemplateInstance(moved, packet.instance.id)).status).toBe("EDITED");
  }, 120_000);
});

describe("captions follow the clip that holds them", () => {
  function withCaptions(project: EditProject, captions: Array<[string, number, number]>): EditProject {
    return applyCommand(project, { type: "batch", commands: captions.map(([id, start, duration]) => ({ type: "add_caption" as const,
      caption: { id, text: `字幕 ${id}`, start, duration } })) });
  }
  const captionStart = (project: EditProject, id: string) => project.captions.find(caption => caption.id === id)!.start;

  it("moves the captions inside a moved clip in the same command; one Undo restores them", async () => {
    // A [0,4): "in" lies inside, "edge" only partly overlaps, "b" belongs to B [4,8).
    const project = withCaptions(base(), [["in", 1, 2], ["edge", 3.5, 1], ["b", 5, 1]]);
    expect(clipAttachments(project, "A").captions.map(caption => caption.id)).toEqual(["in"]);
    expect(hasClipAttachments(project, "A")).toBe(true);
    const plan = (await planClipMoveWithAttachments(project, "A", "video-main", 10, makeId))!;
    expect(plan.message).toBe("已把片段移到 10.00 秒，上面的 1 段字幕也一起移動；一次復原即可還原。");
    const history = dispatchCommand(createHistory(project), plan.command);
    expect(history.past).toHaveLength(1);
    expect([captionStart(history.present, "in"), captionStart(history.present, "edge"), captionStart(history.present, "b")]).toEqual([11, 3.5, 5]);
    const restored = undo(history).present;
    expect([captionStart(restored, "in"), restored.tracks[0].clips.find(item => item.id === "A")!.timelineStart]).toEqual([1, 0]);
  });

  it("titles and captions move together, and a caption on an overlay belongs to the 主畫面 clip under it", async () => {
    let project = withGraphics(withCaptions(base(), [["in", 1, 2]]), [title("on-a", 1, 2, "第一段")]);
    project.tracks.push({ id: "overlay", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [] });
    project = applyCommand(validateProject(project), { type: "add_clip", clip: clip("over", "overlay", 0.5, 3) });
    expect(captionOwnerClip(project, project.captions[0])?.id).toBe("A");
    expect(clipAttachments(project, "over").captions).toEqual([]);
    const plan = (await planClipMoveWithAttachments(project, "A", "video-main", 10, makeId))!;
    expect(plan.message).toBe("已把片段移到 10.00 秒，上面的標題和 1 段字幕也一起移動；一次復原即可還原。");
    const moved = applyCommand(project, plan.command);
    expect([captionStart(moved, "in"), graphic(moved, "on-a").timelineStart]).toEqual([11, 11]);
    // Without a 主畫面 clip under it, the overlay clip that holds the caption owns it.
    const alone = withCaptions(base(), []);
    alone.tracks[0].clips = [clip("B", "video-main", 4, 4)];
    alone.tracks.push({ id: "overlay", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [clip("over", "overlay", 0, 3)] });
    const lone = withCaptions(validateProject(alone), [["lone", 1, 1]]);
    expect(captionOwnerClip(lone, lone.captions[0])?.id).toBe("over");
    const shifted = applyCommand(lone, (await planClipMoveWithAttachments(lone, "over", "overlay", 12, makeId))!.command);
    expect(captionStart(shifted, "lone")).toBe(13);
  });

  it("a one-frame nudge carries the captions; a track change without a time change leaves them where they are", async () => {
    const project = withCaptions(applyCommand(base(), { type: "move_clip", clipId: "B", timelineStart: 12 }), [["in", 1, 2]]);
    project.tracks.push({ id: "overlay", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [] });
    const nudged = applyCommand(validateProject(project), (await planClipMoveWithAttachments(validateProject(project), "A", "video-main", 1 / 30, makeId))!.command);
    expect(captionStart(nudged, "in")).toBeCloseTo(1 + 1 / 30, 9);
    const relayered = await planClipMoveWithAttachments(validateProject(project), "A", "overlay", 0, makeId);
    expect(relayered!.message).toBe("已移到另一條軌道；時間不變，一次復原即可還原。");
    expect(captionStart(applyCommand(validateProject(project), relayered!.command), "in")).toBe(1);
  });

  it("refuses, in plain words and before anything changes, a move that would stack captions", async () => {
    // A [0,4) with "in" [1,3) moved to 4 s would put "in" at [5,7), over B's caption "b" [5,6).
    const project = withCaptions(base(), [["in", 1, 2], ["b", 5, 1]]);
    const spaced = applyCommand(project, { type: "move_clip", clipId: "B", timelineStart: 12 });
    await expect(planClipMoveWithAttachments(spaced, "A", "video-main", 4, makeId)).rejects.toThrow("字幕「字幕 in」跟著片段移過去，會和字幕「字幕 b」疊在一起；請換個位置。");
    expect(clipMoveRefusal(spaced, "A", 4)).toBe("字幕「字幕 in」跟著片段移過去，會和字幕「字幕 b」疊在一起；請換個位置。");
    expect(clipMoveRefusal(spaced, "A", 8)).toBeUndefined();
  });
});

describe("the Inspector start-time field can say why before anything changes", () => {
  it("names the same refusals the move makes, and nothing for a move that works", async () => {
    const owned = await savedLegacy();
    expect(clipMoveRefusal(owned.current, "primary", 8)).toBe(TEMPLATE_OVERLAP_REFUSAL);
    expect(clipMoveRefusal(owned.current, "primary", 2, "video-second")).toBe(TEMPLATE_TRACK_REFUSAL);
    expect(clipMoveRefusal(owned.current, "primary", 1.5)).toBeUndefined();
    const locked = applyCommand(base(), { type: "toggle_track_lock", trackId: "video-main" });
    expect(clipMoveRefusal(locked, "A", 10)).toMatch(/[一-鿿]/);
    expect(clipMoveRefusal(base(), "A", 10)).toBeUndefined();
  }, 60_000);
});

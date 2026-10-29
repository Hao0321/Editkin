import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateReapply,
  prepareReferenceMotionTemplateRevision, ReferenceMotionRebuildRefusal } from "./referenceMotionTemplateInstances";
import { editTouchesTemplates, planClipExtensionWithTemplates, planClipSlipWithTemplates, planClipSplitWithTemplates, planRippleDeleteWithTemplates,
  splitTemplatePiece } from "./timelineMotionEdits";
import { planRippleDelete } from "./timelineRippleEdits";

// The real EditGraph commands and history, the real saved-template compiler and bundled glyph bytes: split, a new
// in-point (slip) and ripples of a template's main clip are planned with the template, committed as one command, and
// the template stays CURRENT — re-applying it afterwards changes nothing. No rendered pixels or mounted GUI here.
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
function ids(prefix: string) { let next = 0; return (kind: string, role?: string) => `${prefix}-${kind}-${role?.replaceAll(":", "-") ?? ""}-${next++}`; }
const glyphs = { prepareText: physicalText, idFactory: ids("follow-edit") };
let made = 0;
const makeId = (kind: string) => `${kind}-made-${++made}`;
const frames = (seconds: number) => Math.round(seconds * 30);

function clip(id: string, timelineStart: number, duration: number, assetId = "source", sourceStart = 1): TimelineClip {
  return { id, assetId, trackId: "video-main", timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
function asset(id: string, name: string, duration = 30) {
  return { id, name, kind: "video" as const, uri: `D:/owned/${id}.mp4`, duration, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" as const } };
}
const legacyInput = (clipId: string, startFrame: number, durationFrames: number, title = "FOCUS"): ReferenceMotionTemplateInput => ({
  templateId: "level_bridge", clipId, startFrame, durationFrames, title, kicker: "LOOK", purpose: "Owned control", evidenceRefs: ["owned:fixture"],
  graphicCadence: "kinetic", style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } });

/** Clips on 主畫面 and a legacy kinetic title template (Bebas Neue, at least 3 s) on each clip named in `templated`. */
async function legacy(clips: TimelineClip[], templated: Array<[string, string?]> = [["primary"]]) {
  const project = createEmptyProject("Follow edits", { id: "follow-edits", width: 1080, height: 1920, fps: 30 });
  project.assets = [asset("source", "旅行.mp4")];
  project.tracks[0].clips = clips;
  let current = parseProject(validateProject(project));
  for (const [clipId, title] of templated) {
    const main = clips.find(item => item.id === clipId)!;
    const packet = await prepareReferenceMotionTemplateInstance(current, legacyInput(clipId, frames(main.timelineStart), frames(main.duration), title),
      ids(`legacy-${clipId}`), { prepareText: physicalText });
    current = applyCommand(current, { type: "batch", commands: packet.commands });
  }
  return current;
}

/** A design-theme strike (trip_pop_v1, at least 4 s): it draws the main clip itself — window layout, mask and keyframes. */
async function design(startFrame: number, extra: TimelineClip[] = []) {
  const project = createEmptyProject("Design follow edits", { id: "design-follow-edits", width: 1080, height: 1920, fps: 30 });
  project.assets = [asset("media-0", "蝙蝠洞.mov"), asset("source", "旅行.mp4")];
  project.tracks[0].clips = [clip("primary", startFrame / 30, 11, "media-0"), ...extra];
  const input = { templateId: "strike_reframe", clipId: "primary", startFrame, durationFrames: 330, graphicCadence: "kinetic", intent: "shortform",
    designSystem: "trip_pop_v1", kicker: "桃園復興｜三民蝙蝠洞", previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", tag: "沒有蝙蝠",
    sources: [], evidenceRefs: ["owned:fixture"], purpose: "Owned design control" } as ReferenceMotionTemplateInput;
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input, ids("design"), { prepareText: physicalText });
  return { packet, current: applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands }) };
}

const clipsOf = (project: EditProject) => project.tracks.flatMap(track => track.clips);
const clipById = (project: EditProject, id: string) => clipsOf(project).find(item => item.id === id);
const instanceNamed = (project: EditProject, title: string) => project.referenceMotionInstances!.find(item => item.input.title === title)!;

/** Commit as the editor does (one history entry); every template it names is CURRENT on its clip, survives save/reopen,
 * and revising or re-applying it again changes nothing. */
async function committed(before: EditProject, command: EditorCommand, titles = ["FOCUS"]) {
  const history = dispatchCommand(createHistory(before), command);
  expect(history.past).toHaveLength(1);
  const after = history.present, reopened = decodeProjectBytes(encodeProjectBytes(after));
  for (const title of titles) {
    const saved = instanceNamed(after, title), main = clipById(after, saved.input.clipId)!;
    expect((await inspectReferenceMotionTemplateInstance(after, saved.id)).status).toBe("CURRENT");
    expect([saved.input.startFrame, saved.input.durationFrames]).toEqual([frames(main.timelineStart), frames(main.duration)]);
    expect((await inspectReferenceMotionTemplateInstance(reopened, saved.id)).status).toBe("CURRENT");
    const revision = await prepareReferenceMotionTemplateRevision(after, saved.id, { title: saved.input.title },
      { expectedInstanceRevision: saved.instanceRevision, prepareText: physicalText, idFactory: makeId });
    expect(revision.status).toBe("UNCHANGED");
    const reapplied = await prepareReferenceMotionTemplateReapply(after, saved.id, { expectedInstanceRevision: saved.instanceRevision, prepareText: physicalText, idFactory: makeId });
    expect(reapplied.status).toBe("UNCHANGED");
    expect(reapplied.commands).toEqual([]);
    for (const role of saved.roles.filter(item => item.kind === "graphic")) {
      const graphic = after.motionGraphics.find(item => item.id === role.id)!;
      expect(frames(graphic.timelineStart)).toBeGreaterThanOrEqual(saved.input.startFrame);
      expect(frames(graphic.timelineStart + graphic.duration)).toBeLessThanOrEqual(saved.input.startFrame + saved.input.durationFrames);
    }
  }
  return { history, after };
}

describe("which piece of a split clip keeps its title template (splitTemplatePiece)", () => {
  it("the first piece when the cut leaves the template's start whole on it; otherwise the longer piece, the first on a tie", async () => {
    // primary [1 s, 7 s); level_bridge needs 3 s from its first frame.
    const project = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]);
    expect(splitTemplatePiece(project, "primary", 4)).toBe("first");      // 3 s | 3 s: the start is whole on the first piece.
    expect(splitTemplatePiece(project, "primary", 5.5)).toBe("first");    // 4.5 s | 1.5 s
    expect(splitTemplatePiece(project, "primary", 1.5)).toBe("second");   // 0.5 s | 5.5 s: the cut is inside the start; longer wins.
    expect(splitTemplatePiece(project, "primary", 3.9)).toBe("second");   // 2.9 s | 3.1 s
    const even = await legacy([clip("primary", 1, 5), clip("after", 12, 2)]);
    expect(splitTemplatePiece(even, "primary", 3.5)).toBe("first");       // 2.5 s | 2.5 s: a tie keeps it on the first piece.
    expect(splitTemplatePiece(project, "after", 13)).toBeUndefined();     // no template on that clip
  }, 60_000);
});

describe("split: the template follows one piece, laid out again on it, in one command (one Undo)", () => {
  it("first piece: the title stays where it began; the second piece is a plain clip", async () => {
    const current = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]), before = instanceNamed(current, "FOCUS");
    expect(editTouchesTemplates(current, [{ type: "split_clip", clipId: "primary", at: 5, newClipId: "tail" }])).toBe(true);
    const plan = (await planClipSplitWithTemplates(current, "primary", 5, "tail", glyphs))!;
    expect(plan.keptBy).toBe("first");
    expect(plan.message).toBe("已在 5.00 秒切開片段，標題模板留在前一段，照新的長度重新排好；一次復原即可還原。");
    const { history, after } = await committed(current, plan.command);
    expect(instanceNamed(after, "FOCUS")).toMatchObject({ instanceRevision: 2, input: { clipId: "primary", startFrame: 30, durationFrames: 120 } });
    expect(instanceNamed(after, "FOCUS").roles.map(role => role.id)).toEqual(before.roles.map(role => role.id));
    expect(clipById(after, "tail")).toMatchObject({ timelineStart: 5, sourceStart: 5, duration: 2, keyframes: [] });
    const restored = undo(history).present;
    expect(instanceNamed(restored, "FOCUS")).toEqual(before);
    expect(clipById(restored, "tail")).toBeUndefined();
  }, 120_000);

  it("second piece: cutting a little off the head gives the template to the rest of the clip, under the new clip", async () => {
    const current = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]), before = instanceNamed(current, "FOCUS");
    const plan = (await planClipSplitWithTemplates(current, "primary", 1.5, "rest", glyphs))!;
    expect(plan.keptBy).toBe("second");
    expect(plan.message).toBe("已在 1.50 秒切開片段，標題模板移到後一段，照新的長度重新排好；一次復原即可還原。");
    const { history, after } = await committed(current, plan.command);
    const saved = instanceNamed(after, "FOCUS");
    expect(saved).toMatchObject({ instanceRevision: 2, input: { clipId: "rest", startFrame: 45, durationFrames: 165 } });
    // Every layer keeps its identity; the template's main clip role is the new piece now.
    expect(saved.roles.filter(role => role.kind !== "clip").map(role => role.id)).toEqual(before.roles.filter(role => role.kind !== "clip").map(role => role.id));
    expect(clipById(after, "primary")).toMatchObject({ timelineStart: 1, duration: 0.5, keyframes: [] });
    expect(instanceNamed(undo(history).present, "FOCUS")).toEqual(before);
  }, 120_000);

  it("a design template that draws the main clip moves its window, mask and keyframes to its piece; the other piece is plain", async () => {
    const { current, packet } = await design(60);
    const own = (kind: string) => packet.instance.roles.filter(role => role.kind === kind && role.parentId === "primary").map(role => role.id).sort();
    expect(own("keyframe").length).toBeGreaterThan(0);
    expect(own("mask").length).toBeGreaterThan(0);
    // primary [2 s, 13 s); trip_pop strike needs 4 s: a cut at 3 s is inside its start, the 10 s rest keeps it.
    const plan = (await planClipSplitWithTemplates(current, "primary", 3, "rest", glyphs))!;
    expect(plan.keptBy).toBe("second");
    const { after } = await committed(current, plan.command, ["其實是來看水簾"]);
    const rest = clipById(after, "rest")!, head = clipById(after, "primary")!;
    expect(rest.keyframes.map(key => key.id).sort()).toEqual(own("keyframe"));
    expect((rest.masks ?? []).map(mask => mask.id).sort()).toEqual(own("mask"));
    expect(rest.layout).toBeDefined();
    // The head piece is the user's own clip again: no window, no template mask or keyframe, the resting picture as before.
    expect(head.keyframes).toEqual([]);
    expect(head.masks ?? []).toEqual([]);
    expect(head.layout).toBeUndefined();
    expect(head.transform).toEqual(clipById(current, "primary")!.transform);
    // The cut far into the clip leaves the template's start whole on the first piece: it stays there.
    const later = (await planClipSplitWithTemplates(current, "primary", 10, "tail", glyphs))!;
    expect(later.keptBy).toBe("first");
    const kept = (await committed(current, later.command, ["其實是來看水簾"])).after;
    expect(clipById(kept, "tail")!.masks ?? []).toEqual([]);
    expect(clipById(kept, "tail")!.layout).toBeUndefined();
    expect(clipById(kept, "primary")!.keyframes.map(key => key.id).sort()).toEqual(own("keyframe"));
  }, 180_000);

  it("when the piece that keeps it is too short, the split still happens and the template says why", async () => {
    // primary [1 s, 6 s) cut in the middle: 2.5 s | 2.5 s, a tie on the first piece, shorter than the 3 s it needs.
    const current = await legacy([clip("primary", 1, 5), clip("after", 12, 2)]), before = instanceNamed(current, "FOCUS");
    const plan = (await planClipSplitWithTemplates(current, "primary", 3.5, "tail", glyphs))!;
    expect(plan.keptBy).toBeUndefined();
    expect(plan.message).toBe("已在 3.50 秒切開片段；片段太短，標題模板「FOCUS」放不下文字，沒有跟著改。把片段拉長後，可以在模板編輯器重新套用；一次復原即可還原。");
    const split = dispatchCommand(createHistory(current), plan.command).present;
    expect(clipById(split, "tail")).toBeDefined();
    expect(instanceNamed(split, "FOCUS")).toEqual(before);
    expect((await inspectReferenceMotionTemplateInstance(split, before.id)).status).toBe("EDITED");
    // 「依目前片段重新套用」 keeps its plain reason.
    await expect(prepareReferenceMotionTemplateReapply(split, before.id, glyphs))
      .rejects.toThrow(new ReferenceMotionRebuildRefusal("片段只有 2.50 秒，這個模板至少要 3.00 秒；先把片段拉長。"));
  }, 120_000);

  it("leaves an ordinary split to the editor", async () => {
    const current = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]);
    expect(editTouchesTemplates(current, [{ type: "split_clip", clipId: "after", at: 13, newClipId: "x" }])).toBe(false);
    expect(await planClipSplitWithTemplates(current, "after", 13, "x", glyphs)).toBeUndefined();
  }, 60_000);
});

describe("slip: a new in-point lays the template out again on the clip as it now plays", () => {
  it("keeps the clip's place and length, and the template stays editable", async () => {
    const current = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]), before = instanceNamed(current, "FOCUS");
    const plan = (await planClipSlipWithTemplates(current, "primary", 3, glyphs))!;
    expect(plan.message).toBe("已換入點：素材改從 3.00 秒開始，片段位置和長度不變，標題模板也照新的畫面重新排好；一次復原即可還原。");
    const { history, after } = await committed(current, plan.command);
    expect(clipById(after, "primary")).toMatchObject({ timelineStart: 1, sourceStart: 3, duration: 6 });
    expect(instanceNamed(after, "FOCUS")).toMatchObject({ instanceRevision: 2, input: { startFrame: 30, durationFrames: 180 } });
    expect(instanceNamed(undo(history).present, "FOCUS")).toEqual(before);
  }, 120_000);

  it("a template's own copy of the main clip's media follows the new in-point", async () => {
    const project = createEmptyProject("Slip wall", { id: "slip-wall", width: 1080, height: 1920, fps: 30 });
    project.assets = Array.from({ length: 3 }, (_, index) => asset(`asset-${index}`, `Owned ${index}.mp4`, 20));
    project.tracks[0].clips = [clip("primary", 0, 12, "asset-0", 2)];
    const input: ReferenceMotionTemplateInput = { templateId: "focus_wall", clipId: "primary", startFrame: 0, durationFrames: 360, title: "FOCUS", primaryLabel: "MAIN",
      purpose: "Keep declared sources readable", evidenceRefs: ["owned:observed-source"],
      sources: [1, 2].map(index => ({ assetId: `asset-${index}`, sourceStart: 3, label: `VIEW ${index}` })),
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
        typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
    const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input, ids("wall"), { prepareText: physicalText });
    const current = applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands });
    const copies = (value: EditProject) => packet.instance.roles.filter(role => role.kind === "clip" && role.id !== "primary")
      .map(role => clipById(value, role.id)!).filter(item => item.assetId === "asset-0");
    expect(copies(current).length).toBeGreaterThan(0);
    const plan = (await planClipSlipWithTemplates(current, "primary", 5, glyphs))!;
    const { after } = await committed(current, plan.command);
    expect(clipById(after, "primary")!.sourceStart).toBe(5);
    for (const copy of copies(after)) expect(copy.sourceStart).toBe(5);
  }, 180_000);
});

describe("ripple delete: templates further on move with their clips and stay editable", () => {
  it("re-records a template the ripple carries along (no recompile), in one command", async () => {
    // [before 1–2 s] gap [primary 3–9 s]: deleting "before" carries the template 1 s earlier.
    const current = await legacy([clip("before", 1, 1), clip("primary", 3, 6), clip("after", 12, 2)]), before = instanceNamed(current, "FOCUS");
    const plan = (await planRippleDeleteWithTemplates(current, "before", glyphs))!;
    expect(plan.message).toBe("已刪除片段並自動補上空隙，後面的標題模板也跟著移好；一次復原即可還原。");
    const commands = plan.command.type === "batch" ? plan.command.commands : [plan.command];
    expect(commands.map(command => command.type)).toEqual(["ripple_delete_clip", "upsert_reference_motion_instance"]);
    const { history, after } = await committed(current, plan.command);
    expect(instanceNamed(after, "FOCUS")).toMatchObject({ instanceRevision: 2, input: { startFrame: 60, durationFrames: 180 } });
    expect(instanceNamed(undo(history).present, "FOCUS")).toEqual(before);
  }, 120_000);

  it("lays out again a template the ripple moves onto 0 s, and re-records one carried further on, in the same command", async () => {
    // [before 0–1 s][primary 1–7 s][second 7–12 s]: both templates move 1 s earlier; the first now opens the video.
    const current = await legacy([clip("before", 0, 1), clip("primary", 1, 6), clip("second", 7, 5)], [["primary", "FOCUS"], ["second", "NEXT"]]);
    const plan = (await planRippleDeleteWithTemplates(current, "before", glyphs))!;
    expect(plan.message).toBe("已刪除片段並自動補上空隙，後面的標題模板也跟著移好；一次復原即可還原。");
    const { history, after } = await committed(current, plan.command, ["FOCUS", "NEXT"]);
    expect(instanceNamed(after, "FOCUS").input.startFrame).toBe(0);
    expect(instanceNamed(after, "NEXT").input.startFrame).toBe(180);
    const restored = undo(history).present;
    expect(instanceNamed(restored, "FOCUS")).toEqual(instanceNamed(current, "FOCUS"));
    expect(instanceNamed(restored, "NEXT")).toEqual(instanceNamed(current, "NEXT"));
  }, 180_000);

  it("a design template moved onto 0 s by a ripple is laid out again with its opening", async () => {
    const { current } = await design(30, [clip("before", 0, 1)]);
    const plan = (await planRippleDeleteWithTemplates(current, "before", glyphs))!;
    const { after } = await committed(current, plan.command, ["其實是來看水簾"]);
    expect(instanceNamed(after, "其實是來看水簾").input.startFrame).toBe(0);
  }, 180_000);

  // Rewritten on purpose (2026-10-11): a free title on the deleted clip used to stay behind over the next shot, so the
  // template carried onto it could not follow and asked to be re-applied. The title now goes with its clip (ripple
  // delete, domain/rippleDelete.ts), and the template further on is carried along and stays editable.
  it("a title on the deleted clip goes with it, so the template carried along stays editable", async () => {
    // [before 1–3 s] gap [primary 4–10 s]; a free title on "before" (1–2.8 s) goes with "before".
    const project = await legacy([clip("before", 1, 2), clip("primary", 4, 6), clip("after", 12, 2)]);
    const current = applyCommand(project, { type: "add_motion_graphic", graphic: createMotionGraphic("left-behind", "title", "留下來的標題", 1, 1.8) });
    const before = instanceNamed(current, "FOCUS");
    const plan = (await planRippleDeleteWithTemplates(current, "before", glyphs))!;
    expect(plan.message).toBe("已刪除片段並自動補上空隙，後面的標題模板也跟著移好；片段上的字幕和標題也一起刪除或修短；復原一次即可完整還原。");
    const { history, after } = await committed(current, plan.command);
    expect(after.motionGraphics.map(graphic => graphic.id)).not.toContain("left-behind");
    expect(clipById(after, "primary")!.timelineStart).toBe(2);
    expect(instanceNamed(after, "FOCUS")).toMatchObject({ instanceRevision: 2, input: { startFrame: 60, durationFrames: 180 } });
    const restored = undo(history).present;
    expect(instanceNamed(restored, "FOCUS")).toEqual(before);
    expect(restored.motionGraphics.map(graphic => graphic.id)).toContain("left-behind");
  }, 120_000);

  // Rewritten on purpose (2026-10-11): deleting a template's own main clip used to leave the template (its titles over
  // the next shot) asking to be re-applied. A template now goes with the clip it sits on, with all its layers, in one Undo.
  it("deleting the template's own clip deletes the template with it, in one Undo", async () => {
    const current = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]);
    const instance = instanceNamed(current, "FOCUS");
    const owned = instance.roles.filter(role => role.kind === "graphic").map(role => role.id);
    expect(owned.length).toBeGreaterThan(0);
    // Nothing is left to follow, so the editor runs the plain ripple delete with its own words.
    expect(await planRippleDeleteWithTemplates(current, "primary", glyphs)).toBeUndefined();
    const plan = planRippleDelete(current, ["primary"]);
    expect(plan.message).toBe("已刪除片段和上面的標題模板「FOCUS」，並自動補上空隙；復原一次即可完整還原。");
    const history = dispatchCommand(createHistory(current), plan.command);
    const after = history.present;
    expect(clipById(after, "primary")).toBeUndefined();
    expect(after.referenceMotionInstances ?? []).toEqual([]);
    expect(after.motionGraphics.filter(graphic => owned.includes(graphic.id))).toEqual([]);
    expect(clipById(after, "after")!.timelineStart).toBe(6);
    expect(decodeProjectBytes(encodeProjectBytes(after)).referenceMotionInstances ?? []).toEqual([]);
    expect(instanceNamed(undo(history).present, "FOCUS")).toEqual(instance);
  }, 60_000);

  it("leaves an ordinary ripple delete to the editor", async () => {
    const current = await legacy([clip("primary", 1, 6), clip("after", 12, 2)]);
    expect(await planRippleDeleteWithTemplates(current, "after", glyphs)).toBeUndefined();
  }, 60_000);
});

describe("ripple insert: a clip that grows pushes a template further on, which moves with its clip and stays editable", () => {
  it("re-records the pushed template at its new place in the same command", async () => {
    // [before 1–3 s][primary 3–9 s]: growing "before" by 1 s pushes the template 1 s later.
    const current = await legacy([clip("before", 1, 2), clip("primary", 3, 6), clip("after", 12, 2)]), before = instanceNamed(current, "FOCUS");
    expect(editTouchesTemplates(current, [{ type: "extend_clip", clipId: "before", edge: "end", seconds: 1 }])).toBe(true);
    const plan = (await planClipExtensionWithTemplates(current, "before", "end", 1, glyphs))!;
    expect(plan.message).toBe("已把片段結尾延長 1.00 秒，後面的內容一起往後移，標題模板也跟著移好；一次復原即可還原。");
    const { history, after } = await committed(current, plan.command);
    expect(clipById(after, "primary")!.timelineStart).toBe(4);
    expect(instanceNamed(after, "FOCUS")).toMatchObject({ instanceRevision: 2, input: { startFrame: 120 } });
    expect(instanceNamed(undo(history).present, "FOCUS")).toEqual(before);
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { decodeProjectBytes, encodeProjectBytes, parseProject } from "./projectCodec";
import { inspectReferenceMotionTemplateInstance, prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateReapply,
  prepareReferenceMotionTemplateRevision, ReferenceMotionRebuildRefusal, referenceMotionTemplateReapplyPatch,
  TEMPLATE_REBUILD_NOT_CURRENT } from "./referenceMotionTemplateInstances";
import { planClipExtensionWithTemplates, planClipMoveWithAttachments, planClipTrimWithTemplates, planTemplateMove } from "./timelineMotionEdits";

// The real EditGraph commands and history, the real saved-template compiler and bundled glyph bytes. These check the
// edit → recompile → one command path and its reopen; no rendered pixels or mounted GUI are claimed here.
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
const glyphs = { prepareText: physicalText, idFactory: ids("follow") };
let made = 0;
const makeId = (kind: string) => `${kind}-made-${++made}`;

function clip(id: string, timelineStart: number, duration: number, assetId = "source", sourceStart = 1): TimelineClip {
  return { id, assetId, trackId: "video-main", timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
function asset(id: string, name: string, duration = 30) {
  return { id, name, kind: "video" as const, uri: `D:/owned/${id}.mp4`, duration, width: 1080, height: 1920, displayAspectRatio: 9 / 16,
    color: { interpretation: "rec709" as const } };
}

/** A legacy kinetic title (Bebas Neue) on 主畫面 clip "primary" [startFrame, +6 s); "after" waits at 12 s. */
async function legacy(startFrame = 30) {
  const project = createEmptyProject("Follow", { id: "follow", width: 1080, height: 1920, fps: 30 });
  project.assets = [asset("source", "旅行.mp4")];
  project.tracks[0].clips = [clip("primary", startFrame / 30, 6), clip("after", 12, 2)];
  const input: ReferenceMotionTemplateInput = { templateId: "level_bridge", clipId: "primary", startFrame, durationFrames: 180, title: "FOCUS", kicker: "LOOK",
    purpose: "Owned control", evidenceRefs: ["owned:fixture"], graphicCadence: "kinetic",
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } };
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input, ids("legacy"), { prepareText: physicalText });
  return { packet, current: applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands }) };
}

/** A design-theme strike (trip_pop_v1): it draws the main clip itself (layout, mask and keyframes) and opens differently at 0 s. */
async function design(startFrame: number) {
  const project = createEmptyProject("Design follow", { id: "design-follow", width: 1080, height: 1920, fps: 30 });
  project.assets = [asset("media-0", "蝙蝠洞.mov")];
  project.tracks[0].clips = [clip("primary", startFrame / 30, 11, "media-0")];
  const input = { templateId: "strike_reframe", clipId: "primary", startFrame, durationFrames: 330, graphicCadence: "kinetic", intent: "shortform",
    designSystem: "trip_pop_v1", kicker: "桃園復興｜三民蝙蝠洞", previousText: "來看蝙蝠", title: "其實是來看水簾", accentText: "水簾", tag: "沒有蝙蝠",
    sources: [], evidenceRefs: ["owned:fixture"], purpose: "Owned design control" } as ReferenceMotionTemplateInput;
  const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input, ids("design"), { prepareText: physicalText });
  return { packet, current: applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands }) };
}

const main = (project: EditProject) => project.tracks.flatMap(track => track.clips).find(item => item.id === "primary")!;
const instanceOf = (project: EditProject) => project.referenceMotionInstances![0];
const frames = (seconds: number) => Math.round(seconds * 30);

/** Commit as the editor does (one history entry), then prove the template is current, survives save/reopen, and that
 * revising or re-applying it again changes nothing. */
async function committed(before: EditProject, command: EditorCommand) {
  const history = dispatchCommand(createHistory(before), command);
  expect(history.past).toHaveLength(1);
  const after = history.present, id = instanceOf(after).id;
  expect((await inspectReferenceMotionTemplateInstance(after, id)).status).toBe("CURRENT");
  const saved = instanceOf(after), clipNow = main(after);
  expect(saved.input.startFrame).toBe(frames(clipNow.timelineStart));
  expect(saved.input.durationFrames).toBe(frames(clipNow.duration));
  const reopened = decodeProjectBytes(encodeProjectBytes(after));
  expect((await inspectReferenceMotionTemplateInstance(reopened, id)).status).toBe("CURRENT");
  const revision = await prepareReferenceMotionTemplateRevision(after, id, { title: saved.input.title },
    { expectedInstanceRevision: saved.instanceRevision, prepareText: physicalText, idFactory: makeId });
  expect(revision.status).toBe("UNCHANGED");
  const reapplied = await prepareReferenceMotionTemplateReapply(after, id, { expectedInstanceRevision: saved.instanceRevision, prepareText: physicalText, idFactory: makeId });
  expect(reapplied.status).toBe("UNCHANGED");
  expect(reapplied.commands).toEqual([]);
  // Template layers sit inside the edited clip.
  const owned = saved.roles.filter(role => role.kind === "graphic").map(role => after.motionGraphics.find(graphic => graphic.id === role.id)!);
  for (const graphic of owned) {
    expect(frames(graphic.timelineStart)).toBeGreaterThanOrEqual(saved.input.startFrame);
    expect(frames(graphic.timelineStart + graphic.duration)).toBeLessThanOrEqual(saved.input.startFrame + saved.input.durationFrames);
  }
  return { history, after };
}

describe("a saved template stays editable when its main clip is trimmed, extended or moved (one command, one Undo)", () => {
  it("trim start: the template is laid out again on the shorter clip and keeps its identities", async () => {
    const { current, packet } = await legacy();
    const plan = (await planClipTrimWithTemplates(current, "primary", "start", 0.5, glyphs))!;
    expect(plan.message).toBe("已修剪片段開頭 0.50 秒，標題模板也照新的長度重新排好；一次復原即可還原。");
    const { history, after } = await committed(current, plan.command);
    expect(main(after)).toMatchObject({ timelineStart: 1.5, sourceStart: 1.5, duration: 5.5 });
    expect(instanceOf(after)).toMatchObject({ instanceRevision: 2, input: { startFrame: 45, durationFrames: 165, title: "FOCUS" } });
    expect(instanceOf(after).roles.map(role => role.id)).toEqual(packet.instance.roles.map(role => role.id));
    const restored = undo(history).present;
    expect(instanceOf(restored)).toEqual(packet.instance);
    expect(main(restored)).toMatchObject({ timelineStart: 1, sourceStart: 1, duration: 6 });
    expect((await inspectReferenceMotionTemplateInstance(restored, packet.instance.id)).status).toBe("CURRENT");
  }, 120_000);

  it("trim end: the template ends with the clip", async () => {
    const { current } = await legacy();
    const plan = (await planClipTrimWithTemplates(current, "primary", "end", 1, glyphs))!;
    expect(plan.message).toBe("已修剪片段結尾 1.00 秒，標題模板也照新的長度重新排好；一次復原即可還原。");
    const { after } = await committed(current, plan.command);
    expect(instanceOf(after).input).toMatchObject({ startFrame: 30, durationFrames: 150 });
  }, 120_000);

  it("extend end and extend start: the template grows with its clip", async () => {
    const { current } = await legacy();
    const longer = (await planClipExtensionWithTemplates(current, "primary", "end", 1, glyphs))!;
    expect(longer.message).toBe("已把片段結尾延長 1.00 秒，標題模板也照新的長度重新排好；一次復原即可還原。");
    expect(instanceOf((await committed(current, longer.command)).after).input).toMatchObject({ startFrame: 30, durationFrames: 210 });
    const earlier = (await planClipExtensionWithTemplates(current, "primary", "start", 0.5, glyphs))!;
    const { after } = await committed(current, earlier.command);
    expect(main(after)).toMatchObject({ timelineStart: 0.5, sourceStart: 0.5, duration: 6.5 });
    expect(instanceOf(after).input).toMatchObject({ startFrame: 15, durationFrames: 195 });
  }, 120_000);

  it("a design template that draws the main clip itself follows a head trim without baking its entrance into the clip", async () => {
    const { current, packet } = await design(60);
    const keyRoles = packet.instance.roles.filter(role => role.kind === "keyframe" && role.parentId === "primary");
    expect(keyRoles.length).toBeGreaterThan(0);
    const plan = (await planClipTrimWithTemplates(current, "primary", "start", 0.5, glyphs))!;
    const { after } = await committed(current, plan.command);
    // Its own keyframes are all there again (none cut off by the trim), and the clip's resting picture is untouched.
    expect(main(after).keyframes.map(key => key.id).sort()).toEqual(keyRoles.map(role => role.id).sort());
    expect(main(after).transform).toEqual(main(current).transform);
    expect(main(after).color).toEqual(main(current).color);
    expect(instanceOf(after).input).toMatchObject({ startFrame: 75, durationFrames: 315 });
  }, 120_000);

  it("moving onto 0 s and off 0 s recompiles the opening and stays editable", async () => {
    const later = await design(60);
    const onto = await planTemplateMove(later.current, later.packet.instance.id, -60, makeId, glyphs);
    expect(onto.message).toBe("已把標題模板「其實是來看水簾」和主片段一起移到 0.00 秒；一次復原即可還原。");
    expect(instanceOf((await committed(later.current, onto.command)).after).input.startFrame).toBe(0);
    const opening = await design(0);
    const off = (await planClipMoveWithAttachments(opening.current, "primary", "video-main", 1, makeId, glyphs))!;
    expect(off.needsReapply).toBe(false);
    expect(off.message).toBe("已把片段移到 1.00 秒，標題模板也一起移動；一次復原即可還原。");
    const { after } = await committed(opening.current, off.command);
    expect(instanceOf(after).input.startFrame).toBe(30);
  }, 120_000);
});

describe("when the template truly cannot follow, the edit still happens and the reason is plain", () => {
  it("a clip shorter than the template's minimum keeps the trim, leaves the template as it was, and re-applies once long enough", async () => {
    const { current, packet } = await legacy();
    const plan = (await planClipTrimWithTemplates(current, "primary", "end", 4, glyphs))!;
    expect(plan.message).toBe("已修剪片段結尾 4.00 秒；片段太短，標題模板「FOCUS」放不下文字，沒有跟著改。把片段拉長後，可以在模板編輯器重新套用；一次復原即可還原。");
    const trimmed = dispatchCommand(createHistory(current), plan.command).present;
    expect(main(trimmed).duration).toBe(2);
    expect(instanceOf(trimmed)).toEqual(packet.instance);
    expect((await inspectReferenceMotionTemplateInstance(trimmed, packet.instance.id)).status).toBe("EDITED");
    await expect(prepareReferenceMotionTemplateReapply(trimmed, packet.instance.id, glyphs))
      .rejects.toThrow(new ReferenceMotionRebuildRefusal("片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。"));
    // Growing the clip again does not silently rewrite a template that is out of date; it says so.
    const grown = (await planClipExtensionWithTemplates(trimmed, "primary", "end", 2, glyphs))!;
    expect(grown.message).toBe("已把片段結尾延長 2.00 秒；標題模板「FOCUS」沒有跟著改，打開模板編輯器可以看原因並重新套用；一次復原即可還原。");
    const longEnough = applyCommand(trimmed, grown.command);
    expect(main(longEnough).duration).toBe(4);
    // 「依目前片段重新套用」, through the editor's ordinary revise channel.
    const reapplied = await prepareReferenceMotionTemplateRevision(longEnough, packet.instance.id, referenceMotionTemplateReapplyPatch(),
      { expectedInstanceRevision: 1, prepareText: physicalText, idFactory: makeId });
    expect(reapplied.status).toBe("REVIEW_REQUIRED");
    const { after } = await committed(longEnough, { type: "batch", commands: reapplied.commands });
    expect(instanceOf(after)).toMatchObject({ instanceRevision: 2, input: { startFrame: 30, durationFrames: 120 } });
  }, 120_000);

  it("never treats a serialized patch as a re-apply request, and refuses to follow a template edited by hand", async () => {
    const { current, packet } = await legacy();
    await expect(prepareReferenceMotionTemplateRevision(current, packet.instance.id, JSON.parse(JSON.stringify(referenceMotionTemplateReapplyPatch())),
      { expectedInstanceRevision: 1, prepareText: physicalText })).rejects.toThrow(/empty/);
    const edited = structuredClone(current), owned = new Set(packet.instance.roles.map(role => role.id));
    edited.motionGraphics.find(graphic => owned.has(graphic.id) && graphic.text === "FOCUS")!.text = "USER EDIT";
    const plan = (await planClipTrimWithTemplates(edited, "primary", "start", 0.5, glyphs))!;
    expect(plan.message).toContain("沒有跟著改");
    const trimmed = applyCommand(edited, plan.command);
    expect(instanceOf(trimmed)).toEqual(packet.instance);
    expect(TEMPLATE_REBUILD_NOT_CURRENT).toMatch(/改過/);
  }, 120_000);
});

describe.each<ReferenceMotionTemplateId>(["comparison_pair", "evidence_takeover", "focus_wall"])("%s: generated clips and the main clip's keyframes follow", templateId => {
  it("trim start and trim end keep it CURRENT with the same identities", async () => {
    const project = createEmptyProject("Families", { id: "families", width: 1080, height: 1920, fps: 30 });
    project.assets = Array.from({ length: 3 }, (_, index) => asset(`asset-${index}`, `Owned ${index}.mp4`, 20));
    project.tracks[0].clips = [{ ...clip("primary", 0, 12, "asset-0", 2), volume: .7 }];
    const input: ReferenceMotionTemplateInput = { templateId, clipId: "primary", startFrame: 0, durationFrames: 360, title: "FOCUS", primaryLabel: "MAIN",
      purpose: "Keep declared sources readable", evidenceRefs: ["owned:observed-source"],
      sources: Array.from({ length: templateId === "comparison_pair" ? 1 : templateId === "focus_wall" ? 2 : 0 }, (_, index) => ({
        assetId: `asset-${index + 1}`, sourceStart: 3, label: `VIEW ${index + 1}` })),
      style: { palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
        typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" }, animationSpeed: 1 } };
    const packet = await prepareReferenceMotionTemplateInstance(parseProject(validateProject(project)), input, ids(templateId), { prepareText: physicalText });
    const current = applyCommand(parseProject(validateProject(project)), { type: "batch", commands: packet.commands });
    for (const [edge, seconds] of [["start", 1], ["end", 2]] as const) {
      const plan = (await planClipTrimWithTemplates(current, "primary", edge, seconds, glyphs))!;
      expect(plan.message).toContain("標題模板也照新的長度重新排好");
      const { after } = await committed(current, plan.command);
      expect(instanceOf(after).roles.map(role => role.id)).toEqual(packet.instance.roles.map(role => role.id));
      expect(main(after).volume).toBe(.7);
      for (const role of packet.instance.roles.filter(item => item.kind === "clip" && item.id !== "primary")) {
        const generated = after.tracks.flatMap(track => track.clips).find(item => item.id === role.id)!;
        expect([generated.timelineStart, generated.duration]).toEqual([main(after).timelineStart, main(after).duration]);
      }
    }
  }, 180_000);
});

import { describe, expect, it } from "vitest";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import type { EditProject } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { inspectReferenceMotionTemplateInstance, isEditkinUpdateReason, prepareReferenceMotionTemplatesUpdate, prepareReferenceMotionTemplateReapply,
  referenceMotionTemplatesBehindUpdate, TEMPLATE_UPDATE_EDITED } from "./referenceMotionTemplateInstances";
import { instanceOf, madeByOlderEditkin, oldTitlesProject, physicalTemplateText } from "./oldTitleTemplatesFixture";

// The real compiler, the bundled font bytes and real EditGraph history throughout.
const glyphs = { prepareText: physicalTemplateText, idFactory: (prefix: string) => `${prefix}-update` };
const status = async (project: EditProject, id: string) => (await inspectReferenceMotionTemplateInstance(project, id)).status;
/** A template's own record and layers, as they are in `project`. */
function owned(project: EditProject, id: string) {
  const instance = instanceOf(project, id), ids = new Set(instance.roles.map(role => role.id));
  return canonicalJson({ instance, graphics: project.motionGraphics.filter(graphic => ids.has(graphic.id)),
    clip: project.tracks.flatMap(track => track.clips).find(clip => clip.id === instance.input.clipId) });
}
const words = (project: EditProject, id: string) => {
  const { input, roles } = instanceOf(project, id);
  return { title: input.title, kicker: input.kicker, subtitle: input.subtitle,
    texts: Object.fromEntries(roles.filter(role => role.kind === "graphic").map(role => [role.key, project.motionGraphics.find(graphic => graphic.id === role.id)?.text])) };
};

describe("titles an Editkin update left behind", () => {
  it("finds the old titles; a title changed by hand afterwards is marked, today's EDITED and MISSING ones are not touched", async () => {
    const f = await oldTitlesProject();
    expect(await status(f.project, f.ids.fresh)).toBe("ENVIRONMENT_CHANGED");
    expect(await status(f.project, f.ids.edited)).toBe("ENVIRONMENT_CHANGED");
    expect(await status(f.project, f.ids.current)).toBe("EDITED");
    expect(await status(f.project, f.ids.short)).toBe("ENVIRONMENT_CHANGED");
    const behind = await referenceMotionTemplatesBehindUpdate(f.project);
    expect(behind.map(item => [item.instance.id, item.editedSince])).toEqual([[f.ids.fresh, false], [f.ids.edited, true], [f.ids.short, false]]);
    // A template whose main clip is gone is MISSING, not behind an update.
    const gone = applyCommand(f.project, { type: "delete_clip", clipId: "a" });
    expect(await status(gone, f.ids.fresh)).toBe("MISSING");
    expect((await referenceMotionTemplatesBehindUpdate(gone)).map(item => item.instance.id)).not.toContain(f.ids.fresh);
  }, 120_000);

  it("a recipe, preset or font that moved on is an update; a canvas change is the project's own change and is left alone", async () => {
    const f = await oldTitlesProject();
    const base = f.compiled, id = f.ids.fresh, template = instanceOf(base, id);
    const reasonFor = async (project: EditProject) => (await inspectReferenceMotionTemplateInstance(project, id)).reason;
    const cases: Array<[string, (project: EditProject) => Promise<EditProject>]> = [
      ["template recipe contract changed", project => madeByOlderEditkin(project, id)],
      ["physical template font dependency changed", project => madeByOlderEditkin(project, id, undefined, instance => { instance.dependencies.fonts[0].fontSha256 = "0".repeat(64); })],
      ["compiled physical template font is unavailable", project => madeByOlderEditkin(project, id, undefined, instance => { instance.dependencies.fonts[0].faceId = "EditkinFace-retired"; })],
      ["registered template preset changed", project => madeByOlderEditkin(project, id, undefined, instance => { instance.dependencies.presetHashes[0].sha256 = "0".repeat(64); })],
      ["registered template preset is unavailable", project => madeByOlderEditkin(project, id, undefined, instance => { instance.dependencies.presetHashes[0].presetId = "retired-preset"; })],
    ];
    expect(template.dependencies.presetHashes.length).toBeGreaterThan(0);
    for (const [words, age] of cases) {
      const project = await age(base);
      expect(await reasonFor(project)).toBe(`ENVIRONMENT_CHANGED: ${words}`);
      expect(isEditkinUpdateReason(await reasonFor(project))).toBe(true);
      expect((await referenceMotionTemplatesBehindUpdate(project)).map(item => [item.instance.id, item.editedSince])).toContainEqual([id, false]);
    }
    const resized = structuredClone(base); resized.width = 1920; resized.height = 1080;
    expect(await reasonFor(resized)).toBe("ENVIRONMENT_CHANGED: canvas or project frame rate changed");
    expect(isEditkinUpdateReason(await reasonFor(resized))).toBe(false);
    expect(await referenceMotionTemplatesBehindUpdate(resized)).toEqual([]);
  }, 120_000);

  it("updates them in one command: CURRENT again, words kept byte for byte, the old layout replaced; the rest stay exactly as they were", async () => {
    const f = await oldTitlesProject();
    const update = await prepareReferenceMotionTemplatesUpdate(f.project, glyphs);
    expect(update.updated).toEqual([{ instanceId: f.ids.fresh, title: "FOCUS" }]);
    expect(update.notUpdated).toEqual([
      { instanceId: f.ids.edited, title: "RIVER", reason: TEMPLATE_UPDATE_EDITED },
      { instanceId: f.ids.short, title: "BATS", reason: "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。" },
    ]);
    expect(update.message).toBe("已更新 1 個標題；2 個標題沒有更新，原因列在標題更新提示裡；一次復原即可還原。");
    const updated = applyCommand(f.project, { type: "batch", commands: update.commands });
    expect(await status(updated, f.ids.fresh)).toBe("CURRENT");
    expect(words(updated, f.ids.fresh)).toEqual(words(f.project, f.ids.fresh));
    expect(words(updated, f.ids.fresh).texts).toEqual(words(f.compiled, f.ids.fresh).texts);
    // Today's layout: the title sits where today's compiler puts it, not where the older version did.
    const moved = (project: EditProject) => project.motionGraphics.find(graphic => graphic.id === f.movedGraphicId)?.y;
    expect(moved(f.project)).not.toBe(moved(f.compiled));
    expect(moved(updated)).toBe(moved(f.compiled));
    expect(instanceOf(updated, f.ids.fresh).instanceRevision).toBe(instanceOf(f.project, f.ids.fresh).instanceRevision + 1);
    expect(instanceOf(updated, f.ids.fresh).dependencies).toEqual(instanceOf(f.compiled, f.ids.fresh).dependencies);
    // Re-applying the updated title changes nothing.
    const again = await prepareReferenceMotionTemplateReapply(updated, f.ids.fresh, glyphs);
    expect(again.status).toBe("UNCHANGED");
    for (const id of [f.ids.edited, f.ids.current, f.ids.short]) expect(owned(updated, id)).toBe(owned(f.project, id));
    expect(await status(updated, f.ids.edited)).toBe("ENVIRONMENT_CHANGED");
    expect(await status(updated, f.ids.current)).toBe("EDITED");
    expect(await status(updated, f.ids.short)).toBe("ENVIRONMENT_CHANGED");
  }, 120_000);

  it("running it again changes nothing, and still says which titles it could not update", async () => {
    const f = await oldTitlesProject();
    const first = await prepareReferenceMotionTemplatesUpdate(f.project, glyphs);
    const updated = applyCommand(f.project, { type: "batch", commands: first.commands });
    const second = await prepareReferenceMotionTemplatesUpdate(updated, glyphs);
    expect(second.commands).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.notUpdated.map(row => row.instanceId)).toEqual([f.ids.edited, f.ids.short]);
    expect(second.message).toBe("標題沒有更新：2 個標題不能自動更新，原因列在標題更新提示裡。");
    // With nothing old left at all, it says so.
    const clean = await prepareReferenceMotionTemplatesUpdate(f.compiled, glyphs);
    expect([clean.commands, clean.updated, clean.notUpdated, clean.message]).toEqual([[], [], [], "標題都已經是新版，不用更新。"]);
  }, 120_000);

  it("one Undo restores the whole project exactly as it was", async () => {
    const f = await oldTitlesProject();
    const update = await prepareReferenceMotionTemplatesUpdate(f.project, glyphs);
    let history = dispatchCommand(createHistory(f.project), { type: "batch", commands: update.commands });
    expect(history.past).toHaveLength(1);
    expect(await status(history.present, f.ids.fresh)).toBe("CURRENT");
    history = undo(history);
    expect(history.present).toEqual(f.project);
    expect(await status(history.present, f.ids.fresh)).toBe("ENVIRONMENT_CHANGED");
  }, 120_000);

  it("a title too short for today's template is reported and left exactly as it was, never forced", async () => {
    const f = await oldTitlesProject();
    const onlyShort = structuredClone(f.project);
    onlyShort.referenceMotionInstances = onlyShort.referenceMotionInstances!.filter(item => item.id === f.ids.short);
    const update = await prepareReferenceMotionTemplatesUpdate(onlyShort, glyphs);
    expect(update.commands).toEqual([]);
    expect(update.notUpdated).toEqual([{ instanceId: f.ids.short, title: "BATS", reason: "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。" }]);
    expect(update.message).toBe("標題沒有更新：「BATS」不能自動更新，原因列在標題更新提示裡。");
  }, 120_000);

  it("cancelling cancels the whole update", async () => {
    const f = await oldTitlesProject();
    const controller = new AbortController(); controller.abort();
    await expect(prepareReferenceMotionTemplatesUpdate(f.project, { ...glyphs, signal: controller.signal })).rejects.toThrow(/cancelled/);
  }, 120_000);
});

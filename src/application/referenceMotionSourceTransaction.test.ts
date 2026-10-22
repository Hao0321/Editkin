import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { canonicalJson } from "../shared/canonicalJson";
import { preparePhysicalFace, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { prepareReferenceMotionTemplateInstance, inspectReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { prepareReferenceMotionTemplateSourceReplacement, referenceMotionSourceReplacementCommandContext } from "./referenceMotionSourceTransaction";
import { decodeProjectBytes, encodeProjectBytes } from "./projectCodec";
import type { ReferenceMotionSourceReplacementRequest } from "./referenceMotionSourceReplacement";
import { createProjectSession } from "./projectSession";
import { runReferenceMotionUiPreparation } from "../ui/SavedReferenceMotionInstances";
import { prepareReferenceMotionTemplateRevision } from "./referenceMotionTemplateInstances";

// Real bundled glyphs, synthetic probed graph metadata. No file, pixel, license or installed-native acceptance claim.
const faces = new Map<string, Promise<(text: string) => PreparedGlyphRun>>();
const prepareText = async (faceId: string, text: string) => {
  if (!faces.has(faceId)) faces.set(faceId, readFile(join(resolve("public/fonts"), bundledFontFaceSpec(faceId).fontFile))
    .then(bytes => preparePhysicalFace(faceId, new Uint8Array(bytes))));
  return (await faces.get(faceId)!)(text);
};
function ids(label: string) { let index = 0; return (prefix: string, role?: string) => `${label}-${prefix}-${role?.replaceAll(":", "-") ?? "none"}-${index++}`; }
const clipOf = (project: EditProject, id: string) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!;
type Mode = "legacy" | "soft" | "theme" | "native_v1" | "native_display";
async function fixture(mode: Mode = "legacy", overrides: Partial<ReferenceMotionTemplateInput> = {}, allPortrait = false) {
  const project = createEmptyProject("Synthetic template source transaction", { id: `source-${mode}`, width: 1080, height: 1920, fps: 30 });
  project.assets = ["old-primary", "old-extra", "new-primary", "new-extra"].map((id, index) => ({ id, kind: "video" as const, name: id,
    uri: `D:/synthetic-source-transaction/${id}.mp4`, duration: 30, width: index === 2 ? 1080 : 1920, height: index === 2 ? 1920 : 1080,
    displayAspectRatio: index === 2 ? 9 / 16 : 16 / 9, color: { interpretation: "rec709" as const } }));
  project.tracks[0].clips = [{ id: "primary", trackId: project.tracks[0].id, assetId: "old-primary", sourceStart: 1, timelineStart: 0, duration: 8,
    volume: .7, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] }];
  const native = mode === "native_v1" || mode === "native_display";
  if (native) project.colorManagement = { ...DEFAULT_COLOR_MANAGEMENT, mode: "aces2" };
  const input: ReferenceMotionTemplateInput = { templateId: native ? "level_bridge" : "comparison_pair", clipId: "primary", startFrame: 0, durationFrames: 240,
    title: native ? "CLEAR VIEW" : "來源測試", kicker: native ? "EDITKIN" : undefined,
    sources: native ? [] : [{ assetId: "old-extra", sourceStart: 2, label: "原素材二" }],
    intent: "shortform", graphicCadence: "legacy", purpose: "Owned synthetic graph and actual glyph control", evidenceRefs: ["synthetic:source-transaction"],
    style: { ...structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), ...(native ? { typography: { headingFamily: "Bebas Neue", bodyFamily: "Bebas Neue" } } : {}) } };
  if (mode === "soft") input.mediaPresentation = "source_soft_v2";
  if (mode === "theme") input.designSystem = "swiss_blue_v1";
  if (native) input.graphicPresentation = mode === "native_v1" ? "native_paint_v1" : "native_paint_display_v2";
  Object.assign(input, overrides);
  for (let index = 2; index <= (input.sources ?? []).length; index++) for (const kind of ["old", "new"]) {
    project.assets.push({ ...structuredClone(project.assets[1]), id: `${kind}-extra-${index}`, uri: `D:/synthetic-source-transaction/${kind}-extra-${index}.mp4` });
  }
  if (allPortrait) for (const asset of project.assets) Object.assign(asset, { width: 1080, height: 1920, displayAspectRatio: 9 / 16 });
  const prepared = await prepareReferenceMotionTemplateInstance(project, input, ids("old"), { prepareText });
  const current = applyCommand(project, { type: "batch", commands: prepared.commands });
  expect((await inspectReferenceMotionTemplateInstance(current, prepared.instance.id)).status).toBe("CURRENT");
  const request: ReferenceMotionSourceReplacementRequest = { instanceId: prepared.instance.id, expectedInstanceRevision: 1,
    expectedProjectRevision: current.revision, primary: { assetId: "new-primary", sourceStart: 3 }, durationFrames: 180,
    sources: (input.sources ?? []).map((_source, index) => ({ assetId: index ? `new-extra-${index + 1}` : "new-extra", sourceStart: 4, label: `NEW ${index + 1}` })),
    audio: { primary: "keep_level", extra: (input.sources ?? []).map(() => "muted") }, focusRegion: null, textRegion: null,
    evidenceRefs: ["synthetic:fresh-new-footage-observation"] };
  return { project: current, before: prepared.instance, request };
}

describe("same-instance source replacement, independently recompiled from real bundled glyphs", () => {
  it.each<Mode>(["legacy", "soft", "theme", "native_v1", "native_display"])("keeps %s copy, style, role identities and source clocks through one Undo/Redo and save/reopen", async mode => {
    const f = await fixture(mode), original = canonicalJson(f.project);
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("replace"), { prepareText });
    expect(canonicalJson(f.project)).toBe(original); expect(prepared.status).toBe("PREPARED_NOT_APPLIED");
    expect(prepared.instance.id).toBe(f.before.id); expect(prepared.instance.instanceRevision).toBe(2);
    expect(prepared.instance.input.title).toBe(f.before.input.title); expect(prepared.instance.input.style).toEqual(f.before.input.style);
    expect(prepared.instance.input.templateId).toBe(f.before.input.templateId); expect(prepared.instance.input.graphicCadence).toBe(f.before.input.graphicCadence);
    expect(prepared.instance.primaryBefore).toEqual(f.before.primaryBefore);
    expect(prepared.instance.roles).toEqual(f.before.roles); expect(prepared.previousQaOrArtworkApprovalReusable).toBe(false);
    const history = dispatchCommand(createHistory(f.project), { type: "batch", commands: prepared.commands }, "source-replacement", referenceMotionSourceReplacementCommandContext(f.project, prepared));
    expect(history.past).toHaveLength(1); expect(canonicalJson(undo(history).present)).toBe(original);
    expect(canonicalJson(redo(undo(history)).present)).toBe(canonicalJson(history.present));
    const result = decodeProjectBytes(encodeProjectBytes(history.present));
    expect((await inspectReferenceMotionTemplateInstance(result, f.before.id)).status).toBe("CURRENT");
    expect(clipOf(result, "primary")).toMatchObject({ id: "primary", assetId: "new-primary", sourceStart: 3, duration: 6, timelineStart: 0, volume: .7 });
    expect(prepared.materialRequirements.map(window => [window.assetId, window.sourceStart, window.duration])).toEqual(mode.startsWith("native")
      ? [["new-primary", 3, 6]] : [["new-primary", 3, 6], ["new-extra", 4, 6]]);
    expect(prepared.physicalLayoutBindings.length).toBeGreaterThan(0);
  });
  it("changes an in-point on the same asset and mutes primary without persisting a new extra audio field", async () => {
    const f = await fixture("legacy"); f.request.primary = { assetId: "old-primary", sourceStart: 2 };
    f.request.sources = [null]; f.request.durationFrames = 240; f.request.audio = { primary: "mute", extra: ["muted"] };
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("audio"), { prepareText });
    const result = applyCommand(f.project, { type: "batch", commands: prepared.commands }, referenceMotionSourceReplacementCommandContext(f.project, prepared));
    expect(clipOf(result, "primary").volume).toBe(0); expect(Object.hasOwn(prepared.instance.input.sources[0], "audio")).toBe(false);
    expect(prepared.audioDisposition.extraPolicy).toBe("muted_fixed_v1");
    const extraIds = prepared.binding.slots[1].clipIds; expect(extraIds.length).toBeGreaterThan(0);
    for (const id of extraIds) expect(clipOf(result, id).volume).toBe(0);
    expect((await inspectReferenceMotionTemplateInstance(result, f.before.id)).status).toBe("CURRENT");
  });
  it("returns UNCHANGED with no history when sources, clocks, input and audio all stay the same", async () => {
    const f = await fixture(); const request = { instanceId: f.before.id, expectedInstanceRevision: 1, expectedProjectRevision: f.project.revision,
      audio: { primary: "keep_level" as const, extra: ["muted" as const] } };
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, request, ids("noop"), { prepareText });
    expect(prepared.status).toBe("UNCHANGED"); expect(prepared.commands).toEqual([]); expect(prepared.instance).toEqual(f.before);
    expect(prepared.materialRequirements).toEqual([]);
  });
  it("refuses stale revisions, bad windows, aliases, insufficient reading time and incomplete audio choices before any mutation", async () => {
    const f = await fixture(), original = canonicalJson(f.project);
    for (const patch of [{ expectedProjectRevision: f.project.revision + 1 }, { expectedInstanceRevision: 2 }, { durationFrames: 90 },
      { primary: { assetId: "new-primary", sourceStart: .001 } }, { primary: { assetId: "new-primary", sourceStart: 29 } },
      { sources: [{ assetId: "new-primary", sourceStart: 4 }] }, { audio: { primary: "keep_level" as const } },
      { sources: [null, null] }]) {
      await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, { ...f.request, ...patch }, ids("refuse"), { prepareText })).rejects.toThrow();
      expect(canonicalJson(f.project)).toBe(original);
    }
  });
  it("imports an owned pending asset only as part of the same final commit and rejects unused or duplicate imports", async () => {
    const f = await fixture(), incoming = { ...structuredClone(f.project.assets.find(asset => asset.id === "new-primary")!), id: "pending", uri: "D:/synthetic-source-transaction/pending.mp4" };
    f.request.primary = { assetId: incoming.id, sourceStart: 1 };
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("pending"), { prepareText, pendingImport: incoming });
    expect(prepared.commands[0].type).toBe("import_asset"); expect(f.project.assets.some(asset => asset.id === incoming.id)).toBe(false);
    const result = applyCommand(f.project, { type: "batch", commands: prepared.commands }, referenceMotionSourceReplacementCommandContext(f.project, prepared));
    expect(result.assets.filter(asset => asset.id === incoming.id)).toHaveLength(1); expect((await inspectReferenceMotionTemplateInstance(result, f.before.id)).status).toBe("CURRENT");
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, { ...f.request, primary: { assetId: "new-primary", sourceStart: 1 } }, ids("unused"), { prepareText, pendingImport: incoming })).rejects.toThrow("沒有對應");
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("duplicate"), { prepareText, pendingImport: f.project.assets[0] })).rejects.toThrow("已存在");
  });
  it("rejects manual drift, links, track locks, project drift, cancellation and mutated or serialized preparations", async () => {
    const f = await fixture(), edited = structuredClone(f.project); edited.motionGraphics[0].text = "manual edit";
    await expect(prepareReferenceMotionTemplateSourceReplacement(edited, f.request, ids("edited"), { prepareText })).rejects.toThrow("已被手動修改");
    const linked = structuredClone(f.project); clipOf(linked, "primary").linkGroupId = "user-link";
    await expect(prepareReferenceMotionTemplateSourceReplacement(linked, f.request, ids("linked"), { prepareText })).rejects.toThrow();
    const locked = structuredClone(f.project); locked.tracks[0].locked = true;
    await expect(prepareReferenceMotionTemplateSourceReplacement(locked, f.request, ids("locked"), { prepareText })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("cancel"), { prepareText, signal: controller.signal })).rejects.toThrow("cancelled");
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("proof"), { prepareText });
    expect(() => referenceMotionSourceReplacementCommandContext(f.project, structuredClone(prepared))).toThrow("新版本");
    const drifted = structuredClone(f.project); drifted.revision++;
    expect(() => referenceMotionSourceReplacementCommandContext(drifted, prepared)).toThrow("新版本");
    prepared.commands.pop(); expect(() => referenceMotionSourceReplacementCommandContext(f.project, prepared)).toThrow("新版本");
  });
  it("cancels during a real glyph request and detects concurrent project/request changes", async () => {
    for (const mode of ["cancel", "project", "request"] as const) {
      const f = await fixture(), before = structuredClone(f.project), controller = new AbortController(); let changed = false;
      const provider = async (faceId: string, text: string) => {
        const run = await prepareText(faceId, text);
        if (!changed) { changed = true; if (mode === "cancel") controller.abort(); else if (mode === "project") f.project.revision++; else f.request.durationFrames = 210; }
        return run;
      };
      await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids(mode), { prepareText: provider, signal: controller.signal })).rejects.toThrow();
      if (mode === "project") before.revision++; expect(f.project).toEqual(before);
    }
  });
  it("rejects path and pinned-byte aliases across retained slots while accepting a measured lower VFR average", async () => {
    const f = await fixture(), newPrimary = f.project.assets.find(asset => asset.id === "new-primary")!, newExtra = f.project.assets.find(asset => asset.id === "new-extra")!;
    newExtra.uri = "D:/SYNTHETIC-SOURCE-TRANSACTION/NEW-PRIMARY.MP4";
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("path-alias"), { prepareText })).rejects.toThrow("同一個影片");
    newExtra.uri = "D:/synthetic-source-transaction/new-extra.mp4";
    newPrimary.derivatives = { sourceSha256: "a".repeat(64), generatedAt: "2026-10-03T00:00:00.000Z" };
    newExtra.derivatives = structuredClone(newPrimary.derivatives);
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("byte-alias"), { prepareText })).rejects.toThrow("同一個影片");
    delete newExtra.derivatives;
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("vfr"), {
      prepareText, sourceFrameRates: { "new-primary": { numerator: 24000, denominator: 1001 } } });
    expect(prepared.sourceFrameRates[0]).toEqual({ assetId: "new-primary", frameRate: { numerator: 24000, denominator: 1001 } });
    expect(prepared.instance.frameFormat.fps).toBe(30);
    expect(f.project.assets.every(asset => !Object.hasOwn(asset, "frameRate"))).toBe(true);
  });
  it("refuses growing through a following authored clip", async () => {
    const f = await fixture();
    f.project.tracks[0].clips.push({ ...structuredClone(clipOf(f.project, "primary")), id: "following", timelineStart: 8, sourceStart: 16, duration: 2,
      keyframes: [], masks: [] });
    f.request.durationFrames = 300;
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("overlap"), { prepareText })).rejects.toThrow("後面的片段");
  });
  it("requires fresh observations and explicit region decisions on changed assets, and a label on each changed extra", async () => {
    const f = await fixture(), original = canonicalJson(f.project);
    for (const patch of [{ evidenceRefs: undefined }, { evidenceRefs: f.before.input.evidenceRefs }, { focusRegion: undefined },
      { textRegion: undefined }, { sources: [{ assetId: "new-extra", sourceStart: 4 }] }]) {
      await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, { ...f.request, ...patch }, ids("observations"), { prepareText })).rejects.toThrow();
      expect(canonicalJson(f.project)).toBe(original);
    }
    const request = { instanceId: f.before.id, expectedInstanceRevision: 1, expectedProjectRevision: f.project.revision,
      primary: { assetId: "old-primary", sourceStart: 2 }, audio: { primary: "keep_level" as const, extra: ["muted" as const] } };
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, request, ids("window"), { prepareText });
    expect(prepared.footageDecision).toEqual({ assetChanged: false, observationsKeptForSameAsset: true });
    expect(prepared.instance.input.evidenceRefs).toEqual(f.before.input.evidenceRefs);
  });
  it("rejects a shrink adjacent to another clip or either clip's transition without editing that clip", async () => {
    for (const mode of ["adjacent", "next-transition", "gap"] as const) {
      const f = await fixture(), following = { ...structuredClone(clipOf(f.project, "primary")), id: "following",
        timelineStart: mode === "adjacent" ? 8 : 10, sourceStart: 16, duration: 2, keyframes: [], masks: [] };
      if (mode === "next-transition") following.creative = { effectPresetIds: [], transitionIn: { presetId: "cross_dissolve", duration: .5 } };
      f.project.tracks[0].clips.push(following); const original = canonicalJson(f.project);
      if (mode === "gap") {
        const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids(mode), { prepareText });
        const result = applyCommand(f.project, { type: "batch", commands: prepared.commands }, referenceMotionSourceReplacementCommandContext(f.project, prepared));
        expect(clipOf(result, following.id)).toEqual(following);
      } else await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids(mode), { prepareText })).rejects.toThrow("不能縮短");
      expect(canonicalJson(f.project)).toBe(original);
    }
  });
  it("requires the exact live physical source context even when all old metadata and digests are valid", async () => {
    const f = await fixture(), prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("authority"), { prepareText });
    const batch = { type: "batch" as const, commands: prepared.commands }, context = referenceMotionSourceReplacementCommandContext(f.project, prepared)!;
    for (const fake of [undefined, {}, structuredClone(context)]) expect(() => applyCommand(f.project, batch, fake)).toThrow("提交證明");
    const altered = structuredClone(batch); altered.commands.splice(0, 0, { type: "set_clip_volume", clipId: "primary", volume: .3 });
    expect(() => applyCommand(f.project, altered, context)).toThrow("提交證明");
    const drifted = structuredClone(f.project); drifted.updatedAt = "2026-10-12T00:00:00.000Z";
    expect(() => applyCommand(drifted, batch, context)).toThrow("提交證明");
    expect((await inspectReferenceMotionTemplateInstance(applyCommand(f.project, batch, context), f.before.id)).status).toBe("CURRENT");
  });
  it("rebinds a source-overlay primary that never had a source clip role", async () => {
    const f = await fixture("legacy", { templateId: "strike_reframe", sources: [], previousText: "OLD VIEW", title: "NEW VIEW",
      strikePresentation: "semantic_replace_v1", strikeSurface: "source_overlay_v2" });
    expect(f.before.roles.some(role => role.kind === "clip" && role.id === "primary")).toBe(false);
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("overlay"), { prepareText });
    const result = applyCommand(f.project, { type: "batch", commands: prepared.commands }, referenceMotionSourceReplacementCommandContext(f.project, prepared));
    expect(clipOf(result, "primary").assetId).toBe("new-primary");
    expect((await inspectReferenceMotionTemplateInstance(result, f.before.id)).status).toBe("CURRENT");
  });
  it("renames only owned focus-wall tracks for fresh labels and refuses a DAR-induced topology change", async () => {
    const f = await fixture("legacy", { templateId: "focus_wall", designSystem: "trip_pop_v1", title: "WALL", subtitle: undefined, primaryLabel: "一",
      sources: [{ assetId: "old-extra", sourceStart: 2, label: "二" }, { assetId: "old-extra-2", sourceStart: 2, label: "三" }] }, true);
    f.request.sources![0]!.label = "四"; f.request.sources![1]!.label = "五";
    const prepared = await prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("wall"), { prepareText });
    const result = applyCommand(f.project, { type: "batch", commands: prepared.commands }, referenceMotionSourceReplacementCommandContext(f.project, prepared));
    expect(prepared.commands.some(command => command.type === "rename_track")).toBe(true);
    expect(prepared.instance.roles.filter(role => role.kind !== "graphic")).toEqual(f.before.roles.filter(role => role.kind !== "graphic"));
    expect((await inspectReferenceMotionTemplateInstance(result, f.before.id)).status).toBe("CURRENT");
    Object.assign(f.project.assets.find(asset => asset.id === "new-extra")!, { width: 1920, height: 1080, displayAspectRatio: 16 / 9 });
    await expect(prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("wall-topology"), { prepareText })).rejects.toThrow("解除模板連結");
  });
  it.each(["source", "native-revision"] as const)("passes live authority through the actual GUI preparation runner for %s", async mode => {
    const f = await fixture("native_display"), session = createProjectSession(f.project); let committed = 0;
    const status = await runReferenceMotionUiPreparation({ project: f.project, session, controller: new AbortController(), isMounted: () => true,
      action: "GUI context integration", onStatus: () => undefined,
      createTextPreparer: () => ({ prepareText, dispose: () => undefined }),
      prepare: () => mode === "source" ? prepareReferenceMotionTemplateSourceReplacement(f.project, f.request, ids("gui-source"), { prepareText })
        : prepareReferenceMotionTemplateRevision(f.project, f.before.id, { title: "NEXT VIEW" }, { expectedInstanceRevision: 1, idFactory: ids("gui-revise"), prepareText }),
      onCommand: (command, _message, context) => {
        const history = dispatchCommand(session.getSnapshot().history, command, "one-gui-commit", context);
        session.setHistory(history); committed++; return true;
      } });
    expect(status).toBe("APPLIED"); expect(committed).toBe(1); expect(session.getSnapshot().history.past).toHaveLength(1);
    expect((await inspectReferenceMotionTemplateInstance(session.getSnapshot().history.present, f.before.id)).status).toBe("CURRENT");
  });
});

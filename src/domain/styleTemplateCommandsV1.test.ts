import { describe, expect, it } from "vitest";
import { decodeProjectBytes, encodeProjectBytes } from "../application/projectCodec";
import { compileStyleTemplateClipV1 } from "../styleTemplates/slots/compileClip";
import { styleTemplateClipAssetV1 } from "../styleTemplates/slots/renderTemplateClip";
import { applyCommand } from "./commands";
import type { EditorCommand } from "./commandTypes";
import { createEmptyProject } from "./editGraph";
import { createHistory, dispatchCommandSafely, redo, undo } from "./history";
import { editorCommandSchema } from "./schema";
import type { StyleJobClipV1 } from "./styleJobFieldsV1";
import { assertStyleJobClipV1, STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1 } from "./styleJobV1";
import { STYLE_TEMPLATE_AUTO_TRACK_V1 } from "./styleTemplateCommandsV1";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip } from "./types";

/**
 * add_style_template_clip / update_style_template_clip: the pure reducer, Undo/Redo, autoTrack, the refusals that only a
 * command can see (template, revision, slots against declarations, slot pictures) and the domain validation of the
 * stored field (slot hash, key, asset binding, image sources). Renders are stood in by their compiled field and the
 * asset record the renderer would publish; real renders are in styleTemplates/slots/templateClip.render.test.ts.
 */
const CACHE = "D:/workspace/.editkin-media-cache";
const PICTURE: MediaAsset = { id: "shot", name: "shot", kind: "image", uri: "shot.png", duration: 5, width: 1600, height: 900, redistributable: true };
const IMAGE = { sha256: "c".repeat(64), width: 1600, height: 900, mime: "image/png" as const };

function base(): EditProject {
  let project = createEmptyProject("Style template commands", { id: "stc", width: 1080, height: 1920, fps: 30 });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "footage", kind: "video", uri: "footage.mp4", duration: 10, width: 1080, height: 1920 } });
  return applyCommand(project, { type: "add_clip", clip: { id: "base", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 10, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
}

function rendered(slots: unknown, images: Record<string, typeof IMAGE> = {}, durationSeconds?: number) {
  const compiled = compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots, frame: { width: 1080, height: 1920, fps: 30 }, images, durationSeconds });
  const asset = styleTemplateClipAssetV1(compiled.field, `${CACHE}/styletpl-clip/S1_explainer_ui/${compiled.field.key}.mov`, { width: 1080, height: 1920, fps: 30 }, "產品教學", []);
  return { field: compiled.field, asset };
}
const slots = (keyword: string, extra: Record<string, unknown> = {}) => ({ text: { lead: "還有", keyword }, color: {}, image: {}, ...extra });

function addCommand(project: EditProject, render: ReturnType<typeof rendered>, extra: Partial<Extract<EditorCommand, { type: "add_style_template_clip" }>> = {}, clipId = "tpl-1", start = 1) {
  const clip: TimelineClip = { id: clipId, assetId: render.asset.id, trackId: STYLE_TEMPLATE_AUTO_TRACK_V1.base, timelineStart: start, sourceStart: 0, duration: render.asset.duration, volume: 0,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], styleJob: structuredClone(render.field) };
  return { type: "add_style_template_clip" as const, asset: render.asset, clip, autoTrack: true as const, ...extra };
}
const templateClip = (project: EditProject, id = "tpl-1") => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)!;
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return ((error as { code?: string }).code ?? (error as Error).message).split(":")[0]; } return "applied"; };

describe("add_style_template_clip", () => {
  it("adds asset, clip and a top 模板 track as one Undo; Redo brings them back; the field validates", () => {
    const project = base(), render = rendered(slots("角色立繪"));
    let history = createHistory(project);
    const result = dispatchCommandSafely(history, addCommand(project, render), "add");
    expect(result.error).toBeUndefined();
    history = result.state;
    const after = history.present;
    expect(after.tracks.at(-1)).toMatchObject({ id: "styletpl", name: "模板", kind: "video" });
    expect(templateClip(after)).toMatchObject({ assetId: render.asset.id, styleJob: { key: render.field.key, slots: { text: { keyword: "角色立繪" } } } });
    expect(after.assets.find(asset => asset.id === render.asset.id)).toMatchObject({ kind: "video", alphaMode: "opaque", license: "Editkin original" });
    expect(assertStyleJobClipV1(after, "video", templateClip(after))).toBe("current");
    const undone = undo(history);
    expect(undone.present.tracks.some(track => track.id === "styletpl")).toBe(false);
    expect(undone.present.assets.some(asset => asset.id === render.asset.id)).toBe(false);
    expect(redo(undone).present).toEqual(after);
    // A second clip that overlaps goes on 模板 2; one that fits reuses 模板.
    const overlap = applyCommand(after, addCommand(after, rendered(slots("遊戲引擎")), {}, "tpl-2", 2));
    expect(templateClip(overlap, "tpl-2").trackId).toBe("styletpl-2");
    const later = applyCommand(after, addCommand(after, rendered(slots("遊戲引擎")), {}, "tpl-3", 6));
    expect(templateClip(later, "tpl-3").trackId).toBe("styletpl");
  });

  it("saves and reopens the field unchanged", () => {
    const project = applyCommand(base(), addCommand(base(), rendered(slots("角色立繪"))));
    const reopened = decodeProjectBytes(encodeProjectBytes(project));
    expect(templateClip(reopened).styleJob).toEqual(templateClip(project).styleJob);
    expect(editorCommandSchema.safeParse(addCommand(base(), rendered(slots("角色立繪")))).success).toBe(true);
  });

  it("brings an imported picture file along in the same Undo, and refuses a picture the project does not hold", () => {
    const project = base();
    const render = rendered(slots("角色立繪", { image: { card: { source: { kind: "asset", assetId: "shot" }, focal: [0.2, 0.5] } } }), { card: IMAGE });
    expect(refusal(() => applyCommand(project, addCommand(project, render)))).toBe("STYLE_JOB_SLOT_ASSET_MISSING");
    const added = applyCommand(project, addCommand(project, render, { slotAssets: [PICTURE] }));
    expect(added.assets.find(asset => asset.id === "shot")).toEqual(PICTURE);
    expect(refusal(() => applyCommand(project, addCommand(project, render, { slotAssets: [{ ...PICTURE, kind: "video" }] })))).toBe("STYLE_JOB_SLOT_ASSET_KIND");
    // A still needs a video and a time inside it.
    const still = rendered(slots("角色立繪", { image: { card: { source: { kind: "still", assetId: "footage", time: 12 } } } }), { card: IMAGE });
    expect(refusal(() => applyCommand(project, addCommand(project, still)))).toBe("STYLE_JOB_SLOT_ASSET_TIME");
    const inside = rendered(slots("角色立繪", { image: { card: { source: { kind: "still", assetId: "footage", time: 4 } } } }), { card: IMAGE });
    expect(refusal(() => applyCommand(project, addCommand(project, inside)))).toBe("applied");
  });

  it("refuses a stale engine, another template revision, unknown or over-long slots, a tampered field and a mismatched asset", () => {
    const project = base(), render = rendered(slots("角色立繪"));
    const tamper = (mutate: (field: StyleJobClipV1) => void) => { const command = addCommand(project, render); mutate(command.clip.styleJob!); return command; };
    expect(refusal(() => applyCommand(project, tamper(field => { field.engineVersion = "editkin.style-template-clip-engine/0.9.0"; })))).toBe("STYLE_JOB_ENGINE_VERSION_STALE");
    expect(refusal(() => applyCommand(project, tamper(field => { field.template.revision = 3; })))).toBe("STYLE_JOB_TEMPLATE_MISMATCH");
    expect(refusal(() => applyCommand(project, tamper(field => { field.template.id = "S9_none"; })))).toBe("STYLE_JOB_TEMPLATE_UNKNOWN");
    expect(refusal(() => applyCommand(project, tamper(field => { field.slots.text.subtitle = "x"; })))).toBe("STYLE_SLOT_UNKNOWN");
    expect(refusal(() => applyCommand(project, tamper(field => { field.slots.text.keyword = "一二三四五六七八九十"; })))).toBe("STYLE_SLOT_TEXT_TOO_LONG");
    expect(refusal(() => applyCommand(project, tamper(field => { field.slots.text.keyword = "改字但沒重算"; })))).toBe("STYLE_JOB_SLOTS_HASH_MISMATCH");
    expect(refusal(() => applyCommand(project, tamper(field => { field.slots.color.accent = "#fcc834"; })))).toBe("STYLE_JOB_FIELD_INVALID");
    expect(refusal(() => applyCommand(project, tamper(field => { (field.job.params as { accent: string }).accent = "#000000"; })))).toBe("STYLE_JOB_CACHE_KEY_MISMATCH");
    expect(refusal(() => applyCommand(project, tamper(field => { field.component.id = "mesh3dDeviceScreen"; field.component.renderer = "mesh3d"; })))).toBe("STYLE_JOB_TEMPLATE_MISMATCH");
    expect(refusal(() => applyCommand(project, { ...addCommand(project, render), asset: { ...render.asset, uri: `${CACHE}/elsewhere/${render.field.key}.mov` } }))).toBe("STYLE_JOB_ASSET_BINDING_MISMATCH");
    expect(refusal(() => applyCommand(project, { ...addCommand(project, render), asset: { ...render.asset, alphaMode: "straight" } }))).toBe("STYLE_JOB_ASSET_ALPHA_MISMATCH");
    expect(refusal(() => applyCommand(project, { ...addCommand(project, render), asset: { ...render.asset, duration: 1 } }))).toBe("STYLE_JOB_ASSET_FRAME_COUNT_MISMATCH");
    expect(refusal(() => applyCommand(project, { ...addCommand(project, render), asset: { ...render.asset, id: "other" } }))).toBe("STYLE_JOB_ASSET_BINDING_MISMATCH");
    expect(refusal(() => applyCommand(project, { type: "add_style_template_clip", asset: render.asset, clip: { ...addCommand(project, render).clip, styleJob: undefined } }))).toBe("STYLE_JOB_FIELD_REQUIRED");
    // A refused command leaves nothing behind (no track created).
    expect(project.tracks.some(track => track.id === "styletpl")).toBe(false);
  });

  it("keeps the canvas honest: a resolution or frame-rate change makes the stored render refuse", () => {
    const project = applyCommand(base(), addCommand(base(), rendered(slots("角色立繪"))));
    const clip = templateClip(project);
    expect(refusal(() => assertStyleJobClipV1({ ...project, fps: 25 }, "video", clip))).toBe("STYLE_JOB_FPS_MISMATCH");
    expect(refusal(() => assertStyleJobClipV1({ ...project, width: 720, height: 1280 }, "video", clip))).toBe("STYLE_JOB_ASSET_DIMENSIONS_MISMATCH");
    expect(refusal(() => assertStyleJobClipV1(project, "audio", clip))).toBe("STYLE_JOB_TRACK_INVALID");
    expect(assertStyleJobClipV1(project, "video", { ...clip, styleJob: { ...clip.styleJob!, engineVersion: "editkin.style-template-clip-engine/0.9.0" } })).toBe("stale_engine");
    expect(STYLE_TEMPLATE_CLIP_ENGINE_VERSION_V1).toMatch(/\/1\.0\.0$/);
  });
});

describe("update_style_template_clip", () => {
  it("re-points the clip after a slot change as one Undo, keeps a trim when the length is unchanged, and refits a new length", () => {
    const project = applyCommand(base(), addCommand(base(), rendered(slots("角色立繪"))));
    const trimmed = applyCommand(project, { type: "trim_clip_end", clipId: "tpl-1", seconds: 1 });
    const clip = templateClip(trimmed), next = rendered(slots("遊戲引擎"));
    const update = { type: "update_style_template_clip" as const, clipId: "tpl-1", expected: { assetId: clip.assetId, key: clip.styleJob!.key }, asset: next.asset, styleJob: next.field };
    let history = createHistory(trimmed);
    history = dispatchCommandSafely(history, update, "update").state;
    expect(templateClip(history.present)).toMatchObject({ assetId: next.asset.id, duration: 3, timelineStart: 1, styleJob: { key: next.field.key, slots: { text: { keyword: "遊戲引擎" } } } });
    expect(templateClip(undo(history).present)).toEqual(clip);
    // A new length refits the clip.
    const longer = rendered(slots("遊戲引擎"), {}, 6);
    const refit = applyCommand(trimmed, { ...update, asset: longer.asset, styleJob: longer.field, sourceStart: 0, duration: longer.asset.duration });
    expect(templateClip(refit)).toMatchObject({ duration: 6, sourceStart: 0 });
  });

  it("refuses a stale expectation, another template and a clip without the field", () => {
    const project = applyCommand(base(), addCommand(base(), rendered(slots("角色立繪"))));
    const clip = templateClip(project), next = rendered(slots("遊戲引擎"));
    const update = { type: "update_style_template_clip" as const, clipId: "tpl-1", expected: { assetId: clip.assetId, key: clip.styleJob!.key }, asset: next.asset, styleJob: next.field };
    expect(refusal(() => applyCommand(project, { ...update, expected: { assetId: clip.assetId, key: "0".repeat(64) } }))).toBe("STYLE_JOB_UPDATE_STALE");
    expect(refusal(() => applyCommand(project, { ...update, clipId: "base" }))).toBe("STYLE_JOB_FIELD_REQUIRED");
    expect(refusal(() => applyCommand(project, { ...update, styleJob: { ...next.field, slots: { ...next.field.slots, text: { keyword: "改了" } } } }))).toBe("STYLE_JOB_SLOTS_HASH_MISMATCH");
    expect(editorCommandSchema.safeParse(update).success).toBe(true);
    expect(editorCommandSchema.safeParse({ ...update, expected: { assetId: "a", key: "short" } }).success).toBe(false);
  });

  it("a locked track refuses both commands", () => {
    const project = applyCommand(base(), addCommand(base(), rendered(slots("角色立繪"))));
    const locked = applyCommand(project, { type: "toggle_track_lock", trackId: "styletpl" });
    const clip = templateClip(locked), next = rendered(slots("遊戲引擎"));
    expect(refusal(() => applyCommand(locked, { type: "update_style_template_clip", clipId: "tpl-1", expected: { assetId: clip.assetId, key: clip.styleJob!.key }, asset: next.asset, styleJob: next.field })))
      .not.toBe("applied");
    expect(refusal(() => applyCommand(locked, addCommand(locked, next, { autoTrack: undefined }, "tpl-9", 1)))).not.toBe("applied");
  });
});

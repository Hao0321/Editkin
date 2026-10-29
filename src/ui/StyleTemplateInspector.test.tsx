import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import type { EditorCommand } from "../domain/commandTypes";
import { createEmptyProject } from "../domain/editGraph";
import { createHistory, dispatchCommandSafely, undo, type EditorHistory } from "../domain/history";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset } from "../domain/types";
import { compileStyleTemplateClipV1 } from "../styleTemplates/slots/compileClip";
import { styleTemplateAddClipCommandV1 } from "../styleTemplates/slots/clipCommands";
import {
  createStyleTemplateInspectorControllerV1, styleTemplateResetColorV1, styleTemplateStillAtPlayheadV1, styleTemplateTextCounterV1,
} from "../styleTemplates/slots/inspectorModel";
import { STYLE_TEMPLATE_NATIVE_REQUIRED_V1, type StyleTemplateRenderHostV1, type StyleTemplateRenderRequestV1 } from "../styleTemplates/slots/renderHost";
import { styleTemplateClipAssetV1 } from "../styleTemplates/slots/renderTemplateClip";
import { interfacePreferences } from "./i18n/interfacePreferences";
import StyleTemplateInspector from "./StyleTemplateInspector";

/** The 「模板片段」 inspector: its markup per slot and locale, and its controller (draft, validation, re-render, one Undo). */
const FRAME = { width: 1080, height: 1920, fps: 30 };
const PICTURE: MediaAsset = { id: "shot", name: "截圖", kind: "image", uri: "shot.png", duration: 5, width: 1600, height: 900 };

/** A stand-in for the desktop render task: the real compiler and asset record, no FFmpeg. */
function fakeHost(options: { delay?: () => Promise<void> } = {}) {
  const calls: StyleTemplateRenderRequestV1[] = [];
  const host: StyleTemplateRenderHostV1 = {
    async render(request, { signal, onProgress }) {
      calls.push(request);
      onProgress({ phase: "generate", fraction: 0.5 });
      await options.delay?.();
      if (signal.aborted) throw new Error("aborted");
      const images = Object.fromEntries(Object.keys(request.slots.image).map(slot => [slot, { sha256: "d".repeat(64), width: 1600, height: 900, mime: "image/png" as const }]));
      const compiled = compileStyleTemplateClipV1({ templateId: request.templateId, slots: request.slots, frame: { width: request.width, height: request.height, fps: request.fps },
        durationSeconds: request.durationSeconds, images });
      const asset = styleTemplateClipAssetV1(compiled.field, `D:/w/.editkin-media-cache/styletpl-clip/${request.templateId}/${compiled.field.key}.mov`, FRAME, "產品教學", request.assets);
      return { field: compiled.field, asset, previewUrls: { [asset.id]: `asset://${compiled.field.key}` } };
    },
    pickImageFile: async () => PICTURE,
  };
  return { host, calls };
}

function setup() {
  let project = createEmptyProject("Inspector", { id: "insp", ...FRAME });
  project = applyCommand(project, { type: "import_asset", asset: { id: "footage", name: "footage", kind: "video", uri: "footage.mp4", duration: 10, width: 1080, height: 1920 } });
  project = applyCommand(project, { type: "add_clip", clip: { id: "base", assetId: "footage", trackId: "video-main", timelineStart: 0, sourceStart: 2, duration: 8, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } });
  const compiled = compileStyleTemplateClipV1({ templateId: "S1_explainer_ui", slots: { text: { lead: "還有", keyword: "角色立繪" }, color: {}, image: {} }, frame: FRAME, images: {} });
  const asset = styleTemplateClipAssetV1(compiled.field, `D:/w/.editkin-media-cache/styletpl-clip/S1_explainer_ui/${compiled.field.key}.mov`, FRAME, "產品教學", []);
  project = applyCommand(project, styleTemplateAddClipCommandV1(project, { field: compiled.field, asset }, { clipId: "tpl", startFrame: 30 }));
  let history: EditorHistory = createHistory(project);
  const commands: EditorCommand[] = [];
  const runCommand = (command: EditorCommand) => { commands.push(command); const result = dispatchCommandSafely(history, command, `c${commands.length}`); history = result.state; return !result.error; };
  return { get history() { return history; }, set history(value: EditorHistory) { history = value; }, get project() { return history.present; }, runCommand, commands };
}
const clipOf = (project: EditProject) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === "tpl")!;

afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); vi.useRealTimers(); });

describe("「模板片段」 markup", () => {
  it("shows a field with a live counter per text slot, a well per colour role and the picture picker; without a host it says so", () => {
    const state = setup();
    const html = renderToStaticMarkup(<StyleTemplateInspector project={state.project} clip={clipOf(state.project)} playhead={2} onCommand={() => undefined} host={null} />);
    for (const slot of ["chapterNumber", "chapterLabel", "lead", "keyword", "tag"]) expect(html).toContain(`data-testid="style-template-text-${slot}"`);
    expect(html).toMatch(/data-testid="style-template-count-keyword"[^>]*>4\/8</);
    expect(html).toMatch(/data-testid="style-template-count-lead"[^>]*>2\/14</);
    expect(html).toContain("重點大字");
    expect(html).toContain("必填");
    for (const role of ["accent", "ink"]) expect(html).toContain(`data-testid="style-template-color-${role}"`);
    expect(html).toContain("#FCC834");
    expect(html).not.toContain("style-template-reset-accent");
    expect(html).toContain('data-testid="style-template-image-card"');
    expect(html).toContain('data-testid="style-template-still-card"');
    expect(html).toContain("沒有圖片時顯示示意介面");
    expect(html).toContain('data-testid="style-template-no-host"');
    expect(html).toContain(STYLE_TEMPLATE_NATIVE_REQUIRED_V1);
    expect(html).toContain("未認證");
  });

  it("labels slots in the interface language", async () => {
    const state = setup();
    expect(await interfacePreferences.setLocale("en")).toBe(true);
    const html = renderToStaticMarkup(<StyleTemplateInspector project={state.project} clip={clipOf(state.project)} playhead={2} onCommand={() => undefined} host={fakeHost().host} />);
    expect(html).toContain("Keyword");
    expect(html).toContain("Accent (keyword, chapter number, tag)");
    expect(html).toContain("Template clip");
    expect(html).not.toContain("重點大字");
    expect(await interfacePreferences.setLocale("ja")).toBe(true);
    expect(renderToStaticMarkup(<StyleTemplateInspector project={state.project} clip={clipOf(state.project)} playhead={2} onCommand={() => undefined} host={null} />)).toContain("キーワード");
  }, 60_000);
});

describe("「模板片段」 controller", () => {
  it("re-renders a valid edit once after the pause and lands it as one Undo", async () => {
    vi.useFakeTimers();
    const state = setup(), { host, calls } = fakeHost(), merged: Record<string, string>[] = [];
    const controller = createStyleTemplateInspectorControllerV1({ getProject: () => state.project, clipId: "tpl", host, runCommand: state.runCommand, mergeRuntimeUrls: urls => merged.push(urls), delayMs: 400 });
    const before = clipOf(state.project);
    const draft = controller.getSnapshot().draft;
    controller.edit({ ...draft, text: { ...draft.text, keyword: "遊戲" } });
    controller.edit({ ...draft, text: { ...draft.text, keyword: "遊戲引擎" } });
    expect(controller.getSnapshot().status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
    expect(calls[0].slots.text.keyword).toBe("遊戲引擎");
    expect(state.commands.map(command => command.type)).toEqual(["update_style_template_clip"]);
    expect(controller.getSnapshot().status).toBe("applied");
    expect(clipOf(state.project).styleJob!.slots.text.keyword).toBe("遊戲引擎");
    expect(merged).toHaveLength(1);
    expect(clipOf(undo(state.history).present)).toEqual(before);
    // The same slots again render to the same key: nothing to apply.
    controller.edit({ ...controller.getSnapshot().draft });
    await vi.advanceTimersByTimeAsync(400);
    expect(state.commands).toHaveLength(1);
    controller.dispose();
  });

  it("never renders over-long text, an unknown colour role or a bad colour; reset brings the template colour back", async () => {
    vi.useFakeTimers();
    const state = setup(), { host, calls } = fakeHost();
    const controller = createStyleTemplateInspectorControllerV1({ getProject: () => state.project, clipId: "tpl", host, runCommand: state.runCommand, delayMs: 10 });
    const draft = controller.getSnapshot().draft;
    controller.edit({ ...draft, text: { ...draft.text, keyword: "一二三四五六七八九" } });
    expect(controller.getSnapshot()).toMatchObject({ status: "invalid", message: expect.stringContaining("STYLE_SLOT_TEXT_TOO_LONG") });
    controller.edit({ ...draft, color: { bg: "#000000" } });
    expect(controller.getSnapshot().message).toContain("STYLE_SLOT_UNKNOWN");
    controller.edit({ ...draft, color: { accent: "#12" } });
    expect(controller.getSnapshot().message).toContain("STYLE_SLOT_COLOR_INVALID");
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(0);
    expect(styleTemplateTextCounterV1({ maxLength: 8 }, " 一二三四五六七八九 ")).toEqual({ length: 9, max: 8, over: true });
    const coloured = { ...draft, color: { accent: "#5CE4F4", ink: "#FFFFFF" } };
    expect(styleTemplateResetColorV1(coloured, "accent").color).toEqual({ ink: "#FFFFFF" });
    expect(styleTemplateResetColorV1(coloured).color).toEqual({});
    controller.dispose();
  });

  it("drops a render the clip changed under, and cancels the older render when a newer edit arrives", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const state = setup(), { host, calls } = fakeHost({ delay: () => new Promise<void>(resolve => { release = resolve; }) });
    const controller = createStyleTemplateInspectorControllerV1({ getProject: () => state.project, clipId: "tpl", host, runCommand: state.runCommand, delayMs: 10 });
    const draft = controller.getSnapshot().draft;
    controller.edit({ ...draft, text: { ...draft.text, keyword: "第一版" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.getSnapshot()).toMatchObject({ status: "rendering", progress: { phase: "generate", fraction: 0.5 } });
    // Meanwhile the clip moves on (another update lands first).
    const other = await fakeHost().host.render({ templateId: "S1_explainer_ui", slots: { text: { keyword: "別人改的" }, color: {}, image: {} }, ...FRAME, durationSeconds: 4, assets: [] },
      { signal: new AbortController().signal, onProgress: () => undefined });
    const current = clipOf(state.project);
    state.runCommand({ type: "update_style_template_clip", clipId: "tpl", expected: { assetId: current.assetId, key: current.styleJob!.key }, asset: other.asset, styleJob: other.field });
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.commands).toHaveLength(1);
    expect(clipOf(state.project).styleJob!.slots.text.keyword).toBe("別人改的");
    expect(controller.getSnapshot().status).toBe("idle");
    // A newer edit aborts an in-flight render.
    const signals: AbortSignal[] = [];
    const slowHost: StyleTemplateRenderHostV1 = { render: (_request, options) => { signals.push(options.signal); return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))); } };
    const second = createStyleTemplateInspectorControllerV1({ getProject: () => state.project, clipId: "tpl", host: slowHost, runCommand: state.runCommand, delayMs: 10 });
    second.edit({ ...second.getSnapshot().draft, text: { ...second.getSnapshot().draft.text, keyword: "甲" } });
    await vi.advanceTimersByTimeAsync(10);
    second.edit({ ...second.getSnapshot().draft, text: { ...second.getSnapshot().draft.text, keyword: "乙" } });
    expect(signals[0].aborted).toBe(true);
    second.cancel();
    expect(second.getSnapshot().status).toBe("idle");
    expect(calls).toHaveLength(1);
    controller.dispose(); second.dispose();
  });

  it("takes a picture from project media, the frame under the playhead or an imported file (imported in the same Undo)", async () => {
    vi.useFakeTimers();
    const state = setup(), { host, calls } = fakeHost();
    expect(styleTemplateStillAtPlayheadV1(state.project, 3)).toEqual({ kind: "still", assetId: "footage", time: 5 });
    expect(styleTemplateStillAtPlayheadV1(state.project, 20)).toBeUndefined();
    const controller = createStyleTemplateInspectorControllerV1({ getProject: () => state.project, clipId: "tpl", host, runCommand: state.runCommand, delayMs: 10 });
    const draft = controller.getSnapshot().draft;
    const picked = await host.pickImageFile!();
    controller.edit({ ...draft, image: { card: { source: { kind: "asset", assetId: picked!.id }, fit: "contain", focal: [0.25, 0.75] } } }, [picked!]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls[0].assets.map(asset => asset.id)).toEqual(["shot"]);
    const update = state.commands[0] as Extract<EditorCommand, { type: "update_style_template_clip" }>;
    expect(update.slotAssets?.map(asset => asset.id)).toEqual(["shot"]);
    expect(state.project.assets.some(asset => asset.id === "shot")).toBe(true);
    expect(clipOf(state.project).styleJob!.slots.image.card).toEqual({ source: { kind: "asset", assetId: "shot" }, fit: "contain", focal: [0.25, 0.75] });
    expect(undo(state.history).present.assets.some(asset => asset.id === "shot")).toBe(false);
    // The frame under the playhead.
    controller.edit({ ...controller.getSnapshot().draft, image: { card: { source: styleTemplateStillAtPlayheadV1(state.project, 3)! } } });
    await vi.advanceTimersByTimeAsync(10);
    expect(clipOf(state.project).styleJob!.slots.image.card.source).toEqual({ kind: "still", assetId: "footage", time: 5 });
    controller.dispose();
  });

  it("without a host keeps the draft and says that applying needs the desktop app", () => {
    const state = setup();
    const controller = createStyleTemplateInspectorControllerV1({ getProject: () => state.project, clipId: "tpl", host: undefined, runCommand: state.runCommand });
    controller.edit({ ...controller.getSnapshot().draft, text: { keyword: "改了", lead: "還有" } });
    expect(controller.getSnapshot()).toMatchObject({ status: "no_host", message: STYLE_TEMPLATE_NATIVE_REQUIRED_V1, draft: { text: { keyword: "改了" } } });
    expect(state.commands).toHaveLength(0);
  });
});

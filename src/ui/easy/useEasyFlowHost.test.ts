import { describe, expect, it, vi } from "vitest";
import { createProjectSession } from "../../application/projectSession";
import { planImportedMediaTimeline } from "../../application/timelineImport";
import type { EditorCommand } from "../../domain/commands";
import { createUiDemoProject } from "../../domain/demo";
import { dispatchCommandSafely } from "../../domain/history";
import type { MediaAsset } from "../../domain/types";
import type { HaoDesktopApi } from "../../desktop/apiTypes";
import type { OpenProjectResult } from "../../desktop/mediaTypes";
import type { SemanticAutoEditOutcome } from "../../desktop/useSemanticAutoEdit";
import { createEasyFlowController } from "./easyFlowController";
import { createEasyFlowStore, type EasyProgress } from "./easyFlowModel";
import { createEditorShellEasyHost, easyVideoFromAsset, editorialProfileForGenre, projectNameForVideo, type EasyShellProps, type PendingRoughCut } from "./useEasyFlowHost";

// The real project session and edit commands; the import path, the rough cut and the render are the shell's doubles.
const video = (id: string, width = 1920, height = 1080): MediaAsset => ({ id, name: `${id}.MOV`, kind: "video", uri: `D:/footage/${id}.MOV`, duration: 20, width, height });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function shell(options: { isDesktop?: boolean; picked?: MediaAsset[]; files?: MediaAsset[]; desktopApi?: Partial<HaoDesktopApi> } = {}) {
  const session = createProjectSession(createUiDemoProject());
  const commands: EditorCommand[] = [];
  const runCommand = vi.fn((command: EditorCommand) => {
    const result = dispatchCommandSafely(session.getSnapshot().history, command);
    session.setHistory(result.state);
    if (!result.error) commands.push(command);
    return !result.error;
  });
  let ids = 0;
  const importAssets = (assets: MediaAsset[]) => {
    if (!assets.length) return;
    const planned = planImportedMediaTimeline(session.getSnapshot().history.present, assets, undefined, prefix => `${prefix}-${++ids}`);
    runCommand(planned.command);
  };
  const library = {
    importState: { phase: "idle", total: 0, completed: 0, failed: 0, message: "" },
    importDesktopMedia: vi.fn(async () => importAssets(options.picked ?? [video("IMG_3310")])),
  };
  const props = {
    projectSession: session, isDesktop: options.isDesktop ?? true, status: "無法匯入素材",
    importFiles: vi.fn(async () => importAssets(options.files ?? [video("IMG_3310")])),
    creativeLibrary: library as unknown as EasyShellProps["creativeLibrary"],
    runtimeUrls: { "IMG_3310:thumbnail": "thumb://IMG_3310", IMG_3310: "proxy://IMG_3310" } as Record<string, string>,
    runCommand, setSelectedClipId: vi.fn(), setSelectedCaptionId: vi.fn(), pausePlayback: vi.fn(), openProject: vi.fn(async () => undefined),
    loadOpenedProject: vi.fn((opened: OpenProjectResult) => { session.replaceProject(opened.project!, opened.path); }),
  } satisfies EasyShellProps;
  const openWorkspace = vi.fn();
  let pending: PendingRoughCut | undefined;
  const renderProject = vi.fn(async () => ({ canceled: false, outputPath: "D:\\Videos\\IMG_3310.mp4" }));
  const store = createEasyFlowStore();
  const { host, forgetVideo } = createEditorShellEasyHost({
    store, live: () => ({ props, openWorkspace }), launchRoughCut: next => { pending = next; }, settle: () => Promise.resolve(), renderProject,
    desktopApi: options.desktopApi,
  });
  return { session, props, library, host, store, commands, openWorkspace, renderProject, forgetVideo, pending: () => pending };
}

describe("editor shell side of the easy flow", () => {
  it("brings a video in through the app's desktop import path and remembers how to put it away", async () => {
    const s = shell();
    const before = s.session.getSnapshot().history;
    const outcome = await s.host.chooseVideo();
    expect(s.library.importDesktopMedia).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "video", video: { id: "IMG_3310", name: "IMG_3310.MOV", durationSeconds: 20, orientation: "landscape",
      thumbnailUrl: "thumb://IMG_3310", previewUrl: "proxy://IMG_3310" } });
    expect(s.session.getSnapshot().history.present.assets.map(asset => asset.id)).toEqual(["IMG_3310"]);
    s.host.discardVideo();
    expect(s.session.getSnapshot().history).toBe(before);
    expect(s.session.getSnapshot().dirty).toBe(false);
    expect(s.props.pausePlayback).toHaveBeenCalled();
  });

  it("uses the browser import path for chosen files and has no engine there", async () => {
    const s = shell({ isDesktop: false });
    expect(s.host.picker).toBe("file-input");
    expect(s.host.engine.formatStatus("horizontal")).toBe("needs-desktop");
    const outcome = await s.host.chooseVideo([new File(["x"], "IMG_3310.MOV")]);
    expect(s.props.importFiles).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("video");
    expect(await s.host.chooseVideo()).toEqual({ kind: "nothing" });
  });

  it("refuses photos, sounds and several files at once, leaving the project as it was", async () => {
    const audio: MediaAsset = { id: "song", name: "song.mp3", kind: "audio", uri: "D:/song.mp3", duration: 30 };
    const notVideo = shell({ picked: [audio] });
    const before = notVideo.session.getSnapshot().history;
    expect(await notVideo.host.chooseVideo()).toEqual({ kind: "not-video" });
    expect(notVideo.session.getSnapshot().history).toBe(before);
    const many = shell({ picked: [video("A"), video("B")] });
    const manyBefore = many.session.getSnapshot().history;
    expect(await many.host.chooseVideo()).toEqual({ kind: "too-many" });
    expect(many.session.getSnapshot().history).toBe(manyBefore);
  });

  it("tells a closed chooser apart from a failed import", async () => {
    const closed = shell({ picked: [] });
    expect(await closed.host.chooseVideo()).toEqual({ kind: "nothing" });
    const failed = shell({ picked: [] });
    failed.library.importDesktopMedia.mockImplementation(async () => {
      failed.library.importState = { phase: "failed", total: 1, completed: 1, failed: 1, message: "預覽準備失敗" };
    });
    expect(await failed.host.chooseVideo()).toEqual({ kind: "failed", detail: "預覽準備失敗" });
    const browser = shell({ isDesktop: false, files: [] });
    expect(await browser.host.chooseVideo([new File(["x"], "broken.mov")])).toEqual({ kind: "failed", detail: "無法匯入素材" });
  });

  it("prepares the project in one undoable step, selects the clip and runs the existing rough cut", async () => {
    const s = shell();
    const controller = createEasyFlowController(s.host);
    controller.chooseFormat("horizontal");
    await controller.chooseVideo();
    expect(s.store.getState()).toMatchObject({ screen: "genre", plan: { needsTitle: false, rendersPreview: false } });
    controller.chooseGenre("food");
    controller.confirmGenre();
    expect(s.store.getState().screen).toBe("working");
    await flush();
    const prepared = s.session.getSnapshot().history.present;
    expect(prepared.editorialProfile).toBe("food");
    expect(prepared.name).toBe("IMG_3310");
    expect(s.commands.at(-1)).toMatchObject({ type: "batch", commands: [{ type: "set_editorial_profile", profile: "food" }, { type: "set_aesthetic_system" }, { type: "rename_project", name: "IMG_3310" }] });
    const clipId = prepared.tracks.flatMap(track => track.clips).find(clip => clip.assetId === "IMG_3310")!.id;
    expect(s.props.setSelectedClipId).toHaveBeenLastCalledWith(clipId);
    const pending = s.pending()!;
    expect(pending).toBeDefined();
    pending.onStage(1);
    pending.onStage(3);
    expect(s.store.getState().run).toMatchObject({ step: 2 });
    pending.resolve({ ok: true, segmentCount: 6, addedCaptions: 14, music: true } satisfies SemanticAutoEditOutcome);
    await flush();
    expect(s.store.getState()).toMatchObject({ screen: "result", result: { summary: { segments: 6, captions: 14, music: true } } });
    await controller.save();
    // W2-4: the save is the desktop export job (progress, stop and the close guard), so the render gets its job id.
    expect(s.renderProject).toHaveBeenCalledWith(s.session.getSnapshot().history.present, { jobId: expect.stringMatching(/^render-[a-f0-9]{16}$/) });
    expect(s.store.getState()).toMatchObject({ screen: "saved", saved: { path: "D:\\Videos\\IMG_3310.mp4", folderName: "Videos", fileName: "IMG_3310.mp4" } });
    expect(controller.canReveal()).toBe(false);
  });

  it("reports a refused rough cut as a failure, not as a result", async () => {
    const s = shell();
    const controller = createEasyFlowController(s.host);
    controller.chooseFormat("horizontal");
    await controller.chooseVideo();
    controller.confirmGenre();
    await flush();
    s.pending()!.resolve({ ok: false, reason: "failed", message: "智慧成片失敗：decoder" });
    await flush();
    expect(s.store.getState()).toMatchObject({ screen: "failed", failure: { detail: "智慧成片失敗：decoder" } });
  });

  it("keeps vertical footage away from the rough cut", async () => {
    const s = shell({ picked: [video("IMG_4022", 1080, 1920)] });
    const controller = createEasyFlowController(s.host);
    controller.chooseFormat("horizontal");
    await controller.chooseVideo();
    expect(s.store.getState()).toMatchObject({ screen: "unavailable", unavailable: "video-not-horizontal" });
    expect(s.pending()).toBeUndefined();
  });

  it("leaves for the editor with the video kept, or opens the workspace when the flow has no video", async () => {
    const s = shell();
    const controller = createEasyFlowController(s.host);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    expect(s.store.getState().screen).toBe("unavailable");
    controller.openEditor();
    expect(s.store.getState().screen).toBe("home");
    expect(s.session.getSnapshot().history.present.assets.map(asset => asset.id)).toEqual(["IMG_3310"]);
    expect(s.openWorkspace).not.toHaveBeenCalled();
    const empty = shell();
    empty.host.leaveToEditor();
    expect(empty.openWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not roll back a project that was replaced in the meantime", async () => {
    const s = shell();
    await s.host.chooseVideo();
    s.session.replaceProject(createUiDemoProject());
    const replaced = s.session.getSnapshot().history;
    s.host.discardVideo();
    expect(s.session.getSnapshot().history).toBe(replaced);
  });

  it("maps genres and names conservatively", () => {
    expect(editorialProfileForGenre("travel")).toBe("travel");
    expect(editorialProfileForGenre("food")).toBe("food");
    expect(editorialProfileForGenre("game")).toBe("gaming");
    for (const genre of ["teaching", "unboxing", "life", "auto"] as const) expect(editorialProfileForGenre(genre)).toBe("auto");
    expect(projectNameForVideo({ id: "x", name: "IMG_3310.MOV" })).toBe("IMG_3310");
    expect(projectNameForVideo({ id: "x", name: ".MOV" })).toBe(".MOV");
    expect(easyVideoFromAsset({ ...video("P", 1080, 1920), displayAspectRatio: 16 / 9 }, {}).orientation).toBe("landscape");
  });

  it("vertical Shorts use the template engine on the chosen video's own path when the desktop offers it", async () => {
    const portraitClip = video("IMG_4022", 1080, 1920);
    const status = { jobId: "job-1", phase: "finished" as const, step: 3, fraction: 1, outputPath: "D:\\run\\output.mp4", outputUrl: "asset://run/output.mp4",
      result: { schema: "editkin.template-short-in-app/v1" as const, status: "REVIEW_REQUIRED", delivered: true, flags: [], window: { start: 0, end: 15, seconds: 15, clamped: true } } };
    const short = createUiDemoProject();
    const desktopApi: Partial<HaoDesktopApi> = {
      templateShortPrepare: vi.fn(async () => ({ workspaceFound: true, defaults: "present" as const, scope: { name: "videos", kind: "folder" as const } })),
      templateShortConfirmRights: vi.fn(async () => ({ written: true })),
      templateShortStart: vi.fn(async () => ({ jobId: "job-1" })),
      templateShortStatus: vi.fn(async () => status),
      templateShortCancel: vi.fn(async (jobId: string) => ({ jobId, canceled: true })),
      templateShortSaveVideo: vi.fn(async () => ({ path: "C:\\Users\\a\\Videos\\t.mp4", fileName: "t.mp4", folderName: "Videos" })),
      templateShortOpenProject: vi.fn(async () => ({ canceled: false, path: "D:\\run\\short.editkin.json", project: short, runtimeUrls: {} })),
      revealInFolder: vi.fn(async () => undefined),
    };
    const s = shell({ picked: [portraitClip], desktopApi });
    expect(s.host.engine.formatStatus("vertical")).toBe("ready");
    const controller = createEasyFlowController(s.host);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    expect(desktopApi.templateShortPrepare).toHaveBeenCalledWith("D:/footage/IMG_4022.MOV");
    expect(s.store.getState()).toMatchObject({ screen: "genre", plan: { copy: "story" } });
    controller.confirmGenre();
    controller.skipHook();
    controller.setTitle("其實是來看水簾的");
    controller.submitTitle();
    controller.setPoint(0, "洞頂滴水");
    controller.setPoint(1, "步道好走");
    controller.submitPoints();
    await vi.waitFor(() => expect(s.store.getState().screen).toBe("result"));
    expect(desktopApi.templateShortStart).toHaveBeenCalledWith({ sourcePath: "D:/footage/IMG_4022.MOV", genre: "knowledge",
      copy: { payoff: "其實是來看水簾的", points: ["洞頂滴水", "步道好走"] } });
    // The rough cut never runs for vertical Shorts, and the creator's project is never the template's target.
    expect(s.pending()).toBeUndefined();
    expect(s.commands.some(command => command.type === "batch" && command.commands.some(inner => inner.type === "set_editorial_profile"))).toBe(false);
    expect(controller.canReveal()).toBe(true);
    // 我想自己細調 opens the new Short project.
    controller.openEditor();
    await vi.waitFor(() => expect(s.props.loadOpenedProject).toHaveBeenCalledTimes(1));
    expect(desktopApi.templateShortOpenProject).toHaveBeenCalledWith("job-1");
    expect(s.store.getState().screen).toBe("home");
    expect(s.session.getSnapshot().history.present).toBe(short);
  });

  it("keeps the result on screen and says so when the finished Short cannot be opened", async () => {
    const s = shell({ desktopApi: { templateShortOpenProject: vi.fn(async () => { throw new Error("read_project failed"); }) } });
    s.store.dispatch({ type: "choose-format", format: "vertical" });
    s.store.dispatch({ type: "pick-started" });
    s.store.dispatch({ type: "pick-finished", video: { id: "IMG_3310", name: "IMG_3310.MOV" }, check: { ok: true, plan: { needsTitle: true, copy: "story",
      steps: ["a", "b", "c", "d"], canRestyle: false, canEditText: true, rendersPreview: true, canCancel: true } } });
    s.store.dispatch({ type: "run-started", runId: 1, startedAt: 0 });
    s.store.dispatch({ type: "run-finished", runId: 1, result: { orientation: "vertical", flags: [], handle: "job-9", previewUrl: "x.mp4" } });
    s.host.leaveToEditor();
    await vi.waitFor(() => expect(s.store.getState().saveProblem).toMatchObject({ kind: "open-failed", detail: "read_project failed" }));
    expect(s.store.getState().screen).toBe("result");
    expect(s.props.loadOpenedProject).not.toHaveBeenCalled();
  });

  it("the rough cut gets 打開資料夾 when the desktop can reveal a saved file", async () => {
    const revealInFolder = vi.fn(async () => undefined);
    const s = shell({ desktopApi: { revealInFolder } });
    expect(s.host.engine.formatStatus("vertical")).toBe("shorts-connecting");
    await s.host.engine.revealInFolder!({ path: "D:\\Videos\\IMG_3310.mp4" });
    expect(revealInFolder).toHaveBeenCalledWith("D:\\Videos\\IMG_3310.mp4");
  });

  it("forwards progress only into the running flow", () => {
    const progress: EasyProgress[] = [];
    const s = shell();
    void s.host.engine.start({ format: "horizontal", genre: "auto", title: "", description: "", video: { id: "missing", name: "x" }, styleVariant: 0 },
      item => progress.push(item), new AbortController().signal).catch(() => undefined);
    expect(s.pending()).toBeUndefined();
    expect(progress).toEqual([]);
  });
});

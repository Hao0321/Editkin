import { describe, expect, it, vi } from "vitest";
import { createDemoEasyEngine, createRoughCutEasyEngine, createUnavailableEasyEngine, EasyEngineError } from "./easyEngines";
import { createEasyFlowController } from "./easyFlowController";
import type { EasyChooseOutcome, EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore, type EasyAutoEditEngine, type EasyResult, type EasyVideo } from "./easyFlowModel";

const portrait: EasyVideo = { id: "asset-v", name: "IMG_4022.MOV", orientation: "portrait", durationSeconds: 42 };
const landscape: EasyVideo = { id: "asset-h", name: "IMG_3310.MOV", orientation: "landscape", durationSeconds: 95 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function setup(engine: EasyAutoEditEngine = createDemoEasyEngine({ previewUrl: "demo.mp4", wait: () => Promise.resolve() }),
  outcome: EasyChooseOutcome = { kind: "video", video: portrait }) {
  const store = createEasyFlowStore();
  const host: EasyFlowHost = {
    store, engine, picker: "dialog",
    chooseVideo: vi.fn(async () => outcome),
    discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn(),
  };
  return { store, host, controller: createEasyFlowController(host, () => 1_000) };
}

describe("easy flow controller", () => {
  it("asks for the kind of video first and does not open the chooser until then", async () => {
    const { store, host, controller } = setup();
    expect(controller.canChooseVideo()).toBe(false);
    await controller.chooseVideo();
    expect(host.chooseVideo).not.toHaveBeenCalled();
    expect(store.getState().formatHint).toBe(true);
    controller.chooseFormat("vertical");
    expect(controller.canChooseVideo()).toBe(true);
  });

  it("walks the whole template flow: video → genre → title → working → result → saved", async () => {
    const { store, host, controller } = setup();
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    expect(store.getState()).toMatchObject({ screen: "genre", video: portrait });
    controller.chooseGenre("travel");
    controller.confirmGenre();
    expect(store.getState().screen).toBe("title");
    expect(controller.submitTitle()).toBe(false);
    expect(store.getState()).toMatchObject({ screen: "title", titleError: true });
    controller.setTitle("其實是來看水簾的");
    expect(controller.submitTitle()).toBe(true);
    expect(store.getState().screen).toBe("working");
    await flush();
    expect(store.getState()).toMatchObject({ screen: "result", result: { orientation: "vertical", previewUrl: "demo.mp4" } });
    await controller.save();
    expect(store.getState()).toMatchObject({ screen: "saved", saved: { fileName: "其實是來看水簾的.mp4", inVideosFolder: true } });
    expect(controller.canReveal()).toBe(true);
    controller.startOver();
    expect(host.discardVideo).toHaveBeenCalledTimes(1);
    expect(store.getState().screen).toBe("home");
  });

  it("never starts the engine without a title", async () => {
    const engine = createDemoEasyEngine({ previewUrl: "x", wait: () => Promise.resolve() });
    const start = vi.spyOn(engine, "start");
    const { controller } = setup(engine);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    controller.confirmGenre();
    controller.setTitle("   ");
    controller.submitTitle();
    expect(start).not.toHaveBeenCalled();
  });

  it("shows the honest screen, not progress, when no engine can edit the video", async () => {
    const engine = createUnavailableEasyEngine("needs-desktop");
    const start = vi.spyOn(engine, "start");
    const { store, controller } = setup(engine);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    expect(store.getState()).toMatchObject({ screen: "unavailable", unavailable: "needs-desktop", run: undefined, result: undefined });
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps vertical Shorts honest on the desktop of today and opens the editor with the video", async () => {
    const roughCut = createRoughCutEasyEngine({ start: vi.fn(), render: vi.fn() });
    const { store, host, controller } = setup(roughCut);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    expect(store.getState()).toMatchObject({ screen: "unavailable", unavailable: "shorts-connecting" });
    controller.openEditor();
    expect(host.leaveToEditor).toHaveBeenCalledTimes(1);
  });

  it("starts the rough cut straight from the genre screen, since it writes no title", async () => {
    const start = vi.fn(async (_brief: unknown, onStage: (stage: 1 | 2 | 3 | 4) => void) => { onStage(1); onStage(2); return { ok: true as const, segmentCount: 3, addedCaptions: 8, music: true }; });
    const { store, controller } = setup(createRoughCutEasyEngine({ start, render: vi.fn() }), { kind: "video", video: landscape });
    controller.chooseFormat("horizontal");
    await controller.chooseVideo();
    expect(store.getState().plan?.needsTitle).toBe(false);
    controller.confirmGenre();
    expect(store.getState().screen).toBe("working");
    await flush();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ format: "horizontal", genre: "auto", video: landscape }), expect.any(Function));
    expect(store.getState()).toMatchObject({ screen: "result", result: { summary: { segments: 3, captions: 8, music: true } } });
  });

  it("reports chooser problems in place and says nothing when the chooser was closed", async () => {
    for (const [outcome, kind] of [[{ kind: "not-video" }, "not-video"], [{ kind: "too-many" }, "too-many"], [{ kind: "failed", detail: "bad file" }, "import-failed"]] as const) {
      const { store, controller } = setup(undefined, outcome);
      controller.chooseFormat("vertical");
      await controller.chooseVideo();
      expect(store.getState()).toMatchObject({ screen: "home", picking: false, pickProblem: { kind } });
    }
    const { store, controller } = setup(undefined, { kind: "nothing" });
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    expect(store.getState()).toMatchObject({ screen: "home", picking: false, pickProblem: undefined });
  });

  it("puts the video away again when going back to the start", async () => {
    const { store, host, controller } = setup();
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    controller.back();
    expect(host.discardVideo).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ screen: "home", format: "vertical" });
    expect(store.getState().video).toBeUndefined();
  });

  it("shows a failure with its reason and can try again", async () => {
    const engine = createDemoEasyEngine({ previewUrl: "x", failAtStep: 1, wait: () => Promise.resolve() });
    const { store, controller } = setup(engine);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    controller.confirmGenre();
    controller.setTitle("標題");
    controller.submitTitle();
    await flush();
    expect(store.getState()).toMatchObject({ screen: "failed", failure: { kind: "engine-failed", detail: "這次沒有剪成功。" } });
    controller.retry();
    expect(store.getState().screen).toBe("working");
  });

  it("stops a run and ignores anything it reports afterwards", async () => {
    let report: ((step: 0 | 1 | 2 | 3) => void) | undefined;
    const engine = createDemoEasyEngine({ previewUrl: "x" });
    engine.start = vi.fn((_brief, onProgress) => { report = step => onProgress({ step, fraction: 0 }); return new Promise<EasyResult>(() => undefined); });
    const { store, controller } = setup(engine);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    controller.confirmGenre();
    controller.setTitle("標題");
    controller.submitTitle();
    controller.cancelRun();
    expect(store.getState().screen).toBe("title");
    report?.(2);
    expect(store.getState().run).toBeUndefined();
  });

  it("re-runs with the next style and with edited words", async () => {
    const engine = createDemoEasyEngine({ previewUrl: "x", wait: () => Promise.resolve() });
    const start = vi.spyOn(engine, "start");
    const { store, controller } = setup(engine);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    controller.confirmGenre();
    controller.setTitle("第一版");
    controller.submitTitle();
    await flush();
    controller.restyle();
    await flush();
    expect(start.mock.calls.at(-1)?.[0]).toMatchObject({ title: "第一版", styleVariant: 1 });
    controller.editText();
    expect(store.getState().screen).toBe("title");
    controller.setTitle("第二版");
    controller.submitTitle();
    await flush();
    expect(start.mock.calls.at(-1)?.[0]).toMatchObject({ title: "第二版", styleVariant: 1 });
    expect(store.getState().screen).toBe("result");
  });

  it("keeps the result when saving is cancelled or fails", async () => {
    const engine = createDemoEasyEngine({ previewUrl: "x", wait: () => Promise.resolve() });
    const { store, controller } = setup(engine);
    controller.chooseFormat("vertical");
    await controller.chooseVideo();
    controller.confirmGenre();
    controller.setTitle("標題");
    controller.submitTitle();
    await flush();
    engine.saveVideo = vi.fn(async () => undefined);
    await controller.save();
    expect(store.getState()).toMatchObject({ screen: "result", saveProblem: undefined });
    engine.saveVideo = vi.fn(async () => { throw new Error("disk full"); });
    await controller.save();
    expect(store.getState()).toMatchObject({ screen: "result", saveProblem: { kind: "save-failed", detail: "disk full" } });
  });

  describe("template Shorts", () => {
    const storyPlan = { needsTitle: true, copy: "story" as const, steps: ["a", "b", "c", "d"] as const, canRestyle: false, canEditText: true,
      rendersPreview: true, canCancel: true };
    const storyEngine = (rights?: EasyAutoEditEngine["rights"]): EasyAutoEditEngine => ({
      ...createDemoEasyEngine({ previewUrl: "x", wait: () => Promise.resolve() }), check: () => ({ ok: true, plan: storyPlan }), ...(rights ? { rights } : {}),
    });

    it("a rights check that fails is an honest screen, not a question", async () => {
      const { store, controller } = setup(storyEngine({ status: async () => { throw new Error("IPC"); }, confirm: vi.fn() }));
      controller.chooseFormat("vertical");
      await controller.chooseVideo();
      expect(store.getState()).toMatchObject({ screen: "unavailable", unavailable: "check-failed" });
    });

    it("a refused confirmation stays on the question with its reason; going back puts the video away", async () => {
      const confirm = vi.fn(async () => { throw new Error("disk is read-only"); });
      const { store, host, controller } = setup(storyEngine({ status: async () => ({ kind: "ask", scope: { name: "videos", kind: "folder" } }), confirm }));
      controller.chooseFormat("vertical");
      await controller.chooseVideo();
      await controller.confirmRights();
      expect(store.getState()).toMatchObject({ screen: "rights", rights: { busy: false, problem: { kind: "rights-failed", detail: "disk is read-only" } } });
      controller.back();
      expect(host.discardVideo).toHaveBeenCalledTimes(1);
      expect(store.getState()).toMatchObject({ screen: "home", format: "vertical" });
    });

    it("words that cannot go on screen never leave the screen; fewer than two points ask for more", async () => {
      const engine = storyEngine();
      const start = vi.spyOn(engine, "start");
      const { store, controller } = setup(engine);
      controller.chooseFormat("vertical");
      await controller.chooseVideo();
      controller.confirmGenre();
      expect(store.getState().screen).toBe("hook");
      controller.setHook("來看・蝙蝠");
      expect(controller.submitHook()).toBe(false);
      expect(store.getState().screen).toBe("hook");
      controller.setHook("");
      expect(controller.submitHook()).toBe(true); // nothing written is the same as skipping
      expect(store.getState()).toMatchObject({ screen: "title", hookSkipped: true });
      controller.setTitle("其實🎬");
      expect(controller.submitTitle()).toBe(false);
      controller.setTitle("其實是來看水簾的");
      expect(controller.submitTitle()).toBe(true);
      expect(store.getState().screen).toBe("points");
      controller.setPoint(0, "洞頂滴水");
      expect(controller.submitPoints()).toBe(false);
      expect(store.getState().pointsError).toBe(true);
      controller.setPoint(1, "步道好走");
      expect(controller.submitPoints()).toBe(true);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ title: "其實是來看水簾的", points: ["洞頂滴水", "步道好走"] }), expect.any(Function), expect.anything());
    });

    it("an engine failure with a plain reason keeps that reason for the failure screen", async () => {
      const engine = storyEngine();
      engine.start = vi.fn(async () => { throw new EasyEngineError("Q3_safe_area", "words"); });
      const { store, controller } = setup(engine);
      controller.chooseFormat("vertical");
      await controller.chooseVideo();
      controller.confirmGenre();
      controller.skipHook();
      controller.setTitle("標題");
      controller.submitTitle();
      controller.setPoint(0, "一");
      controller.setPoint(1, "二");
      controller.submitPoints();
      await flush();
      expect(store.getState()).toMatchObject({ screen: "failed", failure: { kind: "words", detail: "Q3_safe_area" } });
      controller.editText();
      expect(store.getState().screen).toBe("hook");
    });
  });

  it("leaves for the editor, the workspace or an earlier project through the host only", () => {
    const { host, controller } = setup();
    controller.openEditor();
    controller.openWorkspace();
    controller.openProject();
    expect(host.leaveToEditor).toHaveBeenCalledTimes(1);
    expect(host.openWorkspace).toHaveBeenCalledTimes(1);
    expect(host.openProject).toHaveBeenCalledTimes(1);
  });
});

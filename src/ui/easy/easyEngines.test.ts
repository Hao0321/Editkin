import { describe, expect, it, vi } from "vitest";
import { combineEasyEngines, createDemoEasyEngine, createRoughCutEasyEngine, createUnavailableEasyEngine, EasyEngineError, ROUGH_CUT_STEPS, savedVideoFromPath, TEMPLATE_STEPS, type RoughCutBridge } from "./easyEngines";
import { readEasyDemoSwitch } from "./easyFlowHost";
import type { EasyBrief, EasyProgress, EasyVideo } from "./easyFlowModel";

const landscape: EasyVideo = { id: "a", name: "IMG_3310.MOV", orientation: "landscape" };
const portrait: EasyVideo = { id: "b", name: "IMG_4022.MOV", orientation: "portrait" };
const brief = (video: EasyVideo, format: EasyBrief["format"] = "horizontal"): EasyBrief => ({ format, genre: "travel", title: "標題", description: "", video, styleVariant: 0 });
const signal = () => new AbortController().signal;

function bridge(overrides: Partial<RoughCutBridge> = {}): RoughCutBridge {
  return {
    start: vi.fn(async (_brief, onStage) => { onStage(1); onStage(2); onStage(3); onStage(4); return { ok: true as const, segmentCount: 5, addedCaptions: 12, music: false }; }),
    render: vi.fn(async () => ({ canceled: false, outputPath: "D:\\Videos\\IMG_3310.mp4" })),
    ...overrides,
  };
}

describe("rough-cut engine (desktop today)", () => {
  it("admits only horizontal footage and says vertical Shorts are still being connected", () => {
    const engine = createRoughCutEasyEngine(bridge());
    expect(engine.formatStatus("vertical")).toBe("shorts-connecting");
    expect(engine.formatStatus("horizontal")).toBe("ready");
    expect(engine.check("vertical", landscape)).toEqual({ ok: false, reason: "shorts-connecting" });
    expect(engine.check("horizontal", portrait)).toEqual({ ok: false, reason: "video-not-horizontal" });
    expect(engine.check("horizontal", { ...landscape, orientation: "square" })).toEqual({ ok: false, reason: "video-not-horizontal" });
    expect(engine.check("horizontal", { ...landscape, orientation: undefined })).toEqual({ ok: false, reason: "video-not-horizontal" });
  });

  it("describes what it really does: no title on screen, no rendered preview, no restyle, honest steps", () => {
    const check = createRoughCutEasyEngine(bridge()).check("horizontal", landscape);
    expect(check.ok && check.plan).toMatchObject({ needsTitle: false, rendersPreview: false, canRestyle: false, canEditText: false, canCancel: false, steps: ROUGH_CUT_STEPS });
    expect(check.ok && check.plan.estimateSeconds).toBeUndefined();
  });

  it("maps the rough cut's four stages to the four steps and reports what it made", async () => {
    const progress: EasyProgress[] = [];
    const result = await createRoughCutEasyEngine(bridge()).start(brief(landscape), item => progress.push(item), signal());
    expect(progress.map(item => item.step)).toEqual([0, 1, 2, 3]);
    expect(result).toEqual({ orientation: "horizontal", flags: [], summary: { segments: 5, captions: 12, music: false } });
  });

  it("turns a refused or failed rough cut into an error with its reason", async () => {
    const failing = createRoughCutEasyEngine(bridge({ start: async () => ({ ok: false, reason: "failed", message: "智慧成片失敗：decoder" }) }));
    await expect(failing.start(brief(landscape), () => undefined, signal())).rejects.toThrow("智慧成片失敗：decoder");
    const stale = createRoughCutEasyEngine(bridge({ start: async () => ({ ok: false, reason: "stale" }) }));
    await expect(stale.start(brief(landscape), () => undefined, signal())).rejects.toBeInstanceOf(EasyEngineError);
  });

  it("saves through the desktop render and treats a closed save dialog as nothing saved", async () => {
    expect(await createRoughCutEasyEngine(bridge()).saveVideo({ orientation: "horizontal", flags: [] }, brief(landscape)))
      .toEqual({ path: "D:\\Videos\\IMG_3310.mp4", fileName: "IMG_3310.mp4", folderName: "Videos" });
    expect(await createRoughCutEasyEngine(bridge({ render: async () => ({ canceled: true }) })).saveVideo({ orientation: "horizontal", flags: [] }, brief(landscape))).toBeUndefined();
    await expect(createRoughCutEasyEngine(bridge({ render: async () => ({ canceled: false }) })).saveVideo({ orientation: "horizontal", flags: [] }, brief(landscape))).rejects.toThrow();
  });

  it("does not pretend it can open the folder, and opens it when the desktop can", async () => {
    expect(createRoughCutEasyEngine(bridge()).revealInFolder).toBeUndefined();
    expect(savedVideoFromPath("C:/Media/x/Videos/a.mp4")).toEqual({ path: "C:/Media/x/Videos/a.mp4", fileName: "a.mp4", folderName: "Videos" });
    const reveal = vi.fn(async () => undefined);
    await createRoughCutEasyEngine(bridge({ reveal })).revealInFolder!({ path: "D:\\Videos\\IMG_3310.mp4" });
    expect(reveal).toHaveBeenCalledWith("D:\\Videos\\IMG_3310.mp4");
  });
});

describe("one engine per kind of video", () => {
  it("sends vertical to the vertical engine and horizontal to the rough cut; rights are asked for vertical only", async () => {
    const rough = createRoughCutEasyEngine(bridge());
    const confirm = vi.fn(async () => undefined);
    const vertical = { ...createDemoEasyEngine({ previewUrl: "short.mp4", wait: () => Promise.resolve() }),
      rights: { status: vi.fn(async () => ({ kind: "ask" as const, scope: { name: "videos", kind: "folder" as const } })), confirm } };
    const engine = combineEasyEngines({ horizontal: rough, vertical });
    expect(engine.formatStatus("vertical")).toBe("ready");
    expect(engine.formatStatus("horizontal")).toBe("ready");
    expect(engine.check("horizontal", portrait)).toEqual({ ok: false, reason: "video-not-horizontal" });
    expect(engine.check("vertical", portrait).ok).toBe(true);
    expect(await engine.rights!.status("horizontal", landscape)).toEqual({ kind: "confirmed" });
    expect(await engine.rights!.status("vertical", portrait)).toMatchObject({ kind: "ask" });
    expect(await engine.start(brief(portrait, "vertical"), () => undefined, signal())).toMatchObject({ previewUrl: "short.mp4" });
    expect(await engine.start(brief(landscape), () => undefined, signal())).toMatchObject({ summary: { segments: 5 } });
    await engine.rights!.confirm(portrait, { brandName: "" });
    expect(confirm).toHaveBeenCalledTimes(1);
    const alone = combineEasyEngines({ horizontal: rough });
    expect(alone.formatStatus("vertical")).toBe("shorts-connecting");
    expect(alone.rights).toBeUndefined();
    expect(alone.revealInFolder).toBeUndefined();
  });
});

describe("no engine", () => {
  it("never starts and gives the same honest reason for every choice", async () => {
    const engine = createUnavailableEasyEngine("needs-desktop");
    expect(engine.formatStatus("vertical")).toBe("needs-desktop");
    expect(engine.check("horizontal", landscape)).toEqual({ ok: false, reason: "needs-desktop" });
    await expect(engine.start(brief(landscape), () => undefined, signal())).rejects.toBeInstanceOf(EasyEngineError);
  });
});

describe("dev-only demo engine", () => {
  const instant = () => Promise.resolve();
  it("walks all four template steps and returns the preview, with an art flag when asked", async () => {
    const progress: EasyProgress[] = [];
    const engine = createDemoEasyEngine({ previewUrl: "demo.mp4", flags: true, wait: instant });
    const check = engine.check("vertical", portrait);
    expect(check.ok && check.plan).toMatchObject({ needsTitle: true, steps: TEMPLATE_STEPS, rendersPreview: true, canRestyle: true, canEditText: true });
    const result = await engine.start(brief(portrait, "vertical"), item => progress.push(item), signal());
    expect(progress.at(-1)).toEqual({ step: 3, fraction: 1 });
    expect(result).toEqual({ orientation: "vertical", previewUrl: "demo.mp4", flags: [{ second: 3, kind: "text-cut" }] });
    expect(await engine.saveVideo(result, brief(portrait, "vertical"))).toEqual({ fileName: "標題.mp4", inVideosFolder: true });
  });

  it("stops when asked and can fail on purpose for the failure screen", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createDemoEasyEngine({ previewUrl: "x", stepMs: 10 }).start(brief(portrait), () => undefined, controller.signal)).rejects.toThrow();
    await expect(createDemoEasyEngine({ previewUrl: "x", failAtStep: 2, wait: instant }).start(brief(portrait), () => undefined, signal())).rejects.toThrow("這次沒有剪成功。");
  });

  it("is reachable only through the explicit dev switch", () => {
    expect(readEasyDemoSwitch("?easyDemo=1", true)).toBe("plain");
    expect(readEasyDemoSwitch("?easyDemo=flags", true)).toBe("flags");
    expect(readEasyDemoSwitch("?easyDemo=today", true)).toBe("today");
    expect(readEasyDemoSwitch("?easyDemo=browser", true)).toBe("browser");
    expect(readEasyDemoSwitch("?easyDemo=fail", true)).toBe("fail");
    expect(readEasyDemoSwitch("", true)).toBeUndefined();
    expect(readEasyDemoSwitch("?easyDemo=toString", true)).toBeUndefined();
    expect(readEasyDemoSwitch("?easyDemo=1", false)).toBeUndefined();
  });
});

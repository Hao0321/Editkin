import { describe, expect, it, vi } from "vitest";
import type { TemplateShortJobStatus } from "../../desktop/templateShortTypes";
import type { TemplateShortInAppResult } from "../../service/templateShortService";
import { EasyEngineError } from "./easyEngines";
import { createEasyFlowController } from "./easyFlowController";
import type { EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore, type EasyBrief, type EasyProgress, type EasyVideo } from "./easyFlowModel";
import {
  EASY_TEMPLATE_GENRES, TEMPLATE_SHORT_STEPS, createTemplateShortEasyEngine, templateShortApiOf, templateShortCopyOf, templateShortEasyResult,
  templateShortFlags, templateShortProblemKind, type TemplateShortEngineApi,
} from "./templateShortEngine";

const video: EasyVideo = { id: "asset-1", name: "IMG_4022.MOV", orientation: "portrait", durationSeconds: 42 };
const SOURCE = "D:\\Creator\\videos\\_INBOX\\IMG_4022.MOV";
const brief = (overrides: Partial<EasyBrief> = {}): EasyBrief => ({ format: "vertical", genre: "travel", title: "其實是來看水簾的", description: "", video, styleVariant: 0,
  hook: "來看蝙蝠", ...overrides });
const delivered = (overrides: Partial<TemplateShortInAppResult> = {}): TemplateShortInAppResult => ({ schema: "editkin.template-short-in-app/v1", status: "READY",
  delivered: true, shortId: "ts-20261010-img-4022-3f9a1c", runDir: "videos/_AUTOPILOT/editkin-short/20261010-img-4022-3f9a1c",
  outputPath: "videos/_AUTOPILOT/editkin-short/20261010-img-4022-3f9a1c/output.mp4", outputSha256: "a".repeat(64),
  window: { start: 0, end: 15, seconds: 15, clamped: true }, flags: [], ...overrides });
const finished = (result: TemplateShortInAppResult, extra: Partial<TemplateShortJobStatus> = {}): TemplateShortJobStatus => ({ jobId: "job-1", phase: "finished", step: 3,
  fraction: 1, result, ...(result.delivered ? { outputPath: "D:\\run\\output.mp4", outputUrl: "asset://run/output.mp4" } : {}), ...extra });
const instant = () => Promise.resolve();

function fakeApi(statuses: TemplateShortJobStatus[], overrides: Partial<TemplateShortEngineApi> = {}) {
  const queue = [...statuses];
  const api = {
    templateShortPrepare: vi.fn(async () => ({ workspaceFound: true, defaults: "missing" as const, scope: { name: "videos", kind: "folder" as const }, source: "videos/_INBOX/IMG_4022.MOV" })),
    templateShortConfirmRights: vi.fn(async () => ({ written: true, exists: true })),
    templateShortStart: vi.fn(async () => ({ jobId: "job-1" })),
    templateShortStatus: vi.fn(async () => queue.length > 1 ? queue.shift()! : queue[0]),
    templateShortCancel: vi.fn(async (jobId: string) => ({ jobId, canceled: true })),
    templateShortSaveVideo: vi.fn(async (_jobId: string, name: string) => ({ path: `C:\\Users\\a\\Videos\\${name}.mp4`, fileName: `${name}.mp4`, folderName: "Videos" })),
    revealInFolder: vi.fn(async () => undefined),
  };
  return Object.assign(api, overrides) as typeof api;
}
const engineOf = (api: TemplateShortEngineApi, sourcePath: string | undefined = SOURCE) =>
  createTemplateShortEasyEngine(api, { sourcePathOf: () => sourcePath, wait: instant, pollMs: 1 });
const signal = () => new AbortController().signal;

describe("template Short engine: what it offers", () => {
  it("is a vertical engine for videos on this computer of at least 5 seconds, with honest steps and no restyle", () => {
    const engine = engineOf(fakeApi([]));
    const check = engine.check("vertical", video);
    expect(check.ok && check.plan).toMatchObject({ needsTitle: true, copy: "story", steps: TEMPLATE_SHORT_STEPS, rendersPreview: true, canCancel: true,
      canEditText: true, canRestyle: false });
    expect(check.ok && check.plan.estimateSeconds).toBeUndefined();
    expect(engine.check("vertical", { ...video, durationSeconds: 4.9 })).toEqual({ ok: false, reason: "video-too-short" });
    expect(createTemplateShortEasyEngine(fakeApi([]), { sourcePathOf: () => undefined }).check("vertical", video)).toEqual({ ok: false, reason: "needs-desktop" });
    expect(engine.check("horizontal", video)).toEqual({ ok: false, reason: "needs-desktop" });
    expect(TEMPLATE_SHORT_STEPS).toEqual(["看你的影片", "加上標題和動畫", "做成影片", "最後檢查一次"]);
  });

  it("maps genres: 旅遊/美食 to the travel theme, the others to their own, 生活 and 讓電腦幫我選 to the engine's first theme", () => {
    expect(EASY_TEMPLATE_GENRES).toEqual({ travel: "travel", food: "food", teaching: "teaching", unboxing: "unboxing", game: "game", life: "knowledge", auto: "knowledge" });
  });

  it("takes the creator's words exactly: 原本以為 → 其實是, or 2–4 points; never invents any", () => {
    expect(templateShortCopyOf(brief())).toEqual({ payoff: "其實是來看水簾的", hook: "來看蝙蝠" });
    expect(templateShortCopyOf(brief({ hook: undefined, points: [" 洞頂滴水 ", "步道好走"] }))).toEqual({ payoff: "其實是來看水簾的", points: ["洞頂滴水", "步道好走"] });
    expect(() => templateShortCopyOf(brief({ hook: undefined, points: ["一個"] }))).toThrow(EasyEngineError);
    expect(() => templateShortCopyOf(brief({ title: "  " }))).toThrow("先寫一句大標題。");
  });

  it("is available only when the desktop offers every command it needs", () => {
    const api = fakeApi([]);
    expect(templateShortApiOf(undefined)).toBeUndefined();
    expect(templateShortApiOf({ ...api, templateShortCancel: undefined })).toBeUndefined();
    expect(Object.keys(templateShortApiOf(api)!).sort()).toEqual(Object.keys(api).sort());
  });
});

describe("template Short engine: the one-time rights question", () => {
  it("asks only when the defaults file is missing, refuses a video outside the work folder, and confirms only on request", async () => {
    const api = fakeApi([]);
    const engine = engineOf(api);
    expect(await engine.rights!.status("vertical", video)).toEqual({ kind: "ask", scope: { name: "videos", kind: "folder" } });
    expect(api.templateShortPrepare).toHaveBeenCalledWith(SOURCE);
    expect(api.templateShortConfirmRights).not.toHaveBeenCalled();
    api.templateShortPrepare.mockResolvedValueOnce({ workspaceFound: true, defaults: "present" as never, scope: { name: "videos", kind: "folder" }, source: "x" });
    expect(await engine.rights!.status("vertical", video)).toEqual({ kind: "confirmed" });
    api.templateShortPrepare.mockResolvedValueOnce({ workspaceFound: false } as never);
    expect(await engine.rights!.status("vertical", video)).toEqual({ kind: "unavailable", reason: "outside-workspace" });
    await engine.rights!.confirm(video, { brandName: "  " });
    expect(api.templateShortConfirmRights).toHaveBeenLastCalledWith(SOURCE, undefined);
    await engine.rights!.confirm(video, { brandName: " 小明 " });
    expect(api.templateShortConfirmRights).toHaveBeenLastCalledWith(SOURCE, "小明");
    api.templateShortConfirmRights.mockResolvedValueOnce({ written: false, exists: false });
    await expect(engine.rights!.confirm(video, { brandName: "" })).rejects.toThrow("沒有記下來。");
  });
});

describe("template Short engine: a run", () => {
  it("starts with the source and the creator's words, reports the real steps and returns the delivered Short", async () => {
    const api = fakeApi([
      { jobId: "job-1", phase: "running", step: 0, fraction: 0.35 },
      { jobId: "job-1", phase: "running", step: 2, fraction: 0.05, shortId: "ts-20261010-img-4022-3f9a1c" },
      finished(delivered({ status: "NEEDS_FIX", flags: [{ check: "Q8_stall", seconds: [3.7] }, { check: "Q7_text_overlap", seconds: [5.2, 5.9] }] })),
    ]);
    const progress: EasyProgress[] = [];
    const result = await engineOf(api).start(brief(), item => progress.push(item), signal());
    expect(api.templateShortStart).toHaveBeenCalledWith({ sourcePath: SOURCE, genre: "travel", copy: { payoff: "其實是來看水簾的", hook: "來看蝙蝠" } });
    expect(progress.map(item => item.step)).toEqual([0, 2, 3]);
    expect(result).toEqual({ orientation: "vertical", videoPath: "D:\\run\\output.mp4", previewUrl: "asset://run/output.mp4", handle: "job-1",
      flags: [{ second: 3, kind: "stutter" }, { second: 5, kind: "text-overlap" }], usedRange: { seconds: 15, clamped: true }, review: true });
  });

  it("asks for a look before saving whenever the style is not certified, and for every genre outside 旅遊/美食", () => {
    expect(templateShortEasyResult(finished(delivered({ status: "READY" })), "travel").review).toBe(false);
    expect(templateShortEasyResult(finished(delivered({ status: "SPOT_CHECK_DUE" })), "food").review).toBe(false);
    expect(templateShortEasyResult(finished(delivered({ status: "REVIEW_REQUIRED" })), "travel").review).toBe(true);
    for (const genre of ["life", "auto", "teaching", "unboxing", "game"] as const) {
      expect(templateShortEasyResult(finished(delivered({ status: "READY" })), genre).review, genre).toBe(true);
    }
  });

  it("stops: 停下來 cancels the desktop job and ignores what comes after", async () => {
    const controller = new AbortController();
    const api = fakeApi([{ jobId: "job-1", phase: "running", step: 1, fraction: 0.2 }]);
    const engine = createTemplateShortEasyEngine(api, { sourcePathOf: () => SOURCE, pollMs: 5 });
    const running = engine.start(brief(), () => undefined, controller.signal);
    await vi.waitFor(() => expect(api.templateShortStatus).toHaveBeenCalled());
    controller.abort();
    await expect(running).rejects.toThrow("已停止");
    expect(api.templateShortCancel).toHaveBeenCalledWith("job-1");
  });

  it("the desktop's no-progress watchdog becomes the plain 「很久都沒有進展」 failure", async () => {
    const api = fakeApi([{ jobId: "job-1", phase: "interrupted", step: 2, fraction: 0.1, error: "超過 5 分鐘沒有任何進展，已經停下這個工作" }]);
    const error = await engineOf(api).start(brief(), () => undefined, signal()).catch(caught => caught);
    expect(error).toBeInstanceOf(EasyEngineError);
    expect(error).toMatchObject({ kind: "stalled", message: "超過 5 分鐘沒有任何進展，已經停下這個工作" });
  });

  it("BLOCK reasons become the matching honest screens; a child failure stays a plain failure with its reason", async () => {
    const reasons: Array<[Partial<TemplateShortInAppResult>, string]> = [
      [{ status: "BLOCK_DISK", block: { code: "BLOCK_DISK", detail: "D: 只剩 0.5 GB" } }, "no-space"],
      [{ status: "BLOCK_START", block: { code: "BLOCK_START", detail: "找不到 .autopilot/template-short-defaults.json", field: "defaults" } }, "settings"],
      [{ status: "BLOCK_START", block: { code: "BLOCK_START", detail: "不在已宣告為自有素材的範圍", field: "source.path" } }, "not-allowed"],
      [{ status: "BLOCK_COPY_GLYPH", block: { code: "BLOCK_COPY_GLYPH", detail: "hook 第 3 字『・』字型不支援", field: "copy.hook" } }, "words"],
      [{ status: "BLOCK_BRIEF", block: { code: "BLOCK_BRIEF", detail: "copy.payoff 最多 32 字", field: "copy.payoff" } }, "words"],
      [{ status: "BLOCK_TEMPLATE_QA", block: { code: "BLOCK_TEMPLATE_QA", detail: "Q3_safe_area（headline:0）：超出安全範圍" } }, "words"],
      [{ status: "BLOCK_TEMPLATE", block: { code: "BLOCK_TEMPLATE", detail: "主標太長，影像區塊沒有足夠空間；請縮短文字" } }, "words"],
      [{ status: "BLOCK_AUDIT", block: { code: "BLOCK_AUDIT", detail: "Current design projectSha256 changed" } }, "engine-failed"],
      [{ status: "RENDER_FAILED_PROJECT_APPLIED", detail: "R1 技術檢查失敗" }, "engine-failed"],
    ];
    for (const [overrides, kind] of reasons) {
      const result = { ...delivered(), delivered: false, outputPath: undefined, ...overrides } as TemplateShortInAppResult;
      expect(templateShortProblemKind(result), String(overrides.status)).toBe(kind);
      const error = await engineOf(fakeApi([finished(result)])).start(brief(), () => undefined, signal()).catch(caught => caught);
      expect(error).toMatchObject({ kind, message: overrides.block?.detail ?? overrides.detail });
    }
    const crashed = await engineOf(fakeApi([{ jobId: "job-1", phase: "failed", step: 1, fraction: 0, error: "自動剪輯子程序沒有回傳結果" }]))
      .start(brief(), () => undefined, signal()).catch(caught => caught);
    expect(crashed).toMatchObject({ message: "自動剪輯子程序沒有回傳結果", kind: undefined });
  });

  it("a status that cannot be read a few times in a row fails the run instead of waiting forever", async () => {
    const api = fakeApi([], { templateShortStatus: vi.fn(async () => { throw new Error("IPC closed"); }) });
    const engine = createTemplateShortEasyEngine(api, { sourcePathOf: () => SOURCE, wait: instant, maxStatusFailures: 3 });
    await expect(engine.start(brief(), () => undefined, signal())).rejects.toThrow("讀不到剪輯進度：IPC closed");
    expect(api.templateShortStatus).toHaveBeenCalledTimes(3);
  });

  it("flags become at most six whole-second rows, one per second and kind", () => {
    expect(templateShortFlags([{ check: "Q8_stall", seconds: [3.7, 3.2, 3.9] }, { check: "Q9_first_frame", seconds: [0] }, { check: "R3_stall", seconds: [Number.NaN, -1, 12.4] }]))
      .toEqual([{ second: 0, kind: "check-again" }, { second: 3, kind: "stutter" }, { second: 12, kind: "stutter" }]);
    expect(templateShortFlags([{ check: "Q10_footage_share", seconds: [1, 2, 3, 4, 5, 6, 7, 8] }])).toHaveLength(6);
  });

  it("saves under the creator's title into the Videos folder and opens that folder", async () => {
    const api = fakeApi([]);
    const engine = engineOf(api);
    const saved = await engine.saveVideo({ orientation: "vertical", flags: [], handle: "job-1" }, brief());
    expect(api.templateShortSaveVideo).toHaveBeenCalledWith("job-1", "其實是來看水簾的");
    expect(saved).toEqual({ path: "C:\\Users\\a\\Videos\\其實是來看水簾的.mp4", fileName: "其實是來看水簾的.mp4", folderName: "Videos", inVideosFolder: true });
    await engine.revealInFolder!(saved!);
    expect(api.revealInFolder).toHaveBeenCalledWith("C:\\Users\\a\\Videos\\其實是來看水簾的.mp4");
    await expect(engine.saveVideo({ orientation: "vertical", flags: [] }, brief())).rejects.toThrow(EasyEngineError);
  });
});

describe("template Short engine in the flow", () => {
  it("first time: video → rights → genre → 原本以為 → 其實是 → working → result → saved, with nothing written before the yes", async () => {
    const api = fakeApi([{ jobId: "job-1", phase: "running", step: 1, fraction: 0.5 }, finished(delivered({ status: "REVIEW_REQUIRED" }))]);
    const store = createEasyFlowStore();
    const host: EasyFlowHost = { store, engine: engineOf(api), picker: "dialog", chooseVideo: vi.fn(async () => ({ kind: "video" as const, video })),
      discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn() };
    const flow = createEasyFlowController(host, () => 1_000);
    flow.chooseFormat("vertical");
    await flow.chooseVideo();
    expect(store.getState()).toMatchObject({ screen: "rights", rights: { scope: { name: "videos" }, brandName: "" } });
    expect(api.templateShortConfirmRights).not.toHaveBeenCalled();
    await flow.confirmRights();
    expect(api.templateShortConfirmRights).toHaveBeenCalledTimes(1);
    flow.chooseGenre("food");
    flow.confirmGenre();
    flow.setHook("來看蝙蝠");
    expect(flow.submitHook()).toBe(true);
    expect(flow.submitTitle()).toBe(false);
    flow.setTitle("其實是來看水簾的");
    expect(flow.submitTitle()).toBe(true);
    await vi.waitFor(() => expect(store.getState().screen).toBe("result"));
    expect(api.templateShortStart).toHaveBeenCalledWith({ sourcePath: SOURCE, genre: "food", copy: { payoff: "其實是來看水簾的", hook: "來看蝙蝠" } });
    expect(store.getState().result).toMatchObject({ usedRange: { seconds: 15, clamped: true }, review: true, handle: "job-1" });
    await flow.save();
    expect(store.getState()).toMatchObject({ screen: "saved", saved: { inVideosFolder: true, fileName: "其實是來看水簾的.mp4" } });
    expect(flow.canReveal()).toBe(true);
  });
});

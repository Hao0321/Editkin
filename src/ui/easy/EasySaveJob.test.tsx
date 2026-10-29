// W2-4: simple mode's 「好了，存成影片」 shows the export job itself (step, measured percentage, remaining time, 停止存檔 with
// one question) and offers 播放 when it is saved; the editor's export panel stays out of the way for that job.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRenderJobForTest, setRenderJobForTest, type RenderJobState } from "../../desktop/renderJobStore";
import { ExportPanel } from "../export/ExportPanel";
import { createEasyFlowController } from "./easyFlowController";
import type { EasyFlowHost } from "./easyFlowHost";
import { createUnavailableEasyEngine } from "./easyEngines";
import { createEasyFlowStore, easyFlowReducer, initialEasyFlowState, type EasyFlowAction, type EasyFlowState, type EasySaveJob } from "./easyFlowModel";
import { EasyScreen, type EasySaveControls, type EasyScreenProps } from "./EasyScreens";
import { easySaveJobView } from "./useEasyFlowHost";

afterEach(() => resetRenderJobForTest());

const reduce = (state: EasyFlowState, ...actions: EasyFlowAction[]) => actions.reduce(easyFlowReducer, state);
const video = { id: "asset-h", name: "IMG_3310.MOV", orientation: "landscape" as const, durationSeconds: 95 };
const result = reduce(initialEasyFlowState(), { type: "choose-format", format: "horizontal" }, { type: "pick-started" },
  { type: "pick-finished", video, check: { ok: true, plan: { needsTitle: false, steps: ["a", "b", "c", "d"], canRestyle: false, canEditText: false, rendersPreview: false, canCancel: false } } },
  { type: "run-started", runId: 1, startedAt: 1_000 }, { type: "run-finished", runId: 1, result: { orientation: "horizontal", flags: [] } });
const saving = reduce(result, { type: "save-started" });
const savedWith = (url?: string) => reduce(saving, { type: "save-finished", saved: { path: "D:\\Videos\\IMG_3310.mp4", fileName: "IMG_3310.mp4", folderName: "Videos", ...(url ? { url } : {}) } });

function props(state: EasyFlowState, overrides: Partial<EasyScreenProps> = {}): EasyScreenProps {
  const store = createEasyFlowStore();
  const engine = createUnavailableEasyEngine("needs-desktop");
  const host: EasyFlowHost = { store, engine, picker: "dialog", chooseVideo: vi.fn(), discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn() };
  return { state, controller: createEasyFlowController(host), formatStatus: engine.formatStatus, videoUrls: {}, canReveal: true, picker: "dialog",
    onChooseVideo: vi.fn(), onFilesChosen: vi.fn(), onSeekPreview: vi.fn(), now: 66_000, ...overrides };
}
const controls = (job: EasySaveJob | undefined, confirmingStop = false): EasySaveControls => ({ job, confirmingStop, askStop: vi.fn(), keepSaving: vi.fn(), stop: vi.fn() });
const html = (state: EasyFlowState, overrides: Partial<EasyScreenProps> = {}) => renderToStaticMarkup(<EasyScreen {...props(state, overrides)} />);
function expand(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  if (typeof element.type === "function") return expand((element.type as (input: unknown) => ReactNode)(element.props));
  return [element, ...expand(element.props.children)];
}
const press = (state: EasyFlowState, overrides: Partial<EasyScreenProps>, testId: string) => {
  const found = expand(<EasyScreen {...props(state, overrides)} />).filter(element => element.props["data-testid"] === testId);
  expect(found, testId).toHaveLength(1);
  found[0].props.onClick();
};
const measured: EasySaveJob = { stage: "encode", fraction: 0.423, remainingMs: 150_000, runningSinceMs: 1_000, cancelRequested: false, canCancel: true };

describe("simple mode's 存成影片 as an export job", () => {
  it("shows the step, a measured percentage, the remaining time, the elapsed time and 停止存檔 (no primary button while waiting)", () => {
    const markup = html(saving, { save: controls(measured) });
    expect(markup).toContain("正在存成影片…");
    expect(markup).toContain("正在把畫面和聲音合成影片");
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain("42%");
    expect(markup).toContain("大約還要 3 分鐘");
    expect(markup).toContain("已經過 1 分 5 秒");
    expect(markup).toContain('data-testid="easy-save-stop"');
    expect(markup).toContain("easy-progress-measured");
    expect(markup).not.toContain("data-easy-primary");
  });

  it("never invents a number for a step the renderer cannot measure, and shows parts", () => {
    const markup = html(saving, { save: controls({ stage: "precompose", part: 2, parts: 3, runningSinceMs: 1_000, cancelRequested: false, canCancel: true }) });
    expect(markup).toContain("正在先做好預合成的片段");
    expect(markup).toContain("（第 2／3 段）");
    expect(markup).toContain("這一步算不出百分比，請稍候。");
    expect(markup).toContain("easy-progress-indeterminate");
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).not.toMatch(/\d+%/);
    // Before the first report (or a save that is not a render job): the plain waiting bar only, no stop button.
    const plain = html(saving, { save: controls(undefined) });
    expect(plain).toContain("easy-progress-indeterminate");
    expect(plain).not.toContain("easy-save-stop");
    expect(html(saving)).not.toContain("easy-save-stop");
  });

  it("asks once before stopping, stops only on the second press, and says it is stopping", () => {
    const ask = controls(measured);
    press(saving, { save: ask }, "easy-save-stop");
    expect(ask.askStop).toHaveBeenCalledTimes(1);
    expect(ask.stop).not.toHaveBeenCalled();
    const question = controls(measured, true);
    const markup = html(saving, { save: question });
    expect(markup).toContain("要停止存檔嗎？影片不會存下來，剪好的內容還在。");
    expect(markup).toContain('role="alertdialog"');
    press(saving, { save: question }, "easy-save-keep");
    expect(question.keepSaving).toHaveBeenCalledTimes(1);
    press(saving, { save: question }, "easy-save-stop-confirm");
    expect(question.stop).toHaveBeenCalledTimes(1);
    const stopping = html(saving, { save: controls({ ...measured, cancelRequested: true }, true) });
    expect(stopping).toContain("正在停止…");
    expect(stopping).toMatch(/data-testid="easy-save-stop"[^>]*disabled=""/);
    expect(html(saving, { save: controls({ ...measured, canCancel: false }) })).not.toContain("easy-save-stop");
  });

  it("offers 打開資料夾 first and 播放 for the saved file in the in-app player", () => {
    const onPlaySaved = vi.fn();
    const markup = html(savedWith("http://asset.localhost/IMG_3310.mp4?v=abc"), { onPlaySaved });
    expect(markup).toContain('data-testid="easy-saved-player"');
    expect(markup).toContain('src="http://asset.localhost/IMG_3310.mp4?v=abc"');
    expect(markup.indexOf("easy-reveal")).toBeLessThan(markup.indexOf("easy-play-saved"));
    expect(markup).toMatch(/class="easy-primary"[^>]*data-testid="easy-reveal"/);
    press(savedWith("http://asset.localhost/IMG_3310.mp4?v=abc"), { onPlaySaved }, "easy-play-saved");
    expect(onPlaySaved).toHaveBeenCalledTimes(1);
    const noUrl = html(savedWith(), { onPlaySaved });
    expect(noUrl).not.toContain("easy-saved-player");
    expect(noUrl).not.toContain("easy-play-saved");
  });
});

describe("the export job store as the saving screen sees it", () => {
  const job = (patch: Partial<RenderJobState>): RenderJobState => ({ id: "render-0123456789abcdef", kind: "video", phase: "running", presentation: "inline",
    runningSinceMs: 1_000, samples: [], cancelRequested: false, collapsed: false, ...patch });

  it("maps only inline running jobs, keeps unmeasured steps unmeasured, and lets the export panel step aside", () => {
    expect(easySaveJobView(job({ progress: { stage: "encode", fraction: 0.5 }, remainingMs: 60_000 }), true))
      .toEqual({ stage: "encode", fraction: 0.5, remainingMs: 60_000, runningSinceMs: 1_000, cancelRequested: false, canCancel: true });
    expect(easySaveJobView(job({ progress: { stage: "frames" }, remainingMs: 60_000 }), true)).toEqual({ stage: "frames", runningSinceMs: 1_000, cancelRequested: false, canCancel: true });
    expect(easySaveJobView(job({ phase: "choosing", runningSinceMs: undefined }), true)).toEqual({ cancelRequested: false, canCancel: false });
    expect(easySaveJobView(job({ presentation: undefined }), true)).toBeUndefined();
    expect(easySaveJobView(job({ phase: "done" }), true)).toBeUndefined();
    expect(easySaveJobView(job({}), false)?.canCancel).toBe(false);

    const api = { cancelRenderJob: vi.fn(), revealInFolder: vi.fn() };
    setRenderJobForTest(job({ progress: { stage: "encode", fraction: 0.5 } }));
    expect(renderToStaticMarkup(<ExportPanel api={api} />)).toBe("");
    setRenderJobForTest(job({ presentation: undefined, progress: { stage: "encode", fraction: 0.5 } }));
    expect(renderToStaticMarkup(<ExportPanel api={api} />)).toContain('data-testid="export-panel"');
  });
});

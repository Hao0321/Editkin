import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "./ExportPanel";
import { resetRenderJobForTest, setRenderJobForTest, type RenderJobState } from "../../desktop/renderJobStore";
import { describeProblem } from "../../application/plainProblems";

const api = { cancelRenderJob: vi.fn(), revealInFolder: vi.fn() };
const base: RenderJobState = { id: "render-0123456789abcdef", kind: "video", phase: "running", runningSinceMs: Date.now() - 65_000,
  outputPath: "D:\\Videos\\旅行 vlog.mp4", samples: [], cancelRequested: false, collapsed: false };
const html = (state: Partial<RenderJobState>) => {
  setRenderJobForTest({ ...base, ...state });
  return renderToStaticMarkup(<ExportPanel api={api} />);
};
afterEach(() => resetRenderJobForTest());

describe("export panel (plain words, one main action)", () => {
  it("shows nothing until the location was chosen", () => {
    expect(html({ phase: "choosing" })).toBe("");
    resetRenderJobForTest();
    expect(renderToStaticMarkup(<ExportPanel api={api} />)).toBe("");
  });

  it("shows the file, the four steps, a measured percentage and the remaining time", () => {
    const markup = html({ progress: { stage: "encode", fraction: .423, doneSeconds: 25.4, totalSeconds: 60 }, remainingMs: 150_000 });
    expect(markup).toContain("正在輸出影片");
    expect(markup).toContain("旅行 vlog.mp4");
    expect(markup).toContain("存放位置：D:\\Videos");
    expect(markup).toMatch(/<li class="done"[^>]*>.*?準備素材/);
    expect(markup).toMatch(/<li class="current" aria-current="step">.*?合成影片/);
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain(">42%<");
    expect(markup).toContain("大約還要 3 分鐘");
    expect(markup).toContain("已經過 1 分 5 秒");
    expect(markup).toContain('data-testid="export-panel-cancel"');
    expect(markup).not.toContain("export-panel-reveal");
  });

  it("never invents a number for a step it cannot measure", () => {
    const markup = html({ progress: { stage: "audio" } });
    expect(markup).toContain("正在處理聲音");
    expect(markup).toContain("這一步算不出百分比，請稍候。");
    expect(markup).toContain("export-panel-bar indeterminate");
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).not.toMatch(/\d+%</);
    const parts = html({ progress: { stage: "precompose", part: 2, parts: 3 } });
    expect(parts).toContain("（第 2／3 段）");
  });

  it("says when it is stopping, and shows a small chip when moved aside", () => {
    expect(html({ cancelRequested: true, progress: { stage: "encode" } })).toContain("正在停止…");
    const chip = html({ collapsed: true, progress: { stage: "encode", fraction: .5 } });
    expect(chip).toContain('data-testid="export-panel-chip"');
    expect(chip).toContain("輸出中 50%");
    expect(chip).not.toContain('data-testid="export-panel"');
  });

  it("offers 打開資料夾 first and 播放 when done", () => {
    const markup = html({ phase: "done", finishedAtMs: base.runningSinceMs! + 125_000, outputUrl: "http://asset.localhost/trip.mp4" });
    expect(markup).toContain("影片做好了！");
    expect(markup).toContain("花了 2 分 5 秒");
    expect(markup.indexOf("export-panel-reveal")).toBeLessThan(markup.indexOf("export-panel-play"));
    expect(markup).toMatch(/class="primary" data-testid="export-panel-reveal"/);
    expect(markup).toContain('data-testid="export-panel-close"');
    // A transparent ProRes master cannot be played in the app; only the folder is offered.
    expect(html({ phase: "done", kind: "alpha", outputUrl: undefined })).not.toContain("export-panel-play");
  });

  it("says a stop changed nothing, and a failure in plain words with the raw reason folded", () => {
    expect(html({ phase: "canceled" })).toContain("你的專案沒有改變，可以隨時再輸出一次。");
    const failed = html({ phase: "failed", problem: describeProblem("export", "ENOSPC: no space left on device"), retry: () => undefined });
    expect(failed).toContain("影片沒有輸出完成");
    expect(failed).toContain("存放的磁碟空間不夠了。");
    expect(failed).toContain("<summary>查看原因</summary><p>ENOSPC: no space left on device</p>");
    expect(failed).toContain('data-testid="export-panel-retry"');
  });
});

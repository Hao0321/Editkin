import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { OperationStatus } from "./OperationStatus";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { resetRenderJobForTest, setRenderJobForTest } from "../desktop/renderJobStore";
import { describeProblem } from "../application/plainProblems";

const summaryOf = (html: string) => html.match(/data-testid="operation-status-message"[^>]*>([^<]*)</)?.[1];
const ENGINE = "Resident output service 失敗：ENOSPC: no space left on device, write C:\\Users\\Hao\\Videos\\out.mp4 (h264_nvenc)";

afterEach(async () => {
  interfacePreferences.setMode("simple");
  await interfacePreferences.setLocale("zh-TW");
  resetRenderJobForTest();
});

describe("the footer status in simple mode", () => {
  it("says what happened in plain words and keeps the engine text only behind 「查看原因」", () => {
    interfacePreferences.setMode("simple");
    const html = renderToStaticMarkup(<OperationStatus status={ENGINE} runtimeInfo="桌面版" />);
    expect(summaryOf(html)).toBe("輸出失敗：存放的磁碟空間不夠了。");
    expect(html).toContain('data-testid="operation-status-advice"');
    expect(html).toContain("請刪掉一些用不到的大檔案，或換一個空間夠的磁碟，再試一次。");
    // The raw text is still there for whoever helps, closed by default and outside the live summary.
    expect(html).toMatch(/<details class="operation-status-reason"[^>]*><summary>查看原因<\/summary><p>Resident output service/);
    expect(html).not.toMatch(/<details class="operation-status-reason"[^>]*\sopen/);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html.slice(0, html.indexOf("operation-status-panel"))).not.toMatch(/h264_nvenc|ENOSPC|C:\\/);
  });

  it("keeps the detailed text in advanced mode", () => {
    interfacePreferences.setMode("advanced");
    const html = renderToStaticMarkup(<OperationStatus status={ENGINE} runtimeInfo="桌面版" />);
    expect(summaryOf(html)).toBe(ENGINE);
    expect(html).not.toContain("operation-status-reason");
    expect(html).not.toContain("data-plain-status");
  });

  it("shows the export's measured progress, and its own plain cause when it fails", () => {
    setRenderJobForTest({ id: "render-test", kind: "video", phase: "running", samples: [], cancelRequested: false, collapsed: true,
      progress: { stage: "encode", fraction: 0.452 } });
    expect(summaryOf(renderToStaticMarkup(<OperationStatus status="正在輸出影片…" runtimeInfo="桌面版" />))).toBe("正在輸出 45%");
    const error = new Error("Encoder stopped: ffmpeg exit code 1 [h264_nvenc] No capable devices found");
    setRenderJobForTest({ id: "render-test", kind: "video", phase: "failed", samples: [], cancelRequested: false, collapsed: false,
      problem: describeProblem("export", error) });
    expect(summaryOf(renderToStaticMarkup(<OperationStatus status={error.message} runtimeInfo="桌面版" />))).toBe("輸出失敗：顯示卡的影片編碼出了問題。");
  });

  it("says the same plain words in another language", async () => {
    expect(await interfacePreferences.setLocale("en")).toBe(true);
    const html = renderToStaticMarkup(<OperationStatus status={ENGINE} runtimeInfo="桌面版" />);
    expect(summaryOf(html)).toBe("Export failed: There isn&#x27;t enough space on the drive.");
    expect(html).toContain("View reason");
    const done = renderToStaticMarkup(<OperationStatus status={"影片輸出完成：D:\\Videos\\Trip.mp4 · hevc_nvenc · 尚未綁定美感審查 · 尚未取得人工品質認證"} runtimeInfo="桌面版" />);
    expect(summaryOf(done)).toBe("Video exported: Trip.mp4");
  });
});

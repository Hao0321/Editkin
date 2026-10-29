import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAppProblem, reportAppProblem } from "../application/appProblemStore";
import { describeProblem } from "../application/plainProblems";
import { resetRenderJobForTest, setRenderJobForTest } from "../desktop/renderJobStore";
import { ExportFeatureRefusalErrorV1 } from "../render/exportFeatureRefusalV1";
import { createDemoEasyEngine } from "./easy/easyEngines";
import { createEasyFlowController } from "./easy/easyFlowController";
import type { EasyFlowHost } from "./easy/easyFlowHost";
import { createEasyFlowStore, easyFlowReducer, initialEasyFlowState, type EasyEnginePlan, type EasyFlowAction, type EasyFlowState } from "./easy/easyFlowModel";
import { EasyScreen } from "./easy/EasyScreens";
import { TEMPLATE_SHORT_STEPS } from "./easy/templateShortEngine";
import { ExportPanel } from "./export/ExportPanel";
import { localizeExportRefusalReasonV1, translateExportRefusalInTextV1, translateExportRefusalV1 } from "./i18n/exportRefusalTranslationV1";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { OperationStatus } from "./OperationStatus";
import { AppProblemNotices } from "./ProblemNotice";

/**
 * Every place an export refusal reaches the user shows it in the interface language: the pro export panel's
 * 「查看原因」, the notices under the toolbar, the footer status (advanced line and simple-mode reason) and the
 * simple-mode save and failure screens. Names and the EXPORT_FEATURE_REFUSED code stay as they are.
 */
const refusal = new ExportFeatureRefusalErrorV1("colorKeyframes", "colorKeyframesAdjustment", { clip: "beach.mp4", fields: "曝光、色溫" }, "clip-1");
const CODE = "EXPORT_FEATURE_REFUSED/colorKeyframes/clip-1";
const escape = (text: string) => renderToStaticMarkup(<i>{text}</i>).slice(3, -4);
const LOCALES = ["en", "ja"] as const;
/** The refusal as each locale should show it. */
async function expected(locale: (typeof LOCALES)[number]): Promise<string> {
  await interfacePreferences.setLocale(locale);
  return `${translateExportRefusalV1(refusal)}${locale === "ja" ? `（${CODE}）` : ` (${CODE})`}`;
}

afterEach(async () => {
  resetRenderJobForTest();
  clearAppProblem("export");
  interfacePreferences.setMode("simple");
  await interfacePreferences.setLocale("zh-TW");
});

describe("the refusal inside a raw text", () => {
  it("is found after a prefix and before trailing text; other text is left alone", async () => {
    await interfacePreferences.setLocale("en");
    const english = translateExportRefusalV1(refusal);
    expect(translateExportRefusalInTextV1(`Render failed: ${refusal.message}\n(job render-1)`)).toBe(`Render failed: ${english} (${CODE})\n(job render-1)`);
    expect(translateExportRefusalInTextV1(refusal.message.replace(/（EXPORT_FEATURE_REFUSED.*$/, ""))).toBe(english);
    expect(translateExportRefusalInTextV1("ENOSPC: no space left on device")).toBeUndefined();
    // A raw reason that is not a refusal stays exactly as it was, even when a translation exists for it.
    expect(localizeExportRefusalReasonV1("影片沒有輸出完成")).toBe("影片沒有輸出完成");
    expect(english).toContain("Exposure, Temperature");
  });
});

describe("export refusal surfaces in English and Japanese", () => {
  it("pro export panel: 「查看原因」 shows the translated refusal", async () => {
    for (const locale of LOCALES) {
      const text = await expected(locale);
      setRenderJobForTest({ id: "render-1", kind: "video", phase: "failed", samples: [], cancelRequested: false, collapsed: false,
        outputPath: "D:\\Videos\\trip.mp4", problem: describeProblem("export", refusal) });
      const html = renderToStaticMarkup(<ExportPanel api={{ cancelRenderJob: vi.fn(), revealInFolder: vi.fn() }} />);
      expect(html, locale).toContain(`<summary>${escape(interfacePreferences.translate("查看原因"))}</summary><p>${escape(text)}</p>`);
      expect(html, locale).toContain(escape(interfacePreferences.translate("這個專案用到目前還不能一起輸出的功能。")));
      expect(html, locale).not.toContain("調整圖層「beach.mp4」");
    }
  });

  it("notices under the toolbar: an export problem's reason is translated", async () => {
    for (const locale of LOCALES) {
      const text = await expected(locale);
      reportAppProblem("export", refusal);
      const html = renderToStaticMarkup(<AppProblemNotices />);
      expect(html, locale).toContain(`<p>${escape(text)}</p>`);
    }
  });

  it("footer status: the advanced line and the simple-mode 「查看原因」", async () => {
    for (const locale of LOCALES) {
      const text = await expected(locale);
      interfacePreferences.setMode("advanced");
      const advanced = renderToStaticMarkup(<OperationStatus status={refusal.message} runtimeInfo="desktop" />);
      expect(advanced, locale).toContain(`data-testid="operation-status-message" role="status" aria-live="polite" aria-atomic="true">${escape(text)}</span>`);
      interfacePreferences.setMode("simple");
      setRenderJobForTest({ id: "render-1", kind: "video", phase: "failed", samples: [], cancelRequested: false, collapsed: false, problem: describeProblem("export", refusal) });
      const simple = renderToStaticMarkup(<OperationStatus status={refusal.message} runtimeInfo="desktop" />);
      expect(simple, locale).toMatch(new RegExp(`data-testid="operation-status-reason"><summary>[^<]+</summary><p>${escape(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
      expect(simple, locale).not.toContain("調整圖層「beach.mp4」");
    }
  });

  it("simple mode: the save screen's error and the failure screen show the translated refusal", async () => {
    const store = createEasyFlowStore(), engine = createDemoEasyEngine({ previewUrl: "demo.mp4", wait: () => Promise.resolve() });
    const host: EasyFlowHost = { store, engine, picker: "dialog", chooseVideo: vi.fn(async () => ({ kind: "video" as const, video })),
      discardVideo: vi.fn(), leaveToEditor: vi.fn(), openWorkspace: vi.fn(), openProject: vi.fn() };
    const controller = createEasyFlowController(host, () => 1_000);
    const video = { id: "asset-v", name: "IMG_4022.MOV", orientation: "portrait" as const, durationSeconds: 42 };
    const plan: EasyEnginePlan = { needsTitle: true, copy: "story", steps: TEMPLATE_SHORT_STEPS, canRestyle: false, canEditText: true, rendersPreview: true, canCancel: true };
    const reduce = (state: EasyFlowState, ...actions: EasyFlowAction[]) => actions.reduce(easyFlowReducer, state);
    const genre = reduce(initialEasyFlowState(), { type: "choose-format", format: "vertical" }, { type: "pick-started" },
      { type: "pick-finished", video, check: { ok: true, plan }, rights: { kind: "ask", scope: { name: "videos", kind: "folder" } } }, { type: "rights-confirmed" });
    const working = reduce(genre, { type: "show-hook" }, { type: "hook-done", skipped: true }, { type: "set-title", value: "Waterfall" },
      { type: "run-started", runId: 1, startedAt: 1_000 });
    const result = reduce(working, { type: "run-finished", runId: 1, result: { orientation: "vertical", previewUrl: "short.mp4", handle: "job-1", flags: [], review: false } });
    const saveFailed = reduce(result, { type: "save-started" }, { type: "save-failed", problem: { kind: "save-failed", detail: refusal.message } });
    const runFailed = reduce(working, { type: "run-failed", runId: 1, problem: { kind: "engine-failed", detail: refusal.message } });
    expect(saveFailed.screen).toBe("result");
    expect(runFailed.screen).toBe("failed");
    const render = (state: EasyFlowState) => renderToStaticMarkup(<EasyScreen state={state} controller={controller} formatStatus={engine.formatStatus} videoUrls={{}}
      canReveal={controller.canReveal()} picker="dialog" onChooseVideo={() => undefined} onFilesChosen={() => undefined} onSeekPreview={() => undefined} now={6_000} />);
    for (const locale of LOCALES) {
      const text = await expected(locale);
      for (const [name, state] of [["save", saveFailed], ["failed", runFailed]] as const) {
        const html = render(state);
        expect(html, `${locale} ${name}`).toContain(`<summary>${escape(interfacePreferences.translate("查看原因"))}</summary><p>${escape(text)}</p>`);
        expect(html, `${locale} ${name}`).not.toContain("調整圖層「beach.mp4」");
      }
    }
  });
});

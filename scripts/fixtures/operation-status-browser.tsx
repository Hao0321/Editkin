import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { OperationStatus } from "../../src/ui/OperationStatus";
import { EDITOR_THEMES, normalizeEditorTheme, THEME_LABELS, type EditorTheme } from "../../src/ui/theme";
import "../../src/styles.css";

const frameMode = new URLSearchParams(location.search).get("frame") === "1";
const initialTheme = normalizeEditorTheme(new URLSearchParams(location.search).get("theme"));
document.documentElement.dataset.operationFixture = frameMode ? "stage" : "controller";
const SCHEMA = "editkin.operation-status-real-dom/v1";
const styles = `
html[data-operation-fixture],html[data-operation-fixture] body,html[data-operation-fixture] #root{min-width:0;min-height:0}
html[data-operation-fixture="controller"],html[data-operation-fixture="controller"] body,html[data-operation-fixture="controller"] #root{height:auto;overflow:auto}
.status-fixture-controller{padding:20px;font:16px/1.5 system-ui,sans-serif}
.status-fixture-controller h1{font-size:24px}.status-fixture-controller p{max-width:1100px}
.status-fixture-controls{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:16px 0}
.status-fixture-controls label{display:flex;gap:8px;align-items:center}
.status-fixture-controls button,.status-fixture-controls select,.status-fixture-content button{min-height:42px;padding:8px 12px;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface);color:var(--ink);font:inherit}
.status-fixture-controller iframe{display:block;border:0;outline:1px solid var(--line-strong);max-width:none}
.status-fixture-controller pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;max-width:1100px;padding:12px;border:1px solid var(--line-strong)}
/* Isolated footer container, not a change to the product App's grid or minimum width. */
.status-fixture-app{height:100dvh;display:grid;grid-template-rows:minmax(0,1fr) 32px;background:var(--bg);color:var(--ink)}
.status-fixture-content{padding:24px;overflow:auto;font:16px/1.5 system-ui,sans-serif}
.status-fixture-content h2{font-size:22px}.status-fixture-content .fixture-actions{display:flex;gap:12px;flex-wrap:wrap}
`;

function describe(element: Element | null) {
  return element ? `${element.tagName.toLowerCase()}${typeof element.className === "string" && element.className ? `.${element.className.trim().replace(/\s+/g, ".")}` : ""}` : null;
}
function measured(element: HTMLElement | null) {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const css = getComputedStyle(element);
  return { element: describe(element), rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
    hit: describe(hit), hitMatches: !!hit && (hit === element || element.contains(hit)),
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop,
    withinViewportInline: r.left >= -0.5 && r.right <= innerWidth + 0.5,
    css: { fontSize: css.fontSize, overflowX: css.overflowX, overflowY: css.overflowY, whiteSpace: css.whiteSpace, textOverflow: css.textOverflow, position: css.position, minWidth: css.minWidth, contain: css.contain, flexBasis: css.flexBasis } };
}

function Stage() {
  const [status, setStatus] = useState("請先選一段要粗剪的影片或聲音。");
  const [runtimeInfo, setRuntimeInfo] = useState("桌面版 · 即時預覽 · 自動儲存 · 手機已連線 2");
  const latest = useRef({ status, runtimeInfo });
  latest.current = { status, runtimeInfo };
  const events = useRef<Array<Record<string, unknown>>>([]);
  const snapshot = useCallback((reason: string) => {
    const disclosure = document.querySelector<HTMLDetailsElement>('[data-testid="operation-status"]');
    const message = document.querySelector<HTMLElement>('[data-testid="operation-status-message"]');
    const report = {
      schema: SCHEMA, status: "OBSERVATION_ONLY", reason, measuredAt: new Date().toISOString(),
      scope: "Real production OperationStatus + real styles in a representative 32px footer; not full App/native acceptance",
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      documentWidth: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      container: measured(document.querySelector(".status-fixture-app")), disclosure: measured(disclosure),
      open: disclosure?.open, summary: measured(disclosure?.querySelector("summary") ?? null),
      footer: measured(document.querySelector(".status-bar")), message: measured(message),
      visibleMessage: message?.textContent, ariaLive: message?.getAttribute("aria-live"),
      fullText: document.querySelector(".operation-status-full-message")?.textContent,
      panel: disclosure?.open ? measured(document.querySelector(".operation-status-panel")) : null,
      runtimeInfo: latest.current.runtimeInfo, activeElement: describe(document.activeElement), events: [...events.current],
      boundaries: ["All messages are synthetic diagnostic inputs, not native task outcomes.", "Root desktop min-width:1080px is relaxed only for this isolated footer viewport.", "No localStorage, media, user project, desktop API or mocked geometry.", "Status changes should not open the disclosure; real pointer/keyboard/scroll acceptance is performed by the reviewer."],
    };
    parent.postMessage(report, location.origin);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = initialTheme;
    requestAnimationFrame(() => snapshot("message-rendered"));
  }, [status, runtimeInfo, snapshot]);
  useEffect(() => {
    const record = (event: Event) => {
      events.current.push({ type: event.type, trusted: event.isTrusted, target: describe(event.target instanceof Element ? event.target : null), at: new Date().toISOString() });
      if (events.current.length > 30) events.current.shift();
      requestAnimationFrame(() => snapshot(event.type));
    };
    const message = (event: MessageEvent) => {
      if (event.source === parent && event.origin === location.origin && event.data?.type === "operation-fixture-measure") snapshot("visible-measure-button");
    };
    for (const type of ["pointerdown", "keydown", "toggle", "scroll"]) document.addEventListener(type, record, true);
    window.addEventListener("message", message);
    const observer = new ResizeObserver(() => snapshot("real-resize-observer"));
    observer.observe(document.documentElement);
    return () => { for (const type of ["pointerdown", "keydown", "toggle", "scroll"]) document.removeEventListener(type, record, true); window.removeEventListener("message", message); observer.disconnect(); };
  }, [snapshot]);
  const asyncMessage = (message: string) => { void Promise.resolve().then(() => setStatus(message)); };
  return <><style>{styles}</style><main className="status-fixture-app" data-workspace-mode="editor">
    <section className="status-fixture-content"><h2>常駐操作狀態：真元件驗收</h2>
      <p>底列只保留原有 32px 高度。先不展開，按下方按鈕，确认非同步訊息會顯示、但不會自動彈開。</p>
      <div className="fixture-actions">
        <button type="button" data-testid="simulate-status-failure" onClick={() => asyncMessage("智慧成片失敗：本機語音模型尚未就緒。\n目前修改仍保留，請確認模型後重新執行。")}>模擬非同步失敗</button>
        <button type="button" onClick={() => asyncMessage("正在本機分析語音與場景；素材不會上傳。")}>模擬進度</button>
        <button type="button" onClick={() => asyncMessage("本機規則式粗剪完成。尚未完成 AI 畫面判讀與人工審片。")}>模擬完成訊息</button>
        <button type="button" data-testid="simulate-status-long" onClick={() => asyncMessage(Array.from({ length: 24 }, (_, index) => `${index + 1}. 詳細訊息：字幕文字仍會重新辨識取代，可一次復原。長路徑測試_${"unbroken_".repeat(12)}`).join("\n"))}>超長多行訊息</button>
        <button type="button" data-testid="simulate-status-unbroken" onClick={() => asyncMessage(`path_${"x".repeat(8192)}`)}>單一超長無空白字串</button>
        <button type="button" onClick={() => asyncMessage("")}>清空訊息</button>
        <button type="button" onClick={() => setRuntimeInfo("桌面版 · 即時預覽 · 自動儲存 · 手機已連線 3")}>更新手機連線資訊</button>
      </div>
      <p>點底列「操作狀態」展開全文後，可測滾輪、Tab 與 Escape；新訊息抵達時不應重新開關。右上關閉鈕與 Escape 應回到 summary 焦點。</p>
      <p>反例回歸：保留原「超長多行訊息」與新增 8192 字元無空白串。舊版在 1920×863 曾讓 panel 左緣到 24728.96875px；請同時查 container、footer、disclosure、summary、panel 的真實邊界，不能只檢查 panel 自己的 scrollWidth。</p>
    </section>
    <footer className="status-bar"><span><i className="green" />所有變更已儲存</span><span>1920×1080 · 30 fps</span><OperationStatus status={status} runtimeInfo={runtimeInfo} /></footer>
  </main></>;
}

function Controller() {
  const [width, setWidth] = useState(1440);
  const [theme, setTheme] = useState<EditorTheme>("sky");
  const [report, setReport] = useState<unknown>({ status: "WAITING_FOR_IFRAME" });
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow && event.origin === location.origin && event.data?.schema === SCHEMA) setReport(event.data); };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return <><style>{styles}</style><main className="status-fixture-controller"><h1>OperationStatus — 實際瀏覽器元件診斷</h1>
    <p>直接使用正式元件与樣式；訊息為記憶體模擬輸入。本頁量測真 DOM／CSS，不表示原生自動剪輯或全 App 已通過。iframe 解除桌面最小寬度僅供隔離元件驗收。</p>
    <div className="status-fixture-controls"><label>真 iframe 寬度<select data-testid="status-fixture-width" value={width} onChange={(event) => setWidth(Number(event.target.value))}>{[390, 900, 1440].map(value => <option key={value} value={value}>{value}px</option>)}</select></label>
      <label>主題<select value={theme} onChange={(event) => setTheme(event.target.value as EditorTheme)}>{EDITOR_THEMES.map(value => <option key={value} value={value}>{THEME_LABELS[value]}</option>)}</select></label>
      <button type="button" onClick={() => frame.current?.contentWindow?.postMessage({ type: "operation-fixture-measure" }, location.origin)}>擷取真實幾何</button>
    </div>
    <iframe ref={frame} key={`${width}-${theme}`} title="常駐操作狀態驗收視窗" data-testid="status-viewport" src={`./operation-status-browser.html?frame=1&theme=${theme}`} style={{ width, height: 640 }} />
    <h2>可見觀測 JSON（不自動宣告 PASS）</h2><pre data-testid="operation-status-report">{JSON.stringify(report, null, 2)}</pre>
  </main></>;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{frameMode ? <Stage /> : <Controller />}</StrictMode>);

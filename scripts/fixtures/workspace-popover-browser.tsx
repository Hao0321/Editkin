import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toolbar } from "../../src/ui/Toolbar";
import { WorkspaceControls } from "../../src/ui/WorkspaceControls";
import { EDITOR_THEMES, normalizeEditorTheme, THEME_LABELS, type EditorTheme } from "../../src/ui/theme";
import { normalizeWorkspaceLayout, WORKSPACE_PRESETS, type WorkspaceLayoutState } from "../../src/ui/workspaceLayout";
import "../../src/styles.css";
import "../../src/ui/timelineDirectManipulation.css";

const FRAME_SCHEMA = "editkin.workspace-popover-real-dom/v1";
const params = new URLSearchParams(location.search);
const frameMode = params.get("frame") === "1";
document.documentElement.dataset.workspaceFixture = frameMode ? "stage" : "controller";
const initialTheme = normalizeEditorTheme(params.get("theme"));
const styles = `
html[data-workspace-fixture], html[data-workspace-fixture] body, html[data-workspace-fixture] #root { min-width:0; min-height:0; }
html[data-workspace-fixture="controller"], html[data-workspace-fixture="controller"] body, html[data-workspace-fixture="controller"] #root { height:auto; overflow:auto; }
.fixture-controller { padding:20px; font:16px/1.5 system-ui,sans-serif; }
.fixture-controller h1 { margin:0 0 8px; font-size:24px; }
.fixture-controller p { max-width:1000px; }
.fixture-controller-controls { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:16px 0; }
.fixture-controller-controls label { display:flex; align-items:center; gap:8px; }
.fixture-controller-controls button,.fixture-controller-controls select { min-height:42px; padding:8px 12px; border:1px solid #9ba9bc; border-radius:6px; color:#172033; background:#fff; }
.fixture-controller-controls button[aria-pressed="true"] { border:2px solid #175cd3; }
.fixture-controller iframe { display:block; border:0; outline:1px solid #9ba9bc; max-width:none; }
.fixture-controller pre { max-width:1200px; white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.5 ui-monospace,monospace; border:1px solid #9ba9bc; padding:12px; }
.fixture-workspace-stage { grid-template-rows:80px minmax(0,1fr) 326px 30px; min-height:0; }
.fixture-preview-placeholder { padding:24px; overflow:hidden; color:var(--muted); }
.fixture-preview-placeholder strong { font-size:20px; color:var(--ink); }
.fixture-timeline-body { display:grid; align-content:start; gap:12px; padding:20px; overflow:hidden; }
.fixture-timeline-track { min-height:48px; padding:12px; border:1px solid var(--line); border-radius:6px; background:var(--surface); }
/* Component-isolation container only: do not change any project-menu,
   workspace-controls or popover rule. Full App remains min-width:1080px. */
@media(max-width:1079px) {
  .fixture-workspace-stage > .toolbar { grid-template-columns:minmax(0,1fr); }
  .fixture-workspace-stage > .toolbar > :not(.toolbar-actions),
  .fixture-workspace-stage > .toolbar .toolbar-actions > :not(.project-menu) { display:none; }
}
`;

function describeElement(element: Element | null): string | null {
  if (!element) return null;
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.className && typeof element.className === "string" ? `.${element.className.trim().replace(/\s+/g, ".")}` : ""}`;
}

function rect(element: Element) {
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
}

function measure(element: HTMLElement) {
  const box = rect(element);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  const css = getComputedStyle(element);
  return {
    element: describeElement(element), rect: box, center: { x, y }, hit: describeElement(hit),
    hitMatches: hit !== null && (hit === element || element.contains(hit)),
    checked: element instanceof HTMLInputElement ? element.checked : undefined,
    text: element instanceof HTMLInputElement ? element.closest("label")?.textContent : element.textContent?.trim().slice(0, 90),
    clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
    css: { position: css.position, width: css.width, minWidth: css.minWidth, minInlineSize: css.minInlineSize, maxWidth: css.maxWidth, overflowX: css.overflowX, overflowY: css.overflowY, zIndex: css.zIndex, gridTemplateColumns: css.gridTemplateColumns },
  };
}

function WorkspaceStage() {
  const [theme, setTheme] = useState<EditorTheme>(initialTheme);
  const [layout, setLayout] = useState<WorkspaceLayoutState>({ ...WORKSPACE_PRESETS.edit });
  const events = useRef<Array<Record<string, unknown>>>([]);
  const latest = useRef({ theme, layout });
  latest.current = { theme, layout };

  const snapshot = useCallback((reason: string) => {
    const menu = document.querySelector<HTMLElement>(".project-menu-popover");
    const panel = document.querySelector<HTMLElement>(".workspace-controls-popover");
    const checkbox = document.querySelector<HTMLElement>('[data-testid="workspace-controls"] fieldset label:nth-of-type(3) input');
    const ancestors = [];
    for (let ancestor = checkbox?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      ancestors.push(measure(ancestor));
    }
    const report = {
      schema: FRAME_SCHEMA,
      classification: "ACTUAL_BROWSER_COMPONENT_OBSERVATIONS_NOT_PACKAGED_APP_ACCEPTANCE",
      status: "OBSERVATION_ONLY",
      reason,
      measuredAt: new Date().toISOString(),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      mediaQueries: { atMost900: matchMedia("(max-width:900px)").matches, atMost390: matchMedia("(max-width:390px)").matches },
      theme: latest.current.theme,
      layout: latest.current.layout,
      details: Array.from(document.querySelectorAll<HTMLDetailsElement>("details")).map((element) => ({ element: describeElement(element), open: element.open })),
      menu: menu ? measure(menu) : null,
      panel: panel ? measure(panel) : null,
      checkboxes: Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid="workspace-controls"] input[type="checkbox"]')).map(measure),
      autoEditCheckboxAncestors: ancestors,
      events: [...events.current],
      boundaries: [
        "Real production Toolbar + WorkspaceControls + styles + iframe media queries; no mocked DOM geometry.",
        "Callbacks mutate fixture React memory only; no project/session, desktop API, localStorage or user files.",
        "Full desktop App minimum width is explicitly relaxed in this component fixture. Under 1080px, unrelated Toolbar siblings are hidden by fixture-only container CSS.",
        "Timeline is representative static content using production timeline styles, not the live editing engine.",
        "No baseline CSS injection, no packaged/native acceptance, no automatic PASS label.",
      ],
    };
    const output = document.getElementById("frame-observation");
    if (output) output.textContent = JSON.stringify(report, null, 2);
    parent.postMessage(report, location.origin);
  }, []);

  const remember = useCallback((event: Record<string, unknown>) => {
    events.current.push({ ...event, at: new Date().toISOString() });
    if (events.current.length > 40) events.current.shift();
    requestAnimationFrame(() => snapshot(String(event.type ?? "event")));
  }, [snapshot]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    requestAnimationFrame(() => snapshot("theme-or-layout-rendered"));
  }, [theme, layout, snapshot]);

  useEffect(() => {
    const pointer = (event: PointerEvent) => remember({ type: "pointerdown", trusted: event.isTrusted, target: describeElement(event.target instanceof Element ? event.target : null), x: event.clientX, y: event.clientY });
    const wheel = (event: WheelEvent) => remember({ type: "wheel", trusted: event.isTrusted, target: describeElement(event.target instanceof Element ? event.target : null), deltaY: event.deltaY, deltaX: event.deltaX });
    const scroll = (event: Event) => remember({ type: "scroll", trusted: event.isTrusted, target: describeElement(event.target instanceof Element ? event.target : null) });
    const toggle = () => requestAnimationFrame(() => snapshot("details-toggled"));
    const message = (event: MessageEvent) => {
      if (event.source === parent && event.origin === location.origin && event.data?.type === "workspace-fixture-measure") snapshot("visible-measure-button");
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("wheel", wheel, { passive: true, capture: true });
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("toggle", toggle, true);
    window.addEventListener("message", message);
    const observer = new ResizeObserver(() => snapshot("real-resize-observer"));
    observer.observe(document.documentElement);
    void document.fonts.ready.then(() => snapshot("fonts-ready"));
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("wheel", wheel, true);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("toggle", toggle, true);
      window.removeEventListener("message", message);
      observer.disconnect();
    };
  }, [remember, snapshot]);

  const notConnected = () => remember({ type: "inert-non-workspace-fixture-action", note: "No desktop bridge called" });
  return <>
    <style>{styles}</style>
    <main className="app-shell fixture-workspace-stage" data-workspace-mode="editor" data-text-size={layout.textSize}>
      <Toolbar projectName="工作區點擊診斷（記憶體資料）" hasUserMedia={true} workspaceMode="editor" theme={theme} onThemeChange={setTheme}
        dirty={false} recoveryState="idle" playhead={0} canUndo={false} canRedo={false} isDesktop={true}
        onNew={notConnected} onOpen={notConnected} onSave={notConnected} onUndo={notConnected} onRedo={notConnected}
        onExport={notConnected} onExportOpenExrSequence={notConnected} onExportAlphaMaster={notConnected}
        onOpenAgentConnect={notConnected} onAutoEdit={notConnected} onMobileRemote={notConnected}
        onCheckUpdates={notConnected} onDirectorConsole={notConnected} onHelp={notConnected}
        workspaceControls={<WorkspaceControls layout={layout}
          onPreset={(preset) => { remember({ type: "preset", preset }); setLayout({ ...WORKSPACE_PRESETS[preset] }); }}
          onPatch={(patch) => { remember({ type: "workspace-patch", patch }); setLayout((current) => normalizeWorkspaceLayout({ ...current, ...patch, preset: "custom" })); }}
          onReset={() => { remember({ type: "reset" }); setLayout({ ...WORKSPACE_PRESETS.simple }); }} />}
      />
      <section className="fixture-preview-placeholder"><strong>實際 DOM／CSS 工作區驗收</strong><p>更多 → 專案、工作區與進階 → 剪輯工作區。請直接點選四個核取方塊中心，並在選單內使用滾輪。</p><p>下方時間軸為靜態障礙層；資料只留在本頁 React 記憶體。</p></section>
      <section className="timeline-region"><div className="timeline-shell">
        <div className="timeline-toolbar"><div><strong><b>3</b> 拖曳微調</strong><span>代表原先收到錯誤點擊的 timeline-toolbar</span></div><div className="timeline-actions"><button type="button" onClick={() => remember({ type: "timeline-hit" })}>時間軸按鈕</button></div></div>
        <div className="fixture-timeline-body">{["主畫面", "聲音", "字幕"].map((name) => <div className="fixture-timeline-track" key={name}>{name} — 靜態代表層</div>)}</div>
      </div></section>
      <footer className="status-bar"><span>診斷 fixture · 無桌面 API · 不寫使用者設定</span></footer>
    </main>
    <script id="frame-observation" type="application/json">{"{}"}</script>
  </>;
}

function Controller() {
  const [width, setWidth] = useState(1440);
  const [height, setHeight] = useState(900);
  const [theme, setTheme] = useState<EditorTheme>("sky");
  const [generation, setGeneration] = useState(0);
  const [report, setReport] = useState<unknown>({ status: "WAITING_FOR_REAL_IFRAME" });
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.origin === location.origin && event.data?.schema === FRAME_SCHEMA) setReport(event.data);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return <><style>{styles}</style><main className="fixture-controller">
    <h1>工作區選單：真瀏覽器裁切／捲動診斷</h1>
    <p>直接掛載 production <code>Toolbar</code>、<code>WorkspaceControls</code> 與正式樣式。iframe 寬度會真正觸發 media query；選單設定僅存在 React 記憶體，不讀寫 localStorage 或專案。</p>
    <p><strong>邊界：</strong>這是元件驗收，不是整套 App 手機版或已交付 EXE。為隔離窄寬選單，fixture 解除 App 的 1080px 最小寬度，並在窄視窗隱藏無關的 Toolbar 同層控制；沒有修改任何選單／工作區 CSS 規則。沒有注入假 baseline，也不自動宣告 PASS。</p>
    <div className="fixture-controller-controls">
      <span>真 iframe 寬度</span>{[390, 900, 1440].map((value) => <button key={value} type="button" aria-pressed={width === value} data-testid={`viewport-${value}`} onClick={() => setWidth(value)}>{value}px</button>)}
      <label>高度<select value={height} onChange={(event) => setHeight(Number(event.target.value))}><option value={900}>900px</option><option value={640}>640px（捲動）</option></select></label>
      <label>主題<select data-testid="fixture-theme-select" value={theme} onChange={(event) => setTheme(event.target.value as EditorTheme)}>{EDITOR_THEMES.map((value) => <option key={value} value={value}>{THEME_LABELS[value]}</option>)}</select></label>
      <button type="button" onClick={() => setGeneration((value) => value + 1)}>重新載入隔離頁</button>
      <button type="button" data-testid="measure-workspace-button" onClick={() => frame.current?.contentWindow?.postMessage({ type: "workspace-fixture-measure" }, location.origin)}>擷取目前真實幾何</button>
    </div>
    <p>操作：點開「更多 → 專案、工作區與進階 → 剪輯工作區」後，檢查四個 checkbox 中心、預設版型、字級選單，再在主選單內滾輪到底；JSON 保留 <code>elementFromPoint</code>、祖先 overflow、scrollTop 與可信指標事件。換寬度／主題會重新掛載，請重開選單。</p>
    <iframe ref={frame} key={`${width}-${height}-${theme}-${generation}`} title="真工作區元件驗收視窗" data-testid="workspace-viewport"
      src={`./workspace-popover-browser.html?frame=1&theme=${theme}&run=${generation}`} style={{ width, height }} />
    <h2>可見觀測 JSON（不等於 PASS）</h2><pre data-testid="workspace-popover-report">{JSON.stringify(report, null, 2)}</pre>
    <details><summary>保留的已驗證失敗 baseline</summary><p>c27281703c9d5489 桌面版 1440×900：第三個 checkbox 中心 (975.5, 586) 命中 timeline-toolbar。來源：.rd/workspace-checkbox-hit-target-p1-20260831.md；report SHA256 36c5460be630cdf5b003b1a2dfab03b9ac8f39d4cf9e01352cabfe1fdb10d8d6。本頁沒有把該舊版缺陷重命名成新版結果。</p></details>
  </main></>;
}

createRoot(document.getElementById("root")!).render(<StrictMode>{frameMode ? <WorkspaceStage /> : <Controller />}</StrictMode>);

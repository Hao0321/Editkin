import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DirectorConsole } from "../../src/ui/DirectorConsole";
import { resolveAestheticSystem } from "../../src/application/editkinAesthetic";
import { AESTHETIC_BENCHMARKS, BENCHMARK_AXES } from "../../src/domain/aestheticBenchmarks";
import { scoreAestheticReview } from "../../src/domain/aestheticReview";
import { createDemoProject } from "../../src/domain/demo";
import { createHistory, dispatchCommandSafely, undo } from "../../src/domain/history";
import type { EditorCommand } from "../../src/domain/commands";
import type { AestheticArtifactBinding, AestheticBenchmarkReview } from "../../src/domain/types";
import { EDITOR_THEMES, THEME_LABELS, normalizeEditorTheme, type EditorTheme } from "../../src/ui/theme";
import "../../src/styles.css";

const SCHEMA = "editkin.aesthetic-review-real-dom/v1";
const frameMode = new URLSearchParams(location.search).get("frame") === "1";
const initialTheme = normalizeEditorTheme(new URLSearchParams(location.search).get("theme"));
document.documentElement.dataset.aestheticFixture = frameMode ? "stage" : "controller";
const fixtureArtifact: AestheticArtifactBinding = { outputSha256: "a".repeat(64), fps: 30, durationFrames: 900 };
function projectFixture() {
  const project = createDemoProject(); project.name = "合成資料：不是實際審片";
  project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
  return project;
}
function syntheticBenchmark(): AestheticBenchmarkReview {
  return { schema: "editkin.aesthetic-benchmark-review/v1", artifact: { ...fixtureArtifact }, axes: Object.fromEntries(BENCHMARK_AXES.map(axis => [axis, Object.fromEntries(AESTHETIC_BENCHMARKS[axis].map(item => [item.id, { rating: 4.5, evidence: [{ fromFrame: 90, toFrame: 120, observation: "合成驗收資料，不是真人評分，也不是美感驗收。" }] }]))])) };
}
const styles = `
html[data-aesthetic-fixture],html[data-aesthetic-fixture] body,html[data-aesthetic-fixture] #root{min-width:0;min-height:0}
html[data-aesthetic-fixture="controller"],html[data-aesthetic-fixture="controller"] body,html[data-aesthetic-fixture="controller"] #root{height:auto;overflow:auto}
.aesthetic-fixture-controller{padding:20px;font:16px/1.6 system-ui,sans-serif}
.aesthetic-fixture-controller h1{font-size:24px}.aesthetic-fixture-controller p{max-width:1050px}
.aesthetic-fixture-controls{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.aesthetic-fixture-controls label{display:flex;align-items:center;gap:8px}
.aesthetic-fixture-controls :is(button,select){min-height:44px;padding:8px 12px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}
.aesthetic-fixture-controller iframe{display:block;border:0;outline:1px solid var(--line-strong);max-width:none}
.aesthetic-fixture-controller pre{max-width:1100px;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 ui-monospace,monospace;border:1px solid var(--line)}
.aesthetic-fixture-closed{padding:24px;font:16px/1.6 system-ui,sans-serif}
`;
function measured(element: HTMLElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect(); const css = getComputedStyle(element);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return { rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
    withinViewportInline: rect.left >= -.5 && rect.right <= innerWidth + .5,
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    fontSize: css.fontSize, overflowX: css.overflowX, overflowY: css.overflowY,
    hitMatches: !!hit && (hit === element || element.contains(hit)), text: element.textContent?.slice(0, 180) };
}
function Stage() {
  const [history, setHistory] = useState(() => createHistory(projectFixture()));
  const [artifact, setArtifact] = useState<AestheticArtifactBinding | undefined>();
  const [playhead, setPlayhead] = useState(3);
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState("本頁所有媒體／binding 都是合成資料，僅驗收真元件行為。");
  const latest = useRef({ history, artifact, playhead, status }); latest.current = { history, artifact, playhead, status };
  const events = useRef<Array<Record<string, unknown>>>([]);
  const snapshot = useCallback((reason: string) => {
    const values = latest.current;
    const visibleControls = Array.from(document.querySelectorAll<HTMLElement>(".director-console button,.director-console select,.director-console textarea,.director-console summary,.director-console input")).filter(element => element.getClientRects().length && element.getBoundingClientRect().height > 0).map(element => ({ tag: element.tagName, label: element.getAttribute("aria-label") ?? element.textContent?.slice(0, 80), type: element.getAttribute("type"), ...measured(element) }));
    parent.postMessage({ schema: SCHEMA, status: "OBSERVATION_ONLY", reason, measuredAt: new Date().toISOString(),
      viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      documentWidth: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
      modal: measured(document.querySelector(".director-console")), panel: measured(document.querySelector(".aesthetic-review-panel")),
      details: [...document.querySelectorAll<HTMLDetailsElement>(".aesthetic-group,.aesthetic-criterion")].map(element => ({ open: element.open, name: element.querySelector("summary")?.textContent })),
      visibleControls, recordDisabled: document.querySelector<HTMLButtonElement>('[data-testid="aesthetic-record-review"]')?.disabled,
      draftDisabled: document.querySelector<HTMLButtonElement>('[data-testid="aesthetic-save-draft"]')?.disabled,
      bindingText: document.querySelector('[data-testid="aesthetic-binding-note"]')?.textContent,
      history: { past: values.history.past.length, journal: values.history.journal.map(row => row.command.type), review: values.history.present.aestheticSystem?.review },
      owner: values.artifact ? "SYNTHETIC_FIXTURE_OWNER_NOT_A_RENDER_RECEIPT" : "MISSING", playhead: values.playhead, message: values.status, events: [...events.current],
      boundaries: ["Production DirectorConsole/AestheticReviewPanel, real CSS, real React 19 and real domain history commands.", "Fixture-only synthetic output binding and observations; no actual render, disk write, native IPC or completed human review.", "Three themes share identical product components; iframe changes actual viewport/media queries.", "Only the App root min-width is relaxed for this isolated modal; this does not certify the whole mobile App.", "No mocked geometry and no browser automation invoked by this fixture."],
    }, location.origin);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = initialTheme; requestAnimationFrame(() => snapshot("react-render")); }, [history, artifact, playhead, status, open, snapshot]);
  useEffect(() => {
    const record = (event: Event) => { events.current.push({ type: event.type, trusted: event.isTrusted, at: new Date().toISOString() }); if (events.current.length > 24) events.current.shift(); requestAnimationFrame(() => snapshot(event.type)); };
    const message = (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== location.origin || event.data?.type !== "aesthetic-fixture-action") return;
      const action = event.data.action;
      if (action === "measure") snapshot("visible-measure-button");
      if (action === "blank") { setHistory(createHistory(projectFixture())); setArtifact(undefined); setOpen(true); }
      if (action === "owner") { setArtifact({ ...fixtureArtifact }); setOpen(true); }
      if (action === "no-owner") setArtifact(undefined);
      if (action === "switch-owner") setArtifact({ ...fixtureArtifact, outputSha256: "b".repeat(64) });
      if (action === "playhead") setPlayhead(6.4);
      if (action === "undo") setHistory(value => undo(value));
      if (action === "reopen") setOpen(true);
      if (action === "complete-fixture" || action === "legacy-fixture") {
        const project = projectFixture(); const system = project.aestheticSystem!;
        system.review = scoreAestheticReview(system, Object.fromEntries(system.dimensions.map(d => [d.id, 5])), { benchmarkReview: syntheticBenchmark(), currentArtifact: fixtureArtifact, complete: action === "legacy-fixture" });
        setHistory(createHistory(project)); setArtifact(action === "legacy-fixture" ? undefined : { ...fixtureArtifact }); setOpen(true);
      }
      if (action === "long-fixture") {
        const project = projectFixture(); const system = project.aestheticSystem!; const benchmark = syntheticBenchmark();
        benchmark.axes.mrbeast_information_energy!.promise_stakes.evidence[0].observation = `長字串_${"x".repeat(8192)}`;
        system.review.benchmarkReview = benchmark; system.primaryLabel = `版面負例_${"LongUnbrokenName".repeat(35)}`;
        setHistory(createHistory(project)); setArtifact({ ...fixtureArtifact }); setOpen(true);
      }
    };
    for (const type of ["pointerdown", "keydown", "change", "input", "toggle", "scroll"]) document.addEventListener(type, record, true);
    window.addEventListener("message", message);
    const observer = new ResizeObserver(() => snapshot("real-resize-observer")); observer.observe(document.documentElement);
    return () => { for (const type of ["pointerdown", "keydown", "change", "input", "toggle", "scroll"]) document.removeEventListener(type, record, true); window.removeEventListener("message", message); observer.disconnect(); };
  }, [snapshot]);
  const command = (value: EditorCommand, message?: string) => {
    setHistory(previous => { const result = dispatchCommandSafely(previous, value, `fixture-${previous.journal.length}`, { currentAestheticArtifact: () => latest.current.artifact }); setStatus(result.error ?? message ?? "命令已記錄"); return result.state; });
  };
  return <><style>{styles}</style>{open ? <DirectorConsole project={history.present} playhead={playhead} currentArtifact={artifact} onSeek={setPlayhead} onCommand={command} onClose={() => setOpen(false)} /> : <p className="aesthetic-fixture-closed">導演台已關閉；按上方「重新開啟」可檢查已保存的評分。</p>}</>;
}
function Controller() {
  const [width, setWidth] = useState(1440); const [theme, setTheme] = useState<EditorTheme>("sky");
  const [report, setReport] = useState<unknown>({ status: "WAITING_FOR_IFRAME" }); const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => { const receive = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow && event.origin === location.origin && event.data?.schema === SCHEMA) setReport(event.data); }; window.addEventListener("message", receive); return () => window.removeEventListener("message", receive); }, []);
  const action = (value: string) => frame.current?.contentWindow?.postMessage({ type: "aesthetic-fixture-action", action: value }, location.origin);
  return <><style>{styles}</style><main className="aesthetic-fixture-controller"><h1>美感審查 · 真元件驗收頁</h1><p>這是 UI 與資料回寫測試，不是影片美感通過證明。所有預填評分／binding 都是明示合成資料。請操作實際群組、評分、時間碼、理由、儲存、滾輪與 Undo。</p>
    <div className="aesthetic-fixture-controls"><label>iframe 寬度<select data-testid="aesthetic-fixture-width" value={width} onChange={event => setWidth(Number(event.target.value))}>{[390, 900, 1440].map(value => <option key={value} value={value}>{value}px</option>)}</select></label><label>主題<select value={theme} onChange={event => setTheme(event.target.value as EditorTheme)}>{EDITOR_THEMES.map(value => <option key={value} value={value}>{THEME_LABELS[value]}</option>)}</select></label></div>
    <div className="aesthetic-fixture-controls">{[["blank", "空白草稿"], ["owner", "模擬目前輸出"], ["no-owner", "移除輸出綁定"], ["switch-owner", "切換另一份輸出"], ["complete-fixture", "預載完整合成資料（未審）"], ["legacy-fixture", "舊存檔 PASSED 反例"], ["long-fixture", "超長無空白反例"], ["playhead", "播放頭移到 6.4 秒"], ["undo", "Undo 真命令"], ["reopen", "重新開啟"], ["measure", "擷取真實幾何"]].map(([id, label]) => <button type="button" key={id} data-testid={`aesthetic-fixture-${id}`} onClick={() => action(id)}>{label}</button>)}</div>
    <iframe ref={frame} key={`${width}-${theme}`} title="美感審查真元件視窗" data-testid="aesthetic-viewport" src={`./aesthetic-review-browser.html?frame=1&theme=${theme}`} style={{ width, height: 800 }} />
    <h2>可見觀測 JSON · 不自動宣告 PASS</h2><pre data-testid="aesthetic-review-report">{JSON.stringify(report, null, 2)}</pre>
  </main></>;
}
createRoot(document.getElementById("root")!).render(<StrictMode>{frameMode ? <Stage /> : <Controller />}</StrictMode>);

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AutoEditDialog } from "../../src/ui/AutoEditDialog";
import type { NativeEditingPolicy } from "../../src/application/nativeAutopilotPolicy";
import "../../src/ui/theme.css";

// Real production dialog; callback is visible diagnostic state, not native editing.
function Fixture() {
  const [opened, setOpened] = useState(false);
  const [calls, setCalls] = useState<NativeEditingPolicy[]>([]);
  const [theme, setTheme] = useState("sky");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <main data-theme={theme} style={{ minHeight: "100vh", padding: 24, boxSizing: "border-box", background: "var(--bg)", color: "var(--ink)", fontFamily: "system-ui" }}>
    <h1>粗剪設定：真實 React 介面測試</h1>
    <p>僅檢查設定視窗與回呼；不存取影片、不代表原生分析或完整 App 測試。</p>
    <label>主題 <select value={theme} onChange={(e) => setTheme(e.target.value)}><option value="sky">藍白</option><option value="candy">粉白</option><option value="volt">黑綠</option></select></label>
    <button onClick={() => setOpened(true)}>開啟粗剪設定</button>
    <output data-testid="dialog-call-count">{calls.length}</output>
    <pre data-testid="dialog-calls">{JSON.stringify(calls)}</pre>
    {opened && <AutoEditDialog onClose={() => setOpened(false)} onStart={(policy) => { setCalls((previous) => [...previous, policy]); setOpened(false); }} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);

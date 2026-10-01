import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import { renderBrowserDraft, downloadBrowserDraft } from "../application/browserDraftExport";

export function useBrowserDraftExport(input: {
  project: EditProject;
  runtimeUrls: Record<string, string>;
  session: ProjectSession;
  onStatus: (message: string) => void;
  onStart: () => void;
}) {
  const pending = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); };
  }, []);
  const cancel = () => pending.current?.abort(new DOMException("已取消草稿匯出。", "AbortError"));
  const render = async () => {
    if (!mounted.current || pending.current) return;
    const task = input.session.beginTask(input.project);
    if (!task.isCurrent()) return;
    const controller = new AbortController();
    pending.current = controller; setBusy(true);
    const unsubscribe = input.session.subscribe(() => {
      if (!task.isCurrent()) controller.abort(new DOMException("專案已修改，草稿匯出已停止；請重新匯出目前版本。", "AbortError"));
    });
    try {
      input.onStart();
      input.onStatus("正在準備網頁草稿…即時錄製，請保持此分頁在前景；不等同 Rust／GPU 正式輸出。");
      const result = await renderBrowserDraft(input.project, input.runtimeUrls, {
        signal: controller.signal,
        onProgress: percent => { if (mounted.current && task.isCurrent() && !controller.signal.aborted) input.onStatus(`正在輸出網頁草稿 ${percent}%…請保持此分頁在前景。`); },
      });
      if (!mounted.current || !task.isCurrent() || controller.signal.aborted) return;
      downloadBrowserDraft(result.blob, input.project.name, result.extension);
      input.onStatus(`草稿影片已下載 · ${result.width}×${result.height} · 目標 ${result.fps} fps · ${result.encoder} · 即時錄製，非 Rust／GPU 正式輸出。`);
    } catch (error) {
      if (mounted.current && task.isSessionCurrent()) input.onStatus(error instanceof Error ? error.message : "草稿影片輸出失敗。");
    } finally {
      unsubscribe();
      if (pending.current === controller) { pending.current = undefined; if (mounted.current) setBusy(false); }
    }
  };
  return { busy, cancel, render };
}

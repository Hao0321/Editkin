import { useEffect, useRef, useState } from "react";
import { partitionSupportedMedia, rejectedMediaMessage } from "./mediaDrop";
import "./workspaceDropImport.css";

interface WorkspaceDropImportProps {
  onBrowserFiles: (files: File[]) => void;
  onDesktopPaths?: (paths: string[]) => void;
  onStatus: (message: string) => void;
}

export function WorkspaceDropImport({ onBrowserFiles, onDesktopPaths, onStatus }: WorkspaceDropImportProps) {
  const [active, setActive] = useState(false);
  const dragDepth = useRef(0);
  const onBrowserFilesRef = useRef(onBrowserFiles);
  const onDesktopPathsRef = useRef(onDesktopPaths);
  const onStatusRef = useRef(onStatus);
  onBrowserFilesRef.current = onBrowserFiles;
  onDesktopPathsRef.current = onDesktopPaths;
  onStatusRef.current = onStatus;

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setActive(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setActive(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setActive(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      const { supported, rejected } = partitionSupportedMedia(files, (file) => file.name);
      if (rejected.length) onStatusRef.current(rejectedMediaMessage(rejected.length));
      if (supported.length) onBrowserFilesRef.current(supported);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !onDesktopPathsRef.current) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      unlisten = await getCurrentWindow().onDragDropEvent(({ payload }) => {
        if (disposed) return;
        if (payload.type === "over") setActive(true);
        if (payload.type === "leave") setActive(false);
        if (payload.type !== "drop") return;
        setActive(false);
        const { supported, rejected } = partitionSupportedMedia(payload.paths, (path) => path);
        if (rejected.length) onStatusRef.current(rejectedMediaMessage(rejected.length));
        if (supported.length) onDesktopPathsRef.current?.(supported);
      });
      if (disposed) unlisten();
    }).catch((error) => onStatusRef.current(`拖放匯入初始化失敗：${error instanceof Error ? error.message : String(error)}`));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  if (!active) return null;
  return <div className="workspace-drop-overlay" role="status" aria-live="polite" data-testid="workspace-drop-overlay">
    <div><b aria-hidden="true">＋</b><strong>放開就加入影片</strong><span>影片、照片、聲音都可以；會自動判斷直式或橫式</span></div>
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { partitionSupportedMedia, rejectedMediaMessage } from "./mediaDrop";
import type { WorkspaceDropPoint } from "./internalAssetPointerDrag";
import "./workspaceDropImport.css";

interface WorkspaceDropImportProps {
  onBrowserFiles: (files: File[], point?: WorkspaceDropPoint) => void;
  onDesktopPaths?: (paths: string[], point?: WorkspaceDropPoint) => void;
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
    // Windows Tauri owns native file drops; installing a second Files route can
    // import the same native drop twice. Internal assets use pointer events.
    if (window.__TAURI_INTERNALS__) return;
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
      if (supported.length) onBrowserFilesRef.current(supported, Object.freeze({ clientX: event.clientX, clientY: event.clientY }));
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
    let unlistenDrag: (() => void) | undefined, unlistenScale: (() => void) | undefined;
    let observedScale: number | undefined, scaleRevision = 0;
    const stopListeners = () => { unlistenDrag?.(); unlistenDrag = undefined; unlistenScale?.(); unlistenScale = undefined; };
    const acceptScale = (value: number) => { observedScale = Number.isFinite(value) && value > 0 ? value : undefined; };
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      const nativeWindow = getCurrentWindow();
      unlistenScale = await nativeWindow.onScaleChanged(({ payload }) => {
        if (disposed) return;
        scaleRevision += 1; acceptScale(payload.scaleFactor);
      });
      if (disposed) { stopListeners(); return; }
      const initialRevision = scaleRevision, initialScale = await nativeWindow.scaleFactor();
      if (disposed) { stopListeners(); return; }
      if (initialRevision === scaleRevision) acceptScale(initialScale);
      unlistenDrag = await nativeWindow.onDragDropEvent(({ payload }) => {
        if (disposed) return;
        if (payload.type === "over") setActive(true);
        if (payload.type === "leave") setActive(false);
        if (payload.type !== "drop") return;
        setActive(false);
        const { supported, rejected } = partitionSupportedMedia(payload.paths, (path) => path);
        if (rejected.length) onStatusRef.current(rejectedMediaMessage(rejected.length));
        if (!supported.length) return;
        // The observed native scale is initialized before this listener and
        // updated by the owned scale listener. Capture DOM intent synchronously
        // at drop, before the importer can await or the project can change.
        try {
          if (observedScale === undefined || ![payload.position.x, payload.position.y].every(Number.isFinite)) throw new Error("視窗拖放座標比例無效");
          onDesktopPathsRef.current?.([...supported], Object.freeze({ clientX: payload.position.x / observedScale, clientY: payload.position.y / observedScale }));
        } catch (error) {
          onStatusRef.current(`拖放匯入未完成：${error instanceof Error ? error.message : String(error)}`);
        }
      });
      if (disposed) stopListeners();
    }).catch((error) => { stopListeners(); if (!disposed) onStatusRef.current(`拖放匯入初始化失敗：${error instanceof Error ? error.message : String(error)}`); });
    return () => { disposed = true; stopListeners(); };
  }, []);

  if (!active) return null;
  return <div className="workspace-drop-overlay" role="status" aria-live="polite" data-testid="workspace-drop-overlay">
    <div><b aria-hidden="true">＋</b><strong>放開就加入影片</strong><span>影片、照片、聲音都可以；會自動判斷直式或橫式</span></div>
  </div>;
}

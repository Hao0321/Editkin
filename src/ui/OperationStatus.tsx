import { useRef } from "react";
import "./operationStatus.css";

interface OperationStatusProps {
  status: string;
  runtimeInfo: string;
}

/** A persistent, neutral message surface; status text never determines success. */
export function OperationStatus({ status, runtimeInfo }: OperationStatusProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const message = status.trim() ? status : "目前沒有進行中的操作。";
  const close = () => {
    if (!details.current) return;
    details.current.open = false;
    details.current.querySelector("summary")?.focus();
  };
  return <details ref={details} className="operation-status" data-testid="operation-status" onKeyDown={(event) => {
    if (event.key === "Escape" && details.current?.open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <summary title={message}>
      <b>操作狀態</b>
      <span className="operation-status-message" data-testid="operation-status-message" role="status" aria-live="polite" aria-atomic="true">{message}</span>
      <span className="operation-status-chevron" aria-hidden="true">⌃</span>
    </summary>
    <div className="operation-status-panel" data-testid="operation-status-panel">
      <header><strong>目前操作</strong><button type="button" onClick={close} aria-label="關閉操作狀態">×</button></header>
      <p className="operation-status-full-message">{message}</p>
      <p className="operation-status-runtime">{runtimeInfo}</p>
    </div>
  </details>;
}

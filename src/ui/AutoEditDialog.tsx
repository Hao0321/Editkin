import { useEffect, useRef, useState } from "react";
import type { NativeEditingPolicy } from "../application/nativeAutopilotPolicy";
import "./autoEditDialog.css";

interface AutoEditDialogProps {
  onClose: () => void;
  onStart: (policy: NativeEditingPolicy) => void;
}

export function AutoEditDialog({ onClose, onStart }: AutoEditDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitted = useRef(false);
  const [format, setFormat] = useState<"longform" | "shorts">();
  const [preserveStyle, setPreserveStyle] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialog} className="auto-edit-dialog" aria-labelledby="auto-edit-title" onCancel={onClose}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!format || submitted.current) return;
      submitted.current = true;
      onStart({ format, ownership: preserveStyle ? "manual" : "automatic" });
    }}>
      <header><h2 id="auto-edit-title">先做一版本機粗剪</h2><button type="button" aria-label="關閉粗剪設定" onClick={onClose}>×</button></header>
      <p>剪停頓、排節奏、加可編輯字幕與配樂。完成後仍可逐段調整。</p>
      <fieldset className="auto-edit-formats"><legend>這次要剪什麼？</legend>
        <label><input type="radio" name="edit-format" value="longform" checked={format === "longform"} onChange={() => setFormat("longform")} /><span><strong>長片</strong><small>白字、黑底，字幕顏色一致</small></span></label>
        <label><input type="radio" name="edit-format" value="shorts" checked={format === "shorts"} onChange={() => setFormat("shorts")} /><span><strong>Shorts／Reels</strong><small>沿用所選題材的字幕樣式</small></span></label>
      </fieldset>
      <label className="auto-edit-preserve"><input type="checkbox" checked={preserveStyle} onChange={(event) => setPreserveStyle(event.target.checked)} /><span>保留字幕樣式與原邊界轉場<small>字幕文字仍會重新辨識取代，可一次復原。不把原轉場複製到新切口。</small></span></label>
      <p className="auto-edit-note">這是本機規則式粗剪，不包含 Codex／Claude 的畫面分析。片型不會改變畫幅；新切口不自動加轉場。設定只用於這一次。</p>
      <footer><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={!format}>開始粗剪</button></footer>
    </form>
  </dialog>;
}

import { useEffect, useRef, useState } from "react";
import "./autoEditDialog.css";
import "./motionGraphicTextDialog.css";

export function MotionGraphicTextDialog({ initialText, tracked, onClose, onSubmit }: {
  initialText: string; tracked: boolean; onClose: () => void; onSubmit: (text: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  const [text, setText] = useState(initialText);
  const valid = Boolean(text.trim()) && Array.from(text.trim()).length <= 128;
  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement;
    element?.showModal(); input.current?.select();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialog} className="auto-edit-dialog motion-text-dialog" aria-labelledby="motion-text-title" onCancel={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!valid || submitted.current) return;
      submitted.current = true; onSubmit(text.trim());
    }}>
      <header><h2 id="motion-text-title">{tracked ? "新增追蹤標籤" : "新增動態圖文"}</h2><button type="button" aria-label="關閉動態圖文" onClick={onClose}>×</button></header>
      <label>顯示文字<input ref={input} value={text} aria-label="動態圖文文字" maxLength={256} onChange={event => setText(event.target.value)} /></label>
      <p>完成後可以繼續改字、換字型；取消不會新增圖文。</p>
      {!valid && <small role="status">請輸入 1–128 個字。</small>}
      <footer><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={!valid}>建立圖文</button></footer>
    </form>
  </dialog>;
}

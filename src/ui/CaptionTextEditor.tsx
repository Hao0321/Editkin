import { useEffect, useRef, useState } from "react";

/** Buffer composition and intermediate edits; one accepted correction is one EditGraph command. */
export function CaptionTextEditor({ value, label, testId, onCommit }: {
  value: string; label: string; testId: string; onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState({ text: value, baseline: value, conflict: false });
  const composing = useRef(false);
  const dirty = draft.text !== draft.baseline;
  const valid = draft.text.trim().length > 0;
  useEffect(() => {
    setDraft(current => {
      if (value === current.baseline) return current.conflict ? { ...current, conflict: false } : current;
      if (current.text === current.baseline || value === current.text)
        return { text: value, baseline: value, conflict: false };
      return { ...current, conflict: true };
    });
  }, [value]);
  const commit = (text = draft.text) => {
    if (composing.current || draft.conflict || value !== draft.baseline || !text.trim() || text === draft.baseline) return;
    // Keep the baseline until the project confirms the command; a failed command stays visibly pending.
    onCommit(text);
  };
  const reset = () => setDraft({ text: value, baseline: value, conflict: false });
  return <div className="caption-text-editor" data-testid={`${testId}-editor`}>
    <label className="field-label">{label}
      <textarea value={draft.text} data-testid={testId} aria-invalid={!valid || draft.conflict}
        onChange={event => setDraft(current => ({ ...current, text: event.target.value }))}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => {
          composing.current = false;
          if (document.activeElement !== event.currentTarget) commit(event.currentTarget.value);
        }}
        onBlur={event => commit(event.currentTarget.value)}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
            if (event.nativeEvent.isComposing || composing.current || draft.conflict || !valid) {
              event.preventDefault(); event.stopPropagation();
            } else commit();
            return;
          }
          if (event.nativeEvent.isComposing || composing.current) return;
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { event.preventDefault(); reset(); }
        }} />
    </label>
    <div className="caption-text-actions">
      <span role="status">{draft.conflict ? "字幕已由其他操作更新，請重新校對。" : !valid ? "請輸入文字；清除字幕請使用刪除。" : dirty ? "尚未套用 · 離開欄位或 Ctrl＋Enter 套用" : "文字已同步至時間軸"}</span>
      {draft.conflict ? <button type="button" onClick={reset} data-testid={`${testId}-reset`}>使用目前字幕</button>
        : <button type="button" disabled={!dirty || !valid} onClick={() => commit()} data-testid={`${testId}-apply`}>套用文字</button>}
    </div>
  </div>;
}

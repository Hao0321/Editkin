import { translateUi as uiText, translateUiStatus, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { EditProject } from "../domain/types";
import { clipSlipError, clipSourceEditBlocker, clipSourceWindow, formatEditSeconds } from "../domain/clipSourceEdits";
import "./clipInPointControl.css";

interface Props {
  project: EditProject;
  clipId: string;
  /** Commits one new in-point; returns false (or a promise of false, while a title template on the clip is laid out
   * again) when the editor refused it. */
  onCommit: (sourceStart: number) => boolean | void | Promise<boolean>;
}

/** Shown in seconds, at most three decimals, without trailing zeros. */
const display = (seconds: number) => String(Number(seconds.toFixed(3)));

/** In-point (source start) of the selected clip. Changing it keeps the clip's place and length. */
export function ClipInPointControl({ project, clipId, onCommit }: Props) {
  useI18n();
  const clip = project.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clipId);
  const current = clip?.sourceStart ?? 0;
  const [draft, setDraft] = useState(() => display(current));
  const [error, setError] = useState<string>();
  // The in-point being applied while a title template follows it: Enter and then leaving the field commit it only once.
  const [pending, setPending] = useState<number>();
  useEffect(() => { setDraft(display(current)); setError(undefined); }, [clipId, current]);
  if (!clip) return null;
  const fps = project.fps;
  const blocker = clipSourceEditBlocker(project, clipId, "slip");
  const window = clipSourceWindow(project, clipId);
  const latest = (window?.maxSourceStartFrame ?? 0) / fps;

  const commit = () => {
    const text = draft.trim();
    const value = text === "" ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) { setError("請輸入入點秒數。"); return; }
    // Typed seconds land on the nearest project frame; the frame grid is what plays and saves.
    const sourceStart = Math.round(value * fps) / fps + 0;
    if (Math.abs(sourceStart - current) <= 1e-6) { setDraft(display(current)); setError(undefined); return; }
    if (pending !== undefined && Math.abs(pending - sourceStart) <= 1e-6) return;
    const problem = clipSlipError(project, clipId, sourceStart);
    if (problem) { setError(problem); return; }
    setError(undefined);
    const result = onCommit(sourceStart);
    if (result === false) { setDraft(display(current)); return; }
    if (result instanceof Promise) {
      setPending(sourceStart);
      void result.then(accepted => { if (!accepted) setDraft(display(current)); }, () => setDraft(display(current)))
        .finally(() => setPending(value => value === sourceStart ? undefined : value));
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); commit(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(display(current)); setError(undefined); }
  };

  return <section className="clip-in-point" data-testid="clip-in-point" aria-label={uiText("素材入點")}>
    <label className="field-label">{uiText("素材入點（從素材第幾秒開始）")}
      <div className="number-field">
        <input type="number" inputMode="decimal" min="0" max={blocker ? undefined : latest} step={1 / fps} value={draft}
          disabled={Boolean(blocker)} aria-invalid={Boolean(error)} data-testid="clip-in-point-input"
          onChange={event => { setDraft(event.target.value); setError(undefined); }} onBlur={commit} onKeyDown={keyDown} />
        <span>sec</span>
      </div>
    </label>
    {/* A refusal sits right under the field it explains. */}
    {error && <small className="clip-in-point-error" role="alert" data-testid="clip-in-point-error">{translateUiStatus(error)}</small>}
    {blocker
      ? <small className="clip-in-point-note" data-testid="clip-in-point-blocked">{translateUiStatus(blocker)}</small>
      : <small className="clip-in-point-note">{window && window.maxSourceStartFrame > 0
        ? uiText("可選 {min}–{max} 秒；片段位置和長度不變。", { min: formatEditSeconds(0), max: formatEditSeconds(latest) })
        : uiText("這段已用到整段素材；先把片段剪短，才有空間換入點。")} {uiText("也可以在時間軸按住 Alt 拖曳片段。")}</small>}
  </section>;
}

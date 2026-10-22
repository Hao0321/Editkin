import { translateUi as uiText, translateUiStatus, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EditProject } from "../domain/types";
import { clipMoveRefusal } from "../application/timelineMotionEdits";
import "./clipInPointControl.css";

export const CLIP_START_INVALID = "請輸入 0 或更大的秒數。";
/** The editor refused the move after it started (the project kept changing, for example); the status line has more. */
export const CLIP_START_NOT_MOVED = "片段沒有移動；請再試一次。";

interface Props {
  clipId: string;
  timelineStart: number;
  fps: number;
  /** Moves the clip once; false (now or when its promise settles) means the editor refused it. */
  onMove: (timelineStart: number) => boolean | void | Promise<boolean>;
  /** The live project: a move the editor would refuse is explained right under the field, before anything changes. */
  project?: EditProject;
}

/** Shown in seconds, at most three decimals, without trailing zeros. */
const display = (seconds: number) => String(Number(seconds.toFixed(3)));

/**
 * Where the selected clip starts on the timeline. A typed value moves the clip once, on Enter or when leaving the
 * field, so typing "12.5" never moves the clip to 1, 12 and 12.5 on the way (titles riding on it move with it).
 * A refusal says why right under the field, in plain words, not only in the status line.
 */
export function ClipStartField({ clipId, timelineStart, fps, onMove, project }: Props) {
  useI18n();
  const [draft, setDraft] = useState(() => display(timelineStart));
  const [error, setError] = useState<string>();
  const commits = useRef(0);
  useEffect(() => { setDraft(display(timelineStart)); setError(undefined); }, [clipId, timelineStart]);

  const commit = () => {
    const text = draft.trim();
    const value = text === "" ? Number.NaN : Number(text);
    if (!Number.isFinite(value) || value < 0) { setError(CLIP_START_INVALID); return; }
    // Typed seconds land on the nearest project frame; the frame grid is what plays and saves.
    const start = Math.round(value * fps) / fps + 0;
    if (Math.abs(start - timelineStart) <= 1e-6) { setDraft(display(timelineStart)); setError(undefined); return; }
    // The same checks the move makes: a refused value stays in the field with the reason under it.
    const refusal = project ? clipMoveRefusal(project, clipId, start) : undefined;
    if (refusal) { setError(refusal); return; }
    setError(undefined);
    const ticket = ++commits.current;
    const settle = (accepted: unknown) => {
      if (accepted !== false || commits.current !== ticket) return;
      setDraft(display(timelineStart)); setError(CLIP_START_NOT_MOVED);
    };
    const result = onMove(start);
    if (result instanceof Promise) void result.then(settle, () => settle(false)); else settle(result);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); commit(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(display(timelineStart)); setError(undefined); }
  };

  return <div className="clip-start-field" data-testid="clip-start-field">
    <label className="field-label">{uiText("片段從第幾秒開始")}
      <div className="number-field">
        <input type="number" inputMode="decimal" min="0" step="0.1" value={draft} aria-invalid={Boolean(error)} data-testid="clip-start-input"
          aria-describedby={error ? `clip-start-error-${clipId}` : undefined}
          onChange={event => { setDraft(event.target.value); setError(undefined); }} onBlur={commit} onKeyDown={keyDown} />
        <span>sec</span>
      </div>
    </label>
    {error
      ? <small className="clip-in-point-error" role="alert" id={`clip-start-error-${clipId}`} data-testid="clip-start-error">{translateUiStatus(error)}</small>
      : <small className="clip-in-point-note">{uiText("輸入秒數後按 Enter 套用。")}</small>}
  </div>;
}

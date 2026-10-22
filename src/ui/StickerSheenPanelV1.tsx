import { useEffect, useRef, useState } from "react";
import type { EditProject } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import type { SubjectOverlayBakeRequestV1 } from "../application/subjectStickerBakeV1";
import { admitSubjectOverlaySourceV1 } from "../application/subjectOverlayProjectV1";
import { createSubjectOverlayInteractionV1, type SubjectOverlayUiApplicationV1, type SubjectOverlayUiAckV1, type SubjectOverlayUiStateV1 } from "../application/subjectOverlayInteractionV1";
import type { SubjectStickerStyleV1 } from "../render/subjectStickerV1";
import type { SubjectSheenStyleV1 } from "../render/subjectSheenV1";
import "./stickerSheenPanelV1.css";
export interface StickerSheenLabelsV1 {
  title: string; sticker: string; sheen: string; cancel: string; idle: string; applying: string; done: string;
  clean_hold: string; cancelled: string; failed: string; uncertain: string; unavailable: string; locked: string;
  selectClip: string; unsupported: string; styleUnavailable: string; rangeRequired: string; progress: string; help: string; artPending: string;
}
export interface StickerSheenPanelPropsV1 {
  project: EditProject; projectSession: ProjectSession; clipId: string;
  /** Stable per addition. Supply new unique IDs after an accepted commit. */
  ids: SubjectOverlayBakeRequestV1["ids"]; range: { startFrame: number; endFrame: number };
  /** Explicit host-selected candidates, never locally manufactured defaults. */
  styles?: { sticker: SubjectStickerStyleV1; sheen: SubjectSheenStyleV1 }; labels: StickerSheenLabelsV1; disabled?: boolean;
  onApply?(application: SubjectOverlayUiApplicationV1): Promise<SubjectOverlayUiAckV1>; onPause?(): void;
}
/** Source component for H13's existing selected-clip/engine owner. No shared
 * mount, IPC dispatcher, model, native input or VA/default promotion. */
export function StickerSheenPanelV1(props: StickerSheenPanelPropsV1) {
  const [state, setState] = useState<SubjectOverlayUiStateV1>({ status: "idle" }), latest = useRef(props); latest.current = props;
  const alive = useRef(true), instance = useRef<ReturnType<typeof createSubjectOverlayInteractionV1>>(undefined);
  if (!instance.current) instance.current = createSubjectOverlayInteractionV1({
    read: kind => { const p = latest.current;
      const request: SubjectOverlayBakeRequestV1 = { schema: "editkin.subject-overlay-request/v1", expectedRevision: p.project.revision, clipId: p.clipId, ids: p.ids,
        effect: kind === "sticker" ? { kind, style: p.styles!.sticker } : { kind, style: p.styles!.sheen, range: p.range } };
      return { project: p.project, projectSession: p.projectSession, request, selectionRange: p.range, hostOwner: p.onApply, disabled: p.disabled || !p.styles };
    },
    apply: a => { const fn = latest.current.onApply; if (!fn) throw Error("SUBJECT_OVERLAY_UI_BACKEND_UNAVAILABLE"); return fn(a); },
    onState: next => { if (alive.current) setState(next); }, onPause: () => latest.current.onPause?.(),
  });
  const driver = instance.current;
  useEffect(() => { alive.current = true; driver.resume(); return () => { alive.current = false; driver.dispose(); }; }, []);
  useEffect(() => driver.synchronize(), [props.project, props.projectSession, props.clipId, props.ids, props.range, props.styles, props.disabled, props.onApply]);
  useEffect(() => props.projectSession.subscribe(() => driver.synchronize()), [props.projectSession]);
  const l = props.labels, track = props.project.tracks.find(t => t.clips.some(c => c.id === props.clipId)), clip = track?.clips.find(c => c.id === props.clipId);
  const unsupported = (kind: "sticker" | "sheen") => { try { admitSubjectOverlaySourceV1(props.project, props.clipId, kind); return false; } catch { return true; } };
  const stickerUnsupported = unsupported("sticker"), sheenUnsupported = unsupported("sheen");
  const busy = state.status === "applying", terminal = state.status === "done" || state.status === "uncertain";
  const start = clip ? Math.round(clip.timelineStart * props.project.fps) : 0, end = clip ? start + Math.round(clip.duration * props.project.fps) : 0;
  const count = props.range.endFrame - props.range.startFrame, rangeValid = [props.range.startFrame, props.range.endFrame].every(Number.isSafeInteger) && props.range.startFrame >= start && props.range.endFrame <= end && count >= 3 && count <= 240;
  const disabled = busy || terminal || props.disabled || !props.onApply || !props.styles;
  const status = !track || !clip ? l.selectClip : track.locked ? l.locked : !props.onApply ? l.unavailable : !props.styles ? l.styleUnavailable : stickerUnsupported && sheenUnsupported ? l.unsupported : l[state.status];
  return <section className="sticker-sheen-panel-v1" aria-label={l.title} aria-busy={busy} data-testid="sticker-sheen-panel" data-state={state.status}
    onKeyDown={e => { if (e.key === "Escape" && busy) { e.preventDefault(); e.stopPropagation(); driver.cancel(); } }}>
    <strong>{l.title}</strong><p>{l.help}</p>
    <div className="sticker-sheen-actions"><button type="button" data-testid="subject-sticker-add" title={stickerUnsupported ? l.unsupported : undefined} disabled={disabled || stickerUnsupported} onClick={() => { void driver.apply("sticker"); }}>{l.sticker}</button>
      <button type="button" data-testid="subject-sheen-add" title={sheenUnsupported ? l.unsupported : undefined} disabled={disabled || sheenUnsupported || !rangeValid} onClick={() => { void driver.apply("sheen"); }}>{l.sheen}</button>
      {busy && <button type="button" data-testid="subject-overlay-cancel" onClick={() => driver.cancel()}>{l.cancel}</button>}</div>
    {!rangeValid && <small>{l.rangeRequired}</small>}
    <p role="status" aria-live="polite" data-testid="subject-overlay-status">{status}</p>
    {busy && state.progress && <label>{l.progress}<progress aria-label={l.progress} max={state.progress.total} value={state.progress.frames} /></label>}
    <small>{l.artPending}</small>
  </section>;
}

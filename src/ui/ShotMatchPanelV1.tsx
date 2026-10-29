import { useEffect, useRef, useState } from "react";
import { createShotMatchPanelInteractionV1, type ShotMatchPanelStateV1 } from "./shotMatchPanelInteractionV1";
import { replaceShotMatchMarkV1, shotMatchReferenceStripV1, type ShotMatchHostV1, type ShotMatchFramesV1 } from "./shotMatchPanelModelV1";
import { ShotGradeRegionPickerV1 } from "./ShotGradeRegionPickerV1";
import type { ShotGradeRegionV1 } from "../color/shotGradeStatisticsV1";

export interface ShotMatchLabelsV1 {
  title: string; target: string; reference: string; chooseReference: string; match: string; balance: string; apply: string; cancel: string; discard: string; reload: string;
  neutral: string; skin: string; clearMarks: string; sample: string; before: string; after: string; append: string; replace: string; nodeLabel: string; nodeName: string; timeout: string;
  markHelp: string; optionalMarks: string; idle: string; loading: string; analysing: string; ready: string; applying: string; applied: string; unchanged: string;
  not_applicable: string; held: string; cancelled: string; uncertain: string; unavailable: string; locked: string; aces: string; stale: string; frames: string; destination: string;
}
interface Props { getHost(): ShotMatchHostV1 | undefined; labels: ShotMatchLabelsV1; }
type Control = ReturnType<typeof createShotMatchPanelInteractionV1>;
function Frames({ frames, name, contextKey, regions, role, disabled, labels, onMark }: {
  frames?: ShotMatchFramesV1; name: string; contextKey: string; regions: ShotGradeRegionV1[]; role: "neutral" | "skin"; disabled: boolean;
  labels: ShotMatchLabelsV1; onMark(region: ShotGradeRegionV1): void;
}) {
  const [index, setIndex] = useState(0), frame = frames?.frames[index] ?? frames?.frames[0];
  useEffect(() => setIndex(0), [frames?.clipId]);
  return <fieldset className="grade-v2-panel" data-testid={`shot-match-${name}`}>
    <legend>{name === "target" ? labels.target : labels.reference}</legend>
    {frames && <label>{labels.sample}<select aria-label={labels.sample} value={frame?.sampleId ?? ""} onChange={event => setIndex(frames.frames.findIndex(f => f.sampleId === event.target.value))}>
      {frames.frames.map(f => <option key={f.sampleId} value={f.sampleId}>{f.timeSeconds.toFixed(2)}s</option>)}</select></label>}
    {frame && <ShotGradeRegionPickerV1 frame={frame} contextKey={`${contextKey}/${frames?.sourceSha256}/${frame.sampleId}`} regions={regions} role={role}
      label={name === "target" ? labels.target : labels.reference} help={labels.markHelp} disabled={disabled} onMark={onMark}/>}
  </fieldset>;
}
/** Controlled source-only panel. Shared host wiring and five-language generation remain with the integrator. */
export function ShotMatchPanelV1(props: Props) {
  const latest = useRef(props); latest.current = props;
  const control = useRef<Control | undefined>(undefined), [state, setState] = useState<ShotMatchPanelStateV1>({ status: "idle", draft: { targetRegions: [], referenceRegions: [], destination: { kind: "append", label: props.labels.nodeLabel } } });
  const [role, setRole] = useState<"neutral" | "skin">("neutral"), [after, setAfter] = useState(false);
  useEffect(() => {
    const active = createShotMatchPanelInteractionV1(() => latest.current.getHost(), latest.current.labels.nodeLabel, setState); control.current = active;
    void active.refresh(); return () => { active.dispose(); if (control.current === active) control.current = undefined; };
  }, []);
  useEffect(() => { void control.current?.refresh(); });
  useEffect(() => { setAfter(false); }, [state.comparison]);
  const labels = props.labels, busy = ["loading", "analysing", "applying"].includes(state.status), sealed = state.status === "applying" || state.status === "uncertain";
  let host: ShotMatchHostV1 | undefined, strip: ReturnType<typeof shotMatchReferenceStripV1> | undefined;
  try { host = props.getHost(); if (host) strip = shotMatchReferenceStripV1(host); } catch { /* Visible state is supplied by the interaction owner. */ }
  const draft = state.draft, change = (next: typeof draft) => { control.current?.changeDraft(next); }, nodes = host?.project.tracks.flatMap(t => t.clips).find(c => c.id === host?.targetClipId)?.gradeV2?.nodes;
  const mark = (side: "target" | "reference", region: ShotGradeRegionV1) => change({ ...draft, [side === "target" ? "targetRegions" : "referenceRegions"]: replaceShotMatchMarkV1(side === "target" ? draft.targetRegions : draft.referenceRegions, region) });
  const visible = state.comparison ? after ? state.comparison.after : state.comparison.before : state.target;
  const key = `${host?.sessionId}/${host?.project.id}/${host?.project.revision}/${host?.targetClipId}`;
  const message = state.code ? state.code === "reference" ? labels.chooseReference : labels[state.code] : labels[state.status];
  return <section className="grade-v2-panel" aria-label={labels.title} data-testid="shot-match-panel" data-status={state.status} onKeyDown={event => {
    if (event.key === "Escape" && busy) { event.preventDefault(); event.stopPropagation(); control.current?.cancel(); return; }
    const target = event.target as HTMLElement;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (["m", "b"].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); void control.current?.run(event.key.toLowerCase() === "m" ? "shot_match" : "auto_balance"); }
  }}>
    <strong>{labels.title}</strong>
    <div className="film-look-list" aria-label={labels.reference} data-testid="shot-match-reference-strip">
      <label>{labels.reference}<select data-testid="shot-match-reference-select" disabled={sealed} value={draft.referenceClipId ?? ""} onChange={event => change({ ...draft, referenceClipId: event.target.value || undefined })}>
        <option value="">{labels.chooseReference}</option>{strip?.clips.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      {strip?.clips.map(c => <button key={c.id} type="button" disabled={sealed} aria-pressed={draft.referenceClipId === c.id} data-reference-id={c.id} onClick={() => change({ ...draft, referenceClipId: c.id })}>{c.name}</button>)}
    </div>
    <div className="grade-node-actions">
      <button type="button" aria-pressed={role === "neutral"} onClick={() => setRole("neutral")}>{labels.neutral}</button>
      <button type="button" aria-pressed={role === "skin"} onClick={() => setRole("skin")}>{labels.skin}</button>
      <button type="button" disabled={busy || sealed} onClick={() => change({ ...draft, targetRegions: [], referenceRegions: [] })}>{labels.clearMarks}</button>
      <button type="button" disabled={busy || sealed} onClick={() => { void control.current?.reload(); }} data-testid="shot-match-reload">{labels.reload}</button>
    </div>
    <small>{labels.optionalMarks}</small>
    <Frames frames={visible} name="target" contextKey={key} regions={draft.targetRegions} role={role} disabled={busy || sealed || Boolean(state.comparison)} labels={labels} onMark={region => mark("target", region)}/>
    <Frames frames={state.reference} name="reference" contextKey={key} regions={draft.referenceRegions} role={role} disabled={busy || sealed || Boolean(state.comparison)} labels={labels} onMark={region => mark("reference", region)}/>
    <label>{labels.destination}<select data-testid="shot-match-destination" disabled={busy || sealed} value={draft.destination.kind} onChange={event => {
      if (event.target.value === "replace" && nodes?.at(-1)) change({ ...draft, destination: { kind: "replace", nodeId: nodes.at(-1)!.id, label: draft.destination.label } });
      else change({ ...draft, destination: { kind: "append", label: draft.destination.label } });
    }}><option value="append">{labels.append}</option><option value="replace" disabled={!nodes?.length}>{labels.replace}</option></select></label>
    <label>{labels.nodeName}<input data-testid="shot-match-node-label" disabled={busy || sealed} maxLength={120} value={draft.destination.label} onChange={event => change({ ...draft, destination: { ...draft.destination, label: event.target.value } })}/></label>
    <div className="grade-v2-actions">
      <button type="button" disabled={busy || sealed || !state.target || !state.reference} onClick={() => { void control.current?.run("shot_match"); }} data-testid="shot-match-analyse">{labels.match}</button>
      <button type="button" disabled={busy || sealed || !state.target} onClick={() => { void control.current?.run("auto_balance"); }} data-testid="shot-balance-analyse">{labels.balance}</button>
      {state.comparison && <button type="button" disabled={busy || sealed} aria-pressed={after} onClick={() => setAfter(v => !v)} data-testid="shot-match-ab">{after ? labels.after : labels.before}</button>}
      <button type="button" disabled={state.status !== "ready"} onClick={() => { void control.current?.apply(); }} data-testid="shot-match-apply">{labels.apply}</button>
      {(busy || state.review) && <button type="button" onClick={() => control.current?.cancel()} data-testid="shot-match-cancel">{busy ? labels.cancel : labels.discard}</button>}
    </div>
    <small role="status" data-testid="shot-match-notice">{message}</small>
  </section>;
}

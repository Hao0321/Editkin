import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditProject } from "../domain/types";
import type { ProjectSession } from "../application/projectSession";
import type { AnnotationTargetV1, AnnotationKindV1 } from "../application/annotationDraftV1";
import { createAnnotationInteractionV1, annotationInteractionErrorKindV1, type AnnotationApplicationV1, type AnnotationStateV1 } from "../application/annotationInteractionV1";
import { AnnotationPreviewOverlayV1 } from "./AnnotationPreviewOverlayV1";
import "./annotationToolV1.css";

/** Host supplies reviewed H15 strings. Proposal71 is not a live catalogue/default. */
export interface AnnotationLabelsV1 {
  title: string; arrow: string; circle: string; underline: string; tracking: string; trackingMode: string; none: string; anchor: string; surface: string;
  apply: string; cancel: string; help: string; preview: string; idle: string; armed: string; drawing: string; ready: string;
  applying: string; done: string; failed: string; locked: string; source: string; trackingError: string; stale: string;
  invalid: string; unavailable: string; uncertain: string; artPending: string;
}
export interface AnnotationToolPropsV1 {
  project: EditProject; projectSession: ProjectSession; target: AnnotationTargetV1; labels: AnnotationLabelsV1;
  /** Host's existing positioned preview canvas container, not an invented second player. */
  previewRoot?: HTMLElement | null; disabled?: boolean;
  onCommand?(application: AnnotationApplicationV1): { status: "applied" | "cancelled" } | Promise<{ status: "applied" | "cancelled" }>;
  onPause(): void; onError?(error: unknown): void; makeId?(): string;
}
export function AnnotationToolV1(props: AnnotationToolPropsV1) {
  const latest = useRef(props); latest.current = props;
  const [state, setState] = useState<AnnotationStateV1>({ status: "idle" }), [tracking, setTracking] = useState(props.target.tracking);
  const selectedTracking = useRef(tracking); selectedTracking.current = tracking;
  const alive = useRef(true), interaction = useRef<ReturnType<typeof createAnnotationInteractionV1>>(undefined), lastButton = useRef<HTMLButtonElement | null>(null);
  if (!interaction.current) interaction.current = createAnnotationInteractionV1({
    read: () => { const p = latest.current; return { project: p.project, projectSession: p.projectSession, target: { ...p.target, tracking: selectedTracking.current },
      hostReady: !!p.onCommand && !!p.previewRoot, commandOwner: p.onCommand, disabled: p.disabled }; },
    apply: application => { const fn = latest.current.onCommand; if (!fn) throw Error("ANNOTATION_HOST_UNAVAILABLE"); return fn(application); },
    makeId: () => latest.current.makeId?.() ?? `annotation-${crypto.randomUUID()}`,
    name: kind => latest.current.labels[kind], onPause: () => latest.current.onPause(), onError: error => latest.current.onError?.(error),
    onState: value => { if (alive.current) setState(value); },
  });
  const driver = interaction.current;
  useEffect(() => { alive.current = true; driver.resume(); return () => { alive.current = false; driver.dispose(); }; }, []);
  useEffect(() => driver.invalidate(), [props.project, props.projectSession, props.target, props.previewRoot, props.onCommand, props.disabled, tracking]);
  useEffect(() => props.projectSession.subscribe(() => driver.invalidate()), [props.projectSession]);
  useEffect(() => { setTracking(props.target.tracking); }, [props.target.clipId, props.target.tracking?.trackId, props.target.tracking?.mode]);
  useEffect(() => { if (["idle", "done"].includes(state.status)) lastButton.current?.focus(); }, [state.status]);
  const l = props.labels, busy = state.status === "applying", active = !!state.kind && ["armed", "drawing", "ready"].includes(state.status);
  const tracks = props.project.motionTracks.filter(t => t.clipId === props.target.clipId), available = !!props.onCommand && !!props.previewRoot && !props.disabled;
  const errorKind = state.error ? annotationInteractionErrorKindV1(state.error) : undefined;
  const message = errorKind ? errorKind === "tracking" ? l.trackingError : l[errorKind] : !available ? l.unavailable : l[state.status];
  const choose = (kind: AnnotationKindV1, button: HTMLButtonElement) => { lastButton.current = button; driver.arm(kind); };
  return <section className="annotation-tool-v1" aria-label={l.title} data-testid="annotation-tool" data-state={state.status} aria-busy={busy}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); driver.cancel(); } }}>
    <strong>{l.title}</strong>
    <div className="annotation-tool-actions-v1" role="group" aria-label={l.title}>
      {(["arrow", "circle", "underline"] as const).map(kind => <button key={kind} type="button" disabled={!available || busy} aria-pressed={active && state.kind === kind}
        data-testid={`annotation-${kind}`} onClick={event => choose(kind, event.currentTarget)}>{l[kind]}</button>)}
    </div>
    <div className="annotation-tool-tracking-v1">
      <label>{l.tracking}<select aria-label={l.tracking} disabled={!available || busy || !tracks.length} value={tracking?.trackId ?? ""}
        onChange={event => { lastButton.current = null; driver.cancel(); setTracking(event.currentTarget.value ? { trackId: event.currentTarget.value, mode: "anchor" } : undefined); }}>
        <option value="">{l.none}</option>{tracks.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}
      </select></label>
      {tracking && <select aria-label={l.trackingMode} disabled={!available || busy} value={tracking.mode}
        onChange={event => { lastButton.current = null; driver.cancel(); const mode = event.currentTarget.value; if (mode === "anchor" || mode === "surface") setTracking({ ...tracking, mode }); }}>
        <option value="anchor">{l.anchor}</option><option value="surface">{l.surface}</option>
      </select>}
    </div>
    <p role="status" aria-live="polite" data-testid="annotation-status">{message}</p>
    <p className="annotation-tool-help-v1">{l.help}</p><small>{l.artPending}</small>
    {active && <div className="annotation-tool-actions-v1">
      <button type="button" disabled={state.status !== "ready" || !available} onClick={() => { void driver.commit(); }} data-testid="annotation-apply">{l.apply}</button>
      <button type="button" onClick={() => driver.cancel()} data-testid="annotation-cancel">{l.cancel}</button>
    </div>}
    {active && props.previewRoot && createPortal(<AnnotationPreviewOverlayV1 driver={driver} state={state} width={props.project.width} height={props.project.height} label={l.preview} />, props.previewRoot)}
  </section>;
}

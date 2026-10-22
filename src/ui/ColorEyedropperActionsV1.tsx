import { useEffect, useRef, useState } from "react";
import { assertEyedropperBrowserAdmissionV1, createEyedropperActionInteractionV1,
  type EyedropperActionContextV1, type EyedropperActionHostV1, type EyedropperActionStateV1, type EyedropperSampleStateV1 } from "../application/eyedropperActionInteractionV1";
import { EyedropperRefusalV1, type EyedropperRefusalCodeV1 } from "../color/eyedropperActionsV1";

export interface ColorEyedropperLabelsV1 {
  title: string; neutral: string; hsl: string; cancel: string; balanceNode: string; help: string;
  idle: string; pending: string; applied: string; unchanged: string; held: string; cancelled: string; uncertain: string;
  originalRequired: string; calibrationRequired: string; stale: string; locked: string; nodeRequired: string; nodeLimit: string; sourceUnsupported: string; lutUnavailable: string;
}
export interface ColorEyedropperConfigurationV1 { getHost(): EyedropperActionHostV1 | undefined; labels: ColorEyedropperLabelsV1; }
interface Props { configuration: ColorEyedropperConfigurationV1; readSample(): EyedropperSampleStateV1; disabled?: boolean; }

function reason(code: EyedropperRefusalCodeV1 | undefined, labels: ColorEyedropperLabelsV1): string | undefined {
  switch (code) {
    case "EYEDROPPER_GRADED": return labels.originalRequired;
    case "EYEDROPPER_CALIBRATION": return labels.calibrationRequired;
    case "EYEDROPPER_STALE": return labels.stale;
    case "EYEDROPPER_LOCKED": return labels.locked;
    case "EYEDROPPER_NODE": return labels.nodeRequired;
    case "EYEDROPPER_NODE_LIMIT": return labels.nodeLimit;
    case "EYEDROPPER_SOURCE": return labels.sourceUnsupported;
    case "EYEDROPPER_LUT": return labels.lutUnavailable;
    default: return undefined;
  }
}

/** Host labels and context are optional at the existing picker boundary. */
export function ColorEyedropperActionsV1(props: Props) {
  const latest = useRef(props); latest.current = props;
  const control = useRef<ReturnType<typeof createEyedropperActionInteractionV1> | undefined>(undefined);
  const [state, setState] = useState<EyedropperActionStateV1>({ status: "idle" });
  const readContext = (): EyedropperActionContextV1 | undefined => {
    const p = latest.current, host = p.configuration.getHost();
    return host ? { ...host, ...p.readSample(), editable: host.editable === true && p.disabled !== true } : undefined;
  };
  useEffect(() => {
    const active = createEyedropperActionInteractionV1(readContext, setState); control.current = active;
    setState(active.state());
    return () => { active.dispose(); if (control.current === active) control.current = undefined; };
  }, []);
  let context: EyedropperActionContextV1 | undefined, refusal: EyedropperRefusalCodeV1 | undefined;
  try { context = readContext(); if (!context) refusal = "EYEDROPPER_UNAVAILABLE"; else assertEyedropperBrowserAdmissionV1(context, "neutral"); }
  catch (error) { refusal = error instanceof EyedropperRefusalV1 ? error.code : "EYEDROPPER_PARAMETERS"; }
  const labels = props.configuration.labels, pending = state.status === "pending";
  const disabled = Boolean(refusal || pending || control.current?.consumed(context?.sample));
  const hasNode = Boolean(context?.selectedNodeId && context.clip.gradeV2?.nodes?.some(node => node.id === context.selectedNodeId));
  const message = state.status === "idle" ? reason(refusal, labels) ?? labels.idle : reason(state.code, labels) ?? labels[state.status];
  return <section className="color-eyedropper-actions" aria-label={labels.title} data-testid="color-eyedropper-actions" data-action-status={state.status}
    onKeyDown={event => { if (event.key === "Escape" && pending) { event.preventDefault(); event.stopPropagation(); control.current?.cancel(); } }}>
    <div className="grade-node-actions">
      <button type="button" data-testid="eyedropper-neutral-action" disabled={disabled} onClick={() => void control.current?.run("neutral")}>{labels.neutral}</button>
      <button type="button" data-testid="eyedropper-hsl-action" disabled={disabled || !hasNode} title={!hasNode ? labels.nodeRequired : undefined} onClick={() => void control.current?.run("hsl")}>{labels.hsl}</button>
      {pending && <button type="button" data-testid="eyedropper-cancel-action" onClick={() => control.current?.cancel()}>{labels.cancel}</button>}
    </div>
    <small role="status">{message}</small><small>{labels.help}</small>
  </section>;
}

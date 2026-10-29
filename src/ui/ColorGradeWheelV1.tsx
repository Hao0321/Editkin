import { useEffect, useRef, type PointerEvent } from "react";
import type { ColorWheelV2 } from "../domain/visualTypes";
import { GRADE_WHEEL_BOUNDS_V1, wheelFromPointV1, wheelPointV1, type GradeWheelKindV1 } from "../domain/colorGradePanelEditsV1";
import { createParameterRangeGestureInputV1 } from "./parameterRangeGestureInputV1";
import { translateUi as uiText } from "./i18n/interfacePreferences";
const LABELS: Record<GradeWheelKindV1, string> = { offset: "Offset 色輪", lift: "Lift 色輪", gamma: "Gamma 色輪", gain: "Gain 色輪" };
interface Props { kind: GradeWheelKindV1; wheel?: ColorWheelV2; disabled: boolean; onDraft: (wheel: ColorWheelV2) => void; onCommit: () => void; onCancel: () => void }
export function ColorGradeWheelV1({ kind, wheel, disabled, onDraft, onCommit, onCancel }: Props) {
  type Held = { pointerId?: number; target?: HTMLButtonElement; wheel: ColorWheelV2 };
  const held = useRef<Held | undefined>(undefined), mounted = useRef(true), latest = useRef({wheel,onDraft,onCommit,onCancel});
  latest.current = {wheel,onDraft,onCommit,onCancel};
  const masterInput = useRef<ReturnType<typeof createParameterRangeGestureInputV1> | undefined>(undefined);
  masterInput.current ??= createParameterRangeGestureInputV1();
  const finish = (commit: boolean) => {
    const input = held.current; held.current = undefined;
    if (!input) return;
    try { if (commit) latest.current.onCommit(); else latest.current.onCancel(); }
    finally { try { if (input.pointerId !== undefined && input.target?.hasPointerCapture(input.pointerId)) input.target.releasePointerCapture(input.pointerId); } catch { /* detached capture */ } }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; finish(false); masterInput.current?.cancel(); }; }, []);
  const point = wheelPointV1(wheel), [min, max] = GRADE_WHEEL_BOUNDS_V1[kind];
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const input = held.current; if (!mounted.current || !input || input.pointerId !== event.pointerId || disabled) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const next = wheelFromPointV1(input.wheel, kind, (event.clientX - box.left) / box.width * 2 - 1, (event.clientY - box.top) / box.height * 2 - 1);
    input.wheel = next; latest.current.onDraft(next);
  };
  const master = masterInput.current.bind(kind + ".master", () => {
    finish(false);
    return { update: value => { if (!mounted.current || disabled) return false; latest.current.onDraft({...latest.current.wheel, master:value}); return true; },
      commit: () => { latest.current.onCommit(); return true; }, cancel: () => latest.current.onCancel() };
  });
  return <div className="grade-node-wheel">
    <strong>{uiText(LABELS[kind])}</strong>
    <button type="button" className="grade-wheel-disc" aria-label={uiText(LABELS[kind])} disabled={disabled} data-testid={`grade-node-wheel-${kind}`}
      onPointerDown={event => {
        if (!mounted.current || disabled || event.button !== 0 || event.isPrimary === false || held.current) return;
        masterInput.current?.cancel(); held.current = {pointerId:event.pointerId,target:event.currentTarget,wheel:{...wheel}};
        try { event.currentTarget.setPointerCapture(event.pointerId); move(event); } catch { finish(false); }
      }}
      onPointerMove={move}
      onPointerUp={event => { if (held.current?.pointerId === event.pointerId) finish(true); }}
      onPointerCancel={event => { if (held.current?.pointerId === event.pointerId) finish(false); }}
      onLostPointerCapture={event => { if (held.current?.pointerId === event.pointerId) finish(false); }}
      onKeyDown={event => {
        if (!mounted.current || disabled || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); return; }
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || held.current?.pointerId !== undefined) return;
        event.preventDefault(); masterInput.current?.cancel();
        const input = held.current ?? (held.current = {wheel:{...wheel}}), current = wheelPointV1(input.wheel), step = event.shiftKey ? .1 : .02;
        input.wheel = wheelFromPointV1(input.wheel, kind, current.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), current.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
        latest.current.onDraft(input.wheel);
      }}
      onKeyUp={event => { if (!event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229 && event.key.startsWith("Arrow") && held.current?.pointerId === undefined) finish(true); }}
      onBlur={() => finish(held.current?.pointerId === undefined)}>
      <span className="grade-wheel-center" /><span className="grade-wheel-cursor" style={{ left: `${50 + point.x * 43}%`, top: `${50 + point.y * 43}%` }} />
    </button>
    <small>R {(wheel?.r ?? 0).toFixed(3)} · G {(wheel?.g ?? 0).toFixed(3)} · B {(wheel?.b ?? 0).toFixed(3)}</small>
    <label><span>{uiText("Master")}<output>{(wheel?.master ?? 0).toFixed(3)}</output></span>
      <input type="range" min={min} max={max} step="0.005" value={wheel?.master ?? 0} disabled={disabled} aria-label={`${uiText(LABELS[kind])} ${uiText("Master")}`}
        {...master.events} onChange={event => { const value=Number(event.target.value); if (!master.change(event.currentTarget,value)) latest.current.onDraft({...latest.current.wheel,master:value}); }} /></label>
  </div>;
}

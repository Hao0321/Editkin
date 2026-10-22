import { useEffect, useMemo, useRef, type InputHTMLAttributes } from "react";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { NativeImeEventV1 } from "./nativeImeEventV1";

export interface NumberEditControlV1 {
  value: string; valueAsNumber: number;
  readonly validity?: Pick<ValidityState, "valid">;
  setCustomValidity?: (message: string) => void; reportValidity?: () => boolean;
}
type Target = NumberEditControlV1;
interface KeyEvent { currentTarget: Target; key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; nativeEvent?: NativeImeEventV1; preventDefault: () => void; stopPropagation?: () => void }
interface PreviewOptions {
  onGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  onDraftSample?: (value: number, control: NumberEditControlV1) => boolean;
  onDraftConfirm?: (value: number, control: NumberEditControlV1) => boolean;
  onDraftRejected?: () => void;
}
/** Only the input draft, never a project owner. Capture the actual edit's callback across rerenders. */
export function createNumberEditDraftV1() {
  type Edit = { value: number; scope: unknown; commit: (value: number, control?: NumberEditControlV1) => boolean | void;
    options: PreviewOptions; lease?: ParameterGestureLeaseV1 | null; accepted: boolean; composing: boolean };
  let edit: Edit | undefined, live: { value: number; scope: unknown } | undefined, disposed = false;
  const cancel = () => { const old = edit; edit = undefined; old?.lease?.cancel(); };
  const reset = (target: Target | null, value: number) => { cancel(); if (target) target.value = String(value); };
  return {
    cancel, reset,
    mount: () => { disposed = false; },
    dispose: () => { if (!disposed) { disposed = true; cancel(); } },
    bind: (value: number, scope: unknown, onCommit: (value: number, control?: NumberEditControlV1) => boolean | void, options: PreviewOptions = {}) => {
      live = { value, scope };
      const current = () => !disposed && live?.value === value && live.scope === scope;
      const ensure = () => edit ??= { value, scope, commit: onCommit, options, accepted: false, composing: false };
      const update = (target: Target, candidate = target.valueAsNumber) => {
        if (!current()) return;
        const started = ensure();
        if (started.value !== value || started.scope !== scope) return;
        started.accepted = false;
        if (started.composing || !target.value.trim() || !Number.isFinite(candidate)) return;
        try {
          if (started.lease === undefined && started.options.onGestureStart) started.lease = started.options.onGestureStart() ?? null;
          if (started.lease === null) return;
          if (started.lease && started.options.onDraftSample?.(candidate, target) === false) return;
          started.accepted = started.lease ? started.lease.update(candidate) : true;
        } catch { started.lease?.cancel(); started.lease = null; }
      };
      const commit = (target: Target) => {
        if (!current()) return false;
        const started = edit;
        if (!started) return true;
        const next = target.valueAsNumber;
        const reject = () => { try { started.options.onDraftRejected?.(); } finally { reset(target, live!.value); } return false; };
        if (started.scope !== scope || started.value !== value || started.composing || !target.value.trim() || !Number.isFinite(next)) { reset(target, live!.value); return false; }
        if (next === started.value) { reset(target, value); return true; }
        try {
          if (started.options.onGestureStart) {
            if (started.lease === undefined) started.lease = started.options.onGestureStart() ?? null;
            if (!started.lease || started.options.onDraftConfirm?.(next, target) === false) return reject();
            update(target, next); // Use the captured numeric sample even if confirmation formats the DOM value.
            if (!started.accepted) return reject();
          }
          edit = undefined;
          const accepted = started.lease ? started.lease.commit() : started.commit(next, target) !== false;
          if (!accepted) { started.lease?.cancel(); return reject(); }
          return true;
        } catch { started.lease?.cancel(); return reject(); }
      };
      return {
        onChange: (event?: { currentTarget: Target; nativeEvent?: NativeImeEventV1 }) => {
          if (!current()) return;
          const started = ensure();
          if (event?.nativeEvent?.isComposing) { started.composing = true; started.accepted = false; return; }
          if (event) update(event.currentTarget);
        },
        onCompositionStart: () => { if (current()) ensure().composing = true; },
        onCompositionEnd: (event: { currentTarget: Target }) => { if (!current() || !edit?.composing) return; edit.composing = false; update(event.currentTarget); },
        onBlur: (event: { currentTarget: Target }) => commit(event.currentTarget),
        onKeyDown: (event: KeyEvent) => {
          if (!current() || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229 || edit?.composing) return;
          if (event.key === "Enter") { event.preventDefault(); commit(event.currentTarget); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation?.(); reset(event.currentTarget, live!.value); }
          else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s" && !commit(event.currentTarget)) { event.preventDefault(); event.stopPropagation?.(); }
        },
      };
    },
  };
}
interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange">, PreviewOptions {
  value: number; scope?: unknown; onCommit: (value: number, control?: NumberEditControlV1) => boolean | void;
  draft?: ReturnType<typeof createNumberEditDraftV1>;
}
export function renderNumberEditFieldV1({ value, scope, onCommit, draft = createNumberEditDraftV1(), onGestureStart, onDraftSample, onDraftConfirm, onDraftRejected, ...props }: Props) {
  return <input {...props} type="number" step={props.step ?? "any"} defaultValue={value} {...draft.bind(value, scope, onCommit, { onGestureStart, onDraftSample, onDraftConfirm, onDraftRejected })} />;
}
export function NumberEditFieldV1(props: Props) {
  const draft = useMemo(() => createNumberEditDraftV1(), []), input = useRef<HTMLInputElement>(null);
  useEffect(() => { draft.mount(); return draft.dispose; }, [draft]);
  useEffect(() => { draft.reset(input.current, props.value); return draft.cancel; }, [draft, props.scope, props.value]);
  // The ref is attached at the actual DOM input; pure source tests use the same exported render body.
  const element = renderNumberEditFieldV1({ ...props, draft });
  return <input {...element.props} ref={input} />;
}

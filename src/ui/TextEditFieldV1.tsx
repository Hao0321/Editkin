import { useEffect, useMemo, useRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { NativeImeEventV1 } from "./nativeImeEventV1";
interface Target { value: string }
interface KeyEvent { currentTarget: Target; key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
  nativeEvent?: NativeImeEventV1; preventDefault: () => void; stopPropagation?: () => void }
interface Options { multiline?: boolean; onGestureStart?: () => ParameterGestureLeaseV1<string> | undefined; onReject?: () => void }
/** Local DOM text plus the existing shared preview lease; only confirmation reaches the canonical writer. */
export function createTextEditDraftV1() {
  type Edit = { initial: string; scope: unknown; commit: (value: string) => boolean | void; options: Options;
    lease?: ParameterGestureLeaseV1<string> | null; composing: boolean; accepted: boolean };
  let edit: Edit | undefined, live: { value: string; scope: unknown } | undefined, disposed = false;
  const cancel = () => { const old = edit; edit = undefined; old?.lease?.cancel(); };
  const reset = (target: Target | null, value: string) => { cancel(); if (target) target.value = value; };
  return {
    cancel, reset,
    mount: () => { disposed = false; },
    dispose: () => { if (!disposed) { disposed = true; cancel(); } },
    bind: (value: string, scope: unknown, onCommit: (value: string) => boolean | void, options: Options = {}) => {
      live = { value, scope };
      const current = () => !disposed && live?.value === value && live.scope === scope;
      const ensure = () => edit ??= { initial: value, scope, commit: onCommit, options, composing: false, accepted: false };
      const update = (target: Target, composing = false) => {
        if (!current()) return;
        const started = ensure(); if (started.scope !== scope || started.initial !== value) return;
        if (started.composing || composing) { started.composing = true; return; }
        try {
          if (started.lease === undefined && started.options.onGestureStart) started.lease = started.options.onGestureStart() ?? null;
          started.accepted = started.lease === null ? false : started.lease ? started.lease.update(target.value) : true;
        } catch { started.lease?.cancel(); started.lease = null; started.accepted = false; }
      };
      const commit = (target: Target): boolean => {
        if (!current()) return false;
        const started = edit; if (!started) return true;
        if (started.scope !== scope || started.initial !== value || started.composing) { reset(target, live!.value); return false; }
        if (target.value === started.initial) { reset(target, value); return true; }
        update(target);
        if (!started.accepted) { started.options.onReject?.(); reset(target, live!.value); return false; }
        edit = undefined;
        try {
          const accepted = started.lease ? started.lease.commit() : started.commit(target.value) !== false;
          if (!accepted) { started.options.onReject?.(); started.lease?.cancel(); target.value = live!.value; }
          return accepted;
        } catch { started.lease?.cancel(); started.options.onReject?.(); target.value = live!.value; return false; }
      };
      return {
        onChange: (event: { currentTarget: Target; nativeEvent?: NativeImeEventV1 }) => update(event.currentTarget, event.nativeEvent?.isComposing),
        onCompositionStart: () => { if (current()) ensure().composing = true; },
        onCompositionEnd: (event: { currentTarget: Target }) => { if (!current()) return; ensure().composing = false; update(event.currentTarget); },
        onBlur: (event: { currentTarget: Target }) => commit(event.currentTarget),
        onKeyDown: (event: KeyEvent) => {
          if (!current() || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229 || edit?.composing) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation?.(); reset(event.currentTarget, live!.value); }
          else if (event.key === "Enter" && (!options.multiline || (event.ctrlKey || event.metaKey) && !event.altKey)) { event.preventDefault(); commit(event.currentTarget); }
          else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
            if (!commit(event.currentTarget)) { event.preventDefault(); event.stopPropagation?.(); }
          }
        },
      };
    },
  };
}
type Attributes = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "onBlur" | "onKeyDown" | "onCompositionStart" | "onCompositionEnd">;
interface Props extends Attributes, Options {
  value: string; scope?: unknown; rows?: number; onCommit: (value: string) => boolean | void;
  draft?: ReturnType<typeof createTextEditDraftV1>;
}
export function renderTextEditFieldV1({ value, scope, onCommit, multiline, onGestureStart, onReject, draft = createTextEditDraftV1(), ...props }: Props) {
  const events = draft.bind(value, scope, onCommit, { multiline, onGestureStart, onReject });
  return multiline ? <textarea {...props as TextareaHTMLAttributes<HTMLTextAreaElement>} defaultValue={value} {...events} />
    : <input {...props} defaultValue={value} {...events} />;
}
export function TextEditFieldV1(props: Props) {
  const draft = useMemo(() => createTextEditDraftV1(), []), input = useRef<HTMLInputElement | null>(null), area = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { draft.mount(); return draft.dispose; }, [draft]);
  useEffect(() => { draft.reset(props.multiline ? area.current : input.current, props.value); return draft.cancel; }, [draft, props.scope, props.value, props.multiline]);
  const element = renderTextEditFieldV1({ ...props, draft });
  return props.multiline ? <textarea {...element.props} ref={area} /> : <input {...element.props} ref={input} />;
}

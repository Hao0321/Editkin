import {useEffect, useRef} from "react";
import {createParameterRangeGestureInputV1} from "./parameterRangeGestureInputV1";
import type {NativeImeEventV1} from "./nativeImeEventV1";

type Input = ReturnType<typeof createParameterRangeGestureInputV1>;
type Binding = ReturnType<Input["bind"]>;
type InputEvent = Parameters<Binding["events"]["onPointerDown"]>[0];
type Target = Parameters<Binding["change"]>[0] & {valueAsNumber: number};
interface Callbacks {
  disabled?: boolean; onBegin?: () => boolean | void;
  onDraft: (value: number) => boolean | void; onCommit: () => boolean | void; onCancel: () => void;
}
const sameScope = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Native range math and the existing gesture controller; callbacks can advance only within one identity scope. */
export function createGradeRangeInputV1() {
  const input = createParameterRangeGestureInputV1(), callbacks = new Map<string, Callbacks>();
  let scope: readonly unknown[] = [], heldScope: readonly unknown[] | undefined, disposed = false;
  return {
    setScope: (next: readonly unknown[]) => {
      if (!sameScope(scope, next)) { scope = [...next]; callbacks.clear(); }
    },
    cancel: () => input.cancel(),
    mount: () => { disposed = false; },
    dispose: () => { if (!disposed) { try { input.cancel(); } finally { disposed = true; } } },
    bind: (key: string, next: Callbacks) => {
      callbacks.set(key, next);
      const captured = scope, current = () => !disposed && sameScope(captured, scope) ? callbacks.get(key) : undefined;
      const lease = () => {
        const start = current(); if (!start || start.disabled || start.onBegin?.() === false) return undefined;
        heldScope = captured;
        return {
          update: (value: number) => { const live = current(); return Boolean(live && !live.disabled && Number.isFinite(value) && live.onDraft(value) !== false); },
          commit: () => { const live = current(); return Boolean(live && !live.disabled && live.onCommit() !== false); },
          cancel: () => current()?.onCancel(),
        };
      };
      const binding = input.bind(key, lease);
      const event = (name: keyof Binding["events"], value: InputEvent) => {
        if (!current()) return;
        if ((name === "onPointerDown" || name === "onKeyDown") && heldScope && !sameScope(heldScope, scope)) input.cancel();
        binding.events[name](value);
      };
      return {
        onPointerDown: (value: InputEvent) => event("onPointerDown", value),
        onPointerUp: (value: InputEvent) => event("onPointerUp", value),
        onPointerCancel: (value: InputEvent) => event("onPointerCancel", value),
        onLostPointerCapture: (value: InputEvent) => event("onLostPointerCapture", value),
        onKeyDown: (value: InputEvent) => event("onKeyDown", value),
        onKeyUp: (value: InputEvent) => event("onKeyUp", value),
        onBlur: (value: InputEvent) => event("onBlur", value),
        onChange: (value: {currentTarget: Target; nativeEvent?: NativeImeEventV1}) => {
          const live = current(); if (!live || live.disabled || value.nativeEvent?.isComposing || value.nativeEvent?.keyCode === 229) return;
          const number = value.currentTarget.valueAsNumber; if (!Number.isFinite(number)) return;
          if (binding.change(value.currentTarget, number)) return;
          // AT/programmatic value changes without a physical hold are complete, single transactions.
          const transaction = lease(); if (!transaction) return;
          try { if (transaction.update(number)) transaction.commit(); else transaction.cancel(); } catch { transaction.cancel(); }
        },
      };
    },
  };
}
export function useGradeRangeInputV1(scope: readonly unknown[]) {
  const ref = useRef<ReturnType<typeof createGradeRangeInputV1> | undefined>(undefined);
  ref.current ??= createGradeRangeInputV1();
  ref.current.setScope(scope);
  useEffect(() => { ref.current?.mount(); return () => ref.current?.dispose(); }, []);
  return ref.current;
}

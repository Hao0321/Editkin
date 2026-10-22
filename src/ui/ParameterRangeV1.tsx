import { useEffect, useMemo, type InputHTMLAttributes } from "react";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import { createParameterRangeGestureInputV1 } from "./parameterRangeGestureInputV1";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "defaultValue"> {
  value: number; scopeKey: string; onChange: (value: number) => boolean | void;
  onGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  input?: ReturnType<typeof createParameterRangeGestureInputV1>;
}
export function renderParameterRangeV1({ scopeKey, onGestureStart, onChange, input, ...props }: Props) {
  const gesture = input && onGestureStart ? input.bind(scopeKey, onGestureStart) : undefined;
  return <input {...props} type="range" {...gesture?.events} onChange={event => {
    if (!gesture?.change(event.currentTarget, event.currentTarget.valueAsNumber)) onChange(event.currentTarget.valueAsNumber);
  }} />;
}
export function ParameterRangeV1(props: Props) {
  const input = useMemo(() => createParameterRangeGestureInputV1(), []);
  useEffect(() => () => input.cancel(), [input, props.scopeKey]);
  return renderParameterRangeV1({ ...props, input });
}

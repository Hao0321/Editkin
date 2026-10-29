import type { NativeEffectInstance } from "../domain/types";
import { useEffect, useMemo } from "react";
import type { NativeEffectParameterGestureLeaseV1, NativeEffectParameterPreviewV1 } from "../application/nativeEffectParameterGestureV1";
import { createNativeEffectRangeGestureInputV1 } from "./nativeEffectRangeGestureInputV1";
import type { PluginRegistrySummary } from "../desktop/pluginTypes";
import { nativeEffectParameterViewV1, nativeEffectParameterPatchV1, nativeEffectParameterResetV1 } from "./nativeEffectParametersV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";

interface Props {
  instance: NativeEffectInstance; registry?: PluginRegistrySummary; scopeKey: string;
  onChange: (parameters: NativeEffectInstance["parameters"]) => void;
  /** Production owner receives only changed keys; false refuses without a whole-record fallback. */
  onEdit?: (values: NativeEffectInstance["parameters"]) => boolean | void;
  onGestureStart?: (parameterId: string) => NativeEffectParameterGestureLeaseV1 | undefined;
  preview?: NativeEffectParameterPreviewV1;
  gestureInput?: ReturnType<typeof createNativeEffectRangeGestureInputV1>;
}
/** Existing parameter owners/validators are shared. Rendering the panel never dispatches defaults. */
export function renderNativeEffectParameterControlsV1({ instance, registry, scopeKey, onChange, onEdit, onGestureStart, preview, gestureInput }: Props) {
  const view = nativeEffectParameterViewV1(instance, registry);
  let submittedAny = false;
  return <>
    {!view.matched && <small>{uiText("目前使用專案已儲存的參數；此外掛版本的預設值尚未確認。")}</small>}
    <div className="native-effect-parameters" data-testid="native-effect-parameter-controls">
      {view.rows.map(row => {
        const definition = row.definition, value = preview?.instanceId === instance.id && Object.hasOwn(preview.parameters, row.id)
          ? preview.parameters[row.id] : row.value, name = view.builtin ? uiText(row.name) : row.name;
        const key = `${scopeKey}:${instance.id}:${row.id}`;
        const gesture = gestureInput && onGestureStart ? gestureInput.bind(key, () => onGestureStart(row.id)) : undefined;
        let submittedRow = false, cancelNumberBlur = false, cancelColorBlur = false;
        const commit = (value: unknown): boolean => {
          const parameters = nativeEffectParameterPatchV1(instance, row, value);
          if (!parameters) return false;
          if (onEdit && (parameters !== instance.parameters || submittedRow)) {
            const next = Object.hasOwn(parameters, row.id) ? parameters[row.id] : row.value;
            if (onEdit({ [row.id]: next }) === false) return false;
            submittedRow = true; submittedAny = true;
          } else if (parameters !== instance.parameters) {
            onChange(parameters);
          }
          return true;
        };
        const type = definition?.type ?? typeof value;
        return <div key={key} role="group" aria-label={name}>
          {type === "boolean" ? <label>{name}<input type="checkbox" aria-label={name} checked={value === true}
            onChange={event => commit(event.currentTarget.checked)} /></label>
          : type === "enum" && definition?.type === "enum" ? <label>{name}<select aria-label={name} value={String(value)}
            onChange={event => commit(event.currentTarget.value)}>{definition.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          : type === "number" ? <>
            <label>{name}<input key={`${key}:${String(value)}`} type="number" aria-label={name} defaultValue={typeof value === "number" ? value : ""}
              min={definition?.type === "number" ? definition.min : undefined} max={definition?.type === "number" ? definition.max : undefined}
              step={definition?.type === "number" ? definition.step ?? "any" : "any"}
              onBlur={event => { if (cancelNumberBlur) { cancelNumberBlur = false; return; } if (!commit(event.currentTarget.valueAsNumber)) event.currentTarget.value = typeof value === "number" ? String(value) : ""; }}
              onKeyDown={event => {
                if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
                if (event.key !== "Escape" && event.key !== "Enter") return;
                event.preventDefault();
                if (event.key === "Escape") { cancelNumberBlur = true; event.currentTarget.value = typeof value === "number" ? String(value) : ""; }
                event.currentTarget.blur();
              }} /></label>
            {definition?.type === "number" && definition.min !== undefined && definition.max !== undefined && <input type="range"
              {...gesture?.events}
              aria-label={uiText("{name} 滑桿", { name })} min={definition.min} max={definition.max} step={definition.step ?? "any"}
              value={typeof value === "number" ? value : definition.default} onChange={event => {
                if (!gesture?.change(event.currentTarget, event.currentTarget.valueAsNumber)) commit(event.currentTarget.valueAsNumber);
              }} />}
          </>
          : type === "color" ? <>
            <label>{name}<input type="color" aria-label={name} value={/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(String(value)) ? String(value).slice(0, 7) : "#000000"}
              onChange={event => commit(event.currentTarget.value + (/^#[0-9a-f]{8}$/i.test(String(value)) ? String(value).slice(7) : ""))} /></label>
            <label>{uiText("{name} 色碼", { name })}<input key={`${key}:${String(value)}`} type="text" aria-label={uiText("{name} 色碼", { name })}
              defaultValue={String(value)} maxLength={9} onBlur={event => { if (cancelColorBlur) { cancelColorBlur = false; return; } if (!commit(event.currentTarget.value)) event.currentTarget.value = String(value); }}
              onKeyDown={event => { if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
                if (event.key === "Escape") { cancelColorBlur = true; event.currentTarget.value = String(value); event.currentTarget.blur(); }
                else if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
          </>
          : <label>{name}<input type="text" aria-label={name} value={String(value)} maxLength={definition?.type === "string" ? definition.maxLength : 500}
            onChange={event => commit(event.currentTarget.value)} /></label>}
        </div>;
      })}
    </div>
    {view.matched && view.rows.some(row => row.definition) && <button type="button" onClick={() => {
      gestureInput?.cancel();
      const parameters = nativeEffectParameterResetV1(instance, view);
      if (parameters && (parameters !== instance.parameters || submittedAny)) {
        if (onEdit) { if (onEdit({ ...view.defaults }) !== false) submittedAny = true; }
        else if (parameters !== instance.parameters) onChange(parameters);
      }
    }}>{uiText("恢復預設")}</button>}
  </>;
}
export function NativeEffectParameterControlsV1(props: Props) {
  useI18n();
  const gestureInput = useMemo(() => createNativeEffectRangeGestureInputV1(), []);
  useEffect(() => () => gestureInput.cancel(), [gestureInput, props.scopeKey, props.instance.id]);
  return renderNativeEffectParameterControlsV1({ ...props, gestureInput });
}

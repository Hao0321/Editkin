import { EFFECT_PRESETS } from "../creative/corePack";
import { PREVIEW_APPROXIMATE_EFFECT_RENDERERS_V1 } from "../render/unsharpPreviewFilterV1";
import { presetEffectOrderPatchV1, type PresetEffectEditV1 } from "../application/clipPresetEffectEditsV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";

export type PresetEffectEditHandlerV1 = (expectedIds: readonly string[], edit: PresetEffectEditV1) => boolean | void;
interface Props {
  effectIds: readonly string[]; disabled?: boolean; onEdit?: PresetEffectEditHandlerV1;
  onChange: (patch: { effectPresetIds: string[] }) => void;
}
/** An owner refusal is terminal. Standalone callers explicitly retain the original onChange contract. */
export function submitPresetEffectEditV1(effectIds: readonly string[], edit: PresetEffectEditV1, onEdit: PresetEffectEditHandlerV1 | undefined,
  onChange: Props["onChange"]): boolean {
  const next = presetEffectOrderPatchV1(effectIds, edit);
  if (!next) return false;
  if (onEdit) return onEdit(effectIds, edit) !== false;
  if (next !== effectIds) onChange({ effectPresetIds: [...next] });
  return true;
}
export function renderAppliedPresetEffectStackV1({ effectIds, disabled = false, onEdit, onChange }: Props) {
  if (!effectIds.length) return null;
  const submit = (edit: PresetEffectEditV1) => { if (!disabled) submitPresetEffectEditV1(effectIds, edit, onEdit, onChange); };
  return <section className="native-effect-stack" data-testid="applied-preset-effect-stack" aria-label={uiText("已套用的畫面特效")}>
    <div className="tool-surface-heading"><strong>{uiText("已套用的畫面特效")}</strong><span>{uiText("由上往下依序執行")}</span></div>
    {effectIds.map((effectId, index) => {
      const preset = EFFECT_PRESETS.find(candidate => candidate.id === effectId), name = uiText(preset?.name ?? effectId);
      return <article className="native-effect-instance" key={effectId} data-effect-id={effectId}>
        <header><b>{index + 1}. {name}</b>{PREVIEW_APPROXIMATE_EFFECT_RENDERERS_V1.has(preset?.renderer ?? "") && <small className="preview-approximate-badge" data-testid="preview-approximate-badge"
          title={uiText("預覽會用螢幕的解析度套用同一種銳利化，畫面縮小顯示時，邊緣看起來會和輸出檔不完全一樣；實際效果以輸出檔為準。")}>{uiText("預覽近似")}</small>}<div className="native-effect-actions">
          <button type="button" aria-label={`${name} · ${uiText("效果往前")}`} disabled={disabled || index === 0}
            onClick={() => submit({ type: "move", effectId, direction: "earlier" })}>↑</button>
          <button type="button" aria-label={`${name} · ${uiText("效果往後")}`} disabled={disabled || index === effectIds.length - 1}
            onClick={() => submit({ type: "move", effectId, direction: "later" })}>↓</button>
          <button type="button" aria-label={`${name} · ${uiText("移除")}`} disabled={disabled}
            onClick={() => submit({ type: "remove", effectId })}>{uiText("移除")}</button>
        </div></header>
      </article>;
    })}
  </section>;
}
export function AppliedPresetEffectStackV1(props: Props) {
  useI18n(); return renderAppliedPresetEffectStackV1(props);
}

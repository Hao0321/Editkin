import { useEffect, useRef, useState } from "react";
import type { NormalizedRect } from "../domain/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";

export type CropSide = "top" | "bottom" | "left" | "right";
export const UNCROPPED: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
export function cropInsets(crop: NormalizedRect): Record<CropSide, number> {
  const pct = (value: number) => Number((value * 100).toFixed(6));
  return { top: pct(crop.y), bottom: pct(1 - crop.y - crop.height), left: pct(crop.x), right: pct(1 - crop.x - crop.width) };
}
export function withCropInset(crop: NormalizedRect, side: CropSide, percentage: number): NormalizedRect {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error("裁切數值必須介於 0% 和 100%。");
  const values = { ...cropInsets(crop), [side]: percentage };
  if (values.left + values.right >= 100 || values.top + values.bottom >= 100) throw new Error("裁切後必須保留畫面。");
  return { x: values.left / 100, y: values.top / 100, width: (100 - values.left - values.right) / 100, height: (100 - values.top - values.bottom) / 100 };
}
export function quarterTurn(rotation: number, direction: -1 | 1): number {
  return ((rotation + direction * 90 + 180) % 360 + 360) % 360 - 180;
}
const labels: Record<CropSide, string> = { top: "上（%）", bottom: "下（%）", left: "左（%）", right: "右（%）" };
export function ClipGeometryControls({ crop = UNCROPPED, rotation, flipX, flipY, disabled, onCropChange, onRotationChange, onFlip }: {
  crop?: NormalizedRect; rotation: number; flipX?: boolean; flipY?: boolean; onFlip?: (axis: "flipX" | "flipY") => void; disabled?: boolean; onCropChange: (crop: NormalizedRect) => void; onRotationChange: (rotation: number) => void;
}) {
  useI18n(); const initial = () => Object.fromEntries(Object.entries(cropInsets(crop)).map(([side, value]) => [side, String(value)])) as Record<CropSide, string>;
  const [draft, setDraft] = useState(initial), [error, setError] = useState(""); const dirty = useRef(new Set<CropSide>());
  useEffect(() => { setDraft(initial()); setError(""); dirty.current.clear(); }, [crop.x, crop.y, crop.width, crop.height]);
  const commit = (side: CropSide) => {
    if (!dirty.current.delete(side) || disabled) return;
    try {
      if (!draft[side].trim()) throw new Error("裁切數值必須介於 0% 和 100%。");
      const next = withCropInset(crop, side, Number(draft[side]));
      if (Object.keys(next).some(key => Math.abs(next[key as keyof NormalizedRect] - crop[key as keyof NormalizedRect]) > 1e-8)) onCropChange(next);
      setError(""); setDraft(Object.fromEntries(Object.entries(cropInsets(next)).map(([key, value]) => [key, String(value)])) as Record<CropSide, string>);
    } catch (cause) { setError(uiText(cause instanceof Error ? cause.message : String(cause))); setDraft(initial()); }
  };
  return <div data-testid="clip-geometry-controls">
    <strong>{uiText("裁切")}</strong><div className="transform-grid">
      {(["top", "bottom", "left", "right"] as const).map(side => <label key={side}>{uiText(labels[side])}<input type="number" min="0" max="100" step="0.1"
        value={draft[side]} disabled={disabled} data-testid={`clip-crop-${side}`} onChange={event => { dirty.current.add(side); setDraft({ ...draft, [side]: event.target.value }); }}
        onBlur={() => commit(side)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(side); } else if (event.key === "Escape") { dirty.current.delete(side); setDraft(initial()); setError(""); } }} /></label>)}
    </div>{error && <small role="alert">{error}</small>}
    <div className="transform-grid"><button type="button" disabled={disabled} data-testid="clip-rotate-left" onClick={() => onRotationChange(quarterTurn(rotation, -1))}>{uiText("向左轉 90°")}</button>
      <button type="button" disabled={disabled} data-testid="clip-rotate-right" onClick={() => onRotationChange(quarterTurn(rotation, 1))}>{uiText("向右轉 90°")}</button>
      {onFlip && <><button type="button" disabled={disabled} aria-pressed={Boolean(flipX)} data-testid="clip-flip-horizontal" onClick={() => onFlip("flipX")}>{uiText("水平翻轉")}</button>
        <button type="button" disabled={disabled} aria-pressed={Boolean(flipY)} data-testid="clip-flip-vertical" onClick={() => onFlip("flipY")}>{uiText("垂直翻轉")}</button></>}</div>
  </div>;
}

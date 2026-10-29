import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useState } from "react";
import type { ClipExpressionProperty, ClipLayerState, HaoExpressionSource, TimelineClip, TrackMatteMode } from "../domain/types";
import { useClipLayerHostV1 } from "./clipLayerHostV1";
import { clipLayerLabelV1, pictureLayerClipsV1 } from "./clipLayerNamesV1";

const EXPRESSION_PROPERTIES: Array<{ property: ClipExpressionProperty; label: string; example: string }> = [
  { property: "x", label: "左右位置", example: "value + sin(time * 4) * 18" },
  { property: "y", label: "上下位置", example: "value + sin(time * 3) * 12" },
  { property: "scale", label: "畫面大小", example: "value * (0.96 + entrance * 0.04)" },
  { property: "rotation", label: "旋轉角度", example: "value + sin(time * 2) * 2" },
  { property: "opacity", label: "透明度", example: "value * entrance * exit" },
];

interface LayerExpressionPanelProps {
  clip: TimelineClip;
  clips: TimelineClip[];
  onLayerChange: (patch: Partial<ClipLayerState>) => void;
  onExpressionChange: (property: ClipExpressionProperty, expression: HaoExpressionSource | null) => void;
}

function normalizeExpression(value: string): HaoExpressionSource | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return (trimmed.startsWith("hao.expression/v1:") ? trimmed : `hao.expression/v1:${trimmed}`) as HaoExpressionSource;
}

export function LayerExpressionPanel({ clip, clips, onLayerChange, onExpressionChange }: LayerExpressionPanelProps) {
  useI18n();
  // The pickers name clips by their media and place (not raw ids) and offer picture clips only; without the shell's
  // project (a standalone render) they keep the ids they were given.
  const project = useClipLayerHostV1()?.project;
  const candidates = project ? pictureLayerClipsV1(project) : clips;
  const label = (candidate: TimelineClip) => project ? clipLayerLabelV1(project, candidate, uiText).label : candidate.id;
  const [drafts, setDrafts] = useState<Record<ClipExpressionProperty, string>>({
    x: "", y: "", scale: "", rotation: "", opacity: "",
  });

  useEffect(() => {
    setDrafts({
      x: clip.expressions?.x ?? "",
      y: clip.expressions?.y ?? "",
      scale: clip.expressions?.scale ?? "",
      rotation: clip.expressions?.rotation ?? "",
      opacity: clip.expressions?.opacity ?? "",
    });
  }, [clip.id, clip.expressions]);

  return (
    <details className="inspector-section layer-expression-panel" data-testid="layer-expression-section">
      <summary>{uiText("圖層與表達式")}<small>{uiText("進階 · 安全運算")}</small></summary>
      <div className="layer-controls">
        <label className="layer-enabled"><input type="checkbox" checked={clip.layer?.enabled ?? true} onChange={(event) => onLayerChange({ enabled: event.target.checked })} /> {uiText("顯示這個圖層")}</label>
        {/* 混合模式 lives in 調整 › 混合 (both modes, with a hover preview); this panel keeps role, parent and matte. */}
        <label>{uiText("圖層角色")}<select value={clip.layer?.role ?? "content"} onChange={(event) => onLayerChange({ role: event.target.value as ClipLayerState["role"] })} data-testid="layer-role">
            <option value="content">{uiText("內容圖層")}</option>
            <option value="adjustment">{uiText("調整圖層（影響下方）")}</option>
            <option value="controller">{uiText("Null 控制器（不渲染）")}</option>
          </select>
        </label>
        {clip.layer?.role === "controller" && <p className="expression-help" data-testid="layer-controller-help">{uiText("控制器只輸出位置、縮放、旋轉與透明度；不播放原素材，也不占用影片解碼器。把其他圖層的父層設為它即可整組控制。")}</p>}
        <label>{uiText("跟隨父圖層")}<select value={clip.layer?.parentClipId ?? ""} onChange={(event) => onLayerChange({ parentClipId: event.target.value || undefined })} data-testid="layer-parent">
            <option value="">{uiText("不跟隨")}</option>
            {candidates.filter((candidate) => candidate.id !== clip.id && candidate.layer?.role !== "adjustment").map((candidate) => <option key={candidate.id} value={candidate.id}>{label(candidate)}{!project && candidate.layer?.role === "controller" ? " · Null" : ""}</option>)}
          </select>
        </label>
        {(clip.layer?.role ?? "content") === "content" && <label>{uiText("Track Matte 來源")}<select value={clip.layer?.trackMatte?.sourceClipId ?? ""} onChange={(event) => onLayerChange({ trackMatte: event.target.value ? { sourceClipId: event.target.value, mode: clip.layer?.trackMatte?.mode ?? "alpha" } : undefined })} data-testid="layer-track-matte-source">
            <option value="">{uiText("無")}</option>
            {candidates.filter((candidate) => candidate.id !== clip.id && (candidate.layer?.role ?? "content") === "content").map((candidate) => <option key={candidate.id} value={candidate.id}>{label(candidate)}</option>)}
          </select>
        </label>}
        {(clip.layer?.role ?? "content") === "content" && clip.layer?.trackMatte && <label>{uiText("Track Matte 模式")}<select value={clip.layer.trackMatte.mode} onChange={(event) => onLayerChange({ trackMatte: { ...clip.layer!.trackMatte!, mode: event.target.value as TrackMatteMode } })} data-testid="layer-track-matte-mode">
            <option value="alpha">Alpha</option><option value="alpha_inverted">{uiText("Alpha 反相")}</option>
            <option value="luma">Luma</option><option value="luma_inverted">{uiText("Luma 反相")}</option>
          </select>
        </label>}
      </div>
      <p className="expression-help">{uiText("表達式只接受 Editkin 安全 DSL，不會執行 JavaScript。可用 time、frame、value、entrance、exit 與 sin、lerp、clamp 等函式。")}</p>
      <div className="expression-list">
        {EXPRESSION_PROPERTIES.map(({ property, label, example }) => (
          <form key={property} onSubmit={(event) => { event.preventDefault(); onExpressionChange(property, normalizeExpression(drafts[property])); }}>
            <label>{label}
              <input value={drafts[property]} placeholder={example} onChange={(event) => setDrafts((current) => ({ ...current, [property]: event.target.value }))} aria-label={uiText("{value0}表達式", { value0: label })} />
            </label>
            <button type="submit">{uiText("套用")}</button>
            <button type="button" onClick={() => { setDrafts((current) => ({ ...current, [property]: "" })); onExpressionChange(property, null); }}>{uiText("清除")}</button>
          </form>
        ))}
      </div>
    </details>
  );
}

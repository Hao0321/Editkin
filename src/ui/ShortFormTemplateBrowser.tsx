import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { LONG_FORM_TEMPLATE_FEATURES, LONG_FORM_TEMPLATES } from "../application/longFormTemplates";
import { type ShortFormTemplateContent } from "../application/shortFormTemplates";
import { isTemplateGeneratedCaption, isTemplateGeneratedGraphic, isTemplateGeneratedMarker } from "../application/templateLifecycle";
import { isLowerThirdGraphic, LOWER_THIRD_PRESETS, type LowerThirdPresetId } from "../application/lowerThirds";
import type { CaptionCue, DirectorMarker, EditProject, MediaAsset, MotionGraphic, TemplateApplicationState } from "../domain/types";
import MotionThemeCatalog from "./MotionThemeCatalog";
import { REFERENCE_MOTION_TEMPLATES, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import "./shortFormTemplateBrowser.css";

interface TemplateBrowserProps {
  onApplyShort: (templateId: string, content?: ShortFormTemplateContent) => void;
  assets?: readonly MediaAsset[];
  project?: EditProject;
  selectedClipId?: string;
  onApplyThemedTemplate?: (input: ReferenceMotionTemplateInput) => void;
  motionBusy?: boolean;
  onCancelMotion?: () => void;
  sourceAssetId?: string;
  fps?: number;
  canvasFormat?: "short" | "long";
  onApplyLong: (templateId: string) => void;
  onAddLowerThird?: (presetId: LowerThirdPresetId, personName: string, organization: string) => void;
  motionGraphics?: MotionGraphic[];
  captions?: CaptionCue[];
  directorMarkers?: DirectorMarker[];
  templateApplication?: TemplateApplicationState;
  onDeleteMotionGraphic?: (graphicId: string) => void;
  onDeleteCaption?: (captionId: string) => void;
  onDeleteDirectorMarker?: (markerId: string) => void;
  onClearTemplateApplication?: () => void;
}

function TemplatePreview({ accent }: { accent: string }) {
  useI18n();
  return <div className="long-narrative-preview" aria-hidden="true" style={{ "--template-accent": accent } as CSSProperties}><span>{uiText("連續素材")}</span><i /><small>{uiText("少量提示 · 回到原畫面")}</small></div>;
}

export default function ShortFormTemplateBrowser({ onApplyLong, project, selectedClipId, onApplyThemedTemplate, motionBusy, onCancelMotion, canvasFormat, onAddLowerThird, motionGraphics = [], captions = [], directorMarkers = [], templateApplication, onDeleteMotionGraphic, onDeleteCaption, onDeleteDirectorMarker, onClearTemplateApplication }: TemplateBrowserProps) {
  useI18n();
  const [format, setFormat] = useState<"short" | "long">(canvasFormat ?? "short");
  const [category, setCategory] = useState("全部");
  useEffect(() => { if (canvasFormat) { setFormat(canvasFormat); setCategory("全部"); } }, [canvasFormat]);
  const [personName, setPersonName] = useState("");
  const [organization, setOrganization] = useState("");
  const short = format === "short";
  const categories = useMemo(() => ["全部", ...new Set(LONG_FORM_TEMPLATES.map((template) => template.category))], []);
  const visibleLongTemplates = useMemo(() => category === "全部" ? LONG_FORM_TEMPLATES : LONG_FORM_TEMPLATES.filter((template) => template.category === category), [category]);
  const managedElements = useMemo(() => [
    ...motionGraphics.filter((graphic) => isTemplateGeneratedGraphic(graphic) || isLowerThirdGraphic(graphic)).map((graphic) => ({
      key: `graphic:${graphic.id}`, primary: graphic.text, secondary: isLowerThirdGraphic(graphic) ? "人物字幕條" : `動態圖卡 · ${graphic.templateOwner?.role ?? graphic.kind}`,
      delete: onDeleteMotionGraphic ? () => onDeleteMotionGraphic(graphic.id) : undefined,
    })),
    ...captions.filter(isTemplateGeneratedCaption).map((caption) => ({
      key: `caption:${caption.id}`, primary: caption.text, secondary: "模板示範字幕",
      delete: onDeleteCaption ? () => onDeleteCaption(caption.id) : undefined,
    })),
    ...directorMarkers.filter(isTemplateGeneratedMarker).map((marker) => ({
      key: `marker:${marker.id}`, primary: marker.title, secondary: `節奏註記 · ${marker.time.toFixed(2)} 秒`,
      delete: onDeleteDirectorMarker ? () => onDeleteDirectorMarker(marker.id) : undefined,
    })),
  ], [captions, directorMarkers, motionGraphics, onDeleteCaption, onDeleteDirectorMarker, onDeleteMotionGraphic]);
  return <section className="short-template-browser" aria-label={uiText("成片模板")}>
    {(managedElements.length > 0 || templateApplication) && <section className="template-layer-manager" aria-label={uiText("模板元素管理")}><header><div><strong>{templateApplication ? uiText("已套用：{value0}", { value0: templateApplication.templateName }) : uiText("目前可管理的元素")}</strong><span>{uiText("重新套用會取代上一套，不會疊加。")}</span></div>{onClearTemplateApplication && templateApplication ? <button type="button" onClick={onClearTemplateApplication} data-testid="clear-template-application" title={uiText("移除模板元素，並還原套用前的字幕樣式、調色、特效、轉場與剪輯類型")}>{uiText("還原成片模板")}</button> : null}</header>{managedElements.length > 0 && <details><summary>{managedElements.length} {uiText("個圖卡／字幕／註記 · 可個別刪除")}</summary><div>{managedElements.map((element) => <article key={element.key}><span><strong>{element.primary}</strong><small>{element.secondary}</small></span><button type="button" onClick={element.delete} disabled={!element.delete} aria-label={uiText("刪除 {value0}", { value0: element.primary })}>{uiText("刪除")}</button></article>)}</div></details>}</section>}
    <details className="lower-third-builder">
      <summary><span><strong>{uiText("人物字幕條")}</strong><small>{uiText("人名 BAR ＋ 單位／職稱 BAR")}</small></span><b>{uiText("設定")}</b></summary>
      <div className="lower-third-fields"><label>{uiText("人名")}<input value={personName} maxLength={18} onChange={(event) => setPersonName(event.target.value)} placeholder={uiText("例如：王小明")} /></label><label>{uiText("單位／職稱")}<input value={organization} maxLength={28} onChange={(event) => setOrganization(event.target.value)} placeholder={uiText("例如：Editkin 創辦人")} /></label></div>
      <div className="lower-third-presets">{LOWER_THIRD_PRESETS.map((preset) => <button key={preset.id} type="button" disabled={!personName.trim() || !organization.trim() || !onAddLowerThird} onClick={() => onAddLowerThird?.(preset.id, personName, organization)}><i style={{ background: preset.nameBar.backgroundColor, color: preset.nameBar.textColor }}>{uiText("姓名")}</i><i style={{ background: preset.unitBar.backgroundColor, color: preset.unitBar.textColor }}>{uiText("單位")}</i><span><b>{preset.name}</b><small>{preset.description}</small></span></button>)}</div>
    </details>
    <div className="template-format-tabs" role="tablist" aria-label={uiText("影片長度")}>
      <button type="button" role="tab" aria-selected={short} onClick={() => { setFormat("short"); setCategory("全部"); }} data-testid="short-format-templates">{uiText("短片 9:16")} <b>{REFERENCE_MOTION_TEMPLATES.length}</b></button>
      <button type="button" role="tab" aria-selected={!short} onClick={() => { setFormat("long"); setCategory("全部"); }} data-testid="long-format-templates">{uiText("長片 16:9")} <b>{LONG_FORM_TEMPLATES.length}</b></button>
    </div>
    {short ? <MotionThemeCatalog project={project} selectedClipId={selectedClipId} onApply={onApplyThemedTemplate} busy={motionBusy} onCancel={onCancelMotion} /> : <>
      <header><strong>{uiText("選擇長片敘事節奏")}</strong><span>{uiText("保留原畫面；設定敘事與字幕規則，提示依實際內容安排。")}</span><details className="template-feature-details"><summary>{uiText("這套模板包含什麼？")}</summary><div className="short-template-features">{LONG_FORM_TEMPLATE_FEATURES.map(feature => <em key={feature}>{feature}</em>)}</div></details><small className="template-preview-disclosure">{uiText("長片只取需要的動態元素，不插入整套圖卡。")}</small></header>
      <div className="template-category-tabs" role="tablist" aria-label={uiText("{value0}模板用途", { value0: uiText("長片") })}>{categories.map(item => <button type="button" role="tab" aria-selected={category === item} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <div className="short-template-grid">{visibleLongTemplates.map(template => <article key={template.id} className="short-template-card long-template-card">
        <TemplatePreview accent={template.accent} />
        <div><span>{template.category}</span><strong>{template.name}</strong><small>{template.description}</small></div>
        <button type="button" onClick={() => onApplyLong(template.id)} data-testid={`apply-long-template-${template.id}`}>{uiText("套用長片模板")}</button>
      </article>)}</div>
    </>}
  </section>;
}

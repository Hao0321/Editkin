import { useMemo, useState, type CSSProperties } from "react";
import { LONG_FORM_TEMPLATE_FEATURES, LONG_FORM_TEMPLATES } from "../application/longFormTemplates";
import { SHORT_FORM_TEMPLATE_FEATURES, SHORT_FORM_TEMPLATES } from "../application/shortFormTemplates";
import { isTemplateGeneratedCaption, isTemplateGeneratedGraphic, isTemplateGeneratedMarker } from "../application/templateLifecycle";
import { isLowerThirdGraphic, LOWER_THIRD_PRESETS, type LowerThirdPresetId } from "../application/lowerThirds";
import type { CaptionCue, DirectorMarker, MotionGraphic, TemplateApplicationState } from "../domain/types";
import "./shortFormTemplateBrowser.css";

interface TemplateBrowserProps {
  onApplyShort: (templateId: string) => void;
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

function TemplatePreview({ accent, index, longForm = false }: { accent: string; index: number; longForm?: boolean }) {
  return <div className={`short-template-preview ${longForm ? "long-preview" : ""}`} aria-hidden="true" style={{ "--template-accent": accent } as CSSProperties}>
    <i className="template-title" /><i className="template-tag" /><i className="template-media" /><i className="template-card" /><i className="template-caption" /><b>{String(index + 1).padStart(2, "0")}</b>
    </div>;
}

export default function ShortFormTemplateBrowser({ onApplyShort, onApplyLong, onAddLowerThird, motionGraphics = [], captions = [], directorMarkers = [], templateApplication, onDeleteMotionGraphic, onDeleteCaption, onDeleteDirectorMarker, onClearTemplateApplication }: TemplateBrowserProps) {
  const [format, setFormat] = useState<"short" | "long">("short");
  const [category, setCategory] = useState("全部");
  const [personName, setPersonName] = useState("");
  const [organization, setOrganization] = useState("");
  const short = format === "short";
  const features = short ? SHORT_FORM_TEMPLATE_FEATURES : LONG_FORM_TEMPLATE_FEATURES;
  const templates = short ? SHORT_FORM_TEMPLATES : LONG_FORM_TEMPLATES;
  const categories = useMemo(() => ["全部", ...new Set(templates.map((template) => template.category))], [templates]);
  const visibleShortTemplates = useMemo(() => category === "全部" ? SHORT_FORM_TEMPLATES : SHORT_FORM_TEMPLATES.filter((template) => template.category === category), [category]);
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
  return <section className="short-template-browser" aria-label="成片模板">
    {(managedElements.length > 0 || templateApplication) && <section className="template-layer-manager" aria-label="模板元素管理"><header><div><strong>{templateApplication ? `已套用：${templateApplication.templateName}` : "目前可管理的元素"}</strong><span>重新套用會取代上一套，不會疊加。</span></div>{onClearTemplateApplication && templateApplication ? <button type="button" onClick={onClearTemplateApplication} data-testid="clear-template-application" title="移除模板元素，並還原套用前的字幕樣式、調色、特效、轉場與剪輯類型">還原成片模板</button> : null}</header>{managedElements.length > 0 && <details><summary>{managedElements.length} 個圖卡／字幕／註記 · 可個別刪除</summary><div>{managedElements.map((element) => <article key={element.key}><span><strong>{element.primary}</strong><small>{element.secondary}</small></span><button type="button" onClick={element.delete} disabled={!element.delete} aria-label={`刪除 ${element.primary}`}>刪除</button></article>)}</div></details>}</section>}
    <details className="lower-third-builder">
      <summary><span><strong>人物字幕條</strong><small>人名 BAR ＋ 單位／職稱 BAR</small></span><b>設定</b></summary>
      <div className="lower-third-fields"><label>人名<input value={personName} maxLength={18} onChange={(event) => setPersonName(event.target.value)} placeholder="例如：駱君昊" /></label><label>單位／職稱<input value={organization} maxLength={28} onChange={(event) => setOrganization(event.target.value)} placeholder="例如：Editkin 創辦人" /></label></div>
      <div className="lower-third-presets">{LOWER_THIRD_PRESETS.map((preset) => <button key={preset.id} type="button" disabled={!personName.trim() || !organization.trim() || !onAddLowerThird} onClick={() => onAddLowerThird?.(preset.id, personName, organization)}><i style={{ background: preset.nameBar.backgroundColor, color: preset.nameBar.textColor }}>姓名</i><i style={{ background: preset.unitBar.backgroundColor, color: preset.unitBar.textColor }}>單位</i><span><b>{preset.name}</b><small>{preset.description}</small></span></button>)}</div>
    </details>
    <div className="template-format-tabs" role="tablist" aria-label="影片長度">
      <button type="button" role="tab" aria-selected={short} onClick={() => { setFormat("short"); setCategory("全部"); }} data-testid="short-format-templates">短片 9:16 <b>{SHORT_FORM_TEMPLATES.length}</b></button>
      <button type="button" role="tab" aria-selected={!short} onClick={() => { setFormat("long"); setCategory("全部"); }} data-testid="long-format-templates">長片 16:9 <b>{LONG_FORM_TEMPLATES.length}</b></button>
    </div>
    <header><strong>{short ? "選擇短片風格" : "選擇長片敘事節奏"}</strong><span>套用後可逐項調整；字幕保持單一顏色。</span><details className="template-feature-details"><summary>這套模板包含什麼？</summary><div className="short-template-features">{features.map((feature) => <em key={feature}>{feature}</em>)}</div></details><small className="template-preview-disclosure">縮圖是版面示意；套用後請在播放器檢查實際效果。</small></header>
    <div className="template-category-tabs" role="tablist" aria-label={`${short ? "短影音" : "長片"}模板用途`}>{categories.map((item) => <button type="button" role="tab" aria-selected={category === item} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>
    <div className="short-template-grid">
      {short ? visibleShortTemplates.map((template) => { const index = SHORT_FORM_TEMPLATES.findIndex((item) => item.id === template.id); return <article key={template.id} className={`short-template-card template-${index + 1}`}>
        <TemplatePreview accent={template.palette.accent} index={index} />
        <div><span>{template.category}</span><strong>{template.name}</strong><small>{template.description}</small></div>
        <button type="button" onClick={() => onApplyShort(template.id)} data-testid={`apply-template-${template.id}`}>套用短片模板</button>
      </article>; }) : visibleLongTemplates.map((template) => { const index = LONG_FORM_TEMPLATES.findIndex((item) => item.id === template.id); return <article key={template.id} className="short-template-card long-template-card">
        <TemplatePreview accent={template.accent} index={index} longForm />
        <div><span>{template.category}</span><strong>{template.name}</strong><small>{template.description}</small></div>
        <button type="button" onClick={() => onApplyLong(template.id)} data-testid={`apply-long-template-${template.id}`}>套用長片模板</button>
      </article>; })}
    </div>
  </section>;
}

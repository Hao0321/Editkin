import { useState } from "react";
import type { MediaAsset } from "../domain/types";
import type { ShortFormTemplateContent, ShortFormTemplateDefinition } from "../application/shortFormTemplates";
import { bundledFontFamilies } from "../typography/fontFaces";

export default function NativeTemplateSetup({ template, assets, sourceAssetId, fps, previous, onApply, onCancel }: {
  template: ShortFormTemplateDefinition; assets: readonly MediaAsset[]; sourceAssetId?: string; fps: number;
  previous?: ShortFormTemplateContent; onApply: (content: ShortFormTemplateContent) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(previous?.title ?? "");
  const [body, setBody] = useState(previous?.body ?? "");
  const [accent, setAccent] = useState(previous?.accentColor ?? template.palette.accent.slice(0, 7));
  const [surface, setSurface] = useState(previous?.surfaceColor ?? "#F8F3EA");
  const [text, setText] = useState(previous?.textColor ?? (template.id === "spatial_gallery" ? "#F7F5F0" : "#24211E"));
  const [headingFont, setHeadingFont] = useState(previous?.headingFont ?? "Noto Sans TC");
  const [bodyFont, setBodyFont] = useState(previous?.bodyFont ?? "Noto Sans TC");
  const [speed, setSpeed] = useState(previous?.motionSpeed ?? 1);
  const [steps, setSteps] = useState(previous?.progress?.steps ?? 6);
  const [active, setActive] = useState(previous?.progress?.activeStep ?? 1);
  const [rear, setRear] = useState(previous?.sources?.rearRight.assetId ?? "");
  const [front, setFront] = useState(previous?.sources?.front.assetId ?? "");
  const [rearFrame, setRearFrame] = useState(Math.round((previous?.sources?.rearRight.sourceStart ?? 0) * fps));
  const [frontFrame, setFrontFrame] = useState(Math.round((previous?.sources?.front.sourceStart ?? 0) * fps));
  const spatial = template.id === "spatial_gallery";
  const choices = assets.filter(asset => asset.kind === "video" && asset.id !== sourceAssetId);
  const ready = title.trim() && (!spatial || (sourceAssetId && rear && front && rear !== front && rear !== sourceAssetId && front !== sourceAssetId));
  const apply = () => onApply({ title, body, accentColor: accent, surfaceColor: surface, textColor: text, headingFont, bodyFont, motionSpeed: speed,
    ...(spatial ? { sources: { rearRight: { assetId: rear, sourceStart: rearFrame / fps }, front: { assetId: front, sourceStart: frontFrame / fps } } } : { progress: { steps, activeStep: active } }) });
  return <section className="native-template-setup" data-testid="native-template-setup" aria-label={`${template.name}內容設定`}>
    <header><strong>{template.name}</strong><small>填入這支影片的內容；切換模板會沿用文案。</small></header>
    <label>主標題<input aria-label="模板主標題" value={title} maxLength={48} onChange={event => setTitle(event.target.value)} placeholder="這一幕要說的重點" /></label>
    {!spatial && <label>補充重點<input aria-label="模板補充重點" value={body} maxLength={64} onChange={event => setBody(event.target.value)} placeholder="可留空" /></label>}
    <div className="native-template-row"><label>文字色<input aria-label="模板文字色" type="color" value={text} onChange={event => setText(event.target.value)} /></label><label>主標字型<select aria-label="模板主標字型" value={headingFont} onChange={event => setHeadingFont(event.target.value)}>{bundledFontFamilies().map(family => <option key={family} value={family}>{family}</option>)}</select></label></div>
    {!spatial && <label>內文字型<select aria-label="模板內文字型" value={bodyFont} onChange={event => setBodyFont(event.target.value)}>{bundledFontFamilies().map(family => <option key={family} value={family}>{family}</option>)}</select></label>}
    {!spatial && <><div className="native-template-row"><label>強調色<input aria-label="模板強調色" type="color" value={accent} onChange={event => setAccent(event.target.value)} /></label><label>底色<input aria-label="模板底色" type="color" value={surface} onChange={event => setSurface(event.target.value)} /></label></div>
      <div className="native-template-row"><label>章節總數<input aria-label="模板章節總數" type="number" min="1" max="12" step="1" value={steps} onChange={event => { const count = Math.max(1, Math.min(12, Math.round(Number(event.target.value)))); setSteps(count); setActive(Math.min(active, count)); }} /></label><label>目前章節<input aria-label="模板目前章節" type="number" min="0" max={steps} step="1" value={active} onChange={event => setActive(Math.max(0, Math.min(steps, Math.round(Number(event.target.value)))))} /></label></div></>}
    <label>入出場速度 <output>{speed.toFixed(1)}×</output><input aria-label="模板動畫速度" type="range" min="0.5" max="2" step="0.1" value={speed} onChange={event => setSpeed(Number(event.target.value))} /></label>
    {spatial && <><small>主素材使用時間軸第一段影片；後右與前景各選另一段，只有主素材保留音訊。</small>{([{ name: "後右", value: rear, set: setRear, frame: rearFrame, setFrame: setRearFrame }, { name: "前景", value: front, set: setFront, frame: frontFrame, setFrame: setFrontFrame }] as const).map(slot => <div className="native-template-row" key={slot.name}><label>{slot.name}影片<select aria-label={`模板${slot.name}素材`} value={slot.value} onChange={event => slot.set(event.target.value)}><option value="">選擇影片</option>{choices.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>入點（影格）<input aria-label={`模板${slot.name}入點影格`} type="number" min="0" step="1" value={slot.frame} onChange={event => slot.setFrame(Math.max(0, Math.round(Number(event.target.value))))} /></label></div>)}</>}
    <div className="native-template-row"><button type="button" onClick={onCancel}>返回</button><button type="button" disabled={!ready} onClick={apply} data-testid="confirm-native-template">套用這些內容</button></div>
  </section>;
}

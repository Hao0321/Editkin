import { useState } from "react";
import type { MediaAsset, TimelineClip } from "../domain/types";
import { bundledFontFamilies } from "../typography/fontFaces";
import { DEFAULT_REFERENCE_MOTION_STYLE, DEFAULT_REFERENCE_NETWORK_COLORS, REFERENCE_MOTION_TEMPLATES, referenceMotionTemplate, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput, type ReferenceMotionMediaPresentation, type ReferenceMotionStrikePresentation } from "../motion/referenceMotionTemplates";

export type ManualReferenceMotionTemplate = Omit<ReferenceMotionTemplateInput, "clipId" | "startFrame" | "durationFrames" | "evidenceRefs">;

export default function ReferenceMotionTemplateControls({ clip, assets, portrait, fps = 30, onApply, busy = false, onCancel }: {
  clip: TimelineClip; assets: readonly MediaAsset[]; portrait?: boolean; fps?: number;
  onApply?: (input: ManualReferenceMotionTemplate) => void;
  busy?: boolean; onCancel?: () => void;
}) {
  const [templateId, setTemplateId] = useState<ReferenceMotionTemplateId>("level_bridge");
  const [graphicCadence, setGraphicCadence] = useState<NonNullable<ReferenceMotionTemplateInput["graphicCadence"]>>("kinetic");
  const [title, setTitle] = useState(""), [kicker, setKicker] = useState(""), [subtitle, setSubtitle] = useState(""), [previousText, setPreviousText] = useState("");
  const [primaryLabel, setPrimaryLabel] = useState(""), [sourceCount, setSourceCount] = useState(2);
  const [mediaPresentation, setMediaPresentation] = useState<ReferenceMotionMediaPresentation>("source_soft_v2");
  const [strikePresentation, setStrikePresentation] = useState<ReferenceMotionStrikePresentation>("semantic_replace_v1");
  const [strikeSurface, setStrikeSurface] = useState<"standalone" | "source_overlay">("standalone");
  const [useBrandMark, setUseBrandMark] = useState(false), [brandMark, setBrandMark] = useState("");
  const [sources, setSources] = useState(Array.from({ length: 8 }, () => ({ assetId: "", sourceStart: 0, label: "" })));
  const [items, setItems] = useState(Array.from({ length: 4 }, () => ({ label: "", detail: "" })));
  const [itemCount, setItemCount] = useState(3), [showcase, setShowcase] = useState(false), [speed, setSpeed] = useState(1);
  const [surface, setSurface] = useState(DEFAULT_REFERENCE_MOTION_STYLE.palette.surface), [textColor, setTextColor] = useState(DEFAULT_REFERENCE_MOTION_STYLE.palette.text), [accent, setAccent] = useState(DEFAULT_REFERENCE_MOTION_STYLE.palette.accent);
  const [muted, setMuted] = useState(DEFAULT_REFERENCE_MOTION_STYLE.palette.muted), [separator, setSeparator] = useState(DEFAULT_REFERENCE_MOTION_STYLE.palette.separator);
  const [font, setFont] = useState(DEFAULT_REFERENCE_MOTION_STYLE.typography.headingFamily);
  const [bodyFont, setBodyFont] = useState(DEFAULT_REFERENCE_MOTION_STYLE.typography.bodyFamily);
  const [useFocus, setUseFocus] = useState(false), [focusRegion, setFocusRegion] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [networkSeed, setNetworkSeed] = useState(32021), [networkPoints, setNetworkPoints] = useState(32);
  const [networkLabels, setNetworkLabels] = useState(["", "", ""]), [hubLabel, setHubLabel] = useState("");
  const [groupColors, setGroupColors] = useState<[string, string, string]>(DEFAULT_REFERENCE_NETWORK_COLORS);
  const recipe = referenceMotionTemplate(templateId), selectedCount = templateId === "focus_wall" ? sourceCount : recipe.sourceSlots;
  const selectedSources = sources.slice(0, selectedCount), choices = assets.filter(a => a.kind === "video" && a.id !== clip.assetId);
  const showItems = templateId === "context_stack" || templateId === "brand_recap" || templateId === "kinetic_network";
  const effectiveItemCount = templateId === "kinetic_network" ? 3 : itemCount;
  const ready = title.trim() && (portrait || showcase) && clip.duration >= recipe.minSeconds
    && (templateId !== "strike_reframe" || previousText.trim())
    && (templateId !== "strike_reframe" || strikePresentation !== "semantic_replace_v1" || !useBrandMark
      || (brandMark.trim() && Array.from(brandMark.trim()).length <= 16))
    && (!showItems || items.slice(0, effectiveItemCount).every(item => item.label.trim()))
    && (templateId !== "kinetic_network" || (Number.isInteger(networkSeed) && networkSeed >= 0 && networkSeed <= 0xffffffff
      && Number.isInteger(networkPoints) && networkPoints >= 8 && networkPoints <= 64
      && (networkLabels.every(label => !label.trim()) || networkLabels.every(label => label.trim()))))
    && (templateId !== "brand_recap" || !useFocus || (focusRegion.width > 0 && focusRegion.height > 0
      && focusRegion.x >= 0 && focusRegion.y >= 0 && focusRegion.x + focusRegion.width <= 1 && focusRegion.y + focusRegion.height <= 1))
    && selectedSources.every(slot => slot.label.trim() && choices.some(a => a.id === slot.assetId && slot.sourceStart >= 0 && slot.sourceStart + clip.duration <= a.duration))
    && new Set(selectedSources.map(s => s.assetId)).size === selectedSources.length
    && (!selectedCount || primaryLabel.trim());
  const changeSource = (index: number, patch: Partial<typeof sources[number]>) => { if (!busy) setSources(list => list.map((slot, i) => i === index ? { ...slot, ...patch } : slot)); };
  const changeItem = (index: number, patch: Partial<typeof items[number]>) => { if (!busy) setItems(list => list.map((item, i) => i === index ? { ...item, ...patch } : item)); };
  return <details className="floating-video-frame-controls" data-testid="reference-motion-template-controls">
    <summary>參考 Motion 模板 <small>可儲存的文字、字型與配色</small></summary>
    <div className="floating-source-slots">
      <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-busy={busy}>
      <label>動態編排<select aria-label="參考 Motion 模板" value={templateId} onChange={event => {
        if (busy) return;
        const value = event.target.value as ReferenceMotionTemplateId; setTemplateId(value);
        if (value === "kinetic_network") setFont("Noto Sans TC");
      }}>
        {REFERENCE_MOTION_TEMPLATES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <p>{recipe.description}</p>
      <label>圖卡節奏<select aria-label="模板圖卡節奏" value={graphicCadence} onChange={event => {
        if (!busy) setGraphicCadence(event.target.value as NonNullable<ReferenceMotionTemplateInput["graphicCadence"]>);
      }}>
        <option value="kinetic">流暢動態（Motion Language）</option><option value="brisk">俐落動態</option><option value="legacy">保留舊版節奏</option>
      </select><small>加快圖卡入場、退場與交接；閱讀停留、原片速度與音訊保持原設定。</small></label>
      {templateId === "comparison_pair" && <label>素材呈現<select aria-label="比較素材呈現" value={mediaPresentation} onChange={event => {
        if (!busy) setMediaPresentation(event.target.value as ReferenceMotionMediaPresentation);
      }}>
        <option value="source_soft_v2">完整素材・柔邊</option>
        <option value="legacy_layout">保留舊版取景</option>
      </select><small>新建比較預設完整容納兩份素材、保留原比例；舊版取景需明確選擇。已儲存模板不會自動改變。</small></label>}
      <label>主標題<input aria-label="模板主標題" type="text" maxLength={32} value={title} onChange={event => { if (!busy) setTitle(event.target.value); }} placeholder="填入這段真正要說的重點" /></label>
      <label>眉題<input aria-label="模板眉題" type="text" maxLength={24} value={kicker} onChange={event => { if (!busy) setKicker(event.target.value); }} /></label>
      <label>補充短句<input aria-label="模板補充短句" type="text" maxLength={40} value={subtitle} onChange={event => { if (!busy) setSubtitle(event.target.value); }} /></label>
      {templateId === "strike_reframe" && <>
        <label>刪線呈現<select aria-label="刪線呈現" value={strikePresentation} onChange={event => {
          if (!busy) setStrikePresentation(event.target.value as ReferenceMotionStrikePresentation);
        }}><option value="semantic_replace_v1">同焦點・刪去後替換</option><option value="legacy_layout">保留舊版排版</option></select>
          <small>先讀原句，刪去後在同一焦點揭露新句。已儲存模板不會自動改變。</small></label>
        <label>要刪去的原句<input aria-label="刪線原句" type="text" maxLength={24} value={previousText} onChange={event => { if (!busy) setPreviousText(event.target.value); }} /></label>
        {strikePresentation === "semantic_replace_v1" && <>
          <label>畫面用途<select aria-label="刪線畫面用途" value={strikeSurface} onChange={event => {
            const value = event.target.value;
            if (!busy && (value === "standalone" || value === "source_overlay")) setStrikeSurface(value);
          }}><option value="standalone">原創圖形場景</option><option value="source_overlay">在原素材上提示</option></select>
            <small>在原素材上提示會保留目前完整畫面與原片時鐘，只在文字周圍加上閱讀襯底。原創圖形場景保留整幕圖形編排。</small></label>
          <label><input aria-label="加入文字字標" type="checkbox" checked={useBrandMark} onChange={event => {
            if (!busy) setUseBrandMark(event.target.checked);
          }} />加入自己的文字字標</label>
          {useBrandMark && <label>文字字標<input aria-label="模板文字字標" type="text" maxLength={32} value={brandMark} onChange={event => {
            if (!busy) setBrandMark(event.target.value);
          }} /><small>最多 16 字；這是可編輯文字，不是圖片 Logo。請確認自己可以使用這段名稱。</small></label>}
        </>}
      </>}
      {showItems && <>
        <label>重點數<select aria-label="模板重點數" value={effectiveItemCount} disabled={templateId === "kinetic_network"} onChange={event => { if (!busy && templateId !== "kinetic_network") setItemCount(Number(event.target.value)); }}>{[2, 3, 4].map(n => <option key={n}>{n}</option>)}</select></label>
        {items.slice(0, effectiveItemCount).map((item, index) => <div key={index}>
          <label>重點 {index + 1}<input aria-label={`模板重點 ${index + 1}`} maxLength={24} value={item.label} onChange={event => changeItem(index, { label: event.target.value })} /></label>
          <label>補充<input aria-label={`重點補充 ${index + 1}`} maxLength={40} value={item.detail} onChange={event => changeItem(index, { detail: event.target.value })} /></label>
        </div>)}
      </>}
      {templateId === "kinetic_network" && <div className="transform-grid">
        <label>點群排列<input aria-label="點群排列種子" type="number" min={0} max={0xffffffff} step={1} value={networkSeed} onChange={event => { if (!busy) setNetworkSeed(Number(event.target.value)); }} /></label>
        <label>點數<input aria-label="點群數量" type="number" min={8} max={64} step={1} value={networkPoints} onChange={event => { if (!busy) setNetworkPoints(Number(event.target.value)); }} /></label>
        {networkLabels.map((label, index) => <label key={index}>能力 {index + 1}<input aria-label={`點群能力 ${index + 1}`} maxLength={6} value={label}
          onChange={event => { if (!busy) setNetworkLabels(list => list.map((value, i) => i === index ? event.target.value : value)); }} /></label>)}
        <label>連結中心<input aria-label="點群連結中心" maxLength={6} value={hubLabel} onChange={event => { if (!busy) setHubLabel(event.target.value); }} /></label>
        {groupColors.map((color, index) => <label key={`color-${index}`}>能力 {index + 1} 色彩<input aria-label={`點群能力色 ${index + 1}`} type="color" value={color}
          onChange={event => { if (!busy) setGroupColors(list => list.map((value, i) => i === index ? event.target.value : value) as [string, string, string]); }} /></label>)}
        <small>點數是圖形密度，不是平台人數；可更換排列，場景交接與閱讀時間保持精確。</small>
      </div>}
      {templateId === "brand_recap" && <details><summary>素材取景</summary>
        <label><input type="checkbox" aria-label="指定已觀察的主體範圍" checked={useFocus} onChange={event => { if (!busy) setUseFocus(event.target.checked); }} />指定主體範圍</label>
        <small>預設保留完整來源。指定範圍時，包含整個主體及其活動空間。</small>
        {useFocus && <div className="transform-grid">{(["x", "y", "width", "height"] as const).map(key => <label key={key}>{({ x: "左緣", y: "上緣", width: "寬度", height: "高度" })[key]}（%）
          <input type="number" aria-label={`主體範圍 ${key}`} min={key === "width" || key === "height" ? 1 : 0} max={100} step={1} value={Math.round(focusRegion[key] * 100)} onChange={event => { if (!busy) setFocusRegion(r => ({ ...r, [key]: Number(event.target.value) / 100 })); }} />
        </label>)}</div>}
      </details>}
      {selectedCount > 0 && <>
        <label>原片短標籤<input aria-label="模板原片標籤" maxLength={20} value={primaryLabel} onChange={event => { if (!busy) setPrimaryLabel(event.target.value); }} /></label>
        {templateId === "focus_wall" && <label>額外影片數<select aria-label="作品牆素材數" value={sourceCount} onChange={event => { if (!busy) setSourceCount(Number(event.target.value)); }}>{[2, 3, 4, 5, 6, 7, 8].map(n => <option key={n}>{n}</option>)}</select></label>}
        {selectedSources.map((slot, index) => <div key={index}>
          <label>素材 {index + 2}<select aria-label={`模板素材 ${index + 2}`} value={slot.assetId} onChange={event => changeSource(index, { assetId: event.target.value })}>
            <option value="">選擇不同影片</option>{choices.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
          <label>入點（秒）<input aria-label={`模板素材入點 ${index + 2}`} type="number" min={0} step={1 / fps} value={slot.sourceStart} onChange={event => changeSource(index, { sourceStart: Number(event.target.value) })} /></label>
          <label>短標籤<input aria-label={`模板素材標籤 ${index + 2}`} maxLength={20} value={slot.label} onChange={event => changeSource(index, { label: event.target.value })} /></label>
        </div>)}
        <small>只有選中的原片保留音訊。</small>
      </>}
      <details><summary>配色與動態</summary>
        <small>使用自己的品牌或原創配色；參考影片只用來學排版與動態。</small>
        <div className="transform-grid"><label>底色<input aria-label="模板底色" type="color" value={surface} onChange={event => { if (!busy) setSurface(event.target.value); }} /></label>
          <label>文字<input aria-label="模板文字色" type="color" value={textColor} onChange={event => { if (!busy) setTextColor(event.target.value); }} /></label>
          <label>重點色<input aria-label="模板重點色" type="color" value={accent} onChange={event => { if (!busy) setAccent(event.target.value); }} /></label>
          <label>次要文字<input aria-label="模板次要文字色" type="color" value={muted} onChange={event => { if (!busy) setMuted(event.target.value); }} /></label>
          <label>資訊面板<input aria-label="模板面板色" type="color" value={separator} onChange={event => { if (!busy) setSeparator(event.target.value); }} /></label></div>
        <label>標題字型<select aria-label="模板標題字型" value={font} onChange={event => { if (!busy) setFont(event.target.value); }}>{bundledFontFamilies().map(family => <option key={family}>{family}</option>)}</select></label>
        <label>內文字型<select aria-label="模板內文字型" value={bodyFont} onChange={event => { if (!busy) setBodyFont(event.target.value); }}>{bundledFontFamilies().map(family => <option key={family}>{family}</option>)}</select></label>
        <label>動畫速度<input aria-label="模板動畫速度" type="range" min={.5} max={2} step={.1} value={speed} onChange={event => { if (!busy) setSpeed(Number(event.target.value)); }} /><output>{speed.toFixed(1)} 倍</output></label>
      </details>
      {!portrait && <label><input aria-label="橫式獨立展示" type="checkbox" checked={showcase} onChange={event => { if (!busy) setShowcase(event.target.checked); }} />這段是獨立展示場景</label>}
      {!portrait && <small>長片局部提示保留全尺寸原片；整幕模板適用於明確選定的展示段落。</small>}
      <button type="button" data-testid="apply-reference-motion-template" disabled={busy || !ready || !onApply} onClick={() => {
        if (busy || !ready) return;
        onApply?.({ templateId, graphicCadence, title, kicker: kicker || undefined, subtitle: subtitle || undefined,
        ...(templateId === "comparison_pair" ? { mediaPresentation } : {}),
        ...(templateId === "strike_reframe" ? { strikePresentation,
          ...(strikePresentation === "semantic_replace_v1" ? { strikeSurface } : {}),
          ...(strikePresentation === "semantic_replace_v1" && useBrandMark ? { brandMark: brandMark.trim() } : {}) } : {}),
        previousText: templateId === "strike_reframe" ? previousText : undefined, items: showItems ? items.slice(0, effectiveItemCount).map(item => ({ label: item.label, detail: item.detail || undefined })) : undefined,
        network: templateId === "kinetic_network" ? { seed: networkSeed, points: networkPoints,
          labels: networkLabels.every(label => label.trim()) ? networkLabels : undefined, hubLabel: hubLabel || undefined, groupColors } : undefined,
        primaryLabel: primaryLabel || undefined, focusRegion: templateId === "brand_recap" && useFocus ? focusRegion : undefined, sources: selectedSources, intent: portrait ? "shortform" : "standalone_showcase", purpose: `使用者選定：${recipe.description}`,
        style: { palette: { surface, text: textColor, accent, muted, separator }, typography: { headingFamily: font, bodyFamily: bodyFont }, animationSpeed: speed } });
      }}>建立可儲存 Motion 模板</button>
      <small>此片段 {clip.duration.toFixed(2)} 秒；需至少 {recipe.minSeconds} 秒。較長文案需更多閱讀時間。</small>
      </fieldset>
      {busy && <div role="status">正在核對字型並準備模板… <button type="button" onClick={onCancel} disabled={!onCancel} data-testid="cancel-reference-motion-template">取消準備</button></div>}
    </div>
  </details>;
}

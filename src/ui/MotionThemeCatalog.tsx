import { useEffect, useState } from "react";
import type { EditProject } from "../domain/types";
import { REFERENCE_MOTION_DESIGN_THEMES, REFERENCE_MOTION_VIDEO_TYPES, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { emptyReferenceMotionCatalogDraft, initialReferenceMotionCatalogSelection, referenceMotionCatalogClips,
  referenceMotionCatalogSources, referenceMotionCatalogThemes, referenceMotionCatalogFamilies, referenceMotionCatalogInput,
  REFERENCE_CATALOG_ITEM_FAMILIES, ReferenceMotionCatalogValidationError, type CatalogVideoType, type ReferenceMotionCatalogDraft } from "../application/referenceMotionCatalogSelection";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import "./motionThemeCatalog.css";

/** Uses the saved-instance producer and the parent's existing one-batch preparation channel. */
export default function MotionThemeCatalog({ project, selectedClipId, onApply, busy = false, onCancel }: {
  project?: EditProject; selectedClipId?: string; onApply?: (input: ReferenceMotionTemplateInput) => void;
  busy?: boolean; onCancel?: () => void;
}) {
  useI18n();
  const [selection, setSelection] = useState(initialReferenceMotionCatalogSelection);
  const [draft, setDraft] = useState(emptyReferenceMotionCatalogDraft);
  const clips = project ? referenceMotionCatalogClips(project) : [];
  const [clipId, setClipId] = useState(() => clips.some(clip => clip.id === selectedClipId) ? selectedClipId! : clips[0]?.id ?? "");
  useEffect(() => {
    const available = project ? referenceMotionCatalogClips(project) : [];
    setClipId(available.some(clip => clip.id === selectedClipId) ? selectedClipId! : selectedClipId ? "" : available[0]?.id ?? "");
  }, [project?.id, selectedClipId]);
  const families = referenceMotionCatalogFamilies(selection), recipe = families.find(item => item.id === selection.family)!;
  const clip = clips.find(item => item.id === clipId), assets = project ? referenceMotionCatalogSources(project) : [];
  const sources = assets.filter(asset => asset.id !== clip?.assetId);
  const itemCount = recipe.id === "kinetic_network" ? 3 : draft.itemCount;
  const sourceCount = recipe.id === "focus_wall" ? draft.sourceCount : recipe.sourceSlots;
  let prepared: ReferenceMotionTemplateInput | undefined, reason = "", reasonValues: Record<string, string | number> | undefined;
  try {
    if (!project) throw new Error("請先把影片加入時間軸，再選擇要套用的片段。");
    prepared = referenceMotionCatalogInput(project, clipId, selection, draft);
  } catch (error) {
    reason = error instanceof Error ? error.message : "請檢查模板內容後再套用。";
    if (error instanceof ReferenceMotionCatalogValidationError) reasonValues = error.values;
  }
  const copy = (key: keyof Omit<ReferenceMotionCatalogDraft, "items" | "sources" | "itemCount" | "sourceCount">, value: string) => {
    if (!busy) setDraft(current => ({ ...current, [key]: value }));
  };
  const item = (index: number, patch: Partial<ReferenceMotionCatalogDraft["items"][number]>) => {
    if (!busy) setDraft(current => ({ ...current, items: current.items.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  };
  const source = (index: number, patch: Partial<ReferenceMotionCatalogDraft["sources"][number]>) => {
    if (!busy) setDraft(current => ({ ...current, sources: current.sources.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  };
  return <section className="native-template-setup motion-theme-catalog" data-testid="motion-theme-catalog" aria-label={uiText("題材與動態模板")}>
    <header><strong>{uiText("選擇題材、主題與動態編排")}</strong><small>{uiText("填入自己的內容；原影片會保留，文字與動態可以再修改。")}</small></header>
    <fieldset disabled={busy} aria-busy={busy}>
      <label>{uiText("影片類型")}<select aria-label={uiText("模板影片類型")} value={selection.videoType} onChange={event => {
        if (!busy) setSelection(initialReferenceMotionCatalogSelection(event.target.value as CatalogVideoType));
      }}>{Object.entries(REFERENCE_MOTION_VIDEO_TYPES).map(([id, type]) => <option key={id} value={id}>{uiText(type.name)}</option>)}</select></label>
      <label>{uiText("視覺主題")}<select aria-label={uiText("模板視覺主題")} value={selection.theme} onChange={event => {
        if (!busy) setSelection(current => ({ ...current, theme: event.target.value as typeof selection.theme }));
      }}>{referenceMotionCatalogThemes(selection.videoType).map(id => <option key={id} value={id}>{uiText(REFERENCE_MOTION_DESIGN_THEMES[id].name)}</option>)}</select></label>
      <label>{uiText("動態編排")}<select aria-label={uiText("模板動態編排")} value={selection.family} onChange={event => {
        if (!busy) setSelection(current => ({ ...current, family: event.target.value as typeof selection.family }));
      }}>{families.map(family => <option key={family.id} value={family.id}>{uiText(family.name)}</option>)}</select></label>
      <small>{uiText("切換類型、主題或編排時，已填的文案會保留。")}</small>
      <label>{uiText("要套用的片段")}<select aria-label={uiText("題材模板影片片段")} value={clipId} onChange={event => { if (!busy) setClipId(event.target.value); }}>
        <option value="">{uiText("選擇影片…")}</option>{clips.map(candidate => <option key={candidate.id} value={candidate.id}>
          {assets.find(asset => asset.id === candidate.assetId)?.name} · {uiText("{start} 秒起 · {duration} 秒", { start: candidate.timelineStart.toFixed(2), duration: candidate.duration.toFixed(2) })}
        </option>)}
      </select></label>
      <label>{uiText("主標題")}<input aria-label={uiText("題材模板主標題")} maxLength={32} value={draft.title} onChange={event => copy("title", event.target.value)} /></label>
      {recipe.id === "strike_reframe" && <label>{uiText("要刪去的原句")}<input aria-label={uiText("題材模板原句")} maxLength={24} value={draft.previousText} onChange={event => copy("previousText", event.target.value)} /></label>}
      <div className="native-template-row">
        <label>{uiText("眉題")}<input aria-label={uiText("題材模板眉題")} maxLength={24} value={draft.kicker} onChange={event => copy("kicker", event.target.value)} /></label>
        <label>{uiText("補充短句")}<input aria-label={uiText("題材模板補充短句")} maxLength={40} value={draft.subtitle} onChange={event => copy("subtitle", event.target.value)} /></label>
      </div>
      <label>{uiText("重點文字")}<input aria-label={uiText("題材模板重點字")} maxLength={20} value={draft.accentText} onChange={event => copy("accentText", event.target.value)} /><small>{uiText("重點字要出現在主標題中，可以留空。")}</small></label>
      {recipe.id === "strike_reframe" && <label>{uiText("短標籤")}<input aria-label={uiText("題材模板標籤")} maxLength={20} value={draft.tag} onChange={event => copy("tag", event.target.value)} /></label>}
      <label>{uiText("文字字標")}<input aria-label={uiText("題材模板文字字標")} maxLength={16} value={draft.brandMark} onChange={event => copy("brandMark", event.target.value)} />
        <small>{uiText("自己的品牌名稱；片尾字標必填，其他編排可以留空。")}</small></label>
      {(REFERENCE_CATALOG_ITEM_FAMILIES.includes(recipe.id) || sourceCount > 0 || recipe.id === "ui_demo") && <label>{uiText("主影片短標籤")}<input aria-label={uiText("題材模板主影片標籤")} maxLength={20} value={draft.primaryLabel} onChange={event => copy("primaryLabel", event.target.value)} /></label>}
      {REFERENCE_CATALOG_ITEM_FAMILIES.includes(recipe.id) && <section className="motion-theme-fields">
        {(["kinetic_network", "statement_cut", "word_cycle"] as string[]).includes(recipe.id) && <small>{uiText("每個重點最多 8 字，請縮短短句。")}</small>}
        {(["stat_reveal", "stat_cycle"] as string[]).includes(recipe.id) && <small>{uiText("每個重點請填入含數字的真實資料，最多 12 字。")}</small>}
        {recipe.id === "ranked_list" && <small>{uiText("排行分數請填入真實數字，最多 8 字，也可以留空。")}</small>}
        {recipe.id === "ui_demo" && <small>{uiText("請填入按鈕文字；設定名稱最多 12 字、設定值最多 10 字。")}</small>}
        {recipe.id !== "kinetic_network" && <label>{uiText("重點數量")}<select aria-label={uiText("題材模板重點數量")} value={draft.itemCount} onChange={event => {
          if (!busy) setDraft(current => ({ ...current, itemCount: Number(event.target.value) }));
        }}>{[2, 3, 4].map(count => <option key={count} value={count}>{count}</option>)}</select></label>}
        {draft.items.slice(0, itemCount).map((row, index) => <div className="native-template-row" key={index}>
          <label>{uiText("重點 {value0}", { value0: index + 1 })}<input aria-label={uiText("題材模板重點 {value0}", { value0: index + 1 })} maxLength={24} value={row.label} onChange={event => item(index, { label: event.target.value })} /></label>
          <label>{uiText("補充說明")}<input aria-label={uiText("題材模板重點說明 {value0}", { value0: index + 1 })} maxLength={40} value={row.detail} onChange={event => item(index, { detail: event.target.value })} /></label>
        </div>)}
        {(["stat_reveal", "stat_cycle", "ranked_list"] as string[]).includes(recipe.id) && <small>{uiText("數字請填入已核對的真實資料；沒有資料時請選其他編排。")}</small>}
      </section>}
      {recipe.id === "word_build" && <small>{uiText("逐字標題請用空格分開至少兩個詞。")}</small>}
      {recipe.id === "focus_wall" && <label>{uiText("額外素材數量")}<select aria-label={uiText("題材模板額外素材數量")} value={draft.sourceCount} onChange={event => {
        if (!busy) setDraft(current => ({ ...current, sourceCount: Number(event.target.value) }));
      }}>{[2, 3, 4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{count}</option>)}</select></label>}
      {draft.sources.slice(0, sourceCount).map((row, index) => <section className="motion-theme-fields" key={index}>
        <label>{uiText("額外素材 {value0}", { value0: index + 1 })}<select aria-label={uiText("題材模板素材 {value0}", { value0: index + 1 })} value={row.assetId} onChange={event => source(index, { assetId: event.target.value, sourceStart: "0" })}>
          <option value="">{uiText("選擇影片…")}</option>{sources.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select></label>
        <div className="native-template-row">
          <label>{uiText("入點（秒）")}<input aria-label={uiText("題材模板素材入點 {value0}", { value0: index + 1 })} type="number" min={0} step={1 / (project?.fps ?? 30)} value={row.sourceStart} onChange={event => source(index, { sourceStart: event.target.value })} /></label>
          <label>{uiText("短標籤")}<input aria-label={uiText("題材模板素材標籤 {value0}", { value0: index + 1 })} maxLength={20} value={row.label} onChange={event => source(index, { label: event.target.value })} /></label>
        </div>
      </section>)}
      <div role="status" data-testid="motion-theme-status">{reason ? uiText(reason, reasonValues) : uiText("套用後請先看成片，再決定是否採用。")}</div>
      <button type="button" data-testid="apply-motion-theme-catalog" disabled={busy || !prepared || !onApply} onClick={() => { if (!busy && prepared) onApply?.(prepared); }}>{uiText("填入內容並套用")}</button>
    </fieldset>
    {busy && <div role="status">{uiText("正在核對字型並準備模板…")}<button type="button" className="secondary-action" disabled={!onCancel} onClick={onCancel}>{uiText("取消準備")}</button></div>}
  </section>;
}

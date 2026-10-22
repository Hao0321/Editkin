import type { EditProject, MediaAsset, TimelineClip } from "../domain/types";
import { REFERENCE_MOTION_TEMPLATES, REFERENCE_MOTION_DESIGN_THEMES, REFERENCE_MOTION_VIDEO_TYPES,
  REFERENCE_MOTION_DESIGN_CONTRACT, designThemeDefaultStyle, referenceMotionTemplateInputSchema,
  type ReferenceMotionDesignSystem, type ReferenceMotionTemplateId, type ReferenceMotionTemplateInput } from "../motion/referenceMotionTemplates";
import { referenceMotionTemplateSourceColorAdmitted } from "./referenceMotionTemplateCommands";
import { templateShortGlyphSupported } from "./templateShortBrief";
import { referenceMotionReuseSourceIdentity } from "./referenceMotionTemplateReuse";

export class ReferenceMotionCatalogValidationError extends Error {
  constructor(message: string, readonly values: Record<string, string | number>) { super(message); }
}
const sourceIdentity = (uri: string) => { try { return referenceMotionReuseSourceIdentity(uri); } catch { return undefined; } };

export type CatalogVideoType = keyof typeof REFERENCE_MOTION_VIDEO_TYPES;
export interface ReferenceMotionCatalogSelection { videoType: CatalogVideoType; theme: ReferenceMotionDesignSystem; family: ReferenceMotionTemplateId }
export interface ReferenceMotionCatalogDraft {
  title: string; kicker: string; subtitle: string; previousText: string; accentText: string; tag: string; brandMark: string;
  primaryLabel: string; itemCount: number; items: Array<{ label: string; detail: string }>;
  sourceCount: number; sources: Array<{ assetId: string; sourceStart: string; label: string }>;
}
export const REFERENCE_CATALOG_ITEM_FAMILIES: readonly ReferenceMotionTemplateId[] = ["context_stack", "brand_recap", "kinetic_network",
  "stat_reveal", "statement_cut", "stat_cycle", "word_cycle", "ranked_list", "ui_demo"];
export function emptyReferenceMotionCatalogDraft(): ReferenceMotionCatalogDraft {
  return { title: "", kicker: "", subtitle: "", previousText: "", accentText: "", tag: "", brandMark: "", primaryLabel: "",
    itemCount: 3, items: Array.from({ length: 4 }, () => ({ label: "", detail: "" })),
    sourceCount: 2, sources: Array.from({ length: 8 }, () => ({ assetId: "", sourceStart: "0", label: "" })) };
}
export function initialReferenceMotionCatalogSelection(videoType: CatalogVideoType = "teaching"): ReferenceMotionCatalogSelection {
  if (!Object.hasOwn(REFERENCE_MOTION_VIDEO_TYPES, videoType)) throw new Error("請重新選擇影片類型與主題。");
  const type = REFERENCE_MOTION_VIDEO_TYPES[videoType];
  return { videoType, theme: type.styles[0], family: type.scenes[0] };
}
/** Video types rank choices; the engine supports every design family in every design theme. */
export function referenceMotionCatalogThemes(videoType: CatalogVideoType): ReferenceMotionDesignSystem[] {
  if (!Object.hasOwn(REFERENCE_MOTION_VIDEO_TYPES, videoType)) throw new Error("請重新選擇影片類型與主題。");
  const preferred: readonly string[] = REFERENCE_MOTION_VIDEO_TYPES[videoType].styles;
  return [...preferred, ...Object.keys(REFERENCE_MOTION_DESIGN_THEMES).filter(theme => !preferred.includes(theme))] as ReferenceMotionDesignSystem[];
}
export function referenceMotionCatalogFamilies(selection: Pick<ReferenceMotionCatalogSelection, "videoType" | "theme">) {
  if (!Object.hasOwn(REFERENCE_MOTION_VIDEO_TYPES, selection.videoType) || !Object.hasOwn(REFERENCE_MOTION_DESIGN_THEMES, selection.theme)) {
    throw new Error("請重新選擇影片類型與主題。");
  }
  const preferred: readonly string[] = REFERENCE_MOTION_VIDEO_TYPES[selection.videoType].scenes;
  const supported: readonly string[] = REFERENCE_MOTION_DESIGN_CONTRACT.families;
  return REFERENCE_MOTION_TEMPLATES.filter(recipe => supported.includes(recipe.id)).sort((a, b) => {
    const rank = (id: string) => { const index = preferred.indexOf(id); return index < 0 ? preferred.length : index; };
    return rank(a.id) - rank(b.id);
  });
}
export function referenceMotionCatalogSources(project: EditProject): MediaAsset[] {
  return project.assets.filter(asset => asset.kind === "video" && !asset.compositionId && !asset.imageSequence
    && Number.isFinite(asset.duration) && asset.duration > 0 && sourceIdentity(asset.uri) !== undefined
    && referenceMotionTemplateSourceColorAdmitted(project, asset, false));
}
export function referenceMotionCatalogClips(project: EditProject): TimelineClip[] {
  const owned = new Set((project.referenceMotionInstances ?? []).flatMap(instance => [instance.input.clipId,
    ...instance.roles.filter(role => role.kind === "clip").map(role => role.id)]));
  for (const item of project.templateApplication?.generatedClips ?? []) owned.add(item.clipId);
  for (const item of project.templateApplication?.applied.clips ?? []) owned.add(item.clipId);
  const assets = new Set(referenceMotionCatalogSources(project).map(asset => asset.id));
  return project.tracks.filter(track => track.kind === "video" && !track.locked && !track.hidden).flatMap(track =>
    track.clips.filter(clip => assets.has(clip.assetId) && !owned.has(clip.id) && clip.layer?.enabled !== false
      && (clip.layer?.role === undefined || clip.layer.role === "content")));
}
/** User-authored fields only. No placeholder copy, footage claims or artwork approval is generated. */
export function referenceMotionCatalogInput(project: EditProject, clipId: string, selection: ReferenceMotionCatalogSelection,
  draft: ReferenceMotionCatalogDraft): ReferenceMotionTemplateInput {
  const recipe = referenceMotionCatalogFamilies(selection).find(item => item.id === selection.family);
  if (!recipe) throw new Error("這個主題沒有提供所選的動態編排。");
  if (project.width <= 0 || project.height <= project.width) throw new Error("這套題材模板需要直式專案；長片請使用局部提示。");
  const clip = referenceMotionCatalogClips(project).find(item => item.id === clipId);
  if (!clip) throw new Error("請先選擇沒有鎖定、尚未套用模板的影片片段。");
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw new Error("專案影格率無效，請重新開啟專案。");
  const exact = (value: number) => Number.isFinite(value) && Number.isSafeInteger(Math.round(value * project.fps))
    && Math.abs(value * project.fps - Math.round(value * project.fps)) <= 1e-7;
  if (![clip.timelineStart, clip.duration, clip.sourceStart].every(exact) || clip.duration < recipe.minSeconds) {
    throw new Error("這段影片太短或不在完整影格上，請先調整片段。");
  }
  if (clip.duration * project.fps > 1800) throw new Error("這段影片超過模板長度上限，請先分割片段。");
  if (!draft.title.trim()) throw new Error("請填入自己的主標題。");
  const sourceCount = recipe.id === "focus_wall" ? draft.sourceCount : recipe.sourceSlots;
  if (!Number.isInteger(sourceCount) || sourceCount < recipe.sourceSlots || sourceCount > recipe.maxSources || draft.sources.length < sourceCount) throw new Error("請重新選擇素材數量。");
  const assets = referenceMotionCatalogSources(project), primary = assets.find(asset => asset.id === clip.assetId)!;
  if (clip.sourceStart < 0 || clip.duration <= 0 || clip.sourceStart + clip.duration > primary.duration + 1e-7) throw new Error("主影片沒有足夠的素材範圍。");
  const selected = draft.sources.slice(0, sourceCount).map(slot => {
    const asset = assets.find(item => item.id === slot.assetId), sourceStart = Number(slot.sourceStart);
    if (!asset || asset.id === primary.id || !slot.sourceStart.trim() || sourceStart < 0 || !exact(sourceStart)
      || sourceStart + clip.duration > asset.duration + 1e-7 || !slot.label.trim()) throw new Error("請選擇不同的額外素材，填好起點與短標籤。");
    return { assetId: asset.id, sourceStart, label: slot.label.trim() };
  });
  if (new Set(selected.map(slot => slot.assetId)).size !== sourceCount) throw new Error("額外素材不能重複。");
  const chosenAssets = [primary, ...selected.map(slot => assets.find(asset => asset.id === slot.assetId)!)];
  const pins = chosenAssets.flatMap(asset => asset.derivatives?.sourceSha256 ? [asset.derivatives.sourceSha256] : []);
  if (new Set(chosenAssets.map(asset => sourceIdentity(asset.uri))).size !== chosenAssets.length || new Set(pins).size !== pins.length) {
    throw new Error("這些素材指向同一段影片，請換一份不同的素材。");
  }
  const text = (value: string) => value.trim() || undefined;
  const usesItems = REFERENCE_CATALOG_ITEM_FAMILIES.includes(recipe.id), count = recipe.id === "kinetic_network" ? 3 : draft.itemCount;
  if (usesItems && (!Number.isInteger(count) || count < 2 || count > 4 || draft.items.length < count || draft.items.slice(0, count).some(item => !item.label.trim()))) {
    throw new Error("請填入每個真正要呈現的重點。");
  }
  const parsed = referenceMotionTemplateInputSchema.safeParse({ templateId: recipe.id, designSystem: selection.theme, clipId: clip.id,
    startFrame: Math.round(clip.timelineStart * project.fps), durationFrames: Math.round(clip.duration * project.fps), graphicCadence: "kinetic",
    title: draft.title.trim(), kicker: text(draft.kicker), subtitle: text(draft.subtitle), accentText: text(draft.accentText),
    brandMark: text(draft.brandMark), primaryLabel: text(draft.primaryLabel), sources: selected,
    ...(recipe.id === "strike_reframe" ? { previousText: text(draft.previousText), tag: text(draft.tag) } : {}),
    ...(usesItems ? { items: draft.items.slice(0, count).map(item => ({ label: item.label.trim(), detail: text(item.detail) })) } : {}),
    ...(recipe.id === "kinetic_network" ? { network: { seed: 32021, points: 32 } } : {}),
    intent: "shortform", purpose: `使用者選定：${REFERENCE_MOTION_VIDEO_TYPES[selection.videoType].name}・${REFERENCE_MOTION_DESIGN_THEMES[selection.theme].name}`,
    evidenceRefs: [`manual:template-catalog-choice:${project.revision}:${clip.id.slice(0, 64)}`], style: designThemeDefaultStyle(selection.theme) });
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.path[0] === "accentText")) throw new Error("重點字最多 12 字，且必須出現在主標題中。");
    if (parsed.error.issues.some(issue => issue.path[0] === "tag")) throw new Error("短標籤最多 8 字，請縮短標籤。");
    throw new Error("文字太長或內容格式有誤，請縮短內容後再套用。");
  }
  const input = parsed.data;
  for (const value of [input.title, input.kicker, input.subtitle, input.previousText, input.accentText, input.tag, input.brandMark,
    input.primaryLabel, ...(input.items ?? []).flatMap(item => [item.label, item.detail]), ...input.sources.map(slot => slot.label)]) {
    const unsupported = Array.from(value ?? "").find(character => !templateShortGlyphSupported(character));
    if (unsupported) throw new ReferenceMotionCatalogValidationError("文字包含尚未支援的字元「{value0}」。", { value0: unsupported });
  }
  if (recipe.id === "strike_reframe" && !input.previousText) throw new Error("請填入要刪去的原句。");
  if (recipe.id === "logo_end" && !input.brandMark) throw new Error("請填入自己的文字字標。");
  if (["kinetic_network", "statement_cut", "word_cycle"].includes(recipe.id) && input.items?.some(item => Array.from(item.label).length > 8)) {
    throw new Error("每個重點最多 8 字，請縮短短句。");
  }
  if (["stat_reveal", "stat_cycle"].includes(recipe.id) && input.items?.some(item => !/\d/.test(item.label) || Array.from(item.label).length > 12)) {
    throw new Error("每個重點請填入含數字的真實資料，最多 12 字。");
  }
  if (recipe.id === "word_build" && `${input.title} ${input.subtitle ?? ""}`.trim().split(/\s+/).length < 2) {
    throw new Error("逐字標題請用空格分開至少兩個詞。");
  }
  if (recipe.id === "ranked_list" && input.items?.some(item => item.detail !== undefined && (!/\d/.test(item.detail) || Array.from(item.detail).length > 8))) {
    throw new Error("排行分數請填入真實數字，最多 8 字，也可以留空。");
  }
  if (recipe.id === "ui_demo" && (!input.primaryLabel || input.items?.some(item => Array.from(item.label).length > 12 || Array.from(item.detail ?? "").length > 10))) {
    throw new Error("請填入按鈕文字；設定名稱最多 12 字、設定值最多 10 字。");
  }
  return input;
}

import * as z from "zod/v4";
import type { EditProject } from "../domain/types";
import type { ReferenceMotionTemplateInstance } from "../domain/referenceMotionInstance";
import { referenceMotionTemplateInputSchema, referenceMotionTemplate } from "../motion/referenceMotionTemplates";

const id = z.string().min(1).max(160).refine(value => value.trim() === value && !/[\u0000\r\n]/.test(value), "Invalid source identity");
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().finite().nonnegative();
export const referenceMotionSourceReplacementPatchSchema = z.strictObject({
  primary: z.strictObject({ assetId: id, sourceStart: seconds }).optional(),
  sources: z.array(z.strictObject({ assetId: id, sourceStart: seconds, label: z.string().trim().min(1).max(20).optional() }).nullable()).max(8).optional(),
  durationFrames: z.number().int().min(30).max(1800).optional(),
  audio: z.strictObject({ primary: z.enum(["keep_level", "mute", "unity"]), extra: z.array(z.literal("muted")).max(8).optional() }),
  focusRegion: referenceMotionTemplateInputSchema.shape.focusRegion.unwrap().nullable().optional(),
  textRegion: referenceMotionTemplateInputSchema.shape.textRegion.unwrap().nullable().optional(),
  purpose: z.string().trim().min(1).max(160).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8).optional(),
});
export const referenceMotionSourceReplacementRequestSchema = referenceMotionSourceReplacementPatchSchema.safeExtend({
  instanceId: id, expectedInstanceRevision: revision.positive(), expectedProjectRevision: revision,
});
export type ReferenceMotionSourceReplacementRequest = z.input<typeof referenceMotionSourceReplacementRequestSchema>;

export const SOURCE_REPLACEMENT_MESSAGES = {
  edited: "模板圖層已被手動修改或缺少素材，無法自動更換影片；可先解除模板連結再一般替換。",
  stale: "模板已有新版本，請重新開啟後再換。",
  unchanged: "影片、起點和長度都沒有變更。",
  videoOnly: "請選擇影片檔，不能用音訊、圖片或預合成。",
  geometry: "新影片缺少畫面尺寸或比例資訊，請重新匯入。",
  color: "這個影片的色彩格式不能放進模板（需要 Rec.709，或標記完整的 iPhone HLG）。",
  frame: "起點必須是 0 或正數，並對齊影格。",
  nextClip: "新長度會蓋到同一軌後面的片段；請縮短長度或先移開後面的片段。",
  foreignMotion: "新長度會碰到後面的 Motion 圖卡；請縮短長度。",
  alias: "同一個影片不能同時放在模板的兩個位置。",
  crop: "原本的主體取景不適用新影片，請取消「沿用原本的主體取景」。",
  topology: "新影片的比例會改變模板結構；請選相同比例的影片，或先解除模板連結。",
  missingFile: "找不到這個影片檔，可能已移動或刪除。模板沒有變更。",
  unreadable: "無法讀取這個影片檔（權限或格式問題）。模板沒有變更。",
  changedFile: "這個影片檔和匯入時不同，請重新匯入後再換。",
  oneFile: "請只選一個影片檔。",
  playback: "無法停止目前的播放，模板沒有變更。請先暫停再試。",
  extraAudio: "這一版的額外影片固定靜音；請逐一確認靜音選擇。",
  freshEvidence: "新影片需要新的素材確認，不能沿用上一段影片的證據。",
  regions: "換新影片時，請明確選擇新的主體取景與文字位置，或恢復預設。",
  extraLabel: "請重新填寫已更換影片的素材標籤。",
  adjacentShrink: "後面緊接著片段或有轉場，不能縮短模板；請先留出間隔。",
  layout: "新影片的比例放不進原版型；請選相同比例的影片，或先解除模板連結。",
  success: "已更換模板影片；文字、字型與配色沒有改變，可一次復原。請重新看一次成片。",
} as const;

export { referenceMotionSourceSlots, referenceMotionClipOwner, type ReferenceMotionSourceSlotView } from "../domain/referenceMotionSourceSlots";
export function sourceReplacementExactFrame(seconds: number, fps: number): number | undefined {
  const value = seconds * fps, frame = Math.round(value);
  return Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(fps) && fps > 0 && fps <= 240
    && Number.isSafeInteger(frame) && Math.abs(value - frame) <= 1e-7 ? frame : undefined;
}
export function sourceReplacementMinimumFrames(project: EditProject, instance: ReferenceMotionTemplateInstance): number {
  if (!Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 240) throw new Error(SOURCE_REPLACEMENT_MESSAGES.frame);
  return Math.max(30, Math.ceil(referenceMotionTemplate(instance.input.templateId).minSeconds * project.fps));
}

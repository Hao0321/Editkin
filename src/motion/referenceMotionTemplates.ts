import { z } from "zod";
import { motionSceneStyleSchema } from "../domain/motionSceneStyle";
import type { MotionSceneStyle } from "../domain/motionSceneStyle";

/** Editkin sky brand: verified against ui/theme.css, not reference-video colors. */
export const DEFAULT_REFERENCE_MOTION_STYLE: MotionSceneStyle = {
  palette: { surface: "#FFFFFF", text: "#172033", accent: "#175CD3", muted: "#5B6678", separator: "#D8DEE8" },
  typography: { headingFamily: "Noto Serif TC", bodyFamily: "Noto Sans TC" }, animationSpeed: 1,
};
export const DEFAULT_REFERENCE_NETWORK_COLORS: [string, string, string] = ["#175CD3", "#2E90FA", "#0B3B95"];
export const REFERENCE_MOTION_COLOR_POLICY = "Use the creator's verified brand palette or an original design; never extract or copy reference palettes, author branding or color roles as RGB values.";

/** Original editable recipes. Reference video, typography and brand assets are not bundled. */
export const REFERENCE_MOTION_TEMPLATES = [
  { id: "strike_reframe", name: "刪去誤解 · 揭露重點", grammar: "focus_reveal", sourceSlots: 0, maxSources: 0,
    description: "先讀原句，短線刪去誤解，再揭露新的重點。", reference: "facebook:0–4s", minSeconds: 4 },
  { id: "level_bridge", name: "層級切換 · 穩定主標", grammar: "chapter_progress", sourceSlots: 0, maxSources: 0,
    description: "眉題、主標分層入場；閱讀時位置固定。", reference: "instagram:33–37s", minSeconds: 3 },
  { id: "comparison_pair", name: "兩份證據 · 並列比較", grammar: "comparison", sourceSlots: 1, maxSources: 1,
    description: "兩份不同素材等尺度並列，保留同一個比較基準。", reference: "facebook:8–14s", minSeconds: 4 },
  { id: "context_stack", name: "上下文 · 逐層組裝", grammar: "context_assembly", sourceSlots: 0, maxSources: 0,
    description: "2 至 4 份短資訊依因果順序出場，最後共同停留。", reference: "facebook:23–35s", minSeconds: 4 },
  { id: "evidence_takeover", name: "證據接管 · 回到原畫面", grammar: "evidence_takeover", sourceSlots: 0, maxSources: 0,
    description: "同一份影片從框內放大至全畫面，觀看後回到框內；來源時間連續。", reference: "instagram:16–20s", minSeconds: 5 },
  { id: "focus_wall", name: "作品集合 · 選中聚焦", grammar: "focus_wall", sourceSlots: 2, maxSources: 8,
    description: "3 至 9 份不同影片先總覽，再讓選中影片放大；其餘降亮度後穩定停留。平面作品牆。", reference: "instagram:46–55s", minSeconds: 5 },
  { id: "brand_recap", name: "重點回顧 · 依序收束", grammar: "context_assembly", sourceSlots: 0, maxSources: 0,
    description: "真實影片持續播放，2 至 4 個短重點輪流成為主視覺；依閱讀時間安排交接。", reference: "facebook:51–59s", minSeconds: 4 },
  { id: "kinetic_network", name: "能力連結 · 三幕動態敘事", grammar: "context_assembly", sourceSlots: 0, maxSources: 0,
    description: "三個短語依序主導畫面；原生點群從分散、聚合到連線，每幕保留停留。抽象概念圖，不代表真實人數或平台成果。", reference: "facebook:1090924177018347:0–15s / 1083483141329004:11–17s", minSeconds: 8 },
] as const;

export const referenceMotionTemplateIds = REFERENCE_MOTION_TEMPLATES.map(item => item.id) as
  [typeof REFERENCE_MOTION_TEMPLATES[number]["id"], ...typeof REFERENCE_MOTION_TEMPLATES[number]["id"][]];
export type ReferenceMotionTemplateId = typeof REFERENCE_MOTION_TEMPLATES[number]["id"];

const sourceSlotSchema = z.strictObject({
  assetId: z.string().trim().min(1).max(160), sourceStart: z.number().finite().nonnegative(),
  label: z.string().trim().min(1).max(20),
});
export const referenceMotionTemplateInputSchema = z.strictObject({
  templateId: z.enum(referenceMotionTemplateIds), clipId: z.string().trim().min(1),
  startFrame: z.number().int().nonnegative(), durationFrames: z.number().int().min(30).max(1800),
  title: z.string().trim().min(1).max(32), kicker: z.string().trim().max(24).optional(),
  subtitle: z.string().trim().max(40).optional(), previousText: z.string().trim().max(24).optional(),
  items: z.array(z.strictObject({ label: z.string().trim().min(1).max(24), detail: z.string().trim().max(40).optional() })).min(2).max(4).optional(),
  sources: z.array(sourceSlotSchema).max(8).default([]),
  primaryLabel: z.string().trim().max(20).optional(),
  focusRegion: z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) })
    .refine(r => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, "主體範圍超出來源畫面").optional(),
  network: z.strictObject({ seed: z.number().int().min(0).max(0xffffffff), points: z.number().int().min(8).max(64),
    labels: z.array(z.string().trim().min(1).max(6)).length(3).optional(), hubLabel: z.string().trim().min(1).max(6).optional(),
    groupColors: z.tuple([z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional() }).optional(),
  intent: z.enum(["shortform", "standalone_showcase"]).default("shortform"),
  purpose: z.string().trim().min(1).max(160),
  evidenceRefs: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
  style: motionSceneStyleSchema.optional(),
});
export type ReferenceMotionTemplateInput = z.input<typeof referenceMotionTemplateInputSchema>;
export type ReferenceMotionSourceSlot = z.infer<typeof sourceSlotSchema>;

export function referenceMotionTemplate(id: ReferenceMotionTemplateId) {
  return REFERENCE_MOTION_TEMPLATES.find(item => item.id === id)!;
}

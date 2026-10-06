import type { MotionDesignV3TemplateId, MotionGraphicKind, MotionGraphicPresetSeed } from "../domain/types";
import type { MotionGraphicPreset } from "./motionGraphicPresetTypes";

export type MotionDesignV3Category = "title" | "lower_third" | "chapter" | "data" | "label" | "emphasis";

export const MOTION_DESIGN_V3_CATEGORIES: Record<MotionDesignV3Category, string> = {
  title: "標題", lower_third: "人名條", chapter: "章節", data: "數據", label: "標籤", emphasis: "強調",
};

/** Editor labels for the per-line copy fields of each template. */
export const MOTION_DESIGN_V3_FIELD_LABELS: Record<string, string> = {
  title: "主標題", kicker: "眉標", line: "一行文字", label: "標籤", name: "姓名", role: "職稱", number: "編號", subtitle: "副標",
  value: "數值", percent: "百分比", leftLabel: "左項名稱", leftValue: "左項數值", rightLabel: "右項名稱", rightValue: "右項數值",
  place: "地點", detail: "補充說明", quote: "引言", attribution: "出處", step: "步驟", button: "按鈕文字",
};

export function motionDesignV3FieldHint(fields: readonly string[]): string {
  return fields.map(field => field.endsWith("?") ? `${MOTION_DESIGN_V3_FIELD_LABELS[field.slice(0, -1)] ?? field.slice(0, -1)}（可省略）` : MOTION_DESIGN_V3_FIELD_LABELS[field] ?? field).join("\n");
}

interface Theme { textColor: string; backgroundColor: string; accentColor: string }

/** Restrained colour systems; ink on the accent is chosen per WCAG contrast at render time. */
const INK: Theme = { textColor: "#FFFFFF", backgroundColor: "#00000000", accentColor: "#FF5A36" };
const INK_PANEL: Theme = { textColor: "#FFFFFF", backgroundColor: "#0E1116D9", accentColor: "#FF5A36" };
const GLASS: Theme = { textColor: "#FFFFFF", backgroundColor: "#16181DC7", accentColor: "#FF5A36" };
const PAPER: Theme = { textColor: "#15171C", backgroundColor: "#F7F5F0F2", accentColor: "#E2401F" };
const SIGNAL: Theme = { textColor: "#FFFFFF", backgroundColor: "#00000000", accentColor: "#FFD23F" };
const COBALT: Theme = { textColor: "#FFFFFF", backgroundColor: "#00000000", accentColor: "#2F5BFF" };

interface Entry {
  id: string; name: string; category: MotionDesignV3Category; template: MotionDesignV3TemplateId; kind: MotionGraphicKind; theme: Theme;
  text: string; x: number; y: number; width?: number; fontSize: number; fontFamily?: string; fontWeight?: number;
  roles: string[]; avoidWhen?: string[]; intensity: "low" | "medium" | "high";
}

const ENTRIES: Entry[] = [
  { id: "v3_title_reveal", name: "揭幕主標", category: "title", template: "title_reveal", kind: "title", theme: INK, text: "這台相機，改變了我拍片的方式\nREVIEW · 2026", x: .07, y: .56, fontSize: 78, roles: ["hook", "title"], intensity: "medium" },
  { id: "v3_title_reveal_panel", name: "揭幕主標・暗色卡", category: "title", template: "title_reveal", kind: "title", theme: INK_PANEL, text: "一個人的北海道\n旅行日記 EP.3", x: .07, y: .58, fontSize: 70, roles: ["title", "episode"], intensity: "medium" },
  { id: "v3_title_reveal_paper", name: "揭幕主標・紙卡", category: "title", template: "title_reveal", kind: "title", theme: PAPER, text: "週末咖啡地圖\nCITY GUIDE", x: .07, y: .58, fontSize: 70, roles: ["title", "guide"], intensity: "low" },
  { id: "v3_title_impact", name: "衝擊主標", category: "title", template: "title_impact", kind: "title", theme: INK, text: "三個月後\n我後悔了嗎？", x: .07, y: .3, fontSize: 92, roles: ["hook", "payoff"], avoidWhen: ["calm_interview"], intensity: "high" },
  { id: "v3_title_impact_signal", name: "衝擊主標・警示黃", category: "title", template: "title_impact", kind: "title", theme: SIGNAL, text: "千萬別這樣買\n先看完這三點", x: .07, y: .3, fontSize: 92, roles: ["hook", "warning"], avoidWhen: ["calm_interview"], intensity: "high" },
  { id: "v3_title_editorial", name: "雜誌主標", category: "title", template: "title_editorial", kind: "title", theme: INK, text: "在城市邊緣，找到安靜\nCHAPTER 02", x: .5, y: .34, fontSize: 72, roles: ["title", "chapter", "mood"], intensity: "low" },
  { id: "v3_lower_third_bar", name: "人名條・暗色", category: "lower_third", template: "lower_third_bar", kind: "card", theme: INK_PANEL, text: "王小明\n影像實驗室 · 資深攝影師", x: .07, y: .74, fontSize: 50, roles: ["speaker_name", "identity"], avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" },
  { id: "v3_lower_third_paper", name: "人名條・白色", category: "lower_third", template: "lower_third_bar", kind: "card", theme: PAPER, text: "陳怡君\n咖啡烘豆師", x: .07, y: .74, fontSize: 50, roles: ["speaker_name", "identity"], avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" },
  { id: "v3_lower_third_clean", name: "人名條・無底", category: "lower_third", template: "lower_third_bar", kind: "card", theme: INK, text: "李承恩\n獨立遊戲開發者", x: .07, y: .74, fontSize: 50, roles: ["speaker_name", "identity"], avoidWhen: ["identity_unverified", "busy_lower_frame"], intensity: "low" },
  { id: "v3_lower_third_glass", name: "人名卡・霧面", category: "lower_third", template: "lower_third_glass", kind: "card", theme: GLASS, text: "林雨晴\n旅行攝影師", x: .07, y: .74, fontSize: 48, roles: ["speaker_name", "identity"], avoidWhen: ["identity_unverified", "dense_lower_frame"], intensity: "low" },
  { id: "v3_chapter_number", name: "章節大數字", category: "chapter", template: "chapter_number", kind: "title", theme: INK, text: "02\n器材怎麼選\n預算、重量與畫質的取捨", x: .07, y: .36, fontSize: 64, roles: ["chapter", "section"], intensity: "medium" },
  { id: "v3_chapter_card", name: "章節卡・暗色", category: "chapter", template: "chapter_number", kind: "title", theme: INK_PANEL, text: "03\n實拍測試\n白天、夜晚與逆光", x: .07, y: .36, fontSize: 60, roles: ["chapter", "section"], intensity: "medium" },
  { id: "v3_stat_counter", name: "數字計數", category: "data", template: "stat_counter", kind: "counter", theme: INK, text: "1,280\n本週新增訂閱", x: .07, y: .5, fontSize: 170, fontFamily: "Bebas Neue", fontWeight: 400, roles: ["metric", "proof"], intensity: "medium" },
  { id: "v3_stat_counter_signal", name: "數字計數・警示黃", category: "data", template: "stat_counter", kind: "counter", theme: SIGNAL, text: "NT$4,990\n入門機身價格", x: .07, y: .5, fontSize: 150, fontFamily: "Bebas Neue", fontWeight: 400, roles: ["metric", "price"], intensity: "medium" },
  { id: "v3_progress_bar", name: "進度條", category: "data", template: "progress_bar", kind: "counter", theme: INK, text: "電池續航\n86%", x: .07, y: .72, fontSize: 40, roles: ["metric", "rating"], intensity: "low" },
  { id: "v3_compare_bars", name: "比較長條", category: "data", template: "compare_split", kind: "counter", theme: INK, text: "舊款\n6.5 小時\n新款\n9 小時", x: .07, y: .62, fontSize: 46, roles: ["comparison", "proof"], intensity: "medium" },
  { id: "v3_tag_live", name: "直播標籤", category: "label", template: "tag_pill", kind: "tag", theme: INK, text: "LIVE 直播中", x: .07, y: .1, fontSize: 36, roles: ["status", "label"], intensity: "low" },
  { id: "v3_tag_chip", name: "膠囊標籤・暗色", category: "label", template: "tag_pill", kind: "tag", theme: INK_PANEL, text: "開箱實測", x: .07, y: .1, fontSize: 36, roles: ["label", "segment"], intensity: "low" },
  { id: "v3_location_pin", name: "地點標記", category: "label", template: "location_pin", kind: "tag", theme: INK, text: "東京 · 澀谷\n35.6595° N, 139.7005° E", x: .07, y: .74, fontSize: 52, roles: ["location", "establishing"], intensity: "low" },
  { id: "v3_location_card", name: "地點卡片", category: "label", template: "location_pin", kind: "tag", theme: GLASS, text: "京都 · 嵐山\n竹林小徑", x: .07, y: .74, fontSize: 50, roles: ["location", "establishing"], intensity: "low" },
  { id: "v3_callout_line", name: "指示標註", category: "label", template: "callout_line", kind: "tag", theme: INK, text: "1 吋感光元件\n夜拍雜訊更少", x: .62, y: .62, fontSize: 42, roles: ["product_detail", "annotation"], avoidWhen: ["subject_moving_fast"], intensity: "low" },
  { id: "v3_highlight_sweep", name: "螢光筆重點", category: "emphasis", template: "highlight_sweep", kind: "title", theme: INK, text: "重點不是器材\n是你怎麼看世界", x: .07, y: .36, fontSize: 80, roles: ["key_point", "payoff"], intensity: "high" },
  { id: "v3_highlight_signal", name: "螢光筆重點・黃", category: "emphasis", template: "highlight_sweep", kind: "title", theme: SIGNAL, text: "預算有限\n先買好鏡頭", x: .07, y: .36, fontSize: 80, roles: ["key_point", "tip"], intensity: "high" },
  { id: "v3_quote", name: "引言", category: "emphasis", template: "quote_card", kind: "card", theme: INK, text: "最好的相機，就是你身上帶著的那一台。\n攝影圈老話", x: .07, y: .34, fontSize: 54, roles: ["quote", "reflection"], intensity: "low" },
  { id: "v3_quote_card", name: "引言卡・暗色", category: "emphasis", template: "quote_card", kind: "card", theme: INK_PANEL, text: "慢一點，畫面會自己說話。\n本集受訪者", x: .07, y: .34, fontSize: 54, roles: ["quote", "testimonial"], intensity: "low" },
  { id: "v3_steps", name: "步驟清單", category: "emphasis", template: "steps_list", kind: "card", theme: INK, text: "插上電源並開機\n選擇 4K 60fps 模式\n按下錄影鍵開始拍攝", x: .07, y: .3, fontSize: 46, roles: ["tutorial", "steps"], intensity: "low" },
  { id: "v3_cta_subscribe", name: "訂閱按鈕", category: "emphasis", template: "cta_subscribe", kind: "card", theme: INK, text: "訂閱頻道\n每週三晚上 8 點更新", x: .07, y: .78, fontSize: 44, roles: ["cta", "outro"], avoidWhen: ["first_five_seconds"], intensity: "medium" },
  { id: "v3_cta_cobalt", name: "訂閱按鈕・鈷藍", category: "emphasis", template: "cta_subscribe", kind: "card", theme: COBALT, text: "追蹤我\n下一集更精彩", x: .07, y: .78, fontSize: 44, roles: ["cta", "outro"], avoidWhen: ["first_five_seconds"], intensity: "medium" },
];

export const MOTION_DESIGN_V3_PRESETS: readonly (MotionGraphicPreset & { category: MotionDesignV3Category })[] = ENTRIES.map((entry) => {
  const seed: MotionGraphicPresetSeed = {
    schema: "hao.motion-composition/v3", presetId: entry.id, name: entry.name, kind: entry.kind, text: entry.text, designV3: { template: entry.template },
    animation: "fade", x: entry.x, y: entry.y, width: entry.width ?? .84, fontSize: entry.fontSize, offsetX: 0, offsetY: 0, ...entry.theme,
    ...(entry.fontFamily ? { fontFamily: entry.fontFamily } : {}), ...(entry.fontWeight ? { fontWeight: entry.fontWeight } : {}),
  };
  return {
    id: entry.id, name: entry.name, family: `Motion Design v3 · ${MOTION_DESIGN_V3_CATEGORIES[entry.category]}`, category: entry.category, license: "MIT",
    provenance: "Editkin original Motion Design v3 template", renderer: "hao-motion-composition/v3", seed,
    routing: { semanticRoles: entry.roles, formats: ["9:16", "16:9", "1:1"], requires: ["none"], avoidWhen: entry.avoidWhen ?? [], intensity: entry.intensity },
  };
});

export function motionDesignV3Seed(id: string): MotionGraphicPresetSeed {
  const preset = MOTION_DESIGN_V3_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`找不到 Motion Design v3 preset：${id}`);
  return preset.seed;
}

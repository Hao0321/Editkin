import type { ModuleFormat } from "./moduleTypes";

/**
 * Composition templates (editkin.template/v1): named recipes of module slots
 * that Video Autopilot fills from material evidence. A template never invents
 * timing or copy — every fill carries the caller's frames, words and beat id;
 * the template fixes which modules and variants may serve each narrative slot,
 * the base visual package and the pacing budget. Data only: the registry
 * validates every module/variant reference against the live module registry.
 */
export const EDITKIN_TEMPLATE_SCHEMA = "editkin.template/v1" as const;
export const EDITKIN_TEMPLATE_INVOCATION_SCHEMA = "editkin.template-invocation/v1" as const;
export const EDITKIN_TEMPLATE_INDEX_SCHEMA = "editkin.template-index/v1" as const;

/** opening: first seconds · section: start of a step/chapter · keyword: on a spoken word · closing: last beat · global: whole film. */
export const TEMPLATE_PLACEMENTS = ["opening", "section", "keyword", "closing", "global"] as const;
export type TemplatePlacement = typeof TEMPLATE_PLACEMENTS[number];

export interface TemplateSlotOption {
  moduleId: string;
  /** Allowed variants, first = default; omitted when the module has none or any variant is allowed. */
  variantIds?: string[];
  /** Merged under the caller's inputs (caller wins). */
  defaults?: Record<string, unknown>;
}

export interface TemplateSlot {
  id: string;
  name: string;
  /** Story-shape stage this slot serves. */
  stage: string;
  placement: TemplatePlacement;
  min: number;
  max: number;
  /** First option is the default module. */
  options: TemplateSlotOption[];
  guidance: string;
}

export interface CompositionTemplate {
  id: string;
  version: string;
  name: string;
  summary: string;
  bestFor: string;
  formats: ModuleFormat[];
  /** Visual package compiled first when the caller passes base.clipIds. */
  base?: { moduleId: "template.short_form" | "template.long_form"; variantId: string };
  slots: TemplateSlot[];
  /** Designed moments = scene/overlay graphics. Budgets produce warnings, never silent trimming. */
  pacing: { minDesignedGapSeconds: number; maxDesignedShare: number; maxConcurrentOverlays: number };
  /** Invariants the template keeps (identity rules, ownership boundaries). */
  identity: string[];
  source: string;
}

const camera = (variantIds: string[]): TemplateSlotOption => ({ moduleId: "clip_motion.camera", variantIds });
const element = (variantIds: string[], defaults?: Record<string, unknown>): TemplateSlotOption =>
  ({ moduleId: "graphic.original_element", variantIds, ...(defaults ? { defaults } : {}) });
const preset = (variantIds: string[]): TemplateSlotOption => ({ moduleId: "graphic.motion_preset", variantIds });
const overlay = { mode: "overlay" };

export const COMPOSITION_TEMPLATES: readonly CompositionTemplate[] = [
  {
    id: "shorts.tutorial", version: "1.0.0", name: "Shorts 教學：一步一操作", formats: ["portrait"],
    summary: "首幀主標鉤子 → 每步一個步驟連線或操作框選 → 關鍵字強調 → 一行回顧；乾淨中性調色。",
    bestFor: "AI 工具、軟體操作、一步一步的教學短片",
    base: { moduleId: "template.short_form", variantId: "clean_tutorial" },
    pacing: { minDesignedGapSeconds: 1.2, maxDesignedShare: 0.6, maxConcurrentOverlays: 2 },
    slots: [
      { id: "hook", name: "首幀鉤子", stage: "具體鉤子／問題", placement: "opening", min: 1, max: 1,
        options: [preset(["kinetic_slam", "kinetic_pop_punchy", "reel_editorial_step", "kinetic_rise"]), element(["keyword-sticker", "conversation-bubble"])],
        guidance: "首幀就可讀；寫最具體的承諾或問題（旁白原話），至少 0.8 秒閱讀保持。" },
      { id: "step", name: "步驟", stage: "真操作逐段完成", placement: "section", min: 0, max: 8,
        options: [element(["step-path"]), { moduleId: "scene.native_reel", variantIds: ["editorial_steps"] }],
        guidance: "每個新步驟開始時一次；標題用旁白說的動作，不加沒說過的步驟。" },
      { id: "ui_focus", name: "操作框選", stage: "真操作逐段完成", placement: "keyword", min: 0, max: 8,
        options: [element(["focus-bracket"], overlay)],
        guidance: "旁白指向畫面上看得到的控制項時；target 必須來自實際觀察的畫格（sourceId），換頁或捲動前結束。" },
      { id: "emphasis", name: "重點強調", stage: "用圖形講清楚概念", placement: "keyword", min: 0, max: 4,
        options: [camera(["punch_in", "push_settle"]), element(["keyword-sticker"], overlay)],
        guidance: "只放在旁白的關鍵字；運鏡只用在實拍片段，生成圖與字卡不推。" },
      { id: "recap", name: "回顧", stage: "回顧可執行步驟", placement: "closing", min: 0, max: 1,
        options: [element(["recap-strip"])],
        guidance: "把已經講過的步驟濃縮成可執行的一行；不新增承諾。" },
    ],
    identity: ["白字優先字幕（Shorts white-first）", "旁白原聲不改", "一個畫面只講一個操作"],
    source: "Editkin short-form clean_tutorial + video-autopilot shorts tutorial practice",
  },
  {
    id: "shorts.hype", version: "1.0.0", name: "Shorts 高能鉤子", formats: ["portrait"],
    summary: "首秒大字鉤子＋衝擊運鏡 → 反應貼紙與問句泡泡推進 → 揭曉大字收尾；節奏快但每個效果都綁旁白。",
    bestFor: "觀點、挑戰、揭秘、對比結果",
    base: { moduleId: "template.short_form", variantId: "bold_hook" },
    pacing: { minDesignedGapSeconds: 0.8, maxDesignedShare: 0.7, maxConcurrentOverlays: 2 },
    slots: [
      { id: "hook", name: "首秒大字", stage: "具體鉤子／問題", placement: "opening", min: 1, max: 1,
        options: [preset(["kinetic_slam_hype", "kinetic_slam", "kinetic_drop_punchy"])],
        guidance: "首幀可讀的最強承諾；數字必須是真數字（不編造）。" },
      { id: "impact", name: "衝擊運鏡", stage: "鉤子兌現", placement: "keyword", min: 0, max: 4,
        options: [camera(["snap_zoom", "impact_shake", "whip_in", "punch_in"])],
        guidance: "只在旁白重音或畫面真的發生事件時；不連續亂抖。" },
      { id: "question", name: "問句泡泡", stage: "推進好奇", placement: "keyword", min: 0, max: 2,
        options: [element(["conversation-bubble"], overlay)],
        guidance: "旁白真的提出問題時；問句用原話。" },
      { id: "reaction", name: "反應貼紙", stage: "情緒標記", placement: "keyword", min: 0, max: 3,
        options: [element(["reaction-seal"], overlay)],
        guidance: "畫面裡真的有反應瞬間；不當裝飾。" },
      { id: "payoff", name: "揭曉大字", stage: "答案／結論", placement: "closing", min: 0, max: 1,
        options: [preset(["kinetic_drop_punchy", "kinetic_pop_hype", "kinetic_slam"])],
        guidance: "兌現首秒承諾的那一句。" },
    ],
    identity: ["白字優先字幕（Shorts white-first）", "不誇大到結果（voice gate）", "效果數量不加分"],
    source: "Editkin short-form bold_hook + Motion Language punchy/hype energies",
  },
  {
    id: "shorts.vlog", version: "1.0.0", name: "Shorts 旅遊／美食 Vlog", formats: ["portrait"],
    summary: "地點眉題 → 緩推實拍 → 多素材浮空展示 → 手記觀察；柔和調色，留住環境和人的呼吸感。",
    bestFor: "旅遊、美食、日常、幕後（個人內容隨意發，不硬套流量公式）",
    base: { moduleId: "template.short_form", variantId: "mini_vlog" },
    pacing: { minDesignedGapSeconds: 2.5, maxDesignedShare: 0.4, maxConcurrentOverlays: 1 },
    slots: [
      { id: "location", name: "地點眉題", stage: "開場定位", placement: "opening", min: 0, max: 1,
        options: [preset(["travel_editorial_hero", "travel_editorial_eyebrow", "travel_editorial_hero_dark", "travel_editorial_eyebrow_dark"]), element(["chapter-ticket"])],
        guidance: "真實地點或店名；不寫沒去過的地方。" },
      { id: "drift", name: "緩推運鏡", stage: "環境呼吸", placement: "section", min: 0, max: 6,
        options: [camera(["drift_push", "gallery_drift", "slow_push"])],
        guidance: "靜態實拍鏡頭才推；手持晃動素材不再加動。" },
      { id: "showcase", name: "浮空展示", stage: "多素材同框", placement: "section", min: 0, max: 2,
        options: [{ moduleId: "scene.floating_frame", variantIds: ["portrait_stack", "portrait_duo"] }],
        guidance: "同一主題有三個好鏡頭時；素材原比例完整嵌入。" },
      { id: "note", name: "手記觀察", stage: "真心得", placement: "keyword", min: 0, max: 2,
        options: [element(["field-note"], overlay)],
        guidance: "旁白說出具體觀察（味道、價格、排隊時間）時；數字要真。" },
      { id: "reaction", name: "反應貼紙", stage: "情緒標記", placement: "keyword", min: 0, max: 2,
        options: [element(["reaction-seal"], overlay)],
        guidance: "真的反應瞬間；不當裝飾。" },
    ],
    identity: ["個人內容不優化演算法、留真粉", "白字優先字幕", "環境聲與人聲優先"],
    source: "Editkin short-form mini_vlog + Hao personal-content casual posting rule",
  },
  {
    id: "longform.teaching", version: "1.0.0", name: "教學長片（Hao 70 分基準）", formats: ["landscape"],
    summary: "具體鉤子 → 圖形講清楚概念 → 章節票卡 → 真操作逐段完成（框選／局部提示）→ 誠實限制 → 全幅回顧；對應 Long04 70 分故事形狀。",
    bestFor: "AI 工具與工作流教學長片、產品實測講解",
    base: { moduleId: "template.long_form", variantId: "hao_tutorial" },
    pacing: { minDesignedGapSeconds: 4, maxDesignedShare: 0.45, maxConcurrentOverlays: 1 },
    slots: [
      { id: "hook", name: "具體鉤子", stage: "具體鉤子／問題", placement: "opening", min: 1, max: 1,
        options: [preset(["kinetic_slam", "kinetic_rise", "reel_spatial_headline"]), { moduleId: "scene.reference_motion", variantIds: ["strike_reframe", "evidence_takeover"] }],
        guidance: "首幀已有可讀鉤子；真數字或真問題，主張完整停到場景交接，不拆句退場。" },
      { id: "concept", name: "概念圖解", stage: "用圖形講清楚概念與關係", placement: "section", min: 0, max: 4,
        options: [{ moduleId: "scene.reference_motion", variantIds: ["comparison_pair", "context_stack", "level_bridge", "kinetic_network", "focus_wall"] }, { moduleId: "graphic.motion_kit" }],
        guidance: "旁白在講關係或比較時用全幅原創圖形；圖形跟口語意思對齊。" },
      { id: "chapter", name: "章節票卡", stage: "承諾直接看實際內容", placement: "section", min: 0, max: 8,
        options: [element(["chapter-ticket"]), preset(["kinetic_zoom", "kinetic_rise"])],
        guidance: "每個新章節開頭一次；章節名用旁白原話。" },
      { id: "ui_focus", name: "操作框選", stage: "真操作逐段完成旅程", placement: "keyword", min: 0, max: 24,
        options: [element(["focus-bracket"], overlay), { moduleId: "overlay.native_motion_sequence" }],
        guidance: "旁白指向可見的實際控制項時；重新觀察實際畫格定位（不沿用舊座標），捲動／換頁前收掉，保護字幕區。" },
      { id: "emphasis", name: "鏡頭強調", stage: "真操作逐段完成旅程", placement: "keyword", min: 0, max: 6,
        options: [camera(["push_settle", "punch_in"]), element(["keyword-sticker"], overlay)],
        guidance: "教學畫面預設靜止全幅可讀；只有真的焦點才推。" },
      { id: "limit", name: "誠實限制", stage: "誠實說明限制", placement: "keyword", min: 0, max: 2,
        options: [element(["field-note"], overlay)],
        guidance: "旁白說限制或踩雷時；不誇大也不隱藏。" },
      { id: "recap", name: "全幅回顧", stage: "用全幅圖形回顧可執行步驟", placement: "closing", min: 0, max: 1,
        options: [element(["recap-strip"]), { moduleId: "scene.reference_motion", variantIds: ["brand_recap"] }],
        guidance: "只回顧已教過的可執行步驟。" },
    ],
    identity: ["長片字幕全白＋半透明黑底，與主視覺分離（M68，base 模板套用）", "Hao 旁白原聲與自然停頓不改（M101）",
      "片尾三件套由 Video Autopilot 交付流程負責，本模板不產生", "實拍教學畫面不縮成 PPT 小框、不連續亂抖"],
    source: "video-autopilot profiles/longform-70-baseline.json storyShape（hao-longform-70-v1）",
  },
  {
    id: "mv.illustrated", version: "1.0.0", name: "插畫動畫 MV", formats: ["landscape", "portrait"],
    summary: "有權利的插畫背景與透明角色圖層＋歌曲 → 分層 2D 鏡頭推移、角色進場、節拍動態與已驗證歌詞。",
    bestFor: "原創歌曲、動畫 MV",
    pacing: { minDesignedGapSeconds: 0, maxDesignedShare: 1, maxConcurrentOverlays: 4 },
    slots: [
      { id: "draft", name: "MV 草稿", stage: "整支 MV", placement: "global", min: 1, max: 1,
        options: [{ moduleId: "music_video.illustrated" }],
        guidance: "需要授權插畫圖層、歌曲與已驗證歌詞；不要用實拍歌詞卡假裝動畫 MV。" },
    ],
    identity: ["只用有權利的原創／授權插畫", "歌詞必須逐字驗證", "實拍蒙太奇 MV 只在明確要求時另用 music_video.footage"],
    source: "Editkin illustrated music video compiler",
  },
];

import type { EditorialProfileId } from "../domain/types";

export type EditingRhythm = "calm" | "balanced" | "energetic";

export interface EditorialProfile {
  id: EditorialProfileId;
  label: string;
  shortLabel: string;
  description: string;
  rhythm?: EditingRhythm;
  targetBpm?: number;
  captionPresetId?: string;
  lookPresetId?: string;
  effectPresetIds?: string[];
  transitionPresetId?: string;
  visualPolicy: "content_adaptive" | "subject_first" | "speaker_director" | "no_face_documentary";
  promptHint: string;
}

export const EDITORIAL_PROFILES: readonly EditorialProfile[] = [
  { id: "auto", label: "讓 Editkin 判斷", shortLabel: "自動", description: "依畫面、語音與節奏自動決定", visualPolicy: "content_adaptive", promptHint: "先辨識題材，再依證據選擇節奏與視覺。" },
  { id: "gaming", label: "遊戲／實況", shortLabel: "遊戲", description: "快節奏、強 Hook、反應與關鍵操作", rhythm: "energetic", targetBpm: 132, captionPresetId: "neon_signal", lookPresetId: "toy_arena_punch", effectPresetIds: ["scanline_focus"], transitionPresetId: "prism_flash_cut", visualPolicy: "subject_first", promptHint: "優先保留關鍵操作、失敗反差、勝負轉折與可理解的遊戲狀態。" },
  { id: "food", label: "美食／料理", shortLabel: "美食", description: "食物質感、步驟、反應與成品先行", rhythm: "balanced", targetBpm: 106, captionPresetId: "candy_ticket", lookPresetId: "food_warm_appetite", effectPresetIds: ["high_key_bloom"], transitionPresetId: "lens_blur_cut", visualPolicy: "subject_first", promptHint: "先兌現成品，再呈現材料、關鍵步驟、質地與真實反應。" },
  { id: "travel", label: "旅遊／Vlog", shortLabel: "旅遊", description: "地點、過程、體驗與呼吸感", rhythm: "balanced", targetBpm: 98, captionPresetId: "editorial_serif", lookPresetId: "travel_airy_local", effectPresetIds: ["film_grain_soft"], transitionPresetId: "luma_fade", visualPolicy: "content_adaptive", promptHint: "以抵達、探索、發現、反思建立旅程；保留環境聲與視覺呼吸。" },
  { id: "podcast_on_camera", label: "Podcast／訪談（人物）", shortLabel: "訪談", description: "框主持人與來賓，自動切近景與雙格", rhythm: "calm", targetBpm: 92, captionPresetId: "clean_caption", lookPresetId: "podcast_skin_neutral", effectPresetIds: [], transitionPresetId: "luma_fade", visualPolicy: "speaker_director", promptHint: "保持對話自然，以 active speaker、雙人反應、J/L cut、上下雙格與可操作重點組織畫面。" },
  { id: "podcast_no_face", label: "Podcast／訪談（不露臉）", shortLabel: "不露臉", description: "聲音＋真證據＋B-roll＋圖卡", rhythm: "calm", targetBpm: 88, captionPresetId: "clean_caption", lookPresetId: "clean_neutral", effectPresetIds: [], transitionPresetId: "luma_fade", visualPolicy: "no_face_documentary", promptHint: "禁止人臉替代物；依真來源→同題 B-roll→圖解→字卡→clean hold 降級，證據不得由庫存片冒充。" },
] as const;

export function editorialProfile(id: EditorialProfileId): EditorialProfile {
  return EDITORIAL_PROFILES.find((profile) => profile.id === id) ?? EDITORIAL_PROFILES[0];
}

export function compactEditorialProfile(id: EditorialProfileId) {
  const profile = editorialProfile(id);
  return { id: profile.id, visualPolicy: profile.visualPolicy, promptHint: profile.promptHint, targetBpm: profile.targetBpm };
}

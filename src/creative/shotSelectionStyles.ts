/** Editorial shot preferences. Observations are supplied by a reviewer or an
 * evidence-producing analyzer; this catalog does not claim to see footage. */
export type ShotSelectionStyleId =
  | "realist" | "stylized" | "suspense_horror" | "action_adventure"
  | "romance" | "sci_fi_fantasy" | "character_drama" | "vlog" | "commercial_ad";

export interface ShotSelectionStyle {
  id: ShotSelectionStyleId;
  name: string;
  purpose: string;
  priorities: readonly { signal: string; points: 1 | 2; reason: string }[];
  avoid: readonly string[];
  exception: string;
}

const style = (value: ShotSelectionStyle): ShotSelectionStyle => value;

export const SHOT_SELECTION_STYLES: readonly ShotSelectionStyle[] = Object.freeze([
  style({ id: "realist", name: "寫實", purpose: "讓事件、行為與現場聲保持可信和連續", priorities: [
    { signal: "continuous_action", points: 2, reason: "行為有前後過程" },
    { signal: "unposed_reaction", points: 2, reason: "反應與情境相連" },
    { signal: "location_sound", points: 2, reason: "有可用現場聲" },
    { signal: "natural_light", points: 1, reason: "光線符合現場" },
    { signal: "observer_camera", points: 1, reason: "機位不打斷事件" },
  ], avoid: ["staged_reaction", "unmotivated_camera_move"], exception: "對鏡頭說話的紀實訪談仍可保留；真實對話優先於迴避鏡頭。" }),
  style({ id: "stylized", name: "風格化／藝術化", purpose: "用構圖、色彩與留白承載情緒", priorities: [
    { signal: "designed_composition", points: 2, reason: "構圖有明確視覺重心" },
    { signal: "intentional_color", points: 2, reason: "色彩與情緒一致" },
    { signal: "symbolic_action", points: 2, reason: "動作呼應主題" },
    { signal: "visual_pause", points: 1, reason: "留白提供感受時間" },
    { signal: "controlled_motion", points: 1, reason: "運鏡服務情緒" },
  ], avoid: ["unmotivated_effect", "decorative_only"], exception: "必要的劇情資訊仍須看得懂；漂亮的空鏡不能代替情節證據。" }),
  style({ id: "suspense_horror", name: "懸疑／恐怖", purpose: "藉遮蔽、聲畫落差與揭露時機建立張力", priorities: [
    { signal: "concealment", points: 2, reason: "遮蔽保留未知" },
    { signal: "delayed_reaction", points: 2, reason: "反應延遲有敘事原因" },
    { signal: "sound_tension", points: 2, reason: "環境聲或寂靜帶出預期" },
    { signal: "reveal_handle", points: 1, reason: "有可定位的揭露切點" },
    { signal: "negative_space", points: 1, reason: "空間留給觀眾尋找線索" },
  ], avoid: ["premature_reveal", "unmotivated_scare"], exception: "普通暗畫面不等於恐怖證據；需有角色視線、事件或聲音承接。" }),
  style({ id: "action_adventure", name: "動作／冒險", purpose: "保留動作方向、空間關係與可讀的衝擊", priorities: [
    { signal: "clear_action", points: 2, reason: "肢體動作可辨" },
    { signal: "readable_direction", points: 2, reason: "運動方向可追蹤" },
    { signal: "spatial_context", points: 2, reason: "觀眾知道角色所在位置" },
    { signal: "matching_motion", points: 1, reason: "前後鏡頭有動作接力" },
    { signal: "reaction_timing", points: 1, reason: "反應落在事件節點" },
  ], avoid: ["unreadable_blur", "incoherent_space"], exception: "晃動有角色主觀理由時可用；快速剪接不能犧牲動作因果。" }),
  style({ id: "romance", name: "浪漫／愛情", purpose: "用雙方互動與細小動作傳遞關係變化", priorities: [
    { signal: "reciprocal_glance", points: 2, reason: "雙方視線可接續" },
    { signal: "mutual_reaction", points: 2, reason: "對手反應可互文" },
    { signal: "small_gesture", points: 2, reason: "細小動作有情緒意義" },
    { signal: "soft_light", points: 1, reason: "光線支持親密氛圍" },
    { signal: "proximity_change", points: 1, reason: "距離變化呼應關係" },
  ], avoid: ["one_sided_reaction", "staged_contact"], exception: "單人微笑不能單獨證明雙方關係；須看到對手戲或敘事脈絡。" }),
  style({ id: "sci_fi_fantasy", name: "科幻／奇幻", purpose: "讓世界規則、尺度與人物反應彼此說得通", priorities: [
    { signal: "world_rule_evidence", points: 2, reason: "世界運作有可見線索" },
    { signal: "character_response", points: 2, reason: "人物對異常有具體反應" },
    { signal: "world_scale", points: 2, reason: "景別交代世界尺度" },
    { signal: "motivated_light", points: 1, reason: "光效與場景來源一致" },
    { signal: "spatial_exploration", points: 1, reason: "運鏡揭露新空間" },
  ], avoid: ["generic_glow", "effect_without_world_rule"], exception: "發光特效不能代替世界觀；虛構畫面不得冒充現實證據。" }),
  style({ id: "character_drama", name: "人物強敘事", purpose: "讓鏡頭承接選擇、關係與情緒的變化", priorities: [
    { signal: "decision_moment", points: 2, reason: "人物選擇可見" },
    { signal: "before_after_behavior", points: 2, reason: "行為變化有前後對照" },
    { signal: "relationship_shift", points: 2, reason: "互動推動關係" },
    { signal: "reaction_context", points: 1, reason: "反應有事件前因" },
    { signal: "setting_change", points: 1, reason: "環境回應人物處境" },
  ], avoid: ["isolated_expression", "unearned_emotion"], exception: "單一強烈表情沒有前後脈絡時，不可宣稱角色弧線已建立。" }),
  style({ id: "vlog", name: "Vlog", purpose: "保留創作者第一視角與真實日常的參與感", priorities: [
    { signal: "first_person_interaction", points: 2, reason: "創作者直接帶觀眾參與" },
    { signal: "everyday_action", points: 2, reason: "生活動作可連成過程" },
    { signal: "voice_reaction_sync", points: 2, reason: "說話和反應相互對應" },
    { signal: "natural_imperfection", points: 1, reason: "保留有意義的現場感" },
    { signal: "life_transition", points: 1, reason: "移動帶出日常段落" },
  ], avoid: ["staged_everyday", "inaudible_speech"], exception: "適度晃動可用，無法辨識內容或令人不適的抖動仍須淘汰。" }),
  style({ id: "commercial_ad", name: "商業廣告", purpose: "迅速交代問題、實際使用與可核對的改變", priorities: [
    { signal: "demonstrated_use", points: 2, reason: "產品使用過程清楚" },
    { signal: "problem_solution", points: 2, reason: "問題與解法相連" },
    { signal: "product_visible", points: 2, reason: "觀眾能辨識產品" },
    { signal: "verified_change", points: 1, reason: "前後差異有來源可核對" },
    { signal: "single_cta", points: 1, reason: "行動指令清楚" },
  ], avoid: ["unverified_claim", "logo_only"], exception: "高張力反應不能證明功效；前後對比要有相同條件與素材來源。" }),
]);

export interface ShotCandidateObservation { signal: string; evidenceRef: string }
export interface ShotCandidateForReview {
  id: string;
  sourceRef: string;
  rightsApproved: boolean;
  beatPurposeMatched: boolean;
  observations: readonly ShotCandidateObservation[];
}

/** Returns an ordinal review aid, never an automatic cut or quality certificate. */
export function rankStyleShotCandidates(styleId: ShotSelectionStyleId, candidates: readonly ShotCandidateForReview[]) {
  const selectedStyle = SHOT_SELECTION_STYLES.find((entry) => entry.id === styleId);
  if (!selectedStyle) throw new Error(`未知選鏡風格：${styleId}`);
  if (candidates.length > 128 || new Set(candidates.map((entry) => entry.id)).size !== candidates.length) throw new Error("選鏡候選過多或 ID 重複");
  const rows = candidates.map((candidate) => {
    if (!candidate.id || !candidate.sourceRef || !candidate.rightsApproved || !candidate.beatPurposeMatched) {
      return { id: candidate.id, status: "BLOCKED" as const, points: null, reasons: ["來源、權利或段落用途未通過"] };
    }
    if (!candidate.observations.length || candidate.observations.some((item) => !item.evidenceRef.trim())) {
      return { id: candidate.id, status: "REVIEW_REQUIRED" as const, points: null, reasons: ["缺逐鏡觀察與來源位置"] };
    }
    const observed = new Set(candidate.observations.map((item) => item.signal));
    const matches = selectedStyle.priorities.filter((item) => observed.has(item.signal));
    if (!matches.length) return { id: candidate.id, status: "REVIEW_REQUIRED" as const, points: null, reasons: ["未觀察到此風格的正向線索"] };
    const penalties = selectedStyle.avoid.filter((signal) => observed.has(signal));
    return { id: candidate.id, status: "DRAFT_RANKING_REVIEW_REQUIRED" as const,
      points: Math.max(0, matches.reduce((sum, item) => sum + item.points, 0) - 2 * penalties.length),
      reasons: [...matches.map((item) => item.reason), ...penalties.map((signal) => `反例：${signal}`)] };
  });
  return { styleId, evidenceAuthority: "caller_asserted_unverified" as const, directApplyAllowed: false as const,
    rows: rows.sort((a, b) => (b.points ?? -1) - (a.points ?? -1) || a.id.localeCompare(b.id)) };
}

export function compactShotSelectionStyles() {
  return SHOT_SELECTION_STYLES.map(({ id, name, purpose, priorities, avoid, exception }) => ({
    id, name, purpose, priorities: priorities.map(({ signal, points }) => [signal, points]), avoid, exception,
    executionStatus: "review_aid_only" as const,
  }));
}

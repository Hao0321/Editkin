import { useState } from "react";
import { BULLET_TIME_CAPABILITIES, CINEMATIC_LANGUAGE_RECIPES, type BulletTimeCapability, type CinematicLanguageRecipe } from "../creative/cinematicLanguage";
import { LOOK_PRESETS, TRANSITION_PRESETS } from "../creative/corePack";
import "./cinematicLanguageExplorer.css";

export type CinematicExplorerGroup = "language" | "montage" | "bullet-time";

const RECIPE_DESCRIPTIONS: Record<CinematicLanguageRecipe["id"], string> = {
  spatial_orientation: "先交代空間，再接人物與細節，避免觀眾看不懂位置關係。",
  dialogue_flow: "以乾淨主音軌帶出正反打、反應鏡頭與 J／L Cut 企劃。",
  match_action_carry: "找出相同方向與動作，在動作中點安排接力剪接。",
  reveal_ladder: "從局部線索逐步揭示，最後才交代完整答案或產品。",
  semantic_punch_in: "只在真正的語意重點安排受限推近，並保護字幕安全區。",
  process_progress_result: "依問題、過程、修正與成果建立可追蹤的敘事順序。",
  parallel_ab_montage: "把 A／B 兩條故事線對位交錯，最後回到可比較的結果。",
  rhythmic_crescendo: "鏡頭逐步縮短、保留一次停頓，再把成果落在節拍上。",
  beat_aligned_montage: "依鏡頭顯著度與故事順序選鏡，裁切來源並把剪點對齊 caller 提供的節拍格。",
  multicam_performance: "同步多機位後，依句子、動作與反應安排鏡頭切換。",
  time_sculpt: "先檢查幀率與運動品質，再規劃變速、慢動作或定格。",
};

const REQUIREMENT_LABELS: Record<string, string> = {
  shot_scale_labels: "已辨識遠／中／近景",
  scene_boundaries: "已辨識場景邊界",
  speaker_turns: "已辨識說話者輪替",
  clean_dialogue: "乾淨對話音軌",
  motion_vectors_or_track: "可用的動態追蹤或運動向量",
  shot_handles: "鏡頭前後保留幀",
  detail_and_wide_shots: "同時具備細節與全景鏡頭",
  semantic_timestamps: "已標出語意重點時間",
  source_resolution_headroom: "來源解析度可安全推近",
  semantic_segments: "已完成內容分段",
  two_semantic_groups: "兩組可辨識的 A／B 素材",
  shared_match_feature: "A／B 有可對位的動作或物件",
  enough_distinct_shots: "足夠且不同的鏡頭",
  beat_grid_or_event_peaks: "節拍格或事件高峰",
  shot_evidence: "含顯著度、故事順序與來源範圍的鏡頭證據",
  caller_beat_grid: "caller 提供且待驗證的節拍格",
  two_or_more_synced_cameras: "至少兩個已同步機位",
  frame_rate_metadata: "正確幀率資訊",
  motion_quality_analysis: "動態品質分析",
  subject_matte: "主體遮罩",
  depth_map: "深度圖",
  background_inpaint: "背景補全",
  bounded_camera_arc: "受限的環繞角度",
  camera_poses: "相機姿態",
  intrinsics: "鏡頭內參",
  dynamic_depth_or_3dgs: "動態深度或 3D Gaussian",
  temporal_occlusion_qa: "時序遮擋 QA",
  synchronized_cameras: "同步攝影機",
  intrinsics_extrinsics: "相機內／外參",
  lens_calibration: "鏡頭校正",
  timecode_or_genlock: "Timecode／Genlock",
  volumetric_reconstruction: "體積重建",
};

const BULLET_STATUS_LABELS: Record<BulletTimeCapability["status"], string> = {
  prototype: "原型規劃",
  research: "研究中",
  capture_required: "需專用拍攝",
};

function requirementLabel(requirement: string): string {
  return REQUIREMENT_LABELS[requirement] ?? requirement.replaceAll("_", " ");
}

export function cinematicExplorerItems(group: CinematicExplorerGroup): readonly CinematicLanguageRecipe[] | readonly BulletTimeCapability[] {
  if (group === "bullet-time") return BULLET_TIME_CAPABILITIES;
  if (group === "montage") return CINEMATIC_LANGUAGE_RECIPES.filter((recipe) => recipe.family === "montage");
  return CINEMATIC_LANGUAGE_RECIPES.filter((recipe) => recipe.family !== "montage");
}

function RecipeCard({ recipe }: { recipe: CinematicLanguageRecipe }) {
  const fallback = recipe.fallbackId ? CINEMATIC_LANGUAGE_RECIPES.find((candidate) => candidate.id === recipe.fallbackId) : undefined;
  const compilable = recipe.executionStatus === "evidence_compilable";
  return <article className="cinematic-recipe-card" data-execution-status={recipe.executionStatus} data-compiler-tool={recipe.compilerTool}>
    <header><strong>{recipe.name}</strong><span className={`capability-state ${compilable ? "compilable" : "planning"}`}>{compilable ? "條件通過可編譯" : "僅規劃"}</span></header>
    <p>{RECIPE_DESCRIPTIONS[recipe.id]}</p>
    <div className="evidence-requirements"><b>{compilable ? "編譯前要有素材證據" : "建立企劃前要有素材證據"}</b><ul>{recipe.requirements.map((requirement) => <li key={requirement}>{requirementLabel(requirement)}</li>)}</ul></div>
    <footer>{compilable ? "只產生唯讀 draft command；正式修改仍須走 Video Autopilot v4 audit → apply" : fallback ? `條件不足時改用「${fallback.name}」企劃` : "條件不足就停止，不會自動亂剪"}</footer>
  </article>;
}

function BulletTimeCard({ capability }: { capability: BulletTimeCapability }) {
  return <article className="cinematic-recipe-card bullet-time-card" data-execution-status={capability.executionStatus}>
    <header><strong>{capability.name}</strong><span className="capability-state evidence">{BULLET_STATUS_LABELS[capability.status]}</span></header>
    <p>{capability.honestLabel}</p>
    <div className="evidence-requirements"><b>需要素材／拍攝證據</b><ul>{capability.requirements.map((requirement) => <li key={requirement}>{requirementLabel(requirement)}</li>)}</ul></div>
    <footer>目前只能建立企劃，不會宣稱已生成「{capability.forbiddenClaim}」</footer>
  </article>;
}

export function CinematicLanguageExplorer() {
  const [group, setGroup] = useState<CinematicExplorerGroup>("montage");
  const recipes = cinematicExplorerItems(group);
  const tabs: Array<{ id: CinematicExplorerGroup; label: string; count: number }> = [
    { id: "language", label: "鏡頭語言", count: cinematicExplorerItems("language").length },
    { id: "montage", label: "蒙太奇", count: cinematicExplorerItems("montage").length },
    { id: "bullet-time", label: "子彈時間", count: cinematicExplorerItems("bullet-time").length },
  ];

  return <section className="cinematic-language-explorer" aria-label="鏡頭語言與進階剪法" data-testid="cinematic-language-explorer">
    <header className="cinematic-explorer-heading">
      <div><strong>鏡頭語言與進階剪法</strong><small>先看懂能不能做，再讓 Video Autopilot 建立剪輯企劃</small></div>
      <span>{CINEMATIC_LANGUAGE_RECIPES.length} 套剪法</span>
    </header>
    <div className="execution-state-map" aria-label="能力狀態說明">
      <div className="direct"><b>可直接套用</b><span>{LOOK_PRESETS.length} 款濾鏡、上方 {TRANSITION_PRESETS.length} 款片段入／出場</span></div>
      <div className="planning"><b>僅規劃</b><span>10 套鏡頭語言只建立方案，不冒充已重剪</span></div>
      <div className="compilable"><b>條件通過可編譯</b><span>1 套節拍剪法需素材證據，且只產生 draft command</span></div>
    </div>
    <nav className="cinematic-explorer-tabs" role="tablist" aria-label="進階剪法分類">
      {tabs.map((tab) => <button type="button" role="tab" key={tab.id} aria-selected={group === tab.id} className={group === tab.id ? "active" : ""} onClick={() => setGroup(tab.id)}>{tab.label}<small>{tab.count}</small></button>)}
    </nav>
    <div className="cinematic-recipe-list" role="tabpanel" data-testid={`cinematic-group-${group}`}>
      {group === "bullet-time"
        ? (recipes as readonly BulletTimeCapability[]).map((capability) => <BulletTimeCard key={capability.id} capability={capability} />)
        : (recipes as readonly CinematicLanguageRecipe[]).map((recipe) => <RecipeCard key={recipe.id} recipe={recipe} />)}
    </div>
  </section>;
}

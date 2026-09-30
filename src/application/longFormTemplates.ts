import { applyCommand, type EditorCommand } from "../domain/commands";
import type { EditProject, EditorialProfileId } from "../domain/types";
import { resolveAestheticSystem } from "./editkinAesthetic";
import type { CinematicRecipeId } from "../creative/cinematicLanguage";
import {
  createTemplateApplicationState,
  templateApplicationBase,
  templateApplicationCleanupCommands,
  templateElementOwner,
  type TemplateApplicationIdentity,
} from "./templateLifecycle";

export type LongFormTemplateId = "hao_tutorial" | "product_deep_dive" | "proof_case_study" | "documentary_explainer" | "interview_story" | "narrative_vlog";

export const LONG_FORM_TEMPLATE_FEATURES = ["敘事節奏", "純白字幕規則", "來源優先", "語意提示規劃", "安靜觀看"] as const;

export interface LongFormTemplateDefinition {
  id: LongFormTemplateId;
  name: string;
  category: string;
  description: string;
  bestFor: string;
  profile: EditorialProfileId;
  lookPresetId: string;
  effectPresetIds: string[];
  introTransitionPresetId: "luma_fade";
  accent: string;
  surface: string;
  text: string;
  copy: { title: string; card: string; tag: string; counter: string; caption: string };
  cadence: { introSeconds: number; visualResetSeconds: number; rehookSeconds: number };
  cinematicRecipeId: CinematicRecipeId;
}

export const LONG_FORM_TEMPLATES: readonly LongFormTemplateDefinition[] = [
  { id: "hao_tutorial", name: "Hao 教學長片", category: "教學", description: "0–30 秒兌現承諾，中段放寬，章節重點再拉高能量。", bestFor: "AI 工具、軟體教學", profile: "auto", lookPresetId: "ai_cobalt_crisp", effectPresetIds: ["high_key_bloom"], introTransitionPresetId: "luma_fade", accent: "#FFD23F", surface: "#17132EEF", text: "#FFFFFF", cadence: { introSeconds: 30, visualResetSeconds: 25, rehookSeconds: 75 }, cinematicRecipeId: "process_progress_result", copy: { title: "先看最後做出來的結果", card: "這一章只解決一個問題", tag: "實際操作", counter: "01", caption: "這段字幕維持全白，不變色也不放大" } },
  { id: "product_deep_dive", name: "產品深度評測", category: "評測", description: "先給結論，再用細節、實測和限制逐層證明。", bestFor: "科技、產品、功能評測", profile: "auto", lookPresetId: "clean_neutral", effectPresetIds: ["film_grain_soft"], introTransitionPresetId: "luma_fade", accent: "#65E6FF", surface: "#0D1C26EF", text: "#FFFFFF", cadence: { introSeconds: 25, visualResetSeconds: 30, rehookSeconds: 90 }, cinematicRecipeId: "process_progress_result", copy: { title: "它真的值得買嗎？", card: "實測結果比規格表重要", tag: "深度評測", counter: "TEST 01", caption: "先從最直接的使用體驗開始" } },
  { id: "proof_case_study", name: "證據案例拆解", category: "案例", description: "真實來源優先，圖卡只解釋證據，不替證據造假。", bestFor: "數據成果、專案復盤、案例", profile: "podcast_no_face", lookPresetId: "clean_neutral", effectPresetIds: ["analog_print_soft"], introTransitionPresetId: "luma_fade", accent: "#8BFF58", surface: "#0D2114EF", text: "#FFFFFF", cadence: { introSeconds: 30, visualResetSeconds: 25, rehookSeconds: 75 }, cinematicRecipeId: "reveal_ladder", copy: { title: "這是原始資料，不是示意圖", card: "來源、時間與結果都能核對", tag: "真實證據", counter: "PROOF 01", caption: "先把原始證據放到畫面上" } },
  { id: "documentary_explainer", name: "紀錄式解說", category: "紀錄", description: "用真來源、環境聲和克制資訊圖形累積可信度。", bestFor: "調查、知識、歷史與事件", profile: "podcast_no_face", lookPresetId: "cinematic_warm_soft", effectPresetIds: ["film_grain_soft"], introTransitionPresetId: "luma_fade", accent: "#FFB45A", surface: "#24180DEF", text: "#FFFFFF", cadence: { introSeconds: 30, visualResetSeconds: 35, rehookSeconds: 90 }, cinematicRecipeId: "spatial_orientation", copy: { title: "事情是從這一刻開始的", card: "先把時間線還原清楚", tag: "現場紀錄", counter: "CH. 01", caption: "這裡先保留完整的前因後果" } },
  { id: "interview_story", name: "深度訪談", category: "訪談", description: "讓人物和故事主導，字卡只在身分與核心觀點出現。", bestFor: "Podcast、人物、對談", profile: "podcast_on_camera", lookPresetId: "podcast_skin_neutral", effectPresetIds: ["film_grain_soft"], introTransitionPresetId: "luma_fade", accent: "#A985FF", surface: "#171126EF", text: "#FFFFFF", cadence: { introSeconds: 35, visualResetSeconds: 40, rehookSeconds: 105 }, cinematicRecipeId: "dialogue_flow", copy: { title: "這個決定改變了他的人生", card: "先聽完他為什麼這樣選", tag: "人物訪談", counter: "QUOTE", caption: "保留停頓，讓觀眾聽懂這句話" } },
  { id: "narrative_vlog", name: "敘事 Vlog", category: "故事", description: "以地點、行動、反思組成節奏波，不把長片剪成 Shorts。", bestFor: "旅遊、幕後、創作紀錄", profile: "travel", lookPresetId: "travel_airy_local", effectPresetIds: ["film_grain_soft"], introTransitionPresetId: "luma_fade", accent: "#6FE0C1", surface: "#10231FEF", text: "#FFFFFF", cadence: { introSeconds: 30, visualResetSeconds: 35, rehookSeconds: 100 }, cinematicRecipeId: "spatial_orientation", copy: { title: "這趟路跟我想的不一樣", card: "故事真正的轉折在後面", tag: "TAIPEI · DAY 01", counter: "01", caption: "先跟著畫面走，不急著把話說滿" } },
] as const;

export const LONG_FORM_WHITE_CAPTION_STYLE = {
  presetId: "hao_longform_white",
  fontFamily: "Microsoft JhengHei",
  fontSize: 82,
  color: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 16,
  alignment: 2 as const,
  marginV: 72,
  bold: true,
  italic: false,
  shadow: 0,
  backgroundColor: "#000000B3",
  letterSpacing: 0,
  translationFontFamily: "Microsoft JhengHei",
  translationFontSize: 54,
  translationColor: "#FFFFFF",
  translationBold: true,
  translationItalic: false,
};

export function buildLongFormTemplateCommand(project: EditProject, templateId: string, idFactory: (prefix: string) => string): EditorCommand {
  const template = LONG_FORM_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error(`未知長片模板：${templateId}`);
  const baseProject = templateApplicationBase(project);
  const visualTracks = baseProject.tracks.filter((track) => track.kind === "video");
  const visualClips = visualTracks.flatMap((track) => track.clips).sort((a, b) => a.timelineStart - b.timelineStart);
  if (!visualClips.length) throw new Error("請先加入至少一段影片或圖片，再套用長片模板。");
  const identity: TemplateApplicationIdentity = {
    sessionId: idFactory("template-session"), templateId: template.id, templateName: template.name,
    format: "long", createdAt: new Date().toISOString(),
  };
  const first = visualClips[0];
  const projectEnd = Math.max(...visualClips.map((clip) => clip.timelineStart + clip.duration));
  const configurationCommands: EditorCommand[] = [
    { type: "set_editorial_profile", profile: template.profile },
    { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(template.profile, "longform", baseProject.aestheticSystem?.reviewPolicy) },
    { type: "set_caption_style", patch: LONG_FORM_WHITE_CAPTION_STYLE },
  ];
  const appliedProject = applyCommand(baseProject, { type: "batch", commands: configurationCommands });
  const commands: EditorCommand[] = [
    ...templateApplicationCleanupCommands(project),
    ...configurationCommands,
  ];
  const markerSpecs = [
    { at: first.timelineStart, title: `長片模板 · ${template.name}`, note: `${LONG_FORM_TEMPLATE_FEATURES.join("／")}；保留原片尺寸、剪點、調色與聲音；不插入示範文案、底板或固定圖卡。依已觀察的畫面與旁白，用短文字／焦點線條做少量提示，提示後回到乾淨畫面。逐句字幕固定純白。鏡頭路由 ${template.cinematicRecipeId} 必須由 Video Autopilot 素材證據 gate 通過後再編譯。` },
    { at: Math.min(projectEnd, first.timelineStart + template.cadence.introSeconds), title: "開場承諾檢查", note: "封面與標題承諾應在此之前以真畫面兌現。" },
    { at: Math.min(projectEnd, first.timelineStart + template.cadence.rehookSeconds), title: "Re-hook／節奏換氣", note: `一般視覺重置約 ${template.cadence.visualResetSeconds} 秒；依內容呼吸，不固定快切。` },
  ];
  markerSpecs.forEach((marker, index) => commands.push({ type: "add_director_marker", marker: { id: idFactory(`long-template-marker-${index}`), time: marker.at, title: marker.title, note: marker.note, kind: "beat", status: "open", createdAt: identity.createdAt, templateOwner: templateElementOwner(identity, `pace_marker_${index + 1}`) } }));
  commands.push({ type: "set_template_application", application: createTemplateApplicationState(baseProject, appliedProject, identity, visualClips.map((clip) => clip.id)) });
  return { type: "batch", commands };
}

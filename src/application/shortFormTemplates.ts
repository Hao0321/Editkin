import { captionStyleFromPreset } from "../creative/corePack";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { applyCommand, type EditorCommand } from "../domain/commands";
import type { EditProject, EditorialProfileId, MotionGraphic, MotionGraphicKind } from "../domain/types";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { buildNativeReelSceneCommands } from "./nativeReelSceneCommands";
import type { FloatingFrameSceneBindings } from "../motion/floatingFrameScenes";
import { validateMotionSceneStyle } from "../domain/motionSceneStyle";
import type { CinematicRecipeId } from "../creative/cinematicLanguage";
import {
  createTemplateApplicationState,
  templateApplicationBase,
  templateApplicationCleanupCommands,
  templateElementOwner,
  type TemplateApplicationIdentity,
} from "./templateLifecycle";

export type ShortFormTemplateId =
  | "clean_tutorial"
  | "bold_hook"
  | "product_showcase"
  | "podcast_clip"
  | "before_after"
  | "fast_list"
  | "mini_vlog"
  | "beat_montage"
  | "ugc_review"
  | "documentary_proof"
  | "spatial_gallery"
  | "editorial_steps";

export const SHORT_FORM_TEMPLATE_FEATURES = ["標題", "文字配色", "字幕", "字卡", "動態圖", "標籤", "特效", "轉場", "調色"] as const;

export interface ShortFormTemplateContent {
  title: string;
  body?: string;
  accentColor?: string;
  surfaceColor?: string;
  textColor?: string;
  headingFont?: string;
  bodyFont?: string;
  motionSpeed?: number;
  progress?: { steps: number; activeStep: number };
  sources?: FloatingFrameSceneBindings;
}

interface TemplatePalette {
  title: string;
  text: string;
  accent: string;
  surface: string;
  caption: string;
  captionBackground: string;
}

interface TemplateCopy {
  title: string;
  card: string;
  tag: string;
  counter: string;
  caption: string;
}

export interface ShortFormTemplateDefinition {
  id: ShortFormTemplateId;
  name: string;
  category: string;
  description: string;
  bestFor: string;
  profile: EditorialProfileId;
  lookPresetId: string;
  effectPresetIds: string[];
  transitionPresetId: string;
  captionPresetId: string;
  palette: TemplatePalette;
  copy: TemplateCopy;
  rhythm: "calm" | "balanced" | "energetic";
  /** Autopilot recommendations are evidence-gated; the visual template alone never invents recuts. */
  motionGraphicPresetId?: "reel_spatial_headline" | "reel_editorial_step";
  motionClipPresetId?: "gallery_drift" | "chapter_snap";
  floatingFrameScenePresetId?: "portrait_stack";
  /** Video Autopilot must satisfy the recipe evidence gate before it may recut shots. */
  cinematicRecipeId: CinematicRecipeId;
}

const cyan = { title: "#FFFFFF", text: "#07111F", accent: "#49DDF2", surface: "#F4FBFFEE", caption: "#FFFFFF", captionBackground: "#07111FCC" };
const yellow = { title: "#FFF6D6", text: "#161104", accent: "#FFD22E", surface: "#FFF7D6F2", caption: "#FFF6D6", captionBackground: "#120E02DD" };
const lime = { title: "#FFFFFF", text: "#07110A", accent: "#8BFF58", surface: "#F6FFF2F2", caption: "#FFFFFF", captionBackground: "#07110ADD" };
const pink = { title: "#FFFFFF", text: "#1B0712", accent: "#FF4FA3", surface: "#FFF4FAF2", caption: "#FFFFFF", captionBackground: "#1B0712DD" };
const amber = { title: "#FFF9ED", text: "#1F1305", accent: "#FFAE35", surface: "#FFF8ECF2", caption: "#FFF9ED", captionBackground: "#1F1305DD" };
const violet = { title: "#FFFFFF", text: "#120B24", accent: "#A985FF", surface: "#F7F3FFF2", caption: "#FFFFFF", captionBackground: "#120B24DD" };
const spatial = { title: "#F7F5F0", text: "#F7F5F0", accent: "#C0E7D9", surface: "#111923DD", caption: "#FFFFFF", captionBackground: "#111923CC" };
const editorial = { title: "#24211E", text: "#24211E", accent: "#BF6848", surface: "#FBF6EDE8", caption: "#24211E", captionBackground: "#FBF6EDE8" };

export const SHORT_FORM_TEMPLATES: readonly ShortFormTemplateDefinition[] = [
  { id: "clean_tutorial", name: "一步一操作", category: "教學", description: "一個畫面只講一個操作，步驟標籤跟著重點走。", bestFor: "AI 工具、軟體教學", profile: "auto", lookPresetId: "clean_neutral", effectPresetIds: ["high_key_bloom"], transitionPresetId: "exp26_clean_hold_cut", captionPresetId: "exp26_system_title", palette: cyan, rhythm: "balanced", cinematicRecipeId: "process_progress_result", copy: { title: "3 步完成這個操作", card: "現在只做這一步", tag: "步驟教學", counter: "01", caption: "先選取要處理的素材" } },
  { id: "bold_hook", name: "首秒大 Hook", category: "流量", description: "首秒主標最大，警示標籤和高能轉場快速兌現承諾。", bestFor: "觀點、挑戰、揭秘", profile: "gaming", lookPresetId: "ai_cobalt_crisp", effectPresetIds: ["scanline_focus"], transitionPresetId: "chromatic_whip_cut", captionPresetId: "hero_white", palette: yellow, rhythm: "energetic", cinematicRecipeId: "semantic_punch_in", copy: { title: "你可能一直都做錯了", card: "真正關鍵在這裡", tag: "先別滑走", counter: "3 秒", caption: "我直接把結果給你看" } },
  { id: "product_showcase", name: "產品展示", category: "商品", description: "乾淨特寫、賣點標籤與輕量推近，資訊完整但不堆效果。", bestFor: "開箱、商品、功能示範", profile: "auto", lookPresetId: "vlog_bright_clean", effectPresetIds: ["high_key_bloom"], transitionPresetId: "exp26_depth_push", captionPresetId: "exp26_feature_pill", palette: lime, rhythm: "balanced", cinematicRecipeId: "reveal_ladder", copy: { title: "一眼看懂它值不值得", card: "核心功能：更快完成工作", tag: "實測重點", counter: "01", caption: "先看最常用的這個功能" } },
  { id: "podcast_clip", name: "訪談精華", category: "Podcast", description: "先保留上下文，再用引言字卡鎖定真正值得分享的一句。", bestFor: "Podcast、訪談切片", profile: "podcast_on_camera", lookPresetId: "podcast_skin_neutral", effectPresetIds: ["film_grain_soft"], transitionPresetId: "luma_fade", captionPresetId: "exp26_quote_human", palette: amber, rhythm: "calm", cinematicRecipeId: "dialogue_flow", copy: { title: "這句話我記了很久", card: "真正的問題不是能力，是選擇", tag: "本集精華", counter: "精華", caption: "先把前因後果說清楚" } },
  { id: "before_after", name: "前後對比", category: "對比", description: "先給改造結果，再回到之前；分割字卡讓差異一眼可懂。", bestFor: "修圖、改造、成果展示", profile: "auto", lookPresetId: "cinematic_warm_soft", effectPresetIds: ["mono_halftone"], transitionPresetId: "exp26_marker_wipe", captionPresetId: "exp26_versus_split", palette: pink, rhythm: "balanced", cinematicRecipeId: "parallel_ab_montage", copy: { title: "改造前 → 改造後", card: "同一份素材，差別在這裡", tag: "實測對比", counter: "VS", caption: "左邊是原版，右邊是優化後" } },
  { id: "fast_list", name: "清單連發", category: "知識", description: "編號、標籤和重點卡建立節奏，不靠毫無理由的亂切。", bestFor: "工具清單、重點整理", profile: "auto", lookPresetId: "clean_neutral", effectPresetIds: ["scanline_focus"], transitionPresetId: "exp26_data_shutter", captionPresetId: "exp26_signal_number", palette: cyan, rhythm: "energetic", cinematicRecipeId: "rhythmic_crescendo", copy: { title: "今天只講 3 個重點", card: "每一點都能立刻使用", tag: "重點清單", counter: "01/03", caption: "第一個，先把目的講清楚" } },
  { id: "mini_vlog", name: "迷你 Vlog", category: "生活", description: "地點眉題、生活字幕與柔和調色，保留環境和人的呼吸感。", bestFor: "日常、旅行、幕後", profile: "travel", lookPresetId: "travel_airy_local", effectPresetIds: ["film_grain_soft"], transitionPresetId: "exp26_editorial_page", captionPresetId: "exp26_location_postcard", palette: amber, rhythm: "calm", cinematicRecipeId: "spatial_orientation", copy: { title: "跟我過完今天", card: "一個普通但很喜歡的瞬間", tag: "TAIPEI · 08:30", counter: "DAY 01", caption: "今天從這個地方開始" } },
  { id: "beat_montage", name: "節拍蒙太奇視覺包", category: "節奏", description: "先套用高能視覺包；真正快切與對拍必須由素材分析、beat grid 與鏡頭證據通過後再編譯。", bestFor: "活動、運動、作品集", profile: "gaming", lookPresetId: "night_neon_controlled", effectPresetIds: ["scanline_focus"], transitionPresetId: "prism_flash_cut", captionPresetId: "neon_signal", palette: violet, rhythm: "energetic", cinematicRecipeId: "beat_aligned_montage", copy: { title: "READY FOR THE DROP", card: "分析鏡頭後再決定切點", tag: "BEAT PLAN", counter: "04", caption: "重點落在下一個節拍" } },
  { id: "ugc_review", name: "真實心得", category: "UGC", description: "像朋友推薦的口吻，用證據章和功能標籤取代硬廣告。", bestFor: "心得、推薦、使用紀錄", profile: "auto", lookPresetId: "vlog_bright_clean", effectPresetIds: ["high_key_bloom"], transitionPresetId: "exp26_shape_swap", captionPresetId: "exp26_soft_subtitle", palette: pink, rhythm: "balanced", cinematicRecipeId: "process_progress_result", copy: { title: "用了 7 天後，我的真實感受", card: "優點很明確，但也不是人人適合", tag: "非業配實測", counter: "7 DAYS", caption: "先說我最喜歡的地方" } },
  { id: "documentary_proof", name: "證據敘事", category: "紀錄", description: "真來源、證據章與克制調色，適合不露臉的資訊型短片。", bestFor: "案例、調查、幕後證據", profile: "podcast_no_face", lookPresetId: "clean_neutral", effectPresetIds: ["analog_print_soft"], transitionPresetId: "exp26_paper_pull", captionPresetId: "exp26_proof_stamp", palette: lime, rhythm: "calm", cinematicRecipeId: "reveal_ladder", copy: { title: "這不是猜測，這是原始紀錄", card: "來源與時間都能核對", tag: "已查證", counter: "FILE 01", caption: "先看當時留下的第一份資料" } },
  { id: "spatial_gallery", name: "空間浮窗展廊", category: "空間", description: "先套用空間動態字與暗調視覺包；在 Motion 中可接續套用柔邊錯層浮窗。", bestFor: "作品集、人物敘事、產品導覽", profile: "auto", lookPresetId: "night_neon_controlled", effectPresetIds: ["film_grain_soft"], transitionPresetId: "exp26_depth_push", captionPresetId: "exp26_soft_subtitle", palette: spatial, rhythm: "balanced", cinematicRecipeId: "spatial_orientation", motionGraphicPresetId: "reel_spatial_headline", motionClipPresetId: "gallery_drift", floatingFrameScenePresetId: "portrait_stack", copy: { title: "讓畫面走進空間", card: "把自己的影片放進浮窗", tag: "空間敘事", counter: "01/03", caption: "每個畫面帶向下一個重點" } },
  { id: "editorial_steps", name: "章節資訊動態", category: "資訊", description: "暖白與銅色對比、逐字章節標題和清楚的步驟卡。", bestFor: "教學、流程、觀點解說", profile: "auto", lookPresetId: "clean_neutral", effectPresetIds: ["analog_print_soft"], transitionPresetId: "exp26_editorial_page", captionPresetId: "exp26_soft_subtitle", palette: editorial, rhythm: "balanced", cinematicRecipeId: "process_progress_result", motionGraphicPresetId: "reel_editorial_step", motionClipPresetId: "chapter_snap", copy: { title: "把流程講得更清楚", card: "此處放入你的步驟示意", tag: "STEP 01", counter: "01", caption: "一個畫面講清一件事" } },
] as const;

function boundedDuration(start: number, requested: number, clipEnd: number, fps: number): number {
  return Math.max(1 / fps, Math.min(requested, Math.max(1 / fps, clipEnd - start)));
}

function graphicSeed(template: ShortFormTemplateDefinition, kind: MotionGraphicKind): Partial<MotionGraphic> {
  const { palette } = template;
  if (kind === "title" && template.motionGraphicPresetId) return { ...findMotionGraphicPreset(template.motionGraphicPresetId).seed };
  if (template.id === "editorial_steps") {
    const identity = { presetId: `editkin.template/short/${template.id}/${kind}` };
    if (kind === "counter") return { ...identity, x: .65, y: .26, width: .28, fontSize: 128, textColor: palette.accent, backgroundColor: "#00000000", accentColor: palette.accent, animation: "pop" };
    if (kind === "tag") return { ...identity, x: .08, y: .06, width: .32, fontSize: 29, textColor: palette.accent, backgroundColor: "#00000000", accentColor: palette.accent, animation: "slide_up" };
  }
  const identity = { presetId: `editkin.template/short/${template.id}/${kind}` };
  if (kind === "title") return { ...identity, x: 0.08, y: 0.1, width: 0.62, fontSize: 68, textColor: palette.title, backgroundColor: "#05080BCC", accentColor: palette.accent, animation: template.rhythm === "energetic" ? "pop" : "slide_up" };
  if (kind === "card") return { ...identity, x: 0.08, y: 0.68, width: 0.78, fontSize: 42, textColor: palette.text, backgroundColor: palette.surface, accentColor: palette.accent, animation: "slide_up" };
  if (kind === "tag") return { ...identity, x: 0.08, y: 0.28, width: 0.3, fontSize: 32, textColor: palette.text, backgroundColor: palette.accent, accentColor: palette.title, animation: "spring_soft" };
  return { ...identity, x: 0.76, y: 0.1, width: 0.16, fontSize: 60, textColor: palette.title, backgroundColor: palette.accent, accentColor: palette.surface, animation: "pop" };
}

function addTemplateGraphics(commands: EditorCommand[], template: ShortFormTemplateDefinition, identity: TemplateApplicationIdentity, firstStart: number, firstEnd: number, fps: number, idFactory: (prefix: string) => string): void {
  const specs: Array<{ kind: MotionGraphicKind; text: string; offset: number; duration: number }> = [
    { kind: "title", text: template.copy.title, offset: 0, duration: 2.8 },
    { kind: "tag", text: template.copy.tag, offset: 0.18, duration: 3.8 },
    { kind: "counter", text: template.copy.counter, offset: 0.72, duration: 2.4 },
    { kind: "card", text: template.copy.card, offset: 2.25, duration: 3.4 },
  ];
  for (const spec of specs) {
    if (!spec.text.trim()) continue;
    const start = Math.min(firstEnd - 1 / fps, firstStart + spec.offset);
    const graphic = createMotionGraphic(idFactory(`template-${spec.kind}`), spec.kind, spec.text, start, boundedDuration(start, spec.duration, firstEnd, fps));
    commands.push({ type: "add_motion_graphic", graphic: { ...graphic, ...graphicSeed(template, spec.kind), templateOwner: templateElementOwner(identity, spec.kind) } });
  }
}

export function buildShortFormTemplateCommand(project: EditProject, templateId: string, idFactory: (prefix: string) => string, content?: ShortFormTemplateContent): EditorCommand {
  const definition = SHORT_FORM_TEMPLATES.find((item) => item.id === templateId);
  if (!definition) throw new Error(`未知短影音模板：${templateId}`);
  if (content && (!content.title.trim() || content.title.length > 48 || (content.body?.length ?? 0) > 64
    || [content.accentColor, content.surfaceColor, content.textColor].some(color => color !== undefined && !/^#[\da-f]{6}$/i.test(color))
    || (content.motionSpeed !== undefined && (!Number.isFinite(content.motionSpeed) || content.motionSpeed < .5 || content.motionSpeed > 2)))) throw new Error("請填寫短標題、重點、有效顏色與 0.5–2 倍動畫速度");
  const template = content ? { ...definition, palette: { ...definition.palette, ...(content.accentColor ? { accent: content.accentColor } : {}), ...(content.surfaceColor ? { surface: content.surfaceColor } : {}) },
    copy: { ...definition.copy, title: content.title.trim(), card: content.body?.trim() ?? "", tag: "", counter: "", caption: "" } } : definition;
  const style = content ? validateMotionSceneStyle({ palette: { surface: (content.surfaceColor ?? "#F8F3EA").slice(0, 7), text: content.textColor ?? (template.id === "spatial_gallery" ? "#F7F5F0" : "#24211E"), accent: (content.accentColor ?? template.palette.accent).slice(0, 7), muted: "#766E63", separator: "#E4D8C7" },
    typography: { headingFamily: content.headingFont ?? "Noto Sans TC", bodyFamily: content.bodyFont ?? "Noto Sans TC" }, animationSpeed: content.motionSpeed ?? 1 }) : undefined;
  const baseProject = templateApplicationBase(project);
  const visualTracks = baseProject.tracks.filter((track) => track.kind === "video");
  const visualClips = visualTracks.flatMap((track) => track.clips).sort((left, right) => left.timelineStart - right.timelineStart);
  if (!visualClips.length) throw new Error("請先加入至少一段影片或圖片，再套用模板。");
  const identity: TemplateApplicationIdentity = {
    sessionId: idFactory("template-session"), templateId: template.id, templateName: template.name,
    format: "short", createdAt: new Date().toISOString(),
  };
  const captionStyle = captionStyleFromPreset(template.captionPresetId);
  const configurationCommands: EditorCommand[] = [
    { type: "set_editorial_profile", profile: template.profile },
    { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(template.profile, "shorts", baseProject.aestheticSystem?.reviewPolicy) },
    { type: "set_caption_style", patch: { ...captionStyle, color: template.palette.caption, backgroundColor: template.palette.captionBackground, outlineColor: "#05080B", translationColor: template.palette.caption } },
  ];
  for (const clip of visualClips) {
    configurationCommands.push({ type: "set_clip_creative", clipId: clip.id, patch: { lookPresetId: template.lookPresetId, effectPresetIds: [...template.effectPresetIds] } });
  }
  const first = visualClips[0];
  const tolerance = 0.5 / project.fps;
  for (const track of visualTracks) {
    const clips = [...track.clips].sort((left, right) => left.timelineStart - right.timelineStart);
    for (let index = 0; index < clips.length - 1; index += 1) {
      const current = clips[index];
      const next = clips[index + 1];
      if (Math.abs(current.timelineStart + current.duration - next.timelineStart) > tolerance) continue;
      const transition = { presetId: template.transitionPresetId, duration: Math.min(0.35, current.duration, next.duration) };
      configurationCommands.push(
        { type: "set_clip_creative", clipId: current.id, patch: { transitionOut: transition } },
        { type: "set_clip_creative", clipId: next.id, patch: { transitionIn: transition } },
      );
    }
  }
  const appliedProject = applyCommand(baseProject, { type: "batch", commands: configurationCommands });
  const commands: EditorCommand[] = [
    ...templateApplicationCleanupCommands(project),
    ...configurationCommands,
  ];
  const firstEnd = first.timelineStart + first.duration;
  if (!content && !baseProject.captions.length) {
    const captionStart = Math.min(firstEnd - 1 / baseProject.fps, first.timelineStart + 0.45);
    commands.push({ type: "add_caption", caption: { id: idFactory("template-caption"), text: template.copy.caption, start: captionStart, duration: boundedDuration(captionStart, 2.4, firstEnd, baseProject.fps), templateOwner: templateElementOwner(identity, "demo_caption") } });
  }
  const nativeScene = first.duration * baseProject.fps >= 30
    && ((template.id === "editorial_steps" && (baseProject.height > baseProject.width || content)) || (template.id === "spatial_gallery" && content));
  if (nativeScene) {
    const spatial = template.id === "spatial_gallery";
    const scene = buildNativeReelSceneCommands(appliedProject, { templateId: spatial ? "spatial_gallery" : "editorial_steps",
      startFrame: Math.round(first.timelineStart * baseProject.fps), durationFrames: spatial || baseProject.width >= baseProject.height ? Math.round(first.duration * baseProject.fps) : Math.min(Math.round(first.duration * baseProject.fps), Math.round(3.8 * baseProject.fps)),
      title: template.copy.title, body: content ? content.body : "每個畫面，一個重點。文字可在 Motion 中修改。", progress: content?.progress ?? { steps: 6, activeStep: 1 },
      ...(spatial ? { clipId: first.id, sources: content?.sources } : {}), evidenceRefs: [content ? "ui:user-authored-template-copy" : "template:editable-demo-copy-replace-before-autopilot"], style }, idFactory);
    for (const command of scene.commands) {
      if (command.type !== "add_motion_graphic") { commands.push(command); continue; }
      const graphic = structuredClone(command.graphic);
      commands.push({ ...command, graphic: { ...graphic, templateOwner: templateElementOwner(identity, graphic.vectorV2 ? "native_shape" : graphic.kind) } });
    }
  } else addTemplateGraphics(commands, template, identity, first.timelineStart, firstEnd, baseProject.fps, idFactory);
  commands.push({ type: "add_director_marker", marker: {
    id: idFactory("template-receipt"), time: first.timelineStart, title: `短影音模板 · ${template.name}`,
    note: `${SHORT_FORM_TEMPLATE_FEATURES.join("／")}皆為可編輯原生元素；${template.bestFor}。鏡頭路由 ${template.cinematicRecipeId} 必須先通過素材證據 gate。${template.motionClipPresetId ? `建議逐格 Motion ${template.motionClipPresetId}；` : ""}${template.floatingFrameScenePresetId ? `可用原生浮窗場景 ${template.floatingFrameScenePresetId}；` : ""}本次模板不會冒充已完成重剪。未複製第三方品牌資產。`, kind: "beat", status: "open", createdAt: identity.createdAt,
    templateOwner: templateElementOwner(identity, "template_receipt"),
  } });
  // Snapshot settings/clip geometry before attaching explicitly owned overlays;
  // those overlays require the final application receipt in the same transaction.
  const snapshotCommands = commands.filter(command => !["add_motion_graphic", "add_caption", "add_director_marker", "clear_template_application"].includes(command.type));
  const actualApplied = applyCommand(baseProject, { type: "batch", commands: snapshotCommands });
  const application = createTemplateApplicationState(baseProject, actualApplied, identity, visualClips.map((clip) => clip.id));
  const priorIds = new Set(baseProject.tracks.flatMap(track => track.clips.map(clip => clip.id)));
  application.generatedClips = actualApplied.tracks.flatMap(track => track.clips.filter(clip => !priorIds.has(clip.id)).map(clip => ({ clipId: clip.id, trackId: track.id })));
  commands.push({ type: "set_template_application", application });
  return { type: "batch", commands };
}

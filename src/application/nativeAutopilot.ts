import { captionStyleFromPreset } from "../creative/corePack";
import { SHORTS_CAPTION_REFERENCE, cjkSafeCaptionStyle, isGeneratedDefaultCaptionStyle, isVerticalCanvas, shortsCaptionStyle } from "../creative/shortsCaptionStyle";
import { resolveAestheticSystem } from "./editkinAesthetic";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { alignTime, projectDuration } from "../domain/editGraph";
import { conservativePolicy, validatePolicy, type NativeEditingPolicy } from "./nativeAutopilotPolicy";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type CaptionStyle, type DirectorMarker, type EditProject, type EditorialProfileId, type MediaAsset, type TimelineClip } from "../domain/types";
import type { AutomaticCaptionDesktopResult, MotionTrackDesktopResult } from "../desktop/types";
import { buildSemanticAutoEditCommand } from "./semanticAutoEditCommands";
import { NARRATION_PAUSE_TRIM, type SemanticAutoEditPlan, type SemanticCue, type SemanticCut } from "./semanticAutoEdit";
import { editorialProfile, type EditingRhythm } from "./editorialProfiles";
export type { EditingRhythm } from "./editorialProfiles";

export interface RhythmProfile {
  mode: EditingRhythm;
  targetBpm: number;
  speechCharsPerSecond: number;
  visualCutsPerMinute: number;
  emphasisRate: number;
  reasons: string[];
}

export interface NativeAutopilotCreativePlan {
  policy: NativeEditingPolicy;
  engine: "editkin-native-director-0.2";
  rhythm: RhythmProfile;
  captionPresetId: string;
  lookPresetId: string;
  effectPresetIds: string[];
  transitionPresetId: string;
  decisions: Array<{ family: string; selection: string; reason: string }>;
  tracking: { requested: boolean; initialRect: { x: number; y: number; width: number; height: number }; reason: string };
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

export function analyzeEditingRhythm(input: { duration: number; cues: readonly SemanticCue[]; cuts?: readonly SemanticCut[] }): RhythmProfile {
  const duration = Math.max(0.1, input.duration);
  const characters = input.cues.reduce((sum, cue) => sum + cue.text.replace(/\s/g, "").length, 0);
  const emphasis = input.cues.filter((cue) => /[!?！？]|重點|一定|關鍵|why|must|important/i.test(cue.text)).length;
  const speechCharsPerSecond = characters / duration;
  const visualCutsPerMinute = (input.cuts?.length ?? 0) * 60 / duration;
  const emphasisRate = emphasis / Math.max(1, input.cues.length);
  const energy = speechCharsPerSecond / 6 + visualCutsPerMinute / 18 + emphasisRate;
  const mode: EditingRhythm = energy >= 2.05 ? "energetic" : energy <= 0.95 ? "calm" : "balanced";
  const reasons = [
    `語速 ${round(speechCharsPerSecond, 2)} 字/秒`,
    `畫面切換 ${round(visualCutsPerMinute, 1)} 次/分`,
    `強調句 ${Math.round(emphasisRate * 100)}%`,
  ];
  return { mode, targetBpm: mode === "energetic" ? 124 : mode === "calm" ? 88 : 106, speechCharsPerSecond: round(speechCharsPerSecond), visualCutsPerMinute: round(visualCutsPerMinute), emphasisRate: round(emphasisRate), reasons };
}

export function planNativeAutopilotCreative(input: { duration: number; width: number; height: number; cues: readonly SemanticCue[]; cuts?: readonly SemanticCut[]; video: boolean; profile?: EditorialProfileId; policy?: NativeEditingPolicy }): NativeAutopilotCreativePlan {
  const policy = validatePolicy(input.policy ?? conservativePolicy);
  const detectedRhythm = analyzeEditingRhythm(input);
  const profile = editorialProfile(input.profile ?? "auto");
  const rhythm = profile.rhythm ? { ...detectedRhythm, mode: profile.rhythm, targetBpm: profile.targetBpm ?? detectedRhythm.targetBpm, reasons: [...detectedRhythm.reasons, `使用者片型：${profile.label}`] } : detectedRhythm;
  const energetic = rhythm.mode === "energetic";
  const calm = rhythm.mode === "calm";
  const captionPresetId = profile.captionPresetId ?? (energetic ? "cobalt_system" : calm ? "editorial_serif" : "clean_caption");
  const lookPresetId = profile.lookPresetId ?? (energetic ? "ai_cobalt_crisp" : calm ? "cinematic_warm_soft" : "vlog_bright_clean");
  const effectPresetIds = profile.effectPresetIds ?? (energetic ? ["scanline_focus"] : calm ? ["film_grain_soft"] : ["high_key_bloom"]);
  const transitionPresetId = profile.transitionPresetId ?? (energetic ? "chromatic_whip_cut" : calm ? "luma_fade" : "lens_blur_cut");
  const portrait = input.height > input.width;
  const initialRect = portrait
    ? { x: 0.18, y: 0.12, width: 0.64, height: 0.72 }
    : { x: 0.34, y: 0.12, width: 0.32, height: 0.68 };
  const rhythmReason = `${rhythm.mode}：${rhythm.reasons.join("、")}`;
  return {
    policy,
    engine: "editkin-native-director-0.2",
    rhythm,
    captionPresetId,
    lookPresetId,
    effectPresetIds,
    transitionPresetId,
    decisions: [
      { family: "format", selection: policy.format, reason: "使用者本次明確選擇；未指定則 unknown，不從比例推測" },
      { family: "styleOwnership", selection: policy.ownership, reason: "automatic 使用片型字幕規則及直接切換；manual 保留原字幕與仍存在的原邊界轉場" },
      { family: "editorialProfile", selection: profile.id, reason: `${profile.label} · ${profile.promptHint}` },
      { family: "rhythm", selection: rhythm.mode, reason: rhythmReason },
      { family: "caption", selection: policy.ownership === "manual" || policy.format === "unknown" ? "preserved-custom" : policy.format === "longform" ? "longform-monochrome" : captionPresetId, reason: "依明確片型與樣式處理選擇；未知片型保留原樣式" },
      { family: "look", selection: "preserved-source", reason: `候選 ${lookPresetId} 尚需 AI 判讀曝光與題材，不因語速自動套用` },
      { family: "effect", selection: "preserved-source", reason: `候選 ${effectPresetIds.join(",")} 尚缺畫面語意證據，不自動新增 VFX` },
      { family: "transition", selection: policy.ownership === "manual" ? "preserved-original-edges" : "clean-cut", reason: "不以語速或節拍自動製造轉場；保留模式只保留未剪掉的原邊界" },
      { family: "motionGraphic", selection: "blocked-pending-art-review", reason: "使用者已拒絕自動圖卡候選；禁止以 generic v1 或未審核 v2 自動替補，既有手動圖卡保留" },
    ],
    tracking: { requested: false, initialRect, reason: "中央框不是主體語意證據；自動追蹤停用，請先由使用者或具素材綁定的規劃指定主體" },
  };
}

function mappedTime(relativeTime: number, clip: TimelineClip, plan: SemanticAutoEditPlan): number {
  let kept = 0;
  for (const range of plan.keepRanges) {
    if (relativeTime <= range.start) return clip.timelineStart + kept;
    if (relativeTime < range.end) return clip.timelineStart + kept + relativeTime - range.start;
    kept += range.end - range.start;
  }
  return clip.timelineStart + kept;
}

function voiceIntervals(clip: TimelineClip, cues: readonly SemanticCue[], plan: SemanticAutoEditPlan): Array<{ start: number; end: number }> {
  return cues.flatMap((cue) => plan.keepRanges.flatMap((range) => {
    const start = Math.max(cue.start, range.start);
    const end = Math.min(cue.end, range.end);
    return end > start ? [{ start: mappedTime(start, clip, plan), end: mappedTime(end, clip, plan) }] : [];
  })).sort((left, right) => left.start - right.start);
}

export function buildDuckedMusicCommands(project: EditProject, asset: MediaAsset, intervals: readonly { start: number; end: number }[]): EditorCommand[] {
  const duration = projectDuration(project);
  if (duration <= 0 || asset.duration <= 0) return [];
  const trackId = "audio-auto-music";
  const existing = project.tracks.find((track) => track.id === trackId);
  const commands: EditorCommand[] = [];
  if (existing) {
    commands.push(...existing.clips.map((clip): EditorCommand => ({ type: "delete_clip", clipId: clip.id })), { type: "delete_track", trackId });
  }
  if (!project.assets.some((item) => item.id === asset.id)) commands.push({ type: "import_asset", asset: { ...asset, role: "background-music" } });
  commands.push({ type: "add_track", track: { id: trackId, name: "配樂 · 自動壓低旁白", kind: "audio", locked: false, muted: false, clips: [] } });
  const boundaries = new Set([0, duration]);
  for (const interval of intervals) {
    boundaries.add(Math.max(0, Math.min(duration, interval.start - 0.08)));
    boundaries.add(Math.max(0, Math.min(duration, interval.end + 0.12)));
  }
  for (let loop = asset.duration; loop < duration; loop += asset.duration) boundaries.add(loop);
  const sorted = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (end - start < 1 / project.fps) continue;
    const midpoint = (start + end) / 2;
    const speaking = intervals.some((interval) => midpoint >= interval.start && midpoint <= interval.end);
    const modulo = start % asset.duration;
    const sourceStart = asset.duration - modulo < 1e-6 ? 0 : modulo;
    const clipDuration = Math.min(end - start, asset.duration - sourceStart);
    commands.push({ type: "add_clip", clip: {
      id: `autopilot-music-${project.id}-${index}`, assetId: asset.id, trackId, timelineStart: start,
      sourceStart, duration: clipDuration, volume: speaking ? 0.12 : 0.25,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    } });
  }
  return commands;
}

type ReceiptDecision = { family: string; selection: string; reason: string };

function receiptMarker(id: string, clip: TimelineClip, creative: NativeAutopilotCreativePlan, selections: { music?: string; tracking: string; graphics: string; caption?: ReceiptDecision; extra: ReceiptDecision[] }): DirectorMarker {
  const decisions = creative.decisions.map((item) => item.family === "caption" && selections.caption ? selections.caption : item);
  const note = [...decisions, ...selections.extra, { family: "music", selection: selections.music ?? "skipped", reason: selections.music ? `依 ${creative.rhythm.targetBpm} BPM 與片長選曲，旁白區間降至 12%` : "素材庫未提供可用曲目" }, { family: "tracking", selection: selections.tracking, reason: creative.tracking.reason }, { family: "graphicSafety", selection: selections.graphics, reason: "可選重複圖卡僅放字幕空檔，無足夠空檔則略過；空間排版 solver 未完成" }]
    .map((item) => `${item.family}=${item.selection}（${item.reason}）`).join("\n");
  return { id, time: clip.timelineStart, title: `原生自動成片 · ${creative.rhythm.mode}`, note, kind: "beat", status: "open", createdAt: new Date().toISOString() };
}

/** Which caption look an automatic run writes. */
export type NativeCaptionStyleDecision = "shorts-vertical" | "longform-monochrome" | "preset" | "preserved";

/**
 * A 9:16 canvas always gets Shorts captions when the run owns styling (explicit format, or the
 * untouched generated default); horizontal long-video captions keep the existing white-on-black rule.
 */
function automaticCaptionStyle(project: EditProject, policy: NativeEditingPolicy, creative: NativeAutopilotCreativePlan, cues: readonly SemanticCue[]):
  { decision: NativeCaptionStyleDecision; patch?: Partial<CaptionStyle>; receipt?: ReceiptDecision } {
  if (policy.ownership !== "automatic") return { decision: "preserved" };
  if (isVerticalCanvas(project.width, project.height) && (policy.format !== "unknown" || isGeneratedDefaultCaptionStyle(project.captionStyle, project))) {
    const style = shortsCaptionStyle(project, project.editorialProfile);
    const baseline = Math.round(SHORTS_CAPTION_REFERENCE.baselineLimitY * project.height / SHORTS_CAPTION_REFERENCE.height);
    const glyph = Math.round(SHORTS_CAPTION_REFERENCE.glyphHeight * style.fontSize / SHORTS_CAPTION_REFERENCE.assFontSize[style.fontFamily as keyof typeof SHORTS_CAPTION_REFERENCE.assFontSize]);
    return { decision: "shorts-vertical", patch: style, receipt: { family: "caption", selection: style.presetId,
      reason: `直式畫布 Shorts 白字：${style.fontFamily} 字高約 ${glyph}px（ASS ${style.fontSize}）、每行最多 ${style.maxLineEm} 字、柔和陰影${style.presetId.endsWith("green_edge") ? "與綠邊" : ""}、marginV ${style.marginV}，基線不低於 y${baseline}` } };
  }
  if (policy.format === "unknown") return { decision: "preserved" };
  if (policy.format === "longform") {
    return { decision: "longform-monochrome", patch: { ...project.captionStyle, color: "#FFFFFF", backgroundColor: "#000000B3", outlineColor: "#000000", outlineWidth: Math.max(4, Math.round(16 * project.height / 1080)), shadow: 0, shadowColor: undefined, shadowBlur: undefined, maxLineEm: undefined, translationColor: "#FFFFFF" } };
  }
  const preset = captionStyleFromPreset(creative.captionPresetId);
  const safe = cjkSafeCaptionStyle(preset, cues.map((cue) => cue.text));
  return { decision: "preset", patch: safe, receipt: safe === preset ? undefined
    : { family: "caption", selection: creative.captionPresetId, reason: `${preset.fontFamily} 沒有中文字形，中文字幕改用 ${safe.fontFamily}` } };
}

function editModeReceipt(plan: SemanticAutoEditPlan): ReceiptDecision {
  if (plan.engine === "editkin-narration-pause-trim-0.1") {
    return { family: "editMode", selection: "narration-pause-trim", reason: `長片／談話：保留全部語句，只剪 ${NARRATION_PAUSE_TRIM.minPause} 秒以上的停頓（移除 ${plan.removedDuration.toFixed(1)} 秒）` };
  }
  if (plan.engine === "editkin-visual-quality-0.1") {
    return { family: "editMode", selection: "visual-quality", reason: `沒有可用語音：依畫面穩定度選段，保留 ${plan.keptDuration.toFixed(1)} 秒並配樂` };
  }
  return { family: "editMode", selection: "highlight", reason: `Shorts 依語意分數濃縮至約 ${Math.round(plan.targetRatio * 100)}%，剪點只落在語句之間` };
}

function retainedTransition(transition: { presetId: string; duration: number } | undefined, availableDuration: number, fps: number) {
  // Preserve an authored effect only unchanged. Domain normalization otherwise
  // silently shortens it when Smart Cut keeps less than its original duration.
  return transition && Number.isFinite(transition.duration) && transition.duration >= 1 / fps
    && transition.duration <= Math.min(2, availableDuration) ? { ...transition } : null;
}

export function buildNativeAutopilotCommand(input: {
  project: EditProject;
  clip: TimelineClip;
  transcript: Pick<AutomaticCaptionDesktopResult, "cues" | "skippedCaptionBlocks">;
  semantic: SemanticAutoEditPlan;
  creative: NativeAutopilotCreativePlan;
  musicAsset?: MediaAsset;
  musicSelectionId?: string;
  trackingResult?: MotionTrackDesktopResult;
  idFactory?: (kind: string, index: number) => string;
  /** Recognizer cues left out as non-speech (sound descriptions, outro boilerplate, noise tokens). */
  speechFilter?: { dropped: number; usable: boolean };
}): { command: EditorCommand; segmentCount: number; addedCaptions: number; trackingStatus: string; captionStyle: NativeCaptionStyleDecision } {
  let idIndex = 0;
  const id = (kind: string) => input.idFactory?.(kind, idIndex++) ?? `autopilot-${kind}-${Date.now()}-${idIndex++}`;
  const base = buildSemanticAutoEditCommand(input.project, input.clip, input.transcript, input.semantic, (kind) => id(kind));
  const postBase = applyCommand(input.project, base.command);
  const policy = validatePolicy(input.creative.policy ?? conservativePolicy);
  const commands: EditorCommand[] = [base.command];
  if (policy.ownership === "automatic" && policy.format !== "unknown") {
    commands.push({ type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(input.project.editorialProfile, policy.format) });
  }
  const captionStyle = automaticCaptionStyle(input.project, policy, input.creative, input.transcript.cues);
  if (captionStyle.patch) commands.push({ type: "set_caption_style", patch: captionStyle.patch });
  const extraReceipts: ReceiptDecision[] = [editModeReceipt(input.semantic)];
  const skippedBlocks = input.transcript.skippedCaptionBlocks ?? [];
  if (skippedBlocks.length) {
    extraReceipts.push({ family: "captionParse", selection: `skipped-${skippedBlocks.length}`,
      reason: `語音辨識輸出有 ${skippedBlocks.length} 段格式不合法已略過（${skippedBlocks.slice(0, 8).map((item) => `${item.window === undefined ? "" : `窗${item.window + 1}・`}第${item.block}段`).join("、")}${skippedBlocks.length > 8 ? "…" : ""}），其餘字幕保留` });
  }
  if (input.speechFilter && (input.speechFilter.dropped > 0 || !input.speechFilter.usable)) {
    extraReceipts.push({ family: "speechFilter", selection: input.speechFilter.usable ? `dropped-${input.speechFilter.dropped}` : "no-usable-speech",
      reason: `${input.speechFilter.dropped} 段辨識結果是環境聲描述、片尾套話或雜訊，未做成字幕${input.speechFilter.usable ? "" : "；剩下的語音太少，整段改依畫面選段"}` });
  }
  base.segmentIds.forEach((clipId, index) => commands.push({ type: "set_clip_creative", clipId, patch: {
    // Undefined preserves; null deletes. Smart Cut inherits creative state, so
    // every newly created internal join must explicitly discard inherited edges.
    transitionIn: policy.ownership === "manual" && index === 0
      && alignTime(input.semantic.keepRanges[index].start, input.project.fps) === 0
      ? retainedTransition(input.clip.creative?.transitionIn,
        alignTime(input.semantic.keepRanges[index].end, input.project.fps) - alignTime(input.semantic.keepRanges[index].start, input.project.fps), input.project.fps) : null,
    transitionOut: policy.ownership === "manual" && index === base.segmentIds.length - 1
      && alignTime(input.semantic.keepRanges[index].end, input.project.fps) === alignTime(input.clip.duration, input.project.fps)
      ? retainedTransition(input.clip.creative?.transitionOut,
        alignTime(input.semantic.keepRanges[index].end, input.project.fps) - alignTime(input.semantic.keepRanges[index].start, input.project.fps), input.project.fps) : null,
  } }));
  // Rejected by the user in actual visual review. Do not silently substitute
  // generic v1 artwork; this gate affects generation, never existing graphics.
  const graphicDecisions = ["title:blocked-pending-art-review", "card:blocked-pending-art-review"];
  graphicDecisions.push(`aesthetic:${policy.ownership === "automatic" && policy.format !== "unknown"
    ? `${resolveAestheticSystem(input.project.editorialProfile, policy.format).primaryFamily}:REVIEW-not-scored`
    : "preserved-existing-contract"}`);
  const trackingStatus = "disabled-no-semantic-evidence";
  graphicDecisions.push("tag:disabled-no-semantic-evidence");
  if (input.musicAsset) commands.push(...buildDuckedMusicCommands(postBase, input.musicAsset, voiceIntervals(input.clip, input.transcript.cues, input.semantic)));
  commands.push({ type: "add_director_marker", marker: receiptMarker(id("receipt"), input.clip, input.creative, { music: input.musicSelectionId, tracking: trackingStatus, graphics: graphicDecisions.join(","), caption: captionStyle.receipt, extra: extraReceipts }) });
  return { command: { type: "batch", commands }, segmentCount: base.segmentCount, addedCaptions: base.addedCaptions, trackingStatus, captionStyle: captionStyle.decision };
}

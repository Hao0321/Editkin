import * as z from "zod/v4";
import { captionStyleFromPreset, findEffectPreset, findLookPreset, findTransitionPreset } from "../creative/corePack";
import { applyCommand, type EditorCommand } from "../domain/commands";
import { createEmptyProject, projectDuration, validateProject } from "../domain/editGraph";
import {
  DEFAULT_COLOR,
  DEFAULT_TRANSFORM,
  type EditProject,
  type MediaAsset,
  type MotionGraphic,
  type MotionTrack,
  type TimelineClip,
} from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { resolveAestheticSystem } from "./editkinAesthetic";

export const SKILL_EDITORIAL_BATCH_SCHEMA = "hao.video-autopilot.editorial-batch/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const idSchema = z.string().trim().min(1).max(96).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const finiteTime = z.number().finite().nonnegative();
const normalized = z.number().finite().min(0).max(1);
const rectSchema = z.strictObject({ x: normalized, y: normalized, width: normalized, height: normalized });
const textRoleSchema = z.enum(["hook", "launch", "status", "round", "payoff"]);

const segmentSchema = z.strictObject({
  sourceStart: finiteTime,
  duration: z.number().finite().positive().max(90),
});

const textEventSchema = z.strictObject({
  id: idSchema,
  start: finiteTime,
  end: z.number().finite().positive(),
  text: z.string().trim().min(1).max(80),
  role: textRoleSchema,
});

const trackedLabelSchema = z.strictObject({
  id: idSchema,
  text: z.string().trim().min(1).max(48),
  start: finiteTime,
  end: z.number().finite().positive(),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  points: z.array(z.strictObject({ time: finiteTime, rect: rectSchema, confidence: z.number().finite().min(0).max(1) })).min(2).max(600),
});

const deliverableSchema = z.strictObject({
  id: idSchema,
  ordinal: z.number().int().positive().max(64),
  name: z.string().trim().min(1).max(120),
  segments: z.array(segmentSchema).min(3).max(64),
  textEvents: z.array(textEventSchema).min(2).max(32),
  trackedLabels: z.array(trackedLabelSchema).max(16),
  creative: z.strictObject({
    lookPresetId: z.string().trim().min(1).max(64),
    effectPresetIds: z.array(z.string().trim().min(1).max(64)).max(4),
    transitionPresetId: z.string().trim().min(1).max(64),
  }),
  evidence: z.strictObject({
    editorialFingerprintSha256: sha256Schema,
    previousEditorialFingerprintSha256: sha256Schema.optional(),
    visualPlanSha256: sha256Schema,
    trackingSpecSha256: sha256Schema.optional(),
  }),
});

export const skillEditorialBatchPlanSchema = z.strictObject({
  schema: z.literal(SKILL_EDITORIAL_BATCH_SCHEMA),
  batchId: idSchema,
  format: z.enum(["shorts", "reels"]),
  expectedDeliverableCount: z.number().int().positive().max(64),
  revisionPolicy: z.strictObject({
    intent: z.enum(["new_cut", "migration", "recut"]),
    baselineRole: z.literal("benchmark_only"),
    requireMaterialDecisionChange: z.boolean(),
  }),
  source: z.strictObject({
    path: z.string().trim().min(1),
    sha256: sha256Schema,
    duration: z.number().finite().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    colorInterpretation: z.enum(["rec709", "hlg", "pq", "srgb"]),
  }),
  music: z.strictObject({
    assetId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1),
    sha256: sha256Schema,
    duration: z.number().finite().positive(),
    bpm: z.number().finite().positive(),
    license: z.string().trim().min(1).max(128),
    provenance: z.string().trim().min(1).max(512),
    redistributable: z.literal(true),
  }),
  soundEffects: z.array(z.strictObject({
    assetId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(160),
    role: z.enum(["transition-whoosh", "payoff-impact", "countdown-tick", "reveal-spark"]),
    path: z.string().trim().min(1),
    sha256: sha256Schema,
    duration: z.number().finite().positive().max(5),
    license: z.enum(["CC-BY-4.0", "MIT", "CC0-1.0"]),
    provenance: z.string().trim().min(1).max(512),
    redistributable: z.literal(true),
  })).min(2).max(8),
  policy: z.strictObject({
    oneEditableProjectPerDeliverable: z.literal(true),
    muteOriginalAudio: z.literal(true),
    addMusic: z.literal(true),
    useAces2: z.literal(true),
    requireVisibleTypography: z.literal(true),
    preserveMeaningfulWaits: z.literal(true),
    allowCompilationFallback: z.literal(false),
    allowSourceReuse: z.literal(false),
  }),
  deliverables: z.array(deliverableSchema).min(1).max(64),
});

export type SkillEditorialBatchPlan = z.infer<typeof skillEditorialBatchPlanSchema>;
export type SkillEditorialDeliverable = SkillEditorialBatchPlan["deliverables"][number];

function aligned(value: number, fps: number): number {
  return Math.round(value * fps) / fps;
}

function floorAligned(value: number, fps: number): number {
  return Math.max(1 / fps, Math.floor(value * fps) / fps);
}

export function deliverableDuration(deliverable: SkillEditorialDeliverable): number {
  return deliverable.segments.reduce((sum, segment) => sum + segment.duration, 0);
}

function intervalsOverlap(left: { start: number; end: number }, right: { start: number; end: number }, tolerance = 1 / 120): boolean {
  return left.start < right.end - tolerance && right.start < left.end - tolerance;
}

export function parseSkillEditorialBatchPlan(input: unknown): SkillEditorialBatchPlan {
  const plan = skillEditorialBatchPlanSchema.parse(input);
  const soundEffectIds = new Set(plan.soundEffects.map((item) => item.assetId));
  if (soundEffectIds.size !== plan.soundEffects.length) throw new Error("SFX assetId 重複");
  for (const role of ["transition-whoosh", "payoff-impact"] as const) {
    if (!plan.soundEffects.some((item) => item.role === role)) throw new Error(`批次缺少必要 SFX：${role}`);
  }
  if (plan.deliverables.length !== plan.expectedDeliverableCount) {
    throw new Error(`預期 ${plan.expectedDeliverableCount} 支成片，實際計畫只有 ${plan.deliverables.length} 支；禁止退化成合輯`);
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const sourceIntervals: Array<{ id: string; start: number; end: number }> = [];
  for (const deliverable of plan.deliverables) {
    if (ids.has(deliverable.id)) throw new Error(`重複 deliverable id：${deliverable.id}`);
    if (ordinals.has(deliverable.ordinal)) throw new Error(`重複 deliverable ordinal：${deliverable.ordinal}`);
    ids.add(deliverable.id);
    ordinals.add(deliverable.ordinal);
    const duration = deliverableDuration(deliverable);
    if (duration < 8 || duration > 90) throw new Error(`${deliverable.id} 的 Shorts 片長不合理：${duration.toFixed(2)} 秒`);
    if (!deliverable.textEvents.some((event) => event.role === "hook" && event.start <= 0.5)) {
      throw new Error(`${deliverable.id} 缺少 0.5 秒內可見 Hook`);
    }
    const payoffEvents = deliverable.textEvents.filter((event) => event.role === "payoff");
    if (!payoffEvents.some((event) => event.start >= duration * 0.55)) {
      throw new Error(`${deliverable.id} 缺少後半段可見 Payoff`);
    }
    if (payoffEvents.length !== 1) throw new Error(`${deliverable.id} 必須只有一次可見 Payoff`);
    if (plan.revisionPolicy.intent === "recut") {
      const previous = deliverable.evidence.previousEditorialFingerprintSha256;
      if (!previous) throw new Error(`${deliverable.id} 重剪缺少上一版 editorial fingerprint`);
      if (plan.revisionPolicy.requireMaterialDecisionChange && previous === deliverable.evidence.editorialFingerprintSha256) {
        throw new Error(`${deliverable.id} 沒有實質剪輯決策差異，禁止把重新渲染冒充重剪`);
      }
    }
    for (const event of deliverable.textEvents) {
      if (event.end <= event.start || event.end > duration + 1 / 30) throw new Error(`${deliverable.id} 文字事件超出成片：${event.id}`);
    }
    for (const label of deliverable.trackedLabels) {
      if (label.end <= label.start || label.end > duration + 1 / 30) throw new Error(`${deliverable.id} 追蹤標籤超出成片：${label.id}`);
      if (label.points.some((point) => point.time < label.start - 1 / 30 || point.time > label.end + 1 / 30)) {
        throw new Error(`${deliverable.id} 追蹤點不在標籤時間窗：${label.id}`);
      }
    }
    findLookPreset(deliverable.creative.lookPresetId);
    deliverable.creative.effectPresetIds.forEach(findEffectPreset);
    findTransitionPreset(deliverable.creative.transitionPresetId);
    for (const segment of deliverable.segments) {
      const end = segment.sourceStart + segment.duration;
      if (end > plan.source.duration + 1 / 30) throw new Error(`${deliverable.id} 切點超出來源片長`);
      sourceIntervals.push({ id: deliverable.id, start: segment.sourceStart, end });
    }
  }
  for (let ordinal = 1; ordinal <= plan.expectedDeliverableCount; ordinal += 1) {
    if (!ordinals.has(ordinal)) throw new Error(`deliverable ordinal 不連續，缺少 ${ordinal}`);
  }
  if (!plan.policy.allowSourceReuse) {
    const sorted = [...sourceIntervals].sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < sorted.length; index += 1) {
      if (intervalsOverlap(sorted[index - 1], sorted[index])) {
        throw new Error(`來源時間被多支成片重複使用：${sorted[index - 1].id} / ${sorted[index].id}`);
      }
    }
  }
  return plan;
}

function clipAtTime(clips: readonly TimelineClip[], time: number): TimelineClip | undefined {
  return clips.find((clip) => time >= clip.timelineStart - 1 / 60 && time < clip.timelineStart + clip.duration - 1 / 60);
}

function graphicForText(event: SkillEditorialDeliverable["textEvents"][number], duration: number): MotionGraphic | undefined {
  if (event.role === "hook") {
    const graphic = createMotionGraphic(`graphic-${event.id}`, "title", event.text, event.start, event.end - event.start);
    return { ...graphic, x: 0.07, y: 0.085, width: 0.86, fontSize: 82, backgroundColor: "#151A37EE", accentColor: "#FF4FA3", animation: "pop" };
  }
  if (event.role === "launch") {
    const graphic = createMotionGraphic(`graphic-${event.id}`, "counter", event.text, event.start, event.end - event.start);
    return { ...graphic, x: 0.12, y: 0.68, width: 0.76, fontSize: 74, backgroundColor: "#FF3D9ADD", accentColor: "#FFD84D", animation: "pop" };
  }
  if (event.role === "round") {
    const graphic = createMotionGraphic(`graphic-${event.id}`, "counter", event.text, event.start, event.end - event.start);
    return { ...graphic, x: 0.72, y: 0.1, width: 0.22, fontSize: 58, backgroundColor: "#315CFFDD", accentColor: "#77E4FF" };
  }
  if (event.role === "payoff") {
    const graphic = createMotionGraphic(`graphic-${event.id}`, "card", event.text, event.start, Math.min(event.end - event.start, duration - event.start));
    return { ...graphic, x: 0.08, y: 0.69, width: 0.84, fontSize: 64, textColor: "#FFFFFF", backgroundColor: "#10162BEE", accentColor: "#FFD84D", animation: "spring_soft" };
  }
  return undefined;
}

function trackedCommands(deliverable: SkillEditorialDeliverable, clips: readonly TimelineClip[], fps: number): EditorCommand[] {
  const commands: EditorCommand[] = [];
  for (const label of deliverable.trackedLabels) {
    const clip = clipAtTime(clips, label.start);
    if (!clip) throw new Error(`${deliverable.id} 的追蹤標籤找不到承載片段：${label.id}`);
    const trackId = `track-${label.id}`;
    const points = label.points
      .filter((point) => point.time >= clip.timelineStart - 1 / fps && point.time <= clip.timelineStart + clip.duration + 1 / fps)
      .map((point) => ({
        frame: Math.max(0, Math.round((point.time - clip.timelineStart) * fps)),
        time: aligned(Math.max(0, point.time - clip.timelineStart), fps),
        rect: point.rect,
        confidence: point.confidence,
        status: "tracked" as const,
      }));
    if (points.length < 2) throw new Error(`${deliverable.id} 的追蹤標籤有效點不足：${label.id}`);
    const track: MotionTrack = {
      id: trackId,
      clipId: clip.id,
      name: `Skill 追蹤 · ${label.text}`,
      engine: "video-autopilot-receipt",
      analysisFps: fps,
      initialRect: points[0].rect,
      points,
      lostRatio: 0,
      createdAt: new Date().toISOString(),
    };
    const graphic = createMotionGraphic(`graphic-${label.id}`, "tag", label.text, label.start, label.end - label.start, trackId);
    commands.push(
      { type: "add_motion_track", track },
      { type: "add_motion_graphic", graphic: { ...graphic, width: 0.34, fontSize: 42, backgroundColor: `${label.accentColor}EE`, accentColor: label.accentColor, textColor: "#07110A" } },
    );
  }
  return commands;
}

export function buildSkillEditorialProject(plan: SkillEditorialBatchPlan, deliverable: SkillEditorialDeliverable): EditProject {
  const fps = 30;
  const project = createEmptyProject(deliverable.name, { id: `skill-batch-${deliverable.id}`, width: 1080, height: 1920, fps });
  project.editorialProfile = "gaming";
  project.aestheticSystem = resolveAestheticSystem("gaming", "shorts");
  project.colorManagement = { mode: "aces2", workingSpace: "ACEScct", outputTransform: "rec709_sdr", configId: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5" };
  const sourceAsset: MediaAsset = {
    id: `source-${deliverable.id}`,
    name: plan.source.path.split(/[\\/]/).at(-1) ?? "source.mp4",
    kind: "video",
    uri: plan.source.path,
    duration: plan.source.duration,
    width: plan.source.width,
    height: plan.source.height,
    role: "primary-source",
    provenance: "video-autopilot-editorial-receipt",
    redistributable: false,
    color: { interpretation: plan.source.colorInterpretation },
    derivatives: { sourceSha256: plan.source.sha256, generatedAt: new Date().toISOString() },
  };
  const clips: TimelineClip[] = [];
  let cursor = 0;
  for (const [index, segment] of deliverable.segments.entries()) {
    const timelineStart = aligned(cursor, fps);
    const duration = aligned(segment.duration, fps);
    const launch = deliverable.textEvents.some((event) => event.role === "launch" && event.start >= timelineStart - 1 / fps && event.start < timelineStart + duration);
    const payoff = deliverable.textEvents.some((event) => event.role === "payoff" && event.start >= timelineStart - 1 / fps && event.start < timelineStart + duration);
    const clip: TimelineClip = {
      id: `clip-${deliverable.id}-${index + 1}`,
      assetId: sourceAsset.id,
      trackId: "video-main",
      timelineStart,
      sourceStart: aligned(segment.sourceStart, fps),
      duration,
      volume: 0,
      transform: { ...DEFAULT_TRANSFORM },
      color: { ...DEFAULT_COLOR },
      keyframes: launch ? [
        { id: `kf-${deliverable.id}-${index}-impact`, time: 0, transform: { ...DEFAULT_TRANSFORM, scale: 1.04 }, color: { ...DEFAULT_COLOR }, easing: "ease_out" },
        { id: `kf-${deliverable.id}-${index}-settle`, time: Math.min(0.28, duration), transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, easing: "ease_out" },
      ] : [],
      creative: {
        lookPresetId: deliverable.creative.lookPresetId,
        effectPresetIds: index < 2 || launch || payoff ? [...deliverable.creative.effectPresetIds] : [],
        transitionIn: index > 0 && (launch || payoff) ? { presetId: deliverable.creative.transitionPresetId, duration: Math.min(0.16, duration / 4) } : undefined,
      },
    };
    clips.push(clip);
    cursor += duration;
  }

  const captionStyle = { ...captionStyleFromPreset("clean_caption"), fontFamily: "Noto Sans TC", fontSize: 68, outlineWidth: 5, marginV: 120, backgroundColor: "#00000066", letterSpacing: 1 };
  const musicAsset: MediaAsset = {
    id: `music-${deliverable.id}`,
    name: plan.music.name,
    kind: "audio",
    uri: plan.music.path,
    duration: plan.music.duration,
    role: "background-music",
    bpm: plan.music.bpm,
    license: plan.music.license,
    provenance: plan.music.provenance,
    redistributable: true,
    derivatives: { sourceSha256: plan.music.sha256, generatedAt: new Date().toISOString() },
  };
  const soundEffectAssets: MediaAsset[] = plan.soundEffects.map((soundEffect, index) => ({
    id: `sfx-${deliverable.id}-${index + 1}`,
    name: soundEffect.name,
    kind: "audio",
    uri: soundEffect.path,
    duration: soundEffect.duration,
    role: `sound-effect:${soundEffect.role}`,
    license: soundEffect.license,
    provenance: soundEffect.provenance,
    redistributable: true,
    derivatives: { sourceSha256: soundEffect.sha256, generatedAt: new Date().toISOString() },
  }));
  const commands: EditorCommand[] = [
    { type: "import_asset", asset: sourceAsset },
    ...clips.map((clip): EditorCommand => ({ type: "add_clip", clip })),
    { type: "set_caption_style", patch: captionStyle },
  ];
  for (const event of deliverable.textEvents) {
    const graphic = graphicForText(event, cursor);
    if (graphic) commands.push({ type: "add_motion_graphic", graphic });
    else commands.push({ type: "add_caption", caption: { id: `caption-${event.id}`, text: event.text, start: aligned(event.start, fps), duration: aligned(event.end - event.start, fps) } });
  }
  commands.push(...trackedCommands(deliverable, clips, fps));
  commands.push(
    { type: "import_asset", asset: musicAsset },
    { type: "add_track", track: { id: "audio-music", name: `音樂 · ${plan.music.name}`, kind: "audio", locked: false, muted: false, clips: [] } },
    { type: "add_clip", clip: { id: `music-clip-${deliverable.id}`, assetId: musicAsset.id, trackId: "audio-music", timelineStart: 0, sourceStart: ((deliverable.ordinal - 1) * 2.4) % Math.max(1, musicAsset.duration - cursor), duration: Math.min(cursor, musicAsset.duration), volume: 0.24, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
    ...soundEffectAssets.map((asset): EditorCommand => ({ type: "import_asset", asset })),
    { type: "add_track", track: { id: "audio-sfx", name: "音效 · Launch / Impact", kind: "audio", locked: false, muted: false, clips: [] } },
  );
  const effectByRole = new Map(plan.soundEffects.map((soundEffect, index) => [soundEffect.role, { definition: soundEffect, asset: soundEffectAssets[index] }]));
  const soundEvents = deliverable.textEvents.flatMap((event) => {
    const role = event.role === "launch" ? "transition-whoosh" : event.role === "payoff" ? "payoff-impact" : event.role === "round" ? "countdown-tick" : undefined;
    if (!role) return [];
    const selected = effectByRole.get(role);
    if (!selected) return [];
    const timelineStart = aligned(Math.max(0, event.start - (role === "transition-whoosh" ? 0.08 : 0)), fps);
    const duration = floorAligned(Math.min(selected.definition.duration, cursor - timelineStart), fps);
    if (duration <= 0) return [];
    return [{ asset: selected.asset, definition: selected.definition, role, timelineStart, duration }];
  });
  if (!soundEvents.some((event) => event.role === "transition-whoosh")) {
    const selected = effectByRole.get("transition-whoosh");
    if (selected) {
      const timelineStart = aligned(Math.max(0, (clips[1]?.timelineStart ?? 0) - 0.08), fps);
      soundEvents.push({ asset: selected.asset, definition: selected.definition, role: "transition-whoosh", timelineStart, duration: floorAligned(Math.min(selected.definition.duration, cursor - timelineStart), fps) });
    }
  }
  for (const [index, soundEvent] of soundEvents.entries()) {
    commands.push({ type: "add_clip", clip: {
      id: `sfx-clip-${deliverable.id}-${index + 1}`,
      assetId: soundEvent.asset.id,
      trackId: "audio-sfx",
      timelineStart: soundEvent.timelineStart,
      sourceStart: 0,
      duration: soundEvent.duration,
      volume: soundEvent.role === "payoff-impact" ? 0.72 : soundEvent.role === "transition-whoosh" ? 0.52 : 0.42,
      transform: { ...DEFAULT_TRANSFORM },
      color: { ...DEFAULT_COLOR },
      keyframes: [],
    } });
  }
  commands.push({ type: "add_director_marker", marker: { id: `receipt-${deliverable.id}`, time: 0, title: `Skill 原生重建 ${deliverable.ordinal}/${plan.expectedDeliverableCount}`, note: `原聲=靜音；音樂=${plan.music.name}；SFX=${soundEvents.length}；ACES2=開；Look=${deliverable.creative.lookPresetId}；追蹤標籤=${deliverable.trackedLabels.length}；不可合輯`, kind: "beat", status: "open", createdAt: new Date().toISOString() } });
  const built = applyCommand(project, { type: "batch", commands });
  if (Math.abs(projectDuration(built) - cursor) > 1 / fps) throw new Error(`${deliverable.id} 的時間軸片長與計畫不一致`);
  return validateProject(built);
}

export function skillEditorialProjectEvidence(project: EditProject) {
  const sourceClips = project.tracks.find((track) => track.id === "video-main")?.clips ?? [];
  const musicClips = project.tracks.flatMap((track) => track.clips).filter((clip) => project.assets.find((asset) => asset.id === clip.assetId)?.role === "background-music");
  const sfxClips = project.tracks.flatMap((track) => track.clips).filter((clip) => project.assets.find((asset) => asset.id === clip.assetId)?.role?.startsWith("sound-effect:"));
  return {
    duration: projectDuration(project),
    sourceClipCount: sourceClips.length,
    originalAudioMuted: sourceClips.every((clip) => clip.volume === 0),
    musicClipCount: musicClips.length,
    sfxClipCount: sfxClips.length,
    captionCount: project.captions.length,
    motionGraphicCount: project.motionGraphics.length,
    motionTrackCount: project.motionTracks.length,
    aces2: project.colorManagement?.mode === "aces2",
    lookIds: [...new Set(sourceClips.map((clip) => clip.creative?.lookPresetId).filter(Boolean))],
    effectIds: [...new Set(sourceClips.flatMap((clip) => clip.creative?.effectPresetIds ?? []))],
    transitionCount: sourceClips.filter((clip) => clip.creative?.transitionIn || clip.creative?.transitionOut).length,
  };
}

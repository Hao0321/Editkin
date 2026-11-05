import type { EditorCommand } from "../domain/commandTypes";
import { alignTime, EditGraphError } from "../domain/editGraph";
import type { EditProject, TimelineClip } from "../domain/types";
import { findLookPreset, findTransitionPreset } from "../creative/corePack";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import { motionClipPresetCommands } from "../motion/motionClipPresets";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { compileBeatAlignedMontage, type BeatMontageShotEvidence } from "./beatMontageCompiler";
import type { EditorialPlan } from "./editorialPlan";

export const MUSIC_VIDEO_DRAFT_ENGINE = "editkin-music-video-draft-compiler/v1" as const;
export type MusicVideoStyleId = "afterglow" | "paper_air";

export interface MusicVideoLyricCue {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Caller-asserted provenance, to be bound to a source/lyric receipt by the v4 author. */
  evidenceRef: string;
}

export interface MusicVideoTransitionCue {
  /** The incoming clip's slot, starting at 1. */
  boundaryIndex: number;
  fromShotId: string;
  toShotId: string;
  style: "soft" | "axis_left" | "axis_right";
  /** Both sides of the cut must have material evidence. */
  evidenceRefs: [string, string];
}

export interface MusicVideoDraftRequest {
  styleId: MusicVideoStyleId;
  musicClipId: string;
  targetTrackId: string;
  /** Caller-supplied phrase/downbeat boundaries, not inferred by Editkin. */
  beatTimes: readonly number[];
  candidates: readonly BeatMontageShotEvidence[];
  lyricCues?: readonly MusicVideoLyricCue[];
  /** These shot IDs must be evidence-checked as safe for a gentle camera push. */
  cameraSafeShotIds?: readonly string[];
  transitionCues?: readonly MusicVideoTransitionCue[];
  clipIds?: readonly string[];
}

const STYLES = {
  afterglow: { lookPresetId: "cine_neon_night_guard", lyricPresetId: "mv_afterglow_lyric", fastLyricPresetId: "mv_afterglow_lyric_fast" },
  paper_air: { lookPresetId: "cine_pastel_air", lyricPresetId: "mv_paper_air_lyric", fastLyricPresetId: "mv_paper_air_lyric_fast" },
} as const;

const TRANSITION_PRESETS = {
  // The combined fade+zoom preset currently trips a bundled FFmpeg geometry
  // assertion on an otherwise valid 30 fps MV. Keep the native-safe fade here.
  soft: "cine_short_fade_through_base",
  axis_left: "cine_left_slide_fade",
  axis_right: "cine_right_slide_fade",
} as const;

function occupied(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd - 1e-6 && otherStart < end - 1e-6;
}

function requireMusicBed(project: EditProject, clipId: string, start: number, end: number): void {
  const track = project.tracks.find(item => item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId);
  const asset = project.assets.find(item => item.id === clip?.assetId);
  if (!track || track.kind !== "audio" || track.muted || !clip || !asset || asset.kind !== "audio"
    || clip.volume <= 0 || clip.timelineStart > start + 1e-6 || clip.timelineStart + clip.duration < end - 1e-6) {
    throw new EditGraphError("音樂 MV 必須有一條未靜音、覆蓋整段的既有歌曲聲軌");
  }
}

function lyricCommands(
  project: EditProject,
  lyricCues: readonly MusicVideoLyricCue[],
  style: typeof STYLES[MusicVideoStyleId],
  start: number,
  end: number,
): { commands: EditorCommand[]; editorialGraphics: EditorialPlan["graphics"] } {
  if (lyricCues.length > 64) throw new EditGraphError("單段 MV 歌詞不可超過 64 行；請按樂段分批編譯");
  const commands: EditorCommand[] = [];
  const editorialGraphics: EditorialPlan["graphics"] = [];
  const existingIds = new Set(project.motionGraphics.map(item => item.id));
  let previousEnd = start;
  for (const cue of lyricCues) {
    const text = cue.text.trim();
    const lines = text.split(/\r?\n/u);
    const id = `mv-lyric-${cue.id}`;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(cue.id) || existingIds.has(id)
      || !text || [...text].length > 48 || lines.length > 2 || lines.some(line => !line.trim())
      || !cue.evidenceRef.trim() || cue.evidenceRef.length > 160) {
      throw new EditGraphError(`MV 歌詞文字、來源或 id 不合法：${cue.id}`);
    }
    existingIds.add(id);
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)) throw new EditGraphError(`MV 歌詞時間不合法：${cue.id}`);
    const cueStart = alignTime(cue.start, project.fps);
    const cueEnd = alignTime(cue.end, project.fps);
    const frames = Math.round((cueEnd - cueStart) * project.fps);
    if (cueStart < start - 1e-6 || cueEnd > end + 1e-6 || cueStart < previousEnd - 1e-6 || frames < 9) {
      throw new EditGraphError(`MV 歌詞必須依序、不重疊、落在歌曲段內且至少 9 格：${cue.id}`);
    }
    if (project.captions.some(caption => occupied(cueStart, cueEnd, caption.start, caption.start + caption.duration))) {
      throw new EditGraphError(`MV 歌詞與既有字幕重疊：${cue.id}`);
    }
    previousEnd = cueEnd;
    const characterCount = [...text].filter(char => !/\s/u.test(char)).length;
    const slowMotion = findMotionGraphicPreset(style.lyricPresetId).seed.motionV2!;
    const slowFrames = slowMotion.entrance.durationFrames + slowMotion.exit.durationFrames
      + 2 * Math.max(0, characterCount - 1) * slowMotion.sequence.staggerFrames;
    const presetId = frames >= slowFrames ? style.lyricPresetId : style.fastLyricPresetId;
    const preset = findMotionGraphicPreset(presetId);
    // Preserve intentional lyric lines. An unsplit phrase must fit on one
    // line; the layout contract shrinks it or rejects it instead of wrapping
    // a Japanese word/phrase at an arbitrary character.
    const seed = { ...preset.seed, layoutV2: { ...preset.seed.layoutV2!, maxLines: lines.length } };
    const graphic = createMotionGraphic(id, "title", text, cueStart, cueEnd - cueStart, undefined, seed);
    assertMotionGraphicV2Contract(graphic, project.fps);
    motionGraphicV2LayoutReceipt(project, graphic);
    commands.push({ type: "add_motion_graphic", graphic });
    editorialGraphics.push({ id, presetId, range: { startFrame: Math.round(cueStart * project.fps), endFrame: Math.round(cueEnd * project.fps) },
      kind: "lyric_line", purpose: "context", message: text, evidenceRefs: [cue.evidenceRef] });
  }
  return { commands, editorialGraphics };
}

/** Compile editable commands. Source semantics, beat accuracy and art remain external review obligations. */
export function compileMusicVideoDraft(project: EditProject, request: MusicVideoDraftRequest) {
  const style = STYLES[request.styleId];
  if (!style) throw new EditGraphError(`未知音樂 MV 美術方向：${request.styleId}`);
  initializeStudioCreativeAssets();
  findLookPreset(style.lookPresetId);
  const montage = compileBeatAlignedMontage(project, {
    targetTrackId: request.targetTrackId,
    beatTimes: request.beatTimes,
    candidates: request.candidates.map(candidate => ({ ...candidate, volume: 0 })),
    clipIds: request.clipIds,
  });
  const start = montage.beatTimes[0];
  const end = montage.beatTimes.at(-1)!;
  requireMusicBed(project, request.musicClipId, start, end);
  const clips = montage.command.commands.map(command => {
    if (command.type !== "add_clip") throw new EditGraphError("MV 蒙太奇編譯結果不是新增片段");
    return command.clip;
  });
  const selectedShotIds = new Set(montage.selections.map(item => item.shotId));
  const cameraSafe = new Set(request.cameraSafeShotIds ?? []);
  if (cameraSafe.size !== (request.cameraSafeShotIds ?? []).length || [...cameraSafe].some(id => !selectedShotIds.has(id))) {
    throw new EditGraphError("MV 緩推鏡頭清單必須引用已選且不重複的 shotId");
  }

  const transitionBySlot = new Map<number, MusicVideoTransitionCue>();
  let previousTransitionAt = -Infinity;
  for (const cue of [...(request.transitionCues ?? [])].sort((a, b) => a.boundaryIndex - b.boundaryIndex)) {
    const slot = cue.boundaryIndex;
    const left = montage.selections[slot - 1];
    const right = montage.selections[slot];
    if (!Number.isInteger(slot) || !left || !right || slot < 1 || transitionBySlot.has(slot)
      || left.shotId !== cue.fromShotId || right.shotId !== cue.toShotId
      || !TRANSITION_PRESETS[cue.style] || cue.evidenceRefs.length !== 2
      || cue.evidenceRefs.some(ref => !ref.trim() || ref.length > 160)
      || right.timelineStart - previousTransitionAt < 1.5) {
      throw new EditGraphError("MV 轉場需有切點兩側證據、正確鏡頭順序及至少 1.5 秒間隔");
    }
    transitionBySlot.set(slot, cue);
    previousTransitionAt = right.timelineStart;
  }
  if (transitionBySlot.size > Math.ceil(clips.length / 3)) throw new EditGraphError("MV 轉場密度過高；保留乾淨剪點");

  const commands: EditorCommand[] = clips.map((clip): EditorCommand => ({ type: "add_clip", clip }));
  const transitions: Array<{ boundaryIndex: number; presetId: string; evidenceRefs: [string, string] }> = [];
  clips.forEach((clip: TimelineClip, slot) => {
    const cue = transitionBySlot.get(slot);
    const patch: Extract<EditorCommand, { type: "set_clip_creative" }>["patch"] = { lookPresetId: style.lookPresetId };
    if (cue) {
      const preset = findTransitionPreset(TRANSITION_PRESETS[cue.style]);
      const durationFrames = Math.min(Math.round(preset.defaultDuration * project.fps), Math.floor(clip.duration * project.fps / 4));
      if (durationFrames < 2) throw new EditGraphError(`MV 轉場所在鏡頭太短：${clip.id}`);
      patch.transitionIn = { presetId: preset.id, duration: durationFrames / project.fps };
      transitions.push({ boundaryIndex: slot, presetId: preset.id, evidenceRefs: cue.evidenceRefs });
    }
    commands.push({ type: "set_clip_creative", clipId: clip.id, patch });
    if (cameraSafe.has(montage.selections[slot].shotId) && clip.duration * project.fps >= 12) {
      commands.push(...motionClipPresetCommands(clip, project.fps, "slow_push"));
    }
  });
  const lyrics = lyricCommands(project, request.lyricCues ?? [], style, start, end);
  commands.push(...lyrics.commands);
  return {
    schema: "editkin.music-video-draft/v1" as const,
    engine: MUSIC_VIDEO_DRAFT_ENGINE,
    status: "DRAFT_COMMAND_CANDIDATE" as const,
    mutationPerformed: false as const,
    directApplyAllowed: false as const,
    evidenceAuthority: "caller_asserted_unverified" as const,
    projectId: project.id,
    projectRevision: project.revision,
    styleId: request.styleId,
    musicClipId: request.musicClipId,
    beatTimes: montage.beatTimes,
    selections: montage.selections,
    commands,
    editorialGraphics: lyrics.editorialGraphics,
    transitions,
    guarantees: { frameAligned: true, sourceVideoMuted: true, continuousExistingMusicBed: true,
      editableMotion: true, editableLyrics: true, pairwiseTransitions: false, automaticBeatDetection: false,
      automaticLyricTranscription: false, colorCorrectness: false, humanArtApproval: false } as const,
    next: "Bind caller beat/shot/lyric evidence and these exact flat commands to one v4 plan; declare all motionTreatment families, audit_autopilot_plan, then apply_autopilot_plan and render. Human art and color review remain required.",
  };
}

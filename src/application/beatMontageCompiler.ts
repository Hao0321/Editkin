import type { EditorCommand } from "../domain/commands";
import { alignTime, EditGraphError } from "../domain/editGraph";
import {
  DEFAULT_CLIP_LAYER,
  DEFAULT_COLOR,
  DEFAULT_TRANSFORM,
  type EditProject,
  type TimelineClip,
} from "../domain/types";

export const BEAT_MONTAGE_ENGINE = "editkin-closed-world-beat-montage-compiler/v1" as const;

export interface BeatMontageShotEvidence {
  /** Stable evidence identity. It is not inferred from a filename or an array index. */
  shotId: string;
  assetId: string;
  /** Closed source window that the compiler may trim. */
  sourceStart: number;
  sourceEnd: number;
  /** Caller-supplied, evidence-derived score. The compiler does not invent vision evidence. */
  salience: number;
  /** Narrative order. Candidate input order is deliberately ignored. */
  storyOrder: number;
  /** Optional absolute source time around which the selected window is centred. */
  focusTime?: number;
  volume?: number;
}

export interface BeatMontageCompileRequest {
  targetTrackId: string;
  /** Absolute project times. Every adjacent pair becomes one montage slot. */
  beatTimes: readonly number[];
  candidates: readonly BeatMontageShotEvidence[];
  /** Optional caller-owned ids for durable plan/apply workflows. */
  clipIds?: readonly string[];
}

export interface BeatMontageSelection {
  slot: number;
  clipId: string;
  shotId: string;
  assetId: string;
  salience: number;
  storyOrder: number;
  timelineStart: number;
  sourceStart: number;
  duration: number;
}

export interface CompiledBeatMontage {
  schema: "editkin.beat-montage-plan/v1";
  engine: typeof BEAT_MONTAGE_ENGINE;
  projectId: string;
  projectRevision: number;
  targetTrackId: string;
  beatTimes: number[];
  selections: BeatMontageSelection[];
  command: Extract<EditorCommand, { type: "batch" }>;
  guarantees: {
    shotSelection: true;
    reorderByStoryOrder: true;
    sourceTrim: true;
    cutPointsOnBeat: true;
    pairwiseTransitions: false;
    timeRemap: false;
    splitAudioEdits: false;
  };
}

interface NormalizedCandidate extends BeatMontageShotEvidence {
  sourceStart: number;
  sourceEnd: number;
  focusTime?: number;
}

interface DynamicChoice {
  score: number;
  candidates: NormalizedCandidate[];
  signature: string;
}

const MAX_SLOTS = 64;
const MAX_CANDIDATES = 512;
const SCORE_EPSILON = 1e-12;

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd - 1e-6 && rightStart < leftEnd - 1e-6;
}

function safeIdPart(value: string): string {
  const compact = value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return compact.slice(0, 32) || "shot";
}

function betterChoice(candidate: DynamicChoice, current: DynamicChoice | undefined): boolean {
  if (!current || candidate.score > current.score + SCORE_EPSILON) return true;
  return Math.abs(candidate.score - current.score) <= SCORE_EPSILON && candidate.signature < current.signature;
}

function normalizeBeatTimes(project: EditProject, beatTimes: readonly number[]): number[] {
  if (beatTimes.length < 2 || beatTimes.length > MAX_SLOTS + 1) {
    throw new EditGraphError(`節拍邊界必須介於 2 與 ${MAX_SLOTS + 1} 個`);
  }
  const normalized = beatTimes.map((time) => alignTime(time, project.fps));
  normalized.forEach((time, index) => {
    if (!Number.isFinite(beatTimes[index]) || time < 0) throw new EditGraphError("節拍時間不合法");
    if (index > 0 && time - normalized[index - 1] < 1 / project.fps - 1e-6) {
      throw new EditGraphError("節拍時間必須逐幀遞增");
    }
  });
  return normalized;
}

function normalizeCandidates(project: EditProject, candidates: readonly BeatMontageShotEvidence[]): NormalizedCandidate[] {
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
    throw new EditGraphError(`候選鏡頭必須介於 1 與 ${MAX_CANDIDATES} 個`);
  }
  const shotIds = new Set<string>();
  const assets = new Map(project.assets.map((asset) => [asset.id, asset] as const));
  return candidates.map((candidate): NormalizedCandidate => {
    if (!candidate.shotId.trim() || shotIds.has(candidate.shotId)) throw new EditGraphError("候選 shotId 不可空白或重複");
    shotIds.add(candidate.shotId);
    const asset = assets.get(candidate.assetId);
    if (!asset || asset.kind !== "video") throw new EditGraphError(`蒙太奇候選必須指向現有影片素材：${candidate.assetId}`);
    if (!Number.isFinite(candidate.salience) || candidate.salience < 0 || candidate.salience > 1
      || !Number.isFinite(candidate.storyOrder)
      || !Number.isFinite(candidate.sourceStart) || !Number.isFinite(candidate.sourceEnd)) {
      throw new EditGraphError(`候選鏡頭證據不合法：${candidate.shotId}`);
    }
    const sourceStart = alignTime(candidate.sourceStart, project.fps);
    const sourceEnd = alignTime(candidate.sourceEnd, project.fps);
    if (sourceStart < 0 || sourceEnd - sourceStart < 1 / project.fps - 1e-6 || sourceEnd > asset.duration + 1e-6) {
      throw new EditGraphError(`候選鏡頭來源範圍不合法：${candidate.shotId}`);
    }
    if (candidate.volume !== undefined && (!Number.isFinite(candidate.volume) || candidate.volume < 0 || candidate.volume > 4)) {
      throw new EditGraphError(`候選鏡頭音量不合法：${candidate.shotId}`);
    }
    const focusTime = candidate.focusTime === undefined ? undefined : alignTime(candidate.focusTime, project.fps);
    if (focusTime !== undefined && (!Number.isFinite(candidate.focusTime) || focusTime < sourceStart || focusTime > sourceEnd)) {
      throw new EditGraphError(`候選鏡頭 focusTime 不在來源範圍：${candidate.shotId}`);
    }
    return { ...candidate, sourceStart, sourceEnd, focusTime };
  }).sort((left, right) => left.storyOrder - right.storyOrder || left.shotId.localeCompare(right.shotId));
}

function selectCandidates(candidates: readonly NormalizedCandidate[], slotDurations: readonly number[], fps: number): NormalizedCandidate[] {
  const tolerance = .5 / fps;
  const choices: Array<DynamicChoice | undefined> = Array.from({ length: slotDurations.length + 1 });
  choices[0] = { score: 0, candidates: [], signature: "" };
  for (const candidate of candidates) {
    for (let slot = slotDurations.length - 1; slot >= 0; slot -= 1) {
      const previous = choices[slot];
      if (!previous || candidate.sourceEnd - candidate.sourceStart < slotDurations[slot] - tolerance) continue;
      const selected = [...previous.candidates, candidate];
      const next: DynamicChoice = {
        score: previous.score + candidate.salience,
        candidates: selected,
        signature: selected.map((item) => item.shotId).join("\u0000"),
      };
      if (betterChoice(next, choices[slot + 1])) choices[slot + 1] = next;
    }
  }
  const result = choices[slotDurations.length]?.candidates;
  if (!result) throw new EditGraphError("沒有足夠且時長相容的鏡頭可以填滿所有節拍區間");
  return result;
}

function trimmedSourceStart(candidate: NormalizedCandidate, duration: number, fps: number): number {
  const latest = alignTime(candidate.sourceEnd - duration, fps);
  if (candidate.focusTime === undefined) return candidate.sourceStart;
  const centred = alignTime(candidate.focusTime - duration / 2, fps);
  return Math.max(candidate.sourceStart, Math.min(latest, centred));
}

export function compileBeatAlignedMontage(project: EditProject, request: BeatMontageCompileRequest): CompiledBeatMontage {
  const target = project.tracks.find((track) => track.id === request.targetTrackId);
  if (!target || target.kind !== "video") throw new EditGraphError("蒙太奇目標必須是現有畫面軌");
  if (target.locked) throw new EditGraphError("蒙太奇目標軌道已鎖定");
  const beatTimes = normalizeBeatTimes(project, request.beatTimes);
  const montageStart = beatTimes[0];
  const montageEnd = beatTimes.at(-1)!;
  const conflict = target.clips.find((clip) => overlaps(clip.timelineStart, clip.timelineStart + clip.duration, montageStart, montageEnd));
  if (conflict) throw new EditGraphError(`蒙太奇目標區間與片段重疊：${conflict.id}`);

  const slotDurations = beatTimes.slice(0, -1).map((time, index) => alignTime(beatTimes[index + 1] - time, project.fps));
  const candidates = normalizeCandidates(project, request.candidates);
  const selected = selectCandidates(candidates, slotDurations, project.fps);
  const existingClipIds = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const clipIds = request.clipIds
    ? [...request.clipIds]
    : selected.map((candidate, index) => `montage-${safeIdPart(target.id)}-${index + 1}-${safeIdPart(candidate.shotId)}`);
  if (clipIds.length !== slotDurations.length || clipIds.some((id) => !id.trim())
    || new Set(clipIds).size !== clipIds.length || clipIds.some((id) => existingClipIds.has(id))) {
    throw new EditGraphError("蒙太奇 clipIds 數量、內容或唯一性不合法");
  }

  const clips: TimelineClip[] = selected.map((candidate, slot) => ({
    id: clipIds[slot],
    assetId: candidate.assetId,
    trackId: target.id,
    timelineStart: beatTimes[slot],
    sourceStart: trimmedSourceStart(candidate, slotDurations[slot], project.fps),
    duration: slotDurations[slot],
    volume: candidate.volume ?? 1,
    transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR },
    keyframes: [],
    layer: { ...DEFAULT_CLIP_LAYER },
    expressions: {},
  }));
  const selections = clips.map((clip, slot): BeatMontageSelection => ({
    slot,
    clipId: clip.id,
    shotId: selected[slot].shotId,
    assetId: clip.assetId,
    salience: selected[slot].salience,
    storyOrder: selected[slot].storyOrder,
    timelineStart: clip.timelineStart,
    sourceStart: clip.sourceStart,
    duration: clip.duration,
  }));
  return {
    schema: "editkin.beat-montage-plan/v1",
    engine: BEAT_MONTAGE_ENGINE,
    projectId: project.id,
    projectRevision: project.revision,
    targetTrackId: target.id,
    beatTimes,
    selections,
    command: { type: "batch", commands: clips.map((clip) => ({ type: "add_clip", clip })) },
    guarantees: {
      shotSelection: true,
      reorderByStoryOrder: true,
      sourceTrim: true,
      cutPointsOnBeat: true,
      pairwiseTransitions: false,
      timeRemap: false,
      splitAudioEdits: false,
    },
  };
}

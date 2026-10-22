import * as z from "zod/v4";
import { compileBeatAlignedMontage } from "./beatMontageCompiler";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { EditGraphError } from "../domain/editGraphError";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { compileTimelineTransitionHandlesV1 } from "../domain/timelineTransitionHandlesV1";
import type { EditorCommand } from "../domain/commands";
import { findTransitionPreset } from "../creative/corePack";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";

const id = z.string().trim().min(1).max(128), seconds = z.number().finite().min(0).max(86_400);
const cutIndices = z.array(z.number().int().min(1).max(63)).max(63);
export const beatMontageRequestSchemaV2 = z.strictObject({
  targetTrackId: id,
  idPrefix: id,
  beats: z.array(z.strictObject({ timeSeconds: seconds, energy: z.number().finite().min(0).max(1), downbeat: z.boolean() })).min(2).max(129),
  /** Thresholds are an explicit caller choice, not a new automatic style or family. */
  pace: z.strictObject({ lowThreshold: z.number().finite().min(0).max(1), highThreshold: z.number().finite().min(0).max(1) }),
  candidates: z.array(z.strictObject({ shotId: id, assetId: id, sourceStart: seconds, sourceEnd: seconds,
    salience: z.number().finite().min(0).max(1), storyOrder: z.number().int().min(-1_000_000).max(1_000_000), focusTime: seconds.optional() })).min(1).max(512),
  music: z.strictObject({ assetId: id, trackId: id, clipId: id, sourceStart: seconds,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), rightsEvidenceRefs: z.array(z.string().trim().min(1).max(1024)).min(1).max(16) }),
  pairs: z.strictObject({ kernel: z.enum(["dissolve", "dip"]), beforeFrames: z.number().int().min(0).max(240),
    afterFrames: z.number().int().min(0).max(240), cutIndices }).optional(),
  flashes: z.strictObject({ cutIndices, durationFrames: z.number().int().min(1).max(15) }).optional(),
});
export type BeatMontageRequestV2 = z.infer<typeof beatMontageRequestSchemaV2>;
export const BEAT_MONTAGE_ENGINE_V2 = "editkin-energy-flat-beat-montage-compiler/v2" as const;

/** Energy is caller evidence. This function never relabels onset strength or predicted beats as human truth. */
export function beatMontageClockV2(value: BeatMontageRequestV2, fps: number) {
  const input = beatMontageRequestSchemaV2.parse(value);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240 || input.pace.lowThreshold >= input.pace.highThreshold) throw new EditGraphError("BEAT_MONTAGE_PACE_INVALID");
  const frame = (time: number) => {
    const result = Math.round(time * fps);
    if (!Number.isSafeInteger(result) || result < 0) throw new EditGraphError("BEAT_MONTAGE_CLOCK_UNSAFE");
    return result;
  };
  for (let i = 1; i < input.beats.length; i++) {
    if (input.beats[i].timeSeconds <= input.beats[i - 1].timeSeconds || frame(input.beats[i].timeSeconds) <= frame(input.beats[i - 1].timeSeconds)) throw new EditGraphError("BEAT_MONTAGE_BEATS_NOT_INCREASING");
  }
  const boundaries = [{ frame: frame(input.beats[0].timeSeconds), nominalSeconds: input.beats[0].timeSeconds, beatPosition: 0 }];
  const slots: { beatPosition: number; beatSpan: number; requestedBeatSpan: .5 | 1 | 2; energy: number; startFrame: number; endFrame: number }[] = [];
  const append = (nominal: number, beatPosition: number, requestedBeatSpan: .5 | 1 | 2, energy: number) => {
    const previous = boundaries.at(-1)!, next = frame(nominal);
    if (next <= previous.frame) throw new EditGraphError("BEAT_MONTAGE_SUBDIVISION_BELOW_FRAME_GRID");
    slots.push({ beatPosition: previous.beatPosition, beatSpan: beatPosition - previous.beatPosition, requestedBeatSpan, energy, startFrame: previous.frame, endFrame: next });
    boundaries.push({ frame: next, nominalSeconds: nominal, beatPosition });
    if (slots.length > 64) throw new EditGraphError("BEAT_MONTAGE_SLOT_LIMIT");
  };
  for (let i = 0; i < input.beats.length - 1;) {
    const energy = input.beats[i].energy;
    if (energy >= input.pace.highThreshold) {
      append((input.beats[i].timeSeconds + input.beats[i + 1].timeSeconds) / 2, i + .5, .5, energy);
      append(input.beats[i + 1].timeSeconds, i + 1, .5, energy); i++;
    } else {
      const requested = energy < input.pace.lowThreshold ? 2 : 1, next = Math.min(input.beats.length - 1, i + requested);
      append(input.beats[next].timeSeconds, next, requested, energy); i = next;
    }
  }
  return { boundaries: boundaries.map(b => ({ ...b, timeSeconds: b.frame / fps, quantizationErrorFrames: b.frame - b.nominalSeconds * fps })), slots };
}

function uniqueCutIndices(indices: number[], slots: number) {
  if (new Set(indices).size !== indices.length || indices.some(i => i < 1 || i >= slots)) throw new EditGraphError("BEAT_MONTAGE_CUT_INDEX_INVALID");
  return [...indices].sort((a, b) => a - b);
}

/** W2-5 new opt-in compiler. Emits flat commands; the original compiler, recipes and certified outputs are untouched. */
export function compileBeatAlignedMontageV2(project: EditProject, value: BeatMontageRequestV2) {
  const request = beatMontageRequestSchemaV2.parse(value), clock = beatMontageClockV2(request, project.fps);
  for (const candidate of request.candidates) for (const time of [candidate.sourceStart, candidate.sourceEnd, ...(candidate.focusTime === undefined ? [] : [candidate.focusTime])]) {
    if (Math.abs(time - Math.round(time * project.fps) / project.fps) > 1e-6) throw new EditGraphError("BEAT_MONTAGE_SHOT_EVIDENCE_NOT_ON_FRAME_GRID");
  }
  const videoTrack = project.tracks.find(t => t.id === request.targetTrackId), audioTrack = project.tracks.find(t => t.id === request.music.trackId);
  if (!videoTrack || videoTrack.kind !== "video" || !audioTrack || audioTrack.kind !== "audio") throw new EditGraphError("BEAT_MONTAGE_TRACK_INVALID");
  if (videoTrack.locked || audioTrack.locked) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  if (videoTrack.muted || audioTrack.muted) throw new EditGraphError("BEAT_MONTAGE_TRACK_MUTED");
  const start = clock.boundaries[0].timeSeconds, end = clock.boundaries.at(-1)!.timeSeconds, duration = end - start;
  const musicAsset = project.assets.find(a => a.id === request.music.assetId);
  const musicSource = Math.round(request.music.sourceStart * project.fps) / project.fps;
  if (!musicAsset || musicAsset.kind !== "audio" || !Number.isFinite(musicAsset.duration) || musicSource + duration > musicAsset.duration + 1e-6
    || Math.abs(musicSource - request.music.sourceStart) > 1e-6) throw new EditGraphError("BEAT_MONTAGE_MUSIC_SOURCE_WINDOW_INVALID");
  if (audioTrack.clips.some(c => c.timelineStart < end - 1e-6 && c.timelineStart + c.duration > start + 1e-6)) throw new EditGraphError("BEAT_MONTAGE_MUSIC_TRACK_OCCUPIED");
  if (project.tracks.some(t => t.id !== request.targetTrackId && t.id !== request.music.trackId && !t.muted && t.kind !== "caption"
    && t.clips.some(c => c.volume > 0 && c.layer?.enabled !== false && (c.layer?.role ?? "content") === "content"
      && project.assets.find(a => a.id === c.assetId)?.kind !== "image" && c.timelineStart < end - 1e-6 && c.timelineStart + c.duration > start + 1e-6))) {
    throw new EditGraphError("BEAT_MONTAGE_OTHER_AUDIO_OVERLAP");
  }
  const ids = clock.slots.map((_, i) => `${request.idPrefix}-${i + 1}`);
  if (ids.some(s => s.length > 160) || ids.includes(request.music.clipId)
    || project.tracks.some(t => t.clips.some(c => c.id === request.music.clipId))) throw new EditGraphError("BEAT_MONTAGE_CLIP_ID_CONFLICT");
  const legacy = compileBeatAlignedMontage(project, { targetTrackId: request.targetTrackId,
    beatTimes: clock.boundaries.map(b => b.timeSeconds), candidates: request.candidates.map(c => ({ ...c, volume: 0 })), clipIds: ids });
  const clips = legacy.command.commands.map(c => {
    if (c.type !== "add_clip") throw new EditGraphError("BEAT_MONTAGE_LEGACY_OUTPUT_CHANGED");
    return structuredClone(c.clip);
  });
  // Distinct shot ids must not disguise repeated footage. Filesystem aliases still need material SHA audit.
  const usedWindows = new Map<string, { start: number; end: number }[]>();
  for (const clip of clips) {
    const uri = project.assets.find(a => a.id === clip.assetId)!.uri.replace(/\\/g, "/").toLowerCase();
    const previous = usedWindows.get(uri) ?? [], end = clip.sourceStart + clip.duration;
    if (previous.some(w => clip.sourceStart < w.end - 1e-6 && end > w.start + 1e-6)) throw new EditGraphError("BEAT_MONTAGE_REPEATED_SOURCE_WINDOW");
    previous.push({ start: clip.sourceStart, end }); usedWindows.set(uri, previous);
  }
  const music: TimelineClip = { id: request.music.clipId, assetId: request.music.assetId, trackId: request.music.trackId, timelineStart: start,
    sourceStart: musicSource, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    layer: { ...DEFAULT_CLIP_LAYER }, keyframes: [], expressions: {} };
  const commands: EditorCommand[] = [...clips.map(clip => ({ type: "add_clip" as const, clip })), { type: "add_clip", clip: music }];
  const pairs = request.pairs ? uniqueCutIndices(request.pairs.cutIndices, clips.length).map(index => ({ schema: "editkin.timeline-transition/v1" as const,
    id: `${request.idPrefix}-pair-${index}`, trackId: request.targetTrackId, fromClipId: clips[index - 1].id, toClipId: clips[index].id,
    beforeFrames: request.pairs!.beforeFrames, afterFrames: request.pairs!.afterFrames, kernel: request.pairs!.kernel })) : [];
  if (pairs.length) {
    const virtual = { ...project, tracks: project.tracks.map(t => t.id === request.targetTrackId ? { ...t, clips: [...t.clips, ...clips] } : t),
      timelineTransitions: [...(project.timelineTransitions ?? []), ...pairs] };
    const plans = compileTimelineTransitionHandlesV1(virtual);
    const evidence = new Map(request.candidates.map(c => [c.shotId, c]));
    for (const p of plans.filter(p => pairs.some(t => t.id === p.transition.id))) for (const side of [p.from, p.to]) {
      const selection = legacy.selections.find(s => s.clipId === side.clipId)!, allowed = evidence.get(selection.shotId)!;
      if (side.sourceStartSeconds < allowed.sourceStart - 1e-6 || side.sourceStartSeconds + side.sourceDurationSeconds > allowed.sourceEnd + 1e-6) throw new EditGraphError("BEAT_MONTAGE_TRANSITION_OUTSIDE_SHOT_EVIDENCE");
    }
    commands.push(...pairs.map(transition => ({ type: "set_timeline_transition" as const, transition })));
  }
  const flashFrames = request.flashes ? uniqueCutIndices(request.flashes.cutIndices, clips.length).map(index => ({ index, frame: clock.boundaries[index].frame })) : [];
  if (flashFrames.length) {
    initializeStudioCreativeAssets();
    findTransitionPreset("cine_proof_flash");
    let first = 0;
    for (let i = 0; i < flashFrames.length; i++) {
      while (flashFrames[i].frame - flashFrames[first].frame >= project.fps - 1e-9) first++;
      if (i - first + 1 > 3) throw new EditGraphError("BEAT_MONTAGE_FLASH_RATE_EXCEEDS_THREE");
      if (request.flashes!.durationFrames > clock.slots[flashFrames[i].index].endFrame - flashFrames[i].frame
        || i > 0 && flashFrames[i].frame - flashFrames[i - 1].frame < request.flashes!.durationFrames) throw new EditGraphError("BEAT_MONTAGE_FLASH_WINDOW_OVERLAP");
    }
    commands.push(...flashFrames.map(f => ({ type: "set_clip_creative" as const, clipId: clips[f.index].id,
      patch: { transitionIn: { presetId: "cine_proof_flash", duration: request.flashes!.durationFrames / project.fps } } })));
  }
  if (commands.length > 100) throw new EditGraphError("BEAT_MONTAGE_FLAT_COMMAND_LIMIT");
  return { schema: "editkin.beat-montage-plan/v2" as const, engine: BEAT_MONTAGE_ENGINE_V2, projectId: project.id, projectRevision: project.revision,
    targetTrackId: request.targetTrackId, clock, selections: legacy.selections, commands, music: { ...request.music, timelineStart: start, duration }, pairs,
    flashEvents: flashFrames.map(f => ({ ...f, timeSeconds: f.frame / project.fps })),
    audioHitHooks: request.beats.filter(b => b.downbeat && Math.round(b.timeSeconds * project.fps) >= clock.boundaries[0].frame
      && Math.round(b.timeSeconds * project.fps) < clock.boundaries.at(-1)!.frame).map(b => ({ frame: Math.round(b.timeSeconds * project.fps),
      timeSeconds: Math.round(b.timeSeconds * project.fps) / project.fps, nominalTimeSeconds: b.timeSeconds, energy: b.energy, soundAsset: null })),
    guarantees: { flatCommands: true, sourceOriginalAudioMuted: true, musicSourceWindowBounded: true, uniqueShotEvidence: true,
      storyOrderPreserved: true, halfFrameMaximumCutQuantization: true, authoredFlashRateMaximumThreePerSecond: true,
      pairSourceHandlesValidated: true, timeRemap: false, soundEffectsResolved: false, wholePixelFlashSafety: false },
    evidenceAuthority: "caller_asserted_energy_beats_shots_music_rights_unverified" as const,
    qualityState: "ART_PENDING_CLAUDE" as const, defaultEnabled: false, certificationPerformed: false,
    directApplyAllowed: false, executionBoundary: "compile_only_existing_plan_audit_atomic_apply_required" as const };
}

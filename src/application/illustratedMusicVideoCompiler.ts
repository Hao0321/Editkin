import type { EditorCommand } from "../domain/commandTypes";
import { alignTime, EditGraphError } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MediaAsset, type TimelineClip, type Transform2D } from "../domain/types";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { assertMotionGraphicV2Contract } from "../domain/motionCompositionV2Contract";
import { motionGraphicV2LayoutReceipt } from "../motion/compositionV2";
import type { EditorialPlan } from "./editorialPlan";
import { motionPresetSeedSha256 } from "./motionPresetVariant";
import { findEffectPreset, findTransitionPreset } from "../creative/corePack";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";

export const ILLUSTRATED_MV_ENGINE = "editkin-illustrated-mv-compiler/v1" as const;

export interface IllustratedMvSection {
  id: string;
  start: number;
  end: number;
  role: "intro" | "verse" | "chorus" | "break" | "outro";
  framing: "wide" | "close";
  backgroundAssetId: string;
  characterAssetId: string;
  /** Verified phrase/downbeat reference, supplied by the authoring agent. */
  musicEvidenceRef: string;
  /** Optional brief silhouette-to-color reveal on this section's opening beat. */
  silhouetteRevealFrames?: number;
  /** Optional scene-grade effect, kept on the background layer. */
  backgroundEffect?: "none" | "night_depth" | "dawn_bloom";
  /** Verified beat offsets within this section; each gets editable actor hit/release keys. */
  beatAccentFrames?: number[];
  beatAccentEvidenceRefs?: string[];
  entryTransition?: "cut" | "character_slide_left" | "character_slide_right" | "accent_flash";
  transitionEvidenceRefs?: [string, string];
  /** Short transparent foreground flourish, timed to an observed musical accent. */
  foregroundAccent?: { assetId: string; startFrame: number; durationFrames: number; evidenceRef: string };
  /** Explicit composition of a verified wide art cel; keeps the character clear of spatial type. */
  characterFrame?: { x: number; scale: number; evidenceRef: string };
}

export interface IllustratedMvWordCue {
  id: string;
  text: string;
  start: number;
  end: number;
  kind: "title" | "lyric";
  placement: "left" | "right" | "top";
  /** Ink type preserves contrast on bright skies. */
  tone?: "light" | "ink";
  /** An impact cue enters as one enlarged phrase on a verified musical accent. */
  treatment?: "cascade" | "impact" | "ripple";
  /** A lyric requires a verified lyric source; a title requires a brief reference. */
  evidenceRef: string;
}

export interface IllustratedMvRequest {
  musicClipId: string;
  backgroundTrackId: string;
  characterTrackId: string;
  silhouetteTrackId: string;
  foregroundTrackId?: string;
  sections: readonly IllustratedMvSection[];
  wordCues?: readonly IllustratedMvWordCue[];
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const overlaps = (a: number, b: number, c: number, d: number) => a < d - 1e-6 && c < b - 1e-6;

function imageAsset(project: EditProject, assetId: string, layer: "background" | "character" | "foreground"): MediaAsset {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset || asset.kind !== "image" || !asset.provenance?.trim() || !(asset.license?.trim() || asset.rightsBasis?.trim())) {
    throw new EditGraphError(`ILLUSTRATED_ART_REQUIRED：${assetId} 必須是有來源及使用權記錄的插畫圖片`);
  }
  const artWidth = asset.width ?? 0;
  const artHeight = asset.height ?? 0;
  const aspectError = artHeight > 0
    ? Math.abs(artWidth * project.height - artHeight * project.width) / (artHeight * project.width)
    : Infinity;
  if (artWidth < project.width || artHeight < project.height || aspectError > .015) {
    throw new EditGraphError(`ART_CANVAS_REQUIRED：${assetId} 需有相同畫幅、至少 ${project.width}×${project.height} 的完整畫布`);
  }
  if (layer !== "background" && asset.alphaMode !== "straight" && asset.alphaMode !== "premultiplied") {
    throw new EditGraphError(`${layer === "character" ? "CHARACTER" : "FOREGROUND"}_ALPHA_REQUIRED：${assetId} 必須有透明圖層`);
  }
  return asset;
}

function assertMusic(project: EditProject, clipId: string, start: number, end: number): void {
  const track = project.tracks.find(item => item.kind === "audio" && item.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(item => item.id === clipId);
  const asset = project.assets.find(item => item.id === clip?.assetId);
  if (!track || track.muted || !clip || !asset || asset.kind !== "audio" || clip.volume <= 0
    || clip.timelineStart > start + 1e-6 || clip.timelineStart + clip.duration < end - 1e-6) {
    throw new EditGraphError("MUSIC_BED_REQUIRED：需有未靜音且覆蓋整段的歌曲聲軌");
  }
}

function keyframe(clip: TimelineClip, frame: number, fps: number, transform: Transform2D, easing: "ease_out" | "ease_in_out"): EditorCommand {
  return { type: "add_keyframe", clipId: clip.id, keyframe: {
    id: `${clip.id}-f${frame}`, time: frame / fps, transform, color: { ...clip.color }, easing,
  } };
}

/** A read-only, editable two-layer animation draft. Asset generation and beat verification remain authoring steps. */
export function compileIllustratedMusicVideo(project: EditProject, request: IllustratedMvRequest) {
  const sections = request.sections;
  if (!sections.length || sections.length > 12) throw new EditGraphError("ILLUSTRATED_SECTIONS_REQUIRED：請提供 1–12 個樂段");
  const backgroundTrack = project.tracks.find(track => track.id === request.backgroundTrackId);
  const characterTrack = project.tracks.find(track => track.id === request.characterTrackId);
  const silhouetteTrack = project.tracks.find(track => track.id === request.silhouetteTrackId);
  const foregroundRequired = sections.some(section => Boolean(section.foregroundAccent));
  const foregroundTrackId = request.foregroundTrackId ?? "mv-foreground";
  const foregroundTrack = project.tracks.find(track => track.id === foregroundTrackId);
  if (!backgroundTrack || backgroundTrack.kind !== "video" || backgroundTrack.locked || backgroundTrack.muted
    || new Set([request.backgroundTrackId, request.characterTrackId, request.silhouetteTrackId,
      ...(foregroundRequired ? [foregroundTrackId] : [])]).size !== (foregroundRequired ? 4 : 3)
    || (characterTrack && (characterTrack.kind !== "video" || characterTrack.locked || characterTrack.muted))
    || (silhouetteTrack && (silhouetteTrack.kind !== "video" || silhouetteTrack.locked || silhouetteTrack.muted))
    || (foregroundRequired && foregroundTrack && (foregroundTrack.kind !== "video" || foregroundTrack.locked || foregroundTrack.muted))) {
    throw new EditGraphError("ILLUSTRATED_TRACK_REQUIRED：需有可寫入的背景軌與獨立角色軌");
  }
  if (project.fps < 24 || project.fps > 60) throw new EditGraphError("ILLUSTRATED_FPS_UNSUPPORTED：需要 24–60 fps");

  const usedIds = new Set<string>();
  const start = alignTime(sections[0].start, project.fps);
  const end = alignTime(sections.at(-1)!.end, project.fps);
  assertMusic(project, request.musicClipId, start, end);
  const commands: EditorCommand[] = [];
  if (!characterTrack) commands.push({ type: "add_track", track: {
    id: request.characterTrackId, name: "MV · 插畫角色", kind: "video", locked: false, muted: false, clips: [],
  } });
  if (sections.some(section => section.silhouetteRevealFrames) && !silhouetteTrack) commands.push({ type: "add_track", track: {
    id: request.silhouetteTrackId, name: "MV · 剪影揭露", kind: "video", locked: false, muted: false, clips: [],
  } });
  if (foregroundRequired && !foregroundTrack) commands.push({ type: "add_track", track: {
    id: foregroundTrackId, name: "MV · 前景光效", kind: "video", locked: false, muted: false, clips: [],
  } });

  let cursor = start;
  for (const [index, section] of sections.entries()) {
    if (!ID.test(section.id) || usedIds.has(section.id) || !section.musicEvidenceRef.trim() || section.musicEvidenceRef.length > 160) {
      throw new EditGraphError(`樂段 id 或音樂證據不合法：${section.id}`);
    }
    usedIds.add(section.id);
    const sceneStart = alignTime(section.start, project.fps);
    const sceneEnd = alignTime(section.end, project.fps);
    const frames = Math.round((sceneEnd - sceneStart) * project.fps);
    if (Math.abs(sceneStart - section.start) > 1e-6 || Math.abs(sceneEnd - section.end) > 1e-6
      || Math.abs(sceneStart - cursor) > 1e-6 || frames < 18 || frames > 900) {
      throw new EditGraphError(`樂段必須逐格連續、長 18–900 格：${section.id}`);
    }
    cursor = sceneEnd;
    const revealFrames = section.silhouetteRevealFrames ?? 0;
    if (!Number.isInteger(revealFrames) || revealFrames < 0 || revealFrames > Math.min(24, Math.floor(frames / 2))) {
      throw new EditGraphError(`剪影揭露必須是樂段前半的 0–24 格：${section.id}`);
    }
    const entryTransition = section.entryTransition ?? "cut";
    if (entryTransition !== "cut" && (index === 0 || section.transitionEvidenceRefs?.length !== 2
      || section.transitionEvidenceRefs.some(ref => !ref.trim() || ref.length > 160))) {
      throw new EditGraphError(`角色轉場需切點兩側證據：${section.id}`);
    }
    const accents = section.beatAccentFrames ?? [];
    if (accents.length > 8 || accents.some((frame, offset) => !Number.isInteger(frame)
      || frame < 10 || frame + 7 >= frames || (offset > 0 && frame - accents[offset - 1] < 8))
      || (accents.length > 0 && (section.beatAccentEvidenceRefs?.length !== accents.length
        || section.beatAccentEvidenceRefs.some(ref => !ref.trim() || ref.length > 160)))) {
      throw new EditGraphError(`角色節拍重音需有逐格位置及等量音樂證據：${section.id}`);
    }
    const background = imageAsset(project, section.backgroundAssetId, "background");
    const character = imageAsset(project, section.characterAssetId, "character");
    const characterFrame = section.characterFrame;
    if (characterFrame && (!Number.isFinite(characterFrame.x) || Math.abs(characterFrame.x) > project.width / 2
      || !Number.isFinite(characterFrame.scale) || characterFrame.scale < .5 || characterFrame.scale > 2
      || !characterFrame.evidenceRef?.trim() || characterFrame.evidenceRef.length > 160)) {
      throw new EditGraphError(`角色構圖需有合法位置、縮放及美術證據：${section.id}`);
    }
    const accent = section.foregroundAccent;
    if (accent && (!Number.isInteger(accent.startFrame) || !Number.isInteger(accent.durationFrames)
      || accent.startFrame < 0 || accent.durationFrames < 12 || accent.durationFrames > 60
      || accent.startFrame + accent.durationFrames > frames || !accent.evidenceRef.trim() || accent.evidenceRef.length > 160)) {
      throw new EditGraphError(`前景光效需有逐格範圍及音樂證據：${section.id}`);
    }
    const foreground = accent ? imageAsset(project, accent.assetId, "foreground") : undefined;
    if (background.duration + 1e-6 < section.end - section.start || character.duration + 1e-6 < section.end - section.start) {
      throw new EditGraphError(`插畫素材可用長度不足：${section.id}`);
    }
    if (foreground && foreground.duration + 1e-6 < accent!.durationFrames / project.fps) {
      throw new EditGraphError(`前景光效素材可用長度不足：${section.id}`);
    }
    for (const track of [backgroundTrack, characterTrack, silhouetteTrack, foregroundRequired ? foregroundTrack : undefined]
      .filter((value): value is NonNullable<typeof value> => Boolean(value))) {
      if (track.clips.some(clip => overlaps(sceneStart, sceneEnd, clip.timelineStart, clip.timelineStart + clip.duration))) {
        throw new EditGraphError(`MV 目標軌已有片段：${track.id}`);
      }
    }
    const makeClip = (id: string, assetId: string, trackId: string): TimelineClip => ({
      id, assetId, trackId, timelineStart: sceneStart, sourceStart: 0, duration: sceneEnd - sceneStart,
      volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
    });
    const bg = makeClip(`mv-bg-${section.id}`, background.id, request.backgroundTrackId);
    const actor = makeClip(`mv-actor-${section.id}`, character.id, request.characterTrackId);
    if (project.tracks.some(track => track.clips.some(clip => clip.id === bg.id || clip.id === actor.id))) {
      throw new EditGraphError(`MV 片段 id 重複：${section.id}`);
    }
    commands.push({ type: "add_clip", clip: bg }, { type: "add_clip", clip: actor });
    if (section.backgroundEffect && section.backgroundEffect !== "none") {
      const effectId = section.backgroundEffect === "night_depth" ? "studio_night_depth" : "high_key_bloom";
      initializeStudioCreativeAssets();
      findEffectPreset(effectId);
      commands.push({ type: "set_clip_creative", clipId: bg.id, patch: { effectPresetIds: [effectId] } });
    }
    const energetic = section.role === "chorus" || section.role === "break";
    const close = section.framing === "close";
    const sway = index % 2 === 0 ? 1 : -1;
    const bgBase = { ...DEFAULT_TRANSFORM, scale: close ? 1.08 : 1.03, x: -8 * sway };
    const actorBase = { ...DEFAULT_TRANSFORM, scale: characterFrame?.scale ?? (close ? 1.13 : 1.0),
      x: characterFrame?.x ?? (close ? -30 : -8 * sway) };
    if (entryTransition === "accent_flash") {
      initializeStudioCreativeAssets();
      const preset = findTransitionPreset("cine_proof_flash");
      commands.push({ type: "set_clip_creative", clipId: bg.id,
        patch: { transitionIn: { presetId: preset.id, duration: Math.min(4, Math.floor(frames / 4)) / project.fps } } });
    } else if (entryTransition !== "cut") {
      initializeStudioCreativeAssets();
      const preset = findTransitionPreset(entryTransition === "character_slide_left" ? "cine_left_slide_fade" : "cine_right_slide_fade");
      commands.push({ type: "set_clip_creative", clipId: actor.id,
        patch: { transitionIn: { presetId: preset.id, duration: Math.min(6, Math.floor(frames / 4)) / project.fps } } });
    }
    commands.push(
      keyframe(bg, 0, project.fps, bgBase, "ease_in_out"),
      keyframe(bg, frames, project.fps, { ...bgBase, x: (energetic ? 16 : 8) * sway }, "ease_in_out"),
      keyframe(actor, 0, project.fps, { ...actorBase, y: energetic ? 18 : 10 }, "ease_out"),
      keyframe(actor, Math.min(8, Math.floor(frames / 3)), project.fps,
        { ...actorBase, y: -5 }, "ease_out"),
      keyframe(actor, frames, project.fps,
        { ...actorBase, x: actorBase.x + (energetic ? 20 : 13) * sway, y: 0 }, "ease_in_out"),
    );
    for (const frame of accents) {
      commands.push(
        keyframe(actor, frame, project.fps, { ...actorBase, y: -14 }, "ease_out"),
        keyframe(actor, frame + 3, project.fps, { ...actorBase, y: 4 }, "ease_out"),
        keyframe(actor, frame + 7, project.fps, { ...actorBase, y: -5 }, "ease_in_out"),
      );
    }
    if (revealFrames) {
      const silhouette = makeClip(`mv-silhouette-${section.id}`, character.id, request.silhouetteTrackId);
      silhouette.duration = revealFrames / project.fps;
      // Keep the source artwork's soft alpha edge while reducing its RGB to a
      // dark silhouette. Contrast 0.1 is the lowest legal Editkin value.
      silhouette.color = { ...DEFAULT_COLOR, brightness: -1, contrast: 0.1, saturation: 0 };
      commands.push({ type: "add_clip", clip: silhouette },
        keyframe(silhouette, 0, project.fps, { ...actorBase, y: energetic ? 18 : 10 }, "ease_out"),
        keyframe(silhouette, Math.max(1, revealFrames - 4), project.fps, { ...actorBase, y: -5 }, "ease_out"),
        keyframe(silhouette, revealFrames, project.fps, { ...actorBase, y: -5, opacity: 0 }, "ease_out"));
    }
    if (accent && foreground) {
      const flourish = makeClip(`mv-foreground-${section.id}`, foreground.id, foregroundTrackId);
      flourish.timelineStart = sceneStart + accent.startFrame / project.fps;
      flourish.duration = accent.durationFrames / project.fps;
      const endFrame = accent.durationFrames;
      const flourishBase = { ...DEFAULT_TRANSFORM, scale: 1.02, x: -12 * sway };
      commands.push({ type: "add_clip", clip: flourish },
        keyframe(flourish, 0, project.fps, { ...flourishBase, opacity: 0 }, "ease_out"),
        keyframe(flourish, 3, project.fps, { ...flourishBase, opacity: .42 }, "ease_out"),
        keyframe(flourish, endFrame - 4, project.fps, { ...flourishBase, x: 10 * sway, opacity: .42 }, "ease_in_out"),
        keyframe(flourish, endFrame, project.fps, { ...flourishBase, x: 16 * sway, opacity: 0 }, "ease_in_out"));
    }
  }

  const editorialGraphics: EditorialPlan["graphics"] = [];
  if ((request.wordCues?.length ?? 0) > 24) throw new EditGraphError("單次圖形文字不可超過 24 個");
  for (const cue of request.wordCues ?? []) {
    const text = cue.text.trim();
    const cueStart = alignTime(cue.start, project.fps);
    const cueEnd = alignTime(cue.end, project.fps);
    const frames = Math.round((cueEnd - cueStart) * project.fps);
    if (!ID.test(cue.id) || usedIds.has(cue.id) || !text || [...text].length > 16 || /\r|\n/u.test(text)
      || !cue.evidenceRef.trim() || cue.evidenceRef.length > 160 || cueStart < start || cueEnd > end
      || Math.abs(cueStart - cue.start) > 1e-6 || Math.abs(cueEnd - cue.end) > 1e-6 || frames < 10) {
      throw new EditGraphError(`MV 圖形文字、時間或來源不合法：${cue.id}`);
    }
    if (cue.kind === "lyric" && project.captions.some(caption => overlaps(cueStart, cueEnd, caption.start, caption.start + caption.duration))) {
      throw new EditGraphError(`歌詞與既有字幕重疊：${cue.id}`);
    }
    usedIds.add(cue.id);
    const presetId = cue.treatment === "impact" ? "mv_illustrated_word_impact"
      : cue.treatment === "ripple" ? "mv_illustrated_word_ripple"
      : frames < 30 ? "mv_illustrated_word_fast" : "mv_illustrated_word";
    const preset = findMotionGraphicPreset(presetId);
    const placement = cue.placement === "left" ? { x: .08, y: .25, width: .4 }
      : cue.placement === "top" ? { x: .31, y: .08, width: .61 } : { x: .57, y: .34, width: .36 };
    const ink = cue.tone === "ink" ? { textColor: "#18264A", accentColor: "#FFF0DA" } : {};
    const overrides = { ...placement, ...ink };
    const seed = { ...preset.seed, ...overrides };
    const id = `mv-word-${cue.id}`;
    const graphic = createMotionGraphic(id, "title", text, cueStart, cueEnd - cueStart, undefined, seed);
    assertMotionGraphicV2Contract(graphic, project.fps);
    motionGraphicV2LayoutReceipt(project, graphic);
    commands.push({ type: "add_motion_graphic", graphic });
    const presetVariant = cue.placement === "right" && cue.tone !== "ink" ? undefined : {
      schema: "editkin.motion-preset-variant/v1" as const, basePresetSha256: motionPresetSeedSha256(preset),
      reason: `Illustrated MV ${cue.placement} negative-space typography and ${cue.tone ?? "light"} contrast`, overrides,
    };
    editorialGraphics.push({ id, presetId, ...(presetVariant ? { presetVariant } : {}),
      range: { startFrame: Math.round(cueStart * project.fps), endFrame: Math.round(cueEnd * project.fps) },
      kind: cue.kind === "lyric" ? "lyric_line" : "title_card", purpose: "context", message: text, evidenceRefs: [cue.evidenceRef] });
  }
  return {
    schema: "editkin.illustrated-music-video-draft/v1" as const, engine: ILLUSTRATED_MV_ENGINE,
    status: "DRAFT_COMMAND_CANDIDATE" as const, mutationPerformed: false as const, directApplyAllowed: false as const,
    evidenceAuthority: "caller_asserted_unverified" as const, projectId: project.id, projectRevision: project.revision,
    musicClipId: request.musicClipId, sections, commands, editorialGraphics,
    guarantees: { imageLayerOnly: true, characterAlphaRequired: true, frameAligned: true, musicContinuous: true,
      editableCharacterAndBackground: true, editableSilhouette: true, editableForeground: foregroundRequired,
      editableTypography: true, automaticAssetGeneration: false,
      verifiedBeatGrid: false, humanArtApproval: false } as const,
    next: "Verify source art, song and phrase receipts. Bind these flat commands and editorial events to one v4 plan, audit, atomic apply, render, inspect every scene and seek Hao art review.",
  };
}

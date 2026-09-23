import type { AutomaticCaptionCue } from "./automaticCaptions";
import type { EditorCommand } from "../domain/commands";
import { alignTime } from "../domain/editGraph";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type MotionTrack, type NormalizedRect, type TimelineClip } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";

export type PodcastShotMode = "host" | "guest" | "split";

export interface PodcastShot {
  start: number;
  end: number;
  mode: PodcastShotMode;
  confidence: number;
}

function meanActivity(track: MotionTrack, index: number): number {
  const from = Math.max(0, index - 2);
  const to = Math.min(track.points.length - 1, index + 2);
  let sum = 0;
  let weight = 0;
  for (let cursor = from; cursor <= to; cursor += 1) {
    const point = track.points[cursor];
    if (point.status === "lost") continue;
    const pointWeight = Math.max(0, Math.min(1, point.confidence));
    sum += (point.activity ?? 0) * pointWeight;
    weight += pointWeight;
  }
  return weight ? sum / weight : 0;
}

function nearestPointIndex(track: MotionTrack, time: number): number {
  return Math.max(0, Math.min(track.points.length - 1, Math.round(time * track.analysisFps)));
}

function speechAt(cues: AutomaticCaptionCue[], time: number): boolean {
  return cues.some((cue) => time >= cue.start - 0.12 && time <= cue.end + 0.12 && cue.text.trim());
}

function classifyFrame(host: MotionTrack, guest: MotionTrack, cues: AutomaticCaptionCue[], time: number, previous: PodcastShotMode): { mode: PodcastShotMode; confidence: number } {
  if (!speechAt(cues, time)) return { mode: "split", confidence: 0.35 };
  const hostPoint = host.points[nearestPointIndex(host, time)];
  const guestPoint = guest.points[nearestPointIndex(guest, time)];
  if (!hostPoint || !guestPoint || hostPoint.status === "lost" || guestPoint.status === "lost") return { mode: "split", confidence: 0.2 };
  const hostScore = meanActivity(host, nearestPointIndex(host, time)) * hostPoint.confidence;
  const guestScore = meanActivity(guest, nearestPointIndex(guest, time)) * guestPoint.confidence;
  const total = hostScore + guestScore;
  const difference = Math.abs(hostScore - guestScore);
  if (total < 0.008 || difference < Math.max(0.0035, total * 0.18)) return { mode: "split", confidence: 0.42 };
  const leader: PodcastShotMode = hostScore > guestScore ? "host" : "guest";
  const leaderScore = Math.max(hostScore, guestScore);
  const followerScore = Math.min(hostScore, guestScore);
  if (previous !== "split" && previous !== leader && leaderScore < followerScore * 1.55) {
    return { mode: previous, confidence: 0.5 };
  }
  return { mode: leader, confidence: Math.max(0.5, Math.min(0.98, difference / Math.max(total, 1e-6))) };
}

export function planPodcastShots(input: {
  duration: number;
  fps: number;
  host: MotionTrack;
  guest: MotionTrack;
  cues: AutomaticCaptionCue[];
  minimumShot?: number;
}): PodcastShot[] {
  if (input.duration <= 0 || !input.host.points.length || !input.guest.points.length) throw new Error("雙人物導播需要有效時長與兩組追蹤資料");
  const sampleFps = Math.max(1, Math.min(input.host.analysisFps, input.guest.analysisFps, 10));
  const step = 1 / sampleFps;
  const frames: Array<{ time: number; mode: PodcastShotMode; confidence: number }> = [];
  let previous: PodcastShotMode = "split";
  for (let time = 0; time < input.duration; time += step) {
    const classified = classifyFrame(input.host, input.guest, input.cues, time, previous);
    frames.push({ time, ...classified });
    previous = classified.mode;
  }
  const shots: PodcastShot[] = [];
  for (const frame of frames) {
    const current = shots.at(-1);
    if (!current || current.mode !== frame.mode) {
      shots.push({ start: frame.time, end: Math.min(input.duration, frame.time + step), mode: frame.mode, confidence: frame.confidence });
    } else {
      current.end = Math.min(input.duration, frame.time + step);
      current.confidence = Math.min(current.confidence, frame.confidence);
    }
  }
  if (shots.length) shots[shots.length - 1].end = input.duration;
  const minimumShot = input.minimumShot ?? 1.2;
  for (let index = 0; index < shots.length && shots.length > 1;) {
    const shot = shots[index];
    if (shot.mode === "split") { index += 1; continue; }
    if (shot.end - shot.start >= minimumShot) { index += 1; continue; }
    if (index === 0) {
      shots[1].start = shot.start;
      shots[1].confidence = Math.min(shots[1].confidence, shot.confidence);
      shots.splice(0, 1);
    } else {
      shots[index - 1].end = shot.end;
      shots[index - 1].confidence = Math.min(shots[index - 1].confidence, shot.confidence);
      shots.splice(index, 1);
    }
  }
  return shots.map((shot) => ({ ...shot, start: alignTime(shot.start, input.fps), end: alignTime(shot.end, input.fps) }))
    .filter((shot) => shot.end > shot.start);
}

function rectAt(track: MotionTrack, time: number): NormalizedRect {
  return track.points[nearestPointIndex(track, time)]?.rect ?? track.initialRect;
}

function cropAround(rect: NormalizedRect, sourceAspect: number, targetAspect: number): NormalizedRect {
  const ratio = targetAspect / sourceAspect;
  let width = Math.max(rect.width * 2.2, 0.22);
  let height = width / Math.max(ratio, 1e-6);
  if (height < rect.height * 2) {
    height = Math.max(rect.height * 2, 0.28);
    width = height * ratio;
  }
  if (width > 1) { width = 1; height = Math.min(1, width / Math.max(ratio, 1e-6)); }
  if (height > 1) { height = 1; width = Math.min(1, height * ratio); }
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return {
    x: Math.max(0, Math.min(1 - width, centerX - width / 2)),
    y: Math.max(0, Math.min(1 - height, centerY - height / 2)),
    width,
    height,
  };
}

export function buildPodcastDirectorCommand(input: {
  project: EditProject;
  clip: TimelineClip;
  host: MotionTrack;
  guest: MotionTrack;
  cues: AutomaticCaptionCue[];
  idFactory: (kind: string, index: number) => string;
}): { command: EditorCommand; shots: PodcastShot[]; uncertainShots: number } {
  const asset = input.project.assets.find((item) => item.id === input.clip.assetId);
  if (!asset || asset.kind !== "video") throw new Error("雙人物導播只能套用在影片片段");
  const shots = planPodcastShots({ duration: input.clip.duration, fps: input.project.fps, host: input.host, guest: input.guest, cues: input.cues });
  const primaryTrackId = input.idFactory("podcast-primary", 0);
  const secondaryTrackId = input.idFactory("podcast-secondary", 0);
  const commands: EditorCommand[] = [
    { type: "add_track", track: { id: primaryTrackId, name: "Podcast 導播主畫面", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "add_track", track: { id: secondaryTrackId, name: "Podcast 雙人畫面", kind: "video", locked: false, muted: false, clips: [] } },
    { type: "update_clip_transform", clipId: input.clip.id, patch: { opacity: 0 } },
  ];
  const sourceAspect = (asset.width ?? input.project.width) / (asset.height ?? input.project.height);
  const projectAspect = input.project.width / input.project.height;
  let clipIndex = 0;
  const addShotClip = (shot: PodcastShot, role: "host" | "guest", trackId: string, viewport: NormalizedRect) => {
    const track = role === "host" ? input.host : input.guest;
    const midpoint = (shot.start + shot.end) / 2;
    const layoutAspect = projectAspect * viewport.width / viewport.height;
    commands.push({ type: "add_clip", clip: {
      id: input.idFactory(`podcast-${role}`, clipIndex++), assetId: input.clip.assetId, trackId,
      timelineStart: alignTime(input.clip.timelineStart + shot.start, input.project.fps),
      sourceStart: alignTime(input.clip.sourceStart + shot.start, input.project.fps),
      duration: alignTime(shot.end - shot.start, input.project.fps), volume: 0,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      creative: input.clip.creative ? structuredClone(input.clip.creative) : undefined,
      layout: { crop: cropAround(rectAt(track, midpoint), sourceAspect, layoutAspect), viewport },
    } });
  };
  for (const shot of shots) {
    if (shot.mode === "split") {
      addShotClip(shot, "host", primaryTrackId, { x: 0, y: 0, width: 1, height: 0.5 });
      addShotClip(shot, "guest", secondaryTrackId, { x: 0, y: 0.5, width: 1, height: 0.5 });
    } else {
      addShotClip(shot, shot.mode, primaryTrackId, { x: 0, y: 0, width: 1, height: 1 });
    }
  }
  input.cues.filter((cue) => cue.text.trim()).forEach((cue, index) => commands.push({ type: "add_caption", caption: {
    id: input.idFactory("podcast-caption", index), text: cue.text.trim(),
    start: alignTime(input.clip.timelineStart + cue.start, input.project.fps),
    duration: Math.max(1 / input.project.fps, alignTime(cue.end - cue.start, input.project.fps)),
  } }));
  const hostTag = createMotionGraphic(input.idFactory("podcast-host-tag", 0), "tag", "H 主持人", input.clip.timelineStart, input.clip.duration, input.host.id);
  Object.assign(hostTag, { backgroundColor: "#315CFFEE", accentColor: "#77E4FF", textColor: "#FFFFFF" });
  const guestTag = createMotionGraphic(input.idFactory("podcast-guest-tag", 0), "tag", "G 來賓", input.clip.timelineStart, input.clip.duration, input.guest.id);
  Object.assign(guestTag, { backgroundColor: "#8BFF58EE", accentColor: "#00E676", textColor: "#07110A" });
  commands.push({ type: "add_motion_graphic", graphic: hostTag }, { type: "add_motion_graphic", graphic: guestTag });
  const uncertainShots = shots.filter((shot) => shot.mode === "split").length;
  commands.push({ type: "add_director_marker", marker: {
    id: input.idFactory("podcast-receipt", 0), time: input.clip.timelineStart, title: "雙人物導播已建立",
    note: `${shots.length} 個鏡位；${uncertainShots} 個區間因證據不足保留雙人畫面。visual-activity heuristic，不冒充聲紋 diarization。`,
    kind: uncertainShots ? "risk" : "note", status: "open", createdAt: new Date().toISOString(),
  } });
  return { command: { type: "batch", commands }, shots, uncertainShots };
}

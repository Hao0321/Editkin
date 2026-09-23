import { findClip } from "../domain/editGraph";
import { motionTrackPoseAt } from "../domain/motionTrackSampling";
import type { EditProject, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed } from "../domain/types";

export { trackRectAt } from "../domain/motionTrackSampling";

export interface MotionGraphicFrame {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  opacity: number;
  scale: number;
  rotationDegrees: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function motionGraphicFrame(project: EditProject, graphic: MotionGraphic, playhead: number): MotionGraphicFrame {
  const timelineFrame = Math.round(playhead * project.fps);
  const timelineStartFrame = Math.round(graphic.timelineStart * project.fps);
  const durationFrames = Math.max(1, Math.round(graphic.duration * project.fps));
  const localFrame = timelineFrame - timelineStartFrame;
  const visible = localFrame >= 0 && localFrame < durationFrames;
  if (!visible) return { visible: false, x: graphic.x, y: graphic.y, width: graphic.width, opacity: 0, scale: 1, rotationDegrees: 0 };
  const sampledPlayhead = timelineFrame / project.fps;
  let x = graphic.x;
  let y = graphic.y;
  let trackedScale = 1;
  let rotationDegrees = 0;
  if (graphic.trackId) {
    const track = project.motionTracks.find((item) => item.id === graphic.trackId);
    if (!track) return { visible: false, x, y, width: graphic.width, opacity: 0, scale: 1, rotationDegrees: 0 };
    const clip = findClip(project, track.clipId);
    const pose = motionTrackPoseAt(track, sampledPlayhead - clip.timelineStart);
    if (!pose) return { visible: false, x, y, width: graphic.width, opacity: 0, scale: 1, rotationDegrees: 0 };
    x = pose.rect.x + pose.rect.width + graphic.offsetX;
    y = pose.rect.y + graphic.offsetY;
    trackedScale = pose.scale;
    rotationDegrees = pose.rotationDegrees;
  }
  const remainingFrames = durationFrames - localFrame;
  const fadeInFrames = Math.min(Math.round(0.18 * project.fps), Math.floor(durationFrames / 2));
  const fadeOutFrames = Math.min(Math.round(0.14 * project.fps), Math.floor(durationFrames / 2));
  const entry = fadeInFrames > 0 ? clamp01(localFrame / fadeInFrames) : 1;
  const exit = fadeOutFrames > 0 ? clamp01(remainingFrames / fadeOutFrames) : 1;
  const easedEntry = 1 - (1 - entry) ** 3;
  const exitScale = exit >= 1 ? 1 : 0.94 + 0.06 * exit;
  const translateYPixels = graphic.animation === "slide_up" ? (1 - easedEntry) * 48 - (1 - exit) * 24 : 0;
  let animationScale = 1;
  if (graphic.animation === "pop") animationScale = (0.7 + 0.3 * easedEntry) * exitScale;
  if (graphic.animation === "spring_soft") {
    const springScale = entry >= 1 ? 1 : entry <= 0.6
      ? 0.82 + 0.24 * (1 - (1 - entry / 0.6) ** 3)
      : 1.06 - 0.06 * (1 - (1 - (entry - 0.6) / 0.4) ** 3);
    animationScale = springScale * exitScale;
  }
  return {
    visible: true,
    x,
    y: y + translateYPixels / project.height,
    width: graphic.width,
    opacity: Math.min(entry, exit),
    scale: animationScale * trackedScale,
    rotationDegrees,
  };
}

const PRESETS: Record<MotionGraphicKind, Pick<MotionGraphic, "name" | "x" | "y" | "width" | "fontSize" | "textColor" | "backgroundColor" | "accentColor" | "animation">> = {
  title: { name: "動態主標題", x: 0.08, y: 0.12, width: 0.7, fontSize: 72, textColor: "#FFFFFF", backgroundColor: "#315CFFDD", accentColor: "#77E4FF", animation: "slide_up" },
  card: { name: "資訊重點卡", x: 0.08, y: 0.68, width: 0.56, fontSize: 46, textColor: "#10162B", backgroundColor: "#FFFFFFEE", accentColor: "#FF4FA3", animation: "pop" },
  tag: { name: "追蹤標籤", x: 0.65, y: 0.22, width: 0.25, fontSize: 38, textColor: "#07110A", backgroundColor: "#8BFF58EE", accentColor: "#00E676", animation: "spring_soft" },
  counter: { name: "數字重點", x: 0.72, y: 0.12, width: 0.2, fontSize: 80, textColor: "#FFFFFF", backgroundColor: "#FF3D9ADD", accentColor: "#FFFFFF", animation: "pop" },
};

export function createMotionGraphic(id: string, kind: MotionGraphicKind, text: string, timelineStart: number, duration = 3, trackId?: string, seed?: MotionGraphicPresetSeed): MotionGraphic {
  const preset = PRESETS[kind];
  const resolvedSeed = seed ? structuredClone(seed) : undefined;
  return {
    schema: resolvedSeed?.schema ?? "hao.motion-composition/v1", id, timelineStart, duration, trackId, trackingMode: trackId ? "anchor" : undefined,
    name: preset.name, x: preset.x, y: preset.y, width: preset.width, fontSize: preset.fontSize,
    textColor: preset.textColor, backgroundColor: preset.backgroundColor, accentColor: preset.accentColor,
    animation: preset.animation, offsetX: trackId ? 0.015 : 0, offsetY: trackId ? -0.02 : 0, ...resolvedSeed, kind, text,
  };
}

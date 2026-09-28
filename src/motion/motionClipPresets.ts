import type { EditorCommand } from "../domain/commandTypes";
import type { TimelineClip } from "../domain/types";

export const MOTION_CLIP_PRESETS = [
  { id: "float_in", name: "浮空入場", description: "18 格內淡入、前推並柔和回彈" },
  { id: "slow_push", name: "緩推鏡頭", description: "沿整段影片逐格放大 6%" },
] as const;
export type MotionClipPresetId = typeof MOTION_CLIP_PRESETS[number]["id"];

/** Reuses EditGraph keyframes, so UI and v4 Autopilot can author the exact same motion. */
export function motionClipPresetCommands(clip: TimelineClip, fps: number, preset: MotionClipPresetId): EditorCommand[] {
  if (clip.keyframes.length) throw new Error("片段已有關鍵幀；請先確認現有動畫再套用 Motion 預設");
  if (!Number.isFinite(fps) || fps <= 0 || clip.duration * fps < 12) throw new Error("Motion 預設需要至少 12 格有效片段");
  const base = clip.transform;
  const at = (frame: number, scale: number, opacity: number, y: number, easing: "ease_out" | "ease_in_out") => ({
    type: "add_keyframe" as const,
    clipId: clip.id,
    keyframe: { id: `motion-${preset}-${frame}`, time: frame / fps, easing,
      transform: { ...base, scale: base.scale * scale, opacity: base.opacity * opacity, y: base.y + y },
      color: { ...clip.color } },
  });
  if (preset === "float_in") {
    const end = Math.min(18, Math.floor(clip.duration * fps));
    const peak = Math.max(1, Math.round(end * .65));
    return [at(0, .84, 0, 34, "ease_out"), at(peak, 1.035, 1, -5, "ease_in_out"), at(end, 1, 1, 0, "ease_out")];
  }
  if (preset === "slow_push") {
    const end = Math.floor(clip.duration * fps);
    return [at(0, 1, 1, 0, "ease_in_out"), at(end, 1.06, 1, 0, "ease_in_out")];
  }
  throw new Error(`未知 Motion 預設：${preset}`);
}

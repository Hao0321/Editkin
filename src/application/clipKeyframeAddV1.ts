import type { EditorCommand } from "../domain/commandTypes";
import { animatedClipState } from "../domain/editGraph";
import type { TimelineClip } from "../domain/types";

/**
 * Inspector › 動畫關鍵幀 › ＋ 在目前時間加入: one keyframe at the playhead that holds the clip's own animated values there.
 *
 * Expressions are left out of the stored values. They run on top of the keyframes in the preview and the export
 * (animatedClipState), so storing their result would apply them twice: an opacity expression `value * 0.5` on an
 * opacity of 1 would store 0.5 and then play 0.25.
 */
export function planAddClipKeyframeV1(clip: TimelineClip, playhead: number, fps: number, keyframeId: string): { command: EditorCommand; message: string } {
  const time = Math.max(0, Math.min(clip.duration, playhead - clip.timelineStart));
  const authored = animatedClipState({ ...clip, expressions: {} }, time, fps);
  return {
    command: { type: "add_keyframe", clipId: clip.id,
      keyframe: { id: keyframeId, time, transform: authored.transform, color: authored.color, easing: "linear" } },
    message: `已在片段 ${time.toFixed(2)} 秒加入關鍵幀。`,
  };
}

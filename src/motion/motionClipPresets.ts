import type { EditorCommand } from "../domain/commandTypes";
import type { TimelineClip } from "../domain/types";
import { CLIP_MOTION_RECIPES, CLIP_MOTION_RECIPE_SPECS, clipMotionRecipeCommands, type ClipMotionRecipe, type ClipMotionRecipeOptions } from "./motionLanguage";

const LEGACY_MOTION_CLIP_PRESETS = [
  { id: "float_in", name: "浮空入場", description: "18 格內淡入、前推並柔和回彈" },
  { id: "slow_push", name: "緩推鏡頭", description: "沿整段影片逐格放大 6%" },
  { id: "gallery_drift", name: "空間側移", description: "前後景錯位感：緩慢橫移、微縮放與小角度傾斜" },
  { id: "chapter_snap", name: "章節切入", description: "章節開始的 12 格內短距離淡入後停穩" },
] as const;
export type MotionClipPresetId = typeof LEGACY_MOTION_CLIP_PRESETS[number]["id"] | ClipMotionRecipe;

/** Legacy ids keep their exact keyframes; Motion Language recipes are appended. */
export const MOTION_CLIP_PRESETS: ReadonlyArray<{ id: MotionClipPresetId; name: string; description: string }> = [
  ...LEGACY_MOTION_CLIP_PRESETS,
  ...CLIP_MOTION_RECIPES.map((id) => ({ id, name: CLIP_MOTION_RECIPE_SPECS[id].label, description: CLIP_MOTION_RECIPE_SPECS[id].use })),
];
export const MOTION_CLIP_PRESET_IDS = MOTION_CLIP_PRESETS.map((preset) => preset.id) as [MotionClipPresetId, ...MotionClipPresetId[]];

/** Frame size and art direction for Motion Language recipes; legacy presets ignore it. */
export type MotionClipPresetContext = Omit<ClipMotionRecipeOptions, "fps">;

const isRecipe = (preset: MotionClipPresetId): preset is ClipMotionRecipe => (CLIP_MOTION_RECIPES as readonly string[]).includes(preset);

/** Reuses EditGraph keyframes, so UI and v4 Autopilot can author the exact same motion. */
export function motionClipPresetCommands(clip: TimelineClip, fps: number, preset: MotionClipPresetId, context?: MotionClipPresetContext): EditorCommand[] {
  if (isRecipe(preset)) {
    if (!context) throw new Error("Motion 運鏡需要專案畫面尺寸");
    return clipMotionRecipeCommands(clip, preset, { ...context, fps });
  }
  if (clip.keyframes.length) throw new Error("片段已有關鍵幀；請先確認現有動畫再套用 Motion 預設");
  if (!Number.isFinite(fps) || fps <= 0 || clip.duration * fps < 12) throw new Error("Motion 預設需要至少 12 格有效片段");
  const base = clip.transform;
  const at = (frame: number, scale: number, opacity: number, y: number, easing: "ease_out" | "ease_in_out", x = 0, rotation = 0) => ({
    type: "add_keyframe" as const,
    clipId: clip.id,
    keyframe: { id: `motion-${preset}-${frame}`, time: frame / fps, easing,
      transform: { ...base, scale: base.scale * scale, opacity: base.opacity * opacity, y: base.y + y, x: base.x + x, rotation: base.rotation + rotation },
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
  if (preset === "gallery_drift") {
    const end = Math.floor(clip.duration * fps);
    const middle = Math.max(1, Math.floor(end / 2));
    return [at(0, 1.07, 1, 3, "ease_in_out", -20, -1.2),
      at(middle, 1.02, 1, -2, "ease_in_out", 0, 0),
      at(end, 1.06, 1, 2, "ease_in_out", 18, 1.1)];
  }
  if (preset === "chapter_snap") {
    return [at(0, .97, 0, 14, "ease_out", 18),
      at(8, .997, 1, 1, "ease_out", 2),
      at(12, 1, 1, 0, "ease_out")];
  }
  throw new Error(`未知 Motion 預設：${preset}`);
}

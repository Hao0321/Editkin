import { clipTimeRemapSchemaV1, type ClipTimeRemapV1 } from "../domain/clipTimeRemapV1";

export const SPEED_CURVE_PRESETS_V1 = Object.freeze([
  Object.freeze({ id: "montage", certification: "pending", vaDefaultEligible: false }),
  Object.freeze({ id: "impact", certification: "pending", vaDefaultEligible: false }),
  Object.freeze({ id: "bullet_time", certification: "pending", vaDefaultEligible: false }),
  Object.freeze({ id: "jump", certification: "pending", vaDefaultEligible: false }),
] as const);
export type SpeedCurvePresetIdV1 = typeof SPEED_CURVE_PRESETS_V1[number]["id"];
const anchors: Record<SpeedCurvePresetIdV1, readonly (readonly [number, number])[]> = {
  montage: [[0, 1], [.5, .25], [1, 1]],
  impact: [[0, 1], [.5, 3], [1, 1]],
  bullet_time: [[0, 1], [.25, .1], [.75, .1], [1, 1]],
  jump: [[0, 1], [.3, 1], [.45, 4], [.55, 4], [.7, 1], [1, 1]],
};

/** New, uncatalogued candidates; absolute multipliers, never a mutation of the frozen B4 presets. */
export function createSpeedCurvePresetV1(id: SpeedCurvePresetIdV1,
  options: { direction?: "forward" | "reverse"; audioMode?: "mute" | "follow_speed" } = {}): ClipTimeRemapV1 {
  if (!Object.hasOwn(anchors, id)) throw Error("SPEED_CURVE_PRESET_UNKNOWN");
  const points = anchors[id].map(([time, speed]) => ({ time, speed }));
  return clipTimeRemapSchemaV1.parse({ schema: "editkin.clip-time-remap/v1", direction: options.direction ?? "forward",
    interpolation: "frame_blending", audioMode: options.audioMode ?? "mute",
    segments: points.slice(1).map((to, i) => {
      const from = points[i], span = to.time - from.time;
      return { from, control1: { time: from.time + span / 3, speed: from.speed },
        control2: { time: to.time - span / 3, speed: to.speed }, to };
    }) });
}

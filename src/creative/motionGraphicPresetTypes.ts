import type { MotionGraphicPresetSeed } from "../domain/types";

/** Pure preset contract shared by the registry and independently authored packs. */
export interface MotionGraphicPreset {
  id: string;
  name: string;
  family: string;
  license: string;
  provenance: string;
  renderer: "hao-motion-composition/v1" | "hao-motion-composition/v2";
  seed: MotionGraphicPresetSeed;
  routing?: {
    semanticRoles: string[];
    formats: Array<"9:16" | "16:9" | "1:1">;
    requires: Array<"none" | "motion_track" | "surface_quad">;
    avoidWhen: string[];
    intensity: "low" | "medium" | "high";
  };
}

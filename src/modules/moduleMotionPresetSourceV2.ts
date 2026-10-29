import { motionGraphicPresets } from "../creative/motionGraphicPresets";
import type { MotionGraphicPreset } from "../creative/motionGraphicPresetTypes";
/** Presets the creation compiler accepts: registered text v2, no vector body, no tracking or surface requirements. */
export function creatableMotionPresets(): MotionGraphicPreset[] {
    return motionGraphicPresets().filter(preset => preset.renderer === "hao-motion-composition/v2" && preset.seed.schema === "hao.motion-composition/v2"
        && preset.seed.kind !== undefined && preset.seed.vectorV2 === undefined && preset.seed.trackingMode === undefined
        && (preset.routing?.requires ?? ["none"]).every(requirement => requirement === "none"));
}

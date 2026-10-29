import type { ColorManagementSettings, InputColorSpace, TimelineClip } from "../domain/types";
import { ACES_SDR_OUTPUT_LUT, usesAcesDisplayReconstruction } from "./acesDisplayInverse";

/** A saved recipe distinguishes approved fresh phone projects from the pre-existing grade-dependent route. */
export type AcesRec709DisplayPolicyV1 = "legacy-grade-v2" | "phone-bt1886";
export type ClipRec709InputV1 = "display" | "camera";
export const ACES_PHONE_SDR_OUTPUT_LUT_V1 = "luts/output-acescct-to-rec709_sdr_bt1886_v1.cube";

export function usesAcesPhoneSdrV1(management: ColorManagementSettings): boolean {
  return management.mode === "aces2" && management.outputTransform === "rec709_sdr"
    && management.rec709DisplayPolicy === "phone-bt1886";
}

export function acesSdrOutputLutPathV1(management: ColorManagementSettings): string {
  return usesAcesPhoneSdrV1(management) ? ACES_PHONE_SDR_OUTPUT_LUT_V1 : ACES_SDR_OUTPUT_LUT;
}

/** Explicit camera is per clip. It never reinterprets the asset shared by another clip. */
export function usesAcesClipDisplayInverseV1(input: InputColorSpace | "blocked_log", management: ColorManagementSettings,
  clip: Pick<TimelineClip, "gradeV2" | "rec709Input">, hasLinearWhiteBalance = false): boolean {
  if (hasLinearWhiteBalance) return false;
  if (usesAcesPhoneSdrV1(management)) {
    if (input === "rec709" && clip.rec709Input === "camera") return false;
    return usesAcesDisplayReconstruction(input, management);
  }
  return Boolean(clip.gradeV2) && usesAcesDisplayReconstruction(input, management);
}

/** New user projects keep quick Rec.709 until ACES is selected; their ACES recipe is already explicit. */
export function withAcesPhonePolicyV1(management: ColorManagementSettings): ColorManagementSettings {
  return { ...management, rec709DisplayPolicy: "phone-bt1886" };
}

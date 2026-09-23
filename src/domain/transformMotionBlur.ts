import type { NativeEffectInstance } from "./types";

export const TRANSFORM_MOTION_BLUR_PLUGIN_ID = "editkin.builtin.transform-motion-blur";
export const TRANSFORM_MOTION_BLUR_CAPABILITY_ID = "transform_motion_blur";
export const TRANSFORM_MOTION_BLUR_VERSION = "1.0.0";
export const TRANSFORM_MOTION_BLUR_MANIFEST_SHA256 = "d63db233ffb989caf099a60fd3faea0e4ce3fb58b734a71c876d1daa3093cb2c";
export const TRANSFORM_MOTION_BLUR_CONTRACT = "decoded-temporal-shutter-accumulation/v1";

export interface TransformMotionBlurParameters {
  shutterAngle: number;
  samples: number;
  sourceSampling: "decoded_temporal";
}

export function isTransformMotionBlurInstance(instance: NativeEffectInstance): boolean {
  return instance.pluginId === TRANSFORM_MOTION_BLUR_PLUGIN_ID
    && instance.capabilityId === TRANSFORM_MOTION_BLUR_CAPABILITY_ID;
}

export function transformMotionBlurParameters(instance: NativeEffectInstance): TransformMotionBlurParameters {
  if (!isTransformMotionBlurInstance(instance)) throw new Error(`不是 Editkin transform motion blur：${instance.id}`);
  const shutterAngle = instance.parameters.shutter_angle;
  const samples = instance.parameters.samples;
  if (instance.runtimeType !== "gpu_effect_graph"
    || instance.pluginVersion !== TRANSFORM_MOTION_BLUR_VERSION
    || instance.manifestSha256 !== TRANSFORM_MOTION_BLUR_MANIFEST_SHA256
    || Object.keys(instance.parameters).some((key) => key !== "shutter_angle" && key !== "samples")
    || typeof shutterAngle !== "number" || !Number.isFinite(shutterAngle) || shutterAngle <= 0 || shutterAngle > 360
    || typeof samples !== "number" || !Number.isSafeInteger(samples) || samples < 2 || samples > 8) {
    throw new Error(`動態模糊參數超出原生 GPU 安全範圍：${instance.id}`);
  }
  return { shutterAngle, samples, sourceSampling: "decoded_temporal" };
}

export function createTransformMotionBlurInstance(): NativeEffectInstance {
  return {
    id: "builtin-transform-motion-blur",
    pluginId: TRANSFORM_MOTION_BLUR_PLUGIN_ID,
    capabilityId: TRANSFORM_MOTION_BLUR_CAPABILITY_ID,
    pluginVersion: TRANSFORM_MOTION_BLUR_VERSION,
    manifestSha256: TRANSFORM_MOTION_BLUR_MANIFEST_SHA256,
    runtimeType: "gpu_effect_graph",
    enabled: true,
    parameters: { shutter_angle: 180, samples: 8 },
  };
}

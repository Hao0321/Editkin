import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MotionGraphic } from "../domain/types";
import { motionPresetOverridesSchema, type MotionPresetVariant } from "../domain/schema";
import { findMotionGraphicPreset, type MotionGraphicPreset } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return value;
}

/** Registered structure only: never include project text, paths or user data. */
export function motionPresetSeedSha256(preset: MotionGraphicPreset): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    id: preset.id, renderer: preset.renderer, seed: preset.seed,
  }))).digest("hex");
}

export function motionPresetVariantDescriptor(preset: MotionGraphicPreset) {
  if (preset.renderer !== "hao-motion-composition/v2" || preset.seed.schema !== "hao.motion-composition/v2") return undefined;
  return {
    schema: "editkin.motion-preset-variant/v1" as const,
    planPath: "editorial.graphics[].presetVariant",
    basePresetSha256: motionPresetSeedSha256(preset),
    allowedOverrideFields: Object.keys(motionPresetOverridesSchema.shape),
    policy: "Declare reason and overrides; command must equal the registered resolved seed plus those overrides. Text/timing remain event-bound; no identity, renderer, tracking, permissions or arbitrary code override.",
    reviewRequired: true,
  };
}

/** Keeps stock binding strict; only an explicit variant admits visual changes. */
export function assertMotionPresetVariantBinding(graphic: MotionGraphic, presetId: string, variant: MotionPresetVariant): void {
  const preset = findMotionGraphicPreset(presetId);
  if (!motionPresetVariantDescriptor(preset)) throw new Error(`動態圖文 ${graphic.id} 的 preset 不支援 v2 變體`);
  if (variant.basePresetSha256 !== motionPresetSeedSha256(preset)) throw new Error(`動態圖文 ${graphic.id} 的 preset seed SHA-256 不一致`);
  const expected = {
    ...createMotionGraphic(graphic.id, preset.seed.kind ?? "card", graphic.text, graphic.timelineStart, graphic.duration, undefined, preset.seed),
    ...variant.overrides,
  } as unknown as Record<string, unknown>;
  const actual = graphic as unknown as Record<string, unknown>;
  // Timing and text are validated against the editorial event, not the style.
  const eventFields = new Set(["id", "text", "timelineStart", "duration"]);
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!eventFields.has(key) && !isDeepStrictEqual(actual[key], expected[key])) {
      throw new Error(`動態圖文 ${graphic.id} 的變體未忠實解析參數：${key}`);
    }
  }
}

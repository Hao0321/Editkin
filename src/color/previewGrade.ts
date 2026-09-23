import type { ColorAdjustments } from "../domain/types";

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

export function previewPrimaryFilter(color: ColorAdjustments): string {
  const tonalBrightness = color.exposure * 0.075 + color.brightness + (color.shadows + color.highlights + color.whites + color.blacks) * 0.025;
  const sepia = Math.abs(color.temperature) * 0.08;
  return `brightness(${clamp(1 + tonalBrightness, 0.05, 3)}) contrast(${color.contrast}) saturate(${color.saturation}) hue-rotate(${color.hue + color.temperature * 6 - color.tint * 3}deg) sepia(${sepia})`;
}

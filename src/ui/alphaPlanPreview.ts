import { applyChromaKeyRgbaInPlace } from "../domain/chromaKey";
import {
  floorClipAlphaSampleIndex,
  pixelMatteOperation,
  type ClipAlphaOperation,
  type ClipAlphaPlan,
  type ClipAlphaVectorOperation,
} from "../domain/clipAlphaPlan";
import type { MaskPathPoint } from "../domain/types";

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export { clipLocalProjectFrame } from "../domain/clipAlphaPlan";

export function pixelMattePreviewUri(plan: ClipAlphaPlan, localProjectFrame: number): string | undefined {
  const pixel = pixelMatteOperation(plan);
  const index = floorClipAlphaSampleIndex(plan, localProjectFrame);
  if (!pixel || index === undefined) return undefined;
  const uri = pixel.matte.previewUris[index];
  if (!uri) throw new Error(`Alpha plan ${plan.clipId} 缺少第 ${index} 格逐像素 Matte 預覽`);
  return uri;
}

function expanded(points: readonly MaskPathPoint[], amount: number): MaskPathPoint[] {
  if (points.length < 3) throw new Error("向量遮罩至少需要三個路徑點");
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const scale = Math.max(.05, 1 + amount * 2);
  return points.map((point) => ({
    ...point,
    x: clamp(cx + (point.x - cx) * scale),
    y: clamp(cy + (point.y - cy) * scale),
  }));
}

function vectorPointsAt(operation: ClipAlphaVectorOperation, localTime: number): readonly MaskPathPoint[] | undefined {
  if (operation.samples.length === 0) return operation.path;
  let sampleIndex = operation.samples.length - 1;
  for (let index = 0; index < operation.samples.length - 1; index += 1) {
    const boundary = (operation.samples[index].time + operation.samples[index + 1].time) / 2;
    if (localTime < boundary) {
      sampleIndex = index;
      break;
    }
  }
  return operation.samples[sampleIndex].points;
}

interface PreparedVectorOperation {
  operation: ClipAlphaVectorOperation;
  points?: readonly MaskPathPoint[];
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

function prepareVector(operation: ClipAlphaVectorOperation, localTime: number, width: number, height: number): PreparedVectorOperation {
  const selected = vectorPointsAt(operation, localTime);
  // A lost authored/tracked sample is an explicit empty mask, including when inverted.
  if (!selected) return { operation };
  const points = expanded(selected, operation.expansion + operation.edgeShift)
    .map((point) => ({ ...point, x: point.x * width, y: point.y * height }));
  return {
    operation,
    points,
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function insidePreparedVector(prepared: PreparedVectorOperation, x: number, y: number): boolean {
  const { operation, points, left, right, top, bottom } = prepared;
  if (!points || left === undefined || right === undefined || top === undefined || bottom === undefined) return false;
  if (operation.kind === "ellipse" || operation.kind === "subject") {
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const rx = Math.max(1, (right - left) / 2);
    const ry = Math.max(1, (bottom - top) / 2);
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  }
  if (operation.kind === "rectangle") return x >= left && x <= right && y >= top && y <= bottom;
  let crossings = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const minimumY = Math.min(point.y, next.y);
    const maximumY = Math.max(point.y, next.y);
    const denominator = Math.abs(next.y - point.y) < .00001 ? .00001 : next.y - point.y;
    if (y > minimumY && y <= maximumY && x < point.x + (y - point.y) * (next.x - point.x) / denominator) crossings += 1;
  }
  return crossings % 2 >= 1;
}

function operationAlpha(
  operation: ClipAlphaOperation,
  prepared: PreparedVectorOperation | undefined,
  pixelIndex: number,
  x: number,
  y: number,
  matteAlpha: Float32Array | undefined,
): number {
  if (operation.source === "pixel_matte") {
    if (!matteAlpha) throw new Error(`Alpha plan 的逐像素 Matte ${operation.maskId} 尚未載入`);
    const value = matteAlpha[pixelIndex];
    return operation.opacity * (operation.inverted ? 1 - value : value);
  }
  if (!prepared?.points) return 0;
  const inside = insidePreparedVector(prepared, x, y) ? 1 : 0;
  return operation.opacity * (operation.inverted ? 1 - inside : inside);
}

function combine(current: number, next: number, operation: ClipAlphaOperation): number {
  if (operation.mode === "subtract") return current * (1 - next);
  if (operation.mode === "intersect") return Math.min(current, next);
  return Math.max(current, next);
}

function boxSizesForGaussian(sigma: number): number[] {
  const passes = 3;
  const ideal = Math.sqrt((12 * sigma * sigma / passes) + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const countLower = Math.round((12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4));
  return Array.from({ length: passes }, (_, index) => Math.max(1, index < countLower ? lower : upper));
}

function boxBlurHorizontal(source: Float32Array, target: Float32Array, width: number, height: number, radius: number): void {
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) sum += source[row + Math.max(0, Math.min(width - 1, offset))];
    const divisor = radius * 2 + 1;
    for (let x = 0; x < width; x += 1) {
      target[row + x] = sum / divisor;
      sum -= source[row + Math.max(0, x - radius)];
      sum += source[row + Math.min(width - 1, x + radius + 1)];
    }
  }
}

function boxBlurVertical(source: Float32Array, target: Float32Array, width: number, height: number, radius: number): void {
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) sum += source[Math.max(0, Math.min(height - 1, offset)) * width + x];
    const divisor = radius * 2 + 1;
    for (let y = 0; y < height; y += 1) {
      target[y * width + x] = sum / divisor;
      sum -= source[Math.max(0, y - radius) * width + x];
      sum += source[Math.min(height - 1, y + radius + 1) * width + x];
    }
  }
}

interface AlphaBlurWorkspace {
  horizontal: Float32Array;
  vertical: Float32Array;
}

/** Three box passes are the bounded compatibility approximation of FFmpeg gblur. */
function blurAlpha(values: Float32Array, width: number, height: number, sigma: number, workspace: AlphaBlurWorkspace): Float32Array {
  if (sigma <= .1) return values;
  let current = values;
  let target = workspace.vertical;
  for (const size of boxSizesForGaussian(sigma)) {
    const radius = Math.floor((size - 1) / 2);
    boxBlurHorizontal(current, workspace.horizontal, width, height, radius);
    boxBlurVertical(workspace.horizontal, target, width, height, radius);
    [current, target] = [target, current];
  }
  // Keep scratch storage distinct from the returned plane, and reuse it for
  // subsequent operations instead of allocating two full planes every pass.
  workspace.vertical = target;
  return current;
}

export interface ApplyClipAlphaPlanOptions {
  localProjectFrame: number;
  /** Opaque grayscale Auto Roto preview resampled into the same project canvas. */
  matteAlpha?: Float32Array;
}

/**
 * Browser executor for ClipAlphaPlan. The authored stack and alpha multiplication
 * match formal render; feather uses a bounded CPU Gaussian approximation.
 */
export function applyClipAlphaPlanRgbaInPlace(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  plan: ClipAlphaPlan,
  options: ApplyClipAlphaPlanOptions,
): void {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || pixels.length !== width * height * 4) {
    throw new Error("Alpha 預覽 RGBA frame 尺寸不合法");
  }
  if (!Number.isSafeInteger(options.localProjectFrame) || options.localProjectFrame < 0) throw new Error("Alpha 預覽 frame 不合法");
  if (plan.keyer) applyChromaKeyRgbaInPlace(pixels, plan.keyer);
  if (plan.operations.length === 0) return;

  const pixelOperation = pixelMatteOperation(plan);
  if (pixelOperation && options.matteAlpha?.length !== width * height) throw new Error("逐像素 Matte 預覽尺寸與專案 Canvas 不一致");
  const localTime = options.localProjectFrame * plan.sampleRule.projectRate.denominator / plan.sampleRule.projectRate.numerator;
  const pixelCount = width * height;
  const combinedAlpha = new Float32Array(pixelCount);
  let operationPlane: Float32Array = new Float32Array(pixelCount);
  let workspace: AlphaBlurWorkspace | undefined;
  for (let operationIndex = 0; operationIndex < plan.operations.length; operationIndex += 1) {
    const operation = plan.operations[operationIndex];
    const prepared = operation.source === "vector" ? prepareVector(operation, localTime, width, height) : undefined;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        operationPlane[pixelIndex] = operationAlpha(operation, prepared, pixelIndex, x, y, options.matteAlpha);
      }
    }
    // Feather belongs to this vector operation, before its authored combine
    // mode. A frozen Roto plane already contains its edge refinement.
    const sigma = operation.source === "vector" ? operation.feather * Math.min(width, height) : 0;
    if (sigma > .1) {
      workspace ??= { horizontal: new Float32Array(pixelCount), vertical: new Float32Array(pixelCount) };
      operationPlane = blurAlpha(operationPlane, width, height, sigma, workspace);
    }
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      combinedAlpha[pixelIndex] = operationIndex === 0 ? operationPlane[pixelIndex]
        : combine(combinedAlpha[pixelIndex], operationPlane[pixelIndex], operation);
    }
  }
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    // Preserve both source and keyer alpha; neither is part of a mask's blur.
    const sourceAlpha = pixels[pixelIndex * 4 + 3];
    pixels[pixelIndex * 4 + 3] = Math.round(sourceAlpha * clamp(combinedAlpha[pixelIndex]));
  }
}

import type { ClipAlphaOperation, ClipAlphaPlan, ClipAlphaVectorOperation } from "../domain/clipAlphaPlan";
import type { MaskPathPoint } from "../domain/types";

function n(value: number): string {
  const normalized = value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return normalized || "0";
}

function expanded(points: readonly MaskPathPoint[], amount: number): MaskPathPoint[] {
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const scale = Math.max(.05, 1 + amount * 2);
  return points.map((point) => ({ ...point, x: Math.max(0, Math.min(1, cx + (point.x - cx) * scale)), y: Math.max(0, Math.min(1, cy + (point.y - cy) * scale)) }));
}

function shapeExpression(operation: ClipAlphaVectorOperation, points: readonly MaskPathPoint[], width: number, height: number): string {
  const path = expanded(points, operation.expansion + operation.edgeShift);
  const px = path.map((point) => point.x * width); const py = path.map((point) => point.y * height);
  const left = Math.min(...px); const right = Math.max(...px); const top = Math.min(...py); const bottom = Math.max(...py);
  let inside: string;
  if (operation.kind === "ellipse" || operation.kind === "subject") {
    const cx = (left + right) / 2; const cy = (top + bottom) / 2; const rx = Math.max(1, (right - left) / 2); const ry = Math.max(1, (bottom - top) / 2);
    inside = `lte(pow((X-${n(cx)})/${n(rx)}\,2)+pow((Y-${n(cy)})/${n(ry)}\,2)\,1)`;
  } else if (operation.kind === "rectangle") {
    inside = `between(X\,${n(left)}\,${n(right)})*between(Y\,${n(top)}\,${n(bottom)})`;
  } else {
    const crossings = path.map((point, index) => {
      const next = path[(index + 1) % path.length];
      const x1 = point.x * width; const y1 = point.y * height; const x2 = next.x * width; const y2 = next.y * height;
      const denominator = Math.abs(y2 - y1) < .00001 ? .00001 : y2 - y1;
      return `(gt(Y\,${n(Math.min(y1, y2))})*lte(Y\,${n(Math.max(y1, y2))})*lt(X\,${n(x1)}+(Y-${n(y1)})*${n(x2 - x1)}/${n(denominator)}))`;
    }).join("+");
    inside = `gte(mod(${crossings}\,2)\,1)`;
  }
  const value = operation.inverted ? `(1-(${inside}))` : `(${inside})`;
  return `${n(operation.opacity)}*${value}`;
}

function timedExpression(operation: ClipAlphaVectorOperation, width: number, height: number): string {
  if (operation.samples.length === 0) return shapeExpression(operation, operation.path, width, height);
  const sampleExpression = (index: number) => operation.samples[index].points
    ? shapeExpression(operation, operation.samples[index].points!, width, height)
    : "0";
  let result = sampleExpression(operation.samples.length - 1);
  for (let index = operation.samples.length - 2; index >= 0; index -= 1) {
    const boundary = (operation.samples[index].time + operation.samples[index + 1].time) / 2;
    result = `if(lt(T\,${n(boundary)})\,${sampleExpression(index)}\,${result})`;
  }
  return result;
}

function operationExpression(operation: ClipAlphaOperation, width: number, height: number, pixelMaximum: number): string {
  if (operation.source === "vector") return timedExpression(operation, width, height);
  const plane = operation.inverted ? `(1-(lum(X\,Y)/${pixelMaximum}))` : `(lum(X\,Y)/${pixelMaximum})`;
  return `${n(operation.opacity)}*${plane}`;
}

function combine(operations: readonly ClipAlphaOperation[], width: number, height: number, pixelMaximum = 255): string | undefined {
  if (operations.length === 0) return undefined;
  let combined = operationExpression(operations[0], width, height, pixelMaximum);
  for (const operation of operations.slice(1)) {
    const next = operationExpression(operation, width, height, pixelMaximum);
    combined = operation.mode === "subtract" ? `(${combined})*(1-(${next}))` : operation.mode === "intersect" ? `min(${combined}\,${next})` : `max(${combined}\,${next})`;
  }
  return combined;
}

/** Vector-only stack. Pixel matte plans must use matteMaskAlphaExpression. */
export function combinedMaskAlphaExpression(plan: ClipAlphaPlan, width: number, height: number): string | undefined {
  if (plan.operations.some((operation) => operation.source === "pixel_matte")) {
    throw new Error(`Alpha plan ${plan.clipId} 需要逐像素 Matte input，不能退化成向量遮罩`);
  }
  return combine(plan.operations, width, height);
}

/** Full authored stack evaluated against the current gray pixel-matte input. */
export function matteMaskAlphaExpression(plan: ClipAlphaPlan, width: number, height: number, pixelMaximum = 255): string {
  if (!plan.operations.some((operation) => operation.source === "pixel_matte")) {
    throw new Error(`Alpha plan ${plan.clipId} 沒有逐像素 Matte operation`);
  }
  const expression = combine(plan.operations, width, height, pixelMaximum);
  if (!expression) throw new Error(`Alpha plan ${plan.clipId} 沒有可執行的遮罩`);
  return expression;
}

/** Feather is per operation. Frozen pixel-matte refinement is already baked. */
export function maskOperationFeatherSigma(operation: ClipAlphaOperation, width: number, height: number): number {
  return operation.source === "vector" ? Math.max(0, operation.feather * Math.min(width, height)) : 0;
}

export interface MaskAlphaFilterInputs {
  /** Same-size, same-rate, clip-local gray source alpha; never feathered. */
  sourceAlphaLabel: string;
  /** Verified, resampled and clip-local gray matte, when the plan requires it. */
  pixelMatteLabel?: string;
  outputLabel: string;
  width: number;
  height: number;
  pixelMaximum?: 255 | 65535;
}

/**
 * Build operation-local mask planes, combine them in authored order, then
 * multiply untouched source alpha once. Inputs stay clip-local until the
 * caller has finished opacity and assigns the layer's timeline offset.
 */
export function buildClipMaskAlphaFilters(plan: ClipAlphaPlan, input: MaskAlphaFilterInputs): string[] {
  const { sourceAlphaLabel, pixelMatteLabel, outputLabel, width, height, pixelMaximum = 255 } = input;
  if (plan.operations.length === 0) return [`[${sourceAlphaLabel}]null[${outputLabel}]`];
  const hasPixelMatte = plan.operations.some(operation => operation.source === "pixel_matte");
  if (hasPixelMatte && !pixelMatteLabel) throw new Error(`Alpha plan ${plan.clipId} 缺少逐像素 Matte input`);
  const hasFeather = plan.operations.some(operation => maskOperationFeatherSigma(operation, width, height) > .1);
  const multiply = (source: string, mask: string) => `[${source}][${mask}]blend=all_expr='A*B/${pixelMaximum}':shortest=1[${outputLabel}]`;
  if (!hasFeather) {
    // Keep the inexpensive single-expression path for hard masks. Crucially,
    // this path has no stack blur, so source alpha cannot bleed into a hole.
    if (!hasPixelMatte) return [`[${sourceAlphaLabel}]geq=lum='lum(X,Y)*(${combinedMaskAlphaExpression(plan, width, height)})'[${outputLabel}]`];
    const mask = `${outputLabel}mask`;
    return [
      `[${pixelMatteLabel}]geq=lum='${pixelMaximum}*(${matteMaskAlphaExpression(plan, width, height, pixelMaximum)})'[${mask}]`,
      multiply(sourceAlphaLabel, mask),
    ];
  }
  const vectors = plan.operations.filter(operation => operation.source === "vector");
  const protectedSource = `${outputLabel}original`;
  const seeds = vectors.map((_, index) => `${outputLabel}seed${index}`);
  const filters = [`[${sourceAlphaLabel}]split=${vectors.length + 1}[${protectedSource}]${seeds.map(label => `[${label}]`).join("")}`];
  let vectorIndex = 0;
  let accumulated = "";
  for (const [index, operation] of plan.operations.entries()) {
    const source = operation.source === "vector" ? seeds[vectorIndex++] : pixelMatteLabel!;
    const plane = `${outputLabel}op${index}`;
    const sigma = maskOperationFeatherSigma(operation, width, height);
    filters.push(`[${source}]geq=lum='${pixelMaximum}*(${operationExpression(operation, width, height, pixelMaximum)})'${sigma > .1 ? `,gblur=sigma=${n(sigma)}` : ""}[${plane}]`);
    if (index === 0) accumulated = plane;
    else {
      const next = `${outputLabel}stack${index}`;
      const expression = operation.mode === "subtract" ? `A*(1-B/${pixelMaximum})`
        : operation.mode === "intersect" ? "min(A,B)" : "max(A,B)";
      filters.push(`[${accumulated}][${plane}]blend=all_expr='${expression}':shortest=1[${next}]`);
      accumulated = next;
    }
  }
  filters.push(multiply(protectedSource, accumulated));
  return filters;
}

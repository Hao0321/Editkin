import type { PlacementPreference } from "./types";

/**
 * Placement solver (design §2.1 C1, brief §3): frame size + optional face or
 * subject boxes + title-safe → a block position in negative space.
 *
 * Hard rule: the placed block never intersects an avoid box (inflated by the
 * template's face margin). The solver tries the preferred region first, then
 * the remaining negative-space regions by free area, shrinking the block in
 * steps down to minScale. Only when nothing fits does it return fits: false
 * (the compiler then refuses the beat instead of covering the face).
 *
 * Coordinates are pixels, y down. Pure and deterministic.
 */

export interface Box { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export interface PlacementRequest {
  readonly frame: { readonly width: number; readonly height: number };
  /** Block size at scale 1. */
  readonly block: { readonly width: number; readonly height: number };
  /** Face / subject boxes the block must not touch (px, already in frame coordinates). */
  readonly avoid?: readonly Box[];
  /** Inflate avoid boxes by this many px. */
  readonly avoidMargin?: number;
  /** Title-safe margin as a share of each frame side (default 0.05). */
  readonly titleSafe?: number;
  /** Bands kept clear for platform UI (portrait only), as frame shares. */
  readonly uiBottom?: number;
  readonly uiRight?: number;
  readonly preference?: PlacementPreference;
  /** Smallest scale the block may shrink to (default 0.55). */
  readonly minScale?: number;
}

export type PlacementRegion = "left" | "right" | "top" | "bottom" | "center_low" | "free";

export interface PlacementResult {
  /** Block top-left at the returned scale. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** Text alignment that hugs the subject (end on the left of it, start on the right of it). */
  readonly align: "start" | "center" | "end";
  readonly region: PlacementRegion;
  readonly fits: boolean;
  /** Placed box. */
  readonly box: Box;
}

export const intersects = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const area = (box: Box) => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
const clamp = (value: number, min: number, max: number) => (max < min ? (min + max) / 2 : Math.max(min, Math.min(max, value)));

/** Gap between two boxes (0 when they touch or overlap). */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1), dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  return Math.hypot(dx, dy);
}

export function unionBoxes(boxes: readonly Box[]): Box | undefined {
  if (!boxes.length) return undefined;
  return boxes.reduce((acc, box) => ({ x0: Math.min(acc.x0, box.x0), y0: Math.min(acc.y0, box.y0), x1: Math.max(acc.x1, box.x1), y1: Math.max(acc.y1, box.y1) }));
}

/** The allowed area: title-safe, minus platform UI bands in portrait. */
export function safeArea(request: Pick<PlacementRequest, "frame" | "titleSafe" | "uiBottom" | "uiRight">): Box {
  const { width, height } = request.frame;
  const margin = request.titleSafe ?? 0.05;
  const portrait = height > width;
  const bottom = portrait ? Math.max(margin, request.uiBottom ?? 0) : margin;
  const right = portrait ? Math.max(margin, request.uiRight ?? 0) : margin;
  return { x0: width * margin, y0: height * margin, x1: width * (1 - right), y1: height * (1 - bottom) };
}

function validate(request: PlacementRequest): void {
  const { frame, block } = request;
  if (![frame.width, frame.height, block.width, block.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("placement needs a positive frame and block size");
  }
  for (const box of request.avoid ?? []) {
    if (![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) || !(box.x1 > box.x0) || !(box.y1 > box.y0)) throw new Error("placement avoid boxes need x0 < x1 and y0 < y1");
  }
}

const SCALE_STEPS = [1, 0.92, 0.84, 0.76, 0.68, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

export function solvePlacement(request: PlacementRequest): PlacementResult {
  validate(request);
  for (const candidate of placementCandidates(request)) return candidate;
  return fallbackPlacement(request);
}

/**
 * Up to `limit` distinct valid placements in preference order (the first is the solvePlacement answer). The compiler walks
 * them to find a spot where the text also reads against the footage (measured contrast), before it adds a scrim or a box.
 */
export function solvePlacementCandidates(request: PlacementRequest, limit = 8): PlacementResult[] {
  validate(request);
  const out: PlacementResult[] = [];
  for (const candidate of placementCandidates(request)) {
    if (out.some(other => overlapRatio(other.box, candidate.box) > 0.6)) continue;
    out.push(candidate);
    if (out.length >= limit) break;
  }
  return out.length ? out : [fallbackPlacement(request)];
}

function overlapRatio(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return (w * h) / Math.max(1e-9, Math.min(area(a), area(b)));
}

function fallbackPlacement(request: PlacementRequest): PlacementResult {
  const { frame } = request;
  const safe = safeArea(request);
  const scale = (SCALE_STEPS.filter(value => value >= (request.minScale ?? 0.55) - 1e-9).pop()) ?? (request.minScale ?? 0.55);
  const w = request.block.width * scale, h = request.block.height * scale;
  const cy = frame.height > frame.width ? frame.height * 0.66 : frame.height * 0.74;
  const x = clamp(frame.width / 2 - w / 2, safe.x0, safe.x1 - w), y = clamp(cy - h / 2, safe.y0, safe.y1 - h);
  return Object.freeze({ x, y, scale, width: w, height: h, align: "center" as const, region: "center_low" as const, fits: false,
    box: Object.freeze({ x0: x, y0: y, x1: x + w, y1: y + h }) });
}

function* placementCandidates(request: PlacementRequest): Generator<PlacementResult> {
  const { frame } = request;
  const safe = safeArea(request);
  const margin = request.avoidMargin ?? 0;
  const avoid = (request.avoid ?? []).map(box => ({ x0: box.x0 - margin, y0: box.y0 - margin, x1: box.x1 + margin, y1: box.y1 + margin }));
  const minScale = request.minScale ?? 0.55;
  const scales = SCALE_STEPS.filter(scale => scale >= minScale - 1e-9);
  const preference = request.preference ?? "auto";
  const portrait = frame.height > frame.width;

  const place = (x: number, y: number, scale: number, align: PlacementResult["align"], region: PlacementRegion, fits = true): PlacementResult => {
    const width = request.block.width * scale, height = request.block.height * scale;
    return Object.freeze({ x, y, scale, width, height, align, region, fits, box: Object.freeze({ x0: x, y0: y, x1: x + width, y1: y + height }) });
  };
  const clear = (candidate: PlacementResult) => candidate.box.x0 >= safe.x0 - 0.5 && candidate.box.y0 >= safe.y0 - 0.5
    && candidate.box.x1 <= safe.x1 + 0.5 && candidate.box.y1 <= safe.y1 + 0.5 && !avoid.some(box => intersects(candidate.box, box));
  /** A horizontally centred block whose centre sits at `share` of the frame height. */
  const centred = (scale: number, share: number): PlacementResult => {
    const w = request.block.width * scale, h = request.block.height * scale;
    return place(clamp(frame.width / 2 - w / 2, safe.x0, safe.x1 - w), clamp(frame.height * share - h / 2, safe.y0, safe.y1 - h), scale, "center", "center_low");
  };
  const short = Math.min(frame.width, frame.height);
  /** Grid over the safe area that clears every box separately, best first (clearance from boxes, then the reading anchor). */
  const grid = (scale: number, count: number): PlacementResult[] => {
    const w = request.block.width * scale, h = request.block.height * scale;
    const stepX = Math.max(4, frame.width * 0.02), stepY = Math.max(4, frame.height * 0.02);
    const scored: Array<{ candidate: PlacementResult; score: number }> = [];
    for (let y = safe.y0; y + h <= safe.y1 + 0.5; y += stepY) {
      for (let x = safe.x0; x + w <= safe.x1 + 0.5; x += stepX) {
        const candidate = place(x, y, scale, "center", "free");
        if (!clear(candidate)) continue;
        const clearance = avoid.length ? Math.min(...avoid.map(box => boxGap(candidate.box, box)), short * 0.12) : short * 0.12;
        scored.push({ candidate, score: Math.hypot(x + w / 2 - frame.width / 2, y + h / 2 - frame.height * 0.66) * 0.35 - clearance * 2 });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    const picked: PlacementResult[] = [];
    for (const { candidate } of scored) {
      if (picked.some(other => overlapRatio(other.box, candidate.box) > 0.3)) continue;
      picked.push(candidate);
      if (picked.length >= count) break;
    }
    return picked;
  };

  const subject = avoid.length ? unionBoxes(avoid)! : undefined;
  if (!subject) {
    // No subject: the lower third first, then the upper third and the middle, then anywhere.
    for (const share of [portrait ? 0.66 : 0.74, portrait ? 0.3 : 0.26, 0.5]) {
      for (const scale of scales) { const candidate = centred(scale, share); if (clear(candidate)) { yield candidate; break; } }
    }
    for (const scale of scales) yield* grid(scale, 3);
    return;
  }

  // Negative-space regions around the union of the subject boxes, inside the safe area.
  const regions: Record<"left" | "right" | "top" | "bottom", Box> = {
    left: { x0: safe.x0, y0: safe.y0, x1: Math.min(safe.x1, subject.x0), y1: safe.y1 },
    right: { x0: Math.max(safe.x0, subject.x1), y0: safe.y0, x1: safe.x1, y1: safe.y1 },
    top: { x0: safe.x0, y0: safe.y0, x1: safe.x1, y1: Math.min(safe.y1, subject.y0) },
    bottom: { x0: safe.x0, y0: Math.max(safe.y0, subject.y1), x1: safe.x1, y1: safe.y1 },
  };
  const subjectCx = (subject.x0 + subject.x1) / 2, subjectCy = (subject.y0 + subject.y1) / 2;

  const inRegion = (name: keyof typeof regions, scale: number): PlacementResult | undefined => {
    const region = regions[name];
    const w = request.block.width * scale, h = request.block.height * scale;
    if (region.x1 - region.x0 < w || region.y1 - region.y0 < h) return undefined;
    const gapX = short * 0.02;
    let candidate: PlacementResult;
    switch (name) {
      case "left": {
        // Hug the subject: right-aligned text ending just left of it, vertically on the subject centre line.
        const x = clamp(region.x1 - gapX - w, region.x0, region.x1 - w);
        candidate = place(x, clamp(subjectCy - h / 2, region.y0, region.y1 - h), scale, "end", "left");
        break;
      }
      case "right": {
        const x = clamp(region.x0 + gapX, region.x0, region.x1 - w);
        candidate = place(x, clamp(subjectCy - h / 2, region.y0, region.y1 - h), scale, "start", "right");
        break;
      }
      case "top": {
        const x = clamp(subjectCx - w / 2, region.x0, region.x1 - w);
        candidate = place(x, region.y0 + (region.y1 - region.y0 - h) * 0.58, scale, "center", "top");
        break;
      }
      default: {
        const x = clamp(subjectCx - w / 2, region.x0, region.x1 - w);
        candidate = place(x, region.y0 + (region.y1 - region.y0 - h) * 0.3, scale, "center", "bottom");
      }
    }
    return clear(candidate) ? candidate : undefined;
  };

  const byArea = (Object.keys(regions) as Array<keyof typeof regions>).sort((a, b) => area(regions[b]) - area(regions[a]));
  const order = preference === "left" || preference === "right" || preference === "top" || preference === "bottom"
    ? [preference, ...byArea.filter(name => name !== preference)] : byArea;
  // 1. Negative-space regions around the subjects, shrinking a little (to 76%).
  // 2. Then, per scale, the regions and a grid over the whole safe area that clears every box separately (text may sit
  //    between two important regions), so a big block between subjects beats a tiny one beside their union.
  for (const scale of scales.filter(value => value >= 0.76)) {
    for (const name of order) { const candidate = inRegion(name, scale); if (candidate) yield candidate; }
  }
  for (const scale of scales) {
    for (const name of order) { const candidate = inRegion(name, scale); if (candidate) yield candidate; }
    yield* grid(scale, 5);
  }
}

/** Normalized [x0, y0, x1, y1] → px box. */
export function boxFromNormalized(box: readonly [number, number, number, number], frame: { width: number; height: number }): Box {
  return { x0: box[0] * frame.width, y0: box[1] * frame.height, x1: box[2] * frame.width, y1: box[3] * frame.height };
}

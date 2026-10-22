import { fmt } from "./document";

/**
 * Operations on the absolute path data this library produces (glyphs.ts outlines,
 * document.ts builders): M/L/H/V/Q/C/Z with absolute coordinates. Relative
 * commands and arcs are refused rather than guessed.
 *
 * - flattenPathD: curves → polygons (contours), used by roughen.ts and glyphCells.ts.
 * - transformPathD: an affine matrix applied to every coordinate (rotate / scale /
 *   place a glyph outline without a transform attribute, e.g. to merge many glyphs
 *   into one <path>).
 */

export type FlatPoint = readonly [number, number];

/** Affine matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG matrix order). */
export type AffineMatrix = readonly [number, number, number, number, number, number];

type Segment =
  | { readonly type: "M" | "L"; readonly x: number; readonly y: number }
  | { readonly type: "Q"; readonly x1: number; readonly y1: number; readonly x: number; readonly y: number }
  | { readonly type: "C"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly type: "Z" };

/** Parse absolute M/L/H/V/Q/C/Z path data into M/L/Q/C/Z segments (H and V become L). */
export function parseAbsolutePathD(d: string, label = "path"): Segment[] {
  const tokens = d.match(/[MLHVQCZAmlhvqcza]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const segments: Segment[] = [];
  let index = 0, command = "", x = 0, y = 0, startX = 0, startY = 0;
  const number = () => {
    const token = tokens[index++];
    const value = Number(token);
    if (token === undefined || !Number.isFinite(value)) throw new Error(`${label}: malformed path data`);
    return value;
  };
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      index += 1;
      if (command !== command.toUpperCase() || command === "A") throw new Error(`${label}: only absolute M/L/H/V/Q/C/Z path data is supported`);
      if (command === "Z") { segments.push({ type: "Z" }); x = startX; y = startY; continue; }
    } else if (!command || command === "Z") throw new Error(`${label}: malformed path data`);
    switch (command) {
      case "M": {
        x = startX = number(); y = startY = number();
        segments.push({ type: "M", x, y });
        command = "L"; // Implicit lineto after the first moveto pair.
        break;
      }
      case "L": x = number(); y = number(); segments.push({ type: "L", x, y }); break;
      case "H": x = number(); segments.push({ type: "L", x, y }); break;
      case "V": y = number(); segments.push({ type: "L", x, y }); break;
      case "Q": { const x1 = number(), y1 = number(); x = number(); y = number(); segments.push({ type: "Q", x1, y1, x, y }); break; }
      case "C": {
        const x1 = number(), y1 = number(), x2 = number(), y2 = number();
        x = number(); y = number();
        segments.push({ type: "C", x1, y1, x2, y2, x, y });
        break;
      }
      default: throw new Error(`${label}: unsupported command ${command}`);
    }
  }
  return segments;
}

export interface FlattenOptions {
  /** Target chord length in px when subdividing curves (default 6). */
  readonly segmentLength?: number;
  /** Prefix for error messages. */
  readonly label?: string;
}

/**
 * Flatten absolute path data into closed polygons. Each contour drops repeated
 * points and its duplicate closing point; contours with fewer than 3 points are
 * dropped. Quadratics use ceil(chord / segmentLength) steps (2–24), cubics
 * ceil(control polygon / segmentLength) steps (3–32).
 */
export function flattenPathD(d: string, options: FlattenOptions = {}): FlatPoint[][] {
  const segmentLength = options.segmentLength ?? 6;
  if (!(segmentLength > 0)) throw new Error("flattenPathD needs a positive segmentLength");
  const contours: FlatPoint[][] = [];
  let current: FlatPoint[] | null = null, x = 0, y = 0, startX = 0, startY = 0;
  for (const segment of parseAbsolutePathD(d, options.label ?? "path")) {
    switch (segment.type) {
      case "M":
        if (current && current.length) contours.push(current);
        x = startX = segment.x; y = startY = segment.y;
        current = [[x, y]];
        break;
      case "L":
        current ??= [[x, y]];
        current.push([segment.x, segment.y]);
        x = segment.x; y = segment.y;
        break;
      case "Q": {
        current ??= [[x, y]];
        const steps = Math.max(2, Math.min(24, Math.ceil(Math.hypot(segment.x - x, segment.y - y) / segmentLength)));
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps, u = 1 - t;
          current.push([u * u * x + 2 * u * t * segment.x1 + t * t * segment.x, u * u * y + 2 * u * t * segment.y1 + t * t * segment.y]);
        }
        x = segment.x; y = segment.y;
        break;
      }
      case "C": {
        current ??= [[x, y]];
        const length = Math.hypot(segment.x1 - x, segment.y1 - y) + Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
          + Math.hypot(segment.x - segment.x2, segment.y - segment.y2);
        const steps = Math.max(3, Math.min(32, Math.ceil(length / segmentLength)));
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps, u = 1 - t;
          current.push([u * u * u * x + 3 * u * u * t * segment.x1 + 3 * u * t * t * segment.x2 + t * t * t * segment.x,
            u * u * u * y + 3 * u * u * t * segment.y1 + 3 * u * t * t * segment.y2 + t * t * t * segment.y]);
        }
        x = segment.x; y = segment.y;
        break;
      }
      case "Z":
        if (current && current.length) contours.push(current);
        current = null; x = startX; y = startY;
        break;
    }
  }
  if (current && current.length) contours.push(current);
  return contours.map(contour => {
    const cleaned: FlatPoint[] = [];
    for (const point of contour) {
      const last = cleaned[cleaned.length - 1];
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-6) cleaned.push(point);
    }
    if (cleaned.length > 2) {
      const first = cleaned[0], last = cleaned[cleaned.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) cleaned.pop();
    }
    return cleaned;
  }).filter(contour => contour.length >= 3);
}

/** Matrix for translate(tx, ty) · rotate(degrees) · scale(sx, sy), the usual "place a glyph" order. */
export function placementMatrix(tx: number, ty: number, degrees = 0, sx = 1, sy = sx): AffineMatrix {
  const radians = (degrees * Math.PI) / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  return [cos * sx, sin * sx, -sin * sy, cos * sy, tx, ty];
}

/** Apply an affine matrix to absolute path data; returns absolute M/L/Q/C/Z (decimals default 2). */
export function transformPathD(d: string, matrix: AffineMatrix, decimals: 0 | 1 | 2 | 3 = 2): string {
  if (!d) return "";
  const [a, b, c, dd, e, f] = matrix;
  if (![a, b, c, dd, e, f].every(Number.isFinite)) throw new Error("transformPathD needs a finite matrix");
  const point = (x: number, y: number) => `${fmt(a * x + c * y + e, decimals)} ${fmt(b * x + dd * y + f, decimals)}`;
  let text = "";
  for (const segment of parseAbsolutePathD(d, "transformPathD")) {
    switch (segment.type) {
      case "M": case "L": text += `${segment.type}${point(segment.x, segment.y)}`; break;
      case "Q": text += `Q${point(segment.x1, segment.y1)} ${point(segment.x, segment.y)}`; break;
      case "C": text += `C${point(segment.x1, segment.y1)} ${point(segment.x2, segment.y2)} ${point(segment.x, segment.y)}`; break;
      case "Z": text += "Z"; break;
    }
  }
  return text;
}

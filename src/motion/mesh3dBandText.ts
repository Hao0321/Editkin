import type { Font } from "opentype.js";
import { mesh3dGlyphRun, mesh3dPolylineBounds, mesh3dPushOrientedTriangle, type Mesh3dMeshData, type Mesh3dPolyline } from "./mesh3dExtrude";

/**
 * Text carried on a rotating band (R7 「SOMEONE」「Knows」): an alpha mask of real
 * glyph outlines wrapped around an open cylinder or a bulged torus strip. The
 * mask covers one repeat period (u wraps), keeps four box-filtered mip levels and
 * is sampled as coverage, so letters stay crisp near the camera and calm far away.
 */
export interface Mesh3dMaskLevelV1 { readonly width: number; readonly height: number; readonly alpha: Uint8Array; }
export interface Mesh3dMaskV1 { readonly levels: readonly Mesh3dMaskLevelV1[]; readonly repeat: number; }
export interface Mesh3dBandTextSpecV1 {
  text: string; form: "cylinder" | "torus"; facing: "outside" | "inside"; radius: number; height: number;
  segments: number; repeat: number; tracking: number;
}

const SUPERSAMPLE = 4;
/** Nonzero-winding coverage of closed polylines (pixel units, y-down), 4×4 supersampled. */
export function mesh3dRasterizeCoverageV1(contours: readonly Mesh3dPolyline[], width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4_194_304) throw new Error("MESH_MASK_SIZE_INVALID");
  const top: number[] = [], bottom: number[] = [], xTop: number[] = [], slope: number[] = [], direction: number[] = [];
  for (const poly of contours) for (let i = 0, n = poly.length / 2; i < n; i++) {
    const j = (i + 1) % n, x0 = poly[i * 2], y0 = poly[i * 2 + 1], x1 = poly[j * 2], y1 = poly[j * 2 + 1];
    if (y0 === y1) continue;
    const down = y1 > y0;
    top.push(down ? y0 : y1); bottom.push(down ? y1 : y0); xTop.push(down ? x0 : x1); slope.push((x1 - x0) / (y1 - y0)); direction.push(down ? 1 : -1);
  }
  const order = top.map((_, i) => i).sort((a, b) => top[a] - top[b]);
  const counts = new Uint8Array(width * height), active: number[] = [], xs: number[] = [], ds: number[] = [];
  let next = 0;
  for (let sy = 0; sy < height * SUPERSAMPLE; sy++) {
    const y = (sy + .5) / SUPERSAMPLE, row = (sy / SUPERSAMPLE | 0) * width;
    while (next < order.length && top[order[next]] <= y) active.push(order[next++]);
    let count = 0;
    for (let k = 0; k < active.length; k++) { const e = active[k]; if (bottom[e] > y) active[count++] = e; }
    active.length = count;
    if (!count) continue;
    xs.length = 0; ds.length = 0;
    for (const e of active) if (top[e] <= y) { xs.push(xTop[e] + (y - top[e]) * slope[e]); ds.push(direction[e]); }
    const sorted = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    let winding = 0, start = 0;
    for (const i of sorted) {
      const before = winding; winding += ds[i];
      if (before === 0 && winding !== 0) start = xs[i];
      else if (before !== 0 && winding === 0) {
        const c0 = Math.max(0, Math.ceil(start * SUPERSAMPLE - .5)), c1 = Math.min(width * SUPERSAMPLE - 1, Math.floor(xs[i] * SUPERSAMPLE - .5));
        for (let c = c0; c <= c1; c++) counts[row + (c >> 2)]++;
      }
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(counts[i] * 255 / (SUPERSAMPLE * SUPERSAMPLE));
  return alpha;
}

function mipLevels(base: Mesh3dMaskLevelV1): Mesh3dMaskLevelV1[] {
  const levels = [base];
  while (levels.length < 5) {
    const p = levels[levels.length - 1];
    if (p.width < 8 || p.height < 8) break;
    const width = p.width >> 1, height = p.height >> 1, alpha = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const a = (y * 2) * p.width + x * 2;
      alpha[y * width + x] = (p.alpha[a] + p.alpha[a + 1] + p.alpha[a + p.width] + p.alpha[a + p.width + 1] + 2) >> 2;
    }
    levels.push({ width, height, alpha });
  }
  return levels;
}

/** Band surface plus its text mask. u runs once around (read left to right from the facing side), v bottom → top. */
export function mesh3dBandTextV1(font: Font, spec: Mesh3dBandTextSpecV1, faceLabel: string): { data: Mesh3dMeshData; mask: Mesh3dMaskV1 } {
  const r = spec.height / 2, circumference = 2 * Math.PI * (spec.form === "torus" ? (spec.facing === "outside" ? spec.radius + r : spec.radius - r) : spec.radius);
  const bandArc = spec.form === "torus" ? Math.PI * r : spec.height, aspect = circumference / spec.repeat / bandArc;
  const maskHeight = Math.max(48, Math.min(384, Math.floor(2048 / aspect))), maskWidth = Math.max(16, Math.min(4096, Math.round(maskHeight * aspect)));
  // Lay out at the em size, then centre the ink box in one period (shrinking only if it would not fit).
  let em = maskHeight * .8;
  let run = mesh3dGlyphRun(font, spec.text, em, spec.tracking, .2, 16, faceLabel);
  let bounds = mesh3dPolylineBounds(run.contours.flat());
  const inkWidth = bounds[2] - bounds[0], inkHeight = bounds[3] - bounds[1];
  const fit = Math.min(1, maskWidth * .92 / Math.max(1e-6, inkWidth), maskHeight * .86 / Math.max(1e-6, inkHeight));
  if (fit < 1) { em *= fit; run = mesh3dGlyphRun(font, spec.text, em, spec.tracking, .2, 16, faceLabel); bounds = mesh3dPolylineBounds(run.contours.flat()); }
  const dx = maskWidth / 2 - (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
  const pixels = run.contours.flat().map(poly => poly.map((value, i) => i % 2 ? maskHeight / 2 - (value - cy) : value + dx));
  const alpha = Number.isFinite(dx) ? mesh3dRasterizeCoverageV1(pixels, maskWidth, maskHeight) : new Uint8Array(maskWidth * maskHeight);
  const mask: Mesh3dMaskV1 = { levels: mipLevels({ width: maskWidth, height: maskHeight, alpha }), repeat: spec.repeat };

  const data: Mesh3dMeshData = { positions: [], normals: [], uvs: [], indices: [] };
  const rows = spec.form === "torus" ? 12 : 1, inside = spec.facing === "inside" ? -1 : 1;
  for (let row = 0; row <= rows; row++) for (let j = 0; j <= spec.segments; j++) {
    const theta = 2 * Math.PI * j / spec.segments * inside, s = Math.sin(theta), c = Math.cos(theta), v = row / rows;
    let radius = spec.radius, y = (v - .5) * spec.height, ny = 0, nr = inside;
    if (spec.form === "torus") { const phi = (v - .5) * Math.PI; radius = spec.radius + inside * r * Math.cos(phi); y = r * Math.sin(phi); nr = inside * Math.cos(phi); ny = Math.sin(phi); }
    data.positions.push(radius * s, y, radius * c); data.normals.push(nr * s, ny, nr * c); data.uvs.push(j / spec.segments, v);
  }
  for (let row = 0; row < rows; row++) for (let j = 0; j < spec.segments; j++) {
    const a = row * (spec.segments + 1) + j, b = a + 1, c = a + spec.segments + 1, d = c + 1;
    mesh3dPushOrientedTriangle(data, a, b, d); mesh3dPushOrientedTriangle(data, a, d, c);
  }
  return { data, mask };
}

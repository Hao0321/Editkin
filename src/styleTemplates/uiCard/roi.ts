/**
 * ROI follow for screen recordings (browser-safe math; the Node analyzer measures the heat).
 *
 * Heat: per analysis frame, a coarse grid of how much the pixels changed (frame differences, decayed over ~0.4 s),
 * inside the recording's content box (black bars excluded). Each frame the window of the card's size that holds the
 * most heat is the target; a dead zone holds the camera still when the action stays inside it, and a critically
 * damped spring moves it otherwise (no overshoot, no jitter). The window never leaves the content box.
 */

export interface RoiBox { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export interface RoiHeat {
  /** Analysis frames per second. */
  readonly rate: number;
  readonly source: { readonly width: number; readonly height: number };
  /** Non-black content of the recording (source px). */
  readonly content: RoiBox;
  readonly cols: number;
  readonly rows: number;
  /** Per analysis frame: cols × rows heat over the whole source (row-major). */
  readonly frames: readonly Float32Array[];
  /** Optional cols × rows information density (edge energy): ties and quiet moments go to the detailed UI. */
  readonly detail?: Float32Array;
}

export interface RoiWindow { readonly cx: number; readonly cy: number; readonly w: number; readonly h: number }

export interface RoiFollowOptions {
  /** Window size (source px) at rest. */
  readonly width: number;
  readonly height: number;
  /** Output frame rate and frame count of the shot. */
  readonly fps: number;
  readonly frames: number;
  /** Source time (s, relative to the heat's frame 0) of output frame 0. */
  readonly offset?: number;
  /** Dead zone as a share of the window size. */
  readonly deadZone?: number;
  /** Spring angular frequency (rad/s): higher follows faster. */
  readonly omega?: number;
  /** Heat below this (sum inside the content) counts as "nothing moves": hold. */
  readonly minHeat?: number;
  /** A fixed focus box (source px) instead of following. */
  readonly fixed?: RoiBox;
}

export function clampWindow(cx: number, cy: number, w: number, h: number, content: RoiBox): { cx: number; cy: number } {
  const clamp = (value: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, value)));
  return { cx: clamp(cx, content.x0 + w / 2, content.x1 - w / 2), cy: clamp(cy, content.y0 + h / 2, content.y1 - h / 2) };
}

/** Target centre per analysis frame: the window position (stride one cell) that holds the most heat, near the last one. */
export function roiTargets(heat: RoiHeat, width: number, height: number, minHeat = 0): Array<{ cx: number; cy: number } | undefined> {
  const { cols, rows } = heat, cw = heat.source.width / cols, ch = heat.source.height / rows;
  const wc = Math.max(1, Math.round(width / cw)), hc = Math.max(1, Math.round(height / ch));
  const c0 = Math.max(0, Math.floor(heat.content.x0 / cw)), c1 = Math.min(cols, Math.ceil(heat.content.x1 / cw));
  const r0 = Math.max(0, Math.floor(heat.content.y0 / ch)), r1 = Math.min(rows, Math.ceil(heat.content.y1 / ch));
  const integral = new Float64Array((cols + 1) * (rows + 1));
  const detailIntegral = new Float64Array((cols + 1) * (rows + 1));
  let detailTotal = 0;
  if (heat.detail) {
    for (let r = 0; r < rows; r += 1) {
      let rowSum = 0;
      for (let c = 0; c < cols; c += 1) {
        const value = c >= c0 && c < c1 && r >= r0 && r < r1 ? heat.detail[r * cols + c] : 0;
        rowSum += value; detailTotal += value;
        detailIntegral[(r + 1) * (cols + 1) + c + 1] = detailIntegral[r * (cols + 1) + c + 1] + rowSum;
      }
    }
  }
  const detailSum = (ca: number, ra: number, cb: number, rb: number) => (detailTotal > 0
    ? (detailIntegral[rb * (cols + 1) + cb] - detailIntegral[ra * (cols + 1) + cb] - detailIntegral[rb * (cols + 1) + ca] + detailIntegral[ra * (cols + 1) + ca]) / detailTotal : 0);
  let previous: { cx: number; cy: number } | undefined;
  return heat.frames.map(frame => {
    integral.fill(0);
    let total = 0;
    for (let r = 0; r < rows; r += 1) {
      let rowSum = 0;
      for (let c = 0; c < cols; c += 1) {
        const inside = c >= c0 && c < c1 && r >= r0 && r < r1;
        const value = inside ? frame[r * cols + c] : 0;
        rowSum += value; total += value;
        integral[(r + 1) * (cols + 1) + c + 1] = integral[r * (cols + 1) + c + 1] + rowSum;
      }
    }
    if (total <= minHeat && (previous || detailTotal <= 0)) return previous;
    const sum = (ca: number, ra: number, cb: number, rb: number) =>
      integral[rb * (cols + 1) + cb] - integral[ra * (cols + 1) + cb] - integral[rb * (cols + 1) + ca] + integral[ra * (cols + 1) + ca];
    let best = -Infinity, bestCx = 0, bestCy = 0;
    const maxC = Math.max(c0, c1 - wc), maxR = Math.max(r0, r1 - hc);
    for (let r = r0; r <= maxR; r += 1) {
      for (let c = c0; c <= maxC; c += 1) {
        const cx = (c + wc / 2) * cw, cy = (r + hc / 2) * ch;
        // A small pull toward the current centre keeps ties (and near-ties) from flipping the camera.
        const distance = previous ? Math.hypot(cx - previous.cx, cy - previous.cy) / Math.max(width, height) : 0;
        const cb = Math.min(cols, c + wc), rb = Math.min(rows, r + hc);
        const action = total > minHeat ? sum(c, r, cb, rb) / total : 0;
        const score = (action + 0.6 * detailSum(c, r, cb, rb)) * (1 - 0.35 * distance);
        if (score > best) { best = score; bestCx = cx; bestCy = cy; }
      }
    }
    previous = clampWindow(bestCx, bestCy, width, height, heat.content);
    return previous;
  });
}

/** Per output frame window centre: dead zone + critically damped spring, clamped inside the content. */
export function followRoi(heat: RoiHeat, options: RoiFollowOptions): RoiWindow[] {
  const { width: w, height: h, fps, frames } = options;
  const dead = options.deadZone ?? 0.12, omega = options.omega ?? 3.2;
  const offset = options.offset ?? 0;
  if (options.fixed) {
    const f = options.fixed;
    const centre = clampWindow((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, w, h, heat.content);
    return Array.from({ length: frames }, () => ({ cx: centre.cx, cy: centre.cy, w, h }));
  }
  const targets = roiTargets(heat, w, h, options.minHeat ?? 0);
  const first = targets.find(Boolean) ?? clampWindow((heat.content.x0 + heat.content.x1) / 2, (heat.content.y0 + heat.content.y1) / 2, w, h, heat.content);
  // Start where the action is at the shot's first frame (no drift-in from the centre).
  const startIndex = Math.max(0, Math.min(targets.length - 1, Math.round(offset * heat.rate)));
  const start = targets.slice(0, startIndex + 1).reverse().find(Boolean) ?? first;
  let cx = start.cx, cy = start.cy, vx = 0, vy = 0, goalX = cx, goalY = cy;
  const out: RoiWindow[] = [];
  const dt = 1 / fps;
  for (let i = 0; i < frames; i += 1) {
    const time = offset + i / fps;
    const target = targets[Math.max(0, Math.min(targets.length - 1, Math.floor(time * heat.rate)))] ?? { cx: goalX, cy: goalY };
    // Dead zone: re-aim only when the action leaves the middle of the current view.
    if (Math.abs(target.cx - cx) > dead * w || Math.abs(target.cy - cy) > dead * h) { goalX = target.cx; goalY = target.cy; }
    for (let sub = 0; sub < 4; sub += 1) {
      const step = dt / 4;
      const ax = omega * omega * (goalX - cx) - 2 * omega * vx, ay = omega * omega * (goalY - cy) - 2 * omega * vy;
      vx += ax * step; vy += ay * step; cx += vx * step; cy += vy * step;
    }
    const clamped = clampWindow(cx, cy, w, h, heat.content);
    if (clamped.cx !== cx) { cx = clamped.cx; vx = 0; }
    if (clamped.cy !== cy) { cy = clamped.cy; vy = 0; }
    out.push({ cx, cy, w, h });
  }
  return out;
}

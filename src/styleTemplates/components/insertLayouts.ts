import { createSvgDocument, fmt, g, path, rect, roundRect } from "../../motionLibrary/svg/document";
import { clamp01, curve } from "../../motionLibrary/svg/easing";
import { createSeededRng } from "../../motionLibrary/svg/random";
import { dropShadow } from "../svgFx";

/**
 * C5 insert layouts: a rounded picture-in-picture card (R3), a split screen (R5: the insert on top, the
 * footage below), a torn-paper frame (R5 collage). The insert itself is an ordinary clip (masked and
 * transformed by commands); these generators draw what surrounds it — the soft shadow and torn paper
 * margin UNDER the clip and the card border / split divider OVER it — and share the entry/exit pose with
 * the clip's transform keyframes, so frame and clip move as one.
 */

export const INSERT_FRAME_REVISION = 1;
export type InsertFrameLayout = "pip" | "split" | "tornPaper";

export interface InsertRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export interface InsertFrameParams {
  readonly component: "insertFrame";
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly layout: InsertFrameLayout;
  readonly part: "under" | "over";
  readonly duration: number;
  readonly rect: InsertRect;
  readonly radius: number;
  readonly rotation: number;
  readonly slide: { readonly dx: number; readonly dy: number };
  readonly colors: { readonly border?: string; readonly paper: string; readonly shadow: string; readonly divider: string };
  readonly borderWidth: number;
  readonly shadowOpacity: number;
  readonly seed: number;
}

const ENTRY = 0.32, EXIT = 0.22;

/** Shared pose (frame px offset, opacity) of the insert at local time t: slide + fade in, fade out. */
export function insertPose(params: Pick<InsertFrameParams, "slide" | "duration">, t: number): { dx: number; dy: number; opacity: number } {
  const e = curve("expoOut", clamp01(t / ENTRY));
  const out = clamp01((t - (params.duration - EXIT)) / EXIT);
  return { dx: params.slide.dx * (1 - e), dy: params.slide.dy * (1 - e), opacity: Math.min(1, t / 0.18) * (1 - curve("snapIn", out)) };
}

/** Torn edge polygon of a rect (closed, rect-local px). `maxPoints` caps the vertex count (a clip mask takes at most 64). */
export function tornPolygon(rectW: number, rectH: number, seed: number, amplitude: number, margin = 0, maxPoints = Infinity): Array<[number, number]> {
  const rng = createSeededRng("tornPaper", seed, "edge");
  const step = Math.max(6, Math.min(rectW, rectH) * 0.025, (2 * (rectW + rectH)) / Math.max(8, maxPoints - 4));
  const pts: Array<[number, number]> = [];
  const edge = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(len / step));
    for (let i = 0; i < n; i += 1) {
      const u = i / n, j = (rng.next() - 0.35) * amplitude + (i % 3 === 0 ? amplitude * 0.5 : 0);
      pts.push([x0 + (x1 - x0) * u + nx * (j + margin), y0 + (y1 - y0) * u + ny * (j + margin)]);
    }
  };
  edge(0, 0, rectW, 0, 0, -1); edge(rectW, 0, rectW, rectH, 1, 0); edge(rectW, rectH, 0, rectH, 0, 1); edge(0, rectH, 0, 0, -1, 0);
  return pts;
}

/** The insert's own outline (rect-local px, at most 60 points): what the clip mask cuts and the stage texture clips to. */
export function insertOutline(layout: InsertFrameLayout | "full", w: number, h: number, radius: number, seed: number): Array<[number, number]> {
  if (layout === "tornPaper") return tornPolygon(w, h, seed, Math.min(w, h) * 0.018, 0, 60);
  if (layout === "pip") return roundedRectPolygon(w, h, radius);
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/** Rounded-rect polygon (rect-local px) for a clip mask: corners as 8-point arcs. */
export function roundedRectPolygon(w: number, h: number, r: number): Array<[number, number]> {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2)), pts: Array<[number, number]> = [];
  const corner = (cx: number, cy: number, start: number) => {
    for (let i = 0; i <= 8; i += 1) { const a = start + (i / 8) * (Math.PI / 2); pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]); }
  };
  corner(w - radius, radius, -Math.PI / 2); corner(w - radius, h - radius, 0); corner(radius, h - radius, Math.PI / 2); corner(radius, radius, Math.PI);
  return pts;
}

const polyD = (pts: ReadonlyArray<readonly [number, number]>, ox: number, oy: number) =>
  `M${pts.map(([x, y]) => `${fmt(x + ox, 1)} ${fmt(y + oy, 1)}`).join("L")}Z`;

export function insertFrame(params: InsertFrameParams, t: number): string {
  const doc = createSvgDocument({ width: params.width, height: params.height }, { idPrefix: "if" });
  const pose = insertPose(params, t);
  if (pose.opacity <= 0.001) return doc.render();
  const { rect: r } = params;
  const x = r.x + pose.dx, y = r.y + pose.dy;
  const cx = x + r.w / 2, cy = y + r.h / 2;
  const rot = params.rotation ? `rotate(${fmt(params.rotation, 2)} ${fmt(cx, 1)} ${fmt(cy, 1)})` : undefined;
  const parts: string[] = [];
  const box = { x0: x, y0: y, x1: x + r.w, y1: y + r.h };
  switch (params.layout) {
    case "pip": {
      if (params.part === "under") {
        parts.push(g({ filter: dropShadow(doc, { box, sigma: Math.min(r.w, r.h) * 0.04, dy: Math.min(r.w, r.h) * 0.025, color: params.colors.shadow, opacity: params.shadowOpacity }) },
          roundRect(x, y, r.w, r.h, params.radius, { fill: params.colors.shadow })));
      } else if (params.colors.border && params.borderWidth > 0) {
        const inset = params.borderWidth / 2;
        parts.push(roundRect(x + inset, y + inset, r.w - 2 * inset, r.h - 2 * inset, Math.max(0, params.radius - inset),
          { fill: "none", stroke: params.colors.border, "stroke-width": Number(fmt(params.borderWidth, 2)) }));
      }
      break;
    }
    case "tornPaper": {
      if (params.part === "under") {
        const amp = Math.min(r.w, r.h) * 0.018, margin = Math.min(r.w, r.h) * 0.035;
        const paper = polyD(tornPolygon(r.w, r.h, params.seed + 11, amp * 1.3, margin), x, y);
        parts.push(g({ filter: dropShadow(doc, { box, sigma: Math.min(r.w, r.h) * 0.03, dy: Math.min(r.w, r.h) * 0.02, color: params.colors.shadow, opacity: params.shadowOpacity }) },
          path(paper, { fill: params.colors.paper })));
      }
      break;
    }
    case "split": {
      if (params.part === "over") {
        // A divider bar sliding across the seam.
        const grow = curve("expoOut", clamp01(t / 0.45));
        const barH = Math.max(4, params.height * 0.006);
        parts.push(rect(0, r.y + r.h - barH / 2, params.width * grow, barH, { fill: params.colors.divider }));
      }
      break;
    }
  }
  return doc.render(g({ transform: rot, opacity: pose.opacity < 0.999 ? Number(fmt(pose.opacity, 3)) : undefined }, parts));
}

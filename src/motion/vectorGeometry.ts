import type { MotionGraphic } from "../domain/types";
import type { MotionGraphicV2FrameReceipt, MotionGraphicV2LayoutReceipt } from "./compositionV2";
import { motionPanelPaths } from "./panelGeometry";
import { connectionFieldGeometry } from "./connectionField";

export interface MotionVectorPath { color: string; ass: string; svg: string }
const r = (value: number) => Math.round(value * 100) / 100;

/** Cubic ellipse contours are authored here once for SVG and libass. */
function ellipse(cx: number, cy: number, rx: number, ry: number) {
  const k = .5522847498;
  const commands = [
    { op: "m", p: [cx + rx, cy] },
    { op: "b", p: [cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry] },
    { op: "b", p: [cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy] },
    { op: "b", p: [cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry] },
    { op: "b", p: [cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy] },
  ];
  return {
    ass: commands.map(c => `${c.op} ${c.p.map(r).join(" ")}`).join(" "),
    svg: commands.map(c => `${c.op === "b" ? "C" : "M"} ${c.p.map(r).join(" ")}`).join(" ") + " Z",
  };
}

/** Integer-frame geometry, independent of seek order and browser clocks. */
export function motionVectorPaths(graphic: MotionGraphic, layout: MotionGraphicV2LayoutReceipt, frame: MotionGraphicV2FrameReceipt): MotionVectorPath[] {
  const vector = graphic.vectorV2;
  if (!vector || !frame.visible || !frame.vectorState || frame.vectorState.opacity <= .001) return [];
  const { width, height } = layout.box;
  const progress = vector.revealFrames === 1 ? 1 : Math.max(0, Math.min(1, frame.localFrame / (vector.revealFrames - 1)));
  const reveal = 1 - (1 - progress) ** 3;
  const radius = graphic.cornerRadius ?? 8;
  if (vector.kind === "connection_field") {
    const geometry = connectionFieldGeometry(vector, width, height, frame.localFrame);
    const edgeShapes = geometry.edges.flatMap(({ from, to }) => {
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
      if (length < .1) return [];
      const ox = -dy / length * vector.lineWidthPixels / 2, oy = dx / length * vector.lineWidthPixels / 2;
      const coordinates = [[from.x + ox, from.y + oy], [to.x + ox, to.y + oy], [to.x - ox, to.y - oy], [from.x - ox, from.y - oy]];
      return [{ ass: `m ${coordinates[0].map(r).join(" ")} l ${coordinates.slice(1).flat().map(r).join(" ")}`,
        svg: `M ${coordinates[0].map(r).join(" ")} L ${coordinates.slice(1).flat().map(r).join(" ")} Z` }];
    });
    const paths: MotionVectorPath[] = [];
    if (edgeShapes.length) paths.push({ color: graphic.backgroundColor, ass: edgeShapes.map(p => p.ass).join(" "), svg: edgeShapes.map(p => p.svg).join(" ") });
    for (const group of [2, 1, 0]) {
      const nodes = geometry.points.filter(p => p.group === group).map(p => ellipse(p.x, p.y, p.radius, p.radius));
      paths.push({ color: vector.groupColors?.[group] ?? (group === 0 ? graphic.accentColor : graphic.textColor),
        ass: nodes.map(p => p.ass).join(" "), svg: nodes.map(p => p.svg).join(" ") });
    }
    if (geometry.connect > 0) paths.push({ color: graphic.accentColor, ...ellipse(geometry.center.x, geometry.center.y,
      vector.dotRadiusPixels * (1 + geometry.connect * 1.7), vector.dotRadiusPixels * (1 + geometry.connect * 1.7)) });
    return paths;
  }
  if (vector.kind === "step_progress") {
    const cellWidth = (width - vector.gapPixels * (vector.steps - 1)) / vector.steps;
    const background = [], foreground = [];
    const fill = vector.activeStep * reveal;
    for (let i = 0; i < vector.steps; i += 1) {
      const origin = { x: i * (cellWidth + vector.gapPixels), y: 0 };
      background.push(motionPanelPaths(cellWidth, height, radius, 0, origin));
      const filledWidth = cellWidth * Math.max(0, Math.min(1, fill - i));
      if (filledWidth > .01) foreground.push(motionPanelPaths(filledWidth, height, radius, 0, origin));
    }
    return [
      { color: graphic.backgroundColor, ass: background.map(p => p.fillAss).join(" "), svg: background.map(p => p.fillSvg).join(" ") },
      ...(foreground.length ? [{ color: graphic.accentColor, ass: foreground.map(p => p.fillAss).join(" "), svg: foreground.map(p => p.fillSvg).join(" ") }] : []),
    ];
  }
  if (vector.kind === "line_grid") {
    const buckets: Array<Array<{ ass: string; svg: string }>> = [[], []];
    const line = (x0: number, y0: number, x1: number, y1: number, major: boolean) => {
      const coordinates = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      buckets[major ? 1 : 0].push({ ass: `m ${coordinates[0].map(r).join(" ")} l ${coordinates.slice(1).flat().map(r).join(" ")}`,
        svg: `M ${coordinates[0].map(r).join(" ")} L ${coordinates.slice(1).flat().map(r).join(" ")} Z` });
    };
    if (Math.ceil(width / vector.spacingPixels) + Math.ceil(height / vector.spacingPixels) > 256) throw new Error("網格超出每層 256 線預算");
    // Inset half a cell so no line straddles the clipping edge. The background
    // stays still: its lattice supplies spatial structure without camera sway.
    for (let axis = 0; axis < 2; axis++) {
      const limit = axis === 0 ? width : height;
      for (let index = 0, position = vector.spacingPixels / 2; position < limit; position += vector.spacingPixels, index++) {
        const major = index % vector.majorEvery === 0, half = vector.lineWidthPixels * (major ? 1.25 : 1) / 2;
        if (axis === 0) line(Math.max(0, position - half), 0, Math.min(width, position + half), height, major);
        else line(0, Math.max(0, position - half), width, Math.min(height, position + half), major);
      }
    }
    return buckets.flatMap((paths, index) => paths.length ? [{ color: index ? graphic.textColor : graphic.accentColor,
      ass: paths.map(p => p.ass).join(" "), svg: paths.map(p => p.svg).join(" ") }] : []);
  }
  if (vector.kind === "dot_grid") {
    const dots = [];
    for (let y = vector.spacingPixels / 2; y + vector.dotRadiusPixels <= height; y += vector.spacingPixels) {
      for (let x = vector.spacingPixels / 2; x + vector.dotRadiusPixels <= width; x += vector.spacingPixels) {
        dots.push(ellipse(x, y, vector.dotRadiusPixels, vector.dotRadiusPixels));
        if (dots.length > 512) throw new Error("點陣超出每層 512 點預算");
      }
    }
    return dots.length ? [{ color: graphic.accentColor, ass: dots.map(d => d.ass).join(" "), svg: dots.map(d => d.svg).join(" ") }] : [];
  }
  if (vector.kind === "ellipse") return [{ color: graphic.backgroundColor, ...ellipse(width / 2, height / 2, width / 2, height / 2) }];
  const drawnWidth = vector.kind === "rule" ? width * reveal : width;
  if (drawnWidth <= .01) return [];
  const paths = motionPanelPaths(drawnWidth, height, radius, vector.kind === "panel" ? graphic.outlineWidth ?? 0 : 0);
  return [
    { color: vector.kind === "rule" ? graphic.accentColor : graphic.backgroundColor, ass: paths.fillAss, svg: paths.fillSvg },
    ...(paths.borderAss ? [{ color: graphic.accentColor, ass: paths.borderAss, svg: paths.borderSvg }] : []),
  ];
}

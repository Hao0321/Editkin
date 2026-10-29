import type { PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";

type PathCommand = { op: "m" | "l" | "b"; points: number[] };
const rounded = (value: number) => Math.round(value * 100) / 100;

function contour(width: number, height: number, radius: number, inset = 0, reverse = false): PathCommand[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2)), k = r * .5522847498;
  const points = [
    [r, 0], [width - r, 0], [width - r + k, 0, width, r - k, width, r],
    [width, height - r], [width, height - r + k, width - r + k, height, width - r, height],
    [r, height], [r - k, height, 0, height - r + k, 0, height - r],
    [0, r], [0, r - k, r - k, 0, r, 0],
  ];
  let commands: PathCommand[] = points.map((p, i) => ({ op: i === 0 ? "m" : p.length === 6 ? "b" : "l", points: p }));
  if (reverse) {
    const backwards = commands.slice(1).map((command, index): PathCommand => ({
      op: command.op,
      points: command.op === "b"
        ? [command.points[2], command.points[3], command.points[0], command.points[1], ...commands[index].points.slice(-2)]
        : commands[index].points.slice(-2),
    })).reverse();
    commands = [{ op: "m", points: commands.at(-1)!.points.slice(-2) }, ...backwards];
  }
  return commands.map(command => ({ ...command, points: command.points.map(value => rounded(value + inset)) }));
}

/** The same authored rounded contour as SVG/ASS, delivered as numeric native geometry. */
export function motionPanelContourCommands(width: number, height: number, radius: number): readonly PreparedGlyphPathCommand[] {
  if (![width, height, radius].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Invalid motion panel geometry");
  return [...contour(width, height, radius).map((command): PreparedGlyphPathCommand => {
    const p = command.points;
    if (command.op === "b") return { type: "C", x1: p[0], y1: p[1], x2: p[2], y2: p[3], x: p[4], y: p[5] };
    return { type: command.op === "m" ? "M" : "L", x: p[0], y: p[1] };
  }), { type: "Z" }];
}

/** One inside-stroke geometry for both SVG preview and ASS output. CSS border
 * widths snap to device pixels, so they cannot represent this authored contour. */
export function motionPanelPaths(width: number, height: number, radius: number, outlineWidth: number, origin = { x: 0, y: 0 }) {
  if (![width, height, radius, outlineWidth].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Invalid motion panel geometry");
  const border = Math.max(0, Math.min(outlineWidth, width / 2, height / 2));
  const outer = contour(width, height, radius);
  const inner = border > 0 && width > border * 2 && height > border * 2
    ? contour(width - border * 2, height - border * 2, Math.max(0, radius - border), border, true) : [];
  const points = (command: PathCommand) => command.points.map((value, index) => rounded(value + (index % 2 ? origin.y : origin.x))).join(" ");
  const ass = (commands: PathCommand[]) => commands.map(c => `${c.op} ${points(c)}`).join(" ");
  const svg = (commands: PathCommand[]) => commands.map(c => `${c.op === "b" ? "C" : c.op.toUpperCase()} ${points(c)}`).join(" ");
  return {
    fillAss: ass(outer), fillSvg: `${svg(outer)} Z`,
    borderAss: border > 0 ? ass([...outer, ...inner]) : "",
    borderSvg: border > 0 ? `${svg(outer)} Z${inner.length ? ` ${svg(inner)} Z` : ""}` : "",
  };
}

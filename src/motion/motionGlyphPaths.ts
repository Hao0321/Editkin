import type { PreparedGlyph } from "../typography/preparedGlyphRun";

export const MOTION_GLYPH_MAX_COMMANDS = 4096;
export const MOTION_GLYPH_COORDINATE_LIMIT = 1_000_000;
export const MOTION_GLYPH_PATH_DECIMALS = 6;

/** Pixel bounds in the caller's baseline/y-down coordinate space, not em units. */
export interface MotionGlyphInk { xMin: number; yMin: number; xMax: number; yMax: number }

/** Closed, y-down pixel geometry. Quadratics have already been elevated to C. */
export type MotionGlyphPathCommand =
  | Readonly<{ type: "M"; x: number; y: number }>
  | Readonly<{ type: "L"; x: number; y: number }>
  | Readonly<{ type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }>
  | Readonly<{ type: "Z" }>;

export interface MotionGlyphPath {
  svg: string;
  ass: string;
  ink: MotionGlyphInk | null;
  commands: readonly MotionGlyphPathCommand[];
}

interface Point { x: number; y: number }

function coordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MOTION_GLYPH_COORDINATE_LIMIT) {
    throw new Error("Motion glyph coordinate is non-finite or exceeds the supported bound");
  }
  return value;
}

/** Round geometry once for every consumer; no exponent or signed zero. */
function canonicalCoordinate(value: number): number {
  const rounded = Number(coordinate(value).toFixed(MOTION_GLYPH_PATH_DECIMALS));
  return rounded === 0 ? 0 : rounded;
}

function commandCoordinates(command: Exclude<MotionGlyphPathCommand, { type: "Z" }>): number[] {
  return command.type === "C" ? [command.x1, command.y1, command.x2, command.y2, command.x, command.y]
    : [command.x, command.y];
}

/**
 * Convert an already prepared outline, never its text. getPath(0,0,UPM) already
 * includes its side bearing and is y-down relative to the baseline. Do not add
 * ink.xMin, flip y, or apply an ASS font/ascender/p1 baseline correction here.
 *
 * Q is elevated to C once in unrounded font units. SVG, ASS and numeric paths
 * then consume the same canonical pixel geometry. Contour direction is never reordered;
 * callers use nonzero fill. ASS has no polygon Z opcode: an explicit line back
 * to the contour start preserves closure before the next m contour.
 */
export function motionGlyphPath(glyph: PreparedGlyph, unitsPerEm: number, fontSize: number,
  originX = 0, baselineY = 0): MotionGlyphPath {
  if (!Number.isSafeInteger(unitsPerEm) || unitsPerEm < 16 || unitsPerEm > 16384
    || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 4096) {
    throw new Error("Motion glyph requires valid unitsPerEm and a positive bounded fontSize");
  }
  coordinate(originX); coordinate(baselineY);
  if (!glyph || !["glyph", "space", "newline"].includes(glyph.kind)
    || !Array.isArray(glyph.pathCommands) || glyph.pathCommands.length > MOTION_GLYPH_MAX_COMMANDS) {
    throw new Error("Motion glyph requires a prepared outline within the command bound");
  }
  const inkEm = glyph.inkEm;
  if (inkEm !== null && (!inkEm || ![inkEm.xMin, inkEm.yMin, inkEm.xMax, inkEm.yMax].every(Number.isFinite)
    || inkEm.xMin > inkEm.xMax || inkEm.yMin > inkEm.yMax)) {
    throw new Error("Motion glyph requires a finite ordered ink box");
  }
  if (glyph.kind !== "glyph" && (glyph.pathCommands.length !== 0 || inkEm !== null)) {
    throw new Error("Motion whitespace cannot carry an outline or ink box");
  }
  if ((glyph.pathCommands.length === 0) !== (inkEm === null)) {
    throw new Error("Motion glyph outline and ink presence disagree");
  }
  if (!glyph.pathCommands.length) return { svg: "", ass: "", ink: null, commands: Object.freeze([]) };

  const scale = fontSize / unitsPerEm;
  const transformed = (x: number, y: number): Point => {
    coordinate(x); coordinate(y);
    return { x: canonicalCoordinate(originX + x * scale), y: canonicalCoordinate(baselineY + y * scale) };
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): MotionGlyphPathCommand => {
    const c1 = transformed(x1, y1), c2 = transformed(x2, y2), end = transformed(x, y);
    return { type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y };
  };
  const commands: MotionGlyphPathCommand[] = [];
  let current: Point | undefined, start: Point | undefined;
  for (const command of glyph.pathCommands) {
    if (!command || typeof command !== "object") throw new Error("Invalid motion glyph path command");
    switch (command.type) {
      case "M":
        if (current) throw new Error("Motion glyph contour must close before the next M");
        commands.push({ type: "M", ...transformed(command.x, command.y) });
        current = { x: command.x, y: command.y }; start = current;
        break;
      case "L":
        if (!current) throw new Error("Motion glyph path must begin with M");
        commands.push({ type: "L", ...transformed(command.x, command.y) });
        current = { x: command.x, y: command.y };
        break;
      case "Q": {
        if (!current) throw new Error("Motion glyph path must begin with M");
        coordinate(command.x1); coordinate(command.y1); coordinate(command.x); coordinate(command.y);
        const c1 = { x: current.x + (command.x1 - current.x) * 2 / 3,
          y: current.y + (command.y1 - current.y) * 2 / 3 };
        const c2 = { x: command.x + (command.x1 - command.x) * 2 / 3,
          y: command.y + (command.y1 - command.y) * 2 / 3 };
        commands.push(cubic(c1.x, c1.y, c2.x, c2.y, command.x, command.y));
        current = { x: command.x, y: command.y };
        break;
      }
      case "C":
        if (!current) throw new Error("Motion glyph path must begin with M");
        commands.push(cubic(command.x1, command.y1, command.x2, command.y2, command.x, command.y));
        current = { x: command.x, y: command.y };
        break;
      case "Z":
        if (!current || !start) throw new Error("Motion glyph closure requires a contour start");
        commands.push({ type: "Z" });
        current = undefined; start = undefined;
        break;
      default:
        throw new Error("Unsupported motion glyph outline command");
    }
  }
  if (current) throw new Error("Motion glyph contour must close before conversion completes");
  // The bbox is a prepared physical ink measurement, not control-point bounds.
  // Return its scaled/translated pixels without a second bearing or baseline shift.
  const ink: MotionGlyphInk = {
    xMin: coordinate(originX + inkEm!.xMin * fontSize), yMin: coordinate(baselineY + inkEm!.yMin * fontSize),
    xMax: coordinate(originX + inkEm!.xMax * fontSize), yMax: coordinate(baselineY + inkEm!.yMax * fontSize),
  };
  const canonicalCommands = Object.freeze(commands.map(command => Object.freeze(command)));
  let contourStart: Point | undefined;
  return {
    svg: canonicalCommands.map(command => command.type === "Z" ? "Z" : command.type + " " + commandCoordinates(command).join(" ")).join(" "),
    ass: canonicalCommands.map(command => {
      if (command.type === "M") contourStart = command;
      if (command.type === "Z") {
        const close = `l ${contourStart!.x} ${contourStart!.y}`;
        contourStart = undefined;
        return close;
      }
      return (command.type === "C" ? "b" : command.type.toLowerCase()) + " " + commandCoordinates(command).join(" ");
    }).join(" "),
    ink, commands: canonicalCommands,
  };
}

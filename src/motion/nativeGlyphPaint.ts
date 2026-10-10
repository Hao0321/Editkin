import { assertPreparedGlyphRun, type PreparedGlyphRun, type PreparedGlyphPathCommand } from "../typography/preparedGlyphRun";

/** Candidate wire. Native consumer revalidates geometry and resource limits.
 * Physical glyph authority remains the factory, not a deserialized hash receipt. */
export interface NativeVectorPath {
  commands: readonly PreparedGlyphPathCommand[];
  fill_rule: "non_zero" | "even_odd";
}
export type NativePaint = Readonly<{ kind: "solid"; color: readonly [number, number, number, number] }>
  | Readonly<{ kind: "linear"; start: { x: number; y: number }; end: { x: number; y: number };
    stops: readonly { at: number; color: readonly [number, number, number, number] }[] }>
  | Readonly<{ kind: "radial"; center: { x: number; y: number }; radius: number;
    stops: readonly { at: number; color: readonly [number, number, number, number] }[] }>;
export interface NativePaintLayer {
  id: string; path: NativeVectorPath; paint: NativePaint; clips: readonly NativeVectorPath[];
  stroke?: Readonly<{ width: number; color: readonly [number, number, number, number] }>;
  /** Blur is Gaussian sigma in local pixels; the native consumer bounds its 3-sigma support. */
  shadow?: Readonly<{ offset_x: number; offset_y: number; blur: number; color: readonly [number, number, number, number] }>;
}
export interface NativePaintScene { width: number; height: number; max_scale?: number; background: readonly [number, number, number, number]; layers: readonly NativePaintLayer[] }
export interface NativeGlyphInk { xMin: number; yMin: number; xMax: number; yMax: number }
export interface NativeGlyphPaintPath {
  path: NativeVectorPath;
  ink: NativeGlyphInk;
  advance: number;
  font: Readonly<{ faceId: string; fontSha256: string; manifestSha256: string; parserVersion: string }>;
}
const MAX_COORDINATE = 1_000_000;
function coordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) throw new Error("Native glyph pixel coordinate invalid");
  return value;
}

/** Simple single-line physical glyphs. No CSS text, estimated width, implicit reflow or shaping. */
export function prepareNativeGlyphPaintPath(run: PreparedGlyphRun, fontSize: number,
  left: number, baseline: number, letterSpacing = 0): NativeGlyphPaintPath {
  assertPreparedGlyphRun(run);
  if (!Number.isFinite(fontSize) || fontSize < 1 || fontSize > 2048 || !Number.isFinite(letterSpacing)
    || Math.abs(letterSpacing) > fontSize || run.glyphs.some(glyph => glyph.kind === "newline")) {
    throw new Error("Native glyph requires a bounded font size, spacing and single line");
  }
  coordinate(left); coordinate(baseline);
  const scale = fontSize / run.unitsPerEm;
  let cursor = left;
  let ink: NativeGlyphInk | undefined;
  const commands: PreparedGlyphPathCommand[] = [];
  for (const [index, glyph] of run.glyphs.entries()) {
    if (glyph.inkEm) {
      const box = { xMin: coordinate(cursor + glyph.inkEm.xMin * fontSize),
        yMin: coordinate(baseline + glyph.inkEm.yMin * fontSize),
        xMax: coordinate(cursor + glyph.inkEm.xMax * fontSize),
        yMax: coordinate(baseline + glyph.inkEm.yMax * fontSize) };
      ink = ink ? { xMin: Math.min(ink.xMin, box.xMin), yMin: Math.min(ink.yMin, box.yMin),
        xMax: Math.max(ink.xMax, box.xMax), yMax: Math.max(ink.yMax, box.yMax) } : box;
    }
    for (const command of glyph.pathCommands) {
      const xy = (x: number, y: number) => ({ x: coordinate(cursor + x * scale), y: coordinate(baseline + y * scale) });
      if (command.type === "Z") commands.push(Object.freeze({ type: "Z" }));
      else if (command.type === "M" || command.type === "L") commands.push(Object.freeze({ type: command.type, ...xy(command.x, command.y) }));
      else if (command.type === "Q") { const control = xy(command.x1, command.y1);
        commands.push(Object.freeze({ type: "Q", x1: control.x, y1: control.y, ...xy(command.x, command.y) })); }
      else if (command.type === "C") { const first = xy(command.x1, command.y1), second = xy(command.x2, command.y2);
        commands.push(Object.freeze({ type: "C", x1: first.x, y1: first.y, x2: second.x, y2: second.y, ...xy(command.x, command.y) })); }
    }
    cursor = coordinate(cursor + (glyph.advanceEm + glyph.kerningAfterEm) * fontSize
      + (index < run.glyphs.length - 1 ? letterSpacing : 0));
  }
  if (!ink || commands.length === 0 || commands.length > 65536) throw new Error("Native glyph requires visible bounded physical ink");
  return Object.freeze({ path: Object.freeze({ commands: Object.freeze(commands), fill_rule: "non_zero" as const }),
    ink: Object.freeze(ink), advance: cursor - left,
    font: Object.freeze({ faceId: run.faceId, fontSha256: run.fontSha256, manifestSha256: run.manifestSha256,
      parserVersion: run.parserVersion }) });
}

export interface PaintEntrance {
  enterAt: number; enterFrames: number; exitAt: number; exitFrames: number;
  fromX: number; fromY: number; fromScale: number;
}
export interface PaintPose { x: number; y: number; scale: number; opacity: number }
function ease(value: number): number { const t = Math.max(0, Math.min(1, value)); return 1 - (1 - t) ** 3; }
/** Integer project frames; settled hold has no looping jiggle or camera move. */
export function nativePaintPoseAtFrame(frame: number, animation: PaintEntrance): PaintPose {
  const { enterAt, enterFrames, exitAt, exitFrames, fromX, fromY, fromScale } = animation;
  if (![frame, enterAt, enterFrames, exitAt, exitFrames].every(Number.isSafeInteger) || frame < 0
    || enterAt < 0 || enterFrames < 1 || exitFrames < 1 || exitAt < enterAt + enterFrames
    || exitAt + exitFrames > 1_000_000 || !Number.isFinite(fromScale) || fromScale < 0.01 || fromScale > 32) {
    throw new Error("Native paint animation requires ordered bounded integer frames");
  }
  coordinate(fromX); coordinate(fromY);
  const progress = ease((frame - enterAt) / enterFrames);
  const opacity = frame < exitAt ? progress : 1 - ease((frame - exitAt) / exitFrames);
  return Object.freeze({ x: fromX * (1 - progress), y: fromY * (1 - progress),
    scale: fromScale + (1 - fromScale) * progress, opacity });
}

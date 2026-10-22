import { mixHex } from "../../svg/color";
import { g, path, polygon, polyline, type Point2 } from "../../svg/document";
import { energyProfile, loopPhase } from "../../svg/easing";
import { curveSampler, layoutLine, layoutOnPath } from "../../svg/glyphs";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import { createTextDocument, textBackdrop, textFace, textOnBackground } from "../shared";
import { compactPathD, distinctFrom, fraction, isMarqueeSeparator, marqueeUnitText } from "./T09_hugeTextScroll";

/**
 * T13 Text Ribbon (リボン): a sine ribbon crosses the frame on a gentle rising
 * diagonal (−26° in portrait, −6° in landscape), filled with a slightly lighter (on a
 * dark card; darker on a light one) tone, the text colour mixed 12% into the
 * backdrop, and hemmed with thin accent lines. The text (「乘著浪・」 repeated, in
 * the readable colour with accent separators) is set on the ribbon's centre line with layoutOnPath over a
 * curveSampler and flows along it toward the start (leftward), each glyph turned to
 * the tangent and centred on the line. The ribbon undulates slowly: its wave travels
 * the other way, one wavelength per loop, so the characters bob as they ride over
 * the crests. The ribbon runs edge to edge by definition; its whole swing stays
 * inside the 5% title-safe box vertically.
 *
 * A seamless 4 s loop (catalog loopSeconds): the wave moves one wavelength and the
 * text a whole number of repeats per loop. Energy scales the wave amplitude.
 */

const ID = "T13";
const REVISION = 1;
export const T13_LOOP_SECONDS = 4;
/** Text em (× short side), ribbon half-width (em), hem inset and stroke (em). */
const TEXT_EM = 0.145, HALF_WIDTH = 0.8, HEM_INSET = 0.12, HEM_STROKE = 0.045;
/** Wave: amplitude and wavelength (em; portrait swings wider), text speed (em per second), ribbon tint. */
const AMPLITUDE = 0.75, PORTRAIT_AMPLITUDE = 0.85, WAVELENGTH = 8, TEXT_SPEED = 2.2, TINT = 0.12, TRACKING = -0.02;
const SAMPLES = 160;

export interface TextRibbonPlan {
  readonly fontSize: number;
  readonly text: string;
  /** The text repeated enough to cover the ribbon, and the advance of one repeat. */
  readonly repeated: string;
  readonly unitAdvance: number;
  readonly repeatsPerLoop: number;
  readonly baselineShift: number;
  /** Straight axis of the ribbon: start point, unit direction and length (frame px). */
  readonly origin: Point2;
  readonly direction: Point2;
  readonly length: number;
  readonly amplitude: number;
  readonly wavelength: number;
  readonly halfWidth: number;
  readonly textColor: string;
  readonly ribbonColor: string;
  readonly hemColor: string;
}

export function textRibbonPlan(params: TextMotionParams, size: MotionFrameSize): TextRibbonPlan {
  const short = Math.min(size.width, size.height);
  const face = textFace(params.font, 900);
  const fontSize = TEXT_EM * short;
  const text = marqueeUnitText(params.lines.map(line => line.trim()).join("・"), face);
  const line = layoutLine(text, { ...face, size: fontSize, tracking: TRACKING });
  // One repeat: the pen advance plus the tracking that follows it inside the repeated string.
  const unitAdvance = line.width + line.tracking * line.size;
  const portrait = size.height > size.width * 1.2;
  const angle = ((portrait ? -26 : size.width > size.height * 1.2 ? -6 : -12) * Math.PI) / 180;
  const direction: Point2 = [Math.cos(angle), Math.sin(angle)];
  const length = size.width / Math.cos(angle) + 3 * fontSize;
  const origin: Point2 = [size.width / 2 - (direction[0] * length) / 2, size.height / 2 - (direction[1] * length) / 2];
  const amplitude = (portrait ? PORTRAIT_AMPLITUDE : AMPLITUDE) * fontSize * Math.min(1.5, energyProfile(params.energy).amplitude);
  // Enough repeats to cover the longest arc (the wave lengthens the path by at most √(1 + slope²)).
  const slope = (2 * Math.PI * amplitude) / (WAVELENGTH * fontSize);
  const repeats = Math.ceil((length * Math.sqrt(1 + slope * slope)) / unitAdvance) + 2;
  const ink = line.inkBox ?? { y0: -0.88 * fontSize, y1: 0.12 * fontSize };
  const backdrop = textBackdrop(params);
  const textColor = textOnBackground(params.palette, backdrop);
  return {
    fontSize: line.size, text, repeated: text.repeat(repeats), unitAdvance,
    repeatsPerLoop: Math.max(1, Math.round((TEXT_SPEED * fontSize * T13_LOOP_SECONDS) / unitAdvance)),
    baselineShift: -(ink.y0 + ink.y1) / 2, origin, direction, length, amplitude, wavelength: WAVELENGTH * fontSize,
    halfWidth: HALF_WIDTH * fontSize, textColor,
    ribbonColor: mixHex(backdrop, textColor, TINT),
    hemColor: distinctFrom(backdrop, params.palette.accent, [params.palette.accent2, textColor]),
  };
}

/** Centre line point at axis distance s (0..length) and loop phase u: the axis plus a sine offset along the normal. */
export function ribbonPoint(plan: TextRibbonPlan, s: number, u: number): Point2 {
  const offset = plan.amplitude * Math.sin((2 * Math.PI * s) / plan.wavelength - 2 * Math.PI * u);
  const [dx, dy] = plan.direction;
  return [plan.origin[0] + dx * s - dy * offset, plan.origin[1] + dy * s + dx * offset];
}

function edge(points: readonly Point2[], normals: readonly Point2[], distance: number): Point2[] {
  return points.map((point, index) => [point[0] + normals[index][0] * distance, point[1] + normals[index][1] * distance] as const);
}

export const T13_textRibbon = defineTextMotion(ID, (params, t, size) => {
  const plan = textRibbonPlan(params, size);
  const doc = createTextDocument(size, params);
  const u = loopPhase(t, T13_LOOP_SECONDS);

  // Ribbon: centre line samples, unit normals from the neighbours, both edges.
  const points: Point2[] = Array.from({ length: SAMPLES + 1 }, (_, index) => ribbonPoint(plan, (index / SAMPLES) * plan.length, u));
  const normals: Point2[] = points.map((_, index) => {
    const [ax, ay] = points[Math.max(0, index - 1)], [bx, by] = points[Math.min(SAMPLES, index + 1)];
    const length = Math.hypot(bx - ax, by - ay) || 1;
    return [-(by - ay) / length, (bx - ax) / length] as const;
  });
  const ribbon = polygon([...edge(points, normals, plan.halfWidth), ...edge(points, normals, -plan.halfWidth).reverse()], { fill: plan.ribbonColor });
  const hemOffset = plan.halfWidth - HEM_INSET * plan.fontSize, hemWidth = HEM_STROKE * plan.fontSize;
  const hems = [hemOffset, -hemOffset].map(offset => polyline(edge(points, normals, offset),
    { stroke: plan.hemColor, "stroke-width": hemWidth, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // Text: flows toward the start of the line by whole repeats per loop.
  const sampler = curveSampler(v => { const [x, y] = ribbonPoint(plan, v * plan.length, u); return { x, y }; }, SAMPLES);
  const placed = layoutOnPath(plan.repeated, { ...textFace(params.font, 900), size: plan.fontSize, tracking: TRACKING, baselineShift: plan.baselineShift,
    startOffset: -fraction(plan.repeatsPerLoop * u) * plan.unitAdvance }, sampler);
  const visible = placed.glyphs.filter(glyph => glyph.pathD && glyph.distance > -glyph.advance && glyph.distance < sampler.totalLength + glyph.advance);
  const draw = (separators: boolean) => visible.filter(glyph => isMarqueeSeparator(glyph.char) === separators)
    .map(glyph => path(compactPathD(glyph.pathD), { transform: glyph.transform }));
  // Text in the readable colour, separators in the accent (one accent per item, ART_DIRECTION §0).
  return doc.render(ribbon, hems, g({ fill: plan.textColor }, draw(false)), g({ fill: plan.hemColor }, draw(true)));
}, { revision: REVISION });

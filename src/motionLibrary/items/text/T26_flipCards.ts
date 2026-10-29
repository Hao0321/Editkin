import { mixHex, relativeLuminance } from "../../svg/color";
import { path, pathData } from "../../svg/document";
import { cubicInOut, expoIn, expoOut } from "../../svg/easing";
import { layoutLine, type GlyphBox } from "../../svg/glyphs";
import { parseAbsolutePathD } from "../../svg/pathOps";
import { defineTextMotion, type MotionFrameSize, type TextMotionParams } from "../../types";
import {
  backdropTone, createTextDocument, heroTextBox, itemTiming, readableColor, secondaryTone, textBackdrop, textFace, textOnBackground, titleSafeBox,
} from "../shared";

/**
 * T26 Flip Cards (フリップ), SWITCH: one card per character, flipping on its
 * vertical axis to swap the word (one word per line: 日出 → 晴天 by default). A
 * flip is rotateY 0 → 180° in 0.3 s (cubic ease-in-out) in true perspective: the
 * card outline and its glyph are projected point by point (camera 3.2 card widths
 * away), so the near edge grows and the far edge shrinks as it turns. The front
 * face (this word's character) shows while cos θ ≥ 0, the back face (the next
 * word's character, reading the right way round) after edge-on. The card lifts 6%
 * at the half turn and shades toward the edge-on pose. Cards flip one by one, 0.1 s
 * apart, left to right. The cards turn in from edge-on to open the clip (0.08 s
 * apart) and turn away to close it; every word holds equally in between. Colours
 * follow the reference: dark cards on the accent plate (the showcase plate), and on a
 * dark plate (or over footage) the cards take the accent instead; glyphs alternate per word
 * between the card's text role and its second tone (ink then accent2 on the lavender
 * card, ART_DIRECTION §0; paper then accent on a dark card). Words shorter than the
 * row are centred on blank cards. A single word of 4+ characters wraps onto two rows
 * in a portrait frame when that makes the cards larger. Times are standard-energy
 * seconds, scaled by energy and squeezed into short clips.
 */

const ID = "T26";
/** Art revision (part of the clip cache key): 1 = first render. */
const REVISION = 1;
const ENTER = 0.26, ENTER_STAGGER = 0.08, FLIP = 0.3, FLIP_STAGGER = 0.1, EXIT = 0.2, EXIT_STAGGER = 0.06, TAIL = 0.08, MIN_HOLD = 0.8;
/** Card geometry: height / width, gap (× width), row gap (× height), glyph em (× width), corner radius (× width). */
const CARD_ASPECT = 1.12, GAP = 0.1, ROW_GAP = 0.1, GLYPH_EM = 0.72, RADIUS = 0.1;
/** Lift at the half turn and the darkest shade toward edge-on. */
const LIFT = 0.06, TURN_SHADE = 0.28, ENTER_SCALE = 0.9;
/** Camera distance in card widths (perspective strength of the turn). */
const CAMERA = 3.2;

export interface FlipCardSlot {
  readonly index: number;
  /** Card centre (frame px). */
  readonly cx: number;
  readonly cy: number;
  /** The character this card shows for each word ("" = blank face). */
  readonly faces: readonly string[];
}

export interface FlipCardsLayout {
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly fontSize: number;
  readonly timeScale: number;
  readonly cards: readonly FlipCardSlot[];
  /** Word w is shown from the end of its flip-in (or the entrance) to flipStarts[w]; flipStarts[last] is the exit. */
  readonly enterSeconds: number;
  readonly flipStarts: readonly number[];
  /** Board box at rest (frame px). */
  readonly box: GlyphBox;
}

function cardWidthFor(rows: number, columns: number, hero: { maxWidth: number; maxHeight: number }): number {
  return Math.min(hero.maxWidth / (columns + GAP * (columns - 1)), hero.maxHeight / (rows * CARD_ASPECT + ROW_GAP * CARD_ASPECT * (rows - 1)));
}

/** Card grid, word faces and the flip schedule (shared by the generator and its tests). */
export function flipCardsLayout(params: TextMotionParams, size: MotionFrameSize): FlipCardsLayout {
  const words = params.lines.map(line => [...line.trim()]);
  const count = Math.max(1, ...words.map(word => word.length));
  const enterSpan = ENTER + ENTER_STAGGER * (count - 1), flipSpan = FLIP + FLIP_STAGGER * (count - 1), exitSpan = EXIT + EXIT_STAGGER * (count - 1);
  const motion = enterSpan + flipSpan * (words.length - 1) + exitSpan + TAIL;
  const { timeScale } = itemTiming(params.energy, params.durationSeconds, motion + MIN_HOLD * words.length);
  const hold = Math.max(0, (params.durationSeconds - motion * timeScale) / words.length);
  const flipStarts: number[] = [];
  let clock = enterSpan * timeScale;
  for (let word = 0; word < words.length; word += 1) {
    clock += hold;
    flipStarts.push(clock);
    clock += flipSpan * timeScale;
  }

  // Hero size (ART_DIRECTION §0): the row fills 86% of the title-safe width; portrait may wrap onto two rows.
  const hero = heroTextBox(size, { heightFill: 0.66, headroom: 1 + LIFT });
  let rows = 1, columns = count;
  if (size.height > size.width && count >= 4) {
    const wrappedColumns = Math.ceil(count / 2);
    if (cardWidthFor(2, wrappedColumns, hero) > cardWidthFor(1, count, hero)) { rows = 2; columns = wrappedColumns; }
  }
  const cardWidth = cardWidthFor(rows, columns, hero), cardHeight = cardWidth * CARD_ASPECT;
  const safe = titleSafeBox(size);
  const boardWidth = columns * cardWidth + GAP * cardWidth * (columns - 1);
  const boardHeight = rows * cardHeight + ROW_GAP * cardHeight * (rows - 1);
  const left = safe.cx - boardWidth / 2, top = safe.cy - boardHeight / 2;
  const cards: FlipCardSlot[] = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns), column = index % columns;
    // The last row of a wrapped board is centred when it holds fewer cards.
    const inRow = row === rows - 1 ? count - row * columns : columns;
    const rowLeft = left + ((columns - inRow) * cardWidth * (1 + GAP)) / 2;
    return {
      index, cx: rowLeft + column * cardWidth * (1 + GAP) + cardWidth / 2, cy: top + row * cardHeight * (1 + ROW_GAP) + cardHeight / 2,
      faces: words.map(word => {
        const offset = Math.floor((count - word.length) / 2), character = word[index - offset] ?? "";
        return character.trim() === "" ? "" : character;
      }),
    };
  });
  return {
    cardWidth, cardHeight, fontSize: Number((GLYPH_EM * cardWidth).toFixed(3)), timeScale, cards, enterSeconds: enterSpan * timeScale, flipStarts,
    box: { x0: left, y0: top, x1: left + boardWidth, y1: top + boardHeight },
  };
}

export interface FlipPose {
  /** Word shown on the visible face. */
  readonly word: number;
  /** Turn angle θ (radians, 0 = facing, π = the back facing); |cos θ| is the horizontal scale (0 = edge-on, not drawn). */
  readonly angle: number;
  readonly scaleX: number;
  /** Uniform lift / entrance scale. */
  readonly scale: number;
  /** Turn shade 0..TURN_SHADE (darker toward edge-on). */
  readonly shade: number;
}

/** Pose of card `index` at clip time t, or undefined while it is hidden. */
export function flipPose(layout: FlipCardsLayout, index: number, t: number): FlipPose | undefined {
  const ts = layout.timeScale, words = layout.flipStarts.length;
  const enterStart = ENTER_STAGGER * index * ts;
  if (t < enterStart) return undefined;
  if (t < enterStart + ENTER * ts) {
    // Turning in from edge-on (θ from −90° to 0).
    const p = expoOut((t - enterStart) / (ENTER * ts)), angle = -(Math.PI / 2) * (1 - p), c = Math.cos(angle);
    return { word: 0, angle, scaleX: c, scale: ENTER_SCALE + (1 - ENTER_SCALE) * p, shade: TURN_SHADE * (1 - c) };
  }
  for (let word = 0; word < words; word += 1) {
    const start = layout.flipStarts[word] + (word === words - 1 ? EXIT_STAGGER : FLIP_STAGGER) * index * ts;
    if (t < start) return { word, angle: 0, scaleX: 1, scale: 1, shade: 0 };
    if (word === words - 1) {
      const q = (t - start) / (EXIT * ts);
      if (q >= 1) return undefined;
      const angle = (Math.PI / 2) * expoIn(q), c = Math.cos(angle);
      return { word, angle, scaleX: c, scale: 1 - (1 - ENTER_SCALE) * expoIn(q), shade: TURN_SHADE * (1 - c) };
    }
    if (t < start + FLIP * ts) {
      const angle = Math.PI * cubicInOut((t - start) / (FLIP * ts)), c = Math.cos(angle);
      return { word: c >= 0 ? word : word + 1, angle, scaleX: Math.abs(c), scale: 1 + LIFT * Math.sin(angle), shade: TURN_SHADE * (1 - Math.abs(c)) };
    }
  }
  return { word: words - 1, angle: 0, scaleX: 1, scale: 1, shade: 0 };
}

type PathSegments = ReturnType<typeof parseAbsolutePathD>;

/**
 * Project a face's outline (segments in card-local px, origin at the card centre) through rotateY(angle) and a
 * pinhole camera `camera` px in front of the card, about the card centre (cx, cy), with a uniform lift. The back
 * face reads the right way round: its own x runs opposite to the card's. Bézier control points are projected as
 * points (a close approximation at these angles and sizes).
 */
function projectedPathD(segments: PathSegments, cx: number, cy: number, angle: number, back: boolean, lift: number, camera: number): string {
  const cos = Math.cos(angle), sin = Math.sin(angle), mirror = back ? -1 : 1;
  const map = (u: number, v: number): readonly [number, number] => {
    const x = mirror * u, k = (lift * camera) / (camera + x * sin);
    return [cx + x * cos * k, cy + v * k];
  };
  const builder = pathData(2);
  for (const segment of segments) {
    switch (segment.type) {
      case "M": { const [x, y] = map(segment.x, segment.y); builder.M(x, y); break; }
      case "L": { const [x, y] = map(segment.x, segment.y); builder.L(x, y); break; }
      case "Q": { const [x1, y1] = map(segment.x1, segment.y1), [x, y] = map(segment.x, segment.y); builder.Q(x1, y1, x, y); break; }
      case "C": {
        const [x1, y1] = map(segment.x1, segment.y1), [x2, y2] = map(segment.x2, segment.y2), [x, y] = map(segment.x, segment.y);
        builder.C(x1, y1, x2, y2, x, y); break;
      }
      case "Z": builder.Z(); break;
    }
  }
  return builder.toString();
}

/** Rounded rectangle centred on the origin as absolute cubic path data (projectable: no arcs). */
function cardPathD(width: number, height: number, radius: number): string {
  const hw = width / 2, hh = height / 2, r = Math.max(0, Math.min(radius, hw, hh)), k = 0.5523 * r;
  return pathData(3).M(-hw + r, -hh).L(hw - r, -hh).C(hw - r + k, -hh, hw, -hh + r - k, hw, -hh + r).L(hw, hh - r)
    .C(hw, hh - r + k, hw - r + k, hh, hw - r, hh).L(-hw + r, hh).C(-hw + r - k, hh, -hw, hh - r + k, -hw, hh - r)
    .L(-hw, -hh + r).C(-hw, -hh + r - k, -hw + r - k, -hh, -hw + r, -hh).Z().toString();
}

export const T26_flipCards = defineTextMotion(ID, (params, t, size) => {
  const layout = flipCardsLayout(params, size);
  const doc = createTextDocument(size, params);
  const palette = params.palette;
  const backdrop = textBackdrop(params);
  // The reference's dark card on the accent plate; on a dark plate (or footage) the card takes the accent instead.
  const card = backdropTone(palette, backdrop) === "dark" ? palette.accent : readableColor(backdrop, [palette.bg, palette.ink, palette.paper], 3);
  const light = relativeLuminance(card) > 0.2;
  const tones = [textOnBackground(palette, card), secondaryTone(palette, card)];
  const { cardWidth: w, cardHeight: h, fontSize } = layout;
  const cardSegments = parseAbsolutePathD(cardPathD(w, h, RADIUS * w), "T26 card");
  const glyphSegments = new Map<string, PathSegments>();
  const glyph = (character: string): PathSegments => {
    let segments = glyphSegments.get(character);
    if (!segments) {
      const line = layoutLine(character, { ...textFace(params.font, 900), size: fontSize });
      // Em box centred on the card (one shared baseline for every card), advance centred on the axis.
      const dx = -line.width / 2, dy = -(line.emTop + line.emBottom) / 2;
      segments = parseAbsolutePathD(line.pathD, "T26 glyph").map(segment => {
        switch (segment.type) {
          case "M": case "L": return { ...segment, x: segment.x + dx, y: segment.y + dy };
          case "Q": return { ...segment, x1: segment.x1 + dx, y1: segment.y1 + dy, x: segment.x + dx, y: segment.y + dy };
          case "C": return { ...segment, x1: segment.x1 + dx, y1: segment.y1 + dy, x2: segment.x2 + dx, y2: segment.y2 + dy, x: segment.x + dx, y: segment.y + dy };
          default: return segment;
        }
      });
      glyphSegments.set(character, segments);
    }
    return segments;
  };
  const camera = CAMERA * w;
  const parts = layout.cards.map(slot => {
    const pose = flipPose(layout, slot.index, t);
    if (!pose || pose.scaleX < 0.02) return "";
    const fill = pose.shade > 0.001 ? mixHex(card, light ? palette.ink : palette.paper, pose.shade) : card;
    const back = Math.cos(pose.angle) < 0, character = slot.faces[pose.word];
    return [
      path(projectedPathD(cardSegments, slot.cx, slot.cy, pose.angle, back, pose.scale, camera), { fill }),
      character ? path(projectedPathD(glyph(character), slot.cx, slot.cy, pose.angle, back, pose.scale, camera), { fill: tones[pose.word % 2] }) : "",
    ];
  });
  return doc.render(parts);
}, { revision: REVISION });

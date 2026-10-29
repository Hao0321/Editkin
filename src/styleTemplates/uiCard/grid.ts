import { S1V2 } from "./design";

/**
 * The S1 v2 grid resolved for an output frame (px). 9:16 is the style frames' grid scaled by width;
 * 16:9 adapts it: the card takes the left of the frame, key lockups the column to its right, subtitles and step
 * chips the strip under the card, the chapter chip sits over the card, type set at 0.78 of the portrait sizes.
 */

export interface UiCardGrid {
  readonly orientation: "portrait" | "landscape";
  /** Multiplies every design size (type, radii, shadows, offsets). */
  readonly s: number;
  readonly chip: { readonly cx: number; readonly y: number };
  readonly card: { readonly x: number; readonly w: number; readonly squareY: number; readonly squareH: number; readonly bandY0: number; readonly bandY1: number;
    readonly wideMinH: number; readonly calloutBand: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } };
  readonly bubble: { readonly x: number; readonly y: number; readonly w: number; readonly cardGap: number };
  readonly lower: { readonly subtitleCx: number; readonly subtitleY: number; readonly subtitleMaxWidth: number; readonly stepsY: number;
    readonly lockupCx: number; readonly leadY: number; readonly keywordY: number; readonly lockupMaxWidth: number };
}

export function uiCardGrid(width: number, height: number): UiCardGrid {
  if (height > width) {
    const s = width / S1V2.frame.width, C = S1V2.card, L = S1V2.lower, B = S1V2.bubble;
    return {
      orientation: "portrait", s,
      chip: { cx: width / 2, y: S1V2.chip.y * s },
      card: { x: C.x * s, w: C.width * s, squareY: C.square.y * s, squareH: C.square.height * s, bandY0: C.band.y0 * s, bandY1: C.band.y1 * s, wideMinH: 300 * s,
        calloutBand: { x0: 30 * s, y0: (C.band.y0 - 40) * s, x1: width - 30 * s, y1: (C.band.y1 + 40) * s } },
      bubble: { x: B.x * s, y: B.y * s, w: B.width * s, cardGap: (C.wideWithBubbleY - B.y - (B.padTop + 2 * B.lineHeight + B.padBottom)) * s },
      lower: { subtitleCx: width / 2, subtitleY: L.subtitleCenterY * s, subtitleMaxWidth: L.maxWidth * s, stepsY: L.steps.centerY * s,
        lockupCx: width / 2, leadY: L.leadCenterY * s, keywordY: L.keywordCenterY * s, lockupMaxWidth: L.maxWidth * s },
    };
  }
  // 16:9 (scaled for other landscape sizes by height).
  const k = height / 1080, s = 0.78 * k;
  const cardX = 70 * k, cardW = 1180 * k, bandY0 = 128 * k, bandY1 = 958 * k;
  const columnX0 = cardX + cardW + 50 * k, columnX1 = width - 60 * k;
  return {
    orientation: "landscape", s,
    chip: { cx: cardX + cardW / 2, y: 30 * k },
    card: { x: cardX, w: cardW, squareY: bandY0, squareH: bandY1 - bandY0, bandY0, bandY1, wideMinH: 240 * k,
      calloutBand: { x0: 30 * k, y0: bandY0 - 30 * k, x1: columnX0 + 120 * k, y1: bandY1 + 20 * k } },
    bubble: { x: cardX + 20 * k, y: bandY0 + 40 * k, w: cardW - 40 * k, cardGap: 70 * k },
    // The text column right of the card: subtitles (wrapped in balanced lines), key lockups and step chips share it.
    lower: { subtitleCx: (columnX0 + columnX1) / 2, subtitleY: 543 * k, subtitleMaxWidth: columnX1 - columnX0, stepsY: 543 * k,
      lockupCx: (columnX0 + columnX1) / 2, leadY: 470 * k, keywordY: 580 * k, lockupMaxWidth: columnX1 - columnX0 },
  };
}

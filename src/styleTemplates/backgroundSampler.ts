import type { Box } from "./placement";
import type { BackgroundStats } from "./readability";

/**
 * Background statistics from a low-resolution grey copy of the real (graded) footage:
 * `rate` frames per second of `columns × rows` display-luma bytes, timeline-aligned.
 * Browser-safe: the editor can feed it its own preview frames; the review harness
 * feeds it an FFmpeg grey extract. compileStylePlanV1 calls the returned function
 * for every candidate text box (project.sampleBackground).
 */
export interface GreyFrames {
  readonly rate: number;
  readonly columns: number;
  readonly rows: number;
  /** The full-resolution frame the grey copy was scaled from (box coordinates are in it). */
  readonly width: number;
  readonly height: number;
  /** frames × rows × columns display-luma bytes. */
  readonly data: Uint8Array;
}

const LINEAR = new Float64Array(256).map((_, code) => (code / 255) ** 2.2);

function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
}

export function greyBackgroundSampler(grey: GreyFrames): (box: Box, from: number, to: number) => BackgroundStats | undefined {
  const frameBytes = grey.columns * grey.rows, frames = Math.floor(grey.data.length / frameBytes);
  return (box, from, to) => {
    const f0 = Math.max(0, Math.floor(from * grey.rate)), f1 = Math.min(frames - 1, Math.ceil(to * grey.rate));
    if (f1 < f0) return undefined;
    const x0 = Math.max(0, Math.floor((box.x0 / grey.width) * grey.columns)), x1 = Math.min(grey.columns, Math.ceil((box.x1 / grey.width) * grey.columns));
    const y0 = Math.max(0, Math.floor((box.y0 / grey.height) * grey.rows)), y1 = Math.min(grey.rows, Math.ceil((box.y1 / grey.height) * grey.rows));
    if (x1 <= x0 || y1 <= y0) return undefined;
    const linear: number[] = [];
    let textureSum = 0, textureFrames = 0;
    for (let f = f0; f <= f1; f += 1) {
      let sum = 0, sumSq = 0, count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const code = grey.data[f * frameBytes + y * grey.columns + x];
          linear.push(LINEAR[code]);
          sum += code; sumSq += code * code; count += 1;
        }
      }
      if (count) {
        const mean = sum / count;
        textureSum += Math.sqrt(Math.max(0, sumSq / count - mean * mean)) / 255;
        textureFrames += 1;
      }
    }
    if (!linear.length) return undefined;
    const mean = linear.reduce((total, value) => total + value, 0) / linear.length;
    linear.sort((a, b) => a - b);
    return { mean, high: percentile(linear, 0.8), low: percentile(linear, 0.2), texture: textureFrames ? textureSum / textureFrames : 0 };
  };
}

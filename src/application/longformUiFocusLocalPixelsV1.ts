import type { LongformUiFocusDraftV1 } from "../domain/longformUiFocusV1";
import type { LongformUiFocusHoldSequenceV1, LongformUiFocusLocalObservationV1 } from "../domain/longformUiFocusHoldV1";
import { longformUiFocusQuadProjectionV1, verifyLongformUiFocusHoldSequenceV1 } from "./longformUiFocusHoldV1";

interface Sample { x: number; y: number; weights: [number, number, number, number]; value: number }
const yieldEventLoop = () => new Promise<void>(done => setImmediate(done));
function measure(frame: Uint8Array, samples: readonly Sample[], width: number, dx: number, dy: number) {
  let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0, absolute = 0;
  for (const sample of samples) {
    const index = (sample.y + dy) * width + sample.x + dx, [a, b, c, d] = sample.weights;
    const value = frame[index] * a + frame[index + 1] * b + frame[index + width] * c + frame[index + width + 1] * d;
    sumA += sample.value; sumB += value; sumAA += sample.value ** 2; sumBB += value ** 2; sumAB += sample.value * value;
    absolute += Math.abs(sample.value - value);
  }
  const n = samples.length, varianceA = sumAA - sumA ** 2 / n, varianceB = sumBB - sumB ** 2 / n;
  return { correlation: Math.max(-1, Math.min(1, (sumAB - sumA * sumB / n) / Math.max(1e-8, Math.sqrt(Math.max(0, varianceA * varianceB))))),
    difference: absolute / (n * 255), standardDeviation: Math.sqrt(Math.max(0, varianceA / n)) };
}
/** A bounded translation search over actual pixels, using the immutable initial
 * text template. No global reacquisition, template adaptation or native-score
 * substitution. Every frame needs a unique measured local peak. */
export async function locateLongformUiFocusPixelsV1(draft: LongformUiFocusDraftV1, raw: unknown,
  sequence: LongformUiFocusHoldSequenceV1, pixels: Uint8Array, signal?: AbortSignal): Promise<LongformUiFocusLocalObservationV1[]> {
  const target = verifyLongformUiFocusHoldSequenceV1(sequence, pixels, draft, raw), width = sequence.width, height = sequence.height;
  const initial = target.candidate.quad, project = longformUiFocusQuadProjectionV1(initial), frameBytes = width * height;
  const columns = Math.max(8, Math.min(40, Math.ceil(target.candidate.bounds.width * width)));
  const rows = Math.max(8, Math.min(24, Math.ceil(target.candidate.bounds.height * height))), samples: Sample[] = [];
  const first = pixels.subarray(0, frameBytes);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const p = project((column + .5) / columns, (row + .5) / rows), x = p.x * width - .5, y = p.y * height - .5;
    const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
    if (left < 0 || top < 0 || left + 1 >= width || top + 1 >= height) throw Error("UI_FOCUS_LOCAL_SAMPLE_OUTSIDE_FRAME");
    const weights: Sample["weights"] = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy], index = top * width + left;
    samples.push({ x: left, y: top, weights, value: first[index] * weights[0] + first[index + 1] * weights[1]
      + first[index + width] * weights[2] + first[index + width + 1] * weights[3] });
  }
  const coarse = samples.filter((_, index) => index % Math.max(1, Math.floor(samples.length / 96)) === 0);
  const initialQuality = measure(first, samples, width, 0, 0), radius = Math.max(8, Math.min(32, Math.ceil(Math.min(width, height) * .05)));
  const minX = Math.min(...samples.map(p => p.x)), maxX = Math.max(...samples.map(p => p.x)), minY = Math.min(...samples.map(p => p.y)), maxY = Math.max(...samples.map(p => p.y));
  let dx = 0, dy = 0, retired = initialQuality.standardDeviation < 4;
  const observations: LongformUiFocusLocalObservationV1[] = [];
  for (let frame = 0; frame < sequence.frames.length; frame++) {
    signal?.throwIfAborted(); const image = pixels.subarray(frame * frameBytes, (frame + 1) * frameBytes);
    let testedOffsets = 0, verifiedHypotheses = 0, state: LongformUiFocusLocalObservationV1["state"] = retired ? "retired" : "missing";
    let best: { dx: number; dy: number; correlation: number; difference: number } | undefined;
    if (!retired && sequence.cuts.some(cut => cut.frame === frame && frame > 0)) { retired = true; state = "retired"; }
    if (!retired && frame === 0) { best = { dx: 0, dy: 0, correlation: initialQuality.correlation, difference: 0 }; verifiedHypotheses = 1; }
    else if (!retired) {
      const proposals: Array<{ dx: number; dy: number; correlation: number; difference: number }> = [];
      for (let y = dy - radius; y <= dy + radius; y++) {
        if (minY + y < 0 || maxY + y + 1 >= height) continue;
        for (let x = dx - radius; x <= dx + radius; x++) {
          if (minX + x < 0 || maxX + x + 1 >= width) continue;
          testedOffsets++; const quality = measure(image, coarse, width, x, y);
          if (quality.correlation >= .88 && quality.difference <= .14) proposals.push({ dx: x, dy: y, ...quality });
        }
        if ((y - dy + radius) % 8 === 0) { await yieldEventLoop(); signal?.throwIfAborted(); }
      }
      // Too many competing coarse locations remain ambiguous; never discard
      // candidates until an easier positive survives a fixed top-N list.
      if (proposals.length > 64) state = "ambiguous";
      else {
        const verified = proposals.map(p => ({ dx: p.dx, dy: p.dy, ...measure(image, samples, width, p.dx, p.dy) }))
          .filter(p => p.correlation >= .92 && p.difference <= .08)
          .sort((a, b) => b.correlation - a.correlation || a.difference - b.difference);
        verifiedHypotheses = verified.length; best = verified[0];
        if (best && verified.some(p => Math.hypot(p.dx - best!.dx, p.dy - best!.dy) > 2)) { state = "ambiguous"; best = undefined; }
      }
    }
    if (best) { state = "measured"; dx = best.dx; dy = best.dy; }
    else retired = true;
    observations.push({ frame, state, targetQuad: best ? initial.map(p => ({ x: p.x + dx / width, y: p.y + dy / height })) : [],
      correlation: best?.correlation ?? -1, difference: best?.difference ?? 1, searchRadiusPixels: radius, testedOffsets, verifiedHypotheses });
    await yieldEventLoop(); signal?.throwIfAborted();
  }
  return observations;
}

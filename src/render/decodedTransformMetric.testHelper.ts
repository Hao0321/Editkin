/** Known single bright-subject synthetic corpus only; not a Roto quality metric. */
export function measureDecodedTransform(actual: Uint8Array, expected: Uint8Array, width: number, height: number) {
  if (actual.length !== width * height || expected.length !== actual.length) throw Error("Unexpected decoded geometry");
  const maximum = Math.max(...expected), threshold = Math.max(8, maximum * .35);
  let a = 0, b = 0, intersect = 0, ax = 0, ay = 0, bx = 0, by = 0, coreError = 0, coreCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, av = actual[p] > threshold, bv = expected[p] > threshold;
    if (av) { a++; ax += x; ay += y; } if (bv) { b++; bx += x; by += y; } if (av && bv) intersect++;
    // Erode the foreground, not a fragile peak-relative color band. Isolated
    // codec ringing must not erase all valid low-opacity interior samples.
    if (x > 2 && x < width - 3 && y > 2 && y < height - 3 && [-2, -1, 0, 1, 2].every(d => expected[p + d] > threshold && expected[p + d * width] > threshold)) {
      coreError += Math.abs(actual[p] - expected[p]); coreCount++;
    }
  }
  return { iou: intersect / Math.max(1, a + b - intersect), centroid: a && b ? Math.hypot(ax / a - bx / b, ay / a - by / b) : Infinity, areaRatio: a / Math.max(1, b), interiorLumaError: coreError / Math.max(1, coreCount), coreCount, actualArea: a, expectedArea: b };
}
export function decodedTransformAccepted(m: ReturnType<typeof measureDecodedTransform>) {
  return m.iou >= .9 && m.centroid <= 1.5 && m.areaRatio >= .9 && m.areaRatio <= 1.1 && m.interiorLumaError <= 4 && m.coreCount > 0;
}

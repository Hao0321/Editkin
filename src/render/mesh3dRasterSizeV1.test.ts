import { expect, it } from "vitest";
import { mesh3dRasterSizeV1 } from "./mesh3dRasterSizeV1";

it.each([[1280, 720], [1920, 1080], [1080, 1920]])("preserves existing supersampling for %sx%s", (w, h) => {
  expect(mesh3dRasterSizeV1(w, h)).toEqual({ width: w * 1.5, height: h * 1.5 });
});
it.each([[3840, 2160], [2160, 3840], [3001, 2001], [4000, 1000], [1, 8294400]])("keeps %sx%s within the pixel cap without shrinking delivery", (w, h) => {
  const result = mesh3dRasterSizeV1(w, h);
  expect(result.width * result.height).toBeLessThanOrEqual(3840 * 2160);
  expect(result.width).toBeGreaterThanOrEqual(w); expect(result.height).toBeGreaterThanOrEqual(h);
});
it.each([[0, 1], [NaN, 1], [3841, 2160], [2.5, 2]])("refuses invalid dimensions %sx%s", (w, h) => {
  expect(() => mesh3dRasterSizeV1(w, h)).toThrow("INVALID");
});

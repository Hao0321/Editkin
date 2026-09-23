import { describe, expect, it } from "vitest";
import { sameF32 } from "./residentGpuPreviewReceipts";

describe("resident GPU receipt f32 transport", () => {
  it("accepts bounded native f32 arithmetic drift at project-pixel scale", () => {
    expect(sameF32(275.20001220703125, 275.2)).toBe(true);
    expect(sameF32(125.99999237060547, 126)).toBe(true);
    expect(sameF32(0.1733333319425583, 0.17333333333333334)).toBe(true);
  });

  it("still rejects meaningful receipt changes and non-finite values", () => {
    expect(sameF32(275.2005, 275.2)).toBe(false);
    expect(sameF32(0.17335333333333334, 0.17333333333333334)).toBe(false);
    expect(sameF32(Number.NaN, 1)).toBe(false);
    expect(sameF32(1, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

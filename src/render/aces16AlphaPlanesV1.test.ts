import { describe, expect, it } from "vitest";
import { aces16AlphaMultiplyV1, aces16AlphaPlaneJoinV1 } from "./aces16AlphaPlanesV1";

describe("internal16-bit alpha plane labels", () => {
  it.each(["", "0:v", "rgb;null", "rgb[injected]", "../rgb", "rgb,alpha"])("refuses graph injection or external selectors in every position: %s", invalid => {
    for (const operation of [aces16AlphaMultiplyV1, aces16AlphaPlaneJoinV1]) {
      expect(() => operation(invalid, "alpha", "out")).toThrow(/label/);
      expect(() => operation("rgb", invalid, "out")).toThrow(/label/);
      expect(() => operation("rgb", "alpha", invalid)).toThrow(/label/);
    }
  });
});

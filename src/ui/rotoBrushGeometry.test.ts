import { describe, expect, it } from "vitest";
import { containedMediaRect, normalizedContainedMediaPoint } from "./rotoBrushGeometry";

const squareViewport = { left: 10, top: 20, width: 200, height: 200 };

describe("Roto Brush object-fit contain geometry", () => {
  it("maps landscape content while rejecting top and bottom letterbox clicks", () => {
    expect(containedMediaRect(squareViewport, 1920, 1080)).toEqual({ left: 10, top: 63.75, width: 200, height: 112.5 });
    expect(normalizedContainedMediaPoint(squareViewport, 1920, 1080, 110, 120)).toEqual({ x: .5, y: .5 });
    expect(normalizedContainedMediaPoint(squareViewport, 1920, 1080, 110, 40)).toBeUndefined();
    expect(normalizedContainedMediaPoint(squareViewport, 1920, 1080, 110, 190)).toBeUndefined();
  });

  it("maps portrait content while rejecting left and right pillarbox clicks", () => {
    expect(containedMediaRect(squareViewport, 1080, 1920)).toEqual({ left: 53.75, top: 20, width: 112.5, height: 200 });
    expect(normalizedContainedMediaPoint(squareViewport, 1080, 1920, 110, 120)).toEqual({ x: .5, y: .5 });
    expect(normalizedContainedMediaPoint(squareViewport, 1080, 1920, 30, 120)).toBeUndefined();
    expect(normalizedContainedMediaPoint(squareViewport, 1080, 1920, 190, 120)).toBeUndefined();
  });

  it("keeps exact content edges valid but fails closed for unknown or invalid geometry", () => {
    expect(normalizedContainedMediaPoint(squareViewport, 1920, 1080, 10, 63.75)).toEqual({ x: 0, y: 0 });
    expect(normalizedContainedMediaPoint(squareViewport, 1920, 1080, 210, 176.25)).toEqual({ x: 1, y: 1 });
    expect(normalizedContainedMediaPoint(squareViewport, 0, 1080, 110, 120)).toBeUndefined();
    expect(normalizedContainedMediaPoint({ ...squareViewport, width: 0 }, 1920, 1080, 110, 120)).toBeUndefined();
    expect(normalizedContainedMediaPoint(squareViewport, 1920, 1080, Number.NaN, 120)).toBeUndefined();
  });
});

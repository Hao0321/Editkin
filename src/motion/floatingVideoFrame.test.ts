import { describe, expect, it } from "vitest";
import { floatingFrameCornerRadiusPixels, floatingFrameCssMatrix, floatingFrameFeatherPixels, floatingFrameFfmpegFilters, floatingFrameGeometry, floatingVideoFramePreset } from "./floatingVideoFrame";

describe("floating video frame preview and formal render geometry", () => {
  it("keeps the matte edge thin and the export cast shadow outside its feathered alpha", () => {
    const frame = floatingVideoFramePreset("matte");
    const geometry = floatingFrameGeometry(frame, 1080, 1920);
    expect(geometry.border).toBe(2);
    expect(floatingFrameCornerRadiusPixels(frame, 1080, 1920, geometry.border)).toBe(30);
    const filters = floatingFrameFfmpegFilters(frame, 1080, 1920, 30);
    const shadow = filters.find(filter => filter.startsWith("geq="))!;
    expect(shadow).toContain("alpha(X,Y)/255");
    expect(shadow).toContain("exp(-pow(max(");
    expect(filters.filter(filter => filter.startsWith("drawbox="))).toHaveLength(2);
    const legacy = floatingFrameFfmpegFilters(floatingVideoFramePreset("graphite"), 1080, 1920, 30);
    expect(legacy.some(filter => filter.startsWith("geq="))).toBe(false);
  });
  it("maps all four browser corners to the shared project quad", () => {
    const frame = floatingVideoFramePreset("portrait_orbit");
    const geometry = floatingFrameGeometry(frame, 360, 640, .55);
    const matrix = floatingFrameCssMatrix(geometry.quad, 360, 640).slice(9, -1).split(",").map(Number);
    for (const [index, [x, y]] of ([[0, 0], [360, 0], [0, 640], [360, 640]] as const).entries()) {
      const divisor = matrix[3] * x + matrix[7] * y + matrix[15];
      const actualX = (matrix[0] * x + matrix[4] * y + matrix[12]) / divisor / 360;
      const actualY = (matrix[1] * x + matrix[5] * y + matrix[13]) / divisor / 640;
      expect(actualX).toBeCloseTo(geometry.quad[index][0], 5);
      expect(actualY).toBeCloseTo(geometry.quad[index][1], 5);
    }
  });

  it("moves the portrait perspective over time in both preview and FFmpeg", () => {
    const frame = floatingVideoFramePreset("portrait_orbit");
    const first = floatingFrameGeometry(frame, 360, 640, 0);
    const later = floatingFrameGeometry(frame, 360, 640, .55);
    expect(Math.abs(later.quad[0][0] - first.quad[0][0])).toBeGreaterThan(.005);
    const filters = floatingFrameFfmpegFilters(frame, 360, 640, 30);
    const perspective = filters.find(filter => filter.startsWith("perspective="));
    expect(perspective).toContain("sin(2*PI*on/108)");
    expect(perspective).toContain("eval=frame");
  });

  it("preserves source geometry when landscape footage fills a portrait frame", () => {
    const filters = floatingFrameFfmpegFilters(floatingVideoFramePreset("portrait_orbit"), 360, 640, 30);
    expect(filters[0]).toContain("force_original_aspect_ratio=increase");
    expect(filters[1]).toMatch(/^crop=\d+:\d+:/);
    expect(filters.find(filter => filter.startsWith("gblur="))).toContain("planes=8");
    expect(filters.at(-1)).toBe("format=rgba");
  });

  it("fades only the outside alpha and scales the feather with the project canvas", () => {
    expect(floatingFrameFeatherPixels(360, 640)).toBe(6);
    expect(floatingFrameFeatherPixels(1080, 1920)).toBe(17);
    const filters = floatingFrameFfmpegFilters(floatingVideoFramePreset("portrait_orbit"), 1080, 1920, 30);
    const mask = filters.find(filter => filter.startsWith("format=rgba,geq="))!;
    expect(mask).toContain("min(min(X,W-1-X),min(Y,H-1-Y))/17");
    expect(mask).toContain("a='alpha(X,Y)*");
    expect(filters.find(filter => filter.startsWith("gblur="))).toContain("planes=8");
  });
});

import { describe, expect, it } from "vitest";
import { floatingFrameCornerRadiusPixels, floatingFrameCssMatrix, floatingFrameFeatherPixels, floatingFrameFfmpegFilters, floatingFrameGeometry, floatingVideoFramePreset } from "./floatingVideoFrame";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("floating video frame preview and formal render geometry", () => {
  it("projects actual exported pixels to the browser position, rejecting inverse perspective", () => {
    const frame = { ...floatingVideoFramePreset("matte"), centerX: .31, centerY: .65 };
    const g = floatingFrameGeometry(frame, 360, 640);
    const m = floatingFrameCssMatrix(g.quad, 360, 640).slice(9, -1).split(",").map(Number);
    const corners = [[g.left, g.top], [g.left + g.outerWidth, g.top], [g.left, g.top + g.outerHeight], [g.left + g.outerWidth, g.top + g.outerHeight]];
    const expectedTop = Math.min(...corners.map(([x, y]) => (m[1] * x + m[5] * y + m[13]) / (m[3] * x + m[7] * y + m[15])));
    const top = (inverse: boolean) => {
      const filters = floatingFrameFfmpegFilters(frame, 360, 640, 30).join(",");
      const pixels = execFileSync(resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe"), ["-v", "error", "-f", "lavfi", "-i", "color=c=0x629AC0:s=360x640:r=30:d=0.1", "-vf", inverse ? filters.replace("sense=destination", "sense=source") : filters,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      for (let y = 0; y < 640; y++) for (let x = 0; x < 360; x++) if (pixels[(y * 360 + x) * 4 + 3] >= 180) return y;
      throw new Error("The exported plane has no opaque footage");
    };
    expect(Math.abs(top(false) - expectedTop)).toBeLessThan(10);
    expect(Math.abs(top(true) - expectedTop)).toBeGreaterThan(25);
  }, 65000);
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

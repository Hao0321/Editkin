import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { floatingFrameCssMatrix, floatingFrameFfmpegFilters, floatingFrameGeometry, floatingVideoFramePreset } from "./floatingVideoFrame";

describe("floating frame decoded export geometry", () => {
  it("projects actual exported pixels to the browser position, rejecting inverse perspective", () => {
    const ffmpeg = process.env.EDITKIN_FFMPEG_PATH ?? process.env.HAO_FFMPEG_PATH ?? "ffmpeg";
    const frame = { ...floatingVideoFramePreset("matte"), centerX: .31, centerY: .65 };
    const g = floatingFrameGeometry(frame, 360, 640);
    const m = floatingFrameCssMatrix(g.quad, 360, 640).slice(9, -1).split(",").map(Number);
    const corners = [[g.left, g.top], [g.left + g.outerWidth, g.top], [g.left, g.top + g.outerHeight], [g.left + g.outerWidth, g.top + g.outerHeight]];
    const expectedTop = Math.min(...corners.map(([x, y]) => (m[1] * x + m[5] * y + m[13]) / (m[3] * x + m[7] * y + m[15])));
    const top = (inverse: boolean) => {
      const filters = floatingFrameFfmpegFilters(frame, 360, 640, 30).join(",");
      const pixels = execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x629AC0:s=360x640:r=30:d=0.1", "-vf", inverse ? filters.replace("sense=destination", "sense=source") : filters,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      for (let y = 0; y < 640; y++) for (let x = 0; x < 360; x++) if (pixels[(y * 360 + x) * 4 + 3] >= 180) return y;
      throw new Error("The exported plane has no opaque footage");
    };
    expect(Math.abs(top(false) - expectedTop)).toBeLessThan(10);
    expect(Math.abs(top(true) - expectedTop)).toBeGreaterThan(25);
  }, 65000);
});

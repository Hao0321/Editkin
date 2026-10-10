import { describe, expect, it } from "vitest";
import type { FloatingVideoFrame } from "../domain/types";
import { assertFloatingFramePhase, assertFloatingVideoFrame, floatingFrameCornerRadiusPixels, floatingFrameCssMatrix, floatingFrameFeatherPixels, floatingFrameFfmpegFilters, floatingFrameGeometry,
  floatingFrameLayout, floatingVideoFramePreset, floatingVideoFramePresetV2 } from "./floatingVideoFrame";

const source = { width: 1920, height: 1080 };
const context = (localFrame: number, fps = 30, durationFrames = 60) => ({ ...source, localFrame, fps, durationFrames });

/** Limited AVExpr arithmetic oracle, not a process/FFmpeg or decoded-pixel observation. */
function expressionAt(expression: string, frame: number): number {
  const executable = expression.replaceAll("if(", "choose(");
  const evaluate = new Function("N", "on", "PI", "sin", "cos", "clip", "between", "choose", `return (${executable});`);
  return evaluate(frame, frame, Math.PI, Math.sin, Math.cos,
    (n: number, low: number, high: number) => Math.max(low, Math.min(high, n)),
    (n: number, low: number, high: number) => Number(n >= low && n <= high),
    (condition: number, yes: number, no: number) => condition ? yes : no) as number;
}

function phaseExpression(filters: string[]): string {
  const alpha = filters.find(filter => filter.includes("a='alpha(X,Y)*if(between(N,"));
  if (!alpha) throw new Error("Missing actual frame-indexed panel alpha");
  return alpha.match(/a='alpha\(X,Y\)\*(.*)':interpolation=nearest$/)![1];
}

describe("source-preserving floating frame v2 shared layout", () => {
  it("authors explicit v2 defaults while the v1 factory and saved geometry remain unchanged", () => {
    expect(floatingVideoFramePresetV2("matte")).toEqual({ schema: "editkin.floating-video-frame/v2", style: "matte", size: .58,
      yawDegrees: -12, pitchDegrees: 3, aspect: "source", mediaFit: "contain", motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } });
    expect(floatingVideoFramePresetV2("portrait_orbit").aspect).toBe("portrait");
    const legacy = floatingVideoFramePreset("matte");
    expect(legacy).toEqual({ schema: "editkin.floating-video-frame/v1", style: "matte", size: .58, yawDegrees: -12, pitchDegrees: 3 });
    const geometry = floatingFrameGeometry(legacy, 1080, 1920);
    expect({ width: geometry.innerWidth, height: geometry.innerHeight, left: geometry.left, top: geometry.top }).toEqual({ width: 626, height: 1114, left: 225, top: 401 });
    const filters = floatingFrameFfmpegFilters(legacy, 1080, 1920, 30);
    expect(filters[0]).toBe("scale=626:1114:force_original_aspect_ratio=increase:flags=lanczos:reset_sar=1");
    expect(filters[1]).toBe("crop=626:1114:(iw-ow)/2:(ih-oh)/2");
    expect(filters.some(filter => filter.includes("between(N,"))).toBe(false);
    expect(floatingFrameCssMatrix(floatingFrameGeometry({ ...legacy, yawDegrees: 0, pitchDegrees: 0 }, 360, 640).quad, 360, 640))
      .toBe("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)");
  });

  it("fits a landscape source into the scaled portrait-canvas bounds without a cover crop", () => {
    const layout = floatingFrameLayout(floatingVideoFramePresetV2("matte"), 1080, 1920, context(30));
    expect([layout.geometry.innerWidth, layout.geometry.innerHeight]).toEqual([626, 352]);
    expect(layout.geometry.innerWidth).toBeLessThanOrEqual(1080 * .58);
    expect(layout.geometry.innerHeight).toBeLessThanOrEqual(1920 * .58);
    expect(layout.mediaFit).toBe("contain");
    expect(layout.sourceFit.cropped).toBe(false);
    expect(layout.sourceFit.left).toBeGreaterThanOrEqual(0);
    expect(layout.sourceFit.top).toBeGreaterThanOrEqual(0);
    expect(layout.sourceFit.left + layout.sourceFit.width).toBeLessThanOrEqual(layout.geometry.innerWidth);
    expect(layout.sourceFit.top + layout.sourceFit.height).toBeLessThanOrEqual(layout.geometry.innerHeight);
    expect(layout.sourceContentRect.width / layout.sourceContentRect.height).toBeCloseTo(16 / 9, 12);
    expect(floatingFrameFfmpegFilters(floatingVideoFramePresetV2("matte"), 1080, 1920, 30, { ...source, durationFrames: 60 })
      .some(filter => filter.startsWith("crop="))).toBe(false);
  });

  it("uses upright display ratio for anamorphic and rotated sources rather than canvas or encoded ratio", () => {
    const frame = floatingVideoFramePresetV2("matte");
    const anamorphic = floatingFrameLayout(frame, 1080, 1920, { ...context(30), width: 16, height: 9 });
    const squarePixelEncoded = floatingFrameLayout(frame, 1080, 1920, { ...context(30), width: 4, height: 3 });
    const uprightRotated = floatingFrameLayout(frame, 1080, 1920, { ...context(30), width: 9, height: 16 });
    expect(anamorphic.geometry.innerHeight).toBe(352);
    expect(squarePixelEncoded.geometry.innerHeight).toBe(468);
    expect(uprightRotated.geometry.innerHeight).toBe(1112);
    expect(uprightRotated.geometry.innerWidth).toBe(626);
    expect(anamorphic.geometry.innerHeight).not.toBe(squarePixelEncoded.geometry.innerHeight);
    expect(uprightRotated.sourceFit.cropped).toBe(false);
  });

  it("contains all source corners in explicit portrait and canvas planes with centered letterboxing", () => {
    const base = floatingVideoFramePresetV2("matte");
    for (const aspect of ["portrait", "canvas"] as const) {
      const layout = floatingFrameLayout({ ...base, aspect }, 1080, 1920, context(30));
      expect(layout.sourceFit.cropped).toBe(false);
      expect(layout.sourceFit.height).toBeLessThan(layout.geometry.innerHeight);
      expect(layout.sourceFit.left * 2 + layout.sourceFit.width).toBe(layout.geometry.innerWidth);
      expect(layout.sourceFit.top * 2 + layout.sourceFit.height).toBe(layout.geometry.innerHeight);
      const filters = floatingFrameFfmpegFilters({ ...base, aspect }, 1080, 1920, 30, { ...source, durationFrames: 60 });
      expect(layout.sourceContentRect.width / layout.sourceContentRect.height).toBeCloseTo(16 / 9, 12);
      expect(filters[0]).toBe(`scale=${layout.sourceFit.width}:${layout.sourceFit.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos:reset_sar=1`);
      expect(filters[1]).toContain(`pad=${layout.sourceFit.width}:${layout.sourceFit.height}:(ow-iw)/2:(oh-ih)/2:`);
      expect(filters[2]).toContain(`pad=${layout.geometry.innerWidth}:${layout.geometry.innerHeight}:${layout.sourceFit.left}:${layout.sourceFit.top}:`);
      expect(filters.some(filter => filter.startsWith("crop="))).toBe(false);
    }
  });

  it("keeps source-corner markers inside the opaque feather and blur buffer while legacy cover loses the side markers", () => {
    const value = floatingVideoFramePresetV2("matte");
    for (const dimensions of [[360, 640], [1080, 1920]] as const) {
      const [width, height] = dimensions, layout = floatingFrameLayout(value, width, height, context(30));
      const { geometry: g, sourceFit: fit } = layout;
      const radius = floatingFrameCornerRadiusPixels(value, width, height, g.border);
      const feather = floatingFrameFeatherPixels(width, height), buffer = Math.ceil(4 * 1.2);
      const corners = [[g.border + fit.left, g.border + fit.top], [g.border + fit.left + fit.width - 1, g.border + fit.top],
        [g.border + fit.left, g.border + fit.top + fit.height - 1], [g.border + fit.left + fit.width - 1, g.border + fit.top + fit.height - 1]];
      for (const [x, y] of corners) {
        const edgeDistance = Math.min(x, y, g.outerWidth - 1 - x, g.outerHeight - 1 - y);
        const cornerDistance = Math.hypot(Math.max(radius - x, 0, x - (g.outerWidth - radius - 1)),
          Math.max(radius - y, 0, y - (g.outerHeight - radius - 1)));
        expect(edgeDistance).toBeGreaterThanOrEqual(feather + buffer);
        expect(cornerDistance).toBeLessThanOrEqual(radius - .5 - buffer);
      }
      const legacy = floatingFrameLayout(floatingVideoFramePreset("matte"), width, height, context(30));
      expect(legacy.sourceFit.cropped).toBe(true);
      expect(legacy.sourceFit.left).toBeLessThan(0);
      expect(legacy.sourceFit.left + legacy.sourceFit.width).toBeGreaterThan(legacy.geometry.innerWidth);
      expect(fit.left).toBeGreaterThan(0);
      expect(fit.left + fit.width).toBeLessThan(g.innerWidth);
    }
    expect(() => floatingFrameLayout(value, 64, 64, { ...context(30), width: 100, height: 1 })).toThrow(/至少 2px/);
    expect(() => floatingFrameLayout({ ...value, size: .82 }, 64, 64, { ...context(30), width: 1, height: 1 })).toThrow(/畫布/);
  });

  it("rejects off-canvas source corners including an interior orbit extremum missed by endpoint-only checks", () => {
    const frame = { ...floatingVideoFramePresetV2("prism"), size: .82, yawDegrees: -20, pitchDegrees: 0, centerX: .61,
      orbit: { amplitudeDegrees: 30, periodSeconds: 3 }, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 } };
    // Independent physical viewport corners for this admitted raster: inner294x166,
    // border6, source inset5, full viewport284x156, centered at(180,320).
    const right = 322, top = 242;
    const screenX = (yawDegrees: number) => {
      // Independent H(theta) of the fixed physical corner, without passing an
      // orbit endpoint through the separate static-yaw authoring admission.
      const x = 2 * right / 360 - 1, y = 2 * top / 640 - 1, pitch = 0;
      const theta = yawDegrees * Math.PI / 180, a = 3.4 - y * Math.sin(pitch), b = x * Math.cos(pitch);
      return 360 * (.61 + 3.4 * x * Math.cos(theta) / (2 * (a + b * Math.sin(theta))));
    };
    expect(screenX(-50)).toBeLessThan(360);
    expect(screenX(10)).toBeLessThan(360);
    const interiorYaw = Math.asin(-((2 * right / 360 - 1) / 3.4)) * 180 / Math.PI;
    expect(interiorYaw).toBeGreaterThan(-50);
    expect(interiorYaw).toBeLessThan(10);
    expect(screenX(interiorYaw)).toBeGreaterThan(360);
    expect(() => floatingFrameLayout(frame, 360, 640, context(0))).toThrow(/完整來源投影超出畫布/);
    expect(() => floatingFrameLayout({ ...frame, centerX: .58 }, 360, 640, context(0))).not.toThrow();
    expect(() => floatingFrameLayout({ ...floatingVideoFramePresetV2("matte"), centerX: .8 }, 360, 640, context(30))).toThrow(/超出畫布/);
    expect(() => floatingFrameLayout({ ...floatingVideoFramePresetV2("matte"), aspect: "portrait", centerY: .8 }, 360, 640, context(30))).toThrow(/超出畫布/);
  });

  it("samples entry and exit smoothstep at exact integer endpoints with a short vertical settle", () => {
    const frame = { ...floatingVideoFramePresetV2("matte"), yawDegrees: 0, pitchDegrees: 0 };
    const first = floatingFrameLayout(frame, 360, 640, context(0));
    const entering = floatingFrameLayout(frame, 360, 640, context(3));
    const hold = floatingFrameLayout(frame, 360, 640, context(6));
    const leaving = floatingFrameLayout(frame, 360, 640, context(56));
    const last = floatingFrameLayout(frame, 360, 640, context(59));
    expect([first.opacity, entering.opacity, hold.opacity, leaving.opacity, last.opacity]).toEqual([0, .5, 1, .5, 0]);
    expect(first.visible).toBe(false);
    expect(last.visible).toBe(false);
    expect(entering.geometry.quad[0][1]).toBeCloseTo(.006, 12);
    expect(hold.geometry.quad[0][1]).toBe(0);
    expect(leaving.geometry.quad[0][1]).toBeCloseTo(-.006, 12);
    expect(first.geometry.quad[0][1] - last.geometry.quad[0][1]).toBeCloseTo(.024, 12);
  });

  it("gives exact arbitrary-seek receipts across fps clocks and makes zero phases hold without NaN", () => {
    const frame = floatingVideoFramePresetV2("matte");
    const expected = new Map([0, 3, 6, 30, 56, 59].map(localFrame => [localFrame, floatingFrameLayout(frame, 360, 640, context(localFrame))]));
    for (const localFrame of [59, 3, 30, 0, 56, 6, 3]) expect(floatingFrameLayout(frame, 360, 640, context(localFrame))).toEqual(expected.get(localFrame));
    for (const fps of [24, 29.97, 60]) expect(floatingFrameLayout(frame, 360, 640, context(3, fps)).opacity).toBe(.5);
    const hold = { ...frame, motion: { entranceFrames: 0, exitFrames: 0, travelY: 0 } };
    expect(floatingFrameLayout(hold, 360, 640, context(0, 30, 1)).opacity).toBe(1);
    expect(floatingFrameLayout(hold, 360, 640, context(-1, 30, 1)).opacity).toBe(0);
    expect(floatingFrameLayout(hold, 360, 640, context(1, 30, 1)).visible).toBe(false);
  });

  it("emits the same frame-local opacity and projected corners after assembled shadow alpha", () => {
    const frame = { ...floatingVideoFramePresetV2("portrait_orbit"), centerX: .43, centerY: .57 };
    const filters = floatingFrameFfmpegFilters(frame, 360, 640, 29.97, { ...source, durationFrames: 90 });
    const expression = phaseExpression(filters);
    const perspective = filters.find(filter => filter.startsWith("perspective="))!;
    const corners = [...perspective.matchAll(/(?:x\d|y\d)='([^']+)'/g)].map(match => match[1]);
    expect(corners).toHaveLength(8);
    expect(perspective).toContain("eval=frame");
    for (const localFrame of [0, 3, 6, 44, 83, 86, 89]) {
      const layout = floatingFrameLayout(frame, 360, 640, context(localFrame, 29.97, 90));
      expect(expressionAt(expression, localFrame)).toBeCloseTo(layout.opacity, 12);
      for (let index = 0; index < 4; index++) {
        expect(expressionAt(corners[index * 2], localFrame) / 360).toBeCloseTo(layout.geometry.quad[index][0], 10);
        expect(expressionAt(corners[index * 2 + 1], localFrame) / 640).toBeCloseTo(layout.geometry.quad[index][1], 10);
      }
    }
    const matteFilters = floatingFrameFfmpegFilters(floatingVideoFramePresetV2("matte"), 360, 640, 30, { ...source, durationFrames: 60 });
    const shadowIndex = matteFilters.findIndex(filter => filter.startsWith("geq=") && filter.includes("exp(-pow(max("));
    const phaseIndex = matteFilters.findIndex(filter => filter.includes("a='alpha(X,Y)*if(between(N,"));
    expect(shadowIndex).toBeGreaterThan(-1);
    expect(phaseIndex).toBeGreaterThan(shadowIndex);
    expect(expressionAt(expression, -1)).toBe(0);
    expect(expressionAt(expression, 90)).toBe(0);
  });

  it("rejects overlapping or fractional phases before constructing an export instead of silently renormalizing", () => {
    const frame = floatingVideoFramePresetV2("matte");
    expect(() => assertFloatingFramePhase(frame, 12)).toThrow(/重疊/);
    expect(() => floatingFrameFfmpegFilters(frame, 360, 640, 30, { ...source, durationFrames: 12 })).toThrow(/重疊/);
    expect(() => assertFloatingFramePhase(frame, 13)).not.toThrow();
    expect(() => assertFloatingVideoFrame({ ...frame, motion: { entranceFrames: 1.5, exitFrames: 0, travelY: 0 } })).toThrow();
    expect(() => assertFloatingVideoFrame({ ...frame, motion: { entranceFrames: 0, exitFrames: 25, travelY: 0 } })).toThrow();
    expect(() => assertFloatingVideoFrame({ ...frame, motion: { entranceFrames: 0, exitFrames: 0, travelY: .031 } })).toThrow();
  });

  it("fails closed for missing or invalid upright geometry, clock context, cover and unknown v2 fields", () => {
    const frame = floatingVideoFramePresetV2("matte");
    expect(() => floatingFrameGeometry(frame, 360, 640)).toThrow(/來源尺寸/);
    expect(() => floatingFrameFfmpegFilters(frame, 360, 640, 30)).toThrow(/來源尺寸/);
    for (const dimensions of [{ width: 0, height: 1080 }, { width: 1920, height: NaN }, { width: Infinity, height: 1 }]) {
      expect(() => floatingFrameLayout({ ...frame, aspect: "portrait" }, 360, 640, { ...context(6), ...dimensions })).toThrow(/來源尺寸/);
    }
    expect(() => floatingFrameLayout(frame, 360, 640, context(1.5))).toThrow(/整數/);
    expect(() => floatingFrameLayout(frame, 360, 640, context(6, 0))).toThrow(/影格率/);
    expect(() => floatingFrameLayout(frame, 360, 640, context(0, 1e-307))).toThrow(/有限範圍/);
    expect(() => assertFloatingVideoFrame({ ...frame, mediaFit: "cover" } as unknown as FloatingVideoFrame)).toThrow(/contain/);
    expect(() => assertFloatingVideoFrame({ ...frame, drift: 1 } as unknown as FloatingVideoFrame)).toThrow();
    expect(() => assertFloatingVideoFrame({ ...frame, motion: null } as unknown as FloatingVideoFrame)).toThrow();
    expect(() => assertFloatingVideoFrame({ ...floatingVideoFramePreset("matte"), mediaFit: "contain" } as unknown as FloatingVideoFrame)).toThrow(/未知版本欄位/);
  });
});

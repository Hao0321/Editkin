import { describe, expect, it } from "vitest";
import { DEFAULT_CHROMA_KEY } from "../domain/chromaKey";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import type { ClipMask, RotoMatteSequence } from "../domain/types";
import {
  applyClipAlphaPlanRgbaInPlace,
  clipLocalProjectFrame,
  pixelMattePreviewUri,
} from "./alphaPlanPreview";

function fullRectangle(id: string): ClipMask {
  const mask = createClipMask(id, "rectangle");
  mask.feather = 0;
  mask.path = [
    { id: "tl", x: 0, y: 0 }, { id: "tr", x: 1, y: 0 },
    { id: "br", x: 1, y: 1 }, { id: "bl", x: 0, y: 1 },
  ];
  return mask;
}

function sequence(): RotoMatteSequence {
  return {
    schema: "editkin.auto-roto-matte/v1",
    engine: "editkin-native-color-temporal-roto/v1",
    width: 4,
    height: 1,
    analysisFps: 12,
    frameCount: 4,
    sequenceUri: "matte.alpha8",
    manifestUri: "matte.json",
    framePreviewUris: ["preview-0.png", "preview-1.png", "preview-2.png", "preview-3.png"],
    meanBoundaryChatter: 0,
    frozen: true,
    qualityState: "diagnostic",
  };
}

describe("shared ClipAlphaPlan browser executor", () => {
  it("multiplies source alpha by the complete authored add/subtract/intersect stack in order", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const base = fullRectangle("base");
    const subtract = fullRectangle("subtract");
    subtract.mode = "subtract";
    subtract.opacity = .5;
    subtract.path = [
      { id: "tl", x: .5, y: 0 }, { id: "tr", x: 1, y: 0 },
      { id: "br", x: 1, y: 1 }, { id: "bl", x: .5, y: 1 },
    ];
    const limiter = fullRectangle("limiter");
    limiter.mode = "intersect";
    limiter.opacity = .75;
    clip.masks = [base, subtract, limiter];
    const pixels = new Uint8ClampedArray([
      10, 20, 30, 128, 10, 20, 30, 128, 10, 20, 30, 128, 10, 20, 30, 128,
    ]);

    applyClipAlphaPlanRgbaInPlace(pixels, 4, 1, compileClipAlphaPlan(project, clip), { localProjectFrame: 0 });

    expect([pixels[3], pixels[7], pixels[11], pixels[15]]).toEqual([96, 96, 64, 64]);
  });

  it("executes self-authored keyer before source-alpha × pixel-matte multiplication", () => {
    const project = createDemoProject();
    project.fps = 30;
    const clip = project.tracks[0].clips[0];
    const roto = createClipMask("roto", "subject");
    roto.feather = 0;
    roto.matteSequence = sequence();
    clip.masks = [roto];
    clip.chromaKey = { ...DEFAULT_CHROMA_KEY };
    const plan = compileClipAlphaPlan(project, clip);
    const pixels = new Uint8ClampedArray([
      0, 177, 64, 200,
      220, 20, 30, 200,
      220, 20, 30, 200,
      220, 20, 30, 200,
    ]);
    const matte = new Float32Array([1, .5, 0, 1]);

    applyClipAlphaPlanRgbaInPlace(pixels, 4, 1, plan, { localProjectFrame: 3, matteAlpha: matte });

    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(100);
    expect(pixels[11]).toBe(0);
    expect(pixels[15]).toBe(200);
    expect(pixelMattePreviewUri(plan, 2)).toBe("preview-0.png");
    expect(pixelMattePreviewUri(plan, 3)).toBe("preview-1.png");
  });

  it("uses the formal midpoint hold/lost rule and a stable project-frame floor", () => {
    const project = createDemoProject();
    project.fps = 30_000 / 1_001;
    const clip = project.tracks[0].clips[0];
    const tracked = fullRectangle("tracked");
    tracked.keyframes = [
      { frame: 0, time: 0, status: "tracked", confidence: 1, points: tracked.path },
      { frame: 6, time: .2, status: "lost", confidence: 0, points: tracked.path },
    ];
    clip.masks = [tracked];
    const plan = compileClipAlphaPlan(project, clip);
    const before = new Uint8ClampedArray([1, 2, 3, 255]);
    const after = new Uint8ClampedArray([1, 2, 3, 255]);
    applyClipAlphaPlanRgbaInPlace(before, 1, 1, plan, { localProjectFrame: 2 });
    applyClipAlphaPlanRgbaInPlace(after, 1, 1, plan, { localProjectFrame: 3 });
    expect(before[3]).toBe(255);
    expect(after[3]).toBe(0);
    expect(clipLocalProjectFrame(plan, 3 * 1_001 / 30_000)).toBe(3);
    expect(clipLocalProjectFrame(plan, .099)).toBe(2);
  });

  it("fails closed when a required pixel matte buffer is absent or dimensionally wrong", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const roto = createClipMask("roto", "subject");
    roto.matteSequence = sequence();
    clip.masks = [roto];
    const plan = compileClipAlphaPlan(project, clip);
    expect(() => applyClipAlphaPlanRgbaInPlace(new Uint8ClampedArray(16), 4, 1, plan, { localProjectFrame: 0 })).toThrow(/Matte 預覽尺寸/);
    expect(() => applyClipAlphaPlanRgbaInPlace(new Uint8ClampedArray(16), 4, 1, plan, { localProjectFrame: 0, matteAlpha: new Float32Array(3) })).toThrow(/Matte 預覽尺寸/);
  });

  it("feathers the mask, never the source's existing sharp or fractional alpha", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = fullRectangle("full-soft");
    mask.feather = .15;
    clip.masks = [mask];
    const width = 32, height = 16;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p += 1) pixels.set([10, 20, 30, p % width < 16 ? 0 : 128], p * 4);
    const original = pixels.slice();
    applyClipAlphaPlanRgbaInPlace(pixels, width, height, compileClipAlphaPlan(project, clip), { localProjectFrame: 0 });
    expect(pixels).toEqual(original);
  });

  it("keeps a hard mask edge sharp beside an independently feathered mask", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const soft = fullRectangle("left-soft");
    soft.path = soft.path.map(point => ({ ...point, x: point.x * .125 }));
    soft.feather = .08;
    const hard = fullRectangle("right-hard");
    hard.path = hard.path.map(point => ({ ...point, x: .75 + point.x * .25 }));
    clip.masks = [soft, hard];
    const width = 32, height = 16;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    applyClipAlphaPlanRgbaInPlace(pixels, width, height, compileClipAlphaPlan(project, clip), { localProjectFrame: 0 });
    for (let y = 0; y < height; y += 1) {
      expect(pixels[(y * width + 23) * 4 + 3]).toBe(0);
      expect(pixels[(y * width + 24) * 4 + 3]).toBe(255);
    }
    // The other operation really was feathered, rather than ignoring all feather.
    expect(pixels[5 * 4 + 3]).toBeGreaterThan(0);
    expect(pixels[5 * 4 + 3]).toBeLessThan(255);
  });

  it("preserves baked pixel-matte detail through a feathered full-frame intersect", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const roto = createClipMask("baked-detail", "subject");
    roto.matteSequence = sequence();
    const limiter = fullRectangle("soft-limiter");
    limiter.feather = .15;
    limiter.mode = "intersect";
    limiter.opacity = .5;
    clip.masks = [roto, limiter];
    const width = 32, height = 16;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(128);
    const matteAlpha = Float32Array.from({ length: width * height }, (_, p) => p % 2);
    applyClipAlphaPlanRgbaInPlace(pixels, width, height, compileClipAlphaPlan(project, clip), { localProjectFrame: 0, matteAlpha });
    for (let p = 0; p < width * height; p += 1) expect(pixels[p * 4 + 3]).toBe(p % 2 ? 64 : 0);
  });
});

import { describe, expect, it } from "vitest";
import { compileClipAlphaPlan } from "../domain/clipAlphaPlan";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { combinedMaskAlphaExpression, maskOperationFeatherSigma, matteMaskAlphaExpression } from "./maskFilters";

describe("mask render filters", () => {
  it("builds an exportable polygon alpha expression with feather", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("mask-1", "polygon");
    mask.feather = .02;
    clip.masks = [mask];
    const plan = compileClipAlphaPlan(project, clip);
    expect(combinedMaskAlphaExpression(plan, 1920, 1080)).toContain("mod(");
    expect(maskOperationFeatherSigma(plan.operations[0], 1920, 1080)).toBeCloseTo(21.6);
  });

  it("hides lost tracked frames instead of guessing a position", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("mask-1", "subject");
    mask.trackId = "track-1";
    clip.masks = [mask];
    project.motionTracks.push({ id: "track-1", clipId: clip.id, name: "主體", engine: "fixture", analysisFps: 30, initialRect: { x: .2, y: .2, width: .3, height: .4 }, points: [
      { frame: 0, time: 0, rect: { x: .2, y: .2, width: .3, height: .4 }, confidence: .9, status: "tracked" },
      { frame: 1, time: 1 / 30, rect: { x: .2, y: .2, width: .3, height: .4 }, confidence: 0, status: "lost" },
    ], lostRatio: .5, createdAt: new Date().toISOString() });
    expect(combinedMaskAlphaExpression(compileClipAlphaPlan(project, clip), 1920, 1080)).toContain(",0)");
  });

  it("uses the per-pixel luminance plane and still composes later masks", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const subject = createClipMask("subject", "subject");
    subject.matteSequence = { schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1", width: 320, height: 180, analysisFps: 12, frameCount: 24, sequenceUri: "C:/matte.alpha8", manifestUri: "C:/matte.json", framePreviewUris: Array.from({ length: 24 }, (_, index) => `C:/preview-${index}.png`), meanBoundaryChatter: .03, frozen: true, qualityState: "diagnostic" };
    subject.inverted = true;
    subject.opacity = .6;
    const subtract = createClipMask("cutout", "rectangle");
    subtract.mode = "subtract";
    subtract.opacity = .25;
    clip.masks = [subject, subtract];
    const plan = compileClipAlphaPlan(project, clip);
    const expression = matteMaskAlphaExpression(plan, 1920, 1080);
    expect(expression).toContain("0.6*(1-(lum(X");
    expect(expression).toContain("*(1-(");
    expect(expression).toContain("0.25*");
    expect(matteMaskAlphaExpression(plan, 1920, 1080, 65535)).toContain("lum(X,Y)/65535");
    expect(() => combinedMaskAlphaExpression(plan, 1920, 1080)).toThrow("不能退化成向量遮罩");
  });

  it("applies add, subtract, and intersect in authored order", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const add = createClipMask("add", "rectangle");
    const subtract = createClipMask("subtract", "ellipse");
    subtract.mode = "subtract";
    const intersect = createClipMask("intersect", "polygon");
    intersect.mode = "intersect";
    clip.masks = [add, subtract, intersect];

    const expression = combinedMaskAlphaExpression(compileClipAlphaPlan(project, clip), 1920, 1080)!;
    expect(expression).toMatch(/^min\(\(.+\)\*\(1-\(.+\)\)\,.+\)$/);
  });

  it("emits a valid zero-opacity operation instead of an empty numeric token", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = createClipMask("transparent", "rectangle");
    mask.opacity = 0;
    clip.masks = [mask];
    expect(combinedMaskAlphaExpression(compileClipAlphaPlan(project, clip), 1920, 1080)).toMatch(/^0\*/);
  });
});

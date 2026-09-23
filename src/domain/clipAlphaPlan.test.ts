import { describe, expect, it } from "vitest";
import { DEFAULT_CHROMA_KEY } from "./chromaKey";
import {
  ClipAlphaPlanError,
  compileClipAlphaPlan,
  floorClipAlphaSampleIndex,
  rationalRate,
  type ClipAlphaPlanErrorCode,
} from "./clipAlphaPlan";
import { createDemoProject } from "./demo";
import { createClipMask } from "./masks";
import type { ClipMask, RotoMatteSequence } from "./types";

function matteSequence(frameCount = 8): RotoMatteSequence {
  return {
    schema: "editkin.auto-roto-matte/v1",
    engine: "editkin-native-color-temporal-roto/v1",
    width: 160,
    height: 90,
    analysisFps: 12,
    frameCount,
    sequenceUri: "C:/fixture/matte.alpha8",
    manifestUri: "C:/fixture/matte.json",
    framePreviewUris: Array.from({ length: frameCount }, (_, index) => `C:/fixture/preview-${index}.png`),
    frameArtifactUris: Array.from({ length: frameCount }, (_, index) => `C:/fixture/artifact-${index}.png`),
    meanBoundaryChatter: .02,
    frozen: true,
    qualityState: "diagnostic",
  };
}

function pixelMask(id = "roto", frameCount = 8): ClipMask {
  const mask = createClipMask(id, "subject");
  mask.matteSequence = matteSequence(frameCount);
  return mask;
}

function capturedPlanError(run: () => unknown): ClipAlphaPlanError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClipAlphaPlanError);
    return error as ClipAlphaPlanError;
  }
  throw new Error("Expected compileClipAlphaPlan to fail closed");
}

describe("compileClipAlphaPlan", () => {
  it("preserves enabled authored order and requires the first enabled operation to add", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const disabled = createClipMask("disabled", "rectangle");
    disabled.enabled = false;
    disabled.mode = "subtract";
    const base = createClipMask("base", "ellipse");
    const cutout = createClipMask("cutout", "rectangle");
    cutout.mode = "subtract";
    const limiter = createClipMask("limiter", "polygon");
    limiter.mode = "intersect";
    clip.masks = [disabled, base, cutout, limiter];

    const plan = compileClipAlphaPlan(project, clip);
    expect(plan.operations.map(({ maskId, authoredIndex, mode }) => ({ maskId, authoredIndex, mode }))).toEqual([
      { maskId: "base", authoredIndex: 1, mode: "add" },
      { maskId: "cutout", authoredIndex: 2, mode: "subtract" },
      { maskId: "limiter", authoredIndex: 3, mode: "intersect" },
    ]);

    base.mode = "subtract";
    const error = capturedPlanError(() => compileClipAlphaPlan(project, clip));
    expect(error.code).toBe<ClipAlphaPlanErrorCode>("first-mask-must-add");
    expect(error.maskId).toBe("base");
  });

  it("rejects a second enabled pixel matte before either can fall back to a subject ellipse", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const first = pixelMask("roto-a");
    const second = pixelMask("roto-b");
    second.mode = "intersect";
    clip.masks = [first, second];

    const error = capturedPlanError(() => compileClipAlphaPlan(project, clip));
    expect(error.code).toBe("multiple-pixel-mattes");
    expect(error.maskId).toBe("roto-b");
  });

  it("rejects an orphaned frozen Auto Roto marker instead of rendering the subject fallback ellipse", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const orphan = createClipMask("orphaned-roto", "subject");
    orphan.frozenRange = { fromFrame: 0, toFrame: 30 };
    clip.masks = [orphan];

    const error = capturedPlanError(() => compileClipAlphaPlan(project, clip));
    expect(error.code).toBe("pixel-matte-invalid");
    expect(error.message).toContain("不得退化成主體橢圓");
  });

  it.each([
    ["stale", (mask: ClipMask) => { mask.matteSequence!.stale = true; }, "pixel-matte-stale"],
    ["not frozen", (mask: ClipMask) => { (mask.matteSequence as unknown as { frozen: boolean }).frozen = false; }, "pixel-matte-not-frozen"],
    ["preview list absent", (mask: ClipMask) => { delete mask.matteSequence!.framePreviewUris; }, "pixel-matte-preview-missing"],
    ["preview list incomplete", (mask: ClipMask) => { mask.matteSequence!.framePreviewUris!.pop(); }, "pixel-matte-preview-missing"],
    ["preview URI blank", (mask: ClipMask) => { mask.matteSequence!.framePreviewUris![0] = " "; }, "pixel-matte-preview-missing"],
  ])("blocks an enabled pixel matte when %s", (_label, mutate, code) => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = pixelMask();
    clip.masks = [mask];
    mutate(mask);
    expect(capturedPlanError(() => compileClipAlphaPlan(project, clip)).code).toBe(code);
  });

  it("uses durable artifact inventory for formal compile and hydrated previews for UI compile", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const mask = pixelMask("durable-roto", 2);
    const previews = [...mask.matteSequence!.framePreviewUris!];
    const artifacts = [...mask.matteSequence!.frameArtifactUris!];
    clip.masks = [mask];
    expect((compileClipAlphaPlan(project, clip, "preview").operations[0] as unknown as { matte: { previewUris: readonly string[] } }).matte.previewUris).toEqual(previews);
    delete mask.matteSequence!.framePreviewUris;
    expect((compileClipAlphaPlan(project, clip, "formal").operations[0] as unknown as { matte: { previewUris: readonly string[] } }).matte.previewUris).toEqual(artifacts);
    delete mask.matteSequence!.frameArtifactUris;
    expect(capturedPlanError(() => compileClipAlphaPlan(project, clip, "formal")).code).toBe("pixel-matte-preview-missing");
  });

  it("ignores disabled stale matte artifacts and snapshots Keyer + Roto into one shared alpha plan", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const disabled = pixelMask("disabled-roto");
    disabled.enabled = false;
    disabled.matteSequence!.stale = true;
    clip.masks = [disabled];
    expect(compileClipAlphaPlan(project, clip).operations).toHaveLength(0);

    const enabled = pixelMask("enabled-roto");
    clip.masks = [enabled];
    clip.chromaKey = { ...DEFAULT_CHROMA_KEY };
    const plan = compileClipAlphaPlan(project, clip);
    expect(plan.keyer).toEqual(DEFAULT_CHROMA_KEY);
    expect(plan.operations.map((operation) => operation.source)).toEqual(["pixel_matte"]);
  });

  it("snapshots mutable clip state and uses exact rational floor sampling", () => {
    const project = createDemoProject();
    project.fps = 30_000 / 1_001;
    const clip = project.tracks[0].clips[0];
    const mask = pixelMask("roto", 100);
    clip.masks = [mask];
    const plan = compileClipAlphaPlan(project, clip);

    expect(plan.sampleRule.projectRate).toEqual({ numerator: 30_000, denominator: 1_001 });
    expect(rationalRate(12)).toEqual({ numerator: 12, denominator: 1 });
    expect(floorClipAlphaSampleIndex(plan, 0)).toBe(0);
    expect(floorClipAlphaSampleIndex(plan, 2)).toBe(0);
    expect(floorClipAlphaSampleIndex(plan, 3)).toBe(1);
    expect(floorClipAlphaSampleIndex(plan, 10_000)).toBe(99);

    mask.opacity = .1;
    mask.matteSequence!.framePreviewUris![0] = "C:/mutated.png";
    expect(plan.operations[0].opacity).toBe(1);
    expect(plan.operations[0].source).toBe("pixel_matte");
    if (plan.operations[0].source === "pixel_matte") {
      expect(plan.operations[0].matte.previewUris[0]).toBe("C:/fixture/preview-0.png");
      expect(plan.operations[0].matte.sequence.framePreviewUris![0]).toBe("C:/fixture/preview-0.png");
    }
  });
});

import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { createClipMask, maskCssImage } from "./masks";
import type { ClipMask } from "./types";

function fixture() {
  const project = createDemoProject();
  project.fps = 30;
  const clip = project.tracks[0].clips[0];
  const mask = createClipMask("pixel-mask", "subject");
  mask.matteSequence = {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
    width: 16, height: 16, analysisFps: 12, frameCount: 3,
    sequenceUri: "C:/fixture/matte.alpha8", manifestUri: "C:/fixture/matte.json",
    framePreviewUris: ["C:/fixture/0.png", "C:/fixture/1.png", "C:/fixture/2.png"],
    meanBoundaryChatter: 0, frozen: true, qualityState: "diagnostic",
  };
  clip.masks = [mask];
  return { project, clip, mask };
}

describe("mask CSS compatibility helper cannot bypass the alpha plan", () => {
  it("uses rational floor sampling instead of jumping to the next matte frame early", () => {
    const { project, clip, mask } = fixture();
    expect(maskCssImage(project, clip, mask, 2 / 30)).toBe('url("C:/fixture/0.png")');
    expect(maskCssImage(project, clip, mask, .099)).toBe('url("C:/fixture/0.png")');
    expect(maskCssImage(project, clip, mask, 3 / 30)).toBe('url("C:/fixture/1.png")');
  });

  it.each<[string, (mask: ClipMask) => void]>([
    ["stale", mask => { mask.matteSequence!.stale = true; }],
    ["missing previews", mask => { delete mask.matteSequence!.framePreviewUris; }],
    ["incomplete previews", mask => { mask.matteSequence!.framePreviewUris!.pop(); }],
    ["orphaned frozen range", mask => { delete mask.matteSequence; mask.frozenRange = { fromFrame: 0, toFrame: 29 }; }],
  ])("rejects %s without returning an old bitmap or fallback ellipse", (_label, mutate) => {
    const { project, clip, mask } = fixture();
    mutate(mask);
    expect(() => maskCssImage(project, clip, mask, 0)).toThrow();
  });

  it("leaves disabled masks inert and ordinary editable vectors available", () => {
    const { project, clip, mask } = fixture();
    mask.enabled = false;
    mask.matteSequence!.stale = true;
    expect(maskCssImage(project, clip, mask, 0)).toBe("linear-gradient(transparent,transparent)");
    const vector = createClipMask("vector", "rectangle");
    expect(maskCssImage(project, clip, vector, 0)).toContain("data:image/svg+xml");
  });
});

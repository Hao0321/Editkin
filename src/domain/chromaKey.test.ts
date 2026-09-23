import { describe, expect, it } from "vitest";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { findClip } from "./editGraph";
import { createHistory, dispatchCommand, redo, undo } from "./history";
import { createClipMask } from "./masks";
import { editorCommandSchema, projectSchema } from "./schema";
import {
  applyChromaKeyPixel,
  applyChromaKeyRgbaInPlace,
  CHROMA_KEY_PRESETS,
  chromaKeyAlpha,
  chromaKeyFfmpegFilter,
} from "./chromaKey";

describe("Editkin self-authored green/blue screen keyer", () => {
  it("produces transparent screen, opaque subject and fractional edge alpha", () => {
    const green = CHROMA_KEY_PRESETS.green;
    expect(chromaKeyAlpha(0, 177, 64, green)).toBeLessThan(.001);
    expect(chromaKeyAlpha(220, 35, 25, green)).toBeGreaterThan(.999);
    const edge = chromaKeyAlpha(25, 150, 60, green);
    expect(edge).toBeGreaterThan(.02);
    expect(edge).toBeLessThan(.98);
  });

  it("removes edge spill without modifying disabled pixels or destroying input alpha", () => {
    const settings = { ...CHROMA_KEY_PRESETS.green, despill: 1 };
    const keyed = applyChromaKeyPixel(25, 150, 60, 128, settings);
    expect(keyed.g).toBeLessThan(150);
    expect(keyed.r).toBeGreaterThan(25);
    expect(keyed.a).toBeLessThanOrEqual(128);
    expect(applyChromaKeyPixel(4, 5, 6, 77, { ...settings, enabled: false })).toEqual({ r: 4, g: 5, b: 6, a: 77 });
  });

  it("uses the same bounded scalar contract for preview buffers and formal FFmpeg GEQ", () => {
    const pixels = new Uint8ClampedArray([0, 177, 64, 255, 220, 35, 25, 255, 25, 150, 60, 128]);
    applyChromaKeyRgbaInPlace(pixels, CHROMA_KEY_PRESETS.green);
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(255);
    expect(pixels[11]).toBeGreaterThan(0);
    expect(pixels[11]).toBeLessThan(128);
    const filter = chromaKeyFfmpegFilter(CHROMA_KEY_PRESETS.green)!;
    expect(filter).toContain("geq=");
    expect(filter).toContain("alpha(X,Y)");
    expect(filter).not.toContain("chromakey");
    const highPrecision = chromaKeyFfmpegFilter(CHROMA_KEY_PRESETS.green, "high16")!;
    expect(highPrecision).toContain("format=gbrap16le");
    expect(highPrecision).toContain(",0,65535)");
    expect(highPrecision).not.toContain("format=rgba");
  });

  it("persists, validates, undoes, redoes and schema-round-trips settings", () => {
    const initial = createHistory(createDemoProject());
    const changed = dispatchCommand(initial, { type: "set_clip_chroma_key", clipId: "clip-demo", settings: CHROMA_KEY_PRESETS.blue }, "blue-key");
    expect(findClip(changed.present, "clip-demo").chromaKey).toEqual(CHROMA_KEY_PRESETS.blue);
    expect(findClip(undo(changed).present, "clip-demo").chromaKey).toBeUndefined();
    expect(findClip(redo(undo(changed)).present, "clip-demo").chromaKey?.screen).toBe("blue");
    expect(projectSchema.parse(JSON.parse(JSON.stringify(changed.present)))).toEqual(changed.present);
    expect(editorCommandSchema.parse({ type: "set_clip_chroma_key", clipId: "clip-demo", settings: CHROMA_KEY_PRESETS.green })).toEqual({ type: "set_clip_chroma_key", clipId: "clip-demo", settings: CHROMA_KEY_PRESETS.green });
  });

  it("fails closed for wrong colorspace and wrong screen color while accepting shared-plan Auto Roto multiplication", () => {
    const aces = createDemoProject();
    aces.colorManagement = { ...aces.colorManagement!, mode: "aces2" };
    expect(() => applyCommand(aces, { type: "set_clip_chroma_key", clipId: "clip-demo", settings: CHROMA_KEY_PRESETS.green })).toThrow(/Rec\.709/);
    expect(() => applyCommand(createDemoProject(), { type: "set_clip_chroma_key", clipId: "clip-demo", settings: { ...CHROMA_KEY_PRESETS.green, screenColor: "#CC2200" } })).toThrow(/設定不合法/);

    let matteProject = createDemoProject();
    const mask = createClipMask("roto-conflict", "subject");
    const digest = "a".repeat(64);
    const artifactRoot = `C:/Editkin/cache/auto-roto-product/${digest}`;
    const width = 160;
    const height = 90;
    const frameCount = 4;
    mask.matteSequence = {
      schema: "editkin.auto-roto-matte/v1",
      engine: "editkin-native-color-temporal-roto/v1",
      width,
      height,
      analysisFps: 12,
      frameCount,
      sequenceUri: `${artifactRoot}/matte-sequence.alpha8`,
      sequenceSha256: digest,
      sequenceBytes: width * height * frameCount,
      manifestUri: `${artifactRoot}/matte-manifest.json`,
      framePreviewUris: Array.from({ length: frameCount }, (_, frame) => `asset://localhost/${digest}/${frame}`),
      frameArtifactUris: Array.from({ length: frameCount }, (_, frame) => `${artifactRoot}/frame-${String(frame).padStart(6, "0")}.png`),
      meanBoundaryChatter: 0,
      regionMemoryRouting: {
        schema: "editkin.region-memory-routing/v1",
        requested: "fixed_baseline",
        executed: "fixed_baseline",
        candidateAttempted: false,
        deterministicFallback: false,
      },
      alphaRefinement: {
        schema: "editkin.optical-alpha-refinement-aggregate/v1",
        engine: "editkin-self-authored-optical-alpha-refiner/v1",
        appliedFrames: frameCount,
        radius: 4,
        backgroundThreshold: .2,
        foregroundThreshold: .8,
        coarseWeight: .5,
        temporalStability: .5,
        temporalGate: .5,
        changedPixels: 0,
        fractionalPixels: 0,
        solvedPixels: 0,
        meanSolveConfidence: 1,
      },
      routeReceipt: createProductAutoRotoRouteReceipt(),
      frozen: true,
      qualityState: "diagnostic",
    };
    matteProject = applyCommand(matteProject, { type: "add_clip_mask", clipId: "clip-demo", mask });
    const combined = applyCommand(matteProject, { type: "set_clip_chroma_key", clipId: "clip-demo", settings: CHROMA_KEY_PRESETS.green });
    expect(findClip(combined, "clip-demo").chromaKey).toEqual(CHROMA_KEY_PRESETS.green);
  });
});

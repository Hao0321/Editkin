import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import { parseProject, readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { applyCommand } from "./commands";
import { createDemoProject } from "./demo";
import { createClipMask } from "./masks";
import { editorCommandSchema, projectSchema } from "./schema";
import type { ClipMask } from "./visualTypes";

const temporaryRoots: string[] = [];
const digest = "a".repeat(64);
const artifactRoot = `C:/Editkin/cache/auto-roto-product/${digest}`;

function productMask(): ClipMask {
  const mask = createClipMask("product-roto", "subject");
  mask.matteSequence = {
    schema: "editkin.auto-roto-matte/v1",
    engine: "editkin-native-color-temporal-roto/v1",
    width: 16,
    height: 16,
    analysisFps: 12,
    frameCount: 2,
    sequenceUri: `${artifactRoot}/matte-sequence.alpha8`,
    sequenceSha256: digest,
    sequenceBytes: 512,
    manifestUri: `${artifactRoot}/matte-manifest.json`,
    framePreviewUris: [`asset://localhost/${digest}/0`, `asset://localhost/${digest}/1`],
    frameArtifactUris: [`${artifactRoot}/frame-000000.png`, `${artifactRoot}/frame-000001.png`],
    meanBoundaryChatter: .02,
    correctionStrokesApplied: 0,
    correctedFrames: [],
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
      appliedFrames: 2,
      radius: 4,
      backgroundThreshold: .2,
      foregroundThreshold: .8,
      coarseWeight: .5,
      temporalStability: .5,
      temporalGate: .5,
      changedPixels: 10,
      fractionalPixels: 20,
      solvedPixels: 10,
      meanSolveConfidence: .8,
    },
    routeReceipt: createProductAutoRotoRouteReceipt(),
    frozen: true,
    qualityState: "diagnostic",
  };
  return mask;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Auto Roto product authoring boundary", () => {
  it("accepts only a complete native v2 product matte command", () => {
    const command = { type: "add_clip_mask" as const, clipId: "clip-demo", mask: productMask() };
    const parsed = editorCommandSchema.parse(command);
    const project = applyCommand(createDemoProject(), parsed);
    expect(project.tracks[0].clips[0].masks?.[0].matteSequence?.routeReceipt).toEqual(createProductAutoRotoRouteReceipt());
  });

  it.each([
    ["legacy ONNX engine", (mask: ClipMask) => { (mask.matteSequence as unknown as { engine: string }).engine = "editkin-native-onnx-assisted-roto/v1"; }],
    ["legacy SAM engine", (mask: ClipMask) => { (mask.matteSequence as unknown as { engine: string }).engine = "editkin-sam21-video-memory-roto/v1"; }],
    ["missing route receipt", (mask: ClipMask) => { delete mask.matteSequence!.routeReceipt; }],
    ["missing routing receipt", (mask: ClipMask) => { delete mask.matteSequence!.regionMemoryRouting; }],
    ["missing alpha refinement", (mask: ClipMask) => { delete mask.matteSequence!.alphaRefinement; }],
    ["missing sequence digest", (mask: ClipMask) => { delete mask.matteSequence!.sequenceSha256; }],
    ["escaped frame path", (mask: ClipMask) => { mask.matteSequence!.frameArtifactUris![0] = "C:/Editkin/outside.png"; }],
    ["tampered route policy", (mask: ClipMask) => { (mask.matteSequence!.routeReceipt as unknown as { policyVersion: string }).policyVersion = "legacy"; }],
  ])("rejects %s", (_label, mutate) => {
    const mask = productMask();
    mutate(mask);
    expect(editorCommandSchema.safeParse({ type: "add_clip_mask", clipId: "clip-demo", mask }).success).toBe(false);
  });

  it("retires legacy research mattes as inert history and strips them from current authoring", () => {
    const project = createDemoProject();
    const mask = createClipMask("legacy-onnx", "subject");
    const hash = "b".repeat(64);
    (mask as unknown as { matteSequence: Record<string, unknown> }).matteSequence = {
      schema: "editkin.auto-roto-matte/v1",
      engine: "editkin-native-onnx-assisted-roto/v1",
      width: 160,
      height: 90,
      analysisFps: 12,
      frameCount: 1,
      sequenceUri: "legacy.alpha8",
      sequenceSha256: hash.toUpperCase(),
      manifestUri: "legacy.json",
      meanBoundaryChatter: .02,
      onnxModel: {
        schema: "editkin.auto-roto-onnx-pack/v1",
        id: "legacy",
        version: "1.0.0",
        qualityTier: "production",
        modelSha256: hash,
        runtimeSha256: hash,
        runtimeVersion: "1.0.0",
        runtimeVersionSha256: hash,
        licenseSha256: hash,
        inputName: "input",
        outputName: "output",
        tensorElements: 1,
        inferenceCalls: 1,
      },
      frozen: true,
      qualityState: "diagnostic",
    };
    project.tracks[0].clips[0].masks = [mask];
    const nestedClip = structuredClone(project.tracks[0].clips[0]);
    nestedClip.id = "nested-legacy-clip";
    nestedClip.trackId = "nested-legacy-track";
    project.compositions.push({
      schema: "editkin.composition/v1", id: "legacy-composition", name: "Legacy composition",
      width: project.width, height: project.height, fps: project.fps, duration: nestedClip.duration,
      tracks: [{ id: "nested-legacy-track", name: "Nested", kind: "video", locked: false, muted: false, clips: [nestedClip] }],
      captions: [], captionStyle: structuredClone(project.captionStyle), motionTracks: [], motionGraphics: [],
      director: structuredClone(project.director), updatedAt: project.updatedAt,
    });
    expect(projectSchema.safeParse(project).success).toBe(false);
    expect(editorCommandSchema.safeParse({ type: "add_clip_mask", clipId: "clip-demo", mask }).success).toBe(false);
    const migrated = parseProject(project);
    const migratedMask = migrated.tracks[0].clips[0].masks?.[0];
    expect(migratedMask?.matteSequence).toBeUndefined();
    expect(migratedMask?.retiredAutoRotoRecord).toEqual({
      schema: "editkin.retired-auto-roto-record/v1",
      reason: "non-product-engine",
      originalEngine: "editkin-native-onnx-assisted-roto/v1",
      originalManifestUri: "legacy.json",
      originalSequenceSha256: hash,
      originalQualityState: "diagnostic",
    });
    const migratedNestedMask = migrated.compositions[0].tracks[0].clips[0].masks?.[0];
    expect(migratedNestedMask?.matteSequence).toBeUndefined();
    expect(migratedNestedMask).toMatchObject({
      retiredAutoRotoRecord: {
        reason: "non-product-engine",
        originalEngine: "editkin-native-onnx-assisted-roto/v1",
      },
    });
  });

  it("preserves the v2 receipt and raw artifact inventory across save and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-roto-project-"));
    temporaryRoots.push(directory);
    const projectPath = join(directory, "project.editkin.json");
    const project = createDemoProject();
    project.tracks[0].clips[0].masks = [productMask()];

    const saved = await writeProjectFileAtomic(projectPath, project);
    const durableJson = await readFile(projectPath, "utf8");
    const reopened = await readProjectFile(projectPath);
    const sequence = reopened.tracks[0].clips[0].masks?.[0].matteSequence;
    expect(sequence?.routeReceipt).toEqual(createProductAutoRotoRouteReceipt());
    expect(sequence?.regionMemoryRouting).toMatchObject({ requested: "fixed_baseline", executed: "fixed_baseline" });
    expect(sequence?.frameArtifactUris).toEqual(productMask().matteSequence?.frameArtifactUris);
    expect(sequence?.framePreviewUris).toBeUndefined();
    expect(durableJson).not.toContain("asset://");
    expect(durableJson).not.toContain("framePreviewUris");
    expect(saved.revision).toBe(1);
  });

  it("persists multiple stale brush corrections and returns to a fresh matte after reanalysis", async () => {
    const directory = await mkdtemp(join(tmpdir(), "editkin-roto-corrections-"));
    temporaryRoots.push(directory);
    const projectPath = join(directory, "project.editkin.json");
    let project = createDemoProject();
    const clipId = project.tracks[0].clips[0].id;
    project = applyCommand(project, { type: "add_clip_mask", clipId, mask: productMask() });
    const first = { id: "foreground-1", frame: 0, mode: "foreground" as const, radius: .04, points: [{ x: .4, y: .5 }] };
    const second = { id: "background-1", frame: 1, mode: "background" as const, radius: .05, points: [{ x: .7, y: .4 }] };
    const current = project.tracks[0].clips[0].masks![0].matteSequence!;
    project = applyCommand(project, {
      type: "update_clip_mask", clipId, maskId: "product-roto",
      patch: { rotoCorrections: [first], matteSequence: { ...current, stale: true } },
    });
    project = applyCommand(project, {
      type: "update_clip_mask", clipId, maskId: "product-roto",
      patch: { rotoCorrections: [first, second], matteSequence: { ...project.tracks[0].clips[0].masks![0].matteSequence!, stale: true } },
    });
    const saved = await writeProjectFileAtomic(projectPath, project);
    const reopened = await readProjectFile(projectPath);
    const reopenedMask = reopened.tracks[0].clips[0].masks![0];
    expect(reopenedMask.rotoCorrections).toEqual([first, second]);
    expect(reopenedMask.matteSequence?.stale).toBe(true);
    const reanalyzed = productMask().matteSequence!;
    reanalyzed.correctionStrokesApplied = 2;
    reanalyzed.correctedFrames = [0, 1];
    const refreshed = applyCommand(reopened, {
      type: "update_clip_mask", clipId, maskId: "product-roto",
      patch: { matteSequence: reanalyzed },
    });
    const refreshedMask = refreshed.tracks[0].clips[0].masks![0];
    expect(refreshedMask).toMatchObject({
      rotoCorrections: [first, second],
      matteSequence: { correctionStrokesApplied: 2, correctedFrames: [0, 1] },
    });
    expect(refreshedMask.matteSequence?.stale).toBeUndefined();
    expect(saved.tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toBeUndefined();
  });
});

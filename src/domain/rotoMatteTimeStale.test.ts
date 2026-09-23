import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProductAutoRotoRouteReceipt } from "../application/autoRotoProductContract";
import { readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { createProjectSession } from "../application/projectSession";
import { runAutoRotoAction } from "../application/runAutoRotoAction";
import type { AutoRotoDesktopResult } from "../desktop/types";
import { autoRotoRuntimeStatusFromReceipt } from "../ui/autoRotoRuntimeStatus";
import { applyCommand, type EditorCommand } from "./commands";
import { createDemoProject } from "./demo";
import { validateProject } from "./editGraph";
import { dispatchCommand } from "./history";
import { createClipMask } from "./masks";
import { editorCommandSchema, projectSchema } from "./schema";
import type { RotoMatteSequence } from "./types";

// Synthetic authoring-contract data, not native execution or model quality evidence.
function matte(key = "a"): RotoMatteSequence {
  const root = `C:/fixture-only/auto-roto-product/${key.repeat(64)}`;
  return {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
    width: 16, height: 16, analysisFps: 12, frameCount: 2,
    sequenceUri: `${root}/matte-sequence.alpha8`, sequenceSha256: "c".repeat(64), sequenceBytes: 512,
    manifestUri: `${root}/matte-manifest.json`,
    frameArtifactUris: [0, 1].map(frame => `${root}/frame-${String(frame).padStart(6, "0")}.png`),
    framePreviewUris: [0, 1].map(frame => `asset://fixture/${key}/${frame}`),
    meanBoundaryChatter: .02, correctionStrokesApplied: 0, correctedFrames: [],
    regionMemoryRouting: { schema: "editkin.region-memory-routing/v1", requested: "fixed_baseline", executed: "fixed_baseline", candidateAttempted: false, deterministicFallback: false },
    alphaRefinement: {
      schema: "editkin.optical-alpha-refinement-aggregate/v1", engine: "editkin-self-authored-optical-alpha-refiner/v1",
      appliedFrames: 2, radius: 4, backgroundThreshold: .2, foregroundThreshold: .8, coarseWeight: .5,
      temporalStability: .5, temporalGate: .5, changedPixels: 10, fractionalPixels: 20, solvedPixels: 10, meanSolveConfidence: .8,
    },
    routeReceipt: createProductAutoRotoRouteReceipt(), frozen: true, qualityState: "diagnostic",
  };
}
function timeStaleProject() {
  const project = createDemoProject();
  const mask = createClipMask("time-stale", "subject");
  mask.matteSequence = Object.assign(matte(), { stale: true, staleReason: "clip-time-range-changed" });
  project.tracks[0].clips[0].masks = [mask];
  return project;
}
const stroke = { id: "brush-1", frame: 0, mode: "foreground" as const, radius: .04, points: [{ x: .4, y: .5 }] };

describe("time-invalidated matte authoring and durable project boundary", () => {
  it("accepts and preserves the explicit reason without rewriting artifact provenance", () => {
    const project = timeStaleProject();
    expect(projectSchema.parse(project).tracks[0].clips[0].masks![0].matteSequence).toEqual(project.tracks[0].clips[0].masks![0].matteSequence);
    expect(validateProject(project)).toBe(project);
  });

  it.each([false, undefined])("rejects reason when stale is %s, including direct typed-domain callers", stale => {
    const project = timeStaleProject();
    project.tracks[0].clips[0].masks![0].matteSequence!.stale = stale;
    expect(projectSchema.safeParse(project).success).toBe(false);
    expect(() => validateProject(project)).toThrow(/matte|過期/);
  });

  it("rejects an unknown stale reason even outside Zod", () => {
    const project = timeStaleProject();
    Object.assign(project.tracks[0].clips[0].masks![0].matteSequence!, { staleReason: "pretend-fresh" });
    expect(projectSchema.safeParse(project).success).toBe(false);
    expect(() => validateProject(project)).toThrow(/matte|過期/);
  });

  it("persists and reopens the reason and complete artifact inventory, without process-local preview URLs", async () => {
    // Keep only this owned temporary directory as replay evidence; no user data is deleted.
    const directory = await mkdtemp(join(tmpdir(), "editkin-time-stale-project-"));
    const path = join(directory, "project.editkin.json");
    const project = timeStaleProject();
    await writeProjectFileAtomic(path, project);
    const reopened = await readProjectFile(path);
    const { framePreviewUris: _preview, ...durable } = project.tracks[0].clips[0].masks![0].matteSequence!;
    expect(reopened.tracks[0].clips[0].masks![0].matteSequence).toEqual(durable);
    expect(await readFile(path, "utf8")).toContain('"staleReason": "clip-time-range-changed"');
    console.info(JSON.stringify({ evidence: "time-stale-project-roundtrip", path }));
  });

  it.each([false, true])("blocks direct brush writes after a cut (old matte supplied=%s)", includeMatte => {
    const project = timeStaleProject();
    const old = project.tracks[0].clips[0].masks![0].matteSequence!;
    const command: EditorCommand = { type: "update_clip_mask", clipId: "clip-demo", maskId: "time-stale", patch: { rotoCorrections: [stroke], ...(includeMatte ? { matteSequence: old } : {}) } };
    expect(() => applyCommand(project, command)).toThrow(/重新分析/);
    expect(project.tracks[0].clips[0].masks![0].rotoCorrections).toBeUndefined();
  });

  it.each(["clear", "same-artifact", "path-spelling"])("does not allow %s to launder an invalidated artifact", attempt => {
    const project = timeStaleProject();
    const replacement = attempt === "clear" ? undefined : matte();
    if (attempt === "path-spelling") {
      replacement!.manifestUri = replacement!.manifestUri.replaceAll("/", "\\");
      replacement!.sequenceUri = replacement!.sequenceUri.replaceAll("/", "\\");
      replacement!.frameArtifactUris = replacement!.frameArtifactUris!.map(path => path.replaceAll("/", "\\"));
    }
    expect(() => applyCommand(project, { type: "update_clip_mask", clipId: "clip-demo", maskId: "time-stale", patch: { matteSequence: replacement } })).toThrow(/重新分析/);
  });

  it.each(["feather", "keyframe", "track"])("retains time-stale evidence when changing %s", field => {
    const project = timeStaleProject();
    const old = structuredClone(project.tracks[0].clips[0].masks![0].matteSequence!);
    const command: EditorCommand = field === "feather"
      ? { type: "update_clip_mask", clipId: "clip-demo", maskId: "time-stale", patch: { feather: .1 } }
      : field === "track"
        ? { type: "set_clip_mask_track", clipId: "clip-demo", maskId: "time-stale" }
        : { type: "set_clip_mask_keyframe", clipId: "clip-demo", maskId: "time-stale", keyframe: { frame: 0, time: 0, points: project.tracks[0].clips[0].masks![0].path, confidence: 1, status: "manual" } };
    const result = applyCommand(project, command);
    expect(result.tracks[0].clips[0].masks![0].matteSequence).toEqual(old);
  });

  it("accepts a complete fresh reanalysis at a new artifact root, even if alpha digest is unchanged", () => {
    const project = timeStaleProject();
    const fresh = matte("b");
    const command = editorCommandSchema.parse({ type: "update_clip_mask", clipId: "clip-demo", maskId: "time-stale", patch: { matteSequence: fresh } });
    const result = applyCommand(project, command);
    const actual = result.tracks[0].clips[0].masks![0].matteSequence!;
    expect(actual).toEqual(fresh);
    expect(actual.stale).toBeUndefined();
    expect(actual).not.toHaveProperty("staleReason");
  });

  it("still permits consecutive ordinary brush-stale edits and their undo", () => {
    let project = timeStaleProject();
    project.tracks[0].clips[0].masks![0].matteSequence = matte();
    for (const strokes of [[stroke], [stroke, { ...stroke, id: "brush-2", frame: 1 }], [stroke]]) {
      project = applyCommand(project, editorCommandSchema.parse({ type: "update_clip_mask", clipId: "clip-demo", maskId: "time-stale", patch: { rotoCorrections: strokes, matteSequence: { ...matte(), stale: true } } }));
      expect(project.tracks[0].clips[0].masks![0].rotoCorrections).toEqual(strokes);
    }
  });

  it("clears the reason through the actual reanalysis action, receipt validator, reducer, and durable reopen", async () => {
    const session = createProjectSession(timeStaleProject());
    const fresh = matte("d");
    const result: AutoRotoDesktopResult = {
      schema: fresh.schema, engine: fresh.engine, width: fresh.width, height: fresh.height,
      analysisFps: fresh.analysisFps, initialFrame: 0, sequencePath: fresh.sequenceUri,
      manifestPath: fresh.manifestUri, sequenceSha256: fresh.sequenceSha256!, sequenceBytes: fresh.sequenceBytes!,
      frames: fresh.frameArtifactUris!.map((alphaPath, frame) => ({ frame, time: frame / fresh.analysisFps,
        alphaPath, previewUrl: fresh.framePreviewUris![frame], confidence: 1, foregroundRatio: .5,
        boundaryChatter: 0, previewSha256: "b".repeat(64), alphaFrameSha256: "c".repeat(64) })),
      meanBoundaryChatter: fresh.meanBoundaryChatter, correctionStrokesApplied: 0, correctedFrames: [],
      regionMemoryRouting: fresh.regionMemoryRouting!, alphaRefinement: fresh.alphaRefinement!, routeReceipt: fresh.routeReceipt!,
      frozen: true, qualityState: "diagnostic", analyzedSeconds: 12, elapsedMs: 1, cacheHit: false,
    };
    // Only the native analysis response is synthetic. This verifies integration
    // acceptance, not that these fixture digests belong to real alpha files.
    const analyze = vi.fn(async () => result);
    const onCommand = vi.fn((command: EditorCommand) => session.setHistory(history => dispatchCommand(history, editorCommandSchema.parse(command))));
    expect(await runAutoRotoAction({ projectSession: session, project: session.getSnapshot().history.present,
      clipId: "clip-demo", maskId: "time-stale", playhead: 0, analyze, busy: { current: false },
      onBusy: vi.fn(), onPlaying: vi.fn(), onStatus: vi.fn(), validateResult: autoRotoRuntimeStatusFromReceipt,
      onRuntimeStatus: vi.fn(), onCommand,
    })).toBe("applied");
    expect(onCommand).toHaveBeenCalledTimes(1);
    const project = session.getSnapshot().history.present;
    expect(project.tracks[0].clips[0].masks![0].matteSequence).not.toHaveProperty("staleReason");
    expect(project.tracks[0].clips[0].masks![0].matteSequence?.stale).toBeUndefined();
    const directory = await mkdtemp(join(tmpdir(), "editkin-time-stale-reanalyzed-"));
    const path = join(directory, "project.editkin.json");
    await writeProjectFileAtomic(path, project);
    const reopened = await readProjectFile(path);
    expect(reopened.tracks[0].clips[0].masks![0].matteSequence?.manifestUri).toBe(fresh.manifestUri);
    expect(reopened.tracks[0].clips[0].masks![0].matteSequence).not.toHaveProperty("staleReason");
    console.info(JSON.stringify({ evidence: "time-stale-reanalysis-roundtrip", path }));
  });
});

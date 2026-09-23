import { describe, expect, it } from "vitest";
import { createDemoProject } from "./demo";
import { createClipMask } from "./masks";
import type { EditProject, TimelineClip } from "./types";
import { dehydrateAutoRotoFramePreviews, hydrateAutoRotoFramePreviews } from "./autoRotoPreviewProjection";

function attachMatte(clip: TimelineClip, id: string, paths: string[]): void {
  const mask = createClipMask(id, "subject");
  mask.matteSequence = {
    schema: "editkin.auto-roto-matte/v1",
    engine: "editkin-native-color-temporal-roto/v1",
    width: 16,
    height: 16,
    analysisFps: 12,
    frameCount: paths.length,
    sequenceUri: `C:/cache/${id}/matte-sequence.alpha8`,
    manifestUri: `C:/cache/${id}/matte-manifest.json`,
    frameArtifactUris: paths,
    framePreviewUris: paths.map((path) => `asset://untrusted/${encodeURIComponent(path)}`),
    meanBoundaryChatter: .02,
    frozen: true,
    qualityState: "diagnostic",
  };
  clip.masks = [mask];
}

function fixture(): EditProject {
  const project = createDemoProject();
  attachMatte(project.tracks[0].clips[0], "root-roto", ["C:/cache/root/frame-000000.png"]);
  const nestedClip = structuredClone(project.tracks[0].clips[0]);
  nestedClip.id = "nested-clip";
  nestedClip.trackId = "nested-video";
  attachMatte(nestedClip, "nested-roto", ["C:/cache/nested/frame-000000.png"]);
  project.compositions.push({
    schema: "editkin.composition/v1",
    id: "nested-composition",
    name: "Nested",
    width: project.width,
    height: project.height,
    fps: project.fps,
    duration: nestedClip.duration,
    tracks: [{ id: "nested-video", name: "Nested video", kind: "video", locked: false, muted: false, clips: [nestedClip] }],
    captions: [],
    captionStyle: structuredClone(project.captionStyle),
    motionTracks: [],
    motionGraphics: [],
    director: structuredClone(project.director),
    updatedAt: project.updatedAt,
  });
  return project;
}

describe("Auto Roto preview projection", () => {
  it("lets the native boundary migrate a legacy project without compositions", () => {
    const legacy = fixture() as unknown as Partial<EditProject>;
    delete legacy.compositions;
    expect(() => dehydrateAutoRotoFramePreviews(legacy as EditProject)).not.toThrow();
  });
  it("removes every process-local preview URL from root and composition durable state", () => {
    const project = fixture();
    const durable = dehydrateAutoRotoFramePreviews(project);
    expect(durable.tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toBeUndefined();
    expect(durable.compositions[0].tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toBeUndefined();
    expect(durable.tracks[0].clips[0].masks![0].matteSequence?.frameArtifactUris).toEqual(["C:/cache/root/frame-000000.png"]);
    expect(project.tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris?.[0]).toMatch(/^asset:/);
  });

  it("hydrates only a complete native-host allowlist and never trusts persisted preview URLs", () => {
    const project = dehydrateAutoRotoFramePreviews(fixture());
    const root = "C:/cache/root/frame-000000.png";
    const nested = "C:/cache/nested/frame-000000.png";
    const hydrated = hydrateAutoRotoFramePreviews(project, [root, nested], (path) => `asset://verified/${path}`);
    expect(hydrated.tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toEqual([`asset://verified/${root}`]);
    expect(hydrated.compositions[0].tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toEqual([`asset://verified/${nested}`]);

    const partial = hydrateAutoRotoFramePreviews(project, [root], (path) => `asset://verified/${path}`);
    expect(partial.tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toEqual([`asset://verified/${root}`]);
    expect(partial.compositions[0].tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toBeUndefined();
  });

  it("never rehydrates wrong-time pixels even when another fresh clip admits the same artifact", () => {
    const project = fixture();
    const sequence = project.tracks[0].clips[0].masks![0].matteSequence!;
    sequence.stale = true;
    sequence.staleReason = "clip-time-range-changed";
    const original = structuredClone(project);
    const hydrated = hydrateAutoRotoFramePreviews(project, ["C:/cache/root/frame-000000.png", "C:/cache/nested/frame-000000.png"], path => `asset://verified/${path}`);
    const result = hydrated.tracks[0].clips[0].masks![0].matteSequence!;
    expect(result.framePreviewUris).toBeUndefined();
    expect(result.frameArtifactUris).toEqual(sequence.frameArtifactUris);
    expect(result.staleReason).toBe("clip-time-range-changed");
    expect(hydrated.compositions[0].tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toHaveLength(1);
    expect(project).toEqual(original);
  });

  it("retains ordinary brush-stale previews for additional corrections", () => {
    const project = fixture();
    project.tracks[0].clips[0].masks![0].matteSequence!.stale = true;
    const hydrated = hydrateAutoRotoFramePreviews(project, ["C:/cache/root/frame-000000.png"], path => `asset://verified/${path}`);
    expect(hydrated.tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toEqual(["asset://verified/C:/cache/root/frame-000000.png"]);
  });

  it("keeps the time-invalid reason through durable serialization for nested clips too", () => {
    const project = fixture();
    const nested = project.compositions[0].tracks[0].clips[0].masks![0].matteSequence!;
    nested.stale = true;
    nested.staleReason = "clip-time-range-changed";
    const reopened = JSON.parse(JSON.stringify(dehydrateAutoRotoFramePreviews(project))) as EditProject;
    const hydrated = hydrateAutoRotoFramePreviews(reopened, ["C:/cache/nested/frame-000000.png"], path => `asset://verified/${path}`);
    expect(hydrated.compositions[0].tracks[0].clips[0].masks![0].matteSequence).toMatchObject({ stale: true, staleReason: "clip-time-range-changed", frameArtifactUris: nested.frameArtifactUris });
    expect(hydrated.compositions[0].tracks[0].clips[0].masks![0].matteSequence?.framePreviewUris).toBeUndefined();
  });
});

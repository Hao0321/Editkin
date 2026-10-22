import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { referenceMotionInstanceSchema } from "../domain/referenceMotionInstance";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import type { MediaAsset } from "../domain/types";
import { verifyReferenceMotionSourceFilesForUi } from "./referenceMotionSourcePreparation";
import type { ReferenceMotionSourceReplacementRequest } from "../application/referenceMotionSourceReplacement";

function fixture() {
  const project = createDemoProject(), primary = project.tracks[0].clips[0]; primary.duration = 8; project.assets[0].duration = 30;
  const next: MediaAsset = { ...structuredClone(project.assets[0]), id: "new", uri: "D:/synthetic/new.mp4", displayAspectRatio: 16 / 9 };
  project.assets.push(next);
  const instance = referenceMotionInstanceSchema.parse({ schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2,
    instanceRevision: 1, input: { templateId: "level_bridge", clipId: primary.id, startFrame: 0, durationFrames: 240, title: "Title", sources: [],
      style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE), intent: "shortform", purpose: "Synthetic ingress test", evidenceRefs: ["old"] },
    frameFormat: { width: project.width, height: project.height, fps: project.fps }, primaryBefore: { layout: null }, roles: [{ key: "heading", kind: "graphic", id: "synthetic-heading" }],
    dependencies: { recipeVersion: "synthetic", fonts: [], presetHashes: [] }, appliedScopeSha256: "1".repeat(64) });
  project.referenceMotionInstances = [instance];
  const request: ReferenceMotionSourceReplacementRequest = { instanceId: "owner", expectedProjectRevision: project.revision, expectedInstanceRevision: 1,
    primary: { assetId: "new", sourceStart: 1 }, audio: { primary: "keep_level", extra: [] }, focusRegion: null, textRegion: null, evidenceRefs: ["fresh"] };
  const api = { importMediaPaths: vi.fn(async () => [{ asset: structuredClone(next), previewUrl: "preview:new" }]),
    prepareMedia: vi.fn(async () => ({ assetId: next.id, derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-12T00:00:00.000Z" },
      runtimeUrls: { [next.id]: "preview:prepared" }, cacheHit: false })) };
  return { project, request, next, api };
}
describe("source ingress disk checks using controlled API responses, not real-file acceptance", () => {
  it("probes a changed unpinned imported asset cheaply without mutating the project", async () => {
    const f = fixture(), original = structuredClone(f.project);
    const checked = await verifyReferenceMotionSourceFilesForUi(f.project, f.request, undefined, f.api);
    expect(f.api.importMediaPaths).toHaveBeenCalledWith([f.next.uri]); expect(f.api.prepareMedia).not.toHaveBeenCalled();
    expect(checked.preparedMedia).toEqual([]); expect(f.project).toEqual(original);
  });
  it("prepares a draft import but leaves it outside the graph until a final compiler batch", async () => {
    const f = fixture(); f.project.assets.pop(); const picked = { asset: f.next, previewUrl: "preview:pick" };
    const checked = await verifyReferenceMotionSourceFilesForUi(f.project, f.request, picked, f.api);
    expect(checked.incoming?.derivatives?.sourceSha256).toBe("a".repeat(64)); expect(checked.pickedMedia).toHaveLength(1);
    expect(f.project.assets.some(asset => asset.id === "new")).toBe(false);
  });
  it("rejects a replaced file's dimensions or a changed pinned byte hash", async () => {
    const f = fixture(); f.api.importMediaPaths.mockResolvedValue([{ asset: { ...f.next, width: 900 }, previewUrl: "preview" }]);
    await expect(verifyReferenceMotionSourceFilesForUi(f.project, f.request, undefined, f.api)).rejects.toThrow("匯入時不同");
    f.api.importMediaPaths.mockResolvedValue([{ asset: f.next, previewUrl: "preview" }]);
    f.next.derivatives = { sourceSha256: "b".repeat(64), generatedAt: "2026-10-12T00:00:00.000Z" };
    await expect(verifyReferenceMotionSourceFilesForUi(f.project, f.request, undefined, f.api)).rejects.toThrow("匯入時不同");
  });
  it("honours cancellation and live project drift while a native probe is pending", async () => {
    for (const action of ["cancel", "drift"] as const) {
      const f = fixture(), controller = new AbortController();
      f.api.importMediaPaths.mockImplementation(async () => { if (action === "cancel") controller.abort(); else f.project.updatedAt = "changed"; return [{ asset: f.next, previewUrl: "preview" }]; });
      await expect(verifyReferenceMotionSourceFilesForUi(f.project, f.request, undefined, f.api, controller.signal)).rejects.toThrow();
      expect(f.api.prepareMedia).not.toHaveBeenCalled();
    }
  });
});

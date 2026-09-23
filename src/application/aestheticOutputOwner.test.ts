import { describe, expect, it } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { createDemoProject } from "../domain/demo";
import { renderReviewContentJson } from "../shared/renderReviewContent";
import { createAestheticOutputOwner } from "./aestheticOutputOwner";
import { resolveAestheticSystem } from "./editkinAesthetic";
import type { EditProject } from "../domain/types";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
function artifact(project: EditProject) {
  return { schema: "editkin.render-artifact-identity/v1", outputSha256: "a".repeat(64), bytes: 40000, fps: 30, durationFrames: 30,
    projectContentSha256: createHash("sha256").update(renderReviewContentJson(project)).digest("hex") };
}
describe("aesthetic output owner, not certification", () => {
  it("binds renderer content, tolerates review/save metadata, and returns defensive copies", async () => {
    const owner = createAestheticOutputOwner(subtle); const project = createDemoProject();
    project.aestheticSystem = resolveAestheticSystem("gaming");
    const receipt = artifact(project);
    expect(await owner.bind(project, receipt)).toBe(true);
    project.aestheticSystem.review.score = 99; project.director.updatedAt = "changed"; project.revision++; project.updatedAt = "changed";
    expect(owner.get(project)?.outputSha256).toBe(receipt.outputSha256);
    receipt.outputSha256 = "b".repeat(64);
    const copy = owner.get(project)!; copy.outputSha256 = "c".repeat(64);
    expect(owner.get(project)?.outputSha256).toBe("a".repeat(64));
  });
  it("invalidates when captions, tracks, source or Motion content change", async () => {
    const project = createDemoProject(); const owner = createAestheticOutputOwner(subtle);
    await owner.bind(project, artifact(project));
    for (const change of [
      (p: EditProject) => { p.captionStyle.color = "#ff0000"; },
      (p: EditProject) => { p.tracks[0].clips[0].duration -= 1; },
      (p: EditProject) => { p.assets[0].uri = "other.mp4"; },
      (p: EditProject) => { p.motionGraphics = []; p.motionTracks = []; p.tracks[0].clips[0].transform.opacity = .4; },
    ]) { const next = structuredClone(project); change(next); expect(owner.get(next)).toBeUndefined(); }
    owner.reset(); expect(owner.get(structuredClone(project))).toBeUndefined();
  });
  it("rejects malformed receipts, wrong project hashes and bare review artifacts", async () => {
    const project = createDemoProject(); const owner = createAestheticOutputOwner(subtle);
    for (const patch of [{ bytes: 0 }, { fps: Infinity }, { fps: 0 }, { durationFrames: 1.5 }, { outputSha256: "invalid" }, { projectContentSha256: "b".repeat(64) }, { schema: "wrong" }]) {
      expect(await owner.bind(project, { ...artifact(project), ...patch })).toBe(false);
      expect(owner.get(project)).toBeUndefined();
    }
    expect(await owner.bind(project, { outputSha256: "a".repeat(64), fps:30,durationFrames:30 })).toBe(false);
  });
  it("discards late bind completions and reset-in-flight results", async () => {
    const waits: { data: BufferSource; resolve: (value: ArrayBuffer) => void }[] = [];
    const owner = createAestheticOutputOwner({ digest: (_algorithm, data) => new Promise<ArrayBuffer>(resolve => waits.push({ data, resolve })) });
    const project = createDemoProject(); const newer = structuredClone(project); newer.name = "new content";
    const first = owner.bind(project, artifact(project)); const second = owner.bind(newer, artifact(newer));
    waits[1].resolve(await subtle.digest("SHA-256", waits[1].data)); expect(await second).toBe(true);
    waits[0].resolve(await subtle.digest("SHA-256", waits[0].data)); expect(await first).toBe(false);
    expect(owner.get(newer)).toBeDefined(); expect(owner.get(project)).toBeUndefined();
    const third = owner.bind(newer, artifact(newer)); owner.reset();
    waits[2].resolve(await subtle.digest("SHA-256", waits[2].data)); expect(await third).toBe(false);
    expect(owner.get(newer)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createClipMask } from "../domain/masks";
import { buildEngineRenderGraph } from "./engineGraph";

// Graph-admission fixtures only. No file, runtime receipt or matte quality claim.
function fixture(stale = true) {
  const project = createDemoProject();
  const clip = project.tracks[0].clips[0];
  const mask = createClipMask("roto-fixture", "subject");
  mask.matteSequence = {
    schema: "editkin.auto-roto-matte/v1", engine: "editkin-native-color-temporal-roto/v1",
    width: 16, height: 16, analysisFps: 12, frameCount: 144,
    sequenceUri: "C:/fixture-only/matte.alpha8", manifestUri: "C:/fixture-only/matte.json",
    meanBoundaryChatter: 0, stale, frozen: true, qualityState: "diagnostic",
  };
  clip.masks = [mask];
  return { project, clip, mask };
}

describe("EngineGraph stale-matte admission (no native execution)", () => {
  it.each(["content", "adjustment", "controller"] as const)("rejects enabled stale matte before the %s branch can omit it", role => {
    const { project, clip } = fixture();
    clip.layer = { enabled: true, role, blendMode: "normal" };
    const original = structuredClone(project);
    expect(() => buildEngineRenderGraph(project)).toThrow(/roto-fixture.*已過期/);
    expect(project).toEqual(original);
  });

  it("rejects stale matte even when a later valid matte is present", () => {
    const { project, clip } = fixture();
    const fresh = fixture(false).mask;
    fresh.id = "fresh-second";
    clip.masks!.push(fresh);
    expect(() => buildEngineRenderGraph(project)).toThrow(/roto-fixture.*已過期/);
  });

  it("allows explicitly disabled stale masks without emitting their nodes", () => {
    const { project, mask } = fixture();
    mask.enabled = false;
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.some(node => node.kind === "mask")).toBe(false);
    expect(graph.nodes.some(node => node.id === "output:main")).toBe(true);
  });

  it("does not block a muted track because of its inactive stale matte", () => {
    const { project } = fixture();
    project.tracks[0].muted = true;
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.some(node => node.kind === "mask")).toBe(false);
    expect(graph.nodes.some(node => node.id === "source:transparent")).toBe(true);
  });

  it("does not block an explicitly disabled layer because of its inactive stale matte", () => {
    const { project, clip } = fixture();
    clip.layer = { enabled: false, role: "content", blendMode: "normal" };
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes.some(node => node.kind === "mask")).toBe(false);
    expect(graph.nodes.find(node => node.id === "transform:clip-demo")?.enabled).toBe(false);
  });

  it.each([false, true])("preserves existing fresh matte graph binding (inverted %s)", inverted => {
    const { project, mask } = fixture(false);
    mask.inverted = inverted;
    const graph = buildEngineRenderGraph(project);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      kind: "mask", matteId: mask.matteSequence!.manifestUri,
      matteMode: inverted ? "alpha_inverted" : "alpha",
    }));
  });
});

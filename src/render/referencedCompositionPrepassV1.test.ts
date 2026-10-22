import { describe, expect, it } from "vitest";
import { validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER } from "../domain/types";
import { addCompositionFixtureV1, referencedCompositionProjectFixtureV1 } from "./referencedCompositionPrepassV1.fixture";
import { selectReferencedCompositionsForRenderV1 } from "./referencedCompositionPrepassV1";

describe("referenced composition prepasses, synthetic metadata", () => {
  it("keeps the transitive shared dependencies in declaration order and skips an unreferenced chain", () => {
    const project = referencedCompositionProjectFixtureV1();
    addCompositionFixtureV1(project, "parent", "asset:used");
    const sibling = addCompositionFixtureV1(project, "sibling", "asset:used");
    const second = structuredClone(sibling.tracks[0].clips[0]);
    Object.assign(second, { id: "root-sibling", trackId: project.tracks[0].id, assetId: "asset:sibling", timelineStart: 1 });
    project.tracks[0].clips.push(second);
    project.tracks[0].clips[0].assetId = "asset:parent";
    addCompositionFixtureV1(project, "unused-parent", "asset:unused");
    project.compositions.reverse();
    validateProject(project);
    const snapshot = structuredClone(project);
    const selected = selectReferencedCompositionsForRenderV1(project);
    expect(selected.compositions.map(composition => composition.id)).toEqual(["sibling", "parent", "used"]);
    expect(project).toEqual(snapshot);
    expect(selected.assets).toBe(project.assets);
    expect(selected.tracks).toBe(project.tracks);
  });

  it("conservatively retains references on hidden, muted and disabled clips", () => {
    const project = referencedCompositionProjectFixtureV1();
    project.tracks[0].hidden = true; project.tracks[0].muted = true;
    project.tracks[0].clips[0].layer = { ...DEFAULT_CLIP_LAYER, enabled: false };
    expect(selectReferencedCompositionsForRenderV1(project).compositions.map(composition => composition.id)).toEqual(["used"]);
  });

  it("creates an empty work view when the timeline references no composition, without editing author data", () => {
    const project = referencedCompositionProjectFixtureV1();
    project.tracks[0].clips[0].assetId = project.assets[0].id;
    const snapshot = JSON.stringify(project);
    expect(selectReferencedCompositionsForRenderV1(project).compositions).toEqual([]);
    expect(JSON.stringify(project)).toBe(snapshot);
  });

  it("does not loop on a cycle and refuses a missing reachable composition; full validation retains cycle authority", () => {
    const project = referencedCompositionProjectFixtureV1();
    project.compositions[0].tracks[0].clips[0].assetId = "asset:used";
    expect(selectReferencedCompositionsForRenderV1(project).compositions.map(composition => composition.id)).toEqual(["used"]);
    expect(() => validateProject(project)).toThrow(/環狀/);
    project.assets.find(asset => asset.id === "asset:used")!.compositionId = "missing";
    expect(() => selectReferencedCompositionsForRenderV1(project)).toThrow("找不到預合成：missing");
  });
});

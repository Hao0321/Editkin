import { describe, expect, it } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { DEFAULT_CLIP_LAYER } from "../domain/types";
import { renderReviewContentJson } from "./renderReviewContent";

describe("render-equivalent default normalization", () => {
  it("equates missing clip defaults and the actual command-normalized defaults", () => {
    const project = createDemoProject();
    const next = applyCommand(project, { type: "set_director_review_state", reviewState: "reviewing" });
    expect(project.tracks[0].clips[0].layer).toBeUndefined();
    expect(next.tracks[0].clips[0].layer).toEqual(DEFAULT_CLIP_LAYER);
    expect(renderReviewContentJson(next)).toBe(renderReviewContentJson(project));
    expect(project.tracks[0].clips[0].expressions).toBeUndefined();
  });
  it("does not hide actual enabled/blending/role or expression changes", () => {
    const project = createDemoProject(); const baseline = renderReviewContentJson(project);
    for (const layer of [{ ...DEFAULT_CLIP_LAYER, enabled: false }, { ...DEFAULT_CLIP_LAYER, blendMode: "screen" as const }, { ...DEFAULT_CLIP_LAYER, role: "controller" as const }]) {
      const changed = structuredClone(project); changed.tracks[0].clips[0].layer = layer;
      expect(renderReviewContentJson(changed)).not.toBe(baseline);
    }
    const changed = structuredClone(project); changed.tracks[0].clips[0].expressions = { opacity: "hao.expression/v1:0.5" };
    expect(renderReviewContentJson(changed)).not.toBe(baseline);
  });
});

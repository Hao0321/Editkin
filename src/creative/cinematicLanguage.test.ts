import { describe, expect, it } from "vitest";
import { BULLET_TIME_CAPABILITIES, CINEMATIC_LANGUAGE_RECIPES, compactCinematicLanguageIndex, resolveCinematicRecipe } from "./cinematicLanguage";

describe("cinematic language registry", () => {
  it("keeps eleven original recipes unique, low-token routable, and exposes exactly one bounded compiler", () => {
    expect(CINEMATIC_LANGUAGE_RECIPES).toHaveLength(11);
    expect(new Set(CINEMATIC_LANGUAGE_RECIPES.map((item) => item.id)).size).toBe(11);
    expect(CINEMATIC_LANGUAGE_RECIPES.every((item) => item.operations.length >= 4 && item.tokenContract === "recipe_id_plus_evidence_refs")).toBe(true);
    expect(CINEMATIC_LANGUAGE_RECIPES.filter((item) => item.executionStatus === "planning_only")).toHaveLength(10);
    expect(CINEMATIC_LANGUAGE_RECIPES.filter((item) => item.executionStatus === "evidence_compilable")).toEqual([
      expect.objectContaining({ id: "beat_aligned_montage", compilerTool: "compile_beat_montage" }),
    ]);
    expect(CINEMATIC_LANGUAGE_RECIPES.find((item) => item.id === "rhythmic_crescendo")).toMatchObject({ executionStatus: "planning_only" });
    expect(compactCinematicLanguageIndex().recipes.every((item) => !Object.hasOwn(item, "operations"))).toBe(true);
    expect(compactCinematicLanguageIndex().recipes.filter((item) => Object.hasOwn(item, "compilerTool"))).toEqual([
      expect.objectContaining({ id: "beat_aligned_montage", compilerTool: "compile_beat_montage" }),
    ]);
  });

  it("fails closed or selects a declared planning fallback from explicit evidence", () => {
    expect(resolveCinematicRecipe("time_sculpt", [])).toMatchObject({ status: "BLOCKED", selectedId: null, executionStatus: "planning_only" });
    expect(resolveCinematicRecipe("time_sculpt", ["frame_rate_metadata", "motion_quality_analysis"])).toMatchObject({ status: "DRAFT_PLAN_CANDIDATE", selectedId: "time_sculpt", evidenceAuthority: "caller_asserted_unverified" });
    expect(resolveCinematicRecipe("beat_aligned_montage", [])).toMatchObject({ status: "BLOCKED", executionStatus: "evidence_compilable", compilerTool: "compile_beat_montage", directApplyAllowed: false });
    expect(resolveCinematicRecipe("beat_aligned_montage", ["shot_evidence", "caller_beat_grid"])).toMatchObject({ status: "DRAFT_COMPILER_CANDIDATE", executionStatus: "evidence_compilable", compilerTool: "compile_beat_montage", directApplyAllowed: false, evidenceAuthority: "caller_asserted_unverified" });
    expect(() => resolveCinematicRecipe("invented", [])).toThrow(/找不到鏡頭語言 recipe/);
  });

  it("labels every bullet-time tier honestly instead of pretending simulation is capture", () => {
    expect(BULLET_TIME_CAPABILITIES.map((item) => item.status)).toEqual(["prototype", "research", "capture_required"]);
    expect(BULLET_TIME_CAPABILITIES[0].honestLabel).toContain("非真實新視角");
    expect(BULLET_TIME_CAPABILITIES.every((item) => item.requirements.length >= 4 && item.forbiddenClaim)).toBe(true);
  });
});

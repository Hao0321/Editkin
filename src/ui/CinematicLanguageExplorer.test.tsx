import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BULLET_TIME_CAPABILITIES, CINEMATIC_LANGUAGE_RECIPES } from "../creative/cinematicLanguage";
import { initializeStudioCreativeAssets } from "../creative/studioAssets";
import { initializeWave2Registry } from "../creative/wave2Registry";
import { CinematicLanguageExplorer, cinematicExplorerItems } from "./CinematicLanguageExplorer";

initializeStudioCreativeAssets();
initializeWave2Registry();

describe("cinematic language explorer", () => {
  it("keeps camera language, montage and bullet-time discoverable without mixing their capability boundaries", () => {
    expect(cinematicExplorerItems("language")).toHaveLength(8);
    expect(cinematicExplorerItems("montage")).toHaveLength(3);
    expect(cinematicExplorerItems("bullet-time")).toHaveLength(3);
    expect([...cinematicExplorerItems("language"), ...cinematicExplorerItems("montage")]).toHaveLength(CINEMATIC_LANGUAGE_RECIPES.length);
    expect(cinematicExplorerItems("bullet-time")).toEqual(BULLET_TIME_CAPABILITIES);
  });

  it("exposes one evidence compiler while keeping every other recipe and bullet-time tier planning-only", () => {
    const planningRecipes = CINEMATIC_LANGUAGE_RECIPES.filter((recipe) => recipe.executionStatus === "planning_only");
    const compilableRecipes = CINEMATIC_LANGUAGE_RECIPES.filter((recipe) => recipe.executionStatus === "evidence_compilable");
    const everyBulletTimeTierNeedsEvidence = BULLET_TIME_CAPABILITIES.every((capability) => capability.executionStatus === "planning_only" && capability.requirements.length > 0 && capability.honestLabel.length > 0);
    expect(planningRecipes).toHaveLength(10);
    expect(compilableRecipes).toEqual([expect.objectContaining({ id: "beat_aligned_montage", compilerTool: "compile_beat_montage", requirements: ["shot_evidence", "caller_beat_grid"] })]);
    expect(CINEMATIC_LANGUAGE_RECIPES.find((recipe) => recipe.id === "rhythmic_crescendo")?.executionStatus).toBe("planning_only");
    expect(everyBulletTimeTierNeedsEvidence).toBe(true);
  });

  it("renders the three user-facing execution states and all advanced categories", () => {
    const html = renderToStaticMarkup(<CinematicLanguageExplorer />);
    expect(html).toContain("可直接套用");
    expect(html).toContain("僅規劃");
    expect(html).toContain("需素材證據");
    expect(html).toContain("條件通過可編譯");
    expect(html).toContain("只產生唯讀 draft command");
    expect(html).toContain("data-compiler-tool=\"compile_beat_montage\"");
    expect(html).toContain("鏡頭語言");
    expect(html).toContain("蒙太奇");
    expect(html).toContain("子彈時間");
    expect(html).toContain("30 款濾鏡");
    expect(html).toContain("52 款片段入／出場");
    expect(html).toContain("不冒充已重剪");
    expect(html).not.toContain("立即生成子彈時間");
    expect(html.slice(html.indexOf("cinematic-recipe-list"))).not.toContain("<button");
  });
});

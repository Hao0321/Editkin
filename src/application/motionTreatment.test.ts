import { describe, expect, it } from "vitest";
import { createAutopilotV4Fixture } from "./autopilotPlanFixture";
import { autopilotPlanCoverage, compactAutopilotContract, parseAutopilotPlan } from "./autopilotPlan";
import { MOTION_TREATMENT_FAMILIES, motionTreatmentSchema, type MotionTreatment } from "./motionTreatment";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";

function fixture() {
  const plan = createAutopilotV4Fixture();
  const graphic = createMotionGraphic("motion-title", "title", "清楚的承諾", 0, 2, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
  const treatment: MotionTreatment = { schema: "editkin.motion-treatment/v1", decisions: MOTION_TREATMENT_FAMILIES.map(family => ({
    family, action: family === "title" || family === "motion" ? "use" : "omit",
    reason: family === "title" || family === "motion" ? "以可編輯主標呈現此節拍的承諾" : "這個測試只驗證主標，不為展示功能加入裝飾",
    beatIds: ["promise"], commandIndexes: family === "title" || family === "motion" ? [2] : [],
  })) };
  return { ...plan, editorial: { ...plan.editorial, motionTreatment: treatment, graphics: [{ id: graphic.id, presetId: graphic.presetId!, range: { startFrame: 0, endFrame: 60 }, kind: "title_card", purpose: "stakes", message: graphic.text, evidenceRefs: ["material:opening"] }] }, commands: [...plan.commands, { type: "add_motion_graphic", graphic }] };
}

describe("Editkin Motion treatment in the existing v4 workflow", () => {
  it("names the existing engine and exposes all ten planning families without competitor claims", () => {
    expect(compactAutopilotContract().motion).toMatchObject({ name: "Editkin Motion", comparisonStatus: "unmeasured", discover: "list_creative_presets", families: MOTION_TREATMENT_FAMILIES });
  });
  it("requires exact family coverage without requiring every family to be used", () => {
    const plan = parseAutopilotPlan(fixture());
    const coverage = autopilotPlanCoverage(plan);
    expect(coverage.motionTreatment?.state).toBe("DECLARED_COMMAND_COVERAGE");
    expect(coverage.motionTreatment?.families.filter(row => row.action === "omit")).toHaveLength(8);
    expect(coverage.motionTreatment?.boundary).toContain("not pixel execution");
  });
  it("preserves older v4 readability but never calls missing treatment complete", () => {
    expect(autopilotPlanCoverage(parseAutopilotPlan(createAutopilotV4Fixture())).motionTreatment?.state).toBe("REVIEW_REQUIRED");
  });
  it("rejects duplicate/missing families, blank reasons and phantom command links", () => {
    const plan = fixture();
    const missing = structuredClone(plan.editorial.motionTreatment); missing.decisions.pop();
    expect(motionTreatmentSchema.safeParse(missing).success).toBe(false);
    const duplicate = structuredClone(plan.editorial.motionTreatment); duplicate.decisions[1] = duplicate.decisions[0];
    expect(motionTreatmentSchema.safeParse(duplicate).success).toBe(false);
    const blank = fixture(); blank.editorial.motionTreatment.decisions[0].reason = " ";
    expect(() => parseAutopilotPlan(blank)).toThrow();
    const wrong = fixture(); wrong.editorial.motionTreatment.decisions[0].commandIndexes = [0];
    expect(() => parseAutopilotPlan(wrong)).toThrow(/命令綁定/);
  });
  it("rejects unknown beats and effects hidden behind an omit decision", () => {
    const unknown = fixture(); unknown.editorial.motionTreatment.decisions[0].beatIds = ["invented"];
    expect(() => parseAutopilotPlan(unknown)).toThrow(/不存在/);
    const hidden = fixture(); hidden.editorial.motionTreatment.decisions[0].action = "omit"; hidden.editorial.motionTreatment.decisions[0].commandIndexes = [];
    expect(() => parseAutopilotPlan(hidden)).toThrow(/未交代用途/);
  });
});

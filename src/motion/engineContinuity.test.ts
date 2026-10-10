import { describe, expect, it } from "vitest";
import { compactAutopilotContract } from "../application/autopilotPlan";
import { floatingVideoFramePresetV2 } from "./floatingVideoFrame";
import { EDITKIN_MOTION } from "./identity";
import { EDITKIN_ENGINE_CONTINUITY, parseEngineContinuity } from "./engineContinuity";

function currentDeclaration() {
  return {
    schema: "editkin.engine-continuity/v1", engineId: "editkin-motion", commonBase: "editkin.scene-glyph-spring/v1",
    projectSchemas: [9, 10], motionSchemas: ["hao.motion-composition/v1", "hao.motion-composition/v2", "editkin.motion-scene-2d/v1"],
    textPreparation: "physical-glyph-binary/v1", templateAuthoring: "async-generation2",
    floatingFrame: { schema: "editkin.floating-video-frame/v2", mediaFit: "contain", clock: "integer_project_frames", geometry: "upright_display_aspect_ratio" },
    planSchema: "hao.video-autopilot.edit-plan/v4", visualReviewPolicyBound: true,
    originalSource: { schema: "editkin.original-motion-source/v1", sameProcessCommit: true },
  };
}

describe("current engine continuity declaration", () => {
  it("publishes the exact current compatibility floor through the actual compact contract", () => {
    const contract = compactAutopilotContract();
    expect(contract.engineContinuity).toEqual(currentDeclaration());
    expect(contract.engineContinuity).toBe(EDITKIN_ENGINE_CONTINUITY);
    expect(contract.engineContinuity.engineId).toBe(contract.motion.id);
    expect(contract.engineContinuity.commonBase).toBe(contract.motion.commonBase);
    expect(contract.engineContinuity.motionSchemas).toEqual(EDITKIN_MOTION.schemas);
    expect(contract.engineContinuity.planSchema).toBe(contract.planSchema);
    expect(contract.engineContinuity.visualReviewPolicyBound).toBe(contract.visualReview.policyBound);
    expect(contract.engineContinuity.originalSource.schema).toBe(contract.originalSourceExecution.schema);
    expect(contract.originalSourceExecution.commitAuthentication).toBe("protected_user");
    expect(contract.engineContinuity.floatingFrame.schema).toBe(floatingVideoFramePresetV2("matte").schema);
    expect(contract.engineContinuity.floatingFrame.mediaFit).toBe(floatingVideoFramePresetV2("matte").mediaFit);
    expect(contract.engineContinuity).not.toHaveProperty("artworkAccepted");
    expect(contract.engineContinuity).not.toHaveProperty("nativeAccepted");
  });

  it("admits the established schema9 floor without requiring schema10 instance support", () => {
    const raw = currentDeclaration(); raw.projectSchemas = [9];
    raw.motionSchemas = ["hao.motion-composition/v2", "editkin.motion-scene-2d/v1"];
    expect(parseEngineContinuity(raw).projectSchemas).toEqual([9]);
  });

  it("owns and freezes every mutable declaration branch before a run can pin it", () => {
    const raw = currentDeclaration();
    const parsed = parseEngineContinuity(raw);
    raw.projectSchemas.push(8); raw.motionSchemas.pop();
    raw.floatingFrame.clock = "seconds"; raw.originalSource.sameProcessCommit = false;
    expect(parsed).toEqual(currentDeclaration());
    expect(parsed).not.toBe(raw);
    for (const branch of [parsed, parsed.projectSchemas, parsed.motionSchemas, parsed.floatingFrame, parsed.originalSource]) {
      expect(Object.isFrozen(branch)).toBe(true);
    }
  });

  it("rejects missing or estimated glyph preparation instead of a legacy fallback", () => {
    const raw = currentDeclaration();
    const { textPreparation: _discarded, ...missing } = raw;
    expect(() => parseEngineContinuity(missing)).toThrow();
    expect(() => parseEngineContinuity({ ...raw, textPreparation: "estimated-font-metrics" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, textPreparation: true })).toThrow();
  });

  it("rejects missing or synchronous generation1 authoring", () => {
    const raw = currentDeclaration();
    const { templateAuthoring: _discarded, ...missing } = raw;
    expect(() => parseEngineContinuity(missing)).toThrow();
    expect(() => parseEngineContinuity({ ...raw, templateAuthoring: "sync-generation1" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, templateAuthoring: 2 })).toThrow();
  });

  it("rejects floating v1 cover seconds or encoded-ratio declarations", () => {
    const raw = currentDeclaration();
    expect(() => parseEngineContinuity({ ...raw, floatingFrame: { ...raw.floatingFrame, schema: "editkin.floating-video-frame/v1" } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, floatingFrame: { ...raw.floatingFrame, mediaFit: "cover" } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, floatingFrame: { ...raw.floatingFrame, clock: "seconds" } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, floatingFrame: { ...raw.floatingFrame, geometry: "encoded_width_height" } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, floatingFrame: false })).toThrow();
  });

  it("rejects schema8 schema10-only duplicated and oversized project schema lists", () => {
    const raw = currentDeclaration();
    for (const projectSchemas of [[8], [10], [9, 9], [9, 10, 9], ["9"], []]) {
      expect(() => parseEngineContinuity({ ...raw, projectSchemas })).toThrow();
    }
  });

  it("rejects missing required motion schemas and unknown or duplicated motion identities", () => {
    const raw = currentDeclaration();
    for (const motionSchemas of [["hao.motion-composition/v1"], ["hao.motion-composition/v1", "hao.motion-composition/v2"],
      ["hao.motion-composition/v1", "editkin.motion-scene-2d/v1"], ["hao.motion-composition/v2", "editkin.motion-scene-2d/v1", "legacy-engine"],
      ["hao.motion-composition/v2", "editkin.motion-scene-2d/v1", "hao.motion-composition/v2"]]) {
      expect(() => parseEngineContinuity({ ...raw, motionSchemas })).toThrow();
    }
  });

  it("rejects unknown fields at the root and both nested capability boundaries", () => {
    const raw = currentDeclaration();
    expect(() => parseEngineContinuity({ ...raw, artworkAccepted: true })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, floatingFrame: { ...raw.floatingFrame, nativeAccepted: true } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, originalSource: { ...raw.originalSource, callerProof: "GREEN" } })).toThrow();
  });

  it("rejects engine v4 review and original-source downgrades or type-confused flags", () => {
    const raw = currentDeclaration();
    expect(() => parseEngineContinuity({ ...raw, schema: "editkin.engine-continuity/v0" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, engineId: "old-motion" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, commonBase: "flat-card/v1" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, planSchema: "hao.video-autopilot.edit-plan/v3" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, visualReviewPolicyBound: "true" })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, visualReviewPolicyBound: false })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, originalSource: { ...raw.originalSource, schema: "caller-motion/v1" } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, originalSource: { ...raw.originalSource, sameProcessCommit: "true" } })).toThrow();
    expect(() => parseEngineContinuity({ ...raw, originalSource: { ...raw.originalSource, sameProcessCommit: false } })).toThrow();
  });
});

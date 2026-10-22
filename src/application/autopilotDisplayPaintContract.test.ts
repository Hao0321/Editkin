import { expect, it } from "vitest";
import { compactAutopilotContract } from "./autopilotPlan";
import { ORIGINAL_MOTION_DISPLAY_PAINT_CAPABILITY } from "./originalMotionScene2d";

it("exposes conditional current display paint source scope without claiming installed or native product acceptance", () => {
  const contract = compactAutopilotContract();
  expect(contract.originalSourceExecution.nativeDisplayPaintV2).toEqual(ORIGINAL_MOTION_DISPLAY_PAINT_CAPABILITY);
  expect(contract.originalSourceExecution.nativeDisplayPaintV2).toMatchObject({
    paintSchema: "editkin.motion-paint/v2", colorIntent: "display_rec709_sdr", scope: "authored_overlay_flat_2d",
    compositionBoundary: "after_aces2_before_output_encoding", maxProjectGraphics: 4,
    matchingNativeRuntimeRequired: true, sourceAdmissionOnly: true, installedOrFullProductCertified: false,
  });
  expect(contract.planSchema).toBe("hao.video-autopilot.edit-plan/v4");
  expect(contract.engineContinuity.templateAuthoring).toBe("async-generation2");
  expect(Object.isFrozen(contract.originalSourceExecution.nativeDisplayPaintV2)).toBe(true);
});

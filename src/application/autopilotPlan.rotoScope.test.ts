import { describe, expect, it } from "vitest";
import type { EditorCommand } from "../domain/commands";
import { createClipMask } from "../domain/masks";
import { rotoKeyerScopedCommands, type AutopilotPlan } from "./autopilotPlan";
import { assertRotoKeyerPlanCommandBinding } from "./rotoKeyerAutopilot";

// A design template places footage in a rounded window: its own compilation carries an add_clip_mask. v4 audit and apply
// recompile a declared reference instance and compare it exactly, so that mask is template geometry, not an alpha decision.
const mask = (clipId: string, id: string): EditorCommand => ({ type: "add_clip_mask", clipId, mask: { ...createClipMask(id, "polygon"), name: "影片窗柔和圓角" } });
const instance = { type: "upsert_reference_motion_instance", instance: { id: "reference-motion-instance-a", instanceRevision: 1 } } as unknown as EditorCommand;
const declaration = { schema: "editkin.reference-motion-plan/v1", instances: [{ instanceId: "reference-motion-instance-a", mode: "create", commandIndexes: [1, 2] }] };
const planWith = (commands: EditorCommand[]) => ({ commands, referenceMotion: declaration }) as unknown as AutopilotPlan;
const style: EditorCommand = { type: "set_aesthetic_system", aestheticSystem: {} } as unknown as EditorCommand;

describe("roto/keyer evidence scope", () => {
  it("leaves a declared template's own window mask to the template's exact recompile", () => {
    const plan = planWith([style, mask("clip-a", "motion-edge-1"), instance]);
    const scoped = rotoKeyerScopedCommands(plan);
    expect(scoped).toEqual([style]);
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, scoped, "review_required", 4096)).not.toThrow();
  });

  it("still requires roto-keyer evidence for an alpha command outside the template range", () => {
    const plan = planWith([style, mask("clip-a", "motion-edge-1"), instance, mask("clip-b", "author-mask")]);
    expect(rotoKeyerScopedCommands(plan)).toEqual([style, mask("clip-b", "author-mask")]);
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, rotoKeyerScopedCommands(plan), "review_required", 4096))
      .toThrow(/roto-keyer-plan/);
  });

  it("scopes nothing away without a reference declaration", () => {
    const plan = { commands: [mask("clip-a", "motion-edge-1")] } as unknown as AutopilotPlan;
    expect(() => assertRotoKeyerPlanCommandBinding(undefined, rotoKeyerScopedCommands(plan), "review_required", 4096)).toThrow(/roto-keyer-plan/);
  });
});

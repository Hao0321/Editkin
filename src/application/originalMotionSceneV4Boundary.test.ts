import { describe, expect, it } from "vitest";
import type { EditorCommand } from "../domain/commandTypes";
import { assertOriginalMotionSceneV4Boundary } from "./originalMotionSceneV4Boundary";

describe("original scene canonical v4 source boundary", () => {
  it("does not change existing ordinary command admission", () => {
    expect(() => assertOriginalMotionSceneV4Boundary([{ type: "delete_motion_graphic", graphicId: "ordinary" }])).not.toThrow();
  });
  it("refuses source-unadmitted standalone scene creation or revision", () => {
    for (const type of ["add_motion_scene", "update_motion_scene", "delete_motion_scene"] as const) {
      const draft = { type, sceneId: "original-scene" } as EditorCommand;
      expect(() => assertOriginalMotionSceneV4Boundary([draft])).toThrow(/ORIGINAL_SCENE_V4_SOURCE_CONTRACT_REQUIRED/);
    }
  });
  it("cannot conceal a source-unadmitted camera inside nested batches", () => {
    expect(() => assertOriginalMotionSceneV4Boundary([{ type: "batch", commands: [
      { type: "batch", commands: [{ type: "delete_motion_scene", sceneId: "unadmitted" }] },
    ] }])).toThrow(/SOURCE_CONTRACT_REQUIRED/);
  });
});

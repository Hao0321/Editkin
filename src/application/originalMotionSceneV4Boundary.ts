import type { EditorCommand } from "../domain/commandTypes";
import type { CanonicalOriginalMotionSourceSet } from "./originalMotionSourceSets";

/** The existing v4 material contract requires real clip/source receipts.
 * A read-only standalone scene draft cannot impersonate those receipts.
 * Keep this explicit boundary until the canonical original-source admission
 * and semantic/design/camera recompilation are implemented together. */
export function assertOriginalMotionSceneV4Boundary(commands: readonly EditorCommand[], sources?: CanonicalOriginalMotionSourceSet): void {
  for (const command of commands) {
    if (command.type === "revise_motion_scene_graphics") {
      throw new Error("ORIGINAL_SCENE_V4_REVISION_CONTRACT_REQUIRED: manual scene content editing is not canonical source-bound revision admission");
    }
    if (command.type === "batch") assertOriginalMotionSceneV4Boundary(command.commands);
    if (command.type === "revise_original_motion_scene_graphic") {
      if ((sources?.schema !== "editkin.original-motion-source/v2" && sources?.schema !== "editkin.original-motion-source/v3") || !sources.sources[0].commands.some(binding => commands[binding.commandIndex] === command)) {
        throw new Error("ORIGINAL_SCENE_V4_SOURCE_REVISION_REQUIRED: actual versioned owner revision evidence is required");
      }
      continue;
    }
    if (command.type === "add_motion_scene" && sources?.schema === "editkin.original-motion-source/v1" && sources.sources.some(source => commands[source.sceneCommandIndex] === command)) continue;
    if (command.type === "add_motion_scene" || command.type === "update_motion_scene" || command.type === "delete_motion_scene") {
      throw new Error("ORIGINAL_SCENE_V4_SOURCE_CONTRACT_REQUIRED: read-only scene authoring is not current canonical v4 source/design admission");
    }
  }
}

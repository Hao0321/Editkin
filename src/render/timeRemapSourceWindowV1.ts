import type { EditProject } from "../domain/types";
import { renderTimeRemapSourceProjectV1 } from "./timeRemapSourceRenderV1";
import { SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4, type TimeRemapFrameWindowV1 } from "./timeRemapFrameWindowV1";
import type { SourceClockIndexSessionV1 } from "./sourceClockIndexSessionV1";
export { openSourceClockIndexSessionV1 } from "./sourceClockIndexSessionV1";
export { SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4 } from "./timeRemapFrameWindowV1";
/** Explicit opt-in video window of the ORIGINAL full neutral clip project. Audio is one separate
 * full-project pass in the LM host. Callers must keep original curve/duration and global indices. */
export function renderTimeRemapSourceWindowV1(project: EditProject, outputPath: string,
  runtime: Omit<Parameters<typeof renderTimeRemapSourceProjectV1>[2], "policy" | "outputFrameWindow" | "sourceIndexSession"> & {
    outputFrameWindow: TimeRemapFrameWindowV1; sourceIndexSession: SourceClockIndexSessionV1;
  }) {
  return renderTimeRemapSourceProjectV1(project, outputPath, { ...runtime, policy: SOURCE_CLOCK_FRAME_WINDOW_POLICY_V4 });
}

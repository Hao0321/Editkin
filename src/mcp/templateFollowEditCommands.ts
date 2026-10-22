import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { ProjectRevisionConflictError } from "../application/projectFiles";
import type { EditProject } from "../domain/types";
import { planEditCommandsWithTemplates, type TemplateNeedsReapply } from "../application/timelineMotionEdits";
import { rippleDeleteReports, type RippleDeleteReport } from "../application/timelineRippleEdits";
import { withReferenceMotionPhysicalFonts } from "./referenceMotionPhysicalFonts";
import { applyProjectCommands, readProject } from "./storage";

/** What happened to the saved title templates an agent's edit changed (apply_edit_commands → templateFollow). */
export interface TemplateFollowReport {
  /** Templates laid out again on their edited main clip (or re-recorded where a move or ripple carried them): still editable. */
  followed: Array<{ instanceId: string; title: string }>;
  /**
   * Templates that could not follow (too short for their words, edited by hand, their recipe or font updated…): the edit
   * still happened and each stays as it was until it is re-applied in the editor (「依目前片段重新套用」). The reason is
   * the same plain sentence the editor shows.
   */
  needsReapply: TemplateNeedsReapply[];
}

/**
 * apply_edit_commands: the agent's commands are accepted exactly as before (each one must apply to the result of the
 * ones before it). When they change a saved title template — its main clip trimmed (trim_clip_start/end), moved
 * (move_clip, move_clip_to_track, compact_track), extended (extend_clip), split (split_clip), or carried along by a
 * ripple (ripple_delete_clip, or extend_clip on an earlier clip) — the template follows in the same write through
 * followTemplatesThroughEdit, the very function the editor's own gestures use: laid out again with the real compiler and
 * the bundled fonts, or re-recorded where a move or ripple carried it, so it stays editable. Anything else that changes
 * a template (smart_cut_clip, deleting its main clip…) is detected the same way; when the template cannot follow, the
 * edit still happens and needsReapply says why. (slip_clip is not an apply_edit_commands command.) Commands that write
 * a template's own saved record (inspect_reference_motion_instances' update to the new version, a re-apply or revision)
 * manage that template themselves and are applied as they are. The project revision it was planned on must still be
 * current when the result is written; `expectedRevision`, when given, must be the revision on disk now.
 */
export async function applyEditCommandsWithTemplates(projectPath: string, commands: EditorCommand[],
  options: { environment?: NodeJS.ProcessEnv; expectedRevision?: number } = {}): Promise<{ project: EditProject; templates?: TemplateFollowReport; rippleDelete?: RippleDeleteReport[] }> {
  const project = await readProject(projectPath);
  if (options.expectedRevision !== undefined && project.revision !== options.expectedRevision) {
    throw new ProjectRevisionConflictError(options.expectedRevision, project.revision);
  }
  let edited = project;
  for (const command of commands) edited = applyCommand(edited, command);
  // ripple_delete_clip runs the editor's own rule; say in the editor's words what moved and what stayed in place.
  const ripple = commands.some(command => command.type === "ripple_delete_clip") ? rippleDeleteReports(project, commands) : [];
  const rippleDelete = ripple.length ? { rippleDelete: ripple } : {};
  const plan = await withReferenceMotionPhysicalFonts(fonts => planEditCommandsWithTemplates(project, commands, fonts), options.environment ?? process.env);
  if (!plan) return { project: await applyProjectCommands(projectPath, commands, options.expectedRevision), ...rippleDelete };
  return { project: await applyProjectCommands(projectPath, [plan.command], project.revision),
    templates: { followed: plan.followed, needsReapply: plan.needsReapply }, ...rippleDelete };
}

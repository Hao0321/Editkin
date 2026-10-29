import { EditGraphError } from "./editGraphError";
import { compileTimelineTransitionHandleV1, compileTimelineTransitionHandlesV1 } from "./timelineTransitionHandlesV1";
import type { EditorCommand } from "./commandTypes";
import type { EditProject } from "./types";

export function applyTimelineTransitionCommandV1(project: EditProject, command: EditorCommand): boolean {
  if (command.type === "set_timeline_transition") {
    const transition = compileTimelineTransitionHandleV1(project, command.transition).transition;
    const previous = project.timelineTransitions ?? [], next = previous.filter(t => t.id !== transition.id);
    next.push(structuredClone(transition));
    compileTimelineTransitionHandlesV1({ ...project, timelineTransitions: next });
    project.timelineTransitions = next;
    return true;
  }
  if (command.type === "delete_timeline_transition") {
    const previous = project.timelineTransitions ?? [];
    if (!previous.some(t => t.id === command.transitionId)) throw new EditGraphError("TIMELINE_TRANSITION_NOT_FOUND");
    project.timelineTransitions = previous.filter(t => t.id !== command.transitionId);
    return true;
  }
  return false;
}

/** Timing/source edits keep still-valid cuts. Broken bindings are removed immutably and restored by the same Undo. */
export function reconcileTimelineTransitionsV1(project: EditProject): EditProject {
  if (!project.timelineTransitions?.length) return project;
  const next = project.timelineTransitions.filter(t => {
    try { compileTimelineTransitionHandleV1(project, t); return true; }
    catch (error) {
      if (!(error instanceof EditGraphError) || !/^TIMELINE_TRANSITION_(?:TRACK_INVALID|NOT_ADJACENT|CONTENT_REQUIRED|FRAME_GRID_INVALID|WINDOW_EXCEEDS_CLIPS|SOURCE_INVALID|SOURCE_HANDLE_MISSING)$/.test(error.message)) throw error;
      return false;
    }
  });
  // A timing edit can make windows collide; retain the first still-admissible cut in authored order.
  const accepted: typeof next = [];
  for (const t of next) {
    try { compileTimelineTransitionHandlesV1({ ...project, timelineTransitions: [...accepted, t] }); accepted.push(t); }
    catch (error) { if (!(error instanceof EditGraphError) || error.message !== "TIMELINE_TRANSITION_WINDOW_OVERLAP") throw error; }
  }
  return accepted.length === project.timelineTransitions.length ? project : { ...project, timelineTransitions: accepted };
}

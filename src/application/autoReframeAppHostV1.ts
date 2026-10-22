import { applyCommand } from "../domain/commands";
import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import type { ProjectSession } from "./projectSession";

export interface ReframeNewProjectRequestV1 {
  baseProject: EditProject; command: EditorCommand; expectedSourceId: string; expectedSourceRevision: number;
}
/** Switch only after the existing draft was admitted; the source file is never a destination. */
export function createAutoReframeAppHostV1(input: {
  session: ProjectSession; confirmLeave(): boolean;
  openNew(project: EditProject): void;
}) {
  return (request: ReframeNewProjectRequestV1): { status: "created" | "cancelled" } => {
    const started = input.session.getSnapshot();
    if (started.history.present.id !== request.expectedSourceId || started.history.present.revision !== request.expectedSourceRevision) throw Error("AUTO_REFRAME_JOB_STALE");
    if (started.savePending) return { status: "cancelled" };
    if (started.dirty && !input.confirmLeave()) return { status: "cancelled" };
    const current = input.session.getSnapshot();
    if (current.sessionId !== started.sessionId || current.history.present !== started.history.present) throw Error("AUTO_REFRAME_JOB_STALE");
    if (request.baseProject.id === request.expectedSourceId) throw Error("AUTO_REFRAME_NEW_IDENTITY_INVALID");
    const next = applyCommand(request.baseProject, request.command);
    input.openNew(next);
    return { status: "created" };
  };
}

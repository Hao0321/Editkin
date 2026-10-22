import type { EditingLayerSelectionV1, EditingWorkspaceV1 } from "./editingWorkspaceV1";

export interface EditingGraphicSelectionV1 { id: string; sessionId: number }
/** Selection stays in the existing shell/session owners; it never edits or copies the project. */
export function editingLayerSelectionChangeV1(selection: EditingLayerSelectionV1, sessionId: number): {
  clipId?: string; captionId?: string; graphic?: EditingGraphicSelectionV1; workspace?: EditingWorkspaceV1;
} {
  return selection.kind === "graphic" ? { graphic: { id: selection.id, sessionId }, workspace: "effects" }
    : selection.kind === "caption" ? { captionId: selection.id, workspace: "edit" } : { clipId: selection.id };
}
export function reconcileEditingGraphicSelectionV1(selection: EditingGraphicSelectionV1 | undefined, context: {
  sessionId: number; clipId?: string; captionId?: string; exists: boolean;
}): EditingGraphicSelectionV1 | undefined {
  return selection && selection.sessionId === context.sessionId && context.clipId === undefined && context.captionId === undefined && context.exists
    ? selection : undefined;
}

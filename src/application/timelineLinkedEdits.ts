import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { expandLinkedClipIds, unusedLinkGroupId } from "../domain/clipLinks";
import { LINK_DONE, UNLINK_DONE } from "../domain/linkedClipCommands";

export function planTimelineClipLink(project: EditProject, clipIds: readonly string[], unlink = false) {
  const ids = expandLinkedClipIds(project, clipIds);
  const command: EditorCommand = { type: "set_clip_links", clipIds: ids, ...(unlink ? {} : { groupId: unusedLinkGroupId(project, ids.join("-")) }) };
  applyCommand(project, command);
  return { command, message: unlink ? UNLINK_DONE : LINK_DONE };
}

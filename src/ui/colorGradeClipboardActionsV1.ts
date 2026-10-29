import type { EditorCommand } from "../domain/commandTypes";
import type { createColorGradeClipboardV1 } from "../application/colorGradeClipboardV1";
export function colorGradeClipboardActionsV1(clipboard: ReturnType<typeof createColorGradeClipboardV1>, clipId: string, playhead: number,
  runCommand: (command: EditorCommand, message?: string) => boolean | void, setStatus: (message: string) => void) {
  return {
    onCopy: () => { try { clipboard.copy(clipId, playhead); setStatus("已複製目前影格的調色。"); } catch (e) { setStatus(e instanceof Error ? e.message : "調色快照不合法。"); } },
    onPaste: () => { try { runCommand(clipboard.planPaste(clipId), "已貼上調色，可一次復原。"); } catch (e) { setStatus(e instanceof Error ? e.message : "調色快照不合法。"); } },
  };
}

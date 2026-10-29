import type { ProjectSession } from "./projectSession";
import type { EditorCommand } from "../domain/commandTypes";
import type { ClipGradeSnapshotV1 } from "../domain/clipGradeSnapshotV1Schema";
import { assertClipGradePasteTargetV1, captureClipGradeSnapshotV1 } from "../domain/clipGradeSnapshotV1";
import { findClip, findTrack } from "../domain/editGraph";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
export interface ColorGradeClipboardStateV1 { hasCopy: boolean; sourceName?: string; localTime?: number }
/** Window/project-session clipboard. Only metadata is exposed; payload and OS clipboard stay private. */
export function createColorGradeClipboardV1(session: ProjectSession) {
  let payload: { sessionId: number; management: string; snapshot: ClipGradeSnapshotV1 } | undefined;
  let state: ColorGradeClipboardStateV1 = { hasCopy: false };
  const listeners = new Set<() => void>();
  const managementKey = () => JSON.stringify(session.getSnapshot().history.present.colorManagement ?? DEFAULT_COLOR_MANAGEMENT);
  const publish = (next: ColorGradeClipboardStateV1) => { state = next; for (const listener of [...listeners]) listener(); };
  const refresh = () => {
    if (payload && (payload.sessionId !== session.getSnapshot().sessionId || payload.management !== managementKey())) { payload = undefined; publish({ hasCopy: false }); }
  };
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    attach: () => { refresh(); return session.subscribe(refresh); },
    copy: (clipId: string, playhead: number) => {
      refresh(); const captured = captureClipGradeSnapshotV1(session.getSnapshot().history.present, clipId, playhead);
      payload = { sessionId: session.getSnapshot().sessionId, management: managementKey(), snapshot: structuredClone(captured.snapshot) };
      publish({ hasCopy: true, sourceName: captured.sourceName, localTime: captured.localTime }); return state;
    },
    canPaste: (clipId: string) => {
      if (!payload || payload.sessionId !== session.getSnapshot().sessionId || payload.management !== managementKey()) return false;
      try { assertClipGradePasteTargetV1(session.getSnapshot().history.present, clipId); return true; } catch { return false; }
    },
    planPaste: (clipId: string): EditorCommand => {
      refresh(); if (!payload) throw new Error("尚未複製這個專案的調色。");
      const p = session.getSnapshot().history.present, clip = findClip(p, clipId), track = findTrack(p, clip.trackId);
      if (track.locked) throw new Error(TRACK_LOCKED_MESSAGE);
      // Admission is the same as actual mutation; no stale target/invalid payload is silently accepted.
      assertClipGradePasteTargetV1(p, clipId);
      return { type: "paste_clip_grade_v1", clipId, snapshot: structuredClone(payload.snapshot) };
    },
    clear: () => { payload = undefined; publish({ hasCopy: false }); },
  };
}

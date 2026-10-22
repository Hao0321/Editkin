import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ProjectSession } from "../application/projectSession";
import { createColorGradeClipboardV1 } from "../application/colorGradeClipboardV1";
/** Session object is stable across edits; the store invalidates copied grades on session/mode replacement. */
export function useColorGradeClipboardV1(session: ProjectSession) {
  const clipboard = useMemo(() => createColorGradeClipboardV1(session), [session]);
  useEffect(() => clipboard.attach(), [clipboard]);
  const state = useSyncExternalStore(clipboard.subscribe, clipboard.getSnapshot, clipboard.getSnapshot);
  return { clipboard, state };
}

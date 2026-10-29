import { useEffect } from "react";
import { clampProjectSeek } from "./playbackTiming";

/** The in-bounds playhead after an edit or Undo made the project shorter; undefined when already in bounds. */
export function playheadAfterProjectChange(playhead: number, duration: number): number | undefined {
  if (!Number.isFinite(playhead)) return undefined;
  const clamped = clampProjectSeek(playhead, duration);
  return clamped === playhead ? undefined : clamped;
}

/** Keeps the playhead, ruler readout and transport on the real project, like every explicit seek. */
export function useProjectEndPlayheadClamp(playhead: number, duration: number, seek: (time: number) => void): void {
  useEffect(() => {
    const next = playheadAfterProjectChange(playhead, duration);
    if (next !== undefined) seek(next);
  }, [playhead, duration, seek]);
}

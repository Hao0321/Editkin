import { useCallback, useRef, useState } from "react";
import { createTimelineRangeTransport, type TimelinePlaybackRange, type TimelineRangeTransportHost, type TimelineSeekValue } from "../application/timelineRangePlayback";
import type { PlayheadStore } from "./playheadStore";

/** Adds transient In/Out playback to the existing transport, keeping the same seek revision protocol.
 * PF1 (2026-10-23): the transport lives in `store`, outside App state; App does not re-render on a seek or a clock tick.
 * `observeSeekRevision` is called while PlayheadRenderObserver renders, where App's render called it before. */
export function useTimelineRangeTransport(onRangeEnd: () => void, store: PlayheadStore) {
  const host = useRef<TimelineRangeTransportHost>({ setPlayhead: store.seek, onPlaybackClock: store.clock, onRangeEnd });
  host.current = { setPlayhead: store.seek, onPlaybackClock: store.clock, onRangeEnd };
  const [owner] = useState(() => createTimelineRangeTransport(() => host.current, store.getSnapshot().seekRevision));
  const setPlayhead = useCallback((value: TimelineSeekValue) => owner.setPlayhead(value), [owner]);
  const onPlaybackClock = useCallback((time: number, revision: number) => owner.onPlaybackClock(time, revision), [owner]);
  const beginRangePlayback = useCallback((range: TimelinePlaybackRange, start: (range: TimelinePlaybackRange) => void) => owner.beginRange(range, start), [owner]);
  const cancelRangePlayback = useCallback(() => owner.cancelRange(), [owner]);
  const observeSeekRevision = useCallback((state: { seekRevision: number }) => owner.observeSeekRevision(state.seekRevision), [owner]);
  return { setPlayhead, onPlaybackClock, beginRangePlayback, cancelRangePlayback, observeSeekRevision };
}

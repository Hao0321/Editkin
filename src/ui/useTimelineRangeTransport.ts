import { useCallback, useRef, useState } from "react";
import { createTimelineRangeTransport, type TimelinePlaybackRange, type TimelineRangeTransportHost, type TimelineSeekValue } from "../application/timelineRangePlayback";
import { usePlayheadTransport } from "./playheadTransport";

/** Adds transient In/Out playback to the existing transport, keeping the same seek revision protocol. */
export function useTimelineRangeTransport(onRangeEnd: () => void) {
  const transport = usePlayheadTransport();
  const host = useRef<TimelineRangeTransportHost>({ ...transport, onRangeEnd });
  host.current = { ...transport, onRangeEnd };
  const [owner] = useState(() => createTimelineRangeTransport(() => host.current, transport.seekRevision));
  owner.observeSeekRevision(transport.seekRevision);
  const setPlayhead = useCallback((value: TimelineSeekValue) => owner.setPlayhead(value), [owner]);
  const onPlaybackClock = useCallback((time: number, revision: number) => owner.onPlaybackClock(time, revision), [owner]);
  const beginRangePlayback = useCallback((range: TimelinePlaybackRange, start: (range: TimelinePlaybackRange) => void) => owner.beginRange(range, start), [owner]);
  const cancelRangePlayback = useCallback(() => owner.cancelRange(), [owner]);
  return { ...transport, setPlayhead, onPlaybackClock, beginRangePlayback, cancelRangePlayback };
}

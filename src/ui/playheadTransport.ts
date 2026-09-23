import { useCallback, useReducer, type SetStateAction } from "react";

export interface PlayheadTransportState { time: number; seekRevision: number }
export type PlayheadTransportAction = { kind: "seek"; value: SetStateAction<number> }
  | { kind: "clock"; time: number; seekRevision: number };

/** User seeks and device progress are distinct commands. A queued old device
 * event can never undo a newer seek, including a seek to the same timestamp. */
export function reducePlayheadTransport(state: PlayheadTransportState, action: PlayheadTransportAction): PlayheadTransportState {
  if (action.kind === "clock" && action.seekRevision !== state.seekRevision) return state;
  const time = action.kind === "clock" ? action.time
    : typeof action.value === "function" ? action.value(state.time) : action.value;
  if (!Number.isFinite(time) || time < 0) return state;
  return action.kind === "seek" ? { time, seekRevision: state.seekRevision + 1 }
    : time === state.time ? state : { ...state, time };
}

export function usePlayheadTransport() {
  const [state, dispatch] = useReducer(reducePlayheadTransport, { time: 0, seekRevision: 0 });
  const setPlayhead = useCallback((value: SetStateAction<number>) => dispatch({ kind: "seek", value }), []);
  const onPlaybackClock = useCallback((time: number, seekRevision: number) => dispatch({ kind: "clock", time, seekRevision }), []);
  return { playhead: state.time, seekRevision: state.seekRevision, setPlayhead, onPlaybackClock };
}

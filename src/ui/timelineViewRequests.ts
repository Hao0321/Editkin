import { useEffect, useRef } from "react";
import { TIMELINE_ZOOM_IN, TIMELINE_ZOOM_OUT } from "./TimelineZoomControl";

/** S1: every key press has a new nonce even when it requests the same view again. */
export interface TimelineViewRequest {
  kind: "zoom-in" | "zoom-out" | "fit" | "frames" | "toggle-snap";
  nonce: number;
}
export interface TimelineViewRequestHost {
  busy: () => boolean;
  simpleMode: boolean;
  zoom: (factor: number) => void;
  fit: () => void;
  frames: () => void;
  toggleSnap: () => void;
}

/** Reuses the timeline's current controls and the same refusal while a captured gesture owns its time scale. */
export function useTimelineViewRequest(request: TimelineViewRequest | undefined, host: TimelineViewRequestHost) {
  const live = useRef(host);
  live.current = host;
  const processed = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!request) { processed.current = undefined; return; }
    if (processed.current === request.nonce) return;
    processed.current = request.nonce;
    const current = live.current;
    if (current.busy()) return;
    if (request.kind === "zoom-in") current.zoom(TIMELINE_ZOOM_IN);
    else if (request.kind === "zoom-out") current.zoom(TIMELINE_ZOOM_OUT);
    else if (request.kind === "fit") current.fit();
    else if (request.kind === "frames") current.frames();
    else if (!current.simpleMode) current.toggleSnap();
  }, [request?.nonce]);
}

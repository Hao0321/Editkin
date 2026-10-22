import { useEffect, useMemo, useRef, useState } from "react";
import { motionLibraryAnimationV1, motionLibraryStillTimeV1, type MotionLibraryFrameRequestV1 } from "./motionLibraryFramesV1";
import { MOTION_LIBRARY_PRIORITY_V1, type MotionLibraryThumbnailServiceV1 } from "./motionLibraryThumbnailServiceV1";
import type { MotionLibraryItem } from "../motionLibrary/types";

/**
 * A live thumbnail: the item's still at its representative moment, and — while `animating` — its own animation loop,
 * starting from that still and generated frame by frame in the thumbnail worker (the first pass may run slower than
 * real time; later passes replay the cached frames).
 */
export interface MotionLibraryThumbProps {
  readonly service: MotionLibraryThumbnailServiceV1;
  readonly item: MotionLibraryItem;
  readonly size: { width: number; height: number };
  readonly purpose: "card" | "preview";
  readonly params?: Readonly<Record<string, unknown>>;
  /** Visible on screen: only then is the still requested. */
  readonly visible: boolean;
  readonly animating: boolean;
  readonly className?: string;
  readonly onError?: (message: string | undefined) => void;
}

export function MotionLibraryThumb({ service, item, size, purpose, params, visible, animating, className, onError }: MotionLibraryThumbProps) {
  const paramsKey = JSON.stringify(params ?? null);
  const still = useMemo<MotionLibraryFrameRequestV1>(() => ({ itemId: item.id, purpose, size, t: motionLibraryStillTimeV1(item), ...(params ? { params } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id, purpose, size.width, size.height, paramsKey]);
  const [stillUrl, setStillUrl] = useState<string | undefined>(() => service.peek(still));
  const [frameUrl, setFrameUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    const cached = service.peek(still);
    setStillUrl(cached);
    if (cached || !visible) return;
    const controller = new AbortController();
    service.frame(still, { priority: purpose === "preview" ? MOTION_LIBRARY_PRIORITY_V1.preview : MOTION_LIBRARY_PRIORITY_V1.still, signal: controller.signal })
      .then(url => { if (!controller.signal.aborted) { setStillUrl(url); setError(undefined); errorRef.current?.(undefined); } },
        failure => { if (!controller.signal.aborted && failure?.name !== "AbortError") { setError(String(failure?.message ?? failure)); errorRef.current?.(String(failure?.message ?? failure)); } });
    return () => controller.abort();
  }, [service, still, visible, purpose]);

  useEffect(() => {
    // New params or a new item: drop the old loop's frame at once, so the new still (or first new frame) shows immediately.
    setFrameUrl(undefined);
    if (!animating) return;
    const controller = new AbortController();
    let animation;
    // The loop begins on the still the card shows (frame 0 is that same, already cached request) and plays the item's
    // whole duration from there, so hovering never flashes the empty frame of an entrance that starts later (T05).
    try { animation = motionLibraryAnimationV1(item.id, params ?? {}, still.t); } catch { return; }
    const frames: Array<string | undefined> = new Array(animation.times.length);
    const priority = purpose === "preview" ? MOTION_LIBRARY_PRIORITY_V1.preview : MOTION_LIBRARY_PRIORITY_V1.hover;
    let index = 0, timer: ReturnType<typeof setTimeout> | undefined;
    // Generate in display order (in the worker), so the loop fills front to back.
    const request = (at: number) => service.frame({ itemId: item.id, purpose, size, t: animation.times[at], ...(params ? { params } : {}) }, { priority, signal: controller.signal })
      .then(url => { frames[at] = url; }, () => undefined);
    void (async () => { for (let at = 0; at < frames.length && !controller.signal.aborted; at += 1) await request(at); })();
    const tick = () => {
      if (controller.signal.aborted) return;
      const url = frames[index];
      if (url) { setFrameUrl(url); timer = setTimeout(() => { index = (index + 1) % frames.length; tick(); }, animation.frameMs[index]); }
      else timer = setTimeout(tick, 30);
    };
    tick();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animating, service, still, item.id, purpose, size.width, size.height, paramsKey]);

  const url = (animating && frameUrl) || stillUrl;
  return <span className={`ml-thumb${className ? ` ${className}` : ""}`} data-state={url ? "ready" : error ? "error" : "loading"} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
    {url ? <img src={url} alt="" draggable={false} decoding="async" /> : error ? <span className="ml-thumb-error">{item.names.zh}</span> : <span className="ml-thumb-shimmer" />}
  </span>;
}

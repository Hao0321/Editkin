/** Coalesce panel movement within one display frame, retaining the full delta. */
export function createFrameDeltaScheduler(options: {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  onDelta: (delta: number) => void;
}) {
  let pending = 0;
  let frame: number | undefined;
  const flush = () => {
    if (frame !== undefined) options.cancelFrame(frame);
    frame = undefined;
    const delta = pending;
    pending = 0;
    if (delta) options.onDelta(delta);
  };
  return {
    add: (delta: number) => {
      if (!Number.isFinite(delta) || !delta) return;
      pending += delta;
      if (frame === undefined) frame = options.requestFrame(flush);
    },
    flush,
    cancel: () => {
      if (frame !== undefined) options.cancelFrame(frame);
      frame = undefined;
      pending = 0;
    },
  };
}

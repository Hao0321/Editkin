import { describe, expect, it, vi } from "vitest";
import { previewPlaybackRate, startCompatiblePlaybackClock } from "./playbackTiming";

function scheduler() {
  let now = 1000, next = 0;
  const queued = new Map<number, (now: number) => void>(), delivered = new Map<number, (now: number) => void>();
  return {
    now: () => now,
    requestFrame: (work: (now: number) => void) => { queued.set(++next, work); delivered.set(next, work); return next; },
    cancelFrame: (id: number) => { queued.delete(id); },
    advance: (milliseconds: number) => { now += milliseconds; const entry = queued.entries().next().value; if (!entry) return;
      queued.delete(entry[0]); entry[1](now); },
    late: (id: number) => delivered.get(id)?.(now + 1000),
    pending: () => queued.size,
  };
}

describe("signed compatible playback clock", () => {
  it("follows signed wall-clock trajectories at every supported shuttle magnitude", () => {
    for (const rate of [0.5, 1, 2, 4, 8, -0.5, -1, -2, -4, -8]) {
      const clock = scheduler(), onTime = vi.fn(), onEnded = vi.fn();
      const cancel = startCompatiblePlaybackClock({ ...clock, origin: 4, duration: 20, fps: 60,
        playbackRate: rate, isCurrent: () => true, onTime, onEnded });
      clock.advance(250);
      expect(onTime).toHaveBeenLastCalledWith(4 + 0.25 * rate);
      expect(onEnded).not.toHaveBeenCalled();
      cancel(); expect(clock.pending()).toBe(0);
    }
  });

  it("clamps and ends once at the real forward end and reverse start", () => {
    const forward = scheduler(), reverse = scheduler(), forwardTime = vi.fn(), reverseTime = vi.fn(), end = vi.fn(), start = vi.fn();
    startCompatiblePlaybackClock({ ...forward, origin: 4.9, duration: 5, fps: 30, playbackRate: 8,
      isCurrent: () => true, onTime: forwardTime, onEnded: end });
    startCompatiblePlaybackClock({ ...reverse, origin: 0.1, duration: 5, fps: 30, playbackRate: -8,
      isCurrent: () => true, onTime: reverseTime, onEnded: start });
    forward.advance(100); reverse.advance(100); forward.late(1); reverse.late(1);
    expect(forwardTime.mock.calls).toEqual([[5]]); expect(reverseTime.mock.calls).toEqual([[0]]);
    expect(end).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    expect(forward.pending() + reverse.pending()).toBe(0);
  });

  it("coalesces ticks within a project frame and rejects a delivered callback after cancel", () => {
    const clock = scheduler(), onTime = vi.fn(), onEnded = vi.fn();
    const cancel = startCompatiblePlaybackClock({ ...clock, origin: 1, duration: 5, fps: 30,
      isCurrent: () => true, onTime, onEnded });
    clock.advance(5); clock.advance(5); clock.advance(20);
    expect(onTime).not.toHaveBeenCalled();
    clock.advance(4); expect(onTime).toHaveBeenCalledTimes(1); expect(onTime).toHaveBeenLastCalledWith(1.034);
    cancel(); clock.late(5);
    expect(onTime).toHaveBeenCalledTimes(1); expect(onEnded).not.toHaveBeenCalled(); expect(clock.pending()).toBe(0);
  });

  it("rebases an explicit seek and rate switch without letting the retired clock overwrite it", () => {
    const clock = scheduler(), onTime = vi.fn(), onEnded = vi.fn();
    let revision = 0;
    const old = startCompatiblePlaybackClock({ ...clock, origin: 0, duration: 8, fps: 60, playbackRate: 4,
      isCurrent: () => revision === 0, onTime, onEnded });
    revision = 1; old();
    const current = startCompatiblePlaybackClock({ ...clock, origin: 5, duration: 8, fps: 60, playbackRate: -2,
      isCurrent: () => revision === 1, onTime, onEnded });
    clock.late(1); expect(onTime).not.toHaveBeenCalled();
    clock.advance(250); expect(onTime.mock.calls).toEqual([[4.5]]);
    revision = 2; clock.advance(250); expect(onTime.mock.calls).toEqual([[4.5]]);
    current(); expect(onEnded).not.toHaveBeenCalled();
  });

  it("rejects unsupported rates and invalid clocks before allocating animation work", () => {
    const clock = scheduler(), onTime = vi.fn(), onEnded = vi.fn();
    const options = { ...clock, origin: 1, duration: 5, fps: 30, isCurrent: () => true, onTime, onEnded };
    expect(previewPlaybackRate()).toBe(1);
    expect(() => previewPlaybackRate(0)).toThrow(/速度/); expect(() => previewPlaybackRate(NaN)).toThrow(/速度/);
    expect(() => startCompatiblePlaybackClock({ ...options, duration: Infinity })).toThrow(/時間/);
    expect(() => startCompatiblePlaybackClock({ ...options, now: () => NaN })).toThrow(/時鐘/);
    expect(clock.pending()).toBe(0); expect(onTime).not.toHaveBeenCalled();
  });
});

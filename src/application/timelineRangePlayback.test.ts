import { describe, expect, it } from "vitest";
import { reducePlayheadTransport, type PlayheadTransportAction, type PlayheadTransportState } from "../ui/playheadTransport";
import { createTimelineRangeTransport, timelinePlaybackRange, type TimelineRangeTransportHost } from "./timelineRangePlayback";

/** Same reducer as the player, with a buffered queue like a React event. */
function transport() {
  let state: PlayheadTransportState = { time: 0, seekRevision: 0 }, stops = 0;
  const queued: PlayheadTransportAction[] = [];
  const host: TimelineRangeTransportHost = {
    setPlayhead: value => queued.push({ kind: "seek", value }),
    onPlaybackClock: (time, seekRevision) => queued.push({ kind: "clock", time, seekRevision }),
    onRangeEnd: () => { stops++; owner.setPlayhead(current => current); },
  };
  const owner = createTimelineRangeTransport(() => host);
  const render = () => {
    for (const action of queued.splice(0)) state = reducePlayheadTransport(state, action);
    owner.observeSeekRevision(state.seekRevision);
  };
  const begin = () => owner.beginRange({ in: 1, out: 3 }, range => {
    // A pause or rate change invalidates device progress too, before seeking and starting.
    owner.setPlayhead(current => current); owner.setPlayhead(range.in); owner.setPlayhead(current => current);
  });
  return { owner, begin, render, get state() { return state; }, get stops() { return stops; } };
}

describe("transient range playback keeps the existing seek revision protection", () => {
  it("aligns range marks to frames and refuses invalid, empty or out-of-timeline ranges", () => {
    expect(timelinePlaybackRange({ in: 1.003, out: 3.001 }, 6, 30)).toEqual({ in: 1, out: 3 });
    for (const range of [{}, { in: 1 }, { in: 3, out: 1 }, { in: 1, out: 1.001 }, { in: -1, out: 3 }, { in: 1, out: 7 }, { in: NaN, out: 3 }]) {
      expect(timelinePlaybackRange(range, 6, 30)).toBeUndefined();
    }
    expect(timelinePlaybackRange({ in: 1, out: 3 }, 6, 0)).toBeUndefined();
  });

  it("binds to the actual revision after all queued start seeks, not to a guessed single seek", () => {
    const player = transport(); player.begin();
    player.owner.onPlaybackClock(10, 0); // The old actor has not observed the new seek yet.
    player.render();
    expect(player.state).toEqual({ time: 1, seekRevision: 3 });
    expect(player.stops).toBe(0);
    player.owner.onPlaybackClock(2, 3); player.render();
    expect(player.state.time).toBe(2);
    expect(player.owner.getActiveRange()).toEqual({ in: 1, out: 3 });
  });

  it.each([3, 3.04, 8])("stops at Out when the real clock reaches %s and retires all late events", time => {
    const player = transport(); player.begin(); player.render();
    player.owner.onPlaybackClock(time, 3); player.render();
    expect(player.state).toEqual({ time: 3, seekRevision: 5 });
    expect(player.stops).toBe(1);
    expect(player.owner.getActiveRange()).toBeUndefined();
    player.owner.onPlaybackClock(9, 3); player.render();
    expect(player.state.time).toBe(3); expect(player.stops).toBe(1);
  });

  it("an old clock cannot stop a new range or move its playhead", () => {
    const player = transport(); player.begin(); player.render();
    player.owner.onPlaybackClock(10, 2); player.render();
    expect(player.state.time).toBe(1); expect(player.stops).toBe(0);
    expect(player.owner.getActiveRange()).toEqual({ in: 1, out: 3 });
    player.owner.onPlaybackClock(2.99, 3); player.render();
    expect(player.state.time).toBe(2.99); expect(player.stops).toBe(0);
  });

  it("a user seek cancels the range synchronously, before even an already queued end clock", () => {
    const player = transport(); player.begin(); player.render();
    player.owner.setPlayhead(4); player.owner.onPlaybackClock(8, 3); player.render();
    expect(player.state).toEqual({ time: 4, seekRevision: 4 });
    expect(player.stops).toBe(0); expect(player.owner.getActiveRange()).toBeUndefined();
    player.owner.onPlaybackClock(4.5, 4); player.render(); expect(player.state.time).toBe(4.5);
  });

  it("an invalid numeric seek keeps both the original reducer state and the active range", () => {
    const player = transport(); player.begin(); player.render();
    for (const time of [NaN, Infinity, -1]) player.owner.setPlayhead(time);
    player.render();
    expect(player.state).toEqual({ time: 1, seekRevision: 3 });
    expect(player.owner.getActiveRange()).toEqual({ in: 1, out: 3 });
  });
});

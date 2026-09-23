import { describe, expect, it } from "vitest";
import { reducePlayheadTransport as reduce } from "./playheadTransport";

describe("timeline seek versus playback clock ownership", () => {
  it("120 device frames do not create 120 user seeks", () => {
    let state = { time: 0, seekRevision: 0 };
    for (let i = 1; i <= 120; i++) state = reduce(state, { kind: "clock", time: i / 30, seekRevision: 0 });
    expect(state).toEqual({ time: 4, seekRevision: 0 });
  });
  it("a real seek, even to the same frame, retires all old clock updates", () => {
    const state = reduce({ time: 4, seekRevision: 3 }, { kind: "seek", value: 4 });
    expect(state).toEqual({ time: 4, seekRevision: 4 });
    expect(reduce(state, { kind: "clock", time: 5, seekRevision: 3 })).toBe(state);
    expect(reduce(state, { kind: "clock", time: 4.1, seekRevision: 4 }).time).toBe(4.1);
  });
  it("keyboard-relative seeks use the latest clock and reject non-finite input", () => {
    const state = reduce({ time: 2, seekRevision: 0 }, { kind: "seek", value: current => current + 1 });
    expect(state).toEqual({ time: 3, seekRevision: 1 });
    for (const time of [NaN, Infinity, -1]) expect(reduce(state, { kind: "clock", time, seekRevision: 1 })).toBe(state);
  });
});

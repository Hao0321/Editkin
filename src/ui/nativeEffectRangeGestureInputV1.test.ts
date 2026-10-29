import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createNativeEffectRangeGestureInputV1 } from "./nativeEffectRangeGestureInputV1";

type Input = ReturnType<typeof createNativeEffectRangeGestureInputV1>;
type Binding = ReturnType<Input["bind"]>;
type Event = Parameters<Binding["events"]["onPointerDown"]>[0];
function fixture(options: { refuse?: boolean; invalid?: boolean; captureThrows?: boolean; commitThrows?: boolean } = {}) {
  const input = createNativeEffectRangeGestureInputV1(), values: number[] = [], calls = { begin: 0, commit: 0, cancel: 0, prevented: 0 };
  const held = new Set<number>();
  const target = {
    setPointerCapture(id: number) { if (options.captureThrows) throw Error("Detached"); held.add(id); },
    hasPointerCapture: (id: number) => held.has(id),
    releasePointerCapture: (id: number) => { held.delete(id); },
  };
  const binding = input.bind("a", () => {
    calls.begin++;
    return options.refuse ? undefined : {
      update: (value: number) => { values.push(value); return !options.invalid; },
      commit: () => { calls.commit++; if (options.commitThrows) throw Error("Host exception"); return true; },
      cancel: () => { calls.cancel++; },
    };
  });
  const event = (extra: Partial<Event> = {}): Event => ({
    currentTarget: target, pointerId: 1, button: 0, isPrimary: true, preventDefault: () => { calls.prevented++; }, ...extra,
  });
  return { input, binding, calls, held, target, values, event };
}

describe("range gesture native event ownership", () => {
  it("keeps native value math, captures pointer and commits once", () => {
    const f = fixture(); f.binding.events.onPointerDown(f.event()); assert(f.held.has(1)); assert.equal(f.calls.prevented, 0);
    assert(f.binding.change(f.target, .3)); assert(f.binding.change(f.target, .7)); assert.equal(f.calls.commit, 0);
    f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 1); assert.equal(f.held.size, 0);
    f.binding.events.onLostPointerCapture(f.event()); f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 1);
  });
  it("refused begin consumes every input until physical release", () => {
    const f = fixture({ refuse: true }); f.binding.events.onPointerDown(f.event());
    for (const value of [.3, .5, .8]) assert(f.binding.change(f.target, value));
    assert.equal(f.calls.commit, 0); f.binding.events.onPointerUp(f.event()); assert.equal(f.binding.change(f.target, .9), false);
  });
  it("rejected update never falls back on later moves", () => {
    const f = fixture({ invalid: true }); f.binding.events.onPointerDown(f.event());
    assert(f.binding.change(f.target, .3)); assert(f.binding.change(f.target, .7));
    assert.equal(f.calls.cancel, 1); assert.deepEqual(f.values, [.3]); f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 0);
  });
  it("secondary/right pointer cannot begin", () => {
    const f = fixture(); f.binding.events.onPointerDown(f.event({ button: 2 }));
    f.binding.events.onPointerDown(f.event({ pointerId: 2, isPrimary: false })); assert.equal(f.calls.begin, 0); assert.equal(f.calls.prevented, 2);
  });
  it("another pointer cannot end the primary", () => {
    const f = fixture(); f.binding.events.onPointerDown(f.event());
    f.binding.events.onPointerDown(f.event({ pointerId: 2, isPrimary: false }));
    f.binding.events.onPointerUp(f.event({ pointerId: 2 })); f.binding.events.onLostPointerCapture(f.event({ pointerId: 2 }));
    assert.equal(f.calls.commit, 0); assert(f.held.has(1)); f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 1);
  });
  it("capture failure cancels and blocks fallback", () => {
    const f = fixture({ captureThrows: true }); f.binding.events.onPointerDown(f.event());
    assert(f.binding.change(f.target, .5)); assert.equal(f.calls.cancel, 1); f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 0);
  });
  it("host commit exception still releases capture and held state", () => {
    const f = fixture({ commitThrows: true }); f.binding.events.onPointerDown(f.event());
    assert.throws(() => f.binding.events.onPointerUp(f.event()), /Host exception/); assert.equal(f.held.size, 0);
    f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 1);
  });
  it("keyboard auto-repeat is one lease and one commit", () => {
    const f = fixture(); for (let i = 0; i < 5; i++) f.binding.events.onKeyDown(f.event({ key: "ArrowRight" }));
    assert.equal(f.calls.begin, 1); f.binding.events.onKeyUp(f.event({ key: "ArrowRight" })); assert.equal(f.calls.commit, 1);
  });
  it("IME owns composition keys including Escape", () => {
    const f = fixture(); f.binding.events.onKeyDown(f.event({ key: "ArrowRight", nativeEvent: { isComposing: true } }));
    assert.equal(f.calls.begin, 0); f.binding.events.onKeyDown(f.event({ key: "ArrowRight" }));
    f.binding.events.onKeyDown(f.event({ key: "Escape", nativeEvent: { keyCode: 229 } })); assert.equal(f.calls.cancel, 0);
    f.binding.events.onKeyUp(f.event({ key: "ArrowRight", nativeEvent: { isComposing: true } })); assert.equal(f.calls.commit, 0);
    f.binding.events.onKeyDown(f.event({ key: "Escape" })); assert.equal(f.calls.cancel, 1);
  });
  it("pointer blur cancels, keyboard blur commits", () => {
    const a = fixture(); a.binding.events.onPointerDown(a.event()); a.binding.events.onBlur(a.event()); assert.equal(a.calls.cancel, 1);
    const b = fixture(); b.binding.events.onKeyDown(b.event({ key: "End" })); b.binding.events.onBlur(b.event()); assert.equal(b.calls.commit, 1);
  });
  it("unmount cancellation is idempotent and releases capture", () => {
    const f = fixture(); f.binding.events.onPointerDown(f.event()); f.input.cancel(); f.input.cancel();
    assert.equal(f.calls.cancel, 1); assert.equal(f.held.size, 0); assert.equal(f.binding.change(f.target, .5), false);
  });
  it("replacement node is consumed without reviving a gesture", () => {
    const f = fixture(); f.binding.events.onPointerDown(f.event()); assert(f.binding.change({}, .4)); assert(f.binding.change(f.target, .8));
    assert.equal(f.calls.cancel, 1); assert.deepEqual(f.values, []); f.binding.events.onPointerUp(f.event()); assert.equal(f.calls.commit, 0);
  });
});

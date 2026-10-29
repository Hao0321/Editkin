import { afterEach, describe, expect, it, vi } from "vitest";
import { bindCameraPrevisObjectDragV1, type prepareCameraPrevisPlacementV1 } from "./cameraPrevisPlacementV1";

// The callback contract is isolated here. Actual ordinary project validation,
// GPU pixels, history and browser pointer input have a separate source journey.
class Surface {
  style = { touchAction: "pan-y" }; tabIndex = -1; captured = false;
  handlers = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) { const set = this.handlers.get(type) ?? new Set(); set.add(listener); this.handlers.set(type, set); }
  removeEventListener(type: string, listener: EventListener) { this.handlers.get(type)?.delete(listener); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; }
  setPointerCapture() { this.captured = true; }
  hasPointerCapture() { return this.captured; }
  releasePointerCapture() { this.captured = false; }
  focus() {}
  emit(type: string, x = 150) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerId: 7, button: 0, isPrimary: true, clientX: x, clientY: 100 }).map(([key, value]) => [key, { value }])));
    for (const listener of [...this.handlers.get(type) ?? []]) listener(event);
  }
}
const disposers: Array<() => void> = [];
function fixture() {
  const canvas = new Surface(), win = new Surface(), frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("window", win);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const plan = Object.freeze({}) as ReturnType<ReturnType<typeof prepareCameraPrevisPlacementV1>["move"]>;
  const state = { authority: "original", view: "original", mutations: 0 };
  const callbacks = {
    preview: vi.fn(() => { state.view = "draft"; }),
    commit: vi.fn(() => { state.authority = "committed"; state.mutations++; }),
    cancel: vi.fn(() => { state.view = state.authority; }), refused: vi.fn(),
  };
  const binder = bindCameraPrevisObjectDragV1(canvas as unknown as HTMLCanvasElement, () => ({ pick: () => "person", ground: () => [0, 0, 0] as [number, number, number], move: () => plan }), callbacks);
  disposers.push(binder.dispose);
  const start = () => {
    canvas.emit("pointerdown", 100); canvas.emit("pointermove");
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
  };
  return { canvas, callbacks, binder, state, start, frames, plan };
}
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });

describe("previs drag commit recovery without owning project history", () => {
  it("keeps a successful release as exactly one commit without restoring or refusing", () => {
    const f = fixture(); f.start(); f.canvas.emit("pointerup");
    expect(f.callbacks.commit).toHaveBeenCalledExactlyOnceWith(f.plan);
    expect(f.state.mutations).toBe(1); expect(f.callbacks.cancel).not.toHaveBeenCalled(); expect(f.callbacks.refused).not.toHaveBeenCalled();
  });
  it("restores the ephemeral preview and reports a rejected commit without an uncaught event error", () => {
    const f = fixture(), failure = Error("command rejected"); f.callbacks.commit.mockImplementation(() => { throw failure; }); f.start();
    expect(() => f.canvas.emit("pointerup")).not.toThrow();
    expect(f.state).toEqual({ authority: "original", view: "original", mutations: 0 });
    expect(f.callbacks.cancel).toHaveBeenCalledTimes(1); expect(f.callbacks.refused).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.canvas.captured).toBe(false); expect(f.frames.size).toBe(0);
  });
  it("preserves both commit and preview restoration failures", () => {
    const f = fixture(), commit = Error("commit rejected"), restore = Error("restore rejected");
    f.callbacks.commit.mockImplementation(() => { throw commit; }); f.callbacks.cancel.mockImplementation(() => { throw restore; }); f.start();
    expect(() => f.canvas.emit("pointerup")).not.toThrow();
    expect(f.callbacks.refused).toHaveBeenCalledTimes(1); const error = f.callbacks.refused.mock.calls[0][0];
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([commit, restore]);
    expect(f.canvas.captured).toBe(false); expect(f.state.mutations).toBe(0);
  });
  it("does not retry or roll back when acknowledgement fails after a caller mutation", () => {
    const f = fixture(), failure = Error("reply lost after accepted command");
    f.callbacks.commit.mockImplementation(() => { f.state.authority = "committed"; f.state.mutations++; throw failure; }); f.start();
    expect(() => f.canvas.emit("pointerup")).not.toThrow(); f.canvas.emit("pointerup"); f.binder.dispose();
    expect(f.state).toEqual({ authority: "committed", view: "committed", mutations: 1 });
    expect(f.callbacks.commit).toHaveBeenCalledTimes(1); expect(f.callbacks.cancel).toHaveBeenCalledTimes(1);
    expect(f.callbacks.refused).toHaveBeenCalledExactlyOnceWith(failure);
  });
  it("restores from the latest caller authority after the caller rejects an obsolete source", () => {
    const f = fixture(), failure = Error("source owner changed");
    const captured = f.state.authority;
    f.callbacks.commit.mockImplementation(() => { if (f.state.authority !== captured) throw failure; }); f.start();
    f.state.authority = "replacement project";
    expect(() => f.canvas.emit("pointerup")).not.toThrow();
    expect(f.state).toEqual({ authority: "replacement project", view: "replacement project", mutations: 0 });
    expect(f.callbacks.refused).toHaveBeenCalledExactlyOnceWith(failure);
  });
  it("can perform a fresh drag after rejection without replaying the rejected one", () => {
    const f = fixture(); f.callbacks.commit.mockImplementationOnce(() => { throw Error("rejected"); }); f.start();
    expect(() => f.canvas.emit("pointerup")).not.toThrow(); f.start(); f.canvas.emit("pointerup");
    expect(f.state.mutations).toBe(1); expect(f.callbacks.commit).toHaveBeenCalledTimes(2);
    expect(f.callbacks.refused).toHaveBeenCalledTimes(1); expect(f.callbacks.cancel).toHaveBeenCalledTimes(1);
  });
  it("does not restore or report the rejection again on disposal", () => {
    const f = fixture(); f.callbacks.commit.mockImplementation(() => { throw Error("rejected"); }); f.start();
    expect(() => f.canvas.emit("pointerup")).not.toThrow(); f.binder.dispose(); f.binder.dispose();
    expect(f.callbacks.cancel).toHaveBeenCalledTimes(1); expect(f.callbacks.refused).toHaveBeenCalledTimes(1);
    expect(f.canvas.captured).toBe(false); expect(f.canvas.tabIndex).toBe(-1); expect(f.canvas.style.touchAction).toBe("pan-y");
  });
});

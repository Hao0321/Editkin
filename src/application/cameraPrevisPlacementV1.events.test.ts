import { afterEach, describe, expect, it, vi } from "vitest";
import { bindCameraPrevisObjectDragV1, type prepareCameraPrevisPlacementV1 } from "./cameraPrevisPlacementV1";

// Synchronous event surface for lifetime faults. Real pointer capture, GPU and
// ordinary history are independently exercised by the source browser journey.
class Surface {
  style = { touchAction: "pan-y" }; tabIndex = -1; width = 640; height = 360; captured = false;
  handlers = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const set = this.handlers.get(type) ?? new Set(); set.add(listener); this.handlers.set(type, set);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) { this.handlers.get(type)?.delete(listener); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  setPointerCapture() { this.captured = true; }
  hasPointerCapture() { return this.captured; }
  releasePointerCapture() { this.captured = false; }
  focus() {}
  listeners() { return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0); }
  emit(type: string, values: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerId: 7, button: 0, isPrimary: true, clientX: 100, clientY: 100, ...values }).map(([key, value]) => [key, { value }])));
    for (const listener of [...this.handlers.get(type) ?? []]) {
      if (typeof listener === "function") listener(event); else listener.handleEvent(event);
    }
  }
}
function fixture() {
  const canvas = new Surface(), win = new Surface(), frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("window", win);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  // Placement is an opaque dependency here; existing ray/planner tests and the
  // real browser cover its scene and geometry contract, rather than this double.
  const plan = Object.freeze({}) as ReturnType<ReturnType<typeof prepareCameraPrevisPlacementV1>["move"]>;
  const placement = { pick: () => "hero", ground: () => [0, 0, 0] as [number, number, number], move: () => plan };
  const callbacks = { preview: vi.fn(), commit: vi.fn(), cancel: vi.fn(), refused: vi.fn() };
  const bind = () => bindCameraPrevisObjectDragV1(canvas as unknown as HTMLCanvasElement, () => placement, callbacks);
  const binder = bind();
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
  const start = () => { canvas.emit("pointerdown"); canvas.emit("pointermove", { clientX: 120 }); frame(); };
  return { canvas, win, callbacks, binder, bind, frame, start, frames, plan };
}
afterEach(() => vi.unstubAllGlobals());
describe("previs drag event lifetime and failure cleanup", () => {
  it("coalesces preview and commits exactly once on release", () => {
    const f = fixture(); f.start();
    f.canvas.emit("pointermove", { clientX: 130 }); f.canvas.emit("pointermove", { clientX: 140 }); f.frame();
    expect(f.callbacks.preview).toHaveBeenCalledTimes(2); expect(f.callbacks.commit).not.toHaveBeenCalled();
    f.canvas.emit("pointerup", { clientX: 140 });
    expect(f.callbacks.commit).toHaveBeenCalledExactlyOnceWith(f.plan); expect(f.callbacks.refused).not.toHaveBeenCalled();
    f.binder.dispose(); expect(f.canvas.listeners() + f.win.listeners()).toBe(0);
  });
  it.each(["width", "height"] as const)("cancels safely when the viewport has zero %s", axis => {
    const f = fixture(); f.start(); f.canvas[axis] = 0;
    expect(() => f.canvas.emit(axis === "width" ? "pointermove" : "pointerup", { clientX: 140 })).not.toThrow();
    expect(f.callbacks.cancel).toHaveBeenCalledTimes(1); expect(f.callbacks.refused).toHaveBeenCalledTimes(1);
    expect(String(f.callbacks.refused.mock.calls[0][0])).toContain("PREVIS_VIEWPORT_HIDDEN");
    expect(f.canvas.captured).toBe(false); expect(f.frames.size).toBe(0);
    f.canvas.emit("pointerup", { clientX: 140 }); expect(f.callbacks.commit).not.toHaveBeenCalled(); f.binder.dispose();
  });
  it.each(["Escape", "pointercancel", "lostpointercapture", "blur"])("routes a failed restore during %s without an uncaught event error", kind => {
    const f = fixture(); f.start(); const error = Error("restore failed"); f.callbacks.cancel.mockImplementation(() => { throw error; });
    expect(() => kind === "blur" ? f.win.emit("blur") : f.canvas.emit(kind === "Escape" ? "keydown" : kind, { key: "Escape" })).not.toThrow();
    expect(f.callbacks.refused).toHaveBeenCalledExactlyOnceWith(error); expect(f.callbacks.commit).not.toHaveBeenCalled();
    expect(f.canvas.captured).toBe(false); f.binder.dispose(); expect(f.canvas.listeners() + f.win.listeners()).toBe(0);
  });
  it("reports both preview and restore failures and leaves no active gesture", () => {
    const f = fixture(), preview = Error("preview failed"), restore = Error("restore failed");
    f.callbacks.preview.mockImplementation(() => { throw preview; }); f.callbacks.cancel.mockImplementation(() => { throw restore; });
    f.canvas.emit("pointerdown"); f.canvas.emit("pointermove", { clientX: 120 }); expect(f.frame).not.toThrow();
    expect(f.callbacks.refused).toHaveBeenCalledTimes(1); const error = f.callbacks.refused.mock.calls[0][0];
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([preview, restore]);
    expect(f.canvas.captured).toBe(false); expect(f.frames.size).toBe(0); f.canvas.emit("pointerup"); expect(f.callbacks.commit).not.toHaveBeenCalled(); f.binder.dispose();
  });
  it("always tears down listeners and interaction properties when dispose restore throws", () => {
    const f = fixture(); f.start(); const error = Error("restore failed"); f.callbacks.cancel.mockImplementation(() => { throw error; });
    expect(() => f.binder.dispose()).toThrow(error);
    expect(f.canvas.listeners() + f.win.listeners()).toBe(0); expect(f.canvas.style.touchAction).toBe("pan-y"); expect(f.canvas.tabIndex).toBe(-1);
    expect(f.canvas.captured).toBe(false); expect(f.frames.size).toBe(0); expect(() => f.binder.dispose()).not.toThrow();
    expect(f.callbacks.cancel).toHaveBeenCalledTimes(1); expect(f.callbacks.commit).not.toHaveBeenCalled();
  });
  it("can rebind the same canvas after a failed disposal without inheriting leaked settings", () => {
    const f = fixture(); f.start(); f.callbacks.cancel.mockImplementation(() => { throw Error("restore failed"); });
    expect(() => f.binder.dispose()).toThrow("restore failed"); f.callbacks.cancel.mockReset(); const second = f.bind(); second.dispose();
    expect(f.canvas.listeners() + f.win.listeners()).toBe(0); expect(f.canvas.style.touchAction).toBe("pan-y"); expect(f.canvas.tabIndex).toBe(-1);
  });
});

import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { INTERNAL_ASSET_POINTER_DRAG_EVENT, isInternalAssetPointerDragDetail, resolveTimelineImportPlacement,
  startInternalAssetPointerDrag, type InternalAssetPointerDragDetail } from "./internalAssetPointerDrag";

// Explicit EventTarget/geometry adapter: controller ownership and coordinates,
// not a claim that a browser or Windows native input was observed.
function pointer(type: string, values: Partial<PointerEvent> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), { pointerId: 7, clientX: 20, clientY: 30, altKey: false, ...values }) as PointerEvent;
}
function fixture() {
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { defaultView: window });
  const captured = new Set<number>(), details: InternalAssetPointerDragDetail[] = [];
  const scope: EventTarget & { contains: (node: unknown) => boolean } = Object.assign(new EventTarget(), { contains: (node: unknown) => node === source });
  const source = Object.assign(new EventTarget(), { ownerDocument: document as unknown as Document, isConnected: true,
    closest: (selector: string) => selector === ".app-shell" ? scope : null,
    setPointerCapture: vi.fn((id: number) => { captured.add(id); }), hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn<(id: number) => void>() });
  source.releasePointerCapture.mockImplementation((id: number) => { captured.delete(id); source.dispatchEvent(pointer("lostpointercapture", { pointerId: id })); });
  scope.addEventListener(INTERNAL_ASSET_POINTER_DRAG_EVENT, event => details.push((event as CustomEvent<InternalAssetPointerDragDetail>).detail));
  const event = { button: 0, pointerId: 7, clientX: 20, clientY: 30, altKey: false, currentTarget: source, target: source,
    preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as ReactPointerEvent<HTMLElement>;
  const onStart = vi.fn(), onEnd = vi.fn();
  const start = () => startInternalAssetPointerDrag(event, { assetId: "actual-asset", onStart, onEnd });
  return { window, document, scope, source, details, event, onStart, onEnd, start, captured };
}

describe("internal asset pointer controller ownership", () => {
  it("publishes a real asset and final captured point with Alt without DataTransfer", () => {
    const f = fixture(); f.start();
    f.document.dispatchEvent(pointer("pointermove", { pointerId: 8, clientX: 900 }));
    f.document.dispatchEvent(pointer("pointermove", { clientX: 24, clientY: 32, altKey: true }));
    f.document.dispatchEvent(pointer("pointerup", { clientX: 420, clientY: 280, altKey: true }));
    expect(f.details.map(detail => detail.phase)).toEqual(["start", "move", "drop"]);
    expect(f.details.at(-1)).toMatchObject({ assetId: "actual-asset", pointerId: 7, clientX: 420, clientY: 280, moved: true, altKey: true });
    expect(f.details.every(isInternalAssetPointerDragDetail)).toBe(true);
    expect(isInternalAssetPointerDragDetail({ ...f.details[0] })).toBe(false);
    expect(f.onStart).toHaveBeenCalledExactlyOnceWith("actual-asset");
    expect(f.onEnd).toHaveBeenCalledTimes(1);
    expect(f.captured.size).toBe(0);
    f.document.dispatchEvent(pointer("pointerup")); f.window.dispatchEvent(new Event("blur"));
    expect(f.details).toHaveLength(3);
  });
  it.each(["cleanup", "escape", "blur", "pointercancel", "lostpointercapture", "detach"] as const)("cancels %s and removes all active listeners", reason => {
    const f = fixture(), cleanup = f.start()!;
    if (reason === "cleanup") cleanup();
    if (reason === "escape") f.document.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
    if (reason === "blur") f.window.dispatchEvent(new Event("blur"));
    if (reason === "pointercancel") f.document.dispatchEvent(pointer("pointercancel"));
    if (reason === "lostpointercapture") f.source.dispatchEvent(pointer("lostpointercapture"));
    if (reason === "detach") { f.source.isConnected = false; f.document.dispatchEvent(pointer("pointermove")); }
    f.document.dispatchEvent(pointer("pointermove", { clientX: 900 })); cleanup();
    expect(f.details.map(detail => detail.phase)).toEqual(["start", "cancel"]);
    expect(f.onEnd).toHaveBeenCalledTimes(1); expect(f.captured.size).toBe(0);
  });
  it("replaces only the active document session and leaves clicks below threshold unmoved", () => {
    const f = fixture(); f.start(); const cleanup = f.start()!;
    f.document.dispatchEvent(pointer("pointerup", { clientX: 21, clientY: 30 })); cleanup();
    expect(f.details.map(detail => detail.phase)).toEqual(["start", "cancel", "start", "drop"]);
    expect(f.details.at(-1)?.moved).toBe(false);
    expect(f.details[0]?.sessionId).not.toBe(f.details[2]?.sessionId); expect(f.onEnd).toHaveBeenCalledTimes(2);
  });
  it("rejects controls, detached or foreign scope sources and failed capture before callbacks", () => {
    const f = fixture();
    (f.event as unknown as { button: number }).button = 1; expect(f.start()).toBeUndefined();
    (f.event as unknown as { button: number }).button = 0;
    const control = { closest: () => ({}) }; (f.event as unknown as { target: unknown }).target = control;
    expect(f.start()).toBeUndefined(); (f.event as unknown as { target: unknown }).target = f.source;
    f.source.isConnected = false; expect(f.start()).toBeUndefined(); f.source.isConnected = true;
    const closest = f.source.closest; f.source.closest = () => null; expect(f.start()).toBeUndefined(); f.source.closest = closest;
    f.source.setPointerCapture.mockImplementation(() => { throw Error("capture unavailable"); });
    expect(f.start()).toBeUndefined(); expect(f.onStart).not.toHaveBeenCalled(); expect(f.details).toEqual([]);
  });
});

function rect(left: number, top: number, right: number, bottom: number): DOMRect { return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect; }
function placementFixture() {
  const lane = { dataset: { trackId: "video-second", trackKind: "video", trackLocked: "false" }, getBoundingClientRect: () => rect(100, 235, 900, 350) };
  const viewport = { dataset: { timelinePixelsPerSecond: "80", timelineFps: "30" }, scrollLeft: 160,
    clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 400,
    getBoundingClientRect: () => rect(100, 200, 900, 600), querySelector: () => ({ getBoundingClientRect: () => rect(100, 200, 900, 235) }), querySelectorAll: () => [lane] };
  const shell = { getBoundingClientRect: () => rect(0, 100, 1000, 700), querySelector: () => viewport as unknown };
  const document = { querySelectorAll: () => [shell] } as unknown as Document;
  return { lane, viewport, shell, document, point: { clientX: 408, clientY: 260 } };
}
describe("external import placement from the owned live timeline", () => {
  it("captures the hovered second lane, scroll offset, label width and exact project frame", () => {
    const f = placementFixture(), placement = resolveTimelineImportPlacement(f.point, f.document)!;
    expect(placement).toEqual({ trackId: "video-second", trackKind: "video", timelineStart: 3.5 });
    expect(Object.isFrozen(placement)).toBe(true);
    f.viewport.dataset.timelineFps = String(30000 / 1001);
    expect(resolveTimelineImportPlacement(f.point, f.document)!.timelineStart * (30000 / 1001)).toBeCloseTo(105, 8);
  });
  it("returns append intent only outside the actual timeline shell", () => {
    const f = placementFixture(); expect(resolveTimelineImportPlacement({ clientX: 1001, clientY: 260 }, f.document)).toBeUndefined();
  });
  it("excludes borders and scrollbars while using the true client content origin", () => {
    const f = placementFixture(); f.viewport.clientLeft = 2; f.viewport.clientTop = 2; f.viewport.clientWidth = 780; f.viewport.clientHeight = 380;
    expect(resolveTimelineImportPlacement(f.point, f.document)!.timelineStart).toBeCloseTo(3.466666666666667);
    expect(() => resolveTimelineImportPlacement({ clientX: 890, clientY: 260 }, f.document)).toThrow("捲軸");
    expect(() => resolveTimelineImportPlacement({ clientX: 408, clientY: 590 }, f.document)).toThrow("捲軸");
  });
  it.each(["label", "toolbar", "ruler", "locked", "caption", "missing-scale", "missing-viewport", "bad-point"])("rejects %s rather than silently appending", mode => {
    const f = placementFixture();
    if (mode === "label") f.point.clientX = 180;
    if (mode === "toolbar") f.point.clientY = 150;
    if (mode === "ruler") f.point.clientY = 220;
    if (mode === "locked") f.lane.dataset.trackLocked = "true";
    if (mode === "caption") f.lane.dataset.trackKind = "caption";
    if (mode === "missing-scale") f.viewport.dataset.timelinePixelsPerSecond = "NaN";
    if (mode === "missing-viewport") f.shell.querySelector = () => null;
    if (mode === "bad-point") f.point.clientX = Number.NaN;
    expect(() => resolveTimelineImportPlacement(f.point, f.document)).toThrow();
  });
});

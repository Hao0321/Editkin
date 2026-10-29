import { beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (value: unknown) => hooks.refs[hooks.cursor++] ??= { current: value },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
import { useTimelineViewRequest, type TimelineViewRequest, type TimelineViewRequestHost } from "./timelineViewRequests";
import { TIMELINE_ZOOM_IN, TIMELINE_ZOOM_OUT } from "./TimelineZoomControl";

beforeEach(() => { hooks.refs = []; hooks.cursor = 0; hooks.effects = []; });
function owner() {
  return { busy: () => false, simpleMode: false, zoom: vi.fn(), fit: vi.fn(), frames: vi.fn(), toggleSnap: vi.fn() };
}
function render(request: TimelineViewRequest | undefined, host: TimelineViewRequestHost) {
  hooks.cursor = 0;
  hooks.effects = [];
  useTimelineViewRequest(request, host);
  for (const effect of hooks.effects) effect();
}

describe("B1 view requests across renders and project changes", () => {
  it("one nonce runs once and subsequent presses use the existing zoom factors", () => {
    const host = owner();
    render({ kind: "zoom-in", nonce: 1 }, host);
    render({ kind: "zoom-in", nonce: 1 }, host);
    render({ kind: "zoom-out", nonce: 2 }, host);
    expect(host.zoom.mock.calls).toEqual([[TIMELINE_ZOOM_IN], [TIMELINE_ZOOM_OUT]]);
    render({ kind: "fit", nonce: 3 }, host);
    expect(host.fit).toHaveBeenCalledOnce();
  });

  it("a new project's first shortcut still works when its nonce restarts at one", () => {
    const host = owner();
    render({ kind: "fit", nonce: 1 }, host);
    render(undefined, host);
    render({ kind: "fit", nonce: 1 }, host);
    expect(host.fit).toHaveBeenCalledTimes(2);
  });

  it("an ignored zoom during a captured drag does not unexpectedly run when dragging ends", () => {
    const host = owner();
    render({ kind: "zoom-in", nonce: 1 }, { ...host, busy: () => true });
    render({ kind: "zoom-in", nonce: 1 }, host);
    expect(host.zoom).not.toHaveBeenCalled();
    render({ kind: "zoom-in", nonce: 2 }, host);
    expect(host.zoom).toHaveBeenCalledOnce();
  });

  it("N keeps simple mode snapping enabled and toggles snapping only in advanced mode", () => {
    const host = owner();
    render({ kind: "toggle-snap", nonce: 1 }, { ...host, simpleMode: true });
    expect(host.toggleSnap).not.toHaveBeenCalled();
    render({ kind: "toggle-snap", nonce: 2 }, host);
    expect(host.toggleSnap).toHaveBeenCalledOnce();
  });
});

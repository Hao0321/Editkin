import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";
import { TimelineRulerMarkers } from "./TimelineRulerMarkers";
vi.mock("react", async load => ({ ...await load<typeof import("react")>(), useRef: (value: unknown) => ({ current: value }), useState: () => [undefined, vi.fn()] }));
afterEach(() => vi.unstubAllGlobals());
const marker = { id: "m", time: 2, title: "Marker", note: "", kind: "note" as const, status: "open" as const, createdAt: "2026-10-11T00:00:00Z" };
function render() {
  const command = vi.fn(), seek = vi.fn(), edit = vi.fn();
  const elements = TimelineRulerMarkers({ markers: [marker], pixelsPerSecond: 80, fps: 30, duration: 12, onCommand: command, onSeek: seek, onEditStart: edit });
  const element = elements[0]; if (!isValidElement(element)) throw new Error("missing marker");
  const props = element.props as import("react").ButtonHTMLAttributes<HTMLButtonElement>, node = { style: { left: "160px" }, focus: vi.fn(), setPointerCapture: vi.fn() };
  const event = (x: number) => ({ button: 0, pointerId: 1, clientX: x, currentTarget: node, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as import("react").PointerEvent<HTMLButtonElement>;
  return { command, seek, props, node, event };
}
describe("ruler markers", () => {
  it("commits a frame-aligned drag exactly once and suppresses the post-drag seek", () => {
    const { props, command, seek, event } = render(); props.onPointerDown!(event(160)); props.onPointerMove!(event(241)); props.onPointerUp!(event(241));
    expect(command).toHaveBeenCalledTimes(1); expect(command.mock.calls[0][0]).toMatchObject({ type: "update_director_marker", markerId: "m", patch: { time: 3 } });
    props.onClick!({ stopPropagation: vi.fn() } as unknown as import("react").MouseEvent<HTMLButtonElement>); expect(seek).not.toHaveBeenCalled();
  });
  it("cancels a captured drag without an edit and lets a plain click seek", () => {
    const { props, command, seek, node, event } = render(); props.onPointerDown!(event(160)); props.onPointerMove!(event(240)); props.onPointerCancel!(event(240));
    expect(command).not.toHaveBeenCalled(); expect(node.style.left).toBe("160px");
    const click = { stopPropagation: vi.fn() } as unknown as import("react").MouseEvent<HTMLButtonElement>;
    props.onClick!(click); props.onClick!(click); expect(seek).toHaveBeenCalledWith(2);
  });
  it("renames and deletes through the command runner and consumes Delete before editor shortcuts", () => {
    const { props, command } = render(); vi.stubGlobal("window", { prompt: vi.fn(() => "Renamed") });
    props.onDoubleClick!({ stopPropagation: vi.fn() } as unknown as import("react").MouseEvent<HTMLButtonElement>);
    expect(command.mock.calls[0][0]).toMatchObject({ type: "update_director_marker", patch: { title: "Renamed" } });
    const event = { key: "Delete", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as import("react").KeyboardEvent<HTMLButtonElement>;
    props.onKeyDown!(event); expect(command.mock.calls[1][0]).toEqual({ type: "delete_director_marker", markerId: "m" }); expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

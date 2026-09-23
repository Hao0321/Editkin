import { describe, expect, it, vi } from "vitest";
import { scrollViewportByWheel } from "./wheelScroll";

const viewport = () => ({ scrollLeft: 0, scrollTop: 0, scrollWidth: 1200, scrollHeight: 1600, clientWidth: 300, clientHeight: 400 });
const event = (patch = {}) => ({ deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...patch });

describe("native wheel scroll ownership", () => {
  it("moves horizontal preset rails and consumes exactly one wheel action", () => {
    const node = viewport(), input = event();
    expect(scrollViewportByWheel(node, input, "horizontal")).toBe(true);
    expect(node.scrollLeft).toBe(80); expect(node.scrollTop).toBe(0);
    expect(input.preventDefault).toHaveBeenCalledTimes(1); expect(input.stopPropagation).toHaveBeenCalledTimes(1);
  });
  it.each([[1, 3, 48], [2, 1, 400]])("converts delta mode %s to pixels", (deltaMode, deltaY, expected) => {
    const node = viewport();
    scrollViewportByWheel(node, event({ deltaMode, deltaY }), "vertical");
    expect(node.scrollTop).toBe(expected);
  });
  it("uses the horizontal trackpad axis without also scrolling vertically", () => {
    const node = viewport();
    expect(scrollViewportByWheel(node, event({ deltaX: 150, deltaY: 2 }), "vertical")).toBe(false);
    expect(scrollViewportByWheel(node, event({ deltaX: 150, deltaY: 2 }), "horizontal")).toBe(true);
    expect(node.scrollLeft).toBe(150); expect(node.scrollTop).toBe(0);
  });
  it("clamps overshoot and lets the outer panel scroll at the edge", () => {
    const node = viewport(); node.scrollLeft = 880;
    expect(scrollViewportByWheel(node, event(), "horizontal")).toBe(true); expect(node.scrollLeft).toBe(900);
    const input = event(); expect(scrollViewportByWheel(node, input, "horizontal")).toBe(false);
    expect(input.preventDefault).not.toHaveBeenCalled(); expect(input.stopPropagation).not.toHaveBeenCalled();
  });
  it.each([{ ctrlKey: true }, { metaKey: true }, { deltaY: NaN }, { deltaY: 0 }, { deltaMode: 8 }])("leaves zoom and invalid input untouched: %j", patch => {
    const node = viewport(), input = event(patch);
    expect(scrollViewportByWheel(node, input, "horizontal")).toBe(false);
    expect(node.scrollLeft).toBe(0); expect(input.preventDefault).not.toHaveBeenCalled();
  });
  it("does not trap a viewport with no overflow", () => {
    const node = viewport(); node.scrollHeight = 200;
    expect(scrollViewportByWheel(node, event(), "vertical")).toBe(false);
  });
});

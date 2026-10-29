import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineRangeOverlay } from "./TimelineRangeOverlay";

describe("frame range on the ruler and lanes", () => {
  it("uses the same in/out positions and declared ruler/track styles without labels", () => {
    const ruler = renderToStaticMarkup(<TimelineRangeOverlay range={{ in: 2, out: 4 }} pixelsPerSecond={80} ruler />);
    const lane = renderToStaticMarkup(<TimelineRangeOverlay range={{ in: 2, out: 4 }} pixelsPerSecond={80} />);
    expect(ruler).toContain('left:160px;width:160px'); expect(lane).toContain('left:160px;width:160px');
    expect(ruler).toContain("on-ruler"); expect(lane).toContain("on-track"); expect(ruler).not.toMatch(/<span|<label/);
  });
  it("shows each available boundary alone, shading only a complete positive range", () => {
    expect(renderToStaticMarkup(<TimelineRangeOverlay range={{ in: 2 }} pixelsPerSecond={80} ruler />)).toContain('timeline-range-in');
    expect(renderToStaticMarkup(<TimelineRangeOverlay range={{ in: 4, out: 2 }} pixelsPerSecond={80} />)).not.toContain('timeline-mark-range');
    expect(renderToStaticMarkup(<TimelineRangeOverlay pixelsPerSecond={80} />)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { trackMenuPosition } from "./trackMenuPosition";

describe("track menu escapes clipped timeline viewport", () => {
  it("opens below the first row, not under the ruler", () => {
    expect(trackMenuPosition({ left: 146, top: 580, bottom: 612 }, 1280, 900)).toMatchObject({ left: 146, top: 616 });
  });
  it("opens above a bottom track and fits the right edge", () => {
    const result = trackMenuPosition({ left: 1250, top: 660, bottom: 692 }, 1280, 720);
    expect(result.top).toBe(510);
    expect(result.left + result.width).toBe(1272);
  });
  it("bounds partially scrolled anchors and tiny windows", () => {
    const result = trackMenuPosition({ left: -50, top: -30, bottom: 2 }, 180, 120);
    expect(result).toEqual({ left: 8, top: 8, width: 164, maxHeight: 104 });
  });
});

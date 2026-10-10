import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionFontSelection } from "../typography/motionFontReadiness";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import MotionOverlay from "./MotionOverlay";

const requests = vi.hoisted(() => [] as MotionFontSelection[]);
vi.mock("./useMotionFontReadiness", () => ({ useMotionFontReadiness: (selection: MotionFontSelection) => {
  requests.push(selection);
  return { selectionKey: selection.selectionKey, status: "pending", face: selection.face };
} }));

beforeEach(() => { requests.length = 0; });
describe("Motion font boundary wiring with a pending hook adapter (no browser or SSR readiness proof)", () => {
  it("mounts the same font request before a future v1 title is visible and emits no offscreen placeholder", () => {
    const project = createEmptyProject("Preload v1", { width: 1920, height: 1080, fps: 30 });
    project.motionGraphics = [createMotionGraphic("future", "title", "Future title", 5, 3, undefined, legacyMotionGraphicSeed("title"))];
    const hidden = renderToStaticMarkup(<MotionOverlay project={project} playhead={0} trackingSelectionEnabled={false} />);
    expect(hidden).toBe(""); expect(requests).toHaveLength(1);
    const key = requests[0].selectionKey;
    expect(requests[0]).toMatchObject({ text: "Future title", face: { fontFamily: "EditkinFace noto-sans-tc 700" } });
    const visible = renderToStaticMarkup(<MotionOverlay project={project} playhead={6} trackingSelectionEnabled={false} />);
    expect(requests[1].selectionKey).toBe(key);
    expect(visible).toContain('data-motion-font-status="pending"'); expect(visible).not.toContain("Future title");
  });

  it("preloads future v2 text with distinct physical selections while a future vector requests no font", () => {
    const project = createEmptyProject("Preload v2", { width: 1920, height: 1080, fps: 30 });
    const sans = createMotionGraphic("sans", "title", "Promise", 5, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    // Desktop delivery now leases only the current interval/next five seconds.
    const serif = createMotionGraphic("serif", "title", "Payoff", 4, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    serif.fontFamily = "Noto Serif TC"; serif.fontWeight = 700;
    const vector = createMotionGraphic("vector", "card", "", 5, 3, undefined, findMotionGraphicPreset("reel_native_disc").seed);
    vector.fontFamily = "Unverified custom font"; project.motionGraphics = [sans, serif, vector];
    expect(renderToStaticMarkup(<MotionOverlay project={project} playhead={0} trackingSelectionEnabled={false} />)).toBe("");
    expect(requests).toHaveLength(2);
    expect(requests.map(row => row.face?.fontFamily)).toEqual(["EditkinFace noto-sans-tc 850", "EditkinFace noto-serif-tc 700"]);
    const oldKey = requests[0].selectionKey; sans.fontWeight = 700;
    renderToStaticMarkup(<MotionOverlay project={project} playhead={0} trackingSelectionEnabled={false} />);
    expect(requests[2].selectionKey).not.toBe(oldKey);
    expect(requests[2].face?.fontFamily).toBe("EditkinFace noto-sans-tc 700");
  });
});

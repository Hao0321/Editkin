import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionFontSelection, MotionFontStatus } from "../typography/motionFontReadiness";
import { createEmptyProject } from "../domain/editGraph";
import { createMotionGraphic, legacyMotionGraphicSeed } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import MotionOverlay from "./MotionOverlay";

const adapter = vi.hoisted(() => ({ requests: [] as MotionFontSelection[], priorities: [] as string[], status: "pending" as MotionFontStatus, reason: undefined as string | undefined }));
vi.mock("./useMotionFontReadiness", () => ({ useMotionFontReadiness: (selection: MotionFontSelection, priority: string) => {
  adapter.requests.push(selection); adapter.priorities.push(priority);
  return { selectionKey: selection.selectionKey, status: adapter.status, reason: adapter.reason, face: selection.face };
} }));
beforeEach(() => { adapter.requests.length = 0; adapter.priorities.length = 0; adapter.status = "pending"; adapter.reason = undefined; });
function markup(project: ReturnType<typeof createEmptyProject>, playhead: number) {
  return renderToStaticMarkup(<MotionOverlay project={project} playhead={playhead} trackingSelectionEnabled={false} />);
}

describe("selected desktop font consumer admission (hook adapters; no mounted browser proof)", () => {
  it("mounts a title at exactly five seconds and excludes farther titles without an offscreen placeholder", () => {
    const project = createEmptyProject("Five seconds", { width: 1920, height: 1080, fps: 30 });
    project.motionGraphics = [createMotionGraphic("near", "title", "NEAR", 5, 3), createMotionGraphic("far", "title", "FAR", 5.01, 3)];
    expect(markup(project, 0)).toBe(""); expect(adapter.requests.map(row => row.text)).toEqual(["NEAR"]);
  });

  it("moves the bounded font window with timeline seek and remounts reentered text", () => {
    const project = createEmptyProject("Seek", { width: 1920, height: 1080, fps: 30 });
    project.motionGraphics = [createMotionGraphic("first", "title", "FIRST", 0, 3),
      createMotionGraphic("second", "title", "SECOND", 9, 3), createMotionGraphic("late", "title", "LATE", 300, 3)];
    markup(project, 1); expect(adapter.requests.map(row => row.text)).toEqual(["FIRST"]);
    adapter.requests.length = 0; expect(markup(project, 6)).toBe(""); expect(adapter.requests.map(row => row.text)).toEqual(["SECOND"]);
    adapter.requests.length = 0; markup(project, 10); expect(adapter.requests.map(row => row.text)).toEqual(["SECOND"]);
    adapter.requests.length = 0; expect(markup(project, 100)).toBe(""); expect(adapter.requests).toHaveLength(0);
    adapter.requests.length = 0; markup(project, 301); expect(adapter.requests.map(row => row.text)).toEqual(["LATE"]);
    adapter.requests.length = 0; markup(project, 1); expect(adapter.requests.map(row => row.text)).toEqual(["FIRST"]);
  });

  it("unmounts the font boundary at the exclusive interval end", () => {
    const project = createEmptyProject("End", { width: 1920, height: 1080, fps: 30 });
    project.motionGraphics = [createMotionGraphic("first", "title", "END", 0, 3)];
    expect(markup(project, 3)).toBe(""); expect(adapter.requests).toHaveLength(0);
  });

  it("wires visible text to current priority and preserves selection identity when lookahead enters", () => {
    const project = createEmptyProject("Priority", { width: 1920, height: 1080, fps: 30 });
    project.motionGraphics = [createMotionGraphic("current", "title", "CURRENT", 0, 3),
      createMotionGraphic("future", "title", "FUTURE", 5, 3)];
    markup(project, 1); expect(adapter.priorities).toEqual(["current", "lookahead"]);
    const futureKey = adapter.requests[1].selectionKey;
    adapter.requests.length = 0; adapter.priorities.length = 0;
    markup(project, 6); expect(adapter.priorities).toEqual(["current"]);
    expect(adapter.requests[0].selectionKey).toBe(futureKey);
  });

  it("shows an actionable delivery error for current text while keeping the text itself suppressed", () => {
    const project = createEmptyProject("Blocked", { width: 1920, height: 1080, fps: 30 });
    project.motionGraphics = [createMotionGraphic("first", "title", "UNAUTHORIZED TITLE", 0, 3)];
    adapter.status = "blocked"; adapter.reason = "此桌面版本缺少實體字型介面，請更新到支援此介面的版本後重新開啟專案";
    const html = markup(project, 1);
    expect(html).toContain('role="alert"'); expect(html).toContain("請更新"); expect(html).toContain("重新開啟專案");
    expect(html).toContain('data-motion-font-status="blocked"'); expect(html).not.toContain("UNAUTHORIZED TITLE");
  });

  it("keeps an unknown custom font explicit instead of substituting a bundled family", () => {
    const project = createEmptyProject("Custom", { width: 1920, height: 1080, fps: 30 });
    const title = createMotionGraphic("first", "title", "CUSTOM TEXT", 0, 3, undefined, legacyMotionGraphicSeed("title")); title.fontFamily = "Unknown custom"; project.motionGraphics = [title];
    adapter.status = "unverified"; adapter.reason = "字型 Unknown custom 尚未驗證";
    const html = markup(project, 1); expect(html).toContain("請選擇內建字型"); expect(html).not.toContain("CUSTOM TEXT");
    expect(adapter.requests[0].face).toBeUndefined();
  });

  it("never requests a font for a foreground vector even with an unknown font family", () => {
    const project = createEmptyProject("Vector", { width: 1920, height: 1080, fps: 30 });
    const vector = createMotionGraphic("vector", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_native_disc").seed);
    vector.fontFamily = "Unknown custom"; project.motionGraphics = [vector];
    const html = markup(project, 1); expect(html).toContain('data-motion-font-status="not-required"');
    expect(html).toContain('data-testid="motion-vector-v2"'); expect(adapter.requests).toHaveLength(0);
  });
});

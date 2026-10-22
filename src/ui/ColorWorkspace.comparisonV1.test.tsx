import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { ColorWorkspace } from "./ColorWorkspace";
import { GpuColorScopesV1 } from "./GpuColorScopesV1";
const setters = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect:()=>{}, useRef: (initial: unknown) => ({ current: initial }), useState: (initial: unknown) => { const set = vi.fn(); setters.push(set); return [initial, set]; } }));
vi.mock("./i18n/interfacePreferences", async original => ({ ...await original<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(all); if (!isValidElement(node)) return []; const e = node as Element; return [e, ...all(e.props.children)]; }
function setup(blocked = false) {
  setters.length = 0; const p = createDemoProject(), clip = p.tracks[0].clips[0]; if (blocked) clip.color.whiteBalanceRed = .5;
  const change = vi.fn(), element = ColorWorkspace({ asset: p.assets[0], clip, source: "fixture.mp4", playhead: 0, colorManagement: { ...DEFAULT_COLOR_MANAGEMENT, mode: "rec709", outputTransform: "rec709_sdr" }, onColorManagementChange: change, onColorChange: change, onInputColorSpaceChange: change, onAlphaModeChange: change, onGradeV2Change: change, onClose: () => {} });
  return { items: all(element), change };
}
describe("comparison is a local preview choice", () => {
  it("starts off and switches locally without invoking any project callback", () => {
    const { items, change } = setup(); const toggle = items.find(e => e.props["data-testid"] === "color-comparison-toggle")!;
    expect(toggle.props["aria-pressed"]).toBe(false); expect(items.find(e => e.type === GpuColorScopesV1)!.props.comparison).toBe(false);
    toggle.props.onClick(); expect(change).not.toHaveBeenCalled(); expect(setters[0]).toHaveBeenCalledWith(false); expect(setters[1]).toHaveBeenCalled();
  });
  it("keeps uncalibrated WB/HDR comparison disabled", () => {
    const { items } = setup(true); expect(items.find(e => e.props["data-testid"] === "color-comparison-toggle")!.props.disabled).toBe(true);
    expect(items.some(e => e.type === GpuColorScopesV1)).toBe(false);
  });
});

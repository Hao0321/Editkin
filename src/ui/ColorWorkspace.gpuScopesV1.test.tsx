import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { DEFAULT_COLOR, DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { ColorWorkspace } from "./ColorWorkspace";
import { GpuColorScopesV1 } from "./GpuColorScopesV1";
// Source handlers/props only; actual WebGL, readback and A/B are separate browser evidence.
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect:()=>{}, useRef: (initial: unknown) => ({ current: initial }), useState: (initial: unknown) => [initial, () => {}] }));
vi.mock("./i18n/interfacePreferences", async original => ({ ...await original<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
function all(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...all(element.props.children)];
}
function setup() {
  const p = createDemoProject(), clip = p.tracks[0].clips[0], asset = p.assets[0];
  asset.color = { interpretation: "rec709" }; clip.keyframes = []; clip.color = { ...DEFAULT_COLOR };
  const management = { ...DEFAULT_COLOR_MANAGEMENT, mode: "rec709" as "rec709" | "aces2", outputTransform: "rec709_sdr" as const };
  const render = (playhead = clip.timelineStart) => ColorWorkspace({ asset, clip, source: "fixture.mp4", playhead, colorManagement: management, onColorManagementChange: () => {}, onColorChange: () => {}, onInputColorSpaceChange: () => {}, onAlphaModeChange: () => {}, onClose: () => {} });
  return { p, clip, asset, management, render, scopes: (time?: number) => all(render(time)).find(e => e.type === GpuColorScopesV1) };
}
describe("color workspace GPU scope admission and frame wiring", () => {
  it("passes the authored v2 grade and source time to the canonical renderer scope surface", () => {
    const s = setup(); s.clip.gradeV2 = { schema: "editkin.color-grade/v2", nodes: [{ id: "test", saturation: .2 }] }; s.clip.sourceStart = 3;
    expect(s.scopes(s.clip.timelineStart + 1)!.props.grade).toBe(s.clip.gradeV2);
    expect(s.scopes(s.clip.timelineStart + 1)!.props.sourceTime).toBe(4);
  });
  it("samples animated primary values at the playhead instead of showing base values", () => {
    const s = setup(); s.clip.keyframes = [{ id: "k0", time: 0, transform: s.clip.transform, color: { ...DEFAULT_COLOR, exposure: 1 }, easing: "hold" }];
    expect(s.scopes()!.props.color.exposure).toBe(1);
  });
  it.each(["wb", "hdr", "retime", "aces"])("keeps unsupported %s measurement explicit", kind => {
    const s = setup();
    if (kind === "wb") s.clip.color.whiteBalanceRed = 1;
    if (kind === "hdr") s.asset.color = { interpretation: "hlg", primaries: "bt2020", transfer: "arib-std-b67", matrix: "bt2020nc", range: "tv" };
    if (kind === "retime") s.clip.speed = 2;
    if (kind === "aces") s.management.mode = "aces2";
    expect(s.scopes()).toBeUndefined();
    expect(all(s.render()).some(e => e.props["data-testid"] === "color-scope-unavailable")).toBe(true);
  });
});

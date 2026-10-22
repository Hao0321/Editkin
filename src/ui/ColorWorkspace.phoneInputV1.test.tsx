import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoProject } from "../domain/demo";
import { withAcesPhonePolicyV1 } from "../color/acesPhoneInputV1";
import { ColorWorkspace } from "./ColorWorkspace";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: () => {}, useRef: () => ({ current: null }), useState: (initial: unknown) => [initial, () => {}] }));
vi.mock("./i18n/interfacePreferences", async original => ({ ...await original<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement(node)) return [];
  const e = node as Element;
  return [e, ...all(e.props.children)];
}
function setup(fresh = true, interpretation: "auto" | "apple_log" = "auto", camera = false, wired = true) {
  const p = createDemoProject(), a = p.assets[0], c = p.tracks[0].clips[0];
  a.color = { interpretation };
  if (camera) c.rec709Input = "camera";
  const management = { ...p.colorManagement!, mode: "aces2" as const };
  const change = vi.fn(), assetChange = vi.fn();
  const element = ColorWorkspace({ asset: a, clip: c, colorManagement: fresh ? withAcesPhonePolicyV1(management) : management,
    playhead: 0, onColorManagementChange: vi.fn(), onColorChange: vi.fn(), onInputColorSpaceChange: assetChange, onAlphaModeChange: vi.fn(),
    onRec709InputChange: wired ? change : undefined, onClose: vi.fn() });
  return { element, change, assetChange, selector: all(element).find(e => e.props["data-testid"] === "clip-rec709-input") };
}
describe("approved per-clip phone/camera selector", () => {
  it("shows the phone default and exact approved camera choice using the existing label/select style", () => {
    const { element, selector } = setup();
    expect(selector?.props.value).toBe("display");
    const html = renderToStaticMarkup(element);
    expect(html).toContain("相機 Rec.709（場景光）");
    expect(html).toContain("手機 Rec.709（保留拍攝外觀）");
  });
  it("dispatches the clip choice without calling the asset interpretation callback", () => {
    const { selector, change, assetChange } = setup();
    selector!.props.onChange({ target: { value: "camera" } });
    expect(change).toHaveBeenCalledExactlyOnceWith("camera");
    expect(assetChange).not.toHaveBeenCalled();
    expect(setup(true, "auto", true).selector?.props.value).toBe("camera");
  });
  it("keeps legacy and actual scene Log controls unchanged", () => {
    expect(setup(false).selector).toBeUndefined();
    expect(setup(true, "apple_log").selector).toBeUndefined();
  });
  it("does not present an enabled control when the command is not wired", () => {
    expect(setup(true, "auto", false, false).selector?.props.disabled).toBe(true);
  });
});

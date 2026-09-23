import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EFFECT_PRESETS } from "../creative/corePack";
import { CreativePresetGallery } from "./PresetPreviewGallery";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useRef: () => ({ current: null }), useEffect: () => {},
  useState: (value: unknown) => [value, () => {}],
}));

function buttons(node: ReactNode): Record<string, any>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [...(child.type === "button" ? [child.props] : []), ...buttons(child.props.children)];
  });
}

describe("preset controls", () => {
  it("removes each existing transition even without a current neighbor", () => {
    const onChange = vi.fn();
    const controls = buttons(CreativePresetGallery({ duration: 3, canTransitionIn: false, canTransitionOut: false, onChange, section: "transition",
      creative: { effectPresetIds: [], transitionIn: { presetId: "luma_fade", duration: .3 }, transitionOut: { presetId: "luma_fade", duration: .3 } },
    }));
    const removals = controls.filter(item => String(item["data-testid"]).startsWith("remove-transition-"));
    expect(removals).toHaveLength(2);
    removals.forEach(item => { expect(item.disabled).not.toBe(true); item.onClick(); });
    expect(onChange.mock.calls).toEqual([[{ transitionIn: null }], [{ transitionOut: null }]]);
  });

  it("disables the fifth effect but keeps all selected effects removable", () => {
    const effects = EFFECT_PRESETS.slice(0, 4).map(item => item.id);
    const onChange = vi.fn();
    const controls = buttons(CreativePresetGallery({ duration: 3, canTransitionIn: true, canTransitionOut: true, onChange, section: "effect", creative: { effectPresetIds: effects } }));
    expect(controls.filter(item => item.disabled === false)).toHaveLength(4);
    expect(controls.filter(item => item.disabled === true).length).toBeGreaterThan(0);
    controls[0]!.onClick();
    expect(onChange).toHaveBeenCalledWith({ effectPresetIds: effects.slice(1) });
  });
});

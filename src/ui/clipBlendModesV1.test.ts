import { describe, expect, it, vi } from "vitest";
import { editorCommandSchema } from "../domain/schema";
import type { LayerBlendMode } from "../domain/types";
import { CLIP_BLEND_MODE_GROUPS_V1, CLIP_BLEND_MODES_V1, clipBlendModeCssV1, clipBlendModeLabelV1, createBlendHoverPreviewV1 } from "./clipBlendModesV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";

// P6 (2026-10-23): the 混合模式 list and its hover-preview controller.
const lease = (current = true) => {
  const calls: string[] = [];
  const value: ParameterGestureLeaseV1<LayerBlendMode> = { update: mode => { calls.push(`update:${mode}`); return true; },
    commit: () => { calls.push("commit"); return current; }, cancel: () => { calls.push("cancel"); }, isCurrent: () => current };
  return { value, calls };
};

describe("混合模式 list", () => {
  it("lists every blend mode the project accepts exactly once, grouped 一般／變暗／變亮／對比／差異", () => {
    expect(CLIP_BLEND_MODE_GROUPS_V1.map(group => group.label)).toEqual(["一般", "變暗", "變亮", "對比", "差異"]);
    expect(new Set(CLIP_BLEND_MODES_V1).size).toBe(12);
    for (const mode of CLIP_BLEND_MODES_V1) {
      expect(editorCommandSchema.safeParse({ type: "set_clip_layer", clipId: "c", patch: { blendMode: mode } }).success, mode).toBe(true);
      expect(clipBlendModeLabelV1(mode)).toMatch(/\p{Script=Han}/u);
      expect(clipBlendModeCssV1(mode)).toBeTruthy();
    }
    expect(editorCommandSchema.safeParse({ type: "set_clip_layer", clipId: "c", patch: { blendMode: "exclusion" } }).success).toBe(false);
    expect(CLIP_BLEND_MODE_GROUPS_V1.find(group => group.label === "變暗")!.modes).toEqual(["darken", "multiply", "color_burn"]);
    expect(CLIP_BLEND_MODE_GROUPS_V1.find(group => group.label === "變亮")!.modes).toEqual(["lighten", "screen", "color_dodge", "add"]);
    expect(clipBlendModeCssV1("add")).toBe("plus-lighter");
  });
});

describe("hover preview controller", () => {
  it("begins one lease for a whole hover session, previews each mode and restores on leave", () => {
    const held = lease(), begin = vi.fn(() => held.value), hover = createBlendHoverPreviewV1();
    expect(hover.hover("multiply", begin)).toBe(true); expect(hover.hover("screen", begin)).toBe(true);
    expect(begin).toHaveBeenCalledOnce(); expect(hover.previewing).toBe(true);
    hover.restore();
    expect(held.calls).toEqual(["update:multiply", "update:screen", "cancel"]); expect(hover.previewing).toBe(false);
  });
  it("commits through the lease when it is current and never sends the command twice", () => {
    const held = lease(true), fallback = vi.fn(), hover = createBlendHoverPreviewV1();
    hover.hover("overlay", () => held.value);
    expect(hover.choose("overlay", fallback)).toBe(true);
    expect(held.calls).toEqual(["update:overlay", "update:overlay", "commit"]); expect(fallback).not.toHaveBeenCalled();
  });
  it("a refused current commit stays refused (no second command); a stale lease falls back to the plain command", () => {
    const refused = lease(true); refused.value.commit = () => false;
    const hover = createBlendHoverPreviewV1(), fallback = vi.fn(() => true);
    hover.hover("darken", () => refused.value);
    expect(hover.choose("darken", fallback)).toBe(false); expect(fallback).not.toHaveBeenCalled();
    const stale = lease(false), next = createBlendHoverPreviewV1();
    next.hover("darken", () => stale.value);
    expect(next.choose("lighten", fallback)).toBe(true); expect(fallback).toHaveBeenCalledExactlyOnceWith("lighten");
    expect(stale.calls.at(-1)).toBe("cancel");
  });
  it("without a lease (locked, stale selection) hovering previews nothing and choosing sends the plain command", () => {
    const hover = createBlendHoverPreviewV1(), begin = vi.fn(() => undefined), fallback = vi.fn(() => true);
    expect(hover.hover("screen", begin)).toBe(false); expect(hover.hover("multiply", begin)).toBe(false);
    expect(begin).toHaveBeenCalledOnce();
    expect(hover.choose("multiply", fallback)).toBe(true); expect(fallback).toHaveBeenCalledExactlyOnceWith("multiply");
  });
});

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { LayerBlendMode, TimelineClip } from "../domain/types";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { ClipLayerHostV1 } from "./clipLayerHostV1";

// P6 (2026-10-23): Inspector › 調整 › 混合. The production component is called directly with indexed hook doubles (no DOM
// in this suite); its real handlers are invoked. Real React SSR in five languages is in ClipBlendControlsV1.ssr.test.tsx.
const harness = vi.hoisted(() => ({ values: [] as unknown[], index: 0, host: undefined as unknown }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = harness.index++; if (!(i in harness.values)) harness.values[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [harness.values[i], (next: unknown) => { harness.values[i] = typeof next === "function" ? (next as (old: unknown) => unknown)(harness.values[i]) : next; }]; },
  useMemo: (factory: () => unknown) => { const i = harness.index++; if (!(i in harness.values)) harness.values[i] = factory(); return harness.values[i]; },
  useRef: (current: unknown) => { const i = harness.index++; if (!(i in harness.values)) harness.values[i] = { current }; return harness.values[i]; },
  useEffect: () => {}, useId: () => "blend" }));
vi.mock("./clipLayerHostV1", () => ({ useClipLayerHostV1: () => harness.host }));
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { ClipBlendControlsV1, blendMenuPositionV1, keyframeAtPlayheadV1 } from "./ClipBlendControlsV1";

type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...all(node.props.children as ReactNode)];
}
const byTest = (tree: Element[], id: string) => tree.find(element => element.props["data-testid"] === id);
function setup(patch: Partial<ClipLayerHostV1> = {}, clipPatch: Partial<TimelineClip> = {}) {
  const project = createDemoProject(), clip = { ...project.tracks[0].clips[0], ...clipPatch };
  project.tracks[0].clips[0] = clip;
  const leaseCalls: string[] = [];
  const lease: ParameterGestureLeaseV1<LayerBlendMode> = { update: mode => { leaseCalls.push(`update:${mode}`); return true; }, commit: () => { leaseCalls.push("commit"); return true; },
    cancel: () => { leaseCalls.push("cancel"); }, isCurrent: () => true };
  const host: ClipLayerHostV1 = { project, clipId: clip.id, playhead: 3, fps: 30, opacity: 1, onLayerChange: vi.fn(() => true), onOpacityChange: vi.fn(() => true),
    beginBlendGesture: vi.fn(() => lease), onAddKeyframe: vi.fn(), onDeleteKeyframe: vi.fn(), ...patch };
  harness.host = host; harness.values = [];
  const render = () => { harness.index = 0; return all(ClipBlendControlsV1({ clip })); };
  return { host, clip, project, leaseCalls, render };
}
const event = (patch: Record<string, unknown> = {}) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...patch });
beforeEach(() => { harness.values = []; harness.index = 0; });

describe("調整 › 混合 row", () => {
  it("shows 混合模式, 不透明度 (slider and number) and ◆ for the selected clip only", () => {
    const f = setup(), tree = f.render();
    expect(byTest(tree, "clip-blend-controls")).toBeDefined();
    expect(byTest(tree, "clip-blend-mode")!.props["data-blend-mode"]).toBe("normal");
    expect(byTest(tree, "clip-opacity-slider")!.props.value).toBe(100);
    expect(byTest(tree, "clip-opacity-keyframe")).toBeDefined();
    harness.host = { ...f.host, clipId: "another" }; harness.index = 0;
    expect(ClipBlendControlsV1({ clip: f.clip })).toBeNull();
  });

  it("opens the list in two actions from a selected clip; hovering previews, leaving restores, nothing is committed", () => {
    const f = setup();
    byTest(f.render(), "clip-blend-mode")!.props.onClick();
    const open = f.render(), list = byTest(open, "clip-blend-menu")!;
    const options = open.filter(element => element.props.role === "option");
    expect(options.map(option => option.props["data-blend-mode"])).toEqual(["normal", "darken", "multiply", "color_burn", "lighten", "screen", "color_dodge", "add", "overlay", "soft_light", "hard_light", "difference"]);
    expect(open.filter(element => element.props.role === "group")).toHaveLength(5);
    byTest(open, "clip-blend-option-multiply")!.props.onPointerEnter();
    byTest(f.render(), "clip-blend-option-screen")!.props.onPointerEnter();
    expect(f.host.beginBlendGesture).toHaveBeenCalledOnce();
    list.props.onPointerLeave();
    expect(f.leaseCalls).toEqual(["update:multiply", "update:screen", "cancel"]);
    expect(f.host.onLayerChange).not.toHaveBeenCalled();
  });

  it("commits the clicked mode once through the preview lease and closes the list", () => {
    const f = setup();
    byTest(f.render(), "clip-blend-mode")!.props.onClick();
    byTest(f.render(), "clip-blend-option-multiply")!.props.onPointerEnter();
    byTest(f.render(), "clip-blend-option-multiply")!.props.onClick();
    expect(f.leaseCalls).toEqual(["update:multiply", "update:multiply", "commit"]);
    expect(f.host.onLayerChange).not.toHaveBeenCalled();
    expect(byTest(f.render(), "clip-blend-menu")).toBeUndefined();
  });

  it("works from the keyboard: arrows preview, Enter commits, Esc restores", () => {
    const f = setup();
    byTest(f.render(), "clip-blend-mode")!.props.onKeyDown(event({ key: "ArrowDown" }));
    let list = byTest(f.render(), "clip-blend-menu")!;
    list.props.onKeyDown(event({ key: "ArrowDown" }));
    list = byTest(f.render(), "clip-blend-menu")!;
    expect(list.props["aria-activedescendant"]).toBe("blend-mode-darken");
    list.props.onKeyDown(event({ key: "End" }));
    list = byTest(f.render(), "clip-blend-menu")!;
    const escape = event({ key: "Escape" });
    list.props.onKeyDown(escape);
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(f.leaseCalls).toEqual(["update:darken", "update:difference", "cancel"]);
    expect(byTest(f.render(), "clip-blend-menu")).toBeUndefined();
    byTest(f.render(), "clip-blend-mode")!.props.onKeyDown(event({ key: "Enter" }));
    list = byTest(f.render(), "clip-blend-menu")!;
    list.props.onKeyDown(event({ key: "ArrowUp" }));
    byTest(f.render(), "clip-blend-menu")!.props.onKeyDown(event({ key: "Enter" }));
    expect(f.leaseCalls.slice(3)).toEqual(["update:difference", "update:difference", "commit"]);
  });

  it("without a preview lease, choosing sends the plain layer change", () => {
    const f = setup({ beginBlendGesture: vi.fn(() => undefined) });
    byTest(f.render(), "clip-blend-mode")!.props.onClick();
    byTest(f.render(), "clip-blend-option-screen")!.props.onPointerEnter();
    byTest(f.render(), "clip-blend-option-screen")!.props.onClick();
    expect(f.host.onLayerChange).toHaveBeenCalledExactlyOnceWith({ blendMode: "screen" });
  });

  it("shows the hovered mode on the button while it previews", () => {
    const f = setup({ blendPreview: "overlay" });
    expect(byTest(f.render(), "clip-blend-mode")!.props["data-blend-mode"]).toBe("overlay");
  });

  it("a locked track disables the whole row and opens nothing", () => {
    const f = setup();
    f.project.tracks[0].locked = true;
    const tree = f.render(), trigger = byTest(tree, "clip-blend-mode")!;
    expect(trigger.props.disabled).toBe(true);
    expect(trigger.props.title).toBe("這個軌道已鎖定，先解鎖才能修改。");
    trigger.props.onClick();
    expect(byTest(f.render(), "clip-blend-menu")).toBeUndefined();
    expect(byTest(tree, "clip-opacity-slider")!.props.disabled).toBe(true);
    expect(byTest(tree, "clip-opacity-keyframe")!.props.disabled).toBe(true);
  });

  it("adjustment and Null layers have no blend mode; an opacity expression disables the opacity controls", () => {
    expect(byTest(setup({}, { layer: { enabled: true, blendMode: "normal", role: "adjustment" } }).render(), "clip-blend-mode")!.props.disabled).toBe(true);
    expect(byTest(setup({}, { layer: { enabled: true, blendMode: "normal", role: "controller" } }).render(), "clip-blend-mode")!.props.disabled).toBe(true);
    const expression = setup({}, { expressions: { opacity: "hao.expression/v1:value * 0.5" } }).render();
    expect(byTest(expression, "clip-opacity-slider")!.props.disabled).toBe(true);
    expect(byTest(expression, "clip-blend-mode")!.props.disabled).toBe(false);
  });

  it("the opacity slider sends one value without a drag lease, and previews through the lease while dragging", () => {
    const f = setup();
    const slider = byTest(f.render(), "clip-opacity-slider")!;
    slider.props.onChange({ currentTarget: { valueAsNumber: 40 } });
    expect(f.host.onOpacityChange).toHaveBeenCalledExactlyOnceWith(.4);
    const updates: number[] = [], opacityLease: ParameterGestureLeaseV1 = { update: value => { updates.push(value); return true; }, commit: () => true, cancel: () => {} };
    const g = setup({ beginOpacityGesture: vi.fn(() => opacityLease), opacityPreview: .25 });
    const dragged = byTest(g.render(), "clip-opacity-slider")!;
    expect(dragged.props.value).toBe(25);
    const target = { setPointerCapture: vi.fn(), valueAsNumber: 60 };
    dragged.props.onPointerDown({ currentTarget: target, pointerId: 1, button: 0, isPrimary: true, preventDefault: vi.fn() });
    dragged.props.onChange({ currentTarget: target });
    expect(updates).toEqual([.6]); expect(g.host.onOpacityChange).not.toHaveBeenCalled();
  });

  it("the % field commits 0–100 as one opacity change", () => {
    const f = setup();
    const field = byTest(f.render(), "clip-opacity-number")!;
    expect(field.props.value).toBe(100);
    expect(field.props.onCommit(35)).toBe(true);
    expect(f.host.onOpacityChange).toHaveBeenCalledExactlyOnceWith(.35);
    expect(field.props.onCommit(140)).toBe(false);
  });

  it("◆ adds a keyframe at the playhead, or deletes the one already there", () => {
    const f = setup();
    const add = byTest(f.render(), "clip-opacity-keyframe")!;
    expect(add.props["aria-pressed"]).toBe(false); add.props.onClick();
    expect(f.host.onAddKeyframe).toHaveBeenCalledOnce();
    const keyed = setup({}, { keyframes: [{ id: "k", time: 3, transform: { ...createDemoProject().tracks[0].clips[0].transform }, color: { ...createDemoProject().tracks[0].clips[0].color }, easing: "linear" }] });
    const remove = byTest(keyed.render(), "clip-opacity-keyframe")!;
    expect(remove.props["aria-pressed"]).toBe(true); remove.props.onClick();
    expect(keyed.host.onDeleteKeyframe).toHaveBeenCalledExactlyOnceWith("k");
    expect(byTest(setup({ playhead: 20 }).render(), "clip-opacity-keyframe")!.props.disabled).toBe(true);
  });
});

describe("helpers", () => {
  it("finds the keyframe within half a frame of the playhead, only inside the clip", () => {
    const clip = { ...createDemoProject().tracks[0].clips[0], timelineStart: 2 };
    clip.keyframes = [{ id: "k", time: 1, transform: clip.transform, color: clip.color, easing: "linear" }];
    expect(keyframeAtPlayheadV1(clip, 3 + .01, 30).keyframe?.id).toBe("k");
    expect(keyframeAtPlayheadV1(clip, 3 + .02, 30)).toEqual({ inside: true, keyframe: undefined });
    expect(keyframeAtPlayheadV1(clip, 1, 30)).toEqual({ inside: false });
  });
  it("opens the list under its button when there is room, above it otherwise, always inside the window", () => {
    expect(blendMenuPositionV1({ left: 100, top: 100, bottom: 136, width: 180 }, 1440, 900)).toEqual({ left: 100, top: 140, width: 212, maxHeight: 420 });
    const above = blendMenuPositionV1({ left: 1400, top: 800, bottom: 836, width: 180 }, 1440, 900);
    expect(above.top + above.maxHeight).toBeLessThanOrEqual(796); expect(above.left + above.width).toBeLessThanOrEqual(1432);
  });
  it("is not hidden by simple mode's CSS (it lives in 片段工具, outside the advanced section)", () => {
    const css = readFileSync(new URL("./simpleWorkspace.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/clip-blend|clip-quick-tools/);
  });
});

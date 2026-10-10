import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { applyCommand } from "../domain/commands";
import { projectSchema } from "../domain/schema";
import type { MotionGraphic } from "../domain/types";
import { prepareNativeGeometryMotion } from "../application/nativeGeometryMotion";
import MotionGeometryControls from "./MotionGeometryControls";
import MotionVectorControls from "./MotionVectorControls";
import MotionStudio from "./MotionStudio";

type Input = { tagName: "INPUT"; value: string; validity: { valid: boolean };
  setCustomValidity: ReturnType<typeof vi.fn>; reportValidity: ReturnType<typeof vi.fn> };
type Control = ReactElement<{ "aria-label"?: string; "data-testid"?: string; children?: ReactNode; disabled?: boolean;
  onChange?: (event: { currentTarget: Input }) => void;
  onClick?: (event: { currentTarget: { tagName: "BUTTON"; closest: () => { querySelector: () => Input } } }) => void }>;
function find(node: ReactNode, label: string, attribute: "aria-label" | "data-testid" = "aria-label"): Control | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, label, attribute)).find(Boolean);
  if (!isValidElement<{ "aria-label"?: string; "data-testid"?: string; children?: ReactNode }>(node)) return;
  if (node.props[attribute] === label) return node as Control;
  return find(node.props.children, label, attribute);
}
function inputControl(value: string): Input {
  return { tagName: "INPUT", value, validity: { valid: true }, setCustomValidity: vi.fn(), reportValidity: vi.fn() };
}
async function fixture() {
  const project = createDemoProject();
  const prepared = await prepareNativeGeometryMotion(project, { expectedRevision: project.revision,
    range: { startFrame: 0, endFrame: 120 }, position: { x: .1, y: .2 }, fixedEnvelope: { width: 400, height: 250 },
    initial: { left: 60, top: 70, right: 180, bottom: 170, cornerRadius: 16 },
    dynamics: { stiffness: 120, damping: 24, mass: 1 },
    targets: [{ property: "right", frame: 12, target: 320 }, { property: "right", frame: 72, target: 280 }],
    purpose: "流程節點沿右緣變形，保留可追蹤的物件身份", evidenceRefs: ["brief:retained-node"] }, () => "node");
  const current = applyCommand(project, prepared.commands[0]);
  return { project: current, graphic: current.motionGraphics[0] };
}

describe("continuity geometry native controls", () => {
  it("uses the actual width target handler and roundtrips only editable vector data", async () => {
    const { project, graphic } = await fixture(), original = structuredClone(graphic), update = vi.fn();
    const tree = MotionGeometryControls({ graphic, onUpdate: update });
    const input = inputControl("280");
    find(tree, `${graphic.name}寬度事件 1 目標`)!.props.onChange!({ currentTarget: input });
    expect(update).toHaveBeenCalledTimes(1); expect(Object.keys(update.mock.calls[0][0])).toEqual(["vectorV2"]);
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(project,
      { type: "update_motion_graphic", graphicId: graphic.id, patch: update.mock.calls[0][0] }))));
    const revised = reopened.motionGraphics[0];
    if (revised.vectorV2?.kind !== "spring_panel") throw new Error("fixture lost geometry");
    expect(revised.vectorV2.geometry.right.events[0]).toEqual({ frame: 12, target: 340 });
    expect(revised.vectorV2.geometry.envelope).toEqual({ x: 0, y: 0, width: 400, height: 250 });
    expect(revised.vectorV2.geometry.localId).toBe("node"); expect(revised.x).toBe(graphic.x); expect(revised.duration).toBe(graphic.duration);
    expect(graphic).toEqual(original); expect(input.reportValidity).not.toHaveBeenCalled();
  });

  it("edits the physical damping and initial contour through the stored track", async () => {
    const { project, graphic } = await fixture(), update = vi.fn(), tree = MotionGeometryControls({ graphic, onUpdate: update });
    find(tree, `${graphic.name}右緣阻尼`)!.props.onChange!({ currentTarget: inputControl("30") });
    const changed = applyCommand(project, { type: "update_motion_graphic", graphicId: graphic.id, patch: update.mock.calls[0][0] });
    if (changed.motionGraphics[0].vectorV2?.kind !== "spring_panel") throw new Error("fixture lost geometry");
    expect(changed.motionGraphics[0].vectorV2.geometry.right.spring.damping).toBe(30);
    update.mockClear();
    find(tree, `${graphic.name}初始寬度`)!.props.onChange!({ currentTarget: inputControl("100") });
    const initial = update.mock.calls[0][0].vectorV2.geometry.right;
    expect(initial.initialPosition).toBe(160); expect(initial.initialTarget).toBe(160); expect(initial.initialVelocity).toBe(0);
  });

  it("adds and removes real target events and blocks invalid contour or duplicate frames", async () => {
    const { project, graphic } = await fixture(), update = vi.fn(), tree = MotionGeometryControls({ graphic, onUpdate: update });
    const feedback = inputControl("120"), button = { tagName: "BUTTON" as const, closest: () => ({ querySelector: () => feedback }) };
    find(tree, `${graphic.name}新增右緣事件`)!.props.onClick!({ currentTarget: button });
    const added = applyCommand(project, { type: "update_motion_graphic", graphicId: graphic.id, patch: update.mock.calls[0][0] });
    if (added.motionGraphics[0].vectorV2?.kind !== "spring_panel") throw new Error("fixture lost geometry");
    expect(added.motionGraphics[0].vectorV2.geometry.right.events.at(-1)).toEqual({ frame: 73, target: 280 });
    update.mockClear();
    find(tree, `${graphic.name}移除右緣事件 1`)!.props.onClick!({ currentTarget: button });
    const removed = projectSchema.parse(applyCommand(project, { type: "update_motion_graphic", graphicId: graphic.id, patch: update.mock.calls[0][0] }));
    if (removed.motionGraphics[0].vectorV2?.kind !== "spring_panel") throw new Error("fixture lost geometry");
    expect(removed.motionGraphics[0].vectorV2.geometry.right.events).toEqual([{ frame: 72, target: 280 }]);
    update.mockClear();
    const duplicate = inputControl("72");
    find(tree, `${graphic.name}右緣事件 1 影格`)!.props.onChange!({ currentTarget: duplicate });
    expect(update).not.toHaveBeenCalled(); expect(duplicate.reportValidity).toHaveBeenCalledTimes(1);
    const collapsed = inputControl("0");
    find(tree, `${graphic.name}初始寬度`)!.props.onChange!({ currentTarget: collapsed });
    expect(update).not.toHaveBeenCalled(); expect(collapsed.reportValidity).toHaveBeenCalledTimes(1);
  });

  it("routes the actual vector controls to continuity inputs and exposes no mutable envelope", async () => {
    const { graphic } = await fixture();
    const routed = MotionVectorControls({ graphic, onUpdate: vi.fn() });
    expect(isValidElement(routed) && routed.type).toBe(MotionGeometryControls);
    const markup = renderToStaticMarkup(routed);
    expect(markup).toContain("固定畫布 400 × 250 px"); expect(markup).toContain("初始寬度");
    expect(markup).not.toContain("圖形高度"); expect(markup).not.toContain("揭露影格");
    const capped: MotionGraphic = structuredClone(graphic);
    if (capped.vectorV2?.kind !== "spring_panel") throw new Error("fixture lost geometry");
    capped.vectorV2.geometry.left.events = Array.from({ length: 30 }, (_, frame) => ({ frame, target: 60 }));
    const tree = MotionGeometryControls({ graphic: capped, onUpdate: vi.fn() });
    expect(find(tree, `${graphic.name}新增左緣事件`)!.props.disabled).toBe(true);
  });

  it("invokes the actual MotionStudio create button and preserves callers without the optional callback", async () => {
    const { project, graphic } = await fixture(), create = vi.fn(), noop = () => {};
    const props = { asset: project.assets[0], motionTracks: [], motionGraphics: [graphic], wave2Presets: [],
      trackingBusy: false, trackingSelectionActive: false, onBeginMotionTrack: noop, onCorrectMotionTrack: noop,
      onDeleteMotionTrack: noop, onAddMotionGraphic: vi.fn(), onUpdateMotionGraphic: vi.fn(), onDeleteMotionGraphic: noop };
    const tree = MotionStudio({ ...props, onAddGeometryMotion: create });
    const button = find(tree, "add-continuity-geometry", "data-testid")!;
    expect(button.props.disabled).toBe(false);
    button.props.onClick!({ currentTarget: { tagName: "BUTTON", closest: () => ({ querySelector: () => inputControl("0") }) } });
    expect(create).toHaveBeenCalledTimes(1); expect(props.onAddMotionGraphic).not.toHaveBeenCalled();
    const previousCaller = MotionStudio(props);
    expect(find(previousCaller, "add-continuity-geometry", "data-testid")!.props.disabled).toBe(true);
    expect(find(previousCaller, "add-continuity-geometry", "data-testid")!.props.onClick).toBeUndefined();
  });

  it("omits the compositor selector for continuity while exposing the actual geometry controls", async () => {
    const { project, graphic } = await fixture(), noop = () => {};
    const tree = MotionStudio({ asset: project.assets[0], projectFps: project.fps, motionTracks: [], motionGraphics: [graphic],
      wave2Presets: [], trackingBusy: false, trackingSelectionActive: false, onBeginMotionTrack: noop,
      onCorrectMotionTrack: noop, onDeleteMotionTrack: noop, onAddMotionGraphic: noop, onUpdateMotionGraphic: noop,
      onDeleteMotionGraphic: noop });
    expect(find(tree, `${graphic.name}合成位置`)).toBeUndefined();
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("初始寬度"); expect(markup).toContain("右緣事件 1 影格");
    expect(markup).not.toContain("合成位置"); expect(markup).not.toContain("圖形高度");
    expect(markup).not.toContain(`${graphic.name}文字`);
  });

  it("preserves authored alpha in native fill and border color updates", async () => {
    const { project, graphic } = await fixture(), update = vi.fn();
    const transparent = { ...graphic, backgroundColor: "#175CD380", accentColor: "#FFFFFF66" };
    const tree = MotionGeometryControls({ graphic: transparent, onUpdate: update });
    find(tree, `${graphic.name}填色`)!.props.onChange!({ currentTarget: inputControl("#2299AA") });
    expect(update).toHaveBeenLastCalledWith({ backgroundColor: "#2299AA80" });
    const source = { ...project, motionGraphics: [transparent] };
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(applyCommand(source,
      { type: "update_motion_graphic", graphicId: graphic.id, patch: update.mock.calls[0][0] }))));
    expect(reopened.motionGraphics[0].backgroundColor).toBe("#2299AA80");
    expect(reopened.motionGraphics[0].vectorV2).toEqual(graphic.vectorV2);
    find(tree, `${graphic.name}邊框色`)!.props.onChange!({ currentTarget: inputControl("#334455") });
    expect(update).toHaveBeenLastCalledWith({ accentColor: "#33445566" });
  });
});

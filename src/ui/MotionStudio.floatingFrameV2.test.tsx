import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { floatingVideoFramePreset } from "../motion/floatingVideoFrame";
import MotionStudio, { type MotionStudioProps } from "./MotionStudio";

function byTestId(node: ReactNode, id: string): ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }> | undefined {
  if (Array.isArray(node)) return node.map(child => byTestId(child, id)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; "data-testid"?: string }>(node)) return undefined;
  if (node.props["data-testid"] === id) return node as ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>;
  return byTestId(node.props.children, id);
}

function props(): MotionStudioProps {
  const project = createDemoProject();
  const noop = () => {};
  return { asset: project.assets[0], clip: project.tracks[0].clips[0], portraitCanvas: true, projectFps: 30,
    onSetFloatingFrame: vi.fn(), onApplyFloatingScene: vi.fn(), motionTracks: [], motionGraphics: [], wave2Presets: [],
    trackingBusy: false, trackingSelectionActive: false, onBeginMotionTrack: noop, onCorrectMotionTrack: noop,
    onDeleteMotionTrack: noop, onAddMotionGraphic: noop, onUpdateMotionGraphic: noop, onDeleteMotionGraphic: noop };
}

describe("MotionStudio v2 floating creation controls", () => {
  it("creates source-contain v2 through the real callback while portrait orbit remains explicit", () => {
    const input = props(), tree = MotionStudio(input);
    byTestId(tree, "floating-frame-matte")!.props.onClick!();
    byTestId(tree, "floating-frame-portrait_orbit")!.props.onClick!();
    expect(input.onSetFloatingFrame).toHaveBeenNthCalledWith(1, expect.objectContaining({ schema: "editkin.floating-video-frame/v2",
      aspect: "source", mediaFit: "contain", motion: { entranceFrames: 6, exitFrames: 6, travelY: .012 } }));
    expect(input.onSetFloatingFrame).toHaveBeenNthCalledWith(2, expect.objectContaining({ schema: "editkin.floating-video-frame/v2",
      aspect: "portrait", mediaFit: "contain" }));
  });

  it("disables new presets and scenes when the real clip span cannot hold both default phases", () => {
    const input = props(); input.clip!.duration = 12 / 30;
    const tree = MotionStudio(input);
    expect(byTestId(tree, "floating-frame-matte")!.props.disabled).toBe(true);
    expect(byTestId(tree, "floating-scene-portrait_stack")!.props.disabled).toBe(true);
  });

  it("identifies saved v1 as unchanged until an explicit new preset is applied", () => {
    const input = props(); input.clip!.floatingFrame = floatingVideoFramePreset("matte");
    const before = structuredClone(input.clip), tree = MotionStudio(input);
    expect(byTestId(tree, "floating-frame-version")!.props.children).toContain("v1 · 保留既有裁切與動畫");
    expect(input.onSetFloatingFrame).not.toHaveBeenCalled();
    expect(input.clip).toEqual(before);
    byTestId(tree, "floating-frame-matte")!.props.onClick!();
    expect(input.onSetFloatingFrame).toHaveBeenCalledWith(expect.objectContaining({ schema: "editkin.floating-video-frame/v2" }));
  });
});

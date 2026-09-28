import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import MotionStudio from "./MotionStudio";
import { createDemoProject } from "../domain/demo";

function byTestId(node: ReactNode, id: string): ReactElement<{ onClick?: () => void; disabled?: boolean }> | undefined {
  if (Array.isArray(node)) return node.map(child => byTestId(child, id)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; "data-testid"?: string }>(node)) return undefined;
  if (node.props["data-testid"] === id) return node as ReactElement<{ onClick?: () => void; disabled?: boolean }>;
  return byTestId(node.props.children, id);
}

const noop = () => {};
describe("Editkin Motion floating frame controls", () => {
  it("sends the registered portrait scene and orbit preset through editor callbacks", () => {
    const project = createDemoProject();
    const setFrame = vi.fn();
    const setScene = vi.fn();
    const tree = MotionStudio({ asset: project.assets[0], clip: project.tracks[0].clips[0], portraitCanvas: true,
      onSetFloatingFrame: setFrame, onApplyFloatingScene: setScene,
      motionTracks: [], motionGraphics: [], wave2Presets: [], trackingBusy: false, trackingSelectionActive: false,
      onBeginMotionTrack: noop, onCorrectMotionTrack: noop, onDeleteMotionTrack: noop,
      onAddMotionGraphic: noop, onUpdateMotionGraphic: noop, onDeleteMotionGraphic: noop });
    const scene = byTestId(tree, "floating-scene-portrait_duo");
    const orbit = byTestId(tree, "floating-frame-portrait_orbit");
    expect(scene?.props.disabled).toBe(false);
    scene?.props.onClick?.();
    orbit?.props.onClick?.();
    expect(setScene).toHaveBeenCalledWith("portrait_duo");
    expect(setFrame.mock.calls[0][0]).toMatchObject({ aspect: "portrait", orbit: { amplitudeDegrees: 24, periodSeconds: 3.6 } });
  });

  it("blocks the portrait scene on a landscape canvas", () => {
    const project = createDemoProject();
    const tree = MotionStudio({ asset: project.assets[0], clip: project.tracks[0].clips[0], portraitCanvas: false,
      onSetFloatingFrame: noop, onApplyFloatingScene: noop,
      motionTracks: [], motionGraphics: [], wave2Presets: [], trackingBusy: false, trackingSelectionActive: false,
      onBeginMotionTrack: noop, onCorrectMotionTrack: noop, onDeleteMotionTrack: noop,
      onAddMotionGraphic: noop, onUpdateMotionGraphic: noop, onDeleteMotionGraphic: noop });
    expect(byTestId(tree, "floating-scene-portrait_duo")?.props.disabled).toBe(true);
    expect(byTestId(tree, "floating-frame-portrait_orbit")?.props.disabled).toBe(true);
  });
});

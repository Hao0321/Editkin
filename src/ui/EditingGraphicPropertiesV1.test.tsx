import { isValidElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo, redo } from "../domain/history";
import { projectSchema } from "../domain/schema";
import { createMotionGraphic } from "../motion/composition";
import { findMotionGraphicPreset } from "../creative/motionGraphicPresets";
import { EditingGraphicPropertiesV1 } from "./EditingGraphicPropertiesV1";
import { renderMotionGraphicPropertiesV1 } from "./MotionGraphicPropertiesV1";

type Control = ReactElement<{ children?: ReactNode; "aria-label"?: string; onChange?: (event: { target: { value: string } }) => void }>;
function control(node: ReactNode, label: string): Control | undefined {
  if (Array.isArray(node)) return node.map(child => control(child, label)).find(Boolean);
  if (!isValidElement<Control["props"]>(node)) return undefined;
  if (node.props["aria-label"] === label) return node;
  return control(node.props.children, label);
}

describe("motion layer properties", () => {
  it("edits the selected layer's font and box width through history and JSON restore", () => {
    const project = projectSchema.parse(createDemoProject());
    const graphic = createMotionGraphic("selected-layer", "title", "AV 12", 0, 3, undefined, findMotionGraphicPreset("v2-word-cascade").seed);
    const untouched = createMotionGraphic("other-layer", "card", "Keep", 4, 2);
    project.motionGraphics = [graphic, untouched];
    const original = JSON.stringify(project);
    let history = createHistory(project);
    const node = renderMotionGraphicPropertiesV1({ graphic, onDeleteMotionGraphic: vi.fn(),
      onUpdateMotionGraphic: (graphicId, patch) => { history = dispatchCommand(history, { type: "update_motion_graphic", graphicId, patch }); },
    });
    control(node, `${graphic.name}字型`)!.props.onChange!({ target: { value: "Bebas Neue" } });
    control(node, `${graphic.name}底框寬度`)!.props.onChange!({ target: { value: "fit_content" } });
    const restored = projectSchema.parse(JSON.parse(JSON.stringify(history.present)));
    expect(restored.motionGraphics[0]).toMatchObject({ fontFamily: "Bebas Neue", fontWeight: 400, layoutV2: { widthMode: "fit_content" } });
    expect(restored.motionGraphics[1]).toEqual(untouched);
    expect(undo(history).present.motionGraphics[0].layoutV2?.widthMode).toBe(graphic.layoutV2?.widthMode);
    expect(redo(undo(history)).present).toEqual(history.present);
    expect(JSON.stringify(project)).toBe(original);
  });

  it("keeps vector composite position available without editing its geometry", () => {
    const graphic = createMotionGraphic("vector-layer", "card", "", 0, 3, undefined, findMotionGraphicPreset("reel_native_panel").seed);
    const update = vi.fn();
    const node = renderMotionGraphicPropertiesV1({ graphic, onUpdateMotionGraphic: update, onDeleteMotionGraphic: vi.fn() });
    control(node, `${graphic.name}合成位置`)!.props.onChange!({ target: { value: "background" } });
    expect(update).toHaveBeenCalledWith(graphic.id, { compositeLayer: "background", vectorV2: { ...graphic.vectorV2, schema: "editkin.motion-vector-stage/v1" } });
    expect(graphic.compositeLayer).toBeUndefined();
  });

  it("provides the owning editor instead of raw edits for managed layers", () => {
    const graphic = createMotionGraphic("owned-layer", "title", "Keep", 0, 3);
    for (const settings of [{ templateId: "template-owner" }, { managed: true, onOpenSceneEditor: vi.fn() }]) {
      const html = renderToStaticMarkup(<EditingGraphicPropertiesV1 graphic={graphic} {...settings} onChange={vi.fn()} />);
      expect(html).not.toMatch(/<(input|textarea|select)\b/);
      expect(html).toContain("button");
    }
  });
});

vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});

import { readFileSync } from "node:fs";
import ts from "typescript";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";

// P6/P7 pack (2026-10-23): how EditorShell wires the 混合 row, ＋ 調整圖層 and simple mode's 特效. AST evidence for the
// shell (it needs the whole app to render) plus the production Inspector called with hook doubles for what it shows.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useMemo: (factory: () => unknown) => factory(), useEffect: () => {}, useLayoutEffect: () => {},
    useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback,
    useState: (value: unknown) => [typeof value === "function" ? (value as () => unknown)() : value, () => {}] };
});
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { Inspector } from "./Inspector";
import Mesh3dControls from "./Mesh3dControls";

const text = readFileSync(new URL("./EditorShell.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("EditorShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find<T extends ts.Node>(test: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (test(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(source); return found;
}
const jsx = (name: string) => find((node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === name);
const attribute = (element: ts.JsxSelfClosingElement, name: string) => element.attributes.properties.filter(ts.isJsxAttribute).find(item => item.name.getText(source) === name);
const declaration = (name: string) => find((node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(source) === name)[0];

describe("editor shell wiring for layers", () => {
  it("wraps the Inspector in the clip layer host, whose blend preview and gestures use the shell's transient owner", () => {
    const inspector = jsx("Inspector")[0]!;
    let parent: ts.Node | undefined = inspector.parent;
    while (parent && !(ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === "ClipLayerHostContextV1.Provider")) parent = parent.parent;
    expect(parent, "Inspector inside ClipLayerHostContextV1.Provider").toBeDefined();
    expect((parent as ts.JsxElement).openingElement.attributes.getText(source)).toBe("value={clipLayerHost}");
    const host = declaration("clipLayerHost")!.initializer!.getText(source);
    expect(host).toContain('layerDraft?.parameterId === "layer.blendMode"');
    expect(host).toContain('layerDraft?.parameterId === "transform.opacity"');
    expect(host).toContain('beginOpacityGesture: () => beginTransformNumberGesture("opacity")');
    const blend = declaration("beginBlendGesture")!.initializer!.getText(source);
    expect(blend).toContain("clipParameterGesture.beginLayer(");
    expect(blend).toContain('parameterId: "layer.blendMode"');
    expect(blend).toContain('{ type: "set_clip_layer", clipId, patch: { blendMode: mode } }');
    expect(attribute(inspector, "onTransformNumberGestureStart")!.initializer!.getText(source)).toBe("{beginTransformNumberGesture}");
    expect(attribute(inspector, "onAddKeyframe")!.initializer!.getText(source)).toBe("{addKeyframeAtPlayhead}");
  });
  it("gives ＋ 調整圖層 to the timeline's 更多工具 and the 圖層 panel", () => {
    expect(attribute(jsx("Timeline")[0]!, "onAddAdjustmentLayer")!.initializer!.getText(source)).toBe("{addAdjustmentLayer}");
    const panel = jsx("EditingLayerStackV1")[0]!;
    expect(attribute(panel, "onAddAdjustmentLayer")!.initializer!.getText(source)).toBe("{addAdjustmentLayer}");
    expect(attribute(panel, "adjustmentLayerReady")!.initializer!.getText(source)).toBe("{adjustmentLayerReady}");
    expect(declaration("addAdjustmentLayer")!.initializer!.getText(source)).toContain("planAdjustmentLayerV1(");
  });
  it("sends both simple-mode 連接 AI 助手 entries (start screen and ⚙) to the same Agent Connect dialog, on the desktop", () => {
    expect(attribute(jsx("FirstProjectStart")[0]!, "onConnectAgent")!.initializer!.getText(source)).toBe("{isDesktop ? () => openAgentConnect() : undefined}");
    expect(attribute(jsx("Toolbar")[0]!, "onOpenAgentConnect")!.initializer!.getText(source)).toBe("{() => openAgentConnect()}");
    expect(declaration("openAgentConnect")!.initializer!.getText(source)).toContain("setAgentConnectOpened(true)");
  });
  it("passes neither 3D scenes nor saved original scenes to the Inspector in simple mode", () => {
    const inspector = jsx("Inspector")[0]!;
    for (const name of ["onMesh3dCommand", "originalMotionScenesControl"]) {
      const value = (attribute(inspector, name)!.initializer as ts.JsxExpression).expression!;
      expect(ts.isConditionalExpression(value), name).toBe(true);
      const conditional = value as ts.ConditionalExpression;
      expect(conditional.condition.getText(source)).toBe("simpleMode");
      expect(conditional.whenTrue.getText(source)).toBe("undefined");
    }
  });
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
describe("simple mode's 特效 without 3D and saved original scenes", () => {
  const render = (extra: Record<string, unknown>) => {
    const project = createDemoProject();
    const data = { workspace: "effects", projectFps: 30, playhead: 1, clip: project.tracks[0].clips[0], asset: project.assets[0], captionStyle: project.captionStyle, tracks: project.tracks,
      canTransitionIn: false, canTransitionOut: false, motionTracks: [], trackingBusy: false, trackingSelectionActive: false, motionGraphics: [],
      autoRotoBusy: false, autoRotoRuntimeStatus: initialAutoRotoRuntimeStatus(undefined), mesh3dProject: project, ...extra } as Record<string, unknown>;
    const props = new Proxy(data, { get: (target, key) => typeof key === "string" && key in target ? target[key] : key.toString().startsWith("on") && key !== "onMesh3dCommand" ? () => {} : undefined,
      has: (target, key) => key in target });
    return elements(Inspector(props as unknown as Parameters<typeof Inspector>[0]));
  };
  it("shows 立體 Motion 場景 and saved scenes only when the shell passes them (advanced mode)", () => {
    const saved = <div data-testid="saved-original-motion-scenes" />;
    const advanced = render({ onMesh3dCommand: () => {}, originalMotionScenesControl: saved });
    expect(advanced.some(element => element.type === Mesh3dControls)).toBe(true);
    expect(advanced.some(element => element.props["data-testid"] === "saved-original-motion-scenes")).toBe(true);
    const simple = render({ onMesh3dCommand: undefined, originalMotionScenesControl: undefined });
    expect(simple.some(element => element.type === Mesh3dControls)).toBe(false);
    expect(simple.some(element => element.props["data-testid"] === "saved-original-motion-scenes")).toBe(false);
    // The effects tools themselves stay.
    expect(simple.some(element => element.props["data-testid"] === "clip-quick-tools")).toBe(true);
  });
});

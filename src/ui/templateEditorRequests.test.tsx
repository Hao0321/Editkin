import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { Inspector } from "./Inspector";
import MotionStudio from "./MotionStudio";
import { isTemplateEditorRequestDetail, openTemplateEditorAtPoint, openTemplateEditorFromStageClick, requestTemplateEditor, subscribeTemplateEditorRequests,
  TEMPLATE_EDITOR_REQUEST_EVENT, templateInstanceAtPoint } from "./templateEditorRequests";

// One request opens the saved-template editor from the Inspector, the Motion studio, the timeline or a preview click.
// Real request event, real hit test and the real Inspector/MotionStudio trees; no mounted browser is claimed.
// Hook doubles so the production Inspector/MotionStudio render functions can be called directly and their handlers invoked.
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
afterEach(() => vi.unstubAllGlobals());

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

/** A clip on 主畫面 [0,4) whose saved template owns one title drawn at (0.1, 0.3) from 0.5 s for 3 s. */
function project(): EditProject {
  const value = createEmptyProject("Requests", { id: "requests", width: 1080, height: 1920, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "C:/owned/trip.mp4", duration: 30, width: 1080, height: 1920 }];
  value.tracks[0].clips = [{ id: "main", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } }];
  const title = { ...createMotionGraphic("owned-title", "title", "其實是水簾", 0.5, 3), x: .1, y: .3, width: .8, fontSize: 96 };
  const withTitle = applyCommand(validateProject(value), { type: "add_motion_graphic", graphic: title });
  return applyCommand(withTitle, { type: "upsert_reference_motion_instance", instance: {
    schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: "main", startFrame: 0, durationFrames: 120, title: "其實是水簾", sources: [], intent: "shortform",
      purpose: "request control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: 1080, height: 1920, fps: 30 }, roles: [{ key: "heading", kind: "graphic", id: "owned-title" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture", presetHashes: [], fonts: [] } } });
}
function eventSink() {
  const target = new EventTarget(), received: unknown[] = [];
  target.addEventListener(TEMPLATE_EDITOR_REQUEST_EVENT, event => received.push((event as CustomEvent).detail));
  return { target, received };
}

describe("the template editor request", () => {
  it("carries the template and where it came from, and a subscriber receives only well-formed requests", () => {
    const target = new EventTarget(), handler = vi.fn();
    const unsubscribe = subscribeTemplateEditorRequests(handler, target);
    expect(requestTemplateEditor("owner", "inspector", target)).toBe(true);
    target.dispatchEvent(new CustomEvent(TEMPLATE_EDITOR_REQUEST_EVENT, { detail: { instanceId: "", source: "inspector" } }));
    target.dispatchEvent(new CustomEvent(TEMPLATE_EDITOR_REQUEST_EVENT, { detail: { instanceId: "owner", source: "elsewhere" } }));
    expect(handler.mock.calls).toEqual([[{ instanceId: "owner", source: "inspector" }]]);
    unsubscribe(); requestTemplateEditor("owner", "timeline", target);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(isTemplateEditorRequestDetail({ instanceId: "a", source: "preview" })).toBe(true);
  });
  it("finds the template whose visible title is under a preview click, at the playhead only", () => {
    const value = project();
    expect(templateInstanceAtPoint(value, 1, { x: .2, y: .31 })?.id).toBe("owner");
    expect(templateInstanceAtPoint(value, 1, { x: .2, y: .9 })).toBeUndefined();
    expect(templateInstanceAtPoint(value, 3.6, { x: .2, y: .31 })).toBeUndefined();
    const sink = eventSink();
    expect(openTemplateEditorAtPoint(value, 1, { x: .2, y: .31 }, sink.target)).toBe(true);
    expect(sink.received).toEqual([{ instanceId: "owner", source: "preview" }]);
    expect(openTemplateEditorAtPoint(value, 1, { x: .9, y: .95 }, sink.target)).toBe(false);
  });
  it("a click on the preview stage opens the template under it, but a click on a control inside the preview is left alone", () => {
    const value = project(), sink = eventSink();
    const stage = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 270, height: 480 }), contains: () => true };
    const click = (clientX: number, clientY: number, target: unknown = stage) => ({ clientX, clientY, target: target as EventTarget, currentTarget: stage,
      stopPropagation: vi.fn() });
    // (0.2, 0.31) of a 270×480 stage at (100, 50).
    const onTitle = click(154, 198.8);
    expect(openTemplateEditorFromStageClick(onTitle, value, 1, sink.target)).toBe(true);
    expect(onTitle.stopPropagation).toHaveBeenCalledOnce();
    expect(sink.received).toEqual([{ instanceId: "owner", source: "preview" }]);
    const playButton = { closest: (selector: string) => selector.includes("button") ? playButton : null };
    const onControl = click(154, 198.8, playButton);
    expect(openTemplateEditorFromStageClick(onControl, value, 1, sink.target)).toBe(false);
    expect(onControl.stopPropagation).not.toHaveBeenCalled();
    expect(openTemplateEditorFromStageClick(click(154, 520), value, 1, sink.target)).toBe(false);
    expect(sink.received).toHaveLength(1);
  });
});

describe("ways into the editor", () => {
  it("the Inspector of the main clip shows its title template with a large button that opens the editor", () => {
    const value = project(), dispatched: Event[] = [];
    vi.stubGlobal("document", { dispatchEvent: (event: Event) => { dispatched.push(event); return true; } });
    const data = { projectFps: 30, playhead: 1, clip: value.tracks[0].clips[0], asset: value.assets[0], captionStyle: value.captionStyle, tracks: value.tracks,
      canTransitionIn: false, canTransitionOut: false, motionTracks: [], trackingBusy: false, trackingSelectionActive: false, motionGraphics: value.motionGraphics,
      autoRotoBusy: false, autoRotoRuntimeStatus: initialAutoRotoRuntimeStatus(undefined), sourceTimingProject: value } as Record<string, unknown>;
    const props = new Proxy(data, { get: (target, key) => typeof key === "string" && key in target ? target[key] : key.toString().startsWith("on") ? () => {} : undefined,
      has: (target, key) => key in target });
    const tree = Inspector(props as unknown as Parameters<typeof Inspector>[0]);
    const card = elements(tree).find(element => element.props["data-testid"] === "inspector-template-card")!;
    expect(renderToStaticMarkup(card)).toContain("這段有標題模板");
    const button = elements(tree).find(element => element.props["data-testid"] === "inspector-open-template-owner")!;
    expect(renderToStaticMarkup(button)).toContain("改標題文字：其實是水簾");
    (button.props.onClick as () => void)();
    expect((dispatched[0] as CustomEvent).detail).toEqual({ instanceId: "owner", source: "inspector" });
  });
  it("the Motion studio hint on a template's title becomes a button that opens that template", () => {
    const value = project(), dispatched: Event[] = [], noop = () => {};
    vi.stubGlobal("document", { dispatchEvent: (event: Event) => { dispatched.push(event); return true; } });
    const tree = MotionStudio({ asset: value.assets[0], motionTracks: [], motionGraphics: value.motionGraphics, wave2Presets: [], trackingBusy: false,
      trackingSelectionActive: false, onBeginMotionTrack: noop, onCorrectMotionTrack: noop, onDeleteMotionTrack: noop, onAddMotionGraphic: noop,
      onUpdateMotionGraphic: noop, onDeleteMotionGraphic: noop, managedMotionGraphicIds: ["owned-title"],
      templateOwners: { "owned-title": { instanceId: "owner", title: "其實是水簾" } } });
    const button = elements(tree).find(element => element.props["data-testid"] === "motion-open-template-owned-title")!;
    expect(renderToStaticMarkup(button)).toContain("這是標題模板「其實是水簾」的文字 · 打開模板編輯器修改");
    (button.props.onClick as () => void)();
    expect((dispatched[0] as CustomEvent).detail).toEqual({ instanceId: "owner", source: "motion-studio" });
  });
});

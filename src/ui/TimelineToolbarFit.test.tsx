import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { movedToolbarActions, nextToolbarStep, placeTimelineMoreMenu, TIMELINE_TOOLBAR_LAST_STEP, TimelineToolbarFit, toolbarRowOverflows } from "./TimelineToolbarFit";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { TimelineZoomControl, timelineZoomFromSlider, timelineZoomToSlider, TIMELINE_ZOOM_IN, TIMELINE_ZOOM_OUT } from "./TimelineZoomControl";
import { MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND } from "./timelineContract";

// The one-row timeline toolbar. The measuring runs in the browser (headless Chrome, zh-TW/en/es/ja/ko at 1280×720,
// 1440×900 and 800×560: .rd/benchmarks/usable-v1-20261009/work/layout-1280-20261010/toolbar; with the two tools, both
// modes and both tools at 1280×720: .rd/benchmarks/usable-v1-20261009/work/timeline-blade-20261011); here: the step rule,
// where 更多工具 opens, the Timeline wiring (which actions may move and their copies in the menu) and the CSS.
const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], states: [] as { value: unknown }[], refIndex: 0, stateIndex: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useMemo: (factory: () => unknown) => factory(), useEffect: () => {},
    useRef: (value: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: value }),
    useState: (value: unknown) => {
      const index = hooks.stateIndex++;
      const state = hooks.states[index] ?? (hooks.states[index] = { value: typeof value === "function" ? value() : value });
      return [state.value, (next: unknown) => { state.value = typeof next === "function" ? next(state.value) : next; }];
    } };
});
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
afterEach(async () => { vi.unstubAllGlobals(); interfacePreferences.setMode("simple"); await interfacePreferences.setLocale("zh-TW"); });

type Props = Record<string, unknown> & { children?: ReactNode };
function all(node: ReactNode, predicate: (props: Props) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, out));
  else if (isValidElement<Props>(node)) { if (predicate(node.props)) out.push(node.props); if (node.props.children) all(node.props.children, predicate, out); }
  return out;
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node)
  : isValidElement<Props>(node) ? text(node.props.children) : "";
const byTestId = (tree: ReactNode, id: string) => {
  const found = all(tree, props => props["data-testid"] === id);
  expect(found, id).toHaveLength(1);
  return found[0];
};

function project(): EditProject {
  const value = createEmptyProject("Toolbar", { id: "toolbar", width: 1920, height: 1080, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "C:/owned/trip.mp4", duration: 30, width: 1920, height: 1080 }];
  value.tracks[0].clips = [{ id: "A", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } }];
  return validateProject(value);
}
function render(overrides: Partial<TimelineProps> = {}) {
  hooks.refs.length = hooks.states.length = 0;
  hooks.refIndex = hooks.stateIndex = 0;
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const noop = () => {};
  const props: TimelineProps = { project: project(), duration: 4, playhead: 0, runtimeUrls: {}, selectedClipId: "A", onSeek: noop, onSelect: noop,
    onSelectCaption: noop, onMoveClip: () => true, onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onEditSelection: noop,
    onAddTrack: vi.fn(), onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: vi.fn(), onPrecompose: noop,
    onToggleMute: noop, onSplit: noop, onDelete: noop, onCommand: () => true, ...overrides };
  return { props, tree: Timeline(props) };
}

describe("the toolbar steps down until it fits one row", () => {
  it("moves one action per step, then the title, and only lets the row wrap at the last step", () => {
    expect([0, 1, 2, 3, 4, 5].map(step => nextToolbarStep(step, true))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(nextToolbarStep(TIMELINE_TOOLBAR_LAST_STEP, true)).toBeUndefined();
    expect(nextToolbarStep(2, false)).toBeUndefined();
    expect([0, 1, 2, 3, 4, 5, 6].map(movedToolbarActions)).toEqual([undefined, "1", "1 2", "1 2 3", "1 2 3 4", "1 2 3 4", "1 2 3 4"]);
  });

  it("counts buttons that run into the toolbar's padding as not fitting (800×560 ja with a caption selected)", () => {
    const fits = { scrollWidth: 616, clientWidth: 616 }, squeezed = { scrollWidth: 632, clientWidth: 616 }, title = { scrollWidth: 120, clientWidth: 120 };
    expect(toolbarRowOverflows({ scrollWidth: 800, clientWidth: 800, children: [title, fits] })).toBe(false);
    expect(toolbarRowOverflows({ scrollWidth: 800, clientWidth: 800, children: [title, squeezed] })).toBe(true);
    expect(toolbarRowOverflows({ scrollWidth: 820, clientWidth: 800, children: [title, fits] })).toBe(true);
    expect(toolbarRowOverflows({ scrollWidth: 801, clientWidth: 800, children: [title, { scrollWidth: 617, clientWidth: 616 }] })).toBe(false);
  });

  it("starts from every action in the row (a server render or no measurement keeps the full toolbar)", () => {
    const html = renderToStaticMarkup(<TimelineToolbarFit fitKey="zh-TW"><div><strong>時間軸</strong></div></TimelineToolbarFit>);
    expect(html).toBe('<div class="timeline-toolbar" data-fit="" data-overflow="0"><div><strong>時間軸</strong></div></div>');
  });
});

describe("更多工具 opens where it never covers its own button", () => {
  const toolbar = { top: 412, bottom: 479 } as DOMRect, button = { left: 1105 } as DOMRect, viewport = { width: 1280, height: 720 };
  it("opens under the toolbar when it fits there", () => {
    expect(placeTimelineMoreMenu(toolbar, button, 216, viewport)).toEqual({ top: "485px", bottom: "auto", right: "12px", maxHeight: "223px" });
  });
  it("otherwise opens from the window's bottom beside its button, no higher than the toolbar", () => {
    expect(placeTimelineMoreMenu(toolbar, button, 290, viewport)).toEqual({ top: "auto", bottom: "12px", right: "183px", maxHeight: "290px" });
  });
});

// The one-row fitting and its 更多工具 copies belong to advanced mode's full toolbar since 2026-10-11; simple mode's
// toolbar has nothing to move (see "simple mode's toolbar" below), so these checks run in advanced mode.
describe("the Timeline's toolbar: which actions may move into 更多工具", () => {
  it.each(["zh-TW", "en", "es", "ja", "ko"] as const)("keeps the title action in advanced mode with an overflow copy in %s", async locale => {
    await interfacePreferences.setLocale(locale); interfacePreferences.setMode("advanced"); const title = vi.fn(), { tree } = render({ onAddTitle: title });
    const row = byTestId(tree, "timeline-add-title"), copy = byTestId(tree, "timeline-more-add-title");
    expect(row["data-overflow-step"]).toBe("3"); expect(copy["data-overflow-copy"]).toBe("3");
    expect(text(row.children)).toBe(text(copy.children)); expect(text(row.children)).not.toBe("");
    (row.onClick as () => void)(); (copy.onClick as () => void)(); expect(title).toHaveBeenCalledTimes(2);
    interfacePreferences.setMode("simple"); expect(all(render({ onAddTitle: title }).tree, props => props["data-testid"] === "timeline-add-title")).toHaveLength(0);
  });
  it("lets 逐幀, 畫中畫, ＋ 軌道 and 顯示全部 move, in that order, and keeps the two tools, 文字, 調整片段, 吸附, 切開 and 刪除 in the row", () => {
    interfacePreferences.setMode("advanced");
    const { tree } = render();
    expect(byTestId(tree, "timeline-frame-zoom")["data-overflow-step"]).toBe("1");
    expect(byTestId(tree, "picture-in-picture-button")["data-overflow-step"]).toBe("2");
    expect(byTestId(tree, "add-video-track-button")["data-overflow-step"]).toBe("3");
    expect(byTestId(tree, "timeline-fit-button")["data-overflow-step"]).toBe("4");
    for (const id of ["timeline-tool-toggle", "timeline-tool-select", "timeline-tool-blade", "add-caption-button", "edit-selection-button", "timeline-snap-toggle",
      "split-button", "delete-button"]) {
      expect(byTestId(tree, id)["data-overflow-step"], id).toBeUndefined();
    }
    const fit = all(tree, props => typeof props.fitKey === "string");
    expect(fit).toHaveLength(1);
    // The key ends with the mode since 2026-10-11: switching modes changes the toolbar's words, so it is measured again.
    expect(String(fit[0].fitKey)).toMatch(/^zh-TW\|1\|clip\|\|snap\|1\|0\|advanced$/);
  });

  it("has a copy of each moved action in 更多工具 with the same words and the same action", () => {
    interfacePreferences.setMode("advanced");
    const { props, tree } = render();
    const pairs: Array<[string, string, number]> = [["timeline-frame-zoom", "timeline-more-frame-zoom", 1], ["picture-in-picture-button", "timeline-more-picture-in-picture", 2],
      ["add-video-track-button", "timeline-more-add-video-track", 3]];
    for (const [row, copy, step] of pairs) {
      const original = byTestId(tree, row), duplicate = byTestId(tree, copy);
      expect(duplicate["data-overflow-copy"]).toBe(String(step));
      expect(text(duplicate.children as ReactNode)).toBe(text(original.children as ReactNode));
      expect(duplicate.disabled).toBe(original.disabled);
      expect(duplicate.title).toBe(original.title);
    }
    expect(byTestId(tree, "timeline-more-frame-zoom").onClick).toBe(byTestId(tree, "timeline-frame-zoom").onClick);
    (byTestId(tree, "timeline-more-picture-in-picture").onClick as () => void)();
    expect(props.onMakePictureInPicture).toHaveBeenCalledTimes(1);
    (byTestId(tree, "timeline-more-add-video-track").onClick as () => void)();
    expect(props.onAddTrack).toHaveBeenCalledWith("video");
    // 顯示全部 needs no copy: it is already in 更多工具 between 縮小 and 放大.
    const zoom = all(tree, item => item.className === "timeline-zoom")[0];
    expect(text(zoom.children as ReactNode)).toContain("顯示全部");
  });
});

describe("simple mode's toolbar", () => {
  // Rewritten on purpose (2026-10-11): the two tools (選取 A, 剪刀 B) lead the row in both modes since the 剪刀 tool.
  it("has the two tools, ＋ 文字, 切開, 刪除 and the zoom, nothing that moves into 更多工具, and no 更多工具", () => {
    interfacePreferences.setMode("simple");
    const { tree } = render();
    const row = all(tree, item => item.className === "timeline-quick-actions")[0];
    const ids = all(row.children as ReactNode, item => typeof item["data-testid"] === "string").map(item => item["data-testid"]);
    expect(ids).toEqual(["timeline-tool-toggle", "timeline-tool-select", "timeline-tool-blade", "add-caption-button", "split-button", "delete-button"]);
    expect(all(tree, item => item["data-overflow-step"] !== undefined || item["data-overflow-copy"] !== undefined)).toHaveLength(0);
    expect(all(tree, item => item.className === "timeline-more")).toHaveLength(0);
    expect(String(all(tree, item => typeof item.fitKey === "string")[0].fitKey)).toMatch(/\|simple$/);
  });

  it("gives the zoom the timeline's own zoom and fit (the same anchor and the same pointer-edit guard)", () => {
    interfacePreferences.setMode("simple");
    const { tree } = render();
    const zoom = all(tree, item => typeof item.onFit === "function" && typeof item.onZoom === "function");
    expect(zoom).toHaveLength(1);
    expect(zoom[0]).toMatchObject({ pixelsPerSecond: 80, min: MIN_PIXELS_PER_SECOND, max: MAX_PIXELS_PER_SECOND });
  });

  it("maps the slider on a log scale over the whole zoom range, and its buttons use the advanced 縮小／放大 factors", () => {
    expect(timelineZoomToSlider(MIN_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND)).toBe(0);
    expect(timelineZoomToSlider(MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND)).toBe(1000);
    expect(timelineZoomToSlider(10_000, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND)).toBe(1000);
    for (const pps of [18, 80, 240, 1920]) {
      expect(timelineZoomFromSlider(timelineZoomToSlider(pps, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND), MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND) / pps).toBeCloseTo(1, 2);
    }
    expect([TIMELINE_ZOOM_OUT, TIMELINE_ZOOM_IN]).toEqual([0.75, 1.34]);
    const onZoom = vi.fn(), onFit = vi.fn();
    const html = renderToStaticMarkup(<TimelineZoomControl pixelsPerSecond={MIN_PIXELS_PER_SECOND} min={MIN_PIXELS_PER_SECOND} max={MAX_PIXELS_PER_SECOND} onZoom={onZoom} onFit={onFit} />);
    // At the smallest zoom − is disabled; every button has a name and a tooltip, and the icons are SVG (not text a narrow
    // window's timeline CSS would hide).
    expect(html).toMatch(/<button type="button" data-testid="timeline-zoom-out" aria-label="縮小" title="縮小時間軸" disabled=""/);
    expect(html).toContain('data-testid="timeline-fit-button" aria-label="顯示全部" title="顯示全部（也可以雙擊時間尺）"');
    expect(html.match(/<svg /g)).toHaveLength(3);
    expect(html).not.toMatch(/<button[^>]*>[^<]*<span/);
  });
});

describe("the CSS behind the steps", () => {
  const css = postcss.parse(readFileSync(new URL("./timelineToolbarFit.css", import.meta.url), "utf8"));
  const rule = (selector: string) => {
    let found: Rule | undefined;
    css.walkRules(item => { if (item.selectors.includes(selector)) found = item; });
    if (!found) throw new Error(`missing ${selector}`);
    const declarations: Record<string, string> = {};
    found.walkDecls(decl => { declarations[decl.prop] = decl.value.replace(/\s+/g, " "); });
    return declarations;
  };

  it("keeps the row on one line until the last step", () => {
    expect(rule(".timeline-shell .timeline-toolbar.timeline-toolbar[data-fit][data-overflow]")).toMatchObject({ "flex-wrap": "nowrap" });
    expect(rule(".timeline-shell .timeline-toolbar.timeline-toolbar[data-fit][data-overflow] .timeline-quick-actions")).toMatchObject({ flex: "1 0 auto", "flex-wrap": "nowrap", overflow: "visible" });
    expect(rule('.timeline-shell .timeline-toolbar.timeline-toolbar[data-fit][data-overflow="6"]')).toMatchObject({ "flex-wrap": "wrap" });
  });

  it("hides a moved action in the row and shows its copy in 更多工具, step by step", () => {
    for (const step of [1, 2, 3, 4]) expect(rule(`.timeline-toolbar[data-moved~="${step}"] .timeline-quick-actions > [data-overflow-step="${step}"]`)).toMatchObject({ display: "none" });
    for (const step of [1, 2, 3]) expect(rule(`.timeline-toolbar:not([data-moved~="${step}"]) .timeline-more-popover [data-overflow-copy="${step}"]`)).toMatchObject({ display: "none" });
    expect(rule('.timeline-toolbar[data-fit]:is([data-overflow="5"], [data-overflow="6"]) > div:first-child')).toMatchObject({ display: "none" });
  });

  it("opens 更多工具 where TimelineToolbarFit places it", () => {
    expect(rule(".app-shell[data-interface-mode] .timeline-toolbar[data-fit] .timeline-more-popover")).toMatchObject({
      "inset-block-start": "var(--timeline-more-top, auto)", "inset-block-end": "var(--timeline-more-bottom, 12px)",
      "inset-inline-end": "var(--timeline-more-right, 12px)", "max-height": "var(--timeline-more-max, calc(100dvh - 24px))" });
  });

  it("gives 更多工具 room for the moved actions, no empty heading, and centred words on its button", () => {
    expect(rule(".app-shell[data-interface-mode] .timeline-toolbar[data-fit] .timeline-more-popover")).toMatchObject({ width: "min(520px, calc(100vw - 24px))" });
    expect(rule(".timeline-toolbar[data-fit] .timeline-more-popover :is(.timeline-zoom, .timeline-add-actions)")).toMatchObject({ "grid-template-columns": "repeat(auto-fit, minmax(110px, 1fr))" });
    expect(rule(".timeline-toolbar[data-fit] .timeline-more-popover .ripple-default")).toMatchObject({ display: "inline-flex" });
    expect(rule(".timeline-toolbar[data-fit] .timeline-more > summary")).toMatchObject({ display: "flex", "align-items": "center" });
  });
});

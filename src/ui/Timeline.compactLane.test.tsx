import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

// The production Timeline with hook doubles, as in Timeline.motionLane.test.tsx: these check what the 標題與圖卡 lane
// renders in simple and advanced mode and the 「還有 N 個」／「收起」 button, not mounted browser layout (that was
// measured in headless Chrome at 1280×720 and 1440×900, see timelineMotionLaneLayout.test.ts).
const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], states: [] as { value: unknown }[], refIndex: 0, stateIndex: 0,
  mode: "simple" as "simple" | "advanced" }));
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
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), mode: hooks.mode, t: actual.translateUi }) };
});

type Props = Record<string, unknown> & { children?: ReactNode; style?: Record<string, unknown> };
function all(node: ReactNode, predicate: (props: Props) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, out));
  else if (isValidElement<Props>(node)) { if (predicate(node.props)) out.push(node.props); if (node.props.children) all(node.props.children, predicate, out); }
  return out;
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node)
  : isValidElement<Props>(node) ? text(node.props.children) : "";

/** 主畫面 A [0,4) with four titles over the same seconds, so the lane needs four rows. */
function project(): EditProject {
  const value = createEmptyProject("Compact lane", { id: "compact-lane", width: 1920, height: 1080, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "C:/owned/trip.mp4", duration: 30, width: 1920, height: 1080 }];
  value.tracks[0].clips = [{ id: "A", assetId: "source", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 4, volume: 1,
    transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } }];
  let result = validateProject(value);
  for (const [index, words] of ["王小明", "第一站：九份老街", "第二站：阿妹茶樓", "Editkin 示範"].entries()) {
    result = applyCommand(result, { type: "add_motion_graphic", graphic: createMotionGraphic(`title-${index}`, "title", words, index * 0.25, 3) });
  }
  return result;
}

function harness(mode: "simple" | "advanced") {
  hooks.refs.length = hooks.states.length = 0;
  hooks.mode = mode;
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const value = project(), noop = () => {};
  const render = () => {
    hooks.refIndex = hooks.stateIndex = 0;
    const props: TimelineProps = { project: value, duration: 8, playhead: 0, runtimeUrls: {}, onSeek: noop, onSelect: noop, onSelectCaption: noop,
      onMoveClip: () => true, onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop, onRenameTrack: noop,
      onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop,
      onCommand: () => true };
    const tree = Timeline(props);
    const lane = all(tree, props => props["data-testid"] === "motion-lane-row")[0];
    const blocks = all(tree, props => typeof props["data-motion-block-id"] === "string");
    const more = all(tree, props => props["data-testid"] === "motion-lane-more")[0];
    return { tree, lane, blocks, more };
  };
  return { render };
}
afterEach(() => vi.unstubAllGlobals());

describe("simple mode: compact 標題與圖卡 rows, two at a time", () => {
  it("draws two one-line rows (62 px) and says how many titles wait behind 「還有 N 個」", () => {
    const view = harness("simple").render();
    expect(view.lane.style).toEqual({ height: 62 });
    expect(view.lane).toMatchObject({ "data-motion-rows": 4, "data-motion-visible-rows": 2 });
    expect(String(view.lane.className)).toContain("compact");
    expect(view.blocks).toHaveLength(2);
    for (const block of view.blocks) {
      expect(String(block.className)).toContain("compact");
      expect(block.style).toMatchObject({ top: 3 + Number(block["data-motion-row"]) * 30 });
      // Every block still has its plain spoken name with the kind, the words and the seconds.
      expect(String(block["aria-label"])).toMatch(/^標題「.+」，\d\.\d\d 秒到 \d\.\d\d 秒$/);
    }
    expect(view.more).toMatchObject({ type: "button", "aria-expanded": false, "aria-label": "還有 2 個標題或圖卡沒顯示，按一下全部顯示" });
    expect(text(view.more.children)).toBe("還有 2 個");
  });

  it("opens all four rows from the button and closes them again with 「收起」", () => {
    const timeline = harness("simple");
    (timeline.render().more.onClick as () => void)();
    const open = timeline.render();
    expect(open.blocks).toHaveLength(4);
    expect(open.lane.style).toEqual({ height: 4 * 30 - 4 + 6 });
    expect(open.more).toMatchObject({ "aria-expanded": true, "aria-label": "收起，只顯示兩排標題" });
    expect(text(open.more.children)).toBe("收起");
    (open.more.onClick as () => void)();
    expect(timeline.render().blocks).toHaveLength(2);
  });
});

describe("advanced mode keeps the two-line lane unchanged", () => {
  it("draws every row at 46 px with no 「還有 N 個」 button", () => {
    const view = harness("advanced").render();
    expect(view.lane.style).toEqual({ height: 4 * 46 + 6 });
    expect(view.blocks).toHaveLength(4);
    expect(view.blocks.map(block => (block.style as { top: number }).top).sort((a, b) => a - b)).toEqual([3, 49, 95, 141]);
    expect(view.blocks.every(block => !String(block.className).includes("compact"))).toBe(true);
    expect(view.more).toBeUndefined();
  });
});

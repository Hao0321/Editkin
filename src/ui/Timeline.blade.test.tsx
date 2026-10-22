import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { TRACK_LOCKED_MESSAGE } from "../domain/trackLock";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { BLADE_TOO_CLOSE } from "../application/timelineSplitTarget";
import { EasyIcon } from "./easy/easyIcons";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { BLADE_HELP, BLADE_TOOL_HELP, SELECT_TOOL_BACK, SELECT_TOOL_HELP, type TimelineKeyboardActions, type TimelineProps } from "./timelineContract";

// The production Timeline's handlers with hook doubles (state kept between renders, no mounted DOM): the two tools, the
// 剪刀 click (frame and edge snapping, Shift on every track, a locked track, an edge), and what 剪刀 turns off.
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
import { Timeline } from "./Timeline";

type Props = Record<string, unknown> & { children?: ReactNode };
function all(node: ReactNode, predicate: (props: Props, type: unknown) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, out));
  else if (isValidElement<Props>(node)) { if (predicate(node.props, node.type)) out.push(node.props); if (node.props.children) all(node.props.children, predicate, out); }
  return out;
}
const byTestId = (tree: ReactNode, id: string) => {
  const found = all(tree, props => props["data-testid"] === id);
  expect(found, id).toHaveLength(1);
  return found[0];
};
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node)
  : isValidElement<Props>(node) ? text(node.props.children) : "";
const icons = (node: ReactNode) => all(node, (_props, type) => type === EasyIcon).map(props => props.name);

const FPS = 30;
function clip(id: string, trackId: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "cam", trackId, timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR },
    keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** 主畫面 A[0,4) B[4,8) · 聲音 VO[0,10) · 畫面軌 2 P[5,7) · a caption [1,2). */
function project(lock?: string): EditProject {
  const value = createEmptyProject("Blade", { id: "blade", width: 1920, height: 1080, fps: FPS });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 60, width: 1920, height: 1080 }];
  value.tracks[0].clips = [clip("A", "video-main", 0, 4), clip("B", "video-main", 4, 4)];
  value.tracks[1].clips = [clip("VO", "audio-main", 0, 10)];
  value.tracks.push({ id: "v2", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [clip("P", "v2", 5, 2)] });
  value.captions = [{ id: "c1", text: "字幕", start: 1, duration: 1 }];
  for (const track of value.tracks) if (track.id === lock) track.locked = true;
  return validateProject(value);
}

let props: TimelineProps;
let keys: { current: TimelineKeyboardActions | undefined };
function setup(overrides: Partial<TimelineProps> = {}) {
  hooks.refs.length = hooks.states.length = 0;
  keys = { current: undefined };
  const noop = () => {};
  props = { project: project(), duration: 10, playhead: 9, runtimeUrls: {}, onSeek: vi.fn(), onSelect: vi.fn(), onSelectCaption: vi.fn(),
    onMoveClip: vi.fn(() => true), onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop, onRenameTrack: noop,
    onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: vi.fn(), onDelete: vi.fn(),
    onEditStart: vi.fn(), onEditRefused: vi.fn(), onCut: vi.fn(), onStatus: vi.fn(), onActivateSelection: vi.fn(), onCommand: () => true,
    keyboardActions: keys, ...overrides };
}
function render() {
  hooks.refIndex = hooks.stateIndex = 0;
  return Timeline(props);
}
/** A real pointer click at `seconds` on the lane (80 px a second, the lane's left edge at 0). */
const click = (seconds: number, shiftKey = false) => ({ clientX: seconds * 80, shiftKey, detail: 1, stopPropagation: vi.fn(), preventDefault: vi.fn(),
  currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 0 }) }) } });
const press = () => {
  const target = { setPointerCapture: vi.fn(), focus: vi.fn(), closest: () => null, getBoundingClientRect: () => ({ left: 0, top: 0 }), classList: { add: vi.fn(), remove: vi.fn() } };
  return { button: 0, pointerId: 1, clientX: 400, clientY: 10, altKey: false, currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
};
const blade = () => { (byTestId(render(), "timeline-tool-blade").onClick as () => void)(); return render(); };

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  setup();
});
afterEach(() => { vi.unstubAllGlobals(); interfacePreferences.setMode("simple"); });

describe("the two timeline tools, at the left of the toolbar in both modes", () => {
  it.each(["simple", "advanced"] as const)("%s mode: 選取 (A) is on, 剪刀 (B) next to it, each an icon, a word and its key", mode => {
    interfacePreferences.setMode(mode);
    const tree = render();
    const row = all(tree, item => item.className === "timeline-quick-actions")[0];
    expect(all(row.children as ReactNode, item => typeof item["data-testid"] === "string")[0]["data-testid"]).toBe("timeline-tool-toggle");
    const select = byTestId(tree, "timeline-tool-select"), cut = byTestId(tree, "timeline-tool-blade");
    expect([select["aria-pressed"], cut["aria-pressed"]]).toEqual([true, false]);
    expect([select.title, cut.title]).toEqual([SELECT_TOOL_HELP, BLADE_TOOL_HELP]);
    expect([select["aria-keyshortcuts"], cut["aria-keyshortcuts"]]).toEqual(["A", "B"]);
    expect([icons(select.children as ReactNode), icons(cut.children as ReactNode)]).toEqual([["pointer"], ["scissors"]]);
    expect([text(select.children as ReactNode), text(cut.children as ReactNode)]).toEqual(["選取A", "剪刀B"]);
    expect(byTestId(tree, "timeline-tool-toggle")["data-overflow-step"]).toBeUndefined();
  });

  it("切開 and 刪除 carry the split (playhead between two pieces) and trash icons, their words and their keys in the tooltip", () => {
    const tree = render();
    const split = byTestId(tree, "split-button"), remove = byTestId(tree, "delete-button");
    expect([split.title, split["aria-keyshortcuts"], icons(split.children as ReactNode), text(split.children as ReactNode)])
      .toEqual(["在播放頭切開（Ctrl+B）", "Control+B", ["split"], "切開"]);
    expect([remove.title, remove["aria-keyshortcuts"], icons(remove.children as ReactNode), text(remove.children as ReactNode)])
      .toEqual(["刪除選取的片段（Delete）", "Delete", ["trash"], "刪除"]);
  });
});

describe("剪刀 on", () => {
  it("says how it works, changes the timeline's hint and cursor, and stays on after a cut until A or Esc", () => {
    const tree = blade();
    expect(props.onStatus).toHaveBeenCalledWith(BLADE_HELP);
    expect(all(tree, item => item.className === "timeline-shell")[0]["data-tool"]).toBe("blade");
    expect(byTestId(tree, "timeline-tool-blade")["aria-pressed"]).toBe(true);
    expect(text(all(tree, item => item["aria-label"] === "時間軸")[0].children as ReactNode)).toContain(BLADE_HELP);
    expect(byTestId(tree, "timeline-clip-B").title).toBe(BLADE_HELP);
    (byTestId(tree, "timeline-clip-B").onClick as (event: unknown) => void)(click(6));
    expect(props.onCut).toHaveBeenCalledWith([{ clipId: "B", at: 6 }]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(byTestId(render(), "timeline-tool-blade")["aria-pressed"]).toBe(true);
    // Esc from the editor's key owner takes it back to 選取 (true); once 選取 is on, Esc is not the timeline's (false).
    expect(keys.current?.escapeTool()).toBe(true);
    expect(props.onStatus).toHaveBeenLastCalledWith(SELECT_TOOL_BACK);
    expect(byTestId(render(), "timeline-tool-select")["aria-pressed"]).toBe(true);
    expect(keys.current?.escapeTool()).toBe(false);
    keys.current?.setTool("blade");
    expect(all(render(), item => item.className === "timeline-shell")[0]["data-tool"]).toBe("blade");
    keys.current?.setTool("select");
    expect(all(render(), item => item.className === "timeline-shell")[0]["data-tool"]).toBe("select");
  });

  it("cuts on the frame grid, pulled to the playhead or another clip's edge within 6 px", () => {
    setup({ playhead: 179 / FPS });
    const tree = blade();
    const cutAt = (seconds: number, shiftKey = false) => { (byTestId(tree, "timeline-clip-B").onClick as (event: unknown) => void)(click(seconds, shiftKey)); };
    cutAt(6.51);
    expect(props.onCut).toHaveBeenLastCalledWith([{ clipId: "B", at: 6.5 }]);
    cutAt(6.02);
    expect(props.onCut).toHaveBeenLastCalledWith([{ clipId: "B", at: 179 / FPS }]);
    // 畫面軌 2's P starts at 5 s: a click 0.04 s after it cuts B at exactly 5 s.
    cutAt(5.04);
    expect(props.onCut).toHaveBeenLastCalledWith([{ clipId: "B", at: 5 }]);
    // Shift+click: every unlocked picture and sound track that has a clip there, in one cut list (one Undo).
    cutAt(5.5, true);
    expect(props.onCut).toHaveBeenLastCalledWith([{ clipId: "B", at: 5.5 }, { clipId: "VO", at: 5.5 }, { clipId: "P", at: 5.5 }]);
    expect(props.onCut).toHaveBeenCalledTimes(4);
  });

  it("does nothing within a frame of the clip's edge (gently says so), refuses a locked track, and ignores a keyboard click", () => {
    let tree = blade();
    (byTestId(tree, "timeline-clip-B").onClick as (event: unknown) => void)(click(4.05));
    expect(props.onEditRefused).toHaveBeenLastCalledWith(BLADE_TOO_CLOSE);
    (byTestId(tree, "timeline-clip-B").onClick as (event: unknown) => void)({ ...click(6), detail: 0 });
    expect(props.onCut).not.toHaveBeenCalled();
    setup({ project: project("video-main") });
    tree = blade();
    (byTestId(tree, "timeline-clip-B").onClick as (event: unknown) => void)(click(6));
    expect(props.onEditRefused).toHaveBeenLastCalledWith(TRACK_LOCKED_MESSAGE);
    expect(props.onCut).not.toHaveBeenCalled();
  });

  it("drags, moves and trims nothing, leaves captions alone, and only the ruler moves the playhead", () => {
    // 選取: a press on a clip starts its drag (the control).
    const drag = press();
    (byTestId(render(), "timeline-clip-B").onPointerDown as (event: unknown) => void)(drag);
    expect(drag.currentTarget.setPointerCapture).toHaveBeenCalled();
    setup();
    const tree = blade();
    const still = press();
    (byTestId(tree, "timeline-clip-B").onPointerDown as (event: unknown) => void)(still);
    expect(still.stopPropagation).toHaveBeenCalled();
    expect(still.currentTarget.setPointerCapture).not.toHaveBeenCalled();
    expect(props.onEditStart).not.toHaveBeenCalled();
    // No trim handle gesture either.
    const handle = all(byTestId(tree, "timeline-clip-B").children as ReactNode, item => item.className === "clip-trim-handle start")[0];
    (handle.onPointerDown as (event: unknown) => void)(press());
    expect(props.onEditStart).not.toHaveBeenCalled();
    // A caption click picks nothing and cuts nothing.
    (byTestId(tree, "timeline-caption-c1").onClick as (event: unknown) => void)(click(1.5));
    expect(props.onSelectCaption).not.toHaveBeenCalled();
    expect(props.onCut).not.toHaveBeenCalled();
    // Empty track space: no seek and no scrub; the ruler still moves the playhead.
    const lane = all(tree, item => item["data-track-id"] === "video-main")[0];
    const space = { clientX: 800, currentTarget: { classList: { contains: () => false, add: vi.fn() }, getBoundingClientRect: () => ({ left: 0 }), setPointerCapture: vi.fn() },
      button: 0, pointerId: 2 };
    (lane.onPointerDown as (event: unknown) => void)(space);
    (lane.onClick as (event: unknown) => void)(space);
    expect(space.currentTarget.setPointerCapture).not.toHaveBeenCalled();
    expect(props.onSeek).not.toHaveBeenCalled();
    (byTestId(tree, "timeline-ruler").onClick as (event: unknown) => void)({ clientX: 160,
      currentTarget: { classList: { contains: (name: string) => name === "timeline-ruler" }, getBoundingClientRect: () => ({ left: 0 }) } });
    expect(props.onSeek).toHaveBeenCalledWith(2);
  });
});

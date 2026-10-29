import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { Timeline } from "./Timeline";
import type { TimelineKeyboardActions, TimelineProps } from "./timelineContract";
import { interfacePreferences } from "./i18n/interfacePreferences";

// Direct production handler controls, with hook/element doubles. No mounted DOM,
// media clock or browser gesture acceptance is implied by these controls.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useMemo: (factory: () => unknown) => factory(),
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [typeof value === "function" ? value() : value, () => {}] };
});

type NodeProps = Record<string, unknown> & { children?: ReactNode };
function find(node: ReactNode, predicate: (props: NodeProps) => boolean): NodeProps {
  if (Array.isArray(node)) {
    for (const child of node) { try { return find(child, predicate); } catch { /* continue tree */ } }
  } else if (isValidElement<NodeProps>(node)) {
    if (predicate(node.props)) return node.props;
    if (node.props.children) return find(node.props.children, predicate);
  }
  throw new Error("Production Timeline element not found");
}
function invoke(props: NodeProps, name: string, event: object) {
  const handler = props[name];
  if (typeof handler !== "function") throw new Error(`Missing actual handler ${name}`);
  handler(event);
}
function element() {
  const value = { style: { width: "960px", removeProperty: vi.fn() }, dataset: {} as Record<string, string>,
    classList: { add: vi.fn(), remove: vi.fn() }, setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 960, bottom: 40, width: 960, height: 40 }),
    closest: (_selector: string): unknown => value };
  return value;
}
function fixture(locked = false, selection?: string, activate?: () => void) {
  const project = createDemoProject();
  project.tracks[0].locked = locked;
  let playing = true;
  const order: string[] = [];
  const pause = vi.fn(() => { playing = false; order.push("pause"); });
  const seek = vi.fn(), move = vi.fn(), editSelection = vi.fn();
  const noop = () => {};
  const keys: { current: TimelineKeyboardActions | undefined } = { current: undefined };
  const props: TimelineProps = { project, duration: 12, playhead: 1, runtimeUrls: {}, onEditStart: pause,
    onSeek: seek, onSelect: () => order.push("select"), onSelectCaption: noop, onMoveClip: move, onMoveCaption: noop,
    onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onEditSelection: editSelection, selectedClipId: selection, onAddTrack: noop, onRenameTrack: noop,
    onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop,
    onActivateSelection: activate, keyboardActions: keys };
  const tree = Timeline(props);
  const clip = find(tree, p => p["data-testid"] === "timeline-clip-clip-demo");
  return { tree, clip, pause, seek, move, editSelection, order, keys, playing: () => playing };
}
function pointer(target: ReturnType<typeof element>, button = 0) {
  return { button, currentTarget: target, pointerId: 1, clientX: 16, clientY: 8, altKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

afterEach(() => { interfacePreferences.setMode("simple"); });

describe("timeline edit-start ownership in actual handler closures", () => {
  // The 調整片段 button is an advanced-mode tool since 2026-10-11 (simple mode opens the panel when a clip is picked),
  // so its two checks set advanced mode first.
  it("forwards explicit properties access once without mutating or seeking the clip", () => {
    interfacePreferences.setMode("advanced");
    const f = fixture(false, "clip-demo");
    const button = find(f.tree, p => p["data-testid"] === "edit-selection-button");
    expect(button.disabled).toBe(false);
    invoke(button, "onClick", {});
    expect(f.editSelection).toHaveBeenCalledTimes(1);
    expect(f.move).not.toHaveBeenCalled();
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.order).toEqual([]);
  });
  it.each([undefined, "removed-clip"])("rejects properties access for absent/stale selection %s", selection => {
    interfacePreferences.setMode("advanced");
    const f = fixture(false, selection);
    const button = find(f.tree, p => p["data-testid"] === "edit-selection-button");
    expect(button.disabled).toBe(true);
    invoke(button, "onClick", {});
    expect(f.editSelection).not.toHaveBeenCalled();
  });
  it("pauses before selection/capture and stays paused when a clip drag is canceled", () => {
    const f = fixture(), event = pointer(element());
    invoke(f.clip, "onPointerDown", event);
    expect(f.order).toEqual(["pause", "select"]);
    expect(f.playing()).toBe(false);
    invoke(f.clip, "onPointerCancel", event);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.playing()).toBe(false);
    expect(f.move).not.toHaveBeenCalled();
  });
  it("locked/nonprimary clip gestures neither claim pause nor start an edit", () => {
    const locked = fixture(true);
    invoke(locked.clip, "onPointerDown", pointer(element()));
    expect(locked.pause).not.toHaveBeenCalled();
    const secondary = fixture();
    invoke(secondary.clip, "onPointerDown", pointer(element(), 2));
    expect(secondary.pause).not.toHaveBeenCalled();
  });
  it("a press on a locked clip does not fall through to the lane as a scrub; its click picks it without seeking", () => {
    const locked = fixture(true);
    const target = element(), press = pointer(target);
    invoke(locked.clip, "onPointerDown", press);
    expect(press.stopPropagation).toHaveBeenCalled();
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    expect(locked.order).toEqual([]);
    invoke(locked.clip, "onClick", { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(locked.order).toEqual(["select"]);
    expect(locked.seek).not.toHaveBeenCalled();
  });
  it("real trim handle pauses before capture and cancellation never resumes playback", () => {
    const f = fixture();
    const trim = find(f.clip.children, p => p.className === "clip-trim-handle start");
    const event = pointer(element());
    invoke(trim, "onPointerDown", event);
    expect(f.pause).toHaveBeenCalledTimes(1);
    invoke(trim, "onPointerCancel", event);
    expect(f.playing()).toBe(false);
    expect(f.pause).toHaveBeenCalledTimes(1);
  });
  // Rewritten on purpose (2026-10-11): ← → on a focused clip used to move it here (and blocked frame steps). The clip
  // no longer listens to keys at all: ← → reach the editor's key owner and step the playhead, and Alt+← → ask the
  // timeline (keyboardActions) to nudge the selected clip, still frame by frame.
  it("ruler scrub pauses before seek and remains paused after release; Alt+← → nudge keeps one-frame precision", () => {
    const f = fixture(false, "clip-demo");
    const ruler = find(f.tree, p => p["data-testid"] === "timeline-ruler");
    const event = pointer(element());
    invoke(ruler, "onPointerDown", event);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.seek).toHaveBeenLastCalledWith(.2);
    invoke(ruler, "onPointerUp", event);
    expect(f.playing()).toBe(false);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.clip.onKeyDown).toBeUndefined();
    f.keys.current!.nudge(1, "nudge:1");
    expect(f.move).toHaveBeenCalledWith("clip-demo", 1 / 30, "video-main", { coalesce: "nudge:1" });
    expect(f.pause).toHaveBeenCalledTimes(2);
  });
  it("Alt+← → leave a clip on a locked track where it is and say why", () => {
    const refused = vi.fn();
    const project = createDemoProject();
    project.tracks[0].locked = true;
    const keys: { current: TimelineKeyboardActions | undefined } = { current: undefined };
    const noop = () => {};
    Timeline({ project, duration: 12, playhead: 1, runtimeUrls: {}, onSeek: noop, onSelect: noop, onSelectCaption: noop, onMoveClip: noop, onMoveCaption: noop,
      onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, selectedClipId: "clip-demo", onAddTrack: noop, onRenameTrack: noop, onToggleTrackLock: noop,
      onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop, onEditRefused: refused, keyboardActions: keys });
    keys.current!.nudge(-1, "nudge:2");
    expect(refused).toHaveBeenCalledWith("這個軌道已鎖定，先解鎖才能修改。");
  });
  it("simple mode: a click on a clip asks the shell to open its panel; a press that starts a drag does not", () => {
    interfacePreferences.setMode("simple");
    const pressed = vi.fn(), clicked = vi.fn();
    const drag = fixture(false, undefined, pressed);
    invoke(drag.clip, "onPointerDown", pointer(element()));
    expect(drag.order).toEqual(["pause", "select"]);
    expect(pressed).not.toHaveBeenCalled();
    const click = fixture(false, undefined, clicked);
    invoke(click.clip, "onClick", { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(click.order).toEqual(["select"]);
    expect(clicked).toHaveBeenCalledTimes(1);
    // Picking a clip never moves the playhead (it used to jump to the clip's first frame, so B cut at the edge).
    expect(click.seek).not.toHaveBeenCalled();
    expect(() => find(click.tree, p => p["data-testid"] === "edit-selection-button")).toThrow();
  });
});

// Direct handler/hook-double controls isolate the new subscription. Real React
// localization and browser state continuity are checked in separate suites.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});

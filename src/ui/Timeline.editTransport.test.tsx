import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

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
function fixture(locked = false) {
  const project = createDemoProject();
  project.tracks[0].locked = locked;
  let playing = true;
  const order: string[] = [];
  const pause = vi.fn(() => { playing = false; order.push("pause"); });
  const seek = vi.fn(), move = vi.fn();
  const noop = () => {};
  const props: TimelineProps = { project, duration: 12, playhead: 1, runtimeUrls: {}, onEditStart: pause,
    onSeek: seek, onSelect: () => order.push("select"), onSelectCaption: noop, onMoveClip: move, onMoveCaption: noop,
    onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop, onRenameTrack: noop,
    onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop };
  const tree = Timeline(props);
  const clip = find(tree, p => p["data-testid"] === "timeline-clip-clip-demo");
  return { tree, clip, pause, seek, move, order, playing: () => playing };
}
function pointer(target: ReturnType<typeof element>, button = 0) {
  return { button, currentTarget: target, pointerId: 1, clientX: 16, clientY: 8, altKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("timeline edit-start ownership in actual handler closures", () => {
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
  it("ruler scrub pauses before seek and remains paused after release; keyboard nudge keeps one-frame precision", () => {
    const f = fixture();
    const ruler = find(f.tree, p => p["data-testid"] === "timeline-ruler");
    const event = pointer(element());
    invoke(ruler, "onPointerDown", event);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.seek).toHaveBeenLastCalledWith(.2);
    invoke(ruler, "onPointerUp", event);
    expect(f.playing()).toBe(false);
    expect(f.pause).toHaveBeenCalledTimes(1);
    invoke(f.clip, "onKeyDown", { key: "ArrowRight", shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(f.move).toHaveBeenCalledWith("clip-demo", 1 / 30, "video-main");
    expect(f.pause).toHaveBeenCalledTimes(2);
  });
});

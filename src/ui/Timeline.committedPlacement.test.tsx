import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { planTimelineClipMove } from "../application/timelinePlacement";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

// Production handlers, placement/history and reveal effect; hook/DOM doubles.
// These controls do not certify a mounted browser gesture or installed GUI.
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], states: [] as { value: unknown }[],
  refIndex: 0, stateIndex: 0,
  effects: [] as { run: () => unknown; deps: unknown[] }[],
}));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useMemo: (factory: () => unknown) => factory(),
    useRef: (value: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: value }),
    useState: (value: unknown) => {
      const index = hooks.stateIndex++;
      const state = hooks.states[index] ?? (hooks.states[index] = { value: typeof value === "function" ? value() : value });
      return [state.value, (next: unknown) => { state.value = typeof next === "function" ? next(state.value) : next; }];
    },
    useEffect: (run: () => unknown, deps: unknown[]) => hooks.effects.push({ run, deps }),
  };
});
type Props = Record<string, unknown> & { children?: ReactNode };
function find(node: ReactNode, testId: string): Props {
  if (Array.isArray(node)) {
    for (const child of node) { try { return find(child, testId); } catch { /* next child */ } }
  } else if (isValidElement<Props>(node)) {
    if (node.props["data-testid"] === testId) return node.props;
    if (node.props.children) return find(node.props.children, testId);
  }
  throw new Error(`Missing production Timeline element ${testId}`);
}
function invoke(props: Props, name: string, event: object) {
  const handler = props[name];
  if (typeof handler !== "function") throw new Error(`Missing production handler ${name}`);
  handler(event);
}
function classes() {
  const values = new Set<string>();
  return { add: (...names: string[]) => names.forEach(name => values.add(name)),
    remove: (...names: string[]) => names.forEach(name => values.delete(name)),
    contains: (name: string) => values.has(name),
    toggle: (name: string, on: boolean) => on ? values.add(name) : values.delete(name) };
}
function fixture(collision: boolean, appendedTop: number, scrollLeft = 0) {
  hooks.refs.length = hooks.states.length = 0;
  vi.stubGlobal("localStorage", { getItem: () => "off" });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const project = createDemoProject();
  const source = { ...project.tracks[0].clips[0], duration: 1 };
  project.tracks[0].clips = [source, { ...source, id: "clip-neighbour", timelineStart: collision ? 1 : 8 }];
  let history = createHistory(project);
  const node = { scrollLeft, scrollTop: 0, clientLeft: 0, clientTop: 0, clientWidth: 900,
    clientHeight: 208, scrollWidth: 1500, scrollHeight: 1000, dataset: {} as Record<string, string>,
    contains: (element: { isConnected: boolean }) => element.isConnected,
    getBoundingClientRect: () => ({ left: 0, right: 900, top: 0, bottom: 208 }),
    querySelector: (_selector: string) => ({ getBoundingClientRect: () => ({ bottom: 52 }) }),
    querySelectorAll: (_selector: string) => history.present.tracks.map(track => lane(track.id)),
  };
  function lane(trackId: string) {
    const track = history.present.tracks.find(item => item.id === trackId)!;
    const top = trackId === "video-main" ? 52 : trackId.startsWith("video-track-") ? appendedTop : 104;
    return { dataset: { trackId, trackKind: track.kind, trackLocked: String(track.locked) }, classList: classes(),
      getBoundingClientRect: () => ({ left: 188, right: 1500, top: top - node.scrollTop, bottom: top + 52 - node.scrollTop }),
      querySelectorAll: (_selector: string) => track.clips.map(clip => button(clip.id)),
    };
  }
  function button(id: string) {
    const style: Record<string, unknown> = { removeProperty: (key: string) => { delete style[key]; } };
    return { isConnected: true, style, dataset: { testid: `timeline-clip-${id}` }, classList: classes(), setPointerCapture: vi.fn(),
      closest: () => lane(history.present.tracks.find(track => track.clips.some(clip => clip.id === id))!.id),
      getBoundingClientRect: () => {
        const track = history.present.tracks.find(item => item.clips.some(clip => clip.id === id))!;
        const clip = track.clips.find(item => item.id === id)!;
        const row = lane(track.id).getBoundingClientRect();
        return { left: 188 + clip.timelineStart * 80 - node.scrollLeft, right: 188 + (clip.timelineStart + clip.duration) * 80 - node.scrollLeft,
          top: row.top + 5, bottom: row.bottom - 5 };
      },
    };
  }
  const noop = () => {};
  const seek = vi.fn();
  const move = vi.fn((clipId: string, start: number, trackId: string) => {
    const placement = planTimelineClipMove(history.present, clipId, trackId, start, prefix => `${prefix}-collision`);
    history = dispatchCommand(history, placement.command, "move-once");
    return true;
  });
  const props = (value = history.present): TimelineProps => ({ project: value, duration: 12, playhead: 0,
    selectedClipId: source.id, runtimeUrls: {}, onSeek: seek, onSelect: noop, onSelectCaption: noop,
    onMoveClip: move, onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop,
    onAddTrack: noop, onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop,
    onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop });
  const render = (value = history.present) => {
    hooks.refIndex = hooks.stateIndex = 0; hooks.effects = [];
    const tree = Timeline(props(value)); hooks.refs[0].current = node;
    return tree;
  };
  const reveal = () => {
    const effect = hooks.effects.find(item => item.deps?.length === 3 && typeof item.deps[1] === "string");
    if (!effect) throw new Error("Production selection reveal effect missing");
    effect.run();
  };
  const target = button(source.id);
  const pointer = (clientX: number, clientY = 80, pointerId = 1) => ({ button: 0, currentTarget: target, pointerId, clientX, clientY,
    altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const dragOneSecond = () => {
    const item = find(render(), `timeline-clip-${source.id}`);
    invoke(item, "onPointerDown", pointer(220));
    invoke(item, "onPointerMove", pointer(300));
    invoke(item, "onPointerUp", pointer(300));
  };
  return { node, project, render, reveal, dragOneSecond, move, seek, pointer, history: () => history };
}
afterEach(() => vi.unstubAllGlobals());
describe("accepted timeline placements retain or reveal the actual selected row", () => {
  it("reveals an offscreen collision layer after delayed controlled props; one Undo restores clip and layer", () => {
    const f = fixture(true, 600);
    f.dragOneSecond();
    expect(f.move).toHaveBeenCalledExactlyOnceWith("clip-demo", 1, "video-main");
    expect(f.history().past).toHaveLength(1);
    const added = f.history().present.tracks.find(track => track.id === "video-track-collision")!;
    expect(added.clips[0]).toMatchObject({ id: "clip-demo", timelineStart: 1, sourceStart: 0, duration: 1 });
    f.render(f.project); f.reveal(); // Accepted callback, old controlled graph still visible.
    expect(f.node.scrollTop).toBe(0);
    f.render(); f.reveal();
    expect(f.node.scrollTop).toBeGreaterThan(400);
    expect(f.node.scrollLeft).toBe(0);
    const restored = undo(f.history());
    expect(restored.present.tracks.some(track => track.id === added.id)).toBe(false);
    expect(restored.present.tracks[0].clips[0]).toMatchObject({ id: "clip-demo", timelineStart: 0, sourceStart: 0, duration: 1 });
    expect(restored.present.tracks[0].clips[1]).toMatchObject({ id: "clip-neighbour", timelineStart: 1 });
  });
  it("keeps the viewport when the actual new layer is already visible", () => {
    const f = fixture(true, 104);
    f.dragOneSecond(); f.render(); f.reveal();
    expect(f.history().present.tracks.some(track => track.id === "video-track-collision")).toBe(true);
    expect(f.node.scrollTop).toBe(0);
    expect(f.node.scrollLeft).toBe(0);
  });
  it("does not reveal the old source or reposition an ordinary accepted drag", () => {
    const f = fixture(false, 600, 37);
    f.dragOneSecond(); f.render(f.project); f.reveal(); f.render(); f.reveal();
    expect(f.history().present.tracks).toHaveLength(f.project.tracks.length);
    expect(f.history().present.tracks[0].clips[0]).toMatchObject({ id: "clip-demo", timelineStart: 1 });
    expect(f.node.scrollLeft).toBe(37);
    expect(f.node.scrollTop).toBe(0);
  });
});

describe("current pointer ownership and invalid-release follow-up", () => {
  it.each(["release", "cancel"])("keeps a %s over an incompatible row from seeking the old source; the next click still works", finish => {
    const f = fixture(false, 600);
    const item = find(f.render(), "timeline-clip-clip-demo");
    invoke(item, "onPointerDown", f.pointer(220));
    invoke(item, "onPointerMove", f.pointer(300, 130));
    invoke(item, finish === "release" ? "onPointerUp" : "onPointerCancel", f.pointer(300, 130));
    invoke(item, "onClick", f.pointer(300, 130));
    expect(f.move).not.toHaveBeenCalled();
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.history().past).toHaveLength(0);
    invoke(item, "onPointerDown", f.pointer(220));
    invoke(item, "onPointerUp", f.pointer(220));
    invoke(item, "onClick", f.pointer(220));
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("retains the first capture when another pointer attempts to start an edit", () => {
    const f = fixture(false, 600);
    const item = find(f.render(), "timeline-clip-clip-demo");
    invoke(item, "onPointerDown", f.pointer(220));
    invoke(item, "onPointerDown", f.pointer(400, 80, 2));
    invoke(item, "onPointerMove", f.pointer(300));
    invoke(item, "onPointerUp", f.pointer(300));
    expect(f.move).toHaveBeenCalledExactlyOnceWith("clip-demo", 1, "video-main");
    expect(f.history().past).toHaveLength(1);
  });
  it("preserves the captured frame clock when Fit is requested before release", () => {
    const f = fixture(false, 600);
    const tree = f.render(), item = find(tree, "timeline-clip-clip-demo");
    invoke(item, "onPointerDown", f.pointer(220));
    invoke(find(tree, "timeline-fit-button"), "onClick", {});
    const current = find(f.render(), "timeline-clip-clip-demo");
    invoke(current, "onPointerMove", f.pointer(300));
    invoke(current, "onPointerUp", f.pointer(300));
    expect(f.move).toHaveBeenCalledExactlyOnceWith("clip-demo", 1, "video-main");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import { createHistory, dispatchCommand, undo } from "../domain/history";
import { useTimelineCanvasEditing } from "./useTimelineCanvasEditing";
const effects = vi.hoisted(() => ({ callbacks: [] as Array<() => unknown> }));
afterEach(() => vi.unstubAllGlobals());
vi.mock("react", async load => ({ ...await load<typeof import("react")>(), useRef: (value: unknown) => ({ current: value }), useState: () => [undefined, vi.fn()], useEffect: (callback: () => unknown) => { effects.callbacks.push(callback); } }));

function fixture() {
  effects.callbacks.length = 0;
  const project = createDemoProject(), base = structuredClone(project.tracks[0].clips[0]);
  project.tracks[0].clips = [0, 4].map((timelineStart, i) => ({ ...structuredClone(base), id: i ? "B" : "A", timelineStart, duration: 2 })); project.captions = [];
  const classes = { contains: () => false, remove: vi.fn(), toggle: vi.fn() }, style = { removeProperty: vi.fn(), transform: "" };
  const lane = { dataset: { trackId: "video-main", trackKind: "video" }, getBoundingClientRect: () => ({ top: 10, bottom: 90 }), matches: () => true,
    focus: vi.fn(), setPointerCapture: vi.fn(), classList: classes, style };
  const elements = [
    { dataset: { testid: "timeline-clip-A" }, getBoundingClientRect: () => ({ left: 10, top: 10, right: 80, bottom: 40 }), classList: classes, style },
    { dataset: { testid: "timeline-caption-caption" }, getBoundingClientRect: () => ({ left: 10, top: 50, right: 80, bottom: 80 }), classList: classes, style },
  ];
  const node = { addEventListener: vi.fn(), removeEventListener: vi.fn(), scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelectorAll: (selector: string) => selector.includes("track-lane") ? [lane] : elements };
  const selection = vi.fn(), command = vi.fn(), refused = vi.fn();
  const host = { project, scrollRef: { current: node as unknown as HTMLDivElement }, pixelsPerSecond: 80, playing: false, playhead: 0,
    selection: { clipIds: ["A", "B"], captionIds: [] }, onSelectionChange: selection, onCommand: command, onRefused: refused, otherBusy: () => false };
  const hook = useTimelineCanvasEditing(host);
  const event = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    currentTarget: lane, target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as import("react").PointerEvent<HTMLDivElement>;
  return { project, hook, event, selection, command, refused };
}
describe("canvas pointer ownership", () => {
  it("Escape cancels a group and consumes its trailing item click without creating an edit", () => {
    const { hook, event, command, selection } = fixture(); let escape: ((event: KeyboardEvent) => void) | undefined;
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => { if (name === "keydown") escape = listener; }, removeEventListener: vi.fn() });
    effects.callbacks[0]();
    hook.beginGroup(event(50, 50) as unknown as import("react").PointerEvent<HTMLButtonElement>, { kind: "clip", id: "A", trackId: "video-main", start: 0 });
    hook.moveGroup(event(130, 50)); escape!({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);
    expect(hook.busy()).toBe(false); expect(hook.consumeClick("item")).toBe(true); expect(command).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled();
  });
  it("marquee selects intersecting clips/captions while making no project command and consumes the trailing lane click", () => {
    const { hook, event, selection, command } = fixture(); expect(hook.beginMarquee(event(100, 100))).toBe(true);
    hook.moveMarquee(event(0, 0)); hook.finishMarquee(event(0, 0));
    expect(selection.mock.calls.at(-1)?.[0]).toMatchObject({ clipIds: ["A"], captionIds: ["caption"] });
    expect(command).not.toHaveBeenCalled(); expect(hook.consumeClick("lane")).toBe(true); expect(hook.consumeClick("lane")).toBe(false);
  });
  it("cancelling marquee restores the selection at pointer-down", () => {
    const { hook, event, selection } = fixture(); hook.beginMarquee(event(100, 100)); hook.moveMarquee(event(0, 0)); hook.finishMarquee(event(0, 0), true);
    expect(selection.mock.calls.at(-1)?.[0]).toEqual({ clipIds: ["A", "B"], captionIds: [] }); expect(hook.busy()).toBe(false);
  });
  it("a captured group drag preserves selection and makes one batch/Undo on release", () => {
    const { project, hook, event, selection, command } = fixture();
    const button = (x: number) => event(x, 50) as unknown as import("react").PointerEvent<HTMLButtonElement>;
    expect(hook.beginGroup(button(50), { kind: "clip", id: "A", trackId: "video-main", start: 0 })).toBe(true);
    hook.moveGroup(button(130)); hook.finishGroup(button(130)); expect(selection).not.toHaveBeenCalled(); expect(command).toHaveBeenCalledTimes(1);
    const history = dispatchCommand(createHistory(project), command.mock.calls[0][0]);
    expect(history.present.tracks[0].clips.map(c => c.timelineStart)).toEqual([1, 5]); expect(history.past).toHaveLength(1);
    expect(undo(history).present.tracks).toEqual(project.tracks); expect(hook.consumeClick("item")).toBe(true);
  });
  it("cancelling a group drag does not create an edit or collapse the selection", () => {
    const { hook, event, selection, command } = fixture();
    hook.beginGroup(event(50, 50) as unknown as import("react").PointerEvent<HTMLButtonElement>, { kind: "clip", id: "A", trackId: "video-main", start: 0 });
    hook.moveGroup(event(130, 50)); hook.finishGroup(event(130, 50), true);
    expect(command).not.toHaveBeenCalled(); expect(selection).not.toHaveBeenCalled(); expect(hook.busy()).toBe(false);
  });
});

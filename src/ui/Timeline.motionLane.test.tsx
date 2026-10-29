import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommandSafely, undo, type EditorHistory } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { createMotionGraphic } from "../motion/composition";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { TEMPLATE_EDITOR_REQUEST_EVENT } from "./templateEditorRequests";
import { TEMPLATE_DELETE_REFUSAL, TEMPLATE_TRIM_REFUSAL } from "./timelineMotionBlocks";
import { MOTION_LANE_READONLY_HELP, PENDING_MOVE_REFUSAL, type TimelineKeyboardActions } from "./timelineContract";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

// Production Timeline handlers with hook and element doubles, as in the other Timeline suites: these check the actual
// gesture → command path on the 標題與圖卡 lane, not mounted browser layout or installed GUI input.
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

type Props = Record<string, unknown> & { children?: ReactNode };
function all(node: ReactNode, predicate: (props: Props) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, out));
  else if (isValidElement<Props>(node)) { if (predicate(node.props)) out.push(node.props); if (node.props.children) all(node.props.children, predicate, out); }
  return out;
}
function find(node: ReactNode, predicate: (props: Props) => boolean): Props {
  const found = all(node, predicate)[0];
  if (!found) throw new Error("Production Timeline element not found");
  return found;
}
function call(props: Props, name: string, event: object) {
  const handler = props[name];
  if (typeof handler !== "function") throw new Error(`Missing production handler ${name}`);
  handler(event);
}
function element(dataset: Record<string, string> = {}) {
  const classes = new Set<string>(), properties = new Map<string, string>();
  const value = {
    isConnected: true, dataset,
    style: { width: "", transform: "", removeProperty: (key: string) => { properties.delete(key); if (key === "transform") value.style.transform = ""; },
      setProperty: (key: string, v: string) => properties.set(key, v) },
    classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)), remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
      contains: (name: string) => classes.has(name), toggle: (name: string, on?: boolean) => (on ?? !classes.has(name)) ? classes.add(name) : classes.delete(name) },
    setPointerCapture: vi.fn(), focus: vi.fn(),
    closest: (): unknown => value,
    getBoundingClientRect: () => ({ left: 188, right: 428, top: 57, bottom: 99, width: 240, height: 42 }),
    classes, properties,
  };
  return value;
}
function clip(id: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart: 2, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** 主畫面: A [0,4) and B [4,8) at 30 fps; a title on A at 1 s for 2 s. */
function project(): EditProject {
  const value = createEmptyProject("Motion lane", { id: "motion-lane", width: 1080, height: 1920, fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "C:/owned/trip.mp4", duration: 30, width: 1080, height: 1920 }];
  value.tracks[0].clips = [clip("A", 0, 4), clip("B", 4, 4)];
  return applyCommand(validateProject(value), { type: "add_motion_graphic", graphic: createMotionGraphic("title-a", "title", "大家好", 1, 2) });
}
/** B carries a saved template that owns one graphic (fixture metadata; it is not CURRENT, so it moves without being re-recorded). */
function withTemplate(value: EditProject): EditProject {
  const owned = applyCommand(value, { type: "add_motion_graphic", graphic: createMotionGraphic("template-title", "title", "其實是水簾", 4, 4) });
  return applyCommand(owned, { type: "upsert_reference_motion_instance", instance: {
    schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: "B", startFrame: 120, durationFrames: 120, title: "其實是水簾", sources: [],
      intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: value.width, height: value.height, fps: value.fps },
    roles: [{ key: "source:0:clip", kind: "clip", id: "B", parentId: "video-main" }, { key: "heading", kind: "graphic", id: "template-title" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
  } });
}

function harness(initial: EditProject, options: { command?: boolean; liveFrames?: boolean; selectedClipId?: string } = {}) {
  hooks.refs.length = hooks.states.length = 0;
  vi.stubGlobal("localStorage", { getItem: () => "off", setItem: () => {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn((frame: (time: number) => void) => { if (options.liveFrames) frame(0); return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const dispatched: Event[] = [];
  vi.stubGlobal("document", { dispatchEvent: (event: Event) => { dispatched.push(event); return true; } });
  let history: EditorHistory = createHistory(initial);
  const statuses: string[] = [];
  // The editor's runner: a held nudge's commands share `coalesce`, so they make one Undo step.
  const runCommand = vi.fn((command: Parameters<typeof applyCommand>[1], message?: string, edit?: { coalesce?: string }) => {
    const result = dispatchCommandSafely(history, command, `cmd-${runCommand.mock.calls.length}`, undefined, edit?.coalesce);
    history = result.state; statuses.push(result.error ?? message ?? "");
    return !result.error;
  });
  const refused = vi.fn((message: string) => statuses.push(message));
  const move = vi.fn(() => true), trim = vi.fn(), select = vi.fn(), seek = vi.fn();
  // Filled in by the timeline on each render: what the editor's key owner asks for Alt+← → and Delete.
  const keys: { current: TimelineKeyboardActions | undefined } = { current: undefined };
  const blocks = new Map<string, ReturnType<typeof element>>(), clips = new Map<string, ReturnType<typeof element>>();
  const captions = new Map<string, ReturnType<typeof element>>();
  const node = { scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0, clientWidth: 900, clientHeight: 300, scrollWidth: 2000, scrollHeight: 300,
    dataset: {} as Record<string, string>, contains: () => true, getBoundingClientRect: () => ({ left: 0, right: 900, top: 0, bottom: 300 }),
    querySelector: (selector: string) => captions.get(selector.match(/data-testid="([^"]+)"/)?.[1] ?? "") ?? null,
    querySelectorAll: (selector: string) => selector.includes("data-motion-block-id") ? [...(selector.includes(".timeline-clip") ? clips.values() : []), ...blocks.values()]
      : selector.includes(".track-lane") ? history.present.tracks.map(track => lane(track.id)) : [] };
  function lane(trackId: string) {
    const track = history.present.tracks.find(item => item.id === trackId)!, top = 52 + 52 * history.present.tracks.indexOf(track);
    return { dataset: { trackId, trackKind: track.kind, trackLocked: String(track.locked) }, classList: element().classList,
      getBoundingClientRect: () => ({ left: 188, right: 1500, top, bottom: top + 52 }) };
  }
  const render = () => {
    hooks.refIndex = hooks.stateIndex = 0;
    const noop = () => {};
    const props: TimelineProps = { project: history.present, duration: 8, playhead: 0, runtimeUrls: {}, onSeek: seek, onSelect: select, onSelectCaption: noop,
      onMoveClip: move, onMoveCaption: noop, onTrimClip: trim, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop, onRenameTrack: noop,
      onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop,
      onEditRefused: refused, ...(options.command === false ? {} : { onCommand: runCommand }), selectedClipId: options.selectedClipId, keyboardActions: keys };
    const tree = Timeline(props);
    hooks.refs[0].current = node;
    return tree;
  };
  const registerBlocks = (tree: ReactNode) => {
    for (const props of all(tree, item => typeof item["data-motion-block-id"] === "string")) {
      const id = props["data-motion-block-id"] as string;
      if (!blocks.has(id)) blocks.set(id, element({ motionBlockId: id, ...(props["data-bound-clip-id"] ? { boundClipId: props["data-bound-clip-id"] as string } : {}) }));
    }
    for (const props of all(tree, item => typeof item["data-testid"] === "string" && (item["data-testid"] as string).startsWith("timeline-clip-"))) {
      const id = props["data-testid"] as string;
      if (!clips.has(id)) clips.set(id, element({ testid: id }));
    }
    for (const props of all(tree, item => typeof item["data-testid"] === "string" && (item["data-testid"] as string).startsWith("timeline-caption-"))) {
      const id = props["data-testid"] as string;
      if (!captions.has(id)) captions.set(id, element({ testid: id }));
    }
  };
  const pointer = (target: unknown, clientX: number, extra: object = {}) => ({ button: 0, pointerId: 9, clientX, clientY: 30, altKey: false,
    currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra });
  const block = (tree: ReactNode, id: string) => find(tree, props => props["data-motion-block-id"] === id);
  const drag = (id: string, fromX: number, toX: number) => {
    const tree = render(); registerBlocks(tree);
    const target = blocks.get(id)!, item = block(tree, id);
    call(item, "onPointerDown", pointer(target, fromX));
    call(item, "onPointerMove", pointer(target, toX));
    call(item, "onPointerUp", pointer(target, toX));
    return target;
  };
  const trimBlock = (id: string, edge: "start" | "end", fromX: number, toX: number) => {
    const tree = render(); registerBlocks(tree);
    const button = blocks.get(id)!, grip = find(block(tree, id).children, props => props.className === `clip-trim-handle ${edge} motion-trim-handle`);
    const target = { ...element(), closest: () => button };
    call(grip, "onPointerDown", pointer(target, fromX));
    call(grip, "onPointerMove", pointer(target, toX));
    call(grip, "onPointerUp", pointer(target, toX));
    return button;
  };
  return { render, registerBlocks, runCommand, refused, move, trim, select, seek, statuses, dispatched, blocks, clips, captions, pointer, block, drag, trimBlock,
    keys, history: () => history };
}
afterEach(() => vi.unstubAllGlobals());

const graphic = (value: EditProject, id: string) => value.motionGraphics.find(item => item.id === id)!;
const mainClip = (value: EditProject, id: string) => value.tracks[0].clips.find(item => item.id === id)!;

describe("the 標題與圖卡 lane shows titles and templates as blocks", () => {
  it("draws one block per free title and one per template, on the frame grid, with plain labels", () => {
    const f = harness(withTemplate(project()));
    const tree = f.render();
    const lane = find(tree, props => props["data-testid"] === "motion-lane-row");
    expect(lane.style).toEqual({ height: 52 });
    const title = f.block(tree, "graphic:title-a"), template = f.block(tree, "template:owner");
    expect(title).toMatchObject({ "data-motion-kind": "graphic", "data-bound-clip-id": "A", "data-start-frame": 30, "data-end-frame": 90,
      "aria-label": "標題「大家好」，1.00 秒到 3.00 秒" });
    expect(title.style).toMatchObject({ left: 80, width: 160 });
    expect(template).toMatchObject({ "data-motion-kind": "template", "data-bound-clip-id": "B", "aria-label": "標題模板「其實是水簾」，4.00 秒到 8.00 秒" });
  });
  it("adds no lane when the project has no titles or graphics", () => {
    const value = project(); value.motionGraphics = [];
    expect(all(harness(value).render(), props => props["data-testid"] === "motion-lane-row")).toHaveLength(0);
  });
});

describe("dragging and trimming blocks: one command each, same frame grid as clips", () => {
  it("moves a free title by 0.5 s (40 px at 80 px/s) in one command; one Undo restores it", () => {
    const f = harness(project());
    f.drag("graphic:title-a", 200, 240);
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.runCommand.mock.calls[0][0]).toEqual({ type: "update_motion_graphic", graphicId: "title-a", patch: { timelineStart: 1.5 } });
    expect(f.statuses.at(-1)).toBe("已把「大家好」移到 1.50 秒；一次復原即可還原。");
    expect(graphic(undo(f.history()).present, "title-a").timelineStart).toBe(1);
  });
  it("selects the title and its main clip without moving anything on a plain click", () => {
    const f = harness(project());
    const tree = f.render(); f.registerBlocks(tree);
    const target = f.blocks.get("graphic:title-a")!, item = f.block(tree, "graphic:title-a");
    call(item, "onPointerDown", f.pointer(target, 200));
    call(item, "onPointerUp", f.pointer(target, 201));
    call(item, "onClick", { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.select).toHaveBeenCalledWith("A");
    // Rewritten on purpose (2026-10-11): picking a title used to move the playhead to its first frame. Picking never
    // moves the playhead now; it stays where the creator parked it.
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.block(f.render(), "graphic:title-a").className).toContain("selected");
  });
  it("trims the end of a free title by 0.5 s and keeps its start", () => {
    const f = harness(project());
    f.trimBlock("graphic:title-a", "end", 300, 260);
    expect(f.runCommand.mock.calls[0][0]).toEqual({ type: "update_motion_graphic", graphicId: "title-a", patch: { timelineStart: 1, duration: 1.5 } });
  });
  it("drags a template block: its main clip and the template move together in one command", async () => {
    const f = harness(withTemplate(project()));
    f.history();
    // B [4,8) moves later by 1 s; nothing else is in the way on 主畫面.
    f.drag("template:owner", 400, 480);
    await vi.waitFor(() => expect(f.runCommand).toHaveBeenCalledOnce());
    const moved = f.history().present;
    expect(mainClip(moved, "B").timelineStart).toBe(5);
    expect(graphic(moved, "template-title").timelineStart).toBe(5);
    expect(f.statuses.at(-1)).toBe("已把標題模板「其實是水簾」和主片段一起移到 5.00 秒；標題模板要重新套用後才能改字；一次復原即可還原。");
    const restored = undo(f.history()).present;
    expect(mainClip(restored, "B").timelineStart).toBe(4);
    expect(graphic(restored, "template-title").timelineStart).toBe(4);
  });
  it("refuses to trim a template block and says why, without a command", () => {
    const f = harness(withTemplate(project()));
    f.trimBlock("template:owner", "end", 700, 650);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.refused).toHaveBeenCalledWith(TEMPLATE_TRIM_REFUSAL);
  });
  it("is read-only without a command runner: a drag explains instead of moving", () => {
    const f = harness(project(), { command: false });
    f.drag("graphic:title-a", 200, 260);
    expect(f.runCommand).not.toHaveBeenCalled();
    expect(f.refused).toHaveBeenCalledWith(MOTION_LANE_READONLY_HELP);
  });
});

describe("keys on a block", () => {
  // Rewritten on purpose (2026-10-11): ← → on a focused block used to move it. ← → now always step the playhead (the
  // editor's key owner); the block leaves them alone. Alt+← → (Alt+Shift: ten frames) move the picked block through the
  // timeline's keyboard actions; Delete on the focused block still removes a free title.
  it("← → are left to the playhead, Alt+→ nudges the picked title, Delete removes a free title, a template refuses Delete", () => {
    const f = harness(withTemplate(project()));
    const keys = (id: string, key: string, shiftKey = false) => {
      const event = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      call(f.block(f.render(), id), "onKeyDown", event);
      return event;
    };
    const plain = keys("graphic:title-a", "ArrowRight", true);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    expect(plain.stopPropagation).not.toHaveBeenCalled();
    expect(f.runCommand).not.toHaveBeenCalled();
    call(f.block(f.render(), "graphic:title-a"), "onClick", { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    f.render();
    f.keys.current!.nudge(10, "nudge:7");
    expect(f.runCommand.mock.calls[0][0]).toEqual({ type: "update_motion_graphic", graphicId: "title-a", patch: { timelineStart: 40 / 30 } });
    expect(f.runCommand.mock.calls[0][2]).toEqual({ coalesce: "nudge:7" });
    keys("graphic:title-a", "Delete");
    expect(f.runCommand.mock.calls[1][0]).toEqual({ type: "delete_motion_graphic", graphicId: "title-a" });
    keys("template:owner", "Delete");
    expect(f.refused).toHaveBeenCalledWith(TEMPLATE_DELETE_REFUSAL);
    expect(f.runCommand).toHaveBeenCalledTimes(2);
  });
  it("Delete from the editor's key owner removes a picked free title instead of the clip under it", () => {
    const f = harness(project());
    expect(f.render() && f.keys.current!.deleteSelection()).toBe(false);
    call(f.block(f.render(), "graphic:title-a"), "onClick", { preventDefault: vi.fn(), stopPropagation: vi.fn() });
    f.render();
    expect(f.keys.current!.deleteSelection()).toBe(true);
    expect(f.runCommand.mock.calls[0][0]).toEqual({ type: "delete_motion_graphic", graphicId: "title-a" });
    expect(mainClip(f.history().present, "A")).toBeDefined();
  });
  it("Enter on a template block asks the template editor to open on that template", () => {
    const f = harness(withTemplate(project()));
    call(f.block(f.render(), "template:owner"), "onKeyDown", { key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0].type).toBe(TEMPLATE_EDITOR_REQUEST_EVENT);
    expect((f.dispatched[0] as CustomEvent).detail).toEqual({ instanceId: "owner", source: "timeline" });
  });
});

describe("a clip carries the titles bound to it", () => {
  it("previews the bound title riding along, then moves both in one command", async () => {
    const f = harness(project(), { liveFrames: true });
    const tree = f.render(); f.registerBlocks(tree);
    const clipButton = find(tree, props => props["data-testid"] === "timeline-clip-A"), target = element();
    call(clipButton, "onPointerDown", f.pointer(target, 100, { clientY: 80 }));
    call(clipButton, "onPointerMove", f.pointer(target, 740, { clientY: 80 }));
    expect(f.blocks.get("graphic:title-a")!.style.transform).toBe("translate3d(640px,0,0)");
    expect(f.blocks.get("graphic:title-a")!.classes.has("is-following")).toBe(true);
    call(clipButton, "onPointerUp", f.pointer(target, 740, { clientY: 80 }));
    expect(f.blocks.get("graphic:title-a")!.style.transform).toBe("");
    expect(f.move).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.runCommand).toHaveBeenCalledOnce());
    const moved = f.history().present;
    expect(mainClip(moved, "A").timelineStart).toBe(8);
    expect(graphic(moved, "title-a").timelineStart).toBe(9);
    expect(f.statuses.at(-1)).toBe("已把片段移到 8.00 秒，上面的標題也一起移動；一次復原即可還原。");
  });
  // Rewritten on purpose (2026-10-11): the held key is Alt+→ now (← → alone step the playhead), and the editor's key
  // owner sends its repeats with one shared key, so the whole hold is one Undo step.
  it("a held Alt+→ waits for a clip's titles to land instead of piling up moves; a drag meanwhile is refused; one Undo for the hold", async () => {
    const start = applyCommand(project(), { type: "move_clip", clipId: "B", timelineStart: 6 });
    const f = harness(start, { liveFrames: true, selectedClipId: "A" });
    const frame = (seconds: number) => Math.round(seconds * 30);
    const nudge = () => { f.render(); f.keys.current!.nudge(1, "nudge:1"); };
    nudge(); nudge(); nudge();
    const tree = f.render(), clipButton = find(tree, props => props["data-testid"] === "timeline-clip-A"), target = element();
    call(clipButton, "onPointerDown", f.pointer(target, 300, { clientY: 80 }));
    call(clipButton, "onPointerMove", f.pointer(target, 380, { clientY: 80 }));
    call(clipButton, "onPointerUp", f.pointer(target, 380, { clientY: 80 }));
    expect(f.refused).toHaveBeenCalledExactlyOnceWith(PENDING_MOVE_REFUSAL);
    await vi.waitFor(() => expect(f.runCommand).toHaveBeenCalledOnce());
    expect(frame(mainClip(f.history().present, "A").timelineStart)).toBe(1);
    expect(frame(graphic(f.history().present, "title-a").timelineStart)).toBe(31);
    await new Promise(resolve => setTimeout(resolve, 0));
    nudge();
    await vi.waitFor(() => expect(f.runCommand).toHaveBeenCalledTimes(2));
    expect(frame(mainClip(f.history().present, "A").timelineStart)).toBe(2);
    expect(frame(graphic(f.history().present, "title-a").timelineStart)).toBe(32);
    expect(f.move).not.toHaveBeenCalled();
    expect(f.history().past).toHaveLength(1);
    const restored = undo(f.history()).present;
    expect(mainClip(restored, "A").timelineStart).toBe(0);
    expect(graphic(restored, "title-a").timelineStart).toBe(1);
  });
  it("a clip with nothing bound keeps the editor's own move", () => {
    const value = project(); value.motionGraphics = [];
    const f = harness(value, { liveFrames: true });
    const tree = f.render(), clipButton = find(tree, props => props["data-testid"] === "timeline-clip-A"), target = element();
    call(clipButton, "onPointerDown", f.pointer(target, 100, { clientY: 80 }));
    call(clipButton, "onPointerMove", f.pointer(target, 740, { clientY: 80 }));
    call(clipButton, "onPointerUp", f.pointer(target, 740, { clientY: 80 }));
    expect(f.move).toHaveBeenCalledWith("A", 8, "video-main");
    expect(f.runCommand).not.toHaveBeenCalled();
  });
  it("a head trim of a clip keeps a title lined up with the clip start lined up, in one command", () => {
    const value = applyCommand(project(), { type: "update_motion_graphic", graphicId: "title-a", patch: { timelineStart: 0 } });
    const f = harness(value);
    const tree = f.render();
    const button = element(), target = { ...element(), closest: () => button };
    const grip = find(find(tree, props => props["data-testid"] === "timeline-clip-A").children, props => props.className === "clip-trim-handle start");
    call(grip, "onPointerDown", f.pointer(target, 188));
    call(grip, "onPointerMove", f.pointer(target, 228));
    call(grip, "onPointerUp", f.pointer(target, 228));
    expect(f.trim).not.toHaveBeenCalled();
    const trimmed = f.history().present;
    expect(mainClip(trimmed, "A")).toMatchObject({ timelineStart: 0.5, duration: 3.5 });
    expect(graphic(trimmed, "title-a")).toMatchObject({ timelineStart: 0.5, duration: 1.5 });
    expect(f.statuses.at(-1)).toBe("已修剪片段開頭 0.50 秒，貼齊這個邊的標題也一起調整；一次復原即可還原。");
  });
});

describe("captions and title templates follow clip edits made on the timeline", () => {
  it("previews the captions inside a dragged clip riding along, then moves them with the clip in one command", async () => {
    const value = applyCommand(project(), { type: "add_caption", caption: { id: "in", text: "第一句", start: 1.5, duration: 1 } });
    const f = harness(value, { liveFrames: true });
    const tree = f.render(); f.registerBlocks(tree);
    const clipButton = find(tree, props => props["data-testid"] === "timeline-clip-A"), target = element();
    call(clipButton, "onPointerDown", f.pointer(target, 100, { clientY: 80 }));
    call(clipButton, "onPointerMove", f.pointer(target, 740, { clientY: 80 }));
    expect(f.captions.get("timeline-caption-in")!.style.transform).toBe("translate3d(640px,0,0)");
    expect(f.captions.get("timeline-caption-in")!.classes.has("is-following")).toBe(true);
    call(clipButton, "onPointerUp", f.pointer(target, 740, { clientY: 80 }));
    expect(f.captions.get("timeline-caption-in")!.style.transform).toBe("");
    await vi.waitFor(() => expect(f.runCommand).toHaveBeenCalledOnce());
    const moved = f.history().present;
    expect([mainClip(moved, "A").timelineStart, graphic(moved, "title-a").timelineStart, moved.captions[0].start]).toEqual([8, 9, 9.5]);
    expect(f.statuses.at(-1)).toBe("已把片段移到 8.00 秒，上面的標題和 1 段字幕也一起移動；一次復原即可還原。");
    expect(undo(f.history()).present.captions[0].start).toBe(1.5);
  });
  it("says before the drop when captions riding with the clip would land on another caption, and moves nothing", () => {
    // A [0,4) holds "in" [2.5,3.5); "next" [5,6) belongs to no clip. A moved 2 s later would put "in" on "next".
    const spaced = applyCommand(project(), { type: "move_clip", clipId: "B", timelineStart: 12 });
    const value = applyCommand(spaced, { type: "batch", commands: [
      { type: "add_caption", caption: { id: "in", text: "第一句", start: 2.5, duration: 1 } },
      { type: "add_caption", caption: { id: "next", text: "第二句", start: 5, duration: 1 } }] });
    const f = harness(value, { liveFrames: true });
    const tree = f.render(); f.registerBlocks(tree);
    const clipButton = find(tree, props => props["data-testid"] === "timeline-clip-A"), target = element();
    call(clipButton, "onPointerDown", f.pointer(target, 100, { clientY: 80 }));
    call(clipButton, "onPointerMove", f.pointer(target, 260, { clientY: 80 }));
    call(clipButton, "onPointerUp", f.pointer(target, 260, { clientY: 80 }));
    expect(f.refused).toHaveBeenCalledExactlyOnceWith("字幕「第一句」跟著片段移過去，會和字幕「第二句」疊在一起；請換個位置。");
    expect(f.runCommand).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled();
    expect(f.history().present.captions.map(caption => caption.start)).toEqual([2.5, 5]);
  });
  it("a trim of a template's main clip goes through the template, as one command, and says plainly when the template did not follow", async () => {
    const f = harness(withTemplate(project()));
    const tree = f.render();
    const button = element(), target = { ...element(), closest: () => button };
    const grip = find(find(tree, props => props["data-testid"] === "timeline-clip-B").children, props => props.className === "clip-trim-handle end");
    call(grip, "onPointerDown", f.pointer(target, 828));
    call(grip, "onPointerMove", f.pointer(target, 788));
    call(grip, "onPointerUp", f.pointer(target, 788));
    expect(f.trim).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.runCommand).toHaveBeenCalledOnce());
    expect(mainClip(f.history().present, "B")).toMatchObject({ timelineStart: 4, duration: 3.5 });
    // This fixture's template is metadata only (not current), so it stays as it was and the status says so.
    expect(f.statuses.at(-1)).toBe("已修剪片段結尾 0.50 秒；標題模板「其實是水簾」沒有跟著改，打開模板編輯器可以看原因並重新套用；一次復原即可還原。");
    expect(f.history().past).toHaveLength(1);
  });
});


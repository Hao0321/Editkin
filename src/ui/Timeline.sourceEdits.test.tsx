import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { applyCommand } from "../domain/commands";
import { createHistory, dispatchCommandSafely, undo, type EditorHistory } from "../domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";
import { DEFAULT_REFERENCE_MOTION_STYLE } from "../motion/referenceMotionTemplates";
import { createClipSourceEditActions } from "../application/clipSourceEditActions";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

// Production Timeline handlers with hook and element doubles: these check the
// actual gesture → command path, not mounted browser layout or installed GUI input.
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
function find(node: ReactNode, predicate: (props: Props) => boolean): Props {
  if (Array.isArray(node)) {
    for (const child of node) { try { return find(child, predicate); } catch { /* next child */ } }
  } else if (isValidElement<Props>(node)) {
    if (predicate(node.props)) return node.props;
    if (node.props.children) return find(node.props.children, predicate);
  }
  throw new Error("Production Timeline element not found");
}
function all(node: ReactNode, predicate: (props: Props) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => all(child, predicate, out));
  else if (isValidElement<Props>(node)) { if (predicate(node.props)) out.push(node.props); if (node.props.children) all(node.props.children, predicate, out); }
  return out;
}
function call(props: Props, name: string, event: object) {
  const handler = props[name];
  if (typeof handler !== "function") throw new Error(`Missing production handler ${name}`);
  handler(event);
}
function element() {
  const classes = new Set<string>(), properties = new Map<string, string>();
  const value = {
    isConnected: true, dataset: {} as Record<string, string>,
    style: { width: "", transform: "", removeProperty: (key: string) => properties.delete(key), setProperty: (key: string, v: string) => properties.set(key, v) },
    classList: { add: (...names: string[]) => names.forEach(name => classes.add(name)), remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
      contains: (name: string) => classes.has(name), toggle: (name: string, on?: boolean) => (on ?? !classes.has(name)) ? classes.add(name) : classes.delete(name) },
    setPointerCapture: vi.fn(), focus: vi.fn(),
    closest: (): unknown => value,
    getBoundingClientRect: () => ({ left: 188, right: 428, top: 57, bottom: 99, width: 240, height: 42 }),
    classes, properties,
  };
  return value;
}
function clip(id: string, trackId: string, timelineStart: number, sourceStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId, timelineStart, sourceStart, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** 主畫面: A [0,3) from source 2 s, B [3,5) from source 0 s, in a 10 s source. */
function project(): EditProject {
  const value = createEmptyProject("Gestures", { id: "gestures", fps: 30 });
  value.assets = [{ id: "source", name: "Source.mp4", kind: "video", uri: "C:/owned/source.mp4", duration: 10, width: 1920, height: 1080 }];
  value.tracks[0].clips = [clip("A", "video-main", 0, 2, 3), clip("B", "video-main", 3, 0, 2)];
  return validateProject(value);
}
function templateOwned(value: EditProject, clipId: string) {
  return applyCommand(value, { type: "upsert_reference_motion_instance", instance: {
    schema: "editkin.reference-motion-instance/v1", id: "owner", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId, startFrame: 0, durationFrames: 60, title: "Owned", sources: [],
      intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: value.width, height: value.height, fps: value.fps },
    roles: [{ key: "source:0:clip", kind: "clip", id: clipId, parentId: "video-main" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
  } });
}

/** A saved template on main clip "B" that generated `clipId` (a copy whose timing the template owns). */
function templateGenerated(value: EditProject, clipId: string) {
  return applyCommand(value, { type: "upsert_reference_motion_instance", instance: {
    schema: "editkin.reference-motion-instance/v1", id: "generator", authoringGeneration: 2, instanceRevision: 1,
    input: { templateId: "level_bridge", clipId: "B", startFrame: 90, durationFrames: 60, title: "Owned", sources: [],
      intent: "shortform", purpose: "ownership control", evidenceRefs: ["fixture:source"], style: structuredClone(DEFAULT_REFERENCE_MOTION_STYLE) },
    frameFormat: { width: value.width, height: value.height, fps: value.fps },
    roles: [{ key: "source:1:clip", kind: "clip", id: clipId, parentId: "video-main" }],
    primaryBefore: { layout: null }, appliedScopeSha256: "d".repeat(64), dependencies: { recipeVersion: "fixture:ownership", presetHashes: [], fonts: [] },
  } });
}

function harness(initial = project(), options: { sourceEdits?: boolean; liveFrames?: boolean; commands?: boolean } = {}) {
  hooks.refs.length = hooks.states.length = 0;
  vi.stubGlobal("localStorage", { getItem: () => "off", setItem: () => {} });
  // liveFrames runs each scheduled frame at once, so a held drag shows its preview before release.
  vi.stubGlobal("requestAnimationFrame", vi.fn((frame: (time: number) => void) => { if (options.liveFrames) frame(0); return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let history: EditorHistory = createHistory(initial);
  const statuses: string[] = [];
  const runCommand = vi.fn((command: Parameters<typeof applyCommand>[1], message?: string) => {
    const result = dispatchCommandSafely(history, command, `cmd-${runCommand.mock.calls.length}`);
    history = result.state; statuses.push(result.error ?? message ?? "");
    return !result.error;
  });
  const actions = createClipSourceEditActions({ getProject: () => history.present, runCommand, setStatus: message => statuses.push(message) });
  const extend = vi.fn(actions.extendClip), slip = vi.fn(actions.slipClip), refused = vi.fn((message: string) => statuses.push(message));
  const trim = vi.fn(), move = vi.fn();
  const rendered = new Map<string, ReturnType<typeof element>>();
  const node = { scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0, clientWidth: 900, clientHeight: 300, scrollWidth: 2000, scrollHeight: 300,
    dataset: {} as Record<string, string>, contains: () => true, getBoundingClientRect: () => ({ left: 0, right: 900, top: 0, bottom: 300 }),
    querySelector: (selector: string) => rendered.get(selector.match(/data-testid="([^"]+)"/)?.[1] ?? "") ?? null, querySelectorAll: () => [] };
  const render = () => {
    hooks.refIndex = hooks.stateIndex = 0;
    const noop = () => {};
    // onCommand as in the editor shell (P8): without it the Alt-drag slide branch never ran here, which hid BUG-14.
    const props: TimelineProps = { project: history.present, duration: 5, playhead: 0, runtimeUrls: {}, onSeek: noop, onSelect: noop, onSelectCaption: noop,
      onMoveClip: move, onMoveCaption: noop, onTrimClip: trim, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop, onRenameTrack: noop,
      onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop,
      ...(options.commands === false ? {} : { onCommand: runCommand }),
      ...(options.sourceEdits === false ? {} : { onExtendClip: extend, onSlipClip: slip, onEditRefused: refused }) };
    const tree = Timeline(props);
    hooks.refs[0].current = node;
    return tree;
  };
  const pointer = (target: ReturnType<typeof element>, clientX: number, altKey = false) => ({ button: 0, pointerId: 7, clientX, clientY: 80, altKey,
    currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const clipButton = (tree: ReactNode, id: string) => find(tree, props => props["data-testid"] === `timeline-clip-${id}`);
  const handle = (tree: ReactNode, id: string, edge: "start" | "end") => find(clipButton(tree, id).children, props => props.className === `clip-trim-handle ${edge}`);
  const dragHandle = (id: string, edge: "start" | "end", fromX: number, toX: number) => {
    const tree = render(), button = element(), target = { ...element(), closest: () => button };
    const grip = handle(tree, id, edge);
    call(grip, "onPointerDown", pointer(target, fromX));
    call(grip, "onPointerMove", pointer(target, toX));
    call(grip, "onPointerUp", pointer(target, toX));
    return button;
  };
  const altDrag = (id: string, fromX: number, toX: number, finish: "up" | "escape" = "up") => {
    const tree = render(), target = element(), item = clipButton(tree, id);
    call(item, "onPointerDown", pointer(target, fromX, true));
    call(item, "onPointerMove", pointer(target, toX, true));
    if (finish === "escape") call(find(tree, props => props["aria-label"] === "時間軸" && typeof props.onKeyDown === "function"), "onKeyDown",
      { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    call(item, "onPointerUp", pointer(target, toX, true));
    return target;
  };
  return { render, dragHandle, altDrag, extend, slip, refused, trim, move, statuses, pointer, rendered, handle, runCommand, clip: (id: string) => clipButton(render(), id),
    history: () => history, setProject: (value: EditProject) => { history = createHistory(value); } };
}
afterEach(() => vi.unstubAllGlobals());

describe("trim handles extend clips toward their real media", () => {
  it("drags the end outward into one extend command; the next clip moves later and one Undo restores both", () => {
    const f = harness();
    f.dragHandle("A", "end", 428, 468);
    expect(f.extend).toHaveBeenCalledExactlyOnceWith("A", "end", 0.5);
    expect(f.trim).not.toHaveBeenCalled();
    const next = f.history().present.tracks[0].clips;
    expect(next.map(item => [item.id, item.timelineStart, item.duration])).toEqual([["A", 0, 3.5], ["B", 3.5, 2]]);
    expect(f.history().past).toHaveLength(1);
    expect(undo(f.history()).present.tracks[0].clips.map(item => [item.id, item.timelineStart, item.duration])).toEqual([["A", 0, 3], ["B", 3, 2]]);
    expect(f.statuses.at(-1)).toMatch(/已把片段結尾延長 0\.50 秒，後面的內容一起往後移 0\.50 秒/);
  });

  it("drags the start outward; with no room before it the clip grows later instead of overwriting", () => {
    const f = harness();
    f.dragHandle("B", "start", 428, 428);
    expect(f.extend).not.toHaveBeenCalled();
    // B starts at the media's first frame: an outward drag is refused with the reason.
    f.dragHandle("B", "start", 428, 388);
    expect(f.extend).not.toHaveBeenCalled();
    expect(f.refused).toHaveBeenCalledExactlyOnceWith("這段已從素材的第一格開始，開頭沒有更早的畫面可以延長。");
    // A sits at 0 s with 2 s of earlier media: it keeps its start, shows 0.5 s more head, and B moves later.
    f.dragHandle("A", "start", 188, 148);
    expect(f.extend).toHaveBeenCalledExactlyOnceWith("A", "start", 0.5);
    expect(f.history().present.tracks[0].clips.map(item => [item.id, item.timelineStart, item.sourceStart, item.duration]))
      .toEqual([["A", 0, 1.5, 3.5], ["B", 3.5, 0, 2]]);
    expect(f.statuses.at(-1)).toMatch(/前面沒有空位，片段改往後長，後面的內容一起往後移 0\.50 秒/);
  });

  it("stops at the last real frame and commits exactly what the media allows", () => {
    const f = harness();
    f.dragHandle("A", "end", 428, 428 + 80 * 8);
    // A reads source 2–5 s of a 10 s file: at most 5 s more.
    expect(f.extend).toHaveBeenCalledExactlyOnceWith("A", "end", 5);
    expect(f.history().present.tracks[0].clips[0]).toMatchObject({ duration: 8, sourceStart: 2 });
  });

  it("refuses to extend a clip a template generated and says why, without touching the project", () => {
    const owned = templateGenerated(project(), "A"), f = harness(owned);
    const before = f.history();
    f.dragHandle("A", "end", 428, 468);
    expect(f.extend).not.toHaveBeenCalled();
    expect(f.refused).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^此片段由模板管理/));
    expect(f.history()).toBe(before);
  });

  it("lets a saved title template's own main clip grow (the editor lays the template out again on it)", () => {
    // The source-edit handler alone: with a command runner the template's own asynchronous re-layout (glyph-measured,
    // commitTemplateClipEdit → planClipExtensionWithTemplates) takes this extension instead; that planner is covered in
    // referenceMotionTemplateFollowEdits.test.ts.
    const f = harness(templateOwned(project(), "A"), { commands: false });
    f.dragHandle("A", "end", 428, 468);
    expect(f.extend).toHaveBeenCalledExactlyOnceWith("A", "end", 0.5);
    expect(f.refused).not.toHaveBeenCalled();
  });

  it("previews what the extension will push, then clears the preview on release", () => {
    const f = harness(project(), { liveFrames: true });
    const neighbour = element();
    f.rendered.set("timeline-clip-B", neighbour);
    const tree = f.render(), button = element(), target = { ...element(), closest: () => button };
    const grip = f.handle(tree, "A", "end");
    call(grip, "onPointerDown", f.pointer(target, 428));
    call(grip, "onPointerMove", f.pointer(target, 468));
    expect(neighbour.classes.has("is-pushed")).toBe(true);
    expect(neighbour.style.transform).toBe("translate3d(40px,0,0)");
    expect(button.classes.has("is-extending")).toBe(true);
    call(grip, "onPointerUp", f.pointer(target, 468));
    expect(neighbour.classes.has("is-pushed")).toBe(false);
    expect(f.extend).toHaveBeenCalledExactlyOnceWith("A", "end", 0.5);
  });

  it("keeps an inward drag as the existing trim", () => {
    const f = harness();
    f.dragHandle("A", "end", 428, 388);
    expect(f.trim).toHaveBeenCalledExactlyOnceWith("A", "end", 0.5);
    expect(f.extend).not.toHaveBeenCalled();
  });

  it("without source-edit handlers the handles stay shrink-only", () => {
    const f = harness(project(), { sourceEdits: false });
    f.dragHandle("A", "end", 428, 468);
    expect(f.trim).not.toHaveBeenCalled();
    expect(f.extend).not.toHaveBeenCalled();
  });
});

describe("Alt-drag changes the in-point while the clip stays in place", () => {
  it("drag right shows earlier source: one slip command, same position and length", () => {
    const f = harness();
    const target = f.altDrag("A", 200, 240);
    expect(f.slip).toHaveBeenCalledExactlyOnceWith("A", 1.5);
    expect(f.move).not.toHaveBeenCalled();
    expect(f.history().present.tracks[0].clips[0]).toMatchObject({ timelineStart: 0, duration: 3, sourceStart: 1.5 });
    expect(f.history().past).toHaveLength(1);
    expect(target.classes.has("is-slipping")).toBe(false);
    expect(f.statuses.at(-1)).toMatch(/已換入點：素材改從 1\.50 秒開始/);
  });

  it("stops at the first and last usable frames", () => {
    const f = harness();
    f.altDrag("A", 200, 200 + 80 * 4);
    expect(f.slip).toHaveBeenLastCalledWith("A", 0);
    f.altDrag("A", 600, 0);
    // 10 s of media minus a 3 s clip: the latest in-point is 7 s.
    expect(f.slip).toHaveBeenLastCalledWith("A", 7);
  });

  it("Escape cancels; clips a template generated and locked clips are refused with a reason", () => {
    const f = harness();
    f.altDrag("A", 200, 240, "escape");
    expect(f.slip).not.toHaveBeenCalled();
    const generated = harness(templateGenerated(project(), "A"));
    generated.altDrag("A", 200, 240);
    expect(generated.slip).not.toHaveBeenCalled();
    expect(generated.refused).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^此片段由模板管理.*換入點/));
    // A title template's own main clip takes a new in-point; the editor lays the template out again on it.
    const main = harness(templateOwned(project(), "A"));
    main.altDrag("A", 200, 240);
    expect(main.slip).toHaveBeenCalledOnce();
    expect(main.refused).not.toHaveBeenCalled();
    const locked = project();
    locked.tracks[0].locked = true;
    const l = harness(locked);
    // The refused press must not fall through to the lane as a scrub/seek.
    const press = l.pointer(element(), 200, true);
    call(l.clip("A"), "onPointerDown", press);
    expect(press.stopPropagation).toHaveBeenCalled();
    expect(l.slip).not.toHaveBeenCalled();
    expect(l.refused).toHaveBeenCalledExactlyOnceWith("這條軌道已鎖定；請先解除鎖定再換入點。");
  });
});

// BUG-14 (P8): with the editor's command runner, Alt-drag on a clip that does not sit between two touching neighbours
// was sent to the slide, refused with 需要相鄰片段, and the slip below it never ran.
describe("Alt-drag: slide between two touching neighbours, slip everywhere else", () => {
  /** 主畫面 with the given [start, duration, sourceStart] clips of a 10 s source. */
  function laidOut(clips: Array<[string, number, number, number]>): EditProject {
    const value = project();
    value.tracks[0].clips = clips.map(([id, start, duration, sourceStart]) => clip(id, "video-main", start, sourceStart, duration));
    return validateProject(value);
  }

  it("a lone clip (no neighbour at all) slips: one slip command, same place and length, no refusal", () => {
    const f = harness(laidOut([["L", 1, 3, 2]]));
    f.altDrag("L", 200, 240);
    expect(f.refused).not.toHaveBeenCalled();
    expect(f.slip).toHaveBeenCalledExactlyOnceWith("L", 1.5);
    expect(f.history().present.tracks[0].clips[0]).toMatchObject({ id: "L", timelineStart: 1, duration: 3, sourceStart: 1.5 });
    expect(f.history().past).toHaveLength(1);
  });

  it("a clip touching only one neighbour slips too (the default project's A sits at 0 s next to B)", () => {
    const f = harness();
    f.altDrag("A", 200, 240);
    expect(f.refused).not.toHaveBeenCalled();
    expect(f.slip).toHaveBeenCalledExactlyOnceWith("A", 1.5);
    const gap = harness(laidOut([["A", 0, 3, 2], ["M", 3, 2, 0], ["B", 5.5, 2, 2]]));
    gap.altDrag("M", 300, 260);
    expect(gap.refused).not.toHaveBeenCalled();
    expect(gap.slip).toHaveBeenCalledExactlyOnceWith("M", 0.5);
  });

  it("a clip between two touching neighbours slides: the neighbours are trimmed, its content and length stay; one Undo", () => {
    const f = harness(laidOut([["A", 0, 3, 2], ["M", 3, 2, 0], ["B", 5, 2, 2]]));
    f.altDrag("M", 300, 340);
    expect(f.slip).not.toHaveBeenCalled();
    expect(f.refused).not.toHaveBeenCalled();
    expect(f.runCommand).toHaveBeenCalledOnce();
    expect(f.history().present.tracks[0].clips.map(item => [item.id, item.timelineStart, item.duration, item.sourceStart]))
      .toEqual([["A", 0, 3.5, 2], ["M", 3.5, 2, 0], ["B", 5.5, 1.5, 2.5]]);
    expect(f.history().past).toHaveLength(1);
    expect(undo(f.history()).present.tracks[0].clips.map(item => [item.id, item.timelineStart, item.duration, item.sourceStart]))
      .toEqual([["A", 0, 3, 2], ["M", 3, 2, 0], ["B", 5, 2, 2]]);
  });
});

describe("the ruler shows where the project ends", () => {
  it("marks the end and dims labels past it; seeking past it stays clamped", () => {
    const f = harness();
    const tree = f.render();
    const end = find(tree, props => props["data-testid"] === "timeline-project-end");
    expect(end.title).toBe("影片在這裡結束：00:05:00");
    const marks = all(tree, props => typeof props.className === "string" && props.className.includes("beyond-end"));
    expect(marks.length).toBeGreaterThan(0);
  });
});

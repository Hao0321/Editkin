import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Static markup uses real React; the interaction cases call the production component with stateful hook doubles
// (no mounted DOM or browser focus).
const hooks = vi.hoisted(() => ({ active: false, states: [] as { value: unknown }[], refs: [] as { current: unknown }[], index: 0, refIndex: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useEffect: (...args: Parameters<typeof actual.useEffect>) => hooks.active ? undefined : actual.useEffect(...args),
    useRef: (value: unknown) => {
      if (!hooks.active) return actual.useRef(value);
      const index = hooks.refIndex++;
      return hooks.refs[index] ?? (hooks.refs[index] = { current: value });
    },
    useState: (value: unknown) => {
      if (!hooks.active) return actual.useState(value);
      const index = hooks.index++;
      const state = hooks.states[index] ?? (hooks.states[index] = { value: typeof value === "function" ? value() : value });
      return [state.value, (next: unknown) => { state.value = typeof next === "function" ? next(state.value) : next; }];
    } };
});
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { CLIP_START_NOT_MOVED, ClipStartField } from "./ClipStartField";
import { applyCommand } from "../domain/commands";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";

type Props = Record<string, unknown> & { children?: ReactNode };
function find(node: ReactNode, predicate: (props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return undefined; }
  if (!isValidElement<Props>(node)) return undefined;
  if (predicate(node.props)) return node.props;
  return node.props.children ? find(node.props.children, predicate) : undefined;
}
function interactive(onMove: (start: number) => boolean | void | Promise<boolean>, timelineStart = 2, project?: EditProject) {
  hooks.active = true; hooks.states = []; hooks.refs = [];
  const move = vi.fn(onMove);
  const render = () => { hooks.index = 0; hooks.refIndex = 0; return ClipStartField({ clipId: "A", timelineStart, fps: 30, onMove: move, project }) as ReactNode; };
  const input = () => find(render(), props => props["data-testid"] === "clip-start-input")!;
  const type = (text: string) => (input().onChange as (event: object) => void)({ target: { value: text } });
  const key = (name: string) => (input().onKeyDown as (event: object) => void)({ key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const blur = () => (input().onBlur as () => void)();
  const error = () => find(render(), props => props["data-testid"] === "clip-start-error");
  return { move, input, type, key, blur, error, done: () => { hooks.active = false; } };
}

describe("Inspector start-time field", () => {
  it("shows the start in seconds and says that Enter applies it", () => {
    hooks.active = false;
    const html = renderToStaticMarkup(<ClipStartField clipId="A" timelineStart={2.5} fps={30} onMove={() => true} />);
    expect(html).toContain("片段從第幾秒開始");
    expect(html).toContain('value="2.5"');
    expect(html).toContain("輸入秒數後按 Enter 套用。");
  });

  it("moves the clip once for a whole typed value, on the nearest frame, only on Enter", () => {
    const f = interactive(() => true);
    f.type("1"); f.type("12"); f.type("12.51");
    expect(f.move).not.toHaveBeenCalled();
    f.key("Enter");
    expect(f.move).toHaveBeenCalledExactlyOnceWith(12.5);
    f.done();
  });

  it("also applies when leaving the field, and does nothing for an unchanged value", () => {
    const f = interactive(() => true);
    f.type("2.0"); f.blur();
    expect(f.move).not.toHaveBeenCalled();
    f.type("3"); f.blur();
    expect(f.move).toHaveBeenCalledExactlyOnceWith(3);
    f.done();
  });

  it("refuses a negative or empty value in plain words; Escape goes back", () => {
    const f = interactive(() => true);
    f.type("-1"); f.key("Enter");
    expect(f.move).not.toHaveBeenCalled();
    expect(String(f.error()?.children)).toBe("請輸入 0 或更大的秒數。");
    f.key("Escape");
    expect(f.input().value).toBe("2");
    expect(f.error()).toBeUndefined();
    f.done();
  });

  it("shows the current start again when the editor refuses the move, now or after a moment", async () => {
    const now = interactive(() => false);
    now.type("9"); now.key("Enter");
    expect(now.input().value).toBe("2");
    now.done();
    const later = interactive(() => Promise.resolve(false));
    later.type("9"); later.key("Enter");
    expect(later.input().value).toBe("9");
    await Promise.resolve(); await Promise.resolve();
    expect(later.input().value).toBe("2");
    later.done();
  });
});

function clip(id: string, timelineStart: number, duration: number): TimelineClip {
  return { id, assetId: "source", trackId: "video-main", timelineStart, sourceStart: 0, duration, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER } };
}
/** 主畫面 A [0,4) with caption "in" [1,3); B [4,8) with caption "b" [5,6). */
function project(): EditProject {
  const value = createEmptyProject("Start field", { id: "start-field", fps: 30 });
  value.assets = [{ id: "source", name: "旅行.mp4", kind: "video", uri: "D:/owned/trip.mp4", duration: 30, width: 1920, height: 1080 }];
  value.tracks[0].clips = [clip("A", 0, 4), clip("B", 4, 4)];
  return applyCommand(validateProject(value), { type: "batch", commands: [
    { type: "add_caption", caption: { id: "in", text: "第一句", start: 1, duration: 2 } },
    { type: "add_caption", caption: { id: "b", text: "第二句", start: 5, duration: 1 } }] });
}

describe("Inspector start-time refusals are explained right under the field", () => {
  it("says why a move would be refused before anything moves, and keeps the typed value to fix", () => {
    const f = interactive(() => true, 0, project());
    f.type("4"); f.key("Enter");
    expect(f.move).not.toHaveBeenCalled();
    expect(String(f.error()?.children)).toBe("字幕「第一句」跟著片段移過去，會和字幕「第二句」疊在一起；請換個位置。");
    expect(f.error()?.role).toBe("alert");
    expect(f.input().value).toBe("4");
    expect(f.input()["aria-invalid"]).toBe(true);
    f.type("12"); expect(f.error()).toBeUndefined();
    f.key("Enter");
    expect(f.move).toHaveBeenCalledExactlyOnceWith(12);
    f.done();
  });
  it("names a locked track in plain words under the field", () => {
    const locked = applyCommand(project(), { type: "toggle_track_lock", trackId: "video-main" });
    const f = interactive(() => true, 0, locked);
    f.type("10"); f.blur();
    expect(f.move).not.toHaveBeenCalled();
    expect(String(f.error()?.children)).toMatch(/鎖定/);
    f.done();
  });
  it("when the editor refuses after starting, says so under the field and shows the current start again", async () => {
    const f = interactive(() => Promise.resolve(false), 0, project());
    f.type("12"); f.key("Enter");
    await Promise.resolve(); await Promise.resolve();
    expect(f.input().value).toBe("0");
    expect(String(f.error()?.children)).toBe(CLIP_START_NOT_MOVED);
    f.done();
  });
});

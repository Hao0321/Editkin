import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject, validateProject } from "../domain/editGraph";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type EditProject, type TimelineClip } from "../domain/types";

// BUG-15 (P8): a right-click on a clip with nothing to offer (an unlinked sound or picture clip on its own) opened an
// empty role="menu", which owned the keyboard until a click, a scroll or Esc, so every editing key seemed dead. The real
// hook and menu with useState/useEffect doubles; the global key owner is checked with the same DOM selector it uses.
const hooks = vi.hoisted(() => ({ states: [] as { value: unknown }[], index: 0 }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => {
      const state = hooks.states[hooks.index] ?? (hooks.states[hooks.index] = { value });
      hooks.index++;
      return [state.value, (next: unknown) => { state.value = next; }];
    } };
});
vi.mock("react-dom", () => ({ createPortal: (tree: ReactNode) => tree }));
vi.mock("./i18n/interfacePreferences", async importOriginal => ({ ...await importOriginal<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
import { useTimelineClipMenuControls } from "./useTimelineClipMenuControls";

type Props = Record<string, unknown> & { children?: ReactNode };
/** Renders the returned element tree (function components called), as the DOM would hold it. */
function expand(tree: ReactNode): Props[] {
  if (Array.isArray(tree)) return tree.flatMap(expand);
  if (!isValidElement<Props>(tree)) return [];
  if (typeof tree.type === "function") return expand((tree.type as (props: Props) => ReactNode)(tree.props));
  return [tree.props, ...expand(tree.props.children)];
}
function clip(id: string, assetId: string, trackId: string, linkGroupId?: string): TimelineClip {
  return { id, assetId, trackId, timelineStart: 0, sourceStart: 0, duration: 4, volume: 1, transform: { ...DEFAULT_TRANSFORM },
    color: { ...DEFAULT_COLOR }, keyframes: [], layer: { ...DEFAULT_CLIP_LAYER }, ...(linkGroupId ? { linkGroupId } : {}) };
}
function project(): EditProject {
  const value = createEmptyProject("Menu", { id: "menu", fps: 30 });
  value.assets = [{ id: "cam", name: "cam.mp4", kind: "video", uri: "D:/owned/cam.mp4", duration: 20, width: 1920, height: 1080 },
    { id: "vo", name: "vo.wav", kind: "audio", uri: "D:/owned/vo.wav", duration: 20 }, { id: "still", name: "still.png", kind: "image", uri: "D:/owned/still.png", duration: 5, width: 1920, height: 1080 }];
  value.tracks[0].clips = [clip("V", "cam", "video-main", "pair")];
  value.tracks[1].clips = [clip("VO", "vo", "audio-main", "pair"), clip("MUSIC", "vo", "audio-main")];
  value.tracks[1].clips[1].timelineStart = 5;
  value.tracks.push({ id: "pics", name: "畫面 2", kind: "video", locked: false, muted: false, clips: [clip("PIC", "still", "pics")] });
  return validateProject(value);
}

let selected: string[];
function controls(value = project()) {
  hooks.index = 0;
  const onSelect = vi.fn((id: string) => { selected = [id]; });
  const result = useTimelineClipMenuControls({ project: value, selectedClipIds: selected, selectedClipId: selected[0], onSelect, setMotionSelection: vi.fn(),
    onFreezeFrame: vi.fn(), onDetachAudio: vi.fn(), onLinkClips: vi.fn(), clipMediaBusy: false });
  return { ...result, onSelect, value };
}
function rightClick(id: string) {
  const first = controls(), track = first.value.tracks.find(item => item.clips.some(c => c.id === id))!;
  const clipValue = track.clips.find(c => c.id === id)!, asset = first.value.assets.find(a => a.id === clipValue.assetId);
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 300, clientY: 200 };
  first.onContextMenu(event as never, clipValue, track, asset);
  // The re-render after the right-click: what the timeline puts on the page.
  const menu = controls().renderMenu();
  return { event, onSelect: first.onSelect, items: expand(menu ?? null), open: expand(menu ?? null).some(props => props.role === "menu") };
}

beforeEach(() => { hooks.states.length = 0; selected = []; vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 720 }); vi.stubGlobal("document", { body: {} }); });
afterEach(() => vi.unstubAllGlobals());

describe("a right-click on a clip opens a menu only when it has something to offer", () => {
  it.each([["MUSIC", "an unlinked sound clip"], ["PIC", "an unlinked picture"]])("%s (%s): picked, the browser menu suppressed, no menu", id => {
    const result = rightClick(id);
    expect(result.event.preventDefault).toHaveBeenCalled();
    expect(result.onSelect).toHaveBeenCalledWith(id);
    expect(result.open).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("a linked clip offers 取消連結; a video clip offers 定格 and 分離聲音", () => {
    const linked = rightClick("VO");
    expect(linked.open).toBe(true);
    expect(linked.items.filter(props => props.role === "menuitem").map(props => props["data-testid"])).toEqual(["clip-context-unlink"]);
    hooks.states.length = 0; selected = [];
    const video = rightClick("V");
    expect(video.items.filter(props => props.role === "menuitem").map(props => props["data-testid"])).toEqual(["clip-context-freeze", "clip-context-detach", "clip-context-unlink"]);
  });

  it("two picked clips offer 連結 even when each alone has nothing", () => {
    selected = ["MUSIC", "PIC"];
    const result = rightClick("PIC");
    expect(result.onSelect).not.toHaveBeenCalled();
    expect(result.items.filter(props => props.role === "menuitem").map(props => props["data-testid"])).toEqual(["clip-context-link"]);
  });

  it("a menu state left behind with nothing to offer renders nothing", () => {
    hooks.states.length = 0; selected = ["MUSIC"];
    hooks.states[0] = { value: { clipId: "MUSIC", x: 1, y: 1 } };
    expect(controls().renderMenu()).toBeUndefined();
  });
});

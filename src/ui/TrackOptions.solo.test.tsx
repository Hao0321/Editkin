import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineTrack } from "../domain/types";
vi.mock("react", async load => ({ ...await load<typeof import("react")>(), useEffect: () => {}, useRef: (value: unknown) => ({ current: value }), useState: () => [{ left: 0, top: 0 }, () => {}] }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./i18n/interfacePreferences", async load => ({ ...await load<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
import { TrackOptions } from "./TrackOptions";
type Props = Record<string, any> & { children?: ReactNode };
function nodes(tree: ReactNode): Props[] { return Array.isArray(tree) ? tree.flatMap(nodes) : isValidElement<Props>(tree) ? [tree.props, ...nodes(tree.props.children)] : []; }
afterEach(() => vi.unstubAllGlobals());
describe("solo in the existing track menu", () => {
  it.each(["video", "audio"] as const)("offers solo then cancel for %s, including locked tracks", kind => {
    vi.stubGlobal("document", { body: {} }); const solo = vi.fn();
    const track: TimelineTrack = { id: "t", name: "Track", kind, locked: true, muted: false, clips: [] };
    const menu = (patch: Partial<TimelineTrack>) => nodes(TrackOptions({ track: { ...track, ...patch }, onToggleSolo: solo, onRename: vi.fn(), onToggleLock: vi.fn(), onDelete: vi.fn() }));
    const item = menu({}).find(node => node["data-testid"] === "track-solo-toggle")!;
    expect(item.children).toBe("獨奏（只聽這軌）"); expect(item["aria-pressed"]).toBe(false); item.onClick(); expect(solo).toHaveBeenCalledExactlyOnceWith("t");
    expect(menu({ solo: true }).find(node => node["data-testid"] === "track-solo-toggle")!.children).toBe("取消獨奏");
    expect(menu({ kind: "caption" }).some(node => node["data-testid"] === "track-solo-toggle")).toBe(false);
  });
});

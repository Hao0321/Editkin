import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineTrack } from "../domain/types";

// The production TrackOptions menu with its open state and portal doubled (no mounted DOM): a picture track offers
// 「隱藏畫面／顯示畫面」 next to lock, a sound track does not.
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
    useState: () => [{ top: 0, left: 0 }, () => {}] };
});
vi.mock("react-dom", async importOriginal => ({ ...(await importOriginal<typeof import("react-dom")>()), createPortal: (node: ReactNode) => node }));
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { TrackOptions } from "./TrackOptions";

type Props = Record<string, unknown> & { children?: ReactNode };
function items(node: ReactNode, out: Props[] = []): Props[] {
  if (Array.isArray(node)) node.forEach(child => items(child, out));
  else if (isValidElement<Props>(node)) { if (node.props.role === "menuitem") out.push(node.props); if (node.props.children) items(node.props.children, out); }
  return out;
}
const label = (props: Props) => String(props.children);
// The menu is portalled into document.body; the portal double renders it in place.
beforeEach(() => vi.stubGlobal("document", { body: {} }));
afterEach(() => vi.unstubAllGlobals());
const track = (patch: Partial<TimelineTrack>): TimelineTrack => ({ id: "v2", name: "畫面軌 2", kind: "video", locked: false, muted: false, clips: [], ...patch });

describe("a track's ⋯ options", () => {
  it("a picture track can hide and show its picture; the choice names what it will do", () => {
    const hide = vi.fn();
    const shown = items(TrackOptions({ track: track({}), onRename: () => {}, onToggleLock: () => {}, onToggleHidden: hide, onDelete: () => {} }));
    expect(shown.map(label)).toEqual(["重新命名", "鎖定軌道", "隱藏畫面", "刪除空軌"]);
    (shown[2].onClick as () => void)();
    expect(hide).toHaveBeenCalledWith("v2");
    const hidden = items(TrackOptions({ track: track({ hidden: true }), onRename: () => {}, onToggleLock: () => {}, onToggleHidden: hide, onDelete: () => {} }));
    expect(hidden.map(label)).toContain("顯示畫面");
  });
  it("a sound track has no picture to hide", () => {
    const menu = items(TrackOptions({ track: track({ kind: "audio" }), onRename: () => {}, onToggleLock: () => {}, onToggleHidden: vi.fn(), onDelete: () => {} }));
    expect(menu.map(label)).toEqual(["重新命名", "鎖定軌道", "刪除空軌"]);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TimelineTrack } from "../domain/types";
// The switches are also called directly (no React renderer) to invoke their handlers: the i18n hook reads the store.
vi.mock("./i18n/interfacePreferences", async importOriginal => {
  const actual = await importOriginal<typeof import("./i18n/interfacePreferences")>();
  return { ...actual, useI18n: () => ({ ...actual.interfacePreferences.getSnapshot(), t: actual.translateUi }) };
});
import { TrackQuickTogglesV1 } from "./TrackHeaderControlsV1";
import { readTimelineTrackHeightV1, writeTimelineTrackHeightV1, TIMELINE_TRACK_HEIGHTS_V1 } from "./timelineTrackHeightV1";

// P7 (2026-10-23): the track header's quick switches (eye, speaker, solo, lock) in real React SSR, plus their handlers.
const track = (patch: Partial<TimelineTrack> = {}): TimelineTrack => ({ id: "v", name: "主畫面", kind: "video", locked: false, muted: false, clips: [], ...patch });
const handlers = () => ({ onToggleHidden: vi.fn(), onToggleMute: vi.fn(), onToggleSolo: vi.fn(), onToggleLock: vi.fn() });

describe("track quick switches", () => {
  it("a picture track has eye, speaker, solo and lock, each an icon with a tooltip that says what it changes", () => {
    const html = renderToStaticMarkup(<TrackQuickTogglesV1 track={track()} {...handlers()} />);
    expect(html.match(/<button/g)).toHaveLength(4);
    expect(html).toContain('aria-label="主畫面 隱藏畫面" aria-pressed="false" title="隱藏畫面：只關畫面，聲音照常"');
    expect(html).toContain('aria-label="主畫面 靜音" aria-pressed="false" title="靜音：只關聲音，畫面照常"');
    expect(html).toContain('aria-label="主畫面 獨奏" aria-pressed="false" title="獨奏：只聽這一軌（和其他獨奏軌）"');
    expect(html).toContain('aria-label="主畫面 鎖定" aria-pressed="false" title="鎖定：這一軌的片段不能移動或修改"');
    expect(html.match(/<svg/g)).toHaveLength(4);
  });
  it("shows each state as a pressed switch with its own tooltip", () => {
    const html = renderToStaticMarkup(<TrackQuickTogglesV1 track={track({ hidden: true, muted: true, solo: true, locked: true })} {...handlers()} />);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(4);
    for (const words of ["畫面已隱藏：按一下顯示畫面", "獨奏中：只聽獨奏的軌道；按一下取消", "已鎖定：按一下解鎖"]) expect(html).toContain(words);
  });
  it("a sound track has no eye; a caption track only a lock", () => {
    expect(renderToStaticMarkup(<TrackQuickTogglesV1 track={track({ kind: "audio", name: "聲音" })} {...handlers()} />).match(/<button/g)).toHaveLength(3);
    const caption = renderToStaticMarkup(<TrackQuickTogglesV1 track={track({ kind: "caption", name: "字幕" })} {...handlers()} />);
    expect(caption.match(/<button/g)).toHaveLength(1); expect(caption).toContain("字幕 鎖定");
  });
  it("each switch sends its own track command handler with the track id", () => {
    const calls = handlers();
    const tree = TrackQuickTogglesV1({ track: track(), ...calls }) as unknown as { props: { children: Array<{ props: { onClick: () => void } } | false | undefined> } };
    for (const button of tree.props.children) if (button) button.props.onClick();
    for (const handler of Object.values(calls)) expect(handler).toHaveBeenCalledExactlyOnceWith("v");
  });
});

describe("軌道高度 preference", () => {
  it("reads 小／中／大 from this computer's storage, defaulting to 中, and tolerates a blocked storage", () => {
    const store = new Map<string, string>(), storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    expect(readTimelineTrackHeightV1(storage)).toBe("m");
    writeTimelineTrackHeightV1("l", storage); expect(readTimelineTrackHeightV1(storage)).toBe("l");
    store.set("editkin.timeline.trackHeight.v1", "huge"); expect(readTimelineTrackHeightV1(storage)).toBe("m");
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readTimelineTrackHeightV1(blocked)).toBe("m"); expect(() => writeTimelineTrackHeightV1("s", blocked)).not.toThrow();
    expect(TIMELINE_TRACK_HEIGHTS_V1.map(option => option.pixels)).toEqual([40, 52, 76]);
  });
});

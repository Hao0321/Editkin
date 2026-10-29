import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// The notice list reads the shared store directly in this double, so the actual
// component can be called and its buttons pressed without a mounted DOM. The
// focus effect needs a mounted DOM and is not exercised here.
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useRef: (current: unknown) => ({ current }), useEffect: () => undefined }));
vi.mock("./i18n/interfacePreferences", async importOriginal => ({ ...await importOriginal<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
import { interfacePreferences } from "./i18n/interfacePreferences";
import { PlaybackControls, type PlaybackControlsProps } from "./PlaybackControls";
import { PlaybackNotices } from "./PlaybackNotices";
import { currentPlaybackNotices, publishPlaybackNotice, resetPlaybackNotices, retryPlaybackNotice } from "./playbackNoticeStore";

function nodes(value: unknown): ReactElement<Record<string, any>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props.children)];
}
function props(overrides: Partial<PlaybackControlsProps> = {}): PlaybackControlsProps {
  return { playing: false, playhead: 2, duration: 10, fps: 30, playbackRate: 1, onTogglePlayback: vi.fn(), onPausePlayback: vi.fn(),
    onSeek: vi.fn(), onPlaybackRateChange: vi.fn(), onShuttle: vi.fn(), onFrameStep: vi.fn(), ...overrides };
}
const html = (overrides: Partial<PlaybackControlsProps> = {}) => renderToStaticMarkup(<PlaybackControls {...props(overrides)} />);
const readout = (overrides: Partial<PlaybackControlsProps> = {}) => html(overrides).match(/data-testid="transport-rate-readout"[^>]*>([^<]*)</)![1];
const actionButtons = () => nodes(PlaybackNotices()).filter(node => node.type === "button" && node.props.className !== "playback-notice-dismiss");
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(async () => {
  resetPlaybackNotices();
  await interfacePreferences.setLocale("zh-TW");
});

describe("playback failures beside the transport (U03 review)", () => {
  it("says what happened and what to do in fixed plain words; the raw cause is only under 查看原因", () => {
    const retry = { audio: vi.fn(), gpu: vi.fn(), source: vi.fn() };
    const raw = { audio: "原生音訊停止尚未確認；變速播放已阻擋", gpu: "device lost", source: "music.m4a：解碼錯誤 4：Format error" };
    publishPlaybackNotice("gpu-preview", { kind: "gpu", step: "fallback", detail: raw.gpu, retry: retry.gpu });
    publishPlaybackNotice("audio-sources", { kind: "audio-source", names: ["music.m4a"], detail: raw.source, retry: retry.source });
    publishPlaybackNotice("preview-audio", { kind: "audio", detail: raw.audio, retry: retry.audio });
    const markup = html();
    expect(markup.indexOf('data-testid="playback-notices"')).toBeLessThan(markup.indexOf('data-testid="transport-play-pause"'));
    for (const text of ["上一段聲音還沒停好，為避免重疊已先暫停", "按「再試一次」確認聲音已停止，就能繼續播放。",
      "「music.m4a」的聲音無法播放", "請確認檔案還在原位置，再重新載入聲音。",
      "GPU 加速暫停，已改用相容預覽", "畫面照常顯示，可以繼續剪輯。"]) expect(markup).toContain(text);
    // Each raw string appears exactly once, folded inside its collapsed <details>.
    const folded = [...markup.matchAll(/<details class="playback-notice-reason"><summary>查看原因<\/summary><span>([^<]*)<\/span><\/details>/g)].map(match => match[1]);
    expect(folded).toEqual([raw.audio, raw.source, raw.gpu]);
    for (const text of Object.values(raw)) expect(markup.split(text)).toHaveLength(2);
    expect(markup).not.toContain("<details open");
    // Blocking problems are alerts; a working fallback picture is a calm status.
    expect(markup.match(/role="alert"/g)).toHaveLength(2); expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-live="assertive"');
    const buttons = actionButtons();
    expect(buttons.map(button => button.props.children)).toEqual(["再試一次", "重新載入聲音", "重試 GPU 預覽"]);
    for (const button of buttons) expect(markup).toContain(`id="${button.props["aria-describedby"]}"`);
    for (const button of buttons) button.props.onClick();
    expect([retry.audio, retry.source, retry.gpu].map(handler => handler.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("a retry shows 重試中… until it settles, then says it is still failing so it is announced again", async () => {
    const pending = deferred(), retry = vi.fn(() => pending.promise);
    publishPlaybackNotice("preview-audio", { kind: "audio", detail: "原生音訊清理未確認", retry });
    actionButtons()[0].props.onClick();
    expect(currentPlaybackNotices()[0]).toMatchObject({ busy: true, attempts: 1 });
    expect(html()).toContain('aria-disabled="true"'); expect(html()).toContain("重試中…");
    actionButtons()[0].props.onClick(); expect(retry).toHaveBeenCalledTimes(1);
    pending.resolve(); await settle();
    expect(currentPlaybackNotices()[0]).toMatchObject({ busy: false, attempts: 1 });
    expect(html()).toContain("還是沒有停好。可以再試一次；如果一直出現，請儲存專案後重新開啟 Editkin。");
    expect(html()).not.toContain('aria-disabled="true"');
    // A different problem under the same key starts over.
    publishPlaybackNotice("preview-audio", { kind: "play", step: "play", detail: "NotAllowedError", retry: vi.fn() });
    expect(currentPlaybackNotices()[0].attempts).toBe(0); expect(html()).toContain("再播放一次通常就能恢復。");
  });

  it("a recovery that clears its notice early keeps the count when the same problem comes back", async () => {
    const notice = { kind: "gpu" as const, step: "fallback", detail: "device lost", retry: () => publishPlaybackNotice("gpu-preview") };
    publishPlaybackNotice("gpu-preview", notice);
    retryPlaybackNotice("gpu-preview"); await settle();
    expect(currentPlaybackNotices()).toHaveLength(0);
    publishPlaybackNotice("gpu-preview", notice);
    expect(currentPlaybackNotices()[0].attempts).toBe(1);
    expect(html()).toContain("GPU 加速還是無法使用。可以先用相容預覽繼續剪輯，更新顯示卡驅動程式後再試。");
    // GPU 直出 still showing the picture uses the playback wording.
    resetPlaybackNotices(); publishPlaybackNotice("gpu-preview", { ...notice, step: "playback" });
    expect(html()).toContain("GPU 加速播放暫停"); expect(html()).toContain("畫面仍可預覽和剪輯，播放可能比較不順。");
  });

  it("a play() failure moves from play again to reload, then to rebuilding the preview", () => {
    const expectations = [["play", "預覽無法開始播放，已暫停", "再播放一次"], ["reload", "這段預覽無法播放，已暫停", "重新載入預覽"],
      ["rebuild", "這段預覽無法播放，已暫停", "重建預覽"]] as const;
    for (const [step, title, action] of expectations) {
      publishPlaybackNotice("preview-audio", { kind: "play", step, detail: "clip.mp4：NotSupportedError", retry: vi.fn() });
      expect(html()).toContain(title); expect(actionButtons().map(button => button.props.children)).toEqual([action]);
    }
    expect(html()).toContain("重新載入後還是無法播放。請重建預覽；原片與剪輯都會保留。");
  });

  it("several broken audio sources are one notice with one reload, and non-blocking notices can be closed", () => {
    publishPlaybackNotice("audio-sources", { kind: "audio-source", names: ["music.m4a", "sfx.wav"], detail: "music.m4a：x\nsfx.wav：y", retry: vi.fn() });
    publishPlaybackNotice("preview-audio", { kind: "audio", detail: "x", retry: vi.fn() });
    expect(html()).toContain("2 段聲音無法播放"); expect(actionButtons().filter(button => button.props.children === "重新載入聲音")).toHaveLength(1);
    const dismiss = nodes(PlaybackNotices()).filter(node => node.props.className === "playback-notice-dismiss");
    expect(dismiss).toHaveLength(1); expect(dismiss[0].props["aria-label"]).toBe("關閉這則提醒");
    dismiss[0].props.onClick();
    expect(currentPlaybackNotices().map(notice => notice.kind)).toEqual(["audio"]);
  });

  it("compatible audio is not a banner: the readout says 音訊相容模式 and keeps the reason in its tooltip", () => {
    expect(html()).not.toContain("playback-notices");
    publishPlaybackNotice("preview-audio", { kind: "audio-fallback", detail: "原生音訊預覽 staging 失敗，已切回相容播放" });
    const markup = html({ playing: true });
    expect(markup).not.toContain("playback-notices"); expect(markup).not.toContain('role="status"');
    expect(readout({ playing: true })).toBe("播放 · 1× · 音訊相容模式");
    const title = markup.match(/data-testid="transport-rate-readout"[^>]*title="([^"]*)"/)![1];
    expect(title).toContain("原生音訊無法使用，聲音改用相容方式播放，可能和畫面有些微落差。");
    expect(title).toContain("原因：原生音訊預覽 staging 失敗，已切回相容播放");
  });

  it("notices float over the picture and the readout has a fixed share of the row, so nothing reflows", () => {
    const css = readFileSync(new URL("./playbackControls.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.playback-controls \{\s*position: relative;/);
    expect(css).toMatch(/\.playback-notices \{[^}]*position: absolute;[^}]*bottom: calc\(100% \+ 8px\);[^}]*max-height: 15rem;[^}]*overflow: auto;/);
    expect(css).toMatch(/\.playback-state \{[^}]*flex: 1 1 15em;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/grid-template-rows: 46px minmax\(0, 1fr\) auto;/);
  });

  it("in GPU 直出 the notices take their own space above the transport row, not the picture under the native window", () => {
    publishPlaybackNotice("gpu-preview", { kind: "gpu", step: "playback", detail: "device lost", retry: vi.fn() });
    expect(html()).toContain('<div class="playback-notices" data-testid="playback-notices" data-placement="overlay"');
    const inline = html({ noticePlacement: "inline" });
    expect(inline).toContain('<div class="playback-notices playback-notices-inline" data-testid="playback-notices" data-placement="inline"');
    expect(inline).toContain("GPU 加速播放暫停"); expect(inline).toContain("重試 GPU 預覽");
    // Still first in the transport, right above the play button the user pressed.
    expect(inline.indexOf('data-testid="playback-notices"')).toBeLessThan(inline.indexOf('data-testid="transport-play-pause"'));
    const css = readFileSync(new URL("./playbackControls.css", import.meta.url), "utf8");
    const rule = css.match(/\.playback-notices\.playback-notices-inline \{([^}]*)\}/)![1];
    expect(rule).toMatch(/position: static;/); expect(rule).toMatch(/max-height: min\(15rem, 30vh\);/);
    expect(rule).not.toMatch(/absolute|bottom/);
  });

  it("the readout states the audio policy: reverse and 8× are muted, 0.5×–4× follow the speed", () => {
    expect(readout({ playing: true, playbackRate: -2 })).toBe("倒放 · −2× · 已靜音");
    expect(readout({ playbackRate: -8 })).toBe("已暫停 · −8× · 已靜音");
    expect(readout({ playing: true, playbackRate: 8 })).toBe("播放 · 8× · 已靜音");
    expect(readout({ playing: true, playbackRate: 4 })).toBe("播放 · 4× · 聲音跟著變速");
    expect(readout({ playbackRate: 0.5 })).toBe("已暫停 · 0.5× · 聲音跟著變速");
    expect(readout({ playing: true, playbackRate: 1 })).toBe("播放 · 1×");
  });

  it("is translated with the interface language", async () => {
    await interfacePreferences.setLocale("en");
    publishPlaybackNotice("gpu-preview", { kind: "gpu", step: "fallback", detail: "device lost", retry: vi.fn() });
    const markup = html({ playing: true, playbackRate: -2 });
    for (const text of ["GPU acceleration paused; switched to the compatible preview", "The picture still shows normally, so you can keep editing.",
      "Retry GPU preview", "View reason", "Muted"]) expect(markup).toContain(text);
  });
});

import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nextTransportFit, PlaybackControls, type PlaybackControlsProps, type TransportDensity } from "./PlaybackControls";
import { interfacePreferences } from "./i18n/interfacePreferences";

// The one-row transport. The measuring itself runs in the browser (headless Chrome, .rd/benchmarks/usable-v1-20261009/
// work/layout-1280-20261010): 1280×720 with the Inspector open gives the row 518 px, where zh-TW and English use the
// icon layout on one row; 1100×720 with the Inspector (398 px) uses 「更多」. Here: the step rule, the markup every layout
// shares (names, tooltips, the 更多 button) and the CSS that switches layouts.

function props(overrides: Partial<PlaybackControlsProps> = {}): PlaybackControlsProps {
  return { playing: false, playhead: 2, duration: 10, fps: 30, playbackRate: 1, onTogglePlayback: vi.fn(), onPausePlayback: vi.fn(), onSeek: vi.fn(),
    onPlaybackRateChange: vi.fn(), onShuttle: vi.fn(), onFrameStep: vi.fn(), ...overrides };
}
const fit = (density: TransportDensity, readout = true) => ({ density, readout });

describe("the transport picks the roomiest layout that fits one row", () => {
  it("steps from every word to icons to 「更多」, and only then lets a very narrow row wrap", () => {
    expect(nextTransportFit(fit("full"), { overflow: true, readoutCut: false })).toEqual(fit("compact"));
    expect(nextTransportFit(fit("compact"), { overflow: true, readoutCut: true })).toEqual(fit("more"));
    expect(nextTransportFit(fit("more"), { overflow: true, readoutCut: false })).toEqual(fit("wrap"));
    expect(nextTransportFit(fit("wrap"), { overflow: true, readoutCut: false })).toBeUndefined();
  });

  it("keeps the words and drops only the state readout from view when just the readout does not fit", () => {
    expect(nextTransportFit(fit("full"), { overflow: false, readoutCut: true })).toEqual(fit("full", false));
    expect(nextTransportFit(fit("compact"), { overflow: false, readoutCut: true })).toEqual(fit("compact", false));
    expect(nextTransportFit(fit("full", false), { overflow: false, readoutCut: true })).toBeUndefined();
    expect(nextTransportFit(fit("full"), { overflow: false, readoutCut: false })).toBeUndefined();
  });
});

describe("every layout keeps each control's name and tooltip", () => {
  // The full transport (倒放, 暫停, 快轉, the speed and 「更多」) is advanced mode's since 2026-10-11; simple mode's row is
  // checked in its own block below.
  interfacePreferences.setMode("advanced");
  const html = renderToStaticMarkup(<PlaybackControls {...props()} />);

  it("starts with every word shown and the 「更多」 button hidden but named", () => {
    expect(html).toMatch(/class="playback-controls-row" data-density="full"/);
    const more = html.match(/<button[^>]*data-testid="transport-more"[^>]*>/)?.[0] ?? "";
    expect(more).toContain('hidden=""');
    expect(more).toContain('aria-expanded="false"');
    expect(more).toContain('aria-label="更多播放控制"');
    expect(more).toContain('title="倒放、暫停、快轉和播放速度"');
  });

  it("gives every button an accessible name and a tooltip, and keeps their words in a label the icon layout can hide", () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(7); // 播放, 倒放, 暫停, 快轉, 上一格, 下一格, 更多
    for (const button of buttons) {
      expect(button).toMatch(/aria-label="[^"]+"/);
      expect(button).toMatch(/title="[^"]+"/);
    }
    for (const words of ["倒放", "暫停", "快轉", "上一格", "下一格", "速度", "更多"]) expect(html).toContain(`<span class="playback-label">${words}</span>`);
    // 倒放／暫停／快轉 and the speed are one group, the one 「更多」 opens on a narrow row.
    expect(html).toMatch(/<div class="playback-secondary">.*data-testid="transport-reverse".*data-testid="transport-pause".*data-testid="transport-forward".*aria-label="預覽播放速度".*<\/div><div class="playback-frame-actions"/);
  });
});

describe("the CSS behind the layouts", () => {
  const css = postcss.parse(readFileSync(new URL("./playbackControls.css", import.meta.url), "utf8"));
  const rule = (selector: string) => {
    let found: Rule | undefined;
    css.walkRules(item => { if (item.selectors.includes(selector)) found = item; });
    if (!found) throw new Error(`missing rule ${selector}`);
    const declarations: Record<string, string> = {};
    found.walkDecls(decl => { declarations[decl.prop] = decl.value; });
    return declarations;
  };

  it("never wraps the row before the last layout", () => {
    expect(rule(".playback-controls.playback-controls .playback-controls-row[data-density]")).toMatchObject({ "flex-wrap": "nowrap" });
    expect(rule(".playback-controls.playback-controls .playback-controls-row[data-density] > .playback-controls-actions")).toMatchObject({ flex: "0 0 auto", "flex-wrap": "nowrap" });
    expect(rule(".playback-controls.playback-controls .playback-controls-row[data-density=\"wrap\"]")).toMatchObject({ "flex-wrap": "wrap" });
  });

  it("hides words only visually (screen readers keep them) and keeps 44 px targets for icon buttons", () => {
    const hidden = rule('.playback-controls-row[data-density="compact"] :is(.playback-secondary, .playback-frame-actions) .playback-label');
    expect(hidden).toMatchObject({ position: "absolute", width: "1px", height: "1px", "clip-path": "inset(50%)" });
    expect(hidden).not.toHaveProperty("display");
    expect(rule('.playback-controls.playback-controls .playback-controls-row[data-density="compact"] :is(.playback-secondary, .playback-frame-actions) button'))
      .toMatchObject({ "min-width": "var(--ui-target-size, 44px)" });
  });

  it("opens 「更多」 below its button with fixed positioning (never over the GPU picture) and hides the button otherwise", () => {
    expect(rule('.playback-controls.playback-controls .playback-controls-row:is([data-density="more"], [data-density="wrap"])[data-more-open="true"] .playback-secondary'))
      .toMatchObject({ position: "fixed", top: "var(--playback-more-top, 0px)", left: "var(--playback-more-left, 0px)" });
    expect(rule('.playback-controls.playback-controls .playback-controls-row:is([data-density="more"], [data-density="wrap"]):not([data-more-open="true"]) .playback-secondary'))
      .toMatchObject({ display: "none" });
    expect(rule(".playback-controls.playback-controls .playback-more-toggle[hidden]")).toMatchObject({ display: "none" });
  });
});

describe("simple mode keeps one 播放／暫停, the frame steps, the time and the scrubber", () => {
  interfacePreferences.setMode("simple");
  const html = renderToStaticMarkup(<PlaybackControls {...props()} />);
  const fast = renderToStaticMarkup(<PlaybackControls {...props({ playing: true, playbackRate: 2 })} />);
  interfacePreferences.setMode("advanced");
  const full = renderToStaticMarkup(<PlaybackControls {...props()} />);
  afterAll(() => interfacePreferences.setMode("simple"));

  it("has no 倒放, separate 暫停, 快轉, speed list or 「更多」, and keeps 播放, 上一格, 下一格 and the scrubber", () => {
    const ids = [...html.matchAll(/data-testid="(transport-[^"]+)"/g)].map(match => match[1]);
    expect(ids).toEqual(["transport-play-pause", "transport-previous-frame", "transport-next-frame", "transport-seek"]);
    expect(html).not.toContain("playback-secondary");
    expect(html).not.toContain('aria-label="預覽播放速度"');
    expect(html.match(/<button[^>]*>/g)).toHaveLength(3);
    expect(html.match(/<output class="playback-time"/g)).toHaveLength(2);
    // The play button keeps its Space shortcut; J, K and L keep working from the keyboard (useEditorShortcuts).
    expect(html).toContain('aria-keyshortcuts="Space"');
  });

  it("says the state only when J or L changed the speed or direction", () => {
    expect(html).not.toContain('data-testid="transport-rate-readout"');
    expect(fast).toContain('data-testid="transport-rate-readout"');
    expect(fast).toContain("播放 · 2× · 聲音跟著變速");
  });

  it("leaves advanced mode's transport as it was", () => {
    for (const id of ["transport-reverse", "transport-pause", "transport-forward", "transport-more", "transport-rate-readout"]) expect(full).toContain(`data-testid="${id}"`);
    expect(full).toContain('aria-label="預覽播放速度"');
  });
});

import { readFileSync } from "node:fs";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { createDemoProject } from "../domain/demo";
import { Timeline } from "./Timeline";
import type { TimelineProps } from "./timelineContract";

const noop = () => {};
function props(): TimelineProps {
  return { project: createDemoProject(), duration: 10000, playhead: 0, runtimeUrls: {}, onSeek: noop, onSelect: noop, onSelectCaption: noop,
    onMoveClip: noop, onMoveCaption: noop, onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onAddTrack: noop,
    onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop, onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop };
}
describe("bounded timeline DOM and visible actions", () => {
  it("keeps the active offscreen clip mounted without rendering the whole timeline", () => {
    const value = props();
    const source = value.project.tracks[0]!.clips[0]!;
    value.project.tracks[0]!.clips = Array.from({ length: 50000 }, (_, i) => ({ ...source, id: `bounded-${i}`, timelineStart: i * 3, duration: 2 }));
    value.selectedClipId = "bounded-40000";
    const html = renderToStaticMarkup(<Timeline {...value} />);
    expect(html).toContain('data-testid="timeline-clip-bounded-40000"');
    expect(html).not.toContain('data-testid="timeline-clip-bounded-39999"');
    expect((html.match(/data-testid="timeline-clip-/g) ?? []).length).toBeLessThan(12);
  });
  // Advanced mode since 2026-10-11: simple mode shows only ＋ 文字, 切開, 刪除 and the zoom (see the simple-mode block below).
  it("places split, delete, add track, PiP and fit before the extra-tools disclosure", () => {
    interfacePreferences.setMode("advanced");
    const html = renderToStaticMarkup(<Timeline {...props()} />);
    const disclosure = html.indexOf('class="timeline-more"');
    expect(disclosure).toBeGreaterThan(0);
    for (const id of ["timeline-snap-toggle", "split-button", "delete-button", "add-video-track-button", "picture-in-picture-button", "timeline-fit-button"]) {
      expect(html.indexOf(`data-testid="${id}"`)).toBeGreaterThan(0);
      expect(html.indexOf(`data-testid="${id}"`)).toBeLessThan(disclosure);
      expect(html.split(`data-testid="${id}"`)).toHaveLength(2);
    }
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-testid="timeline-snap-guide" hidden=""');
    expect(html).toContain("分 : 秒 : 幀");
  });
  it("publishes the actual viewport frame scale and guarded lane identities for drop routing", () => {
    const value = props();
    value.project.fps = 60;
    value.project.tracks[0]!.locked = true;
    const html = renderToStaticMarkup(<Timeline {...value} />);
    expect(html).toContain('data-timeline-viewport="true"');
    expect(html).toContain('data-timeline-pixels-per-second="80"');
    expect(html).toContain('data-timeline-fps="60"');
    expect(html).toContain(`data-track-id="${value.project.tracks[0]!.id}" data-track-kind="video" data-track-locked="true"`);
    expect(html).toContain('data-drop-zone="blocked"');
    expect(html).toContain('data-testid="timeline-asset-drop-preview" hidden=""');
    // Static markup proves routing metadata only; it does not observe live rects or pointer capture.
  });
});

afterEach(() => interfacePreferences.setMode("simple"));

describe("simple mode's calm timeline toolbar", () => {
  // Rewritten on purpose (2026-10-11): the two tools (選取, 剪刀) lead the row in both modes since the 剪刀 tool.
  it("shows only the two tools, ＋ 文字, 切開, 刪除 and a small zoom (−, slider, ＋, 顯示全部); advanced keeps every tool", () => {
    interfacePreferences.setMode("simple");
    const simple = renderToStaticMarkup(<Timeline {...props()} />);
    const row = simple.slice(simple.indexOf('class="timeline-quick-actions"'), simple.indexOf('data-testid="timeline-zoom-control"'));
    expect([...row.matchAll(/data-testid="([^"]+)"/g)].map(match => match[1])).toEqual(["timeline-tool-toggle", "timeline-tool-select", "timeline-tool-blade",
      "add-caption-button", "split-button", "delete-button"]);
    for (const id of ["timeline-zoom-out", "timeline-zoom-slider", "timeline-zoom-in", "timeline-fit-button"]) expect(simple.split(`data-testid="${id}"`)).toHaveLength(2);
    for (const id of ["edit-selection-button", "timeline-snap-toggle", "timeline-frame-zoom", "add-video-track-button", "picture-in-picture-button", "precompose-button"]) {
      expect(simple, id).not.toContain(`data-testid="${id}"`);
    }
    expect(simple).not.toContain('class="timeline-more"');
    expect(simple).not.toContain("✓ 自動補空隙");
    expect(simple).toContain('data-interface-mode="simple"');
    interfacePreferences.setMode("advanced");
    const advanced = renderToStaticMarkup(<Timeline {...props()} />);
    for (const id of ["timeline-snap-toggle", "timeline-frame-zoom", "add-video-track-button", "picture-in-picture-button", "timeline-fit-button", "precompose-button"]) {
      expect(advanced, id).toContain(`data-testid="${id}"`);
    }
    expect(advanced).toContain('class="timeline-more"');
    expect(advanced).toContain("✓ 自動補空隙");
    expect(advanced).not.toContain('data-testid="timeline-zoom-control"');
  });

  it("lets the time ruler show the whole project on a double-click", () => {
    interfacePreferences.setMode("simple");
    expect(renderToStaticMarkup(<Timeline {...props()} />)).toMatch(/data-testid="timeline-ruler" title="點一下移動播放頭；雙擊顯示全部"/);
  });

  it("shows track names only: mute and ⋯ appear on hover or keyboard focus, the kind badge is hidden", () => {
    const css = postcss.parse(readFileSync(new URL("./timelineSimple.css", import.meta.url), "utf8"));
    const selectors: string[] = [];
    css.walkRules(rule => { selectors.push(rule.selector.replace(/\s+/g, " ")); });
    expect(selectors).toContain('.timeline-shell[data-interface-mode="simple"] .track-label:not(.ruler-label) > .track-kind');
    expect(selectors).toContain('.timeline-shell[data-interface-mode="simple"] .track-label:not(:hover):not(:focus-within) > :is(.track-mute, .track-options)');
    // The controls stay in the markup (keyboard and hover reach them); a locked track still says so.
    interfacePreferences.setMode("simple");
    const value = props();
    value.project.tracks[0]!.locked = true;
    const html = renderToStaticMarkup(<Timeline {...value} />);
    expect(html).toContain('class="track-mute');
    expect(html).toContain('<span class="track-locked">已鎖定</span>');
  });
});

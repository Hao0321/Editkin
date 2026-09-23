import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
  it("places split, delete, add track, PiP and fit before the extra-tools disclosure", () => {
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
});

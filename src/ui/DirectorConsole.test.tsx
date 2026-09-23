import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../domain/demo";
import type { EditProject, TimelineClip } from "../domain/types";
import {
  DirectorConsole,
  DirectorCutMap,
  DirectorTabs,
  directorVisualClips,
  nearbyDirectorVisualCuts,
  type DirectorConsoleView,
} from "./DirectorConsole";

function directorFixture(): EditProject {
  const project = createDemoProject();
  const source = project.tracks[0]!.clips[0]!;
  const clip = (id: string, timelineStart: number, duration: number, assetId = source.assetId, trackId = "video-main"): TimelineClip => ({
    ...structuredClone(source), id, assetId, trackId, timelineStart, duration,
  });
  project.assets.push({ id: "asset-bgm", name: "背景音樂", kind: "audio", uri: "bgm.wav", duration: 180 });
  project.tracks[0]!.clips = [
    clip("long-active-picture", 0, 120),
    clip("near-before", 50, 4),
    clip("near-after", 70, 5),
    clip("far-picture", 100, 5),
    clip("misplaced-audio", 60, 8, "asset-bgm"),
  ];
  project.tracks[1]!.clips = [
    clip("bgm", 58, 100, "asset-bgm", "audio-main"),
    clip("audio-track-video-asset", 59, 2, source.assetId, "audio-main"),
  ];
  return project;
}

type ButtonProps = {
  onClick?: () => void;
  "data-clip-id"?: string;
  "aria-controls"?: string;
  "aria-selected"?: boolean;
};

function directButtons(element: ReactElement): ReactElement<ButtonProps>[] {
  return Children.toArray((element.props as { children?: ReactNode }).children)
    .filter(isValidElement) as ReactElement<ButtonProps>[];
}

describe("Director Console task tabs and visual cut map", () => {
  it("docks as a non-modal review region so the original player and timeline remain operable", () => {
    const html = renderToStaticMarkup(<DirectorConsole docked project={directorFixture()} playhead={60} onSeek={() => {}} onCommand={() => {}} onClose={() => {}} />);
    expect(html).toContain('class="director-dock"');
    expect(html).toContain('role="region"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toContain('modal-backdrop');
  });
  it("routes every task tab through one explicit view-change interaction", () => {
    const onViewChange = vi.fn<(view: DirectorConsoleView) => void>();
    const tabs = DirectorTabs({ view: "overview", openCount: 2, onViewChange });
    const buttons = directButtons(tabs);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.props["aria-controls"])).toEqual([
      "director-panel-overview", "director-panel-notes", "director-panel-aesthetic",
    ]);
    expect(buttons.map((button) => button.props["aria-selected"])).toEqual([true, false, false]);
    buttons[1]!.props.onClick?.();
    buttons[2]!.props.onClick?.();
    expect(onViewChange.mock.calls).toEqual([["notes"], ["aesthetic"]]);

    const html = renderToStaticMarkup(<DirectorTabs view="notes" openCount={2} onViewChange={() => {}} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="director-tab-notes"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("時間碼註記 <b>2</b>");
  });

  it("excludes every audio-only route and keeps a long active picture outside the ±20 second start window", () => {
    const visual = directorVisualClips(directorFixture());
    expect(visual.map((clip) => clip.id)).toEqual(["long-active-picture", "near-before", "near-after", "far-picture"]);
    const nearby = nearbyDirectorVisualCuts(visual, 60);
    expect(nearby.map((clip) => clip.id)).toEqual(["long-active-picture", "near-before", "near-after"]);
    expect(nearby.map((clip) => clip.id)).not.toContain("bgm");
    expect(nearby.map((clip) => clip.id)).not.toContain("misplaced-audio");
  });

  it("renders only visual segments, marks the active picture and seeks to its visual cut", () => {
    const visual = directorVisualClips(directorFixture());
    const nearby = nearbyDirectorVisualCuts(visual, 60);
    const onSeek = vi.fn<(time: number) => void>();
    const map = DirectorCutMap({ clips: nearby, playhead: 60, onSeek });
    const buttons = directButtons(map as ReactElement);
    expect(buttons.map((button) => button.props["data-clip-id"])).toEqual(["long-active-picture", "near-before", "near-after"]);
    buttons.find((button) => button.props["data-clip-id"] === "near-before")?.props.onClick?.();
    expect(onSeek).toHaveBeenCalledOnce();
    expect(onSeek).toHaveBeenCalledWith(50);

    const mapHtml = renderToStaticMarkup(map);
    expect(mapHtml).toContain('data-clip-id="long-active-picture"');
    expect(mapHtml).toContain('class="active"');
    expect(mapHtml).not.toContain("bgm");
  });

  it("reports a visual-segment count instead of counting BGM as picture edits", () => {
    const html = renderToStaticMarkup(<DirectorConsole
      project={directorFixture()}
      playhead={60}
      onSeek={() => {}}
      onCommand={() => {}}
      onClose={() => {}}
    />);
    expect(html).toContain("視覺片段");
    expect(html).toContain('data-testid="director-visual-segment-count">4</strong>');
    expect(html).toContain('data-clip-id="long-active-picture"');
    expect(html).not.toContain('data-clip-id="bgm"');
    expect(html).not.toContain('data-clip-id="misplaced-audio"');
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
// Direct component calls with an explicit hook-state double: these check the
// actual ruler and 導演台 seek handlers, not browser pointer geometry.
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => {}],
  useRef: (current: unknown) => ({ current }), useEffect: () => {}, useMemo: (build: () => unknown) => build() }));
vi.mock("./i18n/interfacePreferences", async importOriginal => ({ ...await importOriginal<typeof import("./i18n/interfacePreferences")>(), useI18n: () => ({}) }));
import { createDemoProject } from "../domain/demo";
import { projectDuration } from "../domain/editGraph";
import { clampProjectSeek } from "./playbackTiming";
import { Timeline } from "./Timeline";
import { DirectorConsole, DirectorCutMap } from "./DirectorConsole";
import type { TimelineProps } from "./timelineContract";

function nodes(value: unknown): ReactElement<Record<string, any>>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props.children)];
}
const noop = () => {};

describe("every seek stops at the real project end (U03 bounds)", () => {
  it("clamps to the project duration, not a 12 s minimum, and passes non-finite input to the reducer", () => {
    expect(clampProjectSeek(9, 5)).toBe(5);
    expect(clampProjectSeek(-1, 5)).toBe(0);
    expect(clampProjectSeek(2.5, 5)).toBe(2.5);
    expect(clampProjectSeek(3, 0)).toBe(0);
    expect(clampProjectSeek(3, Number.NaN)).toBe(0);
    expect(clampProjectSeek(Number.NaN, 5)).toBeNaN();
  });

  it("a ruler click past the end of a 5 s project seeks to 5 s, matching the transport readout", () => {
    const onSeek = vi.fn(), project = createDemoProject();
    const props: TimelineProps = { project, duration: 5, playhead: 1, runtimeUrls: {},
      onSeek, onSelect: noop, onSelectCaption: noop, onMoveClip: noop, onMoveCaption: noop,
      onTrimClip: noop, onTrimCaption: noop, onAddCaption: noop, onEditSelection: noop, onAddTrack: noop,
      onRenameTrack: noop, onToggleTrackLock: noop, onDeleteTrack: noop, onMakePictureInPicture: noop,
      onPrecompose: noop, onToggleMute: noop, onSplit: noop, onDelete: noop };
    const ruler = nodes(Timeline(props)).find(node => node.props["data-testid"] === "timeline-ruler")!;
    const click = (clientX: number) => ruler.props.onClick({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 0 }) } });
    click(80 * 11); click(80 * 2);
    expect(onSeek.mock.calls).toEqual([[5], [2]]);
  });

  it("導演台 seeks (cut map and markers) are clamped to the real project end", () => {
    const onSeek = vi.fn(), project = createDemoProject(), end = projectDuration(project);
    const tree = nodes(DirectorConsole({ project, playhead: 0, onSeek, onCommand: noop, onClose: noop }));
    const map = tree.find(node => node.type === DirectorCutMap)!;
    map.props.onSeek(end + 7); map.props.onSeek(end / 2);
    expect(onSeek.mock.calls).toEqual([[end], [end / 2]]);
  });
});

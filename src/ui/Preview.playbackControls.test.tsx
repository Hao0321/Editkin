import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import type { PlaybackControlsProps } from "./PlaybackControls";
import { Preview } from "./Preview";

const captured = vi.hoisted(() => ({ audio: vi.fn(), controls: vi.fn() }));
vi.mock("../desktop/useNativeAudioPreviewPlayback", () => ({ useNativeAudioPreviewPlayback: (options: unknown) => {
  captured.audio(options);
  return { mode: "compatible", stage: undefined, generation: undefined, ownerId: undefined, transportSeekRevision: undefined };
} }));
vi.mock("./PlaybackControls", async importOriginal => {
  const actual = await importOriginal<typeof import("./PlaybackControls")>();
  return { ...actual, PlaybackControls: (props: PlaybackControlsProps) => { captured.controls(props); return actual.PlaybackControls(props); } };
});

function render(overrides: Partial<Parameters<typeof Preview>[0]> = {}) {
  const project = createEmptyProject("Controlled preview fixture", { width: 1080, height: 1920, fps: 30 });
  const props = { project, projectWidth: project.width, projectHeight: project.height, projectFps: project.fps,
    projectDuration: 10, playhead: 2, layers: [], audioLayers: [], captions: [], captionStyle: project.captionStyle,
    playing: false, onPlayingChange: vi.fn(), onPlayheadChange: vi.fn(), ...overrides };
  const html = renderToStaticMarkup(<Preview {...props} />);
  const controls = captured.controls.mock.calls.at(-1)![0] as PlaybackControlsProps;
  return { props, controls, html };
}

beforeEach(() => { captured.audio.mockClear(); captured.controls.mockClear(); });

describe("Preview controlled transport wiring (SSR handlers, not mounted playback)", () => {
  it("routes the actual bar through parent toggle/pause/seek callbacks without a second clock", () => {
    const toggle = vi.fn(), pause = vi.fn(), seek = vi.fn(), shuttle = vi.fn(), step = vi.fn(), rate = vi.fn();
    const { props, controls, html } = render({ onTogglePlayback: toggle, onPausePlayback: pause,
      onPlayheadChange: seek, onShuttle: shuttle, onFrameStep: step, onPlaybackRateChange: rate });
    controls.onTogglePlayback(); controls.onPausePlayback(); controls.onSeek(3);
    controls.onShuttle!(-1); controls.onFrameStep!(1); controls.onPlaybackRateChange!(-2);
    expect(toggle).toHaveBeenCalledTimes(1); expect(pause).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(3); expect(shuttle).toHaveBeenCalledWith(-1);
    expect(step).toHaveBeenCalledWith(1); expect(rate).toHaveBeenCalledWith(-2);
    expect(props.onPlayingChange).not.toHaveBeenCalled();
    expect(html).toContain('class="preview-panel preview-with-transport"');
    expect(html).toContain('data-testid="playback-controls"');
    expect(html).toContain('data-testid="preview-play"');
    expect(html).toContain('aria-label="播放" aria-keyshortcuts="Space"');
  });

  it("forwards the signed rate and excludes native video clocks at nonunit rates", () => {
    render({ playbackRate: -2, autonomousGpuPlayback: true, nativeGpuPlaybackPreparing: true });
    const reverse = captured.audio.mock.calls.at(-1)![0];
    expect(reverse.playbackRate).toBe(-2); expect(reverse.externalVideoClock).toBe(false);
    render({ playbackRate: 4, autonomousGpuPlayback: true });
    expect(captured.audio.mock.calls.at(-1)![0].externalVideoClock).toBe(false);
    render({ playbackRate: 1, autonomousGpuPlayback: true });
    expect(captured.audio.mock.calls.at(-1)![0].externalVideoClock).toBe(true);
  });

  it("preserves the old optional-prop caller and delegates its end reset only when no parent toggle exists", () => {
    const { props, controls } = render({ playhead: 10 });
    controls.onTogglePlayback();
    expect(props.onPlayheadChange).toHaveBeenCalledWith(0);
    expect(props.onPlayingChange).toHaveBeenCalledWith(true);
    controls.onPausePlayback();
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(false);
    expect(controls.onShuttle).toBeUndefined(); expect(controls.onFrameStep).toBeUndefined();
    expect(captured.audio.mock.calls.at(-1)![0].playbackRate).toBe(1);
    const supplied = render({ playhead: 10, onTogglePlayback: vi.fn() });
    supplied.controls.onTogglePlayback();
    expect(supplied.props.onTogglePlayback).toHaveBeenCalledTimes(1);
    expect(supplied.props.onPlayheadChange).not.toHaveBeenCalled();
  });

  it("shows disabled transport for an empty project and permanent transport for the native surface", () => {
    const empty = render({ projectDuration: 0 });
    expect(empty.html).toContain('data-testid="playback-controls"');
    expect(empty.html).toContain('data-testid="transport-play-pause"');
    expect(empty.html).not.toContain('data-testid="preview-play"');
    const native = render({ nativeGpuPreview: true, playing: true });
    expect(native.html).toContain('data-testid="native-gpu-surface"');
    expect(native.html).toContain('data-testid="playback-controls"');
    expect(native.html).toContain('aria-label="暫停播放"');
  });
});

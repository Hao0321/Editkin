import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlaybackControls, type PlaybackControlsProps } from "./PlaybackControls";

type ControlProps = { children?: ReactNode; "aria-label"?: string; "data-testid"?: string; disabled?: boolean;
  value?: string | number; step?: number; onClick?: () => void;
  onChange?: (event: { currentTarget: { value: string } }) => void };
function find(node: ReactNode, id: string, attribute: "aria-label" | "data-testid" = "data-testid"): ReactElement<ControlProps> {
  const visit = (value: ReactNode): ReactElement<ControlProps> | undefined => {
    if (Array.isArray(value)) return value.map(visit).find(Boolean);
    if (!isValidElement<ControlProps>(value)) return;
    if (value.props[attribute] === id) return value;
    return visit(value.props.children);
  };
  const found = visit(node);
  if (!found) throw new Error(`Missing actual control: ${id}`);
  return found;
}
function props(overrides: Partial<PlaybackControlsProps> = {}): PlaybackControlsProps {
  return { playing: false, playhead: 2, duration: 10, fps: 30, playbackRate: 1,
    onTogglePlayback: vi.fn(), onPausePlayback: vi.fn(), onSeek: vi.fn(),
    onPlaybackRateChange: vi.fn(), onShuttle: vi.fn(), onFrameStep: vi.fn(), ...overrides };
}

describe("controlled preview transport controls", () => {
  it("keeps labelled transport, frame, rate and seek controls visible while paused", () => {
    const html = renderToStaticMarkup(<PlaybackControls {...props()} />);
    for (const id of ["transport-play-pause", "transport-reverse", "transport-pause", "transport-forward",
      "transport-previous-frame", "transport-next-frame", "transport-seek", "transport-rate-readout"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('aria-label="預覽播放控制"');
    expect(html).toContain('aria-keyshortcuts="Space"');
    expect(html).toContain('aria-keyshortcuts="J"');
    expect(html).toContain('aria-keyshortcuts="K"');
    expect(html).toContain('aria-keyshortcuts="L"');
    expect(html).toContain('aria-valuetext="00:02.00，全長 00:10.00"');
    expect(html.match(/<option /g)).toHaveLength(5);
  });

  it("invokes the supplied toggle, pause, shuttle and frame handlers with exact directions", () => {
    const input = props(), tree = PlaybackControls(input);
    for (const id of ["transport-play-pause", "transport-pause", "transport-reverse", "transport-forward",
      "transport-previous-frame", "transport-next-frame"]) find(tree, id).props.onClick!();
    expect(input.onTogglePlayback).toHaveBeenCalledTimes(1);
    expect(input.onPausePlayback).toHaveBeenCalledTimes(1);
    expect(input.onShuttle).toHaveBeenNthCalledWith(1, -1);
    expect(input.onShuttle).toHaveBeenNthCalledWith(2, 1);
    expect(input.onFrameStep).toHaveBeenNthCalledWith(1, -1);
    expect(input.onFrameStep).toHaveBeenNthCalledWith(2, 1);
    expect(input.onSeek).not.toHaveBeenCalled();
    expect(input.onPlaybackRateChange).not.toHaveBeenCalled();
  });

  it("projects playing and reverse rate from props without changing playback state", () => {
    const input = props({ playing: true, playbackRate: -4 });
    const html = renderToStaticMarkup(<PlaybackControls {...input} />);
    expect(html).toContain('aria-label="暫停播放"');
    expect(html).toContain("倒放 · −4×");
    expect(html).toContain('value="4" selected=""');
    expect(html).toContain("倒放預覽，聲音靜音");
    expect(input.onTogglePlayback).not.toHaveBeenCalled();
    expect(input.onPlaybackRateChange).not.toHaveBeenCalled();
  });

  it("uses the actual rate selector to preserve direction including half speed", () => {
    const reverse = props({ playbackRate: -2 }), forward = props({ playbackRate: 2 });
    const select = find(PlaybackControls(reverse), "預覽播放速度", "aria-label");
    select.props.onChange!({ currentTarget: { value: "0.5" } });
    select.props.onChange!({ currentTarget: { value: "8" } });
    expect(reverse.onPlaybackRateChange).toHaveBeenNthCalledWith(1, -0.5);
    expect(reverse.onPlaybackRateChange).toHaveBeenNthCalledWith(2, -8);
    find(PlaybackControls(forward), "預覽播放速度", "aria-label").props.onChange!({ currentTarget: { value: "0.5" } });
    expect(forward.onPlaybackRateChange).toHaveBeenCalledWith(0.5);
  });

  it("rejects unsupported rate values without dispatching a playback action", () => {
    const input = props(), select = find(PlaybackControls(input), "預覽播放速度", "aria-label");
    for (const value of ["0", "-2", "16", "NaN", ""]) select.props.onChange!({ currentTarget: { value } });
    expect(input.onPlaybackRateChange).not.toHaveBeenCalled();
    expect(input.onTogglePlayback).not.toHaveBeenCalled();
  });

  it("pauses before seeking, clamps boundaries and preserves the fractional frame step", () => {
    const order: Array<string | number> = [], input = props({ fps: 29.97,
      onPausePlayback: () => { order.push("pause"); }, onSeek: time => { order.push(time); } });
    const seek = find(PlaybackControls(input), "transport-seek");
    expect(seek.props.step).toBe(1 / 29.97);
    for (const value of ["-3", "12", "2.125", "NaN"]) seek.props.onChange!({ currentTarget: { value } });
    expect(order).toEqual(["pause", 0, "pause", 10, "pause", 2.125]);
  });

  it("keeps unavailable optional actions disabled for legacy callers", () => {
    const tree = PlaybackControls(props({ onShuttle: undefined, onFrameStep: undefined, onPlaybackRateChange: undefined }));
    for (const id of ["transport-reverse", "transport-forward", "transport-previous-frame", "transport-next-frame"]) {
      expect(find(tree, id).props.disabled).toBe(true);
      expect(find(tree, id).props.onClick).toBeUndefined();
    }
    expect(find(tree, "預覽播放速度", "aria-label").props.disabled).toBe(true);
    expect(find(tree, "transport-play-pause").props.disabled).toBe(false);
  });

  it("retains the control bar for an empty project and clamps nonfinite readout inputs", () => {
    const tree = PlaybackControls(props({ duration: 0, playhead: Infinity, fps: NaN }));
    for (const id of ["transport-play-pause", "transport-pause", "transport-reverse", "transport-forward", "transport-seek"]) {
      expect(find(tree, id).props.disabled).toBe(true);
    }
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('data-testid="playback-controls"');
    expect(html).toContain('value="0"');
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("NaN");
  });
});

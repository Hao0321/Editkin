import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { formatTime } from "../lib/format";
import { PlaybackNotices, playbackNoticeCopy, type PlaybackNoticePlacement } from "./PlaybackNotices";
import { currentPlaybackNotices, subscribePlaybackNotices } from "./playbackNoticeStore";
import { previewRateIsAudible } from "./playbackTiming";
import "./playbackControls.css";

export interface PlaybackControlsProps {
  playing: boolean;
  playhead: number;
  duration: number;
  fps: number;
  playbackRate?: number;
  onTogglePlayback: () => void;
  onPausePlayback: () => void;
  onSeek: (time: number) => void;
  onPlaybackRateChange?: (rate: number) => void;
  onShuttle?: (direction: -1 | 1) => void;
  onFrameStep?: (direction: -1 | 1) => void;
  /** "inline" while GPU 直出 shows the picture: its native window covers the stage,
   * so notices floated over the picture would be hidden behind it. */
  noticePlacement?: PlaybackNoticePlacement;
}

const rates = [0.5, 1, 2, 4, 8] as const;

/** How much of the transport row is spelled out (see TransportRow). */
export type TransportDensity = "full" | "compact" | "more" | "wrap";

/**
 * Picks the roomiest transport layout that fits on one row, from measured widths:
 *  - "full": every button with its word;
 *  - "compact": 播放 keeps its word, the other buttons show their icon (their name stays in aria-label and title);
 *  - "more": 播放, the frame steps and 「更多」, which opens 倒放／暫停／快轉 and the speed;
 *  - "wrap": even that is too wide (a very narrow panel at a large interface size), so the row may wrap.
 * The state readout shrinks instead of wrapping; when its words no longer fit it leaves the view (still announced).
 */
export function nextTransportFit(fit: { density: TransportDensity; readout: boolean }, measured: { overflow: boolean; readoutCut: boolean }):
  { density: TransportDensity; readout: boolean } | undefined {
  if (measured.overflow) {
    if (fit.density === "full") return { ...fit, density: "compact" };
    if (fit.density === "compact") return { ...fit, density: "more" };
    if (fit.density === "more") return { ...fit, density: "wrap" };
  }
  if (measured.readoutCut && fit.readout) return { ...fit, readout: false };
  return undefined;
}

/**
 * The one-row transport. Measured before paint (no flicker) whenever the row's width or its words change; the
 * density only switches CSS, so the buttons stay the same elements and keep focus. 「更多」 opens its controls
 * below the row with fixed positioning: GPU 直出 draws the picture in a native window above the stage, which would hide
 * anything opened over the picture, and fixed positioning is not cut by the scrolling preview column.
 */
function TransportRow({ children, fitKey, secondary = true }: { children: ReactNode; fitKey: string; secondary?: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState<{ key: string; density: TransportDensity; readout: boolean }>({ key: "", density: "full", readout: true });
  const [open, setOpen] = useState(false);
  const key = `${width}|${fitKey}`;
  const current = fit.key === key ? fit : { key, density: "full" as TransportDensity, readout: true };
  // Simple mode has no 倒放／暫停／快轉／速度 group, so there is nothing for 「更多」 to open.
  const showMore = secondary && (current.density === "more" || current.density === "wrap");
  const menuOpen = open && showMore;

  // Measured until the layout settles for this width and these words; playback (a new playhead every frame) re-renders
  // the row without measuring it again.
  const settled = useRef("");
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (fit.key !== key) { setFit(current); return; }
    const state = `${key}|${fit.density}|${fit.readout}`;
    if (settled.current === state) return;
    const readout = row.querySelector<HTMLElement>(":scope > .playback-state");
    const next = nextTransportFit(fit, {
      overflow: row.scrollWidth > row.clientWidth + 1,
      readoutCut: Boolean(fit.readout && readout && readout.scrollWidth > readout.clientWidth + 1),
    });
    if (next) setFit({ ...next, key }); else settled.current = state;
  });

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    // A new width starts again from the roomiest layout; an open 「更多」 closes (its place under the button moved).
    const observer = new ResizeObserver(() => {
      const next = Math.round(row.clientWidth);
      if (next === widthRef.current) return;
      widthRef.current = next;
      setWidth(next);
      setOpen(false);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  // 「更多」: placed under its button (above it only when there is no room below), inside the window.
  useLayoutEffect(() => {
    const row = rowRef.current, button = moreRef.current;
    if (!menuOpen || !row || !button) return;
    const place = () => {
      const panel = row.querySelector<HTMLElement>(".playback-secondary");
      if (!panel) return;
      const anchor = button.getBoundingClientRect(), size = panel.getBoundingClientRect();
      const below = anchor.bottom + 6, above = anchor.top - size.height - 6;
      const top = below + size.height <= window.innerHeight - 8 || above < 8 ? below : above;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - size.width - 8));
      row.style.setProperty("--playback-more-top", `${Math.round(top)}px`);
      row.style.setProperty("--playback-more-left", `${Math.round(left)}px`);
    };
    place();
    const onScroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(row)) place(); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : undefined;
      if (target && (button.contains(target) || row.querySelector(".playback-secondary")?.contains(target))) return;
      setOpen(false);
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [menuOpen]);

  const toggle = () => {
    const opening = !menuOpen;
    setOpen(opening);
    // The opened controls come first in the reading order, so the keyboard lands on them.
    if (opening) requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>(".playback-secondary button:not(:disabled), .playback-secondary select:not(:disabled)")?.focus());
  };
  const closeOnEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !menuOpen) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    moreRef.current?.focus();
  };

  return <div className="playback-controls-row" ref={rowRef} data-density={current.density} data-readout={current.readout ? undefined : "hidden"}
    data-more-open={menuOpen ? "true" : undefined} onKeyDown={closeOnEscape}>
    {children}
    {secondary && <button ref={moreRef} type="button" className="playback-more-toggle" data-testid="transport-more" hidden={!showMore}
      aria-expanded={menuOpen} aria-label={uiText("更多播放控制")} title={uiText("倒放、暫停、快轉和播放速度")} onClick={toggle}>
      <span aria-hidden="true">⋯</span><span className="playback-label">{uiText("更多")}</span>
    </button>}
  </div>;
}

/** The visible playback state. Compatible audio that keeps playing is stated here
 * with the badge's term (音訊相容模式), not as a banner; the plain reason and the
 * raw cause are in the tooltip. It never wraps the row: it shrinks first, and the
 * row leaves it out of view when even its words no longer fit. */
function PlaybackStateReadout({ label }: { label: string }) {
  const notices = useSyncExternalStore(subscribePlaybackNotices, currentPlaybackNotices, currentPlaybackNotices);
  const fallback = notices.find(notice => notice.kind === "audio-fallback");
  const text = fallback ? `${label} · ${uiText("音訊相容模式")}` : label;
  const title = fallback ? [text, playbackNoticeCopy(fallback).line, fallback.detail ? uiText("原因：{value0}", { value0: fallback.detail }) : ""].filter(Boolean).join("\n") : text;
  return <output className="playback-state" aria-label={uiText("目前播放狀態")} aria-live="polite" data-testid="transport-rate-readout"
    data-audio-mode={fallback ? "compatible" : undefined} title={title}>{text}</output>;
}

/** A controlled transport view: the editor owns the clock, direction and seeks. */
export function PlaybackControls({ playing, playhead, duration, fps, playbackRate = 1,
  onTogglePlayback, onPausePlayback, onSeek, onPlaybackRateChange, onShuttle, onFrameStep, noticePlacement = "overlay" }: PlaybackControlsProps) {
  const { locale, scale, mode } = useI18n();
  // Simple mode keeps one 播放／暫停, the frame steps, the time and the scrubber. 倒放, 快轉 and the speed are advanced
  // tools (J, K and L still work from the keyboard in both modes; the state readout then shows the speed).
  const simple = mode === "simple";
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const current = Math.max(0, Math.min(end, Number.isFinite(playhead) ? playhead : 0));
  const frameRate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const available = end > 0;
  const rate = Number.isFinite(playbackRate) && playbackRate !== 0 ? playbackRate : 1;
  const magnitude = Math.abs(rate);
  const reverse = rate < 0;
  const selectedRate = rates.includes(magnitude as typeof rates[number]) ? magnitude : "";
  // The audio policy is part of the visible state: reverse and 8× are muted, and
  // 0.5×–4× forward play the clips' own sound at that speed.
  const audioPolicy = reverse || !previewRateIsAudible(magnitude) ? uiText("已靜音") : magnitude !== 1 ? uiText("聲音跟著變速") : "";
  const stateLabel = `${uiText(playing ? reverse ? "倒放" : "播放" : "已暫停")} · ${reverse ? "−" : ""}${magnitude}×${audioPolicy ? ` · ${audioPolicy}` : ""}`;
  // Simple mode has no speed list, so its one 播放 button always plays forward at normal speed (after J or L changed it).
  const plainPlay = simple && !playing && rate !== 1 && Boolean(onPlaybackRateChange);
  const resumeReverse = reverse && !plainPlay;
  const playLabel = playing ? uiText("暫停") : resumeReverse ? uiText("繼續倒放") : uiText("播放");
  const play = plainPlay ? () => { onPlaybackRateChange?.(1); onTogglePlayback(); } : onTogglePlayback;

  return <div className="playback-controls" role="group" aria-label={uiText("預覽播放控制")} data-testid="playback-controls">
    <PlaybackNotices placement={noticePlacement} />
    <TransportRow fitKey={`${locale ?? ""}|${scale ?? ""}|${playLabel}|${stateLabel}|${simple ? "simple" : ""}`} secondary={!simple}>
      <div className="playback-controls-actions">
        <button type="button" className="playback-main" data-testid="transport-play-pause"
          aria-label={playing ? uiText("暫停播放") : resumeReverse ? uiText("繼續倒放") : uiText("播放")} aria-keyshortcuts="Space"
          title={playing ? uiText("暫停播放（Space）") : resumeReverse ? uiText("繼續倒放（Space）") : uiText("播放（Space）")} disabled={!available} onClick={play}>
          <span aria-hidden="true">{playing ? "❚❚" : resumeReverse ? "◀" : "▶"}</span>{playLabel}
        </button>
        {/* Shown in the row while it fits, otherwise behind 「更多」. */}
        {!simple && <div className="playback-secondary">
          <button type="button" data-testid="transport-reverse" aria-label={uiText("倒放預覽")} aria-keyshortcuts="J"
            title={uiText("倒放預覽，聲音靜音（J；再次按下加速）")} disabled={!available || !onShuttle}
            onClick={onShuttle ? () => onShuttle(-1) : undefined}><span aria-hidden="true">◀◀</span><span className="playback-label">{uiText("倒放")}</span></button>
          <button type="button" data-testid="transport-pause" aria-label={uiText("暫停")} aria-keyshortcuts="K"
            title={uiText("暫停（K）")} disabled={!available} onClick={onPausePlayback}><span aria-hidden="true">❚❚</span><span className="playback-label">{uiText("暫停")}</span></button>
          <button type="button" data-testid="transport-forward" aria-label={uiText("快轉預覽")} aria-keyshortcuts="L"
            title={uiText("快轉；再次按下加速。L 向前播放並逐次加速")} disabled={!available || !onShuttle}
            onClick={onShuttle ? () => onShuttle(1) : undefined}><span aria-hidden="true">▶▶</span><span className="playback-label">{uiText("快轉")}</span></button>
          <label className="playback-rate-control"><span className="playback-label">{uiText("速度")}</span><select aria-label={uiText("預覽播放速度")} value={selectedRate} disabled={!available || !onPlaybackRateChange}
              title={uiText("調整播放倍率，保留目前播放方向")} onChange={event => {
                const next = Number(event.currentTarget.value);
                if (rates.includes(next as typeof rates[number])) onPlaybackRateChange?.((reverse ? -1 : 1) * next);
              }}>
              {selectedRate === "" && <option value="" disabled>{magnitude}×</option>}
              {rates.map(value => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
        </div>}
        <div className="playback-frame-actions" role="group" aria-label={uiText("逐格預覽")}>
          <button type="button" data-testid="transport-previous-frame" aria-label={uiText("上一格")} aria-keyshortcuts="ArrowLeft"
            title={uiText("上一格（←）")} disabled={!available || !onFrameStep}
            onClick={onFrameStep ? () => onFrameStep(-1) : undefined}><span aria-hidden="true">|◀</span><span className="playback-label">{uiText("上一格")}</span></button>
          <button type="button" data-testid="transport-next-frame" aria-label={uiText("下一格")} aria-keyshortcuts="ArrowRight"
            title={uiText("下一格（→）")} disabled={!available || !onFrameStep}
            onClick={onFrameStep ? () => onFrameStep(1) : undefined}><span aria-hidden="true">▶|</span><span className="playback-label">{uiText("下一格")}</span></button>
        </div>
      </div>
      {/* Simple mode says the state only when it is not ordinary playback (J／L changed the speed or direction). */}
      {(!simple || rate !== 1) && <PlaybackStateReadout label={stateLabel} />}
    </TransportRow>
    <div className="playback-seek-row">
      <output className="playback-time" role="timer" aria-live="off" aria-label={uiText("目前時間")}>{formatTime(current)}</output>
      <input type="range" min={0} max={end} step={1 / frameRate} value={current} disabled={!available}
        aria-label={uiText("預覽播放位置")} aria-valuetext={uiText("{value0}，全長 {value1}", { value0: formatTime(current), value1: formatTime(end) })}
        title={uiText("拖曳以定位；定位時暫停播放")} data-testid="transport-seek" onChange={event => {
          const target = Number(event.currentTarget.value);
          if (!Number.isFinite(target)) return;
          onPausePlayback();
          onSeek(Math.max(0, Math.min(end, target)));
        }} />
      <output className="playback-time" aria-label={uiText("專案全長")}>{formatTime(end)}</output>
    </div>
  </div>;
}

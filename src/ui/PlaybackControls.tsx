import { formatTime } from "../lib/format";
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
}

const rates = [0.5, 1, 2, 4, 8] as const;

/** A controlled transport view: the editor owns the clock, direction and seeks. */
export function PlaybackControls({ playing, playhead, duration, fps, playbackRate = 1,
  onTogglePlayback, onPausePlayback, onSeek, onPlaybackRateChange, onShuttle, onFrameStep }: PlaybackControlsProps) {
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const current = Math.max(0, Math.min(end, Number.isFinite(playhead) ? playhead : 0));
  const frameRate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const available = end > 0;
  const rate = Number.isFinite(playbackRate) && playbackRate !== 0 ? playbackRate : 1;
  const magnitude = Math.abs(rate);
  const reverse = rate < 0;
  const selectedRate = rates.includes(magnitude as typeof rates[number]) ? magnitude : "";
  const stateLabel = `${playing ? reverse ? "倒放" : "播放" : "已暫停"} · ${reverse ? "−" : ""}${magnitude}×`;

  return <div className="playback-controls" role="group" aria-label="預覽播放控制" data-testid="playback-controls">
    <div className="playback-controls-row">
      <div className="playback-controls-actions">
        <button type="button" className="playback-main" data-testid="transport-play-pause"
          aria-label={playing ? "暫停播放" : reverse ? "繼續倒放" : "播放"} aria-keyshortcuts="Space"
          title={playing ? "暫停播放（Space）" : reverse ? "繼續倒放（Space）" : "播放（Space）"} disabled={!available} onClick={onTogglePlayback}>
          <span aria-hidden="true">{playing ? "❚❚" : reverse ? "◀" : "▶"}</span>{playing ? "暫停" : reverse ? "繼續倒放" : "播放"}
        </button>
        <button type="button" data-testid="transport-reverse" aria-label="倒放預覽" aria-keyshortcuts="J"
          title="倒放預覽，聲音靜音（J；再次按下加速）" disabled={!available || !onShuttle}
          onClick={onShuttle ? () => onShuttle(-1) : undefined}><span aria-hidden="true">◀◀</span>倒放</button>
        <button type="button" data-testid="transport-pause" aria-label="暫停" aria-keyshortcuts="K"
          title="暫停（K）" disabled={!available} onClick={onPausePlayback}><span aria-hidden="true">❚❚</span>暫停</button>
        <button type="button" data-testid="transport-forward" aria-label="快轉預覽" aria-keyshortcuts="L"
          title="快轉；再次按下加速。L 向前播放並逐次加速" disabled={!available || !onShuttle}
          onClick={onShuttle ? () => onShuttle(1) : undefined}><span aria-hidden="true">▶▶</span>快轉</button>
        <div className="playback-frame-actions" role="group" aria-label="逐格預覽">
          <button type="button" data-testid="transport-previous-frame" aria-label="上一格" aria-keyshortcuts="ArrowLeft"
            title="上一格（←）" disabled={!available || !onFrameStep}
            onClick={onFrameStep ? () => onFrameStep(-1) : undefined}><span aria-hidden="true">|◀</span>上一格</button>
          <button type="button" data-testid="transport-next-frame" aria-label="下一格" aria-keyshortcuts="ArrowRight"
            title="下一格（→）" disabled={!available || !onFrameStep}
            onClick={onFrameStep ? () => onFrameStep(1) : undefined}><span aria-hidden="true">▶|</span>下一格</button>
        </div>
      </div>
      <label className="playback-rate-control">速度
        <select aria-label="預覽播放速度" value={selectedRate} disabled={!available || !onPlaybackRateChange}
          title="調整播放倍率，保留目前播放方向" onChange={event => {
            const next = Number(event.currentTarget.value);
            if (rates.includes(next as typeof rates[number])) onPlaybackRateChange?.((reverse ? -1 : 1) * next);
          }}>
          {selectedRate === "" && <option value="" disabled>{magnitude}×</option>}
          {rates.map(value => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
      <output className="playback-state" aria-label="目前播放狀態" aria-live="polite" data-testid="transport-rate-readout">{stateLabel}</output>
    </div>
    <div className="playback-seek-row">
      <output className="playback-time" role="timer" aria-live="off" aria-label="目前時間">{formatTime(current)}</output>
      <input type="range" min={0} max={end} step={1 / frameRate} value={current} disabled={!available}
        aria-label="預覽播放位置" aria-valuetext={`${formatTime(current)}，全長 ${formatTime(end)}`}
        title="拖曳以定位；定位時暫停播放" data-testid="transport-seek" onChange={event => {
          const target = Number(event.currentTarget.value);
          if (!Number.isFinite(target)) return;
          onPausePlayback();
          onSeek(Math.max(0, Math.min(end, target)));
        }} />
      <output className="playback-time" aria-label="專案全長">{formatTime(end)}</output>
    </div>
  </div>;
}

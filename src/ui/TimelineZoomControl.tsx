import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";

/** The slider runs 0–1000 over the zoom range on a log scale, so each step feels the same at every zoom. */
export const TIMELINE_ZOOM_SLIDER_MAX = 1000;
/** Each − / ＋ press: the same factors as 縮小／放大 in advanced mode's 更多工具. */
export const TIMELINE_ZOOM_OUT = 0.75;
export const TIMELINE_ZOOM_IN = 1.34;

export function timelineZoomToSlider(pixelsPerSecond: number, min: number, max: number): number {
  const value = Math.min(max, Math.max(min, Number.isFinite(pixelsPerSecond) ? pixelsPerSecond : min));
  return Math.round(TIMELINE_ZOOM_SLIDER_MAX * Math.log(value / min) / Math.log(max / min));
}

export function timelineZoomFromSlider(slider: number, min: number, max: number): number {
  const position = Math.min(TIMELINE_ZOOM_SLIDER_MAX, Math.max(0, Number.isFinite(slider) ? slider : 0)) / TIMELINE_ZOOM_SLIDER_MAX;
  return min * Math.pow(max / min, position);
}

interface TimelineZoomControlProps {
  pixelsPerSecond: number;
  min: number;
  max: number;
  /** Multiply the zoom around the middle of the view (the timeline's own zoom keeps that moment in place). */
  onZoom: (factor: number) => void;
  /** Show the whole project. Double-clicking the time ruler does the same. */
  onFit: () => void;
}

/** Icons, not text: the timeline toolbar hides its spans on a narrow window, and a glyph would change with the font. */
function ZoomIcon({ path }: { path: string }) {
  return <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d={path}
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Simple mode's small zoom: −, a slider, ＋ and 顯示全部. */
export function TimelineZoomControl({ pixelsPerSecond, min, max, onZoom, onFit }: TimelineZoomControlProps) {
  useI18n();
  const slider = timelineZoomToSlider(pixelsPerSecond, min, max);
  const percent = Math.round(slider / (TIMELINE_ZOOM_SLIDER_MAX / 100));
  return <div className="timeline-zoom-control" role="group" aria-label={uiText("時間軸縮放")} data-testid="timeline-zoom-control">
    <button type="button" data-testid="timeline-zoom-out" aria-label={uiText("縮小")} aria-keyshortcuts="-" title={uiText("縮小時間軸（-）")} disabled={slider <= 0}
      onClick={() => onZoom(TIMELINE_ZOOM_OUT)}><ZoomIcon path="M5 10h10" /></button>
    <input type="range" min={0} max={TIMELINE_ZOOM_SLIDER_MAX} step={10} value={slider} data-testid="timeline-zoom-slider"
      aria-label={uiText("時間軸縮放")} aria-valuetext={uiText("放大 {value0}%", { value0: percent })} title={uiText("拖曳放大或縮小時間軸")}
      onChange={event => {
        const next = timelineZoomFromSlider(Number(event.currentTarget.value), min, max);
        if (Number.isFinite(next) && pixelsPerSecond > 0) onZoom(next / pixelsPerSecond);
      }} />
    <button type="button" data-testid="timeline-zoom-in" aria-label={uiText("放大")} aria-keyshortcuts="=" title={uiText("放大時間軸（=）")} disabled={slider >= TIMELINE_ZOOM_SLIDER_MAX}
      onClick={() => onZoom(TIMELINE_ZOOM_IN)}><ZoomIcon path="M5 10h10M10 5v10" /></button>
    <button type="button" data-testid="timeline-fit-button" aria-label={uiText("顯示全部")} aria-keyshortcuts="\ Shift+Z" title={uiText("顯示整段時間軸（\\ 或 Shift+Z，也可以雙擊時間尺）")} onClick={onFit}>
      <ZoomIcon path="M2 5v10M18 5v10M5 10h10M5 10l3-3M5 10l3 3M15 10l-3-3M15 10l-3 3" />
    </button>
  </div>;
}

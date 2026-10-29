import type { MediaAsset, TimelineClip } from "../domain/types";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import "./clipSpeedControls.css";

interface Props {
  clip: TimelineClip; asset?: MediaAsset; playhead?: number; busy?: boolean;
  onRetime?: (rate:number,reverse:boolean)=>unknown; onFreezeFrame?: ()=>unknown;
}
export function ClipSpeedControls({clip,asset,playhead=0,busy=false,onRetime,onFreezeFrame}:Props) {
  useI18n();
  if(!asset || asset.kind==='image') return null;
  const rate=asset.clipRetime?.rate??1, reverse=asset.clipRetime?.reverse??false;
  const canFreeze=asset.kind==='video'&&playhead>=clip.timelineStart&&playhead<clip.timelineStart+clip.duration;
  return <div className="clip-speed-controls" data-testid="clip-speed-controls">
    <label className="field-label">{uiText("片段速度")}</label>
    <div className="clip-speed-controls-row"><div className="timeline-tool-toggle" role="group" aria-label={uiText("片段速度")}>{[0.5,1,1.5,2].map(value=><button type="button" key={value}
      aria-pressed={rate===value} disabled={busy||!onRetime} onClick={()=>onRetime?.(value,reverse)} data-testid={`clip-speed-${value}`}>{value}×</button>)}</div>
    <button type="button" className="clip-speed-reverse" aria-pressed={reverse} disabled={busy||!onRetime}
      onClick={()=>onRetime?.(rate,!reverse)} data-testid="clip-reverse">{uiText("倒放")}</button></div>
    {asset.kind==='video'&&onFreezeFrame&&<button type="button" className="clip-speed-freeze" disabled={busy||!canFreeze} onClick={onFreezeFrame} data-testid="clip-freeze-frame"
      title={canFreeze?undefined:uiText("播放頭要在選取的影片片段內，才能定格。")}>{uiText("定格 2 秒")}</button>}
  </div>;
}

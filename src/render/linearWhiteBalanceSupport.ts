import type { MediaAsset, TimelineClip } from "../domain/types";
import { getLinearWhiteBalanceStops } from "../color/linearWhiteBalance";

/** Source-primary WB cannot silently turn into a post-composite adjustment.
 * Static clips are supported; animated source-time WB requires a separately
 * qualified frame-clock adapter. Preserve the project and fail visibly.
 */
export function assertStaticSourceWhiteBalance(clip: TimelineClip, asset?: MediaAsset): void {
  const base = getLinearWhiteBalanceStops(clip.color);
  const frames = clip.keyframes.map(frame => getLinearWhiteBalanceStops(frame.color));
  if (frames.some(stops => stops.some((value, i) => value !== base[i]))) {
    throw Error(`片段 ${clip.id} 的動畫線性白平衡尚未接入正式逐幀輸出；已停止，沒有略過關鍵影格`);
  }
  if (base.some(value => value !== 0) && (clip.layer?.role === "adjustment" || clip.layer?.role === "controller" || asset?.compositionId)) {
    throw Error(`片段 ${clip.id} 的線性白平衡需要原始素材域，不能當作調整層／巢狀合成後的濾鏡`);
  }
}

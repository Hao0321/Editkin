import { useState } from "react";
import type { MediaAsset, TimelineClip } from "../domain/types";
import type { FloatingFrameSceneBindings, FloatingFrameScenePresetId } from "../motion/floatingFrameScenes";

export default function FloatingFrameSourceSlots({ clip, assets, disabled, onApply }: {
  clip: TimelineClip; assets: readonly MediaAsset[]; disabled: boolean;
  onApply?: (preset: FloatingFrameScenePresetId, sources?: FloatingFrameSceneBindings) => void;
}) {
  const [rear, setRear] = useState("");
  const [front, setFront] = useState("");
  const [rearStart, setRearStart] = useState(0);
  const [frontStart, setFrontStart] = useState(0);
  const [preset, setPreset] = useState<FloatingFrameScenePresetId>("portrait_stack");
  const choices = assets.filter(asset => asset.kind === "video" && asset.id !== clip.assetId);
  const fits = (id: string, start: number) => choices.some(asset => asset.id === id && Number.isFinite(start) && start >= 0 && start + clip.duration <= asset.duration);
  const ready = rear !== front && fits(rear, rearStart) && fits(front, frontStart);
  return <div className="floating-source-slots" data-testid="floating-source-slots">
    <strong>三份獨立素材</strong><small>後左使用選中原片；只有原片保留音訊。</small>
    <label>後右影片<select aria-label="浮窗後右素材" value={rear} onChange={event => setRear(event.target.value)}><option value="">選擇影片</option>{choices.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
    <label>後右入點（秒）<input aria-label="浮窗後右入點" type="number" min="0" step="0.033333" value={rearStart} onChange={event => setRearStart(Number(event.target.value))} /></label>
    <label>前景影片<select aria-label="浮窗前景素材" value={front} onChange={event => setFront(event.target.value)}><option value="">選擇影片</option>{choices.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
    <label>前景入點（秒）<input aria-label="浮窗前景入點" type="number" min="0" step="0.033333" value={frontStart} onChange={event => setFrontStart(Number(event.target.value))} /></label>
    <label>編排<select aria-label="浮窗素材編排" value={preset} onChange={event => setPreset(event.target.value as FloatingFrameScenePresetId)}><option value="portrait_stack">錯層展廊</option><option value="portrait_duo">雙直式後景</option></select></label>
    <button type="button" disabled={disabled || !ready || !onApply} onClick={() => onApply?.(preset, { rearRight: { assetId: rear, sourceStart: rearStart }, front: { assetId: front, sourceStart: frontStart } })}>建立三素材浮窗</button>
    {!ready && <small>請選兩段不同且長度足夠的影片。</small>}
  </div>;
}

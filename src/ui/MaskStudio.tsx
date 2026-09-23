import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CHROMA_KEY_PRESETS, DEFAULT_CHROMA_KEY } from "../domain/chromaKey";
import { floorFrameRateSampleIndex, localProjectFrameAtTime, rationalRate } from "../domain/clipAlphaPlan";
import type { ChromaKeySettings, ClipMask, MaskShapeKind, MotionTrack, RotoCorrectionStroke, TimelineClip } from "../domain/types";
import { productAutoRotoRouteReceiptShapeSchema } from "../domain/autoRotoProductReceipt";
import type { AutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { normalizedContainedMediaPoint } from "./rotoBrushGeometry";
import "./maskStudio.css";

interface MaskStudioProps {
  projectFps: number;
  playhead: number;
  clip: TimelineClip;
  motionTracks: MotionTrack[];
  trackingBusy: boolean;
  trackingSelectionActive: boolean;
  onAdd: (kind: MaskShapeKind) => void;
  onUpdate: (maskId: string, patch: Partial<Omit<ClipMask, "id">>) => void;
  onDelete: (maskId: string) => void;
  onBindTrack: (maskId: string, trackId?: string) => void;
  onKeyframe: (maskId: string) => void;
  onFreeze: (maskId: string) => void;
  onAutoRoto: (maskId: string) => void;
  onQuickAutoRoto: () => void;
  onChromaKeyChange: (settings?: ChromaKeySettings) => void;
  autoRotoBusy: boolean;
  autoRotoRuntimeStatus: AutoRotoRuntimeStatus;
  onBeginMotionTrack: () => void;
}

function ChromaKeyControl({ settings, onChange }: { settings?: ChromaKeySettings; onChange: (settings?: ChromaKeySettings) => void }) {
  const active = settings?.enabled === true;
  const value = settings ?? DEFAULT_CHROMA_KEY;
  const patch = (next: Partial<ChromaKeySettings>) => onChange({ ...value, ...next });
  return <details className="chroma-key-card" data-testid="chroma-key-control" open={active || undefined}>
    <summary><span><b>綠／藍幕去背</b><small>{active ? `${value.screen === "green" ? "綠幕" : "藍幕"} · 分數式 Alpha` : "有攝影棚色幕才使用"}</small></span><i className={active ? "active" : ""}>{active ? "已開啟" : "選用"}</i></summary>
    <div className="chroma-key-body">
      {!active ? <div className="chroma-key-presets"><button type="button" onClick={() => onChange({ ...CHROMA_KEY_PRESETS.green })}>使用綠幕</button><button type="button" onClick={() => onChange({ ...CHROMA_KEY_PRESETS.blue })}>使用藍幕</button></div> : <>
        <div className="chroma-key-presets"><button type="button" className={value.screen === "green" ? "active" : ""} onClick={() => onChange({ ...CHROMA_KEY_PRESETS.green })}>綠幕</button><button type="button" className={value.screen === "blue" ? "active" : ""} onClick={() => onChange({ ...CHROMA_KEY_PRESETS.blue })}>藍幕</button><button type="button" className="remove" onClick={() => onChange(undefined)}>關閉</button></div>
        <label className="chroma-key-color">幕布顏色<input type="color" value={value.screenColor} onChange={(event) => patch({ screenColor: event.target.value.toUpperCase() })} /><b>{value.screenColor}</b></label>
        <label className="mask-slider">去背範圍<input type="range" min="0" max="50" value={Math.round(value.similarity * 100)} onChange={(event) => patch({ similarity: Number(event.target.value) / 100 })} /><b>{Math.round(value.similarity * 100)}%</b></label>
        <label className="mask-slider">半透明邊緣<input type="range" min="1" max="50" value={Math.round(value.softness * 100)} onChange={(event) => patch({ softness: Number(event.target.value) / 100 })} /><b>{Math.round(value.softness * 100)}%</b></label>
        <label className="mask-slider">去溢色<input type="range" min="0" max="100" value={Math.round(value.despill * 100)} onChange={(event) => patch({ despill: Number(event.target.value) / 100 })} /><b>{Math.round(value.despill * 100)}%</b></label>
        <small>這是 Editkin 自研 Keyer，不會下載第三方模型。相容預覽與正式輸出使用同一條公式；Auto Roto 是另一種工具。</small>
      </>}
    </div>
  </details>;
}

const MASK_CHOICES: Array<{ kind: MaskShapeKind; icon: string; name: string }> = [
  { kind: "subject", icon: "人物", name: "追蹤遮罩" }, { kind: "ellipse", icon: "◯", name: "橢圓" },
  { kind: "rectangle", icon: "□", name: "矩形" }, { kind: "polygon", icon: "⌁", name: "鋼筆" },
];

function rotoEngineLabel(mask: ClipMask): string {
  const sequence = mask.matteSequence;
  if (!sequence) return "";
  return productAutoRotoRouteReceiptShapeSchema.safeParse(sequence.routeReceipt).success
    ? "已保存 diagnostic receipt"
    : "歷史 Matte · Runtime 未驗證";
}

function AutoRotoEngineControl({ status }: { status: AutoRotoRuntimeStatus }) {
  return <div className={`auto-roto-model ${status.state}`} data-testid="auto-roto-model-status" data-runtime-state={status.state}>
    <div><b>Editkin 自研 Auto Roto · {status.title}</b><span>{status.detail}</span></div>
    <i>{status.badge}</i>
  </div>;
}

function normalizedPointer(event: ReactPointerEvent<SVGSVGElement>, mediaWidth: number, mediaHeight: number): { x: number; y: number } | undefined {
  const rect = event.currentTarget.getBoundingClientRect();
  return normalizedContainedMediaPoint(rect, mediaWidth, mediaHeight, event.clientX, event.clientY);
}

function RotoBrushEditor({ mask, clip, playhead, projectFps, onUpdate }: { mask: ClipMask; clip: TimelineClip; playhead: number; projectFps: number; onUpdate: MaskStudioProps["onUpdate"] }) {
  const sequence = mask.matteSequence;
  const [mode, setMode] = useState<RotoCorrectionStroke["mode"]>("foreground");
  const [radius, setRadius] = useState(.04);
  const [draft, setDraft] = useState<Array<{ x: number; y: number }>>([]);
  const [frameGeometry, setFrameGeometry] = useState<{ uri: string; width: number; height: number }>();
  const activeStroke = useRef<{
    clipId: string; maskId: string; assetId: string; sourceStart: number; duration: number;
    sequence: ClipMask["matteSequence"]; corrections: ClipMask["rotoCorrections"]; frame: number; pointerId: number;
    mode: RotoCorrectionStroke["mode"]; radius: number; points: Array<{ x: number; y: number }>;
  } | undefined>(undefined);
  if (sequence?.staleReason === "clip-time-range-changed" || !sequence?.framePreviewUris?.length) {
    activeStroke.current = undefined;
    if (sequence?.staleReason === "clip-time-range-changed") return <div className="roto-brush" data-testid={`roto-brush-time-stale-${mask.id}`}>
      <strong>片段已分割／裁切</strong><p>舊 Matte 的畫格時間已不符合目前片段。請先重新分析 Auto Roto，再使用人工筆刷。</p>
    </div>;
    return null;
  }
  const localTime = Math.max(0, Math.min(clip.duration, playhead - clip.timelineStart));
  const projectRate = rationalRate(projectFps);
  const frame = floorFrameRateSampleIndex(localProjectFrameAtTime(projectRate, localTime), projectRate, rationalRate(sequence.analysisFps), sequence.frameCount);
  const frameUri = sequence.framePreviewUris[frame];
  const activeGeometry = frameGeometry?.uri === frameUri ? frameGeometry : undefined;
  const strokes = mask.rotoCorrections ?? [];
  const frameStrokes = strokes.filter((stroke) => stroke.frame === frame);
  const pending = activeStroke.current;
  if (pending && (pending.clipId !== clip.id || pending.maskId !== mask.id || pending.assetId !== clip.assetId
    || pending.sourceStart !== clip.sourceStart || pending.duration !== clip.duration || pending.frame !== frame
    || pending.sequence !== sequence || pending.corrections !== mask.rotoCorrections)) activeStroke.current = undefined;
  const start = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!activeGeometry || activeStroke.current) return;
    const point = normalizedPointer(event, activeGeometry.width, activeGeometry.height);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activeStroke.current = { clipId: clip.id, maskId: mask.id, assetId: clip.assetId, sourceStart: clip.sourceStart, duration: clip.duration,
      sequence, corrections: mask.rotoCorrections, frame, pointerId: event.pointerId, mode, radius, points: [point] };
    setDraft(activeStroke.current.points);
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const active = activeStroke.current;
    if (!activeGeometry || !event.currentTarget.hasPointerCapture(event.pointerId) || !active || active.pointerId !== event.pointerId) return;
    const point = normalizedPointer(event, activeGeometry.width, activeGeometry.height);
    if (!point) return;
    const previous = active.points.at(-1)!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < .002) return;
    active.points = [...active.points, point];
    setDraft(active.points);
  };
  const finish = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const active = activeStroke.current;
    if (active && active.pointerId !== event.pointerId) return;
    activeStroke.current = undefined;
    setDraft([]);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!active || active.points.length === 0) return;
    const stroke: RotoCorrectionStroke = { id: `roto-${frame}-${Date.now().toString(36)}`, frame: active.frame, mode: active.mode, radius: active.radius, points: active.points };
    onUpdate(mask.id, { rotoCorrections: [...strokes, stroke], matteSequence: { ...sequence, stale: true } });
  };
  const cancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeStroke.current && activeStroke.current.pointerId !== event.pointerId) return;
    activeStroke.current = undefined;
    setDraft([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const viewWidth = activeGeometry?.width ?? 1;
  const viewHeight = activeGeometry?.height ?? 1;
  const strokeScale = Math.min(viewWidth, viewHeight);
  const polyline = (points: Array<{ x: number; y: number }>) => points.map((point) => `${point.x * viewWidth},${point.y * viewHeight}`).join(" ");
  return <div className="roto-brush" data-testid={`roto-brush-${mask.id}`}>
    <div className="roto-brush-heading"><strong>人工筆刷修正 · 第 {frame + 1} 格</strong><span>{sequence.stale ? "待重新分析" : "已同步正式 Matte"}</span></div>
    <div className="roto-brush-canvas">
      <img src={frameUri} alt={`第 ${frame + 1} 格 Auto Roto matte`} draggable={false} onLoad={(event) => setFrameGeometry({ uri: frameUri, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFrameGeometry((current) => current?.uri === frameUri ? undefined : current)} />
      <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="xMidYMid meet" data-interaction-state={activeGeometry ? "ready" : "loading"} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel} aria-disabled={!activeGeometry} aria-label="在 Matte 上畫保留或移除筆刷">
        {frameStrokes.map((stroke) => <polyline key={stroke.id} points={polyline(stroke.points)} fill="none" stroke={stroke.mode === "foreground" ? "#6ef0a8" : "#ff667f"} strokeWidth={Math.max(1, stroke.radius * strokeScale * 2)} strokeLinecap="round" strokeLinejoin="round" opacity=".8" />)}
        {activeStroke.current && draft.length > 0 && <polyline points={polyline(draft)} fill="none" stroke={activeStroke.current.mode === "foreground" ? "#6ef0a8" : "#ff667f"} strokeWidth={Math.max(1, activeStroke.current.radius * strokeScale * 2)} strokeLinecap="round" strokeLinejoin="round" opacity=".9" />}
      </svg>
    </div>
    <div className="roto-brush-tools"><button type="button" className={mode === "foreground" ? "keep active" : "keep"} onClick={() => setMode("foreground")}>＋ 保留</button><button type="button" className={mode === "background" ? "remove active" : "remove"} onClick={() => setMode("background")}>－ 移除</button><label>筆刷 <input type="range" min="1" max="18" value={Math.round(radius * 100)} onChange={(event) => setRadius(Number(event.target.value) / 100)} /></label></div>
    <div className="roto-brush-footer"><span>這格 {frameStrokes.length} 筆 · 全段 {strokes.length} 筆</span><button type="button" disabled={strokes.length === 0} onClick={() => onUpdate(mask.id, { rotoCorrections: strokes.slice(0, -1), matteSequence: { ...sequence, stale: true } })}>復原上一筆</button></div>
    {sequence.stale && <small>修正尚未進正式輸出；按下方「重新分析 Auto Roto」後才會傳播並凍結，避免錯用舊 Matte。</small>}
  </div>;
}

function MaskCard({ mask, clip, playhead, projectFps, tracks, onUpdate, onDelete, onBindTrack, onKeyframe, onFreeze, onAutoRoto, autoRotoBusy, autoRotoRuntimeStatus }: { mask: ClipMask; clip: TimelineClip; playhead: number; projectFps: number; tracks: MotionTrack[] } & Pick<MaskStudioProps, "onUpdate" | "onDelete" | "onBindTrack" | "onKeyframe" | "onFreeze" | "onAutoRoto" | "autoRotoBusy" | "autoRotoRuntimeStatus">) {
  const track = tracks.find((item) => item.id === mask.trackId);
  const coverage = track ? Math.round((1 - track.lostRatio) * 100) : undefined;
  return <article className="mask-card" data-testid={`mask-card-${mask.id}`}>
    <header><label><input type="checkbox" checked={mask.enabled} onChange={(event) => onUpdate(mask.id, { enabled: event.target.checked })} /><strong>{mask.name}</strong></label><button type="button" aria-label={`刪除${mask.name}`} onClick={() => onDelete(mask.id)}>×</button></header>
    <div className="mask-status"><span>{mask.matteSequence ? `逐像素 Matte · ${mask.matteSequence.frameCount} 格 · ${rotoEngineLabel(mask)}` : mask.kind === "subject" ? "主體追蹤路徑" : `${mask.path.length} 個路徑點`}</span><b className={track && track.lostRatio > .35 ? "warn" : ""}>{mask.matteSequence ? "品質待量測" : coverage === undefined ? "手動" : `有效 ${coverage}%`}</b></div>
    <label className="mask-wide">合成方式<select value={mask.mode} onChange={(event) => onUpdate(mask.id, { mode: event.target.value as ClipMask["mode"] })}><option value="add">加入</option><option value="subtract">減去</option><option value="intersect">交集</option></select></label>
    <div className="mask-toggle-row"><label><input type="checkbox" checked={mask.inverted} onChange={(event) => onUpdate(mask.id, { inverted: event.target.checked })} /> 反轉遮罩</label><label><input type="checkbox" checked={mask.refine.chatterReduction >= .6} onChange={(event) => onUpdate(mask.id, { refine: { ...mask.refine, chatterReduction: event.target.checked ? .7 : .25 } })} /> 降低邊緣跳動</label></div>
    <label className="mask-slider">羽化<input type="range" min="0" max="25" value={Math.round(mask.feather * 100)} onChange={(event) => onUpdate(mask.id, { feather: Number(event.target.value) / 100 })} /><b>{Math.round(mask.feather * 100)}%</b></label>
    <label className="mask-slider">擴張<input type="range" min="-25" max="25" value={Math.round(mask.expansion * 100)} onChange={(event) => onUpdate(mask.id, { expansion: Number(event.target.value) / 100 })} /><b>{Math.round(mask.expansion * 100)}%</b></label>
    <label className="mask-slider">邊緣對比<input type="range" min="0" max="100" value={Math.round(mask.refine.contrast * 100)} onChange={(event) => onUpdate(mask.id, { refine: { ...mask.refine, contrast: Number(event.target.value) / 100 } })} /><b>{Math.round(mask.refine.contrast * 100)}%</b></label>
    <label className="mask-wide">跟隨追蹤<select value={mask.trackId ?? ""} onChange={(event) => onBindTrack(mask.id, event.target.value || undefined)}><option value="">不綁定 · 手動路徑</option>{tracks.map((item) => <option key={item.id} value={item.id}>{item.name} · {Math.round((1 - item.lostRatio) * 100)}%</option>)}</select></label>
    <div className="mask-actions"><button type="button" onClick={() => onKeyframe(mask.id)}>＋ 修正此格</button><button type="button" onClick={() => onFreeze(mask.id)} className={mask.frozenRange ? "active" : ""}>{mask.frozenRange ? "✓ 已凍結" : "凍結分析"}</button></div>
    {mask.kind === "subject" && mask.matteSequence && <RotoBrushEditor mask={mask} clip={clip} playhead={playhead} projectFps={projectFps} onUpdate={onUpdate} />}
    {mask.kind === "subject" && <button type="button" className="mask-track-action" disabled={autoRotoBusy || !autoRotoRuntimeStatus.canInvoke} onClick={() => onAutoRoto(mask.id)}>{autoRotoBusy ? "正在產生逐像素 Matte…" : !autoRotoRuntimeStatus.canInvoke ? "目前 Runtime 不可用" : mask.matteSequence ? "重新分析 Auto Roto" : "✦ 產生逐像素 Auto Roto"}</button>}
    {track?.lostRatio && track.lostRatio > .35 ? <p className="mask-warning">失追比例過高；失追影格會隱藏遮罩，不會猜測主體位置。請在錯誤影格按「修正此格」。</p> : null}
  </article>;
}

export default function MaskStudio({ playhead, projectFps, clip, motionTracks, trackingBusy, trackingSelectionActive, onAdd, onUpdate, onDelete, onBindTrack, onKeyframe, onFreeze, onAutoRoto, onQuickAutoRoto, onChromaKeyChange, autoRotoBusy, autoRotoRuntimeStatus, onBeginMotionTrack }: MaskStudioProps) {
  const runtimeActive = autoRotoRuntimeStatus.state === "activated_current";
  return <div className="mask-studio" data-testid="mask-studio">
    <div className="tool-surface-heading"><strong>動態去背與遮罩</strong><span>先一鍵去背，需要時再修邊緣</span></div>
    <section className="dynamic-removal-hero" aria-label="一鍵動態去背">
      <div><b>動態去背</b><span>{runtimeActive ? "目前 Runtime 已回傳執行 receipt；產生的 Alpha 仍是 diagnostic，需人工檢查。" : autoRotoRuntimeStatus.canInvoke ? "將呼叫目前桌面 Runtime；成功取得 hash receipt 後才標示已執行。" : "目前 Runtime 未提供 Auto Roto，這個入口已安全停用。"}</span></div>
      <button type="button" data-testid="quick-auto-roto" disabled={autoRotoBusy || !autoRotoRuntimeStatus.canInvoke} onClick={onQuickAutoRoto}>{autoRotoBusy ? "正在分析整段影片…" : !autoRotoRuntimeStatus.canInvoke ? "Runtime 不可用" : "✦ 一鍵開始"}</button>
      <small>{autoRotoRuntimeStatus.canInvoke ? "素材會留在本機；完成後可用「保留／移除」筆刷修正，品質仍需人工確認。" : "手動向量遮罩與動態追蹤仍可使用，不會假裝已完成逐像素去背。"}</small>
    </section>
    <ChromaKeyControl settings={clip.chromaKey} onChange={onChromaKeyChange} />
    <div className="mask-shape-grid">{MASK_CHOICES.map((choice) => <button type="button" key={choice.kind} onClick={() => onAdd(choice.kind)} data-testid={`add-mask-${choice.kind}`}><b>{choice.icon}</b><span>{choice.name}</span></button>)}</div>
    <button type="button" className="mask-track-action" disabled={trackingBusy} onClick={onBeginMotionTrack}>{trackingBusy ? "正在分析追蹤…" : trackingSelectionActive ? "請在預覽框住主體" : "◎ 新增一組動態追蹤"}</button>
    <AutoRotoEngineControl status={autoRotoRuntimeStatus} />
    <p className="mask-truth">{runtimeActive ? "「動態追蹤」是向量框；本次 Auto Roto 已由目前 Runtime 回傳逐像素 matte 與光學 Alpha receipt，再用保留／移除筆刷修正。" : "「動態追蹤」是向量框；Auto Roto 只有在目前 Runtime 回傳有效執行 receipt 後，才會標示為已執行。"} 頭髮、透明物、動態模糊與完整遮擋仍待量測；實驗中的區域記憶候選不會冒充正式產品能力。</p>
    {(clip.masks ?? []).length === 0 ? <div className="mask-empty"><b>尚未建立遮罩</b><span>要讓遮罩跟著人物移動先選「追蹤遮罩」；一般裁切可用矩形、橢圓或鋼筆。</span></div> : <div className="mask-list">{clip.masks!.map((mask) => <MaskCard key={mask.id} mask={mask} clip={clip} playhead={playhead} projectFps={projectFps} tracks={motionTracks} {...{ onUpdate, onDelete, onBindTrack, onKeyframe, onFreeze, onAutoRoto, autoRotoBusy, autoRotoRuntimeStatus }} />)}</div>}
  </div>;
}

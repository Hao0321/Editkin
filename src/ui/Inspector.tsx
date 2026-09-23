import { lazy, Suspense, useRef, useState } from "react";
import { useNativeWheelScroll } from "./wheelScroll";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";
import { LOOK_PRESETS, TEXT_STYLE_PRESETS, TRANSITION_PRESETS } from "../creative/corePack";
import { initializeWave2Registry, mediaFrameLayout } from "../creative/wave2Registry";
import { initializeStudioCreativeAssets, STUDIO_MOTION_ASSETS } from "../creative/studioAssets";
import type { PluginRegistrySummary } from "../desktop/types";
import type { CaptionCue, CaptionStyle, ChromaKeySettings, ClipCreativeState, ClipExpressionProperty, ClipLayout, ClipMask, ClipLayerState, ColorAdjustments, HaoExpressionSource, KeyframeEasing, MaskShapeKind, MediaAsset, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NativeEffectInstance, NormalizedRect, ParticleSimulationSettings, Scene25dSettings, TimelineClip, TimelineTrack, Transform2D, Transform3D } from "../domain/types";
import { formatTime } from "../lib/format";
import { createTransformMotionBlurInstance, isTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { LayerExpressionPanel } from "./LayerExpressionPanel";
import { CaptionPresetGallery, CreativePresetGallery } from "./PresetPreviewGallery";
import { Scene25dLightControls } from "./Scene25dLightControls";
import type { AutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import "./inspectorDiscovery.css";
import "./captionEditor.css";
import "./creatorToolSurface.css";
import "./displayType.css";

const MotionStudio = lazy(() => import("./MotionStudio"));
const MaskStudio = lazy(() => import("./MaskStudio"));

const PIP_PRESETS: Array<{ name: string; layout: ClipLayout }> = [
  { name: "右上角", layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0.66, y: 0.06, width: 0.29, height: 0.29 } } },
  { name: "左上角", layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0.05, y: 0.06, width: 0.29, height: 0.29 } } },
  { name: "右下角", layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0.66, y: 0.65, width: 0.29, height: 0.29 } } },
  { name: "左右分割", layout: { crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0.51, y: 0, width: 0.49, height: 1 } } },
];

type ClipTool = "adjust" | "text" | "look" | "effect" | "transition" | "mask" | "pip";

export const CLIP_TOOL_ITEMS = [
  ["adjust", "◐", "調整"], ["text", "T", "文字"], ["look", "◒", "濾鏡"], ["effect", "✦", "特效"],
  ["transition", "⇄", "轉場剪法"], ["mask", "◒", "遮罩"], ["pip", "▣", "畫中畫"],
] as const satisfies ReadonlyArray<readonly [ClipTool, string, string]>;
export const CLIP_TOOLS_DEFAULT_OPEN = false;

interface InspectorProps {
  projectFps: number;
  playhead: number;
  clip?: TimelineClip;
  asset?: MediaAsset;
  previewSource?: string;
  caption?: CaptionCue;
  captionStyle: CaptionStyle;
  tracks: TimelineTrack[];
  canTransitionIn: boolean;
  canTransitionOut: boolean;
  onMove: (time: number) => void;
  onTrackChange: (trackId: string) => void;
  onVolumeChange: (volume: number) => void;
  onTrimStart: () => void;
  onTrimEnd: () => void;
  onTransformChange: (patch: Partial<Transform2D>) => void;
  scene25d?: Scene25dSettings;
  onScene25dToggle: (enabled: boolean) => void;
  onScene25dChange: (settings: Scene25dSettings) => void;
  onTransform3dChange: (patch: Partial<Transform3D>) => void;
  particleSimulation?: ParticleSimulationSettings;
  onParticleSimulationToggle: (enabled: boolean) => void;
  onParticleSimulationChange: (settings: ParticleSimulationSettings) => void;
  onLayerChange: (patch: Partial<ClipLayerState>) => void;
  onExpressionChange: (property: ClipExpressionProperty, expression: HaoExpressionSource | null) => void;
  onMediaFrameApply: (layout: ClipLayout, name: string) => void;
  onColorChange: (patch: Partial<ColorAdjustments>) => void;
  onCreativeChange: (patch: { lookPresetId?: string | null; effectPresetIds?: string[]; transitionIn?: ClipCreativeState["transitionIn"] | null; transitionOut?: ClipCreativeState["transitionOut"] | null }) => void;
  onNativeEffectAdd: (instance: NativeEffectInstance) => void;
  onNativeEffectUpdate: (instanceId: string, patch: Partial<Pick<NativeEffectInstance, "enabled" | "parameters">>) => void;
  onNativeEffectReorder: (instanceId: string, toIndex: number) => void;
  onNativeEffectRemove: (instanceId: string) => void;
  onAddKeyframe: () => void;
  onKeyframeEasingChange: (keyframeId: string, easing: KeyframeEasing) => void;
  onDeleteKeyframe: (keyframeId: string) => void;
  motionTracks: MotionTrack[];
  trackingBusy: boolean;
  trackingSelectionActive: boolean;
  trackingSelection?: NormalizedRect;
  onBeginMotionTrack: () => void;
  onCorrectMotionTrack: (trackId: string) => void;
  onDeleteMotionTrack: (trackId: string) => void;
  onAddMotionGraphic: (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed) => void;
  motionGraphics: MotionGraphic[];
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => void;
  onDeleteMotionGraphic: (graphicId: string) => void;
  onCaptionChange: (patch: Partial<Pick<CaptionCue, "text" | "start" | "duration">> & { translation?: CaptionCue["translation"] | null }) => void;
  onCaptionStyleChange: (presetId: string) => void;
  onCaptionStylePatch: (patch: Partial<CaptionStyle>) => void;
  onOpenColorWorkspace: () => void;
  onAddCaption: () => void;
  onMakePictureInPicture: (layout?: ClipLayout, name?: string) => void;
  onAddMask: (kind: MaskShapeKind) => void;
  onUpdateMask: (maskId: string, patch: Partial<Omit<ClipMask, "id">>) => void;
  onDeleteMask: (maskId: string) => void;
  onBindMaskTrack: (maskId: string, trackId?: string) => void;
  onSetMaskKeyframe: (maskId: string) => void;
  onFreezeMask: (maskId: string) => void;
  onAutoRotoMask: (maskId: string) => void;
  onQuickAutoRoto: () => void;
  onChromaKeyChange: (settings?: ChromaKeySettings) => void;
  autoRotoBusy: boolean;
  autoRotoRuntimeStatus: AutoRotoRuntimeStatus;
  pluginRegistry?: PluginRegistrySummary;
}

export function Inspector({ playhead, projectFps, clip, asset, previewSource, caption, captionStyle, tracks, canTransitionIn, canTransitionOut, onMove, onTrackChange, onVolumeChange, onTrimStart, onTrimEnd, onTransformChange, scene25d, onScene25dToggle, onScene25dChange, onTransform3dChange, particleSimulation, onParticleSimulationToggle, onParticleSimulationChange, onLayerChange, onExpressionChange, onMediaFrameApply, onColorChange, onCreativeChange, onNativeEffectAdd, onNativeEffectUpdate, onNativeEffectReorder, onNativeEffectRemove, onAddKeyframe, onKeyframeEasingChange, onDeleteKeyframe, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, motionGraphics, onUpdateMotionGraphic, onDeleteMotionGraphic, onCaptionChange, onCaptionStyleChange, onCaptionStylePatch, onOpenColorWorkspace, onAddCaption, onMakePictureInPicture, onAddMask, onUpdateMask, onDeleteMask, onBindMaskTrack, onSetMaskKeyframe, onFreezeMask, onAutoRotoMask, onQuickAutoRoto, onChromaKeyChange, autoRotoBusy, autoRotoRuntimeStatus, pluginRegistry }: InspectorProps) {
  initializeStudioCreativeAssets();
  const wave2 = initializeWave2Registry();
  const [motionStudioOpened, setMotionStudioOpened] = useState(false);
  const [clipToolsOpened, setClipToolsOpened] = useState(false);
  const [quickToolsOpened, setQuickToolsOpened] = useState(CLIP_TOOLS_DEFAULT_OPEN);
  const [engineToolsOpened, setEngineToolsOpened] = useState(Boolean(scene25d?.enabled || particleSimulation?.enabled));
  const [clipTool, setClipTool] = useState<ClipTool>("adjust");
  const [captionToolsOpened, setCaptionToolsOpened] = useState(false);
  const creatorTabs = useRef<HTMLElement>(null);
  useNativeWheelScroll(creatorTabs, "horizontal", caption ? "caption" : clip?.id);
  return (
    <aside className="panel inspector" aria-label="檢查器">
      <div className="panel-title inspector-title">
        <div>
          <span className="eyebrow">目前選取</span>
          <h2>{caption ? "調整字幕" : "調整片段"}</h2>
        </div>
        <span className="live-pill">即時預覽</span>
      </div>
      {caption ? (
        <div className="inspector-body" data-testid="caption-inspector">
          <div className="selected-card">
            <div className="selected-icon">T</div>
            <div><strong>{caption.text}</strong><span>字幕 · {formatTime(caption.duration)}</span></div>
          </div>
          <label className="field-label">第一行 · 原文
            <textarea value={caption.text} onChange={(event) => onCaptionChange({ text: event.target.value })} data-testid="caption-text-input" />
          </label>
          {caption.translation ? <div className="caption-translation-editor" data-testid="caption-translation-editor">
            <label className="field-label">第二行 · {caption.translation.language === "en" ? "英文翻譯" : caption.translation.language}
              <textarea value={caption.translation.text} onChange={(event) => onCaptionChange({ translation: { ...caption.translation!, text: event.target.value } })} data-testid="caption-translation-input" />
            </label>
            <button type="button" onClick={() => onCaptionChange({ translation: null })}>改回單語字幕</button>
          </div> : <p className="caption-bilingual-hint">需要雙語？在「更多一鍵功能 → 字幕類型」選擇「原文＋英文雙語」。</p>}
          <button type="button" className="preview-center-entry caption" onClick={() => setCaptionToolsOpened(true)} data-testid="caption-preview-entry"><span aria-hidden="true"><i>字</i><i>Aa</i><i>黑底</i></span><b><strong>打開字幕樣式預覽</strong><small>字型、顏色、描邊、半透明黑底都能直接看</small></b><em>查看 →</em></button>
          <details className="inspector-section" data-testid="caption-advanced" open={captionToolsOpened}>
            <summary onClick={(event) => { event.preventDefault(); setCaptionToolsOpened((opened) => !opened); }}>更多字幕設定 <small>風格、字型、時間</small></summary>
            <div className="inspector-advanced-body">
              <label className="field-label">文字風格
                <select className="visually-hidden" value={captionStyle.presetId} onChange={(event) => onCaptionStyleChange(event.target.value)} data-testid="text-style-select">
                  {TEXT_STYLE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
                <CaptionPresetGallery selected={captionStyle.presetId} onSelect={onCaptionStyleChange} />
              </label>
              <label className="field-label">內建開源字型
                <select value={captionStyle.fontFamily} onChange={(event) => onCaptionStylePatch({ fontFamily: event.target.value })} data-testid="font-family-select"><option value="Noto Sans TC">Noto Sans TC · 繁中主字型</option><option value="Noto Serif TC">Noto Serif TC · 雜誌襯線</option><option value="LXGW WenKai Mono TC">霞鶩文楷 Mono TC</option><option value="Bebas Neue">Bebas Neue · 英文標題</option><option value="Fredoka">Fredoka · 活潑字卡</option></select>
              </label>
              <div className="caption-emphasis-row"><label><input type="checkbox" checked={captionStyle.bold} onChange={(event) => onCaptionStylePatch({ bold: event.target.checked })} /> 粗體</label><label><input type="checkbox" checked={captionStyle.italic} onChange={(event) => onCaptionStylePatch({ italic: event.target.checked })} /> 斜體</label></div>
              <div className="field-label">字幕顏色與底色
                <div className="caption-color-grid"><label>文字色 <input type="color" value={captionStyle.color.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ color: event.target.value.toUpperCase() })} /></label><label>描邊色 <input type="color" value={captionStyle.outlineColor.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ outlineColor: event.target.value.toUpperCase() })} /></label><label>底色 <input type="color" value={captionStyle.backgroundColor.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ backgroundColor: `${event.target.value.toUpperCase()}${captionStyle.backgroundColor.slice(7, 9) || "99"}` })} /></label><label>字級 <input type="number" min="18" max="160" value={captionStyle.fontSize} onChange={(event) => onCaptionStylePatch({ fontSize: Number(event.target.value) })} /></label></div>
                <div className="caption-background-presets" aria-label="字幕半透明背景"><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#00000000" })}>無底色</button><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#00000066" })}>黑底 40%</button><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#000000A6" })}>黑底 65%</button><button type="button" onClick={() => onCaptionStylePatch({ backgroundColor: "#000000CC" })}>黑底 80%</button></div>
                <label className="caption-opacity">底色透明度 <input type="range" min="0" max="100" value={Math.round((parseInt(captionStyle.backgroundColor.slice(7, 9) || "00", 16) / 255) * 100)} onChange={(event) => onCaptionStylePatch({ backgroundColor: `${captionStyle.backgroundColor.slice(0, 7)}${Math.round(Number(event.target.value) * 2.55).toString(16).padStart(2, "0").toUpperCase()}` })} /><span>{Math.round((parseInt(captionStyle.backgroundColor.slice(7, 9) || "00", 16) / 255) * 100)}%</span></label>
              </div>
              {caption.translation && <div className="caption-translation-style" data-testid="caption-translation-style">
                <strong>第二行翻譯樣式</strong>
                <label className="field-label">翻譯字型
                  <select value={captionStyle.translationFontFamily} onChange={(event) => onCaptionStylePatch({ translationFontFamily: event.target.value })} data-testid="translation-font-family-select"><option value="Noto Sans TC">Noto Sans TC · 清楚易讀</option><option value="Noto Serif TC">Noto Serif TC · 雜誌襯線</option><option value="LXGW WenKai Mono TC">霞鶩文楷 Mono TC</option><option value="Bebas Neue">Bebas Neue · 英文標題</option><option value="Fredoka">Fredoka · 活潑圓體</option></select>
                </label>
                <div className="caption-color-grid"><label>翻譯色 <input type="color" value={captionStyle.translationColor.slice(0, 7)} onChange={(event) => onCaptionStylePatch({ translationColor: event.target.value.toUpperCase() })} /></label><label>翻譯字級 <input type="number" min="14" max="140" value={captionStyle.translationFontSize} onChange={(event) => onCaptionStylePatch({ translationFontSize: Number(event.target.value) })} /></label></div>
                <div className="caption-emphasis-row"><label><input type="checkbox" checked={captionStyle.translationBold} onChange={(event) => onCaptionStylePatch({ translationBold: event.target.checked })} /> 翻譯粗體</label><label><input type="checkbox" checked={captionStyle.translationItalic} onChange={(event) => onCaptionStylePatch({ translationItalic: event.target.checked })} /> 翻譯斜體</label></div>
              </div>}
              <label className="field-label">從第幾秒出現
                <div className="number-field"><input type="number" min="0" step="0.1" value={caption.start} onChange={(event) => onCaptionChange({ start: Number(event.target.value) })} /><span>sec</span></div>
              </label>
              <label className="field-label">顯示多久
                <div className="number-field"><input type="number" min="0.1" step="0.1" value={caption.duration} onChange={(event) => onCaptionChange({ duration: Number(event.target.value) })} /><span>sec</span></div>
              </label>
              <div className="metric-grid"><div><span>結束時間</span><strong>{formatTime(caption.start + caption.duration)}</strong></div><div><span>輸出方式</span><strong>直接燒錄</strong></div></div>
            </div>
          </details>
        </div>
      ) : clip && asset ? (
        <div className="inspector-body">
          <div className="selected-card">
            <div className="selected-icon">▶</div>
            <div><strong>{asset.name}</strong><span>影片片段 · {formatTime(clip.duration)}</span></div>
          </div>
          <details className="inspector-section professional-engine-tools" data-testid="professional-engine-tools" open={engineToolsOpened} onToggle={(event) => setEngineToolsOpened(event.currentTarget.open)}>
            <summary>進階特效 <small>2.5D 場景、景深與粒子模擬</small></summary>
            <div className="professional-engine-tools-body">
          <details className="inspector-section scene-25d-controls" data-testid="scene-25d-controls" open={Boolean(scene25d?.enabled)}>
            <summary>立體畫面 <small>{scene25d?.enabled ? "即時預覽已啟用" : "讓照片與影片產生前後景深度"}</small></summary>
            {!scene25d?.enabled ? <>
              <p className="scene-25d-note">把 1–8 個照片或影片放進同一個透視空間，可調深度、XYZ 旋轉、父子圖層、相機與方向光。影片會沿用原生 GPU 解碼，不必先轉成圖片。</p>
              <button type="button" className="primary-tool-action" disabled={!['image', 'video'].includes(asset.kind)} onClick={() => onScene25dToggle(true)} data-testid="enable-scene-25d">啟用 2.5D 場景</button>
              {!['image', 'video'].includes(asset.kind) && <small>2.5D 場景需要照片、透明 PNG 或影片素材。</small>}
            </> : <>
              <div className="tool-surface-heading"><strong>目前平面</strong><span>位置單位為場景 world unit</span></div>
              <div className="transform-grid">
                {(["X", "Y", "Z"] as const).map((axis, index) => <label key={`position-${axis}`}>位置 {axis}<input type="number" step="0.05" value={clip.transform3d?.position[index] ?? 0} onChange={(event) => onTransform3dChange({ position: (clip.transform3d?.position ?? [0, 0, 0]).map((value, item) => item === index ? Number(event.target.value) : value) as [number, number, number] })} /></label>)}
                {(["X", "Y", "Z"] as const).map((axis, index) => <label key={`rotation-${axis}`}>旋轉 {axis}<input type="number" step="1" value={clip.transform3d?.rotationDegrees[index] ?? 0} onChange={(event) => onTransform3dChange({ rotationDegrees: (clip.transform3d?.rotationDegrees ?? [0, 0, 0]).map((value, item) => item === index ? Number(event.target.value) : value) as [number, number, number] })} /></label>)}
                {(["X", "Y", "Z"] as const).map((axis, index) => <label key={`scale-${axis}`}>縮放 {axis}<input type="number" min="0.01" step="0.05" value={clip.transform3d?.scale[index] ?? 1} onChange={(event) => onTransform3dChange({ scale: (clip.transform3d?.scale ?? [1, 1, 1]).map((value, item) => item === index ? Number(event.target.value) : value) as [number, number, number] })} /></label>)}
              </div>
              <div className="tool-surface-heading"><strong>場景</strong><span>所有平面共用同一台相機與燈光</span></div>
              <div className="transform-grid">
                <label>相機 Z<input type="number" step="0.1" value={scene25d.camera.position[2]} onChange={(event) => onScene25dChange({ ...scene25d, camera: { ...scene25d.camera, position: [scene25d.camera.position[0], scene25d.camera.position[1], Number(event.target.value)] } })} /></label>
                <label>視角<input type="number" min="2" max="178" step="1" value={scene25d.camera.verticalFovDegrees} onChange={(event) => onScene25dChange({ ...scene25d, camera: { ...scene25d.camera, verticalFovDegrees: Number(event.target.value) } })} /></label>
              </div>
              <Scene25dLightControls scene={scene25d} playhead={playhead} onChange={onScene25dChange} />
              <div className="lens-keyframe-controls" data-testid="scene-25d-camera-keyframes">
                <button type="button" className="mini-action" disabled={playhead <= 0 || scene25d.camera.keyframes.length >= 16}
                  onClick={() => {
                    const keyframe = { id: `camera-${Math.round(playhead * 1000)}`, time: playhead, position: [...scene25d.camera.position] as [number, number, number],
                      target: [...scene25d.camera.target] as [number, number, number], verticalFovDegrees: scene25d.camera.verticalFovDegrees, easing: "ease_in_out" as const };
                    const existing = scene25d.camera.keyframes.findIndex((candidate) => Math.abs(candidate.time - playhead) < .0005);
                    const keyframes = existing >= 0
                      ? scene25d.camera.keyframes.map((candidate, index) => index === existing ? { ...keyframe, id: candidate.id } : candidate)
                      : [...scene25d.camera.keyframes, keyframe].sort((left, right) => left.time - right.time);
                    onScene25dChange({ ...scene25d, camera: { ...scene25d.camera, keyframes } });
                  }}>◆ 在 {playhead.toFixed(2)}s 記錄相機</button>
                {scene25d.camera.keyframes.map((keyframe) => <div className="lens-keyframe-row" key={keyframe.id}>
                  <span>{keyframe.time.toFixed(2)}s · Z {keyframe.position[2].toFixed(2)} · {keyframe.verticalFovDegrees.toFixed(0)}°</span>
                  <select aria-label={`${keyframe.time.toFixed(2)} 秒相機緩動`} value={keyframe.easing} onChange={(event) => onScene25dChange({ ...scene25d, camera: { ...scene25d.camera,
                    keyframes: scene25d.camera.keyframes.map((candidate) => candidate.id === keyframe.id ? { ...candidate, easing: event.target.value as KeyframeEasing } : candidate) } })}>
                    <option value="linear">線性</option><option value="hold">停格</option><option value="ease_in">慢進</option><option value="ease_out">慢出</option><option value="ease_in_out">平滑</option><option value="spring_soft">柔和彈性</option>
                  </select>
                  <button type="button" aria-label={`刪除 ${keyframe.time.toFixed(2)} 秒相機關鍵幀`} onClick={() => onScene25dChange({ ...scene25d, camera: { ...scene25d.camera,
                    keyframes: scene25d.camera.keyframes.filter((candidate) => candidate.id !== keyframe.id) } })}>×</button>
                </div>)}
              </div>
              <div className="tool-surface-heading"><strong>鏡頭景深</strong><span>直接取樣每個像素的真實深度</span></div>
              <div className="transform-grid">
                <label className="inspector-toggle-row"><span>啟用景深</span><input type="checkbox" checked={scene25d.depthOfField.enabled} onChange={(event) => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField, enabled: event.target.checked } })} data-testid="scene-25d-depth-of-field" /></label>
                <label>對焦距離<input type="number" min={scene25d.camera.near + .01} max={scene25d.camera.far - .01} step="0.05" value={scene25d.depthOfField.focusDistance} onChange={(event) => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField, focusDistance: Number(event.target.value) } })} /></label>
                <label>散景強度<input type="number" min="0.1" max="16" step="0.1" value={scene25d.depthOfField.aperture} onChange={(event) => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField, aperture: Number(event.target.value) } })} /></label>
                <label>最大半徑<input type="number" min="1" max="32" step="1" value={scene25d.depthOfField.maxBlurRadius} onChange={(event) => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField, maxBlurRadius: Number(event.target.value) } })} /></label>
              </div>
              <div className="lens-keyframe-controls" data-testid="scene-25d-lens-keyframes">
                <button type="button" className="mini-action" disabled={!scene25d.depthOfField.enabled || playhead <= 0 || scene25d.depthOfField.keyframes.length >= 16}
                  onClick={() => {
                    const keyframe = { id: `lens-${Math.round(playhead * 1000)}`, time: playhead, focusDistance: scene25d.depthOfField.focusDistance,
                      aperture: scene25d.depthOfField.aperture, maxBlurRadius: scene25d.depthOfField.maxBlurRadius, easing: "ease_in_out" as const };
                    const existing = scene25d.depthOfField.keyframes.findIndex((candidate) => Math.abs(candidate.time - playhead) < .0005);
                    const keyframes = existing >= 0
                      ? scene25d.depthOfField.keyframes.map((candidate, index) => index === existing ? { ...keyframe, id: candidate.id } : candidate)
                      : [...scene25d.depthOfField.keyframes, keyframe].sort((left, right) => left.time - right.time);
                    onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField, keyframes } });
                  }}>◆ 在 {playhead.toFixed(2)}s 記錄鏡頭</button>
                {scene25d.depthOfField.keyframes.map((keyframe) => <div className="lens-keyframe-row" key={keyframe.id}>
                  <span>{keyframe.time.toFixed(2)}s · 焦點 {keyframe.focusDistance.toFixed(2)}</span>
                  <select aria-label={`${keyframe.time.toFixed(2)} 秒鏡頭緩動`} value={keyframe.easing} onChange={(event) => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField,
                    keyframes: scene25d.depthOfField.keyframes.map((candidate) => candidate.id === keyframe.id ? { ...candidate, easing: event.target.value as KeyframeEasing } : candidate) } })}>
                    <option value="linear">線性</option><option value="hold">停格</option><option value="ease_in">慢進</option><option value="ease_out">慢出</option><option value="ease_in_out">平滑</option><option value="spring_soft">柔和彈性</option>
                  </select>
                  <button type="button" aria-label={`刪除 ${keyframe.time.toFixed(2)} 秒鏡頭關鍵幀`} onClick={() => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField,
                    keyframes: scene25d.depthOfField.keyframes.filter((candidate) => candidate.id !== keyframe.id) } })}>×</button>
                </div>)}
              </div>
              <p className="scene-25d-note">不透明影片平面會走 Depth32Float 遮擋與原生 GPU 景深；相機、燈光與鏡頭關鍵幀都依專案時間逐格取樣。照片相容路徑仍限制非相交平面，Point／Spot Light 與混合模式會直接阻擋。</p>
              <button type="button" className="mini-action" onClick={() => onScene25dToggle(false)} data-testid="disable-scene-25d">退出 2.5D 場景</button>
            </>}
          </details>
          <details className="inspector-section scene-25d-controls" data-testid="particle-vfx-controls" open={Boolean(particleSimulation?.enabled)}>
            <summary>粒子特效 <small>{particleSimulation?.enabled ? "即時預覽已啟用" : "火花、漂浮粒子、能量點"}</small></summary>
            {!particleSimulation?.enabled ? <>
              <p className="scene-25d-note">加入可重播的即時粒子層；預覽與輸出共用同一個 fixed-seed GPU 模擬。</p>
              <button type="button" className="primary-tool-action" disabled={Boolean(scene25d?.enabled)} onClick={() => onParticleSimulationToggle(true)} data-testid="enable-particle-vfx">加入粒子特效</button>
              {scene25d?.enabled && <small>目前的螢幕空間粒子 v1 與 2.5D 場景分開執行，請先退出 2.5D。</small>}
            </> : <>
              <div className="tool-surface-heading"><strong>粒子外觀與動作</strong><span>所有數值可即時預覽</span></div>
              <div className="transform-grid">
                <label className="inspector-toggle-row"><span>限制作用區間</span><input type="checkbox" checked={Boolean(particleSimulation.timeline)} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, timeline: event.target.checked ? { start: Math.max(0, playhead), duration: Math.max(0.1, particleSimulation.lifetimeSeconds) } : undefined })} /></label>
                {particleSimulation.timeline ? <>
                  <label>開始秒數<input type="number" min="0" step="0.01" value={particleSimulation.timeline.start} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, timeline: { ...particleSimulation.timeline!, start: Number(event.target.value) } })} /></label>
                  <label>作用秒數<input type="number" min="0.034" step="0.01" value={particleSimulation.timeline.duration} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, timeline: { ...particleSimulation.timeline!, duration: Number(event.target.value) } })} /></label>
                </> : null}
                <label>每秒數量<input type="number" min="1" max="240" step="1" value={particleSimulation.ratePerSecond} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, ratePerSecond: Number(event.target.value) })} /></label>
                <label>存在秒數<input type="number" min="0.1" max="10" step="0.05" value={particleSimulation.lifetimeSeconds} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, lifetimeSeconds: Number(event.target.value) })} /></label>
                <label>粒子上限<input type="number" min="1" max="64" step="1" value={particleSimulation.maxParticles} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, maxParticles: Number(event.target.value) })} /></label>
                <label>粒子大小<input type="number" min="0.5" max="64" step="0.25" value={particleSimulation.radiusPixels} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, radiusPixels: Number(event.target.value) })} /></label>
                <label>起點 X<input type="number" min="0" max="1" step="0.01" value={particleSimulation.emitterPosition[0]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, emitterPosition: [Number(event.target.value), particleSimulation.emitterPosition[1]] })} /></label>
                <label>起點 Y<input type="number" min="0" max="1" step="0.01" value={particleSimulation.emitterPosition[1]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, emitterPosition: [particleSimulation.emitterPosition[0], Number(event.target.value)] })} /></label>
                <label>水平速度<input type="number" step="1" value={particleSimulation.initialVelocity[0]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, initialVelocity: [Number(event.target.value), particleSimulation.initialVelocity[1]] })} /></label>
                <label>垂直速度<input type="number" step="1" value={particleSimulation.initialVelocity[1]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, initialVelocity: [particleSimulation.initialVelocity[0], Number(event.target.value)] })} /></label>
                <label>重力<input type="number" step="1" value={particleSimulation.gravity[1]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, gravity: [particleSimulation.gravity[0], Number(event.target.value)] })} /></label>
                <label>Seed<input type="number" min="0" max="4294967295" step="1" value={particleSimulation.seed} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, seed: Number(event.target.value) })} /></label>
              </div>
              {(() => {
                const additional = particleSimulation.additionalEmitters ?? [];
                const totalParticles = particleSimulation.maxParticles + additional.reduce((sum, emitter) => sum + emitter.maxParticles, 0);
                const remainingParticles = 192 - totalParticles;
                const addEmitter = () => {
                  const ids = new Set(additional.map((emitter) => emitter.id));
                  let number = 2;
                  while (ids.has(`emitter-${number}`)) number += 1;
                  const palette = [
                    [0.1, 0.65, 1, 0.85], [0.76, 0.28, 1, 0.86], [1, 0.86, 0.35, 0.88],
                  ] as const;
                  onParticleSimulationChange({
                    ...particleSimulation,
                    additionalEmitters: [...additional, {
                      id: `emitter-${number}`,
                      timeline: { start: Math.max(0, playhead), duration: Math.max(0.1, Math.min(1.2, particleSimulation.lifetimeSeconds)) },
                      seed: (particleSimulation.seed + number * 7919) >>> 0,
                      ratePerSecond: Math.min(48, particleSimulation.ratePerSecond),
                      lifetimeSeconds: Math.min(1.25, particleSimulation.lifetimeSeconds),
                      maxParticles: Math.min(48, remainingParticles),
                      emitterPosition: [number % 2 ? 0.35 : 0.65, 0.68],
                      initialVelocity: [number % 2 ? -18 : 18, -64], gravity: [0, 78],
                      radiusPixels: Math.min(4, particleSimulation.radiusPixels),
                      color: [...palette[(number - 2) % palette.length]],
                    }],
                  });
                };
                return <div className="particle-emitter-stack" data-testid="particle-emitter-stack">
                  <div className="tool-surface-heading"><strong>發射器 {1 + additional.length} / 4</strong><span>總粒子預算 {totalParticles} / 192</span></div>
                  {additional.map((emitter, index) => {
                    const updateEmitter = (patch: Partial<typeof emitter>) => onParticleSimulationChange({
                      ...particleSimulation,
                      additionalEmitters: additional.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...patch } : candidate),
                    });
                    const colorValue = JSON.stringify(emitter.color);
                    return <details key={emitter.id} className="inspector-subsection" data-testid={`particle-emitter-${index + 2}`}>
                      <summary>發射器 {index + 2} <small>{emitter.timeline ? `${emitter.timeline.start.toFixed(2)}s · ${emitter.timeline.duration.toFixed(2)}s` : "全片"}</small></summary>
                      <div className="transform-grid">
                        <label>開始<input type="number" min="0" step="0.01" value={emitter.timeline?.start ?? 0} onChange={(event) => updateEmitter({ timeline: { start: Number(event.target.value), duration: emitter.timeline?.duration ?? 1.2 } })} /></label>
                        <label>作用秒數<input type="number" min="0.034" step="0.01" value={emitter.timeline?.duration ?? 1.2} onChange={(event) => updateEmitter({ timeline: { start: emitter.timeline?.start ?? 0, duration: Number(event.target.value) } })} /></label>
                        <label>每秒數量<input type="number" min="1" max="240" step="1" value={emitter.ratePerSecond} onChange={(event) => updateEmitter({ ratePerSecond: Number(event.target.value) })} /></label>
                        <label>粒子上限<input type="number" min="1" max={emitter.maxParticles + remainingParticles} step="1" value={emitter.maxParticles} onChange={(event) => updateEmitter({ maxParticles: Number(event.target.value) })} /></label>
                        <label>起點 X<input type="number" min="0" max="1" step="0.01" value={emitter.emitterPosition[0]} onChange={(event) => updateEmitter({ emitterPosition: [Number(event.target.value), emitter.emitterPosition[1]] })} /></label>
                        <label>起點 Y<input type="number" min="0" max="1" step="0.01" value={emitter.emitterPosition[1]} onChange={(event) => updateEmitter({ emitterPosition: [emitter.emitterPosition[0], Number(event.target.value)] })} /></label>
                        <label>水平速度<input type="number" step="1" value={emitter.initialVelocity[0]} onChange={(event) => updateEmitter({ initialVelocity: [Number(event.target.value), emitter.initialVelocity[1]] })} /></label>
                        <label>垂直速度<input type="number" step="1" value={emitter.initialVelocity[1]} onChange={(event) => updateEmitter({ initialVelocity: [emitter.initialVelocity[0], Number(event.target.value)] })} /></label>
                        <label>顏色<select value={colorValue} onChange={(event) => updateEmitter({ color: JSON.parse(event.target.value) as typeof emitter.color })}>
                          <option value="[0.1,0.65,1,0.85]">冰藍</option><option value="[0.76,0.28,1,0.86]">霓虹紫</option><option value="[1,0.86,0.35,0.88]">金色</option><option value="[1,0.42,0.06,0.92]">暖橘</option>
                        </select></label>
                        <label>Seed<input type="number" min="0" max="4294967295" step="1" value={emitter.seed} onChange={(event) => updateEmitter({ seed: Number(event.target.value) })} /></label>
                      </div>
                      <button type="button" className="mini-action" onClick={() => onParticleSimulationChange({ ...particleSimulation, additionalEmitters: additional.filter((_, candidateIndex) => candidateIndex !== index) })}>移除此發射器</button>
                    </details>;
                  })}
                  <button type="button" className="mini-action" disabled={additional.length >= 3 || remainingParticles < 1} onClick={addEmitter} data-testid="add-particle-emitter">＋ 新增發射器</button>
                </div>;
              })()}
              <p className="scene-25d-note">最多 4 個、合計 192 顆的 2D 螢幕空間 executor；每個發射器有自己的時間、seed 與外觀。3D 碰撞、流體與景深互動仍會明確阻擋。</p>
              <button type="button" className="mini-action" onClick={() => onParticleSimulationToggle(false)} data-testid="disable-particle-vfx">移除粒子特效</button>
            </>}
          </details>
            </div>
          </details>
          <details className="inspector-section clip-quick-tools" data-testid="clip-quick-tools" open={quickToolsOpened} onToggle={(event) => setQuickToolsOpened(event.currentTarget.open)}>
            <summary>片段工具 <small>先選一項，再直接看預覽</small></summary>
            <div className="clip-quick-tools-body">
          <nav ref={creatorTabs} className="creator-tool-tabs" aria-label="片段工具" tabIndex={0}>
            {CLIP_TOOL_ITEMS.map(([id, icon, label]) => <button key={id} type="button" className={clipTool === id ? "active" : ""} aria-pressed={clipTool === id} data-testid={id === "look" ? "effect-preview-entry" : undefined} onClick={() => setClipTool(id)}><b>{icon}</b><span>{label}</span></button>)}
          </nav>
          <section className="creator-tool-surface" data-tool={clipTool}>
            {clipTool === "adjust" && <>
              <div className="tool-surface-heading"><strong>快速調整</strong><span>先處理最常用的操作</span></div>
              <span className="quick-adjust-label">播放到想保留的位置，再按下面其中一個</span>
              <div className="clip-trim-actions"><button type="button" onClick={onTrimStart} data-testid="trim-start-button">保留後面</button><button type="button" onClick={onTrimEnd} data-testid="trim-end-button">保留前面</button></div>
              <label className="large-slider">音量 <input type="range" min="0" max="200" step="5" value={Math.round(clip.volume * 100)} onChange={(event) => onVolumeChange(Number(event.target.value) / 100)} /><b>{Math.round(clip.volume * 100)}%</b></label>
              {asset.kind !== "audio" && <button type="button" className="primary-tool-action" onClick={onOpenColorWorkspace}>◒ 打開調色工作區</button>}
            </>}
            {clipTool === "text" && <>
              <div className="tool-surface-heading"><strong>文字與動態字卡</strong><span>新增後仍能逐項修改</span></div>
              <div className="text-tool-grid"><button type="button" onClick={onAddCaption}><b>字幕</b><span>一般逐句文字</span></button><button type="button" onClick={() => onAddMotionGraphic("title")}><b>主標題</b><span>首秒 Hook</span></button><button type="button" onClick={() => onAddMotionGraphic("card")}><b>重點卡</b><span>資訊整理</span></button><button type="button" onClick={() => onAddMotionGraphic("tag")}><b>標籤</b><span>人物／產品</span></button><button type="button" onClick={() => onAddMotionGraphic("counter")}><b>數字</b><span>排行／步驟</span></button></div>
              <div className="display-type-heading"><strong>花字試裝</strong><span>8 款原創可編輯字卡 · 字型已內建</span></div>
              <div className="display-type-grid" data-testid="display-type-library">{STUDIO_MOTION_ASSETS.map((preset) => { const face = resolveBundledFontFace(preset.seed.fontFamily ?? "Noto Sans TC", preset.seed.fontWeight ?? 700); return <button type="button" key={preset.id} className={`display-type-card ${preset.previewClass}`} title={`${preset.license} · ${preset.provenance}${face?.weightSubstituted ? ` · 字重 ${face.requestedWeight} → ${face.fontWeight}` : ""}`} onClick={() => onAddMotionGraphic("title", undefined, preset.seed)}><i data-font-weight-substituted={face?.weightSubstituted} style={{ fontFamily: cssFontFamily(face?.fontFamily ?? preset.seed.fontFamily), fontWeight: face?.fontWeight ?? preset.seed.fontWeight, fontSynthesis: "style", color: preset.seed.textColor, background: preset.seed.backgroundColor, borderColor: preset.seed.accentColor }}>Aa</i><span>{preset.name}</span></button>; })}</div>
              <details className="inline-motion-library"><summary>更多動態素材 <small>{wave2.motionPresets.length} 款</small></summary><div className="display-type-grid">{wave2.motionPresets.map((preset) => <button type="button" key={preset.id} className="display-type-card library" onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}><i style={{ color: preset.seed.textColor, background: preset.seed.backgroundColor, borderColor: preset.seed.accentColor }}>{preset.presetType === "widget" ? "01" : "Aa"}</i><span>{preset.name}</span></button>)}</div></details>
            </>}
            {clipTool === "look" && <CreativePresetGallery section="look" source={previewSource} creative={clip.creative} duration={clip.duration} canTransitionIn={canTransitionIn} canTransitionOut={canTransitionOut} onChange={onCreativeChange} />}
            {clipTool === "effect" && <>
              <div className="tool-surface-heading"><strong>原生動態模糊</strong><span>GPU shutter sampling · 2–8 samples</span></div>
              <button type="button" className="primary-tool-action" data-testid="add-transform-motion-blur"
                disabled={asset.kind !== "video" || !clip.keyframes.length || Boolean(clip.creative?.nativeEffectInstances?.some(isTransformMotionBlurInstance))}
                onClick={() => onNativeEffectAdd(createTransformMotionBlurInstance())}>
                {clip.creative?.nativeEffectInstances?.some(isTransformMotionBlurInstance) ? "已加入動態模糊" : asset.kind !== "video" ? "目前只支援影片片段" : clip.keyframes.length ? "加入原生動態模糊" : "先加入位置／縮放／旋轉關鍵幀"}
              </button>
              <CreativePresetGallery section="effect" source={previewSource} creative={clip.creative} duration={clip.duration} canTransitionIn={canTransitionIn} canTransitionOut={canTransitionOut} onChange={onCreativeChange} />
              {(clip.creative?.nativeEffectInstances?.length ?? 0) > 0 && <div className="native-effect-stack" data-testid="native-effect-stack">
                <div className="tool-surface-heading"><strong>外掛效果堆疊</strong><span>依序執行 · 可復原 · 正式輸出已接通</span></div>
                <small className="native-effect-preview-note">GPU 圖使用預覽與輸出共用的 shader executor；CPU 原生效果則快取同一隔離 worker 產生的預覽影格。</small>
                {clip.creative!.nativeEffectInstances!.map((instance, index, instances) => {
                  const transformMotionBlur = isTransformMotionBlurInstance(instance);
                  const capability = pluginRegistry?.plugins.find((plugin) => plugin.id === instance.pluginId)?.capabilities.find((candidate) => candidate.id === instance.capabilityId);
                  return <article className="native-effect-instance" key={instance.id}>
                    <header><label><input type="checkbox" checked={instance.enabled} onChange={(event) => onNativeEffectUpdate(instance.id, { enabled: event.target.checked })} /> 啟用</label><b><span>{index + 1}. {transformMotionBlur ? "動態模糊" : capability?.name ?? instance.pluginId}</span><small>{transformMotionBlur ? "原生 GPU" : instance.runtimeType === "gpu_effect_graph" ? "GPU 特效" : "CPU 原生特效"} · {instance.capabilityId} · v{instance.pluginVersion}</small></b><div className="native-effect-actions"><button type="button" aria-label="效果往前" disabled={index === 0} onClick={() => onNativeEffectReorder(instance.id, index - 1)}>↑</button><button type="button" aria-label="效果往後" disabled={index === instances.length - 1} onClick={() => onNativeEffectReorder(instance.id, index + 1)}>↓</button><button type="button" onClick={() => onNativeEffectRemove(instance.id)}>移除</button></div></header>
                    <div className="native-effect-parameters">{Object.entries(instance.parameters).map(([key, value]) => {
                      const definition = transformMotionBlur
                        ? key === "shutter_angle" ? { name: "快門角度", type: "number", min: 1, max: 360, step: 1 }
                          : key === "samples" ? { name: "取樣數", type: "number", min: 2, max: 8, step: 1 } : undefined
                        : capability?.parameters.find((parameter) => parameter.id === key);
                      return <label key={key}>{definition?.name ?? key}
                        {typeof value === "boolean"
                          ? <input type="checkbox" checked={value} onChange={(event) => onNativeEffectUpdate(instance.id, { parameters: { ...instance.parameters, [key]: event.target.checked } })} />
                          : typeof value === "number" && definition?.type === "number" && definition.min !== undefined && definition.max !== undefined
                            ? <span className="native-effect-range"><input type="range" min={definition.min} max={definition.max} step={definition.step ?? "any"} value={value} onChange={(event) => onNativeEffectUpdate(instance.id, { parameters: { ...instance.parameters, [key]: Number(event.target.value) } })} /><output>{value.toFixed(definition.step && definition.step < 1 ? 2 : 0)}</output></span>
                            : <input type={typeof value === "number" ? "number" : "text"} step={typeof value === "number" ? "0.01" : undefined} value={value} onChange={(event) => onNativeEffectUpdate(instance.id, { parameters: { ...instance.parameters, [key]: typeof value === "number" ? Number(event.target.value) : event.target.value } })} />}
                      </label>;
                    })}</div>
                  </article>;
                })}
              </div>}
            </>}
            {clipTool === "transition" && <CreativePresetGallery section="transition" source={previewSource} creative={clip.creative} duration={clip.duration} canTransitionIn={canTransitionIn} canTransitionOut={canTransitionOut} onChange={onCreativeChange} />}
            {clipTool === "mask" && <Suspense fallback={<small>正在載入遮罩工作區…</small>}><MaskStudio playhead={playhead} projectFps={projectFps} clip={clip} motionTracks={motionTracks} trackingBusy={trackingBusy} trackingSelectionActive={trackingSelectionActive} onAdd={onAddMask} onUpdate={onUpdateMask} onDelete={onDeleteMask} onBindTrack={onBindMaskTrack} onKeyframe={onSetMaskKeyframe} onFreeze={onFreezeMask} onAutoRoto={onAutoRotoMask} onQuickAutoRoto={onQuickAutoRoto} onChromaKeyChange={onChromaKeyChange} autoRotoBusy={autoRotoBusy} autoRotoRuntimeStatus={autoRotoRuntimeStatus} onBeginMotionTrack={onBeginMotionTrack} /></Suspense>}
            {clipTool === "pip" && <>
              <div className="tool-surface-heading"><strong>畫中畫</strong><span>建立真正的疊加軌，不是貼紙假效果</span></div>
              <div className="pip-preset-grid">{PIP_PRESETS.map((preset) => <button type="button" key={preset.name} onClick={() => onMakePictureInPicture(preset.layout, preset.name)}><i style={{ left: `${preset.layout.viewport.x * 100}%`, top: `${preset.layout.viewport.y * 100}%`, width: `${preset.layout.viewport.width * 100}%`, height: `${preset.layout.viewport.height * 100}%` }} /><span>{preset.name}</span></button>)}</div>
              <small className="pip-help">先選片段再套版型；時間軸會自動建立「畫中畫」軌，可拖曳、鎖定與重新命名。</small>
            </>}
          </section>
            </div>
          </details>
          <details className="inspector-section inspector-all" data-testid="inspector-advanced" open={clipToolsOpened}>
            <summary onClick={(event) => { event.preventDefault(); setClipToolsOpened((opened) => !opened); }}>更多專業設定 <small>圖層、表達式、動畫與追蹤</small></summary>
            <div className="inspector-advanced-body">
          <label className="field-label">片段從第幾秒開始
            <div className="number-field"><input type="number" min="0" step="0.1" value={Number(clip.timelineStart.toFixed(3))} data-testid="clip-start-input" onChange={(event) => onMove(Number(event.target.value))} /><span>sec</span></div>
          </label>
          <label className="field-label">放在哪一層
            <select value={clip.trackId} onChange={(event) => onTrackChange(event.target.value)}>{tracks.filter((track) => track.kind === (asset.kind === "audio" ? "audio" : "video")).map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select>
          </label>
          <label className="field-label">音量
            <div className="number-field"><input type="number" min="0" max="200" step="5" value={Math.round(clip.volume * 100)} onChange={(event) => onVolumeChange(Number(event.target.value) / 100)} data-testid="clip-volume-input" /><span>%</span></div>
          </label>
          <section className="creative-controls visually-hidden" aria-label="一鍵風格">
            <label className="visually-hidden">影片風格<select value={clip.creative?.lookPresetId ?? ""} onChange={(event) => onCreativeChange({ lookPresetId: event.target.value || null })} data-testid="look-preset-select"><option value="">原始自然</option>{LOOK_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
            <div className="transition-grid">
              <label className="visually-hidden">入場轉場
                <select disabled={!canTransitionIn} value={clip.creative?.transitionIn?.presetId ?? ""} onChange={(event) => {
                  const preset = TRANSITION_PRESETS.find((item) => item.id === event.target.value);
                  onCreativeChange({ transitionIn: preset ? { presetId: preset.id, duration: Math.min(preset.defaultDuration, clip.duration) } : null });
                }} data-testid="transition-in-select">
                  <option value="">{canTransitionIn ? "直接切入" : "前方沒有相鄰片段"}</option>
                  {TRANSITION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
              </label>
              <label className="visually-hidden">離場轉場
                <select disabled={!canTransitionOut} value={clip.creative?.transitionOut?.presetId ?? ""} onChange={(event) => {
                  const preset = TRANSITION_PRESETS.find((item) => item.id === event.target.value);
                  onCreativeChange({ transitionOut: preset ? { presetId: preset.id, duration: Math.min(preset.defaultDuration, clip.duration) } : null });
                }} data-testid="transition-out-select">
                  <option value="">{canTransitionOut ? "直接切換" : "後方沒有相鄰片段"}</option>
                  {TRANSITION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
              </label>
            </div>
          </section>
          <details className="inspector-section" data-testid="wave2-media-frames">
            <summary>媒體框版型 <small>Wave 2 · {wave2.mediaFrames.length} 款</small></summary>
            <div className="wave2-preset-grid">
              <button type="button" onClick={() => onMediaFrameApply({ crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } }, "原始滿版")}>原始滿版</button>
              {wave2.mediaFrames.map((preset) => <button type="button" key={preset.id} title={`${preset.family} · ${preset.provenance}`} onClick={() => onMediaFrameApply(mediaFrameLayout(preset.kind), preset.name)}>{preset.name}</button>)}
            </div>
          </details>
          <details className="inspector-section" data-testid="motion-section" onToggle={(event) => { if (event.currentTarget.open) setMotionStudioOpened(true); }}>
            <summary>Editkin Motion <small>{motionTracks.length ? `${motionTracks.length} 組追蹤` : "字卡、動畫與追蹤"}</small></summary>
            {motionStudioOpened && <Suspense fallback={<small>正在載入 Editkin Motion…</small>}><MotionStudio {...{ asset, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, motionGraphics, onUpdateMotionGraphic, onDeleteMotionGraphic }} wave2Presets={wave2.motionPresets} /></Suspense>}
          </details>
          <div className="metric-grid">
            <div><span>素材起點</span><strong>{formatTime(clip.sourceStart)}</strong></div>
            <div><span>片段長度</span><strong>{formatTime(clip.duration)}</strong></div>
            <div><span>結束時間</span><strong>{formatTime(clip.timelineStart + clip.duration)}</strong></div>
            <div><span>畫面大小</span><strong>{Math.round(clip.transform.scale * 100)}%</strong></div>
          </div>
          <details className="inspector-section">
            <summary>位置、大小與透明度 <small>進階</small></summary>
            <div className="transform-grid">
              <label>左右位置 <input type="number" value={clip.transform.x} onChange={(event) => onTransformChange({ x: Number(event.target.value) })} /></label>
              <label>上下位置 <input type="number" value={clip.transform.y} onChange={(event) => onTransformChange({ y: Number(event.target.value) })} /></label>
              <label>畫面大小 <input type="number" min="0.01" step="0.05" value={clip.transform.scale} onChange={(event) => onTransformChange({ scale: Number(event.target.value) })} /></label>
              <label>旋轉角度 <input type="number" step="1" value={clip.transform.rotation} onChange={(event) => onTransformChange({ rotation: Number(event.target.value) })} /></label>
              <label>透明度 <input type="number" min="0" max="1" step="0.05" value={clip.transform.opacity} onChange={(event) => onTransformChange({ opacity: Number(event.target.value) })} /></label>
            </div>
          </details>
          <LayerExpressionPanel clip={clip} clips={tracks.flatMap((track) => track.clips)} onLayerChange={onLayerChange} onExpressionChange={onExpressionChange} />
          <details className="inspector-section" data-testid="color-section">
            <summary>色彩調整 <small>進階</small></summary>
            <button type="button" className="mini-action color-workspace-open" onClick={onOpenColorWorkspace} data-testid="color-workspace-button">◒ 開啟專業調色與 Scopes</button>
            <div className="transform-grid">
              <label>亮度 <input type="number" min="-1" max="1" step="0.05" value={clip.color.brightness} onChange={(event) => onColorChange({ brightness: Number(event.target.value) })} /></label>
              <label>對比 <input type="number" min="0.1" max="3" step="0.1" value={clip.color.contrast} onChange={(event) => onColorChange({ contrast: Number(event.target.value) })} /></label>
              <label>鮮豔度 <input type="number" min="0" max="3" step="0.1" value={clip.color.saturation} onChange={(event) => onColorChange({ saturation: Number(event.target.value) })} /></label>
              <label>色相 <input type="number" min="-180" max="180" step="1" value={clip.color.hue} onChange={(event) => onColorChange({ hue: Number(event.target.value) })} /></label>
            </div>
          </details>
          <details className="inspector-section">
            <summary>動畫關鍵幀 <small>{clip.keyframes.length} 個</small></summary>
            <button type="button" className="mini-action" onClick={onAddKeyframe}>＋ 在目前時間加入</button>
            <div className="keyframe-list">
              {clip.keyframes.length === 0 ? <small>尚未建立動畫關鍵幀</small> : clip.keyframes.map((keyframe) => (
                <div key={keyframe.id}><span>◆ {formatTime(keyframe.time)}</span><select aria-label={`${formatTime(keyframe.time)} easing`} value={keyframe.easing} onChange={(event) => onKeyframeEasingChange(keyframe.id, event.target.value as KeyframeEasing)}><option value="linear">Linear</option><option value="ease_in">Ease in</option><option value="ease_out">Ease out</option><option value="ease_in_out">Ease in/out</option><option value="spring_soft">Soft spring</option><option value="hold">Hold</option></select><button type="button" onClick={() => onDeleteKeyframe(keyframe.id)}>×</button></div>
              ))}
              {clip.keyframes.length > 0 && <small>移動到想改的位置，再調整畫面或色彩就會自動更新。</small>}
            </div>
          </details>
            </div>
          </details>
        </div>
      ) : (
        <div className="inspector-empty"><span>◇</span><strong>點一下片段或字幕</strong><small>這裡會出現簡單調整選項</small></div>
      )}
    </aside>
  );
}

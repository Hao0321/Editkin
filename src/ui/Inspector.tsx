import { INSPECTOR_WORKSPACE_TOOLS_V1, type EditingWorkspaceV1 } from "./editingWorkspaceV1";
import { EditingTrackingToolsV1 } from "./EditingTrackingToolsV1";
import { ClipAudioEnvelopeControls } from "./ClipAudioEnvelopeControls";
import type { ClipAudioEnvelope } from "../domain/clipAudioEnvelope";
import { ClipGeometryControls } from "./ClipGeometryControls";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { CaptionDelivery } from "./CaptionDelivery";
import { ClipAudioGain } from "./ClipAudioGain";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { useNativeWheelScroll } from "./wheelScroll";
import { cssFontFamily, resolveBundledFontFace } from "../typography/fontFaces";
import { LOOK_PRESETS, TRANSITION_PRESETS } from "../creative/corePack";
import { initializeWave2Registry, mediaFrameLayout } from "../creative/wave2Registry";
import { initializeStudioCreativeAssets, STUDIO_MOTION_ASSETS } from "../creative/studioAssets";
import type { PluginRegistrySummary } from "../desktop/types";
import type { CaptionCue, CaptionStyle, ChromaKeySettings, ClipCreativeState, ClipExpressionProperty, ClipLayout, ClipMask, ClipLayerState, ColorAdjustments, FloatingVideoFrame, HaoExpressionSource, KeyframeEasing, MaskShapeKind, MediaAsset, MotionGraphic, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NativeEffectInstance, NormalizedRect, ParticleSimulationSettings, Scene25dSettings, TimelineClip, TimelineTrack, Transform2D, Transform3D } from "../domain/types";
import type { MotionClipPresetId } from "../motion/motionClipPresets";
import type { ManualReferenceMotionTemplate } from "./ReferenceMotionTemplateControls";
import type { FloatingFrameScenePresetId } from "../motion/floatingFrameScenes";
import { formatTime } from "../lib/format";
import { createTransformMotionBlurInstance, isTransformMotionBlurInstance } from "../domain/transformMotionBlur";
import { LayerExpressionPanel } from "./LayerExpressionPanel";
import { CreativePresetGallery } from "./PresetPreviewGallery";
import Mesh3dControls from "./Mesh3dControls";
import { Scene25dLightControls } from "./Scene25dLightControls";
import { Scene25dCameraControlsV1 } from "./Scene25dCameraControlsV1";
import { Scene25dPlaneControlsV1, Scene25dLensControlsV1 } from "./Scene25dPlaneLensControlsV1";
import type { Transform3dAxisIntentV1 } from "../application/clipAppearanceEditsV1";
import { NativeEffectParameterControlsV1 } from "./NativeEffectParameterControlsV1";
import { ClipTransformNumberFieldsV1, ClipColorNumberFieldsV1, type TransformNumberFieldV1, type ColorNumberFieldV1 } from "./ClipAppearanceNumberFieldsV1";
import { CaptionInspectorControlsV1 } from "./CaptionInspectorControlsV1";
import type { CaptionEditIntentV1, CaptionTextFieldV1 } from "../application/captionEditingActionsV1";
import type { CaptionParameterPreviewV1 } from "../application/captionParameterGestureV1";
import type { ParameterGestureLeaseV1 } from "../application/transientParameterGestureV1";
import type { GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";
import type { NativeEffectParameterGestureLeaseV1, NativeEffectParameterPreviewV1 } from "../application/nativeEffectParameterGestureV1";
import type { PresetEffectEditHandlerV1 } from "./AppliedPresetEffectStackV1";
import { matchingNativeEffectCapabilityV1 } from "./nativeEffectParametersV1";
import { ClipSourceReplacementControls } from "./ClipSourceReplacementControls";
import { ClipInPointControl } from "./ClipInPointControl";
import { ClipSpeedControls } from "./ClipSpeedControls";
import { ClipStartField } from "./ClipStartField";
import type { AutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { requestTemplateEditor, templateOwnerByGraphic } from "./templateEditorRequests";
import { templateInstancesForClip } from "./timelineMotionBlocks";
import "./inspectorDiscovery.css";
import "./templateEditorEntry.css";
import "./captionEditor.css";
import "./creatorToolSurface.css";
import "./displayType.css";

const MotionStudio = lazy(() => import("./MotionStudio"));
const MotionV3Library = lazy(() => import("./MotionV3Library"));
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
  workspace?: EditingWorkspaceV1;
  onOpenEffectsLibrary?: () => void;
  showClipSpeedControls?: boolean;
  clipMediaBusy?: boolean;
  onClipRetime?: (rate: number, reverse: boolean) => unknown;
  onFreezeFrame?: () => unknown;
  /** Simple mode: closes the panel (the selection stays); the next pick opens it again. */
  onClose?: () => void;
  captionProject?: import("../domain/types").EditProject;
  onCaptionCommand?: (command: import("../domain/commands").EditorCommand) => void;
  onCaptionSelect?: (captionId: string) => void;
  originalMotionScenesControl?: ReactNode;
  templateSourceControl?: ReactNode;
  autoReframeControl?: ReactNode;
  /** 動態素材 section for a selected Motion Library clip or timeline transition (it replaces the empty hint). */
  motionLibraryControl?: ReactNode;
  mesh3dProject?: import("../domain/types").EditProject;
  onMesh3dCommand?: (command: import("../domain/commands").EditorCommand) => void;
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
  /** Moves the selected clip once; false, or a promise of false, means the editor refused it. */
  onMove: (time: number) => boolean | void | Promise<boolean>;
  onTrackChange: (trackId: string) => void;
  onReplaceClipSource?: (command: Extract<import("../domain/commandTypes").EditorCommand, { type: "replace_clip_source" }>) => void;
  clipSourceSessionId?: number;
  /** Live project for the in-point field; omitted hides it. */
  sourceTimingProject?: import("../domain/types").EditProject;
  /** One new in-point for the selected clip (its position and length stay); a promise while a title template on it is
   * laid out again. */
  onSlipClip?: (sourceStart: number) => boolean | void | Promise<boolean>;
  onVolumeChange: (volume: number) => boolean | void;
  onVolumeGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  volumePreview?: number;
  numberEditScope?: unknown;
  appearanceValues?: Pick<TimelineClip, "transform" | "color">;
  appearanceEditScope?: unknown;
  onTransformNumberGestureStart?: (field: TransformNumberFieldV1) => ParameterGestureLeaseV1 | undefined;
  onColorNumberGestureStart?: (field: ColorNumberFieldV1) => ParameterGestureLeaseV1 | undefined;
  onAudioEnvelopeChange?: (envelope?: ClipAudioEnvelope) => boolean | void;
  onTrimStart: () => void;
  onTrimEnd: () => void;
  onTransformChange: (patch: Partial<Transform2D>) => void;
  scene25d?: Scene25dSettings;
  onScene25dToggle: (enabled: boolean) => void;
  onScene25dChange: (settings: Scene25dSettings) => boolean | void;
  onTransform3dChange: (patch: Partial<Transform3D>, axis?: Transform3dAxisIntentV1) => boolean | void;
  onSetFloatingFrame?: (frame?: FloatingVideoFrame) => void;
  onApplyFloatingScene?: (preset: FloatingFrameScenePresetId, sources?: import("../motion/floatingFrameScenes").FloatingFrameSceneBindings) => void;
  sceneAssets?: readonly MediaAsset[];
  portraitCanvas?: boolean;
  onApplyClipMotionPreset?: (preset: MotionClipPresetId) => void;
  onApplyReferenceMotionTemplate?: (input: ManualReferenceMotionTemplate) => void;
  referenceMotionTemplateBusy?: boolean;
  onCancelReferenceMotionTemplate?: () => void;
  particleSimulation?: ParticleSimulationSettings;
  onParticleSimulationToggle: (enabled: boolean) => void;
  onParticleSimulationChange: (settings: ParticleSimulationSettings) => void;
  onLayerChange: (patch: Partial<ClipLayerState>) => void;
  onExpressionChange: (property: ClipExpressionProperty, expression: HaoExpressionSource | null) => void;
  onMediaFrameApply: (layout: ClipLayout, name: string) => void;
  onColorChange: (patch: Partial<ColorAdjustments>) => void;
  onCreativeChange: (patch: { lookPresetId?: string | null; effectPresetIds?: string[]; transitionIn?: ClipCreativeState["transitionIn"] | null; transitionOut?: ClipCreativeState["transitionOut"] | null }) => void;
  onPresetEffectEdit?: PresetEffectEditHandlerV1;
  onNativeEffectAdd: (instance: NativeEffectInstance) => void;
  onNativeEffectUpdate: (instanceId: string, patch: Partial<Pick<NativeEffectInstance, "enabled" | "parameters">>) => void;
  onNativeEffectParameterEdit?: (expected: NativeEffectInstance, values: NativeEffectInstance["parameters"]) => boolean | void;
  onNativeEffectParameterGesture?: (expected: NativeEffectInstance, parameterId: string) => NativeEffectParameterGestureLeaseV1 | undefined;
  nativeEffectParameterPreview?: NativeEffectParameterPreviewV1;
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
  onAddGeometryMotion?: () => void;
  motionGraphics: MotionGraphic[];
  managedMotionGraphicIds?: readonly string[];
  onGraphicTextGestureStart?: (graphicId: string) => ParameterGestureLeaseV1<string> | undefined;
  onGraphicTextDraftRejected?: () => void;
  onGraphicNumberGestureStart?: GraphicNumberGestureStartV1;
  onGraphicNumberDraftRejected?: () => void;
  onUpdateMotionGraphic: (graphicId: string, patch: Partial<Omit<MotionGraphic, "schema" | "id">>) => boolean | void;
  onDeleteMotionGraphic: (graphicId: string) => void;
  onCaptionChange: (patch: Partial<Pick<CaptionCue, "text" | "start" | "duration">> & { translation?: CaptionCue["translation"] | null }, intent?: CaptionEditIntentV1) => boolean | void;
  onCaptionStyleChange: (presetId: string) => void;
  onCaptionStylePatch: (patch: Partial<CaptionStyle>) => boolean | void;
  onCaptionTextGestureStart?: (field: CaptionTextFieldV1) => ParameterGestureLeaseV1<string> | undefined;
  onCaptionOpacityGestureStart?: () => ParameterGestureLeaseV1 | undefined;
  onCaptionDraftRejected?: () => void;
  captionParameterPreview?: CaptionParameterPreviewV1;
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

export function Inspector({ workspace, onOpenEffectsLibrary, onClose, captionProject, onCaptionCommand, onCaptionSelect, originalMotionScenesControl, templateSourceControl, autoReframeControl, motionLibraryControl, mesh3dProject, onMesh3dCommand, playhead, projectFps, clip, asset, previewSource, caption, captionStyle, tracks, canTransitionIn, canTransitionOut, onMove, onTrackChange, onReplaceClipSource, clipSourceSessionId, sourceTimingProject, onSlipClip, showClipSpeedControls, clipMediaBusy, onClipRetime, onFreezeFrame, onVolumeChange, onVolumeGestureStart, volumePreview, numberEditScope, appearanceValues, appearanceEditScope, onTransformNumberGestureStart, onColorNumberGestureStart, onAudioEnvelopeChange, onTrimStart, onTrimEnd, onTransformChange, scene25d, onScene25dToggle, onScene25dChange, onTransform3dChange, onSetFloatingFrame, onApplyFloatingScene, sceneAssets, portraitCanvas, onApplyClipMotionPreset, onApplyReferenceMotionTemplate, referenceMotionTemplateBusy, onCancelReferenceMotionTemplate, particleSimulation, onParticleSimulationToggle, onParticleSimulationChange, onLayerChange, onExpressionChange, onMediaFrameApply, onColorChange, onCreativeChange, onPresetEffectEdit, onNativeEffectAdd, onNativeEffectUpdate, onNativeEffectParameterEdit, onNativeEffectParameterGesture, nativeEffectParameterPreview, onNativeEffectReorder, onNativeEffectRemove, onAddKeyframe, onKeyframeEasingChange, onDeleteKeyframe, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, onAddGeometryMotion, motionGraphics, managedMotionGraphicIds, onGraphicTextGestureStart, onGraphicTextDraftRejected, onGraphicNumberGestureStart, onGraphicNumberDraftRejected, onUpdateMotionGraphic, onDeleteMotionGraphic, onCaptionChange, onCaptionStyleChange, onCaptionStylePatch, onCaptionTextGestureStart, onCaptionOpacityGestureStart, onCaptionDraftRejected, captionParameterPreview, onOpenColorWorkspace, onAddCaption, onMakePictureInPicture, onAddMask, onUpdateMask, onDeleteMask, onBindMaskTrack, onSetMaskKeyframe, onFreezeMask, onAutoRotoMask, onQuickAutoRoto, onChromaKeyChange, autoRotoBusy, autoRotoRuntimeStatus, pluginRegistry }: InspectorProps) {
  const { mode } = useI18n();
  initializeStudioCreativeAssets();
  const wave2 = initializeWave2Registry();
  const [motionStudioOpened, setMotionStudioOpened] = useState(false);
  const [clipToolsOpened, setClipToolsOpened] = useState(false);
  // Simple mode opens this panel only for what was picked, so its plain tools start open (advanced keeps them folded).
  const [quickToolsOpened, setQuickToolsOpened] = useState(CLIP_TOOLS_DEFAULT_OPEN || mode === "simple");
  const [engineToolsOpened, setEngineToolsOpened] = useState(Boolean(scene25d?.enabled || particleSimulation?.enabled));
  const [clipTool, setClipTool] = useState<ClipTool>("adjust");
  const isEditing = !workspace || workspace === "edit", isEffects = !workspace || workspace === "effects";
  const allowedTools: readonly string[] = workspace ? INSPECTOR_WORKSPACE_TOOLS_V1[workspace] : CLIP_TOOL_ITEMS.map(([id]) => id);
  const activeClipTool = allowedTools.includes(clipTool) ? clipTool : allowedTools[0];
  const [captionToolsOpened, setCaptionToolsOpened] = useState(false);
  const creatorTabs = useRef<HTMLElement>(null);
  useNativeWheelScroll(creatorTabs, "horizontal", caption ? "caption" : clip?.id);
  // The selected clip's own title templates: their editor opens from here, not only from the footer.
  const templateProject = sourceTimingProject ?? mesh3dProject ?? captionProject;
  const clipTemplates = clip && templateProject ? templateInstancesForClip(templateProject, clip.id) : [];
  const motionTemplateOwners = templateProject ? Object.fromEntries([...templateOwnerByGraphic(templateProject)]
    .map(([graphicId, instance]) => [graphicId, { instanceId: instance.id, title: instance.input.title }])) : undefined;
  return (
    <aside className="panel inspector" aria-label={uiText("屬性面板")}>
      <div className="panel-title inspector-title">
        <div>
          <span className="eyebrow">{uiText("目前選取")}</span>
          <h2>{caption ? uiText("調整字幕") : uiText("調整片段")}</h2>
        </div>
        <span className="live-pill">{uiText("即時預覽")}</span>
        {onClose && <button type="button" className="inspector-close" data-testid="inspector-close" onClick={onClose}
          aria-label={uiText("收起調整面板")} title={uiText("收起調整面板")}><span aria-hidden="true">×</span></button>}
      </div>
      {motionLibraryControl}
      {captionProject && onCaptionCommand && onCaptionSelect && (isEditing ? <CaptionDelivery project={captionProject} onCommand={onCaptionCommand} onSelect={onCaptionSelect} /> : null)}
      {mesh3dProject && onMesh3dCommand && (isEffects ? <Mesh3dControls project={mesh3dProject} clipId={clip?.id} onCommand={onMesh3dCommand}/> : null)}
      {isEffects && originalMotionScenesControl}
      {clip && !caption && autoReframeControl}
      {caption && isEditing ? (<CaptionInspectorControlsV1 caption={caption} captionStyle={captionStyle} editScope={numberEditScope} preview={captionParameterPreview} captionToolsOpened={captionToolsOpened} setCaptionToolsOpened={setCaptionToolsOpened} onCaptionChange={onCaptionChange} onCaptionStyleChange={onCaptionStyleChange} onCaptionStylePatch={onCaptionStylePatch} onCaptionTextGestureStart={onCaptionTextGestureStart} onCaptionOpacityGestureStart={onCaptionOpacityGestureStart} onCaptionDraftRejected={onCaptionDraftRejected} />) : clip && asset ? (<div className="inspector-body">
          <div className="selected-card">
            <div className="selected-icon">▶</div>
            <div><strong>{asset.name}</strong><span>{uiText("影片片段 · ")}{formatTime(clip.duration)}</span></div>
          </div>
          {clipTemplates.length > 0 && <section className="inspector-template-card" data-testid="inspector-template-card" aria-label={uiText("這段的標題模板")}>
            <div><strong>{uiText("這段有標題模板")}</strong><span>{uiText("要改標題、重點字、標籤、文字位置或字型，請打開模板編輯器。")}</span></div>
            {clipTemplates.map(instance => <button type="button" key={instance.id} className="primary-tool-action" data-testid={`inspector-open-template-${instance.id}`}
              onClick={() => requestTemplateEditor(instance.id, "inspector")}>{uiText("改標題文字：{title}", { title: instance.input.title })}</button>)}
          </section>}
          {showClipSpeedControls && (isEditing ? <ClipSpeedControls clip={clip} asset={asset} playhead={playhead} busy={clipMediaBusy} onRetime={onClipRetime} onFreezeFrame={onFreezeFrame} /> : null)}
          {sourceTimingProject && onSlipClip && (isEditing ? <ClipInPointControl key={`${clipSourceSessionId ?? 0}:${clip.id}`}
            project={sourceTimingProject} clipId={clip.id} onCommit={onSlipClip} /> : null)}
          {templateSourceControl ?? (asset.kind === "video" && mesh3dProject && onReplaceClipSource && clipSourceSessionId !== undefined && (isEditing ? <ClipSourceReplacementControls
            key={`${clipSourceSessionId}:${clip.id}:${asset.id}`} project={mesh3dProject} sessionId={clipSourceSessionId}
            clipId={clip.id} expectedAssetId={asset.id} onReplace={onReplaceClipSource} /> : null))}
          {isEffects && <details className="inspector-section professional-engine-tools" data-testid="professional-engine-tools" open={workspace === "effects" || engineToolsOpened} onToggle={(event) => setEngineToolsOpened(event.currentTarget.open)}>
            <summary>{uiText("進階特效 ")}<small>{uiText("2.5D 場景、景深與粒子模擬")}</small></summary>
            <div className="professional-engine-tools-body">
          <details className="inspector-section scene-25d-controls" data-testid="scene-25d-controls" open={Boolean(scene25d?.enabled)}>
            <summary>{uiText("立體畫面 ")}<small>{scene25d?.enabled ? uiText("即時預覽已啟用") : uiText("讓照片與影片產生前後景深度")}</small></summary>
            {!scene25d?.enabled ? <>
              <p className="scene-25d-note">{uiText("把 1–8 個照片或影片放進同一個透視空間，可調深度、XYZ 旋轉、父子圖層、相機與方向光。影片會沿用原生 GPU 解碼，不必先轉成圖片。")}</p>
              <button type="button" className="primary-tool-action" disabled={!['image', 'video'].includes(asset.kind)} onClick={() => onScene25dToggle(true)} data-testid="enable-scene-25d">{uiText("啟用 2.5D 場景")}</button>
              {!['image', 'video'].includes(asset.kind) && <small>{uiText("2.5D 場景需要照片、透明 PNG 或影片素材。")}</small>}
            </> : <>
              <div className="tool-surface-heading"><strong>{uiText("目前平面")}</strong><span>{uiText("位置單位為場景 world unit")}</span></div>
              <Scene25dPlaneControlsV1 clip={clip} editScope={numberEditScope} onChange={onTransform3dChange} />
              <div className="tool-surface-heading"><strong>{uiText("場景")}</strong><span>{uiText("所有平面共用同一台相機與燈光")}</span></div>
              <Scene25dCameraControlsV1 scene={scene25d} editScope={numberEditScope} onChange={onScene25dChange} />
              <Scene25dLightControls scene={scene25d} playhead={playhead} editScope={numberEditScope} onChange={onScene25dChange} />
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
                  }}>{uiText("◆ 在 ")}{playhead.toFixed(2)}{uiText("s 記錄相機")}</button>
                {scene25d.camera.keyframes.map((keyframe) => <div className="lens-keyframe-row" key={keyframe.id}>
                  <span>{keyframe.time.toFixed(2)}s · Z {keyframe.position[2].toFixed(2)} · {keyframe.verticalFovDegrees.toFixed(0)}°</span>
                  <select aria-label={uiText("{value0} 秒相機緩動", { value0: String(keyframe.time.toFixed(2)) })} value={keyframe.easing} onChange={(event) => onScene25dChange({ ...scene25d, camera: { ...scene25d.camera,
                    keyframes: scene25d.camera.keyframes.map((candidate) => candidate.id === keyframe.id ? { ...candidate, easing: event.target.value as KeyframeEasing } : candidate) } })}>
                    <option value="linear">{uiText("線性")}</option><option value="hold">{uiText("停格")}</option><option value="ease_in">{uiText("慢進")}</option><option value="ease_out">{uiText("慢出")}</option><option value="ease_in_out">{uiText("平滑")}</option><option value="spring_soft">{uiText("柔和彈性")}</option>
                  </select>
                  <button type="button" aria-label={uiText("刪除 {value0} 秒相機關鍵幀", { value0: String(keyframe.time.toFixed(2)) })} onClick={() => onScene25dChange({ ...scene25d, camera: { ...scene25d.camera,
                    keyframes: scene25d.camera.keyframes.filter((candidate) => candidate.id !== keyframe.id) } })}>×</button>
                </div>)}
              </div>
              <div className="tool-surface-heading"><strong>{uiText("鏡頭景深")}</strong><span>{uiText("直接取樣每個像素的真實深度")}</span></div>
              <Scene25dLensControlsV1 scene={scene25d} editScope={numberEditScope} onChange={onScene25dChange} />
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
                  }}>{uiText("◆ 在 ")}{playhead.toFixed(2)}{uiText("s 記錄鏡頭")}</button>
                {scene25d.depthOfField.keyframes.map((keyframe) => <div className="lens-keyframe-row" key={keyframe.id}>
                  <span>{keyframe.time.toFixed(2)}{uiText("s · 焦點 ")}{keyframe.focusDistance.toFixed(2)}</span>
                  <select aria-label={uiText("{value0} 秒鏡頭緩動", { value0: String(keyframe.time.toFixed(2)) })} value={keyframe.easing} onChange={(event) => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField,
                    keyframes: scene25d.depthOfField.keyframes.map((candidate) => candidate.id === keyframe.id ? { ...candidate, easing: event.target.value as KeyframeEasing } : candidate) } })}>
                    <option value="linear">{uiText("線性")}</option><option value="hold">{uiText("停格")}</option><option value="ease_in">{uiText("慢進")}</option><option value="ease_out">{uiText("慢出")}</option><option value="ease_in_out">{uiText("平滑")}</option><option value="spring_soft">{uiText("柔和彈性")}</option>
                  </select>
                  <button type="button" aria-label={uiText("刪除 {value0} 秒鏡頭關鍵幀", { value0: String(keyframe.time.toFixed(2)) })} onClick={() => onScene25dChange({ ...scene25d, depthOfField: { ...scene25d.depthOfField,
                    keyframes: scene25d.depthOfField.keyframes.filter((candidate) => candidate.id !== keyframe.id) } })}>×</button>
                </div>)}
              </div>
              <p className="scene-25d-note">{uiText("不透明影片平面會走 Depth32Float 遮擋與原生 GPU 景深；相機、燈光與鏡頭關鍵幀都依專案時間逐格取樣。照片相容路徑仍限制非相交平面，Point／Spot Light 與混合模式會直接阻擋。")}</p>
              <button type="button" className="mini-action" onClick={() => onScene25dToggle(false)} data-testid="disable-scene-25d">{uiText("退出 2.5D 場景")}</button>
            </>}
          </details>
          <details className="inspector-section scene-25d-controls" data-testid="particle-vfx-controls" open={Boolean(particleSimulation?.enabled)}>
            <summary>{uiText("粒子特效 ")}<small>{particleSimulation?.enabled ? uiText("即時預覽已啟用") : uiText("火花、漂浮粒子、能量點")}</small></summary>
            {!particleSimulation?.enabled ? <>
              <p className="scene-25d-note">{uiText("加入可重播的即時粒子層；預覽與輸出共用同一個 fixed-seed GPU 模擬。")}</p>
              <button type="button" className="primary-tool-action" disabled={Boolean(scene25d?.enabled)} onClick={() => onParticleSimulationToggle(true)} data-testid="enable-particle-vfx">{uiText("加入粒子特效")}</button>
              {scene25d?.enabled && <small>{uiText("目前的螢幕空間粒子 v1 與 2.5D 場景分開執行，請先退出 2.5D。")}</small>}
            </> : <>
              <div className="tool-surface-heading"><strong>{uiText("粒子外觀與動作")}</strong><span>{uiText("所有數值可即時預覽")}</span></div>
              <div className="transform-grid">
                <label className="inspector-toggle-row"><span>{uiText("限制作用區間")}</span><input type="checkbox" checked={Boolean(particleSimulation.timeline)} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, timeline: event.target.checked ? { start: Math.max(0, playhead), duration: Math.max(0.1, particleSimulation.lifetimeSeconds) } : undefined })} /></label>
                {particleSimulation.timeline ? <>
                  <label>{uiText("開始秒數")}<input type="number" min="0" step="0.01" value={particleSimulation.timeline.start} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, timeline: { ...particleSimulation.timeline!, start: Number(event.target.value) } })} /></label>
                  <label>{uiText("作用秒數")}<input type="number" min="0.034" step="0.01" value={particleSimulation.timeline.duration} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, timeline: { ...particleSimulation.timeline!, duration: Number(event.target.value) } })} /></label>
                </> : null}
                <label>{uiText("每秒數量")}<input type="number" min="1" max="240" step="1" value={particleSimulation.ratePerSecond} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, ratePerSecond: Number(event.target.value) })} /></label>
                <label>{uiText("存在秒數")}<input type="number" min="0.1" max="10" step="0.05" value={particleSimulation.lifetimeSeconds} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, lifetimeSeconds: Number(event.target.value) })} /></label>
                <label>{uiText("粒子上限")}<input type="number" min="1" max="64" step="1" value={particleSimulation.maxParticles} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, maxParticles: Number(event.target.value) })} /></label>
                <label>{uiText("粒子大小")}<input type="number" min="0.5" max="64" step="0.25" value={particleSimulation.radiusPixels} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, radiusPixels: Number(event.target.value) })} /></label>
                <label>{uiText("起點 X")}<input type="number" min="0" max="1" step="0.01" value={particleSimulation.emitterPosition[0]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, emitterPosition: [Number(event.target.value), particleSimulation.emitterPosition[1]] })} /></label>
                <label>{uiText("起點 Y")}<input type="number" min="0" max="1" step="0.01" value={particleSimulation.emitterPosition[1]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, emitterPosition: [particleSimulation.emitterPosition[0], Number(event.target.value)] })} /></label>
                <label>{uiText("水平速度")}<input type="number" step="1" value={particleSimulation.initialVelocity[0]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, initialVelocity: [Number(event.target.value), particleSimulation.initialVelocity[1]] })} /></label>
                <label>{uiText("垂直速度")}<input type="number" step="1" value={particleSimulation.initialVelocity[1]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, initialVelocity: [particleSimulation.initialVelocity[0], Number(event.target.value)] })} /></label>
                <label>{uiText("重力")}<input type="number" step="1" value={particleSimulation.gravity[1]} onChange={(event) => onParticleSimulationChange({ ...particleSimulation, gravity: [particleSimulation.gravity[0], Number(event.target.value)] })} /></label>
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
                  <div className="tool-surface-heading"><strong>{uiText("發射器 ")}{1 + additional.length} / 4</strong><span>{uiText("總粒子預算 ")}{totalParticles} / 192</span></div>
                  {additional.map((emitter, index) => {
                    const updateEmitter = (patch: Partial<typeof emitter>) => onParticleSimulationChange({
                      ...particleSimulation,
                      additionalEmitters: additional.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...patch } : candidate),
                    });
                    const colorValue = JSON.stringify(emitter.color);
                    return <details key={emitter.id} className="inspector-subsection" data-testid={`particle-emitter-${index + 2}`}>
                      <summary>{uiText("發射器 ")}{index + 2} <small>{emitter.timeline ? `${emitter.timeline.start.toFixed(2)}s · ${emitter.timeline.duration.toFixed(2)}s` : uiText("全片")}</small></summary>
                      <div className="transform-grid">
                        <label>{uiText("開始")}<input type="number" min="0" step="0.01" value={emitter.timeline?.start ?? 0} onChange={(event) => updateEmitter({ timeline: { start: Number(event.target.value), duration: emitter.timeline?.duration ?? 1.2 } })} /></label>
                        <label>{uiText("作用秒數")}<input type="number" min="0.034" step="0.01" value={emitter.timeline?.duration ?? 1.2} onChange={(event) => updateEmitter({ timeline: { start: emitter.timeline?.start ?? 0, duration: Number(event.target.value) } })} /></label>
                        <label>{uiText("每秒數量")}<input type="number" min="1" max="240" step="1" value={emitter.ratePerSecond} onChange={(event) => updateEmitter({ ratePerSecond: Number(event.target.value) })} /></label>
                        <label>{uiText("粒子上限")}<input type="number" min="1" max={emitter.maxParticles + remainingParticles} step="1" value={emitter.maxParticles} onChange={(event) => updateEmitter({ maxParticles: Number(event.target.value) })} /></label>
                        <label>{uiText("起點 X")}<input type="number" min="0" max="1" step="0.01" value={emitter.emitterPosition[0]} onChange={(event) => updateEmitter({ emitterPosition: [Number(event.target.value), emitter.emitterPosition[1]] })} /></label>
                        <label>{uiText("起點 Y")}<input type="number" min="0" max="1" step="0.01" value={emitter.emitterPosition[1]} onChange={(event) => updateEmitter({ emitterPosition: [emitter.emitterPosition[0], Number(event.target.value)] })} /></label>
                        <label>{uiText("水平速度")}<input type="number" step="1" value={emitter.initialVelocity[0]} onChange={(event) => updateEmitter({ initialVelocity: [Number(event.target.value), emitter.initialVelocity[1]] })} /></label>
                        <label>{uiText("垂直速度")}<input type="number" step="1" value={emitter.initialVelocity[1]} onChange={(event) => updateEmitter({ initialVelocity: [emitter.initialVelocity[0], Number(event.target.value)] })} /></label>
                        <label>{uiText("顏色")}<select value={colorValue} onChange={(event) => updateEmitter({ color: JSON.parse(event.target.value) as typeof emitter.color })}>
                          <option value="[0.1,0.65,1,0.85]">{uiText("冰藍")}</option><option value="[0.76,0.28,1,0.86]">{uiText("霓虹紫")}</option><option value="[1,0.86,0.35,0.88]">{uiText("金色")}</option><option value="[1,0.42,0.06,0.92]">{uiText("暖橘")}</option>
                        </select></label>
                        <label>Seed<input type="number" min="0" max="4294967295" step="1" value={emitter.seed} onChange={(event) => updateEmitter({ seed: Number(event.target.value) })} /></label>
                      </div>
                      <button type="button" className="mini-action" onClick={() => onParticleSimulationChange({ ...particleSimulation, additionalEmitters: additional.filter((_, candidateIndex) => candidateIndex !== index) })}>{uiText("移除此發射器")}</button>
                    </details>;
                  })}
                  <button type="button" className="mini-action" disabled={additional.length >= 3 || remainingParticles < 1} onClick={addEmitter} data-testid="add-particle-emitter">{uiText("＋ 新增發射器")}</button>
                </div>;
              })()}
              <p className="scene-25d-note">{uiText("最多 4 個、合計 192 顆的 2D 螢幕空間 executor；每個發射器有自己的時間、seed 與外觀。3D 碰撞、流體與景深互動仍會明確阻擋。")}</p>
              <button type="button" className="mini-action" onClick={() => onParticleSimulationToggle(false)} data-testid="disable-particle-vfx">{uiText("移除粒子特效")}</button>
            </>}
          </details>
            </div>
          </details>}
          {isEditing && <ClipAudioGain key={`visible-${clip.id}`} clipId={clip.id} volume={clip.volume} onVolumeChange={onVolumeChange} onGestureStart={onVolumeGestureStart} previewVolume={volumePreview} editScope={numberEditScope} compact disabled={asset.kind === "image" || Boolean(tracks.find(track => track.id === clip.trackId)?.locked)} />}
          {onAudioEnvelopeChange && asset.kind !== "image" && !asset.compositionId && clip.layer?.role !== "controller" && (isEditing ? <ClipAudioEnvelopeControls key={`audio-envelope-${clip.id}`} clip={clip} playhead={playhead} fps={projectFps} music={asset.role === "background-music"} disabled={Boolean(tracks.find(track => track.id === clip.trackId)?.locked)} onChange={onAudioEnvelopeChange} /> : null)}
          {workspace === "tracking" && asset.kind === "video" && <EditingTrackingToolsV1 busy={trackingBusy} selecting={trackingSelectionActive} selection={trackingSelection} tracks={motionTracks} onBegin={onBeginMotionTrack} onCorrect={onCorrectMotionTrack} onDelete={onDeleteMotionTrack} onAttach={id => onAddMotionGraphic("tag", id)} />}
          <details className="inspector-section clip-quick-tools" data-testid="clip-quick-tools" open={workspace ? true : quickToolsOpened} onToggle={(event) => setQuickToolsOpened(event.currentTarget.open)}>
            <summary>{uiText("片段工具 ")}<small>{uiText("先選一項，再直接看預覽")}</small></summary>
            <div className="clip-quick-tools-body">
          <nav ref={creatorTabs} className="creator-tool-tabs" aria-label={uiText("片段工具")} tabIndex={0}>
            {CLIP_TOOL_ITEMS.filter(([id]) => allowedTools.includes(id)).map(([id, icon, label]) => <button key={id} type="button" className={activeClipTool === id ? "active" : ""} aria-pressed={activeClipTool === id} data-testid={id === "look" ? "effect-preview-entry" : undefined} onClick={() => setClipTool(id)}><b>{icon}</b><span>{uiText(label)}</span></button>)}
          </nav>
          <section className="creator-tool-surface" data-tool={activeClipTool}>
            {activeClipTool === "adjust" && <>
              <div className="tool-surface-heading"><strong>{uiText("快速調整")}</strong><span>{uiText("先處理最常用的操作")}</span></div>
              <span className="quick-adjust-label">{uiText("播放到想保留的位置，再按下面其中一個")}</span>
              <div className="clip-trim-actions"><button type="button" onClick={onTrimStart} data-testid="trim-start-button">{uiText("保留後面")}</button><button type="button" onClick={onTrimEnd} data-testid="trim-end-button">{uiText("保留前面")}</button></div>
              {asset.kind !== "audio" && tracks.find(track => track.id === clip.trackId)?.kind !== "audio" && <ClipGeometryControls key={`geometry-${clip.id}`} crop={clip.layout?.crop} rotation={clip.transform.rotation} flipX={clip.transform.flipX} flipY={clip.transform.flipY} onFlip={axis => onTransformChange({ [axis]: !clip.transform[axis] })} disabled={Boolean(tracks.find(track => track.id === clip.trackId)?.locked)}
                onCropChange={crop => onMediaFrameApply({ ...clip.layout, crop, viewport: clip.layout?.viewport ?? { x: 0, y: 0, width: 1, height: 1 } }, uiText("裁切"))} onRotationChange={rotation => onTransformChange({ rotation })} />}
              {asset.kind !== "audio" && <button type="button" className="primary-tool-action" onClick={onOpenColorWorkspace}>{uiText("◒ 打開調色工作區")}</button>}
            </>}
            {activeClipTool === "text" && <>
              <div className="tool-surface-heading"><strong>{uiText("文字與動態字卡")}</strong><span>{uiText("新增後仍能逐項修改")}</span></div>
              <div className="text-tool-grid"><button type="button" onClick={onAddCaption}><b>{uiText("字幕")}</b><span>{uiText("一般逐句文字")}</span></button><button type="button" onClick={() => onAddMotionGraphic("title")}><b>{uiText("主標題")}</b><span>{uiText("首秒 Hook")}</span></button><button type="button" onClick={() => onAddMotionGraphic("card")}><b>{uiText("重點卡")}</b><span>{uiText("資訊整理")}</span></button><button type="button" onClick={() => onAddMotionGraphic("tag")}><b>{uiText("標籤")}</b><span>{uiText("人物／產品")}</span></button><button type="button" onClick={() => onAddMotionGraphic("counter")}><b>{uiText("數字")}</b><span>{uiText("排行／步驟")}</span></button></div>
              <div className="display-type-heading"><strong>Motion Design v3</strong><span>{uiText("16 款版型 · 預覽與輸出逐格一致")}</span></div>
              <Suspense fallback={<small>{uiText("正在載入 Motion Design v3…")}</small>}><MotionV3Library onAddMotionGraphic={onAddMotionGraphic} /></Suspense>
              <div className="display-type-heading"><strong>{uiText("花字試裝")}</strong><span>{uiText("8 款原創可編輯字卡 · 字型已內建")}</span></div>
              <div className="display-type-grid" data-testid="display-type-library">{STUDIO_MOTION_ASSETS.map((preset) => { const face = resolveBundledFontFace(preset.seed.fontFamily ?? "Noto Sans TC", preset.seed.fontWeight ?? 700); return <button type="button" key={preset.id} className={`display-type-card ${preset.previewClass}`} title={`${preset.license} · ${preset.provenance}${face?.weightSubstituted ? uiText(" · 字重 {value0} → {value1}", { value0: String(face.requestedWeight), value1: String(face.fontWeight) }) : ""}`} onClick={() => onAddMotionGraphic("title", undefined, preset.seed)}><i data-font-weight-substituted={face?.weightSubstituted} style={{ fontFamily: cssFontFamily(face?.fontFamily ?? preset.seed.fontFamily), fontWeight: face?.fontWeight ?? preset.seed.fontWeight, fontSynthesis: "style", color: preset.seed.textColor, background: preset.seed.backgroundColor, borderColor: preset.seed.accentColor }}>Aa</i><span>{uiText(preset.name)}</span></button>; })}</div>
              <details className="inline-motion-library"><summary>{uiText("更多動態素材 ")}<small>{wave2.motionPresets.length}{uiText(" 款")}</small></summary><div className="display-type-grid">{wave2.motionPresets.map((preset) => <button type="button" key={preset.id} className="display-type-card library" onClick={() => onAddMotionGraphic(preset.seed.kind ?? "card", undefined, preset.seed)}><i style={{ color: preset.seed.textColor, background: preset.seed.backgroundColor, borderColor: preset.seed.accentColor }}>{preset.presetType === "widget" ? "01" : "Aa"}</i><span>{uiText(preset.name)}</span></button>)}</div></details>
            </>}
            {activeClipTool === "look" && <CreativePresetGallery section="look" source={previewSource} creative={clip.creative} duration={clip.duration} canTransitionIn={canTransitionIn} canTransitionOut={canTransitionOut} onChange={onCreativeChange} />}
            {activeClipTool === "effect" && <>
              {onOpenEffectsLibrary && <button type="button" className="primary-tool-action" onClick={onOpenEffectsLibrary} data-testid="open-effect-stack-library">{uiText("＋ 新增效果")}</button>}
              <div className="tool-surface-heading"><strong>{uiText("原生動態模糊")}</strong><span>GPU shutter sampling · 2–8 samples</span></div>
              <button type="button" className="primary-tool-action" data-testid="add-transform-motion-blur"
                disabled={asset.kind !== "video" || !clip.keyframes.length || Boolean(clip.creative?.nativeEffectInstances?.some(isTransformMotionBlurInstance))}
                onClick={() => onNativeEffectAdd(createTransformMotionBlurInstance())}>
                {clip.creative?.nativeEffectInstances?.some(isTransformMotionBlurInstance) ? uiText("已加入動態模糊") : asset.kind !== "video" ? uiText("目前只支援影片片段") : clip.keyframes.length ? uiText("加入原生動態模糊") : uiText("先加入位置／縮放／旋轉關鍵幀")}
              </button>
              <CreativePresetGallery section="effect" onEffectEdit={onPresetEffectEdit} effectReadOnly={Boolean(tracks.find(track => track.id === clip.trackId)?.locked)} source={previewSource} creative={clip.creative} duration={clip.duration} canTransitionIn={canTransitionIn} canTransitionOut={canTransitionOut} onChange={onCreativeChange} />
              {(clip.creative?.nativeEffectInstances?.length ?? 0) > 0 && <div className="native-effect-stack" data-testid="native-effect-stack">
                <div className="tool-surface-heading"><strong>{uiText("外掛效果堆疊")}</strong><span>{uiText("依序執行 · 可復原 · 正式輸出已接通")}</span></div>
                <small className="native-effect-preview-note">{uiText("GPU 圖使用預覽與輸出共用的 shader executor；CPU 原生效果則快取同一隔離 worker 產生的預覽影格。")}</small>
                {clip.creative!.nativeEffectInstances!.map((instance, index, instances) => {
                  const transformMotionBlur = isTransformMotionBlurInstance(instance);
                  const capability = matchingNativeEffectCapabilityV1(instance, pluginRegistry);
                  return <article className="native-effect-instance" key={instance.id}>
                    <header><label><input type="checkbox" checked={instance.enabled} onChange={(event) => onNativeEffectUpdate(instance.id, { enabled: event.target.checked })} />{uiText(" 啟用")}</label><b><span>{index + 1}. {transformMotionBlur ? uiText("動態模糊") : capability?.name ?? instance.pluginId}</span><small>{transformMotionBlur ? uiText("原生 GPU") : instance.runtimeType === "gpu_effect_graph" ? uiText("GPU 特效") : uiText("CPU 原生特效")} · {instance.capabilityId} · v{instance.pluginVersion}</small></b><div className="native-effect-actions"><button type="button" aria-label={uiText("效果往前")} disabled={index === 0} onClick={() => onNativeEffectReorder(instance.id, index - 1)}>↑</button><button type="button" aria-label={uiText("效果往後")} disabled={index === instances.length - 1} onClick={() => onNativeEffectReorder(instance.id, index + 1)}>↓</button><button type="button" onClick={() => onNativeEffectRemove(instance.id)}>{uiText("移除")}</button></div></header>
                    <NativeEffectParameterControlsV1 instance={instance} registry={pluginRegistry} scopeKey={`${clipSourceSessionId ?? 0}:${clip.id}`}
                      preview={nativeEffectParameterPreview?.clipId === clip.id ? nativeEffectParameterPreview : undefined}
                      onGestureStart={onNativeEffectParameterGesture ? parameterId => onNativeEffectParameterGesture(instance, parameterId) : undefined}
                      onEdit={onNativeEffectParameterEdit ? values => onNativeEffectParameterEdit(instance, values) : undefined}
                      onChange={parameters => onNativeEffectUpdate(instance.id, { parameters })} />
                  </article>;
                })}
              </div>}
            </>}
            {activeClipTool === "transition" && <CreativePresetGallery section="transition" source={previewSource} creative={clip.creative} duration={clip.duration} canTransitionIn={canTransitionIn} canTransitionOut={canTransitionOut} onChange={onCreativeChange} />}
            {activeClipTool === "mask" && <Suspense fallback={<small>{uiText("正在載入遮罩工作區…")}</small>}><MaskStudio playhead={playhead} projectFps={projectFps} clip={clip} motionTracks={motionTracks} trackingBusy={trackingBusy} trackingSelectionActive={trackingSelectionActive} onAdd={onAddMask} onUpdate={onUpdateMask} onDelete={onDeleteMask} onBindTrack={onBindMaskTrack} onKeyframe={onSetMaskKeyframe} onFreeze={onFreezeMask} onAutoRoto={onAutoRotoMask} onQuickAutoRoto={onQuickAutoRoto} onChromaKeyChange={onChromaKeyChange} autoRotoBusy={autoRotoBusy} autoRotoRuntimeStatus={autoRotoRuntimeStatus} onBeginMotionTrack={onBeginMotionTrack} /></Suspense>}
            {activeClipTool === "pip" && <>
              <div className="tool-surface-heading"><strong>{uiText("畫中畫")}</strong><span>{uiText("建立真正的疊加軌，不是貼紙假效果")}</span></div>
              <div className="pip-preset-grid">{PIP_PRESETS.map((preset) => <button type="button" key={uiText(preset.name)} onClick={() => onMakePictureInPicture(preset.layout, preset.name)}><i style={{ left: `${preset.layout.viewport.x * 100}%`, top: `${preset.layout.viewport.y * 100}%`, width: `${preset.layout.viewport.width * 100}%`, height: `${preset.layout.viewport.height * 100}%` }} /><span>{uiText(preset.name)}</span></button>)}</div>
              <small className="pip-help">{uiText("先選片段再套版型；時間軸會自動建立「畫中畫」軌，可拖曳、鎖定與重新命名。")}</small>
            </>}
          </section>
            </div>
          </details>
          <details className="inspector-section inspector-all" data-testid="inspector-advanced" open={workspace ? true : clipToolsOpened}>
            <summary onClick={workspace ? undefined : (event) => { event.preventDefault(); setClipToolsOpened((opened) => !opened); }}>{uiText(workspace === "effects" ? "圖層與動畫" : workspace === "tracking" ? "追蹤與遮罩" : workspace === "edit" ? "片段參數" : "更多專業設定 ")}{!workspace && <small>{uiText("圖層、表達式、動畫與追蹤")}</small>}</summary>
            <div className="inspector-advanced-body">
          <ClipStartField key={clip.id} clipId={clip.id} timelineStart={clip.timelineStart} fps={projectFps} onMove={onMove} project={sourceTimingProject} />
          <label className="field-label">{uiText("放在哪一層")}<select value={clip.trackId} onChange={(event) => onTrackChange(event.target.value)}>{tracks.filter((track) => track.kind === (asset.kind === "audio" ? "audio" : "video")).map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select>
          </label>
          {isEditing && <ClipAudioGain key={`advanced-${clip.id}`} clipId={clip.id} volume={clip.volume} onVolumeChange={onVolumeChange} onGestureStart={onVolumeGestureStart} previewVolume={volumePreview} editScope={numberEditScope} disabled={asset.kind === "image" || Boolean(tracks.find(track => track.id === clip.trackId)?.locked)} />}
          <section className="creative-controls visually-hidden" aria-label={uiText("一鍵風格")}>
            <label className="visually-hidden">{uiText("影片風格")}<select value={clip.creative?.lookPresetId ?? ""} onChange={(event) => onCreativeChange({ lookPresetId: event.target.value || null })} data-testid="look-preset-select"><option value="">{uiText("原始自然")}</option>{LOOK_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{uiText(preset.name)}</option>)}</select></label>
            <div className="transition-grid">
              <label className="visually-hidden">{uiText("入場轉場")}<select disabled={!canTransitionIn} value={clip.creative?.transitionIn?.presetId ?? ""} onChange={(event) => {
                  const preset = TRANSITION_PRESETS.find((item) => item.id === event.target.value);
                  onCreativeChange({ transitionIn: preset ? { presetId: preset.id, duration: Math.min(preset.defaultDuration, clip.duration) } : null });
                }} data-testid="transition-in-select">
                  <option value="">{canTransitionIn ? uiText("直接切入") : uiText("前方沒有相鄰片段")}</option>
                  {TRANSITION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{uiText(preset.name)}</option>)}
                </select>
              </label>
              <label className="visually-hidden">{uiText("離場轉場")}<select disabled={!canTransitionOut} value={clip.creative?.transitionOut?.presetId ?? ""} onChange={(event) => {
                  const preset = TRANSITION_PRESETS.find((item) => item.id === event.target.value);
                  onCreativeChange({ transitionOut: preset ? { presetId: preset.id, duration: Math.min(preset.defaultDuration, clip.duration) } : null });
                }} data-testid="transition-out-select">
                  <option value="">{canTransitionOut ? uiText("直接切換") : uiText("後方沒有相鄰片段")}</option>
                  {TRANSITION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{uiText(preset.name)}</option>)}
                </select>
              </label>
            </div>
          </section>
          {isEffects && <details className="inspector-section" data-testid="wave2-media-frames">
            <summary>{uiText("媒體框版型 ")}<small>Wave 2 · {wave2.mediaFrames.length}{uiText(" 款")}</small></summary>
            <div className="wave2-preset-grid">
              <button type="button" onClick={() => onMediaFrameApply({ crop: { x: 0, y: 0, width: 1, height: 1 }, viewport: { x: 0, y: 0, width: 1, height: 1 } }, "原始滿版")}>{uiText("原始滿版")}</button>
              {wave2.mediaFrames.map((preset) => <button type="button" key={preset.id} title={`${preset.family} · ${preset.provenance}`} onClick={() => onMediaFrameApply(mediaFrameLayout(preset.kind), preset.name)}>{uiText(preset.name)}</button>)}
            </div>
          </details>}
          {isEffects && <details className="inspector-section" data-testid="motion-section" onToggle={(event) => { if (event.currentTarget.open) setMotionStudioOpened(true); }}>
            <summary>Editkin Motion <small>{motionTracks.length ? uiText("{value0} 組追蹤", { value0: String(motionTracks.length) }) : uiText("字卡、動畫與追蹤")}</small></summary>
            {motionStudioOpened && <Suspense fallback={<small>{uiText("正在載入 Editkin Motion…")}</small>}><MotionStudio showTracking={!workspace} {...{ asset, clip, onSetFloatingFrame, onApplyFloatingScene, sceneAssets, portraitCanvas, projectFps, onApplyClipMotionPreset, onApplyReferenceMotionTemplate, referenceMotionTemplateBusy, onCancelReferenceMotionTemplate, motionTracks, trackingBusy, trackingSelectionActive, trackingSelection, onBeginMotionTrack, onCorrectMotionTrack, onDeleteMotionTrack, onAddMotionGraphic, onAddGeometryMotion, motionGraphics, managedMotionGraphicIds, onUpdateMotionGraphic, onDeleteMotionGraphic }} editScope={numberEditScope} onTextGestureStart={onGraphicTextGestureStart} onTextDraftRejected={onGraphicTextDraftRejected} onNumberGestureStart={onGraphicNumberGestureStart} onNumberDraftRejected={onGraphicNumberDraftRejected} wave2Presets={wave2.motionPresets} templateOwners={motionTemplateOwners} /></Suspense>}
          </details>}
          {isEditing && <div className="metric-grid">
            <div><span>{uiText("素材起點")}</span><strong>{formatTime(clip.sourceStart)}</strong></div>
            <div><span>{uiText("片段長度")}</span><strong>{formatTime(clip.duration)}</strong></div>
            <div><span>{uiText("結束時間")}</span><strong>{formatTime(clip.timelineStart + clip.duration)}</strong></div>
            <div><span>{uiText("畫面大小")}</span><strong>{Math.round(clip.transform.scale * 100)}%</strong></div>
          </div>}
          {(isEditing || isEffects) && <details className="inspector-section" open={Boolean(workspace)} data-testid="clip-affine-parameters">
            <summary>{uiText("位置、大小與透明度 ")}<small>{uiText("進階")}</small></summary>
            <ClipTransformNumberFieldsV1 values={appearanceValues?.transform ?? clip.transform} editScope={appearanceEditScope ?? numberEditScope} onChange={onTransformChange} onGestureStart={onTransformNumberGestureStart} />
          </details>}
          {isEffects && <LayerExpressionPanel clip={clip} clips={tracks.flatMap((track) => track.clips)} onLayerChange={onLayerChange} onExpressionChange={onExpressionChange} />}
          {!workspace && <details className="inspector-section" data-testid="color-section">
            <summary>{uiText("色彩調整 ")}<small>{uiText("進階")}</small></summary>
            <button type="button" className="mini-action color-workspace-open" onClick={onOpenColorWorkspace} data-testid="color-workspace-button">{uiText("◒ 開啟專業調色與 Scopes")}</button>
            <ClipColorNumberFieldsV1 values={appearanceValues?.color ?? clip.color} editScope={appearanceEditScope ?? numberEditScope} onChange={onColorChange} onGestureStart={onColorNumberGestureStart} />
          </details>}
          {isEffects && <details className="inspector-section" open={workspace === "effects"} data-testid="clip-animation-parameters">
            <summary>{uiText("動畫關鍵幀 ")}<small>{clip.keyframes.length}{uiText(" 個")}</small></summary>
            <button type="button" className="mini-action" onClick={onAddKeyframe}>{uiText("＋ 在目前時間加入")}</button>
            <div className="keyframe-list">
              {clip.keyframes.length === 0 ? <small>{uiText("尚未建立動畫關鍵幀")}</small> : clip.keyframes.map((keyframe) => (
                <div key={keyframe.id}><span>◆ {formatTime(keyframe.time)}</span><select aria-label={`${formatTime(keyframe.time)} easing`} value={keyframe.easing} onChange={(event) => onKeyframeEasingChange(keyframe.id, event.target.value as KeyframeEasing)}><option value="linear">Linear</option><option value="ease_in">Ease in</option><option value="ease_out">Ease out</option><option value="ease_in_out">Ease in/out</option><option value="spring_soft">Soft spring</option><option value="hold">Hold</option></select><button type="button" onClick={() => onDeleteKeyframe(keyframe.id)}>×</button></div>
              ))}
              {clip.keyframes.length > 0 && <small>{uiText("移動到想改的位置，再調整畫面或色彩就會自動更新。")}</small>}
            </div>
          </details>}
            </div>
          </details>
        </div>) : motionLibraryControl ? null : (<div className="inspector-empty"><span>◇</span><strong>{uiText("點一下片段或字幕")}</strong><small>{uiText("這裡會出現簡單調整選項")}</small></div>)}
    </aside>
  );
}

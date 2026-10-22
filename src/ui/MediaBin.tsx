import type { EditingWorkspaceV1 } from "./editingWorkspaceV1";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { buildProjectMediaSearchIndex, searchProjectMedia, DEFAULT_PROJECT_MEDIA_FILTER, type ProjectMediaSearchFilter } from "../domain/projectMediaSearch";
import { ProjectMediaSearchControls } from "./ProjectMediaSearchControls";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CreativeLibrarySummary } from "../application/creativeLibrary";
import type { PluginRegistrySummary } from "../desktop/types";
import type { CaptionCue, DirectorMarker, EditProject, MediaAsset, TemplateApplicationState } from "../domain/types";
import type { EditkinWorkflowProfile } from "../plugins/skillPack";
import type { LowerThirdPresetId } from "../application/lowerThirds";
import type { MotionGraphic } from "../domain/types";
import { formatTime } from "../lib/format";
import { libraryWindow } from "./creativeLibraryPreview";
import { useNativeWheelScroll } from "./wheelScroll";
import { startInternalAssetPointerDrag } from "./internalAssetPointerDrag";
import "./mediaBinStates.css";

interface MediaBinProps {
  workspace?: EditingWorkspaceV1;
  layerPanel?: ReactNode;
  effectsLibraryRequest?: number;
  assets: MediaAsset[];
  runtimeUrls: Record<string, string>;
  onImport: (files: File[]) => void;
  onDesktopImport?: () => void;
  creativeLibrary?: CreativeLibrarySummary;
  creativeLoading?: boolean;
  onCreativeImport?: (assetId: string) => void;
  creativeImportingId?: string;
  creativePreviewingId?: string;
  onCreativePreview?: (assetId: string) => void;
  onCreativeResolve?: (assetId: string, mode?: "poster" | "media") => Promise<string>;
  onLoadOriginalSfxCandidates?: () => Promise<void>;
  onAutoMusic?: () => void;
  onBatchAutoEdit?: () => void;
  batchSummary?: { total: number; completed: number; failed: number; running: boolean };
  onOpenBatch?: () => void;
  onAddAssetToTimeline?: (assetId: string) => void;
  onAddAssetAsPictureInPicture?: (assetId: string) => void;
  onAssetDragStart?: (assetId: string) => void;
  onAssetDragEnd?: () => void;
  onApplyShortTemplate?: (templateId: string, content?: import("../application/shortFormTemplates").ShortFormTemplateContent) => void;
  templateSourceAssetId?: string;
  templateProject?: EditProject;
  templateSourceClipId?: string;
  onApplyThemedTemplate?: (input: import("../motion/referenceMotionTemplates").ReferenceMotionTemplateInput) => void;
  templateMotionBusy?: boolean;
  onCancelTemplateMotion?: () => void;
  templateFps?: number;
  templateCanvasFormat?: "short" | "long";
  onApplyLongTemplate?: (templateId: string) => void;
  onAddLowerThird?: (presetId: LowerThirdPresetId, personName: string, organization: string) => void;
  motionGraphics?: MotionGraphic[];
  captions?: CaptionCue[];
  directorMarkers?: DirectorMarker[];
  templateApplication?: TemplateApplicationState;
  onDeleteMotionGraphic?: (graphicId: string) => void;
  onDeleteCaption?: (captionId: string) => void;
  onDeleteDirectorMarker?: (markerId: string) => void;
  onClearTemplateApplication?: () => void;
  pluginRegistry?: PluginRegistrySummary;
  pluginLoading?: boolean;
  pluginBusyId?: string;
  hasSelectedClip?: boolean;
  onApplyPlugin?: (pluginId: string, capabilityId: string, parameters?: Record<string, unknown>) => void;
  onOpenPluginFolder?: () => void;
  onRefreshPlugins?: () => void;
  workflowProfile?: EditkinWorkflowProfile;
  onWorkflowProfileChange?: (profile: EditkinWorkflowProfile) => Promise<void> | void;
  /** 動態素材庫 (Motion Library GUI): its panel, the simple-mode entry and a counter that switches to its tab. */
  motionLibraryPanel?: ReactNode;
  motionLibraryEntry?: ReactNode;
  motionLibraryRequest?: number;
}

const CreativeLibraryBrowser = lazy(() => import("./CreativeLibraryBrowser"));
const ShortFormTemplateBrowser = lazy(() => import("./ShortFormTemplateBrowser"));
const PluginBrowser = lazy(() => import("./PluginBrowser"));

const KIND_LABEL: Record<MediaAsset["kind"], string> = {
  video: "VIDEO",
  audio: "AUDIO",
  image: "IMAGE",
};
const KIND_FALLBACK: Record<MediaAsset["kind"], string> = { video: "影片", audio: "聲音", image: "圖片" };
export const PROJECT_ASSET_ROW_HEIGHT = 76;

export function MediaBin({ workspace, layerPanel, effectsLibraryRequest, assets, runtimeUrls, onImport, onDesktopImport, creativeLibrary, creativeLoading, onCreativeImport, creativeImportingId, creativePreviewingId, onCreativePreview, onCreativeResolve, onLoadOriginalSfxCandidates, onAutoMusic, onBatchAutoEdit, batchSummary, onOpenBatch, onAddAssetToTimeline, onAddAssetAsPictureInPicture, onAssetDragStart, onAssetDragEnd, onApplyShortTemplate, templateSourceAssetId, templateProject, templateSourceClipId, onApplyThemedTemplate, templateMotionBusy, onCancelTemplateMotion, templateFps = 30, templateCanvasFormat, onApplyLongTemplate, onAddLowerThird, motionGraphics, captions, directorMarkers, templateApplication, onDeleteMotionGraphic, onDeleteCaption, onDeleteDirectorMarker, onClearTemplateApplication, pluginRegistry, pluginLoading, pluginBusyId, hasSelectedClip = false, onApplyPlugin, onOpenPluginFolder, onRefreshPlugins, workflowProfile, onWorkflowProfileChange, motionLibraryPanel, motionLibraryEntry, motionLibraryRequest }: MediaBinProps) {
  useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const assetScrollRef = useRef<HTMLDivElement>(null);
  const assetDragCleanupRef = useRef<(() => void) | undefined>(undefined);
  const [tab, setTab] = useState<"project" | "library" | "templates" | "plugins" | "layers" | "motion">("project");
  useEffect(() => { if (workspace) setTab(workspace === "edit" ? "project" : "layers"); }, [workspace]);
  useEffect(() => { if (effectsLibraryRequest) setTab("plugins"); }, [effectsLibraryRequest]);
  useEffect(() => { if (motionLibraryRequest && motionLibraryPanel) setTab("motion"); }, [motionLibraryRequest, Boolean(motionLibraryPanel)]);
  const [assetScrollTop, setAssetScrollTop] = useState(0);
  const [assetViewportHeight, setAssetViewportHeight] = useState(600);
  useNativeWheelScroll(assetScrollRef, "vertical", tab);
  const userAssets = useMemo(() => assets.filter((asset) => asset.id !== "asset-demo"), [assets]);
  const userAssetIdentity = useMemo(() => userAssets.map((asset) => asset.id).join("\u0000"), [userAssets]);
  const [mediaFilter, setMediaFilter] = useState<ProjectMediaSearchFilter>(() => ({ ...DEFAULT_PROJECT_MEDIA_FILTER }));
  const mediaIndex = useMemo(() => { try { return { index: buildProjectMediaSearchIndex(userAssets), error: undefined }; } catch (error) { return { index: undefined, error: error instanceof Error ? error.message : "素材無法搜尋" }; } }, [userAssets]);
  const mediaResult = useMemo(() => { if (!mediaIndex.index) return { items: [], error: mediaIndex.error }; try { return { items: searchProjectMedia(mediaIndex.index, mediaFilter), error: undefined }; } catch (error) { return { items: [], error: error instanceof Error ? error.message : "搜尋条件不合法" }; } }, [mediaIndex, mediaFilter]);
  const filteredAssetIdentity = useMemo(() => mediaResult.items.map(asset => asset.id).join("\u0000"), [mediaResult.items]);
  useEffect(() => () => { assetDragCleanupRef.current?.(); assetDragCleanupRef.current = undefined; }, [tab, userAssetIdentity, filteredAssetIdentity, mediaFilter]);
  const assetWindow = libraryWindow(mediaResult.items, assetScrollTop, assetViewportHeight, PROJECT_ASSET_ROW_HEIGHT, 16);
  const pluginCapabilityCount = pluginRegistry?.plugins.reduce((total, plugin) => total + plugin.capabilities.length, 0);
  useEffect(() => {
    if (tab !== "project") return;
    const node = assetScrollRef.current;
    if (!node) return;
    node.scrollTop = assetScrollTop;
    const measure = () => setAssetViewportHeight((height) => height === node.clientHeight ? height : node.clientHeight);
    measure();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab]);
  useEffect(() => { setAssetScrollTop(0); if (assetScrollRef.current) assetScrollRef.current.scrollTop = 0; }, [userAssetIdentity, filteredAssetIdentity, mediaFilter]);
  const chooseMedia = () => onDesktopImport ? onDesktopImport() : inputRef.current?.click();
  return (
    <aside className="panel media-bin" aria-label={uiText("加入素材")}>
      <div className="panel-title">
        <div>
          <span className="eyebrow">{uiText("專案內容")}</span>
          <h2>{uiText("素材")}</h2>
        </div>
        <button type="button" className="add-button" onClick={chooseMedia} aria-label={uiText("加入更多素材")}>＋</button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="video/*,audio/*,image/*"
          multiple
          data-testid="media-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) onImport(files);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <div className="media-tabs" role="tablist" aria-label={uiText("素材來源")}>
        {layerPanel && <button type="button" role="tab" aria-selected={tab === "layers"} onClick={() => setTab("layers")} data-testid="layer-stack-tab">{uiText("圖層")}</button>}
        <button type="button" role="tab" aria-selected={tab === "project"} onClick={() => setTab("project")} data-user-asset-count={userAssets.length} title={uiText("我的素材")}>{uiText("專案")}<b>{userAssets.length}</b></button>
        {onCreativeImport && <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")} data-testid="asset-library-tab" title={uiText("內建素材庫")}>{uiText("素材")}</button>}
        {onApplyShortTemplate && onApplyLongTemplate && <button type="button" role="tab" aria-selected={tab === "templates"} onClick={() => setTab("templates")} data-testid="short-template-tab" title={uiText("成片模板")}>{uiText("模板")}</button>}
        {motionLibraryPanel && <button type="button" role="tab" aria-selected={tab === "motion"} onClick={() => setTab("motion")} data-testid="motion-library-tab" title={uiText("動態素材庫：文字動畫、轉場、背景")}>{uiText("動態")}</button>}
        {onApplyPlugin && <button type="button" role="tab" aria-selected={tab === "plugins"} onClick={() => setTab("plugins")} data-testid="plugin-tab" title={uiText("外掛工具 {value0}", { value0: pluginCapabilityCount ?? "" })}>{uiText(workspace === "effects" ? "效果與工具" : "工具")}</button>}
      </div>
      {tab === "layers" ? layerPanel : tab === "motion" ? motionLibraryPanel : tab === "project" ? <>
      <button type="button" className={`import-drop${userAssets.length ? " has-media" : ""}`} onClick={chooseMedia} data-testid="import-media-button" data-beginner-action="加入素材">
        <span className="import-icon" aria-hidden="true">＋</span>
        <strong>{userAssets.length ? uiText("加入更多素材") : uiText("加入素材")}</strong>
        <small>{uiText("選擇檔案，或拖入這個視窗")}</small>
      </button>
      {motionLibraryEntry}
      {onCreativeImport && <button type="button" className="library-discovery" onClick={() => setTab("library")} data-testid="asset-preview-entry">
        <span className="library-discovery-visuals" aria-hidden="true"><i>▶</i><i>♫</i><i>▧</i></span>
        <span><strong>{uiText("打開素材庫預覽")}</strong><small>{uiText("補充鏡頭、轉場、音樂與圖片；先預覽，再加入")}</small></span>
        <b>{uiText("查看")}{creativeLibrary?.assetCount ?? "…"} {uiText("份 →")}</b>
      </button>}
      {onBatchAutoEdit && <details className="media-more">
        <summary>{uiText("一次剪很多支影片")}</summary>
        <div className="batch-entry">
          <button type="button" className="batch-start-button" onClick={onBatchAutoEdit} data-testid="batch-auto-edit-button">
            <b aria-hidden="true">✦</b><span><strong>{uiText("開始批次粗剪")}</strong><small>{uiText("逐支整理素材，保留可編輯時間軸")}</small></span>
          </button>
          {batchSummary && <button type="button" className="batch-resume-button" onClick={onOpenBatch}>
            <span>{batchSummary.running ? uiText("處理中") : uiText("{value0}/{value1} 完成", { value0: batchSummary.completed, value1: batchSummary.total })}</span>
            <small>{batchSummary.failed ? uiText("{value0} 支可重試", { value0: batchSummary.failed }) : uiText("查看批次工作")}</small>
          </button>}
        </div>
      </details>}
      <ProjectMediaSearchControls filter={mediaFilter} found={mediaResult.items.length} total={userAssets.length} error={mediaResult.error} onChange={setMediaFilter} />
      <div className="asset-list" ref={assetScrollRef} data-testid="user-asset-list" data-wheel-scroll="vertical" tabIndex={0} aria-label={uiText("專案素材，可捲動瀏覽")} onScroll={(event) => setAssetScrollTop(event.currentTarget.scrollTop)}>
        {userAssets.length === 0 && <div className="asset-list-empty"><b>{uiText("這裡只放你的素材")}</b><span>{uiText("上方的彩色畫面是操作示範，不會算進專案，也不能誤輸出。")}</span></div>}
        {userAssets.length > 0 && mediaResult.items.length === 0 && !mediaResult.error && <div className="asset-list-empty" data-testid="project-media-search-empty"><b>{uiText("沒有找到符合的素材")}</b><span>{uiText("換個關鍵字或清除篩選，再繼續找。")}</span></div>}
        {assetWindow.before > 0 && <div aria-hidden="true" className="library-spacer" style={{ height: assetWindow.before }} />}
        {assetWindow.items.map((asset) => (
          <div className="asset-row" key={asset.id} draggable={false} data-asset-id={asset.id} data-pointer-asset-drag="true" style={{ cursor: "grab", touchAction: "none" }} title={uiText("拖到時間軸指定影格；與同軌片段重疊時保留落點並新增相容軌道")} onDragStart={(event) => event.preventDefault()} onPointerDown={(event) => {
            const cleanup = startInternalAssetPointerDrag(event, { assetId: asset.id, onStart: onAssetDragStart,
              onEnd: () => { assetDragCleanupRef.current = undefined; onAssetDragEnd?.(); } });
            if (cleanup) assetDragCleanupRef.current = cleanup;
          }}>
            <div className={`asset-thumb ${asset.kind}`}>
              {runtimeUrls[`${asset.id}:thumbnail`] || runtimeUrls[`${asset.id}:waveform`] ? <img src={runtimeUrls[`${asset.id}:thumbnail`] ?? runtimeUrls[`${asset.id}:waveform`]} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className="asset-thumb-fallback">{uiText(KIND_FALLBACK[asset.kind])}</span>}
            </div>
            <div className="asset-copy">
              <strong title={asset.name}>{asset.name}</strong>
              <span>{uiText(KIND_FALLBACK[asset.kind])} · {formatTime(asset.duration)}</span>
            </div>
            <div className="asset-row-actions"><button type="button" onClick={() => onAddAssetToTimeline?.(asset.id)} aria-label={uiText("把 {value0} 加入時間軸", { value0: asset.name })}>{uiText("＋ 加入")}</button>{asset.kind !== "audio" && <button type="button" className="pip" onClick={() => onAddAssetAsPictureInPicture?.(asset.id)} aria-label={uiText("把 {value0} 加入畫中畫", { value0: asset.name })}>{uiText("▣ 畫中畫")}</button>}</div>
          </div>
        ))}
        {assetWindow.after > 0 && <div aria-hidden="true" className="library-spacer" style={{ height: assetWindow.after }} />}
      </div>
      </> : tab === "library" ? <Suspense fallback={<div className="creative-library"><small>{uiText("正在載入素材預覽…")}</small></div>}><CreativeLibraryBrowser
        library={creativeLibrary}
        loading={creativeLoading}
        importingId={creativeImportingId}
        previewingId={creativePreviewingId}
        onImport={onCreativeImport}
        onAudioPreview={onCreativePreview}
        onResolvePreview={onCreativeResolve}
        onLoadOriginalSfxCandidates={onLoadOriginalSfxCandidates}
        onAutoMusic={onAutoMusic}
      /></Suspense> : tab === "templates" ? <Suspense fallback={<div className="creative-library"><small>{uiText("正在載入成片模板…")}</small></div>}><ShortFormTemplateBrowser onApplyShort={(templateId, content) => onApplyShortTemplate?.(templateId, content)} assets={assets} sourceAssetId={templateSourceAssetId} project={templateProject} selectedClipId={templateSourceClipId} onApplyThemedTemplate={onApplyThemedTemplate} motionBusy={templateMotionBusy} onCancelMotion={onCancelTemplateMotion} fps={templateFps} canvasFormat={templateCanvasFormat} onApplyLong={(templateId) => onApplyLongTemplate?.(templateId)} onAddLowerThird={onAddLowerThird} motionGraphics={motionGraphics ?? []} captions={captions ?? []} directorMarkers={directorMarkers ?? []} templateApplication={templateApplication} onDeleteMotionGraphic={onDeleteMotionGraphic} onDeleteCaption={onDeleteCaption} onDeleteDirectorMarker={onDeleteDirectorMarker} onClearTemplateApplication={onClearTemplateApplication} /></Suspense> : <Suspense fallback={<div className="creative-library"><small>{uiText("正在載入外掛工具…")}</small></div>}><PluginBrowser registry={pluginRegistry} loading={pluginLoading} busyId={pluginBusyId} hasSelectedClip={hasSelectedClip} onApply={onApplyPlugin} onOpenFolder={onOpenPluginFolder} onRefresh={onRefreshPlugins} workflowProfile={workflowProfile} onWorkflowProfileChange={onWorkflowProfileChange} /></Suspense>}
      <div className="privacy-note"><span>✓</span> {uiText("素材只留在你的電腦")}</div>
    </aside>
  );
}

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CreativeLibrarySummary } from "../application/creativeLibrary";
import type { PluginRegistrySummary } from "../desktop/types";
import type { CaptionCue, DirectorMarker, MediaAsset, TemplateApplicationState } from "../domain/types";
import type { EditkinWorkflowProfile } from "../plugins/skillPack";
import type { LowerThirdPresetId } from "../application/lowerThirds";
import type { MotionGraphic } from "../domain/types";
import { formatTime } from "../lib/format";
import { libraryWindow } from "./creativeLibraryPreview";
import { useNativeWheelScroll } from "./wheelScroll";
import "./mediaBinStates.css";

interface MediaBinProps {
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
  onAutoMusic?: () => void;
  onBatchAutoEdit?: () => void;
  batchSummary?: { total: number; completed: number; failed: number; running: boolean };
  onOpenBatch?: () => void;
  onAddAssetToTimeline?: (assetId: string) => void;
  onAddAssetAsPictureInPicture?: (assetId: string) => void;
  onApplyShortTemplate?: (templateId: string) => void;
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

export function MediaBin({ assets, runtimeUrls, onImport, onDesktopImport, creativeLibrary, creativeLoading, onCreativeImport, creativeImportingId, creativePreviewingId, onCreativePreview, onCreativeResolve, onAutoMusic, onBatchAutoEdit, batchSummary, onOpenBatch, onAddAssetToTimeline, onAddAssetAsPictureInPicture, onApplyShortTemplate, onApplyLongTemplate, onAddLowerThird, motionGraphics, captions, directorMarkers, templateApplication, onDeleteMotionGraphic, onDeleteCaption, onDeleteDirectorMarker, onClearTemplateApplication, pluginRegistry, pluginLoading, pluginBusyId, hasSelectedClip = false, onApplyPlugin, onOpenPluginFolder, onRefreshPlugins, workflowProfile, onWorkflowProfileChange }: MediaBinProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const assetScrollRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"project" | "library" | "templates" | "plugins">("project");
  const [assetScrollTop, setAssetScrollTop] = useState(0);
  const [assetViewportHeight, setAssetViewportHeight] = useState(600);
  useNativeWheelScroll(assetScrollRef, "vertical", tab);
  const userAssets = useMemo(() => assets.filter((asset) => asset.id !== "asset-demo"), [assets]);
  const userAssetIdentity = useMemo(() => userAssets.map((asset) => asset.id).join("\u0000"), [userAssets]);
  const assetWindow = libraryWindow(userAssets, assetScrollTop, assetViewportHeight, PROJECT_ASSET_ROW_HEIGHT, 16);
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
  useEffect(() => { setAssetScrollTop(0); if (assetScrollRef.current) assetScrollRef.current.scrollTop = 0; }, [userAssetIdentity]);
  const chooseMedia = () => onDesktopImport ? onDesktopImport() : inputRef.current?.click();
  return (
    <aside className="panel media-bin" aria-label="加入素材">
      <div className="panel-title">
        <div>
          <span className="eyebrow">專案內容</span>
          <h2>素材</h2>
        </div>
        <button type="button" className="add-button" onClick={chooseMedia} aria-label="加入更多素材">＋</button>
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
      <div className="media-tabs" role="tablist" aria-label="素材來源">
        <button type="button" role="tab" aria-selected={tab === "project"} onClick={() => setTab("project")} data-user-asset-count={userAssets.length} title="我的素材">專案 <b>{userAssets.length}</b></button>
        {onCreativeImport && <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")} data-testid="asset-library-tab" title="內建素材庫">素材</button>}
        {onApplyShortTemplate && onApplyLongTemplate && <button type="button" role="tab" aria-selected={tab === "templates"} onClick={() => setTab("templates")} data-testid="short-template-tab" title="成片模板">模板</button>}
        {onApplyPlugin && <button type="button" role="tab" aria-selected={tab === "plugins"} onClick={() => setTab("plugins")} data-testid="plugin-tab" title={`外掛工具 ${pluginCapabilityCount ?? ""}`}>工具</button>}
      </div>
      {tab === "project" ? <>
      <button type="button" className={`import-drop${userAssets.length ? " has-media" : ""}`} onClick={chooseMedia} data-testid="import-media-button" data-beginner-action="加入素材">
        <span className="import-icon" aria-hidden="true">＋</span>
        <strong>{userAssets.length ? "加入更多素材" : "加入素材"}</strong>
        <small>選擇檔案，或拖入這個視窗</small>
      </button>
      {onCreativeImport && <button type="button" className="library-discovery" onClick={() => setTab("library")} data-testid="asset-preview-entry">
        <span className="library-discovery-visuals" aria-hidden="true"><i>▶</i><i>♫</i><i>▧</i></span>
        <span><strong>打開素材庫預覽</strong><small>補充鏡頭、轉場、音樂與圖片；先預覽，再加入</small></span>
        <b>查看 {creativeLibrary?.assetCount ?? "…"} 份 →</b>
      </button>}
      {onBatchAutoEdit && <details className="media-more">
        <summary>一次剪很多支影片</summary>
        <div className="batch-entry">
          <button type="button" className="batch-start-button" onClick={onBatchAutoEdit} data-testid="batch-auto-edit-button">
            <b aria-hidden="true">✦</b><span><strong>開始批次粗剪</strong><small>逐支整理素材，保留可編輯時間軸</small></span>
          </button>
          {batchSummary && <button type="button" className="batch-resume-button" onClick={onOpenBatch}>
            <span>{batchSummary.running ? "處理中" : `${batchSummary.completed}/${batchSummary.total} 完成`}</span>
            <small>{batchSummary.failed ? `${batchSummary.failed} 支可重試` : "查看批次工作"}</small>
          </button>}
        </div>
      </details>}
      <div className="asset-list" ref={assetScrollRef} data-testid="user-asset-list" data-wheel-scroll="vertical" tabIndex={0} aria-label="專案素材，可捲動瀏覽" onScroll={(event) => setAssetScrollTop(event.currentTarget.scrollTop)}>
        {userAssets.length === 0 && <div className="asset-list-empty"><b>這裡只放你的素材</b><span>上方的彩色畫面是操作示範，不會算進專案，也不能誤輸出。</span></div>}
        {assetWindow.before > 0 && <div aria-hidden="true" className="library-spacer" style={{ height: assetWindow.before }} />}
        {assetWindow.items.map((asset) => (
          <div className="asset-row" key={asset.id}>
            <div className={`asset-thumb ${asset.kind}`}>
              {runtimeUrls[`${asset.id}:thumbnail`] || runtimeUrls[`${asset.id}:waveform`]
                ? <img src={runtimeUrls[`${asset.id}:thumbnail`] ?? runtimeUrls[`${asset.id}:waveform`]} alt="" loading="lazy" decoding="async" />
                : <span className="asset-thumb-fallback">{KIND_FALLBACK[asset.kind]}</span>}
            </div>
            <div className="asset-copy">
              <strong title={asset.name}>{asset.name}</strong>
              <span>{KIND_LABEL[asset.kind]} · {formatTime(asset.duration)}</span>
            </div>
            <div className="asset-row-actions"><button type="button" onClick={() => onAddAssetToTimeline?.(asset.id)} aria-label={`把 ${asset.name} 加入時間軸`}>＋ 加入</button>{asset.kind !== "audio" && <button type="button" className="pip" onClick={() => onAddAssetAsPictureInPicture?.(asset.id)} aria-label={`把 ${asset.name} 加入畫中畫`}>▣ 畫中畫</button>}</div>
          </div>
        ))}
        {assetWindow.after > 0 && <div aria-hidden="true" className="library-spacer" style={{ height: assetWindow.after }} />}
      </div>
      </> : tab === "library" ? <Suspense fallback={<div className="creative-library"><small>正在載入素材預覽…</small></div>}><CreativeLibraryBrowser
        library={creativeLibrary}
        loading={creativeLoading}
        importingId={creativeImportingId}
        previewingId={creativePreviewingId}
        onImport={onCreativeImport}
        onAudioPreview={onCreativePreview}
        onResolvePreview={onCreativeResolve}
        onAutoMusic={onAutoMusic}
      /></Suspense> : tab === "templates" ? <Suspense fallback={<div className="creative-library"><small>正在載入成片模板…</small></div>}><ShortFormTemplateBrowser onApplyShort={(templateId) => onApplyShortTemplate?.(templateId)} onApplyLong={(templateId) => onApplyLongTemplate?.(templateId)} onAddLowerThird={onAddLowerThird} motionGraphics={motionGraphics ?? []} captions={captions ?? []} directorMarkers={directorMarkers ?? []} templateApplication={templateApplication} onDeleteMotionGraphic={onDeleteMotionGraphic} onDeleteCaption={onDeleteCaption} onDeleteDirectorMarker={onDeleteDirectorMarker} onClearTemplateApplication={onClearTemplateApplication} /></Suspense> : <Suspense fallback={<div className="creative-library"><small>正在載入外掛工具…</small></div>}><PluginBrowser registry={pluginRegistry} loading={pluginLoading} busyId={pluginBusyId} hasSelectedClip={hasSelectedClip} onApply={onApplyPlugin} onOpenFolder={onOpenPluginFolder} onRefresh={onRefreshPlugins} workflowProfile={workflowProfile} onWorkflowProfileChange={onWorkflowProfileChange} /></Suspense>}
      <div className="privacy-note"><span>✓</span> 素材只留在你的電腦</div>
    </aside>
  );
}

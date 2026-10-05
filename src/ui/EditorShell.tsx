import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { ActivePreviewLayer } from "../application/previewMedia";
import { selectAutomaticMusicAsset } from "../creative/musicSelection";
import { buildCaptionTrimCommand, buildClipTrimCommand } from "../application/timelineTrim";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import type { useAutomaticEditing } from "../desktop/useAutomaticEditing";
import type { useBatchAutoEdit } from "../desktop/useBatchAutoEdit";
import type { useCreativeLibrary } from "../desktop/useCreativeLibrary";
import type { useDesktopActions } from "../desktop/useDesktopActions";
import type { useMobileRemote } from "../desktop/useMobileRemote";
import type { useProjectRecovery } from "../desktop/useProjectRecovery";
import { useResidentGpuPreview, type NativePreviewBounds } from "../desktop/useResidentGpuPreview";
import type { NativeAudioTransportState } from "../desktop/useNativeAudioPreviewPlayback";
import { useNativeEffectPreview } from "../desktop/useNativeEffectPreview";
import { useRemoteAgentLaunch } from "../desktop/useRemoteAgentLaunch";
import type { EditorCommand } from "../domain/commands";
import { animatedClipState, findClip } from "../domain/editGraph";
import { createClipMask, resolveMaskPath } from "../domain/masks";
import type { EditorHistory } from "../domain/history";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { motionClipPresetCommands } from "../motion/motionClipPresets";
import { floatingFrameSceneCommands } from "../motion/floatingFrameScenes";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "../application/referenceMotionTemplateInstances";
import { prepareReferenceMotionTemplateReuse } from "../application/referenceMotionTemplateReuse";
import type { CaptionCue, ClipLayout, EditProject, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";
import type { EditorTheme } from "./theme";
import { Toolbar } from "./Toolbar";
import { WorkspaceControls } from "./WorkspaceControls";
import { OperationStatus } from "./OperationStatus";
import { ProjectDownloadNotice } from "./ProjectDownloadNotice";
import { SavedReferenceMotionInstances, runReferenceMotionUiPreparation, type ReferenceMotionUiPreparationOptions } from "./SavedReferenceMotionInstances";
import { SavedOriginalMotionScenes } from "./SavedOriginalMotionScenes";
import { prepareOriginalSceneGraphicRevision } from "../application/originalSceneGraphicRevision";
import { MediaImportStatus } from "./MediaImportStatus";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle";
import { useWorkspaceLayout } from "./workspaceLayout";
import { autoRotoRuntimeStatusFromReceipt, initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { runAutoRotoAction } from "../application/runAutoRotoAction";
import { acceptProjectTask } from "../application/projectTask";
import { PROJECT_FORMATS, projectFormatLabel } from "../application/projectFormats";
import { planTimelineClipMove } from "../application/timelinePlacement";
import { resolveTimelineImportPlacement } from "./internalAssetPointerDrag";
import type { ProjectTask } from "../application/projectSession";
import "./layoutHardening.css";
import "./projectFormatControl.css";
import "./mediaImportStatus.css";

import { AgentConnectModal, AutoEditDialog, AgentPanel, BatchAutoEditPanel, BeginnerGuide, ColorWorkspace, DirectorConsole, EditingProfilePicker, FirstProjectStart, Inspector, MediaBin, MobileConnectModal, Preview, Timeline, WorkspaceDropImport, BEGINNER_GUIDE_KEY } from "./editorShellLazy";
import type { EditorShellProps, TrackingMode } from "./editorShellTypes";
export type { TrackingMode } from "./editorShellTypes";

export function EditorShell(props: EditorShellProps) {
  const [colorWorkspaceOpened, setColorWorkspaceOpened] = useState(false);
  const [directorConsoleOpened, setDirectorConsoleOpened] = useState(false);
  const [demoWorkspaceOpened, setDemoWorkspaceOpened] = useState(false);
  const [agentConnectOpened, setAgentConnectOpened] = useState(false);
  const [returnToRemoteAfterAgent, setReturnToRemoteAfterAgent] = useState(false);
  const [autoEditOpened, setAutoEditOpened] = useState(false);
  const [draggingAssetId, setDraggingAssetId] = useState<string>();
  const autoEditTarget = useRef<{ task: ProjectTask; clipId: string } | undefined>(undefined);
  const [autoRotoBusy, setAutoRotoBusy] = useState(false);
  const autoRotoBusyRef = useRef(false);
  const [referenceTemplateBusy, setReferenceTemplateBusy] = useState(false);
  const referenceTemplateOperation = useRef<AbortController | undefined>(undefined);
  const referenceTemplateMounted = useRef(true);
  useEffect(() => {
    referenceTemplateMounted.current = true;
    return () => { referenceTemplateMounted.current = false; referenceTemplateOperation.current?.abort(); };
  }, []);
  const [autoRotoRuntimeStatus, setAutoRotoRuntimeStatus] = useState(() => initialAutoRotoRuntimeStatus(window.haoDesktop?.analyzeAutoRoto));
  const [beginnerGuideOpened, setBeginnerGuideOpened] = useState(() => window.localStorage.getItem(BEGINNER_GUIDE_KEY) !== "done");
  const workspace = useWorkspaceLayout();
  const {
    history, project, duration, theme, setTheme, isDesktop, playhead, setPlayhead, seekRevision, onPlaybackClock, playing, setPlaying,
    playbackRate, setPlaybackRate, togglePlayback, pausePlayback, shuttlePlayback, frameStepPlayback,
    selectedClipId, setSelectedClipId, selectedCaptionId, setSelectedCaptionId, selectedClip,
    selectedClipAtPlayhead, selectedCaption, transitionNeighbors, selectedMotionTracks, activeLayers,
    activeAudioLayers, runtimeUrls, missingMedia, relinkBrowserMedia, projectDownload, cancelProjectDownload, status, setStatus, trackingMode, setTrackingMode, trackingSelection,
    setTrackingSelection, trackingBusy, recovery, desktopActions, automatic, creativeLibrary, batchAutoEdit, mobile,
    newProject, openProject, saveProject, undoEdit, redoEdit, renderVideo, renderOpenExrSequence, renderAlphaMaster, importFiles,
    acceptTrackingSelection, startPodcastDirector, submitAgentInstruction, runCommand, updateAnimatedClipProperty,
    addMotionGraphic, addCaption, addTrack, addAssetToTimeline, makeSelectedPictureInPicture, precomposeSelected, applyShortFormTemplate, applyLongFormTemplate, addLowerThird, clearTemplateApplication, splitSelected, deleteSelected,
  } = props;
  const clipSourceTask = props.projectSession.beginTask(project);
  const clipSourceSessionId = props.projectSession.getSnapshot().sessionId;
  const moveTimelineClip = (clipId: string, timelineStart?: number, trackId?: string) => {
    try {
      const currentProject = props.projectSession.getSnapshot().history.present;
      const currentClip = findClip(currentProject, clipId);
      const placement = planTimelineClipMove(currentProject, clipId, trackId ?? currentClip.trackId,
        timelineStart ?? currentClip.timelineStart, makeId);
      return runCommand(placement.command, placement.newLayer
        ? "已移到指定影格並新增圖層；原片段保留，一次復原即可還原。"
        : "已移到指定影格，可復原。");
    } catch (error) { setStatus(error instanceof Error ? error.message : "無法移動片段。"); return false; }
  };
  useEffect(() => { referenceTemplateOperation.current?.abort(); }, [selectedClipId]);
  const cancelReferenceTemplate = () => {
    if (!referenceTemplateOperation.current) return;
    referenceTemplateOperation.current.abort();
    setStatus("正在取消模板準備；現有圖層未變更。");
  };
  const prepareReferenceInstance = (prepare: ReferenceMotionUiPreparationOptions["prepare"]) => {
    if (referenceTemplateOperation.current) return;
    pausePlayback();
    const controller = new AbortController(); referenceTemplateOperation.current = controller;
    setReferenceTemplateBusy(true); setStatus("正在核對實體字型並重新編譯 Motion 模板；完成後一次套用。");
    void runReferenceMotionUiPreparation({ project, session: props.projectSession, controller, prepare,
      action: "Motion 模板準備", isMounted: () => referenceTemplateMounted.current, onStatus: setStatus, onCommand: runCommand,
    }).finally(() => {
      if (referenceTemplateOperation.current === controller) {
        referenceTemplateOperation.current = undefined;
        if (referenceTemplateMounted.current) setReferenceTemplateBusy(false);
      }
    });
  };
  // The browser build has no local Whisper/FFmpeg/Rust engines; say so up front instead of failing after a click.
  const engineUnavailableReason = isDesktop ? undefined : "網頁版沒有本機 Whisper／FFmpeg 引擎，這項功能需要桌面版。";
  const selectedAsset = selectedClip ? project.assets.find((asset) => asset.id === selectedClip.assetId) : undefined;
  const hasUserMedia = project.assets.some((asset) => asset.id !== "asset-demo");
  const hasAuthoredGraph = project.motionGraphics.length > 0 || (project.motionScenes?.length ?? 0) > 0 || project.captions.length > 0;
  const showWelcome = !hasUserMedia && !hasAuthoredGraph && !demoWorkspaceOpened;
  const [nativePreviewBounds, setNativePreviewBounds] = useState<NativePreviewBounds>();
  const [audioTransport, setAudioTransport] = useState<NativeAudioTransportState>();
  const latestSeekRevision = useRef(seekRevision);
  latestSeekRevision.current = seekRevision;
  const publishPlaybackClock = useCallback((time: number) => {
    onPlaybackClock(Math.max(0, Math.min(duration, time)), seekRevision);
  }, [onPlaybackClock, duration, seekRevision]);
  const finishPlayback = useCallback(() => {
    if (latestSeekRevision.current === seekRevision) setPlaying(false);
  }, [seekRevision, setPlaying]);
  const updateAudioTransport = useCallback((next: NativeAudioTransportState) => {
    setAudioTransport(current => current?.mode === next.mode && current.generation === next.generation
      && current.ownerId===next.ownerId
      && current.seekRevision === next.seekRevision
      && current.projectId === next.projectId && current.projectRevision === next.projectRevision
      && current.projectUpdatedAt === next.projectUpdatedAt ? current : next);
  }, []);
  const updateNativePreviewBounds = useCallback((bounds: Omit<NativePreviewBounds, "revision">) => {
    setNativePreviewBounds((current) => ({ ...bounds, revision: (current?.revision ?? 0) + 1 }));
  }, []);
  const gpuPreview = useResidentGpuPreview(
    project,
    playhead,
    isDesktop && !showWelcome && !trackingMode && playbackRate === 1,
    nativePreviewBounds,
    { playing, duration, seekRevision, audio: audioTransport, onClock: publishPlaybackClock, onEnded: finishPlayback },
  );
  const nativeEffectPreview = useNativeEffectPreview(
    window.haoDesktop,
    project,
    activeLayers,
    isDesktop && !showWelcome && !trackingMode,
  );
  const remoteAgentLaunch = useRemoteAgentLaunch(window.haoDesktop);
  const workspaceColumns = useMemo(() => [
    workspace.layout.mediaVisible && !directorConsoleOpened ? `${workspace.layout.mediaWidth}px 8px` : "",
    "minmax(360px,1fr)",
    directorConsoleOpened ? "8px minmax(340px,440px)" : workspace.layout.inspectorVisible ? `8px ${workspace.layout.inspectorWidth}px` : "",
  ].filter(Boolean).join(" "), [directorConsoleOpened, workspace.layout.inspectorVisible, workspace.layout.inspectorWidth, workspace.layout.mediaVisible, workspace.layout.mediaWidth]);
  const shellStyle = {
    "--timeline-height": workspace.layout.timelineVisible ? `${workspace.layout.timelineHeight}px` : "0px",
  } as CSSProperties;
  const importState=creativeLibrary.importState;
  const importActive=Boolean(importState&&importState.phase!=="idle"&&importState.sessionId===props.projectSession.getSnapshot().sessionId);
  const relinkActive = !showWelcome && !isDesktop && missingMedia.length > 0;
  const closeBeginnerGuide = () => {
    window.localStorage.setItem(BEGINNER_GUIDE_KEY, "done");
    setBeginnerGuideOpened(false);
  };
  const openAgentConnect = (returnToRemote = false) => {
    closeBeginnerGuide();
    setReturnToRemoteAfterAgent(returnToRemote);
    setAgentConnectOpened(true);
  };
  const shortcutsBlocked = beginnerGuideOpened || colorWorkspaceOpened || (directorConsoleOpened && showWelcome) || batchAutoEdit.show || mobile.showConnect || agentConnectOpened || autoEditOpened;
  const closeAgentConnect = () => {
    setAgentConnectOpened(false);
    if (!returnToRemoteAfterAgent) return;
    setReturnToRemoteAfterAgent(false);
    void mobile.open();
  };
  const openAutoEdit = () => {
    if (project.editorialProfile === "music_mv") {
      openAgentConnect();
      setStatus("動畫 MV 會先規劃歌曲樂段與原創插畫分層，再交給 Editkin 建立可編輯鏡頭。");
      return;
    }
    if (automatic.semantic.busy) return;
    if (!selectedClip) return setStatus("請先選一段要粗剪的影片或聲音。");
    autoEditTarget.current = { task: props.projectSession.beginTask(project), clipId: selectedClip.id };
    setAutoEditOpened(true);
  };

  // Only shell-local help navigation belongs here. App/useEditorShortcuts is
  // the single owner of save, history, editing and playback shortcuts.
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (beginnerGuideOpened) {
        if (event.key === "Escape") { event.preventDefault(); closeBeginnerGuide(); }
        return;
      }
      if (shortcutsBlocked || target?.closest("input,textarea,select,button,[contenteditable]:not([contenteditable='false'])")) return;
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setBeginnerGuideOpened(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [beginnerGuideOpened, shortcutsBlocked]);

  const runAutoRoto = (maskId: string, sourceProject = project) => runAutoRotoAction({
    projectSession: props.projectSession, project: sourceProject, clipId: selectedClipId, maskId, playhead,
    analyze: window.haoDesktop?.analyzeAutoRoto, busy: autoRotoBusyRef,
    onBusy: setAutoRotoBusy, onPlaying: setPlaying, onStatus: setStatus,
    validateResult: autoRotoRuntimeStatusFromReceipt, onRuntimeStatus: setAutoRotoRuntimeStatus, onCommand: runCommand,
  });

  const runQuickAutoRoto = () => {
    if (autoRotoBusyRef.current || !acceptProjectTask(props.projectSession.beginTask(project), setStatus, "動態去背")) return;
    if (!selectedClip || !selectedAsset || selectedAsset.kind !== "video") return setStatus("動態去背需要先選一段影片。");
    const existing = selectedClip.masks?.find((mask) => mask.kind === "subject");
    if (existing) {
      if (!existing.enabled) runCommand({ type: "update_clip_mask", clipId: selectedClip.id, maskId: existing.id, patch: { enabled: true } });
      void runAutoRoto(existing.id, props.projectSession.getSnapshot().history.present);
      return;
    }
    const mask = createClipMask(makeId("mask"), "subject");
    runCommand({ type: "add_clip_mask", clipId: selectedClip.id, mask }, "已建立中央主體範圍，開始逐格動態去背。");
    void runAutoRoto(mask.id, props.projectSession.getSnapshot().history.present);
  };

  return (
    <main className="app-shell" data-import-active={importActive} data-workspace-notice={importActive || relinkActive} data-shortcuts-blocked={shortcutsBlocked} data-workspace-mode={showWelcome ? "welcome" : "editor"} data-text-size={workspace.layout.textSize} style={shellStyle}>
      <Suspense fallback={null}><WorkspaceDropImport
        onBrowserFiles={(files, point) => {
          try { void importFiles(files, point ? resolveTimelineImportPlacement(point, document) : undefined); }
          catch (error) { setStatus(error instanceof Error ? error.message : "這個位置無法匯入素材。"); }
        }}
        onDesktopPaths={isDesktop ? (paths, point) => {
          try { void creativeLibrary.importDesktopPaths(paths, point ? resolveTimelineImportPlacement(point, document) : undefined); }
          catch (error) { setStatus(error instanceof Error ? error.message : "這個位置無法匯入素材。"); }
        } : undefined}
        onStatus={setStatus}
      /></Suspense>
      <Toolbar
        projectName={project.name}
        hasUserMedia={hasUserMedia}
        workspaceMode={showWelcome ? "welcome" : "editor"}
        theme={theme}
        onThemeChange={setTheme}
        dirty={recovery.dirty}
        recoveryState={recovery.recoveryState}
        playhead={playhead}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        isDesktop={isDesktop}
        onNew={() => { setDemoWorkspaceOpened(false); newProject(); }}
        onOpen={openProject}
        onSave={() => void saveProject()}
        onUndo={undoEdit}
        onRedo={redoEdit}
        onExport={renderVideo}
        onExportOpenExrSequence={() => void renderOpenExrSequence()}
        onExportAlphaMaster={() => void renderAlphaMaster()}
        onOpenAgentConnect={() => openAgentConnect()}
        onAutoEdit={openAutoEdit}
        autoEditLabel={project.editorialProfile === "music_mv" ? "製作 Music MV" : undefined}
        autoEditBusy={automatic.semantic.busy}
        autoEditUnavailableReason={engineUnavailableReason}
        onMobileRemote={window.haoDesktop?.startMobileRemote ? () => void mobile.open() : undefined}
        mobileRemoteActive={mobile.remote?.active}
        mobileRemoteCount={mobile.remoteStatus?.connectedCount}
        onCheckUpdates={desktopActions.checkForUpdates}
        onDirectorConsole={() => setDirectorConsoleOpened(true)}
        onHelp={() => setBeginnerGuideOpened(true)}
        workspaceControls={<WorkspaceControls layout={workspace.layout} onPreset={workspace.choosePreset} onPatch={workspace.patch} onReset={workspace.reset} />}
      />
      {(importActive || relinkActive) && <div className="workspace-notices">
        {importActive&&importState?<MediaImportStatus state={importState} onRetry={()=>void creativeLibrary.retryFailedImports()}/>:null}
        {relinkActive && <section className="media-import-status" data-testid="missing-media-relink" aria-label="缺失素材重新連結">
          <div><strong>專案已開啟，請重新連結素材</strong><span>逐一選取原檔；瀏覽器重開後需再次選檔。</span></div>
          {missingMedia.map(asset => <button key={asset.id} type="button" className="secondary-action" data-testid={`relink-media-${asset.id}`} onClick={() => void relinkBrowserMedia(asset.id)} disabled={Boolean(asset.imageSequence)} title={asset.imageSequence ? "OpenEXR 序列需要桌面版" : `為 ${asset.name} 選取原始檔案`}>{asset.name} · 重新連結</button>)}
        </section>}
      </div>}
      {showWelcome ? <Suspense fallback={<section className="first-project-loading" aria-label="正在準備開始畫面" />}><FirstProjectStart
        isDesktop={isDesktop}
        onImport={importFiles}
        onDesktopImport={isDesktop ? () => void creativeLibrary.importDesktopMedia() : undefined}
        onOpenProject={() => void openProject()}
        onExploreDemo={() => setDemoWorkspaceOpened(true)}
        onHelp={() => setBeginnerGuideOpened(true)}
        onConnectAgent={isDesktop ? () => openAgentConnect() : undefined}
      /></Suspense> : <>
      <section className="workspace-grid" style={{ gridTemplateColumns: workspaceColumns }} data-testid="modular-workspace">
        {!hasUserMedia && !hasAuthoredGraph && <div className="demo-workspace-banner" data-testid="demo-workspace-banner"><b>示範模式</b><span>{isDesktop ? "先熟悉介面；加入自己的影片後才會啟用自動剪輯與輸出" : "先熟悉介面；加入自己的影片後可手動剪輯並下載專案檔。自動剪輯與影片輸出需要桌面版"}</span></div>}
        {workspace.layout.mediaVisible && !directorConsoleOpened && <><Suspense fallback={<aside className="panel media-bin" aria-label="正在載入素材面板" />}><MediaBin
          assets={project.assets}
          runtimeUrls={runtimeUrls}
          onImport={importFiles}
          onDesktopImport={isDesktop ? () => void creativeLibrary.importDesktopMedia() : undefined}
          creativeLibrary={creativeLibrary.library}
          creativeLoading={creativeLibrary.loading}
          onCreativeImport={isDesktop ? (assetId) => void creativeLibrary.importCreativeAsset(assetId) : undefined}
          creativeImportingId={creativeLibrary.importingId}
          creativePreviewingId={creativeLibrary.previewingId}
          onCreativePreview={isDesktop ? (assetId) => void creativeLibrary.previewCreativeAsset(assetId) : undefined}
          onCreativeResolve={isDesktop ? creativeLibrary.resolveCreativeAssetPreview : undefined}
          onAutoMusic={isDesktop ? () => {
            const selected = selectAutomaticMusicAsset(creativeLibrary.library?.assets ?? [], { projectName: project.name, duration });
            if (!selected) return setStatus("音樂庫尚未就緒，或找不到符合的曲目。");
            setStatus(`已選出「${selected.name}」${selected.bpm ? ` · ${Math.round(selected.bpm)} BPM` : ""}，正在加入配樂…`);
            void creativeLibrary.importCreativeAsset(selected.id);
          } : undefined}
          onBatchAutoEdit={isDesktop ? () => void batchAutoEdit.start(project.editorialProfile) : undefined}
          batchSummary={batchAutoEdit.summary}
          onOpenBatch={() => batchAutoEdit.setShow(true)}
          onAddAssetToTimeline={(assetId) => addAssetToTimeline(assetId, "timeline")}
          onAddAssetAsPictureInPicture={(assetId) => addAssetToTimeline(assetId, "pip")}
          onAssetDragStart={setDraggingAssetId}
          onAssetDragEnd={() => setDraggingAssetId(undefined)}
          onApplyShortTemplate={(templateId, content) => void applyShortFormTemplate(templateId, content)}
          templateSourceAssetId={[...project.tracks.filter(track => track.kind === "video").flatMap(track => track.clips)].sort((a, b) => a.timelineStart - b.timelineStart)[0]?.assetId}
          templateFps={project.fps}
          templateCanvasFormat={project.width > project.height ? "long" : "short"}
          onApplyLongTemplate={(templateId) => void applyLongFormTemplate(templateId)}
          onAddLowerThird={addLowerThird}
          motionGraphics={project.motionGraphics}
          captions={project.captions}
          directorMarkers={project.director.markers}
          templateApplication={project.templateApplication}
          onDeleteMotionGraphic={(graphicId) => runCommand({ type: "delete_motion_graphic", graphicId }, "已刪除這個動態字卡，可復原。")} 
          onDeleteCaption={(captionId) => runCommand({ type: "delete_caption", captionId }, "已刪除模板示範字幕，可復原。")} 
          onDeleteDirectorMarker={(markerId) => runCommand({ type: "delete_director_marker", markerId }, "已刪除模板節奏註記，可復原。")} 
          onClearTemplateApplication={clearTemplateApplication}
          pluginRegistry={creativeLibrary.plugins}
          pluginLoading={creativeLibrary.pluginLoading}
          pluginBusyId={creativeLibrary.pluginBusy}
          hasSelectedClip={Boolean(selectedClip)}
          onApplyPlugin={isDesktop ? (pluginId, capabilityId, parameters) => {
            const capability = creativeLibrary.plugins?.plugins.find((plugin) => plugin.id === pluginId)?.capabilities.find((item) => item.id === capabilityId);
            const projectOnly = capability?.runtimeType === "editgraph_commands"
              && capability.commandScopes.length > 0
              && capability.commandScopes.every((scope) => scope === "project");
            if (!selectedClip && !projectOnly) return setStatus("先在時間軸選一個片段，再套用這個外掛工具。");
            void creativeLibrary.invokePluginTool(pluginId, capabilityId, selectedClip?.id ?? project.id, parameters);
          } : undefined}
          onOpenPluginFolder={isDesktop ? () => void creativeLibrary.openPluginFolder() : undefined}
          onRefreshPlugins={isDesktop ? () => void creativeLibrary.refreshPlugins() : undefined}
          workflowProfile={creativeLibrary.workflowProfile}
          onWorkflowProfileChange={isDesktop ? creativeLibrary.updateWorkflowProfile : undefined}
        /></Suspense><WorkspaceResizeHandle axis="horizontal" label="調整素材面板寬度" onDelta={(delta) => workspace.resize("media", delta)} /></>}
        <div className="center-workspace">
          <Suspense fallback={<section className="preview-panel" aria-label="正在載入播放器" />}><Preview
            onRebuildPreview={isDesktop ? creativeLibrary.repairPreview : undefined}
            previewRepair={creativeLibrary.previewRepair}
            layers={nativeEffectPreview.layers}
            audioLayers={activeAudioLayers}
            projectWidth={project.width}
            projectHeight={project.height}
            playhead={playhead}
            projectDuration={duration}
            projectFps={project.fps}
            captions={project.captions}
            captionStyle={project.captionStyle}
            project={project}
            gpuPreviewUrl={gpuPreview.frameUrl}
            nativeGpuPreview={gpuPreview.nativeSurfaceActive}
            gpuPreviewFullComposition={gpuPreview.fullComposition}
            onGpuPreviewImagePresented={gpuPreview.onImagePresented}
            onGpuPreviewImageRejected={gpuPreview.onImageRejected}
            bakedMotionGraphicIds={gpuPreview.bakedMotionGraphicIds}
            bakedCaptionIds={gpuPreview.bakedCaptionIds}
            gpuPreviewAdmission={gpuPreview.admission}
            gpuPreviewFallbackReason={gpuPreview.fallbackReason}
            gpuPreviewAdmissionDiagnostic={gpuPreview.admissionDiagnostic}
            autonomousGpuPlayback={gpuPreview.autonomousPlayback}
            nativeGpuPlaybackPreparing={gpuPreview.nativePlaybackPreparing}
            nativeGpuPresentedFrame={gpuPreview.presentedTimelineFrame}
            nativeGpuFrameUpdating={gpuPreview.nativeFrameUpdating}
            seekRevision={seekRevision}
            onPlaybackClock={publishPlaybackClock}
            onAudioTransportChange={updateAudioTransport}
            nativeEffectPreviewReadyClipIds={nativeEffectPreview.readyClipIds}
            nativeEffectPreviewPendingClipIds={nativeEffectPreview.pendingClipIds}
            nativeEffectPreviewErrors={nativeEffectPreview.errorByClipId}
            onNativeSurfaceBoundsChange={updateNativePreviewBounds}
            trackingSelectionEnabled={Boolean(trackingMode)}
            trackingSelection={trackingSelection}
            onTrackingSelectionChange={(rect) => void acceptTrackingSelection(rect)}
            playing={playing}
            playbackRate={playbackRate}
            onPlaybackRateChange={setPlaybackRate}
            onTogglePlayback={togglePlayback}
            onPausePlayback={pausePlayback}
            onShuttle={(direction) => shuttlePlayback(direction, direction === 1)}
            onFrameStep={frameStepPlayback}
            onPlayingChange={setPlaying}
            onPlayheadChange={(time) => setPlayhead(Math.max(0, Math.min(duration, time)))}
          /></Suspense>
          <Suspense fallback={null}><EditingProfilePicker
            profile={project.editorialProfile}
            hasVideo={Boolean(selectedClip && selectedAsset?.kind === "video")}
            trackingBusy={trackingBusy}
            onChange={(profile) => runCommand({ type: "batch", commands: [
              { type: "set_editorial_profile", profile },
              { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(profile, project.width > project.height ? "longform" : "shorts") },
            ] }, profile === "music_mv"
              ? "動畫 MV 已選取；按「製作 Music MV」連接 Video Autopilot，先核對歌曲並準備原創角色與場景插畫。"
              : "已套用剪輯類型與匿名美感標準；自動剪輯、批量與 AI 都會沿用。")}
            onStartSpeakerDirector={startPodcastDirector}
            unavailableReason={engineUnavailableReason}
          /></Suspense>
          {workspace.layout.automationVisible && <Suspense fallback={null}><AgentPanel
            status={status}
            hasMedia={hasUserMedia}
            onSubmit={submitAgentInstruction}
            onSmartCut={() => void automatic.smartCut.run()}
            smartCutBusy={automatic.smartCut.busy}
            onAutomaticCaptions={(mode) => void automatic.captions.run(mode)}
            automaticCaptionsBusy={automatic.captions.busy}
            onSceneSplit={() => void automatic.scenes.run()}
            sceneSplitBusy={automatic.scenes.busy}
            onSemanticAutoEdit={openAutoEdit}
            musicMvMode={project.editorialProfile === "music_mv"}
            unavailableReason={engineUnavailableReason}
            semanticAutoEditBusy={automatic.semantic.busy}
            semanticAutoEditStage={automatic.semantic.stage}
            onOpenAgentConnect={isDesktop ? () => openAgentConnect() : undefined}
          /></Suspense>}
        </div>
        {workspace.layout.inspectorVisible && !directorConsoleOpened && <><WorkspaceResizeHandle axis="horizontal" label="調整屬性面板寬度" onDelta={(delta) => workspace.resize("inspector", delta)} /><Suspense fallback={<aside className="inspector inspector-empty"><small>正在載入調整面板…</small></aside>}><Inspector
          captionProject={project}
          onCaptionCommand={command => runCommand(command, "已修正字幕句尾時間，可復原。 ")}
          onCaptionSelect={captionId => { const cue = project.captions.find(item => item.id === captionId); if (!cue) return; pausePlayback(); setSelectedClipId(undefined); setSelectedCaptionId(captionId); setPlayhead(cue.start); }}
          mesh3dProject={project}
          originalMotionScenesControl={<SavedOriginalMotionScenes project={project} sessionId={clipSourceSessionId} busy={referenceTemplateBusy}
            onCancel={cancelReferenceTemplate} onRevise={input => prepareReferenceInstance((prepareText, signal) =>
              prepareOriginalSceneGraphicRevision(project, input, { prepareText, signal }))} />}
          onMesh3dCommand={command => runCommand(command, "已更新可編輯 3D 場景，可復原。 ")}
          projectFps={project.fps}
          playhead={playhead}
          pluginRegistry={creativeLibrary.plugins}
          clip={selectedClipAtPlayhead}
          caption={selectedCaption}
          captionStyle={project.captionStyle}
          tracks={project.tracks}
          canTransitionIn={transitionNeighbors.before}
          canTransitionOut={transitionNeighbors.after}
          asset={selectedAsset}
          sceneAssets={project.assets}
          previewSource={selectedAsset ? runtimeUrls[`${selectedAsset.id}:thumbnail`] ?? (selectedAsset.kind === "image" ? runtimeUrls[selectedAsset.id] : undefined) : undefined}
          onMove={(timelineStart) => {
            if (selectedClip) return moveTimelineClip(selectedClip.id, timelineStart);
          }}
          onTrackChange={(trackId) => {
            if (selectedClip) return moveTimelineClip(selectedClip.id, undefined, trackId);
          }}
          clipSourceSessionId={clipSourceSessionId}
          onReplaceClipSource={command => {
            if (!clipSourceTask.isCurrent()) return setStatus("專案已變更，請重新選擇要替換的影片。");
            if (selectedClip?.id !== command.clipId) return setStatus("請重新選擇要替換的片段。");
            runCommand(command, "已替換影片並保留片段時間與動態，可復原。請檢查構圖、字幕和聲音。");
          }}
          onVolumeChange={(volume) => {
            if (selectedClip && Number.isFinite(volume)) runCommand({ type: "set_clip_volume", clipId: selectedClip.id, volume }, "已更新片段音量。");
          }}
          onTrimStart={() => {
            if (selectedClip) runCommand({ type: "trim_clip_start", clipId: selectedClip.id, seconds: playhead - selectedClip.timelineStart }, "已把播放頭設為片段入點。");
          }}
          onTrimEnd={() => {
            if (selectedClip) runCommand({ type: "trim_clip_end", clipId: selectedClip.id, seconds: selectedClip.timelineStart + selectedClip.duration - playhead }, "已把播放頭設為片段出點。");
          }}
          onTransformChange={(patch) => updateAnimatedClipProperty("transform", patch)}
          scene25d={project.scene25d}
          onScene25dToggle={(enabled) => runCommand({ type: "configure_scene_25d", enabled }, enabled ? "已啟用原生 2.5D 場景；相機、燈光與平面深度會進入同一條 GPU graph。" : "已退出 2.5D 場景並回到一般 2D 圖層。")}
          onScene25dChange={(settings) => runCommand({ type: "set_scene_25d_settings", settings }, "已更新 2.5D 相機／燈光設定。")}
          onTransform3dChange={(patch) => {
            if (selectedClip) runCommand({ type: "update_clip_transform_3d", clipId: selectedClip.id, patch }, "已更新 2.5D 平面位置。 ");
          }}
          onSetFloatingFrame={(frame) => {
            if (selectedClip) runCommand({ type: "set_clip_floating_frame", clipId: selectedClip.id, frame }, frame ? "已套用可編輯浮空影片框。" : "已移除浮空影片框。");
          }}
          portraitCanvas={project.height > project.width}
          onApplyFloatingScene={(preset, sources) => {
            if (!selectedClip) return;
            try {
              runCommand({ type: "batch", commands: floatingFrameSceneCommands(project, selectedClip.id, preset, sources) }, "已建立三層可編輯直式浮空框舞台，可復原。");
            } catch (error) { setStatus(error instanceof Error ? error.message : "浮空框舞台套用失敗"); }
          }}
          onApplyClipMotionPreset={(preset) => {
            if (!selectedClip) return;
            try {
              runCommand({ type: "batch", commands: motionClipPresetCommands(selectedClip, project.fps, preset, { projectWidth: project.width, projectHeight: project.height }) }, "已套用逐格 Motion 動畫，可復原。");
            } catch (error) { setStatus(error instanceof Error ? error.message : "Motion 動畫套用失敗"); }
          }}
          onApplyReferenceMotionTemplate={referenceTemplateBusy ? undefined : (input) => {
            if (!selectedClip || referenceTemplateOperation.current) return;
            const captured = { ...structuredClone(input), clipId: selectedClip.id,
              startFrame: Math.round(selectedClip.timelineStart * project.fps), durationFrames: Math.round(selectedClip.duration * project.fps),
              evidenceRefs: ["manual:motion-template-input"] };
            prepareReferenceInstance((prepareText, signal) => prepareReferenceMotionTemplateInstance(project, captured, makeId, { prepareText, signal }));
          }}
          referenceMotionTemplateBusy={referenceTemplateBusy}
          onCancelReferenceMotionTemplate={cancelReferenceTemplate}
          particleSimulation={project.particleSimulation}
          onParticleSimulationToggle={(enabled) => runCommand({ type: "configure_particle_simulation", enabled }, enabled ? "已啟用原生 GPU 粒子 VFX；預覽與輸出會使用同一個 fixed-seed 模擬。" : "已移除粒子 VFX。")}
          onParticleSimulationChange={(settings) => runCommand({ type: "set_particle_simulation_settings", settings }, "已更新粒子 VFX。")}
          onLayerChange={(patch) => {
            if (selectedClip) runCommand({ type: "set_clip_layer", clipId: selectedClip.id, patch }, "已更新圖層合成設定。");
          }}
          onExpressionChange={(property, expression) => {
            if (selectedClip) runCommand({ type: "set_clip_expression", clipId: selectedClip.id, property, expression }, expression ? "已套用安全表達式。" : "已清除表達式。");
          }}
          onMediaFrameApply={(layout, name) => {
            if (selectedClip) runCommand({ type: "set_clip_layout", clipId: selectedClip.id, layout }, `已套用「${name}」媒體框；仍使用原始真實素材。`);
          }}
          onColorChange={(patch) => updateAnimatedClipProperty("color", patch)}
          onCreativeChange={(patch) => {
            if (selectedClip) runCommand({ type: "set_clip_creative", clipId: selectedClip.id, patch }, "已套用 Editkin Creator Pack，預覽與輸出會使用同一設定。");
          }}
          onNativeEffectAdd={(instance) => {
            if (selectedClip) runCommand({ type: "add_native_effect", clipId: selectedClip.id, instance }, "已加入原生 GPU 動態模糊；預覽與輸出共用 shutter sampling。 ");
          }}
          onNativeEffectUpdate={(instanceId, patch) => {
            if (selectedClip) runCommand({ type: "update_native_effect", clipId: selectedClip.id, instanceId, patch }, "已更新原生效果；正式輸出會使用這組參數。");
          }}
          onNativeEffectReorder={(instanceId, toIndex) => {
            if (selectedClip) runCommand({ type: "reorder_native_effect", clipId: selectedClip.id, instanceId, toIndex }, "已調整效果順序；預覽與正式輸出會依這個順序執行。");
          }}
          onNativeEffectRemove={(instanceId) => {
            if (selectedClip) runCommand({ type: "remove_native_effect", clipId: selectedClip.id, instanceId }, "已移除原生效果；可直接復原。");
          }}
          onAddKeyframe={() => {
            if (!selectedClip) return;
            const time = Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.timelineStart));
            const animated = animatedClipState(selectedClip, time);
            runCommand({
              type: "add_keyframe",
              clipId: selectedClip.id,
              keyframe: { id: makeId("keyframe"), time, transform: animated.transform, color: animated.color, easing: "linear" },
            }, `已在片段 ${time.toFixed(2)} 秒加入關鍵幀。`);
          }}
          onKeyframeEasingChange={(keyframeId, easing) => {
            if (selectedClip) runCommand({ type: "update_keyframe", clipId: selectedClip.id, keyframeId, patch: { easing } }, `已切換為 ${easing} 插值。`);
          }}
          onDeleteKeyframe={(keyframeId) => {
            if (selectedClip) runCommand({ type: "delete_keyframe", clipId: selectedClip.id, keyframeId }, "已刪除關鍵幀。");
          }}
          motionTracks={selectedMotionTracks}
          trackingBusy={trackingBusy}
          trackingSelectionActive={Boolean(trackingMode)}
          trackingSelection={trackingSelection}
          onBeginMotionTrack={() => {
            if (!isDesktop) return setStatus("動態追蹤需要桌面版的本機分析引擎；網頁版無法使用。");
            if (!selectedClip || project.assets.find((asset) => asset.id === selectedClip.assetId)?.kind !== "video") return setStatus("請先選一段影片。");
            setPlaying(false);
            setTrackingSelection(undefined);
            setTrackingMode({ kind: "new" });
            setStatus("請直接在預覽畫面拖曳框住要追蹤的人或物件，放開後會自動分析。");
          }}
          onCorrectMotionTrack={(trackId) => {
            setPlaying(false);
            setTrackingSelection(undefined);
            setTrackingMode({ kind: "correct", trackId });
            setStatus("在預覽畫面重新框住主體，這一幀會成為手動修正點。");
          }}
          onDeleteMotionTrack={(trackId) => runCommand({ type: "delete_motion_track", trackId }, "已移除追蹤資料；已綁定的圖卡會保留為靜態圖卡。")}
          onAddMotionGraphic={addMotionGraphic}
          onAddGeometryMotion={() => {
            const task = props.projectSession.beginTask(project);
            const startFrame = Math.round((selectedClip?.timelineStart ?? playhead) * project.fps);
            const durationFrames = Math.min(1800, Math.round((selectedClip?.duration ?? 3) * project.fps));
            const width = Math.min(4096, project.width * .72), height = Math.min(4096, project.height * .14);
            const radius = Math.floor(Math.min(height * .18, width * .18) * 2) / 2, eventFrame = Math.max(1, Math.floor(durationFrames * .18));
            const centerX = Math.round(width / 2), centerY = Math.round(height / 2);
            void import("../application/nativeGeometryMotion").then(({ prepareNativeGeometryMotion }) => prepareNativeGeometryMotion(project, {
              expectedRevision: project.revision, range: { startFrame, endFrame: startFrame + durationFrames },
              position: { x: .14, y: .35 }, fixedEnvelope: { width, height },
              initial: { left: centerX - radius, top: centerY - radius, right: centerX + radius, bottom: centerY + radius, cornerRadius: radius },
              dynamics: { stiffness: 144, damping: 24, mass: 1 },
              propertyDynamics: { left: { stiffness: 100, damping: 20, mass: 1 }, right: { stiffness: 225, damping: 30, mass: 1 } },
              targets: [{ property: "left", frame: eventFrame, target: width * .02 }, { property: "right", frame: eventFrame, target: width * .98 },
                { property: "top", frame: eventFrame, target: height * .16 }, { property: "bottom", frame: eventFrame, target: height * .84 },
                { property: "cornerRadius", frame: eventFrame, target: Math.min(height * .12, radius) }],
              purpose: "建立可編輯的圓形到柔角面板，後續依素材修改輪廓與節奏", evidenceRefs: ["manual:geometry-authoring"],
            }, () => makeId("geometry"))).then(prepared => {
              if (acceptProjectTask(task, setStatus, "連續輪廓建立")) runCommand({ type: "batch", commands: prepared.commands }, "已建立連續輪廓；可逐邊修改影格目標與彈性，也可復原。");
            }).catch(error => {
              if (acceptProjectTask(task, setStatus, "連續輪廓建立")) setStatus(error instanceof Error ? error.message : "連續輪廓建立失敗");
            });
          }}
          motionGraphics={project.motionGraphics}
          onUpdateMotionGraphic={(graphicId, patch) => runCommand({ type: "update_motion_graphic", graphicId, patch }, "已更新動態圖卡，預覽與輸出會同步。")}
          managedMotionGraphicIds={[
            ...(project.referenceMotionInstances?.flatMap(instance => instance.roles.filter(role => role.kind === "graphic").map(role => role.id)) ?? []),
            ...(project.motionScenes?.flatMap(scene => scene.graphicIds) ?? []),
          ]}
          onDeleteMotionGraphic={(graphicId) => runCommand({ type: "delete_motion_graphic", graphicId }, "已刪除動態圖卡，可隨時復原。")}
          onCaptionChange={(patch) => {
            if (selectedCaption) runCommand({ type: "update_caption", captionId: selectedCaption.id, patch }, "已更新字幕。");
          }}
          onCaptionStyleChange={(presetId) => {
            const task = props.projectSession.beginTask(project);
            void import("../creative/corePack")
              .then(({ captionStyleFromPreset }) => {
                if (acceptProjectTask(task, setStatus, "文字風格載入")) runCommand({ type: "set_caption_style", patch: captionStyleFromPreset(presetId) }, "已套用文字風格。");
              })
              .catch((error) => {
                if (acceptProjectTask(task, setStatus, "文字風格載入")) setStatus(error instanceof Error ? error.message : "無法載入文字風格");
              });
          }}
          onCaptionStylePatch={(patch) => runCommand({ type: "set_caption_style", patch }, "已更新字幕字型，預覽與輸出會使用內建字型。")}
          onOpenColorWorkspace={() => {
            if (!selectedClip || !selectedAsset || selectedAsset.kind === "audio") return setStatus("請先選一段影片或照片。");
            setPlaying(false);
            setColorWorkspaceOpened(true);
          }}
          onAddCaption={addCaption}
          onMakePictureInPicture={makeSelectedPictureInPicture}
          onAddMask={(kind) => {
            if (!selectedClip || !selectedAsset || selectedAsset.kind === "audio") return setStatus("請先選一段影片或照片。");
            const mask = createClipMask(makeId("mask"), kind);
            runCommand({ type: "add_clip_mask", clipId: selectedClip.id, mask }, `已新增「${mask.name}」；可調整羽化、擴張、反轉與追蹤。`);
          }}
          onUpdateMask={(maskId, patch) => {
            if (selectedClip) runCommand({ type: "update_clip_mask", clipId: selectedClip.id, maskId, patch }, "已更新遮罩，預覽與輸出會使用同一設定。");
          }}
          onDeleteMask={(maskId) => {
            if (selectedClip) runCommand({ type: "delete_clip_mask", clipId: selectedClip.id, maskId }, "已刪除遮罩，可隨時復原。");
          }}
          onBindMaskTrack={(maskId, trackId) => {
            if (selectedClip) runCommand({ type: "set_clip_mask_track", clipId: selectedClip.id, maskId, trackId }, trackId ? "遮罩已綁定動態追蹤；失追影格會安全隱藏。" : "遮罩已改回手動路徑。");
          }}
          onSetMaskKeyframe={(maskId) => {
            if (!selectedClip) return;
            const mask = selectedClip.masks?.find((item) => item.id === maskId);
            if (!mask) return;
            const time = Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.timelineStart));
            const resolved = resolveMaskPath(project, selectedClip, mask, time);
            runCommand({ type: "set_clip_mask_keyframe", clipId: selectedClip.id, maskId, keyframe: { frame: Math.round(time * project.fps), time, points: resolved.points, confidence: 1, status: "manual" } }, `已在第 ${Math.round(time * project.fps)} 格加入手動遮罩修正。`);
          }}
          onFreezeMask={(maskId) => {
            if (!selectedClip) return;
            const mask = selectedClip.masks?.find((item) => item.id === maskId);
            if (mask?.matteSequence) runCommand({ type: "freeze_clip_mask_range", clipId: selectedClip.id, maskId, fromFrame: 0, toFrame: Math.ceil(selectedClip.duration * project.fps) }, "已凍結逐像素 matte sequence。");
            else setStatus("向量遮罩沒有逐幀分析可以凍結；請先執行 Auto Roto 或只保留手動路徑。");
          }}
          onAutoRotoMask={(maskId) => void runAutoRoto(maskId)}
          onQuickAutoRoto={runQuickAutoRoto}
          onChromaKeyChange={(settings) => {
            if (selectedClip) runCommand({ type: "set_clip_chroma_key", clipId: selectedClip.id, settings }, settings?.enabled ? "已開啟 Editkin 綠／藍幕 Keyer；相容預覽與正式輸出使用同一公式。" : "已關閉綠／藍幕 Keyer。");
          }}
          autoRotoBusy={autoRotoBusy}
          autoRotoRuntimeStatus={autoRotoRuntimeStatus}
        /></Suspense></>}
        {directorConsoleOpened && <><div className="director-divider" aria-hidden="true" /><Suspense fallback={<aside aria-label="正在載入導演台" />}><DirectorConsole docked project={project} runtimeUrls={runtimeUrls} playhead={playhead} currentArtifact={props.currentAestheticArtifact} onSeek={(time) => setPlayhead(Math.max(0, Math.min(Math.max(duration, 12), time)))} onCommand={runCommand} onClose={() => setDirectorConsoleOpened(false)} /></Suspense></>}
      </section>
      {workspace.layout.timelineVisible && <div className="timeline-region"><WorkspaceResizeHandle axis="vertical" label="調整時間軸高度" onDelta={(delta) => workspace.resize("timeline", delta)} /><Suspense fallback={<section className="timeline-shell" aria-label="正在載入時間軸" />}><Timeline
        project={project}
        duration={duration}
        playhead={playhead}
        selectedClipId={selectedClipId}
        selectedCaptionId={selectedCaptionId}
        runtimeUrls={runtimeUrls}
        draggingAssetId={draggingAssetId}
        onInsertAsset={(assetId, trackId, timelineStart) => addAssetToTimeline(assetId, "timeline", { trackId, timelineStart })}
        onEditStart={pausePlayback}
        onSeek={(time) => { pausePlayback(); setPlayhead(Math.max(0, Math.min(Math.max(duration, 12), time))); }}
        onSelect={(clipId) => { setSelectedCaptionId(undefined); setSelectedClipId(clipId); }}
        onSelectCaption={(captionId) => { setSelectedClipId(undefined); setSelectedCaptionId(captionId); }}
        onMoveClip={moveTimelineClip}
        onMoveCaption={(captionId, start) => runCommand({ type: "update_caption", captionId, patch: { start } }, "已移動字幕，可復原。")} 
        onTrimClip={(clipId, edge, seconds) => {
          const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
          if (!clip) return;
          runCommand(buildClipTrimCommand(clip, edge, seconds), `已拖曳修剪${edge === "start" ? "開頭" : "結尾"} ${seconds.toFixed(2)} 秒；一次復原即可還原。`);
        }}
        onTrimCaption={(captionId, edge, seconds) => {
          const caption = project.captions.find((item) => item.id === captionId);
          if (!caption) return;
          runCommand(buildCaptionTrimCommand(caption, edge, seconds, project.fps), `已拖曳修剪字幕${edge === "start" ? "開頭" : "結尾"}。`);
        }}
        onAddCaption={addCaption}
        onAddTrack={addTrack}
        onRenameTrack={(trackId, name) => runCommand({ type: "rename_track", trackId, name }, `軌道已重新命名為「${name}」。`)}
        onToggleTrackLock={(trackId) => runCommand({ type: "toggle_track_lock", trackId }, "已切換軌道鎖定狀態。")}
        onDeleteTrack={(trackId) => runCommand({ type: "delete_track", trackId }, "已刪除空軌道，可復原。")}
        onMakePictureInPicture={() => makeSelectedPictureInPicture()}
        onPrecompose={precomposeSelected}
        onToggleMute={(trackId) => runCommand({ type: "toggle_track_mute", trackId }, "已切換軌道靜音。")}
        onSplit={splitSelected}
        onDelete={deleteSelected}
      /></Suspense></div>}
      </>}
      <footer className="status-bar" style={{ position: "relative" }}>
        {projectDownload && <ProjectDownloadNotice lease={projectDownload} onCancel={cancelProjectDownload} />}
        <SavedReferenceMotionInstances project={project} session={props.projectSession} busy={referenceTemplateBusy} onCancel={cancelReferenceTemplate}
          onReuse={request => prepareReferenceInstance(async (prepareText, signal) => {
            const prepared = await prepareReferenceMotionTemplateReuse(project, request, makeId, { prepareText, signal });
            return { ...prepared, status: "REVIEW_REQUIRED" as const };
          })}
          onRevise={(id, patch, expectedInstanceRevision) => prepareReferenceInstance((prepareText, signal) =>
            prepareReferenceMotionTemplateRevision(project, id, patch, { expectedInstanceRevision, prepareText, signal, idFactory: makeId }))}
          onDetach={(id, expectedInstanceRevision) => {
            if (referenceTemplateOperation.current || !acceptProjectTask(props.projectSession.beginTask(project), setStatus, "解除模板連結")) return;
            pausePlayback();
            runCommand({ type: "remove_reference_motion_instance", id, expectedInstanceRevision }, "已解除模板連結並保留全部圖層，可一次復原。");
          }} />
        <span data-testid="save-state"><i className={recovery.recoveryState === "error" ? "red" : "green"} /> {!isDesktop ? recovery.dirty ? "未儲存 · 請下載專案 · 無 Autosave" : "專案未變更 · 瀏覽器無 Autosave" : recovery.dirty ? recovery.recoveryState === "saved" ? "未儲存 · Autosave 安全" : recovery.recoveryState === "error" ? "未儲存 · Autosave 失敗" : "未儲存 · Autosave…" : "所有變更已儲存"}</span>
        <details className="project-format-control" data-testid="project-format-control" data-project-width={project.width} data-project-height={project.height}><summary aria-label="設定專案比例"><span data-testid="project-resolution">{projectFormatLabel(project.width, project.height)}</span><small>{project.width}×{project.height} · {project.fps} fps</small></summary><div><header><strong>專案比例</strong><span>只改畫布，不破壞原素材；可再到檢查器調整裁切與位置。</span></header>{PROJECT_FORMATS.map((format) => <button type="button" key={format.id} aria-label={`切換為 ${format.ratio} ${format.label}`} title={`${format.ratio} ${format.label} · ${format.width}×${format.height}`} className={project.width === format.width && project.height === format.height ? "active" : ""} onClick={(event) => { runCommand({ type: "set_project_resolution", width: format.width, height: format.height }, `專案已切換為 ${format.ratio} ${format.label}；素材位置與裁切仍可逐片調整。`); event.currentTarget.closest("details")?.removeAttribute("open"); }}><b>{format.ratio}</b><span><strong>{format.label}</strong><small>{format.use}</small></span></button>)}</div></details>
        <OperationStatus status={status} runtimeInfo={isDesktop ? `桌面版 · 即時預覽 · 自動儲存${mobile.remote?.active ? ` · 手機已連線${mobile.remoteStatus?.connectedCount ? ` ${mobile.remoteStatus.connectedCount}` : ""}` : ""}` : "瀏覽器編輯 · 無自動儲存 · 請下載專案"} />
      </footer>
      {beginnerGuideOpened && <Suspense fallback={null}><BeginnerGuide onClose={closeBeginnerGuide} onChooseMedia={() => document.querySelector<HTMLElement>('[data-testid="import-media-button"]')?.click()} /></Suspense>}
      {mobile.showConnect && (
        <Suspense fallback={null}><MobileConnectModal remote={mobile.remote} status={mobile.remoteStatus} networkSummary={mobile.networkSummary} agentLaunch={remoteAgentLaunch.state} onStartAgent={remoteAgentLaunch.start} onCancelAgent={remoteAgentLaunch.cancel} onClose={() => mobile.setShowConnect(false)} onStart={(confirmed) => void mobile.start(confirmed)} onStop={() => void mobile.stop()} onRevoke={(deviceId) => void mobile.revoke(deviceId)} onOpenAgentConnect={() => { mobile.setShowConnect(false); openAgentConnect(true); }} /></Suspense>
      )}
      {batchAutoEdit.show && batchAutoEdit.session && (
        <Suspense fallback={null}>
          <BatchAutoEditPanel
            session={batchAutoEdit.session}
            onClose={() => batchAutoEdit.setShow(false)}
            onRetry={(jobId) => void batchAutoEdit.retry(jobId)}
            onOpenProject={(jobId) => void batchAutoEdit.openProject(jobId)}
          />
        </Suspense>
      )}
      {colorWorkspaceOpened && selectedClip && selectedAsset && (
        <Suspense fallback={null}><ColorWorkspace asset={selectedAsset} clip={selectedClip} source={runtimeUrls[selectedAsset.id]} playhead={playhead} colorManagement={project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT} onColorManagementChange={(patch) => runCommand({ type: "set_project_color_management", patch }, patch.mode === "aces2" ? "已切換 ACES 2.0 專業色彩管理。" : "已切換快速 Rec.709。") } onColorChange={(patch) => runCommand({ type: "set_clip_color", clipId: selectedClip.id, patch }, "已更新 Primary Grade。") } onInputColorSpaceChange={(interpretation) => runCommand({ type: "set_asset_color_interpretation", assetId: selectedAsset.id, interpretation }, interpretation === "log_unresolved" ? "已標記為未解讀 Log；輸出會安全阻擋。" : "已更新 Input Transform。") } onAlphaModeChange={(alphaMode) => runCommand({ type: "set_asset_alpha_mode", assetId: selectedAsset.id, alphaMode }, alphaMode === "premultiplied" ? "已啟用 Premultiplied Alpha 解碼，避免透明邊緣黑邊。" : "已更新素材 Alpha 模式。") } onClose={() => setColorWorkspaceOpened(false)} /></Suspense>
      )}
      {directorConsoleOpened && showWelcome && (
        <Suspense fallback={null}><DirectorConsole project={project} playhead={playhead} currentArtifact={props.currentAestheticArtifact} onSeek={(time) => setPlayhead(Math.max(0, Math.min(Math.max(duration, 12), time)))} onCommand={runCommand} onClose={() => setDirectorConsoleOpened(false)} /></Suspense>
      )}
      {agentConnectOpened && <Suspense fallback={null}><AgentConnectModal onClose={closeAgentConnect} onConnect={desktopActions.connectAgent} musicMvMode={project.editorialProfile === "music_mv"} /></Suspense>}
      {autoEditOpened && <Suspense fallback={null}><AutoEditDialog onClose={() => setAutoEditOpened(false)} onStart={(policy) => {
        setAutoEditOpened(false);
        const target = autoEditTarget.current;
        if (!target || !acceptProjectTask(target.task, setStatus, "粗剪設定")) return;
        if (target.clipId !== selectedClipId) return setStatus("選取的片段已改變，請重新開啟粗剪設定。");
        void automatic.semantic.run(policy);
      }} /></Suspense>}
    </main>
  );
}

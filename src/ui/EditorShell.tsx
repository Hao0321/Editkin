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
import { animatedClipState } from "../domain/editGraph";
import { createClipMask, resolveMaskPath } from "../domain/masks";
import type { EditorHistory } from "../domain/history";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import type { CaptionCue, ClipLayout, EditProject, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";
import type { EditorTheme } from "./theme";
import { Toolbar } from "./Toolbar";
import { WorkspaceControls } from "./WorkspaceControls";
import { OperationStatus } from "./OperationStatus";
import { MediaImportStatus } from "./MediaImportStatus";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle";
import { useWorkspaceLayout } from "./workspaceLayout";
import { autoRotoRuntimeStatusFromReceipt, initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { runAutoRotoAction } from "../application/runAutoRotoAction";
import { acceptProjectTask } from "../application/projectTask";
import { PROJECT_FORMATS, projectFormatLabel } from "../application/projectFormats";
import type { ProjectTask } from "../application/projectSession";
import "./layoutHardening.css";
import "./projectFormatControl.css";

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
  const autoEditTarget = useRef<{ task: ProjectTask; clipId: string } | undefined>(undefined);
  const [autoRotoBusy, setAutoRotoBusy] = useState(false);
  const autoRotoBusyRef = useRef(false);
  const [autoRotoRuntimeStatus, setAutoRotoRuntimeStatus] = useState(() => initialAutoRotoRuntimeStatus(window.haoDesktop?.analyzeAutoRoto));
  const [beginnerGuideOpened, setBeginnerGuideOpened] = useState(() => window.localStorage.getItem(BEGINNER_GUIDE_KEY) !== "done");
  const workspace = useWorkspaceLayout();
  const {
    history, project, duration, theme, setTheme, isDesktop, playhead, setPlayhead, seekRevision, onPlaybackClock, playing, setPlaying,
    selectedClipId, setSelectedClipId, selectedCaptionId, setSelectedCaptionId, selectedClip,
    selectedClipAtPlayhead, selectedCaption, transitionNeighbors, selectedMotionTracks, activeLayers,
    activeAudioLayers, runtimeUrls, status, setStatus, trackingMode, setTrackingMode, trackingSelection,
    setTrackingSelection, trackingBusy, recovery, desktopActions, automatic, creativeLibrary, batchAutoEdit, mobile,
    newProject, openProject, saveProject, undoEdit, redoEdit, renderVideo, renderOpenExrSequence, renderAlphaMaster, importFiles,
    acceptTrackingSelection, startPodcastDirector, submitAgentInstruction, runCommand, updateAnimatedClipProperty,
    addMotionGraphic, addCaption, addTrack, addAssetToTimeline, makeSelectedPictureInPicture, precomposeSelected, applyShortFormTemplate, applyLongFormTemplate, addLowerThird, clearTemplateApplication, splitSelected, deleteSelected,
  } = props;
  const selectedAsset = selectedClip ? project.assets.find((asset) => asset.id === selectedClip.assetId) : undefined;
  const hasUserMedia = project.assets.some((asset) => asset.id !== "asset-demo");
  const showWelcome = !hasUserMedia && !demoWorkspaceOpened;
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
    isDesktop && !showWelcome && !trackingMode,
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
    "minmax(0,1fr)",
    directorConsoleOpened ? "8px minmax(340px,440px)" : workspace.layout.inspectorVisible ? `8px ${workspace.layout.inspectorWidth}px` : "",
  ].filter(Boolean).join(" "), [directorConsoleOpened, workspace.layout.inspectorVisible, workspace.layout.inspectorWidth, workspace.layout.mediaVisible, workspace.layout.mediaWidth]);
  const shellStyle = {
    "--timeline-height": workspace.layout.timelineVisible ? `${workspace.layout.timelineHeight}px` : "0px",
  } as CSSProperties;
  const importState=creativeLibrary.importState;
  const importActive=Boolean(importState&&importState.phase!=="idle"&&importState.sessionId===props.projectSession.getSnapshot().sessionId);
  const closeBeginnerGuide = () => {
    window.localStorage.setItem(BEGINNER_GUIDE_KEY, "done");
    setBeginnerGuideOpened(false);
  };
  const shortcutsBlocked = beginnerGuideOpened || colorWorkspaceOpened || (directorConsoleOpened && showWelcome) || batchAutoEdit.show || mobile.showConnect || agentConnectOpened || autoEditOpened;
  const closeAgentConnect = () => {
    setAgentConnectOpened(false);
    if (!returnToRemoteAfterAgent) return;
    setReturnToRemoteAfterAgent(false);
    void mobile.open();
  };
  const openAutoEdit = () => {
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
    <main className="app-shell" data-import-active={importActive} data-shortcuts-blocked={shortcutsBlocked} data-workspace-mode={showWelcome ? "welcome" : "editor"} data-text-size={workspace.layout.textSize} style={shellStyle}>
      <Suspense fallback={null}><WorkspaceDropImport
        onBrowserFiles={(files) => void importFiles(files)}
        onDesktopPaths={isDesktop ? (paths) => void creativeLibrary.importDesktopPaths(paths) : undefined}
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
        onOpenAgentConnect={() => { setReturnToRemoteAfterAgent(false); setAgentConnectOpened(true); }}
        onAutoEdit={openAutoEdit}
        autoEditBusy={automatic.semantic.busy}
        onMobileRemote={window.haoDesktop?.startMobileRemote ? () => void mobile.open() : undefined}
        mobileRemoteActive={mobile.remote?.active}
        mobileRemoteCount={mobile.remoteStatus?.connectedCount}
        onCheckUpdates={desktopActions.checkForUpdates}
        onDirectorConsole={() => setDirectorConsoleOpened(true)}
        onHelp={() => setBeginnerGuideOpened(true)}
        workspaceControls={<WorkspaceControls layout={workspace.layout} onPreset={workspace.choosePreset} onPatch={workspace.patch} onReset={workspace.reset} />}
      />
      {importActive&&importState?<MediaImportStatus state={importState} onRetry={()=>void creativeLibrary.retryFailedImports()}/>:null}
      {showWelcome ? <Suspense fallback={<section className="first-project-loading" aria-label="正在準備開始畫面" />}><FirstProjectStart
        isDesktop={isDesktop}
        onImport={importFiles}
        onDesktopImport={isDesktop ? () => void creativeLibrary.importDesktopMedia() : undefined}
        onOpenProject={isDesktop ? () => void openProject() : undefined}
        onExploreDemo={() => setDemoWorkspaceOpened(true)}
        onHelp={() => setBeginnerGuideOpened(true)}
        onConnectAgent={isDesktop ? () => setAgentConnectOpened(true) : undefined}
      /></Suspense> : <>
      <section className="workspace-grid" style={{ gridTemplateColumns: workspaceColumns }} data-testid="modular-workspace">
        {!hasUserMedia && <div className="demo-workspace-banner" data-testid="demo-workspace-banner"><b>示範模式</b><span>先熟悉介面；加入自己的影片後才會啟用自動剪輯與輸出</span></div>}
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
          onApplyShortTemplate={(templateId) => void applyShortFormTemplate(templateId)}
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
            gpuPreviewAdmission={gpuPreview.admission}
            gpuPreviewFallbackReason={gpuPreview.fallbackReason}
            gpuPreviewAdmissionDiagnostic={gpuPreview.admissionDiagnostic}
            autonomousGpuPlayback={gpuPreview.autonomousPlayback}
            nativeGpuPlaybackPreparing={gpuPreview.nativePlaybackPreparing}
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
            ] }, "已套用剪輯類型與匿名美感標準；自動剪輯、批量與 AI 都會沿用。")}
            onStartSpeakerDirector={startPodcastDirector}
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
            semanticAutoEditBusy={automatic.semantic.busy}
            semanticAutoEditStage={automatic.semantic.stage}
            onOpenAgentConnect={isDesktop ? () => setAgentConnectOpened(true) : undefined}
          /></Suspense>}
        </div>
        {workspace.layout.inspectorVisible && !directorConsoleOpened && <><WorkspaceResizeHandle axis="horizontal" label="調整屬性面板寬度" onDelta={(delta) => workspace.resize("inspector", delta)} /><Suspense fallback={<aside className="inspector inspector-empty"><small>正在載入調整面板…</small></aside>}><Inspector
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
          previewSource={selectedAsset ? runtimeUrls[`${selectedAsset.id}:thumbnail`] ?? (selectedAsset.kind === "image" ? runtimeUrls[selectedAsset.id] : undefined) : undefined}
          onMove={(timelineStart) => {
            if (selectedClip && Number.isFinite(timelineStart)) runCommand({ type: "move_clip", clipId: selectedClip.id, timelineStart }, "已更新片段位置。");
          }}
          onTrackChange={(trackId) => {
            if (selectedClip) runCommand({ type: "move_clip_to_track", clipId: selectedClip.id, trackId, timelineStart: selectedClip.timelineStart }, "已把片段移到新軌道。");
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
            if (selectedClip) runCommand({ type: "set_clip_creative", clipId: selectedClip.id, patch }, "已套用 Editkin 社群預設，預覽與輸出會使用同一設定。");
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
          motionGraphics={project.motionGraphics}
          onUpdateMotionGraphic={(graphicId, patch) => runCommand({ type: "update_motion_graphic", graphicId, patch }, "已更新動態圖卡，預覽與輸出會同步。")}
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
        onSeek={(time) => setPlayhead(Math.max(0, Math.min(Math.max(duration, 12), time)))}
        onSelect={(clipId) => { setSelectedCaptionId(undefined); setSelectedClipId(clipId); }}
        onSelectCaption={(captionId) => { setSelectedClipId(undefined); setSelectedCaptionId(captionId); }}
        onMoveClip={(clipId, timelineStart, trackId) => {
          const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
          if (!clip) return;
          if (clip.trackId === trackId) runCommand({ type: "move_clip", clipId, timelineStart }, "已移動片段，可復原。");
          else runCommand({ type: "move_clip_to_track", clipId, trackId, timelineStart }, "已把片段移到新軌道，可復原。");
        }}
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
      <footer className="status-bar">
        <span data-testid="save-state"><i className={recovery.recoveryState === "error" ? "red" : "green"} /> {recovery.dirty ? recovery.recoveryState === "saved" ? "未儲存 · Autosave 安全" : recovery.recoveryState === "error" ? "未儲存 · Autosave 失敗" : "未儲存 · Autosave…" : "所有變更已儲存"}</span>
        <details className="project-format-control" data-testid="project-format-control" data-project-width={project.width} data-project-height={project.height}><summary aria-label="設定專案比例"><span data-testid="project-resolution">{projectFormatLabel(project.width, project.height)}</span><small>{project.width}×{project.height} · {project.fps} fps</small></summary><div><header><strong>專案比例</strong><span>只改畫布，不破壞原素材；可再到檢查器調整裁切與位置。</span></header>{PROJECT_FORMATS.map((format) => <button type="button" key={format.id} aria-label={`切換為 ${format.ratio} ${format.label}`} title={`${format.ratio} ${format.label} · ${format.width}×${format.height}`} className={project.width === format.width && project.height === format.height ? "active" : ""} onClick={(event) => { runCommand({ type: "set_project_resolution", width: format.width, height: format.height }, `專案已切換為 ${format.ratio} ${format.label}；素材位置與裁切仍可逐片調整。`); event.currentTarget.closest("details")?.removeAttribute("open"); }}><b>{format.ratio}</b><span><strong>{format.label}</strong><small>{format.use}</small></span></button>)}</div></details>
        <OperationStatus status={status} runtimeInfo={isDesktop ? `桌面版 · 即時預覽 · 自動儲存${mobile.remote?.active ? ` · 手機已連線${mobile.remoteStatus?.connectedCount ? ` ${mobile.remoteStatus.connectedCount}` : ""}` : ""}` : "本機編輯 · 自動儲存"} />
      </footer>
      {beginnerGuideOpened && <Suspense fallback={null}><BeginnerGuide onClose={closeBeginnerGuide} onChooseMedia={() => document.querySelector<HTMLElement>('[data-testid="import-media-button"]')?.click()} /></Suspense>}
      {mobile.showConnect && (
        <Suspense fallback={null}><MobileConnectModal remote={mobile.remote} status={mobile.remoteStatus} networkSummary={mobile.networkSummary} agentLaunch={remoteAgentLaunch.state} onStartAgent={remoteAgentLaunch.start} onCancelAgent={remoteAgentLaunch.cancel} onClose={() => mobile.setShowConnect(false)} onStart={(confirmed) => void mobile.start(confirmed)} onStop={() => void mobile.stop()} onRevoke={(deviceId) => void mobile.revoke(deviceId)} onOpenAgentConnect={() => { mobile.setShowConnect(false); setReturnToRemoteAfterAgent(true); setAgentConnectOpened(true); }} /></Suspense>
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
      {agentConnectOpened && <Suspense fallback={null}><AgentConnectModal onClose={closeAgentConnect} onConnect={desktopActions.connectAgent} /></Suspense>}
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


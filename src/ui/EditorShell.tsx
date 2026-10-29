import { EditingWorkspaceNavigationV1 } from "./EditingWorkspaceNavigationV1";
import { EditingLayerStackV1 } from "./EditingLayerStackV1";
import { EditingGraphicPropertiesV1 } from "./EditingGraphicPropertiesV1";
import { editingLayerSelectionChangeV1 } from "./editingLayerSelectionV1";
import { createGraphicEditingSelectionV1 } from "../application/graphicEditingSelectionV1";
import { createMotionGraphicEditActionsV1 } from "../application/motionGraphicEditActionsV1";
import { createGraphicParameterGestureV1, type GraphicNumberGestureStartV1 } from "../application/graphicParameterGestureV1";
import { createClipAppearanceEditsV1, clipAppearanceNumberValuesV1 } from "../application/clipAppearanceEditsV1";
import { createNativeEffectParameterGestureV1 } from "../application/nativeEffectParameterGestureV1";
import { createClipParameterGestureV1 } from "../application/clipParameterGestureV1";
import { createClipGradeEditsV1 } from "../application/clipGradeEditsV1";
import { createCaptionEditingActionsV1, captionBackgroundOpacityV1, captionBackgroundWithOpacityV1, normalizeCaptionStylePatchV1 } from "../application/captionEditingActionsV1";
import { createCaptionParameterGestureV1 } from "../application/captionParameterGestureV1";
import { activeMediaLayers } from "../application/previewMedia";
import { clipAttachments } from "../application/timelineMotionEdits";
import { templateOwnerByGraphic } from "./templateEditorRequests";
import type { EditingWorkspaceV1, EditingLayerSelectionV1 } from "./editingWorkspaceV1";
import type { BeginnerGuidePage } from "./BeginnerGuide";
import { CounterTickControlsV1 } from "./CounterTickControlsV1";
import { AutoReframeDesktopControlV1 } from "./AutoReframeDesktopControlV1";
import { createAutoReframeAppHostV1 } from "../application/autoReframeAppHostV1";
import { planAudioDetach } from "../application/audioDetach";
import { useColorGradeClipboardV1 } from "./useColorGradeClipboardV1";
import { colorGradeClipboardActionsV1 } from "./colorGradeClipboardActionsV1";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
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
import { planAddClipKeyframeV1 } from "../application/clipKeyframeAddV1";
import { createClipMask, resolveMaskPath } from "../domain/masks";
import type { EditorHistory } from "../domain/history";
import { DEFAULT_COLOR_MANAGEMENT } from "../domain/types";
import { motionClipPresetCommands } from "../motion/motionClipPresets";
import { floatingFrameSceneCommands } from "../motion/floatingFrameScenes";
import { prepareReferenceMotionTemplateInstance, prepareReferenceMotionTemplateRevision } from "../application/referenceMotionTemplateInstances";
import { prepareReferenceMotionTemplateReuse } from "../application/referenceMotionTemplateReuse";
import { prepareReferenceMotionSourceReplacementForUi } from "../desktop/referenceMotionSourcePreparation";
import { SOURCE_REPLACEMENT_MESSAGES, type ReferenceMotionSourceReplacementRequest } from "../application/referenceMotionSourceReplacement";
import type { PickedMedia } from "../desktop/mediaTypes";
import { ReferenceMotionSourceClipControl, hasReferenceMotionSourceOwner } from "./SavedReferenceMotionSourceReplacement";
import type { CaptionCue, ClipLayout, EditProject, MotionGraphicKind, MotionGraphicPresetSeed, MotionTrack, NormalizedRect, TimelineClip } from "../domain/types";
import { makeId } from "../lib/format";
import type { EditorTheme } from "./theme";
import { Toolbar } from "./Toolbar";
import { useI18n } from "./i18n/interfacePreferences";
import { OperationStatus } from "./OperationStatus";
import { saveStateMessage } from "./saveStateLabel";
import { ProjectDownloadNotice } from "./ProjectDownloadNotice";
import { SavedReferenceMotionInstances, runReferenceMotionUiPreparation, type ReferenceMotionUiPreparationOptions } from "./SavedReferenceMotionInstances";
import { SavedOriginalMotionScenes } from "./SavedOriginalMotionScenes";
import { prepareOriginalSceneGraphicRevision } from "../application/originalSceneGraphicRevision";
import { MediaImportStatus } from "./MediaImportStatus";
import { WorkspaceResizeHandle } from "./WorkspaceResizeHandle";
import { useWorkspaceLayout } from "./workspaceLayout";
import { useMotionLibraryWiringV1 } from "./useMotionLibraryWiringV1";
import { useEasyFlowHost } from "./easy/useEasyFlowHost";
import { useShellSafety } from "./useShellSafety";
import { ProjectOutsideMediaPrompt } from "./ProjectOutsideMediaPrompt";
import { autoRotoRuntimeStatusFromReceipt, initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import { runAutoRotoAction } from "../application/runAutoRotoAction";
import { acceptProjectTask } from "../application/projectTask";
import { PROJECT_FORMATS, type ProjectFormat } from "../application/projectFormats";
import { planTimelineClipMove } from "../application/timelinePlacement";
import { resolveTimelineImportPlacement } from "./internalAssetPointerDrag";
import { createClipSourceEditActions } from "../application/clipSourceEditActions";
import { createClipNativeEffectEditsV1 } from "../application/clipNativeEffectEditsV1";
import { createScene25dSettingsEditActionsV1 } from "../application/scene25dSettingsEditsV1";
import { createClipPresetEffectEditActionsV1 } from "../application/clipPresetEffectEditsV1";
import { createAttachedClipMoveActions } from "../application/attachedClipMoveActions";
import { NOTHING_TO_REDO, NOTHING_TO_UNDO, useHistoryShortcutGuard } from "../desktop/useEditorShortcuts";
import { clampProjectSeek } from "./playbackTiming";
import { useProjectEndPlayheadClamp } from "./playheadBounds";
import type { ProjectTask } from "../application/projectSession";
import "./layoutHardening.css";
import "./projectFormatControl.css";
import "./mediaImportStatus.css";
import "./accessibleWorkspace.css";
import "./simpleWorkspace.css";

import { AgentConnectModal, AutoEditDialog, AgentPanel, BatchAutoEditPanel, BeginnerGuide, ColorWorkspace, EditingProfilePicker, FirstProjectStart, Inspector, MediaBin, MobileConnectModal, Preview, Timeline, WorkspaceDropImport, BEGINNER_GUIDE_KEY } from "./editorShellLazy";
import type { EditorShellProps, TrackingMode } from "./editorShellTypes";
import type { TimelineEditOptions } from "./timelineContract";
export type { TrackingMode } from "./editorShellTypes";

import { planTimelineClipLink } from "../application/timelineLinkedEdits";
import { ClipLayerHostContextV1, type ClipLayerHostV1 } from "./clipLayerHostV1";
import { adjustmentLayerRangeV1, planAdjustmentLayerV1 } from "../application/adjustmentLayerPlanV1";
import type { TransformNumberFieldV1 } from "./ClipAppearanceNumberFieldsV1";
import { PlayheadStoreContext, shallowEqualRecord, usePlayheadSnapshot, type PlayheadStore } from "./playheadStore";
import type { PlayheadTransportState } from "./playheadTransport";
import { LiveClipLayerHostV1, LivePlayhead } from "./LivePlayhead";

export function EditorShell(props: EditorShellProps) {
  const gradeClipboard = useColorGradeClipboardV1(props.projectSession);
  const { t, mode, modeRevision } = useI18n();
  const [activeWorkspace, setActiveWorkspace] = useState<EditingWorkspaceV1>("edit");
  const [effectsLibraryRequest, setEffectsLibraryRequest] = useState(0);
  const graphicSelectionState = useMemo(() => createGraphicEditingSelectionV1(props.projectSession, {
    getSelection: props.getTimelineSelection, subscribe: props.subscribeTimelineSelection,
  }), [props.projectSession, props.getTimelineSelection, props.subscribeTimelineSelection]);
  const graphicSelectionSnapshot = useSyncExternalStore(graphicSelectionState.subscribe, graphicSelectionState.getSnapshot, graphicSelectionState.getSnapshot);
  const effectRegistryRef = useRef(props.creativeLibrary.plugins);
  effectRegistryRef.current = props.creativeLibrary.plugins;
  const effectParameterGesture = useMemo(() => createNativeEffectParameterGestureV1({
    session: props.projectSession, getSelectionSnapshot: graphicSelectionState.getSnapshot,
    subscribeSelection: graphicSelectionState.subscribe, getRegistry: () => effectRegistryRef.current,
  }), [props.projectSession, graphicSelectionState]);
  const effectParameterDraft = useSyncExternalStore(effectParameterGesture.subscribe, effectParameterGesture.getSnapshot, effectParameterGesture.getSnapshot);
  const clipParameterGesture = useMemo(() => createClipParameterGestureV1({ session: props.projectSession,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, subscribeSelection: graphicSelectionState.subscribe,
  }), [props.projectSession, graphicSelectionState]);
  const clipParameterDraft = useSyncExternalStore(clipParameterGesture.subscribe, clipParameterGesture.getSnapshot, clipParameterGesture.getSnapshot);
  const graphicParameterRef = useRef<ReturnType<typeof createGraphicParameterGestureV1> | null>(null);
  const captionParameterGesture = useMemo(() => createCaptionParameterGestureV1({ session: props.projectSession,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, subscribeSelection: graphicSelectionState.subscribe, setStatus: props.setStatus,
    onBegin: () => { clipParameterGesture.cancel(); effectParameterGesture.cancel(); graphicParameterRef.current?.cancel(); },
  }), [props.projectSession, graphicSelectionState, clipParameterGesture, effectParameterGesture, props.setStatus]);
  const captionParameterDraft = useSyncExternalStore(captionParameterGesture.subscribe, captionParameterGesture.getSnapshot, captionParameterGesture.getSnapshot);
  const graphicParameterGesture = useMemo(() => createGraphicParameterGestureV1({ session: props.projectSession,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, subscribeSelection: graphicSelectionState.subscribe, setStatus: props.setStatus,
    onBegin: () => { clipParameterGesture.cancel(); effectParameterGesture.cancel(); captionParameterGesture.cancel(); },
  }), [props.projectSession, graphicSelectionState, clipParameterGesture, effectParameterGesture, captionParameterGesture, props.setStatus]);
  graphicParameterRef.current = graphicParameterGesture;
  const graphicParameterDraft = useSyncExternalStore(graphicParameterGesture.subscribe, graphicParameterGesture.getSnapshot, graphicParameterGesture.getSnapshot);
  const admitOtherParameterGesture = <T,>(lease: T): T => { if (lease) graphicParameterGesture.cancel(); return lease; };
  const graphicSelection = graphicSelectionSnapshot.selection;
  const [compactPane, setCompactPane] = useState<"media" | "preview" | "inspector">("preview");
  const [compactWorkspace, setCompactWorkspace] = useState(() => window.innerWidth < 1040);
  const toolbarMediaInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const resize = () => setCompactWorkspace(window.innerWidth < 1040);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
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
  const [beginnerGuideOpened, setBeginnerGuideOpened] = useState(false);
  // 說明 opens the guide on its four steps; "?" opens it on the 快捷鍵 page.
  const [beginnerGuidePage, setBeginnerGuidePage] = useState<BeginnerGuidePage>("steps");
  const openBeginnerGuide = (page: BeginnerGuidePage) => { setBeginnerGuidePage(page); setBeginnerGuideOpened(true); };
  // The right-hand panel is always shown on a wide window (it says 點一下片段或字幕 until something is picked); on a narrow
  // window picking something switches to its tab. (2026-10-23: the old open/closed state here was set but never read.)
  const workspace = useWorkspaceLayout();
  const previousModeRevision = useRef(modeRevision);
  useEffect(() => {
    if (previousModeRevision.current === modeRevision) return;
    previousModeRevision.current = modeRevision;
    workspace.choosePreset(mode === "advanced" ? "edit" : "simple");
    
    setCompactPane("preview");
  }, [mode, modeRevision, workspace.choosePreset]);
  const {
    history, project, duration, theme, setTheme, isDesktop, playheadStore, setPlayhead, onPlaybackClock, playing, setPlaying,
    playbackRate, setPlaybackRate, togglePlayback, pausePlayback, shuttlePlayback, frameStepPlayback,
    selectedClipId, setSelectedClipId, selectedCaptionId, setSelectedCaptionId, selectedClip,
    selectedCaption, transitionNeighbors, selectedMotionTracks,
    runtimeUrls, missingMedia, relinkBrowserMedia, projectDownload, cancelProjectDownload, status, setStatus, trackingMode, setTrackingMode, trackingSelection,
    setTrackingSelection, trackingBusy, recovery, desktopActions, automatic, creativeLibrary, batchAutoEdit, mobile,
    newProject, openProject, saveProject, undoEdit, redoEdit, renderVideo, renderOpenExrSequence, renderAlphaMaster, importFiles,
    acceptTrackingSelection, startPodcastDirector, submitAgentInstruction, runCommand,
    addMotionGraphic, addCaption, addTrack, addAssetToTimeline, makeSelectedPictureInPicture, precomposeSelected, applyShortFormTemplate, applyLongFormTemplate, addLowerThird, clearTemplateApplication, splitSelected, deleteSelected,
  } = props;
  const clipSourceTask = props.projectSession.beginTask(project);
  const clipSourceSessionId = props.projectSession.getSnapshot().sessionId;
  // PF1 (2026-10-23): the shell does not re-render on a seek or a clock tick. Commands read the transport the editor last
  // rendered when they run (as they read this render's playhead before); what is shown at the playhead comes from the
  // subscribing hosts below (the preview runtime, the Inspector's live values, LivePlayhead).
  const renderedTransport = () => { const state = playheadStore.rendered(); return { playhead: state.time, seekRevision: state.seekRevision }; };
  const shellPlayhead = playheadStore.rendered().time;
  const parameterPreviewProject = graphicParameterDraft.preview?.project ?? captionParameterDraft.preview?.project ?? clipParameterDraft.preview?.project ?? effectParameterDraft.preview?.project ?? project;
  const parameterPreviewEpoch = graphicParameterDraft.epoch + captionParameterDraft.epoch + clipParameterDraft.epoch + effectParameterDraft.epoch;
  const captionEdits = createCaptionEditingActionsV1({ getSnapshot: props.projectSession.getSnapshot,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, runCommand, setStatus },
    { project, captionId: selectedCaption?.id, selection: graphicSelectionSnapshot });
  // One appearance edit owner per rendered transport, as when the shell rendered once per transport: its view is that
  // transport, and its first project snapshot is this render's (the owner used to be built while rendering).
  const shellSessionSnapshot = props.projectSession.getSnapshot();
  const appearanceOwner: { transport?: PlayheadTransportState; edits?: ReturnType<typeof createClipAppearanceEditsV1> } = {};
  const clipAppearanceEdits = () => {
    const transport = playheadStore.rendered();
    if (appearanceOwner.transport !== transport || !appearanceOwner.edits) {
      let captured = false;
      appearanceOwner.transport = transport;
      appearanceOwner.edits = createClipAppearanceEditsV1({ getSnapshot: () => { if (captured) return props.projectSession.getSnapshot(); captured = true; return shellSessionSnapshot; },
        getSelectionSnapshot: graphicSelectionState.getSnapshot, getTransport: renderedTransport,
        runCommand, setStatus, makeId }, { project, clipId: selectedClip?.id, selection: graphicSelectionSnapshot,
        transport: { playhead: transport.time, seekRevision: transport.seekRevision } });
    }
    return appearanceOwner.edits;
  };
  // Each method belongs to the owner of the moment it is read (a gesture keeps the owner it began with, as before).
  const clipAppearance = {
    get transform() { return clipAppearanceEdits().transform; }, get color() { return clipAppearanceEdits().color; },
    get baseColor() { return clipAppearanceEdits().baseColor; }, get volume() { return clipAppearanceEdits().volume; },
    get transform3d() { return clipAppearanceEdits().transform3d; }, get planTransform() { return clipAppearanceEdits().planTransform; },
    get planColor() { return clipAppearanceEdits().planColor; }, get planBaseColor() { return clipAppearanceEdits().planBaseColor; },
    get planVolume() { return clipAppearanceEdits().planVolume; },
  };
  // The values at the playhead: shown by the Inspector host, read when a gesture starts.
  const appearanceValuesAt = (time: number) => selectedClip ? clipAppearanceNumberValuesV1(selectedClip, time, project.fps) : undefined;
  // A number draft is dropped when the selection changes (this scope) or the playhead or a seek moves (the signal).
  const appearanceEditScope = useMemo(() => ({ selection: graphicSelectionSnapshot }), [graphicSelectionSnapshot]);
  const appearanceScopeSignal = useMemo(() => ({ subscribe: playheadStore.subscribeRendered }), [playheadStore]);
  // One drag or typed draft of 位置／大小／旋轉／不透明度: a preview without history, then one command (one Undo).
  const beginTransformNumberGesture = (field: TransformNumberFieldV1) => {
    const transport = renderedTransport(), appearanceValues = appearanceValuesAt(transport.playhead), appearance = clipAppearanceEdits();
    if (!selectedClip || !appearanceValues || !["x", "y", "scale", "rotation", "opacity"].includes(field)) return undefined;
    const initial = appearanceValues.transform[field];
    if (!Number.isFinite(initial)) return undefined;
    const plan = (value: number) => appearance.planTransform({ [field]: value });
    const initialPlan = plan(initial);
    if (!initialPlan || initialPlan.command) return undefined;
    const lease = clipParameterGesture.begin({ clipId: selectedClip.id, selection: graphicSelectionSnapshot,
      parameterId: "transform." + field, initial, plan, commit: value => appearance.transform({ [field]: value }),
      isCurrent: () => renderedTransport().playhead === transport.playhead && renderedTransport().seekRevision === transport.seekRevision });
    if (lease) { effectParameterGesture.cancel(); captionParameterGesture.cancel(); }
    return admitOtherParameterGesture(lease);
  };
  // Hovering 混合模式 options: the same transient owner as the sliders, so a hover is never a history step.
  const beginBlendGesture = () => {
    if (!selectedClip) return undefined;
    const clipId = selectedClip.id, initial = selectedClip.layer?.blendMode ?? "normal";
    const lease = clipParameterGesture.beginLayer({ clipId, selection: graphicSelectionSnapshot, parameterId: "layer.blendMode", initial,
      plan: mode => mode === initial ? {} : { command: { type: "set_clip_layer", clipId, patch: { blendMode: mode } } },
      commit: mode => runCommand({ type: "set_clip_layer", clipId, patch: { blendMode: mode } }, "已更新混合模式，可復原。") === true });
    if (lease) { effectParameterGesture.cancel(); captionParameterGesture.cancel(); }
    return admitOtherParameterGesture(lease);
  };
  const addKeyframeAtPlayhead = () => {
    if (!selectedClip) return;
    // The keyframe holds the clip's own values: an expression keeps running on top of it instead of twice.
    const plan = planAddClipKeyframeV1(selectedClip, renderedTransport().playhead, project.fps, makeId("keyframe"));
    runCommand(plan.command, plan.message);
  };
  const deleteKeyframe = (keyframeId: string) => {
    if (selectedClip) runCommand({ type: "delete_keyframe", clipId: selectedClip.id, keyframeId }, "已刪除關鍵幀。");
  };
  // ＋ 調整圖層 (圖層 panel and advanced 更多工具): over the marked I/O range or the selected clip, one batch, one Undo;
  // the new layer is selected so 調色 applies to it.
  const adjustmentLayerReady = Boolean(adjustmentLayerRangeV1(project, selectedClip?.id, props.markRange));
  const addAdjustmentLayer = () => {
    try {
      const plan = planAdjustmentLayerV1(props.projectSession.getSnapshot().history.present,
        { selectedClipId: selectedClip?.id, markRange: props.markRange, trackName: t("調整圖層") }, makeId);
      if (runCommand(plan.command, "已加入調整圖層：選取它後到「調色」調整，會套用到下方所有畫面；可復原。") === false) return;
      pausePlayback(); setSelectedCaptionId(undefined); setSelectedClipId(plan.clipId);
    } catch (error) { setStatus(error instanceof Error ? error.message : "無法加入調整圖層。"); }
  };
  // Inspector › 調整 › 混合 and the 圖層與表達式 pickers reach the shell's owners through this (no new Inspector props).
  const layerDraft = selectedClip && clipParameterDraft.preview?.clipId === selectedClip.id ? clipParameterDraft.preview : undefined;
  const clipLayerHost: ClipLayerHostV1 = {
    project, clipId: selectedClip?.id, playhead: shellPlayhead, fps: project.fps, opacity: appearanceValuesAt(shellPlayhead)?.transform.opacity,
    editScope: appearanceEditScope, editScopeSignal: appearanceScopeSignal, opacityAt: time => appearanceValuesAt(time)?.transform.opacity,
    // LiveClipLayerHostV1 shows these at the live playhead.
    opacityPreviewAt: time => selectedClip && layerDraft?.parameterId === "transform.opacity"
      ? clipAppearanceNumberValuesV1(findClip(layerDraft.project, selectedClip.id), time, project.fps).transform.opacity : undefined,
    blendPreview: selectedClip && layerDraft?.parameterId === "layer.blendMode" ? findClip(layerDraft.project, selectedClip.id).layer?.blendMode : undefined,
    onLayerChange: patch => selectedClip ? runCommand({ type: "set_clip_layer", clipId: selectedClip.id, patch }, "已更新圖層合成設定。") : false,
    onOpacityChange: opacity => clipAppearance.transform({ opacity }),
    beginOpacityGesture: () => beginTransformNumberGesture("opacity"),
    beginBlendGesture, onAddKeyframe: addKeyframeAtPlayhead, onDeleteKeyframe: deleteKeyframe,
  };
  const clipGradeEdits = createClipGradeEditsV1({ getSnapshot: props.projectSession.getSnapshot,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, runCommand, setStatus },
    { project, clipId: selectedClip?.id, selection: graphicSelectionSnapshot });
  const moveTimelineClip = (clipId: string, timelineStart?: number, trackId?: string, options?: TimelineEditOptions) => {
    try {
      const currentProject = props.projectSession.getSnapshot().history.present;
      const currentClip = findClip(currentProject, clipId);
      const placement = planTimelineClipMove(currentProject, clipId, trackId ?? currentClip.trackId,
        timelineStart ?? currentClip.timelineStart, makeId);
      const message = placement.newLayer ? "已移到指定影格並新增圖層；原片段保留，一次復原即可還原。" : "已移到指定影格，可復原。";
      return options ? runCommand(placement.command, message, options) : runCommand(placement.command, message);
    } catch (error) { setStatus(error instanceof Error ? error.message : "無法移動片段。"); return false; }
  };
  // Longer clips and new in-points: one command per accepted gesture, against the live project.
  const clipSourceEdits = createClipSourceEditActions({ getProject: () => props.projectSession.getSnapshot().history.present, runCommand, setStatus });
  const presetEffectEdits = createClipPresetEffectEditActionsV1({ getSnapshot: props.projectSession.getSnapshot, runCommand, setStatus });
  const sceneSettingsEdits = createScene25dSettingsEditActionsV1({ getSnapshot: props.projectSession.getSnapshot, runCommand, setStatus });
  const effectStackEdits = createClipNativeEffectEditsV1({ getSnapshot: props.projectSession.getSnapshot,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, getRegistry: () => creativeLibrary.plugins, runCommand, setStatus },
    { project, clipId: selectedClip?.id, selection: graphicSelectionSnapshot });
  // Inspector start-time and layer edits: the titles and title template on a clip move with it, as one Undo.
  const attachedClipMoves = createAttachedClipMoveActions({ getProject: () => props.projectSession.getSnapshot().history.present, runCommand, setStatus, makeId, plainMove: moveTimelineClip });
  // Empty-history Undo/Redo shortcuts report that nothing changed instead of success.
  useHistoryShortcutGuard(history.past.length > 0, history.future.length > 0, setStatus);
  // (The end clamp lives in EditorPreviewRuntimeV1, which renders with the playhead.)
  // Unchanged is not saved: a new or demo project has no file on disk yet.
  const hasProjectFile = Boolean(props.projectSession.getSnapshot().projectPath);
  useEffect(() => { referenceTemplateOperation.current?.abort(); }, [selectedClipId]);
  const cancelReferenceTemplate = () => {
    if (!referenceTemplateOperation.current) return;
    referenceTemplateOperation.current.abort();
    setStatus("正在取消；畫面不會被改。");
  };
  const prepareReferenceInstance = (prepare: ReferenceMotionUiPreparationOptions["prepare"], action = "更新標題模板") => {
    if (referenceTemplateOperation.current) return;
    pausePlayback();
    const controller = new AbortController(); referenceTemplateOperation.current = controller;
    setReferenceTemplateBusy(true); setStatus("正在更新標題模板，好了會一次套用…");
    void runReferenceMotionUiPreparation({ project, session: props.projectSession, controller, prepare,
      action, isMounted: () => referenceTemplateMounted.current, onStatus: setStatus,
      onCommand: (command, message, context) => runCommand(command, message, undefined, context),
      successMessage: action === "更換模板影片" ? SOURCE_REPLACEMENT_MESSAGES.success : undefined,
      onPrepared: prepared => { if (prepared.preparedMedia?.length && prepared.pickedMedia) creativeLibrary.acceptPreparedMedia(prepared.preparedMedia, prepared.pickedMedia); },
    }).finally(() => {
      if (referenceTemplateOperation.current === controller) {
        referenceTemplateOperation.current = undefined;
        if (referenceTemplateMounted.current) setReferenceTemplateBusy(false);
      }
    });
  };
  const replaceReferenceSource = (request: ReferenceMotionSourceReplacementRequest, picked?: PickedMedia) => {
    if (creativeLibrary.hasPendingMediaImport()) return setStatus("正在匯入影片，完成後再更換模板影片。");
    prepareReferenceInstance((prepareText, signal) => prepareReferenceMotionSourceReplacementForUi(project, request, picked, window.haoDesktop, makeId, { prepareText, signal }), "更換模板影片");
  };
  // The browser build has no local Whisper/FFmpeg/Rust engines; say so up front instead of failing after a click.
  const engineUnavailableReason = isDesktop ? undefined : "網頁版沒有本機 Whisper／FFmpeg 引擎，這項功能需要桌面版。";
  const selectedAsset = selectedClip ? project.assets.find((asset) => asset.id === selectedClip.assetId) : undefined;
  const hasUserMedia = project.assets.some((asset) => asset.id !== "asset-demo");
  const hasAuthoredGraph = project.motionGraphics.length > 0 || (project.motionScenes?.length ?? 0) > 0 || project.captions.length > 0;
  // Simple mode starts with the easy flow; it keeps the start screen while it owns the chosen video.
  const easyFlow = useEasyFlowHost(props, mode, () => setDemoWorkspaceOpened(true));
  const showWelcome = easyFlow.holdsStart || (!hasUserMedia && !hasAuthoredGraph && !demoWorkspaceOpened);
  // Plain problem notices, export panel, close guard, moved media, project changes by other programs, Save As / recent.
  const shellSafety = useShellSafety(props, { showWelcome, translate: t });
  // The resident GPU preview, the native effect previews, the playback clock and the end clamp move with the playhead:
  // EditorPreviewRuntimeV1 (always mounted with the shell, as these were) renders them on a tick, not the shell.
  const gpuPreviewEnabled = isDesktop && !showWelcome && !trackingMode && playbackRate === 1 && (!compactWorkspace || compactPane === "preview");
  const nativeEffectPreviewEnabled = isDesktop && !showWelcome && !trackingMode && (!compactWorkspace || compactPane === "preview");
  const remoteAgentLaunch = useRemoteAgentLaunch(window.haoDesktop);
  // Simple mode is one calm layout: the media panel and the timeline always show, the automation panel belongs to
  // 進階模式, and the right-hand panel opens for what the person picked. A layout saved by an older version or in
  // advanced mode cannot hide or pin them here.
  const simpleMode = mode === "simple";
  const graphicCandidate = project.motionGraphics.find(graphic => graphic.id === graphicSelection?.id);
  const selectedGraphic = graphicCandidate;
  const attachedGraphics = useMemo(() => selectedClip ? clipAttachments(project, selectedClip.id).graphics : [], [project, selectedClip]);
  const selectedGraphicTemplate = useMemo(() => selectedGraphic ? templateOwnerByGraphic(project).get(selectedGraphic.id)?.id : undefined, [project, selectedGraphic]);
  const graphicEdits = createMotionGraphicEditActionsV1({ getSnapshot: props.projectSession.getSnapshot,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, runCommand, setStatus }, {
    project, selection: graphicSelectionSnapshot, ...(selectedClip ? { clipId: selectedClip.id } : {}),
  });
  const graphicLibraryDeletes = createMotionGraphicEditActionsV1({ getSnapshot: props.projectSession.getSnapshot,
    getSelectionSnapshot: graphicSelectionState.getSnapshot, runCommand, setStatus }, {
    project, selection: graphicSelectionSnapshot, libraryDeleteOnly: true,
  });
  const beginGraphicTextGesture = (graphicId: string) => {
    const graphic = project.motionGraphics.find(item => item.id === graphicId);
    return graphic ? graphicParameterGesture.begin({ project, graphicId, clipId: selectedClip?.id, selection: graphicSelectionSnapshot,
      initial: graphic.text, plan: value => graphicEdits.planUpdate(graphicId, { text: value }), commit: value => graphicEdits.update(graphicId, { text: value }) }) : undefined;
  };
  const beginGraphicNumberGesture: GraphicNumberGestureStartV1 = (graphicId, request) => graphicParameterGesture.beginNumber({
    project, graphicId, clipId: selectedClip?.id, selection: graphicSelectionSnapshot,
    parameterId: request.parameterId, initial: request.initial, normalize: request.normalize,
    plan: value => graphicEdits.planUpdate(graphicId, request.patch(value)), commit: value => graphicEdits.update(graphicId, request.patch(value)),
  });
  const layerSelection = useMemo<EditingLayerSelectionV1 | undefined>(() => selectedGraphic ? { kind: "graphic", id: selectedGraphic.id } : selectedCaption ? { kind: "caption", id: selectedCaption.id } : selectedClip ? { kind: "clip", id: selectedClip.id } : undefined, [selectedGraphic, selectedCaption, selectedClip]);
  const selectLayer = useCallback((selection: EditingLayerSelectionV1) => {
    if (props.projectSession.getSnapshot().sessionId !== clipSourceSessionId) return;
    const next = editingLayerSelectionChangeV1(selection, clipSourceSessionId);
    pausePlayback();
    setSelectedClipId(next.clipId); setSelectedCaptionId(next.captionId); graphicSelectionState.select(next.graphic);
    if (next.workspace) setActiveWorkspace(next.workspace);
    if (compactWorkspace) setCompactPane("inspector");
  }, [setSelectedClipId, setSelectedCaptionId, compactWorkspace, clipSourceSessionId, pausePlayback, props.projectSession, graphicSelectionState]);
  const hasSelection = Boolean(selectedClip || selectedCaption || selectedGraphic);
  const mediaShown = true;
  const timelineShown = true;
  const automationShown = activeWorkspace === "edit" && !simpleMode && workspace.layout.automationVisible;
  const inspectorShown = compactWorkspace ? compactPane === "inspector" : true;
  const previouslySelected = useRef(hasSelection);
  useEffect(() => {
    // Simple mode on a narrow window: once the picked item is deleted, show the picture again instead of an empty panel.
    if (previouslySelected.current && !hasSelection && simpleMode && compactPane === "inspector") setCompactPane("preview");
    previouslySelected.current = hasSelection;
  }, [hasSelection, simpleMode, compactPane]);
  const workspaceColumns = useMemo(() => [
    `minmax(220px,min(${workspace.layout.mediaWidth}px,28vw)) 8px`, "minmax(0,1fr)",
    inspectorShown ? `8px minmax(${activeWorkspace === "color" ? 360 : 286}px,min(${workspace.layout.inspectorWidth}px,34vw))` : "",
  ].filter(Boolean).join(" "), [activeWorkspace, inspectorShown, workspace.layout.inspectorWidth, workspace.layout.mediaWidth]);
  const shellStyle = {
    "--timeline-height": timelineShown ? `${workspace.layout.timelineHeight}px` : "0px",
  } as CSSProperties;
  const importState=creativeLibrary.importState;
  const importActive=Boolean(importState&&importState.phase!=="idle"&&importState.sessionId===props.projectSession.getSnapshot().sessionId);
  const relinkActive = !showWelcome && !isDesktop && missingMedia.length > 0;
  const closeBeginnerGuide = () => {
    try { window.localStorage.setItem(BEGINNER_GUIDE_KEY, "done"); } catch { /* Optional preference. */ }
    setBeginnerGuideOpened(false);
  };
  const openAgentConnect = (returnToRemote = false) => {
    closeBeginnerGuide();
    setReturnToRemoteAfterAgent(returnToRemote);
    setAgentConnectOpened(true);
  };
  const shortcutsBlocked = beginnerGuideOpened || batchAutoEdit.show || mobile.showConnect || agentConnectOpened || autoEditOpened;
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
      // "?" opens the guide on its 快捷鍵 page whatever button has focus, like the editor's other keys; never while typing.
      if (shortcutsBlocked || target?.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        openBeginnerGuide("shortcuts");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [beginnerGuideOpened, shortcutsBlocked]);

  const runAutoRoto = (maskId: string, sourceProject = project) => runAutoRotoAction({
    projectSession: props.projectSession, project: sourceProject, clipId: selectedClipId, maskId, playhead: renderedTransport().playhead,
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

  const openSelectionInspector = () => {
    pausePlayback();
    
    
    if (!simpleMode) workspace.patch({ inspectorVisible: true });
    setCompactPane("inspector");
  };
  // Simple mode has no 調整片段 button: clicking a clip, text or title shows its panel (on a narrow window, its tab).
  const revealSelectionPanel = () => {
    if (simpleMode && compactWorkspace) setCompactPane("inspector");
  };
  // 動態素材庫: the 動態 tab, the inspector section, the timeline cut points and its keys (wiring only; the GUI lives in its own files).
  const motionLibrary = useMotionLibraryWiringV1({ project, projectSession: props.projectSession, runCommand, setStatus, playhead: shellPlayhead, getPlayhead: () => renderedTransport().playhead, selectedClipId, selectedClip,
    selectClip: clipId => { setSelectedCaptionId(undefined); setSelectedClipId(clipId); }, clearSelection: () => { setSelectedClipId(undefined); setSelectedCaptionId(undefined); },
    revealSelection: openSelectionInspector, mergeRuntimeUrls: props.mergeRuntimeUrls, pause: pausePlayback, keyboard: props.motionLibraryKeyboard,
    onPanelRequest: () => { if (compactWorkspace) setCompactPane("media"); } });
  const changeProjectFormat = (format: ProjectFormat) => runCommand({ type: "set_project_resolution", width: format.width, height: format.height },
    t("專案比例已改成 {ratio} {name}；素材位置與裁切仍可逐片調整。", { ratio: format.ratio, name: t(format.label) }));

  return (
    <PlayheadStoreContext.Provider value={playheadStore}><EditorPreviewRuntimeV1 store={playheadStore} project={project} parameterPreviewProject={parameterPreviewProject}
      parameterPreviewEpoch={parameterPreviewEpoch} runtimeUrls={runtimeUrls} duration={duration} playing={playing} setPlaying={setPlaying}
      setPlayhead={setPlayhead} onPlaybackClock={onPlaybackClock} gpuEnabled={gpuPreviewEnabled} effectEnabled={nativeEffectPreviewEnabled}>
    <main className="app-shell" data-interface-mode={mode} data-timeline-visible={timelineShown} data-editing-workspace={activeWorkspace} data-compact-workspace={compactWorkspace} data-active-pane={compactPane} data-import-active={importActive} data-workspace-notice={importActive || relinkActive || shellSafety.hasNotices} data-shortcuts-blocked={shortcutsBlocked} data-workspace-mode={showWelcome ? "welcome" : "editor"} data-text-size={workspace.layout.textSize} style={shellStyle}>
      <input ref={toolbarMediaInput} className="visually-hidden" type="file" accept="video/*,audio/*,image/*" multiple data-testid="toolbar-media-input"
        onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length) void importFiles(files); }} />
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
        onAddMedia={() => { if (isDesktop) void creativeLibrary.importDesktopMedia(); else toolbarMediaInput.current?.click(); }}
        onEdit={() => { setActiveWorkspace("edit"); setCompactPane("preview"); }}
        projectName={project.name}
        hasUserMedia={hasUserMedia}
        workspaceMode={showWelcome ? "welcome" : "editor"}
        theme={theme}
        onThemeChange={setTheme}
        dirty={recovery.dirty}
        hasProjectFile={hasProjectFile}
        recoveryState={recovery.recoveryState}
        playhead={shellPlayhead}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        isDesktop={isDesktop}
        onNew={() => { setDemoWorkspaceOpened(false); newProject(); }}
        onOpen={openProject}
        onSave={() => void saveProject()}
        onUndo={() => history.past.length ? undoEdit() : setStatus(NOTHING_TO_UNDO)}
        onRedo={() => history.future.length ? redoEdit() : setStatus(NOTHING_TO_REDO)}
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
        onHelp={() => openBeginnerGuide("steps")}
        textSize={workspace.layout.textSize}
        onTextSizeChange={(textSize) => workspace.patch({ textSize })}
        projectFormat={{ width: project.width, height: project.height, onChange: changeProjectFormat }}
        {...shellSafety.toolbar}
      />
      {!showWelcome && <EditingWorkspaceNavigationV1 active={activeWorkspace} onChange={next => { setActiveWorkspace(next); if (compactWorkspace) setCompactPane(next === "edit" ? "preview" : "inspector"); }} />}
      {(importActive || relinkActive || shellSafety.hasNotices) && <div className="workspace-notices">
        {shellSafety.notices}
        {importActive&&importState?<MediaImportStatus state={importState} onRetry={()=>void creativeLibrary.retryFailedImports()}/>:null}
        {relinkActive && <section className="media-import-status" data-testid="missing-media-relink" aria-label={t("缺失素材重新連結")}>
          <div><strong>{t("專案已開啟，請重新連結素材")}</strong><span>{t("逐一選取原檔；瀏覽器重開後需再次選檔。")}</span></div>
          {missingMedia.map(asset => <button key={asset.id} type="button" className="secondary-action" data-testid={`relink-media-${asset.id}`} onClick={() => void relinkBrowserMedia(asset.id)} disabled={Boolean(asset.imageSequence)} title={asset.imageSequence ? t("OpenEXR 序列需要桌面版") : t("為 {name} 選取原始檔案", { name: asset.name })}>{asset.name}{t(" · 重新連結")}</button>)}
        </section>}
      </div>}
      <ProjectOutsideMediaPrompt session={props.projectSession} enabled={!showWelcome} />
      {showWelcome ? <Suspense fallback={<section className="first-project-loading" aria-label={t("正在準備開始畫面")} />}><FirstProjectStart
        isDesktop={isDesktop}
        onImport={importFiles}
        onDesktopImport={isDesktop ? () => void creativeLibrary.importDesktopMedia() : undefined}
        onOpenProject={() => void openProject()}
        onExploreDemo={() => setDemoWorkspaceOpened(true)}
        onHelp={() => openBeginnerGuide("steps")}
        onConnectAgent={isDesktop ? () => openAgentConnect() : undefined}
        easyFlowHost={easyFlow.host}
      /></Suspense> : <>
      <section className="workspace-grid" id="editing-workspace-panel" role="tabpanel" aria-labelledby={`editing-workspace-tab-${activeWorkspace}`} style={{ gridTemplateColumns: workspaceColumns }} data-testid="modular-workspace">
        {!hasUserMedia && !hasAuthoredGraph && <div className="demo-workspace-banner" data-testid="demo-workspace-banner"><b>{t("示範模式")}</b><span>{t(isDesktop ? "先熟悉介面；加入自己的影片後才會啟用自動剪輯與輸出" : "先熟悉介面；加入自己的影片後可手動剪輯並下載專案檔。自動剪輯與影片輸出需要桌面版")}</span></div>}
        <nav className="compact-panel-tabs" aria-label={t("顯示面板")}>
          <button type="button" aria-pressed={compactPane === "media"} onClick={() => {  workspace.patch({ mediaVisible: true }); setCompactPane("media"); }}>{t("素材庫")}</button>
          <button type="button" aria-pressed={compactPane === "preview"} onClick={() => setCompactPane("preview")}>{t("預覽")}</button>
          <button type="button" aria-pressed={compactPane === "inspector"} onClick={() => {  workspace.patch({ inspectorVisible: true }); setCompactPane("inspector"); }}>{t("屬性面板")}</button>
        </nav>
        {mediaShown && <><Suspense fallback={<aside className="panel media-bin" aria-label={t("正在載入素材面板")} />}><MediaBin workspace={activeWorkspace} motionLibraryPanel={motionLibrary.panel} motionLibraryEntry={simpleMode ? motionLibrary.entry : undefined} motionLibraryRequest={motionLibrary.panelRequest} effectsLibraryRequest={effectsLibraryRequest} layerPanel={<EditingLayerStackV1 key={JSON.stringify([clipSourceSessionId, project.id])} project={project} selection={layerSelection} onSelect={selectLayer} onCommand={runCommand}
            onStatus={setStatus} onAddAdjustmentLayer={addAdjustmentLayer} adjustmentLayerReady={adjustmentLayerReady} />}
          assets={project.assets}
          runtimeUrls={runtimeUrls}
          onImport={importFiles}
          onDesktopImport={isDesktop ? () => void creativeLibrary.importDesktopMedia() : undefined}
          creativeLibrary={creativeLibrary.library}
          onLoadOriginalSfxCandidates={isDesktop ? creativeLibrary.loadOriginalSfxCandidates : undefined}
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
          templateProject={project}
          templateSourceClipId={selectedClip?.id}
          templateMotionBusy={referenceTemplateBusy}
          onCancelTemplateMotion={cancelReferenceTemplate}
          onApplyThemedTemplate={referenceTemplateBusy ? undefined : input => prepareReferenceInstance((prepareText, signal) =>
            prepareReferenceMotionTemplateInstance(project, input, makeId, { prepareText, signal }))}
          templateFps={project.fps}
          templateCanvasFormat={project.width > project.height ? "long" : "short"}
          onApplyLongTemplate={(templateId) => void applyLongFormTemplate(templateId)}
          onAddLowerThird={addLowerThird}
          motionGraphics={project.motionGraphics}
          captions={project.captions}
          directorMarkers={project.director.markers}
          templateApplication={project.templateApplication}
          onDeleteMotionGraphic={(graphicId) => graphicLibraryDeletes.remove(graphicId)}
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
        /></Suspense><WorkspaceResizeHandle axis="horizontal" label={t("調整素材面板寬度")} value={workspace.layout.mediaWidth} min={220} max={520} onDelta={(delta) => workspace.resize("media", delta)} /></>}
        <div className="center-workspace">
          <Suspense fallback={<section className="preview-panel" aria-label={t("正在載入播放器")} />}><EditorPreviewRuntimeConsumerV1>{({ playhead, seekRevision, gpuPreview, nativeEffectPreview, audioLayers, publishPlaybackClock, updateAudioTransport, updateNativePreviewBounds }) => <Preview
            onRebuildPreview={isDesktop ? creativeLibrary.repairPreview : undefined}
            previewRepair={creativeLibrary.previewRepair}
            layers={nativeEffectPreview.layers}
            audioLayers={audioLayers}
            projectWidth={project.width}
            projectHeight={project.height}
            playhead={playhead}
            projectDuration={duration}
            projectFps={project.fps}
            captions={parameterPreviewProject.captions}
            captionStyle={parameterPreviewProject.captionStyle}
            project={parameterPreviewProject}
            parameterPreviewEpoch={parameterPreviewEpoch}
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
            gpuPreviewFailure={gpuPreview.failure}
            onRetryGpuPreview={gpuPreview.retry}
          />}</EditorPreviewRuntimeConsumerV1></Suspense>
          {/* The video type is chosen in the easy flow or the auto-edit dialog; this row is an advanced tool. */}
          {!simpleMode && <Suspense fallback={null}><EditingProfilePicker
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
          /></Suspense>}
          {automationShown && <Suspense fallback={null}><AgentPanel
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
        {inspectorShown && activeWorkspace !== "color" && !selectedGraphic && <><WorkspaceResizeHandle axis="horizontal" label={t("調整屬性面板寬度")} value={workspace.layout.inspectorWidth} min={286} max={560} onDelta={(delta) => workspace.resize("inspector", delta)} /><ClipLayerHostContextV1.Provider value={clipLayerHost}><LiveClipLayerHostV1><Suspense fallback={<aside className="inspector inspector-empty"><small>{t("正在載入調整面板…")}</small></aside>}><LivePlayhead fallback={shellPlayhead}
          select={time => inspectorAtPlayheadV1(selectedClip, appearanceValuesAt, time)} isEqual={sameInspectorAtPlayheadV1}>{(livePlayhead, { selectedClipAtPlayhead, appearanceValues }) => <Inspector workspace={activeWorkspace} motionLibraryControl={motionLibrary.inspector} onOpenEffectsLibrary={() => { setActiveWorkspace("effects"); setEffectsLibraryRequest(value => value + 1); }}
          onClose={compactWorkspace ? () => setCompactPane("preview") : undefined}
          captionProject={project}
          onCaptionCommand={command => runCommand(command, "已修正字幕句尾時間，可復原。 ")}
          onCaptionSelect={captionId => { const cue = project.captions.find(item => item.id === captionId); if (!cue) return; pausePlayback(); setSelectedClipId(undefined); setSelectedCaptionId(captionId); setPlayhead(cue.start); }}
          mesh3dProject={project}
          autoReframeControl={selectedClip && !selectedCaption && selectedAsset?.kind === "video" ? <AutoReframeDesktopControlV1
            project={project} session={props.projectSession} clipId={selectedClip.id} api={window.haoDesktop}
            disabled={referenceTemplateBusy || importActive || props.clipMediaBusy} onPause={pausePlayback}
            onCommand={(command, revision) => {
              const current = props.projectSession.getSnapshot();
              if (current.sessionId !== clipSourceSessionId || current.history.present.revision !== revision) throw Error("AUTO_REFRAME_JOB_STALE");
              return { status: runCommand(command) === false ? "cancelled" : "applied" };
            }}
            onNewProject={props.loadOpenedProject ? createAutoReframeAppHostV1({ session: props.projectSession,
              confirmLeave: () => window.confirm(t("建立新專案會捨棄目前尚未儲存的修改。要繼續嗎？")),
              openNew: next => props.loadOpenedProject!({ canceled: false, project: next, runtimeUrls }, { dirty: true }),
            }) : undefined} /> : undefined}
          templateSourceControl={hasReferenceMotionSourceOwner(project, selectedClip?.id) && selectedClip ? <ReferenceMotionSourceClipControl project={project} session={props.projectSession} clipId={selectedClip.id} busy={referenceTemplateBusy || importActive} api={window.haoDesktop} onReplace={replaceReferenceSource} onCancel={cancelReferenceTemplate} /> : undefined}
          // 立體 Motion 場景 and saved original scenes are advanced-only (the 2026-10-11 simple-mode rule): simple mode's 特效 omits them.
          originalMotionScenesControl={simpleMode ? undefined : <SavedOriginalMotionScenes project={project} sessionId={clipSourceSessionId} busy={referenceTemplateBusy}
            onCancel={cancelReferenceTemplate} onRevise={input => prepareReferenceInstance((prepareText, signal) =>
              prepareOriginalSceneGraphicRevision(project, input, { prepareText, signal }))} />}
          onMesh3dCommand={simpleMode ? undefined : command => runCommand(command, "已更新可編輯 3D 場景，可復原。 ")}
          onStyleTemplateCommand={command => runCommand(command, "已更新模板片段，可復原。 ")}
          mergeRuntimeUrls={props.mergeRuntimeUrls}
          projectFps={project.fps}
          playhead={livePlayhead}
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
            if (selectedClip) return attachedClipMoves.move(selectedClip.id, timelineStart);
          }}
          onTrackChange={(trackId) => {
            if (selectedClip) return attachedClipMoves.move(selectedClip.id, undefined, trackId);
          }}
          clipSourceSessionId={clipSourceSessionId}
          sourceTimingProject={project}
          showClipSpeedControls clipMediaBusy={props.clipMediaBusy}
          onClipRetime={selectedClip && props.onClipRetime ? (rate, reverse) => props.onClipRetime?.(selectedClip.id, rate, reverse) : undefined}
          onFreezeFrame={selectedClip && props.onFreezeFrame ? () => props.onFreezeFrame?.(selectedClip.id) : undefined}
          onSlipClip={(sourceStart) => selectedClip ? clipSourceEdits.slipClip(selectedClip.id, sourceStart) : false}
          onReplaceClipSource={command => {
            if (!clipSourceTask.isCurrent()) return setStatus("專案已變更，請重新選擇要替換的影片。");
            if (selectedClip?.id !== command.clipId) return setStatus("請重新選擇要替換的片段。");
            runCommand(command, "已替換影片並保留片段時間與動態，可復原。請檢查構圖、字幕和聲音。");
          }}
          onAudioEnvelopeChange={(envelope) => selectedClip ? runCommand({ type: "set_clip_audio_envelope", clipId: selectedClip.id, envelope }, "已更新聲音淡化與音量點，可一次復原。") : false}
          numberEditScope={graphicSelectionSnapshot}
          volumePreview={selectedClip && clipParameterDraft.preview?.clipId === selectedClip.id ? findClip(clipParameterDraft.preview.project, selectedClip.id).volume : undefined}
          onVolumeChange={volume => clipAppearance.volume(volume)}
          onVolumeGestureStart={() => {
            effectParameterGesture.cancel();
            return selectedClip ? admitOtherParameterGesture(clipParameterGesture.begin({ clipId: selectedClip.id, selection: graphicSelectionSnapshot,
              parameterId: "volume", initial: selectedClip.volume, plan: clipAppearance.planVolume, commit: clipAppearance.volume })) : undefined;
          }}
          onTrimStart={() => {
            if (selectedClip) void attachedClipMoves.trimAtPlayhead(selectedClip.id, "start", renderedTransport().playhead - selectedClip.timelineStart);
          }}
          onTrimEnd={() => {
            if (selectedClip) void attachedClipMoves.trimAtPlayhead(selectedClip.id, "end", selectedClip.timelineStart + selectedClip.duration - renderedTransport().playhead);
          }}
          onTransformChange={patch => clipAppearance.transform(patch)}
          appearanceValues={appearanceValues}
          appearanceEditScope={appearanceEditScope}
          appearanceScopeSignal={appearanceScopeSignal}
          onTransformNumberGestureStart={beginTransformNumberGesture}
          scene25d={project.scene25d}
          onScene25dToggle={(enabled) => runCommand({ type: "configure_scene_25d", enabled }, enabled ? "已啟用原生 2.5D 場景；相機、燈光與平面深度會進入同一條 GPU graph。" : "已退出 2.5D 場景並回到一般 2D 圖層。")}
          onScene25dChange={(settings) => project.scene25d ? sceneSettingsEdits.apply({
            sessionId: clipSourceSessionId, projectId: project.id,
          }, project.scene25d, settings) : false}
          onTransform3dChange={(patch, axis) => clipAppearance.transform3d(patch, axis)}
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
          onLayerChange={(patch) => { clipLayerHost.onLayerChange(patch); }}
          onExpressionChange={(property, expression) => {
            if (selectedClip) runCommand({ type: "set_clip_expression", clipId: selectedClip.id, property, expression }, expression ? "已套用安全表達式。" : "已清除表達式。");
          }}
          onMediaFrameApply={(layout, name) => {
            if (selectedClip) runCommand({ type: "set_clip_layout", clipId: selectedClip.id, layout }, `已套用「${name}」媒體框；仍使用原始真實素材。`);
          }}
          onColorChange={(patch) => clipAppearance.color(patch)}
          onColorNumberGestureStart={field => {
            const transport = renderedTransport(), appearanceValues = appearanceValuesAt(transport.playhead), appearance = clipAppearanceEdits();
            if (!selectedClip || !appearanceValues || !["brightness", "contrast", "saturation", "hue"].includes(field)) return undefined;
            const initial = appearanceValues.color[field];
            if (!Number.isFinite(initial)) return undefined;
            const plan = (value: number) => appearance.planColor({ [field]: value });
            const initialPlan = plan(initial);
            if (!initialPlan || initialPlan.command) return undefined;
            const lease = clipParameterGesture.begin({ clipId: selectedClip.id, selection: graphicSelectionSnapshot,
              parameterId: "color." + field, initial, plan, commit: value => appearance.color({ [field]: value }),
              isCurrent: () => renderedTransport().playhead === transport.playhead && renderedTransport().seekRevision === transport.seekRevision });
            if (lease) { effectParameterGesture.cancel(); captionParameterGesture.cancel(); }
            return admitOtherParameterGesture(lease);
          }}
          onCreativeChange={(patch) => {
            if (selectedClip) runCommand({ type: "set_clip_creative", clipId: selectedClip.id, patch }, "已套用 Editkin Creator Pack，預覽與輸出會使用同一設定。");
          }}
          onPresetEffectEdit={(expectedIds, edit) => selectedClip ? presetEffectEdits.apply({
            sessionId: clipSourceSessionId, projectId: project.id, clipId: selectedClip.id,
          }, expectedIds, edit) : false}
          onNativeEffectAdd={(instance) => effectStackEdits.add(instance)}
          onNativeEffectUpdate={(instanceId, patch) => effectStackEdits.update(instanceId, patch)}
          onNativeEffectParameterEdit={(expected, values) => effectStackEdits.parameters(expected, values)}
          nativeEffectParameterPreview={effectParameterDraft.preview}
          onNativeEffectParameterGesture={(expected, parameterId) => {
            clipParameterGesture.cancel();
            return selectedClip ? admitOtherParameterGesture(effectParameterGesture.begin({
              clipId: selectedClip.id, expected, parameterId, selection: graphicSelectionSnapshot,
              commit: values => effectStackEdits.parameters(expected, values),
            })) : undefined;
          }}
          onNativeEffectReorder={(instanceId, toIndex) => effectStackEdits.reorder(instanceId, toIndex)}
          onNativeEffectRemove={(instanceId) => effectStackEdits.remove(instanceId)}
          onAddKeyframe={addKeyframeAtPlayhead}
          onKeyframeEasingChange={(keyframeId, easing) => {
            if (selectedClip) runCommand({ type: "update_keyframe", clipId: selectedClip.id, keyframeId, patch: { easing } }, `已切換為 ${easing} 插值。`);
          }}
          onDeleteKeyframe={deleteKeyframe}
          motionTracks={selectedMotionTracks}
          trackingBusy={trackingBusy}
          trackingSelectionActive={Boolean(trackingMode)}
          trackingSelection={trackingSelection}
          onBeginMotionTrack={() => {
            if (!props.trackingActionGuard()) return;
            if (!isDesktop) return setStatus("動態追蹤需要桌面版的本機分析引擎；網頁版無法使用。");
            if (!selectedClip || project.assets.find((asset) => asset.id === selectedClip.assetId)?.kind !== "video") return setStatus("請先選一段影片。");
            setPlaying(false);
            setTrackingSelection(undefined);
            setTrackingMode({ kind: "new" });
            setStatus("請直接在預覽畫面拖曳框住要追蹤的人或物件，放開後會自動分析。");
          }}
          onCorrectMotionTrack={(trackId) => {
            if (!props.trackingActionGuard(trackId)) return;
            setPlaying(false);
            setTrackingSelection(undefined);
            setTrackingMode({ kind: "correct", trackId });
            setStatus("在預覽畫面重新框住主體，這一幀會成為手動修正點。");
          }}
          onDeleteMotionTrack={(trackId) => props.trackingActionGuard(trackId) ? runCommand({ type: "delete_motion_track", trackId }, "已移除追蹤資料；已綁定的圖卡會保留為靜態圖卡。") : false}
          onAddMotionGraphic={(kind, trackId, seed) => { if (trackId && !props.trackingActionGuard(trackId)) return; addMotionGraphic(kind, trackId, seed); }}
          onAddGeometryMotion={() => {
            const playhead = renderedTransport().playhead;
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
          motionGraphics={attachedGraphics}
          onGraphicTextGestureStart={beginGraphicTextGesture}
          onGraphicTextDraftRejected={graphicParameterGesture.reportError}
          onGraphicNumberGestureStart={beginGraphicNumberGesture}
          onGraphicNumberDraftRejected={graphicParameterGesture.reportError}
          onUpdateMotionGraphic={(graphicId, patch) => graphicEdits.update(graphicId, patch)}
          managedMotionGraphicIds={[
            ...(project.referenceMotionInstances?.flatMap(instance => instance.roles.filter(role => role.kind === "graphic").map(role => role.id)) ?? []),
            ...(project.motionScenes?.flatMap(scene => scene.graphicIds) ?? []),
          ]}
          onDeleteMotionGraphic={(graphicId) => graphicEdits.remove(graphicId)}
          onCaptionChange={(patch, intent) => captionEdits.patch(patch, intent)}
          onCaptionStyleChange={(presetId) => {
            void captionEdits.loadPreset(presetId, () => selectedCaption ? captionParameterGesture.begin({ project, captionId: selectedCaption.id,
              selection: graphicSelectionSnapshot, parameterId: "caption.style", initial: project.captionStyle as Partial<import("../domain/types").CaptionStyle>,
              normalize: normalizeCaptionStylePatchV1, plan: captionEdits.planStyle, commit: captionEdits.style,
            }) : undefined, id => import("../creative/corePack").then(({ captionStyleFromPreset }) => captionStyleFromPreset(id)));
          }}
          onCaptionStylePatch={patch => captionEdits.style(patch)}
          captionParameterPreview={captionParameterDraft.preview}
          onCaptionDraftRejected={captionParameterGesture.reportError}
          onCaptionTextGestureStart={field => {
            if (!selectedCaption || field === "translation" && !selectedCaption.translation) return undefined;
            return captionParameterGesture.begin({ project, captionId: selectedCaption.id, selection: graphicSelectionSnapshot,
              parameterId: "caption." + field, initial: field === "text" ? selectedCaption.text : selectedCaption.translation!.text,
              plan: value => captionEdits.planText(field, value), commit: value => captionEdits.text(field, value) });
          }}
          onCaptionOpacityGestureStart={() => selectedCaption ? captionParameterGesture.begin({ project, captionId: selectedCaption.id, selection: graphicSelectionSnapshot,
            parameterId: "caption.background-opacity", initial: captionBackgroundOpacityV1(project.captionStyle.backgroundColor),
            plan: value => captionEdits.planStyle({ backgroundColor: captionBackgroundWithOpacityV1(project.captionStyle.backgroundColor, value) }),
            commit: value => captionEdits.style({ backgroundColor: captionBackgroundWithOpacityV1(project.captionStyle.backgroundColor, value) }),
          }) : undefined}
          onOpenColorWorkspace={() => {
            if (!selectedClip || !selectedAsset || selectedAsset.kind === "audio") return setStatus("請先選一段影片或照片。");
            setPlaying(false);
            setActiveWorkspace("color");
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
            const playhead = renderedTransport().playhead;
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
        />}</LivePlayhead></Suspense></LiveClipLayerHostV1></ClipLayerHostContextV1.Provider></>}
        {inspectorShown && selectedGraphic && activeWorkspace !== "color" && <><WorkspaceResizeHandle axis="horizontal" label={t("調整屬性面板寬度")} value={workspace.layout.inspectorWidth} min={286} max={560} onDelta={delta => workspace.resize("inspector", delta)} /><EditingGraphicPropertiesV1 graphic={selectedGraphic} editScope={graphicSelectionSnapshot} onTextGestureStart={beginGraphicTextGesture} onTextDraftRejected={graphicParameterGesture.reportError} onNumberGestureStart={beginGraphicNumberGesture} onNumberDraftRejected={graphicParameterGesture.reportError} templateId={selectedGraphicTemplate} managed={Boolean(selectedGraphicTemplate) || Boolean(project.motionScenes?.some(scene => scene.graphicIds.includes(selectedGraphic.id)))} onChange={patch => graphicEdits.update(selectedGraphic.id, patch)} onDelete={() => graphicEdits.remove(selectedGraphic.id)} onOpenSceneEditor={() => { if (graphicSelectionState.getSnapshot() !== graphicSelectionSnapshot) return; graphicSelectionState.select(undefined); setActiveWorkspace("effects"); }} /></>}
        {inspectorShown && activeWorkspace === "color" && <><WorkspaceResizeHandle axis="horizontal" label={t("調整屬性面板寬度")} value={workspace.layout.inspectorWidth} min={360} max={700} onDelta={delta => workspace.resize("inspector", delta)} />
      {activeWorkspace === "color" && selectedClip && selectedAsset && selectedAsset.kind !== "audio" && (
        <Suspense fallback={null}><LivePlayhead fallback={shellPlayhead}>{playhead => <ColorWorkspace embedded asset={selectedAsset} clip={clipParameterDraft.preview?.clipId === selectedClip.id ? findClip(clipParameterDraft.preview.project, selectedClip.id) : selectedClip} source={runtimeUrls[selectedAsset.id]} playhead={playhead} colorManagement={project.colorManagement ?? DEFAULT_COLOR_MANAGEMENT} onColorManagementChange={(patch) => runCommand({ type: "set_project_color_management", patch }, patch.mode === "aces2" ? "已切換 ACES 2.0 專業色彩管理。" : "已切換快速 Rec.709。") } onColorChange={patch => { clipParameterGesture.cancel(); return clipAppearance.baseColor(patch); }} colorEditScopeKey={`${clipSourceSessionId}:${selectedClip.id}`} onColorGestureStart={key => {
          effectParameterGesture.cancel();
          const transport = renderedTransport(), appearance = clipAppearanceEdits();
          return admitOtherParameterGesture(clipParameterGesture.begin({ clipId: selectedClip.id, selection: graphicSelectionSnapshot, parameterId: "base-color." + key,
            initial: selectedClip.color[key] ?? 0, plan: value => appearance.planBaseColor({ [key]: value }), commit: value => appearance.baseColor({ [key]: value }),
            isCurrent: () => renderedTransport().playhead === transport.playhead && renderedTransport().seekRevision === transport.seekRevision }));
        }} onInputColorSpaceChange={(interpretation) => runCommand({ type: "set_asset_color_interpretation", assetId: selectedAsset.id, interpretation }, interpretation === "log_unresolved" ? "已標記為未解讀 Log；輸出會安全阻擋。" : "已更新 Input Transform。") } onRec709InputChange={(interpretation) => runCommand({ type: "set_clip_rec709_input", clipId: selectedClip.id, interpretation }, "已更新這個片段的 Rec.709 解讀。") } onAlphaModeChange={(alphaMode) => runCommand({ type: "set_asset_alpha_mode", assetId: selectedAsset.id, alphaMode }, alphaMode === "premultiplied" ? "已啟用 Premultiplied Alpha 解碼，避免透明邊緣黑邊。" : "已更新素材 Alpha 模式。") } gradeClipboard={{ state: gradeClipboard.state, canPaste: gradeClipboard.clipboard.canPaste(selectedClip.id), ...colorGradeClipboardActionsV1(gradeClipboard.clipboard, selectedClip.id, playhead, runCommand, setStatus) }} gradeBaseClip={selectedClip} onGradeGestureStart={() => {
          effectParameterGesture.cancel();
          return admitOtherParameterGesture(clipParameterGesture.beginGrade({ clipId: selectedClip.id, selection: graphicSelectionSnapshot, parameterId: "grade-v2",
            initial: selectedClip.gradeV2 ?? { schema: "editkin.color-grade/v2" }, plan: clipGradeEdits.plan, commit: clipGradeEdits.set }));
        }} gradeEditOccurrence={graphicSelectionSnapshot} onGradeLookGestureStart={() => {
          effectParameterGesture.cancel();
          const look = selectedClip.gradeV2?.look;
          return look ? admitOtherParameterGesture(clipParameterGesture.begin({ clipId: selectedClip.id, selection: graphicSelectionSnapshot, parameterId: "grade-v2.look.strength",
            initial: look.strength ?? 1, plan: clipGradeEdits.planLookStrength, commit: clipGradeEdits.lookStrength })) : undefined;
        }} gradeEditScope={{ owner: props.projectSession, sessionId: props.projectSession.getSnapshot().sessionId }} gradeReadOnlyReason={project.tracks.some(track => track.id === selectedClip.trackId && track.locked) ? "這個軌道已鎖定，先解鎖才能修改。" : undefined} onGradeV2Change={project.tracks.some(track => track.id === selectedClip.trackId && track.locked) ? undefined : (grade) => clipGradeEdits.set(grade) } onClose={() => setActiveWorkspace("edit")} />}</LivePlayhead></Suspense>
      )}
        {(!selectedClip || !selectedAsset || selectedAsset.kind === "audio") && <aside className="panel inspector"><h2>{t("調色")}</h2><p>{t("請先從圖層選取影片或圖片")}</p></aside>}
        </>}
      </section>
      {timelineShown && <div className="timeline-region"><WorkspaceResizeHandle axis="vertical" label={t("調整時間軸高度")} value={workspace.layout.timelineHeight} min={170} max={520} onDelta={(delta) => workspace.resize("timeline", delta)} /><Suspense fallback={<section className="timeline-shell" aria-label={t("正在載入時間軸")} />}><Timeline
        project={project}
        duration={duration}
        playhead={shellPlayhead}
        playheadStore={playheadStore}
        playing={playing}
        onAddTitle={() => addMotionGraphic("title")}
        selectedClipId={selectedClipId}
        selectedCaptionId={selectedCaptionId}
        selectedClipIds={props.selectedClipIds}
        selectedCaptionIds={props.selectedCaptionIds}
        onSelectionChange={props.onSelectionChange}
        markRange={props.markRange}
        markers={props.markers}
        viewRequest={props.viewRequest}
        runtimeUrls={runtimeUrls}
        draggingAssetId={draggingAssetId}
        onInsertAsset={(assetId, trackId, timelineStart, dropMode) => addAssetToTimeline(assetId, "timeline", { trackId, timelineStart, dropMode })}
        onEditStart={pausePlayback}
        onSeek={(time) => { pausePlayback(); setPlayhead(clampProjectSeek(time, duration)); }}
        onSelect={(clipId) => { setSelectedCaptionId(undefined); setSelectedClipId(clipId); }}
        onSelectCaption={(captionId) => { setSelectedClipId(undefined); setSelectedCaptionId(captionId); }}
        onMoveClip={moveTimelineClip}
        onExtendClip={clipSourceEdits.extendClip}
        onSlipClip={clipSourceEdits.slipClip}
        onFreezeFrame={props.onFreezeFrame} clipMediaBusy={props.clipMediaBusy}
        onDetachAudio={clipId => {
          try { const plan = planAudioDetach(props.projectSession.getSnapshot().history.present, clipId, { clipId: makeId("audio"), trackId: makeId("audio-track") }); runCommand(plan.command, plan.message); }
          catch (error) { setStatus(error instanceof Error ? error.message : "無法分離聲音。"); }
        }}
        onLinkClips={(clipIds, unlink) => {
          try { const plan = planTimelineClipLink(props.projectSession.getSnapshot().history.present, clipIds, unlink); runCommand(plan.command, plan.message); }
          catch (error) { setStatus(error instanceof Error ? error.message : "無法更新片段連結。"); }
        }}
        onEditRefused={setStatus}
        onCommand={runCommand}
        onMoveCaption={(captionId, start, options) => options ? runCommand({ type: "update_caption", captionId, patch: { start } }, "已移動字幕，可復原。", options)
          : runCommand({ type: "update_caption", captionId, patch: { start } }, "已移動字幕，可復原。")} 
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
        onAddCaption={() => { addCaption(); openSelectionInspector(); }}
        onEditSelection={openSelectionInspector}
        onActivateSelection={revealSelectionPanel}
        onAddTrack={addTrack}
        onRenameTrack={(trackId, name) => runCommand({ type: "rename_track", trackId, name }, `軌道已重新命名為「${name}」。`)}
        onToggleTrackLock={(trackId) => runCommand({ type: "toggle_track_lock", trackId }, "已切換軌道鎖定狀態。")}
        onDeleteTrack={(trackId) => runCommand({ type: "delete_track", trackId }, "已刪除空軌道，可復原。")}
        onMakePictureInPicture={() => makeSelectedPictureInPicture()}
        onPrecompose={precomposeSelected}
        onAddAdjustmentLayer={addAdjustmentLayer}
        onToggleMute={(trackId) => {
          // Mute is sound only: say so, so nobody looks for the picture it never hides.
          const track = project.tracks.find(item => item.id === trackId);
          runCommand({ type: "toggle_track_mute", trackId }, !track ? "已切換軌道靜音。" : track.muted ? `已取消「${track.name}」的靜音。`
            : track.kind === "video" && !track.hidden ? `已將「${track.name}」靜音；畫面照常顯示。` : `已將「${track.name}」靜音。`);
        }}
        onToggleHidden={(trackId) => {
          const track = project.tracks.find(item => item.id === trackId);
          // Each message names only what is true afterwards: no "sound as usual" for a muted track, no "picture as usual" for a hidden one.
          runCommand({ type: "toggle_track_hidden", trackId }, !track ? "已切換軌道畫面。" : track.hidden ? `已顯示「${track.name}」的畫面。`
            : track.muted ? `已隱藏「${track.name}」的畫面。` : `已隱藏「${track.name}」的畫面；聲音照常。`);
        }}
        onSplit={splitSelected}
        onDelete={deleteSelected}
        onCut={props.cutClipsAt}
        onStatus={setStatus}
        keyboardActions={props.timelineKeyboard}
        renderTrackOverlay={motionLibrary.renderTrackOverlay}
      /></Suspense></div>}
      </>}
      <footer className="status-bar" style={{ position: "relative" }}>
        {projectDownload && <ProjectDownloadNotice lease={projectDownload} onCancel={cancelProjectDownload} />}
        <SavedReferenceMotionInstances project={project} session={props.projectSession} busy={referenceTemplateBusy || importActive} onCancel={cancelReferenceTemplate} onSourceReplace={replaceReferenceSource}
          counterTicksControl={(instance, current) => <CounterTickControlsV1 key={`ticks:${clipSourceSessionId}:${instance.id}`} project={project} session={props.projectSession} instance={instance} current={current} busy={referenceTemplateBusy || importActive} api={window.haoDesktop}
            onPause={pausePlayback} onStatus={setStatus} onPreview={isDesktop ? id => void creativeLibrary.previewCreativeAsset(id) : undefined}
            onPrepared={(prepared, picked) => creativeLibrary.acceptPreparedMedia([prepared], [picked])} />}
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
        {/* Simple mode: the save state is in the top bar and the project shape in ⚙ 設定; the footer keeps one status line. */}
        {!simpleMode && <span data-testid="save-state"><i className={recovery.recoveryState === "error" ? "red" : "green"} /> {t(saveStateMessage({ mode, isDesktop, dirty: recovery.dirty, recoveryState: recovery.recoveryState, hasProjectFile }))}</span>}
        {!simpleMode && <details className="project-format-control" data-testid="project-format-control" data-project-width={project.width} data-project-height={project.height}><summary aria-label={t("設定專案比例")}><span data-testid="project-resolution">{(() => { const format = PROJECT_FORMATS.find(item => item.width === project.width && item.height === project.height); return format ? `${format.ratio} · ${t(format.label)}` : `${project.width}:${project.height} · ${t("自訂")}`; })()}</span><small>{project.width}×{project.height} · {project.fps} fps</small></summary><div><header><strong>{t("專案比例")}</strong><span>{t("只改畫布，不破壞原素材；可再到檢查器調整裁切與位置。")}</span></header>{PROJECT_FORMATS.map((format) => <button type="button" key={format.id} aria-label={t("切換為 {ratio} {name}", { ratio: format.ratio, name: t(format.label) })} title={`${format.ratio} ${t(format.label)} · ${format.width}×${format.height}`} className={project.width === format.width && project.height === format.height ? "active" : ""} onClick={(event) => { runCommand({ type: "set_project_resolution", width: format.width, height: format.height }, `專案已切換為 ${format.ratio} ${format.label}；素材位置與裁切仍可逐片調整。`); event.currentTarget.closest("details")?.removeAttribute("open"); }}><b>{format.ratio}</b><span><strong>{t(format.label)}</strong><small>{t(format.use)}</small></span></button>)}</div></details>}
        <OperationStatus status={status} runtimeInfo={isDesktop ? `${t("桌面版 · 即時預覽 · 當機復原")}${mobile.remote?.active ? ` · ${t("手機已連線")}${mobile.remoteStatus?.connectedCount ? ` ${mobile.remoteStatus.connectedCount}` : ""}` : ""}` : t("瀏覽器編輯 · 無自動儲存 · 請下載專案")} />
      </footer>
      {beginnerGuideOpened && <Suspense fallback={null}><BeginnerGuide initialPage={beginnerGuidePage} onClose={closeBeginnerGuide} onChooseMedia={() => { if (isDesktop) void creativeLibrary.importDesktopMedia(); else toolbarMediaInput.current?.click(); }} /></Suspense>}
      {mobile.showConnect && (
        <Suspense fallback={null}><MobileConnectModal remote={mobile.remote} status={mobile.remoteStatus} networkSummary={mobile.networkSummary} agentLaunch={remoteAgentLaunch.state} onStartAgent={remoteAgentLaunch.start} onCancelAgent={remoteAgentLaunch.cancel} onClose={() => mobile.setShowConnect(false)} onStart={(confirmed) => void mobile.start(confirmed)} onStop={() => void mobile.stop()} onRevoke={(deviceId) => void mobile.revoke(deviceId)} onOpenAgentConnect={() => { mobile.setShowConnect(false); openAgentConnect(true); }} /></Suspense>
      )}
      {batchAutoEdit.show && batchAutoEdit.session && (
        <Suspense fallback={null}>
          <BatchAutoEditPanel
            session={batchAutoEdit.session}
            running={batchAutoEdit.summary?.running ?? false}
            canCancel={batchAutoEdit.canCancel}
            onCancel={batchAutoEdit.cancel}
            onResume={() => void batchAutoEdit.resume()}
            onClose={() => batchAutoEdit.setShow(false)}
            onRetry={(jobId) => void batchAutoEdit.retry(jobId)}
            onOpenProject={(jobId) => void batchAutoEdit.openProject(jobId)}
          />
        </Suspense>
      )}
      {agentConnectOpened && <Suspense fallback={null}><AgentConnectModal onClose={closeAgentConnect} onConnect={desktopActions.connectAgent} musicMvMode={project.editorialProfile === "music_mv"} /></Suspense>}
      {autoEditOpened && <Suspense fallback={null}><AutoEditDialog onClose={() => setAutoEditOpened(false)} onStart={(policy) => {
        setAutoEditOpened(false);
        const target = autoEditTarget.current;
        if (!target || !acceptProjectTask(target.task, setStatus, "粗剪設定")) return;
        if (target.clipId !== selectedClipId) return setStatus("選取的片段已改變，請重新開啟粗剪設定。");
        void automatic.semantic.run(policy);
      }} /></Suspense>}
      {shellSafety.overlays}
    </main>
    </EditorPreviewRuntimeV1></PlayheadStoreContext.Provider>
  );
}

interface EditorPreviewRuntimeV1Value {
  playhead: number;
  seekRevision: number;
  gpuPreview: ReturnType<typeof useResidentGpuPreview>;
  nativeEffectPreview: ReturnType<typeof useNativeEffectPreview>;
  audioLayers: ActivePreviewLayer[];
  publishPlaybackClock: (time: number) => void;
  updateAudioTransport: (next: NativeAudioTransportState) => void;
  updateNativePreviewBounds: (bounds: Omit<NativePreviewBounds, "revision">) => void;
}
const EditorPreviewRuntimeContextV1 = createContext<EditorPreviewRuntimeV1Value | undefined>(undefined);

/**
 * The preview's playhead-driven owners (PF1, 2026-10-23), moved out of EditorShell unchanged: the resident GPU preview,
 * the native effect previews, the active media layers, the playback clock and the end clamp. It is the root of the
 * shell's tree, so it lives exactly as long as the shell did; on a seek or a clock tick it re-renders and its context
 * reaches the preview, while the shell's own tree (its `children`) is the same element and does not re-render.
 */
type EditorPreviewOwnersV1Props = {
  project: EditProject; parameterPreviewProject: EditProject; parameterPreviewEpoch: number; runtimeUrls: Record<string, string>;
  duration: number; playing: boolean; setPlaying: Dispatch<SetStateAction<boolean>>; setPlayhead: Dispatch<SetStateAction<number>>;
  onPlaybackClock: (time: number, seekRevision: number) => void; gpuEnabled: boolean; effectEnabled: boolean; children: ReactNode;
};
function EditorPreviewRuntimeV1({ store, ...props }: EditorPreviewOwnersV1Props & { store: PlayheadStore }) {
  // The subscription is here, the owners below receive the transport as props: their effects' same-value state updates
  // then bail out at once instead of scheduling a second (empty) render after every tick.
  const { time, seekRevision } = usePlayheadSnapshot(store);
  return <EditorPreviewOwnersV1 {...props} playhead={time} seekRevision={seekRevision} />;
}
function EditorPreviewOwnersV1({ playhead, seekRevision, project, parameterPreviewProject, parameterPreviewEpoch, runtimeUrls, duration, playing, setPlaying, setPlayhead, onPlaybackClock, gpuEnabled, effectEnabled, children }: EditorPreviewOwnersV1Props & {
  playhead: number; seekRevision: number;
}) {
  // An edit or Undo that shortens the project brings the playhead back to its real end.
  useProjectEndPlayheadClamp(playhead, duration, setPlayhead);
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
  const nativePreviewScaleRef = useRef<number | undefined>(undefined);
  const updateNativePreviewBounds = useCallback((bounds: Omit<NativePreviewBounds, "revision">) => {
    // Preview reports on every scroll anywhere on the page. Same rectangle at the same display scale keeps the state, so
    // scrolling a panel neither re-renders the shell nor re-binds the native surface; a monitor-scale change still does.
    const scale = window.devicePixelRatio, rescaled = nativePreviewScaleRef.current !== scale;
    nativePreviewScaleRef.current = scale;
    setNativePreviewBounds((current) => !rescaled && current && current.x === bounds.x && current.y === bounds.y
      && current.width === bounds.width && current.height === bounds.height ? current : { ...bounds, revision: (current?.revision ?? 0) + 1 });
  }, []);
  const gpuPreview = useResidentGpuPreview(
    parameterPreviewProject,
    playhead,
    gpuEnabled,
    nativePreviewBounds,
    { playing, duration, seekRevision, audio: audioTransport, onClock: publishPlaybackClock, onEnded: finishPlayback },
  );
  const nativeEffectPreview = useNativeEffectPreview(
    window.haoDesktop,
    parameterPreviewProject,
    activeMediaLayers(parameterPreviewProject !== project ? parameterPreviewProject : project, playhead, runtimeUrls, "video"),
    effectEnabled,
    parameterPreviewEpoch,
  );
  const audioLayers = activeMediaLayers(parameterPreviewProject !== project ? parameterPreviewProject : project, playhead, runtimeUrls, "audio");
  const value: EditorPreviewRuntimeV1Value = { playhead, seekRevision, gpuPreview, nativeEffectPreview, audioLayers, publishPlaybackClock, updateAudioTransport, updateNativePreviewBounds };
  return <EditorPreviewRuntimeContextV1.Provider value={value}>{children}</EditorPreviewRuntimeContextV1.Provider>;
}

/** Renders the preview with the runtime's live values (a tick re-renders this and the preview only). */
function EditorPreviewRuntimeConsumerV1({ children }: { children: (runtime: EditorPreviewRuntimeV1Value) => ReactNode }) {
  const runtime = useContext(EditorPreviewRuntimeContextV1);
  return runtime ? <>{children(runtime)}</> : null;
}

type InspectorAtPlayheadV1 = { selectedClipAtPlayhead?: TimelineClip; appearanceValues?: Pick<TimelineClip, "transform" | "color"> };
/** The selected clip with its keyframes and expressions at the playhead, and the Inspector's numbers there (as App and
 * the shell computed them on every tick before PF1). */
function inspectorAtPlayheadV1(selectedClip: TimelineClip | undefined, appearanceValuesAt: (time: number) => Pick<TimelineClip, "transform" | "color"> | undefined, playhead: number): InspectorAtPlayheadV1 {
  let selectedClipAtPlayhead = selectedClip;
  if (selectedClip && playhead >= selectedClip.timelineStart && playhead <= selectedClip.timelineStart + selectedClip.duration) {
    const animated = animatedClipState(selectedClip, playhead - selectedClip.timelineStart);
    selectedClipAtPlayhead = { ...selectedClip, transform: animated.transform, color: animated.color };
  }
  return { selectedClipAtPlayhead, appearanceValues: appearanceValuesAt(playhead) };
}
const sameAppearanceV1 = (a?: Pick<TimelineClip, "transform" | "color">, b?: Pick<TimelineClip, "transform" | "color">) =>
  a === b || Boolean(a && b && shallowEqualRecord(a.transform, b.transform) && shallowEqualRecord(a.color, b.color));
/** Equal when the same selected clip shows the same transform and colour (the Inspector then renders the same). */
function sameClipAtPlayheadV1(a?: TimelineClip, b?: TimelineClip): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => key === "transform" || key === "color"
    ? shallowEqualRecord(left[key] as object, right[key] as object) : Object.is(left[key], right[key]));
}
const sameInspectorAtPlayheadV1 = (a: InspectorAtPlayheadV1, b: InspectorAtPlayheadV1) =>
  sameClipAtPlayheadV1(a.selectedClipAtPlayhead, b.selectedClipAtPlayhead) && sameAppearanceV1(a.appearanceValues, b.appearanceValues);

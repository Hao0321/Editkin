import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { assertBrowserMediaRelink, chooseBrowserFile, missingBrowserMedia, prepareBrowserMediaRelink } from "./application/browserProjectFiles";
import { createMobileSnapshotSource } from "./desktop/mobileSnapshot";
import { useAutomaticUpdates } from "./desktop/useAutomaticUpdates";
import { useEditorShortcuts, type EditorShortcutAction, type EditorShortcutHandlers, type EditorShortcutPress } from "./desktop/useEditorShortcuts";
import { CaptionFindReplaceSheet } from "./ui/CaptionFindReplaceSheet";
import { findSplitTarget, type TimelineCut } from "./application/timelineSplitTarget";
import type { TimelineEditOptions, TimelineKeyboardActions } from "./ui/timelineContract";
import { useCreativeLibrary } from "./desktop/useCreativeLibrary";
import { useMobileRemote } from "./desktop/useMobileRemote";
import { useProjectRecovery } from "./desktop/useProjectRecovery";
import { useAutomaticEditing } from "./desktop/useAutomaticEditing";
import { useClipMediaEdits } from "./desktop/useClipMediaEdits";
import { useBatchAutoEdit } from "./desktop/useBatchAutoEdit";
import { useDesktopActions } from "./desktop/useDesktopActions";
import type { OpenProjectResult } from "./desktop/types";
import { compileAgentInstruction, isAutomaticCaptionInstruction, isSceneSplitInstruction, isSemanticAutoEditInstruction, isSmartCutInstruction } from "./domain/agent";
import type { EditorCommand, EditorCommandContext } from "./domain/commands";
import { alignTime, createEmptyProject, findCaption, findClip, projectDuration } from "./domain/editGraph";
import { createUiDemoProject } from "./domain/demo";
import { dispatchCommandSafely, redo, undo } from "./domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type ClipLayout, type MotionGraphicKind, type MotionGraphicPresetSeed, type NormalizedRect } from "./domain/types";
import { importBrowserMedia, type ImportedBrowserMedia } from "./lib/browserMedia";
import { planImportedMediaTimeline } from "./application/timelineImport";
import { resolveAestheticSystem } from "./application/editkinAesthetic";
import { buildLoopingMusicPlan } from "./application/loopingMusic";
import { makeId } from "./lib/format";
import { useEditorTheme } from "./ui/useEditorTheme";
import { useTimelineRangeTransport } from "./ui/useTimelineRangeTransport";
import { createPlayheadStore } from "./ui/playheadStore";
import { PlayheadRenderObserver } from "./ui/LivePlayhead";
import { timelinePlaybackRange } from "./application/timelineRangePlayback";
import { createTimelineEditingState } from "./application/timelineEditingState";
import { createTimelineNudgeQueue } from "./application/timelineNudgeQueue";
import { createTimelineShortcutActions, SHORTCUT_RANGE_REQUIRED } from "./application/timelineShortcutActions";
import type { TimelineViewRequest } from "./ui/timelineViewRequests";
import { isPreviewPlaybackRate, nextShuttleRate, playbackResumeTime, stepPreviewFrame } from "./ui/playbackControlsState";
import { timelineAssetDuration } from "./ui/timelineAssetDrop";
import { planTimelineAssetDrop } from "./application/timelineAssetEditDrop";
import type { TimelineImportPlacement } from "./ui/internalAssetPointerDrag";
import { createMotionGraphic, legacyMotionGraphicSeed } from "./motion/composition";
import { MOTION_V3_MIN_DURATION_SECONDS } from "./domain/motionCompositionV3Contract";
import type { TrackingMode } from "./ui/EditorShell";
import type { MotionTrack } from "./domain/types";
const EditorShell = lazy(() => import("./ui/EditorShell").then((module) => ({ default: module.EditorShell })));

import { DEFAULT_PIP_LAYOUT } from "./application/appDefaults";
import { planPictureInPictureV1 } from "./application/pictureInPicturePlanV1";
import { createAppProjectFileActions } from "./application/appProjectFileActions";
import { createProjectSession } from "./application/projectSession";
import { createMotionTrackingEditScopeV1 } from "./application/motionTrackingEditScopeV1";
import { createMotionGraphicCreationOwner } from "./application/motionGraphicCreationOwner";
import { acceptProjectTask } from "./application/projectTask";
import { submitAppAgentInstruction } from "./application/appAgentInstruction";
import { createAppRenderActions } from "./application/appRenderActions";
import { createProjectDownloadOwner, type ProjectDownloadLease } from "./application/projectDownloadLease";
import { createAestheticOutputOwner } from "./application/aestheticOutputOwner";
import { buildLowerThirdCommand, type LowerThirdPresetId } from "./application/lowerThirds";
import { templateApplicationCleanupCommands, templateOwnedElementCount } from "./application/templateLifecycle";
import { MotionGraphicTextDialog } from "./ui/MotionGraphicTextDialog";
import { interfacePreferences, useI18n } from "./ui/i18n/interfacePreferences";
import { RecoveryChoiceDialog } from "./ui/RecoveryChoiceDialog";
import { createTemplateFollowEditActions } from "./application/templateFollowEditActions";
import { planCaptionInsert } from "./application/captionPlacement";

function App() {
  const { t } = useI18n();
  const [projectSession] = useState(() => {
    const demo = createUiDemoProject();
    demo.aestheticSystem = resolveAestheticSystem("auto", "longform");
    return createProjectSession(demo);
  });
  const { history, projectPath, cleanUpdatedAt, dirty, recoveryOwner, sessionId } = useSyncExternalStore(projectSession.subscribe, projectSession.getSnapshot, projectSession.getSnapshot);
  const aestheticOutputOwner = useMemo(() => createAestheticOutputOwner(), [sessionId]);
  const [aestheticOutputVersion, setAestheticOutputVersion] = useState(0);
  const setHistory = projectSession.setHistory;
  const [projectDownload, setProjectDownload] = useState<ProjectDownloadLease>();
  const [projectDownloadOwner] = useState(() => createProjectDownloadOwner({ session: projectSession, onChange: setProjectDownload }));
  useEffect(() => projectDownloadOwner.attach(), [projectDownloadOwner]);
  // PF1 (2026-10-23): the playhead lives in a store outside App state, so a seek or a clock tick re-renders only what
  // shows time. Commands read the playhead the editor last rendered when they run, as they read App's `playhead` before.
  const [playheadStore] = useState(() => createPlayheadStore());
  const { setPlayhead, onPlaybackClock, beginRangePlayback, observeSeekRevision } = useTimelineRangeTransport(() => setPlaying(false), playheadStore);
  const renderedPlayhead = () => playheadStore.rendered().time;
  const [playing, setPlayingState] = useState(false);
  const playingRef = useRef(false);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const playbackRateRef = useRef(1);
  const setPlaying: Dispatch<SetStateAction<boolean>> = useCallback((value) => {
    const next = typeof value === "function" ? value(playingRef.current) : value;
    if (next === playingRef.current) return;
    playingRef.current = next;
    // Starting or pausing invalidates already-queued device progress too.
    setPlayhead(current => current);
    setPlayingState(next);
  }, [setPlayhead]);
  const setPlaybackRate = useCallback((rate: number) => {
    if (!isPreviewPlaybackRate(rate) || rate === playbackRateRef.current) return;
    playbackRateRef.current = rate;
    setPlayhead(current => current);
    setPlaybackRateState(rate);
  }, [setPlayhead]);

  const [runtimeUrls, setRuntimeUrls] = useState<Record<string, string>>({});
  const [browserRelinkRequired, setBrowserRelinkRequired] = useState(false);
  const ownedBrowserUrls = useRef(new Map<string, string>());
  const browserRelinkPending = useRef(false);
  const releaseBrowserUrls = useCallback(() => {
    for (const url of ownedBrowserUrls.current.values()) URL.revokeObjectURL(url);
    ownedBrowserUrls.current.clear();
  }, []);
  useEffect(() => releaseBrowserUrls, [releaseBrowserUrls]);
  // Plain words for every mode: the AI request box is an advanced panel, so the first line does not point to it.
  const [status, setStatus] = useState("點一下片段或字幕，就能調整。");
  const [captionSearchOpen, setCaptionSearchOpen] = useState(false);
  const [motionTextRequest, setMotionTextRequest] = useState<{ kind: MotionGraphicKind; trackId?: string; seed?: MotionGraphicPresetSeed;
    initialText: string; sessionId: number; revision: number; start: number }>();
  const [trackingMode, setTrackingModeState] = useState<TrackingMode>();
  const trackingModeRef = useRef<TrackingMode | undefined>(undefined);
  const [trackingSelection, setTrackingSelection] = useState<NormalizedRect>();
  const [trackingBusy, setTrackingBusy] = useState(false);
  const trackingPending = useRef(false);
  const { theme, setTheme } = useEditorTheme();
  const isDesktop = window.haoDesktop?.isDesktop === true;
  const project = history.present;
  const [timelineEditing] = useState(() => createTimelineEditingState(projectSession, { clipIds: ["clip-demo"], captionIds: [], primaryClipId: "clip-demo" }));
  const { selection: timelineSelection, markRange } = useSyncExternalStore(timelineEditing.subscribe, timelineEditing.getSnapshot, timelineEditing.getSnapshot);
  const selectedClipId = timelineSelection.primaryClipId, selectedCaptionId = timelineSelection.primaryCaptionId;
  const { setSelectedClipId, setSelectedCaptionId } = timelineEditing;
  const [trackingScope] = useState(() => createMotionTrackingEditScopeV1({ session: projectSession,
    getSelection: timelineEditing.getSelection, subscribeSelection: timelineEditing.subscribe, onStatus: setStatus }));
  const setTrackingMode = useCallback<Dispatch<SetStateAction<TrackingMode | undefined>>>((value) => {
    const next = typeof value === "function" ? value(trackingModeRef.current) : value;
    trackingScope.retire(trackingModeRef.current);
    const bound = next ? trackingScope.captureMode(next) : undefined;
    trackingModeRef.current = bound; setTrackingModeState(bound);
  }, [trackingScope]);
  useEffect(() => trackingScope.attach(() => trackingModeRef.current, () => {
    setTrackingMode(undefined); setTrackingSelection(undefined);
  }), [trackingScope, setTrackingMode]);
  const [viewRequest, setViewRequest] = useState<TimelineViewRequest>();
  useEffect(() => setViewRequest(undefined), [sessionId]);
  const currentAestheticArtifact = useMemo(() => aestheticOutputOwner.get(project), [aestheticOutputOwner, aestheticOutputVersion, project]);
  const duration = projectDuration(project);
  const pausePlayback = useCallback(() => setPlaying(false), [setPlaying]);
  const togglePlayback = useCallback(() => {
    if (playingRef.current) { setPlaying(false); return; }
    if (duration <= 0) return;
    setPlayhead(current => playbackResumeTime(current, duration, project.fps, playbackRateRef.current));
    setPlaying(true);
  }, [duration, project.fps, setPlayhead, setPlaying]);
  const shuttlePlayback = useCallback((direction: -1 | 1, fastForward = false) => {
    if (duration <= 0) return;
    let rate = nextShuttleRate(playbackRateRef.current, playingRef.current, direction);
    if (fastForward && direction === 1 && rate === 1) rate = 2;
    setPlaybackRate(rate);
    setPlayhead(current => playbackResumeTime(current, duration, project.fps, rate));
    setPlaying(true);
  }, [duration, project.fps, setPlaybackRate, setPlayhead, setPlaying]);
  const frameStepPlayback = useCallback((direction: -1 | 1) => {
    setPlaying(false);
    setPlayhead(current => stepPreviewFrame(current, duration, project.fps, direction));
  }, [duration, project.fps, setPlayhead, setPlaying]);
  const selectedClip = useMemo(() => {
    if (!selectedClipId) return undefined;
    try { return findClip(project, selectedClipId); } catch { return undefined; }
  }, [project, selectedClipId]);
  const selectedCaption = useMemo(() => {
    if (!selectedCaptionId) return undefined;
    try { return findCaption(project, selectedCaptionId); } catch { return undefined; }
  }, [project, selectedCaptionId]);
  const trackingActionGuard = trackingScope.renderGuard(project, selectedClip?.id);
  const transitionNeighbors = useMemo(() => {
    if (!selectedClip) return { before: false, after: false };
    const track = project.tracks.find((item) => item.id === selectedClip.trackId);
    if (!track) return { before: false, after: false };
    const tolerance = 0.5 / project.fps;
    return {
      before: track.clips.some((clip) => clip.id !== selectedClip.id && Math.abs(clip.timelineStart + clip.duration - selectedClip.timelineStart) <= tolerance),
      after: track.clips.some((clip) => clip.id !== selectedClip.id && Math.abs(selectedClip.timelineStart + selectedClip.duration - clip.timelineStart) <= tolerance),
    };
  }, [project.fps, project.tracks, selectedClip]);
  const selectedMotionTracks = useMemo(() => selectedClip ? project.motionTracks.filter((track) => track.clipId === selectedClip.id) : [], [project.motionTracks, selectedClip]);
  // The animated clip at the playhead and the preview's active layers are derived where they are shown (EditorShell's
  // Inspector and preview hosts). The phone snapshot reads the rendered playhead and is told after each commit.
  const mobileInputs = useRef({ project, status });
  mobileInputs.current = { project, status };
  const [mobileSnapshot] = useState(() => createMobileSnapshotSource(() => ({ ...mobileInputs.current, playhead: playheadStore.rendered().time })));
  useEffect(() => mobileSnapshot.notify(), [mobileSnapshot, project, status]);
  const recovery = useProjectRecovery({
    api: window.haoDesktop,
    project,
    projectPath,
    cleanUpdatedAt,
    dirty,
    recoveryOwner,
    diskFileIdentity: projectSession.getSnapshot().diskFileIdentity,
    isRecoveryOwnerCurrent: projectSession.isRecoveryOwnerCurrent,
    onRestore: (restored, restoredPath, restoredCleanUpdatedAt, restoredUrls, baseFileIdentity) => {
      projectSession.replaceProject(restored, restoredPath, { dirty: true, cleanUpdatedAt: restoredCleanUpdatedAt, fileIdentity: baseFileIdentity });
      setRuntimeUrls(restoredUrls);
      setSelectedClipId(restored.tracks.flatMap((track) => track.clips)[0]?.id);
      setSelectedCaptionId(undefined);
      setPlayhead(0);
      setPlaying(false);
      setPlaybackRate(1);
    },
    onOpenSaved: (opened) => loadOpenedProject(opened),
    onStatus: setStatus,
  });
  const loadOpenedProject = (opened: OpenProjectResult, options?: { dirty?: boolean }) => {
    if (!opened.project) return;
    releaseBrowserUrls();
    setBrowserRelinkRequired(!isDesktop);
    projectSession.replaceProject(opened.project, opened.path, { dirty: options?.dirty, fileIdentity: opened.fileIdentity });
    setRuntimeUrls(opened.runtimeUrls ?? {});
    const firstClip = opened.project.tracks.flatMap((track) => track.clips)[0];
    setSelectedClipId(firstClip?.id);
    setSelectedCaptionId(undefined);
    setPlayhead(0);
    setPlaying(false);
    setPlaybackRate(1);
    setTrackingMode(undefined);
    setTrackingSelection(undefined);
  };
  const batchAutoEdit = useBatchAutoEdit({ api: window.haoDesktop, projectSession, onOpenProject: loadOpenedProject, onStatus: setStatus });
  useAutomaticUpdates(window.haoDesktop?.checkForUpdates, setStatus);
  const desktopActions = useDesktopActions(window.haoDesktop, setStatus);
  const runCommand = (command: EditorCommand, successMessage?: string, options?: TimelineEditOptions, commandContext?: EditorCommandContext) => {
    const recordId = makeId("cmd");
    // `coalesce`: the commands of one held gesture (Alt+← → nudges) share one Undo step.
    const result = dispatchCommandSafely(projectSession.getSnapshot().history, command, recordId, {
      ...commandContext,
      currentAestheticArtifact: (candidate) => projectSession.isCurrentSession(sessionId) ? aestheticOutputOwner.get(candidate) : undefined,
    }, options?.coalesce);
    setHistory(result.state);
    setStatus(result.error ?? successMessage ?? "操作完成。");
    return !result.error;
  };
  // Split and delete: a title template the gesture changes follows it in the same command (one Undo); a clip without one
  // runs the same command with the same message as before, at once.
  const templateFollowEdits = createTemplateFollowEditActions({ getProject: () => projectSession.getSnapshot().history.present, runCommand, setStatus });
  const clipMedia = useClipMediaEdits({ api: window.haoDesktop, projectSession, getPlayhead: renderedPlayhead, onCommand: runCommand, onStatus: setStatus, onPause: pausePlayback,
    onRuntimeUrls: urls => setRuntimeUrls(current => ({ ...current, ...urls })) });
  const motionCreationOwner = useMemo(() => createMotionGraphicCreationOwner({
    session: projectSession, onCommand: runCommand, onStatus: setStatus,
  }), [projectSession, sessionId, aestheticOutputOwner]);
  useEffect(() => motionCreationOwner.attach(), [motionCreationOwner]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") motionCreationOwner.cancel(); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [motionCreationOwner]);
  const automatic = useAutomaticEditing({
    api: window.haoDesktop,
    projectSession,
    project,
    selectedClip,
    onCommand: runCommand,
    onStatus: setStatus,
    onRuntimeUrls: (urls) => setRuntimeUrls((current) => ({ ...current, ...urls })),
  });
  const splitSelected = () => {
    const playhead = renderedPlayhead();
    // Ctrl+B and 切開: the selected clip when the playhead is inside it; otherwise the clip under the playhead (the selected
    // clip's track first, then 主畫面, then the topmost unlocked track). Picking a clip never moves the playhead.
    const found = findSplitTarget(projectSession.getSnapshot().history.present, playhead, selectedClipId);
    if ("refusal" in found) return setStatus(found.refusal);
    void templateFollowEdits.split(found.target.clip.id, playhead, makeId("clip"));
  };
  const deleteSelected = () => { liveKeys.current.delete?.({ repeat: false }); };
  // The 剪刀 tool: the clicked clip (with Shift, every unlocked track's clip there) is cut where it was clicked, with the
  // same split command as 切開 and Ctrl+B; one Undo.
  const cutClipsAt = (cuts: TimelineCut[]) => { if (cuts.length) void templateFollowEdits.splitMany(cuts, () => makeId("clip")); };
  // Q and W: the part of the clip left or right of the playhead goes and the gap closes (one Undo). After Q the playhead
  // stays on the same picture, now at the clip's old start, and the piece that stays is the selection.
  const deleteToPlayhead = (side: "left" | "right") => {
    const playhead = renderedPlayhead();
    const run = templateFollowEdits.deleteToPlayhead(side, playhead, selectedClipId, makeId("clip"));
    if (!run) return;
    const after = (ran: boolean) => {
      if (!ran) return;
      if (side === "left") setPlayhead(run.plan.start);
      if (selectedClipId === run.plan.clipId) setSelectedClipId(run.plan.keptClipId);
    };
    if (typeof run.ran === "boolean") after(run.ran); else void run.ran.then(after);
  };
  const addCaption = () => {
    const playhead = renderedPlayhead();
    const captionId = makeId("caption");
    // Never on top of existing text (only one caption shows at a time): inside a caption the new one starts where that
    // one ends, and it is shortened to fit before the next caption.
    const place = planCaptionInsert(project.captions, playhead, project.fps);
    if (!runCommand({
      type: "add_caption",
      caption: { id: captionId, text: "輸入字幕內容", start: place.moved ? place.start : playhead, duration: place.duration },
    }, place.moved ? `這裡已經有字幕，新文字放在 ${place.start.toFixed(2)} 秒，接在它後面。` : `已在 ${playhead.toFixed(2)} 秒加入字幕。`)) return;
    if (place.moved) setPlayhead(place.start);
    setSelectedClipId(undefined);
    setSelectedCaptionId(captionId);
  };
  const addTrack = (kind: "video" | "audio") => {
    const existing = project.tracks.filter((track) => track.kind === kind).length;
    const label = kind === "video" ? "畫面" : "聲音";
    runCommand({
      type: "add_track",
      track: { id: makeId(`${kind}-track`), name: `${label}軌 ${existing + 1}`, kind, locked: false, muted: false, clips: [] },
    }, `已新增一條${label}軌，可重新命名、鎖定或刪除。`);
  };
  const addAssetToTimeline = (assetId: string, mode: "timeline" | "pip" = "timeline", placement?: { trackId: string; timelineStart: number; dropMode?: "insert" | "overwrite" }) => {
    const playhead = renderedPlayhead();
    const project = projectSession.getSnapshot().history.present;
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) { setStatus("找不到要加入的素材。"); return false; }
    if (mode === "pip" && asset.kind === "audio") { setStatus("畫中畫需要影片或圖片素材。"); return false; }
    if (placement && mode === "timeline") {
      const clipId = makeId("clip");
      try {
        const planned = planTimelineAssetDrop(project, assetId, placement.trackId, placement.timelineStart, clipId, makeId, placement.dropMode);
        if (!runCommand(planned.command, planned.message)) return false;
        setSelectedCaptionId(undefined);
        setSelectedClipId(clipId);
        setPlayhead(planned.timelineStart);
        return true;
      } catch (error) { setStatus(error instanceof Error ? error.message : "無法加入素材。"); return false; }
    }
    const commands: EditorCommand[] = [];
    let trackId: string;
    let timelineStart: number;
    if (mode === "pip") {
      const existing = project.tracks.find((track) => track.kind === "video" && !track.locked && track.name.startsWith("畫中畫")
        && track.clips.every(clip => playhead + timelineAssetDuration(asset, project.fps) <= clip.timelineStart + 1e-6 || playhead >= clip.timelineStart + clip.duration - 1e-6));
      trackId = existing?.id ?? makeId("pip-track");
      if (!existing) commands.push({ type: "add_track", track: { id: trackId, name: `畫中畫 ${project.tracks.filter((track) => track.name.startsWith("畫中畫")).length + 1}`, kind: "video", locked: false, muted: false, clips: [] } });
      timelineStart = alignTime(playhead, project.fps);
    } else {
      const kind = asset.kind === "audio" ? "audio" : "video";
      const target = project.tracks.find((track) => track.kind === kind && !track.locked);
      trackId = target?.id ?? makeId(`${kind}-track`);
      if (!target) commands.push({ type: "add_track", track: { id: trackId, name: kind === "audio" ? "新增聲音軌" : "新增畫面軌", kind, locked: false, muted: false, clips: [] } });
      const trackEnd = target?.clips.reduce((end, clip) => Math.max(end, clip.timelineStart + clip.duration), 0) ?? 0;
      timelineStart = Math.max(0, Math.ceil(trackEnd * project.fps - 1e-7) / project.fps);
    }
    const clipId = makeId(mode === "pip" ? "pip-clip" : "clip");
    const clipDuration = timelineAssetDuration(asset, project.fps);
    if (clipDuration <= 0) { setStatus("素材不足一個專案影格，無法加入時間軸。"); return false; }
    commands.push({ type: "add_clip", clip: {
      id: clipId, assetId: asset.id, trackId, timelineStart, sourceStart: 0, duration: clipDuration, volume: 1,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      layout: mode === "pip" ? structuredClone(DEFAULT_PIP_LAYOUT) : undefined,
      layer: { ...DEFAULT_CLIP_LAYER },
    } });
    if (!runCommand({ type: "batch", commands }, mode === "pip" ? "已加入真正的畫中畫軌道；可拖曳片段並切換角落版型。" : "已把素材加入時間軸尾端。")) return false;
    setSelectedCaptionId(undefined);
    setSelectedClipId(clipId);
    setPlayhead(timelineStart);
    return true;
  };
  const precomposeSelected = () => {
    if (!selectedClip) return setStatus("請先選取要做成預合成的片段。");
    const sourceTrack = project.tracks.find((track) => track.id === selectedClip.trackId);
    const targetTrack = sourceTrack?.kind === "video" ? sourceTrack : project.tracks.find((track) => track.kind === "video" && !track.locked);
    if (!targetTrack) return setStatus("找不到可放置預合成的畫面軌。");
    const sourceAsset = project.assets.find((asset) => asset.id === selectedClip.assetId);
    const name = window.prompt("預合成名稱", `${sourceAsset?.name ?? "片段"} 預合成`)?.trim();
    if (!name) return;
    const replacementClipId = makeId("precomp-clip");
    runCommand({
      type: "precompose_clips",
      compositionId: makeId("composition"),
      assetId: makeId("precomp-asset"),
      replacementClipId,
      targetTrackId: targetTrack.id,
      name,
      clipIds: [selectedClip.id],
    }, `已建立「${name}」預合成；內部時間軸會隨專案存檔，預覽與輸出使用同一份內容。`);
    setSelectedClipId(replacementClipId);
    setSelectedCaptionId(undefined);
  };
  const makeSelectedPictureInPicture = (layout: ClipLayout = DEFAULT_PIP_LAYOUT, name = "右上角") => {
    if (!selectedClip) return setStatus("請先選取一段影片或圖片。");
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
    if (!asset || asset.kind === "audio") return setStatus("畫中畫只能使用影片或圖片。");
    // The clip keeps its blend mode and layer settings; the plan only places the picture.
    const { commands, hasBackground } = planPictureInPictureV1(project, selectedClip, layout, () => makeId("pip-track"));
    runCommand({ type: "batch", commands }, `已套用${name}畫中畫${hasBackground ? "" : "；再把底圖或主影片放到主畫面軌即可看到雙層"}。`);
  };
  const applyShortFormTemplate = async (templateId: string, content?: import("./application/shortFormTemplates").ShortFormTemplateContent) => {
    const task = projectSession.beginTask(project);
    try {
      const { buildShortFormTemplateCommand, SHORT_FORM_TEMPLATES } = await import("./application/shortFormTemplates");
      if (!acceptProjectTask(task, setStatus, "套用短影音模板")) return;
      const template = SHORT_FORM_TEMPLATES.find((item) => item.id === templateId);
      if (!template) throw new Error("找不到短影音模板");
      const command = buildShortFormTemplateCommand(project, templateId, (prefix) => makeId(prefix), content);
      runCommand(command, `已套用「${template.name}」；每個片段、字卡與效果仍可單獨修改。`);
    } catch (error) {
      if (acceptProjectTask(task, setStatus, "套用短影音模板")) setStatus(error instanceof Error ? error.message : "無法套用短影音模板");
    }
  };
  const applyLongFormTemplate = async (templateId: string) => {
    const task = projectSession.beginTask(project);
    try {
      const { buildLongFormTemplateCommand, LONG_FORM_TEMPLATES } = await import("./application/longFormTemplates");
      if (!acceptProjectTask(task, setStatus, "套用長片模板")) return;
      const template = LONG_FORM_TEMPLATES.find((item) => item.id === templateId);
      if (!template) throw new Error("找不到長片模板");
      const command = buildLongFormTemplateCommand(project, templateId, (prefix) => makeId(prefix));
      runCommand(command, `已套用「${template.name}」；字幕維持純白，字卡、VFX、標籤與節奏標記都能單獨修改。`);
    } catch (error) {
      if (acceptProjectTask(task, setStatus, "套用長片模板")) setStatus(error instanceof Error ? error.message : "無法套用長片模板");
    }
  };
  const addLowerThird = (presetId: LowerThirdPresetId, personName: string, organization: string) => {
    const playhead = renderedPlayhead();
    try {
      const current = projectSession.getSnapshot().history.present;
      const command = buildLowerThirdCommand(current, { presetId, personName, organization, timelineStart: playhead }, (prefix) => makeId(prefix));
      runCommand(command, `已在 ${playhead.toFixed(2)} 秒加入可編輯的人名 BAR／單位 BAR；同時段舊 BAR 已自動替換。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "無法加入人物字幕條");
    }
  };
  const clearTemplateApplication = () => {
    const current = projectSession.getSnapshot().history.present;
    const count = templateOwnedElementCount(current);
    const commands = templateApplicationCleanupCommands(current);
    if (!commands.length) return setStatus("目前沒有已套用的成片模板。");
    runCommand({ type: "batch", commands }, `已還原成套用模板前的設定並移除 ${count} 個模板元素；套用後手動修改的欄位已保留。`);
  };
  const addImportedMedia = (importedFiles: ImportedBrowserMedia[], options: { backgroundMusic?: boolean; placement?: TimelineImportPlacement } = {}) => {
    if (!importedFiles.length) return false;
    // Import is additive: use the live graph, not the render that opened the picker.
    const project = projectSession.getSnapshot().history.present;
    if (options.backgroundMusic) {
      const imported = importedFiles[0];
      const music = buildLoopingMusicPlan(project, imported.asset, () => makeId("music-clip"));
      if (!runCommand({ type: "batch", commands: music.commands }, `已自動鋪滿 ${music.targetDuration.toFixed(1)} 秒配樂，重複處使用 ${music.crossfade.toFixed(1)} 秒 crossfade，旁白會自動 ducking。`)) return false;
      setRuntimeUrls((current) => ({ ...current, [imported.asset.id]: imported.runtimeUrl }));
      setSelectedCaptionId(undefined);
      setSelectedClipId(music.lastClipId);
      return true;
    }
    let placement: ReturnType<typeof planImportedMediaTimeline>;
    try { placement = planImportedMediaTimeline(project, importedFiles.map(item => item.asset), options.placement, makeId); }
    catch (error) { setStatus(error instanceof Error ? error.message : "指定落點已失效，素材尚未加入。"); return false; }
    if (!runCommand(placement.command, `已匯入 ${importedFiles.length} 份素材${placement.orientationMessage}，從第 ${Math.round(placement.timelineStart * project.fps)} 幀依序放入${placement.newLayers ? "；重疊處已新增圖層，原素材保留" : ""}。`)) return false;
    setRuntimeUrls((current) => Object.fromEntries([
      ...Object.entries(current),
      ...importedFiles.map(({ asset, runtimeUrl }) => [asset.id, runtimeUrl]),
    ]));
    setSelectedCaptionId(undefined);
    setSelectedClipId(placement.lastClipId);
    if (options.placement) setPlayhead(placement.timelineStart);
    return true;
  };
  const importFiles = async (files: File[], placement?: TimelineImportPlacement) => {
    const intent = placement ? Object.freeze({ ...placement }) : undefined;
    const task = projectSession.beginTask();
    const importedFiles: ImportedBrowserMedia[] = [];
    try {
      for (const file of files) {
        importedFiles.push(await importBrowserMedia(file));
        if (!task.isSessionCurrent()) {
          for (const item of importedFiles) URL.revokeObjectURL(item.runtimeUrl);
          return;
        }
      }

      if (!addImportedMedia(importedFiles, { placement: intent })) for (const item of importedFiles) URL.revokeObjectURL(item.runtimeUrl);
      else for (const item of importedFiles) ownedBrowserUrls.current.set(item.asset.id, item.runtimeUrl);
    } catch (error) {
      for (const item of importedFiles) URL.revokeObjectURL(item.runtimeUrl);
      if (task.isSessionCurrent()) setStatus(error instanceof Error ? error.message : "無法匯入素材");
    }
  };
  const relinkBrowserMedia = async (assetId: string) => {
    if (isDesktop) return;
    if (browserRelinkPending.current) { setStatus("正在為另一份素材選檔或驗證；請等它完成。"); return; }
    const task = projectSession.beginTask();
    const sourceProject = projectSession.getSnapshot().history.present;
    const sourceAsset = sourceProject.assets.find(asset => asset.id === assetId);
    if (!sourceAsset || sourceAsset.compositionId) return;
    browserRelinkPending.current = true;
    const sourceIdentity = JSON.stringify(sourceAsset);
    let prepared: Awaited<ReturnType<typeof prepareBrowserMediaRelink>> | undefined;
    try {
      setPlaying(false);
      const file = await chooseBrowserFile(`${sourceAsset.kind}/*`);
      if (!file || !task.isSessionCurrent()) return;
      setStatus(`正在驗證「${sourceAsset.name}」的所選檔案…`);
      prepared = await prepareBrowserMediaRelink(sourceProject, assetId, file);
      if (!task.isSessionCurrent()) { prepared.dispose(); return; }
      const live = projectSession.getSnapshot().history.present;
      if (JSON.stringify(live.assets.find(asset => asset.id === assetId)) !== sourceIdentity) throw new Error("選檔期間原素材設定已變更，未重新連結。");
      assertBrowserMediaRelink(live, assetId, prepared.measured);
      const previous = ownedBrowserUrls.current.get(assetId);
      if (previous) URL.revokeObjectURL(previous);
      const runtimeUrl = prepared.runtimeUrl;
      ownedBrowserUrls.current.set(assetId, runtimeUrl);
      setRuntimeUrls(current => ({ ...current, [assetId]: runtimeUrl }));
      setStatus(`已為「${sourceAsset.name}」重新連結瀏覽器預覽；片段 IDs、來源範圍與幀位置保留。${sourceAsset.kind === "image" ? "靜態圖片沒有媒體時長，保留專案編排時長。" : ""}${sourceAsset.derivatives?.sourceSha256 ? "已核對原素材 SHA-256。" : "原專案沒有實體 SHA，僅核對類型、時長與尺寸，無法證明原檔位元相同。"}重開後需再次選檔。`);
    } catch (error) {
      prepared?.dispose();
      if (task.isSessionCurrent()) setStatus(error instanceof Error ? error.message : "素材未重新連結");
    } finally { browserRelinkPending.current = false; }
  };
  const creativeLibrary = useCreativeLibrary({
    api: window.haoDesktop,
    projectSession,
    onPicked: (items, options) => addImportedMedia(items.map((item) => ({ asset: item.asset, runtimeUrl: item.previewUrl })), options),
    onPrepared: (items, isCurrent = () => true) => {
      if (!isCurrent()) return;
      const liveUris = new Map(projectSession.getSnapshot().history.present.assets.map(asset => [asset.id, asset.uri]));
      const currentItems = items.filter(item => liveUris.has(item.assetId));
      projectSession.applyMediaDerivatives(currentItems.map(item => ({ assetId: item.assetId, sourceUri: liveUris.get(item.assetId)!, derivatives: item.derivatives })));
      setRuntimeUrls((current) => isCurrent() ? Object.assign({}, current, ...currentItems.map((item) => item.runtimeUrls)) : current);
    },
    onStatus: setStatus,
    onCommands: (commands, message) => runCommand({ type: "batch", commands }, message),
  });
  const addMotionGraphic = (kind: MotionGraphicKind, trackId?: string, seed?: MotionGraphicPresetSeed) => {
    const playhead = renderedPlayhead();
    motionCreationOwner.cancel();
    setPlaying(false);
    if (seed?.schema === "hao.motion-composition/v3") {
      // Motion Design v3 gallery picks start from the template's full sample copy; each line is edited in the motion list.
      const current = projectSession.getSnapshot().history.present;
      const end = projectDuration(current);
      try {
        const graphic = createMotionGraphic(makeId("motion"), kind, seed.text ?? "", playhead,
          Math.max(MOTION_V3_MIN_DURATION_SECONDS, Math.min(4, end - playhead || 3)), undefined, seed);
        runCommand({ type: "add_motion_graphic", graphic }, `已加入「${graphic.name}」；在動態圖卡清單逐行改字即可。`);
      } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
      return;
    }
    const defaults: Record<MotionGraphicKind, string> = { title: "輸入主標題", card: "輸入重點內容", tag: trackId ? "追蹤重點" : "重點標籤", counter: "01" };
    const snapshot = projectSession.getSnapshot();
    setMotionTextRequest({ kind, trackId, seed, initialText: seed?.name ?? defaults[kind], sessionId: snapshot.sessionId,
      revision: snapshot.history.present.revision, start: playhead });
  };
  const submitMotionGraphicText = (text: string) => {
    const request = motionTextRequest;
    setMotionTextRequest(undefined);
    if (!request) return;
    const snapshot = projectSession.getSnapshot();
    if (snapshot.sessionId !== request.sessionId || snapshot.history.present.revision !== request.revision) {
      setStatus("專案已變更，尚未新增圖文；請重新選擇位置後建立。"); return;
    }
    const { kind, trackId, seed, start } = request;
    const current = projectSession.getSnapshot().history.present;
    const end = projectDuration(current);
    if (!trackId && (!seed || seed.schema === "hao.motion-composition/v2")) {
      void motionCreationOwner.start({ expectedRevision: current.revision, graphicId: makeId("motion"), kind, text,
        startFrame: Math.round(start * current.fps), preferredDurationFrames: Math.max(1, Math.floor((end > 0 ? 4 : 3) * current.fps)),
        scope: end > 0 ? "existing_timeline" : "empty_canvas", ...(seed ? { presetId: seed.presetId } : {}) });
      return;
    }
    // Explicit existing tracked/v1 producers remain readable; this is not a
    // fallback from failed new-v2 preparation and does not certify T11 migration.
    motionCreationOwner.cancel();
    try {
      const graphic = createMotionGraphic(makeId("motion"), kind, text, start, Math.max(0.5, Math.min(4, end - start || 3)), trackId,
        seed ?? legacyMotionGraphicSeed(kind));
      runCommand({ type: "add_motion_graphic", graphic }, trackId ? "已把標籤綁到追蹤主體，預覽與輸出會同步移動。" : "已加入明選的相容圖卡。");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };
  const acceptTrackingSelection = async (rect: NormalizedRect) => {
    const playhead = renderedPlayhead();
    if (trackingPending.current) return;
    const mode = trackingModeRef.current, current = trackingScope.read(mode);
    if (!mode || !current) return;
    const { project, clip: selectedClip, asset } = current;
    const accepts = () => trackingModeRef.current === mode && Boolean(trackingScope.read(mode));
    setTrackingSelection(rect);
    if (mode.kind === "correct" && mode.trackId) {
      const track = project.motionTracks.find((item) => item.id === mode.trackId && item.clipId === selectedClip.id);
      if (!track) return setStatus("找不到要修正的追蹤資料。");
      const time = Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.timelineStart));
      if (runCommand({ type: "set_motion_track_point", trackId: track.id, point: { frame: Math.round(time * track.analysisFps), time, rect, confidence: 1, status: "manual" } }, "已把目前框選寫成手動修正幀，前後追蹤會接續使用。") === false) return;
      setTrackingMode(undefined);
      return;
    }
    if (!asset || asset.kind !== "video" || !window.haoDesktop) return setStatus("動態追蹤需要桌面版影片素材。");
    const task = projectSession.beginTask(project);
    if (!acceptProjectTask(task, setStatus, "動態追蹤")) return;
    trackingPending.current = true;
    setTrackingBusy(true);
    setStatus("正在以 FFmpeg 取樣並用 Rust 追蹤主體；影片越長需要越久…");
    try {
      const result = await window.haoDesktop.analyzeMotionTrack({
        sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration, fps: project.fps,
        sourceWidth: asset.width ?? project.width, sourceHeight: asset.height ?? project.height,
        initialTime: Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.timelineStart)), initialRect: rect,
        sourceSha256: asset.derivatives?.sourceSha256,
      });
      if (!accepts() || !acceptProjectTask(task, setStatus, "動態追蹤")) return;
      const trackId = makeId("motion-track");
      const role = mode.kind === "podcast" ? mode.role : "subject";
      const track: MotionTrack = { id: trackId, clipId: selectedClip.id, name: role === "host" ? "主持人" : role === "guest" ? "來賓" : "追蹤主體", role, engine: result.engine, analysisFps: result.analysisFps, initialRect: rect, points: result.points, lostRatio: result.lostRatio, createdAt: new Date().toISOString() };
      if (mode.kind === "podcast" && mode.role === "host") {
        if (runCommand({ type: "add_motion_track", track }, `主持人追蹤完成：${Math.round((1 - result.lostRatio) * 100)}% 有效幀。`) === false) return;
        setTrackingSelection(undefined);
        setTrackingMode({ kind: "podcast", role: "guest", hostTrack: track });
        setStatus("第一位完成。現在請框住來賓的臉；證據不足的區間會保留雙人畫面，不會亂切。");
        return;
      }
      if (mode.kind === "podcast" && mode.role === "guest") {
        const hostTrack = mode.hostTrack;
        if (!hostTrack) throw new Error("主持人追蹤資料遺失，請重新開始雙人物導播");
        setStatus("兩位人物追蹤完成，正在本機辨識語音並建立可編輯導播時間軸…");
        const transcript = await window.haoDesktop.automaticCaptionMedia({
          sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration,
          sourceSha256: asset.derivatives?.sourceSha256, language: "auto",
        });
        if (!accepts() || !acceptProjectTask(task, setStatus, "雙人物導播")) return;
        const { buildPodcastDirectorCommand } = await import("./application/podcastDirector");
        if (!accepts() || !acceptProjectTask(task, setStatus, "雙人物導播")) return;
        const built = buildPodcastDirectorCommand({ project, clip: selectedClip, host: hostTrack, guest: track, cues: transcript.cues, idFactory: (kind, index) => `${makeId(kind)}-${index}` });
        if (built.command.type !== "batch") throw new Error("雙人物導播命令格式錯誤");
        if (runCommand({ type: "batch", commands: [
          { type: "add_motion_track", track },
          { type: "set_caption_style", patch: { presetId: "clean_caption", backgroundColor: "#00000099", color: "#FFFFFF" } },
          ...built.command.commands,
        ] }, `Podcast 導播完成：${built.shots.length} 個可編輯鏡位，${built.uncertainShots} 個不確定區間保留雙人畫面。`) === false) return;
        setTrackingMode(undefined);
        setTrackingSelection(undefined);
        return;
      }
      const graphic = createMotionGraphic(makeId("motion"), "tag", "追蹤重點", playhead, Math.max(0.5, Math.min(selectedClip.timelineStart + selectedClip.duration - playhead, 4)), trackId, legacyMotionGraphicSeed("tag"));
      if (runCommand({ type: "batch", commands: [
        { type: "add_motion_track", track },
        { type: "add_motion_graphic", graphic },
      ] }, `追蹤完成：${Math.round((1 - result.lostRatio) * 100)}% 有效幀，已自動綁定標籤${result.cacheHit ? "（快取命中）" : ""}。`) === false) return;
      setTrackingMode(undefined);
    } catch (error) {
      if (accepts() && acceptProjectTask(task, setStatus, "動態追蹤")) setStatus(error instanceof Error ? `動態追蹤失敗：${error.message}` : `動態追蹤失敗：${String(error)}`);
    } finally { trackingPending.current = false; setTrackingBusy(false); }
  };
  const startPodcastDirector = () => {
    if (!trackingActionGuard()) return;
    if (!selectedClip || project.assets.find((asset) => asset.id === selectedClip.assetId)?.kind !== "video") return setStatus("請先在 Timeline 選一段包含兩位人物的影片。");
    setPlaying(false);
    setTrackingSelection(undefined);
    if (runCommand({ type: "batch", commands: [
      { type: "set_editorial_profile", profile: "podcast_on_camera" },
      { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem("podcast_on_camera", project.width > project.height ? "longform" : "shorts") },
    ] }, "已進入 Podcast 雙人物導播並套用訪談美感標準。") === false) return;
    setTrackingMode({ kind: "podcast", role: "host" });
    setStatus("請先在預覽畫面框住主持人的臉；放開後會用 Rust 分析位置與局部說話動態。");
  };
  const { newProject, openProject, saveProject } = createAppProjectFileActions({
    confirm: (message) => window.confirm(t(message)),
    api: window.haoDesktop, session: projectSession, loadOpenedProject,
    setRuntimeUrls: () => { releaseBrowserUrls(); setBrowserRelinkRequired(false); setRuntimeUrls({}); }, setSelectedClipId, setSelectedCaptionId, setPlayhead,
    setPlaying, setPlaybackRate,
    requestProjectDownload: projectDownloadOwner.request,
    setTrackingMode, setTrackingSelection, setStatus,
  });
  const submitAgentInstruction = (instruction: string) => submitAppAgentInstruction(instruction, {
    automatic, project, selectedClipId, selectedCaptionId, playhead: renderedPlayhead(), runCommand, setHistory, setStatus,
  });
  const mobile = useMobileRemote({ api: window.haoDesktop, snapshot: mobileSnapshot, onInstruction: submitAgentInstruction, onStatus: setStatus });

  const { renderVideo, renderOpenExrSequence, renderAlphaMaster } = createAppRenderActions({
    api: window.haoDesktop, project, setStatus, session: projectSession, requestProjectDownload: projectDownloadOwner.request,
    onArtifactReady: async (snapshot, artifact) => {
      if (!projectSession.isCurrentSession(sessionId)) return false;
      const bound = await aestheticOutputOwner.bind(snapshot, artifact);
      if (!projectSession.isCurrentSession(sessionId)) return false;
      setAestheticOutputVersion(version => version + 1);
      return bound;
    },
  });

  const undoEdit = () => { setHistory((current) => undo(current)); setStatus("已復原上一步。"); };
  const redoEdit = () => { setHistory((current) => redo(current)); setStatus("已重做上一步。"); };
  // The timeline fills this in while it is shown: Alt+← → move its selection, Delete removes a picked title.
  const timelineKeyboard = useRef<TimelineKeyboardActions | undefined>(undefined);
  // The Motion Library GUI fills this in: Ctrl+T applies the last transition, Delete removes a selected transition first.
  const motionLibraryKeyboard = useRef<import("./ui/motionLibraryControllerV1").MotionLibraryKeyboardActionsV1 | undefined>(undefined);
  const nudgePress = useRef(0);
  const nudgeQueue = useMemo(() => createTimelineNudgeQueue(), [sessionId]);
  useEffect(() => () => nudgeQueue.cancelQueued(), [nudgeQueue]);
  // Every key reads the editor as it is now: the playhead and selection change without re-creating the handlers.
  const liveKeys = useRef<EditorShortcutHandlers>({});
  liveKeys.current = {
    save: () => void saveProject(),
    "save-as": () => void saveProject(true),
    "find-captions": () => { pausePlayback(); setCaptionSearchOpen(true); },
    undo: undoEdit,
    redo: redoEdit,

    split: splitSelected,
    play: togglePlayback,
    pause: pausePlayback,
    "shuttle-back": () => shuttlePlayback(-1),
    "shuttle-forward": () => shuttlePlayback(1),
    "frame-back": () => frameStepPlayback(-1),
    "frame-forward": () => frameStepPlayback(1),
    "second-back": () => { setPlaying(false); setPlayhead((current) => Math.max(0, current - 1)); },
    "second-forward": () => { setPlaying(false); setPlayhead((current) => Math.min(duration, current + 1)); },

    "go-start": () => { setPlaying(false); setPlayhead(0); },
    "go-end": () => { setPlaying(false); setPlayhead(duration); },
    // B 剪刀 and A 選取 are the timeline's tools; Esc leaves 剪刀 (true) or stays with whoever else uses it (false).
    "blade-tool": () => timelineKeyboard.current?.setTool("blade"),
    "select-tool": () => timelineKeyboard.current?.setTool("select"),
    "escape-tool": () => timelineKeyboard.current?.escapeTool() ?? false,
    "delete-left": () => deleteToPlayhead("left"),
    "delete-right": () => deleteToPlayhead("right"),
    ...createTimelineShortcutActions({
      getProject: () => projectSession.getSnapshot().history.present, runCommand, setStatus,
      getSelection: timelineEditing.getSelection, setSelection: timelineEditing.setSelection,
      getClipboard: timelineEditing.getClipboard, setClipboard: timelineEditing.setClipboard,
      getPlayhead: renderedPlayhead, setPlayhead, pause: pausePlayback,
      getMarkRange: timelineEditing.getMarkRange, setMarkRange: timelineEditing.setMarkRange,
      playRange: range => {
        const liveProject = projectSession.getSnapshot().history.present;
        const bounded = timelinePlaybackRange(range, projectDuration(liveProject), liveProject.fps);
        if (!bounded) { setStatus(SHORTCUT_RANGE_REQUIRED); return; }
        beginRangePlayback(bounded, active => { setPlaying(false); setPlaybackRate(1); setPlayhead(active.in); setPlaying(true); });
      },
      view: action => setViewRequest(current => ({ kind: action === "fit-timeline" ? "fit" : action, nonce: (current?.nonce ?? 0) + 1 })),
      simpleMode: () => interfacePreferences.getSnapshot().mode === "simple",
      escapeTool: () => timelineKeyboard.current?.escapeTool() ?? false,
      clearMotionSelection: () => timelineKeyboard.current?.clearMotionSelection?.() ?? false,
      deleteMotionSelection: () => timelineKeyboard.current?.deleteSelection() ?? false,
      nudgeMotionSelection: (frames, coalesce) => timelineKeyboard.current?.nudgeMotionSelection?.(frames, coalesce) ?? false,
      nudgeSequence: nudgePress, nudgeQueue, makeId, defaultMarkerTitle: () => t("標記"),
    }),
  };
  const deleteSelection = liveKeys.current.delete;
  liveKeys.current.delete = press => motionLibraryKeyboard.current?.deleteSelectedTransition() ? true : deleteSelection?.(press);
  liveKeys.current["apply-transition"] = () => motionLibraryKeyboard.current?.applyLastTransition();
  const shortcutHandlers = useMemo<EditorShortcutHandlers>(() => {
    const actions: EditorShortcutAction[] = ["save", "save-as", "undo", "redo", "delete", "split", "play", "pause", "shuttle-back", "shuttle-forward",
      "frame-back", "frame-forward", "second-back", "second-forward", "nudge-back", "nudge-forward", "nudge-back-ten", "nudge-forward-ten", "go-start", "go-end",
      "blade-tool", "select-tool", "escape-tool", "delete-left", "delete-right", "lift", "select-all", "select-forward", "copy", "cut", "paste", "duplicate",
      "add-marker", "next-marker", "previous-marker", "previous-edit", "next-edit", "mark-in", "mark-out", "clear-marks", "go-in", "go-out", "play-range",
      "zoom-in", "zoom-out", "fit-timeline", "toggle-snap", "trim-start", "trim-end", "find-captions", "apply-transition"];
    return Object.fromEntries(actions.map(action => [action, (press: EditorShortcutPress) => liveKeys.current[action]?.(press)]));
  }, []);
  useEditorShortcuts(recovery.ready ? shortcutHandlers : {});

  if (!recovery.ready && recovery.pendingChoice) return <RecoveryChoiceDialog request={recovery.pendingChoice} />;
  if (!recovery.ready) return <main className="app-loading" aria-busy="true" data-shortcuts-blocked="true">{t("正在檢查未儲存的工作…")}</main>;

  return <><PlayheadRenderObserver store={playheadStore} onRender={observeSeekRevision} onCommit={mobileSnapshot.notify} /><Suspense fallback={<main className="app-loading" aria-label={t("正在載入 Editkin")}>{t("正在載入 Editkin 剪輯工作區…")}</main>}><EditorShell currentAestheticArtifact={currentAestheticArtifact} {...{
    history, project, projectSession, duration, theme, setTheme, isDesktop, playheadStore, setPlayhead, onPlaybackClock, playing, setPlaying,
    getTimelineSelection: timelineEditing.getSelection, subscribeTimelineSelection: timelineEditing.subscribe,
    playbackRate, setPlaybackRate, togglePlayback, pausePlayback, shuttlePlayback, frameStepPlayback,
    selectedClipId, setSelectedClipId, selectedCaptionId, setSelectedCaptionId, selectedClip,
    selectedCaption, transitionNeighbors, selectedMotionTracks,
    runtimeUrls, mergeRuntimeUrls: (urls: Record<string, string>) => setRuntimeUrls(current => ({ ...current, ...urls })), missingMedia: isDesktop || !browserRelinkRequired ? [] : missingBrowserMedia(project, runtimeUrls), relinkBrowserMedia,
    projectDownload, cancelProjectDownload: projectDownloadOwner.cancel, status, setStatus, trackingMode, setTrackingMode, trackingSelection,
    setTrackingSelection, trackingBusy, trackingActionGuard, recovery, desktopActions, automatic, creativeLibrary, batchAutoEdit, mobile, loadOpenedProject,
    newProject, openProject, saveProject, undoEdit, redoEdit, renderVideo, renderOpenExrSequence, renderAlphaMaster, importFiles,
    acceptTrackingSelection, startPodcastDirector, submitAgentInstruction, runCommand,
    addMotionGraphic, addCaption, addTrack, addAssetToTimeline, makeSelectedPictureInPicture, precomposeSelected, applyShortFormTemplate, applyLongFormTemplate, addLowerThird, clearTemplateApplication, splitSelected, deleteSelected,
    cutClipsAt, timelineKeyboard, motionLibraryKeyboard, selectedClipIds: timelineSelection.clipIds, selectedCaptionIds: timelineSelection.captionIds,
    onSelectionChange: timelineEditing.setSelection, markRange, viewRequest,
    clipMediaBusy: clipMedia.busy, onFreezeFrame: clipMedia.freeze, onClipRetime: clipMedia.retime,
  }} />{captionSearchOpen && <CaptionFindReplaceSheet project={project} onCommand={command => runCommand(command, "已更新字幕文字。")}
    onSelect={captionId => { setSelectedCaptionId(captionId); setPlaying(false); setPlayhead(findCaption(project, captionId).start); }}
    onClose={() => setCaptionSearchOpen(false)} />}{motionTextRequest && <MotionGraphicTextDialog initialText={motionTextRequest.initialText} tracked={Boolean(motionTextRequest.trackId)}
    onClose={() => setMotionTextRequest(undefined)} onSubmit={submitMotionGraphicText} />}</Suspense></>;
}

export default App;

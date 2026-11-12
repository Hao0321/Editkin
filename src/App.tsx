import { lazy, Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./generated/fontFaces.css";
import { activeMediaLayers } from "./application/previewMedia";
import { downloadEditGraph } from "./application/exportGraph";
import { buildMobileSnapshot } from "./desktop/mobileSnapshot";
import { useAutomaticUpdates } from "./desktop/useAutomaticUpdates";
import { useEditorShortcuts } from "./desktop/useEditorShortcuts";
import { useCreativeLibrary } from "./desktop/useCreativeLibrary";
import { useMobileRemote } from "./desktop/useMobileRemote";
import { useProjectRecovery } from "./desktop/useProjectRecovery";
import { useAutomaticEditing } from "./desktop/useAutomaticEditing";
import { useBatchAutoEdit } from "./desktop/useBatchAutoEdit";
import { useDesktopActions } from "./desktop/useDesktopActions";
import type { OpenProjectResult } from "./desktop/types";
import { compileAgentInstruction, isAutomaticCaptionInstruction, isSceneSplitInstruction, isSemanticAutoEditInstruction, isSmartCutInstruction } from "./domain/agent";
import type { EditorCommand } from "./domain/commands";
import { activeVideoClip, alignTime, animatedClipState, createEmptyProject, findCaption, findClip, projectDuration } from "./domain/editGraph";
import { createUiDemoProject, UI_DEMO_PREVIEW_URI } from "./domain/demo";
import { dispatchCommandSafely, redo, undo } from "./domain/history";
import { DEFAULT_CLIP_LAYER, DEFAULT_COLOR, DEFAULT_TRANSFORM, type ClipLayout, type MotionGraphicKind, type MotionGraphicPresetSeed, type NormalizedRect } from "./domain/types";
import { importBrowserMedia, type ImportedBrowserMedia } from "./lib/browserMedia";
import { isStarterDemo } from "./application/sourceOrientation";
import { planImportedMediaPlacement } from "./application/importPlacement";
import { resolveAestheticSystem } from "./application/editkinAesthetic";
import { buildLoopingMusicPlan } from "./application/loopingMusic";
import { makeId } from "./lib/format";
import { useEditorTheme } from "./ui/useEditorTheme";
import { usePlayheadTransport } from "./ui/playheadTransport";
import { timelineAssetDuration } from "./ui/timelineAssetDrop";
import { createMotionGraphic } from "./motion/composition";
import type { TrackingMode } from "./ui/EditorShell";
import type { MotionTrack } from "./domain/types";
const EditorShell = lazy(() => import("./ui/EditorShell").then((module) => ({ default: module.EditorShell })));

import { DEFAULT_PIP_LAYOUT } from "./application/appDefaults";
import { createAppProjectFileActions } from "./application/appProjectFileActions";
import { createProjectSession } from "./application/projectSession";
import { acceptProjectTask } from "./application/projectTask";
import { submitAppAgentInstruction } from "./application/appAgentInstruction";
import { createAppRenderActions } from "./application/appRenderActions";
import { createAestheticOutputOwner } from "./application/aestheticOutputOwner";
import { buildLowerThirdCommand, type LowerThirdPresetId } from "./application/lowerThirds";
import { templateApplicationCleanupCommands, templateOwnedElementCount } from "./application/templateLifecycle";
import { openAgentProjectResult, type AgentProjectResult } from "./application/agentProjectResult";

function App() {
  const [projectSession] = useState(() => {
    const demo = createUiDemoProject();
    demo.aestheticSystem = resolveAestheticSystem("auto", "longform");
    return createProjectSession(demo);
  });
  const agentWorkingCopy = useRef<{ sessionId: number; projectId: string; path: string; revision: number; contentOwner: object; demoSourceUri?: string } | undefined>(undefined);
  const agentWorkingCopyPending = useRef<Promise<string> | undefined>(undefined);
  const { history, projectPath, cleanUpdatedAt, dirty, recoveryOwner, sessionId, savePending } = useSyncExternalStore(projectSession.subscribe, projectSession.getSnapshot, projectSession.getSnapshot);
  const aestheticOutputOwner = useMemo(() => createAestheticOutputOwner(), [sessionId]);
  const [aestheticOutputVersion, setAestheticOutputVersion] = useState(0);
  const setHistory = projectSession.setHistory;
  const { playhead, setPlayhead, seekRevision, onPlaybackClock } = usePlayheadTransport();
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>("clip-demo");
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | undefined>();
  const [runtimeUrls, setRuntimeUrls] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("選取片段後，直接告訴我你想怎麼改。");
  const renderGate = useRef(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [trackingMode, setTrackingMode] = useState<TrackingMode>();
  const [trackingSelection, setTrackingSelection] = useState<NormalizedRect>();
  const [trackingBusy, setTrackingBusy] = useState(false);
  const trackingPending = useRef(false);
  const { theme, setTheme } = useEditorTheme();
  const isDesktop = window.haoDesktop?.isDesktop === true;
  const project = history.present;
  const currentAestheticArtifact = useMemo(() => aestheticOutputOwner.get(project), [aestheticOutputOwner, aestheticOutputVersion, project]);
  const duration = projectDuration(project);
  const activeClip = activeVideoClip(project, playhead);
  const selectedClip = useMemo(() => {
    if (!selectedClipId) return undefined;
    try { return findClip(project, selectedClipId); } catch { return undefined; }
  }, [project, selectedClipId]);
  const selectedCaption = useMemo(() => {
    if (!selectedCaptionId) return undefined;
    try { return findCaption(project, selectedCaptionId); } catch { return undefined; }
  }, [project, selectedCaptionId]);
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
  const selectedClipAtPlayhead = useMemo(() => {
    if (!selectedClip || playhead < selectedClip.timelineStart || playhead > selectedClip.timelineStart + selectedClip.duration) return selectedClip;
    const animated = animatedClipState(selectedClip, playhead - selectedClip.timelineStart);
    return { ...selectedClip, transform: animated.transform, color: animated.color };
  }, [selectedClip, playhead]);
  const selectedMotionTracks = useMemo(() => selectedClip ? project.motionTracks.filter((track) => track.clipId === selectedClip.id) : [], [project.motionTracks, selectedClip]);
  const previewAsset = activeClip
    ? project.assets.find((asset) => asset.id === activeClip.assetId)
    : undefined;
  const activeLayers = activeMediaLayers(project, playhead, runtimeUrls, "video");
  const activeAudioLayers = activeMediaLayers(project, playhead, runtimeUrls, "audio");
  const mobileSnapshot = useMemo(
    () => buildMobileSnapshot(project, playhead, status, previewAsset),
    [project, playhead, status, previewAsset],
  );
  const recovery = useProjectRecovery({
    api: window.haoDesktop,
    project,
    projectPath,
    cleanUpdatedAt,
    dirty,
    recoveryOwner,
    isRecoveryOwnerCurrent: projectSession.isRecoveryOwnerCurrent,
    onRestore: (restored, restoredPath, restoredCleanUpdatedAt, restoredUrls) => {
      projectSession.replaceProject(restored, restoredPath, { dirty: true, cleanUpdatedAt: restoredCleanUpdatedAt });
      setRuntimeUrls(restoredUrls);
      setSelectedClipId(restored.tracks.flatMap((track) => track.clips)[0]?.id);
      setSelectedCaptionId(undefined);
      setPlayhead(0);
      setPlaying(false);
    },
    onStatus: setStatus,
  });
  const loadOpenedProject = (opened: OpenProjectResult, dirty = false) => {
    if (!opened.project) return;
    projectSession.replaceProject(opened.project, opened.path, { dirty });
    setRuntimeUrls(opened.runtimeUrls ?? {});
    const firstClip = opened.project.tracks.flatMap((track) => track.clips)[0];
    setSelectedClipId(firstClip?.id);
    setSelectedCaptionId(undefined);
    setPlayhead(0);
    setPlaying(false);
    setTrackingMode(undefined);
    setTrackingSelection(undefined);
  };
  const ensureAgentWorkingProject = useCallback(async (): Promise<string> => {
    const api = window.haoDesktop;
    if (!api) throw new Error("只有桌面版能建立 Agent 剪輯工作副本");
    if (agentWorkingCopyPending.current) return agentWorkingCopyPending.current;
    const prepare = async (projectSwitches = 0): Promise<string> => {
      const started = projectSession.getSnapshot();
      const existing = agentWorkingCopy.current;
      if (existing && existing.sessionId === started.sessionId && existing.projectId === started.history.present.id) {
        if (existing.contentOwner === started.contentOwner) return existing.path;
        const copy = structuredClone(started.history.present);
        if (copy.id === "editkin-demo" && existing.demoSourceUri) {
          const demo = copy.assets.find((asset) => asset.id === "asset-demo" && asset.uri === UI_DEMO_PREVIEW_URI);
          if (demo) demo.uri = existing.demoSourceUri;
        }
        copy.revision = existing.revision;
        const saved = await api.saveProject(copy, existing.path, false);
        if (saved.canceled || !saved.project || saved.path !== existing.path || saved.project.id !== existing.projectId)
          throw new Error("Agent 工作副本未完成同步");
        const current = projectSession.getSnapshot();
        if (current.sessionId !== started.sessionId && projectSwitches < 2)
          return prepare(projectSwitches + 1);
        if (current.sessionId !== started.sessionId || current.contentOwner !== started.contentOwner)
          throw new Error("同步期間剪輯台又有修改；請再送一次，避免 Agent 使用舊內容");
        existing.revision = saved.project.revision;
        existing.contentOwner = current.contentOwner;
        return existing.path;
      }
      if (started.projectPath) return started.projectPath;
      const created = await api.createAgentWorkingProject(started.history.present);
      const current = projectSession.getSnapshot();
      if ((current.sessionId !== started.sessionId || current.projectPath) && projectSwitches < 2)
        return prepare(projectSwitches + 1);
      if (current.sessionId !== started.sessionId || current.contentOwner !== started.contentOwner || current.projectPath)
        throw new Error("準備 Agent 工作副本期間專案已變動；請再試一次");
      if (!created.path || created.project.id !== started.history.present.id)
        throw new Error("Agent 工作副本建立結果不完整");
      agentWorkingCopy.current = { sessionId: started.sessionId, projectId: created.project.id,
        path: created.path, revision: created.project.revision, contentOwner: started.contentOwner,
        demoSourceUri: started.history.present.id === "editkin-demo"
          ? created.project.assets.find((asset) => asset.id === "asset-demo")?.uri : undefined };
      return created.path;
    };
    const pending = prepare();
    agentWorkingCopyPending.current = pending;
    try { return await pending; }
    finally { if (agentWorkingCopyPending.current === pending) agentWorkingCopyPending.current = undefined; }
  }, [projectSession]);
  const openCompletedAgentProject = async (result: AgentProjectResult) => {
    const api = window.haoDesktop;
    if (!api) throw new Error("只有桌面版能開啟先前的 Agent 剪輯結果。");
    return openAgentProjectResult({ result, session: projectSession, load: api.reloadProjectFromPath,
      confirm: (message) => window.confirm(message), open: (opened) => {
        loadOpenedProject(opened, result.workingCopy);
        if (result.workingCopy && opened.project) {
          const current = projectSession.getSnapshot();
          agentWorkingCopy.current = { sessionId: current.sessionId, projectId: opened.project.id,
            path: result.path, revision: opened.project.revision, contentOwner: current.contentOwner };
        }
        setStatus("已開啟先前的 Agent 剪輯結果；請審片，滿意後儲存正式專案。");
      } });
  };
  const reloadAgentProject = async (agentPath?: string, allowConflictReplace = false) => {
    const snapshot = projectSession.getSnapshot();
    const working = agentWorkingCopy.current;
    if (agentPath && working?.path === agentPath && working.sessionId === snapshot.sessionId) {
      if (!window.haoDesktop || snapshot.savePending) throw new Error("剪輯台正在儲存；稍後再載入 Agent 版本");
      if (snapshot.contentOwner !== working.contentOwner && (!allowConflictReplace || !window.confirm(
        "Agent 執行期間，你也修改了剪輯台。載入 Agent 版本後，可按『復原』回到目前剪輯。確定載入 Agent 版本？",
      ))) throw new Error("保留目前剪輯台；Agent 工作副本仍在磁碟上");
      const opened = await window.haoDesktop.reloadProjectFromPath(agentPath);
      const current = projectSession.getSnapshot();
      if (!opened.project || opened.project.id !== working.projectId || current.sessionId !== snapshot.sessionId
        || current.contentOwner !== snapshot.contentOwner) throw new Error("載入期間專案狀態已改變；未覆蓋目前時間軸");
      projectSession.setHistory((history) => ({ ...history, past: [...history.past.slice(-99), history.present],
        present: opened.project!, future: [] }));
      working.revision = opened.project.revision;
      working.contentOwner = projectSession.getSnapshot().contentOwner;
      setRuntimeUrls(opened.runtimeUrls ?? {});
      setSelectedClipId((selected) => opened.project!.tracks.some((track) => track.clips.some((clip) => clip.id === selected))
        ? selected : opened.project!.tracks.flatMap((track) => track.clips)[0]?.id);
      setStatus("Agent 的剪輯已載入時間軸；請審片，滿意後儲存正式專案。");
      return;
    }
    if (!snapshot.projectPath || snapshot.dirty || snapshot.savePending || !window.haoDesktop) throw new Error("請先儲存目前專案，才能重新載入 Agent 的磁碟變更");
    const opened = await window.haoDesktop.reloadProjectFromPath(snapshot.projectPath);
    if (projectSession.getSnapshot() !== snapshot) throw new Error("載入期間專案狀態已改變；未覆蓋目前時間軸");
    loadOpenedProject(opened);
  };
  const batchAutoEdit = useBatchAutoEdit({ api: window.haoDesktop, projectSession, onOpenProject: loadOpenedProject, onStatus: setStatus });
  useAutomaticUpdates(window.haoDesktop?.checkForUpdates, setStatus);
  const desktopActions = useDesktopActions(window.haoDesktop, setStatus);
  const runCommand = (command: EditorCommand, successMessage?: string) => {
    const recordId = makeId("cmd");
    const result = dispatchCommandSafely(projectSession.getSnapshot().history, command, recordId, {
      currentAestheticArtifact: (candidate) => projectSession.isCurrentSession(sessionId) ? aestheticOutputOwner.get(candidate) : undefined,
    });
    setHistory(result.state);
    setStatus(result.error ?? successMessage ?? "操作完成。");
    return !result.error;
  };
  const automatic = useAutomaticEditing({
    api: window.haoDesktop,
    projectSession,
    project,
    selectedClip,
    onCommand: runCommand,
    onStatus: setStatus,
    onRuntimeUrls: (urls) => setRuntimeUrls((current) => ({ ...current, ...urls })),
  });
  const updateAnimatedClipProperty = (property: "transform" | "color", patch: Record<string, number>) => {
    if (!selectedClip) return;
    const inside = playhead >= selectedClip.timelineStart && playhead <= selectedClip.timelineStart + selectedClip.duration;
    if (!inside || selectedClip.keyframes.length === 0) {
      if (property === "transform") runCommand({ type: "update_clip_transform", clipId: selectedClip.id, patch }, "已更新 Transform。");
      else runCommand({ type: "set_clip_color", clipId: selectedClip.id, patch }, "已更新調色。");
      return;
    }
    const time = Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.timelineStart));
    const tolerance = 0.5 / project.fps;
    const existing = selectedClip.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= tolerance);
    const animated = animatedClipState(selectedClip, time);
    const transform = property === "transform" ? { ...animated.transform, ...patch } : animated.transform;
    const color = property === "color" ? { ...animated.color, ...patch } : animated.color;
    if (existing) {
      runCommand({ type: "update_keyframe", clipId: selectedClip.id, keyframeId: existing.id, patch: { transform, color } }, "已更新目前時間的動畫關鍵幀。");
    } else {
      runCommand({ type: "add_keyframe", clipId: selectedClip.id, keyframe: { id: makeId("keyframe"), time, transform, color, easing: "linear" } }, "已自動在目前時間建立關鍵幀。");
    }
  };
  const splitSelected = () => {
    if (!selectedClip) return setStatus("請先選取要分割的片段");
    runCommand({
      type: "split_clip",
      clipId: selectedClip.id,
      at: playhead,
      newClipId: makeId("clip"),
    }, `已在 ${playhead.toFixed(2)} 秒分割。`);
  };
  const deleteSelected = () => {
    if (selectedCaption) {
      runCommand({ type: "delete_caption", captionId: selectedCaption.id }, "已刪除選取字幕，可隨時復原。");
      setSelectedCaptionId(undefined);
      return;
    }
    if (!selectedClip) return;
    runCommand({ type: "ripple_delete_clip", clipId: selectedClip.id }, "已刪除片段並自動補上空隙；復原一次即可完整還原。");
    setSelectedClipId(undefined);
  };
  const addCaption = () => {
    const captionId = makeId("caption");
    runCommand({
      type: "add_caption",
      caption: { id: captionId, text: "輸入字幕內容", start: playhead, duration: 3 },
    }, `已在 ${playhead.toFixed(2)} 秒加入字幕。`);
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
  const addAssetToTimeline = (assetId: string, mode: "timeline" | "pip" = "timeline", placement?: { trackId: string; timelineStart: number }) => {
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) return setStatus("找不到要加入的素材。");
    if (mode === "pip" && asset.kind === "audio") return setStatus("畫中畫需要影片或圖片素材。");
    const commands: EditorCommand[] = [];
    let trackId: string;
    let timelineStart: number;
    if (mode === "pip") {
      const existing = project.tracks.find((track) => track.kind === "video" && track.name.startsWith("畫中畫"));
      trackId = existing?.id ?? makeId("pip-track");
      if (!existing) commands.push({ type: "add_track", track: { id: trackId, name: `畫中畫 ${project.tracks.filter((track) => track.name.startsWith("畫中畫")).length + 1}`, kind: "video", locked: false, muted: false, clips: [] } });
      timelineStart = alignTime(playhead, project.fps);
    } else {
      const kind = asset.kind === "audio" ? "audio" : "video";
      const target = placement
        ? project.tracks.find((track) => track.id === placement.trackId && track.kind === kind && !track.locked)
        : project.tracks.find((track) => track.kind === kind && !track.locked);
      if (!target) return setStatus("找不到相容的時間軸軌道。");
      trackId = target.id;
      timelineStart = alignTime(placement ? placement.timelineStart : target.clips.reduce((end, clip) => Math.max(end, clip.timelineStart + clip.duration), 0), project.fps);
    }
    const clipId = makeId(mode === "pip" ? "pip-clip" : "clip");
    const available = duration > timelineStart ? duration - timelineStart : Math.max(asset.duration || 3, 1);
    const clipDuration = placement ? timelineAssetDuration(asset, project.fps)
      : Math.max(1 / project.fps, alignTime(asset.kind === "image" ? Math.min(3, available) : Math.min(asset.duration || 3, available), project.fps));
    if (placement) {
      const target = project.tracks.find((track) => track.id === trackId);
      if (target?.clips.some((clip) => timelineStart + clipDuration > clip.timelineStart + 1e-6
        && timelineStart < clip.timelineStart + clip.duration - 1e-6)) {
        return setStatus("目標軌道已有片段；請拖到空白處或另一條相容軌道。");
      }
    }
    commands.push({ type: "add_clip", clip: {
      id: clipId, assetId: asset.id, trackId, timelineStart, sourceStart: 0, duration: clipDuration, volume: 1,
      transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
      layout: mode === "pip" ? structuredClone(DEFAULT_PIP_LAYOUT) : undefined,
      layer: { ...DEFAULT_CLIP_LAYER },
    } });
    runCommand({ type: "batch", commands }, mode === "pip" ? "已加入真正的畫中畫軌道；可拖曳片段並切換角落版型。" : placement ? "已將素材放到指定影格，可復原。" : "已把素材加入時間軸尾端。");
    setSelectedCaptionId(undefined);
    setSelectedClipId(clipId);
    setPlayhead(timelineStart);
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
    const commands: EditorCommand[] = [];
    const currentTrack = project.tracks.find((track) => track.id === selectedClip.trackId);
    let target = currentTrack?.name.startsWith("畫中畫") ? currentTrack : project.tracks.find((track) => track.kind === "video" && track.name.startsWith("畫中畫"));
    if (!target) {
      const trackId = makeId("pip-track");
      target = { id: trackId, name: `畫中畫 ${project.tracks.filter((track) => track.name.startsWith("畫中畫")).length + 1}`, kind: "video", locked: false, muted: false, clips: [] };
      commands.push({ type: "add_track", track: target });
    }
    if (selectedClip.trackId !== target.id) commands.push({ type: "move_clip_to_track", clipId: selectedClip.id, trackId: target.id, timelineStart: selectedClip.timelineStart });
    commands.push(
      { type: "set_clip_layout", clipId: selectedClip.id, layout },
      { type: "set_clip_layer", clipId: selectedClip.id, patch: { enabled: true, blendMode: "normal" } },
    );
    const hasBackground = project.tracks.some((track) => track.kind === "video" && track.id !== selectedClip.trackId && track.clips.some((clip) => clip.timelineStart < selectedClip.timelineStart + selectedClip.duration && clip.timelineStart + clip.duration > selectedClip.timelineStart));
    runCommand({ type: "batch", commands }, `已套用${name}畫中畫${hasBackground ? "" : "；再把底圖或主影片放到主畫面軌即可看到雙層"}。`);
  };
  const applyShortFormTemplate = async (templateId: string) => {
    const task = projectSession.beginTask(project);
    try {
      const { buildShortFormTemplateCommand, SHORT_FORM_TEMPLATES } = await import("./application/shortFormTemplates");
      if (!acceptProjectTask(task, setStatus, "套用短影音模板")) return;
      const template = SHORT_FORM_TEMPLATES.find((item) => item.id === templateId);
      if (!template) throw new Error("找不到短影音模板");
      const command = buildShortFormTemplateCommand(project, templateId, (prefix) => makeId(prefix));
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
  const addImportedMedia = (importedFiles: ImportedBrowserMedia[], options: { backgroundMusic?: boolean } = {}) => {
    if (!importedFiles.length) return;
    // Import is additive: use the live graph, not the render that opened the picker.
    const project = projectSession.getSnapshot().history.present;
    if (options.backgroundMusic && !isStarterDemo(project) && projectDuration(project) > 0) {
      const imported = importedFiles[0];
      const music = buildLoopingMusicPlan(project, imported.asset, () => makeId("music-clip"));
      if (!runCommand({ type: "batch", commands: music.commands }, `已自動鋪滿 ${music.targetDuration.toFixed(1)} 秒配樂，重複處使用 ${music.crossfade.toFixed(1)} 秒 crossfade，旁白會自動 ducking。`)) return;
      setRuntimeUrls((current) => ({ ...current, [imported.asset.id]: imported.runtimeUrl }));
      setSelectedCaptionId(undefined);
      setSelectedClipId(music.lastClipId);
      return;
    }
    const placement = planImportedMediaPlacement(project, importedFiles.map(({ asset }) => asset), () => makeId("clip"));
    if (!runCommand({ type: "batch", commands: placement.commands }, `已匯入 ${importedFiles.length} 份素材${placement.orientationMessage}；畫面與聲音分軌接續。`)) return;
    setRuntimeUrls((current) => Object.fromEntries([
      ...Object.entries(current),
      ...importedFiles.map(({ asset, runtimeUrl }) => [asset.id, runtimeUrl]),
    ]));
    setSelectedCaptionId(undefined);
    setSelectedClipId(placement.lastClipId);
  };
  const importFiles = async (files: File[]) => {
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

      addImportedMedia(importedFiles);
    } catch (error) {
      for (const item of importedFiles) URL.revokeObjectURL(item.runtimeUrl);
      if (task.isSessionCurrent()) setStatus(error instanceof Error ? error.message : "無法匯入素材");
    }
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
    const defaults: Record<MotionGraphicKind, string> = { title: "輸入主標題", card: "輸入重點內容", tag: "追蹤重點", counter: "01" };
    const text = window.prompt(kind === "tag" ? "追蹤標籤要顯示什麼？" : "圖卡要顯示什麼？", seed?.name ?? defaults[kind])?.trim();
    if (!text) return;
    const graphic = createMotionGraphic(makeId("motion"), kind, text, playhead, Math.max(0.5, Math.min(4, duration - playhead || 3)), trackId, seed);
    runCommand({ type: "add_motion_graphic", graphic }, trackId ? "已把標籤綁到追蹤主體，預覽與輸出會同步移動。" : `已加入 ${graphic.schema} 動態圖卡。`);
  };
  const acceptTrackingSelection = async (rect: NormalizedRect) => {
    if (trackingPending.current) return;
    setTrackingSelection(rect);
    if (!trackingMode || !selectedClip) return;
    if (trackingMode.kind === "correct" && trackingMode.trackId) {
      const track = project.motionTracks.find((item) => item.id === trackingMode.trackId);
      if (!track) return setStatus("找不到要修正的追蹤資料。");
      const time = Math.max(0, Math.min(selectedClip.duration, playhead - selectedClip.timelineStart));
      runCommand({ type: "set_motion_track_point", trackId: track.id, point: { frame: Math.round(time * track.analysisFps), time, rect, confidence: 1, status: "manual" } }, "已把目前框選寫成手動修正幀，前後追蹤會接續使用。");
      setTrackingMode(undefined);
      return;
    }
    const asset = project.assets.find((item) => item.id === selectedClip.assetId);
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
      if (!acceptProjectTask(task, setStatus, "動態追蹤")) return;
      const trackId = makeId("motion-track");
      const role = trackingMode.kind === "podcast" ? trackingMode.role : "subject";
      const track: MotionTrack = { id: trackId, clipId: selectedClip.id, name: role === "host" ? "主持人" : role === "guest" ? "來賓" : "追蹤主體", role, engine: result.engine, analysisFps: result.analysisFps, initialRect: rect, points: result.points, lostRatio: result.lostRatio, createdAt: new Date().toISOString() };
      if (trackingMode.kind === "podcast" && trackingMode.role === "host") {
        runCommand({ type: "add_motion_track", track }, `主持人追蹤完成：${Math.round((1 - result.lostRatio) * 100)}% 有效幀。`);
        setTrackingSelection(undefined);
        setTrackingMode({ kind: "podcast", role: "guest", hostTrack: track });
        setStatus("第一位完成。現在請框住來賓的臉；證據不足的區間會保留雙人畫面，不會亂切。");
        return;
      }
      if (trackingMode.kind === "podcast" && trackingMode.role === "guest") {
        const hostTrack = trackingMode.hostTrack;
        if (!hostTrack) throw new Error("主持人追蹤資料遺失，請重新開始雙人物導播");
        setStatus("兩位人物追蹤完成，正在本機辨識語音並建立可編輯導播時間軸…");
        const transcript = await window.haoDesktop.automaticCaptionMedia({
          sourcePath: asset.uri, sourceStart: selectedClip.sourceStart, duration: selectedClip.duration,
          sourceSha256: asset.derivatives?.sourceSha256, language: "auto",
        });
        if (!acceptProjectTask(task, setStatus, "雙人物導播")) return;
        const { buildPodcastDirectorCommand } = await import("./application/podcastDirector");
        if (!acceptProjectTask(task, setStatus, "雙人物導播")) return;
        const built = buildPodcastDirectorCommand({ project, clip: selectedClip, host: hostTrack, guest: track, cues: transcript.cues, idFactory: (kind, index) => `${makeId(kind)}-${index}` });
        if (built.command.type !== "batch") throw new Error("雙人物導播命令格式錯誤");
        runCommand({ type: "batch", commands: [
          { type: "add_motion_track", track },
          { type: "set_caption_style", patch: { presetId: "clean_caption", backgroundColor: "#00000099", color: "#FFFFFF" } },
          ...built.command.commands,
        ] }, `Podcast 導播完成：${built.shots.length} 個可編輯鏡位，${built.uncertainShots} 個不確定區間保留雙人畫面。`);
        setTrackingMode(undefined);
        setTrackingSelection(undefined);
        return;
      }
      const graphic = createMotionGraphic(makeId("motion"), "tag", "追蹤重點", playhead, Math.max(0.5, Math.min(selectedClip.timelineStart + selectedClip.duration - playhead, 4)), trackId);
      runCommand({ type: "batch", commands: [
        { type: "add_motion_track", track },
        { type: "add_motion_graphic", graphic },
      ] }, `追蹤完成：${Math.round((1 - result.lostRatio) * 100)}% 有效幀，已自動綁定標籤${result.cacheHit ? "（快取命中）" : ""}。`);
      setTrackingMode(undefined);
    } catch (error) {
      if (acceptProjectTask(task, setStatus, "動態追蹤")) setStatus(error instanceof Error ? `動態追蹤失敗：${error.message}` : `動態追蹤失敗：${String(error)}`);
    } finally { trackingPending.current = false; setTrackingBusy(false); }
  };
  const startPodcastDirector = () => {
    if (!selectedClip || project.assets.find((asset) => asset.id === selectedClip.assetId)?.kind !== "video") return setStatus("請先在 Timeline 選一段包含兩位人物的影片。");
    setPlaying(false);
    setTrackingSelection(undefined);
    setTrackingMode({ kind: "podcast", role: "host" });
    runCommand({ type: "batch", commands: [
      { type: "set_editorial_profile", profile: "podcast_on_camera" },
      { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem("podcast_on_camera", project.width > project.height ? "longform" : "shorts") },
    ] }, "已進入 Podcast 雙人物導播並套用訪談美感標準。");
    setStatus("請先在預覽畫面框住主持人的臉；放開後會用 Rust 分析位置與局部說話動態。");
  };
  const { newProject, openProject, saveProject } = createAppProjectFileActions({
    api: window.haoDesktop, session: projectSession, loadOpenedProject,
    setRuntimeUrls, setSelectedClipId, setSelectedCaptionId, setPlayhead, setPlaying,
    setTrackingMode, setTrackingSelection, setStatus,
  });
  const submitAgentInstruction = (instruction: string) => submitAppAgentInstruction(instruction, {
    automatic, project, selectedClipId, selectedCaptionId, playhead, runCommand, setHistory, setStatus,
  });
  const mobile = useMobileRemote({ api: window.haoDesktop, snapshot: mobileSnapshot, onInstruction: submitAgentInstruction, onStatus: setStatus });

  const { renderVideo, renderOpenExrSequence, renderAlphaMaster } = createAppRenderActions({
    api: window.haoDesktop, project, setStatus, session: projectSession, renderGate, onRenderBusyChange: setRenderBusy,
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
  const shortcutHandlers = useMemo(() => ({
    save: () => void saveProject(),
    "save-as": () => void saveProject(true),
    undo: undoEdit,
    redo: redoEdit,
    delete: deleteSelected,
    split: splitSelected,
    play: () => { if (duration > 0) { if (!playing && playhead >= duration) setPlayhead(0); setPlaying((current) => !current); } },
    "frame-back": () => setPlayhead((current) => Math.max(0, current - 1 / project.fps)),
    "frame-forward": () => setPlayhead((current) => Math.min(duration, current + 1 / project.fps)),
    "second-back": () => setPlayhead((current) => Math.max(0, current - 1)),
    "second-forward": () => setPlayhead((current) => Math.min(duration, current + 1)),
  }), [duration, playhead, playing, project.fps, projectPath, project, selectedCaption, selectedClip]);
  useEditorShortcuts(recovery.ready ? shortcutHandlers : {});

  if (!recovery.ready) return <main className="app-loading" aria-busy="true" data-shortcuts-blocked="true">正在檢查未儲存的工作…</main>;

  return <Suspense fallback={<main className="app-loading" aria-label="正在載入 Editkin">正在載入 Editkin 剪輯工作區…</main>}><EditorShell currentAestheticArtifact={currentAestheticArtifact} {...{
    history, project, projectPath, projectSavePending: savePending, projectSession, ensureAgentWorkingProject, reloadAgentProject, openCompletedAgentProject, duration, theme, setTheme, isDesktop, playhead, setPlayhead, seekRevision, onPlaybackClock, playing, setPlaying,
    selectedClipId, setSelectedClipId, selectedCaptionId, setSelectedCaptionId, selectedClip,
    selectedClipAtPlayhead, selectedCaption, transitionNeighbors, selectedMotionTracks, activeLayers,
    activeAudioLayers, runtimeUrls, status, setStatus, trackingMode, setTrackingMode, trackingSelection,
    setTrackingSelection, trackingBusy, recovery, desktopActions, automatic, creativeLibrary, batchAutoEdit, mobile,
    newProject, openProject, saveProject, undoEdit, redoEdit, renderVideo, renderBusy, renderOpenExrSequence, renderAlphaMaster, importFiles,
    acceptTrackingSelection, startPodcastDirector, submitAgentInstruction, runCommand, updateAnimatedClipProperty,
    addMotionGraphic, addCaption, addTrack, addAssetToTimeline, makeSelectedPictureInPicture, precomposeSelected, applyShortFormTemplate, applyLongFormTemplate, addLowerThird, clearTemplateApplication, splitSelected, deleteSelected,
  }} /></Suspense>;
}

export default App;

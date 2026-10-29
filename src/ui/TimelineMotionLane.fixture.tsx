/* Local source-UI diagnostic only: owned fixture metadata (no media files), real Timeline, Inspector and template editor
 * wired exactly as the editor shell wires them after patches A and B, with split and delete wired as App.tsx is after the
 * template-follow patch F, and the old-titles notice as useShellSafety shows it. Not installed-product or desktop evidence. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { EditorCommand } from "../domain/commands";
import { projectDuration } from "../domain/editGraph";
import { dispatchCommandSafely, redo, undo } from "../domain/history";
import { decodeProjectBytes } from "../application/projectCodec";
import { createProjectSession, type ProjectSession } from "../application/projectSession";
import { planTimelineClipMove } from "../application/timelinePlacement";
import { buildCaptionTrimCommand, buildClipTrimCommand } from "../application/timelineTrim";
import { createClipSourceEditActions } from "../application/clipSourceEditActions";
import { createAttachedClipMoveActions } from "../application/attachedClipMoveActions";
import { createTemplateFollowEditActions } from "../application/templateFollowEditActions";
import { prepareReferenceMotionTemplateRevision } from "../application/referenceMotionTemplateInstances";
import { makeId } from "../lib/format";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import MotionOverlay from "./MotionOverlay";
import { openTemplateEditorFromStageClick } from "./templateEditorRequests";
import { OperationStatus } from "./OperationStatus";
import { SavedReferenceMotionInstances, runReferenceMotionUiPreparation } from "./SavedReferenceMotionInstances";
import { useTemplateUpdateNotice } from "./TemplateUpdateNotice";
import { initialAutoRotoRuntimeStatus } from "./autoRotoRuntimeStatus";
import "../styles.css";

const INSPECTOR_CALLBACKS = ["onMove", "onTrackChange", "onVolumeChange", "onTrimStart", "onTrimEnd", "onTransformChange", "onScene25dToggle", "onScene25dChange",
  "onTransform3dChange", "onParticleSimulationToggle", "onParticleSimulationChange", "onLayerChange", "onExpressionChange", "onMediaFrameApply", "onColorChange",
  "onCreativeChange", "onNativeEffectAdd", "onNativeEffectUpdate", "onNativeEffectReorder", "onNativeEffectRemove", "onAddKeyframe", "onKeyframeEasingChange",
  "onDeleteKeyframe", "onBeginMotionTrack", "onCorrectMotionTrack", "onDeleteMotionTrack", "onAddMotionGraphic", "onUpdateMotionGraphic", "onDeleteMotionGraphic",
  "onCaptionChange", "onCaptionStyleChange", "onCaptionStylePatch", "onOpenColorWorkspace", "onAddCaption", "onMakePictureInPicture", "onAddMask", "onUpdateMask",
  "onDeleteMask", "onBindMaskTrack", "onSetMaskKeyframe", "onFreezeMask", "onAutoRotoMask", "onQuickAutoRoto", "onChromaKeyChange"] as const;

function Fixture({ session }: { session: ProjectSession }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const project = snapshot.history.present;
  const [status, setStatus] = useState("已載入診斷專案（只有素材名稱，沒有真正的影片檔）。");
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState(false);
  // Diagnostic hook for the capture script: put the playhead where a title is on screen.
  useEffect(() => { (window as unknown as { __motionLaneSeek?: (time: number) => void }).__motionLaneSeek = setPlayhead; }, []);
  const runCommand = (command: EditorCommand, message?: string) => {
    const result = dispatchCommandSafely(session.getSnapshot().history, command, makeId("cmd"));
    session.setHistory(() => result.state);
    setStatus(result.error ?? message ?? "操作完成。");
    return !result.error;
  };
  const sourceEdits = useMemo(() => createClipSourceEditActions({ getProject: () => session.getSnapshot().history.present, runCommand, setStatus }), [session]);
  // The editor shell's ordinary move, and Inspector moves through the attached-move actions (patch B).
  const plainMove = (clipId: string, start?: number, trackId?: string) => {
    const current = session.getSnapshot().history.present, clip = current.tracks.flatMap(track => track.clips).find(item => item.id === clipId);
    if (!clip) return false;
    try { const plan = planTimelineClipMove(current, clipId, trackId ?? clip.trackId, start ?? clip.timelineStart, makeId); return runCommand(plan.command, "已移到指定影格，可復原。"); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); return false; }
  };
  const attachedMoves = useMemo(() => createAttachedClipMoveActions({ getProject: () => session.getSnapshot().history.present, runCommand, setStatus, makeId, plainMove }), [session]);
  // Split and delete as App.tsx wires them after patch F: a title template the gesture changes follows it, one Undo.
  const templateEdits = useMemo(() => createTemplateFollowEditActions({ getProject: () => session.getSnapshot().history.present, runCommand, setStatus }), [session]);
  // The old-titles notice as the editor shell shows it (useShellSafety's workspace notices); it also runs the update.
  const titleUpdate = useTemplateUpdateNotice({ session, enabled: true, runCommand, setStatus });
  const clips = project.tracks.flatMap(track => track.clips);
  const selectedClip = clips.find(clip => clip.id === selectedClipId);
  const noop = () => {};
  const inspectorProps = { ...Object.fromEntries(INSPECTOR_CALLBACKS.map(name => [name, noop])),
    onMove: (start: number) => selectedClip ? attachedMoves.move(selectedClip.id, start) : undefined,
    onTrackChange: (trackId: string) => selectedClip ? attachedMoves.move(selectedClip.id, undefined, trackId) : undefined,
    onSlipClip: (sourceStart: number) => selectedClip ? sourceEdits.slipClip(selectedClip.id, sourceStart) : false,
    projectFps: project.fps, playhead, clip: selectedClip,
    asset: project.assets.find(asset => asset.id === selectedClip?.assetId), captionStyle: project.captionStyle, tracks: project.tracks, canTransitionIn: false,
    canTransitionOut: false, motionTracks: [], trackingBusy: false, trackingSelectionActive: false, motionGraphics: project.motionGraphics,
    managedMotionGraphicIds: [...(project.referenceMotionInstances?.flatMap(instance => instance.roles.filter(role => role.kind === "graphic").map(role => role.id)) ?? [])],
    autoRotoBusy: false, autoRotoRuntimeStatus: initialAutoRotoRuntimeStatus(undefined), sourceTimingProject: project, sceneAssets: project.assets,
    portraitCanvas: true } as unknown as Parameters<typeof Inspector>[0];
  const duration = projectDuration(project);
  return <main data-testid="motion-lane-fixture" style={{ display: "grid", gridTemplateRows: "auto auto minmax(0,1fr) 330px auto", height: "100vh", background: "var(--bg)" }}>
    <header style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
      <strong>Motion lane · local diagnostic</strong>
      <button type="button" data-testid="fixture-undo" onClick={() => { session.setHistory(undo); setStatus("已復原一步。"); }}>Undo</button>
      <button type="button" data-testid="fixture-redo" onClick={() => { session.setHistory(redo); setStatus("已重做一步。"); }}>Redo</button>
      <output data-testid="fixture-history">{snapshot.history.past.length} undo steps</output>
    </header>
    <div className="workspace-notices" data-testid="fixture-notices">{titleUpdate.notice}</div>
    <section style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", minHeight: 0 }}>
      {/* Not the product Preview: the real MotionOverlay in a stage with the preview click wiring of patch P. */}
      <div style={{ display: "grid", placeItems: "center", minHeight: 0, padding: 12 }}>
        <div className="preview-stage" data-testid="fixture-stage" style={{ position: "relative", height: "100%", maxHeight: "100%", aspectRatio: `${project.width} / ${project.height}`,
          containerType: "size", background: "#1d2730", overflow: "hidden" }}
          onClick={event => { openTemplateEditorFromStageClick(event, project, playhead); }}>
          <MotionOverlay project={project} playhead={playhead} trackingSelectionEnabled={false} />
        </div>
      </div>
      <div style={{ minHeight: 0, overflow: "auto", borderLeft: "1px solid var(--line)" }}><Inspector {...inspectorProps} /></div>
    </section>
    <div style={{ minHeight: 0, display: "grid" }}><Timeline project={project} duration={duration} playhead={playhead} selectedClipId={selectedClipId} selectedCaptionId={selectedCaptionId}
      runtimeUrls={{}} onSeek={time => setPlayhead(Math.max(0, Math.min(duration, time)))} onSelect={clipId => { setSelectedCaptionId(undefined); setSelectedClipId(clipId); }}
      onSelectCaption={captionId => { setSelectedClipId(undefined); setSelectedCaptionId(captionId); }}
      onMoveClip={(clipId, start, trackId) => { try { const plan = planTimelineClipMove(project, clipId, trackId, start, makeId); return runCommand(plan.command, "已移到指定影格，可復原。"); } catch (error) { setStatus(String(error)); return false; } }}
      onExtendClip={sourceEdits.extendClip} onSlipClip={sourceEdits.slipClip} onEditRefused={setStatus} onCommand={runCommand}
      onMoveCaption={(captionId, start) => runCommand({ type: "update_caption", captionId, patch: { start } }, "已移動字幕，可復原。")}
      onTrimClip={(clipId, edge, seconds) => { const clip = clips.find(item => item.id === clipId); if (clip) runCommand(buildClipTrimCommand(clip, edge, seconds), "已拖曳修剪，一次復原即可還原。"); }}
      onTrimCaption={(captionId, edge, seconds) => { const caption = project.captions.find(item => item.id === captionId); if (caption) runCommand(buildCaptionTrimCommand(caption, edge, seconds, project.fps)); }}
      onAddCaption={noop} onEditSelection={noop} onAddTrack={noop} onRenameTrack={noop} onToggleTrackLock={trackId => runCommand({ type: "toggle_track_lock", trackId })}
      onDeleteTrack={noop} onMakePictureInPicture={noop} onPrecompose={noop} onToggleMute={noop}
      onSplit={() => { if (selectedClip) void templateEdits.split(selectedClip.id, playhead, makeId("clip")); }}
      onDelete={() => { if (selectedClip) { void templateEdits.rippleDelete(selectedClip.id); setSelectedClipId(undefined); } }} /></div>
    <footer className="status-bar" style={{ position: "relative" }}>
      <SavedReferenceMotionInstances project={project} session={session} busy={busy} onCancel={noop}
        onRevise={(id, patch, expectedInstanceRevision) => {
          setBusy(true);
          void runReferenceMotionUiPreparation({ project, session, controller: new AbortController(), action: "Motion 模板準備", isMounted: () => true,
            onStatus: setStatus, onCommand: runCommand,
            prepare: (prepareText, signal) => prepareReferenceMotionTemplateRevision(project, id, patch, { expectedInstanceRevision, prepareText, signal, idFactory: makeId }),
          }).finally(() => setBusy(false));
        }}
        onDetach={(id, expectedInstanceRevision) => runCommand({ type: "remove_reference_motion_instance", id, expectedInstanceRevision }, "已解除模板連結並保留全部圖層，可一次復原。")} />
      <OperationStatus status={status} runtimeInfo="local diagnostic" />
    </footer>
  </main>;
}

void (async () => {
  // The same motion-font bootstrap and saved interface language as the app entry, so the overlay can draw the titles.
  await (await import("../typography/motionFontDelivery")).bootstrapMotionFontCss(window, () => import("../generated/fontFaces.css"));
  await (await import("./i18n/interfacePreferences")).interfacePreferences.initialize();
  // ?project=<url> opens another saved project (relative to this page), e.g. one made by an older Editkin.
  const response = await fetch(new URL(new URLSearchParams(window.location.search).get("project") ?? "fixture-project.json", window.location.href));
  const project = decodeProjectBytes(new Uint8Array(await response.arrayBuffer()));
  createRoot(document.getElementById("root")!).render(<Fixture session={createProjectSession(project)} />);
})();

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ProjectSession } from "../application/projectSession";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject, TimelineClip, TimelineTrack } from "../domain/types";
import { makeId } from "../lib/format";
import { translateUi as uiText, useI18n } from "./i18n/interfacePreferences";
import { MotionLibraryIcon } from "./MotionLibraryIcons";
import { createMotionLibraryControllerV1, type MotionLibraryKeyboardActionsV1 } from "./motionLibraryControllerV1";
import { resolveMotionLibraryRenderHostV1 } from "./motionLibraryRenderHostV1";
import { browserPreferenceStorageV1, createMotionLibraryUiStoreV1 } from "./motionLibraryUiStoreV1";
import { TimelineCutPointsV1 } from "./TimelineCutPointsV1";
import "./motionLibraryTimeline.css";

const MotionLibraryPanel = lazy(() => import("./MotionLibraryPanel"));
const MotionLibraryInspector = lazy(() => import("./MotionLibraryInspector"));

/**
 * Everything the editor shell needs for the Motion Library GUI, so the shell only passes values through:
 * the 動態 tab's panel, the simple-mode 「動態素材」 entry, the inspector section for a selected motion clip or transition,
 * the cut-point overlay per video track, and the keys (Ctrl+T, Delete of a selected transition) for the editor's key owner.
 * The panel and the inspector load on first use (the catalog and the generators are a separate chunk).
 */
export interface MotionLibraryWiringInputV1 {
  readonly project: EditProject;
  readonly projectSession: ProjectSession;
  readonly runCommand: (command: EditorCommand, successMessage?: string) => boolean | void;
  readonly setStatus: (message: string) => void;
  readonly playhead: number;
  readonly selectedClipId?: string;
  readonly selectedClip?: TimelineClip;
  readonly selectClip: (clipId: string) => void;
  readonly clearSelection: () => void;
  readonly revealSelection: () => void;
  readonly mergeRuntimeUrls?: (urls: Record<string, string>) => void;
  readonly pause: () => void;
  readonly keyboard?: { current: MotionLibraryKeyboardActionsV1 | undefined };
  /** The panel was asked to show itself (narrow windows switch to the media pane). */
  readonly onPanelRequest?: () => void;
}

export function useMotionLibraryWiringV1(input: MotionLibraryWiringInputV1) {
  if (import.meta.env?.DEV) { const counter = globalThis as { __editkinShellRenders?: number }; counter.__editkinShellRenders = (counter.__editkinShellRenders ?? 0) + 1; }
  const live = useRef(input);
  live.current = input;
  const store = useMemo(() => createMotionLibraryUiStoreV1({ storage: browserPreferenceStorageV1() }), []);
  const controller = useMemo(() => createMotionLibraryControllerV1({
    getProject: () => live.current.projectSession.getSnapshot().history.present,
    runCommand: (command, message) => live.current.runCommand(command, message),
    setStatus: message => live.current.setStatus(message),
    getPlayhead: () => live.current.playhead,
    getSelectedClipId: () => live.current.selectedClipId,
    selectClip: clipId => live.current.selectClip(clipId),
    clearClipSelection: () => live.current.clearSelection(),
    revealSelection: () => live.current.revealSelection(),
    mergeRuntimeUrls: urls => live.current.mergeRuntimeUrls?.(urls),
    pause: () => live.current.pause(),
    store, host: resolveMotionLibraryRenderHostV1, makeId,
    sessionToken: () => live.current.projectSession.getSnapshot().sessionId,
  }), [store]);
  if (input.keyboard) input.keyboard.current = controller.keyboard;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Picking a clip ends a transition selection; a transition that no longer exists is not selected.
  useEffect(() => { if (input.selectedClipId) store.selectTransition(undefined); }, [input.selectedClipId, store]);
  const selectedTransition = state.selectedTransitionId ? input.project.timelineTransitions?.find(transition => transition.id === state.selectedTransitionId) : undefined;
  useEffect(() => { if (state.selectedTransitionId && !selectedTransition) store.selectTransition(undefined); }, [state.selectedTransitionId, selectedTransition, store]);
  useEffect(() => { if (state.panelRequest) live.current.onPanelRequest?.(); }, [state.panelRequest]);
  // Another project: no focused cut, no selection from the old one.
  const sessionId = input.projectSession.getSnapshot().sessionId;
  useEffect(() => { store.setFocusCut(undefined); store.selectTransition(undefined); }, [sessionId, store]);
  useEffect(() => () => controller.cancelAll(), [controller]);

  const canRender = Boolean(resolveMotionLibraryRenderHostV1());
  const loading = <div className="ml-panel-loading" role="status">{uiText("正在載入動態素材庫…")}</div>;
  const panel = <Suspense fallback={loading}><MotionLibraryPanel store={store} controller={controller} project={input.project} canRender={canRender} /></Suspense>;
  const motionClip = input.selectedClip?.motionLibrary ? input.selectedClip : undefined;
  const inspector: ReactNode = selectedTransition
    ? <Suspense fallback={null}><MotionLibraryInspector key={`transition:${selectedTransition.id}`} project={input.project} controller={controller} store={store}
      target={{ kind: "transition", transition: selectedTransition }} canRender={canRender} /></Suspense>
    : motionClip ? <Suspense fallback={null}><MotionLibraryInspector key={`clip:${motionClip.id}`} project={input.project} controller={controller} store={store}
      target={{ kind: "clip", clip: motionClip }} canRender={canRender} /></Suspense> : undefined;
  const project = input.project;
  const renderTrackOverlay = useCallback((track: TimelineTrack, pixelsPerSecond: number) => track.kind === "video"
    ? <TimelineCutPointsV1 project={project} track={track} pixelsPerSecond={pixelsPerSecond} controller={controller} store={store} /> : null, [project, controller, store]);
  const entry = <MotionLibraryEntryV1 onOpen={() => store.openPanel()} />;
  return { panel, entry, inspector, renderTrackOverlay, panelRequest: state.panelRequest, store, controller, transitionSelected: Boolean(selectedTransition) };
}

/** Simple mode's one 「動態素材」 button: opens the 動態 tab. */
export function MotionLibraryEntryV1({ onOpen }: { onOpen: () => void }) {
  useI18n();
  return <button type="button" className="ml-entry" onClick={onOpen} data-testid="motion-library-entry" title={uiText("打開動態素材庫：文字動畫、轉場、背景")}>
    <span className="ml-entry-mark" aria-hidden="true"><MotionLibraryIcon name="motion" size={18} /></span>
    <span><strong>{uiText("動態素材")}</strong><small>{uiText("文字動畫・轉場・背景，共 160 種")}</small></span>
    <b aria-hidden="true">→</b>
  </button>;
}

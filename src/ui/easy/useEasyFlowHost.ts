import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { clearAppProblem } from "../../application/appProblemStore";
import { resolveAestheticSystem } from "../../application/editkinAesthetic";
import { describeProblem, PROBLEM_WHAT, type ProblemCause } from "../../application/plainProblems";
import { openProjectAtPath } from "../../application/projectPathActions";
import { canvasResolutionForAsset } from "../../application/sourceOrientation";
import type { DesktopRenderResult, HaoDesktopApi } from "../../desktop/apiTypes";
import { forgetRecentProject, listRecentProjects, subscribeRecentProjects } from "../../desktop/recentProjects";
import { cancelRenderJob, closeRenderJob, currentRenderJob, failRenderJob, renderJobBusy, runRenderJob, subscribeRenderJob, type RenderJobState } from "../../desktop/renderJobStore";
import type { SemanticAutoEditOutcome } from "../../desktop/useSemanticAutoEdit";
import type { EditorHistory } from "../../domain/history";
import type { EditorialProfileId, MediaAsset } from "../../domain/types";
import type { EditorShellProps } from "../editorShellTypes";
import { translateUi, type InterfaceMode } from "../i18n/interfacePreferences";
import { combineEasyEngines, createRoughCutEasyEngine, createUnavailableEasyEngine, EasyEngineError, type RoughCutBridge } from "./easyEngines";
import type { EasyChooseOutcome, EasyFlowHost } from "./easyFlowHost";
import { createEasyFlowStore, easyFlowOwnsVideo, type EasyFlowStore, type EasyGenre, type EasySaveJob, type EasySaveJobSource, type EasyVideo } from "./easyFlowModel";
import type { EasyRecentProjects } from "./easyRecentProjects";
import { createTemplateShortEasyEngine, templateShortApiOf } from "./templateShortEngine";

/** The rough cut's explicit choice for horizontal footage: long-form subtitles, automatic styling. */
export const ROUGH_CUT_POLICY = Object.freeze({ format: "longform", ownership: "automatic" } as const);
const STARTER_ASSET_ID = "asset-demo";

export function editorialProfileForGenre(genre: EasyGenre): EditorialProfileId {
  return genre === "travel" ? "travel" : genre === "food" ? "food" : genre === "game" ? "gaming" : "auto";
}

export function easyVideoFromAsset(asset: MediaAsset, runtimeUrls: Readonly<Record<string, string>>): EasyVideo {
  return {
    id: asset.id,
    name: asset.name,
    durationSeconds: asset.duration > 0 ? asset.duration : undefined,
    orientation: canvasResolutionForAsset(asset)?.orientation,
    thumbnailUrl: runtimeUrls[`${asset.id}:thumbnail`],
    previewUrl: runtimeUrls[asset.id],
  };
}

/** The saved file is named after the creator's clip, so a second video never overwrites the first by default. */
export function projectNameForVideo(video: EasyVideo): string {
  return video.name.replace(/\.[^./\\]+$/, "").trim() || video.name;
}

/** The saving screen's view of an inline export job (simple mode's 存成影片); undefined for any other job. */
export function easySaveJobView(job: RenderJobState | undefined, canCancel: boolean): EasySaveJob | undefined {
  if (!job || job.presentation !== "inline" || (job.phase !== "choosing" && job.phase !== "running")) return undefined;
  const running = job.phase === "running";
  const progress = running ? job.progress : undefined;
  return {
    ...(progress ? { stage: progress.stage } : {}),
    ...(progress?.parts ? { part: progress.part ?? 1, parts: progress.parts } : {}),
    ...(progress?.fraction !== undefined ? { fraction: progress.fraction } : {}),
    ...(progress?.fraction !== undefined && job.remainingMs !== undefined ? { remainingMs: job.remainingMs } : {}),
    ...(job.runningSinceMs !== undefined ? { runningSinceMs: job.runningSinceMs } : {}),
    cancelRequested: job.cancelRequested,
    canCancel: canCancel && running,
  };
}

/** The export job store as the easy flow's save source (one stable object per store state, for useSyncExternalStore). */
export function createEasySaveJobSource(api: Partial<Pick<HaoDesktopApi, "cancelRenderJob">> | undefined): EasySaveJobSource {
  let seen: RenderJobState | undefined;
  let view: EasySaveJob | undefined;
  const canCancel = Boolean(api?.cancelRenderJob);
  return {
    subscribe: subscribeRenderJob,
    current: () => {
      const job = currentRenderJob();
      if (job !== seen) { seen = job; view = easySaveJobView(job, canCancel); }
      return view;
    },
    cancel: async () => {
      if (currentRenderJob()?.presentation !== "inline" || !api?.cancelRenderJob) return;
      const cancel = api.cancelRenderJob;
      await cancelRenderJob({ cancelRenderJob: id => cancel(id) });
    },
  };
}

/** A rough cut waiting for the render that carries its prepared project. */
export interface PendingRoughCut {
  onStage: (stage: 1 | 2 | 3 | 4) => void;
  resolve: (outcome: SemanticAutoEditOutcome) => void;
  reject: (error: unknown) => void;
}

/** The shell props the easy flow actually uses. */
export type EasyShellProps = Pick<EditorShellProps, "projectSession" | "isDesktop" | "importFiles" | "creativeLibrary" | "runtimeUrls" | "status"
  | "runCommand" | "setSelectedClipId" | "setSelectedCaptionId" | "pausePlayback" | "openProject" | "loadOpenedProject">
  & Partial<Pick<EditorShellProps, "setStatus">>;

export interface EditorShellEasyHostDeps {
  store: EasyFlowStore;
  /** The latest render's props and the shell's open-workspace action. */
  live: () => { props: EasyShellProps; openWorkspace: () => void };
  /** Starts the rough cut once the app has rendered the prepared project (React effect in the shell). */
  launchRoughCut: (pending: PendingRoughCut) => void;
  /** Lets React publish import state before it is read. */
  settle?: () => Promise<void>;
  /** The desktop render (window.haoDesktop.renderProject by default); `jobId` makes it a visible, stoppable job. */
  renderProject?: (project: EditorHistory["present"], options?: { jobId?: string }) => Promise<DesktopRenderResult>;
  /** The desktop API (window.haoDesktop by default); tests pass a double. */
  desktopApi?: Partial<HaoDesktopApi>;
}

/**
 * The editor shell's side of the easy flow, as plain code. Real: the app's import path (desktop chooser or browser
 * input); on desktop the local rough cut for horizontal footage plus the existing render, and Editkin's one-tool
 * template Short (M1) for vertical Shorts when the desktop can run it (otherwise the honest "connecting" screen).
 * Nothing is simulated.
 */
export function createEditorShellEasyHost(deps: EditorShellEasyHostDeps): { host: EasyFlowHost; forgetVideo: () => void } {
  const { store, live } = deps;
  const settle = deps.settle ?? (() => new Promise<void>(resolve => setTimeout(resolve, 80)));
  const api = deps.desktopApi ?? (typeof window === "undefined" ? undefined : window.haoDesktop);
  let baseline: { sessionId: number; history: EditorHistory } | undefined;

  /** Puts the project back exactly as it was before the flow brought its video in. */
  const rollback = () => {
    const base = baseline;
    baseline = undefined;
    if (!base) return;
    const { props } = live();
    if (props.projectSession.getSnapshot().sessionId !== base.sessionId) return;
    props.pausePlayback();
    props.projectSession.setHistory(() => base.history);
  };

  const bridge: RoughCutBridge = {
    start: (brief, onStage) => new Promise<SemanticAutoEditOutcome>((resolve, reject) => {
      const { props } = live();
      const project = props.projectSession.getSnapshot().history.present;
      const clip = project.tracks.flatMap(track => track.clips).find(item => item.assetId === brief.video.id);
      if (!clip) { reject(new EasyEngineError("找不到要剪的影片。")); return; }
      const profile = editorialProfileForGenre(brief.genre);
      // One undoable step: the genre's editing profile and a file name taken from the creator's clip.
      const accepted = props.runCommand({ type: "batch", commands: [
        { type: "set_editorial_profile", profile },
        { type: "set_aesthetic_system", aestheticSystem: resolveAestheticSystem(profile, "longform") },
        { type: "rename_project", name: projectNameForVideo(brief.video) },
      ] }, "已套用影片類型。");
      if (accepted === false) { reject(new EasyEngineError("影片類型沒有套用成功。")); return; }
      props.setSelectedCaptionId(undefined);
      props.setSelectedClipId(clip.id);
      deps.launchRoughCut({ onStage, resolve, reject });
    }),
    // 「好了，存成影片」 runs as the same export job as the editor's 輸出影片 (W2-4): measured progress and remaining time
    // on the saving screen, 「停止存檔」, and the close guard while it runs. Only the export panel stays out of the way.
    render: async () => {
      const render = deps.renderProject ?? (api?.renderProject
        ? (project: EditorHistory["present"], options?: { jobId?: string }) => api.renderProject!(project, options) : undefined);
      if (!render) throw new EasyEngineError("影片輸出需要桌面版。");
      if (renderJobBusy()) throw new EasyEngineError("已經有一支影片正在輸出，請等它做完再存。");
      const project = live().props.projectSession.getSnapshot().history.present;
      const progressOf = api?.renderJobProgress;
      let jobId: string | undefined;
      try {
        const { result } = await runRenderJob({
          api: { renderJobProgress: progressOf ? (id: string) => progressOf(id) : undefined },
          kind: "video", presentation: "inline",
          start: id => { jobId = id; return render(project, { jobId: id }); },
        });
        return result;
      } catch (error) {
        if (jobId) failRenderJob(jobId, describeProblem("export", error));
        throw error;
      } finally {
        // The save screens carry the outcome from here on; the job lived only while the render ran.
        if (jobId && currentRenderJob()?.id === jobId) closeRenderJob();
      }
    },
    ...(api?.revealInFolder ? { reveal: api.revealInFolder } : {}),
  };

  const isDesktop = live().props.isDesktop;
  // The template engine reads the chosen video from the project the flow imported it into (its asset path on this computer).
  const templateApi = isDesktop ? templateShortApiOf(api) : undefined;
  const sourcePathOf = (video: EasyVideo) => live().props.projectSession.getSnapshot().history.present.assets.find(asset => asset.id === video.id)?.uri;
  const engine = isDesktop
    ? combineEasyEngines({ horizontal: createRoughCutEasyEngine(bridge), vertical: templateApi ? createTemplateShortEasyEngine(templateApi, { sourcePathOf }) : undefined })
    : createUnavailableEasyEngine("needs-desktop");

  // Recent projects reopen through the editor's own path (the unsaved-changes question, plain problem words). The
  // plain browser build has no project files to reopen, so it gets no list at all.
  const openPath = api?.openProjectPath;
  const checkPaths = api?.checkMediaPaths;
  const recent: EasyRecentProjects | undefined = isDesktop && openPath ? {
    list: listRecentProjects,
    subscribe: subscribeRecentProjects,
    ...(checkPaths ? { exists: (paths: readonly string[]) => checkPaths([...paths]) } : {}),
    open: async path => {
      const { props, openWorkspace } = live();
      if (!props.loadOpenedProject) return { kind: "kept" };
      // Set by the open path's callbacks (asserted so control flow does not treat them as never assigned).
      let cause = undefined as ProblemCause | undefined;
      let detail = undefined as string | undefined;
      const opened = await openProjectAtPath({
        api: { openProjectPath: openPath }, session: props.projectSession, loadOpenedProject: props.loadOpenedProject,
        setStatus: message => { detail = message; props.setStatus?.(message); }, pausePlayback: props.pausePlayback,
        confirmDiscard: message => typeof window !== "undefined" && window.confirm(translateUi(message)),
        failureActions: found => { cause = found; return []; },
      }, path, "open");
      // An opened project shows the editor, even one that has no clips yet.
      if (opened) { openWorkspace(); return { kind: "opened" }; }
      if (!cause) return { kind: "kept" };
      // The start screen says it on the project's own row; the editor's notice would only repeat it later.
      clearAppProblem("open");
      return cause === "notFound" ? { kind: "missing" } : { kind: "failed", what: PROBLEM_WHAT[cause], ...(detail ? { detail } : {}) };
    },
    forget: forgetRecentProject,
  } : undefined;

  const host: EasyFlowHost = {
    store,
    engine,
    ...(recent ? { recent } : {}),
    ...(isDesktop ? { saveJob: createEasySaveJobSource(api) } : {}),
    picker: isDesktop ? "dialog" : "file-input",
    chooseVideo: async (files): Promise<EasyChooseOutcome> => {
      const { props } = live();
      const before = props.projectSession.getSnapshot();
      const known = new Set(before.history.present.assets.map(asset => asset.id));
      const importBefore = props.creativeLibrary.importState;
      if (files?.length) await props.importFiles([...files]);
      else if (props.isDesktop) await props.creativeLibrary.importDesktopMedia();
      else return { kind: "nothing" };
      const after = props.projectSession.getSnapshot();
      if (after.sessionId !== before.sessionId) return { kind: "nothing" };
      const added = after.history.present.assets.filter(asset => !known.has(asset.id));
      if (!added.length) {
        await settle();
        const now = live().props;
        if (files?.length) return { kind: "failed", detail: now.status };
        const importState = now.creativeLibrary.importState;
        return importState !== importBefore && importState.phase === "failed" ? { kind: "failed", detail: importState.message } : { kind: "nothing" };
      }
      baseline = { sessionId: before.sessionId, history: before.history };
      if (added.length > 1) { rollback(); return { kind: "too-many" }; }
      if (added[0].kind !== "video") { rollback(); return { kind: "not-video" }; }
      return { kind: "video", video: easyVideoFromAsset(added[0], live().props.runtimeUrls) };
    },
    discardVideo: rollback,
    leaveToEditor: () => {
      const { props, openWorkspace } = live();
      // A finished template Short is its own new project: open that one (the creator's open project is never its target).
      const handle = store.getState().result?.handle, open = api?.templateShortOpenProject, load = props.loadOpenedProject;
      if (handle && open && load) {
        void open(handle).then(opened => {
          if (opened.canceled || !opened.project) throw new EasyEngineError("剪好的專案沒有打開。");
          baseline = undefined;
          store.dispatch({ type: "reset" });
          load(opened);
        }).catch((error: unknown) => {
          store.dispatch({ type: "result-problem", problem: { kind: "open-failed", detail: error instanceof Error ? error.message : String(error) } });
        });
        return;
      }
      baseline = undefined;
      store.dispatch({ type: "reset" });
      if (!props.projectSession.getSnapshot().history.present.assets.some(asset => asset.id !== STARTER_ASSET_ID)) openWorkspace();
    },
    openWorkspace: () => live().openWorkspace(),
    openProject: () => { void live().props.openProject(); },
    videoUrls: video => {
      const urls = live().props.runtimeUrls;
      return { thumbnailUrl: urls[`${video.id}:thumbnail`] ?? video.thumbnailUrl, previewUrl: urls[video.id] ?? video.previewUrl };
    },
  };
  return { host, forgetVideo: () => { baseline = undefined; } };
}

export interface EasyFlowHostBinding {
  /** Keep the start screen in front of the editor: the flow owns a video it brought in. */
  holdsStart: boolean;
  host: EasyFlowHost;
}

/**
 * React side, called once by EditorShell (see the patch spec in
 * .rd/benchmarks/usable-v1-20261009/EASY_FLOW_EDITORSHELL_PATCH_20261010.md).
 */
export function useEasyFlowHost(props: EditorShellProps, mode: InterfaceMode, openWorkspace: () => void): EasyFlowHostBinding {
  const [store] = useState(createEasyFlowStore);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const latest = useRef({ props: props as EasyShellProps, openWorkspace, semantic: props.automatic.semantic });
  latest.current = { props, openWorkspace, semantic: props.automatic.semantic };
  const pendingRun = useRef<(PendingRoughCut & { ticket: number; launched: boolean }) | undefined>(undefined);
  const launchCounter = useRef(0);
  const [launchTicket, setLaunchTicket] = useState(0);
  const sessionId = props.projectSession.getSnapshot().sessionId;

  const shell = useMemo(() => createEditorShellEasyHost({
    store,
    live: () => latest.current,
    launchRoughCut: pending => {
      const ticket = ++launchCounter.current;
      pendingRun.current = { ...pending, ticket, launched: false };
      setLaunchTicket(ticket);
    },
  }), [store]);

  // The rough cut reports stages 1–4 through its React state; forward them to the waiting screen.
  const stage = props.automatic.semantic.stage?.step;
  useEffect(() => { if (stage) pendingRun.current?.onStage(stage); }, [stage]);

  // Start only after the render that carries the prepared project, so the run's task binds to it.
  useEffect(() => {
    const pending = pendingRun.current;
    if (!pending || pending.ticket !== launchTicket || pending.launched) return;
    pending.launched = true;
    const settled = () => { if (pendingRun.current === pending) pendingRun.current = undefined; };
    latest.current.semantic.runWithOutcome(ROUGH_CUT_POLICY).then(outcome => { settled(); pending.resolve(outcome); },
      error => { settled(); pending.reject(error); });
  }, [launchTicket]);

  // Opening another project or a recovery restore replaces the session: the flow's video went with it.
  const flowSession = useRef(sessionId);
  useEffect(() => {
    if (flowSession.current === sessionId) return;
    flowSession.current = sessionId;
    shell.forgetVideo();
    pendingRun.current = undefined;
    if (easyFlowOwnsVideo(store.getState())) store.dispatch({ type: "reset" });
  }, [sessionId, shell, store]);

  // The easy flow belongs to simple mode. Switching to advanced keeps the video and shows the editor.
  useEffect(() => {
    if (mode !== "advanced" || !easyFlowOwnsVideo(store.getState())) return;
    shell.forgetVideo();
    pendingRun.current = undefined;
    store.dispatch({ type: "reset" });
  }, [mode, shell, store]);

  return { holdsStart: mode === "simple" && easyFlowOwnsVideo(state), host: shell.host };
}

import { createBrowserClipAudioGainController } from "./browserClipAudioGain";
import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ActivePreviewLayer } from "../application/previewMedia";
import type { EditProject } from "../domain/types";
import type { HaoDesktopApi, NativeAudioPreviewStageReceipt, NativeAudioPreviewStatus, NativeAudioPreviewStartResult } from "./types";
import { playbackFrameIndex, previewPlaybackRate, previewRateIsAudible, startCompatiblePlaybackClock } from "../ui/playbackTiming";
import {useResidentAudioTransport} from "./useResidentAudioTransport";
import { publishPlaybackNotice } from "../ui/playbackNoticeStore";
import type {ResidentAudioStage} from "./residentAudioTypes";

export type NativeAudioPreviewMode = "idle" | "starting" | "native" | "compatible" | "failed";
export interface NativeAudioTransportState {
  mode: NativeAudioPreviewMode;
  generation?: number;
  ownerId?: number;
  projectId: string;
  projectRevision: number;
  projectUpdatedAt: string;
  seekRevision?: number;
}
/** How a rejected play() is recovered: play again first, then reload the media,
 * then rebuild its preview. The same failure never offers the same endless retry. */
export type PlayRecoveryStep = "play" | "reload" | "rebuild";
/** A playback stop the user must see: "play" is a rejected media.play(),
 * "audio" a native audio owner whose stop was never confirmed. */
export interface PreviewPlaybackFailure {
  kind: "play" | "audio";
  /** Raw technical cause, shown folded under 查看原因 only. */
  detail: string;
  step?: PlayRecoveryStep;
  /** Settles when the recovery's outcome is known. */
  retry: () => void | Promise<void>;
}
/** A play failure also records its element and project; it is dropped once either is gone. */
type PlaybackFailureState = Omit<PreviewPlaybackFailure, "retry"> & { media?: HTMLMediaElement; assetId?: string; projectId?: string };

interface NativeAudioPreviewPlaybackOptions {
  api?: HaoDesktopApi;
  project: EditProject;
  layers: ActivePreviewLayer[];
  audioLayers: ActivePreviewLayer[];
  mediaRefs: MutableRefObject<Map<string, HTMLMediaElement>>;
  playhead: number;
  projectDuration: number;
  projectFps: number;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onPlayheadChange: (time: number) => void;
  seekRevision?: number;
  externalVideoClock?: boolean;
  previewEpoch?: number;
  playbackRate?: number;
  /** Rebuilds a video asset's preview; offered after reloading did not help. It
   * settles when done; `onOutcome` says whether a rebuilt preview was committed. */
  onRebuildPreview?: (assetId: string, onOutcome?: (rebuilt: boolean) => void) => Promise<void>;
}

/** Reverse media stays silent/paused; only the latest pending frame seek survives.
 * A rejected play() is reported, except an interrupted one (pause, seek or source
 * change) and an element error, which the element's own error handler owns.
 * Forward speeds outside 0.5×–4× are muted (previewRateIsAudible). */
export function createPreviewMediaSynchronizer(onPlayRejected?: (media: HTMLMediaElement, reason: unknown) => void,
  onPlayStarted?: (media: HTMLMediaElement) => void) {
  const audioGain = createBrowserClipAudioGainController(onPlayRejected);
  const pending = new Map<HTMLMediaElement, { target: number; listener: () => void }>();
  const cancel = (media: HTMLMediaElement) => {
    const job = pending.get(media);
    if (job) media.removeEventListener("seeked", job.listener);
    pending.delete(media);
  };
  return {
    sync(media: HTMLMediaElement, layer: ActivePreviewLayer | undefined, time: number, playing: boolean,
      mode: NativeAudioPreviewMode, rate: number, fps: number): void {
      if (!layer) { cancel(media); audioGain.sync(media, undefined, false, rate); media.pause(); media.muted = true; return; }
      const { clip } = layer;
      const target = clip.sourceStart + Math.max(0, Math.min(clip.duration, time - clip.timelineStart));
      const threshold = playing && rate > 0 ? 0.2 : 0.5 / fps;
      media.volume = Math.max(0, Math.min(1, clip.volume));
      if (rate < 0) {
        audioGain.sync(media, layer, false, rate);
        media.pause(); media.muted = true;
        if (Number.isFinite(target) && (Math.abs(media.currentTime - target) > threshold || pending.has(media))) {
          if (media.seeking) {
            const previous = pending.get(media);
            if (previous) previous.target = target;
            else {
              const job = { target, listener: () => {
                if (pending.get(media) !== job) return;
                cancel(media);
                if (Math.abs(media.currentTime - job.target) > threshold) media.currentTime = job.target;
              } };
              pending.set(media, job); media.addEventListener("seeked", job.listener);
            }
          } else { cancel(media); media.currentTime = target; }
        }
        return;
      }
      cancel(media);
      media.playbackRate = rate;
      if (Number.isFinite(target) && Math.abs(media.currentTime - target) > threshold) media.currentTime = target;
      if (!audioGain.sync(media, layer, playing && mode === "compatible" && clip.volume > 0 && layer.silent !== true && previewRateIsAudible(rate), rate)) return;
      if (!playing || mode === "idle" || mode === "starting" || mode === "failed") { media.pause(); return; }
      media.muted = mode === "native" || clip.volume <= 0 || layer.silent === true || !previewRateIsAudible(rate);
      if ((mode !== "native" || media.tagName === "VIDEO") && media.paused) void media.play().then(() => onPlayStarted?.(media), reason => {
        if ((reason as { name?: unknown } | undefined)?.name !== "AbortError" && !media.error) onPlayRejected?.(media, reason);
      });
    },
    retain(live: ReadonlySet<HTMLMediaElement>) { audioGain.retain(live); for (const media of pending.keys()) if (!live.has(media)) cancel(media); },
    dispose() { audioGain.dispose(); for (const media of pending.keys()) cancel(media); },
  };
}

export function projectMayContainAudio(project: EditProject): boolean {
  return project.tracks.some((track) => (track.kind === "audio" || track.kind === "video")
    && !track.muted
    && track.clips.some((clip) => clip.volume > 0
      && clip.layer?.enabled !== false
      && (clip.layer?.role ?? "content") === "content"
      && project.assets.some((asset) => asset.id === clip.assetId && asset.kind !== "image")));
}

/** The legacy route can stage the project's sound (projectMayContainAudio) as native audio at 1×. */
function legacyNativeAudioAvailable(api: HaoDesktopApi | undefined, hasAudio: boolean): boolean {
  return Boolean(hasAudio && api?.startNativeAudioPreview && (api.nativeAudioPreviewPushEvents || api.nativeAudioPreviewStatus)
    && api.stopNativeAudioPreview);
}

export function nativeAudioStageMatchesProject(stage: NativeAudioPreviewStageReceipt, project: EditProject): boolean {
  return stage.schema === "editkin.native-audio-preview-stage/v2"
    && stage.status === "GREEN"
    && stage.projectId === project.id
    && stage.projectRevision === project.revision
    && stage.projectUpdatedAt === project.updatedAt
    && stage.sampleRate === 48_000
    && stage.channels === 2
    && stage.decoderExecutor === "ffmpeg-source-decode/v1"
    && stage.decodeMode === "independent-source-pcm"
    && stage.mixExecutor === "hao-core-native-dag/v1"
    && stage.nativeGraphExecution === true
    && /^[a-f0-9]{64}$/.test(stage.manifestSha256)
    && stage.manifestBytes > 0
    && stage.sourcePcm.length === stage.clipCount
    && stage.sourcePcm.every((source) => source.bytes > 0 && /^[a-f0-9]{64}$/.test(source.sha256))
    && stage.durationSeconds > 0
    && stage.durationSeconds <= 30.05;
}

export function playheadRequiresTransportSeek(renderedPlayhead: number, transportPlayhead: number, fps: number): boolean {
  if (!Number.isFinite(renderedPlayhead) || !Number.isFinite(transportPlayhead) || !Number.isFinite(fps) || fps <= 0) return false;
  return Math.abs(renderedPlayhead - transportPlayhead) > 0.75 / fps;
}

export function useNativeAudioPreviewPlayback({
  api,
  project,
  layers,
  audioLayers,
  mediaRefs,
  playhead,
  projectDuration,
  projectFps,
  playing,
  onPlayingChange,
  onPlayheadChange,
  seekRevision: explicitSeekRevision,
  externalVideoClock = false,
  previewEpoch = 0,
  playbackRate: requestedRate = 1,
  onRebuildPreview,
}: NativeAudioPreviewPlaybackOptions): {
  mode: NativeAudioPreviewMode;
  error?: string;
  stage?: NativeAudioPreviewStageReceipt | ResidentAudioStage;
  generation?: number;
  ownerId?: number;
  transportSeekRevision?: number;
  failure?: PreviewPlaybackFailure;
} {
  const playbackRate = previewPlaybackRate(requestedRate);
  const [legacyMode, setMode] = useState<NativeAudioPreviewMode>("idle");
  const confirmedLegacyEpoch = useRef(previewEpoch);
  const [error, setError] = useState<string>();
  const [stage, setStage] = useState<NativeAudioPreviewStageReceipt>();
  const [generation, setGeneration] = useState<number>();
  const [transportSeekRevision, setTransportSeekRevision] = useState<number>();
  const [seekRevision, setSeekRevision] = useState(0);
  const implicitRateRevisionRef = useRef(0);
  const previousRateRef = useRef(playbackRate);
  if (previousRateRef.current !== playbackRate) {
    if (explicitSeekRevision === undefined) implicitRateRevisionRef.current += 1;
    previousRateRef.current = playbackRate;
  }
  const transportRevision = explicitSeekRevision ?? seekRevision + implicitRateRevisionRef.current;
  const transportRevisionRef = useRef(transportRevision);
  transportRevisionRef.current = transportRevision;
  const [rateRetirement, setRateRetirement] = useState<{ rate: number; seek?: number; ready: boolean; error?: string }>({ rate: 1, ready: true });
  const retirementRef = useRef<Promise<void>>(Promise.resolve());
  // Sticky until retried: the effect that hit it re-runs as soon as playback pauses.
  const [failure, setFailure] = useState<PlaybackFailureState>();
  // The latest failure: a late recovery acts only while the one it was offered for is current.
  const failureRef = useRef(failure);
  failureRef.current = failure;
  const unconfirmedStopsRef = useRef(new Set<number>());
  const playRejectedRef = useRef<(media: HTMLMediaElement, reason: unknown) => void>(() => undefined);
  // The recovery last offered per media element; cleared once that element plays.
  const playStepsRef = useRef(new WeakMap<HTMLMediaElement, PlayRecoveryStep>());
  // The project whose playback an audio failure paused, so a confirmed retry resumes
  // it there and never starts playback in another project.
  const pausedByFailureRef = useRef<string | undefined>(undefined);
  const onRebuildPreviewRef = useRef(onRebuildPreview);
  onRebuildPreviewRef.current = onRebuildPreview;
  const mediaSynchronizerRef = useRef<ReturnType<typeof createPreviewMediaSynchronizer> | undefined>(undefined);
  mediaSynchronizerRef.current ??= createPreviewMediaSynchronizer((media, reason) => playRejectedRef.current(media, reason),
    media => { playStepsRef.current.delete(media); });
  const sequenceRef = useRef(0);
  const playingRef = useRef(playing);
  const playheadRef = useRef(playhead);
  const projectRef = useRef(project);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  const explicitSeekRef = useRef(explicitSeekRevision);
  const externalVideoClockRef = useRef(externalVideoClock);
  const playbackRateRef = useRef(playbackRate);
  // The retained transport's effect runs before the legacy seek effect below.
  // Synchronize the explicit user position now so a new seek revision never
  // stages the previous render's playhead (e.g. seek to 3 s but stage 0 s).
  if(explicitSeekRevision!==undefined || playbackRateRef.current!==playbackRate)playheadRef.current=playhead;
  playbackRateRef.current = playbackRate;
  explicitSeekRef.current = explicitSeekRevision;
  externalVideoClockRef.current = playbackRate === 1 && externalVideoClock;
  playingRef.current = playing;
  projectRef.current = project;
  onPlayingChangeRef.current = onPlayingChange;
  onPlayheadChangeRef.current = onPlayheadChange;

  const hasAudio = projectMayContainAudio(project);
  const resident=useResidentAudioTransport({api:api?.residentAudio,project,playing:playing&&playbackRate===1,hasAudio,
    seekRevision:transportRevision,previewEpoch,playhead:playheadRef,onClock:(time,ended)=>{
      if(playbackRateRef.current!==1 || !playingRef.current)return;
      playheadRef.current=time;
      if(!externalVideoClockRef.current)onPlayheadChangeRef.current(time);
      if(ended)onPlayingChangeRef.current(false);
    }});
  const nativeMode:NativeAudioPreviewMode=resident.route==="legacy"?(legacyMode==="native"&&confirmedLegacyEpoch.current!==previewEpoch?"starting":legacyMode):resident.route==="checking"?(playing?"starting":"idle")
    :resident.view.mode==="preparing"?"starting":resident.view.mode==="closed"?"idle":resident.view.mode;
  const residentPaused = resident.route === "resident" && (resident.view.mode === "compatible"
    || (resident.view.playing === false && resident.view.mode !== "preparing")
    || (resident.view.ownerId === undefined && resident.view.mode === "idle"));
  const rateReady = resident.route === "resident" ? residentPaused
    : rateRetirement.rate === playbackRate && rateRetirement.seek === explicitSeekRevision && rateRetirement.ready;
  const mode: NativeAudioPreviewMode = playbackRate === 1 ? nativeMode : !playing ? "idle"
    : resident.view.mode === "failed" || rateRetirement.error ? "failed" : rateReady ? "compatible" : "starting";

  const pauseAllMedia = () => mediaRefs.current.forEach((media) => media.pause());
  playRejectedRef.current = (media, reason) => {
    // A rejected play() must not leave the compatible clock advancing silently.
    if (!playingRef.current) return;
    playingRef.current = false;
    pauseAllMedia();
    // Play again first; an unsupported source or a repeat goes to reload, then
    // to rebuilding a video's preview, instead of offering the same retry forever.
    const clipId = [...mediaRefs.current].find(([, item]) => item === media)?.[0];
    const layer = [...layers, ...audioLayers].find(item => item.clip.id === clipId);
    const previous = playStepsRef.current.get(media);
    const canRebuild = Boolean(onRebuildPreviewRef.current && layer?.asset.kind === "video");
    const unsupported = (reason as { name?: unknown } | undefined)?.name === "NotSupportedError";
    const step: PlayRecoveryStep = previous === undefined ? unsupported ? "reload" : "play"
      : previous === "play" ? "reload" : canRebuild ? "rebuild" : "reload";
    playStepsRef.current.set(media, step);
    const message = reason instanceof Error && reason.message ? reason.message : "播放器拒絕播放這段預覽";
    setFailure({ kind: "play", step, media, assetId: layer?.asset.id, projectId: projectRef.current.id,
      detail: layer ? `${layer.asset.name}：${message}` : message });
    onPlayingChangeRef.current(false);
  };
  const residentFailed = resident.route === "resident" && resident.view.mode === "failed";
  const pauseForFailure = () => {
    if (playingRef.current) pausedByFailureRef.current = projectRef.current.id;
    pauseAllMedia(); onPlayingChangeRef.current(false);
  };
  const resumeAfterRecovery = () => {
    const pausedProject = pausedByFailureRef.current;
    pausedByFailureRef.current = undefined;
    if (pausedProject !== undefined && pausedProject === projectRef.current.id) onPlayingChangeRef.current(true);
  };
  const audioFailure = failure?.kind === "audio";
  useEffect(() => {
    if (!playing) return;
    // A new play request supersedes an old rejected play(). A failed native owner, or
    // a native stop that was never confirmed, could sound over new playback, so either
    // pauses again until the user retries it, as its notice says.
    setFailure(current => current?.kind === "play" ? undefined : current);
    if (residentFailed || audioFailure) pauseForFailure();
    // Playback that actually starts belongs to the user again: a later recovery must
    // not resume over a pause they then choose.
    else pausedByFailureRef.current = undefined;
  }, [playing, residentFailed, audioFailure]);
  // Reloads media elements; true when every one decoded data again.
  const reloadMedia = (items: readonly HTMLMediaElement[]) => Promise.all(items.map(media => new Promise<boolean>(resolve => {
    let timer = 0;
    const settle = (loaded: boolean) => {
      window.clearTimeout(timer);
      media.removeEventListener("loadeddata", onLoaded); media.removeEventListener("error", onError);
      resolve(loaded);
    };
    const onLoaded = () => settle(true), onError = () => settle(false);
    media.addEventListener("loadeddata", onLoaded); media.addEventListener("error", onError);
    timer = window.setTimeout(onError, 10_000);
    media.load();
  }))).then(results => results.every(Boolean));
  // A recovery acts only on the failure it was offered for. A newer play request,
  // another project or a removed clip retires that failure; a late result then
  // neither clears a newer notice nor resumes playback after the user moved on.
  const retryPlay = (clicked: PlaybackFailureState): void | Promise<void> => {
    const clear = () => setFailure(current => current === clicked ? undefined : current);
    const rebuild = onRebuildPreviewRef.current;
    if (clicked.step === "rebuild" && clicked.assetId && rebuild) {
      // Only a committed rebuilt preview clears the notice. A failed, skipped or stale
      // rebuild still settles, but keeps the notice, whose line then says it still fails.
      let rebuilt = false;
      return rebuild(clicked.assetId, outcome => { rebuilt = outcome; }).then(() => { if (rebuilt) clear(); });
    }
    if (clicked.step === "reload" && clicked.media) return reloadMedia([clicked.media]).then(loaded => {
      // Not decoded again (an element error, or no data within 10 s) keeps the notice:
      // not every element shows a load error of its own.
      if (!loaded || failureRef.current !== clicked) return;
      clear(); onPlayingChangeRef.current(true);
    });
    clear(); onPlayingChangeRef.current(true);
  };
  const retryUnconfirmedStops = (clicked: PlaybackFailureState): Promise<void> => {
    // Retry the exact unconfirmed generations after in-flight stops settle;
    // only confirmed stops re-admit variable-speed playback.
    const retried = retirementRef.current.catch(() => undefined).then(() => Promise.all([...unconfirmedStopsRef.current].map(generation => {
      if (!api?.stopNativeAudioPreview) throw new Error("原生音訊停止介面不存在");
      return api.stopNativeAudioPreview(generation).then(result => {
        if (result.active && !result.superseded) throw new Error("原生音訊停止尚未確認；變速播放已阻擋");
        unconfirmedStopsRef.current.delete(generation);
      });
    }))).then(() => undefined);
    retirementRef.current = retried;
    return retried.then(() => {
      setRateRetirement({ rate: 1, ready: true }); setError(undefined);
      const stillCurrent = failureRef.current === clicked;
      setFailure(current => current === clicked ? undefined : current);
      if (stillCurrent) resumeAfterRecovery();
    }, reason => setFailure(current => current === clicked
      ? { kind: "audio", detail: reason instanceof Error ? reason.message : "原生音訊停止尚未確認；變速播放已阻擋" } : current));
  };

  const beginCompatiblePlayback = (origin: number, reason?: string) => {
    const sequence = sequenceRef.current;
    playheadRef.current = origin;
    setMode(reason ? "failed" : "compatible");
    setError(reason);
    setGeneration(undefined);
    window.queueMicrotask(() => {
      if (!playingRef.current || sequenceRef.current !== sequence) return;
      setMode("compatible");
    });
  };

  useEffect(() => {
    if (explicitSeekRevision !== undefined) { playheadRef.current = playhead; return; }
    if (!playheadRequiresTransportSeek(playhead, playheadRef.current, projectFps)) return;
    playheadRef.current = playhead;
    if (playing) setSeekRevision((revision) => revision + 1);
  }, [playhead, playing, projectFps, explicitSeekRevision]);

  useEffect(() => {
    const allLayers = [...layers, ...audioLayers];
    const layerByClip = new Map(allLayers.map((layer) => [layer.clip.id, layer]));
    mediaSynchronizerRef.current!.retain(new Set(mediaRefs.current.values()));
    for (const [clipId, media] of mediaRefs.current) {
      const layer = layerByClip.get(clipId);
      mediaSynchronizerRef.current!.sync(media, layer, playhead, playing, mode, playbackRate, projectFps);
    }
  }, [audioLayers, layers, mediaRefs, mode, playhead, playing, playbackRate, projectFps]);

  useEffect(() => {
    if (!playing || mode !== "compatible" || (playbackRate === 1 && externalVideoClock)) return;
    return startCompatiblePlaybackClock({ origin: playheadRef.current, duration: projectDuration, fps: projectFps, playbackRate,
      now: () => performance.now(), requestFrame: callback => window.requestAnimationFrame(callback), cancelFrame: handle => window.cancelAnimationFrame(handle),
      isCurrent: () => playingRef.current && playbackRateRef.current === playbackRate && explicitSeekRef.current === explicitSeekRevision
        && transportRevisionRef.current === transportRevision,
      onTime: next => { playheadRef.current = next; onPlayheadChangeRef.current(next); },
      onEnded: () => onPlayingChangeRef.current(false) });
  }, [mode, playing, projectDuration, projectFps, externalVideoClock, explicitSeekRevision, transportRevision, playbackRate]);

  useEffect(() => {
    if(resident.route!=="legacy")return;
    const canUseNative = playbackRate === 1 && legacyNativeAudioAvailable(api, projectMayContainAudio(project));
    const sequence = ++sequenceRef.current;
    let pollTimer = 0;
    let disposed = false;
    let streamRevision = 0;
    let ownedGeneration: number | undefined;
    const pendingStarts = new Set<Promise<NativeAudioPreviewStartResult>>();
    const stops = new Map<number, Promise<void>>();
    let retirementFailure: unknown;

    const stopNative = (generation: number | undefined): Promise<void> => {
      if (generation === undefined || !api?.stopNativeAudioPreview) return Promise.resolve();
      const previous = stops.get(generation);
      if (previous) return previous;
      const stopped = api.stopNativeAudioPreview(generation).then(result => {
        if (result.active && !result.superseded) throw new Error("原生音訊停止尚未確認；變速播放已阻擋");
      }).catch(reason => {
        retirementFailure = reason;
        unconfirmedStopsRef.current.add(generation);
        throw reason;
      });
      stops.set(generation, stopped);
      return stopped;
    };
    const recoverStartFailure = (reason: unknown) => {
      if (disposed || sequenceRef.current !== sequence || !playingRef.current || playbackRateRef.current !== 1
        || explicitSeekRef.current !== explicitSeekRevision || transportRevisionRef.current !== transportRevision) return;
      if (retirementFailure) {
        const message = "原生音訊清理未確認；相容播放已阻擋";
        setMode("failed"); setError(message); setFailure({ kind: "audio", detail: message });
        pauseForFailure(); return;
      }
      beginCompatiblePlayback(playheadRef.current,
        reason instanceof Error ? reason.message : "原生音訊預覽 staging 失敗，已切回相容播放");
    };
    const startNative = async (timelineStart: number): Promise<void> => {
      if (!api?.startNativeAudioPreview) return;
      const stream = ++streamRevision;
      const current = () => !disposed && sequenceRef.current === sequence && playingRef.current && stream === streamRevision
        && playbackRateRef.current === 1 && explicitSeekRef.current === explicitSeekRevision && transportRevisionRef.current === transportRevision;
      let generation: number | undefined;
      let buffered: NativeAudioPreviewStatus | undefined;
      let terminalHandled = false;
      const fail = async (reason: unknown) => {
        if (terminalHandled || !current()) return;
        terminalHandled = true;
        await stopNative(generation);
        if (!current()) return;
        beginCompatiblePlayback(playheadRef.current, reason instanceof Error ? reason.message : "原生音訊預覽失敗，已切回相容播放");
      };
      const consume = async (status: NativeAudioPreviewStatus) => {
        if (!current() || terminalHandled) return;
        if (generation === undefined) { buffered = status; return; }
        if (api.nativeAudioPreviewPushEvents && status.generation !== generation) return;
        try {
          if (status.failed) throw new Error(status.error || "原生音訊預覽失去裝置連線");
          if (status.playback && Number.isFinite(status.playback.timelineSeconds)) {
            const next = Math.max(0, Math.min(projectDuration, status.playback.timelineSeconds));
            if (playbackFrameIndex(next, projectFps) !== playbackFrameIndex(playheadRef.current, projectFps) || next >= projectDuration) {
              playheadRef.current = next;
              if (!externalVideoClockRef.current) onPlayheadChangeRef.current(next);
            }
          }
          if (!status.active) {
            terminalHandled = true;
            const next = status.playback?.timelineSeconds ?? playheadRef.current;
            if (status.playback?.event === "ended" && next < projectDuration - 0.5 / projectFps) {
              await startNative(next);
            } else {
              await stopNative(generation);
              if (current()) onPlayingChangeRef.current(false);
            }
          }
        } catch (reason) {
          // A failed restart belongs to the new stream; the outer invocation
          // handles it only while this effect still owns the transport.
          if (terminalHandled && stream !== streamRevision) throw reason;
          await fail(reason);
        }
      };
      pauseAllMedia();
      setMode("starting");
      setGeneration(undefined);
      setError(undefined);
      const onStatus = (status: NativeAudioPreviewStatus) => { void consume(status).catch(recoverStartFailure); };
      const pendingStart = api.startNativeAudioPreview(projectRef.current, timelineStart, api.nativeAudioPreviewPushEvents ? onStatus : undefined);
      pendingStarts.add(pendingStart);
      let started: NativeAudioPreviewStartResult;
      try { started = await pendingStart; } finally { pendingStarts.delete(pendingStart); }
      generation = started.generation;
      if (!current()) {
        await stopNative(generation);
        return;
      }
      ownedGeneration = generation;
      if (!nativeAudioStageMatchesProject(started.stage, projectRef.current)) {
        await stopNative(generation);
        throw new Error("原生音訊預覽 stage 與目前專案 revision 不一致");
      }
      setStage(started.stage);
      setGeneration(generation);
      setTransportSeekRevision(explicitSeekRevision);
      confirmedLegacyEpoch.current = previewEpoch; setMode("native");
      playheadRef.current = started.playback.timelineSeconds;
      onPlayheadChangeRef.current(started.playback.timelineSeconds);
      if (api.nativeAudioPreviewPushEvents) {
        if (buffered) await consume(buffered);
        return;
      }
      // Explicit compatibility for older desktop adapters. Tauri uses its
      // request-scoped native channel and never enters this polling branch.
      const poll = async () => {
        if (!current() || terminalHandled) return;
        try {
          const status = await api.nativeAudioPreviewStatus!();
          await consume(status);
          if (current() && !terminalHandled) pollTimer = window.setTimeout(() => void poll(), 24);
        } catch (reason) {
          if (terminalHandled && stream !== streamRevision) recoverStartFailure(reason);
          else await fail(reason);
        }
      };
      pollTimer = window.setTimeout(() => void poll(), 24);
    };

    if (!playing) {
      pauseAllMedia();
      setMode("idle");
      setStage(undefined);
      setGeneration(undefined);
      setError(undefined);
    } else if (failureRef.current?.kind === "audio") {
      // An unconfirmed native stop blocks any new sound, native or compatible, until
      // it is retried; the effect above has already paused this play request.
      pauseAllMedia(); setMode("idle"); setStage(undefined); setGeneration(undefined);
    } else if (playbackRate !== 1) {
      pauseAllMedia();
      setStage(undefined); setGeneration(undefined); setError(undefined);
      setRateRetirement({ rate: playbackRate, seek: explicitSeekRevision, ready: false });
      void retirementRef.current.then(() => {
        if (disposed || sequenceRef.current !== sequence || !playingRef.current
          || playbackRateRef.current !== playbackRate || explicitSeekRef.current !== explicitSeekRevision) return;
        setRateRetirement({ rate: playbackRate, seek: explicitSeekRevision, ready: true });
        setMode("compatible"); setTransportSeekRevision(explicitSeekRevision);
      }, reason => {
        if (disposed || sequenceRef.current !== sequence || playbackRateRef.current !== playbackRate) return;
        const message = reason instanceof Error ? reason.message : "原生音訊清理未確認；變速播放已阻擋";
        setRateRetirement({ rate: playbackRate, seek: explicitSeekRevision, ready: false, error: message });
        setError(message); setMode("failed"); setFailure({ kind: "audio", detail: message }); pauseForFailure();
      });
    } else if (!canUseNative) {
      beginCompatiblePlayback(playheadRef.current);
    } else {
      void startNative(playheadRef.current).catch(recoverStartFailure);
    }
    return () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      if (playing) {
        const previous = retirementRef.current;
        retirementRef.current = Promise.all([previous, stopNative(ownedGeneration),
          ...[...pendingStarts].map(pending => pending.then(started => stopNative(started.generation), () => undefined))]).then(() => undefined);
        // Retain failure for the next rate admission without an unhandled cleanup rejection.
        void retirementRef.current.catch(() => undefined);
      }
    };
  }, [api, mediaRefs, playing, project.id, project.revision, project.updatedAt, projectDuration, projectFps, transportRevision, explicitSeekRevision,resident.route,playbackRate,previewEpoch]);

  useEffect(() => () => {
    ++sequenceRef.current;
    pauseAllMedia();
    mediaSynchronizerRef.current?.dispose();
  }, [api, mediaRefs]);

  // A confirmed audio retry resumes playback it had paused; a failed one keeps the
  // notice, whose line then says it is still failing.
  const visibleFailure: PreviewPlaybackFailure | undefined = failure
    ? { kind: failure.kind, detail: failure.detail, ...(failure.step ? { step: failure.step } : {}),
      retry: failure.kind === "play" ? () => retryPlay(failure) : () => retryUnconfirmedStops(failure) }
    : residentFailed ? { kind: "audio", detail: resident.view.error ?? "原生音訊清理未確認；已停止播放，避免兩份聲音重疊",
      retry: () => Promise.resolve(resident.retry()).then(admitted => { if (admitted) resumeAfterRecovery(); }) } : undefined;
  useEffect(() => { if (!visibleFailure) pausedByFailureRef.current = undefined; }, [visibleFailure === undefined]);
  // A play failure belongs to its element in its project. Once that clip is removed,
  // its element replaced (a new source) or another project opened, the failure is
  // dropped, so its late recovery can neither resume playback nor clear a newer notice.
  useEffect(() => {
    const stale = failureRef.current;
    if (stale?.kind !== "play" || (stale.projectId === project.id && stale.media !== undefined
      && [...mediaRefs.current.values()].includes(stale.media))) return;
    setFailure(current => current === stale ? undefined : current);
  }, [project.id, layers, audioLayers, mediaRefs]);
  // Who plays the clips' own sound follows the route and speed, not the momentary
  // mode, which passes through idle/starting on every pause and seek: native audio
  // owns it unless it fell back to compatible playback. While the route is still
  // being checked nothing plays yet, so no source is blamed.
  const elementsOwnSound = playbackRate !== 1 || (resident.route === "resident" ? !hasAudio || resident.view.mode === "compatible"
    : resident.route === "legacy" && (!legacyNativeAudioAvailable(api, hasAudio) || legacyMode === "compatible"));
  const elementsOwnSoundRef = useRef(elementsOwnSound);
  elementsOwnSoundRef.current = elementsOwnSound;
  // <audio> tracks and 3D-scene audio have no picture to show an error on. A load
  // or decode error pauses while that element is the sound source (native audio
  // does not read it), stays visible beside the transport and can be reloaded.
  const audioSources = [...audioLayers, ...(project.scene3d?.enabled ? layers.filter(layer => layer.asset.kind === "video" && layer.clip.volume > 0 && !layer.silent) : [])];
  const audioSourceKey = audioSources.map(layer => `${layer.clip.id}\n${layer.source}`).join("\n\n");
  const [audioErrors, setAudioErrors] = useState<Record<string, { name: string; detail: string; media: HTMLMediaElement }>>({});
  const reportedAudioErrorsRef = useRef(new WeakSet<HTMLMediaElement>());
  useEffect(() => {
    const names = new Map(audioSources.map(layer => [layer.clip.id, layer.asset.name]));
    setAudioErrors(current => Object.keys(current).every(id => names.has(id)) ? current
      : Object.fromEntries(Object.entries(current).filter(([id]) => names.has(id))));
    const detach: Array<() => void> = [];
    for (const [clipId, media] of mediaRefs.current) {
      const name = names.get(clipId);
      if (name === undefined || media.tagName !== "AUDIO") continue;
      const failed = () => {
        const error = media.error;
        reportedAudioErrorsRef.current.add(media);
        setAudioErrors(current => ({ ...current, [clipId]: { name, media,
          detail: error ? `解碼錯誤 ${error.code}：${error.message || "播放器無法播放這段聲音"}` : "聲音來源無法讀取" } }));
        if (playingRef.current && elementsOwnSoundRef.current) { pauseAllMedia(); onPlayingChangeRef.current(false); }
      };
      const loaded = () => {
        reportedAudioErrorsRef.current.delete(media);
        setAudioErrors(current => { if (!(clipId in current)) return current; const next = { ...current }; delete next[clipId]; return next; });
      };
      media.addEventListener("error", failed); media.addEventListener("loadeddata", loaded);
      if (media.error && !reportedAudioErrorsRef.current.has(media)) failed();
      detach.push(() => { media.removeEventListener("error", failed); media.removeEventListener("loadeddata", loaded); });
    }
    return () => { for (const stop of detach) stop(); };
  }, [audioSourceKey, mediaRefs]);
  // Publish what the user must see beside the transport (ui/playbackNoticeStore).
  // Compatible audio at 1× keeps playing: it is published as a status that the
  // transport readout states (音訊相容模式), never as a banner.
  const visibleError = playbackRate !== 1 ? rateRetirement.error ?? resident.view.error ?? error : resident.route !== "legacy" ? resident.view.error : error;
  const fallbackReason = mode === "compatible" && playbackRate === 1 ? visibleError : undefined;
  const noticeRetryRef = useRef<() => void | Promise<void>>(() => undefined);
  noticeRetryRef.current = visibleFailure?.retry ?? (() => undefined);
  useEffect(() => {
    publishPlaybackNotice("preview-audio", visibleFailure ? { kind: visibleFailure.kind, detail: visibleFailure.detail, step: visibleFailure.step,
      retry: () => noticeRetryRef.current() } : fallbackReason ? { kind: "audio-fallback", detail: fallbackReason } : undefined);
  }, [visibleFailure?.kind, visibleFailure?.detail, visibleFailure?.step, fallbackReason]);
  // Every broken audio source is one notice with one reload for all of them;
  // the clip names and causes are under 查看原因. It stays put across pauses and
  // seeks (so a dismissal sticks) and only follows who owns the sound.
  useEffect(() => {
    const failing = elementsOwnSound ? Object.values(audioErrors) : [];
    publishPlaybackNotice("audio-sources", failing.length === 0 ? undefined : { kind: "audio-source", names: failing.map(value => value.name),
      detail: failing.map(value => `${value.name}：${value.detail}`).join("\n"), retry: () => reloadMedia(failing.map(value => value.media)) });
  }, [audioErrors, elementsOwnSound]);
  useEffect(() => () => {
    publishPlaybackNotice("preview-audio");
    publishPlaybackNotice("audio-sources");
  }, []);
  if(playbackRate!==1)return {mode,error:rateRetirement.error??resident.view.error??error,transportSeekRevision:explicitSeekRevision,failure:visibleFailure};
  if(resident.route!=="legacy")return {mode,error:resident.view.error,stage:resident.view.stage,generation:resident.view.generation,
    ownerId:resident.view.ownerId,transportSeekRevision:explicitSeekRevision!==undefined?resident.view.seekRevision:undefined,failure:visibleFailure};
  return { mode, error, stage, generation, transportSeekRevision, failure: visibleFailure };
}

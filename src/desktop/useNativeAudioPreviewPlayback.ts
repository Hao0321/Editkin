import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ActivePreviewLayer } from "../application/previewMedia";
import type { EditProject } from "../domain/types";
import type { HaoDesktopApi, NativeAudioPreviewStageReceipt, NativeAudioPreviewStatus, NativeAudioPreviewStartResult } from "./types";
import { playbackFrameIndex, previewPlaybackRate, startCompatiblePlaybackClock } from "../ui/playbackTiming";
import {useResidentAudioTransport} from "./useResidentAudioTransport";
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
  playbackRate?: number;
}

/** Reverse media stays silent/paused; only the latest pending frame seek survives. */
export function createPreviewMediaSynchronizer() {
  const pending = new Map<HTMLMediaElement, { target: number; listener: () => void }>();
  const cancel = (media: HTMLMediaElement) => {
    const job = pending.get(media);
    if (job) media.removeEventListener("seeked", job.listener);
    pending.delete(media);
  };
  return {
    sync(media: HTMLMediaElement, layer: ActivePreviewLayer | undefined, time: number, playing: boolean,
      mode: NativeAudioPreviewMode, rate: number, fps: number): void {
      if (!layer) { cancel(media); media.pause(); media.muted = true; return; }
      const { clip } = layer;
      const target = clip.sourceStart + Math.max(0, Math.min(clip.duration, time - clip.timelineStart));
      const threshold = playing && rate > 0 ? 0.2 : 0.5 / fps;
      media.volume = Math.max(0, Math.min(1, clip.volume));
      if (rate < 0) {
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
      if (!playing || mode === "idle" || mode === "starting" || mode === "failed") { media.pause(); return; }
      media.muted = mode === "native" || clip.volume <= 0;
      if ((mode !== "native" || media.tagName === "VIDEO") && media.paused) void media.play().catch(() => undefined);
    },
    retain(live: ReadonlySet<HTMLMediaElement>) { for (const media of pending.keys()) if (!live.has(media)) cancel(media); },
    dispose() { for (const media of pending.keys()) cancel(media); },
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
  playbackRate: requestedRate = 1,
}: NativeAudioPreviewPlaybackOptions): {
  mode: NativeAudioPreviewMode;
  error?: string;
  stage?: NativeAudioPreviewStageReceipt | ResidentAudioStage;
  generation?: number;
  ownerId?: number;
  transportSeekRevision?: number;
} {
  const playbackRate = previewPlaybackRate(requestedRate);
  const [legacyMode, setMode] = useState<NativeAudioPreviewMode>("idle");
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
  const mediaSynchronizerRef = useRef<ReturnType<typeof createPreviewMediaSynchronizer> | undefined>(undefined);
  mediaSynchronizerRef.current ??= createPreviewMediaSynchronizer();
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

  const resident=useResidentAudioTransport({api:api?.residentAudio,project,playing:playing&&playbackRate===1,hasAudio:projectMayContainAudio(project),
    seekRevision:transportRevision,playhead:playheadRef,onClock:(time,ended)=>{
      if(playbackRateRef.current!==1 || !playingRef.current)return;
      playheadRef.current=time;
      if(!externalVideoClockRef.current)onPlayheadChangeRef.current(time);
      if(ended)onPlayingChangeRef.current(false);
    }});
  const nativeMode:NativeAudioPreviewMode=resident.route==="legacy"?legacyMode:resident.route==="checking"?(playing?"starting":"idle")
    :resident.view.mode==="preparing"?"starting":resident.view.mode==="closed"?"idle":resident.view.mode;
  const residentPaused = resident.route === "resident" && (resident.view.mode === "compatible"
    || (resident.view.playing === false && resident.view.mode !== "preparing")
    || (resident.view.ownerId === undefined && resident.view.mode === "idle"));
  const rateReady = resident.route === "resident" ? residentPaused
    : rateRetirement.rate === playbackRate && rateRetirement.seek === explicitSeekRevision && rateRetirement.ready;
  const mode: NativeAudioPreviewMode = playbackRate === 1 ? nativeMode : !playing ? "idle"
    : resident.view.mode === "failed" || rateRetirement.error ? "failed" : rateReady ? "compatible" : "starting";

  const pauseAllMedia = () => mediaRefs.current.forEach((media) => media.pause());

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
    const canUseNative = Boolean(
      playbackRate === 1 && api?.startNativeAudioPreview
      && (api.nativeAudioPreviewPushEvents || api.nativeAudioPreviewStatus)
      && api.stopNativeAudioPreview
      && projectMayContainAudio(project),
    );
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
        throw reason;
      });
      stops.set(generation, stopped);
      return stopped;
    };
    const recoverStartFailure = (reason: unknown) => {
      if (disposed || sequenceRef.current !== sequence || !playingRef.current || playbackRateRef.current !== 1
        || explicitSeekRef.current !== explicitSeekRevision || transportRevisionRef.current !== transportRevision) return;
      if (retirementFailure) {
        pauseAllMedia(); setMode("failed"); setError("原生音訊清理未確認；相容播放已阻擋");
        onPlayingChangeRef.current(false); return;
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
      setMode("native");
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
        setError(message); setMode("failed"); onPlayingChangeRef.current(false);
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
  }, [api, mediaRefs, playing, project.id, project.revision, project.updatedAt, projectDuration, projectFps, transportRevision, explicitSeekRevision,resident.route,playbackRate]);

  useEffect(() => () => {
    ++sequenceRef.current;
    pauseAllMedia();
    mediaSynchronizerRef.current?.dispose();
  }, [api, mediaRefs]);

  if(playbackRate!==1)return {mode,error:rateRetirement.error??resident.view.error??error,transportSeekRevision:explicitSeekRevision};
  if(resident.route!=="legacy")return {mode,error:resident.view.error,stage:resident.view.stage,generation:resident.view.generation,
    ownerId:resident.view.ownerId,transportSeekRevision:explicitSeekRevision!==undefined?resident.view.seekRevision:undefined};
  return { mode, error, stage, generation, transportSeekRevision };
}

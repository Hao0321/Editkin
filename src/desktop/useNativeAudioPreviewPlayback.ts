import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ActivePreviewLayer } from "../application/previewMedia";
import type { EditProject } from "../domain/types";
import type { HaoDesktopApi, NativeAudioPreviewStageReceipt, NativeAudioPreviewStatus } from "./types";
import { playbackFrameIndex } from "../ui/playbackTiming";
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
}: NativeAudioPreviewPlaybackOptions): {
  mode: NativeAudioPreviewMode;
  error?: string;
  stage?: NativeAudioPreviewStageReceipt | ResidentAudioStage;
  generation?: number;
  ownerId?: number;
  transportSeekRevision?: number;
} {
  const [legacyMode, setMode] = useState<NativeAudioPreviewMode>("idle");
  const [error, setError] = useState<string>();
  const [stage, setStage] = useState<NativeAudioPreviewStageReceipt>();
  const [generation, setGeneration] = useState<number>();
  const [transportSeekRevision, setTransportSeekRevision] = useState<number>();
  const [seekRevision, setSeekRevision] = useState(0);
  const sequenceRef = useRef(0);
  const playingRef = useRef(playing);
  const playheadRef = useRef(playhead);
  const projectRef = useRef(project);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  const explicitSeekRef = useRef(explicitSeekRevision);
  const externalVideoClockRef = useRef(externalVideoClock);
  // The retained transport's effect runs before the legacy seek effect below.
  // Synchronize the explicit user position now so a new seek revision never
  // stages the previous render's playhead (e.g. seek to 3 s but stage 0 s).
  if(explicitSeekRevision!==undefined)playheadRef.current=playhead;
  explicitSeekRef.current = explicitSeekRevision;
  externalVideoClockRef.current = externalVideoClock;
  playingRef.current = playing;
  projectRef.current = project;
  onPlayingChangeRef.current = onPlayingChange;
  onPlayheadChangeRef.current = onPlayheadChange;

  const resident=useResidentAudioTransport({api:api?.residentAudio,project,playing,hasAudio:projectMayContainAudio(project),
    seekRevision:explicitSeekRevision??seekRevision,playhead:playheadRef,onClock:(time,ended)=>{
      playheadRef.current=time;
      if(!externalVideoClockRef.current)onPlayheadChangeRef.current(time);
      if(ended)onPlayingChangeRef.current(false);
    }});
  const mode:NativeAudioPreviewMode=resident.route==="legacy"?legacyMode:resident.route==="checking"?(playing?"starting":"idle")
    :resident.view.mode==="preparing"?"starting":resident.view.mode==="closed"?"idle":resident.view.mode;

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
    for (const [clipId, media] of mediaRefs.current) {
      const layer = layerByClip.get(clipId);
      if (!layer) continue;
      const { clip } = layer;
      const target = clip.sourceStart + Math.max(0, playhead - clip.timelineStart);
      if (Number.isFinite(target) && Math.abs(media.currentTime - target) > 0.2) media.currentTime = target;
      media.volume = Math.max(0, Math.min(1, clip.volume));
      if (!playing || mode === "idle" || mode === "starting" || mode === "failed") {
        media.pause();
        continue;
      }
      if (mode === "native") {
        media.muted = true;
        if (media.tagName === "VIDEO" && media.paused) void media.play().catch(() => undefined);
      } else {
        media.muted = clip.volume <= 0;
        if (media.paused) void media.play().catch(() => undefined);
      }
    }
  }, [audioLayers, layers, mediaRefs, mode, playhead, playing]);

  useEffect(() => {
    if (!playing || mode !== "compatible" || externalVideoClock) return;
    const origin = playheadRef.current;
    const startedAt = performance.now();
    let lastFrame = playbackFrameIndex(origin, projectFps);
    let animationFrame = 0;
    const tick = (now: number) => {
      const next = Math.min(projectDuration, origin + (now - startedAt) / 1_000);
      const nextFrame = playbackFrameIndex(next, projectFps);
      if (nextFrame !== lastFrame || next >= projectDuration) {
        lastFrame = nextFrame;
        playheadRef.current = next;
        onPlayheadChangeRef.current(next);
      }
      if (next >= projectDuration) onPlayingChangeRef.current(false);
      else animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [mode, playing, projectDuration, projectFps, externalVideoClock, explicitSeekRevision]);

  useEffect(() => {
    if(resident.route!=="legacy")return;
    const canUseNative = Boolean(
      api?.startNativeAudioPreview
      && (api.nativeAudioPreviewPushEvents || api.nativeAudioPreviewStatus)
      && api.stopNativeAudioPreview
      && projectMayContainAudio(project),
    );
    const sequence = ++sequenceRef.current;
    let pollTimer = 0;
    let disposed = false;
    let streamRevision = 0;
    let ownedGeneration: number | undefined;

    const stopNative = async (generation: number | undefined) => {
      if (generation !== undefined && api?.stopNativeAudioPreview) {
        await api.stopNativeAudioPreview(generation).catch(() => undefined);
      }
    };
    const recoverStartFailure = (reason: unknown) => {
      if (disposed || sequenceRef.current !== sequence || !playingRef.current || explicitSeekRef.current !== explicitSeekRevision) return;
      beginCompatiblePlayback(playheadRef.current,
        reason instanceof Error ? reason.message : "原生音訊預覽 staging 失敗，已切回相容播放");
    };
    const startNative = async (timelineStart: number): Promise<void> => {
      if (!api?.startNativeAudioPreview) return;
      const stream = ++streamRevision;
      const current = () => !disposed && sequenceRef.current === sequence && playingRef.current && stream === streamRevision
        && explicitSeekRef.current === explicitSeekRevision;
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
      const started = await api.startNativeAudioPreview(projectRef.current, timelineStart, api.nativeAudioPreviewPushEvents ? onStatus : undefined);
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
    } else if (!canUseNative) {
      beginCompatiblePlayback(playheadRef.current);
    } else {
      void startNative(playheadRef.current).catch(recoverStartFailure);
    }
    return () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      if (playing) void stopNative(ownedGeneration);
    };
  }, [api, mediaRefs, playing, project.id, project.revision, project.updatedAt, projectDuration, projectFps, seekRevision, explicitSeekRevision,resident.route]);

  useEffect(() => () => {
    ++sequenceRef.current;
    pauseAllMedia();
  }, [api, mediaRefs]);

  if(resident.route!=="legacy")return {mode,error:resident.view.error,stage:resident.view.stage,generation:resident.view.generation,
    ownerId:resident.view.ownerId,transportSeekRevision:explicitSeekRevision!==undefined?resident.view.seekRevision:undefined};
  return { mode, error, stage, generation, transportSeekRevision };
}

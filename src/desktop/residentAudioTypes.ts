import type {EditProject} from "../domain/types";

export interface ResidentAudioStage {
  schema: "editkin.native-audio-project-stage/v1";
  status: "PREPARED";
  projectId: string;
  projectRevision: number;
  projectUpdatedAt: string;
  generation: number;
  planSha256: string;
  planBytes: number;
  startFrame: number;
  frameCount: number;
  sourceCount: number;
  peakActiveSources: number;
  audioFingerprintSha256: string;
  pcmStagingFiles: 0;
}
export interface ResidentAudioStatus {
  schema: "editkin.desktop-audio-status/v1";
  ownerId: number;
  sequence: number;
  generation: number;
  ready: boolean;
  failed: boolean;
  closing: boolean;
  error?: string | null;
  playback: Partial<{
    schema: "editkin.native-audio-session-event/v1";
    event: string;
    streamGeneration: number;
    state: "idle" | "preparing" | "playing" | "paused" | "ended";
    timelineStartFrame: number;
    timelineFrame: number;
    presentedFrame: number;
    sampleMasterFrame: number;
    sampleMasterRate: 48000;
    clockQpc100ns: number;
    deviceGeneration: number;
  }>;
}
export interface ResidentAudioApi {
  capabilities(): Promise<{schema: "editkin.desktop-audio-capabilities/v1"; supported: boolean; gpuClock: boolean; clockSchema?: "editkin.resident-audio-clock/v1"; sampleRate: 48000}>;
  open(onStatus: (status: ResidentAudioStatus) => void): Promise<{ownerId: number; status: ResidentAudioStatus}>;
  replace(ownerId: number, project: EditProject, timelineStartSeconds: number): Promise<{ownerId: number; generation: number; stage: ResidentAudioStage}>;
  control(ownerId: number, generation: number, playing: boolean): Promise<{ownerId: number; requestId: number; accepted: true}>;
  close(ownerId: number): Promise<{ownerId: number; released: boolean; retainedStageFiles: number}>;
  /** Optional for older desktop runtimes; never used to drive the playback clock. */
  status?(ownerId: number): Promise<ResidentAudioStatus>;
}

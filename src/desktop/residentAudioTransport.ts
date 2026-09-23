import type {EditProject} from "../domain/types";
import type {ResidentAudioApi, ResidentAudioStage, ResidentAudioStatus} from "./residentAudioTypes";

export interface ResidentAudioIntent {
  project: EditProject;
  seekRevision: number;
  timelineStartSeconds: number;
  playing: boolean;
}
export interface ResidentAudioView {
  mode: "idle" | "preparing" | "native" | "compatible" | "failed" | "closed";
  ownerId?: number;
  generation?: number;
  stage?: ResidentAudioStage;
  seekRevision?: number;
  playing?: boolean;
  error?: string;
}
const safeId = (n: number) => Number.isSafeInteger(n) && n > 0;
const keyOf = (i: ResidentAudioIntent) => JSON.stringify([i.project.id, i.project.revision, i.project.updatedAt, i.seekRevision]);
export function residentStageMatches(stage: ResidentAudioStage, intent: ResidentAudioIntent, generation: number): boolean {
  return stage.schema === "editkin.native-audio-project-stage/v1" && stage.status === "PREPARED"
    && stage.projectId === intent.project.id && stage.projectRevision === intent.project.revision
    && stage.projectUpdatedAt === intent.project.updatedAt && stage.generation === generation
    && safeId(generation) && stage.startFrame === Math.round(intent.timelineStartSeconds * 48000)
    && Number.isSafeInteger(stage.frameCount) && stage.frameCount > 0
    && stage.startFrame + stage.frameCount <= 4_147_200_000
    && Number.isInteger(stage.sourceCount) && stage.sourceCount >= 0 && stage.sourceCount <= 4096
    && Number.isInteger(stage.peakActiveSources) && stage.peakActiveSources >= 0 && stage.peakActiveSources <= 16
    && stage.peakActiveSources <= stage.sourceCount && stage.pcmStagingFiles === 0
    && /^[a-f0-9]{64}$/.test(stage.planSha256) && /^[a-f0-9]{64}$/.test(stage.audioFingerprintSha256)
    && Number.isInteger(stage.planBytes) && stage.planBytes > 0 && stage.planBytes <= 4 * 1024 * 1024;
}

/** Retained command ownership, independent of React render/effect churn.
 * No wall-clock/RAF drives audio. Telemetry callbacks are UI observations only;
 * native GPU activation still requires the separate long-range QPC bridge.
 */
export class ResidentAudioTransport {
  private desired?: ResidentAudioIntent;
  private owner?: number;
  private generation?: number;
  private stage?: ResidentAudioStage;
  private key?: string;
  private sentPlaying?: boolean;
  private supported?: boolean;
  private retired = false;
  private failed = false;
  private busy?: Promise<void>;
  private sequence = -1;
  private early?: ResidentAudioStatus;
  private replacing = false;
  private revision = 0;
  private readyGeneration?: number;
  private stagedSeekRevision?: number;

  constructor(private readonly api: ResidentAudioApi, private readonly publish: (view: ResidentAudioView) => void,
    private readonly onClock: (seconds: number, ended: boolean) => void) {}

  update(intent: ResidentAudioIntent): void {
    if (this.retired) return;
    if (!Number.isFinite(intent.timelineStartSeconds) || intent.timelineStartSeconds < 0 || intent.timelineStartSeconds >= 86400
      || !Number.isSafeInteger(intent.seekRevision) || intent.seekRevision < 0) throw new Error("音訊播放意圖不合法");
    // A playhead telemetry update is not a seek. Only the explicit seek revision
    // or project identity changes the staged plan.
    this.desired = intent;
    this.revision++;
    if (!this.failed) this.schedule();
  }
  private schedule(): void {
    if (this.busy) return;
    const revision = this.revision;
    this.busy = Promise.resolve().then(() => this.pump()).finally(() => {
      this.busy = undefined;
      if (revision !== this.revision && !this.retired && !this.failed) this.schedule();
    });
  }
  private view(mode: ResidentAudioView["mode"], error?: string): void {
    if (!this.retired) this.publish({mode, ownerId: this.owner, generation: this.generation,
      stage: this.stage,seekRevision:this.stagedSeekRevision, playing: this.sentPlaying, error});
  }
  private async release(): Promise<void> {
    if (this.owner === undefined) return;
    const owner = this.owner;
    const closed = await this.api.close(owner);
    if (closed.ownerId !== owner || closed.released !== true) throw new Error("原生音訊尚未確認關閉；相容播放已阻擋");
    this.owner = undefined; this.generation = undefined; this.stage = undefined;
    this.key = undefined; this.sentPlaying = undefined; this.early = undefined;
    this.readyGeneration = undefined;
    this.stagedSeekRevision = undefined;
  }
  private async pump(): Promise<void> {
    try {
      if (this.retired) { await this.release(); return; }
      if (!this.desired?.playing && this.owner === undefined) { this.view("idle"); return; }
      if (this.supported === undefined) {
        const caps = await this.api.capabilities();
        this.supported = caps.schema === "editkin.desktop-audio-capabilities/v1" && caps.supported && caps.sampleRate === 48000;
      }
      if (this.retired) { await this.release(); return; }
      if (!this.supported) { this.view("compatible", "目前安裝的核心尚未支援常駐音訊"); return; }
      if (this.owner === undefined) {
        this.view("preparing");
        const opened = await this.api.open(status => this.receive(status));
        if (!safeId(opened.ownerId)) throw new Error("原生音訊 owner 不合法");
        this.owner = opened.ownerId;
        if (this.retired) { await this.release(); return; }
      }
      while (!this.retired && !this.failed && this.desired) {
        const intent = this.desired, key = keyOf(intent), owner = this.owner!;
        if (this.key !== key) {
          // Every replacement is prepared PAUSED in native code. An obsolete
          // service completion never autoplays or resumes the wrong generation.
          this.view("preparing"); this.replacing = true; this.early = undefined;
          const replaced = await this.api.replace(owner, intent.project, intent.timelineStartSeconds);
          if (replaced.ownerId !== owner || !residentStageMatches(replaced.stage, intent, replaced.generation)
            || (this.generation !== undefined && replaced.generation <= this.generation)) throw new Error("音訊 plan 與目前專案或 generation 不一致");
          this.generation = replaced.generation; this.stage = replaced.stage; this.key = key;
          this.stagedSeekRevision=intent.seekRevision;
          this.readyGeneration = undefined;
          this.sentPlaying = false; this.replacing = false;
          if (this.retired) break;
          if (this.early) this.receive(this.early);
          if (this.failed) return;
          // Coalesce intermediate seeks; only the latest desired key can play.
          if (keyOf(this.desired) !== key) continue;
        }
        const playing = this.desired.playing;
        if (this.sentPlaying !== playing) {
          const ack = await this.api.control(owner, this.generation!, playing);
          if (ack.ownerId !== owner || ack.accepted !== true || !safeId(ack.requestId)) throw new Error("音訊控制沒有被正確接受");
          this.sentPlaying = playing;
          if (this.failed) return;
          if (this.retired) break;
          if (keyOf(this.desired) !== this.key || this.desired.playing !== playing) continue;
        }
        this.view(this.readyGeneration === this.generation ? "native" : "preparing"); return;
      }
      await this.release();
    } catch (reason) {
      this.replacing = false; this.failed = true;
      const message = reason instanceof Error ? reason.message : String(reason);
      try { await this.release(); this.view("compatible", message); }
      catch { this.view("failed", "原生音訊清理未確認；已停止播放，避免兩份聲音重疊"); }
    }
  }
  private receive(status: ResidentAudioStatus): void {
    if (this.retired || this.failed || status.schema !== "editkin.desktop-audio-status/v1") return;
    if (this.owner === undefined || this.replacing) { this.early = status; return; }
    if (status.ownerId !== this.owner || !Number.isSafeInteger(status.sequence) || status.sequence <= this.sequence) return;
    if (status.failed) {
      // Queue teardown on the same serialized pump; never race a replacement.
      this.failed = true;
      const pending = this.busy ?? Promise.resolve();
      void pending.then(async () => {try {await this.release(); this.view("compatible", status.error ?? "音訊工作階段失敗");}
        catch {this.view("failed", "原生音訊清理未確認；相容播放已阻擋");}});
      return;
    }
    if (status.generation !== this.generation || this.key !== (this.desired && keyOf(this.desired))) return;
    const p = status.playback;
    if (p.schema !== "editkin.native-audio-session-event/v1" || p.streamGeneration !== this.generation
      || p.sampleMasterRate !== 48000 || !Number.isSafeInteger(p.timelineFrame) || !Number.isSafeInteger(p.presentedFrame)
      || !Number.isSafeInteger(p.sampleMasterFrame) || !this.stage
      || p.timelineStartFrame !== this.stage.startFrame || p.timelineFrame! !== p.timelineStartFrame! + p.presentedFrame!
      || p.presentedFrame! < 0 || p.presentedFrame! > p.sampleMasterFrame!
      || p.timelineFrame! > this.stage.startFrame + this.stage.frameCount) return;
    const ended = p.state === "ended" && p.event === "ended";
    if (ended && p.timelineFrame !== this.stage.startFrame + this.stage.frameCount) return;
    this.sequence = status.sequence;
    if (["prepared", "started", "progress", "paused", "resumed", "ended"].includes(p.event ?? "")
      && ["playing", "paused", "ended"].includes(p.state ?? "")) {
      this.readyGeneration = this.generation;
      this.view("native");
    }
    if (!this.desired?.playing && !ended) return;
    this.onClock(p.timelineFrame! / 48000, ended);
  }
  /** Explicit retry, not an automatic failed-start loop on every render. */
  retry(): void { if (!this.retired && this.owner === undefined) {this.failed = false; this.sequence = -1; this.schedule();} }
  async dispose(): Promise<void> {
    this.retired = true;
    await this.busy;
    await this.release();
  }
}

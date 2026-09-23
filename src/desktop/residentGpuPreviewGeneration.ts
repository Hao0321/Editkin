import type { GpuPreviewApi, GpuPreviewOwner } from "./gpuPreviewApiTypes";
import { ResidentGpuPlayback, type PausedNativeFrame } from "./residentGpuPlayback";

export class RetiredGpuPreview extends Error {
  constructor() { super("GPU preview generation retired"); this.name = "RetiredGpuPreview"; }
}
const ref = <T,>(current: T) => ({ current });

/** One committed React effect lifetime. No native work is started by construction. */
export class ResidentGpuPreviewGeneration<Frame> {
  active = true;
  readonly imageSessionRef = ref("");
  readonly videoSessionRef = ref("");
  readonly engineVideoSessionRef = ref("");
  readonly loadedImageStructureRef = ref<string | undefined>(undefined);
  readonly loadedVideoStructureRef = ref<string | undefined>(undefined);
  readonly loadedEngineVideoStructureRef = ref<string | undefined>(undefined);
  readonly surfaceBoundsKeyRef = ref<string | undefined>(undefined);
  readonly surfaceColorSpaceRef = ref<"srgb" | "rec2100_pq_1000" | undefined>(undefined);
  readonly surfaceBoundRef = ref(false);
  readonly pendingRef = ref<Frame | undefined>(undefined);
  readonly runningRef = ref(false);
  readonly tokenRef = ref(0);
  readonly playback = new ResidentGpuPlayback();
  playbackSeekRevision?: number;
  pendingPause?: { seekRevision: number; result: Promise<PausedNativeFrame | undefined> };
  private owner?: Promise<GpuPreviewOwner>;
  private client?: Promise<GpuPreviewApi>;
  private closing?: Promise<void>;

  constructor(private readonly createOwner: (() => Promise<GpuPreviewOwner>) | undefined,
    private readonly cleanupError: (error: unknown) => void = error => console.warn("Editkin GPU owner cleanup failed", error)) {}

  assertActive(): void { if (!this.active) throw new RetiredGpuPreview(); }

  desktop(): Promise<GpuPreviewApi> {
    this.assertActive();
    if (!this.createOwner) return Promise.reject(new Error("原生執行環境缺少預覽持有者保護；請更新桌面版本。"));
    if (!this.client) {
      this.owner = this.createOwner();
      this.client = this.owner.then(async owner => {
        if (!this.active) { await this.close(); throw new RetiredGpuPreview(); }
        this.imageSessionRef.current = owner.sessions.image;
        this.videoSessionRef.current = owner.sessions.video;
        this.engineVideoSessionRef.current = owner.sessions.engineVideo;
        // Every await boundary is guarded, not only final React state updates.
        // Native cleanup owns even a load that completed after this guard retired.
        return Object.fromEntries(Object.entries(owner.desktop).map(([name, method]) => [name,
          typeof method !== "function" ? method : async (...args: unknown[]) => {
            this.assertActive();
            const guardedArgs = name === "startGpuPreviewPlayback" ? args.map(value => typeof value === "function"
              ? (...events: unknown[]) => this.active ? value(...events) : undefined : value) : args;
            const result = await (method as (...args: unknown[]) => Promise<unknown>)(...guardedArgs);
            this.assertActive(); return result;
          }])) as GpuPreviewApi;
      });
    }
    return this.client;
  }

  private close(): Promise<void> {
    if (!this.closing) this.closing = this.owner ? this.owner.then(owner => owner.release()) : Promise.resolve();
    return this.closing;
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false; this.tokenRef.current++; this.pendingRef.current = undefined;
    this.playback.invalidate();
    void this.close().catch(this.cleanupError);
  }
}

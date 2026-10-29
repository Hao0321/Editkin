import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { access, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { materialColorRequestSnapshot, verifyMaterialColorReceipt, type MaterialColorReceipt, type MaterialColorRuntimeIdentity } from "./materialColorSampling";
import type { ColorManagementSettings, MediaColorMetadata } from "../domain/types";
import { canonicalJson } from "../shared/canonicalJson";
import { validateExplicitKeyframeTimes, type MaterialKeyframeAnalysis, type MaterialKeyframeDisplay } from "./materialKeyframeTypes";
import { verifyMaterialKeyframeDisplay } from "./materialKeyframeValidation";
import { PendingNativeCloseError } from "../shared/pendingNativeClose";

export interface MaterialCacheIdentity {
  schema: "hao.editkin.material-intelligence/v1"; engineRevision: 3 | 4;
  assetId: string; clipId: string; sourceSha256: string;
  sourceStart: number; duration: number; fps: number; kind: "audio" | "video" | "image";
  language: string; includeTranscript: boolean; maxKeyframes: number;
  keyframeTimes?: number[];
  color?: MediaColorMetadata; colorManagement?: ColorManagementSettings;
  colorRuntime: MaterialColorRuntimeIdentity;
  preparationSha256: string;
  /** Omitted only for historical evidence or when speech is not requested. */
  transcriptRuntimeSha256?: string;
  /** Target script of transcript cue text; omitted on historical evidence or when speech is not requested. */
  captionScript?: "zh-TW" | "original";
  transcriptPolicy?: "required";
}
export interface MaterialCacheSeal { identity: MaterialCacheIdentity; packetSha256: string }
interface CachePacket {
  materialId: string; schema: string; cache?: MaterialCacheSeal;
  source: { assetId: string; clipId: string; sourceSha256: string; sourceStart: number; duration: number; fps: number; kind: string; color?: MediaColorMetadata; colorManagement?: ColorManagementSettings };
  analysis: { keyframes?: MaterialKeyframeAnalysis; color?: MaterialColorReceipt; scene: { state: string; cuts: Array<{ time: number }> } };
  keyframes: Array<{ id: string; time: number; sceneIndex: number; fileName: string; sha256: string; bytes: number; display?: MaterialKeyframeDisplay }>;
}
export const hashMaterialJson = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function hashMaterialSource(path: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  const signal = options.signal;
  signal?.throwIfAborted();
  // Admit before even metadata I/O; overflowing callers cannot create streams.
  if (sourceHashIO.callers >= 64) throw Error("MATERIAL_SOURCE_IDENTITY_BACKPRESSURE");
  sourceHashIO.callers++;
  sourceHashIO.peakCallers = Math.max(sourceHashIO.peakCallers, sourceHashIO.callers);
  try {
    const source = await readFreshSourceIdentity(path, signal);
    const physical = source.identity.ino !== "0" ? [source.identity.dev, source.identity.ino] : [source.physicalPath];
    const key = JSON.stringify(["material-source-sha256-live/v1", physical, source.identity]);
    const lease = sourceHashWork.acquire(key, async sharedSignal => {
      const sha256 = await readHeldMaterialSource(source, sharedSignal);
      return { sha256 };
    }, { signal });
    try {
      const result = await lease.result;
      signal?.throwIfAborted();
      // Never authorize a caller's path using only another caller's old stat/SHA.
      const current = await readFreshSourceIdentity(path, signal);
      if (current.physicalPath !== source.physicalPath || !sameSourceIdentity(current.identity, source.identity)) throw Error("MATERIAL_SOURCE_CHANGED");
      return result.sha256;
    } finally { await lease.release(); }
  } catch (error) {
    if (signal?.aborted) sourceHashIO.cancelledCallers++;
    throw error;
  } finally { sourceHashIO.callers--; }
}
function packetDigest(packet: CachePacket): string {
  return hashMaterialJson({ ...packet, cache: { identity: packet.cache!.identity } });
}
export function sealMaterialPacket<T extends CachePacket>(packet: T, identity: MaterialCacheIdentity): T {
  const sealed = { ...packet, cache: { identity, packetSha256: "" } };
  sealed.cache.packetSha256 = packetDigest(sealed);
  return sealed;
}
/** Integrity only, not authenticity/signature or proof the source has not changed. */
export function verifyMaterialPacket(packet: CachePacket, expectedId: string): void {
  if (packet.schema !== "hao.editkin.material-intelligence/v1" || packet.materialId !== expectedId) throw new Error("素材 cache 識別完整性不一致");
  if (!packet.cache) {
    if (packet.analysis?.color) throw new Error("色彩素材 cache 缺少完整性封存");
    return; // Legacy read-only evidence remains readable; new preparation never uses its ID.
  }
  const { identity } = packet.cache;
  if (![3, 4].includes(identity.engineRevision) || hashMaterialJson(identity) !== expectedId || packetDigest(packet) !== packet.cache.packetSha256) throw new Error("素材 cache 完整性驗證失敗");
  for (const key of ["assetId", "clipId", "sourceSha256", "sourceStart", "duration", "fps", "kind", "color", "colorManagement"] as const) {
    if (canonicalJson(packet.source[key] ?? null) !== canonicalJson(identity[key] ?? null)) throw new Error(`素材 cache 來源完整性不一致：${key}`);
  }
  const color = packet.analysis.color;
  if (!color) throw new Error("素材 cache 缺少色彩適用性收據");
  verifyMaterialColorReceipt(color, identity.engineRevision === 3 ? { historicalRuntime: "material-cache-revision-3" } : undefined);
  if (color.source.sha256 !== identity.sourceSha256 || color.source.start !== identity.sourceStart || color.source.duration !== identity.duration
    || hashMaterialJson(color.identity) !== hashMaterialJson(identity.colorRuntime)) throw new Error("素材色彩收據與來源／runtime 完整性不一致");
  const scene = packet.analysis.scene;
  if (identity.keyframeTimes !== undefined) {
    if (identity.engineRevision !== 4 || identity.kind !== "video") throw Error("explicit-keyframe-times-require-video");
    const expectedTimes = validateExplicitKeyframeTimes(identity.keyframeTimes, identity.duration, identity.maxKeyframes);
    if (canonicalJson(expectedTimes) !== canonicalJson(packet.analysis.keyframes?.requestedSamples.map(sample => sample.time))) {
      throw Error("explicit-keyframe-times-cache-mismatch");
    }
  }
  if (identity.engineRevision === 4) {
    verifyMaterialKeyframeDisplay(packet.analysis.keyframes, packet.keyframes, packet.source, identity.colorRuntime.identitySha256,
      scene.state === "ready" ? scene.cuts.map(cut => cut.time) : identity.kind === "image" ? [] : undefined);
    if (packet.analysis.keyframes!.requestedSamples.length > identity.maxKeyframes) throw new Error("keyframe-display-budget");
    const preparation = identity.colorRuntime.implementations.find(item => item.name === "materialIntelligence.ts");
    // Unmeasured runtime still has no trusted visuals, but source-only preparation
    // identity is independently bound in the cache ID (e.g. valid audio-only ASR).
    if (identity.colorRuntime.status === "verified" && preparation?.sha256 !== identity.preparationSha256) throw new Error("keyframe-preparation-identity");
  }
  const requested = materialColorRequestSnapshot({
    sourcePath: "not-read-for-receipt-validation", sourceSha256: identity.sourceSha256, sourceStart: identity.sourceStart, duration: identity.duration,
    kind: identity.kind, color: identity.color, colorManagement: identity.colorManagement,
    samples: identity.engineRevision === 4 ? packet.analysis.keyframes!.requestedSamples : packet.keyframes.map(({ id, time, sceneIndex }) => ({ id, time, sceneIndex })),
    sceneCount: identity.kind === "audio" ? 0 : scene.cuts.length + 1,
    sceneCountVerified: scene.state === "ready" || identity.kind === "image",
    sceneCuts: scene.state === "ready" ? scene.cuts.map(cut => cut.time) : identity.kind === "image" ? [] : undefined,
  });
  if (canonicalJson(requested) !== canonicalJson(color.request)) throw new Error("素材色彩收據與要求的設定／抽幀完整性不一致");
}
export async function verifyMaterialKeyframeFiles(packet: CachePacket, directory: string): Promise<void> {
  for (const frame of packet.keyframes) {
    if (!/^frame-\d{2}\.jpg$/.test(frame.fileName)) throw new Error("素材 cache 關鍵幀路徑不合法");
    const data = await readFile(join(directory, frame.fileName));
    if (data.length !== frame.bytes || createHash("sha256").update(data).digest("hex") !== frame.sha256) throw new Error("素材 cache 關鍵幀完整性驗證失敗");
  }
}
/** Only an absent directory is a cache miss; unknown/partial/corrupt evidence is retained. */
export async function readCompletedMaterialCache<T extends CachePacket>(directory: string, materialId: string): Promise<T | undefined> {
  try { await access(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const packet = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as T;
  verifyMaterialPacket(packet, materialId);
  await verifyMaterialKeyframeFiles(packet, directory);
  return packet;
}

/** Windows can transiently deny a rename. This does not diagnose the OS cause.
 * A bounded retry never removes/replaces an existing complete or partial cache.
 * Injection is for deterministic failure controls, not a product bypass.
 */
export async function publishMaterialCache<T extends CachePacket>(staging: string, directory: string, materialId: string, operations = {
  rename,
  read: (path: string, id: string) => readCompletedMaterialCache<T>(path, id),
  wait: (ms: number) => new Promise<void>(done => setTimeout(done, ms)),
}): Promise<T | undefined> {
  const existing = await operations.read(directory, materialId);
  if (existing) return existing;
  const deadline = Date.now() + 750, delays = [50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try { await operations.rename(staging, directory); return undefined; }
    catch (error) {
      const winner = await operations.read(directory, materialId);
      if (winner) return winner;
      const remaining = deadline - Date.now();
      if (!["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= delays.length || remaining <= 0) throw error;
      await operations.wait(Math.min(delays[attempt], remaining));
    }
  }
}

export interface MaterialPreparationWorkLimits {
  maxEntries: number;
  maxActive: number;
  maxLeases: number;
  maxKeyBytes: number;
  /** Logical serialized results retained by this pool, not process RSS. */
  maxRetainedBytes: number;
}
export interface MaterialPreparationLease<T> {
  result: Promise<T>;
  coalesced: boolean;
  /** Idempotent. Waits for cleanup, or visibly rejects while unknown native closure stays quarantined. */
  release(): Promise<void>;
}
type PreparationSubscriber<T, P> = {
  resolve(value: T): void;
  reject(error: unknown): void;
  progress?: (value: P) => void | Promise<void>;
};
type PreparationEntry<T, P> = {
  key: string; keyBytes: number; bytes: number;
  state: "queued" | "running" | "ready" | "failed" | "draining" | "quarantined";
  controller: AbortController;
  subscribers: Map<symbol, PreparationSubscriber<T, P>>;
  produce(signal: AbortSignal, progress: (value: P) => Promise<void>): Promise<T>;
  done: Promise<void>; closed(): void; finished: boolean; value?: T;
  failureBeforeClose: Promise<void>; failBeforeClose(error: unknown): void;
};
const preparationAbort = () => new DOMException("Material preparation lease released", "AbortError");

/** Process-local in-flight owner. Completed disk evidence remains canonical.
 * No timers, eviction, directory scans, or cache deletion. Queue admission is
 * bounded and fails visibly; a draining key cannot start an overlapping worker.
 * Each lease receives isolated structured-cloneable results/progress. Releasing
 * a lease also detaches its observer wait, even when that observer never settles.
 */
export class MaterialPreparationWorkPool<T, P = never> {
  private readonly entries = new Map<string, PreparationEntry<T, P>>();
  private active = 0;
  private leases = 0;
  private bytes = 0;
  private keyBytes = 0;
  private listeners = 0;
  private started = 0;
  private coalesced = 0;
  private refused = 0;
  private peaks = { entries: 0, active: 0, leases: 0, retainedBytes: 0, keyBytes: 0, handles: 0 };
  readonly limits: Readonly<MaterialPreparationWorkLimits>;
  constructor(limits: Partial<MaterialPreparationWorkLimits> = {}) {
    this.limits = Object.freeze({ maxEntries: 16, maxActive: 2, maxLeases: 64, maxKeyBytes: 4096,
      maxRetainedBytes: 16 * 1024 * 1024, ...limits });
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)
      || this.limits.maxActive > this.limits.maxEntries) throw Error("MATERIAL_PREPARATION_LIMITS_INVALID");
  }
  snapshot() {
    return { entries: this.entries.size, active: this.active, queued: [...this.entries.values()].filter(e => e.state === "queued").length,
      quarantined: [...this.entries.values()].filter(e => e.state === "quarantined").length,
      leases: this.leases, retainedBytes: this.bytes, keyBytes: this.keyBytes,
      // These are owned controllers/listeners, not OS or native process handles.
      handles: this.entries.size + this.listeners, started: this.started, coalesced: this.coalesced,
      refused: this.refused, peak: { ...this.peaks }, limits: { ...this.limits } };
  }
  private measure() {
    const current = { entries: this.entries.size, active: this.active, leases: this.leases,
      retainedBytes: this.bytes, keyBytes: this.keyBytes, handles: this.entries.size + this.listeners };
    for (const key of Object.keys(current) as Array<keyof typeof current>) this.peaks[key] = Math.max(this.peaks[key], current[key]);
  }
  private refuse(reason: string): never { this.refused++; throw Error(`MATERIAL_PREPARATION_${reason}`); }
  acquire(key: string, produce: PreparationEntry<T, P>["produce"], options: {
    signal?: AbortSignal; onProgress?: (value: P) => void | Promise<void>;
  } = {}): MaterialPreparationLease<T> {
    options.signal?.throwIfAborted();
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (!keyBytes || keyBytes > this.limits.maxKeyBytes) return this.refuse("KEY_BUDGET");
    let entry = this.entries.get(key);
    const coalesced = Boolean(entry);
    if (entry?.state === "quarantined") return this.refuse("NATIVE_CLOSE_PENDING");
    if (entry && (entry.state === "draining" || entry.state === "failed")) return this.refuse("DRAINING");
    if (this.leases >= this.limits.maxLeases || (!entry && this.entries.size >= this.limits.maxEntries)) return this.refuse("BACKPRESSURE");
    if (!entry) {
      let closed!: () => void;
      const done = new Promise<void>(resolve => { closed = resolve; });
      let failBeforeClose!: (error: unknown) => void;
      const failureBeforeClose = new Promise<void>((_, reject) => { failBeforeClose = reject; });
      // Owned failure remains on each explicit release/result and in quarantine state.
      void failureBeforeClose.catch(() => undefined);
      entry = { key, keyBytes, bytes: 0, state: "queued", controller: new AbortController(),
        subscribers: new Map(), produce, done, closed, finished: false, failureBeforeClose, failBeforeClose };
      this.entries.set(key, entry); this.keyBytes += keyBytes;
    } else this.coalesced++;
    const owned = entry, token = Symbol();
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const result = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    // Releasing an unobserved lease must not cause an unhandled rejection.
    void result.catch(() => undefined);
    let releaseProgress!: () => void;
    const progressReleased = new Promise<void>(done => { releaseProgress = done; });
    const deliver = (value: T) => {
      try { resolve(structuredClone(value)); }
      catch (error) { reject(error); void release(); }
    };
    let releasePromise: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      // Abort listeners may synchronously reenter release(). Claim it first.
      releasePromise = Promise.resolve();
      releaseProgress();
      options.signal?.removeEventListener("abort", abort);
      if (options.signal) this.listeners--;
      owned.subscribers.delete(token); this.leases--;
      reject(preparationAbort());
      if (owned.subscribers.size) return releasePromise = Promise.resolve();
      if (owned.state === "queued") { owned.finished = true; owned.closed(); }
      if (owned.finished) { this.remove(owned); return releasePromise = Promise.resolve(); }
      // Keep capacity and key ownership until the producer has really settled.
      releasePromise = Promise.race([owned.done, owned.failureBeforeClose]);
      // Abort listeners cannot await; explicit release still receives this same rejection.
      void releasePromise.catch(() => undefined);
      if (owned.state !== "quarantined") owned.state = "draining";
      owned.controller.abort();
      return releasePromise;
    };
    const abort = () => { reject(options.signal?.reason ?? preparationAbort()); void release(); };
    const progress = options.onProgress ? async (value: P) => {
      if (!owned.subscribers.has(token)) return;
      try { await Promise.race([options.onProgress!(structuredClone(value)), progressReleased]); }
      catch (error) { if (owned.subscribers.has(token)) { reject(error); void release(); } }
    } : undefined;
    owned.subscribers.set(token, { resolve: deliver, reject, progress }); this.leases++;
    if (options.signal) { options.signal.addEventListener("abort", abort, { once: true }); this.listeners++; }
    this.measure();
    if (owned.state === "ready") deliver(owned.value!);
    this.drain();
    return { result, coalesced, release };
  }
  private remove(entry: PreparationEntry<T, P>) {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key); this.bytes -= entry.bytes; this.keyBytes -= entry.keyBytes;
    entry.value = undefined;
  }
  private drain() {
    for (const entry of this.entries.values()) {
      if (this.active >= this.limits.maxActive) break;
      if (entry.state !== "queued") continue;
      entry.state = "running"; this.active++; this.started++; this.measure();
      void this.execute(entry);
    }
  }
  private async execute(entry: PreparationEntry<T, P>) {
    try {
      const produced = await entry.produce(entry.controller.signal, async progress => {
        entry.controller.signal.throwIfAborted();
        await Promise.all([...entry.subscribers.values()].map(subscriber => subscriber.progress?.(progress)));
        entry.controller.signal.throwIfAborted();
      });
      entry.controller.signal.throwIfAborted();
      // Never retain the producer's mutable object, or expose the retained object
      // through a lease. The byte accounting refers to this captured value.
      const value = structuredClone(produced);
      const serialized = JSON.stringify(value);
      const bytes = Buffer.byteLength(serialized ?? "null", "utf8");
      if (bytes > this.limits.maxRetainedBytes - this.bytes) this.refuse("RESULT_BUDGET");
      entry.value = value; entry.bytes = bytes; this.bytes += bytes; entry.state = "ready"; this.measure();
      for (const subscriber of entry.subscribers.values()) subscriber.resolve(value);
    } catch (error) {
      entry.state = "failed";
      for (const subscriber of entry.subscribers.values()) subscriber.reject(error);
      if (error instanceof PendingNativeCloseError) {
        entry.state = "quarantined";
        entry.failBeforeClose(error);
        // Public callers fail at the existing stop deadline; ownership retires only on real close.
        await error.closed;
        entry.state = "failed";
      }
    } finally {
      entry.finished = true; this.active--; entry.closed();
      if (!entry.subscribers.size) this.remove(entry);
      this.drain();
    }
  }
}

type SourceFileIdentity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; birthtimeNs: string };
type SourceVersion = { physicalPath: string; identity: SourceFileIdentity };
const SOURCE_HASH_BUFFER_BYTES = 64 * 1024;
const sourceHashIO = { callers: 0, peakCallers: 0, activeIO: 0, peakIO: 0, openHandles: 0, reservedHandles: 0, peakHandles: 0,
  bufferBytes: 0, peakBufferBytes: 0, opens: 0, closes: 0, fullReads: 0, readCalls: 0, bytesRead: 0, metadataCalls: 0, cancelledCallers: 0 };
const sourceHashWork = new MaterialPreparationWorkPool<{ sha256: string }>({ maxActive: 2, maxEntries: 16,
  maxLeases: 64, maxRetainedBytes: 64 * 1024 });
/** Actual file-operation counters and logical work ownership, never an RSS claim. */
export const materialSourceHashSnapshot = () => ({ ...sourceHashIO, work: sourceHashWork.snapshot() });
async function sourceIO<T>(operation: () => Promise<T>): Promise<T> {
  sourceHashIO.activeIO++; sourceHashIO.peakIO = Math.max(sourceHashIO.peakIO, sourceHashIO.activeIO);
  try { return await operation(); } finally { sourceHashIO.activeIO--; }
}
function sourceIdentity(info: BigIntStats): SourceFileIdentity {
  if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("MATERIAL_SOURCE_NOT_BOUNDED_REGULAR_FILE");
  return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs), birthtimeNs: String(info.birthtimeNs) };
}
const sameSourceIdentity = (left: SourceFileIdentity, right: SourceFileIdentity) => JSON.stringify(left) === JSON.stringify(right);
async function readFreshSourceIdentity(path: string, signal?: AbortSignal): Promise<SourceVersion> {
  signal?.throwIfAborted(); sourceHashIO.metadataCalls++;
  const physical = await sourceIO(() => realpath(path));
  signal?.throwIfAborted(); sourceHashIO.metadataCalls++;
  const info = await sourceIO(() => stat(path, { bigint: true }));
  signal?.throwIfAborted();
  return { physicalPath: physical, identity: sourceIdentity(info) };
}
async function readHeldMaterialSource(source: SourceVersion, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // A failed close is visible and still consumes this handle budget.
  if (sourceHashIO.reservedHandles >= 2) throw Error("MATERIAL_SOURCE_HANDLES_BUSY");
  sourceHashIO.reservedHandles++;
  let handle;
  try { handle = await sourceIO(() => open(source.physicalPath, "r")); }
  catch (error) { sourceHashIO.reservedHandles--; throw error; }
  sourceHashIO.opens++; sourceHashIO.openHandles++;
  sourceHashIO.peakHandles = Math.max(sourceHashIO.peakHandles, sourceHashIO.openHandles);
  let buffer: Buffer | undefined;
  try {
    signal.throwIfAborted();
    const held = sourceIdentity(await sourceIO(() => handle.stat({ bigint: true })));
    if (!sameSourceIdentity(held, source.identity)) throw Error("MATERIAL_SOURCE_CHANGED_BEFORE_READ");
    buffer = Buffer.allocUnsafe(SOURCE_HASH_BUFFER_BYTES);
    sourceHashIO.bufferBytes += buffer.length; sourceHashIO.peakBufferBytes = Math.max(sourceHashIO.peakBufferBytes, sourceHashIO.bufferBytes);
    const hash = createHash("sha256"); let bytes = 0;
    for (;;) {
      signal.throwIfAborted(); sourceHashIO.readCalls++;
      const read = await sourceIO(() => handle.read(buffer!, 0, buffer!.length, bytes));
      sourceHashIO.bytesRead += read.bytesRead;
      signal.throwIfAborted();
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > Number(source.identity.size)) throw Error("MATERIAL_SOURCE_GREW_DURING_READ");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = sourceIdentity(await sourceIO(() => handle.stat({ bigint: true })));
    if (bytes !== Number(source.identity.size) || !sameSourceIdentity(after, source.identity)) throw Error("MATERIAL_SOURCE_CHANGED_DURING_READ");
    signal.throwIfAborted(); sourceHashIO.fullReads++;
    return hash.digest("hex");
  } finally {
    if (buffer) sourceHashIO.bufferBytes -= buffer.length;
    await sourceIO(() => handle.close());
    sourceHashIO.closes++; sourceHashIO.openHandles--; sourceHashIO.reservedHandles--;
  }
}

// Tiny magic-byte checks must not retain whole decoded-frame/preview files.
// This implementation is already covered by the canonical material code-input
// registry. It shares neither an idle prefix cache nor caller-owned buffers.
const materialHeaderIO = { reserved: 0, openHandles: 0, peakHandles: 0, opens: 0, closes: 0, bytesRead: 0 };
export const materialHeader8Snapshot = () => ({ ...materialHeaderIO });
export async function readMaterialHeader8(path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (materialHeaderIO.reserved >= 64) throw Error("MATERIAL_HEADER_IO_BACKPRESSURE");
  materialHeaderIO.reserved++;
  let handle;
  try { handle = await open(path, "r"); }
  catch (error) { materialHeaderIO.reserved--; throw error; }
  materialHeaderIO.opens++; materialHeaderIO.openHandles++;
  materialHeaderIO.peakHandles = Math.max(materialHeaderIO.peakHandles, materialHeaderIO.openHandles);
  try {
    signal?.throwIfAborted();
    if (!(await handle.stat()).isFile()) throw Error("MATERIAL_HEADER_NOT_REGULAR_FILE");
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(8); let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      materialHeaderIO.bytesRead += read.bytesRead;
      signal?.throwIfAborted();
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    return bytes.subarray(0, used);
  } finally {
    // A failed close keeps its reservation visible; it is never fake recovery.
    await handle.close(); materialHeaderIO.closes++; materialHeaderIO.openHandles--; materialHeaderIO.reserved--;
    signal?.throwIfAborted();
  }
}

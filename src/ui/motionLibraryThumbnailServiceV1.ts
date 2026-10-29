import { registerMotionLibraryFontBytes } from "../motionLibrary/svg/glyphs";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { composeMotionLibraryFrameV1, type MotionLibraryFrameRequestV1 } from "./motionLibraryFramesV1";
import { missingMotionLibraryFaceV1, motionLibrarySvgDataUrlV1, type MotionLibraryThumbnailWorkerInV1, type MotionLibraryThumbnailWorkerOutV1 } from "./motionLibraryThumbnailProtocolV1";

/**
 * Frame budget for Motion Library thumbnails (PHASE3 GUI): generation runs in one worker (or, without workers, in small
 * main-thread slices), at most two frames in flight, most urgent first (live preview, then the hovered card, then
 * visible stills). Finished frames are handed to the page a few per animation frame, so 160 cards appearing at once
 * never hitch scrolling. Results are cached (LRU) by request.
 */

export const MOTION_LIBRARY_PRIORITY_V1 = Object.freeze({ preview: 0, hover: 1, still: 2, prefetch: 3 });

export interface MotionLibraryThumbnailServiceV1 {
  /** A data URL of the frame. Rejects with AbortError when `signal` aborts before it starts. */
  frame(request: MotionLibraryFrameRequestV1, options?: { priority?: number; signal?: AbortSignal }): Promise<string>;
  /** Already-finished frame, if cached. */
  peek(request: MotionLibraryFrameRequestV1): string | undefined;
  stats(): { readonly generated: number; readonly cached: number; readonly queued: number; readonly worker: boolean; readonly meanMs: number; readonly maxMs: number;
    readonly fonts: ReadonlyArray<{ readonly faceId: string; readonly ms: number; readonly bytes: number }> };
  dispose(): void;
}

interface Pending {
  readonly key: string; readonly request: MotionLibraryFrameRequestV1; priority: number; readonly order: number;
  readonly resolve: (url: string) => void; readonly reject: (error: Error) => void; readonly signal?: AbortSignal;
}

const MAX_IN_FLIGHT = 2, CACHE_LIMIT = 900, DELIVER_PER_FRAME = 4, DELIVER_BUDGET_MS = 5, INLINE_SLICE_MS = 8;
const keyOf = (request: MotionLibraryFrameRequestV1) => JSON.stringify([request.itemId, request.purpose, request.size.width, request.size.height,
  Math.round(request.t * 10000) / 10000, request.params ?? null]);

/** Bundled render faces: the desktop reads them through its bounded IPC; the dev server serves public/fonts. */
export async function loadMotionLibraryFaceBytesV1(faceId: string): Promise<Uint8Array> {
  const desktop = typeof window === "undefined" ? undefined : window.haoDesktop;
  if (desktop?.readBundledFontFace) return desktop.readBundledFontFace(faceId);
  const spec = bundledFontFaceSpec(faceId);
  const base = typeof document === "undefined" ? "http://localhost/" : document.baseURI;
  const response = await fetch(new URL(`fonts/${spec.fontFile}`, base));
  if (!response.ok) throw new Error(`字型 ${faceId} 無法載入（${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
}

function createThumbnailWorker(): Worker | undefined {
  if (typeof Worker === "undefined") return undefined;
  try { return new Worker(new URL("./motionLibraryThumbnail.worker.ts", import.meta.url), { type: "module", name: "editkin-motion-library-thumbnails" }); }
  catch { return undefined; }
}

export function createMotionLibraryThumbnailServiceV1(options: {
  loadFace?: (faceId: string) => Promise<Uint8Array>;
  createWorker?: () => Worker | undefined;
  schedule?: (callback: () => void) => void;
} = {}): MotionLibraryThumbnailServiceV1 {
  const loadFace = options.loadFace ?? loadMotionLibraryFaceBytesV1;
  const schedule = options.schedule ?? ((callback: () => void) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback()); else setTimeout(callback, 16);
  });
  let worker = (options.createWorker ?? createThumbnailWorker)();
  const cache = new Map<string, string>();
  const waiting = new Map<string, Promise<string>>();
  const queue: Pending[] = [];
  const inFlight = new Map<number, Pending>();
  const deliveries: Array<() => void> = [];
  const faceBytes = new Map<string, Promise<Uint8Array>>();
  const inlineFaces = new Set<string>();
  let order = 0, nextId = 1, generated = 0, totalMs = 0, maxMs = 0, disposed = false, deliveryScheduled = false, inlineScheduled = false, inlineBusy = false;

  const remember = (key: string, url: string) => {
    cache.delete(key); cache.set(key, url);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  };
  const deliver = (callback: () => void) => {
    deliveries.push(callback);
    if (deliveryScheduled) return;
    deliveryScheduled = true;
    const flush = () => {
      const started = performance.now();
      for (let count = 0; deliveries.length && count < DELIVER_PER_FRAME && performance.now() - started < DELIVER_BUDGET_MS; count += 1) deliveries.shift()!();
      if (deliveries.length) schedule(flush); else deliveryScheduled = false;
    };
    schedule(flush);
  };
  const fonts: Array<{ faceId: string; ms: number; bytes: number }> = [];
  const bytesFor = (faceId: string) => {
    let promise = faceBytes.get(faceId);
    if (!promise) {
      const started = performance.now();
      promise = loadFace(faceId);
      faceBytes.set(faceId, promise);
      promise.then(bytes => fonts.push({ faceId, ms: Math.round(performance.now() - started), bytes: bytes.byteLength }), () => faceBytes.delete(faceId));
    }
    return promise;
  };
  const finish = (job: Pending, url: string | undefined, error?: Error, ms = 0) => {
    if (url !== undefined) { generated += 1; totalMs += ms; maxMs = Math.max(maxMs, ms); remember(job.key, url); }
    waiting.delete(job.key);
    deliver(() => (url !== undefined ? job.resolve(url) : job.reject(error ?? new Error("frame failed"))));
    pump();
  };
  const takeNext = (): Pending | undefined => {
    for (let index = queue.length - 1; index >= 0; index -= 1) if (queue[index].signal?.aborted) {
      const [dropped] = queue.splice(index, 1); waiting.delete(dropped.key); dropped.reject(new DOMException("Aborted", "AbortError"));
    }
    if (!queue.length) return undefined;
    let best = 0;
    for (let index = 1; index < queue.length; index += 1) {
      const a = queue[index], b = queue[best];
      if (a.priority < b.priority || (a.priority === b.priority && a.order < b.order)) best = index;
    }
    return queue.splice(best, 1)[0];
  };

  const onMessage = (event: MessageEvent<MotionLibraryThumbnailWorkerOutV1>) => {
    const message = event.data;
    if (message.type === "need-font") {
      bytesFor(message.faceId).then(bytes => {
        // The worker asks once per face: hand it the bytes without a main-thread copy (7–13 MB per CJK face) and forget them.
        const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
        const buffer = whole ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
        faceBytes.delete(message.faceId);
        worker?.postMessage({ type: "font", faceId: message.faceId, bytes: buffer } satisfies MotionLibraryThumbnailWorkerInV1, [buffer]);
      }, error => worker?.postMessage({ type: "font", faceId: message.faceId, error: error instanceof Error ? error.message : String(error) } satisfies MotionLibraryThumbnailWorkerInV1));
      return;
    }
    const job = inFlight.get(message.id);
    if (!job) return;
    inFlight.delete(message.id);
    if (message.type === "frame") finish(job, message.url, undefined, message.ms);
    else finish(job, undefined, new Error(message.message));
  };
  worker?.addEventListener("message", onMessage);
  worker?.addEventListener("error", () => {
    // A worker that cannot start (blocked script, old webview) falls back to main-thread slices.
    worker?.terminate(); worker = undefined;
    for (const job of inFlight.values()) queue.push(job);
    inFlight.clear(); pump();
  });

  async function inlineFrame(job: Pending): Promise<void> {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const started = performance.now();
      try { const url = motionLibrarySvgDataUrlV1(composeMotionLibraryFrameV1(job.request)); return finish(job, url, undefined, performance.now() - started); }
      catch (error) {
        const face = missingMotionLibraryFaceV1(error);
        if (!face || inlineFaces.has(face)) return finish(job, undefined, error instanceof Error ? error : new Error(String(error)));
        try { await registerMotionLibraryFontBytes(face, await bytesFor(face)); inlineFaces.add(face); }
        catch (failure) { return finish(job, undefined, failure instanceof Error ? failure : new Error(String(failure))); }
      }
    }
    finish(job, undefined, new Error("too many font requests for one frame"));
  }

  function pump(): void {
    if (disposed) return;
    if (worker) {
      while (inFlight.size < MAX_IN_FLIGHT) {
        const job = takeNext();
        if (!job) return;
        const id = nextId++;
        inFlight.set(id, job);
        worker.postMessage({ type: "frame", id, request: job.request } satisfies MotionLibraryThumbnailWorkerInV1);
      }
      return;
    }
    if (inlineScheduled || inlineBusy || !queue.length) return;
    inlineScheduled = true;
    schedule(() => void (async () => {
      inlineScheduled = false;
      const started = performance.now();
      inlineBusy = true;
      // One or more generators per slice, never starting another after the slice budget.
      try {
        while (!disposed && performance.now() - started < INLINE_SLICE_MS) {
          const job = takeNext();
          if (!job) break;
          await inlineFrame(job);
        }
      } finally { inlineBusy = false; }
      pump();
    })());
  }

  return {
    frame(request, frameOptions = {}) {
      if (disposed) return Promise.reject(new Error("thumbnail service disposed"));
      const key = keyOf(request), cached = cache.get(key);
      if (cached) { remember(key, cached); return Promise.resolve(cached); }
      const priority = frameOptions.priority ?? MOTION_LIBRARY_PRIORITY_V1.still;
      const existing = waiting.get(key);
      if (existing) {
        const queued = queue.find(job => job.key === key);
        if (queued && priority < queued.priority) queued.priority = priority;
        return existing;
      }
      if (frameOptions.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      const promise = new Promise<string>((resolve, reject) => {
        queue.push({ key, request, priority, order: order++, resolve, reject, signal: frameOptions.signal });
      });
      waiting.set(key, promise);
      promise.catch(() => undefined);
      pump();
      return promise;
    },
    peek: request => cache.get(keyOf(request)),
    stats: () => ({ generated, cached: cache.size, queued: queue.length, worker: Boolean(worker), meanMs: generated ? totalMs / generated : 0, maxMs, fonts: [...fonts] }),
    dispose() {
      disposed = true; worker?.terminate(); worker = undefined;
      for (const job of queue.splice(0)) job.reject(new DOMException("Aborted", "AbortError"));
    },
  };
}

let shared: MotionLibraryThumbnailServiceV1 | undefined;
/** One service per editor window: the worker and its parsed fonts are shared by the panel and the inspector. */
export function sharedMotionLibraryThumbnailServiceV1(): MotionLibraryThumbnailServiceV1 {
  if (!shared) {
    shared = createMotionLibraryThumbnailServiceV1();
    // Development builds expose the live counters for the performance checks (frame budget, font loads).
    if (import.meta.env?.DEV) (globalThis as { __editkinMotionLibraryThumbnails?: MotionLibraryThumbnailServiceV1 }).__editkinMotionLibraryThumbnails = shared;
  }
  return shared;
}

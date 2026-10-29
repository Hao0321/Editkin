import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { Mesh3dGeometryCache } from "./mesh3dGeometry";
import type { Mesh3dScene } from "./mesh3dScene";
import { mesh3dKernelFactoryV1, type Mesh3dKernelJobV1 } from "./mesh3dKernel";
import { mesh3dPlanFrameV1, type Mesh3dAllocatorV1, type Mesh3dFrame, type Mesh3dRasterOptionsV1, type Mesh3dTexture } from "./mesh3dFramePlan";
import { mesh3dFrameRequestV1 } from "./mesh3dRasterizer";
import { renderMesh3dProjectFrameAsyncV1 } from "./mesh3dProjectFrameV1";

/**
 * Worker-thread mesh3d renderer for Node (export path; polish 2026-10-23).
 *
 * The calling thread plans the frame (poses, vertices, ordering, validation) into
 * shared memory; every worker runs the same kernel (mesh3dKernel.ts) and takes row
 * bands, quarter rows or columns from shared per-phase counters, with a barrier
 * between phases. Each pixel is produced by one work item with the arithmetic of the
 * single-thread renderer, so frames are byte-identical to renderMesh3dFrame for any
 * thread count (mesh3dParallel.test.ts). Workers are evaluated from the kernel's source
 * text, so bundling needs no extra entry point.
 */
export interface Mesh3dWorkerPoolOptionsV1 { threads?: number; }
const CONTROL = 16, PHASES = 1024;
type Typed = Float64Array | Float32Array | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Int32Array;
type Ctor<T extends Typed = Typed> = { new (length: number): T; new (buffer: ArrayBufferLike, byteOffset: number, length: number): T; BYTES_PER_ELEMENT: number; name: string };

/**
 * Default worker count: one per logical core but the calling thread, at most 12. Measured on a 12-core /
 * 24-thread machine, 10–16 workers were equally fast and 23 slower (barrier waits, SMT siblings, other load).
 */
export function mesh3dDefaultThreadsV1(): number { return Math.max(1, Math.min(12, availableParallelism() - 1)); }

/** Worker body; evaluated as source text with the kernel factory in scope as `FACTORY`. */
function workerMain(FACTORY: () => ReturnType<typeof mesh3dKernelFactoryV1>, CONTROL_SLOTS: number, PHASE_COUNT: number) {
  // getBuiltinModule, not require: bundlers rewrite require() into helpers that do not exist in this eval'd source.
  const { parentPort: port, workerData } = process.getBuiltinModule("node:worker_threads") as typeof import("node:worker_threads");
  if (!port) throw new Error("MESH_PARALLEL_NOT_A_WORKER");
  const parentPort = port;
  const kernel = FACTORY(), ctl = new Int32Array(workerData.control), size = workerData.size as number;
  const ctors: Record<string, new (buffer: ArrayBufferLike, offset: number, length: number) => unknown> = {
    Float64Array, Float32Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array };
  const revive = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(revive);
    const record = value as Record<string, unknown>;
    if (typeof record.$t === "string") return new ctors[record.$t](record.b as ArrayBufferLike, record.o as number, record.n as number);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) out[key] = revive(record[key]);
    return out;
  };
  let waited = 0, mark = 0;
  const segments: number[] = [];
  const sync = () => {
    const started = performance.now();
    segments.push(started - mark);
    try { barrier(); } finally { mark = performance.now(); waited += mark - started; }
  };
  const barrier = () => {
    const generation = Atomics.load(ctl, 1);
    if (Atomics.add(ctl, 0, 1) === size - 1) { Atomics.store(ctl, 0, 0); Atomics.add(ctl, 1, 1); Atomics.notify(ctl, 1); return; }
    let spins = 0;
    while (Atomics.load(ctl, 1) === generation) {
      if (Atomics.load(ctl, 2)) throw new Error("MESH_PARALLEL_ABORTED");
      if (++spins < 4000) continue;
      Atomics.wait(ctl, 1, generation, 20);
    }
  };
  parentPort.on("message", (message: { id: number; job: unknown }) => {
    try {
      const started = performance.now(), job = revive(message.job), ctx = { ctl, phaseBase: CONTROL_SLOTS, maxPhases: PHASE_COUNT, phase: 0, sync };
      waited = 0; mark = started; segments.length = 0;
      const rasterized = kernel.runFrame(job as never, ctx);
      parentPort.postMessage({ id: message.id, rasterized, busy: performance.now() - started - waited, phases: ctx.phase, segments: segments.slice() });
    } catch (error) {
      Atomics.store(ctl, 2, 1); Atomics.notify(ctl, 1);
      parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

interface Chunk { buffer: SharedArrayBuffer; offset: number; }
/** Shared-memory allocator: a bump arena per frame, named persistent buffers for scratch and outputs. */
class SharedAllocator implements Mesh3dAllocatorV1 {
  private chunks: Chunk[] = [{ buffer: new SharedArrayBuffer(64 << 20), offset: 0 }];
  private used = 0;
  private readonly named = new Map<string, Typed>();
  bytes(): number { return this.chunks.reduce((n, c) => n + c.buffer.byteLength, 0) + [...this.named.values()].reduce((n, t) => n + t.byteLength, 0); }
  reset(): void {
    if (this.chunks.length > 1) this.chunks = [{ buffer: new SharedArrayBuffer(Math.ceil(this.used * 1.25 / 65536) * 65536), offset: 0 }];
    this.chunks[0].offset = 0; this.used = 0;
  }
  private take<T extends Typed>(ctor: Ctor<T>, length: number): T {
    const bytes = length * ctor.BYTES_PER_ELEMENT;
    let chunk = this.chunks[this.chunks.length - 1], start = Math.ceil(chunk.offset / 8) * 8;
    if (start + bytes > chunk.buffer.byteLength) {
      chunk = { buffer: new SharedArrayBuffer(Math.max(chunk.buffer.byteLength * 2, Math.ceil(bytes / 65536) * 65536)), offset: 0 };
      this.chunks.push(chunk); start = 0;
    }
    chunk.offset = start + bytes; this.used += bytes + 8;
    return new ctor(chunk.buffer, start, length);
  }
  frame<T extends Typed>(ctor: Ctor<T>, length: number): T { const view = this.take(ctor, length); view.fill(0); return view; }
  share<T extends Typed>(source: T): T { const view = this.take(source.constructor as Ctor<T>, source.length); view.set(source as never); return view; }
  scratch<T extends Typed>(name: string, ctor: Ctor<T>, length: number): T {
    const found = this.named.get(name);
    if (found instanceof ctor && found.length === length) return found as T;
    const created = new ctor(new SharedArrayBuffer(Math.max(8, length * ctor.BYTES_PER_ELEMENT)), 0, length); this.named.set(name, created); return created;
  }
  output<T extends Typed>(name: string, ctor: Ctor<T>, length: number): T { return this.scratch(`out:${name}`, ctor, length); }
  result<T extends Typed>(buffer: T): T { return new (buffer.constructor as Ctor<T>)(buffer as never); }
}
/** Job → structured-clone message: typed arrays travel as shared-memory references. */
function encode(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as Typed;
    if (!(view.buffer instanceof SharedArrayBuffer)) {
      if (view.length === 0) return { $t: view.constructor.name, b: new SharedArrayBuffer(8), o: 0, n: 0 };
      throw new Error("MESH_PARALLEL_UNSHARED_ARRAY");
    }
    return { $t: view.constructor.name, b: view.buffer, o: view.byteOffset, n: view.length };
  }
  if (Array.isArray(value)) return value.map(encode);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = encode(item);
  return out;
}

export class Mesh3dWorkerPoolV1 {
  readonly threads: number;
  private readonly workers: Worker[] = [];
  private readonly control = new SharedArrayBuffer((CONTROL + PHASES) * 4);
  private readonly ctl = new Int32Array(this.control);
  private readonly alloc = new SharedAllocator();
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { remaining: number; rasterized: number; errors: string[]; resolve: (n: number) => void; reject: (e: Error) => void };
  private broken?: Error;
  private frameId = 0;
  private closing = false;
  /** Diagnostics of the last frame: planning on the calling thread, worker kernel and copying the result out (ms). */
  lastTimings = { plan: 0, kernel: 0, finish: 0 };
  /** Diagnostics of the last frame: per-worker busy time (not waiting at a barrier), phase count and the time spent before each barrier. */
  lastWorkers: { busy: number[]; phases: number; segments: number[][] } = { busy: [], phases: 0, segments: [] };

  constructor(options: Mesh3dWorkerPoolOptionsV1 = {}) {
    const threads = options.threads ?? mesh3dDefaultThreadsV1();
    if (!Number.isInteger(threads) || threads < 1 || threads > 64) throw new Error("MESH_PARALLEL_THREADS_INVALID");
    this.threads = threads;
    // `__name`: esbuild's keepNames helper (tsx / dev builds wrap functions in it); defined here because the source runs outside its module.
    const source = `"use strict";const __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});
(${workerMain.toString()})((${mesh3dKernelFactoryV1.toString()}), ${CONTROL}, ${PHASES});`;
    for (let rank = 0; rank < threads; rank++) {
      const worker = new Worker(source, { eval: true, workerData: { control: this.control, rank, size: threads } });
      worker.unref();
      worker.on("message", (message: { id: number; rasterized?: number; error?: string }) => this.settle(message));
      worker.on("error", error => this.fail(error));
      worker.on("exit", code => { if (!this.closing) this.fail(new Error(`MESH_PARALLEL_WORKER_EXIT ${code}`)); });
      this.workers.push(worker);
    }
  }
  /** Shared memory currently held (frame arena, scratch and output buffers). */
  sharedBytes(): number { return this.alloc.bytes() + this.control.byteLength; }
  private settle(message: { id: number; rasterized?: number; error?: string; busy?: number; phases?: number; segments?: number[] }): void {
    const pending = this.pending;
    if (!pending || message.id !== this.frameId) return;
    if (pending.remaining === this.threads) this.lastWorkers = { busy: [], phases: message.phases ?? 0, segments: [] };
    this.lastWorkers.busy.push(message.busy ?? 0); this.lastWorkers.segments.push(message.segments ?? []);
    if (message.error !== undefined) pending.errors.push(message.error); else pending.rasterized += message.rasterized ?? 0;
    if (--pending.remaining > 0) return;
    this.pending = undefined;
    const real = pending.errors.find(e => e !== "MESH_PARALLEL_ABORTED") ?? pending.errors[0];
    if (real !== undefined) pending.reject(new Error(real)); else pending.resolve(pending.rasterized);
  }
  private fail(error: Error): void {
    this.broken ??= error;
    Atomics.store(this.ctl, 2, 1); Atomics.notify(this.ctl, 1);
    const pending = this.pending; this.pending = undefined;
    pending?.reject(error);
  }
  private run(job: Mesh3dKernelJobV1): Promise<number> {
    if (this.broken) return Promise.reject(this.broken);
    const message = { id: ++this.frameId, job: encode(job) };
    this.ctl.fill(0, 0, 1); this.ctl.fill(0, 2, 3); this.ctl.fill(0, CONTROL, CONTROL + PHASES);
    // Workers are unref'd between frames (an idle pool never keeps the process alive) and ref'd while one renders.
    for (const worker of this.workers) worker.ref();
    return new Promise<number>((resolve, reject) => {
      this.pending = { remaining: this.threads, rasterized: 0, errors: [], resolve, reject };
      for (const worker of this.workers) worker.postMessage(message);
    }).finally(() => { for (const worker of this.workers) worker.unref(); });
  }
  /** renderMesh3dFrame on the worker threads (same arguments, same bytes). Frames render one at a time, in call order. */
  render(scene: Mesh3dScene, time: number, width: number, height: number, cache: Mesh3dGeometryCache,
    textures = new Map<string, Mesh3dTexture>(), options: Mesh3dRasterOptionsV1 = {}): Promise<Mesh3dFrame> {
    const result = this.queue.then(async () => {
      const begin = performance.now();
      const request = mesh3dFrameRequestV1(scene, time, width, height, cache);
      this.alloc.reset();
      const plan = mesh3dPlanFrameV1(scene, request.passes, width, height, textures, options, request.post, this.alloc);
      const planned = performance.now(), rasterized = await this.run(plan.job), rendered = performance.now();
      const frame = plan.finish(rasterized);
      this.lastTimings = { plan: planned - begin, kernel: rendered - planned, finish: performance.now() - rendered };
      return frame;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  /** renderMesh3dProjectFrameV1 (the export adapter, including world-anchored overlays) on the worker threads. */
  renderProjectFrame(scene: Mesh3dScene, clock: { timelineFrame: number; fps: number }, width: number, height: number, cache: Mesh3dGeometryCache,
    textures = new Map<string, Mesh3dTexture>(), legacySeconds = clock.timelineFrame / clock.fps): Promise<Mesh3dFrame> {
    return renderMesh3dProjectFrameAsyncV1(scene, clock, width, height, cache, textures, legacySeconds, (s, t, w, h, c, x, o) => this.render(s, t, w, h, c, x, o));
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.queue;
    await Promise.all(this.workers.map(w => w.terminate()));
  }
}

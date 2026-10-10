import { bundledFontFaceSpec, type BundledFontFaceSpec } from "./bundledFontCatalog";
import { acquireMotionFontDelivery, motionFontSurface, MOTION_FONT_DELIVERY_TIMEOUT_MS, type MotionFontSurface } from "./motionFontDelivery";
import type { MotionFontSelection } from "./motionFontReadiness";
import { assertPreparedGlyphRun, prepareGlyphRun, PREPARED_GLYPH_MAX_CODE_POINTS, PREPARED_GLYPH_MAX_FONT_BYTES, type PreparedGlyphRun } from "./preparedGlyphRun";

export const MOTION_TEMPLATE_TEXT_TIMEOUT_MS = 10_000;
export const MOTION_TEMPLATE_TEXT_MAX_RUNS = 64;
export const MOTION_TEMPLATE_TEXT_CONCURRENCY = 2;
export const MOTION_TEMPLATE_TEXT_MAX_CACHED_FACES = 2;

export interface MotionTemplateTextPreparer {
  prepareText(faceId: string, text: string): Promise<PreparedGlyphRun>;
  dispose(): void;
}

interface Work {
  readonly controller: AbortController;
  readonly check: () => void;
  readonly execute: () => Promise<PreparedGlyphRun>;
  readonly complete: (run: PreparedGlyphRun) => void;
  readonly fail: (error: unknown) => void;
}
// Shared actual work slots include cancelled readers/parsers until their real
// promise settles. A timeout is not evidence that fetch or parsing stopped.
const waiting: Work[] = [];
const outstanding = new Set<Work>();
let running = 0;
interface WebContext { owner: Window; origin: string; url: string }
interface VerifiedBytes { context: WebContext; faceId: string; sha256: string; manifestSha256: string; bytes: Uint8Array }
// Only completed, factory-verified bytes are shared. At most two faces/32MiB;
// requests, parser work and cancellation ownership are never shared here.
const verifiedBytes: VerifiedBytes[] = [];
function pump(): void {
  while (running < MOTION_TEMPLATE_TEXT_CONCURRENCY && waiting.length) {
    const work = waiting.shift()!;
    try { work.check(); } catch (error) { work.fail(error); outstanding.delete(work); continue; }
    running++;
    void work.execute().then(run => {
      work.check(); work.complete(run);
    }).catch(work.fail).finally(() => { running--; outstanding.delete(work); pump(); });
  }
}

function selectionFor(spec: BundledFontFaceSpec, text: string): MotionFontSelection {
  // Catalog aliases are physical identities, not logical names accepted by
  // resolveBundledFontFace. Construct only from the compiled known-ID spec.
  return Object.freeze({ family: spec.fontFamily, weight: spec.fontWeight, text,
    selectionKey: JSON.stringify([spec.fontFamily, spec.fontWeight, text, spec.faceId, spec.fontFile]),
    face: Object.freeze({ faceId: spec.faceId, fontFamily: spec.fontFamily, fontWeight: spec.fontWeight,
      fontFile: spec.fontFile, requestedWeight: spec.fontWeight, weightSubstituted: false }) });
}

function webContext(spec: BundledFontFaceSpec): WebContext {
  if (typeof window === "undefined" || !window.location || typeof globalThis.fetch !== "function") {
    throw new Error("binary glyph 來源缺少 same-origin location／fetch 介面");
  }
  const page = new URL(window.location.href);
  if (!/^(https?:)$/.test(page.protocol) || page.origin === "null"
    || !/^render\/EditkinFace-[a-z0-9-]+\.ttf$/.test(spec.fontFile)) {
    throw new Error("binary glyph 來源需要可驗證的 same-origin compiled font 路徑");
  }
  return { owner: window, origin: page.origin, url: new URL(`/fonts/${spec.fontFile}`, page.origin).href };
}

function checkWebContext(context: WebContext, check: () => void): void {
  check();
  if (typeof window === "undefined" || window !== context.owner || new URL(window.location.href).origin !== context.origin) {
    throw new Error("binary glyph same-origin context 已變更");
  }
}

function cachedWebBytes(context: WebContext, spec: BundledFontFaceSpec): Uint8Array | undefined {
  const index = verifiedBytes.findIndex(entry => entry.context.owner === context.owner && entry.context.origin === context.origin
    && entry.faceId === spec.faceId && entry.sha256 === spec.sha256 && entry.manifestSha256 === spec.manifestSha256);
  if (index < 0) return undefined;
  const [entry] = verifiedBytes.splice(index, 1); verifiedBytes.push(entry);
  return Uint8Array.from(entry.bytes);
}

function retainWebBytes(context: WebContext, spec: BundledFontFaceSpec, bytes: Uint8Array): void {
  const duplicate = verifiedBytes.findIndex(entry => entry.context.owner === context.owner && entry.context.origin === context.origin && entry.faceId === spec.faceId);
  if (duplicate >= 0) verifiedBytes.splice(duplicate, 1);
  while (verifiedBytes.length >= MOTION_TEMPLATE_TEXT_MAX_CACHED_FACES) verifiedBytes.shift();
  verifiedBytes.push({ context, faceId: spec.faceId, sha256: spec.sha256, manifestSha256: spec.manifestSha256, bytes: Uint8Array.from(bytes) });
}

async function readWebFace(spec: BundledFontFaceSpec, signal: AbortSignal, check: () => void): Promise<Uint8Array> {
  const context = webContext(spec);
  const sameOrigin = () => checkWebContext(context, check);
  sameOrigin();
  const response = await globalThis.fetch(context.url, { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store", signal });
  sameOrigin();
  if (!response.ok || response.redirected || !response.url || new URL(response.url).href !== context.url
    || response.type === "opaque" || response.type === "opaqueredirect" || response.type === "cors") {
    throw new Error("binary glyph 來源不是所選 same-origin compiled font response");
  }
  const size = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity";
  if (!["identity", "gzip", "br", "deflate"].includes(encoding)) throw new Error("binary glyph 來源 Content-Encoding 不受支援");
  if (size !== null && (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) > PREPARED_GLYPH_MAX_FONT_BYTES)) {
    throw new Error("binary glyph 來源超過 16MiB 或宣告長度不合法");
  }
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("binary glyph 來源缺少有界串流介面");
  const reader = response.body.getReader();
  let buffer = new Uint8Array(Math.min(PREPARED_GLYPH_MAX_FONT_BYTES, 64 * 1024));
  let total = 0, finished = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      sameOrigin();
      const next = await reader.read();
      sameOrigin();
      if (next.done) { finished = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > PREPARED_GLYPH_MAX_FONT_BYTES - total) throw new Error("binary glyph 來源超過 16MiB");
      const required = total + next.value.byteLength;
      if (required > buffer.byteLength) {
        const larger = new Uint8Array(Math.min(PREPARED_GLYPH_MAX_FONT_BYTES, Math.max(required, buffer.byteLength * 2)));
        larger.set(buffer.subarray(0, total)); buffer = larger;
      }
      // One bounded growing buffer, not an unbounded collection of tiny chunks.
      buffer.set(next.value, total); total = required;
    }
    // Fetch exposes decoded chunks; compressed Content-Length is a transport
    // count, not the decoded font size. Both are capped; only identity matches.
    if (total < 12 || (encoding === "identity" && size !== null && total !== Number(size))) throw new Error("binary glyph 來源長度與實際字節不符");
    sameOrigin(); return buffer.slice(0, total);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

/** Exact glyph preparation only, not artwork or browser FontFaceSet readiness.
 * No caller URL, digest, parser object, font bytes or estimated fallback exists.
 * Limits are per preparer retained runs and shared outstanding/actual work.
 * Synchronous parsing is checked before/after; it cannot be hard-preempted. */
export function createMotionTemplateTextPreparer(options: { signal?: AbortSignal; surface?: MotionFontSurface } = {}): MotionTemplateTextPreparer {
  const surface = options.surface ?? (typeof window === "undefined" ? undefined : window);
  const kind = motionFontSurface(surface);
  const requests = new Map<string, { promise: Promise<PreparedGlyphRun>; cancel: () => void; context?: WebContext }>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; options.signal?.removeEventListener("abort", dispose);
    for (const request of requests.values()) request.cancel();
    requests.clear();
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  if (options.signal?.aborted) dispose();
  return Object.freeze({ prepareText(faceId: string, text: string): Promise<PreparedGlyphRun> {
    try {
      if (disposed) throw new Error("Motion template glyph preparer 已取消／釋放");
      const spec = bundledFontFaceSpec(faceId);
      if (typeof text !== "string" || !text.trim() || text.includes("\r") || text.length > PREPARED_GLYPH_MAX_CODE_POINTS * 2
        || [...text].length > PREPARED_GLYPH_MAX_CODE_POINTS) throw new Error("Motion template glyph 需要有界 exact text（最多256 codepoints，不含 CR）");
      const context = kind === "web" ? webContext(spec) : undefined;
      const key = JSON.stringify([faceId, text]), existing = requests.get(key);
      if (existing) {
        if (existing.context) checkWebContext(existing.context, () => {});
        return existing.promise;
      }
      if (requests.size >= MOTION_TEMPLATE_TEXT_MAX_RUNS || outstanding.size >= MOTION_TEMPLATE_TEXT_MAX_RUNS) throw new Error("Motion template glyph 請求超過64個有界 run");
      const controller = new AbortController(), deadline = performance.now() + MOTION_TEMPLATE_TEXT_TIMEOUT_MS;
      let terminal = false, timer: ReturnType<typeof setTimeout> | undefined;
      let resolve!: (run: PreparedGlyphRun) => void, reject!: (error: unknown) => void;
      const promise = new Promise<PreparedGlyphRun>((yes, no) => { resolve = yes; reject = no; });
      const fail = (error: unknown) => {
        if (terminal) return; terminal = true;
        if (timer !== undefined) clearTimeout(timer);
        controller.abort(); reject(error);
      };
      const check = () => {
        if (disposed || controller.signal.aborted) throw new Error("Motion template glyph 請求已取消／釋放");
        if (performance.now() >= deadline) throw new Error("Motion template glyph binary glyph 來源準備逾時（10s）");
      };
      const work: Work = { controller, check, fail, complete(run) {
        check(); assertPreparedGlyphRun(run);
        if (run.faceId !== spec.faceId || run.text !== text || run.fontSha256 !== spec.sha256 || run.manifestSha256 !== spec.manifestSha256) throw new Error("Motion template glyph run 與 exact source identity 不符");
        if (terminal) return; terminal = true; if (timer !== undefined) clearTimeout(timer); resolve(run);
      }, async execute() {
        check();
        if (kind === "web") {
          checkWebContext(context!, check);
          const cached = cachedWebBytes(context!, spec);
          const bytes = cached ?? await readWebFace(spec, controller.signal, check);
          checkWebContext(context!, check);
          const run = await prepareGlyphRun(faceId, text, bytes);
          checkWebContext(context!, check);
          if (!cached) retainWebBytes(context!, spec, bytes);
          return run;
        }
        const desktop = surface?.haoDesktop;
        const lease = acquireMotionFontDelivery(selectionFor(spec, text), { signal: controller.signal, prepareGlyphs: true,
          timeoutMs: Math.max(1, Math.min(MOTION_FONT_DELIVERY_TIMEOUT_MS, Math.floor(deadline - performance.now()))),
          ...(desktop?.readBundledFontFace ? { readFace: desktop.readBundledFontFace.bind(desktop) } : {}) });
        try {
          const receipt = await lease.ready; check();
          if (receipt.status !== "registered" || !lease.isRegistered() || !receipt.glyphRun) throw new Error(receipt.reason ?? "Motion template glyph 缺少有效 desktop registration／實體 run");
          return receipt.glyphRun;
        } finally { lease.release(); }
      } };
      requests.set(key, { promise, context, cancel: () => fail(new Error("Motion template glyph preparer 已取消／釋放")) });
      timer = setTimeout(() => fail(new Error("Motion template glyph binary glyph 來源準備逾時（10s）")), MOTION_TEMPLATE_TEXT_TIMEOUT_MS);
      outstanding.add(work); waiting.push(work); pump();
      return promise;
    } catch (error) { return Promise.reject(error); }
  }, dispose });
}

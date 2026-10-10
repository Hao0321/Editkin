import { bundledFontFaceSpec, type BundledFontFaceSpec } from "./bundledFontCatalog";
import { cssFontFamily } from "./fontFaces";
import { currentMotionFontReadiness, type MotionFontSelection } from "./motionFontReadiness";
import { prepareGlyphRun, PREPARED_GLYPH_MAX_CODE_POINTS, type PreparedGlyphRun } from "./preparedGlyphRun";

export const MOTION_FONT_DELIVERY_MAX_BYTES = 16 * 1024 * 1024;
export const MOTION_FONT_DELIVERY_CONCURRENCY = 2;
export const MOTION_FONT_DELIVERY_MAX_FACES = 8;
export const MOTION_FONT_DELIVERY_MAX_WAITING_FACES = 43;
export const MOTION_FONT_DELIVERY_LOOKAHEAD_FACES = 6;
export const MOTION_FONT_DELIVERY_TIMEOUT_MS = 5000;
export const MOTION_FONT_LOOKAHEAD_SECONDS = 5;
export const MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS = 4;
export const MOTION_FONT_DELIVERY_MAX_WAITING_GLYPH_TEXTS = 4;

export interface MotionFontSurface {
  readonly haoDesktop?: { readonly isDesktop?: boolean; readonly readBundledFontFace?: (faceId: string) => Promise<Uint8Array> };
  readonly __TAURI_INTERNALS__?: unknown;
}

/** A desktop missing its new API must never be reclassified as static web. */
export function motionFontSurface(surface: MotionFontSurface | undefined = typeof window === "undefined" ? undefined : window): "desktop" | "web" {
  return surface && (surface.haoDesktop !== undefined || surface.__TAURI_INTERNALS__ !== undefined) ? "desktop" : "web";
}

/** Static CSS belongs to the declared web surface; desktop uses selected binary
 * resources. This does not certify production web staging of static TTFs. */
export async function bootstrapMotionFontCss(surface: MotionFontSurface | undefined, loadWebCss: () => Promise<unknown>): Promise<void> {
  if (motionFontSurface(surface) === "web") await loadWebCss();
}

export function motionFontInLookahead(range: { timelineStart: number; duration: number }, playhead: number): boolean {
  return Number.isFinite(playhead) && Number.isFinite(range.timelineStart) && Number.isFinite(range.duration)
    && playhead >= 0 && range.duration > 0 && range.timelineStart <= playhead + MOTION_FONT_LOOKAHEAD_SECONDS
    && range.timelineStart + range.duration > playhead;
}

export interface MotionFontDeliveryReceipt {
  readonly selectionKey: string;
  readonly status: "registered" | "blocked" | "cancelled" | "unverified" | "not-required";
  readonly faceId?: string;
  readonly manifestSha256?: string;
  readonly reason?: string;
  /** Factory-owned exact-text run; registration alone never supplies contours. */
  readonly glyphRun?: PreparedGlyphRun;
}
export interface MotionFontDeliveryLease {
  readonly selectionKey: string;
  readonly ready: Promise<MotionFontDeliveryReceipt>;
  /** A completed promise cannot authorize rendering after this lease releases. */
  isRegistered(): boolean;
  setPriority(priority: "current" | "lookahead"): void;
  release(): void;
}
export interface MotionFontDeliveryOptions {
  readonly document?: Pick<Document, "fonts">;
  readonly readFace?: (faceId: string) => Promise<Uint8Array>;
  readonly FontFaceConstructor?: typeof FontFace;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly priority?: "current" | "lookahead";
  readonly prepareGlyphs?: boolean;
}

type EntryOutcome = { status: "registered" | "blocked" | "cancelled"; reason?: string };
type GlyphOutcome = { status: "prepared"; run: PreparedGlyphRun } | { status: "blocked" | "cancelled"; reason: string };
interface GlyphRequest {
  readonly text: string;
  readonly tokens: Map<object, "current" | "lookahead">;
  readonly ready: Promise<GlyphOutcome>;
  readonly settle: (outcome: GlyphOutcome) => void;
  settled: boolean;
  working: boolean;
  admitted: boolean;
}
interface Entry {
  readonly registry: Registry;
  readonly spec: BundledFontFaceSpec;
  readonly reader: (faceId: string) => Promise<Uint8Array>;
  readonly constructor: typeof FontFace;
  readonly tokens: Map<object, "current" | "lookahead">;
  readonly ready: Promise<EntryOutcome>;
  readonly settle: (outcome: EntryOutcome) => void;
  readonly glyphs: Map<string, GlyphRequest>;
  valid: boolean;
  started: boolean;
  working: boolean;
  settled: boolean;
  registered: boolean;
  face?: FontFace;
  /** One owned verified view, never exposed. At most 8 * 16MiB retained. */
  bytes?: Uint8Array<ArrayBuffer>;
  failure?: string;
}
interface Registry {
  readonly document: Pick<Document, "fonts">;
  readonly entries: Map<string, Entry>;
  /** Includes cancelled, actually running work until its real settlement. */
  readonly retained: Set<Entry>;
  readonly queue: Entry[];
  readonly waiting: Entry[];
  running: number;
}
const registries = new WeakMap<object, Registry>();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function terminal(selection: MotionFontSelection, status: MotionFontDeliveryReceipt["status"], reason?: string): MotionFontDeliveryLease {
  return { selectionKey: selection.selectionKey, ready: Promise.resolve({ selectionKey: selection.selectionKey, status,
    ...(reason ? { reason } : {}) }), isRegistered: () => false, setPriority: () => {}, release: () => {} };
}
function live(entry: Entry): boolean {
  return entry.valid && entry.tokens.size > 0 && entry.registry.entries.get(entry.spec.faceId) === entry;
}
function membership(entry: Entry): boolean | undefined {
  try { return !!entry.face && entry.registry.document.fonts.has(entry.face); }
  catch { return undefined; }
}
const present = (entry: Entry) => membership(entry) === true;
function finishEntry(entry: Entry, outcome: EntryOutcome) {
  if (!entry.settled) {
    entry.settled = true;
    if (outcome.status !== "registered") entry.failure = outcome.reason ?? "實體字型 registration 受阻";
    entry.settle(outcome);
  }
}
function finishGlyph(request: GlyphRequest, outcome: GlyphOutcome) {
  if (!request.settled) { request.settled = true; request.settle(outcome); }
}
const glyphPriorityRank = (request: GlyphRequest) => [...request.tokens.values()].includes("current") ? 0 : 1;
function admitGlyphs(entry: Entry) {
  let admitted = [...entry.glyphs.values()].filter(request => request.admitted && request.tokens.size > 0).length;
  const waiting = [...entry.glyphs.values()].filter(request => !request.admitted && request.tokens.size > 0)
    .sort((a, b) => glyphPriorityRank(a) - glyphPriorityRank(b));
  for (const request of waiting) {
    if (admitted >= MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS) break;
    request.admitted = true; admitted++;
  }
}
function pendingGlyph(entry: Entry): GlyphRequest | undefined {
  return [...entry.glyphs.values()].filter(request => request.admitted && !request.settled && !request.working && request.tokens.size > 0)
    .sort((a, b) => glyphPriorityRank(a) - glyphPriorityRank(b))[0];
}
function queueGlyph(entry: Entry) {
  if (!live(entry)) return;
  admitGlyphs(entry);
  if (entry.registered && !entry.working && pendingGlyph(entry) && !entry.registry.queue.includes(entry)) entry.registry.queue.push(entry);
}
function releaseEntry(entry: Entry) {
  entry.valid = false;
  if (entry.registry.entries.get(entry.spec.faceId) === entry) entry.registry.entries.delete(entry.spec.faceId);
  const queued = entry.registry.queue.indexOf(entry);
  if (queued >= 0) entry.registry.queue.splice(queued, 1);
  const waiting = entry.registry.waiting.indexOf(entry);
  if (waiting >= 0) entry.registry.waiting.splice(waiting, 1);
  entry.bytes = undefined;
  for (const request of entry.glyphs.values()) finishGlyph(request, { status: "cancelled", reason: "glyph lease 已釋放" });
  entry.glyphs.clear();
  // Ownership is the FontFace object, never an alias-wide delete. Another
  // graphic's lease for this entry prevents this path from running at all.
  if (entry.face && (entry.registered || membership(entry) !== false)) {
    try { entry.registry.document.fonts.delete(entry.face); } catch { /* Remain retained and refuse unbounded replacements. */ }
  }
  entry.registered = false;
  if (!entry.working && membership(entry) === false) entry.registry.retained.delete(entry);
  if (!entry.started) finishEntry(entry, { status: "cancelled", reason: "字型已離開預載範圍" });
}
function assertLive(entry: Entry) {
  if (!live(entry)) throw new Error("字型 lease 已釋放；晚到結果未註冊");
}
function exactFace(face: FontFace, spec: BundledFontFaceSpec): boolean {
  return [spec.fontFamily, cssFontFamily(spec.fontFamily), `'${spec.fontFamily}'`].includes(face.family)
    && (face.weight === String(spec.fontWeight) || (spec.fontWeight === 400 && face.weight === "normal"));
}
async function registerEntry(entry: Entry) {
  const received = await entry.reader(entry.spec.faceId);
  assertLive(entry);
  if (!(received instanceof Uint8Array) || received.byteLength < 12 || received.byteLength > MOTION_FONT_DELIVERY_MAX_BYTES) throw new Error("實體字型必須是 16MiB 內的 Uint8Array");
  // Own a bounded copy; mutation of an IPC view cannot change the bytes after
  // verification. No caller-supplied digest, path, URL, or base64 is accepted.
  const bytes = new Uint8Array(received.byteLength); bytes.set(received);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  assertLive(entry);
  const actualSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  if (actualSha256 !== entry.spec.sha256) throw new Error("實體字型 SHA 與 compiled catalog 不符");
  entry.bytes = bytes;
  const face = new entry.constructor(cssFontFamily(entry.spec.fontFamily)!, bytes.buffer, {
    weight: String(entry.spec.fontWeight), style: "normal", display: "block",
  });
  entry.face = face;
  if (!exactFace(face, entry.spec)) throw new Error("FontFace alias 或字重不符");
  const loaded = await face.load();
  assertLive(entry);
  if (loaded !== face || face.status !== "loaded" || !exactFace(face, entry.spec)) throw new Error("所選 binary FontFace 未成功載入");
  entry.registry.document.fonts.add(face);
  entry.registered = true;
  assertLive(entry);
  if (!present(entry)) throw new Error("所選 FontFace 未加入目前 Document");
}
/** Parsing owns one of the same two workers, including its async digest. The
 * parser is synchronous and cannot be preempted; fixed byte/text/contour bounds
 * and post-work lease/deadline checks limit authority, not measured latency. */
async function workEntry(entry: Entry) {
  if (!entry.settled) {
    await registerEntry(entry);
    finishEntry(entry, { status: "registered" });
  }
  assertLive(entry);
  admitGlyphs(entry);
  const request = pendingGlyph(entry);
  if (!request) return;
  request.working = true;
  try {
    if (!entry.registered || !present(entry) || !entry.bytes) throw new Error("實體 glyph 準備缺少有效 registration／binary");
    const run = await prepareGlyphRun(entry.spec.faceId, request.text, entry.bytes);
    assertLive(entry);
    if (!request.tokens.size || entry.glyphs.get(request.text) !== request) throw new Error("glyph 文字請求已釋放；晚到輪廓未採用");
    finishGlyph(request, { status: "prepared", run });
  } catch (error) {
    finishGlyph(request, { status: live(entry) && request.tokens.size ? "blocked" : "cancelled", reason: message(error) });
  } finally { request.working = false; }
}
const priorityRank = (entry: Entry) => [...entry.tokens.values()].includes("current") ? 0 : 1;
function admit(registry: Registry) {
  registry.waiting.sort((a, b) => priorityRank(a) - priorityRank(b));
  while (registry.retained.size < MOTION_FONT_DELIVERY_MAX_FACES && registry.waiting.length) {
    const next = registry.waiting[0];
    const prefetched = [...registry.retained].filter(entry => live(entry) && priorityRank(entry) === 1).length;
    // Reserve is for admission, not preemption: a backward seek can demote
    // already registered current faces. Keep valid shared faces until release;
    // later current work still has priority and its original bounded deadline.
    if (priorityRank(next) === 1 && prefetched >= MOTION_FONT_DELIVERY_LOOKAHEAD_FACES) break;
    registry.waiting.shift();
    if (!live(next)) { releaseEntry(next); continue; }
    registry.retained.add(next); registry.queue.push(next);
  }
}
function pump(registry: Registry) {
  admit(registry);
  registry.queue.sort((a, b) => priorityRank(a) - priorityRank(b));
  while (registry.running < MOTION_FONT_DELIVERY_CONCURRENCY && registry.queue.length) {
    const entry = registry.queue.shift()!;
    if (!live(entry)) { releaseEntry(entry); continue; }
    if (entry.working) continue;
    entry.started = true; entry.working = true; registry.running++;
    void workEntry(entry).catch(error => {
      if (entry.face && (entry.registered || membership(entry) !== false)) {
        try { registry.document.fonts.delete(entry.face); } catch { /* Retention prevents unbounded registration leakage. */ }
      }
      entry.registered = false;
      entry.bytes = undefined;
      const reason = message(error), status = live(entry) ? "blocked" : "cancelled";
      finishEntry(entry, { status, reason });
      for (const request of entry.glyphs.values()) finishGlyph(request, { status, reason });
    }).finally(() => {
      entry.working = false; registry.running--;
      if (!live(entry)) releaseEntry(entry);
      else queueGlyph(entry);
      pump(registry);
    });
  }
}

/** Per-document physical face sharing. Unit dependencies are explicit adapters;
 * only a real desktop call and real FontFace can prove a product journey. */
export function acquireMotionFontDelivery(selection: MotionFontSelection, options: MotionFontDeliveryOptions = {}): MotionFontDeliveryLease {
  const initial = currentMotionFontReadiness(selection, undefined, true);
  if (initial.status === "not-required" || initial.status === "unverified") return terminal(selection, initial.status, initial.reason);
  if (initial.status !== "pending") return terminal(selection, "blocked", initial.reason);
  if (options.prepareGlyphs !== undefined && typeof options.prepareGlyphs !== "boolean") return terminal(selection, "blocked", "glyph 準備選項不合法");
  const glyphText = options.prepareGlyphs ? selection.text.replaceAll("\r", "") : undefined;
  if (glyphText !== undefined && (glyphText.length > PREPARED_GLYPH_MAX_CODE_POINTS * 2 || [...glyphText].length > PREPARED_GLYPH_MAX_CODE_POINTS)) return terminal(selection, "blocked", "實體 glyph 文字超過 256 codepoints");
  const timeoutMs = options.timeoutMs ?? MOTION_FONT_DELIVERY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MOTION_FONT_DELIVERY_TIMEOUT_MS) return terminal(selection, "blocked", "字型傳遞期限不合法");
  if (options.signal?.aborted) return terminal(selection, "cancelled", "字型 lease 已取消");
  const priority = options.priority ?? "current";
  if (priority !== "current" && priority !== "lookahead") return terminal(selection, "blocked", "字型預載 priority 不合法");
  let documentOwner: Pick<Document, "fonts">, reader: (faceId: string) => Promise<Uint8Array>, constructor: typeof FontFace, spec: BundledFontFaceSpec;
  try {
    const actualDocument = options.document ?? (typeof document === "undefined" ? undefined : document);
    const desktop = typeof window === "undefined" ? undefined : window.haoDesktop;
    const readFace = options.readFace ?? desktop?.readBundledFontFace?.bind(desktop);
    const actualConstructor = options.FontFaceConstructor ?? globalThis.FontFace;
    if (!actualDocument?.fonts || typeof actualDocument.fonts.add !== "function" || typeof actualDocument.fonts.delete !== "function" || typeof actualDocument.fonts.has !== "function") throw new Error("目前 Document 未提供 FontFaceSet 註冊介面");
    if (typeof readFace !== "function") throw new Error("此桌面版本缺少實體字型介面，請更新到支援此介面的版本後重新開啟專案");
    if (typeof actualConstructor !== "function") throw new Error("瀏覽器未提供 binary FontFace 介面");
    if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("瀏覽器未提供字型 SHA 驗證介面");
    spec = bundledFontFaceSpec(selection.face!.faceId);
    if (spec.fontFamily !== selection.face!.fontFamily || spec.fontWeight !== selection.face!.fontWeight || spec.fontFile !== selection.face!.fontFile) throw new Error("字型 selection 與 compiled catalog 不符");
    documentOwner = actualDocument; reader = readFace; constructor = actualConstructor;
  } catch (error) { return terminal(selection, "blocked", message(error)); }
  let registry = registries.get(documentOwner);
  if (!registry) {
    registry = { document: documentOwner, entries: new Map(), retained: new Set(), queue: [], waiting: [], running: 0 };
    registries.set(documentOwner, registry);
  }
  let entry = registry.entries.get(spec.faceId);
  if (!entry) {
    // Only compiled identities may wait. Bound the entire live identity map,
    // including admitted faces, rather than just the capacity waiting list.
    if (registry.entries.size >= MOTION_FONT_DELIVERY_MAX_WAITING_FACES) return terminal(selection, "blocked", "目前 Document 的 selected font 等待數已達上限");
    let settle!: (outcome: EntryOutcome) => void;
    const ready = new Promise<EntryOutcome>(resolve => { settle = resolve; });
    entry = { registry, spec, reader, constructor, tokens: new Map(), ready, settle, glyphs: new Map(), valid: true,
      started: false, working: false, settled: false, registered: false };
    registry.entries.set(spec.faceId, entry); registry.waiting.push(entry);
  }
  const ownedEntry = entry, token = {};
  let glyph: GlyphRequest | undefined;
  if (glyphText !== undefined) {
    glyph = entry.glyphs.get(glyphText);
    if (!glyph) {
      if (entry.glyphs.size >= MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS + MOTION_FONT_DELIVERY_MAX_WAITING_GLYPH_TEXTS) return terminal(selection, "blocked", "同一實體字型的 glyph 文字超過 4 admitted＋4 waiting 硬上限；請減少同時顯示／預載的文字");
      let settle!: (outcome: GlyphOutcome) => void;
      const ready = new Promise<GlyphOutcome>(resolve => { settle = resolve; });
      glyph = { text: glyphText, tokens: new Map(), ready, settle, settled: false, working: false, admitted: false };
      entry.glyphs.set(glyphText, glyph);
      if (entry.failure) finishGlyph(glyph, { status: "blocked", reason: entry.failure });
    }
    glyph.tokens.set(token, priority);
  }
  entry.tokens.set(token, priority);
  queueGlyph(entry);
  const deadline = performance.now() + timeoutMs;
  let active = true, settled = false, timer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: (receipt: MotionFontDeliveryReceipt) => void;
  const ready = new Promise<MotionFontDeliveryReceipt>(resolve => { resolveReady = resolve; });
  const finish = (status: MotionFontDeliveryReceipt["status"], reason?: string, glyphRun?: PreparedGlyphRun) => {
    if (settled) return; settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (status !== "registered") options.signal?.removeEventListener("abort", abort);
    resolveReady({ selectionKey: selection.selectionKey, status, faceId: spec.faceId, manifestSha256: spec.manifestSha256,
      ...(reason ? { reason } : {}), ...(glyphRun ? { glyphRun } : {}) });
  };
  const release = () => {
    if (!active) return; active = false; ownedEntry.tokens.delete(token);
    const releasedGlyph = glyph; glyph = undefined;
    if (releasedGlyph) {
      releasedGlyph.tokens.delete(token);
      if (!releasedGlyph.tokens.size && ownedEntry.glyphs.get(releasedGlyph.text) === releasedGlyph) {
        ownedEntry.glyphs.delete(releasedGlyph.text);
        finishGlyph(releasedGlyph, { status: "cancelled", reason: "glyph 文字請求已釋放" });
      }
    }
    options.signal?.removeEventListener("abort", abort);
    finish("cancelled", "字型 lease 已釋放");
    if (!ownedEntry.tokens.size) releaseEntry(ownedEntry);
    else queueGlyph(ownedEntry);
    pump(ownedEntry.registry);
  };
  const abort = () => release();
  options.signal?.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => { finish("blocked", "實體字型傳遞逾時；請確認桌面字型資源後重新開啟專案"); release(); }, timeoutMs);
  void Promise.all([ownedEntry.ready, glyph?.ready ?? Promise.resolve(undefined)]).then(([outcome, prepared]) => {
    if (!active) return;
    if (performance.now() >= deadline) { finish("blocked", "實體字型／glyph 準備逾時；請確認桌面字型資源後重新開啟專案"); release(); }
    else if (outcome.status === "registered" && (!live(ownedEntry) || !ownedEntry.registered || !present(ownedEntry))) finish("blocked", "目前 Document 的字型 registration 已失效；請重新開啟專案");
    else if (outcome.status !== "registered") finish(outcome.status, outcome.reason);
    else if (prepared && prepared.status !== "prepared") finish(prepared.status, prepared.reason);
    else finish("registered", undefined, prepared?.run);
  });
  pump(registry);
  return { selectionKey: selection.selectionKey, ready,
    isRegistered: () => active && live(ownedEntry) && ownedEntry.registered && present(ownedEntry),
    setPriority: value => {
      if (active && (value === "current" || value === "lookahead")) {
        ownedEntry.tokens.set(token, value); glyph?.tokens.set(token, value); queueGlyph(ownedEntry); pump(ownedEntry.registry);
      }
    }, release };
}

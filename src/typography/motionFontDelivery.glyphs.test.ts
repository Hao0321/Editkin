import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "./bundledFontCatalog";
import { motionFontSelection } from "./motionFontReadiness";

// Instrument v2: drain real wrapper work before resetting shared counters.
// Cancelled lease receipts cannot establish that the async digest/parser ended.
const preparation = vi.hoisted(() => ({ calls: 0, active: 0, maximum: 0,
  pending: new Set<Promise<unknown>>(),
  enter: undefined as ((text: string) => void) | undefined,
  wait: undefined as ((text: string) => Promise<void>) | undefined,
  exit: undefined as ((text: string) => void) | undefined }));
vi.mock("./preparedGlyphRun", async original => {
  const actual = await original<typeof import("./preparedGlyphRun")>();
  return { ...actual, prepareGlyphRun: (faceId: string, text: string, bytes: Uint8Array) => {
    const work = (async () => {
      preparation.calls++; preparation.active++; preparation.maximum = Math.max(preparation.maximum, preparation.active);
      preparation.enter?.(text);
      try { await preparation.wait?.(text); return await actual.prepareGlyphRun(faceId, text, bytes); }
      finally { preparation.active--; preparation.exit?.(text); }
    })();
    preparation.pending.add(work);
    void work.then(() => { preparation.pending.delete(work); }, () => { preparation.pending.delete(work); });
    return work;
  } };
});
import { assertPreparedGlyphRun } from "./preparedGlyphRun";
import { acquireMotionFontDelivery, MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS, MOTION_FONT_DELIVERY_MAX_WAITING_GLYPH_TEXTS } from "./motionFontDelivery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const choose = (text = "AV 12", family = "Bebas Neue", weight = 400) => motionFontSelection({ family, weight, text });
const sourceBytes = new Map<string, Uint8Array>();
beforeAll(async () => {
  for (const selection of [choose(), choose("ONE", "Fredoka", 400), choose("TWO", "Fredoka", 700)]) {
    const spec = bundledFontFaceSpec(selection.face!.faceId);
    sourceBytes.set(spec.faceId, new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile))));
  }
});
function environment() {
  const members = new Set<FontFace>(), created: FontFace[] = [];
  const fonts = { add: vi.fn((face: FontFace) => { members.add(face); return fonts; }),
    delete: vi.fn((face: FontFace) => members.delete(face)), has: vi.fn((face: FontFace) => members.has(face)) };
  class BinaryFace {
    family: string; weight: string; status: FontFaceLoadStatus = "unloaded";
    constructor(family: string, _bytes: ArrayBuffer, descriptor?: FontFaceDescriptors) {
      this.family = family; this.weight = descriptor!.weight!; created.push(this as unknown as FontFace);
    }
    async load() { this.status = "loaded"; return this as unknown as FontFace; }
  }
  const readFace = vi.fn(async (faceId: string) => Uint8Array.from(sourceBytes.get(faceId)!));
  const dependencies = { document: { fonts } as unknown as Pick<Document, "fonts">, readFace,
    FontFaceConstructor: BinaryFace as unknown as typeof FontFace, prepareGlyphs: true };
  return { fonts, members, created, readFace, dependencies };
}
beforeEach(async () => { await Promise.allSettled([...preparation.pending]);
  preparation.calls = 0; preparation.active = 0; preparation.maximum = 0;
  preparation.enter = undefined; preparation.wait = undefined; preparation.exit = undefined; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared lease physical glyph preparation (real source bytes, controlled FontFace; no desktop/pixel proof)", () => {
  it("prepares an exact normalized immutable run from the same verified read without exposing bytes", async () => {
    const env = environment(), selection = choose("AV\r\n12"), lease = acquireMotionFontDelivery(selection, env.dependencies);
    const receipt = await lease.ready;
    expect(receipt.status).toBe("registered"); assertPreparedGlyphRun(receipt.glyphRun);
    expect(receipt.glyphRun.text).toBe("AV\n12"); expect(receipt.glyphRun.faceId).toBe(selection.face!.faceId);
    expect(receipt.glyphRun.fontSha256).toBe(bundledFontFaceSpec(selection.face!.faceId).sha256);
    expect(receipt.glyphRun.glyphs[0].pathCommands.length).toBeGreaterThan(0);
    expect(Object.isFrozen(receipt.glyphRun)).toBe(true); expect(preparation.calls).toBe(1);
    expect(env.readFace).toHaveBeenCalledExactlyOnceWith(selection.face!.faceId);
    expect(Object.keys(lease)).not.toContain("bytes"); expect(Object.keys(receipt)).not.toContain("bytes");
    lease.release(); expect(lease.isRegistered()).toBe(false); expect(env.members.size).toBe(0);
  });

  it("shares identical text preparation and does not release another graphic's active run/face", async () => {
    const env = environment(), a = acquireMotionFontDelivery(choose(), env.dependencies), b = acquireMotionFontDelivery(choose(), env.dependencies);
    const [first, second] = await Promise.all([a.ready, b.ready]);
    expect(first.glyphRun).toBe(second.glyphRun); expect(preparation.calls).toBe(1); expect(env.readFace).toHaveBeenCalledTimes(1);
    a.release(); expect(a.isRegistered()).toBe(false); expect(b.isRegistered()).toBe(true); expect(env.fonts.delete).not.toHaveBeenCalled();
    b.release(); expect(env.fonts.delete).toHaveBeenCalledTimes(1);
  });

  it("prepares changed text on the already registered shared binary without another IPC read", async () => {
    const env = environment(), first = acquireMotionFontDelivery(choose("FIRST"), env.dependencies);
    const original = await first.ready;
    const next = acquireMotionFontDelivery(choose("NEXT"), env.dependencies), changed = await next.ready;
    expect(changed.glyphRun?.text).toBe("NEXT"); expect(changed.glyphRun).not.toBe(original.glyphRun);
    expect(preparation.calls).toBe(2); expect(env.readFace).toHaveBeenCalledTimes(1); expect(env.created).toHaveLength(1);
    first.release(); expect(next.isRegistered()).toBe(true); next.release();
  });

  it("rejects unsupported shaping text and cannot substitute readiness for a run", async () => {
    const env = environment(), good = acquireMotionFontDelivery(choose("GOOD"), env.dependencies); await good.ready;
    const bad = acquireMotionFontDelivery(choose("A\u0301"), env.dependencies), receipt = await bad.ready;
    expect(receipt.status).toBe("blocked"); expect(receipt.reason).toContain("Unsupported complex"); expect(receipt.glyphRun).toBeUndefined();
    expect(good.isRegistered()).toBe(true); expect(env.readFace).toHaveBeenCalledTimes(1);
    bad.release(); good.release();
  });

  it("rejects text bounds and a wrong SHA before preparing any glyph", async () => {
    const env = environment(), oversized = acquireMotionFontDelivery(choose("A".repeat(257)), env.dependencies);
    expect(await oversized.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("256") });
    expect(env.readFace).not.toHaveBeenCalled();
    const bytes = Uint8Array.from(sourceBytes.get(choose().face!.faceId)!); bytes[0] ^= 1; env.readFace.mockResolvedValueOnce(bytes);
    const damaged = acquireMotionFontDelivery(choose(), env.dependencies);
    expect(await damaged.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("SHA") });
    expect(preparation.calls).toBe(0); expect(env.created).toHaveLength(0); damaged.release();
  });

  it("blocks missing bytes, unknown/custom selection and an old API without preparing or retrying", async () => {
    const env = environment(); env.readFace.mockRejectedValueOnce(new Error("selected font file missing"));
    const missing = acquireMotionFontDelivery(choose(), env.dependencies);
    expect(await missing.ready).toMatchObject({ status: "blocked", reason: "selected font file missing" });
    expect(preparation.calls).toBe(0); expect(env.readFace).toHaveBeenCalledTimes(1); missing.release();
    const custom = acquireMotionFontDelivery(choose("CUSTOM", "unlisted font"), env.dependencies);
    expect(await custom.ready).toMatchObject({ status: "unverified" }); expect(env.readFace).toHaveBeenCalledTimes(1);
    vi.stubGlobal("window", { haoDesktop: { isDesktop: true } });
    const legacy = acquireMotionFontDelivery(choose(), { document: env.dependencies.document,
      FontFaceConstructor: env.dependencies.FontFaceConstructor, prepareGlyphs: true });
    expect(await legacy.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("請更新") });
    expect(preparation.calls).toBe(0); expect(env.created).toHaveLength(0);
  });

  it("waits the fifth exact text and recovers that same lease after an admitted text releases", async () => {
    const env = environment(), leases = Array.from({ length: MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS }, (_, index) => acquireMotionFontDelivery(choose(`TEXT ${index}`), env.dependencies));
    await Promise.all(leases.map(lease => lease.ready));
    const waiting = acquireMotionFontDelivery(choose("FIFTH"), { ...env.dependencies, priority: "lookahead" }); let resolved = false;
    void waiting.ready.then(() => { resolved = true; }); for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(resolved).toBe(false);
    expect(preparation.calls).toBe(MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS);
    leases[0].release(); expect((await waiting.ready).glyphRun?.text).toBe("FIFTH"); expect(env.readFace).toHaveBeenCalledTimes(1);
    leases.forEach(lease => lease.release()); waiting.release();
  });

  it("promotes queued current glyph text ahead of lookahead without replacing a successful active run", async () => {
    const env = environment(), admitted = Array.from({ length: MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS }, (_, index) => acquireMotionFontDelivery(choose(`TEXT ${index}`), env.dependencies));
    const originals = await Promise.all(admitted.map(lease => lease.ready));
    const order: string[] = []; preparation.enter = text => { order.push(text); };
    const earlier = acquireMotionFontDelivery(choose("EARLIER"), { ...env.dependencies, priority: "lookahead" });
    const promoted = acquireMotionFontDelivery(choose("PROMOTED"), { ...env.dependencies, priority: "lookahead" }); promoted.setPriority("current");
    admitted[0].release(); expect((await promoted.ready).glyphRun?.text).toBe("PROMOTED"); expect(order).toEqual(["PROMOTED"]);
    expect(originals[1].glyphRun?.text).toBe("TEXT 1"); expect(admitted[1].isRegistered()).toBe(true);
    admitted[1].release(); expect((await earlier.ready).glyphRun?.text).toBe("EARLIER"); expect(order).toEqual(["PROMOTED", "EARLIER"]);
    expect(env.readFace).toHaveBeenCalledTimes(1); admitted.forEach(lease => lease.release()); earlier.release(); promoted.release();
  });

  it("bounds pending text identities and explicitly blocks beyond the admitted-plus-waiting hard cap", async () => {
    const env = environment(), count = MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS + MOTION_FONT_DELIVERY_MAX_WAITING_GLYPH_TEXTS;
    const leases = Array.from({ length: count }, (_, index) => acquireMotionFontDelivery(choose(`TEXT ${index}`), env.dependencies));
    await Promise.all(leases.slice(0, MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS).map(lease => lease.ready));
    const excess = acquireMotionFontDelivery(choose("EXCESS"), env.dependencies);
    expect(await excess.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("硬上限") });
    expect(preparation.calls).toBe(MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS); leases.forEach(lease => lease.release());
    expect((await leases.at(-1)!.ready).status).toBe("cancelled");
  });

  it("retains the same two worker ownership slots until cancelled glyph preparation really settles", async () => {
    const env = environment(), gate = deferred<void>(), twoEntered = deferred<void>(); let entries = 0;
    preparation.wait = () => gate.promise; preparation.enter = () => { if (++entries === 2) twoEntered.resolve(); };
    const a = acquireMotionFontDelivery(choose("FIRST"), env.dependencies);
    const b = acquireMotionFontDelivery(choose("SECOND", "Fredoka", 400), env.dependencies);
    const c = acquireMotionFontDelivery(choose("THIRD", "Fredoka", 700), env.dependencies);
    await twoEntered.promise; expect(env.readFace).toHaveBeenCalledTimes(2); expect(preparation.maximum).toBe(2);
    a.release(); b.release(); expect((await a.ready).status).toBe("cancelled"); expect((await b.ready).status).toBe("cancelled");
    expect(env.readFace).toHaveBeenCalledTimes(2); expect(preparation.active).toBe(2);
    gate.resolve(); expect((await c.ready).glyphRun?.text).toBe("THIRD"); expect(preparation.maximum).toBe(2);
    expect(a.isRegistered()).toBe(false); expect(b.isRegistered()).toBe(false); c.release(); expect(env.members.size).toBe(0);
  });

  it("keeps the original deadline across registration/preparation and rejects late contours", async () => {
    vi.useFakeTimers(); const env = environment(), gate = deferred<void>(), entered = deferred<void>(), exited = deferred<void>();
    preparation.enter = () => entered.resolve(); preparation.wait = () => gate.promise; preparation.exit = () => exited.resolve();
    const lease = acquireMotionFontDelivery(choose(), { ...env.dependencies, timeoutMs: 25 });
    await entered.promise; await vi.advanceTimersByTimeAsync(25);
    const expired = await lease.ready; expect(expired.status).toBe("blocked"); expect(expired.reason).toContain("逾時"); expect(expired.glyphRun).toBeUndefined();
    gate.resolve(); await exited.promise; expect(lease.isRegistered()).toBe(false); expect(env.members.size).toBe(0);
  });

  it("does not reset the waiting glyph deadline when it is promoted and admitted", async () => {
    vi.useFakeTimers(); const env = environment();
    const admitted = Array.from({ length: MOTION_FONT_DELIVERY_MAX_GLYPH_TEXTS }, (_, index) => acquireMotionFontDelivery(choose(`TEXT ${index}`), env.dependencies));
    await Promise.all(admitted.map(lease => lease.ready));
    const gate = deferred<void>(), entered = deferred<void>(), exited = deferred<void>();
    preparation.enter = () => entered.resolve(); preparation.wait = () => gate.promise; preparation.exit = () => exited.resolve();
    const waiting = acquireMotionFontDelivery(choose("WAITING"), { ...env.dependencies, priority: "lookahead", timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(20); waiting.setPriority("current"); admitted[0].release(); await entered.promise;
    await vi.advanceTimersByTimeAsync(5);
    const expired = await waiting.ready;
    expect(expired).toMatchObject({ status: "blocked", reason: expect.stringContaining("逾時") }); expect(expired.glyphRun).toBeUndefined();
    gate.resolve(); await exited.promise; expect(waiting.isRegistered()).toBe(false); expect(env.readFace).toHaveBeenCalledTimes(1);
    admitted.forEach(lease => lease.release());
  });

  it("reentry cannot reuse released binary/run authority and an old release cannot delete the new entry", async () => {
    const env = environment(), old = acquireMotionFontDelivery(choose(), env.dependencies), first = await old.ready; old.release();
    const next = acquireMotionFontDelivery(choose(), env.dependencies), second = await next.ready;
    expect(second.glyphRun).not.toBe(first.glyphRun); expect(env.readFace).toHaveBeenCalledTimes(2); expect(preparation.calls).toBe(2);
    old.release(); expect(next.isRegistered()).toBe(true); next.release();
  });
});

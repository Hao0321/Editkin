import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "./bundledFontCatalog";
import { resolveBundledFontFace } from "./fontFaces";
import { assertPreparedGlyphRun, prepareGlyphRun, PREPARED_GLYPH_MAX_FONT_BYTES, type PreparedGlyphRun } from "./preparedGlyphRun";
import { createMotionTemplateTextPreparer, MOTION_TEMPLATE_TEXT_TIMEOUT_MS, type MotionTemplateTextPreparer } from "./motionTemplateTextPreparation";

const native = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./motionFontDelivery", async original => ({ ...await original<typeof import("./motionFontDelivery")>(), acquireMotionFontDelivery: native.acquire }));

const spec = bundledFontFaceSpec(resolveBundledFontFace("Bebas Neue", 400)!.faceId);
const otherSpecs = [400, 700].map(weight => bundledFontFaceSpec(resolveBundledFontFace("Fredoka", weight)!.faceId));
const fixtureBytes = new Map<string, Uint8Array>();
const url = `http://localhost:4183/fonts/${spec.fontFile}`;
let bytes: Uint8Array, run: PreparedGlyphRun;
const owners: MotionTemplateTextPreparer[] = [];
const liveFetches = new Set<Promise<unknown>>();
const closeFetches: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function response(value = bytes, requestUrl = url, headers?: HeadersInit): Response {
  const result = new Response(Uint8Array.from(value).buffer, { status: 200, headers });
  Object.defineProperty(result, "url", { value: requestUrl }); return result;
}
function create(options: Parameters<typeof createMotionTemplateTextPreparer>[0] = {}) {
  const owner = createMotionTemplateTextPreparer(options); owners.push(owner); return owner;
}
function trackedFetch(work: () => Promise<Response>) {
  const task = work(); liveFetches.add(task);
  void task.then(() => liveFetches.delete(task), () => liveFetches.delete(task)); return task;
}
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
beforeAll(async () => {
  bytes = new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile)));
  fixtureBytes.set(spec.faceId, bytes);
  for (const face of otherSpecs) fixtureBytes.set(face.faceId, new Uint8Array(await readFile(resolve("public/fonts", face.fontFile))));
  run = await prepareGlyphRun(spec.faceId, "AV 12", bytes);
});
beforeEach(() => {
  native.acquire.mockReset();
  vi.stubGlobal("window", { location: { href: "http://localhost:4183/editor" } });
  vi.stubGlobal("fetch", vi.fn(async () => response()));
});
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const close of closeFetches.splice(0)) close();
  await Promise.allSettled([...liveFetches]); await flush();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("template physical text preparation (real pinned font bytes; controlled network/lease, not browser or artwork proof)", () => {
  it("prepares an authentic immutable glyph run from only the compiled same-origin font URL", async () => {
    const owner = create(), actual = await owner.prepareText(spec.faceId, "AV 12");
    assertPreparedGlyphRun(actual);
    expect(actual.fontSha256).toBe(spec.sha256); expect(actual.manifestSha256).toBe(spec.manifestSha256);
    expect(actual.text).toBe("AV 12"); expect(actual.glyphs[0].pathCommands.length).toBeGreaterThan(0);
    expect(Object.isFrozen(actual.glyphs[0].pathCommands)).toBe(true);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ credentials: "same-origin", redirect: "error", cache: "no-store" }));
    expect(native.acquire).not.toHaveBeenCalled(); expect(Object.keys(owner).sort()).toEqual(["dispose", "prepareText"]);
  });
  it("reuses the exact face/text promise and run without repeating I/O or parsing", async () => {
    const owner = create(), first = owner.prepareText(spec.faceId, "AV 12"), duplicate = owner.prepareText(spec.faceId, "AV 12");
    expect(duplicate).toBe(first);
    const actual = await first; expect(await owner.prepareText(spec.faceId, "AV 12")).toBe(actual); expect(fetch).toHaveBeenCalledTimes(1);
    const changed = await owner.prepareText(spec.faceId, "NEXT"); expect(changed).not.toBe(actual); expect(changed.text).toBe("NEXT");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("shares completed verified bytes across consumers, while disposal and a changed Window/origin do not authorize stale reuse", async () => {
    const a = create(), b = create(); await a.prepareText(spec.faceId, "FIRST"); a.dispose();
    const next = await b.prepareText(spec.faceId, "SECOND"); assertPreparedGlyphRun(next); expect(next.text).toBe("SECOND");
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubGlobal("window", { location: { href: "http://localhost:4183/reopened" } });
    await expect(b.prepareText(spec.faceId, "SECOND")).rejects.toThrow(/context 已變更/);
    await b.prepareText(spec.faceId, "THIRD"); expect(fetch).toHaveBeenCalledTimes(2);
    window.location.href = "http://localhost:4184/editor";
    vi.mocked(fetch).mockImplementation(async input => response(bytes, String(input)));
    await b.prepareText(spec.faceId, "FOURTH"); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("evicts completed bytes beyond two physical faces rather than keeping an unbounded font cache", async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      const request = String(input), face = [spec, ...otherSpecs].find(item => request.endsWith(item.fontFile))!;
      return response(fixtureBytes.get(face.faceId)!, request);
    });
    const owner = create();
    for (const face of [spec, ...otherSpecs]) assertPreparedGlyphRun(await owner.prepareText(face.faceId, "AV 12"));
    expect(fetch).toHaveBeenCalledTimes(3);
    await owner.prepareText(spec.faceId, "EVICTED FACE"); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("rejects actual wrong bytes at the factory SHA boundary and provides no estimated run", async () => {
    const corrupt = Uint8Array.from(bytes); corrupt[20] ^= 1;
    vi.mocked(fetch).mockResolvedValueOnce(response(corrupt));
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/SHA/);
  });
  it("rejects declared and actual streamed data above 16MiB", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes, url, { "content-length": String(PREPARED_GLYPH_MAX_FONT_BYTES + 1) }));
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/16MiB/);
    vi.mocked(fetch).mockResolvedValueOnce(response(new Uint8Array(PREPARED_GLYPH_MAX_FONT_BYTES + 1)));
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/16MiB/);
  });
  it("accepts transparently decoded gzip font bytes without comparing them to compressed Content-Length", async () => {
    // Controlled Fetch decoded-body semantics, not proof of an HTTP decoder.
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes, url, { "content-encoding": "gzip", "content-length": String(bytes.length - 123) }));
    const actual = await create().prepareText(spec.faceId, "AV 12"); assertPreparedGlyphRun(actual);
    expect(actual.fontSha256).toBe(spec.sha256);
  });
  it("rejects identity length contradictions and unknown encodings without weakening byte/SHA checks", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes, url, { "content-encoding": "identity", "content-length": String(bytes.length - 1) }));
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/長度/);
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes, url, { "content-encoding": "unknown-codec" }));
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/Content-Encoding/);
  });
  it("rejects a foreign-origin or redirected response rather than trusting its font digest", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(bytes, `https://foreign.invalid/fonts/${spec.fontFile}`));
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/same-origin/);
    const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true });
    vi.mocked(fetch).mockResolvedValueOnce(redirected);
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/same-origin/);
  });
  it("rejects unavailable/local-file origin, unknown IDs and excessive exact text before starting reads", async () => {
    vi.stubGlobal("window", { location: { href: "file:///D:/editor.html" } });
    await expect(create().prepareText(spec.faceId, "AV 12")).rejects.toThrow(/same-origin/);
    await expect(create().prepareText("https://foreign.invalid/font.ttf", "AV 12")).rejects.toThrow(/Unknown/);
    await expect(create().prepareText(spec.faceId, "A".repeat(257))).rejects.toThrow(/256/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors an already aborted owner without starting work", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(create({ signal: controller.signal }).prepareText(spec.faceId, "AV 12")).rejects.toThrow(/取消/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps only two actual work slots across owners and does not fake cancellation of an unsettled reader", async () => {
    const gates: ReturnType<typeof deferred<Response>>[] = [];
    vi.mocked(fetch).mockImplementation(() => trackedFetch(() => {
      const gate = deferred<Response>(); gates.push(gate); closeFetches.push(() => gate.resolve(response())); return gate.promise;
    }));
    const firstOwner = create(), secondOwner = create(), thirdOwner = create();
    const first = firstOwner.prepareText(spec.faceId, "ONE"), second = secondOwner.prepareText(spec.faceId, "TWO"), third = thirdOwner.prepareText(spec.faceId, "THREE");
    const firstRejected = expect(first).rejects.toThrow(/取消/);
    expect(fetch).toHaveBeenCalledTimes(2); firstOwner.dispose(); await firstRejected; await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    gates[0].resolve(response()); await flush(); expect(fetch).toHaveBeenCalledTimes(3);
    gates[1].resolve(response()); gates[2].resolve(response());
    expect((await second).text).toBe("TWO"); expect((await third).text).toBe("THREE");
  });
  it("bounds the shared outstanding queue at 64 even when separate owners submit work", async () => {
    const gate = deferred<Response>(); closeFetches.push(() => gate.resolve(response()));
    vi.mocked(fetch).mockImplementation(() => trackedFetch(() => gate.promise));
    const a = create(), b = create(), c = create();
    const pending = Array.from({ length: 64 }, (_, index) => (index < 32 ? a : b).prepareText(spec.faceId, `ITEM ${index}`));
    const outcomes = Promise.allSettled(pending);
    await expect(c.prepareText(spec.faceId, "OVERFLOW")).rejects.toThrow(/64/); expect(fetch).toHaveBeenCalledTimes(2);
    a.dispose(); b.dispose(); await outcomes; gate.resolve(response()); await flush();
    vi.mocked(fetch).mockResolvedValue(response());
    expect((await c.prepareText(spec.faceId, "RECOVERED")).text).toBe("RECOVERED");
  });
  it("retains the original 10s deadline including queued waiting and cannot publish late bytes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const gate = deferred<Response>(); closeFetches.push(() => gate.resolve(response()));
    vi.mocked(fetch).mockImplementation(() => trackedFetch(() => gate.promise));
    const owner = create(), pending = owner.prepareText(spec.faceId, "AV 12"), rejected = expect(pending).rejects.toThrow(/逾時/);
    await vi.advanceTimersByTimeAsync(MOTION_TEMPLATE_TEXT_TIMEOUT_MS); await rejected;
    gate.resolve(response()); await flush(); await expect(owner.prepareText(spec.faceId, "AV 12")).rejects.toThrow(/逾時/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses desktop registration plus a genuine run and releases the lease after preparation", async () => {
    let registered = true;
    const release = vi.fn(() => { registered = false; });
    native.acquire.mockReturnValue({ ready: Promise.resolve({ status: "registered", glyphRun: run }), isRegistered: () => registered, release });
    const owner = create({ surface: { haoDesktop: { isDesktop: true } } });
    expect(await owner.prepareText(spec.faceId, run.text)).toBe(run);
    expect(native.acquire).toHaveBeenCalledWith(expect.objectContaining({ face: expect.objectContaining({ faceId: spec.faceId, fontFile: spec.fontFile }) }), expect.objectContaining({ prepareGlyphs: true }));
    expect(release).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("releases a failed desktop lease and refuses a registration-only result", async () => {
    const release = vi.fn(); native.acquire.mockReturnValue({ ready: Promise.resolve({ status: "registered" }), isRegistered: () => true, release });
    await expect(create({ surface: { haoDesktop: { isDesktop: true } } }).prepareText(spec.faceId, "AV 12")).rejects.toThrow(/實體 run/);
    expect(release).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});

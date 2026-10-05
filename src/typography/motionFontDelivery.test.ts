import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "./bundledFontCatalog";
import { motionFontSelection } from "./motionFontReadiness";
import { acquireMotionFontDelivery, bootstrapMotionFontCss, motionFontInLookahead, motionFontSurface,
  MOTION_FONT_DELIVERY_MAX_BYTES, MOTION_FONT_DELIVERY_MAX_FACES } from "./motionFontDelivery";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const selection = () => motionFontSelection({ family: "Bebas Neue", weight: 400, text: "LEASE ABC 012" });
const fredoka = (weight: number) => motionFontSelection({ family: "Fredoka", weight, text: "QUEUE ABC 012" });
async function bytesFor(faceId = selection().face!.faceId): Promise<Uint8Array> {
  const spec = bundledFontFaceSpec(faceId);
  return new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile)));
}
interface ControlledFace {
  family: string;
  weight: string;
  status: FontFaceLoadStatus;
  source: ArrayBuffer;
  load(): Promise<FontFace>;
}
function environment(options: { load?: (face: ControlledFace) => Promise<FontFace>; family?: string; weight?: string } = {}) {
  const members = new Set<FontFace>(), created: ControlledFace[] = [];
  const firstFace = deferred<ControlledFace>();
  const fonts = { add: vi.fn((face: FontFace) => { members.add(face); return fonts; }),
    delete: vi.fn((face: FontFace) => members.delete(face)), has: vi.fn((face: FontFace) => members.has(face)) };
  class BinaryFace implements ControlledFace {
    family: string; weight: string; status: FontFaceLoadStatus = "unloaded"; source: ArrayBuffer;
    constructor(family: string, source: ArrayBuffer, descriptors?: FontFaceDescriptors) {
      this.family = options.family ?? family; this.weight = options.weight ?? descriptors?.weight ?? "normal"; this.source = source;
      created.push(this); firstFace.resolve(this);
    }
    async load(): Promise<FontFace> {
      if (options.load) return options.load(this);
      this.status = "loaded"; return this as unknown as FontFace;
    }
  }
  const document = { fonts } as unknown as Pick<Document, "fonts">;
  const readFace = vi.fn((faceId: string) => bytesFor(faceId));
  const dependencies = { document, readFace, FontFaceConstructor: BinaryFace as unknown as typeof FontFace };
  return { document, fonts, members, created, firstFace, readFace, dependencies };
}
const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("selected binary font delivery leases (adapters; no actual desktop/browser proof)", () => {
  it("calls only faceId and verifies real compiled bytes before exact binary registration", async () => {
    const env = environment(), chosen = selection(), lease = acquireMotionFontDelivery(chosen, env.dependencies);
    expect(lease.isRegistered()).toBe(false);
    expect(await lease.ready).toMatchObject({ status: "registered", selectionKey: chosen.selectionKey,
      faceId: chosen.face!.faceId, manifestSha256: bundledFontFaceSpec(chosen.face!.faceId).manifestSha256 });
    expect(env.readFace).toHaveBeenCalledExactlyOnceWith(chosen.face!.faceId);
    expect(env.created).toHaveLength(1); expect(env.created[0]).toMatchObject({ family: '"EditkinFace bebas-neue 400"', weight: "400", status: "loaded" });
    expect(new Uint8Array(env.created[0].source)).toEqual(await bytesFor());
    expect(lease.isRegistered()).toBe(true); lease.release(); expect(env.members.size).toBe(0); expect(lease.isRegistered()).toBe(false);
  });

  it("shares one physical read/face while one lease cannot delete another active graphic's face", async () => {
    const env = environment(), a = acquireMotionFontDelivery(selection(), env.dependencies), b = acquireMotionFontDelivery(selection(), env.dependencies);
    await Promise.all([a.ready, b.ready]); expect(env.readFace).toHaveBeenCalledTimes(1); expect(env.fonts.add).toHaveBeenCalledTimes(1);
    a.release(); a.release(); expect(a.isRegistered()).toBe(false); expect(b.isRegistered()).toBe(true); expect(env.fonts.delete).not.toHaveBeenCalled();
    b.release(); expect(env.fonts.delete).toHaveBeenCalledExactlyOnceWith(env.created[0]); expect(env.members.size).toBe(0);
  });

  it("scopes same-face sharing to each document and deletes only its own FontFace object", async () => {
    const one = environment(), two = environment(), external = {} as FontFace; one.members.add(external);
    const a = acquireMotionFontDelivery(selection(), one.dependencies), b = acquireMotionFontDelivery(selection(), two.dependencies);
    await Promise.all([a.ready, b.ready]); a.release();
    expect(one.members.has(external)).toBe(true); expect(one.members.size).toBe(1); expect(b.isRegistered()).toBe(true);
    expect(one.readFace).toHaveBeenCalledTimes(1); expect(two.readFace).toHaveBeenCalledTimes(1); b.release();
  });

  it("rejects wrong SHA before creating a FontFace", async () => {
    const env = environment(), damaged = await bytesFor(); damaged[0] ^= 1;
    env.readFace.mockResolvedValueOnce(damaged);
    const lease = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(await lease.ready).toMatchObject({ status: "blocked", reason: "實體字型 SHA 與 compiled catalog 不符" });
    expect(env.created).toHaveLength(0); expect(env.fonts.add).not.toHaveBeenCalled(); lease.release();
  });

  it.each(["array", "empty", "oversized"])("rejects %s binary responses before decoding", async defect => {
    const env = environment();
    const response = defect === "array" ? Array.from(await bytesFor()) : new Uint8Array(defect === "empty" ? 0 : MOTION_FONT_DELIVERY_MAX_BYTES + 1);
    env.readFace.mockResolvedValueOnce(response as unknown as Uint8Array);
    const lease = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(await lease.ready).toMatchObject({ status: "blocked", reason: "實體字型必須是 16MiB 內的 Uint8Array" });
    expect(env.created).toHaveLength(0); lease.release();
  });

  it.each([{ family: "Variable source family" }, { weight: "700" }])("rejects a constructor's wrong alias/weight %j", async defect => {
    const env = environment(defect), lease = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(await lease.ready).toMatchObject({ status: "blocked", reason: "FontFace alias 或字重不符" });
    expect(env.fonts.add).not.toHaveBeenCalled(); lease.release();
  });

  it("propagates actual read/load rejection and rejects a substituted load result", async () => {
    const readFailed = environment(); readFailed.readFace.mockRejectedValueOnce(new Error("selected resource unavailable"));
    const a = acquireMotionFontDelivery(selection(), readFailed.dependencies);
    expect(await a.ready).toMatchObject({ status: "blocked", reason: "selected resource unavailable" }); a.release();
    const loadFailed = environment({ load: async () => { throw new Error("binary decode rejected"); } });
    const b = acquireMotionFontDelivery(selection(), loadFailed.dependencies);
    expect(await b.ready).toMatchObject({ status: "blocked", reason: "binary decode rejected" }); b.release();
    const replaced = environment({ load: async face => { face.status = "loaded"; return { ...face } as unknown as FontFace; } });
    const c = acquireMotionFontDelivery(selection(), replaced.dependencies);
    expect(await c.ready).toMatchObject({ status: "blocked", reason: "所選 binary FontFace 未成功載入" });
    expect(replaced.fonts.add).not.toHaveBeenCalled(); c.release();
  });

  it("blocks an old desktop API before I/O and does not select web fallback", async () => {
    const env = environment(), legacy = { haoDesktop: { isDesktop: true, readMesh3dFont: vi.fn() } };
    vi.stubGlobal("window", legacy); expect(motionFontSurface(legacy)).toBe("desktop");
    const lease = acquireMotionFontDelivery(selection(), { document: env.document, FontFaceConstructor: env.dependencies.FontFaceConstructor });
    expect(await lease.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("請更新") });
    expect(env.readFace).not.toHaveBeenCalled(); expect(env.created).toHaveLength(0);
  });

  it("explicitly blocks missing document registration, FontFace or SHA APIs", async () => {
    const env = environment();
    const a = acquireMotionFontDelivery(selection(), { ...env.dependencies, document: {} as Pick<Document, "fonts"> });
    expect(await a.ready).toMatchObject({ status: "blocked", reason: "目前 Document 未提供 FontFaceSet 註冊介面" });
    vi.stubGlobal("FontFace", undefined);
    const b = acquireMotionFontDelivery(selection(), { document: env.document, readFace: env.readFace });
    expect(await b.ready).toMatchObject({ status: "blocked", reason: "瀏覽器未提供 binary FontFace 介面" });
    vi.stubGlobal("crypto", undefined);
    const c = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(await c.ready).toMatchObject({ status: "blocked", reason: "瀏覽器未提供字型 SHA 驗證介面" });
    expect(env.readFace).not.toHaveBeenCalled();
  });

  it("does not read for empty/custom/invalid selections or a pre-aborted lease", async () => {
    const env = environment(), controller = new AbortController(); controller.abort();
    expect(await acquireMotionFontDelivery(motionFontSelection({ family: "custom", weight: 700, text: " " }), env.dependencies).ready).toMatchObject({ status: "not-required" });
    expect(await acquireMotionFontDelivery(motionFontSelection({ family: "custom", weight: 700, text: "Title" }), env.dependencies).ready).toMatchObject({ status: "unverified" });
    expect(await acquireMotionFontDelivery(motionFontSelection({ family: "Noto Sans TC", weight: NaN, text: "Title" }), env.dependencies).ready).toMatchObject({ status: "blocked" });
    expect(await acquireMotionFontDelivery(selection(), { ...env.dependencies, signal: controller.signal }).ready).toMatchObject({ status: "cancelled" });
    expect(env.readFace).not.toHaveBeenCalled();
  });

  it("cancels a pending read and never creates or adds its late result", async () => {
    const env = environment(), reading = deferred<Uint8Array>(), controller = new AbortController();
    env.readFace.mockReturnValueOnce(reading.promise);
    const lease = acquireMotionFontDelivery(selection(), { ...env.dependencies, signal: controller.signal });
    controller.abort(); expect(await lease.ready).toMatchObject({ status: "cancelled" });
    reading.resolve(await bytesFor()); await flush();
    expect(env.created).toHaveLength(0); expect(env.fonts.add).not.toHaveBeenCalled(); expect(lease.isRegistered()).toBe(false);
  });

  it("cancels during FontFace.load and never adds the late loaded face", async () => {
    const loading = deferred<FontFace>(), env = environment({ load: () => loading.promise });
    const lease = acquireMotionFontDelivery(selection(), env.dependencies), face = await env.firstFace.promise;
    lease.release(); expect(await lease.ready).toMatchObject({ status: "cancelled" });
    face.status = "loaded"; loading.resolve(face as unknown as FontFace); await flush();
    expect(env.fonts.add).not.toHaveBeenCalled(); expect(env.members.size).toBe(0);
  });

  it("abort after successful registration still releases the face", async () => {
    const env = environment(), controller = new AbortController();
    const lease = acquireMotionFontDelivery(selection(), { ...env.dependencies, signal: controller.signal });
    await lease.ready; controller.abort(); expect(lease.isRegistered()).toBe(false); expect(env.members.size).toBe(0);
  });

  it("reentry reads/registers anew and a released old ready receipt cannot delete or authorize the new lease", async () => {
    const env = environment(), old = acquireMotionFontDelivery(selection(), env.dependencies);
    const oldReceipt = await old.ready; old.release();
    const reading = deferred<Uint8Array>(); env.readFace.mockReturnValueOnce(reading.promise);
    const next = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(oldReceipt.status).toBe("registered"); expect(old.isRegistered()).toBe(false); expect(next.isRegistered()).toBe(false);
    reading.resolve(await bytesFor()); expect(await next.ready).toMatchObject({ status: "registered" });
    old.release(); expect(next.isRegistered()).toBe(true); expect(env.readFace).toHaveBeenCalledTimes(2); next.release();
  });

  it("requires actual Document membership after registration and cleans failed add operations", async () => {
    const noAdd = environment(); noAdd.fonts.add.mockImplementation(() => noAdd.fonts);
    const a = acquireMotionFontDelivery(selection(), noAdd.dependencies);
    expect(await a.ready).toMatchObject({ status: "blocked", reason: "所選 FontFace 未加入目前 Document" }); a.release();
    const partial = environment(); partial.fonts.add.mockImplementation(face => { partial.members.add(face); throw new Error("add failed after side effect"); });
    const b = acquireMotionFontDelivery(selection(), partial.dependencies);
    expect(await b.ready).toMatchObject({ status: "blocked", reason: "add failed after side effect" });
    expect(partial.members.size).toBe(0); b.release();
  });

  it("does not authorize readiness after an outside removal from the current Document", async () => {
    const env = environment(), lease = acquireMotionFontDelivery(selection(), env.dependencies); await lease.ready;
    env.members.clear(); expect(lease.isRegistered()).toBe(false);
    const second = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(await second.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("registration 已失效") });
    expect(env.readFace).toHaveBeenCalledTimes(1); second.release(); lease.release();
  });

  it("bounds a hung read by the lease deadline and rejects invalid deadlines before I/O", async () => {
    vi.useFakeTimers(); const env = environment(), reading = deferred<Uint8Array>(); env.readFace.mockReturnValueOnce(reading.promise);
    const lease = acquireMotionFontDelivery(selection(), { ...env.dependencies, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await lease.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("逾時") });
    expect(lease.isRegistered()).toBe(false); reading.resolve(await bytesFor()); await flush(); expect(env.fonts.add).not.toHaveBeenCalled();
    for (const timeoutMs of [0, -1, Infinity, NaN, 5001]) expect(await acquireMotionFontDelivery(selection(), { ...env.dependencies, timeoutMs }).ready).toMatchObject({ status: "blocked" });
    expect(env.readFace).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps two actual read slots until settlement, removes cancelled queue items and bounds retained entries", async () => {
    const env = environment(), reads: ReturnType<typeof deferred<Uint8Array>>[] = [];
    env.readFace.mockImplementation(() => { const gate = deferred<Uint8Array>(); reads.push(gate); return gate.promise; });
    const leases = Array.from({ length: MOTION_FONT_DELIVERY_MAX_FACES }, (_, index) => acquireMotionFontDelivery(
      motionFontSelection({ family: "Noto Sans TC", weight: 100 + 50 * index, text: "QUEUE" }), env.dependencies));
    expect(env.readFace).toHaveBeenCalledTimes(2);
    const overflow = acquireMotionFontDelivery(motionFontSelection({ family: "Noto Sans TC", weight: 900, text: "QUEUE" }), env.dependencies);
    expect(overflow.isRegistered()).toBe(false); expect(env.readFace).toHaveBeenCalledTimes(2);
    overflow.release(); expect(await overflow.ready).toMatchObject({ status: "cancelled" });
    leases.forEach(lease => lease.release()); await Promise.all(leases.map(lease => lease.ready));
    const later = [600, 650].map(weight => acquireMotionFontDelivery(motionFontSelection({ family: "Noto Sans TC", weight, text: "NEXT" }), env.dependencies));
    expect(env.readFace).toHaveBeenCalledTimes(2); // Cancelled but actually hung calls still own the two slots.
    const bytes = await bytesFor(); reads[0].resolve(bytes); reads[1].resolve(bytes); await flush();
    expect(env.readFace).toHaveBeenCalledTimes(4);
    later.forEach(lease => lease.release()); reads[2].resolve(bytes); reads[3].resolve(bytes); await flush();
    expect(env.created).toHaveLength(0); expect(env.fonts.add).not.toHaveBeenCalled();
  });

  it("retains undeletable registrations within the cap instead of creating unbounded replacements", async () => {
    const env = environment(); env.fonts.delete.mockReturnValue(false);
    for (let count = 0; count < MOTION_FONT_DELIVERY_MAX_FACES; count++) {
      const lease = acquireMotionFontDelivery(selection(), env.dependencies); expect(await lease.ready).toMatchObject({ status: "registered" }); lease.release();
      expect(lease.isRegistered()).toBe(false);
    }
    vi.useFakeTimers();
    const denied = acquireMotionFontDelivery(selection(), { ...env.dependencies, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await denied.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("逾時") });
    expect(env.readFace).toHaveBeenCalledTimes(MOTION_FONT_DELIVERY_MAX_FACES); expect(env.members.size).toBe(MOTION_FONT_DELIVERY_MAX_FACES);
  });

  it("recovers the same capacity-waiting lease when a retained face releases, without another acquisition", async () => {
    const env = environment(), choices = [selection(), ...[300, 350, 400, 450, 500, 550, 600].map(fredoka)];
    const leases = choices.map(chosen => acquireMotionFontDelivery(chosen, env.dependencies));
    expect((await Promise.all(leases.map(lease => lease.ready))).every(receipt => receipt.status === "registered")).toBe(true);
    expect(env.members.size).toBe(8); expect(env.readFace).toHaveBeenCalledTimes(8);
    const waiting = acquireMotionFontDelivery(fredoka(700), env.dependencies);
    await flush(); expect(waiting.isRegistered()).toBe(false); expect(env.readFace).toHaveBeenCalledTimes(8);
    leases[0].release();
    expect(await waiting.ready).toMatchObject({ status: "registered", selectionKey: fredoka(700).selectionKey });
    expect(env.readFace).toHaveBeenCalledTimes(9); expect(env.members.size).toBe(8);
    expect(leases.slice(1).every(lease => lease.isRegistered())).toBe(true);
    waiting.release(); leases.forEach(lease => lease.release()); expect(env.members.size).toBe(0);
  });

  it("reserves two admission slots for current text and wakes lookahead only after its own capacity frees", async () => {
    const env = environment(), prefetch = [300, 350, 400, 450, 500, 550].map(weight =>
      acquireMotionFontDelivery(fredoka(weight), { ...env.dependencies, priority: "lookahead" }));
    await Promise.all(prefetch.map(lease => lease.ready)); expect(env.readFace).toHaveBeenCalledTimes(6);
    const seventh = acquireMotionFontDelivery(fredoka(600), { ...env.dependencies, priority: "lookahead" });
    await flush(); expect(env.readFace).toHaveBeenCalledTimes(6); expect(seventh.isRegistered()).toBe(false);
    const current = [selection(), fredoka(700)].map(chosen => acquireMotionFontDelivery(chosen, { ...env.dependencies, priority: "current" }));
    expect((await Promise.all(current.map(lease => lease.ready))).every(receipt => receipt.status === "registered")).toBe(true);
    expect(env.members.size).toBe(8); current[0].release(); await flush();
    expect(env.readFace).toHaveBeenCalledTimes(8); expect(seventh.isRegistered()).toBe(false);
    prefetch[0].release(); expect(await seventh.ready).toMatchObject({ status: "registered" });
    expect(env.readFace).toHaveBeenCalledTimes(9); expect(env.members.size).toBe(7);
    seventh.release(); current.forEach(lease => lease.release()); prefetch.forEach(lease => lease.release());
  });

  it("runs queued current text before older lookahead when an actual worker settles", async () => {
    const env = environment(), reads: ReturnType<typeof deferred<Uint8Array>>[] = [];
    env.readFace.mockImplementation(() => { const gate = deferred<Uint8Array>(); reads.push(gate); return gate.promise; });
    const running = [300, 350].map(weight => acquireMotionFontDelivery(fredoka(weight), { ...env.dependencies, priority: "lookahead" }));
    const queued = acquireMotionFontDelivery(fredoka(400), { ...env.dependencies, priority: "lookahead" });
    const current = acquireMotionFontDelivery(selection(), { ...env.dependencies, priority: "current" });
    expect(env.readFace).toHaveBeenCalledTimes(2);
    running[0].release(); reads[0].resolve(new Uint8Array()); await flush();
    expect(env.readFace.mock.calls[2][0]).toBe(selection().face!.faceId);
    [running[1], queued, current].forEach(lease => lease.release());
    reads[1].resolve(new Uint8Array()); reads[2].resolve(new Uint8Array()); await flush();
    expect(env.created).toHaveLength(0); expect(env.fonts.add).not.toHaveBeenCalled();
  });

  it("preserves valid registrations after backward-seek demotion and honestly expires delayed current work", async () => {
    const env = environment(), prefetch = [300, 350, 400, 450, 500, 550].map(weight =>
      acquireMotionFontDelivery(fredoka(weight), { ...env.dependencies, priority: "lookahead" }));
    const current = [selection(), fredoka(700)].map(chosen => acquireMotionFontDelivery(chosen, env.dependencies));
    await Promise.all([...prefetch, ...current].map(lease => lease.ready));
    current.forEach(lease => lease.setPriority("lookahead"));
    expect([...prefetch, ...current].every(lease => lease.isRegistered())).toBe(true);
    expect(env.fonts.delete).not.toHaveBeenCalled(); vi.useFakeTimers();
    const delayed = acquireMotionFontDelivery(fredoka(600), { ...env.dependencies, priority: "current", timeoutMs: 25 });
    expect(env.readFace).toHaveBeenCalledTimes(8); await vi.advanceTimersByTimeAsync(25);
    expect(await delayed.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("逾時") });
    expect(delayed.isRegistered()).toBe(false); expect(env.readFace).toHaveBeenCalledTimes(8);
    [...prefetch, ...current].forEach(lease => lease.release()); expect(env.members.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot demote a shared current title by changing another graphic's lookahead lease", async () => {
    const env = environment(), reads: ReturnType<typeof deferred<Uint8Array>>[] = [];
    env.readFace.mockImplementation(() => { const gate = deferred<Uint8Array>(); reads.push(gate); return gate.promise; });
    const running = [300, 350].map(weight => acquireMotionFontDelivery(fredoka(weight), { ...env.dependencies, priority: "lookahead" }));
    const older = acquireMotionFontDelivery(fredoka(400), { ...env.dependencies, priority: "lookahead" });
    const sharedLookahead = acquireMotionFontDelivery(selection(), { ...env.dependencies, priority: "lookahead" });
    const sharedCurrent = acquireMotionFontDelivery(selection(), { ...env.dependencies, priority: "current" });
    sharedLookahead.setPriority("lookahead");
    running[0].release(); reads[0].resolve(new Uint8Array()); await flush();
    expect(env.readFace.mock.calls[2][0]).toBe(selection().face!.faceId);
    expect(env.readFace.mock.calls.filter(([faceId]) => faceId === selection().face!.faceId)).toHaveLength(1);
    [running[1], older, sharedLookahead, sharedCurrent].forEach(lease => lease.release());
    reads[1].resolve(new Uint8Array()); reads[2].resolve(new Uint8Array()); await flush();
    expect(env.created).toHaveLength(0);
  });

  it("promotes the same waiting lease without resetting its original deadline or repeating I/O", async () => {
    const env = environment(), prefetch = [300, 350, 400, 450, 500, 550].map(weight =>
      acquireMotionFontDelivery(fredoka(weight), { ...env.dependencies, priority: "lookahead" }));
    await Promise.all(prefetch.map(lease => lease.ready));
    vi.useFakeTimers(); const reading = deferred<Uint8Array>(); env.readFace.mockReturnValueOnce(reading.promise);
    const promoted = acquireMotionFontDelivery(fredoka(600), { ...env.dependencies, priority: "lookahead", timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(20); expect(env.readFace).toHaveBeenCalledTimes(6);
    promoted.setPriority("current"); expect(env.readFace).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(5);
    expect(await promoted.ready).toMatchObject({ status: "blocked", reason: expect.stringContaining("逾時") });
    promoted.setPriority("current"); expect(env.readFace).toHaveBeenCalledTimes(7);
    reading.resolve(new Uint8Array()); await flush(); expect(env.fonts.add).toHaveBeenCalledTimes(6);
    prefetch.forEach(lease => lease.release()); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a failed physical read on priority changes or another active same-face lease", async () => {
    const env = environment(); env.readFace.mockRejectedValueOnce(new Error("selected resource unavailable"));
    const first = acquireMotionFontDelivery(selection(), { ...env.dependencies, priority: "lookahead" });
    expect(await first.ready).toMatchObject({ status: "blocked", reason: "selected resource unavailable" });
    first.setPriority("current");
    const shared = acquireMotionFontDelivery(selection(), env.dependencies);
    expect(await shared.ready).toMatchObject({ status: "blocked", reason: "selected resource unavailable" });
    expect(env.readFace).toHaveBeenCalledTimes(1); expect(env.fonts.add).not.toHaveBeenCalled(); first.release(); shared.release();
  });
});

describe("declared font bootstrap and timeline admission", () => {
  it("does not register static URL CSS for either current or old desktop API, or Tauri marker", async () => {
    const css = vi.fn(async () => {});
    for (const surface of [{ haoDesktop: { isDesktop: true } }, { haoDesktop: {} }, { __TAURI_INTERNALS__: {} }]) {
      expect(motionFontSurface(surface)).toBe("desktop"); await bootstrapMotionFontCss(surface, css);
    }
    expect(css).not.toHaveBeenCalled();
  });
  it("awaits actual declared web CSS bootstrap and propagates its failure", async () => {
    const gate = deferred<void>(), css = vi.fn(() => gate.promise); let finished = false;
    const boot = bootstrapMotionFontCss(undefined, css).then(() => { finished = true; });
    await flush(); expect(finished).toBe(false); gate.resolve(); await boot; expect(css).toHaveBeenCalledTimes(1);
    await expect(bootstrapMotionFontCss({}, async () => { throw new Error("web CSS unavailable"); })).rejects.toThrow("web CSS unavailable");
  });
  it("admits only current or next-five-second timeline text including forward/backward seek and exclusive ends", () => {
    expect(motionFontInLookahead({ timelineStart: 0, duration: 3 }, 1)).toBe(true);
    expect(motionFontInLookahead({ timelineStart: 5, duration: 3 }, 0)).toBe(true);
    expect(motionFontInLookahead({ timelineStart: 5.001, duration: 3 }, 0)).toBe(false);
    expect(motionFontInLookahead({ timelineStart: 0, duration: 3 }, 3)).toBe(false);
    expect(motionFontInLookahead({ timelineStart: 900, duration: 3 }, 899)).toBe(true);
    expect(motionFontInLookahead({ timelineStart: 0, duration: 3 }, 899)).toBe(false);
    expect(motionFontInLookahead({ timelineStart: 0, duration: 3 }, 1)).toBe(true);
    for (const playhead of [NaN, Infinity, -1]) expect(motionFontInLookahead({ timelineStart: 0, duration: 3 }, playhead)).toBe(false);
  });
});

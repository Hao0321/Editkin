import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMotionFontReadiness, loadMotionFontReadiness, motionFontSelection, type MotionFontFaceSet } from "./motionFontReadiness";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const selected = () => motionFontSelection({ family: "Noto Sans TC", weight: 850, text: "輪廓 TEXT" });
const loadedFace = () => ({ family: '"EditkinFace noto-sans-tc 850"', weight: "850", status: "loaded" });
function available(overrides: Partial<MotionFontFaceSet> = {}): MotionFontFaceSet {
  return { load: vi.fn(async () => [loadedFace()]), ready: Promise.resolve(), check: vi.fn(() => true), ...overrides };
}
afterEach(() => vi.useRealTimers());

describe("exact physical Motion font load contract (unit adapters, not browser observation)", () => {
  it("keeps pending until both the selected face and fonts.ready complete, using actual text", async () => {
    const selection = selected(), loading = deferred<ReturnType<typeof loadedFace>[]>(), ready = deferred<void>();
    const fonts = available({ load: vi.fn(() => loading.promise), ready: ready.promise });
    const pending = loadMotionFontReadiness(selection, { fontSet: fonts });
    expect(currentMotionFontReadiness(selection, undefined, true).status).toBe("pending");
    expect(fonts.load).toHaveBeenCalledWith('850 16px "EditkinFace noto-sans-tc 850"', "輪廓 TEXT");
    loading.resolve([loadedFace()]); await Promise.resolve();
    expect(fonts.check).not.toHaveBeenCalled();
    ready.resolve();
    expect(await pending).toMatchObject({ status: "ready", selectionKey: selection.selectionKey, face: { fontFile: "render/EditkinFace-noto-sans-tc-850.ttf" } });
    expect(fonts.check).toHaveBeenCalledWith('850 16px "EditkinFace noto-sans-tc 850"', "輪廓 TEXT");
  });

  it("loads the resolved physical weight, including substitutions, rather than synthetic requested bold", async () => {
    const selection = motionFontSelection({ family: "Fredoka", weight: 850, text: "Promise" });
    const fonts = available({ load: vi.fn(async () => [{ family: "EditkinFace fredoka 700", weight: "700", status: "loaded" }]) });
    expect(await loadMotionFontReadiness(selection, { fontSet: fonts })).toMatchObject({ status: "ready", face: { requestedWeight: 850, fontWeight: 700, weightSubstituted: true } });
    expect(fonts.load).toHaveBeenCalledWith('700 16px "EditkinFace fredoka 700"', "Promise");
  });

  it.each([
    { faces: [] },
    { faces: [{ family: "Noto Sans TC", weight: "850", status: "loaded" }] },
    { faces: [{ family: "EditkinFace noto-sans-tc 850", weight: "800", status: "loaded" }] },
    { faces: [{ family: "EditkinFace noto-sans-tc 850", weight: "100 900", status: "loaded" }] },
    { faces: [{ family: "EditkinFace noto-sans-tc 850", weight: "0x352", status: "loaded" }] },
    { faces: [{ family: "EditkinFace noto-sans-tc 850", weight: "850", status: "loading" }] },
    { faces: [{ family: "EditkinFace noto-sans-tc 850", weight: "850", status: "error" }] },
    { faces: [loadedFace(), { family: "Unexpected fallback", weight: "850", status: "loaded" }] },
  ])("rejects missing, fallback, wrong-weight, variable-range or unloaded results even if check says true: %j", async ({ faces }) => {
    const fonts = available({ load: vi.fn(async () => faces) });
    expect(await loadMotionFontReadiness(selected(), { fontSet: fonts })).toMatchObject({ status: "blocked" });
  });

  it("rejects a face that becomes invalid before global font readiness", async () => {
    const face = loadedFace(), ready = deferred<void>();
    const pending = loadMotionFontReadiness(selected(), { fontSet: available({ load: async () => [face], ready: ready.promise }) });
    await Promise.resolve(); face.status = "error"; ready.resolve();
    expect(await pending).toMatchObject({ status: "blocked" });
  });

  it("rejects the final browser check and propagates a real load rejection", async () => {
    expect(await loadMotionFontReadiness(selected(), { fontSet: available({ check: () => false }) })).toMatchObject({ status: "blocked" });
    expect(await loadMotionFontReadiness(selected(), { fontSet: available({ load: async () => { throw new Error("font file rejected"); } }) })).toMatchObject({ status: "blocked", reason: "font file rejected" });
  });

  it.each([undefined, null, {}, { load: () => Promise.resolve([]) }, { check: () => true }])("explicitly blocks an unavailable or incomplete API: %j", async fonts => {
    expect(await loadMotionFontReadiness(selected(), { fontSet: fonts as MotionFontFaceSet | undefined })).toMatchObject({ status: "blocked", reason: "瀏覽器未提供字型載入 API" });
  });

  it("does not treat an absent ready promise as successful loading", async () => {
    expect(await loadMotionFontReadiness(selected(), { fontSet: available({ ready: undefined as unknown as Promise<void> }) })).toMatchObject({ status: "blocked", reason: "瀏覽器未提供 fonts.ready" });
  });

  it.each(["load", "ready"])("bounds a never-completing %s instead of leaving fallback authorized", async stage => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const fonts = available(stage === "load" ? { load: () => never } : { ready: never });
    const pending = loadMotionFontReadiness(selected(), { fontSet: fonts, timeoutMs: 125 });
    await vi.advanceTimersByTimeAsync(125);
    expect(await pending).toMatchObject({ status: "blocked", reason: "字型載入逾時" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Infinity, NaN, 10_001])("rejects an unbounded or invalid timeout %s before loading", async timeoutMs => {
    const fonts = available();
    expect(await loadMotionFontReadiness(selected(), { fontSet: fonts, timeoutMs })).toMatchObject({ status: "blocked" });
    expect(fonts.load).not.toHaveBeenCalled();
  });

  it("cancels an old load and does not let its late completion authorize a new face", async () => {
    const old = selected(), next = motionFontSelection({ family: "Noto Sans TC", weight: 700, text: old.text });
    const delayed = deferred<ReturnType<typeof loadedFace>[]>(), controller = new AbortController();
    const loading = loadMotionFontReadiness(old, { fontSet: available({ load: () => delayed.promise }), signal: controller.signal });
    controller.abort(); expect(await loading).toMatchObject({ status: "cancelled" });
    delayed.resolve([loadedFace()]); await Promise.resolve();
    const oldReady = { selectionKey: old.selectionKey, status: "ready" as const, face: old.face };
    // Negative control: naïvely reusing the prior ready bit would incorrectly permit the new 700 face.
    expect(oldReady.status).toBe("ready");
    expect(currentMotionFontReadiness(next, oldReady, true)).toMatchObject({ status: "pending", selectionKey: next.selectionKey });
    const fonts = available({ load: async () => [{ family: "EditkinFace noto-sans-tc 700", weight: "700", status: "loaded" }] });
    const newReady = await loadMotionFontReadiness(next, { fontSet: fonts });
    expect(currentMotionFontReadiness(next, newReady, true).status).toBe("ready");
  });

  it("keeps changed text and separate graphic faces independent", async () => {
    const old = selected(), ready = await loadMotionFontReadiness(old, { fontSet: available() });
    const textChanged = motionFontSelection({ family: old.family, weight: old.weight, text: "新字" });
    const otherFace = motionFontSelection({ family: "Noto Serif TC", weight: 700, text: "Payoff" });
    expect(currentMotionFontReadiness(textChanged, ready, true).status).toBe("pending");
    expect(currentMotionFontReadiness(otherFace, ready, true).status).toBe("pending");
    expect(currentMotionFontReadiness(old, ready, true).status).toBe("ready");
  });

  it("never promotes SSR markup to observed loading and keeps custom fonts explicitly unverified", async () => {
    const selection = selected(), ready = await loadMotionFontReadiness(selection, { fontSet: available() });
    expect(currentMotionFontReadiness(selection, ready, false).status).toBe("unobserved");
    const custom = motionFontSelection({ family: "Local custom font", weight: 700, text: "Custom" });
    expect(await loadMotionFontReadiness(custom, { fontSet: available() })).toMatchObject({ status: "unverified" });
    const fonts = available(), empty = motionFontSelection({ family: "Local custom font", weight: 700, text: "  " });
    expect(await loadMotionFontReadiness(empty, { fontSet: fonts })).toMatchObject({ status: "not-required" });
    expect(fonts.load).not.toHaveBeenCalled();
  });

  it("cancels before touching the browser API if the selection has already left", async () => {
    const controller = new AbortController(), fonts = available(); controller.abort();
    expect(await loadMotionFontReadiness(selected(), { fontSet: fonts, signal: controller.signal })).toMatchObject({ status: "cancelled" });
    expect(fonts.load).not.toHaveBeenCalled();
  });
});

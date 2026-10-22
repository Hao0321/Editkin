import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { motionFontSelection, type MotionFontReadiness, type MotionFontSelection } from "../typography/motionFontReadiness";
import type { MotionFontDeliveryLease, MotionFontDeliveryReceipt } from "../typography/motionFontDelivery";
import { prepareGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import { useMotionFontReadiness } from "./useMotionFontReadiness";

// Actual hook function with controlled React lifetimes and authentic runs.
// This is not a mounted React, desktop IPC, FontFaceSet or pixel observation.
const hooks = vi.hoisted(() => ({ browser: true, cursor: 0, values: [] as unknown[], deps: [] as (readonly unknown[] | undefined)[],
  cleanups: [] as (undefined | (() => void))[], effects: [] as (() => void)[], writes: 0 }));
const dependencies = vi.hoisted(() => ({ acquire: vi.fn(), load: vi.fn() }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const changed = (slot: number, deps: readonly unknown[] | undefined) => !deps || !hooks.deps[slot]
    || deps.length !== hooks.deps[slot]!.length || deps.some((value, index) => !Object.is(value, hooks.deps[slot]![index]));
  return { ...actual,
    useSyncExternalStore: () => { hooks.cursor++; return hooks.browser; },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
      const slot = hooks.cursor++; if (changed(slot, deps)) { hooks.values[slot] = factory(); hooks.deps[slot] = deps; }
      return hooks.values[slot];
    },
    useRef: (current: unknown) => { const slot = hooks.cursor++; if (!(slot in hooks.values)) hooks.values[slot] = { current }; return hooks.values[slot]; },
    useState: (initial: unknown) => { const slot = hooks.cursor++; if (!(slot in hooks.values)) hooks.values[slot] = initial;
      return [hooks.values[slot], (next: unknown) => { hooks.writes++; hooks.values[slot] = typeof next === "function" ? (next as (old: unknown) => unknown)(hooks.values[slot]) : next; }]; },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[] | undefined) => {
      const slot = hooks.cursor++; if (changed(slot, deps)) { hooks.deps[slot] = deps; hooks.effects.push(() => {
        hooks.cleanups[slot]?.(); const cleanup = effect(); hooks.cleanups[slot] = typeof cleanup === "function" ? cleanup : undefined;
      }); }
    },
  };
});
vi.mock("../typography/motionFontDelivery", async original => ({ ...await original<typeof import("../typography/motionFontDelivery")>(), acquireMotionFontDelivery: dependencies.acquire }));
vi.mock("../typography/motionFontReadiness", async original => ({ ...await original<typeof import("../typography/motionFontReadiness")>(), loadMotionFontReadiness: dependencies.load }));

const chosen = (text = "AV 12") => motionFontSelection({ family: "Bebas Neue", weight: 400, text });
const ready = (selection: MotionFontSelection): MotionFontReadiness => ({ selectionKey: selection.selectionKey, status: "ready", face: selection.face });
let actualRun: PreparedGlyphRun;
beforeAll(async () => { const selection = chosen(), spec = bundledFontFaceSpec(selection.face!.faceId);
  actualRun = await prepareGlyphRun(spec.faceId, selection.text, new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile)))); });
function lease(selection: MotionFontSelection, run: PreparedGlyphRun | undefined = actualRun, response?: Promise<MotionFontDeliveryReceipt>) {
  let active = true;
  const result: MotionFontDeliveryLease = { selectionKey: selection.selectionKey,
    ready: response ?? Promise.resolve({ selectionKey: selection.selectionKey, status: "registered", glyphRun: run }),
    isRegistered: vi.fn(() => active), setPriority: vi.fn(), release: vi.fn(() => { active = false; }) };
  return { result, invalidate: () => { active = false; } };
}
function render(selection: MotionFontSelection, priority: "current" | "lookahead" = "current", physical = true) {
  hooks.cursor = 0; return useMotionFontReadiness(selection, priority, { prepareGlyphs: physical });
}
function commit() { hooks.effects.splice(0).forEach(effect => effect()); }
function unmount() { hooks.cleanups.forEach(cleanup => cleanup?.()); hooks.cleanups.length = 0; }
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
beforeEach(() => {
  hooks.browser = true; hooks.cursor = 0; hooks.values.length = 0; hooks.deps.length = 0; hooks.cleanups.length = 0; hooks.effects.length = 0; hooks.writes = 0;
  dependencies.acquire.mockReset(); dependencies.load.mockReset(); dependencies.load.mockImplementation(async (selection: MotionFontSelection) => ready(selection));
  vi.stubGlobal("window", { haoDesktop: { isDesktop: true } }); vi.stubGlobal("document", { fonts: {} });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("physical glyph hook authority (controlled lifetimes; no mounted browser proof)", () => {
  it("requests real glyph preparation and publishes a run only after exact readiness plus an active lease", async () => {
    const selection = chosen(), physical = lease(selection); dependencies.acquire.mockReturnValue(physical.result);
    expect(render(selection).glyphRun).toBeUndefined(); commit(); await flush();
    const observed = render(selection); expect(observed.status).toBe("ready"); expect(observed.glyphRun).toBe(actualRun); commit();
    expect(dependencies.acquire).toHaveBeenCalledWith(selection, expect.objectContaining({ prepareGlyphs: true }));
    physical.invalidate(); expect(render(selection)).toMatchObject({ status: "blocked" }); expect(render(selection).glyphRun).toBeUndefined();
  });

  it("blocks a legacy registration-only receipt instead of treating FontFaceSet ready as contours", async () => {
    const selection = chosen(), physical = lease(selection, undefined, Promise.resolve({ selectionKey: selection.selectionKey, status: "registered" }));
    dependencies.acquire.mockReturnValue(physical.result); render(selection); commit(); await flush();
    expect(render(selection)).toMatchObject({ status: "blocked", reason: expect.stringContaining("未提供實體 glyph run") });
    expect(render(selection).glyphRun).toBeUndefined(); expect(dependencies.load).not.toHaveBeenCalled();
  });

  it("keeps legacy v1 readiness without requiring a run", async () => {
    const selection = chosen(), physical = lease(selection, undefined, Promise.resolve({ selectionKey: selection.selectionKey, status: "registered" }));
    dependencies.acquire.mockReturnValue(physical.result); render(selection, "current", false); commit(); await flush();
    expect(render(selection, "current", false)).toMatchObject({ status: "ready" });
    expect(dependencies.load).toHaveBeenCalledTimes(1); expect(render(selection, "current", false).glyphRun).toBeUndefined();
  });

  it("masks a released run immediately on text change and never publishes a late old delivery", async () => {
    const first = chosen(), second = chosen("NEXT"), old = lease(first), next = lease(second);
    let resolveNext!: (receipt: MotionFontDeliveryReceipt) => void;
    const pending = new Promise<MotionFontDeliveryReceipt>(resolve => { resolveNext = resolve; });
    next.result = { ...next.result, ready: pending }; dependencies.acquire.mockReturnValueOnce(old.result).mockReturnValueOnce(next.result);
    render(first); commit(); await flush(); expect(render(first).glyphRun).toBe(actualRun); commit();
    expect(render(second).status).toBe("pending"); expect(render(second).glyphRun).toBeUndefined(); commit(); await flush();
    expect(old.result.release).toHaveBeenCalledTimes(1); unmount(); const writes = hooks.writes;
    resolveNext({ selectionKey: second.selectionKey, status: "registered", glyphRun: actualRun }); await flush();
    expect(hooks.writes).toBe(writes); expect(dependencies.load).toHaveBeenCalledTimes(1);
  });

  it("promotes the same glyph lease on visibility entry without reacquiring or resetting work", async () => {
    const selection = chosen(), physical = lease(selection); dependencies.acquire.mockReturnValue(physical.result);
    render(selection, "lookahead"); commit(); await flush(); expect(render(selection, "lookahead").glyphRun).toBe(actualRun); commit();
    expect(render(selection, "current").glyphRun).toBe(actualRun); commit();
    expect(physical.result.setPriority).toHaveBeenLastCalledWith("current"); expect(dependencies.acquire).toHaveBeenCalledTimes(1);
    expect(dependencies.load).toHaveBeenCalledTimes(1); expect(physical.result.release).not.toHaveBeenCalled();
  });

  it("keeps SSR unobserved without preparing or exposing a run", () => {
    hooks.browser = false; expect(render(chosen())).toMatchObject({ status: "unobserved" }); commit();
    expect(render(chosen()).glyphRun).toBeUndefined(); expect(dependencies.acquire).not.toHaveBeenCalled(); expect(dependencies.load).not.toHaveBeenCalled();
  });

  it("blocks web glyph mode rather than consulting CSS as a binary source", async () => {
    vi.stubGlobal("window", {}); render(chosen()); commit(); await flush();
    expect(render(chosen())).toMatchObject({ status: "blocked", reason: expect.stringContaining("binary glyph 來源") });
    expect(dependencies.acquire).not.toHaveBeenCalled(); expect(dependencies.load).not.toHaveBeenCalled();
  });

  it("does not expose a prepared run when the exact font readiness check fails", async () => {
    const selection = chosen(), physical = lease(selection); dependencies.acquire.mockReturnValue(physical.result);
    dependencies.load.mockResolvedValueOnce({ selectionKey: selection.selectionKey, status: "blocked", reason: "exact alias missing" });
    render(selection); commit(); await flush(); expect(render(selection)).toMatchObject({ status: "blocked", reason: "exact alias missing" });
    expect(render(selection).glyphRun).toBeUndefined();
  });
});

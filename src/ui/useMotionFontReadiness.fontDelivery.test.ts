import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motionFontSelection, type MotionFontReadiness, type MotionFontSelection } from "../typography/motionFontReadiness";
import type { MotionFontDeliveryLease } from "../typography/motionFontDelivery";
import { useMotionFontReadiness } from "./useMotionFontReadiness";

// Controlled hook/effect lifetime only. This calls the actual consumer function,
// but does not mount React, execute desktop IPC, or prove browser FontFaceSet.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], deps: [] as (readonly unknown[] | undefined)[],
  cleanups: [] as (undefined | (() => void))[], effects: [] as (() => void)[], writes: 0 }));
const dependencies = vi.hoisted(() => ({ acquire: vi.fn(), load: vi.fn() }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const changed = (slot: number, deps: readonly unknown[] | undefined) => !deps || !hooks.deps[slot]
    || deps.length !== hooks.deps[slot]!.length || deps.some((value, index) => !Object.is(value, hooks.deps[slot]![index]));
  return { ...actual,
    useSyncExternalStore: () => { hooks.cursor++; return true; },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
      const slot = hooks.cursor++; if (changed(slot, deps)) { hooks.values[slot] = factory(); hooks.deps[slot] = deps; }
      return hooks.values[slot];
    },
    useRef: (current: unknown) => { const slot = hooks.cursor++; if (!(slot in hooks.values)) hooks.values[slot] = { current }; return hooks.values[slot]; },
    useState: (initial: unknown) => { const slot = hooks.cursor++; if (!(slot in hooks.values)) hooks.values[slot] = initial;
      return [hooks.values[slot], (next: unknown) => { hooks.writes++; hooks.values[slot] = typeof next === "function" ? (next as (old: unknown) => unknown)(hooks.values[slot]) : next; }]; },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[] | undefined) => {
      const slot = hooks.cursor++;
      if (changed(slot, deps)) { hooks.deps[slot] = deps; hooks.effects.push(() => {
        hooks.cleanups[slot]?.(); const cleanup = effect(); hooks.cleanups[slot] = typeof cleanup === "function" ? cleanup : undefined;
      }); }
    },
  };
});
vi.mock("../typography/motionFontDelivery", async original => ({ ...await original<typeof import("../typography/motionFontDelivery")>(), acquireMotionFontDelivery: dependencies.acquire }));
vi.mock("../typography/motionFontReadiness", async original => ({ ...await original<typeof import("../typography/motionFontReadiness")>(), loadMotionFontReadiness: dependencies.load }));

const chosen = (weight = 400) => motionFontSelection({ family: "Fredoka", weight, text: "Consumer" });
const ready = (selection: MotionFontSelection): MotionFontReadiness => ({ selectionKey: selection.selectionKey, status: "ready", face: selection.face });
function lease(selection: MotionFontSelection) {
  let active = true;
  const result: MotionFontDeliveryLease = { selectionKey: selection.selectionKey,
    ready: Promise.resolve({ selectionKey: selection.selectionKey, status: "registered" }),
    isRegistered: vi.fn(() => active), setPriority: vi.fn(), release: vi.fn(() => { active = false; }) };
  return { result, invalidate: () => { active = false; } };
}
function render(selection: MotionFontSelection, priority: "current" | "lookahead" = "current") {
  hooks.cursor = 0; return useMotionFontReadiness(selection, priority);
}
function commit() { hooks.effects.splice(0).forEach(effect => effect()); }
function unmount() { hooks.cleanups.forEach(cleanup => cleanup?.()); hooks.cleanups.length = 0; }
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
beforeEach(() => {
  hooks.cursor = 0; hooks.values.length = 0; hooks.deps.length = 0; hooks.cleanups.length = 0; hooks.effects.length = 0; hooks.writes = 0;
  dependencies.acquire.mockReset(); dependencies.load.mockReset();
  dependencies.load.mockImplementation(async (selection: MotionFontSelection) => ready(selection));
  vi.stubGlobal("window", { haoDesktop: { isDesktop: true } }); vi.stubGlobal("document", { fonts: {} });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("actual font consumer lease/effect wiring (controlled hooks; no mounted desktop/browser proof)", () => {
  it("requires the currently active lease for every ready projection and releases on unmount", async () => {
    const selection = chosen(), physical = lease(selection); dependencies.acquire.mockReturnValue(physical.result);
    expect(render(selection).status).toBe("pending"); commit(); await flush();
    expect(render(selection).status).toBe("ready"); commit();
    physical.invalidate(); expect(render(selection)).toMatchObject({ status: "blocked", reason: expect.stringContaining("lease 已釋放或失效") });
    expect(dependencies.acquire).toHaveBeenCalledTimes(1); unmount(); expect(physical.result.release).toHaveBeenCalledTimes(1);
  });

  it("promotes visibility using the same request and lease rather than restarting acquisition/readiness", async () => {
    const selection = chosen(), physical = lease(selection); dependencies.acquire.mockReturnValue(physical.result);
    render(selection, "lookahead"); commit(); await flush(); expect(render(selection, "lookahead").status).toBe("ready"); commit();
    expect(render(selection, "current").status).toBe("ready"); commit(); await flush();
    expect(physical.result.setPriority).toHaveBeenLastCalledWith("current");
    expect(dependencies.acquire).toHaveBeenCalledTimes(1); expect(dependencies.load).toHaveBeenCalledTimes(1);
    expect(physical.result.release).not.toHaveBeenCalled();
  });

  it("masks old readiness on font change and prevents a late old loader from publishing after cleanup", async () => {
    const first = chosen(400), second = chosen(700), old = lease(first), next = lease(second);
    dependencies.acquire.mockReturnValueOnce(old.result).mockReturnValueOnce(next.result);
    let resolveOld!: (value: MotionFontReadiness) => void;
    dependencies.load.mockReturnValueOnce(new Promise<MotionFontReadiness>(resolve => { resolveOld = resolve; }));
    render(first); commit(); await flush(); expect(dependencies.load).toHaveBeenCalledTimes(1);
    expect(render(second).status).toBe("pending"); commit(); await flush();
    expect(old.result.release).toHaveBeenCalledTimes(1); expect(render(second)).toMatchObject({ status: "ready", selectionKey: second.selectionKey }); commit();
    const writes = hooks.writes; resolveOld(ready(first)); await flush();
    expect(hooks.writes).toBe(writes); expect(render(second).selectionKey).toBe(second.selectionKey);
    expect(dependencies.acquire).toHaveBeenCalledTimes(2);
  });

  it("reentry obtains a fresh active lease and cannot reuse the released ready projection", async () => {
    const selection = chosen(), old = lease(selection); dependencies.acquire.mockReturnValueOnce(old.result);
    render(selection); commit(); await flush(); expect(render(selection).status).toBe("ready"); commit(); unmount();
    hooks.values.length = 0; hooks.deps.length = 0;
    const next = lease(selection); dependencies.acquire.mockReturnValueOnce(next.result);
    expect(render(selection).status).toBe("pending"); commit(); await flush(); expect(render(selection).status).toBe("ready");
    expect(old.result.isRegistered()).toBe(false); expect(next.result.isRegistered()).toBe(true);
    expect(dependencies.acquire).toHaveBeenCalledTimes(2);
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledFontFaceSpec } from "../typography/bundledFontCatalog";
import { motionFontSelection, type MotionFontSelection } from "../typography/motionFontReadiness";
import { assertPreparedGlyphRun, type PreparedGlyphRun } from "../typography/preparedGlyphRun";
import type { MotionTemplateTextPreparer } from "../typography/motionTemplateTextPreparation";
import { useMotionFontReadiness } from "./useMotionFontReadiness";

// Actual hook, network reader, SHA/parser factory and readiness loader, with
// controlled React/FontFaceSet adapters. This is not mounted/browser proof.
const hooks = vi.hoisted(() => ({ browser: true, cursor: 0, values: [] as unknown[], deps: [] as (readonly unknown[] | undefined)[],
  cleanups: [] as (undefined | (() => void))[], effects: [] as (() => void)[], writes: 0 }));
const owners = vi.hoisted(() => ([] as { owner: MotionTemplateTextPreparer; requests: Promise<PreparedGlyphRun>[]; dispose: ReturnType<typeof vi.fn> }[]));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const changed = (slot: number, deps: readonly unknown[] | undefined) => !deps || !hooks.deps[slot]
    || deps.length !== hooks.deps[slot]!.length || deps.some((value, index) => !Object.is(value, hooks.deps[slot]![index]));
  return { ...actual,
    useSyncExternalStore: () => { hooks.cursor++; return hooks.browser; },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
      const slot = hooks.cursor++; if (changed(slot, deps)) { hooks.values[slot] = factory(); hooks.deps[slot] = deps; } return hooks.values[slot];
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
vi.mock("../typography/motionTemplateTextPreparation", async original => {
  const actual = await original<typeof import("../typography/motionTemplateTextPreparation")>();
  return { ...actual, createMotionTemplateTextPreparer: (options: Parameters<typeof actual.createMotionTemplateTextPreparer>[0]) => {
    const delegate = actual.createMotionTemplateTextPreparer(options), requests: Promise<PreparedGlyphRun>[] = [];
    const dispose = vi.fn(() => delegate.dispose());
    const owner = { prepareText(faceId: string, text: string) { const request = delegate.prepareText(faceId, text); requests.push(request); return request; }, dispose };
    owners.push({ owner, requests, dispose }); return owner;
  } };
});

const choose = (text = "AV 12") => motionFontSelection({ family: "Bebas Neue", weight: 400, text });
const spec = bundledFontFaceSpec(choose().face!.faceId);
let bytes: Uint8Array;
const closeReaders: (() => void)[] = [];
function response(value = bytes): Response {
  const result = new Response(Uint8Array.from(value).buffer);
  Object.defineProperty(result, "url", { value: `http://localhost:4183/fonts/${spec.fontFile}` }); return result;
}
function render(selection: MotionFontSelection, priority: "current" | "lookahead" = "current") {
  hooks.cursor = 0; return useMotionFontReadiness(selection, priority, { prepareGlyphs: true });
}
function commit() { hooks.effects.splice(0).forEach(effect => effect()); }
function unmount() { hooks.cleanups.forEach(cleanup => cleanup?.()); hooks.cleanups.length = 0; }
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
const settled = async () => { await Promise.allSettled(owners.flatMap(owner => owner.requests)); await flush(); };
beforeAll(async () => { bytes = new Uint8Array(await readFile(resolve("public/fonts", spec.fontFile))); });
beforeEach(() => {
  hooks.browser = true; hooks.cursor = 0; hooks.values.length = 0; hooks.deps.length = 0; hooks.cleanups.length = 0; hooks.effects.length = 0; hooks.writes = 0; owners.length = 0;
  vi.stubGlobal("window", { location: { href: "http://localhost:4183/editor" } });
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  vi.stubGlobal("document", { fonts: { load: vi.fn(async () => [{ family: spec.fontFamily, weight: String(spec.fontWeight), status: "loaded" }]),
    check: vi.fn(() => true), ready: Promise.resolve() } });
});
afterEach(async () => {
  unmount(); closeReaders.splice(0).forEach(close => close()); await settled();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("web physical glyph consumer (real pinned bytes and actual loaders; controlled lifecycle, no browser artwork claim)", () => {
  it("publishes true contours only after the selected web binary and exact FontFaceSet readiness both succeed", async () => {
    const selection = choose(); expect(render(selection).status).toBe("pending"); commit(); await settled();
    const result = render(selection); expect(result.status).toBe("ready"); assertPreparedGlyphRun(result.glyphRun);
    expect(result.glyphRun.text).toBe(selection.text); expect(result.glyphRun.fontSha256).toBe(spec.sha256);
    expect(document.fonts.load).toHaveBeenCalledWith(`${spec.fontWeight} 16px "${spec.fontFamily}"`, selection.text);
    expect(fetch).toHaveBeenCalledTimes(1);
    render(selection, "current"); commit(); expect(fetch).toHaveBeenCalledTimes(1); expect(owners).toHaveLength(1);
    unmount(); expect(owners[0].dispose).toHaveBeenCalledTimes(1);
  });
  it("does not consult CSS readiness or publish a run for wrong binary bytes", async () => {
    const corrupt = Uint8Array.from(bytes); corrupt[20] ^= 1; vi.mocked(fetch).mockResolvedValueOnce(response(corrupt));
    render(choose()); commit(); await settled();
    expect(render(choose())).toMatchObject({ status: "blocked", reason: expect.stringContaining("SHA") });
    expect(render(choose()).glyphRun).toBeUndefined(); expect(document.fonts.load).not.toHaveBeenCalled();
  });
  it("does not publish authentic contours when the CSS alias or weight readiness fails", async () => {
    vi.mocked(document.fonts.load).mockResolvedValueOnce([{ family: "wrong alias", weight: "400", status: "loaded" }] as unknown as FontFace[]);
    render(choose()); commit(); await settled();
    expect(render(choose())).toMatchObject({ status: "blocked", reason: expect.stringContaining("alias") });
    expect(render(choose()).glyphRun).toBeUndefined();
  });
  it("cancels the old consumer on a text change and a late original reader cannot publish stale readiness", async () => {
    let resolveOld!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(yes => { resolveOld = yes; })); closeReaders.push(() => resolveOld(response()));
    const first = choose(), next = choose("NEXT"); render(first); commit(); await flush();
    expect(render(next).glyphRun).toBeUndefined(); expect(render(next).status).toBe("pending"); commit();
    await settled(); expect(render(next)).toMatchObject({ status: "ready", selectionKey: next.selectionKey });
    expect(render(next).glyphRun?.text).toBe("NEXT"); expect(owners[0].dispose).toHaveBeenCalledTimes(1);
    const writes = hooks.writes; resolveOld(response()); await flush();
    expect(hooks.writes).toBe(writes); expect(render(next).glyphRun?.text).toBe("NEXT");
  });
  it("blocks a late CSS result at the original total web deadline instead of resetting the clock after byte preparation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.mocked(document.fonts.load).mockReturnValueOnce(new Promise<FontFace[]>(() => {}));
    render(choose()); commit(); await settled(); expect(document.fonts.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(render(choose())).toMatchObject({ status: "blocked", reason: expect.stringContaining("逾時") });
    expect(render(choose()).glyphRun).toBeUndefined();
  });
  it("keeps SSR unobserved with no network preparation or glyph authorization", () => {
    hooks.browser = false; expect(render(choose()).status).toBe("unobserved"); commit();
    expect(render(choose()).glyphRun).toBeUndefined(); expect(fetch).not.toHaveBeenCalled(); expect(owners).toHaveLength(0);
  });
});

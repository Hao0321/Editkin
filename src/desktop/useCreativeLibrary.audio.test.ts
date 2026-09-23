import { beforeEach, describe, expect, it, vi } from "vitest";

const react = vi.hoisted(() => ({
  values: [] as any[], cursor: 0, effectCursor: 0,
  effects: [] as Array<{ deps?: unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const slot = react.cursor++;
    if (!(slot in react.values)) react.values[slot] = typeof initial === "function" ? initial() : initial;
    return [react.values[slot], (value: any) => { react.values[slot] = typeof value === "function" ? value(react.values[slot]) : value; }];
  },
  useRef: (current: unknown) => {
    const slot = react.cursor++;
    return react.values[slot] ?? (react.values[slot] = { current });
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = react.effectCursor++, old = react.effects[slot];
    if (old && deps.length === old.deps?.length && deps.every((value, index) => Object.is(value, old.deps?.[index]))) return;
    react.pending.push(() => {
      old?.cleanup?.();
      const cleanup = effect();
      react.effects[slot] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  },
}));
import { useCreativeLibrary } from "./useCreativeLibrary";
import { createProjectSession } from "../application/projectSession";
import { createDemoProject } from "../domain/demo";
import type { HaoDesktopApi } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const created: FakeAudio[] = [];
let playPending: ReturnType<typeof deferred<void>> | undefined;
class FakeAudio {
  paused = true; volume = 1; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(public source: string) { created.push(this); }
  pause() { this.paused = true; }
  play() { this.paused = false; return this.source === "fixture://pending-play" && playPending ? playPending.promise : Promise.resolve(); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function apiFixture() {
  const requests: Array<{ id: string } & ReturnType<typeof deferred<string>>> = [];
  const api = {
    listCreativeLibrary: vi.fn(async () => ({ assets: [] })),
    listInstalledPlugins: vi.fn(async () => ({ plugins: [] })),
    getWorkflowProfile: vi.fn(async () => ({ profile: {} })),
    previewCreativeAsset: vi.fn((id: string) => { const pending = { id, ...deferred<string>() }; requests.push(pending); return pending.promise; }),
  };
  return { api: api as unknown as HaoDesktopApi, requests };
}
function fixture() {
  const source = apiFixture(), session = createProjectSession(createDemoProject()), onStatus = vi.fn();
  const options = { api: source.api, projectSession: session, onPicked: vi.fn(), onPrepared: vi.fn(), onStatus, onCommands: vi.fn() };
  const render = () => {
    react.cursor = 0; react.effectCursor = 0; react.pending = [];
    const hook = useCreativeLibrary(options);
    for (const commit of react.pending) commit();
    return hook;
  };
  const unmount = () => { for (const effect of react.effects) effect?.cleanup?.(); };
  return { ...source, session, options, onStatus, render, unmount, hook: render() };
}
beforeEach(() => {
  react.values = []; react.effects = []; react.pending = []; react.cursor = 0; react.effectCursor = 0;
  created.length = 0; playPending = undefined; vi.stubGlobal("Audio", FakeAudio);
});

describe("music preview ownership — actual hook/store, deterministic React lifecycle and Audio substitutes", () => {
  it("plays one selection and current ended clears the UI", async () => {
    const f = fixture(), pending = f.hook.previewCreativeAsset("music:a");
    expect(f.render().previewingId).toBe("music:a");
    f.requests[0]!.resolve("fixture://a"); await pending;
    expect(created.filter(audio => !audio.paused).map(audio => audio.source)).toEqual(["fixture://a"]);
    created[0]!.onended?.();
    expect(f.render().previewingId).toBeUndefined();
    expect(created[0]!.paused).toBe(true);
  });
  it("A→B resolves B first and ignores late A", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a"), b = f.hook.previewCreativeAsset("music:b");
    f.requests[1]!.resolve("fixture://b"); await b;
    f.requests[0]!.resolve("fixture://a"); await a;
    expect(created.map(audio => audio.source)).toEqual(["fixture://b"]);
    expect(f.render().previewingId).toBe("music:b");
  });
  it("same-item second click cancels pending work without issuing a second resolver", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    await f.hook.previewCreativeAsset("music:a");
    expect(f.requests).toHaveLength(1);
    f.requests[0]!.resolve("fixture://a"); await a;
    expect(created).toHaveLength(0); expect(f.render().previewingId).toBeUndefined();
  });
  it("same-item second click stops current playback", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    f.requests[0]!.resolve("fixture://a"); await a;
    await f.render().previewCreativeAsset("music:a");
    expect(created[0]!.paused).toBe(true); expect(f.render().previewingId).toBeUndefined();
  });
  it.each(["pending", "playing"])("unmount cancels %s audio", async phase => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    if (phase === "playing") { f.requests[0]!.resolve("fixture://a"); await a; }
    f.unmount();
    if (phase === "pending") { f.requests[0]!.resolve("fixture://a"); await a; expect(created).toHaveLength(0); }
    expect(created.every(audio => audio.paused)).toBe(true);
  });
  it.each(["pending", "playing"])("same-id project replacement cancels %s audio", async phase => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    if (phase === "playing") { f.requests[0]!.resolve("fixture://a"); await a; }
    f.session.replaceProject({ ...f.session.getSnapshot().history.present, name: "Reopened" });
    if (phase === "pending") { f.requests[0]!.resolve("fixture://a"); await a; expect(created).toHaveLength(0); }
    expect(created.every(audio => audio.paused)).toBe(true); expect(f.render().previewingId).toBeUndefined();
  });
  it.each(["pending", "playing"])("API replacement cancels %s audio without losing new playback", async phase => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    if (phase === "playing") { f.requests[0]!.resolve("fixture://a"); await a; }
    const replacement = apiFixture(); f.options.api = replacement.api;
    const b = f.render().previewCreativeAsset("music:b"); replacement.requests[0]!.resolve("fixture://b"); await b;
    if (phase === "pending") { f.requests[0]!.resolve("fixture://a"); await a; }
    expect(created.filter(audio => !audio.paused).map(audio => audio.source)).toEqual(["fixture://b"]);
    expect(f.render().previewingId).toBe("music:b");
  });
  it("a retained old API callback cannot stop or replace the new API owner", async () => {
    const f = fixture(), oldCallback = f.hook.previewCreativeAsset, replacement = apiFixture();
    f.options.api = replacement.api;
    const b = f.render().previewCreativeAsset("music:b"); replacement.requests[0]!.resolve("fixture://b"); await b;
    await oldCallback("music:a");
    expect(f.requests).toHaveLength(0); expect(f.render().previewingId).toBe("music:b"); expect(created[0]!.paused).toBe(false);
  });
  it("ordinary edit and save acknowledgment preserve same-session playback", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    f.requests[0]!.resolve("fixture://a"); await a;
    f.session.setHistory(history => ({ ...history, present: { ...history.present, name: "Edit" } }));
    const save = f.session.beginSave()!;
    f.session.completeSave(save, { path: "fixture-only.json", project: { ...save.project, revision: 1 } }); f.session.finishSave(save);
    expect(created[0]!.paused).toBe(false); expect(f.render().previewingId).toBe("music:a");
  });
  it("stale resolver rejection cannot clear or report over current audio", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a"), b = f.hook.previewCreativeAsset("music:b");
    f.requests[1]!.resolve("fixture://b"); await b; f.requests[0]!.reject(Error("old failure")); await a;
    expect(f.onStatus).not.toHaveBeenCalled(); expect(f.render().previewingId).toBe("music:b");
  });
  it("stale play rejection and queued old ended/error handlers do not affect the new owner", async () => {
    playPending = deferred<void>(); const f = fixture(), a = f.hook.previewCreativeAsset("music:a");
    f.requests[0]!.resolve("fixture://pending-play"); await flush();
    const oldEnded = created[0]!.onended!, oldError = created[0]!.onerror!;
    const b = f.hook.previewCreativeAsset("music:b"); f.requests[1]!.resolve("fixture://b"); await b;
    oldEnded(); oldError(); playPending.reject(Error("old play failure")); await a;
    expect(created[0]!.paused).toBe(true); expect(f.onStatus).not.toHaveBeenCalled(); expect(f.render().previewingId).toBe("music:b");
  });
  it("current decode error remains visible and clears the current selection", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a"); f.requests[0]!.resolve("fixture://a"); await a;
    created[0]!.onerror?.();
    expect(f.onStatus).toHaveBeenCalledWith("音樂預聽失敗"); expect(f.render().previewingId).toBeUndefined();
  });
  it("current resolver rejection can be retried with a fresh request", async () => {
    const f = fixture(), a = f.hook.previewCreativeAsset("music:a"); f.requests[0]!.reject(Error("current failure")); await a;
    expect(f.onStatus).toHaveBeenCalledWith("current failure"); expect(f.render().previewingId).toBeUndefined();
    const retry = f.render().previewCreativeAsset("music:a"); expect(f.requests).toHaveLength(2);
    f.requests[1]!.resolve("fixture://repaired"); await retry; expect(created[0]!.paused).toBe(false);
  });
});
